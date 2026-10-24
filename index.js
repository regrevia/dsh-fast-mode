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

const TAG = '[fast-mode]'
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
  if (!config.enabled) return

  const state = createState()
  /** @type {Map<string, number>} */
  const startedAt = new Map()
  /** @type {Map<string, {plan: any|undefined, defaultEffort: string|undefined, source: string}>} */
  const planCache = new Map()
  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map()
  let reported = false

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
        `turn=${payload?.turn} step=${payload?.step} ${String(original)}=>${String(effort)}`
          + ` route=${route}`
          + ` obs=${signals?.observations ?? 0} clean=${signals?.cleanStreak ?? 0}`
          + ` err=${signals?.errors ?? 0} slow=${signals?.slowestMs ?? 0}ms`
          + ` big=${signals?.biggestChars ?? 0}c rep=${signals?.mostRepeated ?? 0}`
          + `${signals?.struggling ? ' STRUGGLING' : ''}`,
      )
    }

    if (effort === undefined || effort === original) return resolved
    return { ...resolved, reasoningEffort: effort }
  })

  ctx.logger?.info?.(
    '%s active: floor=%s deepAfter=%d slowMs=%d bigChars=%d aliases=%s',
    TAG,
    config.floor,
    config.deepAfter,
    config.slowMs,
    config.bigChars,
    config.aliases === false ? 'off' : 'auto',
  )
}
