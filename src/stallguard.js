/**
 * The stall guard: the third speed lever.
 *
 * A turn's wall clock is not only steps and prose. It also contains **tool
 * wait**, and a single unbounded call can swallow minutes:
 *
 * - a foreground `bash` that starts a server, tails a log, or waits on a
 *   prompt that will never come;
 * - a heredoc or a 4 KB one-liner that dies as a malformed response after the
 *   whole round trip;
 * - a `run_in_background` request sent through a shell tool that ignores the
 *   flag, so the call blocks until its own timeout.
 *
 * None of that is visible in the latency model (`720 ms + 6.6 ms/token`): it
 * hides in the residual, and it is pure loss, because the model usually
 * re-issues the same call afterwards. The harness sanctions exactly one hook
 * for this — the `tools/execute` waterfall, documented as the place where a
 * wrapper may "change only `exec.signal`", race the body, and hand back a
 * failure instead of waiting forever.
 *
 * So this module is deliberately small and gear-scaled: the higher the gear,
 * the tighter the ceiling on a single call. `safe` never guards anything (its
 * promise is "no intervention"), and an explicit `toolTimeoutMs` overrides the
 * table. What the guard must **not** do:
 *
 * - abort a call the user is legitimately waiting on (`ask_user_question`,
 *   `wait_agent`, `job_output … wait:true`, a task-board run, a subagent), so
 *   those names are exempt;
 * - leave the dispatch object pointing at a controller nobody owns, so the
 *   caller's signal is restored in `finally`;
 * - swallow the body's rejection after the race is lost, so the body's promise
 *   gets a no-op `catch`.
 *
 * @module dsh-fast-mode/stallguard
 */

/**
 * Per-gear ceiling on one guarded tool call, in milliseconds.
 *
 * A table rather than a formula: the numbers are budgets a human can reason
 * about ("five minutes is already a hung build"), and `safe: 0` keeps the
 * documented meaning of that gear — it changes nothing at all.
 */
export const STALL_BUDGET = Object.freeze({
  safe: 0,
  fast: 300_000,
  turbo: 180_000,
  // The starting ceiling for `auto`; the live one comes from the session's own
  // observed call latency (`src/auto.js`), so this is only the pre-evidence
  // value.
  auto: 120_000,
  max: 120_000,
  ludicrous: 90_000,
})

/** Ceiling used when a gear has no entry (an unknown gear must still be bounded). */
export const DEFAULT_STALL_BUDGET = 300_000

/**
 * Tools whose whole purpose is to wait for a human, a job, or another agent.
 * Aborting them would break the feature that asked for the wait, so the name
 * check happens before the budget check.
 */
const EXEMPT = new Set([
  'ask_user_question',
  'wait_agent',
  'job_output',
  'job_list',
  'task_board_run',
  'workflow',
  'subagent',
  'subagent_fork',
  'run_code',
])

/**
 * The tools a stall actually happens in: shells, scripts, and monitors. A
 * `read` that takes 90 s is a broken filesystem, not a design problem, and
 * guarding it would only turn one failure into two.
 */
const GUARDED_NAME = /(bash|shell|sh|zsh|exec|pwsh|powershell|cmd|script|monitor|terminal)/i

/**
 * Decide whether a call is worth guarding.
 *
 * @param {unknown} name - the tool name as dispatched.
 * @param {number} budgetMs - resolved ceiling; `0` or less disables the guard.
 * @returns {boolean}
 */
export function shouldGuard(name, budgetMs) {
  if (!(budgetMs > 0) || typeof name !== 'string' || name.length === 0) return false
  const lower = name.toLowerCase()
  if (EXEMPT.has(lower)) return false
  return GUARDED_NAME.test(lower)
}

/**
 * Resolve the ceiling for one session's config.
 *
 * `toolTimeoutMs` is the escape hatch: a positive value is used verbatim, a
 * negative value disables the guard, and `0` (the default) means "follow the
 * gear".
 *
 * @param {object} config - output of `resolveConfig`.
 * @returns {number} milliseconds, `0` when the guard is off.
 */
export function stallBudgetFor(config) {
  if (!config || config.stallGuard === false) return 0
  const explicit = Number(config.toolTimeoutMs)
  if (Number.isFinite(explicit) && explicit < 0) return 0
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const fromGear = STALL_BUDGET[config.gear]
  return Number.isFinite(fromGear) ? fromGear : DEFAULT_STALL_BUDGET
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
}

/** Sentinel that cannot collide with a tool result (which is always an object). */
const STALLED = Symbol('fast-mode:stalled')

/**
 * Build the failure the caller receives when the guard fires.
 *
 * The text is addressed to the model, not to the user: it explains what was
 * cancelled and what to change, because an aborted call with no explanation is
 * how a model ends up retrying the identical command.
 *
 * @param {{name?: string, budgetMs: number, elapsedMs?: number}} info
 * @returns {object} a `ToolExecutionFailure`.
 */
export function stallFailure(info) {
  const name = typeof info?.name === 'string' && info.name.length > 0 ? info.name : 'the tool'
  const budgetMs = Number.isFinite(info?.budgetMs) ? info.budgetMs : DEFAULT_STALL_BUDGET
  const seconds = Math.max(1, Math.round(budgetMs / 1000))
  const text = [
    `fast-mode stall guard: \`${name}\` was still running after ${seconds}s and was cancelled.`,
    'The turn is not waiting on it any more. Before retrying, change something:',
    '- a server, watcher, tail, or REPL belongs in the background (`run_in_background: true`), not in the foreground;',
    '- a long or quoted/multi-line command belongs in a file — write it, then call the shell with `script_path`;',
    '- a narrow probe (one directory, one pattern, `--max-count`, a head/tail) beats a full sweep.',
    'Never re-issue the same command unchanged: it will be cancelled again.',
  ].join('\n')
  return {
    isError: true,
    error: { message: `fast-mode stall guard cancelled ${name} after ${seconds}s` },
    content: [{ type: 'text', text }],
  }
}

/**
 * Create the `tools/execute` waterfall handler.
 *
 * The handler is a plain async function so the policy can be tested without a
 * harness: `budgetFor`, `onStall` and `now` are injected.
 *
 * @param {object} [options]
 * @param {(exec: object) => number} [options.budgetFor] - ceiling for one call.
 * @param {(info: object) => void} [options.onStall] - observation hook.
 * @param {() => number} [options.now] - clock.
 * @param {number} [options.graceMs] - how long to wait for the aborted body to settle.
 */
export function createStallGuard(options = {}) {
  const budgetFor = typeof options.budgetFor === 'function' ? options.budgetFor : () => 0
  const onStall = typeof options.onStall === 'function' ? options.onStall : () => {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 250

  /**
   * @param {object} exec - `ToolDispatchExecution`.
   * @param {() => Promise<object>} next - the rest of the dispatch chain.
   */
  return async function stallGuard(exec, next) {
    if (!exec || typeof exec !== 'object') return next()
    const budgetMs = budgetFor(exec)
    if (!shouldGuard(exec.name, budgetMs)) return next()

    const caller = exec.signal
    if (!caller || typeof caller.addEventListener !== 'function' || caller.aborted === true) return next()

    const controller = new AbortController()
    /** Forward the caller's cancellation into the body's signal. */
    const relay = () => {
      try {
        controller.abort(caller.reason)
      } catch {
        // An abort that throws is already aborted; nothing to forward.
      }
    }
    caller.addEventListener('abort', relay, { once: true })

    const began = now()
    // The one field a wrapper may change.
    exec.signal = controller.signal

    let timedOut = false
    let timer
    const expiry = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        resolve(STALLED)
      }, budgetMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
    })

    // Start the body exactly once. The race may abandon it, so its rejection is
    // attached here: an unobserved rejection would crash the host, not us.
    const body = next()
    body.catch(() => {})

    try {
      const settled = await Promise.race([body, expiry])
      if (settled !== STALLED) return settled

      // Abort, then give the body a short window to unwind so the dispatch
      // chain reaches quiescence before we report the failure.
      try {
        controller.abort(new Error(`fast-mode: ${String(exec.name)} exceeded ${budgetMs} ms`))
      } catch {
        // Already aborted by the caller in the same tick.
      }
      await Promise.race([body.catch(() => undefined), delay(graceMs)])

      const elapsedMs = Math.max(0, now() - began)
      try {
        onStall({ name: exec.name, budgetMs, elapsedMs, timedOut })
      } catch {
        // Observation is best-effort; it must never change the result.
      }
      return stallFailure({ name: exec.name, budgetMs, elapsedMs })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      try {
        caller.removeEventListener('abort', relay)
      } catch {
        // A signal implementation without removeEventListener needs no cleanup.
      }
      try {
        exec.signal = caller
      } catch {
        // Frozen dispatch objects are the host's business; we did our part.
      }
    }
  }
}
