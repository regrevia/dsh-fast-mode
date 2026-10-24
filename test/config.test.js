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

test('the schema defaults to off with the fast gear', () => {
  const value = Config({})
  assert.equal(value.enabled, false)
  assert.equal(value.gear, 'fast')
})

test('every gear the policy knows is selectable', () => {
  for (const gear of ['safe', 'fast', 'turbo', 'max']) {
    assert.equal(Config({ gear }).gear, gear)
  }
})

test('an unknown gear is a load-time error', () => {
  assert.throws(() => Config({ gear: 'warp' }), /gear/)
})

test('the parallel ceiling round-trips through the schema', () => {
  assert.equal(Config({ parallel: 1 }).parallel, 1)
  assert.equal(Config({ parallel: 8 }).parallel, 8)
})

test('undeclared composition keys survive the schema', () => {
  const value = Config({ enabled: true, floor: 'high', holdTools: ['bash'], debug: true })
  assert.equal(value.enabled, true)
  assert.equal(value.floor, 'high', 'the floor is a patch-level knob, not a form field')
  assert.deepEqual(value.holdTools, ['bash'])
  assert.equal(value.debug, true)
})
