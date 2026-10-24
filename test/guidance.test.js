/**
 * The model-facing guidance: what it says, at which gear, and what it costs.
 *
 * These are the assertions that keep the prompt honest. A paragraph of text in
 * every request of every agent is a real token bill, so every block here has to
 * earn its place: the fan-out target must match the resolved config, the
 * speculative-read sentence must not appear before the gear is wide enough for
 * it, the output discipline must be switchable off, and `parallel: 1` must cost
 * nothing at all.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig } from '../src/effort.js'
import { buildGuidance, GUIDANCE_ORDER, GUIDANCE_SECTION } from '../src/guidance.js'

const BASE = { enabled: true, metrics: false, benchmarkFile: '' }

/** @param {object} patch */
const resolve = (patch) => resolveConfig({ ...BASE, ...patch })

test('the safe gear is invisible: no text, no tokens', () => {
  const live = resolve({ gear: 'safe' })
  assert.equal(live.directive, false)
  assert.equal(live.discipline, 'off')
  assert.equal(buildGuidance(live), undefined)
})

test('the section identity is stable, because a reload must replace it', () => {
  assert.equal(GUIDANCE_SECTION, 'fast-mode:execution-speed')
  assert.equal(GUIDANCE_ORDER, 520)
})

test('every directive gear asks for the fan-out it was configured with', () => {
  for (const [gear, expected] of [['fast', 4], ['turbo', 6], ['max', 8], ['ludicrous', 8]]) {
    const text = buildGuidance(resolve({ gear }))
    assert.match(text, new RegExp(`up to ${expected} independent calls per message`), `${gear} default fan-out`)
  }
  // `parallel` overrides the gear default; that is the documented way to push a
  // gear past its own number.
  assert.match(buildGuidance(resolve({ gear: 'turbo', parallel: 8 })), /up to 8 independent calls per message/)
})

test('parallel: 1 is the documented "switch on, no fan-out" setting and costs nothing', () => {
  const live = resolve({ gear: 'turbo', parallel: 1 })
  assert.equal(live.enabled, true)
  assert.equal(live.parallel, 1)
  assert.equal(buildGuidance(live), undefined, 'no text to pay for when no fan-out is asked for')
})

test('the output discipline is present at every directive gear, and heavier at the top', () => {
  const fast = buildGuidance(resolve({ gear: 'fast' }))
  const turbo = buildGuidance(resolve({ gear: 'turbo' }))
  for (const text of [fast, turbo]) {
    assert.match(text, /visible text is charged at the same rate/, 'the reason must be stated')
    assert.match(text, /Do not announce a tool call/, 'no narration around calls')
    assert.match(text, /the answer the user actually asked for still gets written out/, 'the user-facing answer survives')
  }
  assert.doesNotMatch(fast, /a bare call is cheaper than a narrated one/, 'fast keeps the light variant')
  assert.match(turbo, /a bare call is cheaper than a narrated one/, 'turbo asks for bare calls')
})

test('the speculative-read sentence only ships where a step is wide enough to hold it', () => {
  assert.equal(resolve({ gear: 'fast' }).discipline, 'light')
  assert.doesNotMatch(buildGuidance(resolve({ gear: 'fast' })), /a wasted read costs a few hundred/)
  for (const gear of ['turbo', 'max', 'ludicrous']) {
    assert.match(buildGuidance(resolve({ gear })), /a wasted read costs a few hundred/, gear)
  }
})

test('outputDiscipline: false keeps the fan-out and drops the prose rules', () => {
  const live = resolve({ gear: 'turbo', outputDiscipline: false })
  assert.equal(live.discipline, 'off')
  const text = buildGuidance(live)
  assert.match(text, /up to 6 independent calls per message/, 'fan-out is independent of the prose rules')
  assert.doesNotMatch(text, /visible text is charged at the same rate/, 'the user asked for verbose answers')
})

test('the guidance grows with the gear and stays small in absolute terms', () => {
  const sizes = ['fast', 'turbo', 'max'].map(gear => buildGuidance(resolve({ gear })).length)
  assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b), 'a higher gear must not ship less guidance')
  // ~4 chars per token: even the biggest gear stays under ~800 input tokens on
  // a request that already carries a system prompt. The batching block is ~1 KB
  // and the bounded-calls block ~0.5 KB; both are amortised over a step that
  // costs ~90 k prompt tokens, so they are noise next to the round trips and the
  // cancelled calls they remove.
  assert.ok(sizes.at(-1) < 3000, `guidance is ${sizes.at(-1)} chars`)
})
