/**
 * Tool-result compaction: shrink what the model has to read, without changing
 * what the tool did.
 *
 * A single `read` of a 200 KB log or a recursive `grep` over a monorepo can
 * spend more prompt tokens than the rest of the turn. Compaction keeps the
 * shape of the result — the head the model asked for, the tail where the error
 * usually is, the first few hits per file — and replaces the middle with one
 * marker line that says how much was dropped.
 *
 * This module is pure: no environment, no filesystem, no config import. The
 * caller decides whether compaction is on and passes the policy in, so the
 * feature can be turned off without touching this file.
 *
 * Risk, stated plainly: over-truncating makes the model answer from the head
 * and the tail while the fact it needed sat in the elided middle. Compaction is
 * therefore off unless `policy.enabled === true`, and every rewrite is marked
 * in the output so the model can see that something was dropped and ask for a
 * narrower read instead of guessing.
 */

/** Marker prefix shared by every rewrite, and the idempotency test. */
const MARK = /\[fast-mode: [^\]\n]*\]/

/** `path:line: text` — the shape a recursive grep prints. */
const GREP_LINE = /^(.+?):(\d+):/

const DEFAULTS = {
  maxChars: 8000,
  headRatio: 0.4,
  tailRatio: 0.25,
  maxPerFile: 5,
  maxMatches: 120,
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff

/** Largest index <= i that does not fall inside a surrogate pair. */
function safeHead(text, i) {
  if (i <= 0) return 0
  if (i >= text.length) return text.length
  if (isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i))) return i - 1
  return i
}

/** Smallest index >= i that does not fall inside a surrogate pair. */
function safeTail(text, i) {
  if (i <= 0) return 0
  if (i >= text.length) return text.length
  if (isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i))) return i + 1
  return i
}

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalize(policy) {
  const p = policy ?? {}
  const maxChars = finite(p.maxChars, DEFAULTS.maxChars)
  return {
    enabled: p.enabled === true,
    maxChars: maxChars > 0 ? Math.floor(maxChars) : DEFAULTS.maxChars,
    headRatio: clampRatio(finite(p.headRatio, DEFAULTS.headRatio)),
    tailRatio: clampRatio(finite(p.tailRatio, DEFAULTS.tailRatio)),
    maxPerFile: Math.max(1, Math.floor(finite(p.maxPerFile, DEFAULTS.maxPerFile))),
    maxMatches: Math.max(1, Math.floor(finite(p.maxMatches, DEFAULTS.maxMatches))),
  }
}

function clampRatio(r) {
  if (!(r > 0)) return 0.1
  return r >= 0.9 ? 0.9 : r
}

const unchanged = (text, kind = 'none') => ({
  text,
  changed: false,
  originalChars: typeof text === 'string' ? text.length : 0,
  compactedChars: typeof text === 'string' ? text.length : 0,
  kind,
})

/**
 * Head + tail, cut on line boundaries (or at a safe code-unit boundary).
 * Budgets are shares of `maxChars`, not of the original: a 1 MB result must not
 * come back as a 650 KB one.
 */
function headTail(text, maxChars, headRatio, tailRatio) {
  const total = text.length
  const headAt = Math.min(total, Math.max(1, Math.floor(maxChars * headRatio)))
  const tailAt = Math.max(0, total - Math.max(1, Math.floor(maxChars * tailRatio)))

  let headEnd = text.lastIndexOf('\n', Math.max(0, headAt - 1))
  headEnd = headEnd > 0 ? headEnd + 1 : safeHead(text, headAt)

  let tailStart = text.indexOf('\n', Math.min(total, tailAt))
  tailStart = tailStart === -1 ? safeTail(text, tailAt) : Math.min(total, tailStart + 1)

  const elided = tailStart - headEnd
  if (headEnd <= 0 || tailStart <= headEnd || elided <= 0) return null

  // Which lines went missing, so a model can re-read exactly that band instead
  // of guessing or re-reading the whole result. Single-line text has no range.
  const newlinesBefore = countNewlines(text, tailStart)
  const firstElidedLine = countNewlines(text, headEnd) + 1
  const range = newlinesBefore > 0 ? `, lines ${firstElidedLine}–${newlinesBefore}` : ''
  return {
    text: `${text.slice(0, headEnd)}… [fast-mode: elided ${elided} chars${range}] …${text.slice(tailStart)}`,
    elided,
  }
}

/**
 * Newlines in `text` before `end`, i.e. the 1-based number of the last complete
 * line that starts before `end`.
 */
function countNewlines(text, end) {
  let count = 0
  for (let i = 0; i < end; i += 1) if (text.charCodeAt(i) === 10) count += 1
  return count
}

function isGrepLike(name, text) {
  if (typeof name === 'string' && /grep/i.test(name)) return true
  for (const line of text.split('\n', 20)) {
    if (GREP_LINE.test(line)) return true
  }
  return false
}

/** First `maxPerFile` hits per file, then one marker; global cap on top. */
function foldGrep(text, maxPerFile, maxMatches) {
  const lines = text.split('\n')
  const perFile = new Map()
  const out = []
  let file = null
  let pending = 0
  let kept = 0
  let over = 0
  let dropped = 0

  const flush = () => {
    if (pending > 0) {
      out.push(`… [fast-mode: ${pending} more matches in ${file}] …`)
      pending = 0
    }
  }

  for (const line of lines) {
    const m = GREP_LINE.exec(line)
    if (!m) {
      flush()
      out.push(line)
      continue
    }
    const path = m[1]
    if (file !== path) {
      flush()
      file = path
    }
    const seen = (perFile.get(path) ?? 0) + 1
    perFile.set(path, seen)
    if (seen > maxPerFile) {
      pending += 1
      dropped += 1
      continue
    }
    if (kept >= maxMatches) {
      over += 1
      dropped += 1
      continue
    }
    kept += 1
    out.push(line)
  }
  flush()

  if (over > 0) out.push(`… [fast-mode: ${over} more matches elided] …`)
  return { text: out.join('\n'), dropped, kept }
}

/**
 * @param {{ name?: string, args?: unknown, text?: string, isError?: boolean }} result
 * @param {{ enabled?: boolean, maxChars?: number, headRatio?: number,
 *           tailRatio?: number, maxPerFile?: number, maxMatches?: number }} [policy]
 * @returns {{ text: string, changed: boolean, originalChars: number,
 *             compactedChars: number, kind: 'none' | 'grep' | 'read' | 'text' }}
 */
export function compactResult(result, policy) {
  const { name, text, isError } = result ?? {}
  if (typeof text !== 'string' || text.length === 0) return unchanged(typeof text === 'string' ? text : '')
  if (isError) return unchanged(text)
  if (MARK.test(text)) return unchanged(text, 'none')

  const p = normalize(policy)
  if (!p.enabled || text.length <= p.maxChars) return unchanged(text)

  const readLike = typeof name === 'string' && /read|view|open/i.test(name)
  const grepLike = !readLike && isGrepLike(name, text)

  let body = text
  let kind = readLike ? 'read' : 'text'
  let changed = false

  if (grepLike) {
    const folded = foldGrep(text, p.maxPerFile, p.maxMatches)
    if (folded.dropped > 0) {
      body = folded.text
      kind = 'grep'
      changed = true
    }
  }

  if (body.length > p.maxChars) {
    const cut = headTail(body, p.maxChars, p.headRatio, p.tailRatio)
    if (cut) {
      body = cut.text
      changed = true
      if (kind !== 'grep') kind = readLike ? 'read' : 'text'
    }
  }

  if (!changed) return unchanged(text)
  return {
    text: body,
    changed: true,
    originalChars: text.length,
    compactedChars: body.length,
    kind,
  }
}
