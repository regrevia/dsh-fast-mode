/**
 * Lazy mode: the one switch in this plugin that is allowed to touch how much the
 * model deliberates.
 *
 * Everything else here buys speed while holding effort still — the promise is
 * "same depth, sooner". This module is the deliberate exception, and it is the
 * only place in the package that rewrites `reasoningEffort`. It exists because
 * a long turn loses time in a way parallelism cannot fix: the model keeps
 * expanding a problem it has already understood. The idea is borrowed from
 * `ponytail` — a lazy senior developer solves the whole problem with the least
 * new code, and is lazy about the solution but never about the reading.
 *
 * Three mechanisms, cheapest first:
 *
 * 1. **The ladder, in the prompt.** One short text asks for the first rung that
 *    works and a one-line "what I skipped". Cost is input tokens once per turn;
 *    it changes nothing about the harness.
 * 2. **The nudge.** When a turn's streamed reasoning passes a threshold without
 *    a new tool result, one notice says so. It is observation, not policy: it
 *    repeats what the transcript already proves.
 * 3. **The effort step-down.** Only when a step visibly over-thought (the
 *    streamed reasoner block is large) does the next request ask for one rung
 *    less. It never goes below `FLOOR` (the user's own floor, `low`), never
 *    fires twice in a row after an error, and is capped per turn.
 *
 * What is never cut, in this module or its text: validation at a trust boundary,
 * error handling that protects data, security, accessibility, and the
 * deliverable itself. `DIRECTIVE` says so explicitly, because a model told
 * "write less" drops the wrong things first.
 *
 * ## Why the step-down keeps its own ledger
 *
 * The 0.9.x release lowered effort from step two of *every* turn. Measured
 * later, that bought no wall clock on this route and did real damage: the
 * rewrite reached the provider as a request header, so the composer showed an
 * effort the user never chose, and it stayed there across restarts. So this
 * module lowers effort only after evidence, restores the resolved value on the
 * next request, and is off unless `lazy: true`.
 */

/** The prompt section. Short on purpose: it is paid on every request of a turn. */
export const DIRECTIVE = `Work like a lazy senior developer: the best step is the one not taken.

- Read before deciding. Trace the real flow of the code the change touches, then decide. Being lazy about the solution never means being lazy about the reading.
- Once a step fully does the job, stop planning it. No option, abstraction, or "for later" code nobody asked for.
- Take the first rung that works: what this repo already has, then the platform or a tool you already hold, then one line, then the minimum that works.
- Never cut these to save code or time: validation where input crosses a trust boundary, error handling that protects data, security, accessibility, and the deliverable the user asked for.
- End the turn with one line: what you skipped, and the risk that carries.`

/**
 * Bench variants of the ladder text, selected by `lazyVariant`. The measured
 * block compares them in one run, so the control stays the released text.
 */
export const DIRECTIVES = Object.freeze({
  v1: DIRECTIVE,
  v2: `Work like a lazy senior developer: the best step is the one not taken.

- Read before deciding. Trace the real flow of the code the change touches, then decide. Being lazy about the solution never means being lazy about the reading.
- Once a step fully does the job, stop planning it. No option, abstraction, or "for later" code nobody asked for.
- Take the first rung that works: what this repo already has, then the platform or a tool you already hold, then one line, then the minimum that works.
- Never cut these to save code or time: validation where input crosses a trust boundary, error handling that protects data, security, accessibility, and the deliverable the user asked for.
- End the turn with one line: what you skipped, and the risk that carries.
- Do not restate the task or re-explain the plan before acting: the reader already has it.
- If the next action is already clear, take it now. Do not spend a step weighing alternatives you are not going to use.`,
  v3: `Work like a lazy senior developer: the best step is the one not taken.

- Read the flow the change touches before you decide; never be lazy about the reading.
- Take the first rung that works: what the repo already has, the platform, a tool you hold, one line, then the minimum.
- Once the step fully does the job, stop planning it: no option, abstraction, or code nobody asked for.
- Never cut these: validation at a trust boundary, error handling that protects data, security, accessibility, and the deliverable.
- Do not restate the task. If the next action is clear, take it. End with one line: what you skipped and the risk.`,
})


const DIRECTIVE_SUMMARY = 'lazy mode: first rung that works, no scope beyond the task'

/** Reasoning rungs a route may name, weakest first. */
export const EFFORT_RUNGS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * The lowest rung this module will ask for. Effort is the user's contract; a
 * watchdog may spend a little of the headroom a high setting leaves, and stops
 * where the default would have been.
 */
const FLOOR = 'low'

/**
 * Streamed reasoning characters in one step that count as over-thinking. On the
 * measured route a normal step streams a few hundred characters and a step stuck
 * on scope streams thousands, so this is deliberately not a tight bound.
 */
const HOT_CHARS = 1600

/** Reasoning characters a turn may spend before the first nudge. */
const NUDGE_CHARS = 4000

/** How many notices one turn may receive. Two: one early, one late. */
const MAX_NUDGES = 2

/** How many effort reductions one turn may use. */
const MAX_REDUCTIONS = 2

/** Steps a reduction is off limits for after an error result (the step it fired on plus two). */
const ERROR_COOLDOWN = 2

/**
 * The next rung down, or `undefined` when the value is not a rung this module
 * understands (a route may use its own vocabulary — never guess at it) or is
 * already at `FLOOR`.
 *
 * @param {string} value
 * @returns {string | undefined}
 */
export function cheaperEffort(value) {
  const at = EFFORT_RUNGS.indexOf(value)
  if (at <= 0) return undefined
  const floor = EFFORT_RUNGS.indexOf(FLOOR)
  if (at <= floor) return undefined
  return EFFORT_RUNGS[at - 1]
}

/** Per-session bookkeeping; one turn at a time is all a session runs. */
const newTurn = () => ({
  step: 0,
  hot: false,
  stepChars: 0,
  turnChars: 0,
  nudges: 0,
  reductions: 0,
  coolUntil: 0,
  nudgedAt: 0,
  reducedStep: -1,
})

/**
 * Create the per-session ledger. Pure and dependency-free so the policy can be
 * tested without a harness.
 */
export function createLazyWatch() {
  return { runs: new Map() }
}

/** @param {{runs: Map<string, any>}} watch @param {string} sid */
const runOf = (watch, sid) => {
  let run = watch.runs.get(sid)
  if (run === undefined) {
    run = newTurn()
    watch.runs.set(sid, run)
    if (watch.runs.size > 64) watch.runs.delete(watch.runs.keys().next().value)
  }
  return run
}

/**
 * Count streamed reasoning characters. Called from the stream tap, i.e. before
 * the step ends, which is what makes the effort decision possible at all: the
 * decision has to be made for the *next* request.
 *
 * @param {{runs: Map<string, any>}} watch @param {string} sid @param {number} chars
 */
export function noteReasoning(watch, sid, chars) {
  if (!Number.isFinite(chars) || chars <= 0) return
  const run = runOf(watch, sid)
  run.stepChars += chars
  run.turnChars += chars
}

/**
 * Open a step: close the previous one's verdict, and say whether this step is
 * the one that carries the ladder text.
 *
 * @param {{runs: Map<string, any>}} watch @param {string} sid
 * @param {{turn?: number, step?: number, firstStep?: boolean}} where
 * @returns {{directive?: string, nudge?: string} | undefined}
 */
export function beginStep(watch, sid, where) {
  const run = runOf(watch, sid)
  const step = Number.isFinite(where?.step) ? Math.floor(where.step) : run.step + 1
  const newTurnStart = where?.firstStep === true || step <= 1
  if (newTurnStart) {
    const fresh = newTurn()
    fresh.step = step
    watch.runs.set(sid, fresh)
    return { directive: DIRECTIVES[where?.variant] || DIRECTIVE }
  }
  // The previous step's streamed volume is the evidence the next request acts on.
  run.hot = run.stepChars >= HOT_CHARS
  run.stepChars = 0
  run.step = step
  const plan = {}
  if (run.nudges < MAX_NUDGES && run.turnChars >= NUDGE_CHARS * (run.nudges + 1) && run.turnChars > run.nudgedAt) {
    run.nudges += 1
    run.nudgedAt = run.turnChars
    run.hot = true
    plan.nudge = `You have streamed about ${run.turnChars} characters of reasoning this turn. Use what you already have: decide, take the next rung, and say in one line what you skipped. Do not open a new line of investigation unless the last result contradicted an assumption.`
  }
  return Object.keys(plan).length === 0 ? undefined : plan
}

/**
 * A tool result came back. An error is the one signal that the model may need
 * *more* thinking, so it cancels any pending step-down for a couple of steps.
 *
 * @param {{runs: Map<string, any>}} watch @param {string} sid @param {{isError?: boolean}} observation
 */
export function noteToolResult(watch, sid, observation) {
  if (observation?.isError !== true) return
  const run = runOf(watch, sid)
  run.hot = false
  run.coolUntil = run.step + ERROR_COOLDOWN + 1
}

/**
 * The effort this request should carry.
 *
 * Returns `base` untouched unless the ledger holds evidence: a hot previous
 * step, no pending cooldown, budget left, and a base that is a rung above
 * `FLOOR`. The caller must treat `effort === base` as "nothing happened".
 *
 * @param {{runs: Map<string, any>}} watch @param {string} sid
 * @param {string | undefined} base - the effort the harness resolved.
 * @returns {{effort: string | undefined, reduced: boolean}}
 */
export function planEffort(watch, sid, base) {
  if (typeof base !== 'string') return { effort: base, reduced: false }
  const run = runOf(watch, sid)
  if (run.reducedStep === run.step) {
    // One step, one reduction: a retry inside the same step must not walk the
    // effort ladder down twice before anything has been measured again.
    return { effort: base, reduced: false }
  }
  if (!run.hot || run.step < run.coolUntil || run.reductions >= MAX_REDUCTIONS) {
    return { effort: base, reduced: false }
  }
  const cheaper = cheaperEffort(base)
  if (cheaper === undefined) return { effort: base, reduced: false }
  run.reductions += 1
  run.reducedStep = run.step
  return { effort: cheaper, reduced: true }
}

/** The notice body for the nudge, built where it is sent (see `index.js`). */
export const NUDGE_SUMMARY = 'lazy mode: decide with what you have'

export { DIRECTIVE_SUMMARY }
