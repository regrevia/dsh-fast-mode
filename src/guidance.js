/**
 * The model-facing half of a speed gear.
 *
 * The effort policy decides how much the model *thinks*; it cannot decide how
 * many tool calls one step carries. That is a property of the model's output,
 * and the harness already schedules same-message calls concurrently (up to
 * `agentLoop.maxParallelToolCalls`, and only for calls declared safe). So the
 * only honest way for a plugin to raise real concurrency is to ask the model
 * for wider steps — and to hold that guidance back entirely at the safe gear,
 * where the plugin is supposed to be invisible.
 *
 * The text is deliberately short: it is prepended to every request of every
 * agent, so it costs input tokens on every call. It also states the trade in
 * the open, because a model told "batch" without a reason will drop it the
 * first time a narrow step looks cheaper.
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
})

/** Fan-out used in the wording when `parallel` is not a usable number. */
const GEAR_FANOUT = Object.freeze({ fast: 4, turbo: 6, max: 8 })

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
  const parallel = Number.isFinite(config.parallel) && config.parallel > 1 ? Math.floor(config.parallel) : GEAR_FANOUT[config.gear]
  const fanout = template.replace('{n}', String(parallel))
    + ' The harness runs the independent calls of one message concurrently; treat that number as a target, not a quota.'
  return [BATCH_RULES, fanout].join('\n\n')
}
