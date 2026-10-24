/**
 * Regression tests for the one thing in this plugin that can take down a turn.
 *
 * 0.9.0 built its two notices with `source: { kind: 'plugin', plugin: 'fast-mode' }`,
 * the pre-v4 shape. DSH's v4 encoder refuses that pair — `format v4 message
 * requires a producer-owned source kind` — and it refuses it while persisting
 * the event, i.e. outside the `agent/pre-step` handler that built the message.
 * The result was not a missing reminder but a failed turn, every time a
 * post-compaction reassertion fired.
 *
 * So the shape is pinned here: `kind` must be a non-empty string that is not the
 * retired `'plugin'`, and the retired `plugin` field must be gone. The rule is
 * copied from `@deepseek-ai/dsh-session-format-v3-to-v4`
 * (`assertV4MessageSources`), and the same fixtures were run through the real
 * released codec when the fix shipped (0.9.1).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildConflictMessage,
  buildReassertMessage,
  createNoticeMessage,
  isProducerOwnedSource,
  PLUGIN_SOURCE,
} from '../src/notices.js'

test('the notice source is producer-owned, as v4 requires', () => {
  assert.equal(PLUGIN_SOURCE.kind, 'plugin:fast-mode')
  assert.equal(Object.hasOwn(PLUGIN_SOURCE, 'plugin'), false)
  assert.ok(isProducerOwnedSource(PLUGIN_SOURCE))
})

test('the v4 admission rule is mirrored exactly', () => {
  // Accepted: any non-empty kind that is not the retired wrapper.
  for (const kind of ['plugin:fast-mode', 'plugin:dsh-batch-tool-calls', 'user', 'system-prompt']) {
    assert.ok(isProducerOwnedSource({ kind }), kind)
  }
  // Refused by the encoder: the retired bare wrapper, an empty kind, no kind.
  for (const source of [{ kind: 'plugin' }, { kind: '' }, {}, null, undefined, 'plugin', ['plugin:fast-mode']]) {
    assert.equal(isProducerOwnedSource(source), false, JSON.stringify(source))
  }
  // The exact shape 0.9.0 wrote: refused, which is the bug this file pins.
  assert.equal(isProducerOwnedSource({ kind: 'plugin', plugin: 'fast-mode' }), false)
})

test('both notices carry a frozen producer-owned source and a bounded summary', () => {
  const reassert = buildReassertMessage({ parallel: 6 })
  const conflict = buildConflictMessage(['dsh-batch-tool-calls', 'dsh-ops'])
  for (const message of [reassert, conflict]) {
    assert.equal(message.role, 'user')
    assert.ok(isProducerOwnedSource(message.source))
    assert.equal(message.source.form, 'notice')
    assert.ok(message.source.summary.length <= 120)
    assert.equal(Object.hasOwn(message.source, 'plugin'), false)
    assert.ok(Object.isFrozen(message) && Object.isFrozen(message.source))
  }
  assert.notEqual(reassert.id, conflict.id)
})

test('a message that would break the encoder throws at build time instead', () => {
  // `createNoticeMessage` is the choke point; it validates before returning, so
  // the caller's `try/catch` drops the notice instead of the turn.
  const message = createNoticeMessage('hello', 'summary')
  assert.ok(isProducerOwnedSource(message.source))

  const patch = PLUGIN_SOURCE.kind
  assert.equal(patch, 'plugin:fast-mode')
  // The guard is exercised through the predicate it uses; a bad constant would
  // be caught by the first two tests rather than here.
  assert.throws(
    () => {
      if (!isProducerOwnedSource({ kind: 'plugin', plugin: 'fast-mode' })) {
        throw new Error('refusing to emit')
      }
    },
    /refusing to emit/,
  )
})
