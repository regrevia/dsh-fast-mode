/**
 * Tests for the adaptive effort policy. Run with `npm test`.
 *
 * These exist because the plugin this replaces shipped a README claiming live
 * verification of behaviour its code could never produce. Every claim in the
 * README is checked here against the function itself, including the
 * provider-independence claims: the policy is exercised against the official
 * DeepSeek ladder, a self-hosted gateway ladder, and a route that declares no
 * ladder at all.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  contentChars,
  createState,
  decideEffort,
  DEFAULT_GEAR,
  GEARS,
  normaliseGear,
  looksAliased,
  matchesHold,
  normaliseHoldTools,
  orderEfforts,
  rankOf,
  readSignals,
  recordObservation,
  resetTurn,
  resolveConfig,
  resolvePlan,
  stableKey,
  DEFAULTS,
  EFFORT_LADDER,
} from '../src/effort.js'

/** What this machine's self-hosted gateway declares: medium is a real level. */
const SELF_HOSTED = ['off', 'minimal', 'low', 'medium', 'high']
/** What the official DeepSeek API documents, including its compatibility aliases. */
const OFFICIAL_ALIASED = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** What an official route would declare if it exposed only the real levels. */
const OFFICIAL = ['none', 'low', 'high', 'max']

const config = resolveConfig(undefined)
const planFor = (declared, overrides) => resolvePlan(declared, resolveConfig(overrides))

const obs = (overrides = {}) => ({
  name: 'read',
  argsKey: JSON.stringify(Math.random()),
  isError: false,
  chars: 100,
  durationMs: 20,
  ...overrides,
})

const decide = (declared, input) => decideEffort({ config, plan: planFor(declared), ...input })

/* ------------------------------------------------------------------ policy */

test('planning step keeps full effort regardless of signals', () => {
  const signals = readSignals(createState(), 'a')
  assert.equal(decide(SELF_HOSTED, { step: 1, current: 'medium', signals }), 'medium')
  assert.equal(decide(SELF_HOSTED, { step: 1, current: 'high', signals }), 'high')
})

test('execution step drops one notch', () => {
  const signals = readSignals(createState(), 'a')
  assert.equal(decide(SELF_HOSTED, { step: 2, current: 'high', signals }), 'medium')
  assert.equal(decide(SELF_HOSTED, { step: 2, current: 'medium', signals }), 'low')
})

test('a sustained clean streak earns a second notch but never breaks the floor', () => {
  const state = createState()
  for (let index = 0; index < 8; index += 1) recordObservation(state, 'a', obs())
  const signals = readSignals(state, 'a')
  assert.equal(signals.cleanStreak, 8)
  assert.equal(signals.struggling, false)
  assert.equal(decide(SELF_HOSTED, { step: 9, current: 'high', signals }), 'low')
})

test('a short clean streak only drops one notch', () => {
  const state = createState()
  for (let index = 0; index < 3; index += 1) recordObservation(state, 'a', obs())
  const signals = readSignals(state, 'a')
  assert.equal(decide(SELF_HOSTED, { step: 4, current: 'high', signals }), 'medium')
})

test('an error in the window restores full deliberation', () => {
  const state = createState()
  recordObservation(state, 'a', obs())
  recordObservation(state, 'a', obs({ isError: true }))
  const signals = readSignals(state, 'a')
  assert.equal(signals.struggling, true)
  assert.equal(decide(SELF_HOSTED, { step: 4, current: 'medium', signals }), 'medium')
})

test('a slow call counts as struggling: the turn is I/O bound, not thinking bound', () => {
  const state = createState()
  recordObservation(state, 'a', obs({ durationMs: 30_000 }))
  const signals = readSignals(state, 'a')
  assert.equal(signals.struggling, true)
  assert.equal(decide(SELF_HOSTED, { step: 4, current: 'medium', signals }), 'medium')
})

test('an oversized result counts as struggling', () => {
  const state = createState()
  recordObservation(state, 'a', obs({ chars: 60_000 }))
  const signals = readSignals(state, 'a')
  assert.equal(signals.struggling, true)
  assert.equal(decide(SELF_HOSTED, { step: 4, current: 'medium', signals }), 'medium')
})

test('a repeated identical call counts as struggling', () => {
  const state = createState()
  recordObservation(state, 'a', obs({ argsKey: '{"path":"x"}' }))
  recordObservation(state, 'a', obs({ argsKey: '{"path":"x"}' }))
  const signals = readSignals(state, 'a')
  assert.equal(signals.mostRepeated, 2)
  assert.equal(signals.struggling, true)
  assert.equal(decide(SELF_HOSTED, { step: 4, current: 'medium', signals }), 'medium')
})

test('never steps up toward the floor', () => {
  const signals = readSignals(createState(), 'a')
  assert.equal(decide(SELF_HOSTED, { step: 9, current: 'minimal', signals }), 'minimal')
  assert.equal(decide(SELF_HOSTED, { step: 9, current: 'off', signals }), 'off')
})

test('a custom floor is respected', () => {
  const wide = resolveConfig({ floor: 'minimal' })
  const state = createState()
  for (let index = 0; index < 8; index += 1) recordObservation(state, 'a', obs())
  const signals = readSignals(state, 'a')
  const plan = resolvePlan(SELF_HOSTED, wide)
  assert.equal(decideEffort({ step: 5, current: 'medium', config: wide, plan, signals }), 'minimal')
  assert.equal(decideEffort({ step: 5, current: 'low', config: wide, plan, signals }), 'minimal')
})

test('escalateAfterStep lifts a long turn back to full effort', () => {
  const lifted = resolveConfig({ escalateAfterStep: 24 })
  const signals = readSignals(createState(), 'a')
  const plan = resolvePlan(SELF_HOSTED, lifted)
  assert.equal(decideEffort({ step: 30, current: 'medium', config: lifted, plan, signals }), 'medium')
  assert.equal(decideEffort({ step: 10, current: 'medium', config: lifted, plan, signals }), 'low')
})

test('an unknown effort id is passed through, never guessed', () => {
  const signals = readSignals(createState(), 'a')
  assert.equal(decide(SELF_HOSTED, { step: 4, current: 'turbo', signals }), 'turbo')
  assert.equal(decide(SELF_HOSTED, { step: 4, current: undefined, signals }), undefined)
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

/* --------------------------------------------------- provider independence */

test('official DeepSeek route: a real cut, not an alias no-op', () => {
  // The documented aliases mean `high`→`medium` changes nothing on the wire.
  // The policy must land on `low`, which is a genuinely lower level.
  const signals = readSignals(createState(), 'a')
  assert.equal(decide(OFFICIAL, { step: 3, current: 'high', signals }), 'low')
  assert.equal(decide(OFFICIAL_ALIASED, { step: 3, current: 'high', signals }), 'low')
  // `max` is a level of its own, so one notch reaches `high`.
  assert.equal(decide(OFFICIAL, { step: 3, current: 'max', signals }), 'high')
  assert.equal(decide(OFFICIAL_ALIASED, { step: 3, current: 'max', signals }), 'high')
})

test('official aliases resolve onto their canonical level', () => {
  const signals = readSignals(createState(), 'a')
  const plan = planFor(OFFICIAL_ALIASED)
  assert.equal(plan.source, 'provider+aliases')
  assert.equal(plan.indexOf('medium'), plan.indexOf('high'), 'medium is high on the wire')
  assert.equal(plan.indexOf('xhigh'), plan.indexOf('high'), 'xhigh is high on the wire')
  assert.equal(plan.indexOf('minimal'), plan.indexOf('low'), 'minimal is low on the wire')
  // A resolved effort that is only an alias still notches from its real level.
  assert.equal(decideEffort({ config, plan, step: 3, current: 'medium', signals }), 'low')
  assert.equal(decideEffort({ config, plan, step: 3, current: 'xhigh', signals }), 'low')
})

test('a self-hosted gateway keeps every declared level distinct', () => {
  const plan = planFor(SELF_HOSTED)
  assert.equal(plan.aliased, false, 'no max/xhigh family, so no alias collapsing')
  assert.equal(plan.source, 'provider')
  assert.deepEqual(plan.levels.map(level => level.id), SELF_HOSTED)
  const signals = readSignals(createState(), 'a')
  assert.equal(decideEffort({ config, plan, step: 3, current: 'high', signals }), 'medium')
})

test('the official floor keeps thinking enabled', () => {
  // floor `low` must prevent a drop to `none`, which would disable thinking.
  const plan = planFor(OFFICIAL)
  assert.equal(plan.floorId, 'low')
  const state = createState()
  for (let index = 0; index < 20; index += 1) recordObservation(state, 'a', obs())
  const signals = readSignals(state, 'a')
  assert.equal(decideEffort({ config, plan, step: 9, current: 'high', signals }), 'low')
  assert.notEqual(decideEffort({ config, plan, step: 9, current: 'low', signals }), 'none')
})

test('a route that declares no levels is left completely alone', () => {
  const plan = planFor([])
  assert.equal(plan.source, 'provider-none')
  assert.deepEqual(plan.levels, [])
  const signals = readSignals(createState(), 'a')
  assert.equal(decideEffort({ config, plan, step: 9, current: 'high', signals }), 'high')
  assert.equal(decideEffort({ config, plan: undefined, step: 9, current: 'high', signals }), 'high')
})

test('a route declaring a single level cannot be notched', () => {
  const plan = planFor(['high'])
  const signals = readSignals(createState(), 'a')
  assert.equal(decideEffort({ config, plan, step: 9, current: 'high', signals }), 'high')
})

test('a floor the route does not offer maps upward, never below the request', () => {
  const plan = planFor(['high', 'max'])
  // The cheapest level is already `high`, so a `low` floor resolves to `high`
  // and nothing may be cut.
  assert.equal(plan.floorId, 'high')
  const signals = readSignals(createState(), 'a')
  assert.equal(decideEffort({ config, plan, step: 9, current: 'max', signals }), 'high')
})

test('aliases can be disabled or overridden per deployment', () => {
  const off = resolveConfig({ aliases: false })
  const offPlan = resolvePlan(OFFICIAL_ALIASED, off)
  assert.equal(offPlan.aliased, false)
  const signals = readSignals(createState(), 'a')
  assert.equal(decideEffort({ config: off, plan: offPlan, step: 3, current: 'high', signals }), 'medium')

  const custom = resolveConfig({ aliases: { medium: 'low', high: 'high', max: 'max', none: 'none', minimal: 'low', xhigh: 'high' } })
  const customPlan = resolvePlan(OFFICIAL_ALIASED, custom)
  assert.equal(customPlan.indexOf('medium'), customPlan.indexOf('low'))
})

test('looksAliased separates the two documented families', () => {
  assert.equal(looksAliased(OFFICIAL), true)
  assert.equal(looksAliased(OFFICIAL_ALIASED), true)
  assert.equal(looksAliased(SELF_HOSTED), false)
  assert.equal(looksAliased(['low', 'high']), false)
})

test('unrecognised ids keep their declared order instead of being guessed', () => {
  assert.deepEqual([...orderEfforts(['turbo', 'normal-speed', 'high'])], ['turbo', 'normal-speed', 'high'])
  assert.equal(rankOf('turbo'), undefined)
  // A route whose ids are all unknown still works on declared order.
  const plan = planFor(['turbo', 'normal-speed', 'high'])
  const signals = readSignals(createState(), 'a')
  assert.equal(decideEffort({ config, plan, step: 3, current: 'high', signals }), 'high')
})

test('the fallback ladder is only reachable through an explicit pin', () => {
  const pinned = resolveConfig({ ladder: ['low', 'high'], floor: 'low' })
  assert.equal(pinned.ladderExplicit, true)
  const signals = readSignals(createState(), 'a')
  const plan = resolvePlan(undefined, pinned)
  assert.equal(plan.source, 'configured')
  assert.equal(decideEffort({ step: 3, current: 'high', config: pinned, plan, signals }), 'low')
})

/* ---------------------------------------------------------------- config */

test('config defaults are safe', () => {
  const defaults = resolveConfig(undefined)
  assert.equal(defaults.enabled, false, 'fast mode is opt-in')
  assert.equal(defaults.floor, DEFAULTS.floor)
  assert.deepEqual([...defaults.ladder], [...EFFORT_LADDER])
  assert.equal(defaults.ladderExplicit, false)
  assert.equal(defaults.aliases, 'auto')
  assert.equal(defaults.deepAfter, GEARS[DEFAULT_GEAR].deepAfter)
  assert.equal(defaults.escalateAfterStep, 0)
  assert.equal(defaults.baselineFromDefault, true)
  assert.equal(defaults.debug, false)
})

test('a typo in floor degrades to the default, not to no floor', () => {
  assert.equal(resolveConfig({ floor: 'turbo' }).floor, 'low')
  assert.equal(resolveConfig({ floor: 'off' }).floor, 'off')
})

test('only an explicit true arms the policy', () => {
  assert.equal(resolveConfig({}).enabled, false)
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
  assert.equal(resolveConfig({ enabled: true }).enabled, true)
  assert.equal(resolveConfig({ enabled: 1 }).enabled, false, 'a truthy non-boolean never arms it')
  assert.equal(resolveConfig({ enabled: 'yes' }).enabled, false)
})

test('bad thresholds fall back instead of disabling the guard', () => {
  assert.equal(resolveConfig({ slowMs: 'soon' }).slowMs, DEFAULTS.slowMs)
  assert.equal(resolveConfig({ slowMs: -1 }).slowMs, DEFAULTS.slowMs)
  assert.equal(resolveConfig({ bigChars: 0 }).bigChars, DEFAULTS.bigChars)
  assert.equal(resolveConfig({ deepAfter: 0 }).deepAfter, GEARS[DEFAULT_GEAR].deepAfter)
  assert.equal(resolveConfig({ escalateAfterStep: 12.7 }).escalateAfterStep, 12)
  assert.equal(resolveConfig({ discoverTimeoutMs: 'later' }).discoverTimeoutMs, DEFAULTS.discoverTimeoutMs)
})

test('a malformed ladder falls back to the built-in one', () => {
  assert.deepEqual([...resolveConfig({ ladder: ['only-one'] }).ladder], [...EFFORT_LADDER])
  assert.deepEqual([...resolveConfig({ ladder: 'low,high' }).ladder], [...EFFORT_LADDER])
  assert.equal(resolveConfig({ ladder: ['only-one'] }).ladderExplicit, false)
})

/**
 * What the shipped official DeepSeek adapter actually advertises to the
 * harness, read out of `@deepseek-ai/dsh-llm-deepseek`:
 *
 *   REASONING_EFFORTS = [off, low, high, max]
 *
 * It is *not* the seven-value compatibility list from the API docs: the
 * adapter maps the wire protocol itself (`thinking: disabled` at `off`,
 * `output_config.effort` otherwise) and only ever offers those four. So the
 * plugin must treat `off` as the declared lowest id, and must not invent
 * `none`/`minimal`/`medium`/`xhigh` for this route.
 */
const OFFICIAL_ADAPTER = ['off', 'low', 'high', 'max']
/** What the same adapter advertises when its connection sets `thinking: disabled`. */
const OFFICIAL_THINKING_DISABLED = ['off']

test('the official adapter ladder is cut from high to low, keeping thinking on', () => {
  const plan = planFor(OFFICIAL_ADAPTER)
  assert.deepEqual(plan.levels.map(level => level.id), ['off', 'low', 'high', 'max'])
  assert.equal(plan.indexOf('high'), 2)
  assert.equal(plan.indexOf('off'), 0)
  // Floor is `low`: the one level that disables thinking is unreachable.
  assert.equal(plan.floorId, 'low')
  assert.equal(plan.floorIndex, 1)
  assert.equal(planFor(OFFICIAL_ADAPTER).levels[plan.floorIndex].id, 'low')
})

test('the official adapter: no id outside its declared set is ever emitted', () => {
  const plan = planFor(OFFICIAL_ADAPTER)
  const declared = new Set(OFFICIAL_ADAPTER)
  // Only ids the route declares can reach us as `current`, because the harness
  // takes it from the same `reasoning.efforts` list. A foreign id is covered
  // separately: it is passed through untouched, never translated.
  const currentIds = [...OFFICIAL_ADAPTER]
  const outputs = []
  for (const current of currentIds) {
    for (const step of [0, 1, 2, 3, 10]) {
      for (const struggling of [false, true]) {
        for (const cleanStreak of [0, 3, 6, 30]) {
          outputs.push(decideEffort({
            step,
            current,
            baseline: current,
            plan,
            config,
            signals: { struggling, cleanStreak },
          }))
        }
      }
    }
  }
  for (const id of outputs) {
    if (id === undefined) continue
    assert.ok(declared.has(id), `emitted an undeclared effort id: ${id}`)
  }
  // And it does actually act: a clean execution step below the top is cut.
  assert.equal(decideEffort({ step: 2, current: 'high', plan, config, signals: { struggling: false, cleanStreak: 0 } }), 'low')
  // An id the route never declared is never rewritten into one of its own.
  for (const foreign of ['none', 'minimal', 'medium', 'xhigh', 'turbo']) {
    assert.equal(decideEffort({ step: 3, current: foreign, plan, config, signals: { struggling: false, cleanStreak: 0 } }), foreign)
  }
})

test('the official adapter with thinking disabled is inert, not broken', () => {
  const plan = planFor(OFFICIAL_THINKING_DISABLED)
  assert.equal(plan.levels.length, 1)
  assert.equal(decideEffort({ step: 5, current: 'off', plan, config, signals: { struggling: false, cleanStreak: 9 } }), 'off')
})

test('an official route that declares only real levels needs no alias table', () => {
  // `off/low/high/max` contains no alias-only id, so collapsing it changes nothing.
  assert.equal(looksAliased(OFFICIAL_ADAPTER), true) // it declares `max`
  const plan = planFor(OFFICIAL_ADAPTER)
  assert.deepEqual(plan.levels.map(level => level.ids), [['off'], ['low'], ['high'], ['max']])
})

test('the documented alias contract collapses only on routes that offer it', () => {
  // A route that declares the full documented list must notch across effective
  // levels: `high` -> `low`, never the `medium` no-op.
  const plan = planFor(OFFICIAL_ALIASED)
  assert.equal(plan.indexOf('high'), plan.indexOf('medium'))
  assert.equal(plan.indexOf('medium'), plan.indexOf('xhigh'))
  assert.equal(decideEffort({ step: 2, current: 'high', plan, config, signals: { struggling: false, cleanStreak: 0 } }), 'low')
  assert.equal(decideEffort({ step: 2, current: 'medium', plan, config, signals: { struggling: false, cleanStreak: 0 } }), 'low')
})

test('holdTools matches exactly, by prefix, and case-insensitively', () => {
  assert.equal(matchesHold('compress', ['compress']), true)
  assert.equal(matchesHold('Compress', ['compress']), true)
  assert.equal(matchesHold('acp_status', ['acp_*']), true)
  assert.equal(matchesHold('acp_retrieve', ['acp_*']), true)
  // A prefix pattern is anchored at the start: no accidental substring hits.
  assert.equal(matchesHold('not_acp_status', ['acp_*']), false)
  // Exact patterns are exact; `compress` must not swallow `compress_history`.
  assert.equal(matchesHold('compress_history', ['compress']), false)
  assert.equal(matchesHold('bash', []), false)
  assert.equal(matchesHold('bash', undefined), false)
  assert.equal(matchesHold(undefined, ['compress']), false)
})

test('holdTools accepts the string shape an operator writes in YAML', () => {
  assert.deepEqual(normaliseHoldTools('compress, acp_*'), ['compress', 'acp_*'])
  assert.deepEqual(normaliseHoldTools(' compress\n acp_status '), ['compress', 'acp_status'])
  assert.deepEqual(normaliseHoldTools(['compress', '', 42, 'compress']), ['compress'])
  assert.deepEqual(normaliseHoldTools(undefined), [])
  assert.deepEqual(normaliseHoldTools({}), [])

  const resolved = resolveConfig({ holdTools: 'compress, acp_*' })
  assert.deepEqual(resolved.holdTools, ['compress', 'acp_*'])
  assert.deepEqual(resolveConfig(undefined).holdTools, [])
})

test('a held tool pins full effort even on an otherwise clean streak', () => {
  const plan = planFor(SELF_HOSTED)
  const state = createState()
  const observation = (name, overrides = {}) => ({
    name, argsKey: `${name}:1`, isError: false, chars: 40, durationMs: 20, ...overrides,
  })

  // Seven fast small calls: without a hold this is a deep, clean streak.
  for (let index = 0; index < 7; index += 1) {
    recordObservation(state, 'agent', observation('bash', { argsKey: `bash:${index}` }), 8)
  }
  const clean = readSignals(state, 'agent', { holdTools: ['compress'] })
  assert.equal(clean.held, 0)
  assert.equal(clean.struggling, false)
  assert.equal(decideEffort({ step: 3, current: 'high', plan, config, signals: clean }), 'low')

  // The same streak, but one of the calls was a compression tool: hold.
  recordObservation(state, 'agent', observation('compress', { argsKey: 'compress:2' }), 8)
  const held = readSignals(state, 'agent', { holdTools: ['compress'] })
  assert.equal(held.held, 1)
  assert.equal(held.struggling, true)
  const heldConfig = resolveConfig({ holdTools: ['compress'] })
  assert.equal(decideEffort({ step: 3, current: 'high', plan, config: heldConfig, signals: held }), 'high')

  // A window wildcard covers a whole context-management family.
  const wildcard = readSignals(state, 'agent', { holdTools: ['comp*'] })
  assert.equal(wildcard.held, 1)
})

test('holdTools is inert when configured empty, and the whole-request hook stays safe', () => {
  const plan = planFor(SELF_HOSTED)
  const state = createState()
  recordObservation(state, 'agent', { name: 'compress', argsKey: 'a', isError: false, chars: 20, durationMs: 10 }, 8)
  const signals = readSignals(state, 'agent', {})
  assert.equal(signals.held, 0)
  // With no hold configured the ordinary single notch still applies: this route
  // declares a real `medium`, so one notch down from `high` lands there.
  assert.equal(decideEffort({ step: 3, current: 'high', plan, config, signals }), 'medium')
})

test('gears select a coherent stance, and explicit fields still win', () => {
  assert.deepEqual(
    Object.entries(GEARS).map(([name, gear]) => [name, gear.level, gear.parallel, gear.directive]),
    [
      ['safe', 1, 2, false],
      ['fast', 2, 4, true],
      ['turbo', 3, 6, true],
      ['max', 4, 8, true],
      ['ludicrous', 5, 8, true],
    ],
  )

  // A config that names no gear gets the shipped one, field by field.
  const shipped = resolveConfig(undefined)
  assert.equal(shipped.gear, DEFAULT_GEAR)
  assert.equal(DEFAULT_GEAR, 'fast')
  assert.equal(shipped.parallel, 4)
  assert.equal(shipped.deepAfter, 4)
  assert.equal(shipped.window, 6)
  assert.equal(shipped.directive, true)
  assert.equal(shipped.floor, DEFAULTS.floor)

  // Gear 1 is the previous release's behaviour, so an upgrade can opt back in.
  const legacy = resolveConfig({ gear: 'safe' })
  assert.equal(legacy.parallel, 1)
  assert.equal(legacy.deepAfter, DEFAULTS.deepAfter)
  assert.equal(legacy.window, DEFAULTS.window)
  assert.equal(legacy.directive, false)

  // A name, a number and a numeric string all name the same gear.
  for (const value of ['turbo', 3, '3', ' TURBO ']) {
    const resolved = resolveConfig({ gear: value })
    assert.equal(resolved.gear, 'turbo')
    assert.equal(resolved.deepAfter, 3)
    assert.equal(resolved.window, 5)
    assert.equal(resolved.parallel, 6)
  }

  // An explicit field overrides the gear without discarding the rest of it.
  const tuned = resolveConfig({ gear: 4, deepAfter: 9, parallel: 3, floor: 'high' })
  assert.equal(tuned.deepAfter, 9)
  assert.equal(tuned.parallel, 3)
  assert.equal(tuned.floor, 'high')
  assert.equal(tuned.window, 4)

  // Absent means the shipped gear; unreadable means the conservative one, so
  // that a typo cannot silently turn on prompt injection.
  for (const absent of [null, '']) assert.equal(normaliseGear(absent), DEFAULT_GEAR)
  for (const junk of ['warp', 9, {}, []]) {
    assert.equal(normaliseGear(junk), 'safe')
    assert.equal(resolveConfig({ gear: junk }).parallel, 1)
  }
})

test('a higher gear earns its second notch earlier than the safe gear', () => {
  const plan = planFor(SELF_HOSTED)
  const state = createState()
  for (let index = 0; index < 3; index += 1) {
    recordObservation(state, 'agent', {
      name: 'read', argsKey: `read:${index}`, isError: false, chars: 30, durationMs: 15,
    }, 8)
  }
  const signals = readSignals(state, 'agent', { window: 8 })
  assert.equal(signals.cleanStreak, 3)
  assert.equal(signals.struggling, false)

  // Three clean calls is one notch on `safe`, and the second notch on `turbo`.
  assert.equal(decideEffort({ step: 2, current: 'high', plan, config: resolveConfig(undefined), signals }), 'medium')
  assert.equal(decideEffort({ step: 2, current: 'high', plan, config: resolveConfig({ gear: 3 }), signals }), 'low')
})
