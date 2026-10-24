/**
 * The official DeepSeek API contract, pinned.
 *
 * The policy never reasons about what an effort *means* — it only moves one
 * rung at a time through the ids a route declares. That is what makes it portable
 * to a gateway whose `medium` is a real level and to the official API where
 * `medium` is a documentation alias for `high`. This file pins the official half
 * of that contract:
 *
 *   - `@deepseek-ai/dsh-llm-deepseek` 0.2.1-rc.3 declares
 *     `['off', 'low', 'high', 'max']`, default `high`, and sends `off` as
 *     `thinking: {type: 'disabled'}` rather than as an effort id.
 *   - https://api-docs.deepseek.com/api/list-models declares
 *     `effort.supported_levels = ['low','high','max']`, `default_level: 'high'`.
 *   - https://api-docs.deepseek.com/guides/thinking_mode declares the
 *     quantization `minimal→low, medium→high, xhigh→high, ultra→max`.
 *
 * If a future adapter renames or reorders the ladder, these tests fail loudly
 * instead of the plugin silently sending a level the route does not have.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createState,
  decideEffort,
  DOCUMENTED_ALIASES,
  GEARS,
  rankOf,
  readSignals,
  resolveConfig,
  resolvePlan,
} from '../src/effort.js'

/** Exactly what the official adapter declares today, `off` first. */
const ADAPTER = ['off', 'low', 'high', 'max']
/** The documented wire levels; `none` is deliberately not among them. */
const DOCS = { supported_levels: ['low', 'high', 'max'], default_level: 'high' }
/** The quantization the thinking-mode guide prints verbatim, plus the two
 * non-wire names (`off` / `none`) the adapter itself synthesizes. */
const DOCS_QUANTIZATION = {
  off: 'none',
  none: 'none',
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'high',
  max: 'max',
  ultra: 'max',
}

const config = resolveConfig(undefined)
const plan = resolvePlan(ADAPTER, config)

test('the official ladder is emitted as declared, with `off` kept as `off`', () => {
  // The adapter synthesizes `off` from the thinking toggle and never sends it as
  // an effort id, so rewriting it to the canonical `none` would emit a level the
  // route does not declare.
  assert.deepEqual(plan.levels.map(level => level.id), ADAPTER)
  assert.equal(plan.aliased, true)
  assert.equal(plan.indexOf('off'), 0)
  assert.equal(plan.indexOf('none'), -1)
})

test('the documented quantization is the alias table the plugin applies', () => {
  assert.deepEqual({ ...DOCUMENTED_ALIASES }, DOCS_QUANTIZATION)
  // `none` disables thinking and is not an `output_config.effort` value, so it
  // is only ever a request that the official ladder resolves to `off`.
  assert.equal(plan.indexOf('none'), -1)
  assert.equal(DOCS.supported_levels.includes('none'), false)
  assert.equal(DOCS.supported_levels.includes(DOCS.default_level), true)
})

test('no gear and no step ever names an effort outside the declared set', () => {
  const declared = new Set(ADAPTER)
  for (const gear of Object.keys(GEARS)) {
    const cfg = resolveConfig({ gear })
    const gearPlan = resolvePlan(ADAPTER, cfg)
    for (const step of [1, 2, 3, 4, 6, 9, 20]) {
      for (const current of ADAPTER) {
        const out = decideEffort({
          config: cfg,
          plan: gearPlan,
          step,
          current,
          signals: readSignals(createState(), 'agent'),
        })
        assert.ok(declared.has(out), `${gear} step ${step} would send ${out}`)
        // Downgrade only: the policy may hold the current level or lower it,
        // never ask for more deliberation than the session already has.
        assert.ok(rankOf(out) <= rankOf(current), `${gear} step ${step} escalated ${current} to ${out}`)
      }
    }
  }
})

test('a gateway with a real `medium` is not collapsed into `high`', () => {
  // What litellm + Anthropic Messages declares when the upstream has five
  // distinct levels. `medium` here is a real notch (and may be a token budget),
  // so applying the official quantization would silently cost a rung.
  const gateway = ['off', 'minimal', 'low', 'medium', 'high']
  const gatewayPlan = resolvePlan(gateway, config)
  assert.equal(gatewayPlan.aliased, false)
  assert.deepEqual(gatewayPlan.levels.map(level => level.id), gateway)
  assert.notEqual(gatewayPlan.indexOf('medium'), gatewayPlan.indexOf('high'))
})
