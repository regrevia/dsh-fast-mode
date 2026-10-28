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

import { statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
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
  /** Off by default: no second compression reminder in a long turn. */
  disciplineRepeatAtSteps: 0,
  /**
   * Off by default. When set, an early `disciplineAfterSteps` only applies to a
   * turn that has already made this many tool calls; otherwise the reminder
   * waits for the built-in step. The early reminder is what the turn pays for
   * and what it saves depends on the turn being long, so the call density at
   * that step is the prediction: measured on 21 paired sessions, a one-call
   * first step is a single-file task (8/8 codeimpl) and a two-call first step
   * is a multi-file or debug task (7/7 debugfix, 6/6 migrate).
   */
  disciplineEarlyCalls: 0,
  /** A write whose body is at least this long is a whole-file rewrite. */
  patchHintMinChars: 2000,
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
 * @param {{lateDiscipline?: boolean, stepBudget?: number, finishLineSteps?: number, outputBudget?: number, outputBudgetAfterSteps?: number, openBatch?: boolean, shapeGate?: boolean, scheduler?: boolean, fanoutWidth?: number, batchVerify?: boolean, preferPatch?: boolean, disciplineAfterSteps?: number, disciplineRepeatAtSteps?: number, disciplineEarlyCalls?: number, rereadHint?: boolean}} policy
 */
export function notePolicy(state, agent, policy) {
  const entry = entryOf(state, agent)
  entry.lateDiscipline = policy?.lateDiscipline === true
  // A token budget counts decode work, which is what the wall clock is actually
  // made of; 0 is the off switch, exactly like stepBudget.
  entry.outBudget = stepCount(policy?.outputBudget, 0, 0)
  entry.outBudgetAfterSteps = stepCount(policy?.outputBudgetAfterSteps, 0, 0)
  // 0 keeps the built-in entry step; a positive value moves the one reminder that
  // has a measured effect (see BENCHMARK: compress-output) earlier or later.
  entry.disciplineAfterSteps = stepCount(policy?.disciplineAfterSteps, 0, 0)
  // The reminder above is once per turn; a long turn drifts back to prose after
  // it, so an explicit step can repeat the same ask exactly once more.
  entry.disciplineRepeatAtSteps = stepCount(policy?.disciplineRepeatAtSteps, 0, 0)
  // One extra sentence, not one extra message: the compression reminder already
  // owns a step where the turn has proven itself long, and that is the only
  // place a re-read rule can be said for free.
  entry.rereadHint = policy?.rereadHint === true
  // 0 keeps the early reminder unconditional, which is the 1.5.12 behaviour and
  // the arm that measured slower on short turns.
  entry.disciplineEarlyCalls = stepCount(policy?.disciplineEarlyCalls, 0, 0)
  // 0 is a value, not "unset": it is how a caller asks for no hard stop at all.
  entry.turnStepBudget = stepCount(policy?.stepBudget, AUTO_LIMITS.turnStepBudget, 0)
  entry.finishLineSteps = stepCount(policy?.finishLineSteps, AUTO_LIMITS.finishLineSteps, 0)
  entry.openBatch = policy?.openBatch === true
  // Opt-in shape gate: when a turn's calls are mostly writes, the scheduler has
  // nothing to batch and every reminder is a round trip the task cannot use.
  entry.shapeGate = policy?.shapeGate === true
  // Only `false` silences the directive channel; an absent field keeps the
  // default, so every existing caller keeps its behaviour.
  entry.scheduler = policy?.scheduler !== false
  // Opt-in: group the verification of one edit batch instead of one run per file.
  entry.batchVerify = policy?.batchVerify === true
  // Opt-in: after one large whole-file write, ask for hunks on existing files.
  entry.preferPatch = policy?.preferPatch === true
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
    /**
     * Stat fingerprints of the files this session wrote, keyed by absolute path
     * and captured when the write was observed. They are only read to snapshot
     * the artifact versions a passing check covered; they are never rebaselined
     * by a later check, because that would let one pass make a different pass
     * look current.
     *
     * @type {Map<string, {mtimeMs: number, size: number}>}
     */
    writes: new Map(),
    /**
     * True once a write happened whose target could not be fingerprinted. The
     * artifact set is then unknown, and no stored pass can be defended by a stat
     * re-read, so reuse is not offered for the rest of the session.
     */
    writesUncertain: false,
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
    /** Step for the optional repeat of that reminder; 0 = off. */
    disciplineRepeatAtSteps: AUTO_LIMITS.disciplineRepeatAtSteps,
    /** Append the "do not re-read what this turn wrote" sentence to the reminder. */
    rereadHint: false,
    /** True once the repeat has been sent. */
    disciplineRepeatSent: false,
    /**
     * The step the real-time reminder was locked to for this turn, decided once
     * from the first step's call density. 0 means "not decided yet".
     */
    disciplineAtLocked: 0,
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
    /** The directive channel of the scheduler; off = width and budget only. */
    scheduler: true,
    /** Opt-in: ask for one covering check per edit batch, not one per file. */
    batchVerify: false,
    /** Opt-in: after a large whole-file write, ask for hunks instead. */
    preferPatch: false,
    patchHint: false,
    patchHintSent: false,
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
  entry.disciplineRepeatSent = false
  entry.disciplineAtLocked = 0
  entry.finishLineSent = false
  entry.outBudgetSent = false
  entry.openingSent = false
  entry.patchHintSent = false
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
 * @param {{name?: string, argsKey?: string, isError?: boolean, chars?: number, digest?: string,
 *   durationMs?: number, paths?: string[], command?: string, cwd?: string}} observation
 *   `argsKey` is dedupe identity only (sorted, truncated); `paths`, `command` and
 *   `cwd` are the untruncated execution facts the verification evidence needs.
 */
export function noteTool(state, agent, observation) {
  const entry = entryOf(state, agent)
  const obs = observation && typeof observation === 'object' ? observation : {}
  const name = typeof obs.name === 'string' && obs.name.length > 0 ? obs.name : 'unknown'
  const argsKey = typeof obs.argsKey === 'string' ? obs.argsKey : ''
  // Dedupe identity: bounded and cheap. Execution semantics come from the
  // untruncated command/paths the observation carries, never from this key.
  const command = typeof obs.command === 'string' ? obs.command : ''
  const signature = SHELL_CALLS.has(name) && command.length > 0
    ? `${name}\u0000${command}`
    : `${name}\u0000${argsKey}`
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

  // A write, or a shell command the classifier cannot vouch for, invalidates
  // every stored check at once; the epoch is the only bookkeeping the reuse
  // reminder needs. A verification run is *not* a mutation even though its
  // command often names a build tool (`npm test`, `make test`): bumping the
  // epoch on the check itself is what used to make the one command this
  // reminder targets unable to produce it.
  const shellKind = SHELL_CALLS.has(name) ? classifyShell(command.length > 0 ? command : argsKey) : undefined
  if (MUTATING_CALLS.has(name) || shellKind === 'unknown') {
    entry.epoch += 1
    entry.checks.clear()
    entry.reuseHint = ''
    entry.writesSinceCheck += 1
    entry.batchVerifySent = false
  }
  if (MUTATING_CALLS.has(name)) recordWritePaths(entry, obs)

  // A whole-file argument is the compressible half of output: the file lands on
  // disk either way, so the only thing a hunk form changes is how many tokens
  // had to be decoded to say the same thing. Armed by the observation, spent by
  // the scheduler once.
  if (entry.preferPatch && !isError) {
    const name0 = name.toLowerCase()
    const writesWholeFile = name0 === 'write' || name0 === 'write_file' || name0 === 'create_file'
    if (writesWholeFile && Number(obs.argChars) >= AUTO_LIMITS.patchHintMinChars) entry.patchHint = true
    else if (name0 === 'edit' || name0 === 'apply_patch' || name0 === 'patch') entry.patchHint = false
  }

  const previous = entry.seen.get(signature)
  let progress = false
  if (isError) {
    entry.errors += 1
    if (previous) previous.errored = true
    else entry.seen.set(signature, { digest, chars, errored: true })
    // A check that now fails is evidence against the stored pass: the artifact
    // it covered is not proven current any more, even if nothing wrote since.
    if (shellKind === 'verify') withdrawCheck(entry, signature)
  } else {
    if (!previous) progress = true
    else if (previous.errored) progress = true
    else if (previous.digest !== digest) progress = true
    entry.seen.set(signature, { digest, chars, errored: false })
    entry.errors = 0
    noteCheck(entry, signature, digest, shellKind)
    // Only a verification run is evidence that the current files were checked;
    // a read-only shell command says nothing about the edits still unverified.
    if (shellKind === 'verify') {
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

/**
 * Tokens that write. The argument string is all the scheduler has, so a false
 * positive only costs one invalidation, while a false negative would let a stale
 * pass look valid. This list is therefore a *disqualifier*, never a classifier:
 * the command shapes that may be reused are the strict allowlists below.
 */
const MUTATOR = /(?:>>?|\btee\b|\bcp\b|\bmv\b|\brm\b|\bmkdir\b|\btouch\b|\bchmod\b|\bln\b|\bpatch\b|\bdd\b|\bpip3?\b|\bsed\s+-i\b|\s-delete\b|\s-exec\b|\bgit\s+(?:clone|init|add|commit|checkout|switch|apply|reset|stash|merge|rebase|rm)\b)/

/** First tokens of commands that only read. Anything else is not read-only. */
const READONLY_COMMAND = /^(?:cat|ls|grep|rg|head|tail|wc|find|pwd|echo|stat|file|diff|du|df|which|sort|uniq|cut|tr|jq|git\s+(?:status|diff|log|show|branch|rev-parse|ls-files)|node\s+--version|npm\s+(?:ls|list|view|--version)|python3?\s+--version|go\s+(?:version|list)|cargo\s+(?:--version|metadata))\b/

/** Command shapes that are a verification run and nothing else. */
const VERIFY_COMMAND = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|verify|lint|typecheck|ci)\b|(?:npx\s+)?(?:jest|vitest|mocha|tsc|eslint|ruff|mypy|pytest|py\.test)\b|python3?\s+-m\s+(?:unittest|pytest|mypy|ruff|compileall)\b|python3?\s+pytest\b|node\s+--test\b|(?:go|cargo)\s+test\b|make\s+(?:test|check|verify|lint)\b|tox\b|ctest\b)/

/** Argument fields a shell call keeps its command in. */
const COMMAND_FIELDS = ['command', 'cmd', 'script', 'shell']

/** Argument fields a write call keeps its target paths in. */
const PATH_FIELDS = ['path', 'file_path', 'filePath', 'target', 'file', 'filename']

/** Patch-shaped arguments: the targets live in the diff text, not in a path field. */
const PATCH_CALLS = Object.freeze(new Set(['apply_patch', 'patch', 'apply_diff', 'edit_patch']))
const PATCH_TEXT_FIELDS = ['patch', 'patch_text', 'diff', 'input']
const PATCH_HEADER = /^[ \t]*(?:\*\*\* (?:Update File:|Add File:|Move to:)[ \t]*|[+]{3}[ \t]+b\/)(.+?)[ \t]*$/gm

/** How many written files stay tracked for the fingerprint recheck. */
const WRITE_WINDOW = 64

const MUTATING_CALLS = Object.freeze(new Set(['write', 'write_file', 'create_file', 'edit', 'multi_edit', 'apply_patch', 'patch']))
const SHELL_CALLS = Object.freeze(new Set(['bash', 'shell', 'terminal', 'run_code', 'exec']))

/**
 * Files a patch names, read from its headers: `*** Update File:` / `*** Add File:` /
 * `*** Move to:` (the agent patch dialect) and `+++ b/<path>` (unified diff).
 *
 * Without this a patch-based edit names no path, the write cannot be fingerprinted,
 * and the session permanently stops offering reuse evidence — the common edit path
 * would pay the whole cost of a feature it never uses.
 *
 * @param {string} text
 * @returns {string[]}
 */
function patchTargets(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const paths = []
  PATCH_HEADER.lastIndex = 0
  let match = PATCH_HEADER.exec(text)
  while (match) {
    // A unified-diff `+++ b/` line may carry a trailing tab-separated timestamp.
    const raw = match[1].split('\t')[0].trim()
    if (raw.length > 0 && raw !== '/dev/null') paths.push(raw)
    match = PATCH_HEADER.exec(text)
  }
  return paths
}

/**
 * What a tool call actually names: the files a mutation targets, the command text
 * a shell call runs. Read from the **untruncated** arguments the hook receives.
 *
 * This exists because the dedupe key cannot be reused as execution semantics: it
 * is sorted by field name and cut at 400 characters, so a whole-file write whose
 * `content` sorts before `path` loses the path entirely — the tracking table then
 * stays empty while the write did happen. Callers pass the result into
 * `noteTool` so the reuse evidence covers the real artifact.
 *
 * @param {unknown} args
 * @param {string} [name] - tool name; only patch-shaped tools are scanned for diff headers
 * @returns {{paths: string[], command: string}}
 */
export function toolTargets(args, name) {
  const paths = []
  const commands = []
  if (typeof args === 'string') {
    commands.push(args)
  } else if (args && typeof args === 'object') {
    for (const field of PATH_FIELDS) {
      const value = args[field]
      if (typeof value === 'string') paths.push(value)
      else if (Array.isArray(value)) paths.push(...value.filter(part => typeof part === 'string'))
    }
    for (const field of COMMAND_FIELDS) {
      const value = args[field]
      if (typeof value === 'string') commands.push(value)
      else if (Array.isArray(value)) commands.push(...value.filter(part => typeof part === 'string'))
    }
    if (PATCH_CALLS.has(typeof name === 'string' ? name : '')) {
      for (const field of PATCH_TEXT_FIELDS) {
        const value = args[field]
        if (typeof value === 'string') paths.push(...patchTargets(value))
      }
    }
  }
  return {
    paths: paths.filter(path => path.length > 0 && path.length <= 4096),
    command: commands.join('\n').slice(0, 4000),
  }
}

/** @param {string} key @returns {unknown} */
function parseArgs(key) {
  try {
    return JSON.parse(key)
  } catch {
    return undefined
  }
}

/** @param {unknown} value @returns {string} */
function commandText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter(part => typeof part === 'string').join(' ')
  return ''
}

/**
 * The command text of a shell call.
 *
 * `argsKey` is normally the canonical JSON of the call arguments. A key that was
 * truncated before the command field, or one that is not JSON at all, degrades
 * to a scan of the escaped text and finally to `''`, which the classifier reads
 * as unknown — the conservative direction.
 *
 * @param {string} argsKey
 * @returns {string}
 */
function commandOf(argsKey) {
  const key = typeof argsKey === 'string' ? argsKey : ''
  if (key.length === 0 || key === '<unserialisable>') return ''
  const parsed = parseArgs(key)
  if (typeof parsed === 'string') return parsed
  if (parsed && typeof parsed === 'object') {
    for (const field of COMMAND_FIELDS) {
      const value = commandText(parsed[field])
      if (value.length > 0) return value
    }
    return ''
  }
  const match = /"(?:command|cmd|script)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(key)
  if (match) {
    const value = parseArgs(match[1])
    if (typeof value === 'string' && value.length > 0) return value
  }
  // Not JSON: callers without a canonical key still pass the command itself.
  return key.startsWith('{') || key.startsWith('[') ? '' : key
}

/**
 * Split a command line into the segments that run on their own, so `cat a && rm
 * b` cannot pass as a read.
 *
 * @param {string} command
 * @returns {string[]}
 */
function commandSegments(command) {
  return command
    .split(/\r?\n|&&|\|\||;|\|/)
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
}

/** @param {string} segment @returns {'readonly'|'verify'|'unknown'} */
function segmentKind(segment) {
  // A redirection can create or truncate a file, so the segment is not a pure
  // read or a pure check.
  if (/[<>]/.test(segment)) return 'unknown'
  if (VERIFY_COMMAND.test(segment)) return 'verify'
  if (MUTATOR.test(segment)) return 'unknown'
  if (READONLY_COMMAND.test(segment)) return 'readonly'
  return 'unknown'
}

/**
 * Classify a successful shell call by what its command can do to the files:
 * `readonly` (no effect), `verify` (a check, which may build but does not edit
 * the artifacts it covers), or `unknown`, which is treated exactly like a write.
 *
 * @param {string} argsKey
 * @returns {'readonly'|'verify'|'unknown'}
 */
function classifyShell(argsKey) {
  const command = commandOf(argsKey)
  if (command.length === 0) return 'unknown'
  const kinds = commandSegments(command).map(segmentKind)
  if (kinds.length === 0) return 'unknown'
  if (kinds.some(kind => kind === 'unknown')) return 'unknown'
  return kinds.includes('verify') ? 'verify' : 'readonly'
}

/**
 * Files a write call names.
 *
 * Best effort: the canonical key bounds its length, so a large whole-file write
 * can lose its path before the cut. Such a write still bumps the epoch; the
 * fingerprints only add the ability to notice a later change that arrived
 * outside the tool call stream.
 *
 * @param {string} argsKey
 * @returns {string[]}
 */
function writePathsOf(obs) {
  const direct = obs && Array.isArray(obs.paths) ? obs.paths : []
  const named = direct.filter(path => typeof path === 'string' && path.length > 0 && path.length <= 4096)
  if (named.length > 0) return named
  return pathsFromKey(typeof obs?.argsKey === 'string' ? obs.argsKey : '')
}

/**
 * Fallback target extraction from the bounded dedupe key. Only for hosts that do
 * not pass the real arguments: the key is cut at 400 characters and sorted by
 * field name, so a large whole-file write can lose its path. Treat a key-derived
 * target as a hint, never as proof that the rest of the call touched nothing —
 * the caller marks such a write uncertain when a target cannot be fingerprinted.
 *
 * @param {string} key
 * @returns {string[]}
 */
function pathsFromKey(key) {
  const argsKey = typeof key === 'string' ? key : ''
  if (argsKey.length === 0) return []
  const paths = []
  const parsed = parseArgs(argsKey)
  if (typeof parsed === 'string') paths.push(parsed)
  else if (parsed && typeof parsed === 'object') {
    for (const field of PATH_FIELDS) {
      const value = parsed[field]
      if (typeof value === 'string') paths.push(value)
      else if (Array.isArray(value)) paths.push(...value.filter(part => typeof part === 'string'))
    }
  } else {
    const field = /"(?:path|file_path|filePath|target|file|filename)"\s*:\s*("(?:[^"\\]|\\.)*")/g
    let match = field.exec(argsKey)
    while (match) {
      const value = parseArgs(match[1])
      if (typeof value === 'string') paths.push(value)
      match = field.exec(argsKey)
    }
    if (paths.length === 0 && !argsKey.startsWith('{') && !argsKey.startsWith('[')) paths.push(argsKey)
  }
  return paths.filter(path => path.length > 0 && path.length <= 4096)
}

/**
 * Resolve a tool-named path the way the tool itself would. A relative path needs
 * the session's project directory: the host process runs somewhere else, so
 * `statSync('./src/a.js')` against the wrong base silently tracked the wrong
 * file (or nothing at all).
 *
 * @param {string} cwd
 * @param {string} path
 * @returns {string|undefined}
 */
function absolutePath(cwd, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (isAbsolute(path)) return path
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  return resolvePath(cwd, path)
}

/**
 * A stat fingerprint, or `undefined` when the path is not visible from this
 * process. Only visible targets are tracked; the epoch remains the evidence for
 * everything else.
 *
 * @param {string} path
 * @returns {{mtimeMs: number, size: number} | undefined}
 */
function fingerprintOf(path) {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return undefined
  }
}

/** @param {Map<string, {mtimeMs: number, size: number}>} writes @param {string} path */
function trackPath(writes, path) {
  const print = fingerprintOf(path)
  if (!print) return false
  writes.delete(path)
  writes.set(path, print)
  while (writes.size > WRITE_WINDOW) {
    const oldest = writes.keys().next().value
    if (oldest === undefined) break
    writes.delete(oldest)
  }
  return true
}

/**
 * Fingerprint the files a mutation named, resolved against the session directory.
 *
 * @param {object} entry
 * @param {{paths?: string[], cwd?: string, argsKey?: string}} obs
 */
function recordWritePaths(entry, obs) {
  const cwd = obs && typeof obs.cwd === 'string' ? obs.cwd : ''
  const paths = writePathsOf(obs)
  let tracked = 0
  for (const path of paths) {
    const absolute = absolutePath(cwd, path)
    if (absolute === undefined) continue
    if (trackPath(entry.writes, absolute)) tracked += 1
  }
  // A mutation whose target could not be fingerprinted leaves the artifact set
  // unknown. No stored pass can then be defended by a stat re-read, so the
  // session stops offering reuse instead of guessing.
  if (tracked === 0) entry.writesUncertain = true
}

/**
 * Snapshot the versions of every tracked artifact at this instant. This is the
 * evidence a passing check covers: the files on disk when the pass ran, not the
 * state at the last write (which the pass may have been re-run against) and not a
 * session-wide table a different check could refresh.
 *
 * @param {object} entry
 * @returns {Map<string, {mtimeMs: number, size: number}>}
 */
function evidenceSnapshot(entry) {
  const evidence = new Map()
  for (const path of entry.writes.keys()) {
    const print = fingerprintOf(path)
    if (print) evidence.set(path, print)
  }
  return evidence
}

/**
 * True when a file covered by the stored pass no longer matches the fingerprint
 * captured with that pass. A stat that fails counts as changed: a pass is never
 * offered on evidence that could not be re-read.
 *
 * @param {Map<string, {mtimeMs: number, size: number}>} evidence
 * @returns {boolean}
 */
function evidenceStale(evidence) {
  if (!(evidence instanceof Map)) return true
  for (const [path, print] of evidence) {
    const now = fingerprintOf(path)
    if (!now || now.mtimeMs !== print.mtimeMs || now.size !== print.size) return true
  }
  return false
}

/**
 * Drop a stored pass that a failing run just contradicted.
 *
 * @param {object} entry
 * @param {string} signature
 */
function withdrawCheck(entry, signature) {
  entry.checks.delete(signature)
  if (entry.reuseHint === signature) entry.reuseHint = ''
}

/**
 * Store a passing verification as a reusable result, together with the artifact
 * versions **that pass actually covered**, and raise the hint when the same check
 * repeats while that evidence still holds.
 *
 * The evidence is per check, never refreshed by a different check: a later pass
 * of command B used to re-baseline the session-wide fingerprints, which made an
 * older pass of command A look current although A had run against older files.
 * Each stored pass now snapshots `entry.writes` at the moment it is seen, and is
 * only offered while those exact versions are still on disk and no write or
 * unrecognised command has bumped the epoch since.
 *
 * Only a recognised verification run is stored. A repeated read or grep is not a
 * check: offering to "reuse" its output would be a claim about an artifact that
 * nothing verified.
 *
 * @param {object} entry
 * @param {string} signature
 * @param {string} digest
 * @param {'readonly'|'verify'|'unknown'|undefined} shellKind
 */
function noteCheck(entry, signature, digest, shellKind) {
  if (shellKind !== 'verify' || signature.length === 0) return
  const stored = entry.checks.get(signature)
  if (stored && stored.epoch === entry.epoch && stored.digest === digest
      && entry.reuseHint === '' && !entry.writesUncertain && !evidenceStale(stored.evidence)) {
    entry.reuseHint = signature
    return
  }
  entry.checks.set(signature, { epoch: entry.epoch, digest, evidence: evidenceSnapshot(entry) })
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
 * Reading the schedule is not the same as delivering it: the width and the
 * stall budget are read from several hooks per step, while the directive can be
 * spent exactly once. Callers that only want the read-only numbers pass
 * `{ emit: false }` so a peek never consumes a reminder that was never shown.
 *
 * @param {ReturnType<typeof createAutoState>} state
 * @param {string} agent
 * @param {{emit?: boolean}} [options]
 * @returns {{parallel: number, stallBudgetMs: number, directive: {kind: string, text: string, summary: string}|undefined, stats: object}}
 */
export function autoSchedule(state, agent, options = {}) {
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
    // Arm state, readable from the debug line: a benchmark arm that cannot be
    // told apart from the default is otherwise indistinguishable from a bug.
    preferPatch: entry.preferPatch,
    patchHint: entry.patchHint,
    patchHintSent: entry.patchHintSent,
  }

  const directive = options.emit === false ? undefined : directiveFor(entry, stats)
  return { parallel, stallBudgetMs, directive, stats }
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
  // The scheduler's directive half is a separate channel from its width and its
  // watchdog budget: switching it off keeps every time saving the scheduler
  // makes and removes only the copy, which is exactly the arm a clean ablation
  // needs to tell "fewer round trips" apart from "fewer words per step".
  if (!entry.scheduler) return undefined
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
  if (entry.preferPatch && entry.patchHint && !entry.patchHintSent) {
    // The hint fires on the *next* step, not on the write step itself: at that
    // point the model has already seen whether the rewrite worked, so the ask is
    // about form, not about redoing the work. Nothing here limits what gets
    // written or when the turn may end. It sits above the cooldown because it is
    // armed by an observed write and fires at most once per turn, so swallowing
    // it would only make the arm look identical to the default.
    entry.patchHintSent = true
    entry.patchHint = false
    entry.lastDirectiveStep = entry.steps
    entry.lastDirectiveKind = 'prefer-patch'
    return {
      kind: 'prefer-patch',
      text: 'Auto schedule: that step sent a whole file. When you change a file that already exists, '
        + 'send only the lines that change (an edit hunk) instead of the whole file: the file ends up '
        + 'byte-identical, and the unchanged lines cost no output tokens.',
      summary: 'auto: send hunks for the next edit',
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
  // An early reminder is a bet on the turn being long. When the caller asks for
  // the bet to be conditional, spend the turn's observed call density as the
  // prediction and fall back to the built-in step when the turn still looks
  // like a single-file task.
  const earlyAt = entry.disciplineAfterSteps || AUTO_LIMITS.disciplineAfterSteps
  // Calls the turn made before the current step: at the moment this line runs the
  // step's own calls have not happened yet, so counting them would let a step pay
  // for its own admission.
  const callsBefore = entry.turnCalls - entry.stepCalls
  // The bet is decided once, from the first step's density, and then frozen for
  // the turn. Re-reading the cumulative count at every step made the reminder
  // drift: a two-call first step qualified for the early slot at step 2, then the
  // same turn looked dense at step 3 and pushed the reminder to step 4 instead.
  if (entry.disciplineEarlyCalls > 0
      && earlyAt < AUTO_LIMITS.disciplineAfterSteps
      && entry.disciplineAtLocked === 0
      && stats.turnSteps >= 2) {
    entry.disciplineAtLocked = callsBefore < entry.disciplineEarlyCalls
      ? AUTO_LIMITS.disciplineAfterSteps
      : earlyAt
  }
  const disciplineAt = entry.disciplineAtLocked > 0 ? entry.disciplineAtLocked : earlyAt
  if (entry.lateDiscipline && !entry.disciplineSent && stats.turnSteps >= disciplineAt) {
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
        + 'what a tool returned. Keep the answer complete; cut the commentary.'
        + (entry.rereadHint
          ? ' For a file this turn already wrote, work from the last edit and the check output; do not read '
            + 'the whole file again just to confirm.'
          : ''),
      summary: 'auto: compress output for the rest of the turn',
    }
  }
  const repeatAt = entry.disciplineRepeatAtSteps
  if (entry.lateDiscipline && entry.disciplineSent && !entry.disciplineRepeatSent && repeatAt > 0
      && stats.turnSteps >= repeatAt) {
    // Same ask, shorter: by this step the turn has already been told once, so the
    // reminder only has to re-arm the rule, not teach it.
    entry.disciplineRepeatSent = true
    entry.lastDirectiveStep = entry.steps
    entry.lastDirectiveKind = 'compress-output'
    return {
      kind: 'compress-output',
      text: 'Auto schedule: still long. Keep the remaining steps to the command, the file, the conclusion.',
      summary: 'auto: compress output again for the rest of the turn',
    }
  }
  const outBudget = entry.outBudget
  const budgetArmed = stats.turnSteps >= (entry.outBudgetAfterSteps || 0)
  if (outBudget > 0 && budgetArmed && !entry.outBudgetSent && stats.turnOutTokens >= outBudget) {
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
    // already passed and neither a write nor an unrecognised shell command ran
    // since. Both of those bump the epoch, so reaching this branch already means
    // the tool call stream saw nothing that could have changed the result. The
    // artifacts that particular pass covered are re-read here because the stream
    // cannot see a change that arrived some other way; a pass whose own evidence
    // no longer matches is withdrawn, and so is every pass once a write left the
    // artifact set unknown.
    const stored = entry.checks.get(entry.reuseHint)
    const backedByEvidence = stored !== undefined && stored.epoch === entry.epoch
      && !entry.writesUncertain && !evidenceStale(stored.evidence)
    if (!backedByEvidence) {
      entry.checks.delete(entry.reuseHint)
      entry.reuseHint = ''
    } else {
      entry.reuseHint = ''
      entry.reuseSentEpoch = entry.epoch
      entry.lastDirectiveStep = entry.steps
      entry.lastDirectiveKind = 'reuse-check'
      return {
        kind: 'reuse-check',
        text: 'Auto schedule: that exact check already passed verbatim this turn, and no write or '
          + 'unrecognised shell command has run since. Use the result you already have and spend this step on '
          + 'the remaining work; run the check again only after the files it covers change.',
        summary: 'auto: reuse a passing check',
      }
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
