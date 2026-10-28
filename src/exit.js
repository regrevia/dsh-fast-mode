/**
 * Trustworthy exit confirmation for a cancelled subprocess.
 *
 * The bug this module exists for: `child.kill('SIGKILL')` sends a signal to one
 * PID. When the child is a shell (`bash -lc …`), the command that actually does
 * the work is a *grandchild*, and it keeps running — and keeps writing files —
 * after the root PID is gone. A caller that then reports "cancelled, the
 * process is gone" is wrong, and the next step races a live writer.
 *
 * So cancellation is modelled as three states, and only one of them is a claim
 * that anything exited:
 *
 * - `cancel-requested` — a signal was sent; no exit has been observed yet. The
 *   process may still be running.
 * - `exited` — the managed scope (the whole process group on POSIX) was
 *   observed to disappear (`kill(-pgid, 0)` → `ESRCH`).
 * - `unconfirmed` — the confirmation window elapsed and the scope may still be
 *   alive. Callers must say so instead of claiming a clean exit.
 *
 * POSIX gets a process group: jobs are spawned `detached`, which makes the
 * child a session leader, so `-pid` addresses the child and every descendant
 * that did not create its own group. Windows has no cheap equivalent (a Job
 * Object would be the real fix), so there only the root PID can be confirmed;
 * the group scope is reported as unconfirmed rather than pretended.
 *
 * @module dsh-fast-mode/exit
 */

/** The three cancellation states. Never collapse `cancel-requested` into `exited`. */
export const EXIT_STATES = Object.freeze({
  cancelRequested: 'cancel-requested',
  exited: 'exited',
  unconfirmed: 'unconfirmed',
})

/** How long a cancellation may spend confirming exits before it reports unconfirmed. */
export const DEFAULT_EXIT_CONFIRM_MS = 2_000

/** Poll interval while waiting for the process group to drain. */
export const GROUP_POLL_MS = 25

/** Whether this platform can address a process group the POSIX way. */
export function supportsProcessGroups (platform = process.platform) {
  return platform !== 'win32'
}

/**
 * Send `signal` to the whole process group led by `pid`.
 *
 * A group that is already gone is not an error: `ESRCH` means exactly what the
 * caller hoped for. Any other failure (a platform without negative-PID
 * signalling, `EPERM`) falls back to the root PID, and the result says which
 * scope was actually signalled.
 *
 * @param {number} pid - the child's PID, which is also its group id when spawned detached.
 * @param {NodeJS.Signals|string} [signal]
 * @param {{kill?: (target: number, signal?: string) => boolean}} [options]
 * @returns {{sent: boolean, group: boolean, reason: string|null}}
 */
export function signalProcessGroup (pid, signal = 'SIGKILL', options = {}) {
  const kill = typeof options.kill === 'function' ? options.kill : process.kill
  if (!Number.isInteger(pid) || pid <= 0) return { sent: false, group: false, reason: 'no-pid' }
  try {
    kill(-pid, signal)
    return { sent: true, group: true, reason: null }
  } catch (error) {
    if (error?.code === 'ESRCH') return { sent: false, group: true, reason: 'already-gone' }
    try {
      kill(pid, signal)
      return { sent: true, group: false, reason: String(error?.code ?? error?.message ?? 'group-failed') }
    } catch (fallback) {
      return { sent: false, group: false, reason: String(fallback?.code ?? fallback?.message ?? 'failed') }
    }
  }
}

/**
 * Is the process group led by `pid` still alive?
 *
 * `kill(-pgid, 0)` is the probe: it sends nothing and fails with `ESRCH` only
 * when the group is empty. `EPERM` means something is there but not ours, which
 * is still alive.
 *
 * @param {number} pid
 * @param {{kill?: (target: number, signal?: number) => boolean}} [options]
 * @returns {boolean}
 */
export function isProcessGroupAlive (pid, options = {}) {
  const kill = typeof options.kill === 'function' ? options.kill : process.kill
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(-pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

/**
 * Resolve `true` only when the child's own `exit` event was observed (or the
 * child had already exited before the call).
 *
 * @param {object} child - a `ChildProcess`.
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export function waitForExit (child, timeoutMs = DEFAULT_EXIT_CONFIRM_MS) {
  if (!child || typeof child.once !== 'function') return Promise.resolve(false)
  if (child.exitCode !== null || child.signalCode != null) return Promise.resolve(true)
  const limit = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : DEFAULT_EXIT_CONFIRM_MS
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.removeListener('exit', onExit) } catch { /* not an EventEmitter */ }
      try { child.removeListener('error', onError) } catch { /* same */ }
      resolve(value)
    }
    const onExit = () => finish(true)
    const onError = () => finish(false)
    const timer = setTimeout(() => finish(false), limit)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

/** Small cancellable-free sleep; unref'd so a lingering poll never holds the loop open. */
function sleep (ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms))
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * Terminate a spawned child *and its descendants*, then confirm the scope is gone.
 *
 * The returned state is the only thing a caller may report as fact:
 * `exited` was observed, `unconfirmed` was not. Sending a signal is never
 * reported as an exit.
 *
 * @param {object} child - a `ChildProcess` from `spawn`.
 * @param {object} [options]
 * @param {string} [options.signal] - signal for the first attempt.
 * @param {number} [options.confirmMs] - total budget for exit + drain confirmation.
 * @param {boolean} [options.group] - whether the child was spawned detached.
 * @returns {Promise<{state: string, scope: string, signalled: boolean, rootExited: boolean, waitedMs: number}>}
 */
export async function terminateProcessTree (child, options = {}) {
  const began = Date.now()
  const confirmMs = Number.isFinite(options.confirmMs) ? Math.max(0, options.confirmMs) : DEFAULT_EXIT_CONFIRM_MS
  const signal = typeof options.signal === 'string' && options.signal !== '' ? options.signal : 'SIGKILL'
  const group = options.group === undefined ? supportsProcessGroups() : options.group === true
  const pid = Number.isInteger(child?.pid) ? child.pid : null

  const sent = group ? signalProcessGroup(pid, signal) : { sent: false, group: false, reason: 'no-group' }
  if (!sent.sent) {
    try { child?.kill?.(signal) } catch { /* already gone */ }
  }

  const rootExited = await waitForExit(child, Math.max(0, confirmMs - (Date.now() - began)))
  if (!rootExited) {
    return { state: EXIT_STATES.unconfirmed, scope: group ? 'group' : 'process', signalled: sent.sent, rootExited: false, waitedMs: Math.max(0, Date.now() - began) }
  }
  if (!group || pid === null) {
    // Only the root PID was in scope, so nothing more can be confirmed.
    return { state: EXIT_STATES.unconfirmed, scope: 'process', signalled: sent.sent, rootExited: true, waitedMs: Math.max(0, Date.now() - began) }
  }

  while (Date.now() - began <= confirmMs) {
    if (!isProcessGroupAlive(pid)) {
      return { state: EXIT_STATES.exited, scope: 'group', signalled: sent.sent, rootExited: true, waitedMs: Math.max(0, Date.now() - began) }
    }
    await sleep(GROUP_POLL_MS)
  }
  return { state: EXIT_STATES.unconfirmed, scope: 'group', signalled: sent.sent, rootExited: true, waitedMs: Math.max(0, Date.now() - began) }
}

/** Model-facing sentence for a state; `null` for a clean exit (nothing to warn about). */
export function exitWarning (state, scope = 'group') {
  if (state === EXIT_STATES.exited) return null
  if (state === EXIT_STATES.cancelRequested) {
    return 'Cancellation was requested and the turn stopped waiting: the exit is not confirmed, so it may still be running and may still write files.'
  }
  return scope === 'process'
    ? 'The process itself exited, but its descendants were not tracked on this platform: the exit is not confirmed for anything it started.'
    : 'The exit is not confirmed within the confirmation window: it may still be running or finishing, and it may still write files.'
}
