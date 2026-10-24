/**
 * dsh-fast-mode: the harness's own fast mode.
 *
 * Two hooks, one judgement:
 *
 * - `tools/pre-execute` / `tools/post-execute` observe every tool call: its
 *   name, its arguments, whether it failed, how big the result was, how long it
 *   took. Both are pure observers here — they always forward the decision they
 *   were given, so this plugin can never change what a tool returns.
 * - `agent/request` decides the effort for the next model call from those
 *   observations plus the step number.
 *
 * The observation store lives in memory, keyed by agent, reset per turn. Nothing
 * is written to the session, so the policy adds no context and no tokens to the
 * conversation — it only decides how much the model deliberates.
 *
 * ## Switching it on
 *
 * `enabled` defaults to **false**. Fast mode trades deliberation for latency, so
 * it stays out of the way until asked. Turn it on from the lightning chip beside
 * the model selector, or from a composition patch — both write the same
 * `enabled` field, because the chip is this package's client half (`dsh.client`
 * in package.json) reading and writing through the `settings` service.
 *
 * The gear is chosen **only** from the chip's caret menu. There is deliberately
 * no speed form on a settings page: this harness renders no form from a plugin's
 * schema (`autoGenerate` is host bookkeeping, no shipped client reads it), and a
 * second, half-working entry point is worse than none. Settings stays for the
 * composition-level knobs (`enabled`, `parallel`, `debug`).
 *
 * When it is off, nothing about a request changes: the policy returns the effort
 * the harness chose, and the guidance section renders to the empty string, which
 * the prompt assembler drops. What stays registered is the measurement tap and
 * the pass-through hooks — that is deliberate. A comparison between on and off
 * needs the off sessions measured by the same code, and a switch that can only
 * be flipped by restarting the app is a switch nobody flips mid-task. A `debug`
 * file, if configured, still gets one line per load — that is the trace an
 * operator reads when the chip cannot switch anything on.
 *
 * ## Provider independence
 *
 * The plugin never assumes a vocabulary. Before it can lower an effort it asks
 * the harness which levels the current route actually declares
 * (`llm.resolveModelInfo(provider, model)` → `reasoning.efforts`), then notches
 * across *those* levels only. That matters because the harness validates an
 * effort against the route before provider I/O, so a guessed id would fail the
 * whole model call rather than being ignored.
 *
 * Concretely: the shipped official DeepSeek adapter advertises
 * `off/low/high/max` (read out of `@deepseek-ai/dsh-llm-deepseek`, not guessed
 * from the API docs), so the notch on that route is `high`→`low`, and `off` —
 * the one level that disables thinking entirely — stays below the default
 * floor. A self-hosted gateway declaring `off/minimal/low/medium/high` keeps
 * every level distinct, so `high`→`medium` is the notch there. A route that
 * declares no levels, or a route that cannot be interrogated, is left
 * completely alone.
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createAssignment } from './src/benchmark.js'
import {
  contentChars,
  createState,
  decideEffort,
  GEARS,
  readSignals,
  recordObservation,
  resetTurn,
  resolveConfig,
  resolvePlan,
  stableKey,
} from './src/effort.js'
import { buildGuidance, GUIDANCE_ORDER, GUIDANCE_SECTION } from './src/guidance.js'
import { createRecorder } from './src/metrics.js'

/**
 * The settings-page schema. Re-exported from here because the Loader reads
 * `Config` off the plugin module itself, and the `settings` service projects it
 * into the Web UI's plugin page.
 */
export { Config } from './src/config.js'

const TAG = '[fast-mode]'
/**
 * Shipped identity of this build. Traced into the debug log so a stale install is
 * visible at a glance, and pinned by a test against `package.json`.
 */
export const VERSION = '0.6.0'
const GLOBAL_AGENT = '__global__'
const TIMED_OUT = Symbol('discovery-timeout')

/** @param {string} file @param {string} line */
function appendDebug(file, line) {
  if (!file) return
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // A diagnostic sink must never break the request it observes.
  }
}

/**
 * Expand a leading `~`, so the default paths in the schema read as documentation
 * ("`~/.dsh/fast-mode-metrics.jsonl`") instead of as a literal directory named
 * `~`.
 *
 * @param {unknown} file
 * @returns {string}
 */
function expandHome(file) {
  if (typeof file !== 'string' || file.length === 0) return ''
  if (file === '~') return homedir()
  if (file.startsWith('~/')) return join(homedir(), file.slice(2))
  return file
}

/** @param {unknown} resolved */
function routeOf(resolved) {
  const provider = resolved && typeof resolved === 'object' ? resolved.provider : undefined
  const model = resolved && typeof resolved === 'object' ? resolved.model : undefined
  return typeof provider === 'string' && typeof model === 'string' ? `${provider}/${model}` : 'unknown'
}

/**
 * Log, once per load, whether this entry's namespace is actually served by the
 * `settings` service — the fact the chip's state depends on.
 *
 * The client half reads `settings/describe`; when the namespace is missing it can
 * only report "not configured", which looks the same as a broken plugin. Tracing
 * the answer host-side turns that guess into one line in the debug file. Deferred
 * by a couple of seconds so the entry is mounted by the time it is described, and
 * gated on `debug` so a normal install schedules nothing.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof resolveConfig>} config
 */
function traceSettings(ctx, config) {
  const report = (line) => { appendDebug(config.debugFile, `settings v${VERSION}: ${line}`) }
  try {
    ctx.inject(['settings'], (child) => {
      child.effect(() => {
        const timer = setTimeout(() => {
          void (async () => {
            try {
              const described = await child.settings.describe()
              const views = Array.isArray(described) ? described : []
              const names = views.map(view => (view && typeof view.ns === 'string' ? view.ns : '?')).join(',')
              const own = views.find((view) => {
                const ns = view && typeof view.ns === 'string' ? view.ns : ''
                return ns === 'fast-mode' || ns.endsWith(':fast-mode')
              })
              report(`entries=${names || '(none)'} own=${own ? own.ns : 'MISSING'} writable=${child.settings.writable === true}`)
            } catch (error) {
              report(`describe failed: ${error && error.message ? error.message : String(error)}`)
            }
          })()
        }, 2000)
        return () => clearTimeout(timer)
      }, 'fast-mode: settings trace')
    })
  } catch (error) {
    report(`trace not scheduled: ${error && error.message ? error.message : String(error)}`)
  }
}

/** @param {unknown} agent @returns {string} */
function agentKey(agent) {
  const id = agent && typeof agent === 'object' ? agent.id : undefined
  return typeof id === 'string' ? id : GLOBAL_AGENT
}

/**
 * Read the effort ids a route declares, tolerating every shape a provider may
 * use. The harness normalises these, but a plugin should not throw on an
 * adapter that reports entries as bare strings.
 *
 * @param {unknown} info
 * @returns {{declared: string[], defaultEffort: string|undefined}|undefined}
 */
function readModelInfo(info) {
  if (!info || typeof info !== 'object') return undefined
  const reasoning = info.reasoning
  const raw = reasoning && typeof reasoning === 'object' ? reasoning.efforts : undefined
  const declared = Array.isArray(raw)
    ? raw
      .map(entry => (typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? entry.id : undefined))
      .filter(id => typeof id === 'string' && id.length > 0)
    : []
  const fallback = reasoning && typeof reasoning === 'object' ? reasoning.defaultEffort : undefined
  return {
    declared,
    defaultEffort: typeof fallback === 'string' && fallback.length > 0 ? fallback : undefined,
  }
}

/** @param {unknown} value @param {number} ms */
function raceTimeout(value, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms)
    Promise.resolve(value).then(
      result => {
        clearTimeout(timer)
        resolve(result)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const initial = resolveConfig(rawConfig)

  // Traceability before everything else: "the module never loaded" and "the
  // module loaded but is switched off" look identical from the UI, and that
  // ambiguity already cost a debugging round. Only a `debug` file is written to.
  const metrics = createRecorder({
    file: initial.metrics ? expandHome(initial.metricsFile) : '',
  })
  if (initial.debug) {
    appendDebug(
      initial.debugFile,
      `apply v${VERSION} entered enabled=${initial.enabled} gear=${initial.gear} parallel=${initial.parallel}`,
    )
    appendDebug(initial.debugFile, `measure v${VERSION}: ${metrics.enabled ? `file=${metrics.file}` : 'off'}`)
    traceSettings(ctx, initial)
  }

  // The measurement tap is independent of the switch: a comparison needs the
  // sessions that ran *without* fast mode measured by the same code, and a
  // disabled plugin that records nothing cannot answer the question it exists
  // for. This hook observes; it never changes a request.
  if (metrics.enabled) {
    ctx.on('session/event', (session, event) => metrics.record(session, event))
  }

  // Experiment assignment, shipped inert: with no file there is no experiment
  // and the configured gear is the only stance.
  const assignment = createAssignment({
    file: expandHome(initial.benchmarkFile),
    gears: Object.keys(GEARS),
    onError: (message) => {
      if (initial.debug) appendDebug(initial.debugFile, `benchmark v${VERSION}: ${message}`)
    },
  })

  /**
   * The live config for one session.
   *
   * Re-resolved on every request rather than frozen at load: the settings fields
   * are patched into the running plugin in place, so a stale snapshot is how a
   * switch silently does nothing until the next restart. The per-session gear
   * override rides the same path, which is what lets an experiment pin a gear
   * without a reload.
   *
   * @param {string|undefined} sessionId
   */
  const configFor = (sessionId) => {
    const assigned = assignment.gearFor(sessionId)
    if (assigned === undefined) return resolveConfig(rawConfig)
    // An experiment assignment also turns the mode on. Otherwise the harness
    // would depend on the very switch it is supposed to be measuring: every
    // session would have to be clicked on, and a forgotten click would silently
    // land in the control arm.
    return resolveConfig(rawConfig, { gear: assigned, enabled: true })
  }

  const state = createState()
  /** @type {Map<string, number>} */
  const startedAt = new Map()
  /** @type {Map<string, {plan: any|undefined, defaultEffort: string|undefined, source: string}>} */
  const planCache = new Map()
  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map()
  /** Route sources already announced, and parallel caps already warned about. */
  const announced = new Set()
  const warnedCaps = new Set()

  // A gear above `safe` asks the model for wider steps. The harness schedules
  // same-message calls concurrently, so this is the one lever that raises real
  // fan-out. The section's text is a function of the agent, resolved per
  // assembly, so it follows the live config and a per-session gear — and renders
  // to the empty string (dropped by the assembler) when the plugin is off.
  try {
    ctx.inject(['systemPrompt'], (child) => {
      child.effect(() => child.systemPrompt.section({
        name: GUIDANCE_SECTION,
        order: GUIDANCE_ORDER,
        text: (context) => {
          try {
            const scope = context && typeof context === 'object' ? (context.scope ?? context.agent) : undefined
            const sid = scope && typeof scope === 'object' ? scope.id : undefined
            const live = configFor(typeof sid === 'string' ? sid : undefined)
            if (!live.enabled) return ''
            return buildGuidance(live) ?? ''
          } catch {
            // A section that cannot resolve must cost nothing and stay silent.
            return ''
          }
        },
      }), 'fast-mode: guidance section')
      ctx.logger?.info?.('%s guidance section registered (rendered per request)', TAG)
    })
  } catch (error) {
    ctx.logger?.warn?.(
      '%s guidance section not registered: %s',
      TAG,
      error && error.message ? error.message : String(error),
    )
  }

  /**
   * Warn once per gear when the harness cap makes the fan-out target a wish.
   *
   * @param {ReturnType<typeof resolveConfig>} cfg
   */
  const checkParallelCap = (cfg) => {
    if (cfg.parallel <= 1 || warnedCaps.has(cfg.parallel)) return
    warnedCaps.add(cfg.parallel)
    try {
      const holder = ctx.get('agentLoop')?.config?.maxParallelToolCalls
      const cap = typeof holder?.get === 'function' ? holder.get() : holder
      if (typeof cap === 'number' && cap < cfg.parallel) {
        ctx.logger?.warn?.(
          '%s gear=%s asks for up to %d calls per step but agentLoop.maxParallelToolCalls=%d caps it; '
            + 'raise it in cordis.patch.yml (- id: agent-loop, config: { maxParallelToolCalls: %d })',
          TAG, cfg.gear, cfg.parallel, cap, cfg.parallel,
        )
      }
    } catch {
      // A diagnostic must never break a request.
    }
  }

  /**
   * Ask the harness for the current route's declared levels. Any failure is a
   * "we do not know", never an exception.
   *
   * @returns {Promise<{declared: string[], defaultEffort: string|undefined}|undefined>}
   */
  const lookup = (provider, model, signal) => {
    let llm
    try {
      llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm
    } catch {
      llm = undefined
    }
    if (!llm || typeof llm.resolveModelInfo !== 'function') return Promise.resolve(undefined)
    try {
      return Promise.resolve(llm.resolveModelInfo(provider, model, signal))
        .then(readModelInfo)
        .catch(() => undefined)
    } catch {
      return Promise.resolve(undefined)
    }
  }

  /**
   * The decision plan for a route at one gear, cached per provider, model and
   * gear. The gear is part of the key because it changes the floor and the
   * ladder: one cached plan under a different gear would decide a notch it was
   * not built for.
   *
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal|undefined} signal
   * @param {ReturnType<typeof resolveConfig>} cfg
   * @returns {Promise<{plan: any|undefined, defaultEffort: string|undefined, source: string}>}
   */
  const planFor = async (provider, model, signal, cfg) => {
    const key = `${provider}\u0000${model}\u0000${cfg.gear}\u0000${cfg.floor}`
    const cached = planCache.get(key)
    if (cached) return cached

    const pending = inFlight.get(key) ?? lookup(provider, model, signal)
    inFlight.set(key, pending)

    let found
    try {
      found = await raceTimeout(pending, cfg.discoverTimeoutMs)
    } catch {
      found = undefined
    }

    const settle = (info) => {
      if (info) {
        const plan = resolvePlan(info.declared, cfg)
        const source = plan.source
        const announce = `${provider}\u0000${model}\u0000${cfg.gear}`
        if (!announced.has(announce)) {
          announced.add(announce)
          ctx.logger?.info?.(
            '%s gear=%s %s/%s ladder=%s floor=%s (%s)',
            TAG,
            cfg.gear,
            provider,
            model,
            plan.levels.map(level => level.id).join('>') || '-',
            plan.floorId ?? '-',
            source,
          )
        }
        return { plan, defaultEffort: info.defaultEffort, source }
      }
      // Nothing known: only an explicitly pinned ladder may be trusted, because
      // an id the route does not declare would fail the call before I/O.
      const plan = cfg.ladderExplicit ? resolvePlan(undefined, cfg) : undefined
      return { plan, defaultEffort: undefined, source: plan?.source ?? 'unknown' }
    }

    const entry = settle(found === TIMED_OUT ? undefined : found)
    planCache.set(key, entry)

    // Metadata that arrives after we stopped waiting still upgrades the cache,
    // so only the very first request of a slow route runs without it.
    if (found === TIMED_OUT) {
      pending.then((info) => {
        if (info) planCache.set(key, settle(info))
      }).catch(() => {})
    }
    pending.finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key)
    }).catch(() => {})

    return entry
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec && typeof exec.callId === 'string') startedAt.set(exec.callId, Date.now())
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const key = exec && typeof exec.callId === 'string' ? exec.callId : undefined
      const began = key === undefined ? undefined : startedAt.get(key)
      if (key !== undefined) startedAt.delete(key)

      if (exec) {
        const agent = agentKey(exec.agent)
        const cfg = configFor(agent === GLOBAL_AGENT ? undefined : agent)
        recordObservation(
          state,
          agent,
          {
            name: typeof exec.name === 'string' ? exec.name : 'unknown',
            argsKey: stableKey(exec.arguments),
            isError: result?.isError === true,
            chars: contentChars(result?.content),
            durationMs: began === undefined ? 0 : Math.max(0, Date.now() - began),
          },
          cfg.window,
        )
      }
    } catch {
      // Observation is best-effort. A failure here must not affect the tool
      // result the caller is about to receive.
    }

    return next()
  })

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()

    const sid = agentKey(payload?.agent)
    const cfg = configFor(sid === GLOBAL_AGENT ? undefined : sid)
    const original = resolved?.reasoningEffort
    const route = routeOf(resolved)

    // Switched off: hand the request back untouched, but still label the step so
    // the measurement file can compare this session with an accelerated one.
    if (!cfg.enabled) {
      metrics.label(sid, {
        mode: 'off',
        gear: 'off',
        effort: original === undefined ? undefined : String(original),
        route,
      })
      return resolved
    }

    checkParallelCap(cfg)

    let effort = original
    let signals
    let source = route
    try {
      const provider = resolved?.provider
      const model = resolved?.model
      const found = typeof provider === 'string' && typeof model === 'string'
        ? await planFor(provider, model, payload?.signal, cfg)
        : { plan: undefined, defaultEffort: undefined, source: 'unknown' }
      source = found.source

      resetTurn(state, sid, payload?.turn)
      signals = readSignals(state, sid, {
        window: cfg.window,
        slowMs: cfg.slowMs,
        bigChars: cfg.bigChars,
        holdTools: cfg.holdTools,
      })

      effort = decideEffort({
        step: payload?.step,
        current: original,
        baseline: cfg.baselineFromDefault ? found.defaultEffort : undefined,
        plan: found.plan,
        config: cfg,
        signals,
      })
    } catch {
      // Never let a policy failure change the request: keep what the harness chose.
      effort = original
    }

    metrics.label(sid, {
      mode: 'on',
      gear: cfg.gear,
      effort: effort === undefined ? undefined : String(effort),
      route,
    })

    if (cfg.debug) {
      appendDebug(
        cfg.debugFile,
        `turn=${payload?.turn} step=${payload?.step} gear=${cfg.gear} ${String(original)}=>${String(effort)}`
          + ` route=${source}`
          + ` obs=${signals?.observations ?? 0} clean=${signals?.cleanStreak ?? 0}`
          + ` err=${signals?.errors ?? 0} slow=${signals?.slowestMs ?? 0}ms`
          + ` big=${signals?.biggestChars ?? 0}c rep=${signals?.mostRepeated ?? 0}`
          + ` hold=${signals?.held ?? 0}`
          + `${signals?.struggling ? ' STRUGGLING' : ''}`,
      )
    }

    if (effort === undefined || effort === original) return resolved
    return { ...resolved, reasoningEffort: effort }
  })

  ctx.logger?.info?.(
    '%s v%s loaded: enabled=%s gear=%s floor=%s deepAfter=%d slowMs=%d bigChars=%d aliases=%s holdTools=%d metrics=%s',
    TAG,
    VERSION,
    initial.enabled,
    initial.gear,
    initial.floor,
    initial.deepAfter,
    initial.slowMs,
    initial.bigChars,
    initial.aliases === false ? 'off' : 'auto',
    initial.holdTools.length,
    metrics.enabled ? metrics.file : 'off',
  )
}
