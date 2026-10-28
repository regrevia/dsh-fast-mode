/**
 * The `shell_parallel` model-facing tool.
 *
 * Why this exists: the harness runs *parallel-safe* tool calls concurrently,
 * but `bash` is not parallel-safe, so N bash calls in one assistant block are
 * executed one after another (measured: six 1 s commands in a single step take
 * 6.3 s of tool time). Reads/searches are parallel-safe, so they already
 * overlap; shell work does not. On real tasks the shell is where the seconds
 * live — test suites, builds, installs, `git`, format/lint, greps over a large
 * tree — and no amount of prompt-side scheduling can overlap them.
 *
 * So the plugin ships the missing primitive instead: one call that runs N
 * independent commands in a bounded pool and returns every result. This is a
 * harness-level fix (a tool), not a prompt trick: the concurrency is enforced
 * by our code, not by convincing the model to behave.
 *
 * Safety envelope:
 * - only independent jobs belong here; the description says so and the tool
 *   never chains commands itself;
 * - each command runs in the calling session's cwd unless a job sets `cwd`;
 * - per-job output is clipped so a chatty command cannot flood the context;
 * - the whole call and each job are bounded, so a hung command fails the job
 *   instead of the turn.
 *
 * @module dsh-fast-mode/parallel
 */

import {
  DEFAULT_EXIT_CONFIRM_MS,
  EXIT_STATES,
  exitWarning,
  supportsProcessGroups,
  terminateProcessTree,
} from './exit.js'

/** Model-facing tool name. */
export const SHELL_PARALLEL_TOOL = 'shell_parallel'

/**
 * How long a cancelled job may spend confirming that its process group is
 * really gone. Long enough for a shell and its child to be reaped, short enough
 * that three stuck jobs do not add a visible step to the turn.
 */
export const EXIT_CONFIRM_MS = DEFAULT_EXIT_CONFIRM_MS

/** Default pool size. Matches the agent-loop's default cap, with headroom. */
export const DEFAULT_POOL = 8

/** Per-stream clip so one noisy command cannot dominate the context. */
export const STREAM_CLIP = 4000

/** Hard per-job ceiling when the model does not ask for one. */
export const DEFAULT_JOB_TIMEOUT_MS = 120_000

/**
 * Running a command that writes files while another one reads them is the
 * classic parallel foot-gun. We cannot know the file set, so instead of
 * guessing at safety we keep the tool exclusive: it is the only way to get
 * concurrency here, and the model is told to use it for independent jobs only.
 *
 * @returns always false — exclusive scheduling, bounded pool inside.
 */
export function isConcurrencySafe () {
  return false
}

/** Clip one captured stream and record that we did. */
export function clip (text, limit = STREAM_CLIP) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return { text: value, clipped: false }
  const head = Math.floor(limit * 0.7)
  const tail = limit - head
  return {
    text: `${value.slice(0, head)}\n…[${value.length - limit} chars clipped]…\n${value.slice(value.length - tail)}`,
    clipped: true,
  }
}

/** Clamp the requested pool size into something defensible. */
export function poolSize (requested, jobs, cap = DEFAULT_POOL) {
  const wanted = Number.isFinite(requested) ? Math.floor(requested) : cap
  const size = Math.min(Math.max(1, wanted), Math.max(1, cap))
  return Math.max(1, Math.min(size, jobs))
}

/**
 * Resolve the working directory for a job: the job's own `cwd` when it is a
 * non-empty string, else the calling session's project cwd.
 */
export function jobCwd (exec, job) {
  if (job && typeof job.cwd === 'string' && job.cwd !== '') return job.cwd
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** Normalize the model's argument object without throwing on malformed input. */
export function normalizeJobs (args) {
  const raw = args && Array.isArray(args.jobs) ? args.jobs : []
  return raw
    .filter((job) => job && typeof job.command === 'string' && job.command.trim() !== '')
    .slice(0, 16)
    .map((job, index) => ({
      command: job.command.trim(),
      label: typeof job.label === 'string' && job.label !== '' ? job.label : `job-${index + 1}`,
      cwd: typeof job.cwd === 'string' && job.cwd !== '' ? job.cwd : undefined,
    }))
}

/** The tool definition registered on the host's `tools` service. */
export function buildShellParallelTool ({ spawn, logger, pool = DEFAULT_POOL, clock = () => Date.now() } = {}) {
  return {
    name: SHELL_PARALLEL_TOOL,
    description: [
      'Run several INDEPENDENT shell commands at the same time and get every result back in one call.',
      'Use this instead of issuing separate bash calls whenever two or more independent commands each take real time',
      '(test suites, builds, installs, git probes, format/lint, greps over a large tree, network fetches):',
      'separate bash calls — even in one block — are executed one after another, so their runtimes add up, while this call overlaps them.',
      'Do NOT put dependent steps here: a command that needs an earlier command\'s output stays a normal bash call.',
      'Do NOT run two jobs that write the same file. Each job is {command, label?, cwd?}; commands run in the session cwd by default.',
      'A killed job reports exitState: "cancel-requested" (signal sent), "exited" (its process group was seen to be gone), or "unconfirmed" (the group could not be confirmed gone in time). Only "exited" means it stopped; "unconfirmed" may still be writing files.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jobs: {
          type: 'array',
          minItems: 2,
          maxItems: 16,
          description: 'Independent commands to run concurrently. Each needs its own files; no job may depend on another.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              command: { type: 'string', description: 'Shell command line, run with bash -lc.' },
              label: { type: 'string', description: 'Short name used in the returned results. Defaults to job-N.' },
              cwd: { type: 'string', description: 'Working directory for this job. Defaults to the session cwd.' },
            },
            required: ['command'],
          },
        },
        timeoutSec: {
          type: 'number',
          description: 'Per-job timeout in seconds (default 120). A job that exceeds it is killed and reported as timed out.',
        },
      },
      required: ['jobs'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 600_000,
    isConcurrencySafe,
    async execute (args, exec) {
      const jobs = normalizeJobs(args)
      if (jobs.length < 2) {
        return {
          ok: false,
          code: 'not-parallel',
          message: 'shell_parallel needs at least two independent jobs; run a single command with the bash tool instead.',
        }
      }
      const perJob = Number.isFinite(args?.timeoutSec) && args.timeoutSec > 0
        ? Math.min(args.timeoutSec * 1000, 600_000)
        : DEFAULT_JOB_TIMEOUT_MS
      const size = poolSize(pool, jobs.length)
      const signal = exec?.signal
      const begin = clock()
      const results = new Array(jobs.length)
      let next = 0

      const runOne = (job, index) => new Promise((resolve) => {
        const started = clock()
        let stdout = ''
        let stderr = ''
        let settled = false
        /** `null` | 'timeout' | 'abort' — who owns this job's ending. */
        let cancelling = null
        let abort = null
        const finish = (value) => {
          if (settled) return
          settled = true
          if (signal && abort) signal.removeEventListener('abort', abort)
          resolve({ index, started, ...value })
        }
        let child
        try {
          // `-l` starts a login shell, which on Windows re-reads the whole Git bash
          // profile for every job: measured ~850ms of pure startup per job there,
          // enough to blow the parallelism budget the tool exists to prove. The
          // profile contributes nothing to a job, so only POSIX keeps it.
          const shellArgs = process.platform === 'win32' ? ['-c', job.command] : ['-lc', job.command]
          child = spawn('bash', shellArgs, {
            cwd: jobCwd(exec, job),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            // The shell is not the job: `bash -lc 'python …'` runs the work in a
            // grandchild. A process group of its own is what lets a cancellation
            // reach that grandchild instead of leaving it writing files (see
            // `src/exit.js` for the three-state model).
            detached: supportsProcessGroups(),
            // Windows allocates a console for every spawn unless told not to, and
            // that allocation is synchronous on the thread that starts the job:
            // three jobs then take turns instead of overlapping.
            windowsHide: true,
          })
        } catch (error) {
          finish({ label: job.label, command: job.command, exit: null, timedOut: false, error: String(error?.message ?? error), stdout: { text: '', clipped: false }, stderr: { text: '', clipped: false } })
          return
        }
        const group = supportsProcessGroups() && Number.isInteger(child.pid) && child.pid > 0
        let timer
        /**
         * Cancel the managed scope, then settle on what was observed.
         *
         * Sending SIGKILL is `cancel-requested`, not an exit: the promise stays
         * open until the process group is confirmed gone (`exited`) or the
         * confirmation window expires (`unconfirmed`). A job whose shell died
         * but whose grandchild is still writing must never be reported as if it
         * had exited.
         */
        const cancel = (kind) => {
          if (settled || cancelling) return
          cancelling = kind
          clearTimeout(timer)
          terminateProcessTree(child, { confirmMs: EXIT_CONFIRM_MS, group }).then((outcome) => {
            const warning = exitWarning(outcome.state, outcome.scope)
            finish({
              label: job.label,
              command: job.command,
              exit: null,
              ...(kind === 'timeout' ? { timedOut: true } : { timedOut: false, aborted: true }),
              exitState: outcome.state,
              ...(warning ? { stillRunning: outcome.state !== EXIT_STATES.exited, note: warning } : {}),
              stdout: clip(stdout),
              stderr: clip(stderr),
            })
          }).catch((error) => {
            finish({
              label: job.label,
              command: job.command,
              exit: null,
              ...(kind === 'timeout' ? { timedOut: true } : { timedOut: false, aborted: true }),
              exitState: EXIT_STATES.unconfirmed,
              stillRunning: true,
              note: `exit confirmation failed: ${String(error?.message ?? error)}`,
              error: String(error?.message ?? error),
              stdout: clip(stdout),
              stderr: clip(stderr),
            })
          })
        }
        timer = setTimeout(() => cancel('timeout'), perJob)
        abort = () => cancel('abort')
        if (signal) {
          if (signal.aborted) { cancel('abort'); return }
          signal.addEventListener('abort', abort, { once: true })
        }
        child.stdout?.on('data', (chunk) => { stdout += chunk })
        child.stderr?.on('data', (chunk) => { stderr += chunk })
        child.on('error', (error) => {
          // A cancellation owns the ending: its state is the truthful one.
          if (cancelling) return
          clearTimeout(timer)
          finish({ label: job.label, command: job.command, exit: null, timedOut: false, error: String(error?.message ?? error), stdout: clip(stdout), stderr: clip(stderr) })
        })
        child.on('close', (code, sig) => {
          if (cancelling) return
          clearTimeout(timer)
          finish({
            label: job.label,
            command: job.command,
            exit: typeof code === 'number' ? code : null,
            signal: sig ?? undefined,
            timedOut: false,
            exitState: EXIT_STATES.exited,
            stdout: clip(stdout),
            stderr: clip(stderr),
          })
        })
      })

      const worker = async () => {
        while (next < jobs.length) {
          const index = next
          next += 1
          const job = jobs[index]
          const outcome = await runOne(job, index)
          const { index: _i, started: _s, ...rest } = outcome
          results[index] = { ...rest, ms: Math.max(0, clock() - outcome.started) }
        }
      }

      await Promise.all(Array.from({ length: size }, worker))
      const wallMs = Math.max(0, clock() - begin)
      const sumMs = results.reduce((total, item) => total + (item?.ms ?? 0), 0)
      const failed = results.filter((item) => item && item.exit !== 0).length
      try {
        logger?.info?.('shell_parallel ran %d jobs in pool %d: wall %d ms, sum %d ms', jobs.length, size, wallMs, sumMs)
      } catch { /* diagnostics are best effort */ }
      return {
        ok: failed === 0,
        pool: size,
        wallMs,
        sumMs,
        savedMs: Math.max(0, sumMs - wallMs),
        failed,
        results,
      }
    },
  }
}
