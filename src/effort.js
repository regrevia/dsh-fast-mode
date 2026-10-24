/**
 * Adaptive reasoning-effort policy for dsh-fast-mode.
 *
 * Everything here is pure: observations in, a decision out. The plugin wires it
 * to the harness; this file holds the judgement so it can be tested without one.
 *
 * Three concerns live here.
 *
 * 1. **Which effort ids exist.** Not ours to invent. Every route declares its
 *    own levels, and the harness exposes them per provider and model
 *    (`llm.resolveModelInfo` → `reasoning.efforts`). The plugin reads that list.
 *
 * 2. **Which of those ids are actually distinct.** Some upstream APIs document
 *    compatibility aliases: the official DeepSeek API accepts `minimal`,
 *    `medium` and `xhigh` but maps them onto `low`/`high`/`high`, so "drop one
 *    level from `high` to `medium`" changes nothing on the wire while looking
 *    like a working downgrade. The policy therefore notches across *effective*
 *    levels, never across raw ids, and never claims a cut it cannot deliver.
 *
 * 3. **How much to cut.** The step number alone cannot tell a routine read from
 *    a turn that is stuck; tool outcomes can, and `tools/post-execute` makes
 *    them reachable. So the policy reads the run.
 */

/**
 * The ladder used only when a provider cannot be interrogated and no explicit
 * ladder is configured. It is a fallback, not an assumption.
 */
export const EFFORT_LADDER = Object.freeze(['off', 'minimal', 'low', 'medium', 'high'])

/** Steps before this one are planning, and keep the resolved effort. */
export const FIRST_EXECUTION_STEP = 2

/**
 * Semantic rank of well-known effort ids: 0 is cheapest, higher is more
 * deliberation. Used to order ids and to compare a floor against what a route
 * actually offers. Unknown ids get no rank and keep their declared order.
 */
const RANK_BY_ID = Object.freeze({
  off: 0, none: 0, disabled: 0, no: 0, zero: 0, false: 0,
  minimal: 1, min: 1, tiny: 1, lightest: 1,
  low: 2, light: 2, fast: 2, small: 2, brief: 2, quick: 2,
  medium: 3, mid: 3, moderate: 3, default: 3, standard: 3, normal: 3, balanced: 3,
  high: 4, deep: 4, thorough: 4, extended: 4, heavy: 4,
  max: 5, maximum: 5, xhigh: 5, 'extra-high': 5, ultra: 5, extreme: 5, highest: 5,
})

/**
 * The alias contract documented by the official DeepSeek API for
 * `reasoning_effort`: `none` disables thinking; `low`, `high` and `max` enable
 * it at increasing effort; `minimal` maps to `low`, `xhigh` maps to `high`, and
 * `medium` maps to `high`.
 *
 * Applied only when a route turns out to be this family (it declares `max`), so
 * a gateway with genuinely distinct levels is not collapsed by mistake. Override
 * with `aliases` in the config, or turn it off entirely.
 */
export const DOCUMENTED_ALIASES = Object.freeze({
  off: 'none',
  none: 'none',
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'high',
  max: 'max',
})

/** Defaults for the adaptive thresholds. */
/**
 * Speed gears.
 *
 * A gear is one coherent stance, not a single number: how early a clean streak
 * earns a deeper notch, how much of the run the signals look at, and how many
 * independent tool calls the model is asked to issue per step. Raising the gear
 * trades tokens and risk for wall clock; it never changes what the plugin is
 * *allowed* to emit (the floor still holds, and the route still declares the
 * ladder).
 *
 * `parallel` is the target fan-out the guidance asks for. The harness schedules
 * the calls of one message concurrently only while each is declared safe and
 * `agentLoop.maxParallelToolCalls` still has a free slot, so the target is an
 * upper bound, never a promise.
 */
export const GEARS = Object.freeze({
  safe: Object.freeze({
    level: 1,
    floor: 'low',
    deepAfter: 6,
    window: 8,
    parallel: 2,
    directive: false,
  }),
  fast: Object.freeze({
    level: 2,
    floor: 'low',
    deepAfter: 4,
    window: 6,
    parallel: 4,
    directive: true,
  }),
  turbo: Object.freeze({
    level: 3,
    floor: 'low',
    deepAfter: 3,
    window: 5,
    parallel: 6,
    directive: true,
  }),
  max: Object.freeze({
    level: 4,
    floor: 'low',
    deepAfter: 2,
    window: 4,
    parallel: 8,
    directive: true,
  }),
  // The only honest route to 3-4x on a thinking model is to stop paying for
  // thinking: `floor: 'off'` lets the policy settle on the route's `off` level,
  // where the provider emits no reasoning tokens at all. Everything else the
  // plugin owns (dropping `high` to `low`, widening a step to 8 calls) is worth
  // roughly 2x at best. This gear therefore ships with a warning label in the
  // picker instead of a promise: deep multi-step work gets noticeably worse.
  ludicrous: Object.freeze({
    level: 5,
    floor: 'off',
    deepAfter: 1,
    window: 4,
    parallel: 8,
    directive: true,
  }),
})

/**
 * The gear used when the config names none. A plugin called fast mode that
 * installs itself in its do-nothing gear would be a joke, so the shipped
 * default is `fast`; `gear: safe` restores the previous release exactly.
 */
export const DEFAULT_GEAR = 'fast'

/**
 * The gear an unreadable value degrades to. A typo must not silently turn on
 * prompt injection, so an *unknown* gear is more conservative than an absent
 * one.
 */
export const FALLBACK_GEAR = 'safe'

/**
 * Resolve the configured gear, accepting either the name or its level number.
 * An unknown value falls back to the default rather than guessing.
 *
 * @param {unknown} value
 * @returns {string} a key of {@link GEARS}
 */
export function normaliseGear(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    for (const [, gear] of Object.entries(GEARS)) if (gear.level === value) return gearName(gear)
    return FALLBACK_GEAR
  }
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase()
    if (key.length === 0) return DEFAULT_GEAR
    if (Object.hasOwn(GEARS, key)) return key
    if (/^[1-4]$/.test(key)) return normaliseGear(Number(key))
    return FALLBACK_GEAR
  }
  return value === undefined || value === null ? DEFAULT_GEAR : FALLBACK_GEAR
}

/** @param {object} gear @returns {string} the gear's own name */
function gearName(gear) {
  return Object.keys(GEARS).find(name => GEARS[name] === gear) ?? FALLBACK_GEAR
}

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
  /** How long to wait for provider metadata before deciding without it. */
  discoverTimeoutMs: 250,
  /** Downgrade from the model's declared default when no effort was resolved. */
  baselineFromDefault: true,
  /** Calls to these tools mean the work is not routine; see matchesHold. */
  holdTools: Object.freeze([]),
  /** Per-step measurement sink; see metrics.js and bin/report.mjs. */
  metricsFile: '~/.dsh/fast-mode-metrics.jsonl',
  /** Experiment assignment file; absent or `{enabled:false}` means no experiment. */
  benchmarkFile: '~/.dsh/fast-mode-bench.json',
})

/**
 * Whether a tool name matches one of the `holdTools` patterns.
 *
 * `holdTools` exists for tools whose *next* step needs deliberation even though
 * the calls around them look routine — context-compression tools are the case
 * that motivated it. A `compress` call returns a small summary and succeeds
 * quickly, so the clean-streak rule would happily cheapen the very next step:
 * the one where the model re-orients in the freshly folded history, or decides
 * what to compress next. Listing the tool name pins full effort instead.
 *
 * A pattern matches case-insensitively, either exactly or as a prefix when it
 * ends in `*` (`acp_*` covers a whole family of context-management tools).
 *
 * @param {unknown} name - the tool name from a finished call.
 * @param {readonly string[]} [patterns] - configured `holdTools` patterns.
 * @returns {boolean}
 */
export function matchesHold(name, patterns) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  const candidate = name.trim().toLowerCase()
  if (candidate.length === 0) return false
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue
    const needle = pattern.trim().toLowerCase()
    if (needle.length === 0) continue
    if (needle.endsWith('*')) {
      if (candidate.startsWith(needle.slice(0, -1))) return true
      continue
    }
    if (candidate === needle) return true
  }
  return false
}

/**
 * Semantic rank of an effort id, or undefined for an id this plugin does not
 * recognise. Comparison is case-insensitive and ignores separators, so `x-high`
 * and `XHIGH` land on the same rank.
 *
 * @param {unknown} id
 * @returns {number|undefined}
 */
export function rankOf(id) {
  if (typeof id !== 'string') return undefined
  const key = id.trim().toLowerCase()
  if (Object.hasOwn(RANK_BY_ID, key)) return RANK_BY_ID[key]
  const collapsed = key.replace(/[^a-z]/g, '')
  if (Object.hasOwn(RANK_BY_ID, collapsed)) return RANK_BY_ID[collapsed]
  return undefined
}

/**
 * Order declared effort ids cheapest first. When every id is recognised the
 * semantic rank decides; otherwise the adapter's own order is kept, because it
 * is the only information that cannot be wrong.
 *
 * @param {readonly string[]} ids
 * @returns {readonly string[]}
 */
export function orderEfforts(ids) {
  const unique = []
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0 && !unique.includes(id)) unique.push(id)
  }
  if (unique.length < 2) return Object.freeze(unique)
  if (unique.some(id => rankOf(id) === undefined)) return Object.freeze(unique)
  return Object.freeze([...unique].sort((a, b) => rankOf(a) - rankOf(b)))
}

/**
 * Decide whether the documented alias contract applies to a route: it does when
 * the route offers a top level (`max` / `xhigh` family), which is the family the
 * official API belongs to. A route that stops at `high` offers distinct levels
 * for every id it declares, and must not be collapsed.
 *
 * @param {readonly string[]} ids
 * @returns {boolean}
 */
export function looksAliased(ids) {
  return ids.some(id => rankOf(id) === 5)
}

/**
 * Build the send ladder for a route: one id per effective level, cheapest first.
 *
 * Each entry carries the ids that collapse into it, so the policy can look up a
 * resolved effort by its raw id and still land on the right effective level.
 *
 * @param {readonly string[]} declared - ids the route accepts, in its own order.
 * @param {false|Record<string, string>|'auto'|true|undefined} aliasSetting
 * @returns {{levels: {id: string, canonical: string, rank: number|undefined, ids: string[]}[], aliases: Record<string,string>|undefined, aliased: boolean}}
 */
export function buildLadder(declared, aliasSetting) {
  const ordered = orderEfforts(declared)
  let aliases
  if (aliasSetting === false) aliases = undefined
  else if (aliasSetting && typeof aliasSetting === 'object') aliases = aliasSetting
  else if (aliasSetting === 'auto' || aliasSetting === true || aliasSetting === undefined) {
    aliases = looksAliased(ordered) ? DOCUMENTED_ALIASES : undefined
  } else aliases = undefined

  // Without aliases, every declared id is its own level.
  if (!aliases) {
    return {
      levels: ordered.map(id => ({ id, canonical: id, rank: rankOf(id), ids: [id] })),
      aliases: undefined,
      aliased: false,
    }
  }

  // With aliases, ids are grouped by canonical name. If any id cannot be
  // canonicalised the grouping would be a guess, so fall back to raw ids.
  const canonicalOf = id => {
    const key = id.trim().toLowerCase()
    return aliases[key] ?? aliases[id] ?? id
  }
  if (ordered.some(id => rankOf(canonicalOf(id)) === undefined)) {
    return {
      levels: ordered.map(id => ({ id, canonical: id, rank: rankOf(id), ids: [id] })),
      aliases: undefined,
      aliased: false,
    }
  }

  const byCanonical = new Map()
  for (const id of ordered) {
    const canonical = canonicalOf(id)
    const bucket = byCanonical.get(canonical)
    if (bucket) bucket.ids.push(id)
    else byCanonical.set(canonical, { canonical, rank: rankOf(canonical), ids: [id] })
  }

  const levels = [...byCanonical.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(bucket => ({
      // Prefer sending the canonical name itself when the route accepts it;
      // otherwise send the first declared id that reaches this level.
      id: bucket.ids.includes(bucket.canonical) ? bucket.canonical : bucket.ids[0],
      canonical: bucket.canonical,
      rank: bucket.rank,
      ids: bucket.ids,
    }))

  return { levels, aliases: { ...aliases }, aliased: true }
}

/**
 * Map a floor request onto the ladder: the cheapest level that is not cheaper
 * than the request. Dropping below the floor is the one direction this policy
 * must never drift.
 *
 * @param {{levels: {rank: number|undefined}[]}} ladder
 * @param {string} requested
 * @returns {number} level index
 */
export function floorIndex(ladder, requested) {
  const levels = ladder.levels
  if (levels.length === 0) return 0
  const wanted = rankOf(requested)
  if (wanted === undefined) return 0
  for (let index = 0; index < levels.length; index += 1) {
    const rank = levels[index].rank
    if (rank !== undefined && rank >= wanted) return index
  }
  return levels.length - 1
}

/**
 * Build the full decision plan for one route.
 *
 * @param {readonly string[]|undefined} declared - ids the route accepts.
 * @param {object} config - normalised config.
 * @returns {{levels: object[], aliased: boolean, floorIndex: number, indexOf: (id: string) => number, source: string, floorId: string|undefined}}
 */
export function resolvePlan(declared, config) {
  const usable = Array.isArray(declared)
    ? declared.filter(id => typeof id === 'string' && id.length > 0)
    : []

  let ladder
  let source
  // An empty array means the route was interrogated and declares no levels at
  // all. That is an answer ("this model has no effort to cut"), not a missing
  // one, so it must never fall back to a guessed ladder: sending an effort a
  // route does not declare makes the harness reject the call before I/O.
  if (Array.isArray(declared)) {
    ladder = buildLadder(usable, config.aliases)
    source = usable.length === 0 ? 'provider-none' : ladder.aliased ? 'provider+aliases' : 'provider'
  } else {
    ladder = buildLadder(config.ladder, config.aliases === undefined ? false : config.aliases)
    source = config.ladderExplicit ? 'configured' : 'builtin'
  }

  const byId = new Map()
  ladder.levels.forEach((level, index) => {
    for (const id of level.ids) byId.set(id, index)
    byId.set(level.id, index)
  })

  const index = floorIndex(ladder, config.floor)
  return {
    levels: ladder.levels,
    aliased: ladder.aliased,
    floorIndex: index,
    floorId: ladder.levels[index]?.id,
    source,
    indexOf: id => (typeof id === 'string' ? byId.get(id) ?? -1 : -1),
  }
}

/**
 * The shared symbol a volatile config reference is written through.
 *
 * Read from the global registry rather than imported: the reference protocol is
 * identified by this symbol precisely so that two copies of the library agree.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Whether a config value is a live reference instead of plain data.
 *
 * @param {unknown} value
 */
export function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
    && typeof (/** @type {any} */ (value).get) === 'function'
}

/**
 * Read the current value out of a volatile config field.
 *
 * A field the schema marks `.volatile()` reaches a running plugin as a frozen
 * reference, not as its value: the Loader swaps the value inside the reference
 * so a settings edit lands without remounting the plugin. Every other field is
 * plain data, so this is a no-op for them.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function plainConfigValue(value) {
  return /** @type {any} */ (isVolatileRef(value) ? /** @type {any} */ (value).get() : value)
}

/**
 * Normalise plugin config. Every field arrives from a loader patch, so a typo
 * must degrade to the default rather than to "no limit".
 *
 * Volatile fields are unwrapped here, at the single boundary every read passes
 * through: comparing `enabled === true` against a reference would be false even
 * when the switch is on.
 *
 * @param {object} [raw]
 * @param {Record<string, unknown>} [overrides] - resolved after unwrapping, so a
 *   caller can pin one field (`gear`) without having to rebuild the raw config.
 */
export function resolveConfig(raw, overrides) {
  const source = plainConfigValue(raw) ?? {}
  const config = /** @type {Record<string, unknown>} */ ({
    ...Object.fromEntries(
      Object.entries(source).map(([key, value]) => [key, plainConfigValue(value)]),
    ),
    ...(overrides && typeof overrides === 'object' ? overrides : {}),
  })
  const gearName = normaliseGear(config.gear)
  const gear = GEARS[gearName]
  const configured = Array.isArray(config.ladder)
    ? config.ladder.filter(id => typeof id === 'string' && id.length > 0)
    : []
  const ladder = configured.length >= 2 ? Object.freeze(configured) : EFFORT_LADDER

  const number = (value, fallback, { positive = false } = {}) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    if (positive && parsed <= 0) return fallback
    return parsed
  }

  let aliases
  if (config.aliases === false) aliases = false
  else if (config.aliases === 'auto' || config.aliases === undefined || config.aliases === true) aliases = 'auto'
  else if (config.aliases && typeof config.aliases === 'object') aliases = config.aliases
  else aliases = 'auto'

  // A floor that cannot be ranked and is not on the pinned ladder would resolve
  // to the cheapest level, silently permitting a drop that disables thinking.
  // A typo must degrade to the default floor, not to no floor.
  const requestedFloor = typeof config.floor === 'string' && config.floor.length > 0 ? config.floor : gear.floor
  const floor = rankOf(requestedFloor) !== undefined || ladder.includes(requestedFloor)
    ? requestedFloor
    : gear.floor

  return {
    // Opt-in, never opt-out: fast mode trades deliberation for latency, so the
    // absence of a decision means "leave the harness alone". Only an explicit
    // `true` turns it on; `1`/`'yes'`/a stray string stay off rather than
    // silently changing how the model thinks.
    enabled: config.enabled === true,
    floor,
    ladder,
    /** An operator-pinned ladder is authoritative, so it may be used without discovery. */
    ladderExplicit: configured.length >= 2,
    aliases,
    gear: gearName,
    gearLevel: gear.level,
    /** Target fan-out the model-facing guidance asks for; 1 means no guidance. */
    parallel: gear.directive ? Math.floor(number(config.parallel, gear.parallel, { positive: true })) : 1,
    directive: gear.directive,
    deepAfter: Math.floor(number(config.deepAfter, gear.deepAfter, { positive: true })),
    slowMs: Math.floor(number(config.slowMs, DEFAULTS.slowMs, { positive: true })),
    bigChars: Math.floor(number(config.bigChars, DEFAULTS.bigChars, { positive: true })),
    window: Math.floor(number(config.window, gear.window, { positive: true })),
    holdTools: normaliseHoldTools(config.holdTools),
    escalateAfterStep: Math.floor(number(config.escalateAfterStep, DEFAULTS.escalateAfterStep, { positive: true })),
    discoverTimeoutMs: Math.floor(number(config.discoverTimeoutMs, DEFAULTS.discoverTimeoutMs, { positive: true })),
    baselineFromDefault: config.baselineFromDefault !== false,
    debug: config.debug === true,
    debugFile: typeof config.debugFile === 'string' ? config.debugFile : '',
    /**
     * Measurement sink. On by default: a speed plugin nobody can verify is a
     * claim, and the comparison needs the sessions that run *without* it just as
     * much as the ones that run with it.
     */
    metrics: config.metrics !== false,
    metricsFile: typeof config.metricsFile === 'string' && config.metricsFile.length > 0
      ? config.metricsFile
      : DEFAULTS.metricsFile,
    /**
     * Experiment assignment file. Empty by default: no experiment, and the
     * configured gear is the only stance.
     */
    benchmarkFile: typeof config.benchmarkFile === 'string' ? config.benchmarkFile : DEFAULTS.benchmarkFile,
  }
}

/**
 * Normalise the `holdTools` config into a list of patterns.
 *
 * Accepts an array, or the single comma/whitespace separated string a YAML
 * scalar produces (`holdTools: compress, acp_*`), which is the shape an operator
 * is most likely to write by hand. Junk entries are dropped rather than
 * rejected: a malformed list must not take the whole policy down.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normaliseHoldTools(value) {
  const raw = typeof value === 'string' ? value.split(/[\s,]+/) : value
  if (!Array.isArray(raw)) return []
  const patterns = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const pattern = entry.trim()
    if (pattern.length === 0) continue
    if (!patterns.includes(pattern)) patterns.push(pattern)
  }
  return patterns
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
  const {
    window = DEFAULTS.window,
    slowMs = DEFAULTS.slowMs,
    bigChars = DEFAULTS.bigChars,
    holdTools = DEFAULTS.holdTools,
  } = options
  const entry = state.byAgent.get(agentId)
  const recent = entry ? entry.observations.slice(-window) : []

  let errors = 0
  let slowestMs = 0
  let biggestChars = 0
  let held = 0
  const keyCounts = new Map()

  for (const observation of recent) {
    if (observation.isError) errors += 1
    slowestMs = Math.max(slowestMs, observation.durationMs || 0)
    biggestChars = Math.max(biggestChars, observation.chars || 0)
    if (matchesHold(observation.name, holdTools)) held += 1
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
    /** Calls to a `holdTools` entry in the window. */
    held,
    /**
     * A turn showing any struggle keeps full deliberation, and so does a step
     * taken right after a tool the operator asked to hold effort around.
     */
    struggling: errors > 0 || slowestMs >= slowMs || biggestChars >= bigChars || mostRepeated >= 2 || held > 0,
  }
}

/**
 * Decide the effort for one model request.
 *
 * @param {object} input
 * @param {number} input.step
 * @param {string|undefined} input.current - the effort the harness resolved.
 * @param {string|undefined} [input.baseline] - effort to downgrade from when `current` is absent.
 * @param {{levels: object[], floorIndex: number, indexOf: (id: string) => number}} input.plan
 * @param {object} input.config
 * @param {object} [input.signals]
 * @returns {string|undefined} the effort to send, or the original value to leave alone.
 */
export function decideEffort(input) {
  const { step, config, signals, plan } = input ?? {}
  if (!plan || !Array.isArray(plan.levels) || plan.levels.length === 0) return input?.current

  const deepAfter = config?.deepAfter ?? DEFAULTS.deepAfter
  const escalateAfterStep = config?.escalateAfterStep ?? DEFAULTS.escalateAfterStep

  // When the harness resolved no effort, the provider's own declared default is
  // the honest baseline: it is what the request would have used anyway, so a
  // notch below it is a real cut rather than a guess.
  const current = typeof input?.current === 'string' ? input.current : input?.baseline
  if (typeof current !== 'string') return input?.current

  // An id the route does not offer cannot be ranked, so guessing a neighbour
  // would be inventing a value the provider may reject outright.
  const index = plan.indexOf(current)
  if (index < 0) return input?.current

  // Already at or below the floor: stepping up would turn a speed-up into a
  // slow-down.
  if (index <= plan.floorIndex) return input?.current

  // Planning step keeps full deliberation.
  if (!(step >= FIRST_EXECUTION_STEP)) return input?.current

  // A turn that has run very long is treated as stuck.
  if (escalateAfterStep > 0 && step > escalateAfterStep) return input?.current

  // Struggling turns get their deliberation back. This is the quality guard:
  // errors, hangs, oversized results, and repeat calls all mean the next action
  // is not routine.
  if (signals?.struggling) return input?.current

  let notches = 1
  if (deepAfter > 0 && (signals?.cleanStreak ?? 0) >= deepAfter) notches = 2

  const target = Math.max(plan.floorIndex, index - notches)
  return plan.levels[target].id
}
