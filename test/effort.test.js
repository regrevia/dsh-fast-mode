/**
 * Tests for the adaptive effort policy. Run with `npm test`.
 *
 * These exist because the plugin this replaces shipped a README claiming live
 * verification of behaviour its code could not produce. Every claim in the
 * README is checked here against the function itself.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  contentChars,
  createState,
  decideEffort,
  readSignals,
  recordObservation,
  resetTurn,
  resolveConfig,
  stableKey,
  DEFAULTS,
  EFFORT_LADDER,
} from '../src/effort.js'

const config = resolveConfig(undefined)

const obs = (overrides = {}) => ({
  name: 'read',
  argsKey: JSON.stringify(Math.random()),
  isError: false,
  chars: 100,
  durationMs: 20,
  ...overrides,
})

const decide = (input) => decideEffort({ config, ...input })

test('planning step keeps full effort regardless of signals', () => {
  const signals = readSignals(createState(), 'a')
  assert.equal(decide({ step: 1, current: 'medium', signals }), 'medium')
  assert.equal(decide({ step: 1, current: 'high', signals }), 'high')
})

test('execution step drops one notch', () => {
  const signals = readSignals(createState(), 'a')
  assert.equal(decide({ step: 2, current: 'high', signals }), 'medium')
  assert.equal(decide({ step: 2, current: 'medium', signals }), 'low')
})

test('a sustained clean streak earns a second notch but never breaks the floor', () => {
  const state = createState()
  for (let index = 0; index < 8; index += 1) recordObservation(state, 'a', obs())
  const signals = readSignals(state, 'a')
  assert.equal(signals.cleanStreak, 8)
  assert.equal(signals.struggling, false)
  // high -2 => low (floor)
  assert.equal(decide({ step: 9, current: 'high', signals }), 'low')
  assert.equal(decide({ step: 9, current: 'max', signals }), 'max', 'unknown id untouched')
})

test('a short clean streak only drops one notch', () => {
  const state = createState()
  for (let index = 0; index < 3; index += 1) recordObservation(state, 'a', obs())
  const signals = readSignals(state, 'a')
  assert.equal(decide({ step: 4, current: 'high', signals }), 'medium')
})

test('an error in the window restores full deliberation', () => {
  const state = createState()
  recordObservation(state, 'a', obs())
  recordObservation(state, 'a', obs({ isError: true }))
  const signals = readSignals(state, 'a')
  assert.equal(signals.struggling, true)
  assert.equal(decide({ step: 4, current: 'medium', signals }), 'medium')
})

test('a slow call counts as struggling: the turn is I/O bound, not thinking bound', () => {
  const state = createState()
  recordObservation(state, 'a', obs({ durationMs: 30_000 }))
  const signals = readSignals(state, 'a')
  assert.equal(signals.struggling, true)
  assert.equal(decide({ step: 4, current: 'medium', signals }), 'medium')
})

test('an oversized result counts as struggling', () => {
  const state = createState()
  recordObservation(state, 'a', obs({ chars: 60_000 }))
  const signals = readSignals(state, 'a')
  assert.equal(signals.struggling, true)
  assert.equal(decide({ step: 4, current: 'medium', signals }), 'medium')
})

test('a repeated identical call counts as struggling', () => {
  const state = createState()
  recordObservation(state, 'a', obs({ argsKey: '{"path":"x"}' }))
  recordObservation(state, 'a', obs({ argsKey: '{"path":"x"}' }))
  const signals = readSignals(state, 'a')
  assert.equal(signals.mostRepeated, 2)
  assert.equal(signals.struggling, true)
  assert.equal(decide({ step: 4, current: 'medium', signals }), 'medium')
})

test('never steps up toward the floor', () => {
  const signals = readSignals(createState(), 'a')
  assert.equal(decide({ step: 9, current: 'minimal', signals }), 'minimal')
  assert.equal(decide({ step: 9, current: 'off', signals }), 'off')
})

test('a custom floor is respected', () => {
  const wide = resolveConfig({ floor: 'minimal' })
  const state = createState()
  for (let index = 0; index < 8; index += 1) recordObservation(state, 'a', obs())
  const signals = readSignals(state, 'a')
  assert.equal(decideEffort({ step: 5, current: 'medium', config: wide, signals }), 'minimal')
  assert.equal(decideEffort({ step: 5, current: 'low', config: wide, signals }), 'minimal')
})

test('escalateAfterStep lifts a long turn back to full effort', () => {
  const lifted = resolveConfig({ escalateAfterStep: 24 })
  const signals = readSignals(createState(), 'a')
  assert.equal(decideEffort({ step: 30, current: 'medium', config: lifted, signals }), 'medium')
  assert.equal(decideEffort({ step: 10, current: 'medium', config: lifted, signals }), 'low')
})

test('an unknown effort id is passed through, never guessed', () => {
  const signals = readSignals(createState(), 'a')
  assert.equal(decide({ step: 4, current: 'xhigh', signals }), 'xhigh')
  assert.equal(decide({ step: 4, current: undefined, signals }), undefined)
})

test('turn change clears the previous turn observations', () => {
  const state = createState()
  assert.equal(resetTurn(state, 'a', 0), false, 'the first call only tags the turn')
  recordObservation(state, 'a', obs({ isError: true }))
  assert.equal(readSignals(state, 'a').errors, 1)

  // The same turn must not clear mid-turn: the request for step 2 runs after
  // step 1's tool calls, and wiping them here would blind the policy entirely.
  assert.equal(resetTurn(state, 'a', 0), false, 'the same turn keeps its observations')
  assert.equal(readSignals(state, 'a').errors, 1, 'observations survive a same-turn request')

  assert.equal(resetTurn(state, 'a', 1), true, 'a new turn clears them')
  const signals = readSignals(state, 'a')
  assert.equal(signals.errors, 0, 'a fresh turn does not inherit the old struggle')
  assert.equal(signals.observations, 0)
})

test('agents are isolated from each other', () => {
  const state = createState()
  recordObservation(state, 'a', obs({ isError: true }))
  recordObservation(state, 'b', obs())
  assert.equal(readSignals(state, 'a').errors, 1)
  assert.equal(readSignals(state, 'b').errors, 0)
})

test('the observation window stays bounded', () => {
  const state = createState()
  for (let index = 0; index < 500; index += 1) recordObservation(state, 'a', obs())
  const entry = state.byAgent.get('a')
  assert.ok(entry.observations.length <= 24, `bounded tail, got ${entry.observations.length}`)
})

test('contentChars measures text blocks and survives junk', () => {
  assert.equal(contentChars([{ type: 'text', text: 'abcd' }]), 4)
  assert.equal(contentChars([{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }]), 4)
  assert.equal(contentChars(undefined), 0)
  assert.equal(contentChars([null, 42, 'x']), 0)
})

test('stableKey is order-insensitive and bounded', () => {
  assert.equal(stableKey({ a: 1, b: 2 }), stableKey({ b: 2, a: 1 }))
  assert.notEqual(stableKey({ a: 1 }), stableKey({ a: 2 }))
  assert.ok(stableKey({ big: 'x'.repeat(5000) }).length <= 401)
  const cycle = {}
  cycle.self = cycle
  assert.equal(typeof stableKey(cycle), 'string')
})

test('config defaults are safe', () => {
  const defaults = resolveConfig(undefined)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.floor, DEFAULTS.floor)
  assert.deepEqual([...defaults.ladder], [...EFFORT_LADDER])
  assert.equal(defaults.deepAfter, DEFAULTS.deepAfter)
  assert.equal(defaults.escalateAfterStep, 0)
  assert.equal(defaults.debug, false)
})

test('a typo in floor degrades to the default, not to no floor', () => {
  assert.equal(resolveConfig({ floor: 'turbo' }).floor, 'low')
  assert.equal(resolveConfig({ floor: 'off' }).floor, 'off')
})

test('enabled:false is the off switch', () => {
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
  assert.equal(resolveConfig({}).enabled, true)
})

test('bad thresholds fall back instead of disabling the guard', () => {
  assert.equal(resolveConfig({ slowMs: 'soon' }).slowMs, DEFAULTS.slowMs)
  assert.equal(resolveConfig({ slowMs: -1 }).slowMs, DEFAULTS.slowMs)
  assert.equal(resolveConfig({ bigChars: 0 }).bigChars, DEFAULTS.bigChars)
  assert.equal(resolveConfig({ deepAfter: 0 }).deepAfter, DEFAULTS.deepAfter)
  assert.equal(resolveConfig({ escalateAfterStep: 12.7 }).escalateAfterStep, 12)
})

test('a malformed ladder falls back to the built-in one', () => {
  assert.deepEqual([...resolveConfig({ ladder: ['only-one'] }).ladder], [...EFFORT_LADDER])
  assert.deepEqual([...resolveConfig({ ladder: 'low,high' }).ladder], [...EFFORT_LADDER])
})

test('a custom ladder drives the notch', () => {
  const custom = resolveConfig({ ladder: ['low', 'high'], floor: 'low' })
  const signals = readSignals(createState(), 'a')
  assert.equal(decideEffort({ step: 3, current: 'high', config: custom, signals }), 'low')
})
