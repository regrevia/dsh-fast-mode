import assert from 'node:assert/strict'
import test from 'node:test'

import { AUTO_LIMITS, autoSchedule, createAutoState, notePolicy, noteStep, noteTool } from '../src/auto.js'

/** Two clean read steps so the scheduler has evidence to widen on. */
function readStreak(state, agent) {
  for (let step = 0; step < 2; step += 1) {
    noteStep(state, agent)
    for (let i = 0; i < 3; i += 1) {
      noteTool(state, agent, { name: 'read', argsKey: `r-${step}-${i}-${Math.random()}`, chars: 10 })
    }
  }
}

test('the default fan-out cap is the built-in one', () => {
  const state = createAutoState()
  notePolicy(state, 'a', {})
  readStreak(state, 'a')
  assert.equal(autoSchedule(state, 'a').parallel, AUTO_LIMITS.parallelMax)
})

test('fanoutWidth raises the cap only for blocks the evidence already called parallel', () => {
  const state = createAutoState()
  notePolicy(state, 'a', { fanoutWidth: 12 })
  readStreak(state, 'a')
  assert.equal(autoSchedule(state, 'a').parallel, 12)
})

test('fanoutWidth never widens a write step or an erring turn', () => {
  const state = createAutoState()
  notePolicy(state, 'a', { fanoutWidth: 12 })
  noteStep(state, 'a')
  noteTool(state, 'a', { name: 'write', argsKey: 'f.js', chars: 10 })
  noteTool(state, 'a', { name: 'write', argsKey: 'g.js', chars: 10 })
  assert.equal(autoSchedule(state, 'a').parallel, 1)
})

test('a cap below the probe width is ignored, and the cap is bounded', () => {
  const lower = createAutoState()
  notePolicy(lower, 'a', { fanoutWidth: 2 })
  readStreak(lower, 'a')
  assert.equal(autoSchedule(lower, 'a').parallel, AUTO_LIMITS.parallelMax)

  const huge = createAutoState()
  notePolicy(huge, 'a', { fanoutWidth: 99 })
  readStreak(huge, 'a')
  assert.equal(autoSchedule(huge, 'a').parallel, AUTO_LIMITS.parallelCapMax)
})
