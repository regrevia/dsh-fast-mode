/**
 * The scheduler behind the switch.
 *
 * The gear picker asked the user to guess which trade they wanted before the
 * work started, and the public-benchmark runs showed the guesses are not
 * distinguishable from each other on single-file tasks anyway: five gears, one
 * visible difference (output tokens), 0.95x-1.09x wall-clock between the fastest
 * and the slowest arm. A control the data cannot separate is a control that only
 * costs the user a decision. So the panel keeps one switch and this module
 * decides, per step, what "on" means right now.
 *
 * What the scheduler may decide is bounded by what a plugin can actually do on
 * this harness:
 *
 * - **How wide a step should be.** Guidance text is the only lever; the model
 *   still chooses the calls. So this produces a *target*, and it moves with the
 *   session's own behaviour: wider after clean multi-call steps, narrower after
 *   errors.
 * - **How long one tool call may run.** The stall guard enforces this one for
 *   real, by cancelling our own controller at the deadline. The budget is sized
 *   from the session's own observed call latency, not from a gear table: a
 *   session that already waited 45 s for calls is not helped by a 90 s ceiling,
 *   and a session whose calls finish in 2 s is not helped by 300 s of patience.
 * - **When to stop repeating itself.** This is the long-tail fix, and it is the
 *   only part that is not about speed at all. In the benchmark log 12 sessions
 *   with 40+ steps carried 79% of all step time, and 1.5% of steps (60 s+) carried
 *   23%: the wall clock is not lost to slow decode, it is lost to sessions that
 *   keep issuing calls without learning anything. A step counter cannot tell
 *   those apart from honest long work, so the trigger is *no progress* — no new
 *   call signature, no changed result, no error turning into a success.
 *
 * Nothing here throws on strange input: a scheduler that can fail a turn is worse
 * than no scheduler. Unknown shapes degrade to "no opinion".
 *
 * @module dsh-fast-mode/auto
 */
/** The gear id the adaptive scheduler runs under. */
export const AUTO = 'auto'

/** The numbers the scheduler is allowed to pick from. */
export const AUTO_LIMITS = Object.freeze({
  parallelMin: 2,
  parallelBase: 4,
  parallelMax: 8,
  /** Widest step is only asked for after this many clean steps. */
  widenAfterSteps: 2,
  stallFloorMs: 120_000,
  stallCeilMs: 300_000,
  /** A call that is already slower than this makes the ceiling grow with it. */
  stallMultiplier: 3,
  /** Consecutive no-progress steps before the model is told to change approach. */
  noProgressWarn: 6,
  /** Consecutive no-progress steps before it is told to stop and report. */
  noProgressStop: 12,
  /** Steps in one turn before the same stop-and-report fires. */
  turnStepBudget: 30,
  /** How many recent call durations the p90 is taken over. */
  waitWindow: 32,
  /** Steps between two directives, so the reminder cannot become the noise. */
  directiveCooldown: 3,
})

/** Bounded number of sessions the scheduler remembers. */
export const AUTO_SESSIONS = 200

/** @returns {{sessions: Map<string, object>}} */
export function createAutoState() {
  return { sessions: new Map() }
}

/**
 * @param {ReturnType<typeof createAutoState>} state
 * @param {string} agent
 * @returns {object}
 */
function entryOf(state, agent) {
  const key = typeof agent === 'string' && agent.length > 0 ? agent : '__global__'
  let entry = state.sessions.get(key)
  if (entry) {
    // Touch: Map iteration order is the eviction order.
    state.sessions.delete(key)
    state.sessions.set(key, entry)
    return entry
  }
  entry = {
    steps: 0,
    turnSteps: 0,
    noProgress: 0,
    calls: 0,
    stepCalls: 0,
    lastStepCalls: 0,
    errors: 0,
    /** @type {Map<string, {chars: number, errored: boolean}>} */
    seen: new Map(),
    /** @type {number[]} */
    waits: [],
    lastDirectiveStep: -Infinity,
    lastDirectiveKind: '',
    stopped: false,
  }
  state.sessions.set(key, entry)
  if (state.sessions.size > AUTO_SESSIONS) {
    const oldest = state.sessions.keys().next().value
    if (oldest !== undefined) state.sessions.delete(oldest)
  }
  return entry
}

/**
 * A new turn starts with a clean slate for the per-turn counters only: the
 * session-level memory (what has already been tried) must survive, because that
 * is exactly what a stuck loop re-reads.
 *
 * @param {ReturnType<typeof createAutoState>} state
 * @param {string} agent
 */
export function noteTurn(state, agent) {
  const entry = entryOf(state, agent)
  entry.turnSteps = 0
  entry.stepCalls = 0
  entry.lastStepCalls = 0
  entry.stopped = false
}

/**
 * Record one step boundary.
 *
 * @param {ReturnType<typeof createAutoState>} state
 * @param {string} agent
 */
export function noteStep(state, agent) {
  const entry = entryOf(state, agent)
  entry.steps += 1
  entry.turnSteps += 1
  entry.lastStepCalls = entry.stepCalls
  entry.stepCalls = 0
}

/**
 * Record one finished tool call and decide whether it made progress.
 *
 * "Progress" is deliberately observable rather than semantic: a signature the
 * session has not issued before, a result whose size changed, or a call that
 * used to fail and now succeeds. Anything else is a retry wearing a new hat —
 * including a successful rerun of the identical command, which is why the size
 * of the result is part of the test.
 *
 * @param {ReturnType<typeof createAutoState>} state
 * @param {string} agent
 * @param {{name?: string, argsKey?: string, isError?: boolean, chars?: number, durationMs?: number}} observation
 */
export function noteTool(state, agent, observation) {
  const entry = entryOf(state, agent)
  const obs = observation && typeof observation === 'object' ? observation : {}
  const name = typeof obs.name === 'string' && obs.name.length > 0 ? obs.name : 'unknown'
  const argsKey = typeof obs.argsKey === 'string' ? obs.argsKey : ''
  const signature = `${name}\u0000${argsKey}`
  const chars = Number.isFinite(obs.chars) ? Number(obs.chars) : -1
  const isError = obs.isError === true

  entry.calls += 1
  entry.stepCalls += 1
  if (Number.isFinite(obs.durationMs) && obs.durationMs >= 0) {
    entry.waits.push(Number(obs.durationMs))
    if (entry.waits.length > AUTO_LIMITS.waitWindow) entry.waits.shift()
  }

  const previous = entry.seen.get(signature)
  let progress = false
  if (isError) {
    entry.errors += 1
    if (previous) previous.errored = true
    else entry.seen.set(signature, { chars, errored: true })
  } else {
    if (!previous) progress = true
    else if (previous.errored) progress = true
    else if (previous.chars !== chars) progress = true
    entry.seen.set(signature, { chars, errored: false })
    entry.errors = 0
  }

  if (progress) entry.noProgress = 0
  else entry.noProgress += 1

  // Bounded memory: a long session may issue hundreds of distinct calls and the
  // scheduler only needs to recognise the recent ones.
  if (entry.seen.size > 128) {
    const oldest = entry.seen.keys().next().value
    if (oldest !== undefined) entry.seen.delete(oldest)
  }
}

/** @param {number[]} values @param {number} fraction */
function quantile(values, fraction) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

/**
 * The schedule for the next step of one session.
 *
 * @param {ReturnType<typeof createAutoState>} state
 * @param {string} agent
 * @returns {{parallel: number, stallBudgetMs: number, directive: {kind: string, text: string, summary: string}|undefined, stats: object}}
 */
export function autoSchedule(state, agent) {
  const entry = entryOf(state, agent)
  const p90 = quantile(entry.waits, 0.9)
  const stallBudgetMs = Math.round(
    Math.min(
      AUTO_LIMITS.stallCeilMs,
      Math.max(AUTO_LIMITS.stallFloorMs, p90 * AUTO_LIMITS.stallMultiplier),
    ),
  )

  let parallel = AUTO_LIMITS.parallelBase
  if (entry.noProgress >= 3 || entry.errors >= 3) parallel = AUTO_LIMITS.parallelMin
  else if (entry.turnSteps >= AUTO_LIMITS.widenAfterSteps && entry.lastStepCalls >= 2) parallel = AUTO_LIMITS.parallelMax
  else if (entry.turnSteps >= AUTO_LIMITS.widenAfterSteps) parallel = 6

  const stats = {
    steps: entry.steps,
    turnSteps: entry.turnSteps,
    noProgress: entry.noProgress,
    errors: entry.errors,
    calls: entry.calls,
    lastStepCalls: entry.lastStepCalls,
    p90WaitMs: p90,
    stallBudgetMs,
    parallel,
  }

  return { parallel, stallBudgetMs, directive: directiveFor(entry, stats), stats }
}

/**
 * The one message the scheduler is allowed to add to a step.
 *
 * @param {object} entry
 * @param {{noProgress: number, turnSteps: number}} stats
 * @returns {{kind: string, text: string, summary: string}|undefined}
 */
function directiveFor(entry, stats) {
  const since = entry.steps - entry.lastDirectiveStep
  if (since < AUTO_LIMITS.directiveCooldown) return undefined

  let kind = ''
  if (stats.noProgress >= AUTO_LIMITS.noProgressStop || stats.turnSteps >= AUTO_LIMITS.turnStepBudget) {
    if (entry.stopped) return undefined
    kind = 'stop-and-report'
  } else if (stats.noProgress >= AUTO_LIMITS.noProgressWarn) {
    kind = 'change-approach'
  }
  if (kind === '') return undefined

  entry.lastDirectiveStep = entry.steps
  entry.lastDirectiveKind = kind
  if (kind === 'stop-and-report') entry.stopped = true

  if (kind === 'stop-and-report') {
    return {
      kind,
      text: `Auto schedule: ${stats.noProgress} steps without progress or ${stats.turnSteps} steps in one turn. `
        + 'Stop working now and report instead: what is finished, what is blocked, the exact command or path that fails, '
        + 'and the smallest next step that would unblock it. Do not start another long-running call, '
        + 'and do not retry the same command with the same arguments.',
      summary: 'auto: stop and report, no progress',
    }
  }
  return {
    kind,
    text: `Auto schedule: ${stats.noProgress} consecutive steps produced nothing new. `
      + 'Change the approach before the next call: run the slow command in the background and poll it, '
      + 'write the script to a file and execute that file, or narrow it to one path or one pattern. '
      + 'Repeating the same command with the same arguments is not progress, and it will be cancelled again.',
    summary: 'auto: change approach, no progress',
  }
}

/**
 * The line the panel and the prompt both quote, so the number a user sees is the
 * number the model was asked for.
 *
 * @param {ReturnType<typeof autoSchedule>} schedule
 * @returns {{parallel: number, minutes: string, budgetMs: number}}
 */
export function describeSchedule(schedule) {
  const budgetMs = Number.isFinite(schedule?.stallBudgetMs) ? schedule.stallBudgetMs : AUTO_LIMITS.stallFloorMs
  return {
    parallel: Number.isFinite(schedule?.parallel) ? schedule.parallel : AUTO_LIMITS.parallelBase,
    minutes: String(Math.round((budgetMs / 60_000) * 10) / 10),
    budgetMs,
  }
}
