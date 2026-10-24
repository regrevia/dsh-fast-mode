/**
 * The model-facing guidance: what it says, at which width, and what it costs.
 *
 * These are the assertions that keep the prompt honest. A paragraph of text in
 * every request of every agent is a real token bill, so every block here has to
 * earn its place: the fan-out target must match the resolved width, the
 * speculative-read sentence must not appear before a step is wide enough for it,
 * the output discipline must be switchable off, `parallel: 1` must cost nothing,
 * and — the line that must never blur — no text may ask the model to think less.
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

test('the text asks for the width it was configured with', () => {
  for (const width of [2, 4, 6, 8]) {
    assert.match(
      buildGuidance(resolveConfig(BASE, { parallel: width })),
      new RegExp(`up to ${width} independent calls per message`),
      `width ${width}`,
    )
  }
  // The start width of the scheduler is what the default gear ships.
  assert.match(buildGuidance(resolve({ gear: 'auto' })), /up to \d+ independent calls per message/)
})

test('parallel: 1 is the documented "switch on, no fan-out" setting and costs nothing', () => {
  const live = resolve({ gear: 'auto', parallel: 1 })
  assert.equal(live.enabled, true)
  assert.equal(live.parallel, 1)
  assert.equal(buildGuidance(live), undefined, 'no text to pay for when no fan-out is asked for')
})

test('the output discipline is present by default and does not cost the user-facing answer', () => {
  const text = buildGuidance(resolve({ gear: 'auto' }))
  assert.match(text, /visible text is charged at the same rate/, 'the reason must be stated')
  assert.match(text, /Do not announce a tool call/, 'no narration around calls')
  assert.match(text, /the answer the user actually asked for still gets written out/, 'the answer survives')
  assert.match(text, /a bare call is cheaper than a narrated one/)
})

test('the speculative-read sentence only ships where a step is wide enough to hold it', () => {
  assert.doesNotMatch(buildGuidance(resolveConfig(BASE, { parallel: 2 })), /a wasted read costs a few hundred/)
  for (const width of [4, 6, 8]) {
    assert.match(buildGuidance(resolveConfig(BASE, { parallel: width })), /a wasted read costs a few hundred/, `width ${width}`)
  }
})

test('outputDiscipline: false keeps the fan-out and drops the prose rules', () => {
  const live = resolve({ gear: 'auto', outputDiscipline: false })
  assert.equal(live.discipline, 'off')
  const text = buildGuidance(live)
  assert.match(text, /up to \d+ independent calls per message/, 'fan-out is independent of the prose rules')
  assert.doesNotMatch(text, /visible text is charged at the same rate/, 'the user asked for verbose answers')
})

test('the discipline can be light without touching the width', () => {
  // `fast` survived only as an experiment arm; a patch naming it runs `auto`, so
  // this assertion has to pin the arm explicitly.
  const light = buildGuidance(resolveConfig(BASE, { enabled: true, gear: 'fast' }))
  assert.match(light, /up to 4 independent calls per message/)
  assert.match(light, /visible text is charged at the same rate/)
  assert.doesNotMatch(light, /a bare call is cheaper than a narrated one/, 'fast keeps the light variant')
})

test('the guidance stays small in absolute terms', () => {
  const text = buildGuidance(resolve({ gear: 'auto', parallel: 8 }))
  // ~4 chars per token: the whole section stays under ~250 input tokens on a
  // request that already carries a system prompt and a transcript. Both blocks
  // are amortised over a step that costs tens of thousands of prompt tokens, so
  // they are noise next to the round trips and the cancelled calls they remove.
  assert.ok(text.length < 4200, `guidance is ${text.length} chars`)
})

test('no prompt text ever asks the model to think less', () => {
  // The whole contract of fast mode: same thinking strength, sooner. A sentence
  // that trades depth for speed would break it just as surely as rewriting
  // `reasoningEffort` does, and it would be much harder to notice.
  for (const gear of ['safe', 'fast', 'auto', 'turbo', 'max', 'ludicrous']) {
    const text = buildGuidance(resolve({ gear, parallel: 8 })) ?? ''
    for (const banned of [
      /don't think/i, /do not think/i, /think less/i, /skip the (check|verification|test)/i,
      /reasoning is off/i, /deliberation is off/i, /lower (the )?effort/i, /less careful/i,
    ]) {
      assert.doesNotMatch(text, banned, `${gear} must not trade depth for speed`)
    }
  }
})
