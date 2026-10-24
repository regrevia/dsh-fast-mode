/**
 * The configuration surface, after the reasoning-effort policy was deleted.
 *
 * Two things are pinned here:
 *
 * 1. What a gear may and may not decide. A gear is a width preset; the config
 *    that comes out of `resolveConfig` must not contain anything that could
 *    reach a request as a thinking level, and the retired effort knobs must not
 *    reappear as live values.
 * 2. That a patch naming a retired gear (`gear: turbo`) degrades to the scheduler
 *    instead of resurrecting the old "lower the effort" meaning.
 *
 * The behavioural half of the guarantee — the request hook hands back the exact
 * object the harness produced — lives in `test/plugin.test.js`. The source scan
 * at the bottom makes re-introducing the rewrite impossible without deleting a
 * test first.
 */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import {
  contentChars,
  DEFAULT_GEAR,
  FALLBACK_GEAR,
  GEARS,
  isVolatileRef,
  LEGACY_GEARS,
  normaliseGear,
  plainConfigValue,
  resolveConfig,
  stableKey,
} from '../src/effort.js'

test('an empty config resolves to the scheduler, switched off', () => {
  const cfg = resolveConfig(undefined)
  assert.equal(cfg.gear, DEFAULT_GEAR)
  assert.equal(cfg.enabled, false, 'opt-in: absent means leave the harness alone')
  assert.equal(cfg.adaptive, true)
  assert.equal(cfg.directive, true)
  assert.ok(cfg.parallel > 1 && cfg.parallel <= 8)
})

test('only an explicit true switches it on', () => {
  for (const value of [1, 'yes', 'true', {}, []]) {
    assert.equal(resolveConfig({ enabled: value }).enabled, false, `${JSON.stringify(value)} must stay off`)
  }
  assert.equal(resolveConfig({ enabled: true }).enabled, true)
})

test('the resolved config carries no thinking-level field at all', () => {
  const cfg = resolveConfig({ enabled: true, gear: 'auto' })
  for (const retired of [
    'floor', 'ladder', 'ladderExplicit', 'aliases', 'deepAfter', 'slowMs', 'bigChars',
    'window', 'holdTools', 'escalateAfterStep', 'discoverTimeoutMs', 'baselineFromDefault',
    'reasoningEffort', 'thinking',
  ]) {
    assert.equal(retired in cfg, false, `${retired} must not survive into a request decision`)
  }
})

test('a retired gear name becomes the scheduler and is reported', () => {
  for (const legacy of LEGACY_GEARS) {
    const cfg = resolveConfig({ enabled: true, gear: legacy })
    assert.equal(cfg.gear, 'auto', `${legacy} runs the scheduler`)
    assert.equal(cfg.legacyGear, legacy, 'and the load log can say which name was retired')
  }
  assert.equal(resolveConfig({ enabled: true, gear: 'auto' }).legacyGear, undefined)
  assert.equal(resolveConfig({ enabled: true, gear: 'safe' }).legacyGear, undefined)
})

test('an explicit override is authoritative, which is what the experiment arms use', () => {
  // `gear: turbo` from a patch is read as auto; passed as an override (an
  // assigned arm) it is kept as written, so a trial can still pin a width. The
  // control arm passes `enabled: false`, not a fake gear id.
  const assigned = resolveConfig({ enabled: true, gear: 'turbo' }, { gear: 'turbo', enabled: true })
  assert.equal(assigned.gear, 'turbo')
  assert.equal(assigned.legacyGear, undefined)

  const paused = resolveConfig({ enabled: true }, { enabled: false })
  assert.equal(paused.enabled, false)
})

test('gears are width presets: nothing in the table mentions effort', () => {
  for (const [name, gear] of Object.entries(GEARS)) {
    for (const forbidden of ['floor', 'effort', 'reasoningEffort', 'thinking']) {
      assert.equal(forbidden in gear, false, `${name} must not declare ${forbidden}`)
    }
    assert.ok(Number.isFinite(gear.parallel) && gear.parallel >= 1, `${name} declares a width`)
    assert.ok(['off', 'light', 'full'].includes(gear.discipline), `${name} declares a discipline`)
  }
  assert.equal(GEARS[DEFAULT_GEAR].adaptive, true, 'the default is the adaptive gear')
  assert.ok(GEARS[DEFAULT_GEAR].level > GEARS[FALLBACK_GEAR].level, 'the fallback stays the least invasive')
})

test('normaliseGear degrades junk to the least invasive gear', () => {
  assert.equal(normaliseGear(undefined), DEFAULT_GEAR)
  assert.equal(normaliseGear(null), DEFAULT_GEAR)
  assert.equal(normaliseGear(''), DEFAULT_GEAR)
  assert.equal(normaliseGear('  Auto '), 'auto')
  assert.equal(normaliseGear('AUTO'), 'auto')
  assert.equal(normaliseGear(3), 'auto')
  assert.equal(normaliseGear(0), 'safe')
  assert.equal(normaliseGear('9'), FALLBACK_GEAR)
  assert.equal(normaliseGear('nonsense'), FALLBACK_GEAR)
  assert.equal(normaliseGear({}), FALLBACK_GEAR)
  assert.equal(normaliseGear([]), FALLBACK_GEAR)
})

test('parallel is clamped to what the harness can run', () => {
  assert.equal(resolveConfig({ gear: 'auto', parallel: 99 }).parallel, 8)
  assert.equal(resolveConfig({ gear: 'auto', parallel: 0 }).parallel, GEARS.auto.parallel)
  assert.equal(resolveConfig({ gear: 'auto', parallel: -3 }).parallel, GEARS.auto.parallel)
  assert.equal(resolveConfig({ gear: 'auto', parallel: 'lots' }).parallel, GEARS.auto.parallel)
  assert.equal(resolveConfig({ gear: 'auto', parallel: 1 }).parallel, 1, '1 is the documented "no fan-out"')
  assert.equal(resolveConfig({ gear: 'safe', parallel: 8 }).parallel, 1, 'safe never asks for a batch')
})

test('output discipline can be turned off without turning the fan-out off', () => {
  const cfg = resolveConfig({ gear: 'auto', outputDiscipline: false })
  assert.equal(cfg.discipline, 'off')
  assert.ok(cfg.parallel > 1)
})

test('volatile references are unwrapped, plain data passes through', () => {
  const ref = {
    [Symbol.for('cosmokit.volatile.write')]: true,
    get: () => ({ enabled: true, gear: 'auto' }),
  }
  assert.equal(isVolatileRef(ref), true)
  assert.equal(isVolatileRef({ enabled: true }), false)
  assert.deepEqual(plainConfigValue(ref), { enabled: true, gear: 'auto' })
  assert.deepEqual(plainConfigValue({ a: 1 }), { a: 1 })
  assert.equal(resolveConfig(ref).enabled, true)
})

test('stableKey is order-independent, bounded, and cycle-safe', () => {
  assert.equal(stableKey({ a: 1, b: 2 }), stableKey({ b: 2, a: 1 }))
  assert.notEqual(stableKey({ a: 1 }), stableKey({ a: 2 }))
  assert.ok(stableKey({ text: 'x'.repeat(5000) }).length <= 401)
  const cyclic = { name: 'a' }
  cyclic.self = cyclic
  assert.equal(typeof stableKey(cyclic), 'string')
  assert.equal(stableKey(undefined), stableKey(null))
})

test('contentChars counts text blocks and survives junk', () => {
  assert.equal(contentChars([{ type: 'text', text: 'abc' }]), 3)
  assert.equal(contentChars([{ text: 'a' }, { content: 'bc' }]), 3)
  assert.equal(contentChars(undefined), 0)
  assert.equal(contentChars([null, 1]), 0, 'a block that is not an object is not measurable')
})

/* ------------------------------------------------------------------ source */

/**
 * The strongest guarantee a unit test can give: the mechanism cannot come back
 * quietly. Comments are stripped, so the file may still *explain* the
 * retirement — only code assigning a thinking level fails.
 */
test('no shipped module constructs a thinking-level field', async () => {
  const root = new URL('../', import.meta.url)
  const files = ['index.js', 'client.js']
  for (const entry of await readdir(new URL('src/', root))) {
    if (entry.endsWith('.js')) files.push(`src/${entry}`)
  }

  for (const file of files) {
    const source = await readFile(new URL(file, root), 'utf8')
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    assert.doesNotMatch(code, /reasoningEffort\s*:/, `${file} must not build a reasoningEffort field`)
    assert.doesNotMatch(code, /\bthinking\s*:\s*\{/, `${file} must not build a thinking payload`)
    assert.doesNotMatch(code, /\bdecideEffort\b/, `${file} must not resurrect the effort policy`)
  }
})
