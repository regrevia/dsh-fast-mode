/**
 * Token usage, in whichever dialect the route speaks.
 *
 * The plugin must not care which gateway is behind a model: the official API,
 * a self-hosted OpenAI-compatible proxy, an Anthropic-compatible one, and the
 * harness's own projection all describe the same four numbers under different
 * names. The scheduler needs the output count (it is decode time, so it is the
 * wall clock), and the metrics row wants the rest for an honest report. Reading
 * only `outputTokens` meant a gateway that says `completion_tokens` looked like
 * a turn that produced no output at all.
 *
 * Mapping, most specific first:
 *
 * | meaning     | accepted spellings                                                        |
 * | ----------- | ------------------------------------------------------------------------- |
 * | input       | `inputTokens`, `prompt_tokens`, `promptTokenCount`, `uncachedInputTokens` |
 * | output      | `outputTokens`, `output_tokens`, `completion_tokens`, `candidatesTokenCount` |
 * | reasoning   | `reasoningTokens`, `thoughtTokens`, `reasoning_tokens`                    |
 * | cache read  | `cacheReadTokens`, `cachedReadTokens`, `cache_read_input_tokens`, `cached_tokens` |
 * | cache write | `cacheWriteTokens`, `cachedWriteTokens`, `cache_creation_input_tokens`    |
 *
 * A missing usage object is not an error — some proxies do not report one — so
 * every reader here returns zeros rather than throwing, and the caller keeps its
 * own defaults.
 */

const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

const nested = (object, path) => {
  let current = object
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/**
 * Read the first numeric field that exists under any of the given names.
 *
 * @param {any} usage
 * @param {string[]} names
 */
const field = (usage, names) => {
  for (const name of names) {
    const value = number(usage[name])
    if (value > 0) return value
  }
  return 0
}

/** The OpenAI responses / Anthropic style detail objects. */
const detail = (usage, name) => (usage && typeof usage[name] === 'object' ? usage[name] : {})

/**
 * Normalise one usage object.
 *
 * Every key the plugin reads is total-and-positive; `0` means "this route did
 * not say", never "this route said zero", because a zero-token step would be
 * indistinguishable from an absent one anyway.
 *
 * @param {any} usage
 * @returns {{input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number}}
 */
export function readUsage(usage) {
  const empty = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  if (!usage || typeof usage !== 'object') return empty

  const promptDetails = detail(usage, 'prompt_tokens_details')
  const inputDetails = detail(usage, 'input_tokens_details')
  const completionDetails = detail(usage, 'completion_tokens_details')
  const outputDetails = detail(usage, 'output_tokens_details')

  return {
    input: field(usage, ['inputTokens', 'input_tokens', 'prompt_tokens', 'promptTokenCount', 'uncachedInputTokens']),
    output: field(usage, ['outputTokens', 'output_tokens', 'completion_tokens', 'candidatesTokenCount']),
    reasoning: field(usage, ['reasoningTokens', 'thoughtTokens', 'reasoning_tokens', 'thoughtsTokenCount'])
      || field(completionDetails, ['reasoning_tokens'])
      || field(outputDetails, ['reasoning_tokens']),
    cacheRead: field(usage, ['cacheReadTokens', 'cachedReadTokens', 'cache_read_input_tokens', 'cachedContentTokenCount', 'cached_tokens'])
      || field(promptDetails, ['cached_tokens'])
      || field(inputDetails, ['cached_tokens']),
    cacheWrite: field(usage, ['cacheWriteTokens', 'cachedWriteTokens', 'cache_creation_input_tokens']),
  }
}

/**
 * Find a usage object inside an event payload.
 *
 * The harness hangs it off `data.usage`, older adapters off `data.message.usage`;
 * OpenAI-style proxies sometimes nest it under `response.usage`, and a custom
 * gateway that reuses the completion envelope puts it there too. Walk the few
 * shapes that exist rather than demanding one.
 *
 * @param {any} source
 */
export function findUsage(source) {
  if (!source || typeof source !== 'object') return undefined
  const paths = [
    ['usage'],
    ['message', 'usage'],
    ['response', 'usage'],
    ['message', 'response', 'usage'],
    ['result', 'usage'],
    ['output', 'usage'],
    ['data', 'usage'],
  ]
  for (const path of paths) {
    const found = nested(source, path)
    if (found && typeof found === 'object') return found
  }
  // Some adapters store the counts flat on the event.
  if ('outputTokens' in source || 'output_tokens' in source || 'completion_tokens' in source) return source
  return undefined
}

/**
 * Output tokens only — the number the scheduler budgets against.
 *
 * @param {any} source an event payload, not necessarily just the usage object
 */
export function readOutputTokens(source) {
  return readUsage(findUsage(source)).output
}
