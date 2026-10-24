/**
 * Adaptive reasoning-effort policy for dsh-fast-mode.
 *
 * Everything here is pure: observations in, a decision out. The plugin wires it
 * to the harness; this file holds the judgement so it can be tested without one.
 *
 * Why adaptive instead of a fixed rule: a turn that is reading twelve small
 * files in a row and succeeding needs almost no deliberation per step, while a
 * turn that just hit three errors and is looping on the same command needs full
 * deliberation. The step number alone cannot tell those apart. Tool outcomes
 * can, and the harness makes them reachable (`tools/post-execute`), so the
 * policy reads the run instead of guessing from a counter.
 */

/** The effort ids, cheapest first. */
export const EFFORT_LADDER = Object.freeze(['off', 'minimal', 'low', 'medium', 'high'])

/** Steps before this one are planning, and keep the resolved effort. */
export const FIRST_EXECUTION_STEP = 2

/** Defaults for the adaptive thresholds. */
export const DEFAULTS = Object.freeze({
  floor: 'low',
  /** Consecutive clean observations before a second notch is allowed. */
  deepAfter: 6,
  /** A call at or above this duration is treated as I/O bound, not thinking bound. */
  slowMs: 5000,
  /** A single result at or above this size is treated as heavy to digest. */
  bigChars: 20000,
  /** How many recent observations the signals look at. */
  window: 8,
  /** Restore the resolved effort past this step; 0 disables. */
  escalateAfterStep: 0,
})

/**
 * Normalise plugin config. Every field arrives from a loader patch, so a typo
 * must degrade to the default rather than to "no limit".
 *
 * @param {object} [raw]
 */
export function resolveConfig(raw) {
  const config = raw ?? {}
  const ladder = Array.isArray(config.ladder) && config.ladder.filter(id => typeof id === 'string').length >= 2
    ? Object.freeze(config.ladder.filter(id => typeof id === 'string'))
    : EFFORT_LADDER

  const number = (value, fallback, { positive = false } = {}) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    if (positive && parsed <= 0) return fallback
    return parsed
  }

  return {
    enabled: config.enabled !== false,
    floor: typeof config.floor === 'string' && ladder.includes(config.floor) ? config.floor : DEFAULTS.floor,
    ladder,
    deepAfter: Math.floor(number(config.deepAfter, DEFAULTS.deepAfter, { positive: true })),
    slowMs: Math.floor(number(config.slowMs, DEFAULTS.slowMs, { positive: true })),
    bigChars: Math.floor(number(config.bigChars, DEFAULTS.bigChars, { positive: true })),
    window: Math.floor(number(config.window, DEFAULTS.window, { positive: true })),
    escalateAfterStep: Math.floor(number(config.escalateAfterStep, DEFAULTS.escalateAfterStep, { positive: true })),
    debug: config.debug === true,
    debugFile: typeof config.debugFile === 'string' ? config.debugFile : '',
  }
}

/**
 * A stable key for a call's arguments, so a repeated identical call is
 * detectable. Key order is normalised; values are bounded so a huge payload
 * cannot make this expensive.
 *
 * @param {unknown} args
 * @returns {string}
 */
export function stableKey(args) {
  const seen = new WeakSet()
  const walk = (value, depth) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
    if (depth > 4) return '"…"'
    if (seen.has(value)) return '"<cycle>"'
    seen.add(value)
    if (Array.isArray(value)) return `[${value.slice(0, 8).map(item => walk(item, depth + 1)).join(',')}]`
    const keys = Object.keys(value).sort().slice(0, 12)
    return `{${keys.map(key => `${JSON.stringify(key)}:${walk(value[key], depth + 1)}`).join(',')}}`
  }
  try {
    const text = walk(args, 0)
    return text.length > 400 ? `${text.slice(0, 400)}…` : text
  } catch {
    return '<unserialisable>'
  }
}

/**
 * Approximate the size of a tool result, in characters.
 *
 * @param {unknown} content - the result's content blocks.
 * @returns {number}
 */
export function contentChars(content) {
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') total += block.text.length
    else if (typeof block.content === 'string') total += block.content.length
    else {
      try {
        total += JSON.stringify(block).length
      } catch {
        // An unmeasurable block contributes nothing rather than breaking the count.
      }
    }
  }
  return total
}

/** Per-agent observation store. */
export function createState() {
  return { byAgent: new Map() }
}

/**
 * Record one finished tool call.
 *
 * @param {{byAgent: Map<string, any>}} state
 * @param {string} agentId
 * @param {{name: string, argsKey: string, isError: boolean, chars: number, durationMs: number}} observation
 * @param {number} [window]
 */
export function recordObservation(state, agentId, observation, window = DEFAULTS.window) {
  const entry = state.byAgent.get(agentId) ?? { observations: [], turn: undefined }
  entry.observations.push(observation)
  // Keep a bounded tail: the policy never looks further back than `window`, and
  // an unbounded array would grow for the life of the process.
  const keep = Math.max(window * 3, 24)
  if (entry.observations.length > keep) entry.observations.splice(0, entry.observations.length - keep)
  state.byAgent.set(agentId, entry)
  return entry
}

/**
 * Tag the current turn for an agent, clearing observations collected in a
 * previous one so a prior turn's struggles do not slow down a fresh turn.
 *
 * The turn must be tagged even when no observations exist yet. Otherwise the
 * next request of the same turn would see an untagged entry, treat it as a turn
 * change, and wipe the observations the running step just produced — leaving
 * the policy permanently blind while appearing to work.
 *
 * @param {{byAgent: Map<string, any>}} state
 * @param {string} agentId
 * @param {number|undefined} turn
 * @returns {boolean} true when observations were actually cleared.
 */
export function resetTurn(state, agentId, turn) {
  const entry = state.byAgent.get(agentId)
  if (!entry) {
    state.byAgent.set(agentId, { observations: [], turn })
    return false
  }
  // An entry can be created by a tool call that ran before any request tagged
  // the turn. Tag it now without clearing: those observations belong to this
  // turn and are exactly what the policy needs.
  if (entry.turn === undefined) {
    entry.turn = turn
    return false
  }
  if (entry.turn === turn) return false
  const cleared = entry.observations.length > 0
  entry.turn = turn
  entry.observations.length = 0
  return cleared
}

/**
 * Reduce recent observations to the signals the policy acts on.
 *
 * @param {{byAgent: Map<string, any>}} state
 * @param {string} agentId
 * @param {object} [options]
 * @param {number} [options.window]
 * @param {number} [options.slowMs]
 * @param {number} [options.bigChars]
 */
export function readSignals(state, agentId, options = {}) {
  const { window = DEFAULTS.window, slowMs = DEFAULTS.slowMs, bigChars = DEFAULTS.bigChars } = options
  const entry = state.byAgent.get(agentId)
  const recent = entry ? entry.observations.slice(-window) : []

  let errors = 0
  let slowestMs = 0
  let biggestChars = 0
  const keyCounts = new Map()

  for (const observation of recent) {
    if (observation.isError) errors += 1
    slowestMs = Math.max(slowestMs, observation.durationMs || 0)
    biggestChars = Math.max(biggestChars, observation.chars || 0)
    if (observation.argsKey) keyCounts.set(observation.argsKey, (keyCounts.get(observation.argsKey) ?? 0) + 1)
  }

  const mostRepeated = keyCounts.size === 0 ? 0 : Math.max(...keyCounts.values())

  // Trailing clean streak: consecutive recent calls that all succeeded quickly
  // with small results. This is what earns the deeper notch.
  let cleanStreak = 0
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const observation = recent[index]
    const clean = !observation.isError
      && (observation.durationMs || 0) < slowMs
      && (observation.chars || 0) < bigChars
    if (!clean) break
    cleanStreak += 1
  }

  return {
    observations: recent.length,
    errors,
    slowestMs,
    biggestChars,
    mostRepeated,
    cleanStreak,
    /** A turn showing any struggle keeps full deliberation. */
    struggling: errors > 0 || slowestMs >= slowMs || biggestChars >= bigChars || mostRepeated >= 2,
  }
}

/**
 * Decide the effort for one model request.
 *
 * @param {object} input
 * @param {number} input.step
 * @param {string|undefined} input.current - the effort the harness resolved.
 * @param {object} input.config - normalised config.
 * @param {object} [input.signals] - from {@link readSignals}.
 * @returns {string|undefined}
 */
export function decideEffort(input) {
  const { step, current, config, signals } = input ?? {}
  const ladder = config?.ladder ?? EFFORT_LADDER
  const floor = config?.floor ?? DEFAULTS.floor
  const deepAfter = config?.deepAfter ?? DEFAULTS.deepAfter
  const escalateAfterStep = config?.escalateAfterStep ?? DEFAULTS.escalateAfterStep

  // An effort id from another provider's vocabulary: guessing a neighbour would
  // be inventing a value, so pass it through.
  if (typeof current !== 'string') return current
  const index = ladder.indexOf(current)
  if (index < 0) return current

  const floorIndex = Math.max(0, ladder.indexOf(floor))

  // Already at or below the floor: stepping up would turn a speed-up into a
  // slow-down.
  if (index <= floorIndex) return current

  // Planning step keeps full deliberation.
  if (!(step >= FIRST_EXECUTION_STEP)) return current

  // A turn that has run very long is treated as stuck.
  if (escalateAfterStep > 0 && step > escalateAfterStep) return current

  // Struggling turns get their deliberation back. This is the quality guard:
  // errors, hangs, oversized results, and repeat calls all mean the next action
  // is not routine.
  if (signals?.struggling) return current

  let notches = 1
  if (deepAfter > 0 && (signals?.cleanStreak ?? 0) >= deepAfter) notches = 2

  const target = Math.max(floorIndex, index - notches)
  return ladder[target]
}
