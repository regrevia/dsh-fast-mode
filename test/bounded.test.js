import test from 'node:test'
import assert from 'node:assert/strict'

import { trim } from '../src/bounded.js'
import { createRecorder, LABELS_MAX } from '../src/metrics.js'

test('trim leaves a cache under its cap alone', () => {
  const map = new Map([['a', 1], ['b', 2]])
  assert.equal(trim(map, 10), map, 'returns the cache for chaining')
  assert.deepEqual([...map.keys()], ['a', 'b'])
})

test('trim drops the oldest entries first', () => {
  const map = new Map([['a', 1], ['b', 2], ['c', 3], ['d', 4]])
  trim(map, 2)
  assert.deepEqual([...map.keys()], ['c', 'd'])
  const set = new Set(['a', 'b', 'c', 'd'])
  trim(set, 2)
  assert.deepEqual([...set], ['c', 'd'])
})

test('trim works on a cache that grew past the cap in one step', () => {
  const set = new Set(Array.from({ length: 50 }, (_, i) => `s-${i}`))
  trim(set, 5)
  assert.equal(set.size, 5)
  assert.deepEqual([...set], ['s-45', 's-46', 's-47', 's-48', 's-49'])
})

test('trim with no usable cap is a no-op rather than an emptying', () => {
  for (const cap of [0, -1, Number.NaN]) {
    const set = new Set(['a', 'b'])
    trim(set, cap)
    assert.deepEqual([...set], ['a', 'b'], `cap ${cap} must not evict`)
  }
})

/**
 * The label cache is the one an uncapped host actually accumulates: it is
 * written on every request, for every session. Once a session's label is
 * evicted, its row has to say `unknown` instead of borrowing a neighbour's —
 * that is the visible half of the fix.
 */
test('the labels cache is bounded, and an evicted session is labelled unknown', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-fast-mode-labels-'))
  const file = join(dir, 'metrics.jsonl')
  try {
    const recorder = createRecorder({ file })
    // Walk past the shipped cap so the first session is evicted.
    const first = 'session-0'
    for (let i = 0; i < LABELS_MAX + 100; i += 1) {
      recorder.label(`session-${i}`, { mode: 'on', gear: 'auto', effort: 'high', route: 'company/deepseek-v4.1-flash' })
    }
    // The newest label survives: the cache evicted the front, not the back.
    const feedFor = (at) => [
      { type: 'step/start', turn: 0, step: 1, time: at },
      { type: 'assistant/message', turn: 0, step: 1, time: at + 500, usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'step/end', turn: 0, step: 1, time: at + 600 },
    ]
    for (const [index, sid] of [`session-${LABELS_MAX + 99}`, first].entries()) {
      for (const event of feedFor(1000 + index * 1000)) recorder.record({ id: sid }, event)
    }

    const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(rows.length, 2)
    const kept = rows.find(row => row.sid === `session-${LABELS_MAX + 99}`)
    assert.equal(kept.mode, 'on', 'a recent label must survive')
    assert.equal(kept.gear, 'auto')
    const evicted = rows.find(row => row.sid === first)
    assert.equal(evicted.mode, 'unknown', 'an evicted session must not keep a stale label')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
