/**
 * Deliberation controls: the three opt-in mechanisms that replaced the retired
 * effort step-down in 1.7.0.
 *
 * Why the old half went away: rewriting `reasoningEffort` for one request turned
 * out to be unmeasurable on the route this plugin runs on (the provider reports
 * `reasoning` usage as 0 on every row, so there is no evidence the parameter is
 * honoured) and it was the one mechanism that changed answers rather than only
 * latency. See BENCHMARK.md, LZ1: text-only 0.389x vs text+step-down 0.430x.
 *
 * What is left is three switches, all visible in the transcript instead:
 *   1. `probeFirst`   — one line at turn entry: look up the fact you are unsure
 *                       of instead of reasoning about it.
 *   2. `actBeforePlan`— one line at turn entry: at most one line of plan before
 *                       the first call, and act when the next action is clear.
 *   3. `repeatNudge`  — an evidence nudge mid-turn: the same call already ran, or
 *                       the last few results carried nothing new. This targets
 *                       the definition of over-thinking ("no new information, and
 *                       still thinking") instead of its proxy ("long reasoning").
 *
 * `actBeforePlan` also carries a length nudge. Repetition turned out to be blind
 * on tasks that read one new file per step, so the second signal is the one the
 * transcript already records: how many characters of reasoning this turn has
 * written. It is counted from `assistant/message` events and never written back,
 * so like everything else here it can only add text to the prompt.
 *
 * All three are prompt-side only. No config field is written, no request field
 * changes, so nothing here can make the request differ from what the composer
 * shows.
 */

/** Never-cut guard: the point of thinking less is not to skip the expensive checks. */
export const GUARD =
  'None of this cuts validation at trust boundaries, data-loss handling, security, or accessibility.'

export const PROBE_TEXT =
  'When you are unsure of a fact about the codebase — a file\'s contents, a signature, a test\'s expectation — read it once instead of reasoning about it. One call, the cheapest that answers the question: `grep` before `read`, a range before the whole file. Guessing costs a step and is usually wrong; looking costs the same step and settles it. Read again when a result surprises you, before theorising about why it surprised you.'

export const ACT_TEXT =
  'Do not restate the task and do not re-explain the plan: the reader already has it. Before your first tool call, one line of plan is enough; when the next action is already clear, take it now and explain afterwards only if the result is not self-evident.'

export const PROBE_SUMMARY = 'probe-first: read the fact, do not reason about it'
export const ACT_SUMMARY = 'act-first: one line of plan, then work'
export const REPEAT_SUMMARY = 'repeat nudge: same call again, or no new information'
export const LONG_REASONING_SUMMARY = 'over-thinking: think with what you have'

/** Cumulative reasoning characters in one turn that earn the first length nudge. */
export const REASONING_CHARS = 4000
/** At most this many length nudges per turn. */
export const MAX_REASONING_NUDGES = 2

/** At most this many evidence nudges per turn. */
export const MAX_REPEAT_NUDGES = 2
/** The same call (name + arguments) seen this many times in one turn is a loop. */
export const REPEAT_CALLS = 2
/** Consecutive unchanged results beyond the first: three identical results in a row. */
export const STALE_RESULTS = 2
/**
 * Shortest result that can count as "substantial" for the stale test. Below
 * this, two calls returning the same bytes are not evidence of a loop: the
 * generic confirmations (`the file has been updated`, `ok`, the one-line git
 * status of a clean tree) are identical across unrelated calls by design, and
 * counting them made a three-edit batch — three edits, three identical
 * confirmations — read as a loop. Measured on 78 suite transcripts (QC1/COV1/
 * ABL1): all 45 stale triggers were different calls returning a 171-char edit
 * confirmation, i.e. legitimate work; none was a real loop.
 */
export const STALE_MIN_CHARS = 400
/** Bounded history per conversation; the watch is a WeakMap-free Map trimmed by age. */
const HISTORY_MAX = 8
const RUN_MAX = 64

/**
 * The turn-entry notice. Both text switches share one message and one guard line
 * so that turning both on does not cost two notices.
 * @param {{probe?: boolean, act?: boolean}} switches
 * @returns {string|undefined}
 */
export function deliberationNotice(switches) {
  const parts = []
  if (switches?.probe === true) parts.push(PROBE_TEXT)
  if (switches?.act === true) parts.push(ACT_TEXT)
  if (parts.length === 0) return undefined
  return `${parts.join('\n\n')}\n\n${GUARD}`
}

/** @returns {{runs: Map<string, object>}} */
export function createProgressWatch() {
  return { runs: new Map() }
}

function runOf(watch, sid) {
  let run = watch.runs.get(sid)
  if (!run) {
    run = { key: '', calls: [], stale: 0, nudges: 0, nudgedFor: '', reasonChars: 0, reasonNudges: 0 }
    watch.runs.set(sid, run)
    if (watch.runs.size > RUN_MAX) {
      const oldest = watch.runs.keys().next().value
      if (oldest !== undefined && oldest !== sid) watch.runs.delete(oldest)
    }
  }
  return run
}

/**
 * Start (or continue) a conversation's turn. A new user message resets the
 * evidence: the previous turn's loop is not this turn's.
 * @param {{runs: Map<string, object>}} watch
 * @param {string} sid
 * @param {string} key turn identity
 */
export function beginTurn(watch, sid, key) {
  const run = runOf(watch, sid)
  if (run.key !== key) {
    run.key = key
    run.calls = []
    run.stale = 0
    run.nudges = 0
    run.nudgedFor = ''
    run.reasonChars = 0
    run.reasonNudges = 0
  }
  return run
}

/**
 * Record one finished tool call. `signature` must be stable across repeats of the
 * same call (tool name + arguments), `digest` the hash of the result content.
 * Error results are counted as "something happened", never as a loop signal: an
 * error is information, and it is the one case where more thought is warranted.
 * @param {{runs: Map<string, object>}} watch
 * @param {string} sid
 * @param {{signature?: string, digest?: string, isError?: boolean, chars?: number}} call
 */
export function noteCall(watch, sid, call) {
  const run = runOf(watch, sid)
  const signature = typeof call?.signature === 'string' ? call.signature : ''
  const digest = typeof call?.digest === 'string' ? call.digest : ''
  const chars = Number.isFinite(call?.chars) && call.chars > 0 ? call.chars : 0
  const last = run.calls[run.calls.length - 1]
  // Same bytes only mean "nothing new" when the content is long enough to be a
  // payload rather than a canned confirmation. A same-call repeat never reaches
  // this test: planRepeatNudge reports it first, with a count. See
  // STALE_MIN_CHARS.
  const same =
    last !== undefined && digest !== '' && digest === last.digest && chars >= STALE_MIN_CHARS
  if (call?.isError !== true && same) {
    run.stale += 1
  } else {
    run.stale = 0
  }
  // An error is information: it resets the "nothing new" run, and it never counts
  // as a repeated call, because the next step after a failure is exactly where
  // more thought is warranted rather than less.
  const isError = call?.isError === true
  run.calls.push({ signature: isError ? '' : signature, digest, chars, isError })
  if (run.calls.length > HISTORY_MAX) run.calls.shift()
}

/**
 * The evidence nudge for the next step, or undefined when the turn shows no loop.
 * Every nudge names the count it saw, because "you are looping" without a number
 * reads as an opinion and this one has to read as a finding.
 * @param {{runs: Map<string, object>}} watch
 * @param {string} sid
 * @param {number} step
 * @returns {string|undefined}
 */
export function planRepeatNudge(watch, sid, step) {
  const run = runOf(watch, sid)
  if (run.nudges >= MAX_REPEAT_NUDGES) return undefined

  let condition = ''
  let text = ''

  const last = run.calls[run.calls.length - 1]
  if (last !== undefined && last.signature !== '') {
    const same = run.calls.filter((call) => call.signature === last.signature).length
    if (same >= REPEAT_CALLS) {
      // The digest is part of the condition: the same call returning new content
      // is new evidence, and earns its own sentence once.
      condition = `repeat:${last.signature}:${last.digest}`
      text = `The call you are about to reason about has already run ${same} times in this turn and returned what you have. If the answer did not change, a different call is what changes it — not more thinking about this one.`
    }
  }

  if (text === '' && run.stale >= STALE_RESULTS) {
    condition = `stale:${last?.digest ?? ''}`
    text = `The last ${run.stale + 1} calls returned the same content. Nothing new is arriving from that direction: decide with what you have, or ask a different question.`
  }

  if (text === '' || condition === run.nudgedFor) return undefined
  run.nudges += 1
  run.nudgedFor = condition
  run.debugWhy = `${condition} step=${step}`
  return text
}

/**
 * Add one assistant message's reasoning size to this turn's running total.
 *
 * Per turn, not per session: the length of *this* attempt is what the next step
 * needs to know, and the next user message starts the measurement over.
 *
 * @param {{runs: Map<string, object>}} watch
 * @param {string} sid
 * @param {number} chars
 */
export function noteReasoning(watch, sid, chars) {
  if (!Number.isFinite(chars) || chars <= 0) return
  const run = runOf(watch, sid)
  run.reasonChars += chars
}

/**
 * The length nudge for the next step, or undefined when this turn has not yet
 * thought longer than a decision needs. Fires at most `MAX_REASONING_NUDGES`
 * times per turn and names the size it saw, so the message reads as a finding
 * rather than an opinion.
 *
 * @param {{runs: Map<string, object>}} watch
 * @param {string} sid
 * @param {number} step
 * @returns {string|undefined}
 */
export function planReasoningNudge(watch, sid, step) {
  const run = runOf(watch, sid)
  if (run.reasonNudges >= MAX_REASONING_NUDGES) return undefined
  const threshold = REASONING_CHARS * (run.reasonNudges + 1)
  if (run.reasonChars < threshold) return undefined
  run.reasonNudges += 1
  run.debugWhy = `reasoning:${run.reasonChars} step=${step}`
  const seen = Math.round(run.reasonChars / 100) * 100
  return `You have written about ${seen} characters of reasoning in this turn. Past that length, more thinking about facts you already have rarely changes the next action: take the action the evidence supports, or read the one fact that is still missing.`
}
