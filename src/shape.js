/**
 * Request-shape classification: decide, before the first call, whether this
 * request is a fan-out over independent targets.
 *
 * This is deliberately a small, auditable heuristic layer rather than a model
 * call: the plugin must add no request, no latency and no network round trip.
 * It reads only the user's own words. Everything it cannot classify stays
 * native, which is the same width as "fast mode not installed".
 */

/** Phrases that mean the work is a chain, not a fan-out. */
const SERIAL = [
  /\bone\s+by\s+one\b/i,
  /\bchain\b/i,
  /\bnext\s*:/i,
  /\bdependen(?:t|cy)\b[^.]{0,20}\b(?:on|chain)\b/i,
  /\bfollow\b[^.]{0,40}\buntil\b/i,
  /\bin\s+order\b/i,
  /依次/,
  /逐个/,
  /串行/,
  /依赖/,
  /链条/,
  /一个一个/,
]

/** Phrases that mean the step goes through a shell, where fan-out buys nothing. */
const SHELLISH = [
  /\bbash\b/i,
  /\bpython3?\b/i,
  /\bnode\s+-e\b/i,
  /\bshell\b/i,
  /\bexecute\b/i,
  /\brun\b[^.]{0,30}\b(?:command|inside|in each)\b/i,
  /执行/,
  /运行/,
]

/** Phrases that mean "the same operation over many targets". */
const FANOUT = [
  /\bindependent(?:ly)?\b/i,
  /\b(?:every|all|each)\s+(?:of\s+)?(?:the\s+)?(?:files?|modules?|manifests?|logs?|directories|dirs?)\b/i,
  /\bacross\s+(?:every|all|each|the)\s+\w+/i,
  /\bper\s+(?:file|module|manifest|log|directory|dir)\b/i,
  /\bmany\s+(?:log\s+)?files\b/i,
  /\bfor\s+each\s+(?:file|module|manifest|log|directory)\b/i,
  /每个/,
  /所有/,
  /全部/,
  /分别/,
  /逐(?:个|一)/,
]

const FILE_TARGET = /\b(?:files?|modules?|manifests?|logs?|directories|dirs?)\b/gi
const COUNTED_TARGET = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty)\s+(?:[\w-]+\s+)?(?:files?|modules?|manifests?|logs?|directories|dirs?|jobs?)\b/gi

/** Backticked or bare path-like tokens, e.g. `data/nodes/`, repo/module-01.js. */
function pathTargets(text) {
  const found = new Set()
  for (const m of text.matchAll(/`([^`\s]{3,})`/g)) {
    if (/[/.]/.test(m[1])) found.add(m[1])
  }
  for (const m of text.matchAll(/(?:^|[\s(])((?:[\w.-]+\/){1,}[\w.*-]*)/g)) {
    found.add(m[1])
  }
  return found.size
}

/**
 * @param {unknown} input - the user's message text
 * @returns {{width: number, reason: string, targets: number, signals: string[]}}
 *   width 1 means native (the guidance section is not rendered at all).
 */
export function classifyEntry(input) {
  const text = typeof input === 'string' ? input : ''
  if (text.trim().length === 0) {
    return { width: 1, reason: 'empty', targets: 0, signals: [] }
  }

  const signals = []
  const serial = SERIAL.filter((re) => re.test(text))
  if (serial.length > 0) signals.push('serial')
  const shell = SHELLISH.filter((re) => re.test(text))
  if (shell.length > 0) signals.push('shell')
  const fanout = FANOUT.filter((re) => re.test(text))
  if (fanout.length > 0) signals.push('fanout')

  const targets = Math.max(pathTargets(text), [...text.matchAll(COUNTED_TARGET)].length)
  if (targets >= 4) signals.push('targets>=4')

  // A chain is a chain even when it names many files.
  if (serial.length > 0) return { width: 1, reason: 'serial', targets, signals }
  // Many independent shell jobs (one per directory, one per job) still save a
  // round trip each when they share a block; the harness runs them one after
  // another, but the model no longer pays a step per job.
  if (shell.length > 0 && fanout.length > 0) return { width: 8, reason: 'shell-fanout', targets, signals }
  if (shell.length > 0) return { width: 1, reason: 'shell', targets, signals }
  // "The same operation over many targets" is the shape fan-out is for.
  if (fanout.length > 0) return { width: 8, reason: 'fanout', targets, signals }
  if (targets >= 4) return { width: 8, reason: 'many-targets', targets, signals }
  return { width: 1, reason: 'unknown', targets, signals }
}
