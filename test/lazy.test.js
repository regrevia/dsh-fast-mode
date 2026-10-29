/**
 * The lazy switch is the only code in the package allowed to move effort, so its
 * policy is pinned here rather than only exercised through the harness. The
 * guarantees worth pinning are the ones that keep the 0.9.x failure from coming
 * back: a floor, a per-turn cap, an error cooldown, and a pass-through for any
 * vocabulary this module does not recognise.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  beginStep,
  cheaperEffort,
  createLazyWatch,
  DIRECTIVE,
  DIRECTIVE_SUMMARY,
  EFFORT_RUNGS,
  noteReasoning,
  noteToolResult,
  planEffort,
} from '../src/lazy.js'

test('the ladder text asks for the minimum and names what must never be cut', () => {
  assert.match(DIRECTIVE, /lazy senior developer/i)
  assert.match(DIRECTIVE, /first rung that works/i)
  assert.match(DIRECTIVE, /validation where input crosses a trust boundary/i)
  assert.match(DIRECTIVE, /error handling that protects data/i)
  assert.match(DIRECTIVE, /security/i)
  assert.match(DIRECTIVE, /accessibility/i)
  assert.match(DIRECTIVE, /what you skipped/i)
  assert.ok(DIRECTIVE.length < 1400, 'the directive is paid on every request of a turn')
  assert.equal(typeof DIRECTIVE_SUMMARY, 'string')
})

test('cheaperEffort walks down and stops at the floor, unknown vocabulary untouched', () => {
  assert.equal(cheaperEffort('max'), 'xhigh')
  assert.equal(cheaperEffort('high'), 'medium')
  assert.equal(cheaperEffort('medium'), 'low')
  assert.equal(cheaperEffort('low'), undefined, 'low is the floor')
  assert.equal(cheaperEffort('minimal'), undefined)
  assert.equal(cheaperEffort('turbo'), undefined, 'an unknown rung is never guessed at')
  assert.equal(cheaperEffort(undefined), undefined)
  assert.deepEqual([...EFFORT_RUNGS], ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
})

test('the ladder text rides the first step of a turn and stays out of the rest', () => {
  const watch = createLazyWatch()
  const first = beginStep(watch, 's1', { firstStep: true })
  assert.equal(first.directive, DIRECTIVE, 'the model is told the ladder once per turn')
  const second = beginStep(watch, 's1', { firstStep: false })
  assert.equal(second?.directive, undefined, 'the second step pays nothing for it')
})

test('a fresh turn starts a fresh ledger', () => {
  const watch = createLazyWatch()
  beginStep(watch, 's1', { firstStep: true })
  noteReasoning(watch, 's1', 5000)
  beginStep(watch, 's1', { firstStep: false })
  const turn = beginStep(watch, 's1', { firstStep: true })
  assert.equal(turn.directive, DIRECTIVE)
  // The previous turn's volume is gone, so no nudge is inherited.
  assert.equal(turn.nudge, undefined)
  const next = beginStep(watch, 's1', { firstStep: false })
  assert.equal(next?.nudge, undefined, 'character counts do not survive into a new turn')
})

test('reasoning volume is what raises a nudge, and a nudge is spent once', () => {
  const watch = createLazyWatch()
  beginStep(watch, 's1', { firstStep: true })
  noteReasoning(watch, 's1', 1500)
  assert.equal(beginStep(watch, 's1', { firstStep: false })?.nudge, undefined, 'under threshold')
  noteReasoning(watch, 's1', 5000)
  const nudge = beginStep(watch, 's1', { firstStep: false })
  assert.equal(typeof nudge?.nudge, 'string')
  assert.match(nudge.nudge, /use what you already have/i)
  noteReasoning(watch, 's1', 1000)
  assert.equal(beginStep(watch, 's1', { firstStep: false })?.nudge, undefined, 'the threshold doubles: 7500 is not 8000')
  noteReasoning(watch, 's1', 5000)
  assert.equal(typeof beginStep(watch, 's1', { firstStep: false })?.nudge, 'string', 'the late nudge is the second')
  noteReasoning(watch, 's1', 5000)
  assert.equal(beginStep(watch, 's1', { firstStep: false })?.nudge, undefined, 'two nudges a turn at most')
})

test('junk reasoning counts are ignored rather than accumulated', () => {
  const watch = createLazyWatch()
  beginStep(watch, 's1', { firstStep: true })
  for (const value of [undefined, null, NaN, Infinity, -5, '9000']) noteReasoning(watch, 's1', value)
  noteReasoning(watch, 's1', 0)
  assert.equal(beginStep(watch, 's1', { firstStep: false })?.nudge, undefined)
})

test('effort is untouched without evidence of over-thinking', () => {
  const watch = createLazyWatch()
  beginStep(watch, 's1', { firstStep: true })
  const plan = planEffort(watch, 's1', 'high')
  assert.deepEqual(plan, { effort: 'high', reduced: false }, 'a step that has not streamed yet buys nothing')
})

test('a hot step buys one rung, not more than the turn allows', () => {
  const watch = createLazyWatch()
  beginStep(watch, 's1', { firstStep: true })
  const seen = []
  for (let i = 0; i < 4; i += 1) {
    noteReasoning(watch, 's1', 2000)
    beginStep(watch, 's1', { firstStep: false })
    seen.push(planEffort(watch, 's1', 'high'))
  }
  assert.deepEqual(seen[0], { effort: 'medium', reduced: true })
  assert.deepEqual(seen[1], { effort: 'medium', reduced: true }, 'a second hot step spends the second reduction')
  assert.equal(seen[2].reduced, false, 'the per-turn reduction budget is two')
  assert.equal(seen[3].reduced, false)
})

test('the reduction never goes below the floor', () => {
  const watch = createLazyWatch()
  beginStep(watch, 's1', { firstStep: true })
  noteReasoning(watch, 's1', 5000)
  beginStep(watch, 's1', { firstStep: false })
  assert.deepEqual(planEffort(watch, 's1', 'low'), { effort: 'low', reduced: false })
  assert.deepEqual(planEffort(watch, 's1', 'minimal'), { effort: 'minimal', reduced: false })
})

test('an unrecognised effort vocabulary is passed through, never guessed', () => {
  const watch = createLazyWatch()
  beginStep(watch, 's1', { firstStep: true })
  noteReasoning(watch, 's1', 5000)
  beginStep(watch, 's1', { firstStep: false })
  assert.deepEqual(planEffort(watch, 's1', 'turbo'), { effort: 'turbo', reduced: false })
  assert.deepEqual(planEffort(watch, 's1', undefined), { effort: undefined, reduced: false })
  assert.deepEqual(planEffort(watch, 's1', 42), { effort: 42, reduced: false })
})

test('one step yields one reduction even if the request is issued twice', () => {
  const watch = createLazyWatch()
  beginStep(watch, 's1', { firstStep: true })
  noteReasoning(watch, 's1', 5000)
  beginStep(watch, 's1', { firstStep: false })
  assert.deepEqual(planEffort(watch, 's1', 'high'), { effort: 'medium', reduced: true })
  assert.deepEqual(planEffort(watch, 's1', 'medium'), { effort: 'medium', reduced: false }, 'a retry does not walk the ladder again')
})

test('the resolved value is restored on the next request, which is the 0.9.x fix', () => {
  const watch = createLazyWatch()
  beginStep(watch, 's1', { firstStep: true })
  noteReasoning(watch, 's1', 5000)
  beginStep(watch, 's1', { firstStep: false })
  assert.equal(planEffort(watch, 's1', 'high').effort, 'medium')
  // The next step streamed little: the harness's own value is what goes out.
  beginStep(watch, 's1', { firstStep: false })
  assert.deepEqual(planEffort(watch, 's1', 'high'), { effort: 'high', reduced: false })
})

test('an error result holds the effort still for a couple of steps', () => {
  const watch = createLazyWatch()
  beginStep(watch, 's1', { firstStep: true })
  noteReasoning(watch, 's1', 5000)
  noteToolResult(watch, 's1', { isError: true })
  beginStep(watch, 's1', { firstStep: false })
  assert.deepEqual(planEffort(watch, 's1', 'high'), { effort: 'high', reduced: false }, 'the cooldown holds')
  noteReasoning(watch, 's1', 5000)
  beginStep(watch, 's1', { firstStep: false })
  assert.equal(planEffort(watch, 's1', 'high').reduced, false, 'still cooling')
  noteReasoning(watch, 's1', 5000)
  beginStep(watch, 's1', { firstStep: false })
  assert.equal(planEffort(watch, 's1', 'high').reduced, true, 'the cooldown expires')
})

test('a successful result is not evidence either way', () => {
  const watch = createLazyWatch()
  beginStep(watch, 's1', { firstStep: true })
  noteReasoning(watch, 's1', 5000)
  noteToolResult(watch, 's1', { isError: false })
  beginStep(watch, 's1', { firstStep: false })
  assert.equal(planEffort(watch, 's1', 'high').reduced, true)
})

test('sessions do not share a ledger, and the ledger stays bounded', () => {
  const watch = createLazyWatch()
  beginStep(watch, 'a', { firstStep: true })
  noteReasoning(watch, 'a', 5000)
  beginStep(watch, 'a', { firstStep: false })
  assert.equal(planEffort(watch, 'a', 'high').reduced, true)
  assert.deepEqual(planEffort(watch, 'b', 'high'), { effort: 'high', reduced: false })
  for (let i = 0; i < 200; i += 1) beginStep(watch, `x${i}`, { firstStep: true })
  assert.ok(watch.runs.size <= 64, 'a long-lived host does not leak one entry per conversation')
})
