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
  stableKey,
} from './src/effort.js'

const TAG = '[fast-mode]'
const GLOBAL_AGENT = '__global__'

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
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const state = createState()
  /** @type {Map<string, number>} */
  const startedAt = new Map()

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

    let effort = resolved?.reasoningEffort
    let signals
    try {
      const key = agentKey(payload?.agent)
      resetTurn(state, key, payload?.turn)
      signals = readSignals(state, key, {
        window: config.window,
        slowMs: config.slowMs,
        bigChars: config.bigChars,
      })
      effort = decideEffort({ step: payload?.step, current: resolved?.reasoningEffort, config, signals })
    } catch {
      // Never let a policy failure change the request: keep what the harness chose.
      effort = resolved?.reasoningEffort
    }

    if (config.debug) {
      appendDebug(
        config.debugFile,
        `turn=${payload?.turn} step=${payload?.step} ${String(resolved?.reasoningEffort)}=>${String(effort)}`
          + ` obs=${signals?.observations ?? 0} clean=${signals?.cleanStreak ?? 0}`
          + ` err=${signals?.errors ?? 0} slow=${signals?.slowestMs ?? 0}ms`
          + ` big=${signals?.biggestChars ?? 0}c rep=${signals?.mostRepeated ?? 0}`
          + `${signals?.struggling ? ' STRUGGLING' : ''}`,
      )
    }

    if (effort === undefined || effort === resolved?.reasoningEffort) return resolved
    return { ...resolved, reasoningEffort: effort }
  })

  ctx.logger?.info?.(
    '%s active: floor=%s deepAfter=%d slowMs=%d bigChars=%d',
    TAG,
    config.floor,
    config.deepAfter,
    config.slowMs,
    config.bigChars,
  )
}
