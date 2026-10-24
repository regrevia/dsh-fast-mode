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

test('every form field is volatile, or the settings page cannot show it', () => {
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
  assert.deepEqual(Object.keys(root.dict).sort(), ['enabled', 'gear', 'parallel'])
  for (const key of Object.keys(root.dict)) {
    assert.equal(visit(root.dict[key]).meta.volatile, true, `${key} must be volatile to appear in the form`)
  }
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
