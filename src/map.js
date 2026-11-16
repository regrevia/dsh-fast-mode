/**
 * A bounded workspace inventory, delivered once per session.
 *
 * The measured reason this exists: in the recorded `def15` sessions of the bench
 * suite, **35.7 % of all tool calls were discovery** (`ls`, `find`, `cat`,
 * `grep`, `head`, …), and **40 % of the first two calls of a session** were the
 * same. Those calls are not work; they are the model paying a round trip to
 * learn what is in a directory it was just pointed at. Each round trip costs one
 * step of reasoning plus one step of TTFT, and the bench fit says wall clock is
 * ~97 % output tokens with steps on top.
 *
 * So the harness can do the inventory itself: walk the session cwd once, hand
 * the model a capped list of paths (with sizes) and the test entry points it
 * would otherwise search for. Nothing is hidden from the model and nothing is
 * summarised away — files it needs are still there to read; this only removes
 * the "what is here" round trip.
 *
 * Design limits, deliberately tight:
 *
 * - depth 2, 60 entries by default, known clutter (`node_modules`, `.git`,
 *   build output, caches) skipped;
 * - at the default cap the whole message stays under 1 400 characters, so it
 *   costs picture-frame tokens, not a re-read; raising `mapEntries` scales that
 *   bound with it, and the listing is always cut at a whole path — half a path
 *   is a filename the model cannot open;
 * - every failure path returns `null` (no cwd, unreadable dir, empty dir) and
 *   the caller sends nothing. A map is a convenience, never a precondition.
 *
 * @module dsh-fast-mode/map
 */
import fs from 'node:fs'
import path from 'node:path'

const SKIP = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  'coverage', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache',
  '.next', '.turbo', '.cache', '.idea', '.vscode', '.DS_Store',
])

const MAX_ENTRIES = 60
const MAX_DEPTH = 2
const MAX_TEXT = 1400

// The listing is cut at a whole entry, never mid-path: a truncated path is a
// filename the model cannot open and would have to unlearn. So the walk always
// collects a few more than the cap and the text bound decides how many are
// actually printed.
const OVERSCAN = 40

// Roughly what one listing line costs (a path, a size, the newline). Only used
// when `mapEntries` is raised above the default: the default arm must keep
// emitting byte-for-byte the same message it did before, so its text bound is
// unchanged.
const CHARS_PER_ENTRY = 34
const MAX_TEXT_HARD = 6000

function textBoundFor(cap) {
  if (cap <= MAX_ENTRIES) return MAX_TEXT
  return Math.min(MAX_TEXT_HARD, MAX_TEXT + (cap - MAX_ENTRIES) * CHARS_PER_ENTRY)
}

function walk(root, dir, depth, out, limit) {
  let names
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  names.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  for (const entry of names) {
    if (out.length >= limit) return
    if (SKIP.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    // The map is read by the model, not by this shell: forward slashes keep one
    // spelling on every platform instead of \\ on Windows.
    const rel = path.relative(root, abs).split(path.sep).join('/')
    if (entry.isDirectory()) {
      out.push(`${rel}/`)
      if (depth < MAX_DEPTH) walk(root, abs, depth + 1, out, limit)
    } else if (entry.isFile()) {
      let size = ''
      try {
        size = ` ${fs.statSync(abs).size}B`
      } catch {
        size = ''
      }
      out.push(`${rel}${size}`)
    }
  }
}

function readText(file, limit = 200_000) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text.length > limit ? text.slice(0, limit) : text
  } catch {
    return ''
  }
}

/**
 * Test entry points the model would otherwise probe for. Only signals that are
 * actually present in the tree are reported, so the map never suggests a command
 * that cannot work.
 */
function testHints(root) {
  const hints = []
  const pkg = readText(path.join(root, 'package.json'))
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg)
      const script = parsed?.scripts?.test
      if (typeof script === 'string' && script.trim() !== '') hints.push(`npm test (${script.trim()})`)
    } catch {
      // A broken package.json is not this module's problem.
    }
  }
  const tryDir = (rel, label) => {
    try {
      if (fs.statSync(path.join(root, rel)).isDirectory()) hints.push(label)
    } catch {
      // absent
    }
  }
  tryDir('tests', 'tests/')
  tryDir('test', 'test/')
  const files = (() => {
    try {
      return fs.readdirSync(root)
    } catch {
      return []
    }
  })()
  if (files.some(f => /^pytest\.ini$|^pyproject\.toml$|^setup\.cfg$|^tox\.ini$/.test(f))) {
    hints.push('pytest')
  }
  if (files.some(f => /^.*_test\.go$|^go\.mod$/.test(f))) hints.push('go test ./...')
  if (files.some(f => /^Cargo\.toml$/.test(f))) hints.push('cargo test')
  if (files.some(f => /^Makefile$/.test(f))) hints.push('make (Makefile present)')
  return hints
}

/**
 * Build the inventory text for a working directory.
 *
 * @param {string|undefined} cwd Absolute path of the session cwd.
 * @param {object} [options]
 * @param {number} [options.maxEntries] Cap on listed paths.
 * @returns {string|null} Text to hand the model, or `null` when unavailable.
 */
export function buildWorkspaceMap(cwd, options = {}) {
  if (typeof cwd !== 'string' || cwd === '') return null
  let root
  try {
    root = fs.realpathSync(cwd)
    if (!fs.statSync(root).isDirectory()) return null
  } catch {
    return null
  }
  // Ask the walk for a little more than the caller's cap so the text bound has
  // something to trim against instead of cutting the last path in half.
  const cap = Math.max(1, Math.floor(Number(options.maxEntries) || MAX_ENTRIES))
  const entries = []
  walk(root, root, 1, entries, cap + OVERSCAN)
  const hints = testHints(root)
  if (entries.length === 0 && hints.length === 0) return null

  const head = `Auto map: one inventory of ${root} so you do not need a discovery round trip.`
  const tail = [
    ...(hints.length > 0 ? [`Test entry points present: ${hints.join(', ')}.`] : []),
    'Read the files you need; this only replaces the "what is in the directory" step.',
  ]

  // Shrink the listing from the caller's cap one whole entry at a time until
  // the assembled message fits. A path is never cut in half: half a path is a
  // filename the model cannot open.
  const assemble = (n) => {
    const more = entries.length > n
    // The walk stops collecting at cap + OVERSCAN, so a full overscan proves
    // only "at least this many" and the total is not stated then.
    const total = entries.length < cap + OVERSCAN ? String(entries.length) : 'more'
    const header = more
      ? `Entries (depth <= ${MAX_DEPTH}, first ${n} of ${total}):`
      : `Entries (depth <= ${MAX_DEPTH}):`
    return [
      head,
      header,
      ...entries.slice(0, n).map(e => `- ${e}`),
      ...tail,
    ].join('\n')
  }

  const bound = textBoundFor(cap)
  let listed = Math.min(cap, entries.length)
  let text = assemble(listed)
  while (text.length > bound && listed > 0) {
    listed -= 1
    text = assemble(listed)
  }
  return text.length > bound ? null : text
}
