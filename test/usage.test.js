/**
 * Usage parsing across route dialects.
 *
 * The plugin is deliberately provider-agnostic, so the only provider-specific
 * thing it reads is the token counts. Those come in four shapes in practice —
 * the harness's own camelCase projection, the OpenAI chat-completions shape a
 * self-hosted gateway relays, the newer OpenAI `input_tokens` shape, and the
 * Anthropic shape — and a proxy may drop usage entirely. Each case has to land
 * on the same numbers without throwing.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { findUsage, readOutputTokens, readUsage } from '../src/usage.js'

test('the harness spelling is read as is', () => {
  const tokens = readUsage({
    inputTokens: 1200,
    outputTokens: 90,
    reasoningTokens: 12,
    cacheReadTokens: 4000,
    cacheWriteTokens: 60,
  })
  assert.deepEqual(tokens, { input: 1200, output: 90, reasoning: 12, cacheRead: 4000, cacheWrite: 60 })
})

test('an OpenAI-compatible gateway reports prompt/completion tokens, with nested details', () => {
  const tokens = readUsage({
    prompt_tokens: 900,
    completion_tokens: 40,
    total_tokens: 940,
    prompt_tokens_details: { cached_tokens: 300 },
    completion_tokens_details: { reasoning_tokens: 8 },
  })
  assert.deepEqual(tokens, { input: 900, output: 40, reasoning: 8, cacheRead: 300, cacheWrite: 0 })
})

test('the newer OpenAI shapes are the same numbers', () => {
  assert.equal(readUsage({ input_tokens: 500, output_tokens: 25 }).output, 25)
  assert.equal(readUsage({ input_tokens: 500, output_tokens: 25 }).input, 500)
})

test('an Anthropic-shaped gateway is understood, cache tokens included', () => {
  const tokens = readUsage({
    input_tokens: 300,
    output_tokens: 70,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 400,
  })
  assert.deepEqual(tokens, { input: 300, output: 70, reasoning: 0, cacheRead: 2000, cacheWrite: 400 })
})

test('a Google-shaped route is not a crash either', () => {
  const tokens = readUsage({ promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 7 })
  assert.deepEqual(tokens, { input: 120, output: 30, reasoning: 7, cacheRead: 0, cacheWrite: 0 })
})

test('the official harness payload wins over the gateway spelling when both exist', () => {
  const tokens = readUsage({ outputTokens: 90, output_tokens: 1 })
  assert.equal(tokens.output, 90, 'the harness has already normalised the route')
})

test('a missing or malformed usage object yields zeros, never NaN or a throw', () => {
  const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  for (const usage of [undefined, null, 'n/a', 42, {}, { output_tokens: -3 }, { completion_tokens: 'lots' }]) {
    assert.deepEqual(readUsage(usage), zero, `usage=${JSON.stringify(usage)}`)
  }
})

test('usage is found beside the message, under the message, or under a response', () => {
  assert.equal(readOutputTokens({ usage: { outputTokens: 10 } }), 10)
  assert.equal(readOutputTokens({ message: { usage: { output_tokens: 11 } } }), 11, 'older adapter shape')
  assert.equal(readOutputTokens({ response: { usage: { completion_tokens: 12 } } }), 12, 'OpenAI envelope')
  assert.equal(readOutputTokens({ message: { response: { usage: { completion_tokens: 13 } } } }), 13)
  assert.equal(readOutputTokens({ outputTokens: 14 }), 14, 'counts stored flat on the event')
  assert.equal(readOutputTokens({}), 0)
  assert.equal(readOutputTokens(undefined), 0)
  assert.equal(findUsage({ nothing: true }), undefined)
})

test('a gateway that reports nothing does not look like a zero-output step', () => {
  // Both are 0, which the scheduler treats as "no evidence" rather than "no
  // output"; the distinction is documented in usage.js, and this test pins the
  // contract so a later reader does not invent a sentinel.
  assert.equal(readOutputTokens({ usage: {} }), 0)
  assert.equal(readOutputTokens({ usage: { output_tokens: 0 } }), 0)
})
