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
  parallelBase: 4,
  parallelMax: 8,
  /** Hard ceiling for `fanoutWidth`, so a config cannot ask for an unbounded block. */
  parallelCapMax: 12,
  /** Widest step is only asked for after this many clean steps. */
  widenAfterSteps: 2,
  stallFloorMs: 120_000,
  stallCeilMs: 300_000,
  /** A call that is already slower than this makes the ceiling grow with it. */
  stallMultiplier: 3,
  /** Consecutive no-progress steps before the model is told to change approach. */
  noProgressWarn: 6,
  /**
   * Steps in one turn before the hard stop fires. Off by default: a step count
   * is a cost metric, not evidence that the work is finished, and a plugin that
   * ends a turn on a counter can cut a progressing task short. A user who wants
   * a hard ceiling sets `stepBudget` themselves.
   */
  turnStepBudget: 0,
  /**
   * Steps into a turn where an optional soft finish line asks for the report.
   * Off by default, and this one is the retired default: at step 10 it told the
   * model to stop re-reading files and stop re-running checks, which is exactly
   * what a task that just edited code after a green test must keep doing. Kept
   * as an opt-in ablation, never as the shipped stance.
   */
  finishLineSteps: 0,
  /** How many recent call durations the p90 is taken over. */
  waitWindow: 32,
  /** Steps between two directives, so the reminder cannot become the noise. */
  directiveCooldown: 3,
  /** Steps into a turn before compression is worth its one message. */
  disciplineAfterSteps: 4,
})

/**
 * Calls that cannot change shared state. A step made only of these is the one
 * shape where widening costs nothing but a wider prompt: the calls cannot
 * depend on each other's writes, so the harness can start them together.
 *
 * Bash is deliberately absent: `grep` and `cat` through a shell are read-only in
 * effect but the scheduler cannot tell them apart from `rm`, so a shell step is
 * treated as mixed and widens on the slower schedule.
 */
const SAFE_CALLS = Object.freeze(new Set([
  'read', 'grep', 'glob', 'list', 'ls', 'find',
  'web_fetch', 'web_search', 'fetch', 'search', 'journal',
]))

/** Bounded number of sessions the scheduler remembers. */
export const AUTO_SESSIONS = 200

/**
 * Record the width classified from this request's text. It is only consumed by
 * the first step of the next turn, so later steps of the same turn cannot
 * overwrite the decision halfway through.
 *
 * @param {ReturnType<typeof createAutoState>} state
 * @param {string} agent
 * @param {number} width
 */
export function noteEntry(state, agent, width) {
  const entry = entryOf(state, agent)
  if (Number.isFinite(width) && width >= 1) entry.pendingWidth = Math.min(width, widthCap(entry))
}

/**
 * Tell the scheduler how this session's config wants output compressed.
 *
 * `outputDiscipline: 'late'` keeps the system prompt free of prose rules and
 * asks for compression only once the turn has proved long enough to earn it,
 * so a three-step task pays nothing and a twenty-step task still saves the
 * decode time that dominates it.
 *
 * @param {ReturnType<typeof createAutoState>} state
 * @param {string} agent
 * @param {{lateDiscipline?: boolean, stepBudget?: number, finishLineSteps?: number, outputBudget?: number, openBatch?: boolean, shapeGate?: boolean, fanoutWidth?: number, batchVerify?: boolean}} policy
 */
export function notePolicy(state, agent, policy) {
  const entry = entryOf(state, agent)
  entry.lateDiscipline = policy?.lateDiscipline === true
  // A token budget counts decode work, which is what the wall clock is actually
  // made of; 0 is the off switch, exactly like stepBudget.
  entry.outBudget = stepCount(policy?.outputBudget, 0, 0)
  // 0 is a value, not "unset": it is how a caller asks for no hard stop at all.
  entry.turnStepBudget = stepCount(policy?.stepBudget, AUTO_LIMITS.turnStepBudget, 0)
  entry.finishLineSteps = stepCount(policy?.finishLineSteps, AUTO_LIMITS.finishLineSteps, 0)
  entry.openBatch = policy?.openBatch === true
  // Opt-in shape gate: when a turn's calls are mostly writes, the scheduler has
  // nothing to batch and every reminder is a round trip the task cannot use.
  entry.shapeGate = policy?.shapeGate === true
  // Opt-in: group the verification of one edit batch instead of one run per file.
  entry.batchVerify = policy?.batchVerify === true
  // 0 keeps the built-in cap; a positive number only widens blocks that the
  // evidence already called parallel, so nothing new is asked for on a write step.
  entry.widthCap = Number(policy?.fanoutWidth) || 0
}

/** A whole step count, or `fallback` when the value is not a usable number. */
function stepCount(value, fallback, min) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback
}

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
    stepUnsafe: 0,
    stepArgs: new Set(),
    lastStepCalls: 0,
    lastStepReadOnly: false,
    /** True when every call in the last step read a different target. */
    lastStepDistinct: false,
    /** Output tokens this turn has been charged for, from upstream usage. */
    turnOutTokens: 0,
    /** Width chosen from the request text, consumed by the turn's first step. */
    entryWidth: undefined,
    pendingWidth: undefined,
    readOnlyStreak: 0,
    errors: 0,
    /** @type {Map<string, {digest: string, chars: number, errored: boolean}>} */
    seen: new Map(),
    /**
     * A monotone counter of observed mutations. A check result is only reusable
     * while the epoch it was recorded under is still the current one; any write
     * or build command bumps it and invalidates every stored result at once.
     */
    epoch: 0,
    /** @type {Map<string, {epoch: number, digest: string}>} */
    checks: new Map(),
    /** Signature of a check that just repeated with a still-valid stored pass. */
    reuseHint: '',
    /** Epoch in which the reuse reminder last fired, so it fires once per epoch. */
    reuseSentEpoch: -1,
    /** True when the current step produced at least one new observation. */
    stepProgress: false,
    /** @type {number[]} */
    waits: [],
    lastDirectiveStep: -Infinity,
    lastDirectiveKind: '',
    stopped: false,
    /** True when the config asked for `outputDiscipline: 'late'`. */
    lateDiscipline: false,
    /** One compression reminder per turn, never more. */
    disciplineSent: false,
    /** Hard stop: the step count that ends the turn with "report now". */
    turnStepBudget: AUTO_LIMITS.turnStepBudget,
    /** Soft stop: one "no more scope" reminder at this step, 0 = off. */
    finishLineSteps: AUTO_LIMITS.finishLineSteps,
    /** One finish-line reminder per turn, never more. */
    finishLineSent: false,
    /** One "batch the opening step" reminder per turn, never more. */
    openBatch: false,
    openingSent: false,
    /** Opt-in: stay silent on a turn whose calls turned out to be writes. */
    shapeGate: false,
    /** Opt-in: ask for one covering check per edit batch, not one per file. */
    batchVerify: false,
    /** Files changed since the last successful shell check, and whether we asked. */
    writesSinceCheck: 0,
    batchVerifySent: false,
    /** 0 = built-in cap; otherwise the widest block the scheduler may ask for. */
    widthCap: 0,
    turnCalls: 0,
    turnUnsafe: 0,
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
  entry.stepUnsafe = 0
  entry.stepArgs.clear()
  entry.stopped = false
  entry.stepProgress = false
  entry.disciplineSent = false
  entry.finishLineSent = false
  entry.outBudgetSent = false
  entry.openingSent = false
  entry.turnOutTokens = 0
  entry.turnCalls = 0
  entry.turnUnsafe = 0
  entry.entryWidth = undefined
  entry.pendingWidth = undefined
}

/**
 * Charge one assistant message's output tokens to the current turn.
 *
 * The harness reports usage on every completed message, so this is the same
 * number the meter bills: decode time, not round trips. The scheduler reads it
 * to decide whether a turn has already spent enough output to justify a warning.
 *
 * @param {ReturnType<typeof createAutoState>} state
 * @param {string} agent
 * @param {number} tokens
 */
export function noteOutputTokens(state, agent, tokens) {
  const n = Number(tokens)
  if (!Number.isFinite(n) || n <= 0) return
  entryOf(state, agent).turnOutTokens += n
}

/**
 * Record one step boundary.
 *
 * @param {ReturnType<typeof createAutoState>} state
 * @param {string} agent
 */
export function noteStep(state, agent) {
  const entry = entryOf(state, agent)
  // The first step of a turn adopts the width classified from that request.
  if (entry.turnSteps === 0 && entry.pendingWidth !== undefined) {
    entry.entryWidth = entry.pendingWidth
    entry.pendingWidth = undefined
  }
  entry.steps += 1
  entry.turnSteps += 1
  // A step that issued no calls (a final answer, say) says nothing about
  // whether the work is read-heavy, so it must not reset the streak.
  if (entry.stepCalls > 0) {
    entry.lastStepCalls = entry.stepCalls
    entry.lastStepReadOnly = entry.stepUnsafe === 0
    // Distinct read targets are the programmatic definition of "these calls can
    // run together": no two of them touched the same path, so none can depend
    // on another's result. Overlapping targets are the shape that looks batched
    // but is really a chain.
    entry.lastStepDistinct = entry.lastStepReadOnly && entry.stepArgs.size === entry.stepCalls
    entry.readOnlyStreak = entry.lastStepReadOnly ? entry.readOnlyStreak + 1 : 0
    // Stall is a property of a whole step, not of one call: a step that polled
    // status five times with the same text still produced nothing, while a step
    // whose five calls all returned the same *length* may have produced plenty.
    if (entry.stepProgress) entry.noProgress = 0
    else entry.noProgress += 1
  }
  entry.stepProgress = false
  entry.stepCalls = 0
  entry.stepUnsafe = 0
  entry.stepArgs.clear()
}

/**
 * Record one finished tool call and decide whether it made progress.
 *
 * "Progress" is observable, and it is compared on **content**, not size: a
 * status poll that walks `completed 10 / 99` → `11 / 99` has the same length
 * every time, so a length test called a perfectly healthy wait a stall. The
 * digest also separates two results of equal size that say different things.
 * A call that used to fail and now succeeds is progress; an identical
 * successful rerun of the same call is not.
 *
 * The same observation feeds the check registry: a successful call is stored
 * with the artifact epoch it ran under, and repeating it verbatim while that
 * epoch is current is what the "reuse the result" reminder is for.
 *
 * @param {ReturnType<typeof createAutoState>} state
 * @param {string} agent
 * @param {{name?: string, argsKey?: string, isError?: boolean, chars?: number, digest?: string, durationMs?: number}} observation
 */
export function noteTool(state, agent, observation) {
  const entry = entryOf(state, agent)
  const obs = observation && typeof observation === 'object' ? observation : {}
  const name = typeof obs.name === 'string' && obs.name.length > 0 ? obs.name : 'unknown'
  const argsKey = typeof obs.argsKey === 'string' ? obs.argsKey : ''
  const signature = `${name}\u0000${argsKey}`
  const chars = Number.isFinite(obs.chars) ? Number(obs.chars) : -1
  const digest = typeof obs.digest === 'string' && obs.digest.length > 0 ? obs.digest : `chars:${chars}`
  const isError = obs.isError === true

  entry.calls += 1
  entry.stepCalls += 1
  entry.turnCalls += 1
  if (argsKey.length > 0) entry.stepArgs.add(argsKey)
  if (!SAFE_CALLS.has(name)) {
    entry.stepUnsafe += 1
    entry.turnUnsafe += 1
  }
  if (Number.isFinite(obs.durationMs) && obs.durationMs >= 0) {
    entry.waits.push(Number(obs.durationMs))
    if (entry.waits.length > AUTO_LIMITS.waitWindow) entry.waits.shift()
  }

  // A mutation invalidates every stored check at once; the epoch is the only
  // bookkeeping the reuse reminder needs. A verbatim *repeated* check is the
  // exception: `npm test` is a shell call that looks like a writer, and without
  // this branch it would bump its own epoch on every run, so the one command
  // the reuse reminder exists for could never trigger it.
  const priorCheck = entry.checks.get(signature)
  const repeatedCheck = priorCheck !== undefined && priorCheck.epoch === entry.epoch
  if (isMutation(name, argsKey) && !(SHELL_CALLS.has(name) && repeatedCheck)) {
    entry.epoch += 1
    entry.checks.clear()
    entry.reuseHint = ''
    entry.writesSinceCheck += 1
    entry.batchVerifySent = false
  }

  const previous = entry.seen.get(signature)
  let progress = false
  if (isError) {
    entry.errors += 1
    if (previous) previous.errored = true
    else entry.seen.set(signature, { digest, chars, errored: true })
  } else {
    if (!previous) progress = true
    else if (previous.errored) progress = true
    else if (previous.digest !== digest) progress = true
    entry.seen.set(signature, { digest, chars, errored: false })
    entry.errors = 0
    noteCheck(entry, name, argsKey, signature, digest)
    // A successful shell call is the only evidence available that a check ran.
    if (SHELL_CALLS.has(name)) {
      entry.writesSinceCheck = 0
      entry.batchVerifySent = false
    }
  }

  if (progress) entry.stepProgress = true

  // Bounded memory: a long session may issue hundreds of distinct calls and the
  // scheduler only needs to recognise the recent ones.
  if (entry.seen.size > 128) {
    const oldest = entry.seen.keys().next().value
    if (oldest !== undefined) entry.seen.delete(oldest)
  }
}

/** Calls whose whole purpose is to wait, so a repeat carries no reuse meaning. */
const WAITING_CALLS = Object.freeze(new Set([
  'ask_user_question', 'wait_agent', 'job_output', 'job_list', 'task_board_run',
  'workflow', 'subagent', 'subagent_fork',
]))

/**
 * Shell commands that write. The argument string is all the scheduler has, so
 * this is a conservative read: anything that looks like a redirection or one of
 * the common mutators bumps the epoch, and a false positive only costs one
 * unnecessary reminder — a false negative would let a stale check look valid.
 */
const MUTATOR = /(?:>>?|\btee\b|\bcp\b|\bmv\b|\brm\b|\bmkdir\b|\btouch\b|\bchmod\b|\bln\b|\bpatch\b|\bdd\b|\bpip3?\b|\bnpm\b|\bpnpm\b|\byarn\b|\bmake\b|\bsed\s+-i\b|\bgit\s+(?:clone|init|add|commit|checkout|switch|apply|reset|stash|merge|rebase|rm)\b)/

/** @param {string} name @param {string} argsKey */
function isMutation(name, argsKey) {
  if (MUTATING_CALLS.has(name)) return true
  if (SHELL_CALLS.has(name)) return MUTATOR.test(argsKey)
  return false
}

const MUTATING_CALLS = Object.freeze(new Set(['write', 'edit', 'apply_patch', 'patch']))
const SHELL_CALLS = Object.freeze(new Set(['bash', 'shell', 'terminal', 'run_code', 'exec']))

/**
 * Store a successful call as a reusable result, and raise the hint when it is a
 * verbatim repeat of one that is still valid for the current epoch.
 *
 * @param {object} entry
 * @param {string} name
 * @param {string} argsKey
 * @param {string} signature
 * @param {string} digest
 */
function noteCheck(entry, name, argsKey, signature, digest) {
  if (argsKey.length === 0 || WAITING_CALLS.has(name)) return
  const stored = entry.checks.get(signature)
  if (stored && stored.epoch === entry.epoch && stored.digest === digest && entry.reuseHint === '') {
    entry.reuseHint = signature
    return
  }
  entry.checks.set(signature, { epoch: entry.epoch, digest })
  if (entry.checks.size > 64) {
    const oldest = entry.checks.keys().next().value
    if (oldest !== undefined) entry.checks.delete(oldest)
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

  // Selective acceleration: speed is only worth asking for where the evidence
  // says the work is parallel. Everything else keeps the native behaviour —
  // width 1 silences the whole guidance section, so a write-heavy or
  // dependency-bound stretch is not told to batch, and pays no prompt tax.
  let parallel = 1
  // Recent error evidence outranks the request classification: a fan-out shape
  // whose last three calls failed is not a shape worth asking for again.
  if (entry.errors >= 3) {
    parallel = 1
  } else if (entry.turnSteps >= 1 && Number.isFinite(entry.entryWidth) && entry.entryWidth >= 1) {
    // Classified from the request itself: this is the only signal available on
    // the very first step, so it must outrank the "nothing observed" probe.
    parallel = entry.entryWidth
  } else if (entry.steps === 0 && entry.calls === 0) {
    // Nothing observed yet: one cheap probe block, small enough to stay honest
    // on tasks that turn out to have nothing to fan out.
    parallel = AUTO_LIMITS.parallelBase
  } else if (entry.noProgress >= 3) {
    parallel = 1
  } else if (entry.lastStepDistinct && entry.lastStepCalls >= 2) {
    // The strongest local signal: the last step was already a block of
    // independent reads. Keep it wide, whichever step of the turn this is.
    parallel = widthCap(entry)
  } else if (entry.readOnlyStreak >= 2 && entry.lastStepCalls >= 2) {
    // Two consecutive steps of pure reads that batched cleanly: this session is
    // doing read-heavy work, so keep the block wide — including across the turn
    // boundary, where the old rule fell back to the base width for no reason.
    parallel = widthCap(entry)
  } else if (entry.turnSteps >= 1 && entry.lastStepReadOnly && entry.lastStepCalls >= 3) {
    // The first step already proved the calls can run together; a wider read
    // block is the cheapest speed left on the table, so do not wait for a
    // second step to ask for it.
    parallel = widthCap(entry)
  } else if (entry.turnSteps >= AUTO_LIMITS.widenAfterSteps && entry.lastStepCalls >= 2) {
    parallel = widthCap(entry)
  } else if (entry.turnSteps === 0) {
    // A new request whose history shows no parallel shape stays native: the
    // whole guidance section is dropped, so a shell-heavy or write-bound turn
    // pays neither the prompt tax nor a batch instruction it cannot use.
    parallel = 1
  }

  const stats = {
    steps: entry.steps,
    turnSteps: entry.turnSteps,
    turnOutTokens: entry.turnOutTokens,
    turnCalls: entry.turnCalls,
    turnUnsafe: entry.turnUnsafe,
    noProgress: entry.noProgress,
    errors: entry.errors,
    calls: entry.calls,
    lastStepCalls: entry.lastStepCalls,
    lastStepReadOnly: entry.lastStepReadOnly,
    lastStepDistinct: entry.lastStepDistinct,
    readOnlyStreak: entry.readOnlyStreak,
    p90WaitMs: p90,
    stallBudgetMs,
    parallel,
  }

  return { parallel, stallBudgetMs, directive: directiveFor(entry, stats), stats }
}

/** The widest block this session may ask for: the config cap, else the built-in. */
function widthCap(entry) {
  const cap = Number(entry.widthCap)
  if (!Number.isFinite(cap) || cap < AUTO_LIMITS.parallelBase) return AUTO_LIMITS.parallelMax
  return Math.min(cap, AUTO_LIMITS.parallelCapMax)
}

/**
 * The one message the scheduler is allowed to add to a step.
 *
 * @param {object} entry
 * @param {{noProgress: number, turnSteps: number}} stats
 * @returns {{kind: string, text: string, summary: string}|undefined}
 */
function directiveFor(entry, stats) {
  // Shape gate: a turn that has already spent most of its calls on writes is
  // not a turn the scheduler can accelerate — there is nothing to batch, and
  // every reminder costs a round trip the work cannot reuse. Silence is the
  // native behaviour, so the switch falls back to it instead of guessing.
  // An explicit `stepBudget` is the user's own instruction and outranks the
  // gate: "don't accelerate this" must never turn into "ignore my stop line".
  const userAskedStop = entry.turnStepBudget > 0 && stats.turnSteps >= entry.turnStepBudget
  if (!userAskedStop && entry.shapeGate && stats.turnCalls >= 4 && stats.turnUnsafe * 10 >= stats.turnCalls * 6) {
    return undefined
  }
  if (entry.openBatch && !entry.openingSent && stats.turnSteps <= 1) {
    // A short task never reaches the finish line, so it pays the per-call fixed
    // cost (TTFT) of every round trip and nothing else. One line at the opening
    // step is the only harness lever that can remove a round trip outright.
    entry.openingSent = true
    entry.lastDirectiveStep = entry.steps
    entry.lastDirectiveKind = 'open-batch'
    return {
      kind: 'open-batch',
      text: 'Auto schedule: batch now. Put every independent tool call you already know you need in one '
        + 'block this step, and chain shell commands with && instead of one call per command.',
      summary: 'auto: batch the opening step',
    }
  }
  const since = entry.steps - entry.lastDirectiveStep
  if (since < AUTO_LIMITS.directiveCooldown) return undefined

  if (entry.batchVerify && !entry.batchVerifySent && entry.writesSinceCheck >= 2) {
    // The steps this saves are the "run the whole suite again" ones that follow
    // every single edit. The check itself is not skipped, only grouped: the ask
    // is to finish the batch first, then run the covering check once.
    entry.batchVerifySent = true
    entry.lastDirectiveStep = entry.steps
    entry.lastDirectiveKind = 'batch-verify'
    return {
      kind: 'batch-verify',
      text: `Auto schedule: ${entry.writesSinceCheck} files changed since the last run. Finish the edits of this `
        + 'batch, then run the one check that covers all of them instead of one run per file. The check still '
        + 'runs, and it still has to pass before you report.',
      summary: 'auto: group the verification of this edit batch',
    }
  }
  if (entry.lateDiscipline && !entry.disciplineSent && stats.turnSteps >= AUTO_LIMITS.disciplineAfterSteps) {
    // Late engagement: the prompt carried no prose rules, so the only cost of a
    // short task was its own work. By this step the task is demonstrably long,
    // and every remaining step re-pays its output tokens in decode time.
    entry.disciplineSent = true
    entry.lastDirectiveStep = entry.steps
    entry.lastDirectiveKind = 'compress-output'
    return {
      kind: 'compress-output',
      text: 'Auto schedule: this turn is long enough that prose is now the cost. '
        + 'For the remaining steps write only what the next action needs: the command, the file, the '
        + 'conclusion. No restating file contents, no narrating what you are about to do, no summary of '
        + 'what a tool returned. Keep the answer complete; cut the commentary.',
      summary: 'auto: compress output for the rest of the turn',
    }
  }
  const outBudget = entry.outBudget
  if (outBudget > 0 && !entry.outBudgetSent && stats.turnOutTokens >= outBudget) {
    // Evidence that the turn is expensive, not that it is long: the counter is
    // the provider's own usage. A three-step turn that wrote 30 000 tokens is a
    // cost problem the step counter cannot see, and a twenty-step turn that
    // wrote 2 000 tokens is not.
    entry.outBudgetSent = true
    entry.lastDirectiveStep = entry.steps
    entry.lastDirectiveKind = 'output-budget'
    return {
      kind: 'output-budget',
      text: `Auto schedule: this turn has written about ${stats.turnOutTokens} output tokens, and decode time `
        + 'is the wall clock. Close the smallest complete loop for what you are holding: finish the current '
        + 'file or function, run the one check that proves it, and report. Do not expand scope, do not '
        + 'rewrite a file that already works, do not restate what you wrote.',
      summary: 'auto: output token budget reached',
    }
  }
  if (entry.finishLineSteps > 0 && !entry.finishLineSent && stats.turnSteps >= entry.finishLineSteps) {
    // Soft stop: the tail of a long turn is where the wall clock and the
    // correctness both go wrong — the model keeps adding scope and re-verifying
    // what already passes. One reminder at the finish line ends the turn on the
    // artifact it already has instead of cutting it off mid-edit like the hard
    // budget does.
    entry.finishLineSent = true
    entry.lastDirectiveStep = entry.steps
    entry.lastDirectiveKind = 'finish-line'
    return {
      kind: 'finish-line',
      text: 'Auto schedule: finish line. Stop adding scope: no new features, no rewrites, no re-reading '
        + 'your files, no re-running a check that passed. Fix only what still fails, then report.',
      summary: 'auto: finish line, stop adding scope',
    }
  }
  // A hard stop exists only when the user asked for one (`stepBudget`). The
  // scheduler itself never ends a turn on a step counter: the counter measures
  // cost, and the evidence for "the work is done" lives in the work.
  const budget = entry.turnStepBudget
  if (budget > 0 && stats.turnSteps >= budget) {
    if (entry.stopped) return undefined
    entry.stopped = true
    entry.lastDirectiveStep = entry.steps
    entry.lastDirectiveKind = 'stop-and-report'
    return {
      kind: 'stop-and-report',
      text: `Auto schedule: this turn reached the step budget it was given (${budget}). `
        + 'Report where the work stands — finished, still open, the exact command or path that fails, and '
        + 'the smallest next step — and stop starting new long-running work.',
      summary: 'auto: user step budget reached',
    }
  }
  if (entry.reuseHint !== '' && entry.reuseSentEpoch !== entry.epoch) {
    // The narrowest, most defensible kind of saving: the same check, verbatim,
    // already passed on this exact artifact version. Anything that wrote since
    // then bumped the epoch and this branch is unreachable, which is what makes
    // the reminder safe for a task that edits code after a green test.
    entry.reuseHint = ''
    entry.reuseSentEpoch = entry.epoch
    entry.lastDirectiveStep = entry.steps
    entry.lastDirectiveKind = 'reuse-check'
    return {
      kind: 'reuse-check',
      text: 'Auto schedule: that check already passed on the current files and nothing relevant changed '
        + 'since. Use the result you already have and spend this step on the remaining work; run it again only '
        + 'after the files it covers change.',
      summary: 'auto: reuse a passing check',
    }
  }
  if (stats.noProgress >= AUTO_LIMITS.noProgressWarn) {
    // A stall is a reason to change method, never a reason to end the task: the
    // same step evidence that looks like a loop can be a slow, healthy wait.
    entry.lastDirectiveStep = entry.steps
    entry.lastDirectiveKind = 'change-approach'
    return {
      kind: 'change-approach',
      text: `Auto schedule: ${stats.noProgress} consecutive steps produced nothing new. `
        + 'Check the preconditions and change the method before the next call: run the slow command in the '
        + 'background and poll it, write the script to a file and execute that file, or narrow it to one path '
        + 'or one pattern. Repeating the same call with the same arguments will not move the task forward.',
      summary: 'auto: change approach, no progress',
    }
  }
  return undefined
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
