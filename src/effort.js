/**
 * Config → the one resolved stance for a session.
 *
 * ## What this module no longer does
 *
 * Up to 0.9.x this file contained a reasoning-effort policy: each gear declared a
 * `floor`, and `decideEffort` rewrote `reasoningEffort` downwards from the second
 * step of every turn. It looked like a speed lever, and it was not even that —
 * the public-benchmark runs measured zero reasoning tokens on the target route,
 * so lowering the effort bought no wall clock. It did do real damage, though: the
 * rewrite reached the provider as a request header, the composer capsule projects
 * "last used effort" from those headers, so a conversation the user had chosen to
 * run at Medium drifted to Low and stayed there across restarts. The plugin
 * changed the question instead of the speed of answering it.
 *
 * That code is gone, not disabled. Fast mode must never touch `reasoningEffort`,
 * `thinking`, temperature, or any other property that changes what the model
 * thinks about: the requested effort is the user's contract, and "same effort,
 * sooner" is the only honest claim available. What remains is the part that makes
 * the same work finish sooner:
 *
 * - **fan-out** — how many independent tool calls one step may carry;
 * - **output discipline** — not narrating every call twice;
 * - **bounded calls** — a ceiling on a single tool call (see `stallguard.js`);
 * - **progress breaking** — stopping a session that keeps running without
 *   learning anything (see `auto.js`).
 *
 * ## Gears
 *
 * A gear is now only a width preset. `auto` is the shipped default and lets
 * `auto.js` choose per step; the fixed ids stay addressable because existing
 * patches and the experiment harness refer to them by name. Any fixed gear named
 * in a patch is read as `auto` (see `resolveConfig`), because that is what the
 * user meant when they picked a number in the old ladder: "make it faster".
 *
 * @module dsh-fast-mode/effort
 */

/**
 * The gear table. `level` only orders the experiment arms and the settings
 * selector; it carries no capability meaning any more.
 */
export const GEARS = Object.freeze({
  // Do nothing at all: no prompt section, no observation, no ceiling.
  safe: Object.freeze({
    level: 0,
    parallel: 2,
    directive: false,
    discipline: 'off',
  }),
  fast: Object.freeze({
    level: 2,
    parallel: 4,
    directive: true,
    discipline: 'light',
  }),
  // The default. Static numbers are only the starting point: `autoSchedule`
  // overrides the width and the call ceiling as the session produces evidence.
  auto: Object.freeze({
    level: 3,
    parallel: 4,
    directive: true,
    discipline: 'full',
    adaptive: true,
  }),
  turbo: Object.freeze({
    level: 3,
    parallel: 6,
    directive: true,
    discipline: 'full',
  }),
  max: Object.freeze({
    level: 4,
    parallel: 8,
    directive: true,
    discipline: 'full',
  }),
  ludicrous: Object.freeze({
    level: 5,
    parallel: 8,
    directive: true,
    discipline: 'full',
  }),
})

/**
 * Gear ids that older patches still name. Reading one as `auto` is deliberate: a
 * pinned `turbo` used to mean "also think less", and that meaning is retired, so
 * honouring the width while dropping the effort rewrite would keep a number the
 * user never chose. They get the scheduler instead, and the load log says so once.
 */
export const LEGACY_GEARS = Object.freeze(['fast', 'turbo', 'max', 'ludicrous'])

/** The gear used when the config names none. */
export const DEFAULT_GEAR = 'auto'

/** The gear an unreadable value degrades to: a typo must not inject anything. */
export const FALLBACK_GEAR = 'safe'

/** Defaults for the fields that survive resolveConfig. */
/**
 * Resolve the metrics journal path.
 *
 * The composition value wins; while it is still the built-in default,
 * `DSH_FAST_MODE_METRICS_FILE` may redirect it. Benchmarks need that hook: the
 * runner reads the journal by byte offset, so two campaigns running at once
 * must not share a file. Paths are read once at load, like every other path.
 *
 * @param {unknown} configured
 * @returns {string}
 */
export function resolveMetricsFile(configured) {
  const value = typeof configured === 'string' && configured.length > 0 ? configured : DEFAULTS.metricsFile
  const override = process.env.DSH_FAST_MODE_METRICS_FILE
  return value === DEFAULTS.metricsFile && typeof override === 'string' && override.length > 0 ? override : value
}

export const DEFAULTS = Object.freeze({
  metricsFile: '~/.dsh/fast-mode-metrics.jsonl',
  benchmarkFile: '~/.dsh/fast-mode-bench.json',
})

/**
 * Resolve a gear name or its legacy level number.
 *
 * @param {unknown} value
 * @returns {string} a key of {@link GEARS}
 */
export function normaliseGear(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    for (const [name, gear] of Object.entries(GEARS)) if (gear.level === value) return name
    return FALLBACK_GEAR
  }
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase()
    if (key.length === 0) return DEFAULT_GEAR
    if (Object.hasOwn(GEARS, key)) return key
    if (/^[0-5]$/.test(key)) return normaliseGear(Number(key))
    return FALLBACK_GEAR
  }
  return value === undefined || value === null ? DEFAULT_GEAR : FALLBACK_GEAR
}

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
 * A `.volatile()` field reaches a running plugin as a frozen reference: the Loader
 * swaps the value inside it so a settings edit lands without remounting. Every
 * other field is plain data, so this is a no-op for them.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function plainConfigValue(value) {
  return /** @type {any} */ (isVolatileRef(value) ? /** @type {any} */ (value).get() : value)
}

/**
 * Normalise plugin config. A typo degrades to a default, never to "no limit".
 *
 * @param {object} [raw]
 * @param {Record<string, unknown>} [overrides] - applied after unwrapping; an
 *   override is authoritative (the experiment harness pins gear ids through it).
 */
export function resolveConfig(raw, overrides) {
  const source = plainConfigValue(raw) ?? {}
  const config = /** @type {Record<string, unknown>} */ ({
    ...Object.fromEntries(
      Object.entries(source).map(([key, value]) => [key, plainConfigValue(value)]),
    ),
    ...(overrides && typeof overrides === 'object' ? overrides : {}),
  })

  const pinned = overrides && typeof overrides === 'object' && Object.hasOwn(overrides, 'gear')
  const named = normaliseGear(config.gear)
  // A legacy name in the user's own config becomes the scheduler; an explicit
  // override (experiment arm) is kept as written, including `off`.
  const legacyGear = !pinned && LEGACY_GEARS.includes(named) ? named : undefined
  const gearName = legacyGear ? DEFAULT_GEAR : named
  const gear = GEARS[gearName] ?? GEARS[FALLBACK_GEAR]

  const number = (value, fallback, { positive = false } = {}) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    if (positive && parsed <= 0) return fallback
    return parsed
  }

  return {
    // Opt-in, never opt-out: only an explicit `true` turns fast mode on.
    enabled: config.enabled === true,
    gear: gearName,
    gearLevel: gear.level,
    /** Name the config asked for when it was a retired gear id. */
    legacyGear,
    adaptive: gear.adaptive === true,
    /** The static target; `autoSchedule` replaces it per step at `auto`. */
    parallel: gear.directive
      ? Math.min(8, Math.max(1, Math.floor(number(config.parallel, gear.parallel, { positive: true }))))
      : 1,
    directive: gear.directive,
    /** Widest block the scheduler may ask for; 0 = built-in cap. */
    fanoutWidth: gear.directive
      ? Math.min(12, Math.max(0, Math.floor(number(config.fanoutWidth, 0))))
      : 0,
    /** One workspace inventory per session, before the first tool call. */
    workspaceMap: config.workspaceMap === true,
    /** Cap on the inventory listing; the default keeps it under ~1.4 kB. */
    mapEntries: Math.min(200, Math.max(10, Math.floor(number(config.mapEntries, 60, { positive: true })))),
    /** How much visible prose the model is asked to cut. */
    discipline:
      gear.directive && config.outputDiscipline !== false && config.outputDiscipline !== 'late'
        ? gear.discipline
        : 'off',
    /** `outputDiscipline: 'late'` — compress from step 4 on, via the scheduler. */
    lateDiscipline: gear.directive && config.outputDiscipline === 'late',
    /**
     * Optional user hard stop after this many steps in one turn. 0 = no stop,
     * which is the default: the scheduler does not end a turn on a counter.
     */
    stepBudget: gear.directive ? Math.max(0, Math.floor(number(config.stepBudget, 0))) : 0,
    /** One "finish the batch, then run one covering check" reminder per edit batch. */
    batchVerify: gear.directive && config.batchVerify === true,
    /**
     * Stop asking for parallel work once this turn is clearly write-heavy. The
     * gate reads the turn's own calls, not the task family, so it needs no
     * classifier; opt-in because it only ever removes a saving.
     */
    shapeGate: gear.directive && config.shapeGate === true,
    /**
     * The directive half of the scheduler, switchable on its own. Width and the
     * watchdog budget are untouched by it, so `scheduler: false` measures
     * "parallel fan-out and tighter timeouts, but no reminder copy"; without this
     * knob output-discipline and scheduling cannot be separated, because the
     * discipline channel is itself gated on `gear.directive`.
     */
    scheduler: gear.directive && config.scheduler !== false,
    /** Optional ceiling on decoded output per turn, from upstream usage; 0 = off. */
    outputBudget: gear.directive ? Math.max(0, Math.floor(number(config.outputBudget, 0))) : 0,
    /** Steps a turn must have run before the output budget may fire; 0 = immediately. */
    outputBudgetAfterSteps: gear.directive
      ? Math.max(0, Math.floor(number(config.outputBudgetAfterSteps, 0)))
      : 0,
    /** Step at which the late compression reminder fires; 0 = built-in default. */
    disciplineAfterSteps: gear.directive
      ? Math.max(0, Math.floor(number(config.disciplineAfterSteps, 0)))
      : 0,
    /** One "batch the opening step" reminder per turn, for short tasks. */
    openBatch: gear.directive && config.openBatch === true,
    /** One "send hunks, not whole files" reminder after a large whole-file write. */
    preferPatch: gear.directive && config.preferPatch === true,
    /** Optional "stop adding scope" reminder at this step; 0 = off (default). */
    finishLineSteps: gear.directive
      ? Math.max(0, Math.floor(number(config.finishLineSteps, 0)))
      : 0,
    /**
     * The stall guard, the one *hard* bound this plugin owns: it cancels a single
     * tool call at its deadline. On by default; `false` or a negative
     * `toolTimeoutMs` disables it.
     */
    stallGuard: config.stallGuard !== false,
    toolTimeoutMs: Math.floor(number(config.toolTimeoutMs, 0)),
    /**
     * The prompt section. `false` keeps the scheduler, width computation and
     * watchdog exactly as they are and only stops the text from being written —
     * the switch that separates "what the text does" from "what the harness does".
     */
    guidance: config.guidance !== false,
    /**
     * The `shell_parallel` tool. Off by default: measured 2026-10-24, the model
     * already fans independent shell jobs out with inline `&` + `wait`, and the
     * extra tool invited a second verification pass on the same fixture.
     */
    shellParallel: config.shellParallel === true,
    /** Re-state the batch/bounded-call rules once after a context compaction. */
    reassertAfterCompaction: config.reassertAfterCompaction !== false,
    debug: config.debug === true,
    debugFile: typeof config.debugFile === 'string' ? config.debugFile : '',
    metrics: config.metrics !== false,
    metricsFile: resolveMetricsFile(config.metricsFile),
    benchmarkFile: typeof config.benchmarkFile === 'string' ? config.benchmarkFile : DEFAULTS.benchmarkFile,
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
