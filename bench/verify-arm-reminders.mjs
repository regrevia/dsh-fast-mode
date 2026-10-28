#!/usr/bin/env node
/**
 * Offline check that a bench arm actually emits the reminders it claims to test.
 *
 * Drives the real scheduler (`src/auto.js`) in the same order `index.js` does at
 * a step boundary — `noteEntry` once per turn, then per step `noteStep` →
 * `notePolicy(resolvedConfig)` → `autoSchedule(...)` — and feeds it synthetic
 * tool calls. No model run, no network, no tokens: the reminder channel is not
 * recorded in `~/.dsh/fast-mode-metrics.jsonl` (no `directive` field there), so
 * this is the only cheap way to see what an arm can emit.
 *
 * Why this file exists: `bench/arms/disc-only.yml` used to set
 * `scheduler: false` while asking for `outputDiscipline: 'late'`. The late
 * reminder is delivered *by the scheduler*, so that arm emitted nothing and
 * measured a no-op. Two modes keep that from recurring silently:
 *
 *   node bench/verify-arm-reminders.mjs --mechanisms   # each switch, on vs off
 *   node bench/verify-arm-reminders.mjs                # what each arm emits
 *
 * `--mechanisms` is pass/fail: for every mechanism it runs one turn with the
 * switch on (expect the reminder at a given step) and one with the switch that
 * silences it (expect no such reminder). The arm matrix is informational and
 * prints the resolved switches next to the emitted kinds.
 */
import { pathToFileURL } from 'node:url'
import { createAutoState, noteEntry, noteOutputTokens, notePolicy, noteStep, noteTool, noteTurn, autoSchedule } from '../src/auto.js'
import { armPolicy } from './arm-config.mjs'
import { resolveConfig } from '../src/effort.js'

function read(path, chars) {
  return { name: 'read', argsKey: `path=${path}`, chars, digest: `d:${path}:${chars}` }
}

function write(path, chars) {
  return { name: 'write', argsKey: `path=${path}`, argChars: chars, chars, digest: `w:${path}` }
}

function edit(path, n) {
  return { name: 'edit', argsKey: `path=${path}`, chars: 300, digest: `e:${path}:${n}` }
}

function verify() {
  return {
    name: 'bash',
    command: 'python3 -m unittest test_visible.py',
    argsKey: 'command=python3 -m unittest test_visible.py',
    chars: 200,
    digest: 'ok:1',
  }
}

/** One turn's call stream. `tokensPerStep` feeds the output-budget counter. */
const SCENARIOS = {
  'long-read': {
    steps: 10, width: 4, tokensPerStep: 0,
    calls: step => [read(`src/a${step}.py`, 1000 + step), read(`src/b${step}.py`, 900 + step)],
  },
  stall: { steps: 10, width: 1, calls: () => [read('src/same.py', 500)] },
  'repeat-check': { steps: 5, width: 1, calls: () => [verify()] },
  'patch-hint': {
    steps: 4, width: 1,
    calls: step => (step === 1 ? [write('src/big.py', 4000)] : [read('src/big.py', 4100)]),
  },
  'batch-edit': {
    steps: 4, width: 1,
    calls: step => (step <= 2 ? [edit(`src/f${step}.py`, step)] : [read('src/f1.py', 300)]),
  },
  'token-heavy': {
    steps: 4, width: 1, tokensPerStep: 3000,
    calls: step => [read(`src/c${step}.py`, 100)],
  },
  'step-budget': { steps: 6, width: 1, calls: step => [read(`src/h${step}.py`, 100)] },
}

/**
 * Mechanisms and the config that owns each one. `on` is the smallest change that
 * enables it, `off` the smallest change that removes it — both merged over the
 * schema defaults, so the only thing under test is the switch itself.
 *
 * The `no dedicated key` rows are the point of the table: `reuse-check` and the
 * stall reminder are gated only by the scheduler, so `scheduler: false` is the
 * only way to silence them.
 */
const MECHANISMS = {
  'compress-output': {
    mechanism: 'late output reminder',
    on: { lateDiscipline: true }, off: { lateDiscipline: true, scheduler: false },
    scenario: 'long-read', expect: 'compress-output', step: 4,
    note: "outputDiscipline: 'late' — delivered by the scheduler",
  },
  'compress-output-repeat': {
    mechanism: 'second output reminder',
    on: { lateDiscipline: true, disciplineRepeatAtSteps: 8 },
    off: { lateDiscipline: true, disciplineRepeatAtSteps: 8, scheduler: false },
    scenario: 'long-read', expect: 'compress-output', step: 8,
    note: 'disciplineRepeatAtSteps: 8',
  },
  'change-approach': {
    mechanism: 'stall reminder (6 steps without progress)',
    on: { lateDiscipline: false }, off: { lateDiscipline: false, scheduler: false },
    scenario: 'stall', expect: 'change-approach', step: 8,
    note: 'no dedicated key; scheduler: false is the only switch',
  },
  'reuse-check': {
    mechanism: 'reuse a passing check',
    on: { lateDiscipline: false }, off: { lateDiscipline: false, scheduler: false },
    scenario: 'repeat-check', expect: 'reuse-check', step: 3,
    note: 'no dedicated key; scheduler: false is the only switch',
  },
  'open-batch': {
    mechanism: 'batch the opening step',
    on: { lateDiscipline: false, openBatch: true }, off: { lateDiscipline: false, openBatch: false },
    scenario: 'long-read', expect: 'open-batch', step: 1, note: 'openBatch: true',
  },
  'prefer-patch': {
    mechanism: 'hunks instead of a whole-file write',
    on: { lateDiscipline: false, preferPatch: true }, off: { lateDiscipline: false, preferPatch: false },
    scenario: 'patch-hint', expect: 'prefer-patch', step: 2, note: 'preferPatch: true',
  },
  'batch-verify': {
    mechanism: 'one covering check per edit batch',
    on: { lateDiscipline: false, batchVerify: true }, off: { lateDiscipline: false, batchVerify: false },
    scenario: 'batch-edit', expect: 'batch-verify', step: 3, note: 'batchVerify: true',
  },
  'output-budget': {
    mechanism: 'output token budget',
    on: { lateDiscipline: false, outputBudget: 5000 }, off: { lateDiscipline: false, outputBudget: 0 },
    scenario: 'token-heavy', expect: 'output-budget', step: 2, note: 'outputBudget: 5000',
  },
  'finish-line': {
    mechanism: 'stop adding scope at the finish line',
    on: { lateDiscipline: false, finishLineSteps: 3 }, off: { lateDiscipline: false, finishLineSteps: 0 },
    scenario: 'long-read', expect: 'finish-line', step: 3, note: 'finishLineSteps: 3',
  },
  'stop-and-report': {
    mechanism: 'hard stop at the user step budget',
    on: { lateDiscipline: false, stepBudget: 4 }, off: { lateDiscipline: false, stepBudget: 0 },
    scenario: 'step-budget', expect: 'stop-and-report', step: 4, note: 'stepBudget: 4',
  },
}

/** Drive one turn with one resolved policy; return every delivered reminder. */
export function simulate(resolved, scenario) {
  if (resolved.enabled !== true) return []
  const state = createAutoState()
  const agent = 'bench'
  noteTurn(state, agent)
  const events = []
  for (let step = 1; step <= scenario.steps; step += 1) {
    noteEntry(state, agent, scenario.width)
    noteStep(state, agent)
    notePolicy(state, agent, resolved)
    if (scenario.tokensPerStep) noteOutputTokens(state, agent, scenario.tokensPerStep)
    const schedule = autoSchedule(state, agent)
    if (schedule.directive) {
      events.push({ step, turnStep: schedule.stats.turnSteps, kind: schedule.directive.kind })
    }
    for (const call of scenario.calls(step)) noteTool(state, agent, call)
  }
  return events
}

const DEFAULTS = resolveConfig({ enabled: true, gear: 'auto', metrics: false })

function armFile(name) {
  return new URL(`./arms/${name}.yml`, import.meta.url).pathname
}

function show(events) {
  return events.length === 0 ? '(none)' : events.map(e => `${e.kind}@step${e.step}`).join(', ')
}

function mechanisms() {
  let failures = 0
  console.log('mechanism          on                                   silent')
  for (const [id, m] of Object.entries(MECHANISMS)) {
    const scenario = SCENARIOS[m.scenario]
    const on = simulate({ ...DEFAULTS, ...m.on }, scenario)
    const off = simulate({ ...DEFAULTS, ...m.off }, scenario)
    const hit = on.find(e => e.kind === m.expect)
    const onOk = on.some(e => e.kind === m.expect && e.step === m.step)
    const offOk = off.every(e => e.kind !== m.expect)
    if (!onOk || !offOk) failures += 1
    const flag = onOk && offOk ? 'PASS' : 'FAIL'
    console.log(`${flag}  ${id.padEnd(22)} ${show(on).padEnd(36)} ${show(off)}`)
    console.log(`      switch: ${m.note}`)
  }
  console.log(`\n${failures === 0 ? 'OK — every switch is reachable and every silencer is effective' : `${failures} mechanism(s) failed`}`)
  return failures
}

function armMatrix(arms) {
  const checks = [
    // Fixed arm: the reminder this arm is named after is delivered, once, at step 4.
    { arm: 'disc-only', scenario: 'long-read', expect: 'compress-output', step: 4 },
    // Same arm with the old file's `scheduler: false`: the channel is gone.
    { arm: 'disc-only', scenario: 'long-read', override: { scheduler: false }, expect: null,
      label: 'disc-only + scheduler:false (the old file)' },
    // The other two arms put pressure on the prompt, not on a reminder.
    { arm: 'disc-on', scenario: 'long-read', expect: null },
    { arm: 'disc-off', scenario: 'long-read', expect: null },
    { arm: 'def15', scenario: 'long-read', expect: null },
    { arm: 'off', scenario: 'long-read', expect: null },
    // Reminders with no dedicated switch cannot be silenced per mechanism.
    { arm: 'disc-only', scenario: 'stall', expect: 'change-approach' },
    { arm: 'disc-only', scenario: 'repeat-check', expect: 'reuse-check' },
  ]
  let failures = 0
  for (const arm of arms) {
    const { resolved } = armPolicy(armFile(arm))
    const switches = [
      `enabled=${resolved.enabled}`, `scheduler=${resolved.scheduler}`,
      `lateDiscipline=${resolved.lateDiscipline}`, `discipline=${resolved.discipline}`,
      `guidance=${resolved.guidance}`, `parallel=${resolved.parallel}`,
    ].join(' ')
    console.log(`\narm ${arm}  ${switches}`)
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      const events = simulate(resolved, scenario)
      const kinds = events.map(e => e.kind)
      const want = checks.filter(c => c.arm === arm && c.scenario === name && !c.override)
      const unmatched = want.some(c => (c.expect === null ? events.length > 0 : !kinds.includes(c.expect)))
      console.log(`  ${unmatched ? 'FAIL' : '    '}  ${name.padEnd(14)} ${show(events)}`)
      if (unmatched) failures += 1
    }
  }
  console.log('\nheadline checks (reminder kind @ step):')
  for (const c of checks) {
    const { resolved } = armPolicy(armFile(c.arm))
    const events = simulate({ ...resolved, ...(c.override ?? {}) }, SCENARIOS[c.scenario])
    const kinds = events.map(e => e.kind)
    const ok = c.expect === null
      ? events.length === 0
      : events.some(e => e.kind === c.expect && (c.step === undefined || e.step === c.step))
    if (!ok) failures += 1
    const label = c.label ?? `${c.arm} / ${c.scenario}`
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${show(events)}${c.expect === null ? '  (expect none)' : `  want ${c.expect}${c.step === undefined ? '' : `@step${c.step}`}`}`)
  }
  console.log(`\n${failures === 0 ? 'OK' : `${failures} check(s) failed`}`)
  return failures
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--mechanisms')) process.exit(mechanisms() === 0 ? 0 : 1)
  const pick = flag => {
    const i = argv.indexOf(flag)
    if (i < 0) return undefined
    const v = argv[i + 1]
    return v && !v.startsWith('--') ? v.split(',').filter(Boolean) : []
  }
  const DEFAULT_ARMS = ['off', 'def15', 'disc-only', 'disc-on', 'disc-off']
  const listed = pick('--arms') ?? pick('--arm')
  const arms = listed && listed.length ? listed : DEFAULT_ARMS
  process.exit(armMatrix(arms) === 0 ? 0 : 1)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()
