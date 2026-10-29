/**
 * Per-session choices, on both sides of the wire.
 *
 * The host module (`src/state.js`) and the browser copy inside `client.js` are
 * two implementations of one format: the host reads the `sessions` column to
 * decide what a request runs at, the browser writes it. If they disagree the
 * symptom is the worst kind — a switch that appears to work and changes nothing
 * — so every fixture here is fed to both copies and the results are compared.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import {
  SESSIONS_LIMIT,
  choiceFor,
  clearChoice,
  configOverridesFor,
  encodeChoices,
  parseChoices,
  resolveChoice,
  writeChoice,
} from '../src/state.js'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * Strip a value back to this realm.
 *
 * The browser copy runs inside a `vm` context, so its objects carry that
 * context's prototypes and `deepStrictEqual` rejects them as different types
 * even when every field matches. Comparing the JSON form compares the format,
 * which is the thing under test.
 */
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** A config field the loader handed over as a live reference. */
const volatile = value => ({ [VOLATILE_WRITE]: () => {}, get: () => value })

/**
 * The browser copy of the format helpers, loaded from the shipped bundle.
 *
 * The bundle registers itself with `window.__ModuleLoader__`; the loader here is
 * a one-line stub, and `react` is the only module it may require.
 */
function browserChoices() {
  const loaded = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (bundle) => loaded.push(bundle) },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    document: { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild: () => {} } },
    setTimeout,
    clearTimeout,
    console,
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.equal(loaded.length, 1, 'the bundle registers itself once')
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: (fn) => fn(),
  }
  const module = loaded[0].factory((name) => {
    assert.equal(name, 'react', `the bundle may only require react, asked for ${name}`)
    return react
  })
  assert.ok(module.__choices, 'the bundle exports its choice helpers for parity tests')
  return module.__choices
}

/* ------------------------------------------------------------------ reading */

test('the sessions column survives every shape the loader can hand over', () => {
  assert.deepEqual(parseChoices(undefined), {})
  assert.deepEqual(parseChoices(''), {})
  assert.deepEqual(parseChoices('   '), {})
  assert.deepEqual(parseChoices('not json at all'), {}, 'a hand-edited typo is not a crash')
  assert.deepEqual(parseChoices('[]'), {}, 'arrays are not a map')
  assert.deepEqual(parseChoices('null'), {})

  const map = { 'session-a': { enabled: true, gear: 'turbo', ts: 5 } }
  assert.deepEqual(parseChoices(JSON.stringify(map)), map, 'the durable form')
  assert.deepEqual(parseChoices(map), map, 'an already-parsed document')
  assert.deepEqual(parseChoices(volatile(JSON.stringify(map))), map, 'a live volatile reference')
})

test('unusable entries are dropped instead of trusted', () => {
  const parsed = parseChoices(JSON.stringify({
    '': { enabled: true },
    'session-a': 'on',
    'session-b': { enabled: 'yes', gear: '', ts: 'soon' },
    'session-c': { enabled: false, gear: 'fast', ts: 12, extra: 'ignored' },
    'session-d': { gear: 'max' },
    'session-e': { discipline: 'late', stepBudget: 15, map: true, ts: 3 },
    'session-f': { discipline: 'sometimes', stepBudget: -2, map: 'yes' },
    'session-g': { stepBudget: 4.6, discipline: false },
  }))
  assert.deepEqual(parsed, {
    'session-c': { enabled: false, gear: 'fast', ts: 12 },
    'session-d': { gear: 'max' },
    'session-e': { discipline: 'late', stepBudget: 15, map: true, ts: 3 },
    'session-g': { discipline: false, stepBudget: 4 },
  })
})

test('an entry is looked up by session, and absence means inherit', () => {
  const column = JSON.stringify({
    'session-a': { enabled: true, gear: 'turbo', ts: 1 },
    'session-b': { gear: 'safe', ts: 2 },
  })
  assert.deepEqual(choiceFor(column, 'session-a'), { enabled: true, gear: 'turbo' })
  assert.deepEqual(choiceFor(column, 'session-b'), { gear: 'safe' }, 'ts is not part of the choice')
  assert.equal(choiceFor(column, 'session-c'), undefined)
  assert.equal(choiceFor(column, undefined), undefined)
  assert.equal(choiceFor(column, ''), undefined)
})

test('a session entry can pin all four panel fields', () => {
  const column = JSON.stringify({ 'session-a': { enabled: true, gear: 'fast', discipline: false, stepBudget: 30, map: true, batch: true, ts: 1 } })
  assert.deepEqual(choiceFor(column, 'session-a'), {
    enabled: true,
    gear: 'fast',
    discipline: false,
    stepBudget: 30,
    map: true,
    batch: true,
  })
})

test('the compact column is spelled as config fields for the policy', () => {
  const column = JSON.stringify({ 'session-a': { discipline: 'late', stepBudget: 15, map: true, batch: true } })
  assert.deepEqual(
    configOverridesFor(column, 'session-a'),
    { outputDiscipline: 'late', stepBudget: 15, workspaceMap: true, openBatch: true },
    'map is short for workspaceMap, batch for openBatch',
  )
  assert.equal(choiceFor(JSON.stringify({ 'a': { ts: 1, batch: 'yes' } }), 'a'), undefined, 'a non-boolean is not a choice')
  assert.equal(configOverridesFor(column, 'session-b'), undefined, 'no entry means inherit')
  assert.equal(configOverridesFor(column, undefined), undefined)
  assert.equal(configOverridesFor(JSON.stringify({ 'x': { ts: 1 } }), 'x'), undefined, 'a timestamp is not a choice')
})

test('the effective pair falls back field by field, and says whether it was scoped', () => {
  const fallback = { enabled: false, gear: 'fast' }
  const column = JSON.stringify({ 'session-a': { gear: 'turbo' }, 'session-b': { enabled: true } })

  assert.deepEqual(resolveChoice(column, 'session-z', fallback), { enabled: false, gear: 'fast', scoped: false })
  assert.deepEqual(
    resolveChoice(column, 'session-a', fallback),
    { enabled: false, gear: 'turbo', scoped: true },
    'a gear-only entry still inherits the switch',
  )
  assert.deepEqual(
    resolveChoice(column, 'session-b', fallback),
    { enabled: true, gear: 'fast', scoped: true },
    'and the other way round',
  )
})

/* ------------------------------------------------------------------ writing */

test('writing one entry keeps the others and stamps recency', () => {
  const column = JSON.stringify({ 'session-a': { enabled: true, gear: 'turbo', ts: 1 } })
  const { sessions, map } = writeChoice(column, 'session-b', { enabled: false, gear: 'safe' }, 42)

  assert.equal(map['session-a'].ts, 1, 'the other conversation is untouched')
  assert.deepEqual(map['session-b'], { enabled: false, gear: 'safe', ts: 42 })
  assert.equal(JSON.parse(sessions)['session-b'].ts, 42, 'the returned column is the durable form')
})

test('a one-field write keeps the other three choices', () => {
  const column = JSON.stringify({
    'session-a': { enabled: true, discipline: 'late', stepBudget: 15, map: true, ts: 1 },
  })
  const { map } = writeChoice(column, 'session-a', { stepBudget: 0 }, 5)
  assert.deepEqual(map['session-a'], { enabled: true, discipline: 'late', stepBudget: 0, map: true, ts: 5 })
})

test('writing the same entry again merges instead of replacing', () => {
  const column = JSON.stringify({ 'session-a': { enabled: true, gear: 'turbo', ts: 1 } })
  const { map } = writeChoice(column, 'session-a', { enabled: false }, 9)
  assert.deepEqual(map['session-a'], { enabled: false, gear: 'turbo', ts: 9 }, 'the gear survives a switch flip')
})

test('a write with no session, or from a broken column, still returns valid JSON', () => {
  assert.deepEqual(JSON.parse(writeChoice('garbage', undefined, { enabled: true }).sessions), {})
  const { map } = writeChoice('garbage', 'session-a', { enabled: true }, 3)
  assert.deepEqual(map, { 'session-a': { enabled: true, ts: 3 } }, 'one bad column does not block new entries')
})

test('encoding prunes the oldest entries, not the newest', () => {
  /** @type {Record<string, {enabled: boolean, ts: number}>} */
  const map = {}
  for (let index = 0; index < SESSIONS_LIMIT + 10; index += 1) {
    map[`session-${index}`] = { enabled: true, ts: index }
  }
  const encoded = encodeChoices(map)
  const parsed = JSON.parse(encoded)
  assert.equal(Object.keys(parsed).length, SESSIONS_LIMIT, 'the column is bounded')
  assert.equal(parsed['session-0'], undefined, 'the oldest entry went first')
  assert.equal(parsed[`session-${SESSIONS_LIMIT + 9}`].ts, SESSIONS_LIMIT + 9, 'the newest entry stayed')
})

test('clearing one entry leaves the column usable', () => {
  const column = JSON.stringify({ 'session-a': { enabled: true, ts: 1 }, 'session-b': { enabled: false, ts: 2 } })
  assert.deepEqual(JSON.parse(clearChoice(column, 'session-a')), { 'session-b': { enabled: false, ts: 2 } })
  assert.deepEqual(JSON.parse(clearChoice('', 'session-a')), {})
})

/* ------------------------------------------------------------------- parity */

test('the browser copy reads the column exactly like the host does', () => {
  const browser = browserChoices()
  assert.equal(browser.SESSIONS_LIMIT, SESSIONS_LIMIT, 'one limit, two implementations')
  const fixtures = [
    undefined,
    '',
    'garbage',
    '[]',
    '{"": {"enabled": true}}',
    JSON.stringify({ 'session-a': { enabled: true, gear: 'turbo', ts: 1 } }),
    JSON.stringify({ 'session-a': { enabled: 'yes', gear: '' } }),
    JSON.stringify({ 'session-b': { gear: 'safe' } }),
  ]
  for (const fixture of fixtures) {
    assert.deepEqual(
      plain(browser.parseChoices(fixture)),
      parseChoices(fixture),
      `the two copies disagree about ${JSON.stringify(fixture)}`,
    )
  }
})

test('the browser copy writes a column the host reads back unchanged', () => {
  const browser = browserChoices()
  const withOwn = browser.withOwn
  const merged = withOwn({}, 'session-a', { enabled: true, gear: 'max', discipline: false, stepBudget: 30, map: true })
  const encoded = browser.encodeChoices(merged)

  assert.deepEqual(
    choiceFor(encoded, 'session-a'),
    { enabled: true, gear: 'max', discipline: false, stepBudget: 30, map: true },
    'the host sees all five values, not just the switch',
  )
  assert.deepEqual(
    writeChoice(encoded, 'session-b', { enabled: false, gear: 'safe' }, 7).map['session-a'],
    { ...merged['session-a'] },
    'and the entry the browser wrote is the entry the host keeps',
  )

  assert.deepEqual(plain(withOwn({}, undefined, { enabled: true })), {}, 'no session means no entry, never a wrong key')
  const one = { 'session-a': { enabled: true, gear: 'max', ts: 1 } }
  const flipped = plain(withOwn(one, 'session-a', { enabled: false }))
  assert.equal(flipped['session-a'].enabled, false)
  assert.equal(flipped['session-a'].gear, 'max', 'an absent gear keeps the one already pinned')
  assert.equal(typeof flipped['session-a'].ts, 'number', 'recency is restamped on every write')
  assert.equal(one['session-a'].ts, 1, 'the input map is not mutated')
})

test('the lazy switch survives the browser column and the host reader alike', () => {
  // The lazy row writes a one-field entry, so it was the first entry whose only
  // key was not one of the five older ones: the browser copy dropped it on the
  // way out and the panel painted the switch back off.
  const browser = browserChoices()
  const column = browser.encodeChoices(browser.withOwn({}, 'session-a', { lazy: true }))
  assert.deepEqual(plain(choiceFor(column, 'session-a')), { lazy: true }, 'the host reads the field back')
  assert.equal(plain(browser.parseChoices(column))['session-a'].lazy, true, 'and so does the panel')
  assert.equal(browser.parseChoices(column)['session-a'].lazy, true, 'the switch reads on, not undefined')

  const off = browser.encodeChoices(browser.withOwn(browser.parseChoices(column), 'session-a', { lazy: false }))
  assert.deepEqual(plain(choiceFor(off, 'session-a')), { lazy: false }, 'turning it off is a write, not a missing key')
  assert.equal(browser.parseChoices(JSON.stringify({ 'session-a': { lazy: 'yes', ts: 3 } }))['session-a'], undefined, 'a non-boolean is not a switch')
})

test('two conversations keep independent choices in one column', () => {
  const browser = browserChoices()
  let column = browser.encodeChoices(browser.withOwn({}, 'session-fast', { enabled: true, discipline: 'late' }))
  column = browser.encodeChoices(JSON.parse(column))
  assert.equal(choiceFor(column, 'session-fast').discipline, 'late')

  // A second tab changes its own rows only.
  const second = browser.withOwn(browser.parseChoices(column), 'session-plain', { enabled: true, discipline: false })
  const encoded = browser.encodeChoices(second)
  assert.equal(choiceFor(encoded, 'session-fast').discipline, 'late', 'the first conversation is untouched')
  assert.equal(choiceFor(encoded, 'session-plain').discipline, false)
  assert.equal(choiceFor(encoded, 'session-untouched'), undefined, 'a third conversation still inherits')
})
