import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_POOL,
  SHELL_PARALLEL_TOOL,
  buildShellParallelTool,
  clip,
  isConcurrencySafe,
  normalizeJobs,
  poolSize,
} from '../src/parallel.js'
import {
  EXIT_STATES,
  exitWarning,
  isProcessGroupAlive,
  signalProcessGroup,
  supportsProcessGroups,
  terminateProcessTree,
  waitForExit,
} from '../src/exit.js'

const tool = buildShellParallelTool({ spawn, pool: DEFAULT_POOL })

test('the tool is model-visible under one stable name', () => {
  assert.equal(tool.name, SHELL_PARALLEL_TOOL)
  assert.equal(tool.name, 'shell_parallel')
  assert.match(tool.description, /independent/i)
  assert.equal(tool.parameters.properties.jobs.minItems, 2)
})

test('it is exclusive: the pool inside is the concurrency, not the scheduler', () => {
  assert.equal(isConcurrencySafe(), false)
  assert.equal(tool.isConcurrencySafe({ jobs: [] }), false)
})

test('a clipped stream keeps both ends and says how much went missing', () => {
  const value = 'a'.repeat(9000)
  const out = clip(value, 1000)
  assert.equal(out.clipped, true)
  assert.ok(out.text.length < 1200)
  assert.match(out.text, /chars clipped/)
  assert.equal(clip('short').clipped, false)
})

test('the pool is clamped to the cap and to the job count', () => {
  assert.equal(poolSize(undefined, 3), 3)
  assert.equal(poolSize(99, 20), DEFAULT_POOL)
  assert.equal(poolSize(0, 5), 1)
  assert.equal(poolSize(4, 2), 2)
})

test('malformed jobs are dropped rather than executed', () => {
  const jobs = normalizeJobs({ jobs: [{ command: '  echo hi  ', label: 'x' }, { command: '   ' }, { label: 'no-cmd' }, { command: 'echo two' }] })
  assert.deepEqual(jobs, [
    { command: 'echo hi', label: 'x', cwd: undefined },
    { command: 'echo two', label: 'job-2', cwd: undefined },
  ])
  assert.equal(normalizeJobs({}).length, 0)
})

test('a single job is refused: that is what the bash tool is for', async () => {
  const result = await tool.execute({ jobs: [{ command: 'echo hi' }] }, {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-parallel')
})

test('independent jobs overlap in real time', async () => {
  // Windows pays a one-off antivirus scan the first time bash.exe starts in a
  // process (~3s measured, 80ms afterwards). Warm it so this assertion measures
  // the pool's overlap rather than the scanner.
  if (process.platform === 'win32') {
    await tool.execute({ jobs: [{ command: 'exit 0' }, { command: 'exit 0' }] }, {})
  }
  const began = Date.now()
  const result = await tool.execute({
    jobs: [
      { command: 'sleep 0.6; echo one', label: 'one' },
      { command: 'sleep 0.6; echo two', label: 'two' },
      { command: 'sleep 0.6; echo three', label: 'three' },
    ],
  }, {})
  const elapsed = Date.now() - began
  assert.equal(result.ok, true)
  assert.equal(result.results.length, 3)
  assert.ok(result.sumMs >= 1500, `sum ${result.sumMs}`)
  assert.ok(elapsed < 1400, `wall ${elapsed} ms must be far below the serial sum`)
  assert.ok(result.savedMs > 1000, `saved ${result.savedMs}`)
  assert.equal(result.results[0].stdout.text.trim(), 'one')
})

test('a failing job is reported without failing the call', async () => {
  const result = await tool.execute({
    jobs: [
      { command: 'exit 3', label: 'bad' },
      { command: 'echo fine', label: 'good' },
    ],
  }, {})
  assert.equal(result.ok, false)
  assert.equal(result.failed, 1)
  assert.equal(result.results[0].exit, 3)
  assert.equal(result.results[1].exit, 0)
})

test('a hung job is killed at the timeout instead of hanging the turn', async () => {
  const result = await tool.execute({
    jobs: [
      { command: 'sleep 30', label: 'hang' },
      { command: 'echo quick', label: 'quick' },
    ],
    timeoutSec: 1,
  }, {})
  assert.equal(result.results[0].timedOut, true)
  assert.equal(result.results[1].stdout.text.trim(), 'quick')
})

// ---------------------------------------------------------------------------
// Cancellation: a signal reaches the command, not just the shell around it.
//
// `bash -lc 'python3 …'` is two processes. Killing the shell (the old
// implementation) left the python grandchild alive and still writing, while the
// tool returned as if the job were over. These tests pin the three-state
// contract: only an observed group exit may be reported as `exited`.
// ---------------------------------------------------------------------------

const POSIX = process.platform !== 'win32'

/** A python that actually runs here; /usr/bin/python3 can be blocked by the CLT licence. */
let pythonCache
function python () {
  if (pythonCache) return pythonCache
  for (const candidate of ['python3', '/Users/apple/.local/bin/python3', '/opt/homebrew/bin/python3']) {
    const probe = spawnSync('bash', ['-lc', `${candidate} -c 'print(1)'`], { encoding: 'utf8', timeout: 5_000 })
    if (probe.status === 0) { pythonCache = candidate; return candidate }
  }
  return null
}

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fm-cancel-'))
}

/** A python writer: records its own pid, then appends a line every 20 ms. */
function writerScript (dir) {
  const script = path.join(dir, 'writer.py')
  fs.writeFileSync(script, [
    'import os, sys, time',
    'pid_path, out_path = sys.argv[1], sys.argv[2]',
    'open(pid_path, "w").write(str(os.getpid()))',
    'with open(out_path, "a") as f:',
    '    while True:',
    '        f.write("x" * 64 + "\\n")',
    '        f.flush()',
    '        time.sleep(0.02)',
  ].join('\n'))
  return script
}

async function waitForFile (file, ms = 5_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

function isAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

test('cancelling a job kills the command its shell started, and says something exited only then', { skip: POSIX ? false : 'process groups are POSIX-only' }, async () => {
  const dir = tempDir()
  const pidFile = path.join(dir, 'writer.pid')
  const counter = path.join(dir, 'writer.log')
  const command = `: ; ${python()} ${writerScript(dir)} ${pidFile} ${counter}`

  const controller = new AbortController()
  const pending = tool.execute({
    jobs: [
      { command, label: 'writer' },
      { command: 'sleep 5', label: 'other' },
    ],
  }, { signal: controller.signal })

  assert.equal(await waitForFile(pidFile), true, 'the grandchild must have started')
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.ok(pid > 0, `writer pid ${pid}`)

  controller.abort()
  const result = await pending
  const writer = result.results[0]

  assert.equal(writer.aborted, true)
  assert.equal(writer.exitState, EXIT_STATES.exited, 'the group exit was observed')
  assert.equal(writer.stillRunning, undefined)
  assert.equal(isAlive(pid), false, 'the python grandchild is gone')

  // The real regression: after the tool returns, nothing may still write.
  const size = fs.statSync(counter).size
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(fs.statSync(counter).size, size, 'no write happened after the tool returned')
})

test('a timed-out job confirms the group too, instead of returning on the kill', { skip: POSIX ? false : 'process groups are POSIX-only' }, async () => {
  const dir = tempDir()
  const pidFile = path.join(dir, 'writer.pid')
  const counter = path.join(dir, 'writer.log')
  const command = `: ; ${python()} ${writerScript(dir)} ${pidFile} ${counter}`

  const pending = tool.execute({
    jobs: [
      { command, label: 'writer' },
      { command: 'sleep 3', label: 'other' },
    ],
    timeoutSec: 1,
  }, {})

  assert.equal(await waitForFile(pidFile), true, 'the grandchild must have started')
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  const result = await pending
  const writer = result.results[0]

  assert.equal(writer.timedOut, true)
  assert.equal(writer.exitState, EXIT_STATES.exited)
  assert.equal(isAlive(pid), false, 'the python grandchild is gone')

  const size = fs.statSync(counter).size
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(fs.statSync(counter).size, size, 'the timeout path leaves no live writer')
})

test('an already-gone group is not an error, and an untracked scope is never called exited', async () => {
  const esrch = () => { const error = new Error('nope'); error.code = 'ESRCH'; throw error }
  const eperm = () => { const error = new Error('nope'); error.code = 'EPERM'; throw error }

  assert.deepEqual(signalProcessGroup(4242, 'SIGKILL', { kill: esrch }), { sent: false, group: true, reason: 'already-gone' })
  assert.equal(isProcessGroupAlive(4242, { kill: esrch }), false)
  assert.equal(isProcessGroupAlive(4242, { kill: eperm }), true, 'EPERM means something is still there')
  assert.equal(supportsProcessGroups('win32'), false)
  assert.equal(supportsProcessGroups('darwin'), true)

  // Windows-style scope: the root exited, its descendants were never tracked.
  const child = new EventEmitter()
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.kill = () => true
  const pending = terminateProcessTree(child, { confirmMs: 200, group: false })
  child.exitCode = 0
  child.emit('exit', 0, null)
  const outcome = await pending
  assert.equal(outcome.state, EXIT_STATES.unconfirmed)
  assert.equal(outcome.scope, 'process')
  assert.equal(outcome.rootExited, true)
  assert.match(exitWarning(outcome.state, outcome.scope), /not confirmed/)

  // A child that already exited needs no waiting.
  const done = new EventEmitter()
  done.exitCode = 0
  assert.equal(await waitForExit(done, 50), true)
})
