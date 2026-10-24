/**
 * dsh-fast-mode 1.0.0: the harness's own fast mode.
 *
 * The single rule that defines this release: **the plugin never changes thinking
 * effort, the model, or the request body.** `agent/request` awaits the next
 * handler and returns the resolved request untouched. Whatever effort the user
 * picked — a per-conversation UI choice or the profile's `agent-default-model`
 * pin — is what every call runs at, on every request, across restarts. There is
 * no policy here that could drift it, because the mechanism was deleted rather
 * than gated.
 *
 * What the plugin does instead, on the three places a turn actually loses time:
 *
 * 1. **Fan-out.** A prompt section tells the model it may issue several
 *    independent tool calls in one message. The scheduler (`gear: auto`) sets the
 *    width per step, 2–8, from how the last few steps went: widen after a couple
 *    of clean steps in the same turn, narrow on errors or stalls.
 * 2. **Output discipline.** The same section asks for less process narration.
 *    It never asks for a shorter answer: the deliverable is exempt by
 *    construction.
 * 3. **Bounded calls and loop breaking.** Shell-class tool calls get a
 *    cancellable ceiling (`auto`: 120 s, self-tuning to 300 s from the recent
 *    p90; `safe`: none). A call that hits it is cancelled and the model is told
 *    to change approach. Six no-progress steps warn, twelve stop, and after
 *    thirty steps in one turn the scheduler stops widening.
 *
 * ## Switching it on
 *
 * `enabled` defaults to **false**. Turn it on from the lightning chip beside the
 * model selector, or from a composition patch — both write the same `enabled`
 * field, because the chip is this package's client half (`dsh.client` in
 * package.json) reading and writing through the `settings` service. The switch
 * is per conversation; the panel has one switch and no gear picker, because
 * `auto` is the only behaviour left to choose.
 *
 * When it is off, nothing about a turn changes: the guidance section renders to
 * the empty string (the prompt assembler drops it), the stall guard is not
 * installed, and the measurement tap keeps recording so on/off comparisons are
 * measured by the same code.
 *
 * ## Provider independence
 *
 * The plugin adds no provider-specific field and asks the route for no
 * vocabulary. Because the request is returned unchanged, an official DeepSeek
 * route, a self-hosted gateway and a LAN deployment behave identically here:
 * whatever the harness resolved is what goes out. The `effort` column in the
 * metrics journal is therefore evidence — it records the effort the request
 * carried, not one this plugin chose.
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CONTROL, createAssignment } from './src/benchmark.js'
import { contentChars, GEARS, resolveConfig, stableKey } from './src/effort.js'
import { buildGuidance, GUIDANCE_ORDER, GUIDANCE_SECTION } from './src/guidance.js'
import {
  AUTO,
  autoSchedule,
  createAutoState,
  noteStep,
  noteTool,
  noteTurn,
} from './src/auto.js'
import { buildConflictMessage, buildReassertMessage, createNoticeMessage } from './src/notices.js'
import { detectPeerPlugins, opsToolsLive } from './src/peers.js'
import { createStallGuard, stallBudgetFor } from './src/stallguard.js'
import { createRecorder } from './src/metrics.js'
import { choiceFor } from './src/state.js'

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
export const VERSION = '1.2.0'
const GLOBAL_AGENT = '__global__'

/**
 * Insert notices after the last message the step claims to be answering.
 *
 * Appending at the end works but reads as a continuation of the newest message;
 * the post-compaction reminder is more legible immediately after the user
 * message it belongs to. Falls back to appending when nothing is claimed (a
 * background or scheduled turn).
 *
 * @param {unknown} messages - `decision.messages`.
 * @param {unknown} claimed - `payload.messages`.
 * @param {object[]} notices
 * @returns {object[]}
 */
function insertAfterClaimed(messages, claimed, notices) {
  const list = Array.isArray(messages) ? messages : []
  if (notices.length === 0) return list
  const known = Array.isArray(claimed) ? claimed : []
  let index = -1
  if (known.length > 0) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (known.includes(list[i])) {
        index = i
        break
      }
    }
  }
  if (index < 0) return [...list, ...notices]
  return [...list.slice(0, index + 1), ...notices, ...list.slice(index + 1)]
}

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
  //
  // The same listener remembers the compactions, so the two things that read the
  // event stream are read in one place and in one order.
  const compacted = new Set()
  /**
   * @param {{id?: string}} session
   * @param {{type?: string, data?: object}} event
   */
  const trackCompaction = (session, event) => {
    try {
      if (!event || event.type !== 'compaction/end') return
      const payload = event.data && typeof event.data === 'object' ? event.data : event
      if (payload.error) return
      const sid = session && typeof session.id === 'string' ? session.id : undefined
      if (!sid) return
      // Bounded: a long-lived process sees thousands of sessions, and only the
      // next step of a just-compacted one needs the flag.
      if (compacted.size >= 200) compacted.delete(compacted.values().next().value)
      compacted.add(sid)
    } catch {
      // A reminder that cannot be scheduled must not affect the event stream.
    }
  }
  ctx.on('session/event', (session, event) => {
    if (metrics.enabled) {
      try {
        metrics.record(session, event)
      } catch {
        // Measurement is best-effort; the event belongs to the caller.
      }
    }
    trackCompaction(session, event)
    // A new turn resets only the per-turn counters; the session's memory of what
    // has already been tried must survive, because that is what a stuck loop
    // re-reads. Without this the 30-step breaker would be a per-session budget
    // that fires once and stays silent forever.
    if (event && event.type === 'turn/start') {
      try {
        noteTurn(auto, agentKey(session))
      } catch {
        // A scheduler that can fail a turn is worse than no scheduler.
      }
    }
  })

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
    // A running experiment outranks the UI on purpose: the arms are assigned by
    // session hash, and a panel click that quietly overrode the arm would empty
    // the control group of the very trial the user asked for.
    if (assigned === undefined) {
      // No experiment: the conversation's own entry wins, and its absence means
      // "inherit" — the configured pair is both the default and the record of
      // the last choice anywhere, which is what a fresh session starts from.
      const own = choiceFor(rawConfig?.sessions, sessionId)
      return own === undefined ? resolveConfig(rawConfig) : resolveConfig(rawConfig, own)
    }
    // The control arm is an assignment like any other: the mode is off because
    // the experiment said so, not because somebody forgot to click. Otherwise a
    // randomized trial could not have a baseline at all.
    if (assigned === CONTROL) return resolveConfig(rawConfig, { enabled: false })
    // A gear assignment turns the mode on. Otherwise the harness would depend on
    // the very switch it is supposed to be measuring: every session would have
    // to be clicked on, and a forgotten click would silently land in the control
    // arm.
    return resolveConfig(rawConfig, { gear: assigned, enabled: true })
  }

  // The scheduler's memory, one entry per conversation: what has been tried, how
  // long calls have been taking, and how many steps went by without a new result.
  const auto = createAutoState()
  /** Live stall ceilings per conversation, as computed by the scheduler. */
  const autoBudgets = new Map()
  /** @type {Map<string, number>} */
  const startedAt = new Map()
  /** Parallel caps already warned about. */
  const warnedCaps = new Set()

  /**
   * Plugins that already do part of this job. Two probes, both cheap: the
   * profile's install record (catches an installed-but-disabled peer, which is a
   * conflict the user is about to re-enable) and the live `tools` registry
   * (catches an ops wiring with no package entry). A conflict is announced, not
   * enforced: silently disabling ourselves because somebody installed an
   * overlapping plugin would be the worst of both worlds.
   */
  const peers = new Set(
    detectPeerPlugins(join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE || 'desktop')),
  )
  if (opsToolsLive(ctx)) peers.add('dsh-ops')
  let conflictPending = peers.size > 0
  if (peers.size > 0) {
    ctx.logger?.warn?.(
      '%s another installed plugin duplicates part of fast mode (%s); enable only one — '
        + 'remove dsh-batch-tool-calls / dsh-ops, or leave fast mode switched off',
      TAG, [...peers].join(', '),
    )
    if (initial.debug) appendDebug(initial.debugFile, `conflict v${VERSION}: peers=${[...peers].join(',')}`)
  }

  // The stall guard: the one hard bound on how long a single tool call may run.
  // Prompt text can only ask the model to bound its own commands; this is what
  // makes an unbounded call cost a step instead of the whole turn.
  let stalls = 0
  const stallGuard = createStallGuard({
    budgetFor: (exec) => {
      const agent = agentKey(exec?.agent)
      const sid = agent === GLOBAL_AGENT ? undefined : agent
      const cfg = configFor(sid)
      const base = stallBudgetFor(cfg)
      // The adaptive ceiling only replaces the gear table: an explicit
      // `toolTimeoutMs`, a disabled guard, and every fixed gear keep their own
      // value untouched.
      if (cfg.gear !== AUTO || base === 0 || cfg.toolTimeoutMs > 0) return base
      const live = autoBudgets.get(agent)
      return Number.isFinite(live) ? live : base
    },
    onStall: (info) => {
      stalls += 1
      ctx.logger?.warn?.(
        '%s stall guard cancelled %s after %d ms (budget %d ms)',
        TAG, info.name, info.elapsedMs, info.budgetMs,
      )
      if (initial.debug) {
        appendDebug(
          initial.debugFile,
          `stall v${VERSION}: ${info.name} cancelled at ${info.elapsedMs}ms budget=${info.budgetMs}ms total=${stalls}`,
        )
      }
    },
  })
  ctx.on('tools/execute', stallGuard)

  // The transcript's two notices: the post-compaction reminder and the one-time
  // conflict announcement. Both are `notice`-form `source: plugin` messages, so
  // the UI folds them instead of attributing them to the user.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    try {
      const sid = agentKey(payload?.agent)
      const cfg = configFor(sid === GLOBAL_AGENT ? undefined : sid)
      if (!cfg.enabled) return decision
      const notices = []
      if (conflictPending) {
        conflictPending = false
        notices.push(buildConflictMessage([...peers]))
      }
      if (compacted.delete(sid) && cfg.reassertAfterCompaction !== false) {
        notices.push(buildReassertMessage(cfg))
      }
      if (cfg.gear === AUTO) {
        // The step boundary is also the scheduling boundary: it is where the
        // turn's step count grows, and where the long-tail breaker gets to speak.
        // The message is built inside this try/catch, so a scheduler bug drops
        // the reminder instead of failing the step it was meant to protect.
        noteStep(auto, sid)
        const schedule = autoSchedule(auto, sid)
        autoBudgets.set(sid, schedule.stallBudgetMs)
        if (schedule.directive) {
          notices.push(createNoticeMessage(schedule.directive.text, schedule.directive.summary))
          if (initial.debug) {
            appendDebug(
              initial.debugFile,
              `auto v${VERSION}: step=${schedule.stats.steps} turnSteps=${schedule.stats.turnSteps}`
                + ` noProgress=${schedule.stats.noProgress} errors=${schedule.stats.errors}`
                + ` parallel=${schedule.parallel} budget=${schedule.stallBudgetMs}ms`
                + ` directive=${schedule.directive.kind}`,
            )
          }
        }
      }
      if (notices.length === 0) return decision
      return { ...decision, messages: insertAfterClaimed(decision.messages, payload?.messages, notices) }
    } catch {
      // Never let a reminder change the step it was meant to help.
      return decision
    }
  })

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
            // `auto` quotes the width it actually computed for this session, so
            // the sentence the model reads and the number the scheduler enforces
            // are the same number.
            const effective = live.gear === AUTO
              ? { ...live, parallel: autoSchedule(auto, typeof sid === 'string' ? sid : GLOBAL_AGENT).parallel }
              : live
            return buildGuidance(effective) ?? ''
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
   * Warn once when the harness cap makes the fan-out target a wish.
   *
   * @param {ReturnType<typeof resolveConfig>} cfg
   * @param {number} [width] - the scheduler's target for this session
   */
  const checkParallelCap = (cfg, width) => {
    const parallel = Number.isFinite(width) ? Math.floor(width) : cfg.parallel
    if (!(parallel > 1) || warnedCaps.has(parallel)) return
    warnedCaps.add(parallel)
    try {
      const holder = ctx.get('agentLoop')?.config?.maxParallelToolCalls
      const cap = typeof holder?.get === 'function' ? holder.get() : holder
      if (typeof cap === 'number' && cap < parallel) {
        ctx.logger?.warn?.(
          '%s gear=%s asks for up to %d calls per step but agentLoop.maxParallelToolCalls=%d caps it; '
            + 'raise it in cordis.patch.yml (- id: agent-loop, config: { maxParallelToolCalls: %d })',
          TAG, cfg.gear, parallel, cap, parallel,
        )
      }
    } catch {
      // A diagnostic must never break a request.
    }
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
        const observation = {
          name: typeof exec.name === 'string' ? exec.name : 'unknown',
          argsKey: stableKey(exec.arguments),
          isError: result?.isError === true,
          chars: contentChars(result?.content),
          durationMs: began === undefined ? 0 : Math.max(0, Date.now() - began),
        }
        // The scheduler reads the same observation: a call that returns the same
        // bytes for the same arguments is the raw material of the long tail.
        noteTool(auto, agent, observation)
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
    const agent = sid === GLOBAL_AGENT ? undefined : sid
    const cfg = configFor(agent)
    const effort = resolved?.reasoningEffort
    const route = routeOf(resolved)
    const label = effort === undefined ? undefined : String(effort)

    // Fast mode does not touch the thinking budget, on purpose. The route and the
    // effort are the user's contract with the model: a mode that quietly thinks
    // less produces a different answer, not a faster one, and the measured public
    // benchmarks showed the effort ladder bought no wall-clock on this route
    // anyway (0 reasoning tokens in every arm). What is left is the part that
    // makes the same thinking finish sooner — wider steps, bounded calls, and a
    // breaker for the sessions that only look busy.
    if (!cfg.enabled) {
      metrics.label(sid, { mode: 'off', gear: 'off', effort: label, route })
      return resolved
    }

    const schedule = cfg.gear === AUTO ? autoSchedule(auto, sid) : undefined
    checkParallelCap(cfg, schedule?.parallel)
    metrics.label(sid, { mode: 'on', gear: cfg.gear, effort: label, route })

    if (cfg.debug) {
      appendDebug(
        cfg.debugFile,
        `turn=${payload?.turn} step=${payload?.step} gear=${cfg.gear} effort=${String(label)} (unchanged)`
          + ` route=${route}`
          + (schedule
            ? ` parallel=${schedule.parallel} budget=${schedule.stallBudgetMs}ms`
              + ` steps=${schedule.stats.steps} noProgress=${schedule.stats.noProgress}`
              + ` p90=${schedule.stats.p90WaitMs}ms errors=${schedule.stats.errors}`
            : ''),
      )
    }

    return resolved
  })

  ctx.logger?.info?.(
    '%s v%s loaded: enabled=%s gear=%s parallel=%d adaptive=%s reasoningEffort=untouched metrics=%s',
    TAG,
    VERSION,
    initial.enabled,
    initial.gear,
    initial.parallel,
    initial.adaptive === true,
    metrics.enabled ? metrics.file : 'off',
  )
  if (initial.legacyGear) {
    ctx.logger?.warn?.(
      '%s the patch names the retired gear "%s", which used to lower thinking effort; '
        + 'it now runs the auto scheduler, and the effort stays whatever the user chose. '
        + 'Set gear: auto (or delete the override) to make the patch say what it does.',
      TAG,
      initial.legacyGear,
    )
    if (initial.debug) {
      appendDebug(initial.debugFile, `legacyGear=${initial.legacyGear} resolved=auto`)
    }
  }
}
