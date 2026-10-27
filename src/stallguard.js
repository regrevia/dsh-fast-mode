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
 * Ceiling on the *total* time the guard may spend confirming that a cancelled
 * body has really stopped, in milliseconds.
 *
 * The first window is the existing settle window (5 s on a real ceiling, scaled
 * down with the budget). If the body is still alive after that, the guard waits
 * one more confirmation window before it reports "exit not confirmed". Fifteen
 * seconds is the bound: long enough for a wrapper that needs SIGTERM then
 * SIGKILL to reap its child, short enough that a process which ignores its
 * signal costs one step rather than the whole turn.
 */
export const STALL_CONFIRM_TOTAL_MS = 15_000

/**
 * The second (confirmation) window. It is capped so that, for a default settle
 * window (at most 5 s), settle + confirm never exceeds
 * `STALL_CONFIRM_TOTAL_MS`.
 */
export const STALL_CONFIRM_WINDOW_MS = 10_000

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

/**
 * Derive the second window from the time already spent on the first one.
 *
 * Exported as a pure function so the bound can be asserted without sleeping:
 * for the default settle window (250 ms–5 s) the result is 10 s, which keeps
 * the total at 10.25 s–15 s.
 *
 * @param {number} settleMs - the first window that was already used.
 * @returns {number} milliseconds; `0` when the total ceiling is spent.
 */
export function confirmWindowFor(settleMs) {
  const spent = Number.isFinite(settleMs) ? Math.max(0, settleMs) : 0
  return Math.max(0, Math.min(STALL_CONFIRM_WINDOW_MS, STALL_CONFIRM_TOTAL_MS - spent))
}

/** Sentinel that cannot collide with a tool result (which is always an object). */
const STALLED = Symbol('fast-mode:stalled')

/** Outcome of one post-timeout wait window. */
const SETTLED = Symbol('fast-mode:settled')
const STILL_RUNNING = Symbol('fast-mode:still-running')
const CALLER_ABORTED = Symbol('fast-mode:caller-aborted')

/**
 * Build the failure the caller receives when the guard fires.
 *
 * The text is addressed to the model, not to the user: it explains what was
 * cancelled and what to change, because an aborted call with no explanation is
 * how a model ends up retrying the identical command.
 *
 * The two wordings are deliberately different. When the body was seen to settle
 * the next step is safe to run; when it was not, the guard says so plainly and
 * tells the model to verify the process is gone before touching anything. A
 * "cancelled, retry with a change" result on a body that is still writing a file
 * is how two executions end up racing on the same directory.
 *
 * @param {{name?: string, budgetMs: number, elapsedMs?: number, confirmed?: boolean}} info
 * @returns {object} a `ToolExecutionFailure`.
 */
export function stallFailure(info) {
  const name = typeof info?.name === 'string' && info.name.length > 0 ? info.name : 'the tool'
  const budgetMs = Number.isFinite(info?.budgetMs) ? info.budgetMs : DEFAULT_STALL_BUDGET
  const seconds = Math.max(1, Math.round(budgetMs / 1000))
  // Unknown means unconfirmed: never claim a cancellation was clean without
  // having observed the body settle.
  const confirmed = info?.confirmed === true
  const changeSomething = [
    '- a server, watcher, tail, or REPL belongs in the background (`run_in_background: true`), not in the foreground;',
    '- a long or quoted/multi-line command belongs in a file — write it, then call the shell with `script_path`;',
    '- a narrow probe (one directory, one pattern, `--max-count`, a head/tail) beats a full sweep.',
    'Never re-issue the same command unchanged: it will be cancelled again.',
  ]
  const text = confirmed
    ? [
        `fast-mode stall guard: \`${name}\` was still running after ${seconds}s and was cancelled.`,
        'Its process is confirmed gone: the next step may touch the files it wrote.',
        'The turn is not waiting on it any more. Before retrying, change something:',
        ...changeSomething,
      ].join('\n')
    : [
        `fast-mode stall guard: \`${name}\` was still running after ${seconds}s and was cancelled.`,
        'Its exit is NOT confirmed: the process may still be running or finishing, and it may still write files.',
        'Do not edit, move, or delete anything it may have touched until it is gone.',
        'Confirm it exited first, e.g. `pgrep -fl <pattern>` or `ps -o pid,stat,command -p <pid>`, then check the files it was writing.',
        'Once it is gone, retry with a change:',
        ...changeSomething,
      ].join('\n')
  return {
    isError: true,
    error: {
      message: confirmed
        ? `fast-mode stall guard cancelled ${name} after ${seconds}s`
        : `fast-mode stall guard cancelled ${name} after ${seconds}s (exit not confirmed)`,
    },
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
 * @param {(budgetMs: number) => number} [options.settleFor] - first window: how
 *   long to wait for the aborted body to actually settle, given its budget. A
 *   cancelled dispatch must not return a result while the body is still
 *   writing: the host hands the caller a settled call, and a body that finishes
 *   400 ms later then races the next step.
 * @param {(settleMs: number) => number} [options.confirmFor] - second window,
 *   used only when the first one elapsed without the body settling. Defaults to
 *   `confirmWindowFor`, which keeps settle + confirm under
 *   `STALL_CONFIRM_TOTAL_MS`.
 * @param {number} [options.graceMs] - fixed window for both tiers, overriding
 *   `settleFor`/`confirmFor` (tests use it).
 */
export function createStallGuard(options = {}) {
  const budgetFor = typeof options.budgetFor === 'function' ? options.budgetFor : () => 0
  const onStall = typeof options.onStall === 'function' ? options.onStall : () => {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  // The first window: five seconds on a real ceiling (90–300 s), scaled down
  // for a test-sized budget so a unit test does not sleep through the suite.
  const settleFor = Number.isFinite(options.graceMs)
    ? () => options.graceMs
    : typeof options.settleFor === 'function'
      ? options.settleFor
      : (budgetMs) => Math.max(250, Math.min(5_000, budgetMs))
  // The second window: only reached by a body that ignored the abort. It gets a
  // full SIGTERM-then-SIGKILL grace instead of the first window's short one.
  const confirmFor = Number.isFinite(options.graceMs)
    ? () => options.graceMs
    : typeof options.confirmFor === 'function'
      ? options.confirmFor
      : confirmWindowFor

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
    })

    // Start the body exactly once. The race may abandon it, so its rejection is
    // attached here: an unobserved rejection would crash the host, not us.
    const body = next()
    body.catch(() => {})

    try {
      const settled = await Promise.race([body, expiry])
      if (settled !== STALLED) return settled

      // Abort, then wait for the body to really unwind. Reporting the failure
      // while the body is still running hands the harness two live executions
      // for one call: the model sees "cancelled", and the cancelled command
      // writes or deletes something after the next step has started. The wait is
      // tiered so a slow-but-alive wrapper gets a real grace period:
      //
      //   tier 1 - the existing settle window (250 ms–5 s on a default budget);
      //   tier 2 - a confirmation window, only if tier 1 elapsed without the
      //            body settling (10 s by default, so the total stays ≤ 15 s).
      //
      // A body that ignores its signal cannot hang the turn, and the result
      // separates "confirmed gone" from "not confirmed" instead of reporting a
      // cancellation that may still be writing.
      try {
        controller.abort(new Error(`fast-mode: ${String(exec.name)} exceeded ${budgetMs} ms`))
      } catch {
        // Already aborted by the caller in the same tick.
      }
      const rawSettle = settleFor(budgetMs)
      const settleMs = Number.isFinite(rawSettle) ? Math.max(0, rawSettle) : 0
      const rawConfirm = confirmFor(settleMs)
      const confirmMs = Number.isFinite(rawConfirm) ? Math.max(0, rawConfirm) : 0
      const waitedFrom = now()

      // A caller abort during either window ends the wait immediately: the host
      // is already unwinding the turn, so extra confirmation would only delay it.
      let abortedByCaller = caller.aborted === true
      let onCallerAbort
      const callerAbort = new Promise((resolve) => {
        if (abortedByCaller) {
          resolve(CALLER_ABORTED)
          return
        }
        onCallerAbort = () => {
          abortedByCaller = true
          resolve(CALLER_ABORTED)
        }
        caller.addEventListener('abort', onCallerAbort, { once: true })
      })
      const bodySettled = body.then(() => SETTLED, () => SETTLED)
      /**
       * Race the body against one window and the caller's cancellation.
       *
       * The window timer is always cleared, so a body that settles early (or a
       * caller that aborts) does not leave a live handle behind for the rest of
       * the grace period.
       *
       * @param {number} ms - window length; `0` skips the timer.
       * @returns {Promise<symbol>} `SETTLED`, `STILL_RUNNING` or `CALLER_ABORTED`.
       */
      const waitWindow = (ms) => {
        if (!(ms > 0)) {
          return Promise.race([bodySettled, Promise.resolve(STILL_RUNNING)]).then(
            (outcome) => (outcome === STILL_RUNNING && abortedByCaller ? CALLER_ABORTED : outcome),
          )
        }
        let windowTimer
        const windowElapsed = new Promise((resolve) => {
          windowTimer = setTimeout(() => resolve(abortedByCaller ? CALLER_ABORTED : STILL_RUNNING), ms)
        })
        return Promise.race([bodySettled, windowElapsed, callerAbort])
          .finally(() => clearTimeout(windowTimer))
      }

      let outcome = await waitWindow(settleMs)
      if (outcome === STILL_RUNNING) outcome = await waitWindow(confirmMs)
      const quiesced = outcome === SETTLED
      const confirmed = quiesced
      const waitedMs = Math.max(0, now() - waitedFrom)

      const elapsedMs = Math.max(0, now() - began)
      try {
        onStall({
          name: exec.name,
          budgetMs,
          elapsedMs,
          waitedMs,
          settleMs,
          confirmMs,
          timedOut,
          quiesced,
          confirmed,
          callerAborted: abortedByCaller,
        })
      } catch {
        // Observation is best-effort; it must never change the result.
      }
      return stallFailure({ name: exec.name, budgetMs, elapsedMs, confirmed })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      try {
        caller.removeEventListener('abort', relay)
      } catch {
        // A signal implementation without removeEventListener needs no cleanup.
      }
      try {
        if (onCallerAbort) caller.removeEventListener('abort', onCallerAbort)
      } catch {
        // Same here: without removeEventListener there is nothing to undo.
      }
      try {
        exec.signal = caller
      } catch {
        // Frozen dispatch objects are the host's business; we did our part.
      }
    }
  }
}
