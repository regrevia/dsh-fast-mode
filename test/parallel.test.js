import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'

import {
  DEFAULT_POOL,
  SHELL_PARALLEL_TOOL,
  buildShellParallelTool,
  clip,
  isConcurrencySafe,
  normalizeJobs,
  poolSize,
} from '../src/parallel.js'

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
