/**
 * Benchmark assignment: which gear a session runs at, when an experiment is in
 * progress.
 *
 * The comparison question — "is gear N actually faster, and what does it cost in
 * tokens" — cannot be answered from a single session. It needs several sessions
 * of the *same* work, split across gears, with the assignment made by something
 * other than the person who wants a particular answer. This module is that
 * something: a JSON file read live, with the gear chosen per session by hashing
 * the session id, so nothing has to be clicked and no session can be steered.
 *
 * Shipped inert. With no file (the default) there is no experiment and the
 * configured `gear` is the only stance. The file is re-checked at most once a
 * second, so starting or ending an experiment needs neither a reload nor a
 * restart — a benchmark you have to restart the app for runs in whatever
 * configuration you meant to test last time.
 *
 * ```
 * { "enabled": true, "gears": ["safe", "fast", "turbo", "max"] }
 * ```
 *
 * An optional `"sessions": { "<session id>": "turbo" }` map overrides the hash,
 * which is how a single named session is pinned to one gear.
 *
 * `"off"` is a legal arm name and means the control group: the session runs with
 * the plugin switched off. Without it an experiment can only compare gears with
 * each other, never against the thing they are supposed to improve on — and
 * "which gear is fastest" is not the question, "is this faster than doing
 * nothing" is.
 *
 * @module dsh-fast-mode/benchmark
 */
import { readFileSync } from 'node:fs'

/** How long a read file stays authoritative. One second: long enough to matter, short enough to edit. */
const TTL_MS = 1000

/** The control arm: an assigned session that runs with the plugin off. */
export const CONTROL = 'off'

/**
 * FNV-1a over the session id. Stable across processes and platforms, which is
 * what makes a hash-picked gear reproducible from the log alone.
 *
 * @param {string} value
 */
export function hashOf(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Pick the gear for a session: an explicit pin first, otherwise the hash walk.
 *
 * @param {string} sessionId
 * @param {{gears: string[], sessions: Record<string, string>}} assignment
 */
export function gearFor(sessionId, assignment) {
  const pinned = assignment.sessions[sessionId]
  if (typeof pinned === 'string' && assignment.gears.includes(pinned)) return pinned
  if (assignment.gears.length === 0) return undefined
  return assignment.gears[hashOf(sessionId) % assignment.gears.length]
}

/**
 * A live reader for the experiment file.
 *
 * @param {{file?: string, gears: readonly string[], onError?: (message: string) => void}} options
 */
export function createAssignment(options) {
  const file = typeof options.file === 'string' ? options.file : ''
  const known = new Set([...options.gears, CONTROL])
  /** @type {{gears: string[], sessions: Record<string, string>}|undefined} */
  let cached
  let readAt = 0
  let reported = ''

  const complain = (message) => {
    if (message === reported) return
    reported = message
    if (typeof options.onError === 'function') options.onError(message)
  }

  const load = () => {
    if (file.length === 0) return undefined
    const now = Date.now()
    if (now - readAt < TTL_MS) return cached
    readAt = now
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined
      cached = undefined
      if (code !== 'ENOENT') complain(`benchmark file unreadable: ${error && error.message ? error.message : String(error)}`)
      return cached
    }
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || parsed.enabled !== true) {
        cached = undefined
        return cached
      }
      const gears = Array.isArray(parsed.gears) ? parsed.gears.filter((name) => typeof name === 'string' && known.has(name)) : []
      if (gears.length === 0) {
        cached = undefined
        complain('benchmark file names no known gear')
        return cached
      }
      /** @type {Record<string, string>} */
      const sessions = {}
      if (parsed.sessions && typeof parsed.sessions === 'object') {
        for (const [sid, gear] of Object.entries(parsed.sessions)) {
          if (typeof gear === 'string' && known.has(gear)) sessions[sid] = gear
        }
      }
      cached = { gears: [...new Set(gears)], sessions }
      return cached
    } catch (error) {
      cached = undefined
      complain(`benchmark file is not JSON: ${error && error.message ? error.message : String(error)}`)
      return cached
    }
  }

  return {
    /** The live assignment, or undefined when no experiment is running. */
    get current() { return load() },

    /** The gear this session runs at, or undefined to use the configured one. */
    gearFor(sessionId) {
      const assignment = load()
      if (!assignment || typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      return gearFor(sessionId, assignment)
    },
  }
}
