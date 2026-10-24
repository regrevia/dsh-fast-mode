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

test('the schema defaults to off with the fast gear', () => {
  const value = parse({})
  assert.equal(value.enabled, false)
  assert.equal(value.gear, 'fast')
})

test('every gear the policy knows is selectable', () => {
  for (const gear of ['safe', 'fast', 'turbo', 'max']) {
    assert.equal(parse({ gear }).gear, gear)
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
  const value = parse({ enabled: true, floor: 'high', holdTools: ['bash'], debug: true })
  assert.equal(value.enabled, true)
  assert.equal(value.floor, 'high', 'the floor is a patch-level knob, not a form field')
  assert.deepEqual(value.holdTools, ['bash'])
  assert.equal(value.debug, true)
})

test('the form fields are exactly the three live knobs, and all three are volatile', () => {
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
    'benchmarkFile', 'enabled', 'gear', 'metrics', 'metricsFile', 'parallel',
  ])

  // The switch, the gear and the fan-out are the form. They must be volatile:
  // a knob that only takes effect after a restart is not a switch.
  for (const key of ['enabled', 'gear', 'parallel']) {
    assert.equal(visit(root.dict[key]).meta.volatile, true, `${key} must be volatile to appear in the form`)
  }

  // Measurement paths are composition knobs, like `debugFile`: they are read at
  // load and deliberately stay out of the form. Changing where the file goes is
  // an edit in cordis.patch.yml, not something to click mid-task.
  for (const key of ['metrics', 'metricsFile', 'benchmarkFile']) {
    assert.notEqual(visit(root.dict[key]).meta.volatile, true, `${key} is a composition knob, not a form field`)
  }
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
  const raw = Config({ enabled: true, gear: 'fast', slowMs: 1234 })
  const pinned = resolveConfig(raw, { gear: 'turbo' })
  assert.equal(pinned.gear, 'turbo')
  assert.equal(pinned.slowMs, 1234, 'only the overridden field moves')
  assert.equal(pinned.enabled, true)
  assert.ok(pinned.gearLevel > resolveConfig(raw).gearLevel, 'the override reaches the derived plan, not just the name')

  const again = resolveConfig(raw)
  assert.equal(again.gear, 'fast', 'the override must not mutate what it read')

  // The schema is the one place that refuses an unknown gear; at runtime a typo
  // degrades to the default gear, because throwing here would take the turn down.
  assert.equal(resolveConfig(raw, { gear: 'warp' }).gear, 'safe')
})

test('a gear override survives a volatile gear reference', () => {
  const raw = Config({ enabled: true, gear: 'fast' })
  assert.equal(typeof raw.gear, 'object', 'the switch is a reference at runtime')
  assert.equal(resolveConfig(raw, { gear: 'turbo' }).gear, 'turbo')
})
