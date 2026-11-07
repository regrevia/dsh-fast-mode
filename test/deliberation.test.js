import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GUARD, PROBE_TEXT, ACT_TEXT,
  deliberationNotice, createProgressWatch, beginTurn, noteCall, planRepeatNudge,
  noteReasoning, planReasoningNudge,
  MAX_REPEAT_NUDGES, REPEAT_CALLS, STALE_RESULTS, REASONING_CHARS, MAX_REASONING_NUDGES,
} from '../src/deliberation.js'

const watch = () => createProgressWatch()
const call = (w, sid, signature, { digest = 'd', isError = false, chars = 0 } = {}) =>
  noteCall(w, sid, { signature, digest, isError, chars })
const nudge = (w, sid, step = 1) => planRepeatNudge(w, sid, step)

test('the notice is undefined with both text switches off', () => {
  assert.equal(deliberationNotice({}), undefined)
  assert.equal(deliberationNotice(undefined), undefined)
  assert.equal(deliberationNotice({ probe: false, act: false }), undefined)
})

test('the notice carries only the rules that are on, and the guard exactly once', () => {
  const probe = deliberationNotice({ probe: true })
  assert.match(probe, /read it once instead of reasoning/i)
  assert.doesNotMatch(probe, /one line of plan is enough/i)
  assert.equal(probe.split(GUARD).length - 1, 1)

  const both = deliberationNotice({ probe: true, act: true })
  assert.match(both, /read it once instead of reasoning/i)
  assert.match(both, /one line of plan is enough/i)
  assert.equal(both.split(GUARD).length - 1, 1, 'both on still costs one guard line')
  assert.ok(both.includes(PROBE_TEXT) && both.includes(ACT_TEXT), 'the shipped texts are what is sent')
})

test('a turn starts clean, and the same user message does not reset it', () => {
  const w = watch()
  beginTurn(w, 's1', 'turn-1')
  call(w, 's1', 'read\u0000a')
  call(w, 's1', 'read\u0000a')
  assert.ok(nudge(w, 's1'), 'the repeat is visible inside the turn')
  beginTurn(w, 's1', 'turn-1')
  assert.equal(nudge(w, 's1'), undefined, 'a second step of the same turn does not repeat the sentence')
  beginTurn(w, 's1', 'turn-2')
  call(w, 's1', 'read\u0000a')
  call(w, 's1', 'read\u0000a')
  assert.ok(nudge(w, 's1'), 'a new turn is a new ledger')
})

test('the repeated call is counted, so the nudge states a finding', () => {
  const w = watch()
  beginTurn(w, 's1', 't')
  call(w, 's1', 'grep\u0000x')
  call(w, 's1', 'grep\u0000x')
  call(w, 's1', 'grep\u0000x')
  const text = nudge(w, 's1')
  assert.match(text, new RegExp(`already run ${3}`), 'the count is the real one')
  assert.equal(REPEAT_CALLS, 2)
})

test('a different call is not a loop', () => {
  const w = watch()
  beginTurn(w, 's1', 't')
  for (let i = 0; i < 6; i += 1) call(w, 's1', `read\u0000f${i}`, { digest: `d${i}` })
  assert.equal(nudge(w, 's1'), undefined)
})

test('three identical results in a row are a stale run, two are not', () => {
  const w = watch()
  beginTurn(w, 's1', 't')
  call(w, 's1', 'read\u0000a', { digest: 'x', chars: 800 })
  call(w, 's1', 'read\u0000b', { digest: 'x', chars: 800 })
  assert.equal(nudge(w, 's1'), undefined, 'two results is a coincidence')
  call(w, 's1', 'read\u0000c', { digest: 'x', chars: 800 })
  assert.match(nudge(w, 's1'), /returned the same content/i)
  assert.equal(STALE_RESULTS, 2)
})

test('a new result clears the stale run', () => {
  const w = watch()
  beginTurn(w, 's1', 't')
  call(w, 's1', 'read\u0000a', { digest: 'x', chars: 800 })
  call(w, 's1', 'read\u0000b', { digest: 'x', chars: 800 })
  call(w, 's1', 'read\u0000c', { digest: 'y', chars: 800 })
  call(w, 's1', 'read\u0000d', { digest: 'y', chars: 800 })
  assert.equal(nudge(w, 's1'), undefined)
})

test('an edit batch is not a stale run: unrelated calls with one canned confirmation', () => {
  // Every edit returns the same ~171-character confirmation. Three edits in a
  // batch are three different calls doing three different things, and their
  // identical result text carries no loop signal. All 45 stale triggers measured
  // on 78 suite transcripts were exactly this shape.
  const w = watch()
  beginTurn(w, 's1', 't')
  call(w, 's1', 'edit\u0000f1', { digest: 'confirm', chars: 171 })
  call(w, 's1', 'edit\u0000f2', { digest: 'confirm', chars: 171 })
  call(w, 's1', 'edit\u0000f3', { digest: 'confirm', chars: 171 })
  call(w, 's1', 'edit\u0000f4', { digest: 'confirm', chars: 171 })
  assert.equal(nudge(w, 's1'), undefined, 'identical confirmations are not evidence of a loop')
})

test('a same-call repeat is reported as a repeat, not as a stale run', () => {
  const w = watch()
  beginTurn(w, 's1', 't')
  for (let i = 0; i < 3; i += 1) call(w, 's1', 'bash\u0000status', { digest: 'clean', chars: 8 })
  assert.match(nudge(w, 's1'), /has already run 3 times/i)
})

test('an error is information: it never reads as a loop', () => {
  const w = watch()
  beginTurn(w, 's1', 't')
  call(w, 's1', 'read\u0000a', { isError: true })
  call(w, 's1', 'read\u0000a', { isError: true })
  call(w, 's1', 'read\u0000a', { isError: true })
  assert.equal(nudge(w, 's1'), undefined)
})

test('at most two nudges per turn, and never the same evidence twice', () => {
  const w = watch()
  beginTurn(w, 's1', 't')
  call(w, 's1', 'grep\u0000a')
  call(w, 's1', 'grep\u0000a')
  assert.ok(nudge(w, 's1'))
  assert.equal(nudge(w, 's1'), undefined, 'the same condition is not re-sent')
  call(w, 's1', 'grep\u0000a', { digest: 'z' })
  call(w, 's1', 'grep\u0000a', { digest: 'z' })
  call(w, 's1', 'grep\u0000a', { digest: 'z' })
  assert.ok(nudge(w, 's1'), 'a fresh condition earns the second nudge')
  call(w, 's1', 'grep\u0000a', { digest: 'z' })
  assert.equal(nudge(w, 's1'), undefined, `capped at ${MAX_REPEAT_NUDGES}`)
})

test('the watch stays bounded no matter how many conversations run', () => {
  const w = watch()
  for (let i = 0; i < 500; i += 1) beginTurn(w, `session-${i}`, 't')
  assert.ok(w.runs.size <= 64, 'the map is trimmed, so the record cannot grow without limit')

  beginTurn(w, 'one', 't')
  for (let i = 0; i < 200; i += 1) call(w, 'one', `read\u0000${i}`, { digest: `d${i}` })
  const run = w.runs.get('one')
  assert.ok(run.calls.length <= 8, 'and one turn keeps only the recent calls')
  assert.equal(run.stale, 0, 'a long run of new content is not stale')
})

test('reasoning length accumulates per turn and nudges once per threshold', () => {
  const w = watch()
  beginTurn(w, 's1', 'k1')
  noteReasoning(w, 's1', REASONING_CHARS - 500)
  assert.equal(planReasoningNudge(w, 's1', 1), undefined)
  noteReasoning(w, 's1', 1000)
  const first = planReasoningNudge(w, 's1', 2)
  assert.match(first, /about \d+ characters of reasoning/, first)
  assert.ok(first.includes(String(REASONING_CHARS - 500 + 1000)), 'the count it reports is the count it saw')
  assert.equal(planReasoningNudge(w, 's1', 3), undefined, 'one nudge per threshold')
  noteReasoning(w, 's1', REASONING_CHARS)
  assert.ok(planReasoningNudge(w, 's1', 4), 'the second threshold earns the second nudge')
  noteReasoning(w, 's1', REASONING_CHARS * 10)
  assert.equal(planReasoningNudge(w, 's1', 5), undefined, 'capped per turn')
  assert.equal(MAX_REASONING_NUDGES, 2)
})

test('a new user message resets the reasoning total, and bad input is ignored', () => {
  const w = watch()
  beginTurn(w, 's1', 'k1')
  noteReasoning(w, 's1', REASONING_CHARS + 1)
  assert.ok(planReasoningNudge(w, 's1', 1))
  beginTurn(w, 's1', 'k2')
  assert.equal(planReasoningNudge(w, 's1', 1), undefined)
  noteReasoning(w, 's1', Number.NaN)
  noteReasoning(w, 's1', -5)
  assert.equal(planReasoningNudge(w, 's1', 1), undefined)
})
