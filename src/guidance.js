/**
 * The model-facing half of a speed gear.
 *
 * A step costs two things the plugin can actually move, and a third it cannot:
 *
 * - **Round trips.** Every step pays a fixed ~700 ms overhead before the first
 *   token, so merging independent work into one step is pure profit. The
 *   harness already schedules same-message calls concurrently (up to
 *   `agentLoop.maxParallelToolCalls`, and only for calls declared safe), so the
 *   only honest way for a plugin to raise real concurrency is to ask the model
 *   for wider steps.
 * - **Visible output.** Measured on this gateway, a step costs
 *   `720 ms + 6.6 ms per output token` (R² = 0.93): prose is the dominant
 *   term, and trimming narration is a bigger win than any effort change.
 * - **Decode speed.** Not ours. No prompt can make the provider emit tokens
 *   faster.
 *
 * Both texts are deliberately short: they are prepended to every request of
 * every agent, so they cost input tokens on every call. They also state the
 * trade in the open, because a model told "batch" without a reason will drop it
 * the first time a narrow step looks cheaper.
 *
 * Measured effect (identical task, six fresh agents): the output rules cut
 * visible output from ~640 to ~190 tokens per step and the wall clock of the
 * task by roughly a third, even though the terse runs needed more steps.
 */

/** Rules that hold at every gear: they are what keeps batching safe. */
const BATCH_RULES = `Several independent tool calls may share one assistant message: the harness starts them together and returns the results in your order. Batching independent work is how a step gets faster; one call per step is how a task becomes slow.

Batching rules:
- Batch only calls that are independent: no call's arguments may depend on another call's result, and two calls must never write the same file or shared state.
- Keep a read-then-write pair sequential: the reads go in one block, the write in the next.
- Do not pad a batch with redundant calls, and never report a result you have not received.
- If a batch fails or contradicts an earlier assumption, shrink the next step until you are oriented again.
- More input tokens per step is the intended trade for fewer round trips; do not re-narrow steps to save tokens.`

/**
 * Per-gear fan-out wording. The number is substituted from the resolved
 * `parallel`, so the text never promises a different count than the config.
 */
const FANOUT = Object.freeze({
  fast: 'Aim for up to {n} independent calls per message. For exploratory work (reading several files, greps, status checks) prefer one wide step over a chain of narrow ones.',
  turbo: 'Aim for up to {n} independent calls per message. Plan the whole read set of a step before issuing it, then act on every result before requesting more.',
  max: 'Aim for up to {n} independent calls per message. Enumerate every file, search and status check a step needs, issue them together, and combine the results in one pass.',
  ludicrous: 'Aim for up to {n} independent calls per message. Enumerate every file, search and status check a step needs, issue them together, and combine the results in one pass. Deliberation is off at this gear: act on the evidence you already have instead of planning further, and only stop to think again when a result contradicts the plan.',
})

/**
 * The speculative-read sentence. It only becomes true once a step is wide
 * enough for the extra call to fit, so it ships at turbo and above.
 */
const PREFETCH = 'If the evidence already implies which file, search or status check the next step will need, fetch it in this same block: a wasted read costs a few hundred input tokens, an extra round trip costs a whole step.'

/**
 * The output discipline. Visible prose is billed and decoded like thinking, and
 * on a route that emits no reasoning tokens it is the single largest cost of a
 * step — so the model is told, once per request, to stop narrating.
 */
const OUTPUT_LIGHT = `Your visible text is charged at the same rate as your thinking and it is usually the largest single cost of a step. Write it once, for the conclusion:
- Do not announce a tool call before it, and do not describe it after: the tool result is already the message.
- Do not restate what a file or command just showed; quote only the line the conclusion rests on.
- Do not end a step with a progress report or a summary of work already finished: the next step reads the transcript.
- The last step of a turn is the exception — the answer the user actually asked for still gets written out in full.`

/** The full-intensity variant, used once the gear has already given up depth. */
const OUTPUT_FULL = `${OUTPUT_LIGHT}
- When a step needs no prose at all, send the tool calls and nothing else; a bare call is cheaper than a narrated one.`

/** Fan-out used in the wording when `parallel` is not a usable number. */
const GEAR_FANOUT = Object.freeze({ fast: 4, turbo: 6, max: 8, ludicrous: 8 })

/** Gears that also get the speculative-read sentence. */
const PREFETCH_GEARS = Object.freeze({ fast: false, turbo: true, max: true, ludicrous: true })

/** The prompt section name, unique so a reload replaces rather than duplicates. */
export const GUIDANCE_SECTION = 'fast-mode:execution-speed'

/**
 * Order for the prompt section. It sits just after the plan policy and before
 * the per-tool sections, next to the other cross-cutting execution guidance.
 */
export const GUIDANCE_ORDER = 520

/**
 * Build the guidance text for a resolved config.
 *
 * @param {object} config - output of `resolveConfig`.
 * @returns {string|undefined} `undefined` when the gear asks for no guidance.
 */
export function buildGuidance(config) {
  if (!config || config.directive !== true) return undefined
  const template = FANOUT[config.gear]
  if (typeof template !== 'string') return undefined
  const parallel = Number.isFinite(config.parallel) ? Math.floor(config.parallel) : GEAR_FANOUT[config.gear]
  // `parallel: 1` is the documented way to keep the switch on without asking
  // for fan-out, so it silences the whole section rather than asking for one
  // call per message.
  if (!(parallel > 1)) return undefined
  const parts = [BATCH_RULES]
  let fanout = template.replace('{n}', String(parallel))
    + ' The harness runs the independent calls of one message concurrently; treat that number as a target, not a quota.'
  if (PREFETCH_GEARS[config.gear] === true && parallel > 1) fanout += ' ' + PREFETCH
  parts.push(fanout)
  const discipline = config.discipline ?? 'light'
  if (discipline === 'full') parts.push(OUTPUT_FULL)
  else if (discipline === 'light') parts.push(OUTPUT_LIGHT)
  return parts.join('\n\n')
}
