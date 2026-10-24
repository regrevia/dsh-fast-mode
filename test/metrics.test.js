/**
 * The measurement half of the plugin: does the JSONL sink fold the session feed
 * correctly, and does the report compute the comparison it claims to?
 *
 * The feed is faked here on purpose. These tests are about the arithmetic and
 * the folding rules (one row per step, first/last assistant message, usage
 * summing), not about the harness — the wiring is covered by the plugin tests.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { compare, createRecorder, METRICS_VERSION, summarise } from '../src/metrics.js'

/** A session-shaped object: only `id` is ever read. */
const session = id => ({ id })

/** Feed one complete step. */
function step(recorder, sid, { turn = 0, step: index = 1, start, ttft, end, usage, calls = 0, errors = 0 }) {
  const target = session(sid)
  recorder.record(target, { type: 'step/start', turn, step: index, time: start })
  for (let call = 0; call < calls; call += 1) {
    recorder.record(target, { type: 'tool/call', turn, step: index, time: start + 5, name: 'read' })
  }
  for (let error = 0; error < errors; error += 1) {
    recorder.record(target, { type: 'tool/result', turn, step: index, time: start + 6, error: 'boom' })
  }
  // The stream opens at `ttft` (one chunk), the message is committed at `end`:
  // exactly the order the harness emits them in.
  if (usage) recorder.record(target, { type: 'assistant/chunk', turn, step: index, time: ttft, chunk: { type: 'text-delta', text: 'x' } })
  if (usage) recorder.record(target, { type: 'assistant/message', turn, step: index, time: end, usage })
  recorder.record(target, { type: 'step/end', turn, step: index, time: end })
}

const withTempFile = (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fast-mode-metrics-test-'))
  try {
    return run(join(dir, 'metrics.jsonl'), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const readRows = file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))

test('one step produces exactly one row', () => withTempFile((file) => {
  const recorder = createRecorder({ file })
  recorder.label('s1', { mode: 'on', gear: 'fast', effort: 'low', route: 'p/m' })
  step(recorder, 's1', {
    start: 1000,
    ttft: 1600,
    end: 2000,
    usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 100 },
    calls: 2,
  })
  assert.equal(recorder.pending, 0, 'a closed step leaves nothing behind')

  const [row] = readRows(file)
  assert.equal(row.v, METRICS_VERSION)
  assert.equal(row.sid, 's1')
  assert.equal(row.mode, 'on')
  assert.equal(row.gear, 'fast')
  assert.equal(row.effort, 'low')
  assert.equal(row.route, 'p/m')
  assert.equal(row.ttftMs, 600, 'queue + prefill: step start to the first chunk')
  assert.equal(row.decodeMs, 400, 'the generation window after the first chunk')
  assert.equal(row.firstChunk, 'text-delta')
  assert.equal(row.llmMs, 1000, 'the whole call is unchanged')
  assert.equal(row.stepMs, 1000)
  assert.equal(row.input, 300)
  assert.equal(row.output, 50)
  assert.equal(row.cacheRead, 100)
  assert.equal(row.calls, 2)
  assert.equal(row.errors, 0)
}))

test('two assistant messages in one step: first token is the first, cost is the last', () => withTempFile((file) => {
  const recorder = createRecorder({ file })
  const target = session('s1')
  recorder.record(target, { type: 'step/start', turn: 1, step: 2, time: 1000 })
  recorder.record(target, { type: 'assistant/chunk', turn: 1, step: 2, time: 1500, chunk: { type: 'reasoning-delta', text: '…' } })
  recorder.record(target, { type: 'assistant/message', turn: 1, step: 2, time: 1500, usage: { inputTokens: 100, outputTokens: 10 } })
  recorder.record(target, { type: 'assistant/message', turn: 1, step: 2, time: 3000, usage: { inputTokens: 100, outputTokens: 20 } })
  recorder.record(target, { type: 'step/end', turn: 1, step: 2, time: 3200 })

  const [row] = readRows(file)
  assert.equal(row.ttftMs, 500, 'first token: the step waited 500 ms for it')
  assert.equal(row.firstChunk, 'reasoning-delta', 'thinking before writing is still a first token')
  assert.equal(row.decodeMs, 1500)
  assert.equal(row.llmMs, 2000, 'generation: to the last message, not the first')
  assert.equal(row.output, 30, 'usage of both messages in the step is summed')
  assert.equal(row.assistantMessages, 2)
}))

test('a step with no assistant message has no token latency, only wall clock', () => withTempFile((file) => {
  const recorder = createRecorder({ file })
  step(recorder, 's1', { start: 1000, end: 1400, calls: 1 })

  const [row] = readRows(file)
  assert.equal(row.ttftMs, undefined)
  assert.equal(row.llmMs, undefined)
  assert.equal(row.stepMs, 400)
}))

test('a persisted chunk names no turn or step: it belongs to the open step, and framing markers are not tokens', () => withTempFile((file) => {
  const recorder = createRecorder({ file })
  const target = session('alpha')
  recorder.record(target, { type: 'step/start', turn: 3, step: 2, time: 1000 })
  // Real shape, measured: the durable feed appends the chunk alone.
  recorder.record(target, { type: 'assistant/chunk', time: 1100, data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } } })
  recorder.record(target, { type: 'assistant/chunk', time: 1400, data: { chunk: { type: 'reasoning-delta', index: 0, text: 'hm' } } })
  recorder.record(target, { type: 'assistant/message', turn: 3, step: 2, time: 2000, usage: { outputTokens: 5 } })
  recorder.record(target, { type: 'step/end', turn: 3, step: 2, time: 2000 })
  const row = JSON.parse(readFileSync(file, 'utf8').trim())
  assert.equal(row.turn, 3)
  assert.equal(row.step, 2)
  assert.equal(row.ttftMs, 400, 'TTFT is step start to the first delta, not to the block marker')
  assert.equal(row.decodeMs, 600)
  assert.equal(row.firstChunk, 'reasoning-delta')
}))

test('a first token that beats step/start is kept and never reported as a negative TTFT', () => withTempFile((file) => {
  const recorder = createRecorder({ file })
  const target = session('races')
  recorder.record(target, { type: 'assistant/chunk', time: 980, data: { chunk: { type: 'text-delta', text: 'x' } } })
  recorder.record(target, { type: 'step/start', turn: 1, step: 1, time: 1000 })
  recorder.record(target, { type: 'assistant/message', turn: 1, step: 1, time: 1600, usage: { outputTokens: 4 } })
  recorder.record(target, { type: 'step/end', turn: 1, step: 1, time: 1600 })
  const row = JSON.parse(readFileSync(file, 'utf8').trim())
  assert.equal(row.ttftMs, 0)
  assert.equal(row.firstChunk, 'text-delta')
  assert.equal(row.llmMs, 600)
}))

test('errors inside a step are counted, and the row still lands', () => withTempFile((file) => {
  const recorder = createRecorder({ file })
  step(recorder, 's1', { start: 0, ttft: 100, end: 200, usage: { outputTokens: 5 }, calls: 1, errors: 2 })

  const [row] = readRows(file)
  assert.equal(row.errors, 2)
  assert.equal(row.output, 5)
}))

test('the label is per session: two sessions never bleed into each other', () => withTempFile((file) => {
  const recorder = createRecorder({ file })
  recorder.label('s1', { mode: 'off', gear: 'off' })
  recorder.label('s2', { mode: 'on', gear: 'max', effort: 'low' })
  step(recorder, 's1', { start: 0, ttft: 100, end: 200, usage: { outputTokens: 1 } })
  step(recorder, 's2', { start: 200, ttft: 300, end: 400, usage: { outputTokens: 2 } })

  const rows = readRows(file)
  assert.deepEqual(rows.map(row => [row.sid, row.mode, row.gear]), [['s1', 'off', 'off'], ['s2', 'on', 'max']])
}))

test('without a label a row is still written, marked unknown', () => withTempFile((file) => {
  const recorder = createRecorder({ file })
  step(recorder, 's1', { start: 0, ttft: 100, end: 200, usage: { outputTokens: 1 } })

  const [row] = readRows(file)
  assert.equal(row.mode, 'unknown')
  assert.equal(row.gear, 'unknown')
}))

test('non-step noise and id-less sessions are ignored', () => withTempFile((file) => {
  const recorder = createRecorder({ file })
  recorder.record(session('s1'), { type: 'message/user', time: 1000 })
  recorder.record(session('s1'), { type: 'model/selection', time: 1000 })
  recorder.record({}, { type: 'step/start', turn: 0, step: 1, time: 1000 })
  recorder.record(session('s1'), { type: 'step/end', turn: 0, step: 1, time: 2000 })

  assert.equal(recorder.pending, 0, 'nothing is left half-folded')
  assert.equal(existsSync(file), false, 'no completed step means no file is even created')
}))

test('an empty file path disables the sink entirely', () => {
  const recorder = createRecorder({ file: '' })
  assert.equal(recorder.enabled, false)
  step(recorder, 's1', { start: 0, ttft: 1, end: 2, usage: { outputTokens: 1 } })
  assert.equal(recorder.pending, 0)
})

test('a missing directory is created on first write', () => withTempFile((file, dir) => {
  const nested = join(dir, 'deep', 'nested', 'metrics.jsonl')
  const recorder = createRecorder({ file: nested })
  step(recorder, 's1', { start: 0, ttft: 1, end: 2, usage: { outputTokens: 1 } })
  assert.equal(readRows(nested).length, 1)
}))

/** Rows for one stance. */
const row = (sid, mode, gear, overrides = {}) => ({
  sid,
  mode,
  gear,
  turn: 0,
  step: 1,
  llmMs: 1000,
  stepMs: 1100,
  ttftMs: 400,
  input: 1000,
  output: 100,
  calls: 1,
  errors: 0,
  ...overrides,
})

test('summarise buckets by stance and reports the medians a comparison needs', () => {
  const rows = []
  for (let index = 0; index < 4; index += 1) {
    rows.push(row('off-1', 'off', 'off', { step: index + 1, llmMs: 1000, output: 100 }))
  }
  for (let index = 0; index < 4; index += 1) {
    rows.push(row('on-1', 'on', 'fast', { step: index + 1, llmMs: 600, output: 140, calls: 2 }))
  }

  const buckets = summarise(rows)
  assert.equal(buckets.length, 2)
  const [off, on] = buckets
  assert.equal(off.mode, 'off')
  assert.equal(off.steps, 4)
  assert.equal(off.sessions, 1)
  assert.equal(off.turns, 1)
  assert.equal(off.llmMsP50, 1000)
  assert.equal(off.outputPerStep, 100)
  assert.equal(on.gear, 'fast')
  assert.equal(on.llmMsP50, 600)
  assert.equal(on.outputPerStep, 140)
  assert.equal(on.callsPerStep, 2)
  assert.equal(on.multiCallSteps, 4)
})

test('steps per turn counts distinct turns, not rows', () => {
  const rows = [
    row('s', 'on', 'fast', { turn: 0, step: 1 }),
    row('s', 'on', 'fast', { turn: 0, step: 2 }),
    row('s', 'on', 'fast', { turn: 1, step: 1 }),
  ]
  const [bucket] = summarise(rows)
  assert.equal(bucket.turns, 2)
  assert.equal(bucket.stepsPerTurn, 1.5)
})

test('summarise tolerates junk rows instead of throwing', () => {
  const buckets = summarise([null, 'x', row('s', 'on', 'fast'), { sid: 42, mode: 'on' }])
  assert.ok(Array.isArray(buckets))
})

test('compare reports speedup and token cost against the off baseline', () => {
  const baseline = {
    gear: 'off', llmMsMean: 1000, stepMsP50: 1100, outputPerStep: 100,
    outputPerSession: 4000, callsPerStep: 1,
  }
  const candidate = {
    gear: 'fast', llmMsMean: 500, stepMsP50: 550, outputPerStep: 130,
    outputPerSession: 5200, callsPerStep: 2,
  }
  assert.deepEqual(compare(baseline, candidate), {
    gear: 'fast',
    speedupLlm: 2,
    speedupStep: 2,
    outputRatio: 1.3,
    tokensPerSessionRatio: 1.3,
    callsRatio: 2,
  })
  assert.equal(compare(undefined, candidate), undefined, 'no baseline, no claim')
})

test('compare refuses to divide by a missing measurement', () => {
  const result = compare({ llmMsMean: undefined, stepMsP50: 0 }, { gear: 'fast', llmMsMean: 500 })
  assert.equal(result.speedupLlm, undefined)
  assert.equal(result.speedupStep, undefined)
})

test('the real feed wraps every payload in data, and both shapes are read', () => withTempFile((file) => {
  // Regression: the harness appends `session.append(type, data)`, so the event
  // carries `{type, time, data:{turn, step, usage}}`. Reading `event.turn` and
  // `event.usage` produced a release whose rows had no step numbers and zero
  // tokens while every other field looked healthy.
  const recorder = createRecorder({ file })
  recorder.label('wrapped', { mode: 'on', gear: 'turbo', effort: 'low', route: 'p/m' })
  const target = session('wrapped')
  recorder.record(target, { type: 'step/start', time: 1000, data: { turn: 7, step: 3 } })
  recorder.record(target, {
    type: 'tool/call',
    time: 1100,
    data: { turn: 7, step: 3, callId: 'c1', name: 'read', arguments: {} },
  })
  recorder.record(target, {
    type: 'assistant/message',
    time: 1500,
    data: {
      turn: 7,
      step: 3,
      message: { role: 'assistant', content: [] },
      usage: { inputTokens: 1200, outputTokens: 90, cacheReadTokens: 4000, reasoningTokens: 12 },
    },
  })
  recorder.record(target, { type: 'step/end', time: 2000, data: { turn: 7, step: 3 } })

  const [row] = readRows(file)
  assert.equal(row.turn, 7, 'small: the step number comes from the payload')
  assert.equal(row.step, 3)
  assert.equal(row.calls, 1)
  assert.equal(row.input, 1200)
  assert.equal(row.output, 90)
  assert.equal(row.cacheRead, 4000)
  assert.equal(row.reasoning, 12)
  assert.equal(row.llmMs, 500)
}))

test('usage under the gateway spelling is folded too', () => withTempFile((file) => {
  const recorder = createRecorder({ file })
  recorder.label('gateway', { mode: 'off', gear: 'off', effort: 'high', route: 'p/m' })
  const target = session('gateway')
  recorder.record(target, { type: 'step/start', time: 10, data: { turn: 1, step: 1 } })
  recorder.record(target, {
    type: 'assistant/message',
    time: 20,
    data: {
      turn: 1,
      step: 1,
      usage: {
        uncachedInputTokens: 500,
        outputTokens: 40,
        thoughtTokens: 5,
        cachedReadTokens: 900,
        cachedWriteTokens: 60,
      },
    },
  })
  recorder.record(target, { type: 'step/end', time: 30, data: { turn: 1, step: 1 } })

  const [row] = readRows(file)
  assert.deepEqual(
    { input: row.input, output: row.output, reasoning: row.reasoning, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite },
    { input: 500, output: 40, reasoning: 5, cacheRead: 900, cacheWrite: 60 },
  )
}))
