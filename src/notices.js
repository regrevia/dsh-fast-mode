/**
 * The two messages fast mode is allowed to write into a conversation.
 *
 * Everything else the plugin touches is a prompt section, a request field, or a
 * tool call — all invisible to the transcript. A message is different: it is
 * billed input, it shows up in the history, and it changes what the model reads
 * at that exact step. So there are exactly two reasons to send one:
 *
 * 1. **Reassertion after compaction.** A checkpoint replaces the history with a
 *    summary, and the summary is written by a model under its own budget; the
 *    measured symptom (the same one `dsh-batch-tool-calls` documents) is that a
 *    session which batched obediently for twenty steps starts issuing one call
 *    per step again right after a compaction. The static section is still in
 *    the system prompt, but attention has moved to the summary.
 * 2. **A conflict announcement.** When a plugin that duplicates part of this
 *    one is installed, the user is paying twice for the same prompt text and
 *    can get two cancellations of the same call. Saying so once, in the
 *    conversation, is more useful than a log line nobody reads.
 *
 * Both are `source: { kind: 'plugin:fast-mode' }` notices, which is what makes
 * the Web UI render them as a collapsed system line instead of as something the
 * user said. `summary` is capped at the host's 120-character notice limit.
 *
 * Session format v4 retired the bare `kind: 'plugin'` + `plugin` pair: a plugin
 * is now identified by its own `plugin:<name>` kind, which is exactly what DSH's
 * own v3→v4 migration derives for rows this plugin wrote earlier, so both
 * generations read back under one shape. Writing the retired pair makes the
 * v4 encoder throw `SessionFormatError: format v4 message requires a
 * producer-owned source kind`, which the host surfaces as a failed turn every
 * time a post-compaction reminder is injected.
 *
 * @module dsh-fast-mode/notices
 */
import { randomUUID } from 'node:crypto'

/** The `source` every message from this plugin carries. */
export const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin:fast-mode' })

/**
 * The v4 admission rule, mirrored from the released codec.
 *
 * `dsh-session-format-v3-to-v4` refuses a message whose `source.kind` is empty
 * or exactly `'plugin'` (`format v4 message requires a producer-owned source
 * kind`). A plugin is identified by `plugin:<name>` now — the same kind that
 * migration derives for rows written by older versions of this plugin.
 *
 * @param {unknown} source - candidate message source.
 * @returns {boolean} whether the v4 encoder will accept it.
 */
export function isProducerOwnedSource(source) {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return false
  const kind = /** @type {{kind?: unknown}} */ (source).kind
  return typeof kind === 'string' && kind.length > 0 && kind !== 'plugin'
}

/**
 * Refuse a shape the encoder would reject **before** the host sees it.
 *
 * The failure this guards against is expensive: the encoder throws while
 * persisting the event, outside any handler of ours, so a bad `source` takes
 * down the whole turn rather than the notice. Failing here instead means the
 * caller's `try/catch` drops the notice and the step proceeds untouched.
 *
 * @param {unknown} source - the source about to be attached to a message.
 * @returns {object} the same source, when it is admissible.
 */
function assertProducerOwnedSource(source) {
  if (!isProducerOwnedSource(source)) {
    throw new Error(
      'dsh-fast-mode: refusing to emit a message whose source is not producer-owned; '
        + 'the v4 encoder only accepts `plugin:<name>` and throws on a bare `plugin`',
    )
  }
  return /** @type {object} */ (source)
}

/** The host truncates a notice summary at this many characters. */
export const SUMMARY_MAX_CHARS = 120

/** Recursive freeze, matching the host's own `createUserMessage`. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

/** Truncate to the host's single-line summary limit. */
function summaryOf(text) {
  return text.length <= SUMMARY_MAX_CHARS ? text : text.slice(0, SUMMARY_MAX_CHARS - 1) + '\u2026'
}

/**
 * Build a `notice`-form user message.
 *
 * The host does not export `createUserMessage`, so this is the minimal version
 * of its shape: a branded id, `role: 'user'`, one text block, and a `source`
 * that identifies the plugin plus the notice summary the UI folds.
 *
 * @param {string} text - the model-visible body.
 * @param {string} [summary] - the folded one-liner.
 * @returns {object} a frozen `UserMessage`.
 */
export function createNoticeMessage(text, summary) {
  const source = assertProducerOwnedSource({ ...PLUGIN_SOURCE, form: 'notice', summary: summary ?? summaryOf(text) })
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  })
}

/**
 * The post-compaction reminder.
 *
 * Deliberately two sentences plus three bullets: it is paid on the step where
 * the model resumes work, and a long reminder would cost more than the steps it
 * saves.
 *
 * @param {object} config - output of `resolveConfig`.
 * @returns {object} the frozen notice message.
 */
export function buildReassertMessage(config) {
  const parallel = Number.isFinite(config?.parallel) ? Math.floor(config.parallel) : 0
  const target = parallel > 1 ? `up to ${parallel} independent calls` : 'the independent calls'
  const text = [
    'Fast mode reminder: the context was just compacted and the speed rules still hold.',
    `- Issue ${target} per message; split only when a call needs the previous result.`,
    '- Bound every shell call: run servers, watchers and tails in the background instead of the foreground.',
    '- When a call is cancelled or comes back malformed, change something before retrying (narrower command, `script_path`, background job).',
  ].join('\n')
  return createNoticeMessage(text, 'fast mode: batching and bounded calls still apply')
}

/** Human-readable names for the plugins this one supersedes. */
export const PEER_NAMES = Object.freeze({
  'dsh-batch-tool-calls': 'dsh-batch-tool-calls',
  'dsh-ops': 'dsh-ops',
})

/**
 * The conflict announcement, sent once per process when a duplicate is found.
 *
 * @param {string[]} conflicts - plugin ids, in discovery order.
 * @returns {object} the frozen notice message.
 */
export function buildConflictMessage(conflicts) {
  const names = conflicts.map(id => PEER_NAMES[id] ?? id).join(' / ')
  const text = [
    `Fast mode found a plugin that duplicates part of its job: ${names}.`,
    'It and fast mode must not be enabled together — both register batching guidance (and both may cancel the same tool call), '
      + 'so enabling both pays twice for the same prompt text and can produce two cancellations of one call.',
    'Pick one: fast mode already covers batched independent calls, a post-compaction reminder, and a per-gear ceiling on a single tool call.',
  ].join(' ')
  return createNoticeMessage(text, 'fast mode: remove the overlapping batching/tool plugin')
}
