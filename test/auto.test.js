import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AUTO,
  AUTO_LIMITS,
  AUTO_SESSIONS,
  autoSchedule,
  createAutoState,
  describeSchedule,
  noteEntry,
  noteOutputTokens,
  notePolicy,
  noteStep,
  noteTool,
  noteTurn,
  toolTargets,
} from '../src/auto.js'

/** One clean multi-call step: two distinct calls, both new. */
function cleanStep(state, agent, n = 2) {
  noteStep(state, agent)
  for (let i = 0; i < n; i += 1) {
    noteTool(state, agent, { name: 'read', argsKey: `a-${Math.random()}`, chars: 10 })
  }
}

/** One repeated call: same signature, same content, so no progress. */
function repeatCall(state, agent, chars = 100) {
  noteTool(state, agent, { name: 'shell', argsKey: 'tail log', chars, digest: `tail:${chars}` })
}

/** Step boundaries only, enough for the directive cooldown to elapse. */
function cooldownSteps(state, agent) {
  for (let i = 0; i < AUTO_LIMITS.directiveCooldown + 1; i += 1) noteStep(state, agent)
}

/**
 * Drive one check up to a raised reuse hint: first pass, a quiet step, then a
 * verbatim second pass. The caller adds the boundary that observes it.
 */
function toReuseHint(state, agent, check) {
  noteStep(state, agent)
  noteTool(state, agent, check)
  noteStep(state, agent)
  noteStep(state, agent)
  noteTool(state, agent, check)
}

/**
 * One whole step whose single call is a verbatim rerun of the last one.
 * Progress is aggregated per step, so a bare sequence of calls says nothing
 * until a boundary observes it.
 */
function stalledStep(state, agent, chars = 100) {
  repeatCall(state, agent, chars)
  noteStep(state, agent)
}

/** A step of one poll whose text is unique but always the same length. */
function pollStep(state, agent, n) {
  const text = `completed ${n} / 99`
  noteTool(state, agent, { name: 'job_output', argsKey: 'poll', chars: text.length, digest: text })
  noteStep(state, agent)
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
  // A step is only visible at the next boundary: nothing snapshotted yet.
  assert.equal(autoSchedule(state, 's1').parallel, 1)

  // The boundary sees two reads of two distinct targets: that is the parallel
  // shape already, so it goes wide without waiting for a second clean step.
  noteStep(state, 's1')
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
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').stats.noProgress, 0)
  repeatCall(state, 's1')
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').stats.noProgress, 1)
})

test('repeated identical calls narrow the width', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  // The first step is a new signature (progress); the next three are not.
  stalledStep(state, 's1')
  stalledStep(state, 's1')
  stalledStep(state, 's1')
  stalledStep(state, 's1')
  const schedule = autoSchedule(state, 's1')
  assert.equal(schedule.stats.noProgress, 3, 'only the first sighting is progress')
  assert.equal(schedule.parallel, 1)
})

test('changed content counts as progress; an identical rerun does not', () => {
  const state = createAutoState()
  noteStep(state, 's1')
  repeatCall(state, 's1', 100)
  noteStep(state, 's1')
  noteStep(state, 's1')
  repeatCall(state, 's1', 100)
  noteStep(state, 's1')
  noteStep(state, 's1')
  repeatCall(state, 's1', 100)
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').stats.noProgress, 2)

  // Same number of characters, different text: this is real progress and the
  // old length test is exactly what got it wrong.
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'shell', argsKey: 'tail log', chars: 100, digest: 'tail:different' })
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').stats.noProgress, 0)
})

test('a healthy poll that never changes length is progress, not a stall', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  notePolicy(state, 's1', { lateDiscipline: false })
  // The false-stop reproduction: `completed 10 / 99` … `22 / 99` has the same
  // character count at every step, and used to be read as twelve dead steps.
  for (let n = 10; n <= 22; n += 1) pollStep(state, 's1', n)
  const schedule = autoSchedule(state, 's1')
  assert.equal(schedule.stats.turnSteps, 13)
  assert.equal(schedule.stats.noProgress, 0)
  assert.equal(schedule.directive, undefined, 'thirteen progressing steps must not be told to stop or change method')
})

test('stall is counted per step, not per tool call', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  // The first sighting is progress; the next step reruns it eight times.
  noteStep(state, 's1')
  repeatCall(state, 's1')
  noteStep(state, 's1')
  for (let i = 0; i < 8; i += 1) repeatCall(state, 's1')
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').stats.turnSteps, 3)
  // Eight reruns inside one step are still one unproductive step, so a wide
  // step cannot manufacture a stall out of its own fan-out.
  assert.equal(autoSchedule(state, 's1').stats.noProgress, 1)
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

test('the stall reminder changes method and never ends the turn', () => {
  const state = createAutoState()
  noteTurn(state, 's1')

  // The first sighting counts as progress, so one extra step is needed before
  // the threshold is reached.
  let warn
  for (let i = 0; i < AUTO_LIMITS.noProgressWarn + 2 && !warn; i += 1) {
    stalledStep(state, 's1')
    const snapshot = autoSchedule(state, 's1')
    if (snapshot.directive?.kind === 'change-approach') warn = snapshot
  }
  assert.ok(warn, 'a stall must produce a change-approach request')
  assert.match(warn.directive.text, /change the method/)
  assert.match(warn.directive.summary, /change approach/)

  // Same step again: the cooldown suppresses the repeat.
  assert.equal(autoSchedule(state, 's1').directive, undefined)
  for (let i = 0; i < AUTO_LIMITS.directiveCooldown; i += 1) noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').directive?.kind, 'change-approach')

  // Long past the old twelve-step stop: the only thing a stall produces is
  // another request to change method, and the turn is never marked stopped.
  const kinds = new Set()
  for (let i = 0; i < 20; i += 1) {
    stalledStep(state, 's1')
    const kind = autoSchedule(state, 's1').directive?.kind
    if (kind) kinds.add(kind)
  }
  assert.equal(kinds.has('stop-and-report'), false, 'a stall never ends the turn')
  assert.equal(state.sessions.get('s1').stopped, false, 'a stall is a method problem, not a completion')
})

test('45 steps of real progress are never told to wrap up or to stop', () => {
  // The counterexample the default policy has to survive: a long task that keeps
  // producing new results. Nothing here may look like a completion judgement —
  // no finish-line request, no stop-and-report, no "change method" nudge, and the
  // session must never be marked stopped.
  const state = createAutoState()
  noteTurn(state, 's1')
  notePolicy(state, 's1', { lateDiscipline: false })

  const kinds = new Set()
  for (let i = 0; i < 45; i += 1) {
    noteStep(state, 's1')
    noteTool(state, 's1', { name: 'read', argsKey: `file-${i}.md`, chars: 40 + i, digest: `digest-${i}` })
    noteTool(state, 's1', { name: 'shell', argsKey: `run step ${i}`, chars: 12, digest: `out-${i}` })
    // A step boundary observes the progress; the next step is scheduled after it.
    const directive = autoSchedule(state, 's1').directive
    if (directive) kinds.add(directive.kind)
    noteStep(state, 's1')
  }
  assert.deepEqual([...kinds], [], 'a progressing task gets no reminder at all')
  assert.equal(state.sessions.get('s1').stopped, false, 'finishing is the model\'s call, not the counter\'s')
  assert.equal(autoSchedule(state, 's1').stats.turnSteps > 45, true)
})

test('a requirement added in a new turn restarts the finish-line accounting', () => {
  const state = createAutoState()
  notePolicy(state, 's1', { lateDiscipline: false, finishLineSteps: 3 })
  noteTurn(state, 's1')

  for (let i = 0; i < 3; i += 1) {
    noteStep(state, 's1')
    noteTool(state, 's1', { name: 'read', argsKey: `a-${i}`, chars: i, digest: `a-${i}` })
  }
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').directive?.kind, 'finish-line', 'the opt-in line fires in turn one')
  assert.equal(state.sessions.get('s1').stopped, false)

  // The user adds a requirement: a new turn, so the old finish line is spent
  // history and the new work gets its own count. Nothing carries the "wrap up"
  // request into the new turn.
  noteTurn(state, 's1')
  for (let i = 0; i < 2; i += 1) {
    noteStep(state, 's1')
    noteTool(state, 's1', { name: 'read', argsKey: `b-${i}`, chars: i, digest: `b-${i}` })
  }
  assert.equal(autoSchedule(state, 's1').directive, undefined, 'the new requirement is not told to wrap up early')
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').directive?.kind, 'finish-line')
})

test('outputBudgetAfterSteps holds the budget back until the turn is already long', () => {
  const state = createAutoState()
  notePolicy(state, 's1', { lateDiscipline: false, outputBudget: 5000, outputBudgetAfterSteps: 6 })
  noteTurn(state, 's1')
  // Expensive from the start, but the turn is still short: the reminder is a
  // cost cap for work already under way, so it must not collapse a fresh task.
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'read', argsKey: 'a', chars: 1, digest: 'a' })
  noteOutputTokens(state, 's1', 9000)
  assert.equal(autoSchedule(state, 's1').directive, undefined, 'short turn is protected')

  for (let i = 0; i < 6; i += 1) {
    noteStep(state, 's1')
    noteTool(state, 's1', { name: 'read', argsKey: `b-${i}`, chars: i, digest: `b-${i}` })
  }
  const line = autoSchedule(state, 's1')
  assert.equal(line.directive?.kind, 'output-budget', 'once the turn is long the budget speaks')
})

test('an output token budget fires on real usage, once per turn, not on step count', () => {
  const state = createAutoState()
  notePolicy(state, 's1', { lateDiscipline: false, outputBudget: 5000 })
  noteTurn(state, 's1')

  // Two cheap steps: the counter is about decode work, so a long cheap turn must
  // stay silent. This is the case a step budget cannot distinguish.
  for (let i = 0; i < 4; i += 1) {
    noteStep(state, 's1')
    noteTool(state, 's1', { name: 'read', argsKey: `a-${i}`, chars: i, digest: `a-${i}` })
    noteOutputTokens(state, 's1', 400)
  }
  assert.equal(autoSchedule(state, 's1').directive, undefined, '1600 tokens of usage asks for nothing')

  // One expensive message crosses the budget: the reminder is about the tokens
  // already spent, so it must arrive even though only a few steps passed.
  noteOutputTokens(state, 's1', 4000)
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'read', argsKey: 'b', chars: 1, digest: 'b' })
  const line = autoSchedule(state, 's1')
  assert.equal(line.directive?.kind, 'output-budget')
  assert.match(line.directive.text, /5600 output tokens/)

  // Once per turn, and the next turn starts from zero.
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'read', argsKey: 'c', chars: 2, digest: 'c' })
  assert.notEqual(autoSchedule(state, 's1').directive?.kind, 'output-budget')
  noteTurn(state, 's1')
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'read', argsKey: 'd', chars: 3, digest: 'd' })
  assert.equal(autoSchedule(state, 's1').directive, undefined, 'a new turn is charged from zero')
})

test('the shape gate goes silent on a write-dominated turn, and only for that turn', () => {
  const state = createAutoState()
  // Both reminders are armed, so silence can only come from the gate itself.
  notePolicy(state, 's1', { lateDiscipline: true, finishLineSteps: 1, shapeGate: true })

  // Three calls are not enough evidence: a turn often opens by reading.
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'write', argsKey: 'a', chars: 1, digest: 'a' })
  noteTool(state, 's1', { name: 'edit', argsKey: 'b', chars: 1, digest: 'b' })
  assert.equal(autoSchedule(state, 's1').directive?.kind, 'finish-line', 'the gate has not seen enough calls yet')

  // The fourth write tips it: the turn is a write job, so every reminder is a
  // round trip the work cannot reuse. Native behaviour means no directive.
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'write', argsKey: 'c', chars: 1, digest: 'c' })
  noteTool(state, 's1', { name: 'edit', argsKey: 'd', chars: 1, digest: 'd' })
  assert.equal(autoSchedule(state, 's1').directive, undefined, 'a write-dominated turn is left alone')

  // A read-dominated turn is business as usual.
  notePolicy(state, 's2', { lateDiscipline: true, finishLineSteps: 1, shapeGate: true })
  noteTurn(state, 's2')
  noteStep(state, 's2')
  for (let i = 0; i < 4; i += 1) noteTool(state, 's2', { name: 'read', argsKey: `r-${i}`, chars: 1, digest: `r-${i}` })
  assert.equal(autoSchedule(state, 's2').directive?.kind, 'finish-line', 'reads keep their reminders')

  // The next turn starts from zero calls, so the gate re-earns its evidence.
  noteTurn(state, 's1')
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'read', argsKey: 'e', chars: 1, digest: 'e' })
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'read', argsKey: 'f', chars: 2, digest: 'f' })
  // One schedule call, because the scheduler consumes its own reminder when it
  // produces one: asking twice would report the second, silent answer.
  const next = autoSchedule(state, 's1')
  assert.equal(next.stats.turnCalls, 2, 'the call counter restarts with the turn')
  assert.notEqual(next.directive, undefined, 'a new turn is not silenced by the last one')

  // An explicit step budget outranks the gate: a write-heavy turn still gets
  // the stop line the user asked for.
  notePolicy(state, 's4', { lateDiscipline: true, stepBudget: 2, shapeGate: true })
  noteTurn(state, 's4')
  noteStep(state, 's4')
  for (let i = 0; i < 4; i += 1) noteTool(state, 's4', { name: 'write', argsKey: `m-${i}`, chars: 1, digest: `m-${i}` })
  noteStep(state, 's4')
  assert.equal(autoSchedule(state, 's4').directive?.kind, 'stop-and-report', 'the user stop line beats the gate')

  // Default stays off: same evidence, no gate.
  notePolicy(state, 's3', { lateDiscipline: true, finishLineSteps: 1 })
  noteTurn(state, 's3')
  noteStep(state, 's3')
  for (let i = 0; i < 4; i += 1) noteTool(state, 's3', { name: 'write', argsKey: `w-${i}`, chars: 1, digest: `w-${i}` })
  assert.equal(autoSchedule(state, 's3').directive?.kind, 'finish-line', 'shapeGate is opt-in')
})

test('scheduler:false keeps the width and drops every reminder', () => {
  const state = createAutoState()
  notePolicy(state, 'quiet', { lateDiscipline: true, finishLineSteps: 1, scheduler: false })
  noteEntry(state, 'quiet', 3)
  noteTurn(state, 'quiet')
  for (let i = 0; i < 4; i += 1) cleanStep(state, 'quiet')
  noteStep(state, 'quiet')
  const quiet = autoSchedule(state, 'quiet')
  assert.equal(quiet.directive, undefined, 'the directive channel is off, so nothing is asked')
  assert.ok(quiet.parallel > 1, 'the fan-out width is not part of that channel')
  assert.ok(Number.isFinite(quiet.stallBudgetMs), 'and neither is the watchdog budget')

  // The same evidence without the switch does emit, so the silence above is the
  // switch and not an empty schedule.
  const loud = createAutoState()
  notePolicy(loud, 'loud', { lateDiscipline: true, finishLineSteps: 1 })
  noteEntry(loud, 'loud', 3)
  noteTurn(loud, 'loud')
  for (let i = 0; i < 4; i += 1) cleanStep(loud, 'loud')
  noteStep(loud, 'loud')
  assert.ok(autoSchedule(loud, 'loud').directive, 'the control arm asks for something')
})

test('a hard stop exists only when the user asks for a step budget', () => {
  const state = createAutoState()
  notePolicy(state, 's1', { lateDiscipline: false, stepBudget: 8, finishLineSteps: 0 })
  noteTurn(state, 's1')
  for (let i = 0; i < 8; i += 1) cleanStep(state, 's1')
  noteStep(state, 's1')
  const schedule = autoSchedule(state, 's1')
  assert.equal(schedule.stats.turnSteps, 9)
  assert.equal(schedule.directive?.kind, 'stop-and-report')

  // A turn with no configured budget keeps working: forty progressing steps and
  // no directive of any kind.
  const free = createAutoState()
  notePolicy(free, 's2', { lateDiscipline: false })
  noteTurn(free, 's2')
  let kinds = new Set()
  for (let i = 0; i < 40; i += 1) {
    noteStep(free, 's2')
    noteTool(free, 's2', { name: 'read', argsKey: `f-${i}`, chars: i, digest: `f-${i}` })
    const kind = autoSchedule(free, 's2').directive?.kind
    if (kind) kinds.add(kind)
  }
  const long = autoSchedule(free, 's2')
  assert.equal(long.stats.turnSteps, 40)
  assert.equal(kinds.has('stop-and-report'), false, 'a progressing 40-step turn is not told to stop')
  assert.equal(kinds.has('finish-line'), false)
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
  assert.equal(AUTO_LIMITS.parallelBase >= 2, true, 'the first probe is a real batch')
  assert.ok(AUTO_LIMITS.parallelMax <= 8)
  assert.ok(AUTO_LIMITS.stallFloorMs >= 60_000)
  assert.ok(AUTO_LIMITS.stallCeilMs >= AUTO_LIMITS.stallFloorMs)
  assert.equal(AUTO_LIMITS.turnStepBudget, 0, 'no default hard stop: a counter is not completion evidence')
  assert.equal(AUTO_LIMITS.finishLineSteps, 0, 'no default finish line: the reminder retires unverified work')
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

test("outputDiscipline 'late' stays silent until the turn is long, then clears its own flag", () => {
  const state = createAutoState()
  notePolicy(state, 's1', { lateDiscipline: true })
  noteTurn(state, 's1')
  for (let step = 0; step < AUTO_LIMITS.disciplineAfterSteps - 1; step += 1) cleanStep(state, 's1', 1)
  assert.equal(autoSchedule(state, 's1').directive, undefined, 'a short turn pays no prompt cost and no reminder')

  cleanStep(state, 's1', 1)
  const fired = autoSchedule(state, 's1')
  assert.equal(fired.directive?.kind, 'compress-output')
  assert.match(fired.directive.text, /remaining steps/)

  // One reminder per turn, and the next turn may ask again.
  for (let step = 0; step < AUTO_LIMITS.directiveCooldown + 1; step += 1) cleanStep(state, 's1', 1)
  assert.equal(autoSchedule(state, 's1').directive, undefined)
  noteTurn(state, 's1')
  for (let step = 0; step < AUTO_LIMITS.disciplineAfterSteps; step += 1) cleanStep(state, 's1', 1)
  assert.equal(autoSchedule(state, 's1').directive?.kind, 'compress-output')
})

test('the re-read sentence is opt-in and rides the existing reminder', () => {
  const plain = createAutoState()
  notePolicy(plain, 's1', { lateDiscipline: true })
  noteTurn(plain, 's1')
  for (let step = 0; step < AUTO_LIMITS.disciplineAfterSteps; step += 1) cleanStep(plain, 's1', 1)
  const plainText = autoSchedule(plain, 's1').directive?.text ?? ''
  assert.match(plainText, /remaining steps/)
  assert.doesNotMatch(plainText, /read the whole file again/, 'default behaviour is unchanged')

  const hint = createAutoState()
  notePolicy(hint, 's1', { lateDiscipline: true, rereadHint: true })
  noteTurn(hint, 's1')
  for (let step = 0; step < AUTO_LIMITS.disciplineAfterSteps; step += 1) cleanStep(hint, 's1', 1)
  const hinted = autoSchedule(hint, 's1')
  assert.equal(hinted.directive?.kind, 'compress-output', 'the sentence does not add a second reminder')
  assert.match(hinted.directive.text, /read the whole file again just to confirm/)
  // Still one message: the next step stays silent.
  assert.equal(autoSchedule(hint, 's1').directive, undefined)
})

test('without the late policy the scheduler never emits the compression reminder', () => {
  const state = createAutoState()
  notePolicy(state, 's1', { lateDiscipline: false })
  noteTurn(state, 's1')
  for (let step = 0; step < AUTO_LIMITS.disciplineAfterSteps + 2; step += 1) cleanStep(state, 's1', 1)
  assert.equal(autoSchedule(state, 's1').directive, undefined)
})

test('disciplineAfterSteps moves the compression reminder, and 0 keeps the built-in step', () => {
  // The reminder has the only measured effect in this plugin, so its entry step
  // is a real knob: the same turn must fire earlier when the caller asks for it.
  const early = createAutoState()
  notePolicy(early, 's1', { lateDiscipline: true, disciplineAfterSteps: 2 })
  noteTurn(early, 's1')
  cleanStep(early, 's1', 1)
  assert.equal(autoSchedule(early, 's1').directive, undefined, 'still quiet at step 1')
  cleanStep(early, 's1', 1)
  assert.equal(autoSchedule(early, 's1').directive?.kind, 'compress-output', 'fires at the requested step')

  // 0 is not "step 0": it is "use the built-in default", so the shipped behaviour
  // of every existing caller is untouched.
  const fallback = createAutoState()
  notePolicy(fallback, 's1', { lateDiscipline: true, disciplineAfterSteps: 0 })
  noteTurn(fallback, 's1')
  for (let step = 0; step < AUTO_LIMITS.disciplineAfterSteps - 1; step += 1) cleanStep(fallback, 's1', 1)
  assert.equal(autoSchedule(fallback, 's1').directive, undefined)
  cleanStep(fallback, 's1', 1)
  assert.equal(autoSchedule(fallback, 's1').directive?.kind, 'compress-output')
})

test('disciplineEarlyCalls only spends an early reminder on a turn that already made calls', () => {
  // The early entry is a bet that the turn will be long, and the first step's
  // call count is the bet's price signal: one call is a single-file task, two is
  // a multi-file or debug task. Spending it unconditionally measured 1.073x
  // slower on the single-file family (D2_IMPL, 8 pairs), so the gate is the fix.
  const sparse = createAutoState()
  notePolicy(sparse, 's1', { lateDiscipline: true, disciplineAfterSteps: 2, disciplineEarlyCalls: 2 })
  noteTurn(sparse, 's1')
  cleanStep(sparse, 's1', 1)
  assert.equal(autoSchedule(sparse, 's1').directive, undefined, 'one call in the first step keeps the built-in step')
  // The bet is settled once from the first step and then frozen: a turn that
  // started sparse must not drift back into the early slot just because its
  // cumulative call count caught up mid-turn.
  cleanStep(sparse, 's1', 3)
  assert.equal(autoSchedule(sparse, 's1').directive, undefined, 'a dense step after a sparse start does not re-price the bet')
  cleanStep(sparse, 's1', 3)
  assert.equal(autoSchedule(sparse, 's1').directive, undefined, 'still quiet before the built-in step')
  cleanStep(sparse, 's1', 1)
  assert.equal(autoSchedule(sparse, 's1').directive?.kind, 'compress-output', 'falls back to the built-in step')

  const dense = createAutoState()
  notePolicy(dense, 's1', { lateDiscipline: true, disciplineAfterSteps: 2, disciplineEarlyCalls: 2 })
  noteTurn(dense, 's1')
  cleanStep(dense, 's1', 2)
  cleanStep(dense, 's1', 1)
  assert.equal(autoSchedule(dense, 's1').directive?.kind, 'compress-output', 'two calls earn the early entry')

  // 0 is the shipped behaviour: the early step applies to every turn.
  const open = createAutoState()
  notePolicy(open, 's1', { lateDiscipline: true, disciplineAfterSteps: 2, disciplineEarlyCalls: 0 })
  noteTurn(open, 's1')
  cleanStep(open, 's1', 1)
  cleanStep(open, 's1', 1)
  assert.equal(autoSchedule(open, 's1').directive?.kind, 'compress-output', '0 keeps the early entry unconditional')
})

test('disciplineRepeatAtSteps repeats the same ask once, and 0 never repeats it', () => {
  // The first reminder is once per turn; a long turn drifts back to prose after
  // it, so the repeat is the cheapest way to re-arm the rule. It must still be
  // exactly one extra message: a reminder per step would be the noise it warns about.
  const state = createAutoState()
  notePolicy(state, 's1', { lateDiscipline: true, disciplineRepeatAtSteps: 8 })
  noteTurn(state, 's1')
  for (let step = 0; step < AUTO_LIMITS.disciplineAfterSteps; step += 1) cleanStep(state, 's1', 1)
  assert.equal(autoSchedule(state, 's1').directive?.kind, 'compress-output', 'first reminder at the entry step')
  for (let step = AUTO_LIMITS.disciplineAfterSteps; step < 7; step += 1) {
    cleanStep(state, 's1', 1)
    assert.equal(autoSchedule(state, 's1').directive, undefined, 'no repeat before its step')
  }
  cleanStep(state, 's1', 1)
  const repeat = autoSchedule(state, 's1')
  assert.equal(repeat.directive?.kind, 'compress-output', 'repeats at the requested step')
  assert.match(repeat.directive.text, /still long/)
  for (let step = 8; step < 14; step += 1) {
    cleanStep(state, 's1', 1)
    assert.equal(autoSchedule(state, 's1').directive, undefined, 'only one repeat per turn')
  }

  // Off by default, and 0 is a value: nothing changes for existing callers.
  const quiet = createAutoState()
  notePolicy(quiet, 's1', { lateDiscipline: true, disciplineRepeatAtSteps: 0 })
  noteTurn(quiet, 's1')
  for (let step = 0; step < AUTO_LIMITS.disciplineAfterSteps; step += 1) cleanStep(quiet, 's1', 1)
  assert.equal(autoSchedule(quiet, 's1').directive?.kind, 'compress-output', 'the first reminder still fires')
  for (let step = AUTO_LIMITS.disciplineAfterSteps; step < 12; step += 1) {
    cleanStep(quiet, 's1', 1)
    assert.equal(autoSchedule(quiet, 's1').directive, undefined, 'no second reminder with the repeat off')
  }
})

test('batchVerify waits for a second unverified write and asks only once', () => {
  const state = createAutoState()
  notePolicy(state, 's1', { lateDiscipline: false, batchVerify: true })
  noteTurn(state, 's1')
  // One write is a normal edit, not a batch: the reminder would be noise.
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'write', argsKey: 'src/a.js', chars: 40 })
  assert.equal(autoSchedule(state, 's1').directive, undefined, 'not after the first write')

  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'write', argsKey: 'src/b.js', chars: 40 })
  const fired = autoSchedule(state, 's1')
  assert.equal(fired.directive?.kind, 'batch-verify')
  assert.match(fired.directive.text, /one check that covers all of them/)

  // A verified batch resets the counter; the same turn does not ask twice.
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'write', argsKey: 'src/c.js', chars: 40 })
  for (let step = 0; step < AUTO_LIMITS.directiveCooldown + 1; step += 1) cleanStep(state, 's1', 2)
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'write', argsKey: 'src/d.js', chars: 40 })
  assert.equal(autoSchedule(state, 's1').directive?.kind, 'batch-verify', 'a new turn may ask again')
})

test('the finish line fires once at its step and never again in the same turn', () => {
  const state = createAutoState()
  notePolicy(state, 's1', { lateDiscipline: false, stepBudget: 30, finishLineSteps: 5 })
  noteTurn(state, 's1')

  for (let step = 0; step < 4; step += 1) cleanStep(state, 's1', 1)
  assert.equal(autoSchedule(state, 's1').directive, undefined, 'nothing before the line')

  cleanStep(state, 's1', 1)
  const line = autoSchedule(state, 's1')
  assert.equal(line.directive?.kind, 'finish-line')
  assert.match(line.directive.text, /finish line/)
  assert.match(line.directive.text, /Fix only what still fails/)

  // The reminder is one-shot: the turn may run on, but not with a second line.
  for (let step = 0; step < AUTO_LIMITS.directiveCooldown + 2; step += 1) cleanStep(state, 's1', 1)
  assert.notEqual(autoSchedule(state, 's1').directive?.kind, 'finish-line')
})

test('the opening batch line fires once on the first step and not again', () => {
  const state = createAutoState()
  notePolicy(state, 's1', { lateDiscipline: false, finishLineSteps: 0, openBatch: true })
  noteTurn(state, 's1')
  noteStep(state, 's1')
  const first = autoSchedule(state, 's1').directive
  assert.equal(first?.kind, 'open-batch', 'the opening step is the only one that pays for a reminder')
  assert.match(first.text, /chain shell commands with &&/)
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').directive?.kind, undefined, 'once per turn')

  noteTurn(state, 's1')
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').directive?.kind, 'open-batch', 're-armed for the next turn')
})

test('the opening batch line is off unless the policy asks for it', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').directive?.kind, undefined)
})

test('the default policy never announces a finish line on its own', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  const kinds = new Set()
  for (let step = 1; step <= 40; step += 1) {
    cleanStep(state, 's1')
    const kind = autoSchedule(state, 's1').directive?.kind
    if (kind) kinds.add(kind)
  }
  assert.equal(kinds.has('finish-line'), false)
  assert.equal(kinds.has('stop-and-report'), false)
})

test('a long default-policy turn is never told to stop, not even past two hundred steps', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  const kinds = new Set()
  for (let step = 1; step <= 200; step += 1) {
    cleanStep(state, 's1')
    noteOutputTokens(state, 's1', 800)
    const directive = autoSchedule(state, 's1').directive
    if (!directive) continue
    kinds.add(directive.kind)
    // A turn the user did not budget must never be handed a stop instruction,
    // however long it runs: the bug this locks was a mid-task forced stop.
    assert.doesNotMatch(directive.text, /\bstop\b|report instead/i,
      `the default policy must never end a turn on a counter (${directive.kind})`)
  }
  for (const kind of ['stop-and-report', 'finish-line', 'output-budget']) {
    assert.equal(kinds.has(kind), false, `${kind} must stay off under the default policy`)
  }
})

test('stepBudget: 0 means off, and a missing policy is off too', () => {
  for (const policy of [{ lateDiscipline: false, stepBudget: 0 }, { lateDiscipline: false }, undefined]) {
    const state = createAutoState()
    if (policy !== undefined) notePolicy(state, 's1', policy)
    noteTurn(state, 's1')
    let kind
    for (let step = 1; step <= 40; step += 1) {
      cleanStep(state, 's1', 1)
      kind = kind ?? autoSchedule(state, 's1').directive?.kind
    }
    assert.equal(kind, undefined, `policy ${JSON.stringify(policy)} must not stop the turn`)
  }
})

test('a verbatim rerun of a passing check is offered for reuse, once per artifact version', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  notePolicy(state, 's1', { lateDiscipline: false })
  const check = { name: 'bash', argsKey: '{"command":"python3 -m unittest"}', chars: 42, digest: 'ok' }

  noteStep(state, 's1')
  noteTool(state, 's1', check)
  noteStep(state, 's1')
  // Second identical run while nothing wrote: the result is still valid.
  noteStep(state, 's1')
  noteTool(state, 's1', check)
  noteStep(state, 's1')
  const repeat = autoSchedule(state, 's1')
  assert.equal(repeat.directive?.kind, 'reuse-check')
  assert.match(repeat.directive.text, /already passed verbatim this turn/)
  assert.match(repeat.directive.text, /no write or unrecognised shell command has run since/)
  assert.match(repeat.directive.text, /only after the files it covers change/)

  for (let i = 0; i < AUTO_LIMITS.directiveCooldown; i += 1) noteStep(state, 's1')
  assert.notEqual(autoSchedule(state, 's1').directive?.kind, 'reuse-check', 'once per artifact version')

  // A test runner is a shell call that a conservative mutation list also reads
  // as a writer (`npm`/`make`): the verbatim repeat must still be recognised,
  // or the reminder could never fire for the command it targets.
  const runner = createAutoState()
  noteTurn(runner, 's1')
  notePolicy(runner, 's1', { lateDiscipline: false })
  const npm = { name: 'bash', argsKey: '{"command":"npm test"}', chars: 42, digest: 'ok' }
  noteStep(runner, 's1')
  noteTool(runner, 's1', npm)
  noteStep(runner, 's1')
  noteStep(runner, 's1')
  noteTool(runner, 's1', npm)
  noteStep(runner, 's1')
  assert.equal(autoSchedule(runner, 's1').directive?.kind, 'reuse-check', 'a verbatim `npm test` rerun is reusable')
  noteTool(runner, 's1', { name: 'write', argsKey: 'calclang.py', chars: 3 })
  for (let i = 0; i < AUTO_LIMITS.directiveCooldown + 1; i += 1) noteStep(runner, 's1')
  noteTool(runner, 's1', npm)
  noteStep(runner, 's1')
  for (let i = 0; i < AUTO_LIMITS.directiveCooldown + 1; i += 1) noteStep(runner, 's1')
  assert.notEqual(autoSchedule(runner, 's1').directive?.kind, 'reuse-check',
    'the runner checked before a write is not reusable after it')

  // Any write invalidates the stored result: the check must run again.
  noteStep(state, 's1')
  noteTool(state, 's1', { name: 'write', argsKey: 'calclang.py', chars: 3 })
  noteStep(state, 's1')
  noteTool(state, 's1', check)
  noteStep(state, 's1')
  for (let i = 0; i < AUTO_LIMITS.directiveCooldown + 1; i += 1) noteStep(state, 's1')
  assert.notEqual(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
    'a check after a write is not a reusable result')
})

test('a repeated read or grep is never registered as a reusable check', () => {
  const read = { name: 'read', argsKey: '{"file_path":"src/auto.js"}', chars: 40, digest: 'same' }
  const reader = createAutoState()
  noteTurn(reader, 's1')
  notePolicy(reader, 's1', { lateDiscipline: false })
  noteStep(reader, 's1')
  noteTool(reader, 's1', read)
  noteStep(reader, 's1')
  noteStep(reader, 's1')
  noteTool(reader, 's1', read)
  noteStep(reader, 's1')
  assert.notEqual(autoSchedule(reader, 's1').directive?.kind, 'reuse-check',
    'a read carries no proof about an artifact')

  const grep = { name: 'bash', argsKey: '{"command":"grep -n calc src/auto.js"}', chars: 80, digest: 'hits' }
  const shell = createAutoState()
  noteTurn(shell, 's1')
  notePolicy(shell, 's1', { lateDiscipline: false })
  noteStep(shell, 's1')
  noteTool(shell, 's1', grep)
  noteStep(shell, 's1')
  noteStep(shell, 's1')
  noteTool(shell, 's1', grep)
  noteStep(shell, 's1')
  assert.notEqual(autoSchedule(shell, 's1').directive?.kind, 'reuse-check',
    'a read-only shell command is not a check')
})

test('an unrecognised shell command withdraws a stored pass, and a fresh pass restores reuse', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  notePolicy(state, 's1', { lateDiscipline: false })
  const check = { name: 'bash', argsKey: '{"command":"npm test"}', chars: 42, digest: 'ok' }
  toReuseHint(state, 's1', check)
  // `python3 gen.py` could rewrite anything: the scheduler cannot vouch for it.
  noteTool(state, 's1', { name: 'bash', argsKey: '{"command":"python3 gen.py"}', chars: 5, digest: 'gen' })
  noteStep(state, 's1')
  assert.notEqual(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
    'an unclassified shell command invalidates the pass')

  // Re-running once is not enough to reuse: the new result has to repeat.
  noteStep(state, 's1')
  noteTool(state, 's1', check)
  noteStep(state, 's1')
  assert.notEqual(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
    'the first pass after an invalidation is fresh evidence, not a cached one')
  noteTool(state, 's1', check)
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
    'two passes on the same artifact version are reusable again')
})

test('rewriting an artifact with a script suppresses the reminder for the old pass', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  notePolicy(state, 's1', { lateDiscipline: false })
  const check = { name: 'bash', argsKey: '{"command":"python3 -m unittest"}', chars: 42, digest: 'ok' }
  toReuseHint(state, 's1', check)
  // A script that rewrites the tested file is a write the write-tool detector
  // never saw; it must still withdraw the pass.
  noteTool(state, 's1', {
    name: 'bash',
    argsKey: '{"command":"python3 rewrite_calc.py"}',
    chars: 8,
    digest: 'rewritten',
  })
  noteStep(state, 's1')
  assert.notEqual(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
    'a rewrite outside the write tools invalidates the pass')
})

test('a read-only command between passes leaves the stored pass reusable', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  notePolicy(state, 's1', { lateDiscipline: false })
  const check = { name: 'bash', argsKey: '{"command":"node --test test/auto.test.js"}', chars: 42, digest: 'green' }
  toReuseHint(state, 's1', check)
  noteTool(state, 's1', { name: 'bash', argsKey: '{"command":"cat src/auto.js"}', chars: 400, digest: 'content' })
  noteTool(state, 's1', { name: 'bash', argsKey: '{"command":"git diff --stat"}', chars: 90, digest: 'diff' })
  noteStep(state, 's1')
  assert.equal(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
    'reading the files does not invalidate a pass')
})

test('a file that changed on disk after the pass withdraws the reminder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-'))
  const file = join(dir, 'calc.py')
  try {
    const state = createAutoState()
    noteTurn(state, 's1')
    notePolicy(state, 's1', { lateDiscipline: false })
    writeFileSync(file, 'print(1)\n')
    noteTool(state, 's1', {
      name: 'write',
      argsKey: JSON.stringify({ path: file, content: 'print(1)\n' }),
      chars: 9,
    })
    const check = { name: 'bash', argsKey: '{"command":"python3 -m unittest"}', chars: 42, digest: 'ok' }
    noteStep(state, 's1')
    noteTool(state, 's1', check)
    noteStep(state, 's1')
    noteStep(state, 's1')
    noteTool(state, 's1', check)
    // The same tool calls, but the file changed behind them.
    writeFileSync(file, 'print(1)\nprint(2)\n')
    noteStep(state, 's1')
    assert.notEqual(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
      'a file the pass covered changed on disk')

    // After the pass runs again, its evidence is the version on disk now.
    noteStep(state, 's1')
    noteTool(state, 's1', check)
    noteTool(state, 's1', check)
    cooldownSteps(state, 's1')
    assert.equal(autoSchedule(state, 's1').directive?.kind, 'reuse-check')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a write is tracked through the untruncated argument, not the dedupe key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-'))
  const file = join(dir, 'calc.py')
  try {
    const state = createAutoState()
    noteTurn(state, 's1')
    notePolicy(state, 's1', { lateDiscipline: false })
    writeFileSync(file, 'print(1)\n')
    // The dedupe key sorts keys and cuts at 400 chars, so a large `content`
    // pushes `path` out of it. A scheduler that tracked the key would see no
    // file here, call the write unresolvable, and stop offering reuse at all.
    noteTool(state, 's1', {
      name: 'write',
      argsKey: JSON.stringify({ content: 'x'.repeat(600), path: file }),
      paths: [file],
      chars: 9,
    })
    const check = {
      name: 'bash',
      argsKey: '{"command":"python3 -m unittest"}',
      command: 'python3 -m unittest',
      chars: 42,
      digest: 'ok',
    }
    toReuseHint(state, 's1', check)
    cooldownSteps(state, 's1')
    assert.equal(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
      'the tracked file still matches the pass')
    writeFileSync(file, 'print(1)\nprint(2)\n')
    noteStep(state, 's1')
    assert.notEqual(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
      'the changed file withdraws the pass even though the key never named it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a relative write resolves against the session cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-'))
  try {
    const state = createAutoState()
    noteTurn(state, 's1')
    notePolicy(state, 's1', { lateDiscipline: false })
    writeFileSync(join(dir, 'calc.py'), 'print(1)\n')
    noteTool(state, 's1', {
      name: 'write',
      argsKey: '{"path":"calc.py"}',
      paths: ['calc.py'],
      cwd: dir,
      chars: 9,
    })
    const check = {
      name: 'bash',
      argsKey: '{"command":"python3 -m unittest"}',
      command: 'python3 -m unittest',
      chars: 42,
      digest: 'ok',
    }
    toReuseHint(state, 's1', check)
    cooldownSteps(state, 's1')
    assert.equal(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
      'resolving against the cwd keeps the write tracked, so the pass stays reusable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unresolvable write target disables reuse for the rest of the session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-'))
  const file = join(dir, 'calc.py')
  try {
    const state = createAutoState()
    noteTurn(state, 's1')
    notePolicy(state, 's1', { lateDiscipline: false })
    writeFileSync(file, 'print(1)\n')
    noteTool(state, 's1', { name: 'write', argsKey: '{"path":"calc.py"}', paths: [file], chars: 9 })
    // A patch carries its targets inside the patch body, which the argument
    // fields never name. Keeping the pass would be a guess, so honesty costs the
    // remaining reminders in this session.
    noteTool(state, 's1', { name: 'apply_patch', argsKey: '*** Begin Patch', chars: 180 })
    const check = {
      name: 'bash',
      argsKey: '{"command":"python3 -m unittest"}',
      command: 'python3 -m unittest',
      chars: 42,
      digest: 'ok',
    }
    toReuseHint(state, 's1', check)
    cooldownSteps(state, 's1')
    assert.notEqual(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
      'a write the scheduler cannot locate makes the pass unverifiable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a patch that names its files keeps the pass reusable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-'))
  try {
    const state = createAutoState()
    noteTurn(state, 's1')
    notePolicy(state, 's1', { lateDiscipline: false })
    writeFileSync(join(dir, 'calc.py'), 'print(1)\n')
    noteTool(state, 's1', {
      name: 'write',
      argsKey: '{"path":"calc.py"}',
      paths: ['calc.py'],
      cwd: dir,
      chars: 9,
    })
    // The target lives in the patch body. Reading the headers is what keeps the
    // session's reuse evidence alive on the common edit path.
    const patch = '*** Begin Patch\n*** Update File: calc.py\n@@ -1 +1 @@\n-print(1)\n+print(2)\n*** End Patch\n'
    const targets = toolTargets({ patch }, 'apply_patch')
    assert.deepEqual(targets.paths, ['calc.py'])
    noteTool(state, 's1', {
      name: 'apply_patch',
      argsKey: '*** Begin Patch',
      paths: targets.paths,
      cwd: dir,
      chars: 180,
    })
    const check = {
      name: 'bash',
      argsKey: '{"command":"python3 -m unittest"}',
      command: 'python3 -m unittest',
      chars: 42,
      digest: 'ok',
    }
    toReuseHint(state, 's1', check)
    cooldownSteps(state, 's1')
    assert.equal(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
      'a patch header resolves the target, so the pass stays verifiable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('patch targets come from the body, not from unrelated path fields', () => {
  const patch = [
    '*** Update File: src/a.js',
    '*** Add File: src/b.js',
    '*** Move to: src/c.js',
    '*** Delete File: src/gone.js',
    '+++ b/src/uni.js\t2024-01-01',
  ].join('\n')
  assert.deepEqual(toolTargets({ patch }, 'apply_patch').paths, [
    'src/a.js',
    'src/b.js',
    'src/c.js',
    'src/uni.js',
  ])
  // Only patch-shaped tools are scanned: a whole-file write may legitimately
  // contain diff-looking text, and its own path field is the truth.
  assert.deepEqual(toolTargets({ path: 'x.js', content: '@@ +++ b/evil' }, 'write').paths, ['x.js'])
  assert.deepEqual(toolTargets({ path: 'x.js', patch }, 'write').paths, ['x.js'])
})

test('a failing rerun withdraws the pass it contradicts', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  notePolicy(state, 's1', { lateDiscipline: false })
  const check = { name: 'bash', argsKey: '{"command":"npm test"}', chars: 42, digest: 'ok' }
  toReuseHint(state, 's1', check)
  noteTool(state, 's1', { ...check, isError: true, digest: 'fail' })
  noteStep(state, 's1')
  assert.notEqual(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
    'a check that now fails cannot be reused from an earlier pass')
})

test('a read-only command that can delete is not read-only', () => {
  const state = createAutoState()
  noteTurn(state, 's1')
  notePolicy(state, 's1', { lateDiscipline: false })
  const check = { name: 'bash', argsKey: '{"command":"npm test"}', chars: 42, digest: 'ok' }
  toReuseHint(state, 's1', check)
  noteTool(state, 's1', {
    name: 'bash',
    argsKey: '{"command":"find . -name x -delete"}',
    chars: 4,
    digest: 'gone',
  })
  noteStep(state, 's1')
  assert.notEqual(autoSchedule(state, 's1').directive?.kind, 'reuse-check',
    'a command that deletes files cannot leave a pass valid')
})
