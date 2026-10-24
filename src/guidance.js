/**
 * The model-facing half of fast mode.
 *
 * A step costs three things, and the plugin can only move two of them:
 *
 * - **Round trips.** Every step pays a fixed ~700 ms overhead before the first
 *   token, so merging independent work into one step is pure profit. The harness
 *   already schedules same-message calls concurrently (up to
 *   `agentLoop.maxParallelToolCalls`, and only for calls declared safe), so the
 *   only honest way for a plugin to raise real concurrency is to ask the model
 *   for wider steps.
 * - **Visible output.** Measured on this gateway, a step costs
 *   `720 ms + 6.6 ms per output token` (R² = 0.93): prose is the dominant term,
 *   and trimming narration is a bigger win than any effort change.
 * - **Thinking depth.** Not ours, on purpose. Fast mode runs at exactly the
 *   effort the user chose — that is the whole contract — so there is no prompt
 *   text here that asks the model to think less, plan less, or skip a check.
 *   "Faster at the same depth" is bought with parallelism, not with shallowness.
 * - **Decode speed.** Not ours either. No prompt can make the provider emit
 *   tokens faster.
 *
 * The texts are deliberately short: they are prepended to every request of every
 * agent, so they cost input tokens on every call. They also state the trade in
 * the open, because a model told "batch" without a reason will drop it the first
 * time a narrow step looks cheaper.
 *
 * Measured effect (identical task, six fresh agents): the output rules cut
 * visible output from ~640 to ~190 tokens per step and the wall clock of the
 * task by roughly a third, even though the terse runs needed more steps.
 */

/** Rules that hold at every width: they are what keeps batching safe. */
const BATCH_RULES = `Several independent tool calls may share one assistant message: the harness starts them together and returns the results in your order. Batching independent work is how a step gets faster; one call per step is how a task becomes slow.

Batching rules:
- Batch only calls that are independent: no call's arguments may depend on another call's result, and two calls must never write the same file or shared state.
- Keep a read-then-write pair sequential: the reads go in one block, the write in the next.
- Do not pad a batch with redundant calls, and never report a result you have not received.
- If a batch fails or contradicts an earlier assumption, shrink the next step until you are oriented again.
- More input tokens per step is the intended trade for fewer round trips; do not re-narrow steps to save tokens.`

/**
 * The third lever: keep a step from turning into minutes of waiting.
 *
 * Round trips and visible tokens explain a healthy step; they do not explain a
 * step that sat in one tool call for four minutes. That loss is almost always
 * self-inflicted, and it is the one kind the model can avoid without being
 * faster at anything: background the process, bound the command, write the
 * script to a file instead of pasting a heredoc that arrives malformed.
 */
const STALL_RULES = `Bounded calls:
- Never start a server, watcher, tail, or REPL in the foreground: use \`run_in_background: true\` (or \`nohup … &\`) and read it in a later step.
- Prefer a narrow probe (one path, one pattern, head/tail, \`--max-count\`) to a full sweep, and give anything that could block an explicit timeout.
- Write long, quoted, or multi-line commands to a file and run that file instead of pasting a heredoc: malformed arguments cost the whole round trip.
- After a cancelled or malformed call, change the command before retrying; the same call fails the same way.`

/**
 * The fan-out sentence. Only the number changes with the schedule, so the target
 * the model is told and the target the scheduler computed can never drift apart.
 */
const FANOUT = 'Aim for up to {n} independent calls per message: the target is chosen from how your recent steps went — it widens after clean multi-call steps and narrows after errors. Plan the whole read set of a step before issuing it, then act on every result before requesting more. Read/search calls in one message run concurrently; shell calls do not — `bash` runs one at a time, so a block of shell calls costs the sum of their runtimes. Use `shell_parallel` for independent slow shell jobs.'

/**
 * The single largest remaining loss: a model that discovers targets one at a
 * time pays a round trip per discovery. When the request itself names the whole
 * target set, the gather belongs in one block; splitting a known read set is the
 * bug, not a safety measure.
 */
const GATHER = `Gather in one block: before your first call, list every independent target this request already names. Put all of them in the first block — do not split a known read set across steps, and do not read one item only to decide what to read next unless the request is genuinely sequential. Extra input tokens per step are the intended trade; an extra round trip is the cost you are removing. Independent shell jobs belong in ONE \`shell_parallel\` call, not several \`bash\` calls: shell calls run one after another, so their runtimes add up. A dependent chain stays in \`bash\`; no two jobs may write the same file.
- When the target set is large (roughly more than ten items) or the answer is an aggregate (a count, a total, a set intersection), reach for one bounded command or search — \`rg -c\`, \`grep -r\`, \`wc -l\`, or a short script that only prints — instead of reading every file. A wide read set is itself a slow step, and the aggregate usually fits in one command.`;

/** Prefetch only becomes true once a step is wide enough to hold the extra call. */
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

/** The full variant: used when the discipline is on, adding the bare-call rule. */
const OUTPUT_FULL = `${OUTPUT_LIGHT}
- When a step needs no prose at all, send the tool calls and nothing else; a bare call is cheaper than a narrated one.`

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
  const parallel = Number.isFinite(config.parallel) ? Math.floor(config.parallel) : 0
  // `parallel: 1` is the documented way to keep the switch on without asking
  // for fan-out, so it silences the whole section rather than asking for one
  // call per message.
  if (!(parallel > 1)) return undefined
  const parts = [BATCH_RULES]
  let fanout = FANOUT.replace('{n}', String(parallel))
  if (parallel >= 4) fanout += ` ${PREFETCH} ${GATHER}`
  parts.push(fanout)
  if (config.stallGuard !== false) parts.push(STALL_RULES)
  const discipline = config.discipline ?? 'light'
  if (discipline === 'full') parts.push(OUTPUT_FULL)
  else if (discipline === 'light') parts.push(OUTPUT_LIGHT)
  return parts.join('\n\n')
}
