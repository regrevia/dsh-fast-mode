/**
 * Per-session overrides.
 *
 * The `settings` service has one scope: the whole profile. That is the right
 * shape for "how does this plugin behave", and the wrong shape for "is fast
 * mode on in *this* conversation" — a switch that leaks into every other open
 * session is a switch nobody trusts, and the first time it silently changed a
 * different tab's working style it stopped being a speed knob and became a bug.
 *
 * So the plugin keeps two tiers:
 *
 * - The `enabled` / `gear` config fields stay the **default**, and double as the
 *   "last choice": a conversation with no entry of its own inherits whatever was
 *   picked most recently anywhere. That is what makes a fresh session start
 *   where the user left off instead of resetting to the schema default.
 * - The `sessions` field carries the per-session entries: `{ sessionId: { enabled,
 *   gear, ts } }` as a compact JSON string. It is volatile like the other two,
 *   so a write lands in the running plugin without a remount.
 *
 * Why a config field and not a new remote call: a plugin-owned RPC would need a
 * decorated `TypertRemoteService`, and the client half is a static bundle with no
 * compiler — every alternative (a projection, a second settings namespace, a
 * file the browser cannot write) costs more machinery than the problem. A JSON
 * column on the entry the plugin already owns needs no new transport, keeps the
 * value in the same durable document as the rest of the configuration, and
 * survives a restart for free.
 *
 * The browser half of this module is duplicated in `client.js` (the bundle is
 * loaded by the client module loader and cannot import host ESM). Both copies
 * are asserted against the same fixtures in `test/state.test.js`, so a format
 * change cannot land on one side only.
 *
 * @module dsh-fast-mode/state
 */
import { plainConfigValue } from './effort.js'

/**
 * How many sessions keep an explicit entry.
 *
 * A conversation is cheap to remember (about seventy bytes) but the settings
 * document is read on every describe, so it cannot grow without bound. Oldest
 * entries are dropped first; a pruned session simply falls back to the default,
 * which is the same state it had before anyone touched it.
 */
export const SESSIONS_LIMIT = 200

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read the per-session map out of a config value that may be a plain string, a
 * already-parsed object, `undefined`, or a live volatile reference.
 *
 * Never throws: a hand-edited patch with a broken JSON column must degrade to
 * "no overrides" rather than take the plugin down with it.
 *
 * @param {unknown} raw
 * @returns {Record<string, {enabled?: boolean, gear?: string, ts?: number}>}
 */
export function parseChoices(raw) {
  const value = plainConfigValue(raw)
  if (isRecord(value)) return sanitise(value)
  if (typeof value !== 'string' || value.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? sanitise(parsed) : {}
  } catch {
    return {}
  }
}

/**
 * Drop entries that are not a usable shape, and coerce the two fields the policy
 * actually reads. A gear name is validated by `resolveConfig`, not here: this
 * module must not own the gear ladder.
 *
 * @param {Record<string, any>} input
 */
function sanitise(input) {
  /** @type {Record<string, {enabled?: boolean, gear?: string, ts?: number}>} */
  const out = {}
  for (const [sessionId, entry] of Object.entries(input)) {
    if (sessionId.length === 0 || !isRecord(entry)) continue
    /** @type {{enabled?: boolean, gear?: string, ts?: number}} */
    const clean = {}
    if (typeof entry.enabled === 'boolean') clean.enabled = entry.enabled
    if (typeof entry.gear === 'string' && entry.gear.length > 0) clean.gear = entry.gear
    if (Number.isFinite(entry.ts)) clean.ts = Number(entry.ts)
    if (clean.enabled === undefined && clean.gear === undefined) continue
    out[sessionId] = clean
  }
  return out
}

/**
 * The override for one conversation, or `undefined` when it inherits.
 *
 * @param {unknown} raw - the `sessions` config value.
 * @param {string|undefined} sessionId
 * @returns {{enabled?: boolean, gear?: string}|undefined}
 */
export function choiceFor(raw, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const entry = parseChoices(raw)[sessionId]
  if (entry === undefined) return undefined
  /** @type {{enabled?: boolean, gear?: string}} */
  const choice = {}
  if (entry.enabled !== undefined) choice.enabled = entry.enabled
  if (entry.gear !== undefined) choice.gear = entry.gear
  return choice
}

/**
 * The effective pair for one conversation: its own entry when it has one, the
 * configured default otherwise.
 *
 * @param {unknown} raw
 * @param {string|undefined} sessionId
 * @param {{enabled: boolean, gear: string}} fallback
 * @returns {{enabled: boolean, gear: string, scoped: boolean}}
 */
export function resolveChoice(raw, sessionId, fallback) {
  const choice = choiceFor(raw, sessionId)
  if (choice === undefined) return { ...fallback, scoped: false }
  return {
    enabled: choice.enabled === undefined ? fallback.enabled : choice.enabled,
    gear: choice.gear === undefined ? fallback.gear : choice.gear,
    scoped: true,
  }
}

/**
 * Write one conversation's entry and return the column to store.
 *
 * `ts` is the pruning key, not a display field: the map is ordered by nothing in
 * particular after a round trip through JSON, so recency has to be recorded.
 *
 * @param {unknown} raw - current `sessions` value.
 * @param {string} sessionId
 * @param {{enabled?: boolean, gear?: string}} choice
 * @param {number} [now]
 * @returns {{sessions: string, map: Record<string, {enabled?: boolean, gear?: string, ts?: number}>}}
 */
export function writeChoice(raw, sessionId, choice, now) {
  const map = parseChoices(raw)
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { sessions: encodeChoices(map), map }
  }
  const current = map[sessionId] ?? {}
  /** @type {{enabled?: boolean, gear?: string, ts?: number}} */
  const next = { ...current, ts: Number.isFinite(now) ? Number(now) : Date.now() }
  if (typeof choice.enabled === 'boolean') next.enabled = choice.enabled
  if (typeof choice.gear === 'string' && choice.gear.length > 0) next.gear = choice.gear
  map[sessionId] = next
  return { sessions: encodeChoices(map), map }
}

/**
 * Serialise the map, dropping the oldest entries beyond {@link SESSIONS_LIMIT}.
 *
 * @param {Record<string, {enabled?: boolean, gear?: string, ts?: number}>} map
 * @returns {string}
 */
export function encodeChoices(map) {
  const ids = Object.keys(map)
  if (ids.length > SESSIONS_LIMIT) {
    ids
      .sort((a, b) => (map[a]?.ts ?? 0) - (map[b]?.ts ?? 0))
      .slice(0, ids.length - SESSIONS_LIMIT)
      .forEach(id => { delete map[id] })
  }
  return JSON.stringify(map)
}

/**
 * Forget one conversation's entry. Not driven by the UI; exported so a session
 * that the user resets back to "inherit" has a supported path, and so the tests
 * can prove pruning and deletion share the same encoder.
 *
 * @param {unknown} raw
 * @param {string} sessionId
 */
export function clearChoice(raw, sessionId) {
  const map = parseChoices(raw)
  delete map[sessionId]
  return encodeChoices(map)
}
