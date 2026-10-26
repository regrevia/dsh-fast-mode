/**
 * The settings schema.
 *
 * `Config` has two consumers — the Loader validating a composition patch and the
 * `settings` service projecting the plugin page — so these tests pin the
 * contract both of them rely on: fast mode defaults to off, every gear the
 * policy knows is selectable, an unknown gear fails loudly instead of silently
 * degrading, and keys this schema does not declare survive untouched so an
 * existing `cordis.patch.yml` keeps working.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Config } from '../index.js'
import { resolveConfig } from '../src/effort.js'

/**
 * Read a parsed config the way a running plugin does.
 *
 * Volatile fields come back as frozen references, so a test that compares them
 * to plain values would fail for the right reason but the wrong field.
 * @param {object} input
 */
const parse = (input) => {
  const value = Config(input)
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [
    key,
    field && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field,
  ]))
}

test('the schema defaults to off with the scheduler', () => {
  const value = parse({})
  assert.equal(value.enabled, false)
  assert.equal(value.gear, 'auto')
})

test('a retired gear id is still accepted, so an old patch loads', () => {
  for (const gear of ['safe', 'auto', 'fast', 'turbo', 'max', 'ludicrous']) {
    assert.equal(parse({ gear }).gear, gear, 'the schema accepts it; resolveConfig maps it')
  }
})

test('an unknown gear is a load-time error', () => {
  assert.throws(() => Config({ gear: 'warp' }), /gear/)
})

test('the parallel ceiling round-trips through the schema', () => {
  assert.equal(parse({ parallel: 1 }).parallel, 1)
  assert.equal(parse({ parallel: 8 }).parallel, 8)
})

test('undeclared composition keys survive the schema', () => {
  // Pass-through is generic: the retired effort knobs still parse (so an old
  // patch does not fail to load) but nothing reads them any more, which is what
  // test/effort.test.js pins.
  const value = parse({ enabled: true, floor: 'high', holdTools: ['bash'], debug: true })
  assert.equal(value.enabled, true)
  assert.equal(value.floor, 'high', 'unknown keys pass through untouched')
  assert.deepEqual(value.holdTools, ['bash'])
  assert.equal(value.debug, true)
})

test('the form fields are exactly the four live knobs, and all four are volatile', () => {
  // `settings` projects a Config through `volatileForm`, which keeps only
  // nodes carrying `meta.volatile`; a non-volatile field is silently dropped
  // from the form and its write is refused with "is not volatile".
  const json = Config.toJSON()
  const visit = (id) => {
    const node = json.refs[String(id)]
    return node
  }
  const root = visit(json.uid)
  assert.equal(root.type, 'object')
  assert.deepEqual(Object.keys(root.dict).sort(), [
    'batchVerify', 'benchmarkFile', 'enabled', 'fanoutWidth', 'finishLineSteps', 'gear', 'guidance', 'mapEntries', 'metrics', 'metricsFile',
    'openBatch', 'outputBudget', 'outputDiscipline', 'parallel', 'preferPatch', 'reassertAfterCompaction', 'sessions', 'shapeGate', 'shellParallel', 'stallGuard',
    'stepBudget', 'toolTimeoutMs', 'workspaceMap',
  ])

  // The switch, the gear and the fan-out are the form. They must be volatile:
  // a knob that only takes effect after a restart is not a switch.
  for (const key of ['enabled', 'gear', 'parallel']) {
    assert.equal(visit(root.dict[key]).meta.volatile, true, `${key} must be volatile to appear in the form`)
  }

  // The per-session column rides in the same document and has to be writable by
  // the client half, so it is volatile too. It is not a knob anyone should type
  // into: the description says so, and the chip is the only writer.
  assert.equal(visit(root.dict.sessions).meta.volatile, true, 'sessions must be volatile to be writeable')

  // Measurement paths are composition knobs, like `debugFile`: they are read at
  // load and deliberately stay out of the form. Changing where the file goes is
  // an edit in cordis.patch.yml, not something to click mid-task.
  for (const key of ['metrics', 'metricsFile', 'benchmarkFile', 'outputDiscipline', 'shapeGate', 'stallGuard', 'toolTimeoutMs', 'reassertAfterCompaction']) {
    assert.notEqual(visit(root.dict[key]).meta.volatile, true, `${key} is a composition knob, not a form field`)
  }
})

test("outputDiscipline accepts the three documented modes", () => {
  assert.equal(parse({}).outputDiscipline, 'late', 'short tasks pay nothing, long tasks still save')
  assert.equal(parse({ outputDiscipline: false }).outputDiscipline, false)
  assert.equal(parse({ outputDiscipline: 'late' }).outputDiscipline, 'late')
  assert.throws(() => parse({ outputDiscipline: 'sometimes' }))
})

test('measurement is on by default and can be pointed somewhere private', () => {
  const defaults = parse({})
  assert.equal(defaults.metrics, true, 'a plugin about speed must measure its own effect by default')
  assert.match(String(defaults.metricsFile), /fast-mode-metrics\.jsonl$/)
  assert.match(String(defaults.benchmarkFile), /fast-mode-bench\.json$/)

  const custom = parse({ metrics: false, metricsFile: '/tmp/elsewhere.jsonl' })
  assert.equal(custom.metrics, false)
  assert.equal(custom.metricsFile, '/tmp/elsewhere.jsonl')
})

test('a volatile field arrives as a reference and the plugin still reads it', () => {
  // The Loader hands a `.volatile()` field to a running plugin as a frozen
  // reference it swaps in place, so `enabled === true` would be false even with
  // the switch on. This pins the unwrapping that makes the switch work live.
  const parsed = Config({ enabled: true })
  assert.equal(typeof parsed.enabled, 'object')
  assert.equal(parsed.enabled.get(), true)

  assert.equal(resolveConfig(parsed).enabled, true, 'a volatile switch reads as on')
  assert.equal(resolveConfig({ enabled: true }).enabled, true, 'plain config still works')
  assert.equal(resolveConfig({ enabled: parsed.enabled }).enabled, true, 'a ref carried inside a plain object')
})

test('an override pins one field without rebuilding the config', () => {
  // This is what the experiment harness uses: the session's gear comes from the
  // assignment, everything else from the composition.
  const raw = Config({ enabled: true, gear: 'turbo', toolTimeoutMs: 1234 })
  const pinned = resolveConfig(raw, { gear: 'max' })
  assert.equal(pinned.gear, 'max')
  assert.equal(pinned.toolTimeoutMs, 1234, 'only the overridden field moves')
  assert.equal(pinned.enabled, true)
  assert.ok(pinned.gearLevel > resolveConfig(raw).gearLevel, 'the override reaches the derived plan, not just the name')

  const again = resolveConfig(raw)
  assert.equal(again.gear, 'auto', 'the note never appeared, so resolve-time mapping is unchanged by an override')
  assert.equal(again.legacyGear, 'turbo', 'and the override must not mutate what it read')

  // The schema is the one place that refuses an unknown gear; at runtime a typo
  // degrades to the default gear, because throwing here would take the turn down.
  assert.equal(resolveConfig(raw, { gear: 'warp' }).gear, 'safe')
})

test('a gear override survives a volatile gear reference', () => {
  const raw = Config({ enabled: true, gear: 'auto' })
  assert.equal(typeof raw.gear, 'object', 'the switch is a reference at runtime')
  assert.equal(resolveConfig(raw, { gear: 'turbo' }).gear, 'turbo')
})

test('the metrics file default can be redirected by environment, for benchmarks that need separate journals', () => {
  const previous = process.env.DSH_FAST_MODE_METRICS_FILE
  try {
    process.env.DSH_FAST_MODE_METRICS_FILE = '/tmp/bench-only.jsonl'
    const redirected = resolveConfig({})
    assert.equal(redirected.metricsFile, '/tmp/bench-only.jsonl')
    assert.equal(resolveConfig({ metricsFile: '/tmp/explicit.jsonl' }).metricsFile, '/tmp/explicit.jsonl',
      'an explicit config value still wins over the environment')
  } finally {
    if (previous === undefined) delete process.env.DSH_FAST_MODE_METRICS_FILE
    else process.env.DSH_FAST_MODE_METRICS_FILE = previous
  }
})
