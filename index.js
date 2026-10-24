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
 * When it is off, `apply` registers nothing at all: no hooks, no prompt section,
 * no token cost. A `debug` file, if configured, still gets one line per load —
 * that is the trace an operator reads when the chip cannot switch anything on.
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

import {
  contentChars,
  createState,
  decideEffort,
  readSignals,
  recordObservation,
  resetTurn,
  resolveConfig,
  resolvePlan,
  stableKey,
} from './src/effort.js'
import { buildGuidance, GUIDANCE_ORDER, GUIDANCE_SECTION } from './src/guidance.js'

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
export const VERSION = '0.5.2'
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
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  // Traceability before everything else, including the early return for a
  // disabled plugin: "the module never loaded" and "the module loaded but is
  // switched off" look identical from the UI, and that ambiguity already cost a
  // debugging round. Only a `debug` file is written to, and only one line.
  if (config.debug) {
    appendDebug(config.debugFile, `apply v${VERSION} entered enabled=${config.enabled} gear=${config.gear} parallel=${config.parallel}`)
    traceSettings(ctx, config)
  }
  if (!config.enabled) {
    if (config.debug) appendDebug(config.debugFile, `inactive v${VERSION}: enabled=false, no hooks registered`)
    return
  }

  const state = createState()
  /** @type {Map<string, number>} */
  const startedAt = new Map()
  /** @type {Map<string, {plan: any|undefined, defaultEffort: string|undefined, source: string}>} */
  const planCache = new Map()
  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map()
  let reported = false

  // A gear above `safe` asks the model for wider steps. The harness schedules
  // same-message calls concurrently, so this is the one lever that raises real
  // fan-out; the effort policy cannot. Registration failure is contained: a
  // plugin that cannot add its section still runs the policy it was asked for.
  const guidance = buildGuidance(config)
  if (guidance !== undefined) {
    try {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        systemPrompt.section({ name: GUIDANCE_SECTION, order: GUIDANCE_ORDER, text: guidance })
        ctx.logger?.info?.('%s gear=%s asks for up to %d calls per step (prompt section registered)', TAG, config.gear, config.parallel)
      } else {
        ctx.logger?.warn?.('%s gear=%s guidance skipped: no systemPrompt service in this composition', TAG, config.gear)
      }
    } catch (error) {
      ctx.logger?.warn?.('%s gear=%s guidance not registered: %s', TAG, config.gear, String(error))
    }
  }

  /**
   * The guidance is only meaningful if the scheduler can actually run that many
   * calls at once. Report the gap once rather than per request; the value is a
   * volatile setting, so the fix is a composition patch, not a runtime poke.
   */
  let capChecked = false
  const checkParallelCap = () => {
    if (capChecked) return
    capChecked = true
    try {
      const holder = ctx.get('agentLoop')?.config?.maxParallelToolCalls
      const cap = typeof holder?.get === 'function' ? holder.get() : holder
      if (typeof cap === 'number' && cap < config.parallel) {
        ctx.logger?.warn?.(
          '%s gear=%s asks for up to %d calls per step but agentLoop.maxParallelToolCalls=%d caps it; '
            + 'raise it in cordis.patch.yml (- id: agent-loop, config: { maxParallelToolCalls: %d })',
          TAG, config.gear, config.parallel, cap, config.parallel,
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
   * The decision plan for a route, cached per provider and model.
   *
   * @returns {Promise<{plan: any|undefined, defaultEffort: string|undefined, source: string}>}
   */
  const planFor = async (provider, model, signal) => {
    const key = `${provider}\u0000${model}`
    const cached = planCache.get(key)
    if (cached) return cached

    const pending = inFlight.get(key) ?? lookup(provider, model, signal)
    inFlight.set(key, pending)

    let found
    try {
      found = await raceTimeout(pending, config.discoverTimeoutMs)
    } catch {
      found = undefined
    }

    const settle = info => {
      if (info) {
        const plan = resolvePlan(info.declared, config)
        const source = plan.source
        if (!reported) {
          reported = true
          ctx.logger?.info?.(
            '%s %s/%s ladder=%s floor=%s (%s)',
            TAG,
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
      const plan = config.ladderExplicit ? resolvePlan(undefined, config) : undefined
      return { plan, defaultEffort: undefined, source: plan?.source ?? 'unknown' }
    }

    const entry = settle(found === TIMED_OUT ? undefined : found)
    planCache.set(key, entry)

    // Metadata that arrives after we stopped waiting still upgrades the cache,
    // so only the very first request of a slow route runs without it.
    if (found === TIMED_OUT) {
      pending.then(info => {
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
        recordObservation(
          state,
          agentKey(exec.agent),
          {
            name: typeof exec.name === 'string' ? exec.name : 'unknown',
            argsKey: stableKey(exec.arguments),
            isError: result?.isError === true,
            chars: contentChars(result?.content),
            durationMs: began === undefined ? 0 : Math.max(0, Date.now() - began),
          },
          config.window,
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
    checkParallelCap()

    const original = resolved?.reasoningEffort
    let effort = original
    let signals
    let route = 'unknown'

    try {
      const provider = resolved?.provider
      const model = resolved?.model
      const found = typeof provider === 'string' && typeof model === 'string'
        ? await planFor(provider, model, payload?.signal)
        : { plan: undefined, defaultEffort: undefined, source: 'unknown' }
      route = found.source

      const key = agentKey(payload?.agent)
      resetTurn(state, key, payload?.turn)
      signals = readSignals(state, key, {
        window: config.window,
        slowMs: config.slowMs,
        bigChars: config.bigChars,
        holdTools: config.holdTools,
      })

      effort = decideEffort({
        step: payload?.step,
        current: original,
        baseline: config.baselineFromDefault ? found.defaultEffort : undefined,
        plan: found.plan,
        config,
        signals,
      })
    } catch {
      // Never let a policy failure change the request: keep what the harness chose.
      effort = original
    }

    if (config.debug) {
      appendDebug(
        config.debugFile,
        `turn=${payload?.turn} step=${payload?.step} gear=${config.gear} ${String(original)}=>${String(effort)}`
          + ` route=${route}`
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
    '%s active: gear=%s floor=%s deepAfter=%d slowMs=%d bigChars=%d aliases=%s holdTools=%d',
    TAG,
    config.gear,
    config.floor,
    config.deepAfter,
    config.slowMs,
    config.bigChars,
    config.aliases === false ? 'off' : 'auto',
    config.holdTools.length,
  )
}
