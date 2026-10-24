import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUTO,
  AUTO_LIMITS,
  AUTO_SESSIONS,
  autoSchedule,
  createAutoState,
  describeSchedule,
  noteStep,
  noteTool,
  noteTurn,
} from '../src/auto.js'

/** One clean multi-call step: two distinct calls, both new. */
function cleanStep(state, agent, n = 2) {
  noteStep(state, agent)
  for (let i = 0; i < n; i += 1) {
    noteTool(state, agent, { name: 'read', argsKey: `a-${Math.random()}`, chars: 10 })
  }
}

/** One repeated call: same signature, same size, so no progress. */
function repeatCall(state, agent, chars = 100) {
  noteTool(state, agent, { name: 'shell', argsKey: 'tail log', chars })
}

test('a fresh session starts at the base width and the floor budget', () => {
  const state = createAutoState()
  const schedule = autoSchedule(state, 's1')
  assert.equal(AUTO, 'auto')
  assert.equal(schedule.parallel, AUTO_LIMITS.parallelBase)
  assert.equal(schedule.stallBudgetMs, AUTO_LIMITS.stallFloorMs)
  assert.equal(schedule.directive, undefined)
  assert.equal(schedule.stats.steps, 0)
  assert.equal(schedule.stats.turnSteps, 0)
})

test('a wide read-only step widens the very next step, without waiting for a second one', () => {
  const state = createAutoState()
  cleanStep(state, 's1', 3)
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').parallel, AUTO_LIMITS.parallelMax)
  assert.equal(autoSchedule(state, 's1').stats.lastStepReadOnly, true)
})

test('two clean read-only calls widen on the second step, and one call never does', () => {
  const state = createAutoState()
  cleanStep(state, 's1', 2)
  // One observed read step is not yet "two clean read steps": stay native.
  assert.equal(autoSchedule(state, 's1').parallel, 1)

  cleanStep(state, 's1', 2)
  assert.equal(autoSchedule(state, 's1').parallel, AUTO_LIMITS.parallelMax)

  // Single-call steps are the shape where fan-out has nothing to merge: the
  // session is left native (width 1 = no guidance at all) instead of being
  // asked for a wider block it cannot use.
  const quiet = createAutoState()
  cleanStep(quiet, 's1', 1)
  cleanStep(quiet, 's1', 1)
  assert.equal(autoSchedule(quiet, 's1').parallel, 1)
})

test('a step containing a state-changing call widens on the slower schedule', () => {
  const state = createAutoState()
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'read', argsKey: 'a', chars: 10 })
  noteTool(state, 's1', { name: 'read', argsKey: 'b', chars: 10 })
  noteTool(state, 's1', { name: 'write', argsKey: 'c', chars: 10 })
  assert.equal(autoSchedule(state, 's1').stats.lastStepReadOnly, false)
  // A write in the step means the calls were not independent: stay native.
  assert.equal(autoSchedule(state, 's1').parallel, 1)

  cleanStep(state, 's1', 2)
  assert.equal(autoSchedule(state, 's1').parallel, AUTO_LIMITS.parallelMax)
})

test('a new turn resets the per-turn counters but keeps what was tried', () => {
  const state = createAutoState()
  cleanStep(state, 's1')
  cleanStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').parallel, AUTO_LIMITS.parallelMax)

  noteTurn(state, 's1')
  const schedule = autoSchedule(state, 's1')
  assert.equal(schedule.stats.turnSteps, 0)
  // The previous turn ended in a wide read block, so the new request keeps it.
  assert.equal(schedule.parallel, AUTO_LIMITS.parallelMax)
  // Session-level memory survives: the first sighting was progress, the second
  // identical call is not, even in a fresh turn.
  repeatCall(state, 's1')
  assert.equal(autoSchedule(state, 's1').stats.noProgress, 0)
  repeatCall(state, 's1')
  assert.equal(autoSchedule(state, 's1').stats.noProgress, 1)
})

test('repeated identical calls narrow the width', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  for (let i = 0; i < 4; i += 1) repeatCall(state, 's1')
  const schedule = autoSchedule(state, 's1')
  assert.equal(schedule.stats.noProgress, 3, 'only the first sighting is progress')
  assert.equal(schedule.parallel, 1)
})

test('a changed result size counts as progress; an identical rerun does not', () => {
  const state = createAutoState()
  repeatCall(state, 's1', 100)
  repeatCall(state, 's1', 100)
  repeatCall(state, 's1', 100)
  assert.equal(autoSchedule(state, 's1').stats.noProgress, 2)

  repeatCall(state, 's1', 101)
  assert.equal(autoSchedule(state, 's1').stats.noProgress, 0)
})

test('a call that used to fail and now succeeds is progress', () => {
  const state = createAutoState()
  noteTool(state, 's1', { name: 'shell', argsKey: 'x', isError: true, chars: 20 })
  assert.equal(autoSchedule(state, 's1').stats.errors, 1)

  noteTool(state, 's1', { name: 'shell', argsKey: 'x', isError: false, chars: 20 })
  const schedule = autoSchedule(state, 's1')
  assert.equal(schedule.stats.noProgress, 0)
  assert.equal(schedule.stats.errors, 0)
})

test('errors narrow the width even when calls keep changing', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  for (let i = 0; i < 3; i += 1) {
    noteTool(state, 's1', { name: 'shell', argsKey: `e-${i}`, isError: true, chars: 5 })
  }
  assert.equal(autoSchedule(state, 's1').parallel, 1)
})

test('the stall budget follows the recent p90, clamped to 2-5 minutes', () => {
  const slow = createAutoState()
  for (let i = 0; i < 10; i += 1) {
    noteTool(slow, 's1', { name: 'shell', argsKey: `c-${i}`, chars: i, durationMs: 1_000 })
  }
  assert.equal(autoSchedule(slow, 's1').stallBudgetMs, AUTO_LIMITS.stallFloorMs)

  const mid = createAutoState()
  for (let i = 0; i < 10; i += 1) {
    noteTool(mid, 's1', { name: 'shell', argsKey: `c-${i}`, chars: i, durationMs: 45_000 })
  }
  assert.equal(autoSchedule(mid, 's1').stallBudgetMs, 135_000)

  const stuck = createAutoState()
  for (let i = 0; i < 10; i += 1) {
    noteTool(stuck, 's1', { name: 'shell', argsKey: `c-${i}`, chars: i, durationMs: 200_000 })
  }
  assert.equal(autoSchedule(stuck, 's1').stallBudgetMs, AUTO_LIMITS.stallCeilMs)
})

test('only the recent wait window feeds the p90, so a recovered session narrows again', () => {
  const state = createAutoState()
  for (let i = 0; i < 40; i += 1) {
    noteTool(state, 's1', { name: 'shell', argsKey: `old-${i}`, chars: i, durationMs: 200_000 })
  }
  for (let i = 0; i < AUTO_LIMITS.waitWindow; i += 1) {
    noteTool(state, 's1', { name: 'shell', argsKey: `new-${i}`, chars: i, durationMs: 1_000 })
  }
  assert.equal(autoSchedule(state, 's1').stallBudgetMs, AUTO_LIMITS.stallFloorMs)
})

test('the directive warns once, respects the cooldown, then stops and reports once', () => {
  const state = createAutoState()
  noteTurn(state, 's1')

  // The first sighting counts as progress, so one extra call is needed.
  for (let i = 0; i < AUTO_LIMITS.noProgressWarn + 1; i += 1) repeatCall(state, 's1')
  const warn = autoSchedule(state, 's1')
  assert.equal(warn.stats.noProgress, AUTO_LIMITS.noProgressWarn)
  assert.equal(warn.directive?.kind, 'change-approach')
  assert.match(warn.directive.text, /Change the approach/)
  assert.match(warn.directive.summary, /change approach/)

  // Same step again: the cooldown suppresses the repeat.
  assert.equal(autoSchedule(state, 's1').directive, undefined)
  for (let i = 0; i < AUTO_LIMITS.directiveCooldown; i += 1) noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').directive?.kind, 'change-approach')

  while (autoSchedule(state, 's1').stats.noProgress < AUTO_LIMITS.noProgressStop) repeatCall(state, 's1')
  assert.equal(autoSchedule(state, 's1').stats.noProgress, AUTO_LIMITS.noProgressStop)
  for (let i = 0; i < AUTO_LIMITS.directiveCooldown; i += 1) noteStep(state, 's1')
  const stop = autoSchedule(state, 's1')
  assert.equal(stop.directive?.kind, 'stop-and-report')
  assert.match(stop.directive.text, /Stop working now and report/)

  for (let i = 0; i < AUTO_LIMITS.directiveCooldown; i += 1) noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').directive, undefined, 'stop is said once per turn')
})

test('a turn that runs past the step budget is told to stop and report', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  for (let i = 0; i < AUTO_LIMITS.turnStepBudget; i += 1) cleanStep(state, 's1')
  noteStep(state, 's1')
  const schedule = autoSchedule(state, 's1')
  assert.equal(schedule.stats.turnSteps, AUTO_LIMITS.turnStepBudget + 1)
  assert.equal(schedule.directive?.kind, 'stop-and-report')
})

test('the scheduler remembers a bounded number of sessions', () => {
  const state = createAutoState()
  for (let i = 0; i < AUTO_SESSIONS + 20; i += 1) autoSchedule(state, `s-${i}`)
  assert.equal(state.sessions.size, AUTO_SESSIONS)
  assert.equal(state.sessions.has('s-0'), false, 'the oldest entry is evicted')
  assert.equal(state.sessions.has(`s-${AUTO_SESSIONS + 19}`), true)
})

test('the seen-signature map and the wait window stay bounded on a long session', () => {
  const state = createAutoState()
  for (let i = 0; i < 300; i += 1) {
    noteTool(state, 's1', { name: 'read', argsKey: `k-${i}`, chars: i, durationMs: i })
  }
  const session = state.sessions.get('s1')
  assert.ok(session.seen.size <= 128)
  assert.ok(session.waits.length <= AUTO_LIMITS.waitWindow)
})

test('strange input degrades to no opinion instead of throwing', () => {
  const state = createAutoState()
  noteTurn(state, undefined)
  noteStep(state, 42)
  noteTool(state, null, null)
  noteTool(state, 's1', { name: '', argsKey: 7, chars: Number.NaN, durationMs: -1 })
  noteTool(state, 's1', 'not an object')
  const schedule = autoSchedule(state, undefined)
  assert.equal(schedule.parallel, 1)
  assert.equal(schedule.stallBudgetMs, AUTO_LIMITS.stallFloorMs)
  assert.equal(state.sessions.has('__global__'), true)
})

test('describeSchedule quotes the same numbers the scheduler picked', () => {
  const state = createAutoState()
  const schedule = autoSchedule(state, 's1')
  assert.deepEqual(describeSchedule(schedule), { parallel: 4, minutes: '2', budgetMs: 120_000 })

  const fallback = describeSchedule(undefined)
  assert.equal(fallback.parallel, AUTO_LIMITS.parallelBase)
  assert.equal(fallback.budgetMs, AUTO_LIMITS.stallFloorMs)
})

test('the limits themselves stay in the range the docs promise', () => {
  assert.ok(AUTO_LIMITS.parallelMin >= 1)
  assert.ok(AUTO_LIMITS.parallelMax <= 8)
  assert.ok(AUTO_LIMITS.stallFloorMs >= 60_000)
  assert.ok(AUTO_LIMITS.stallCeilMs >= AUTO_LIMITS.stallFloorMs)
  assert.ok(AUTO_LIMITS.noProgressWarn < AUTO_LIMITS.noProgressStop)
})

test('a read-only session stays wide across the turn boundary', () => {
  const state = createAutoState()
  cleanStep(state, 's1', 3)
  cleanStep(state, 's1', 3)
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').stats.readOnlyStreak >= 2, true)
  assert.equal(autoSchedule(state, 's1').parallel, AUTO_LIMITS.parallelMax)

  noteTurn(state, 's1')
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').stats.turnSteps, 1)
  assert.equal(autoSchedule(state, 's1').parallel, AUTO_LIMITS.parallelMax)
})

test('a shell-writing streak does not make the next turn start wide', () => {
  const state = createAutoState()
  for (let step = 0; step < 3; step += 1) {
    noteStep(state, 's1')
    noteTool(state, 's1', { name: 'bash', argsKey: `cmd-${step}`, chars: 10 })
    noteTool(state, 's1', { name: 'read', argsKey: `read-${step}`, chars: 10 })
  }
  noteTurn(state, 's1')
  // Mixed read/write steps are not a fan-out shape: the next turn stays native.
  assert.equal(autoSchedule(state, 's1').parallel, 1)
})
