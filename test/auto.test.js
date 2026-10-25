import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUTO,
  AUTO_LIMITS,
  AUTO_SESSIONS,
  autoSchedule,
  createAutoState,
  describeSchedule,
  noteOutputTokens,
  notePolicy,
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

/** One repeated call: same signature, same content, so no progress. */
function repeatCall(state, agent, chars = 100) {
  noteTool(state, agent, { name: 'shell', argsKey: 'tail log', chars, digest: `tail:${chars}` })
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

test('without the late policy the scheduler never emits the compression reminder', () => {
  const state = createAutoState()
  notePolicy(state, 's1', { lateDiscipline: false })
  noteTurn(state, 's1')
  for (let step = 0; step < AUTO_LIMITS.disciplineAfterSteps + 2; step += 1) cleanStep(state, 's1', 1)
  assert.equal(autoSchedule(state, 's1').directive, undefined)
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
  const check = { name: 'shell', argsKey: 'python3 -m unittest', chars: 42, digest: 'ok' }

  noteStep(state, 's1')
  noteTool(state, 's1', check)
  noteStep(state, 's1')
  // Second identical run while nothing wrote: the result is still valid.
  noteStep(state, 's1')
  noteTool(state, 's1', check)
  noteStep(state, 's1')
  const repeat = autoSchedule(state, 's1')
  assert.equal(repeat.directive?.kind, 'reuse-check')
  assert.match(repeat.directive.text, /already passed on the current files/)

  for (let i = 0; i < AUTO_LIMITS.directiveCooldown; i += 1) noteStep(state, 's1')
  assert.notEqual(autoSchedule(state, 's1').directive?.kind, 'reuse-check', 'once per artifact version')

  // A test runner is a shell call that a conservative mutation list also reads
  // as a writer (`npm`/`make`): the verbatim repeat must still be recognised,
  // or the reminder could never fire for the command it targets.
  const runner = createAutoState()
  noteTurn(runner, 's1')
  notePolicy(runner, 's1', { lateDiscipline: false })
  const npm = { name: 'bash', argsKey: 'npm test', chars: 42, digest: 'ok' }
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
