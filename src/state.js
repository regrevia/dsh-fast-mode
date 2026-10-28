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
 * - The config fields (`enabled`, `gear`, `outputDiscipline`, `stepBudget`,
 *   `workspaceMap`) are the **defaults**: what a conversation runs at until it
 *   has an entry of its own. Only an edit in `cordis.patch.yml` changes them;
 *   the chip and the panel never write them.
 * - The `sessions` field carries every per-session choice: `{ sessionId: {
 *   enabled, gear, discipline, stepBudget, map, ts } }` as a compact JSON
 *   string. It is volatile, so a write lands in the running plugin without a
 *   remount.
 *
 * Every panel control writes this second tier, and that is what makes the four
 * switches independent per conversation: one tab can be fast with terser prose
 * while another is fast with full narration, and neither click moves the other.
 * The previous release wrote the three extra knobs into the shared fields; the
 * host refuses a write to a non-volatile field ("Config field … is not
 * volatile"), so those rows did nothing whatsoever — the symptom read as a dead
 * button rather than as a refusal, because the panel closes on click and the
 * error only appears in a tooltip.
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
 * @returns {Record<string, SessionEntry>}
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
 * Drop entries that are not a usable shape, and coerce the fields the policy
 * actually reads. A gear name is validated by `resolveConfig`, not here: this
 * module must not own the gear ladder.
 *
 * `discipline` is the one field with three states (`true`, `'late'`, `false`),
 * and it is stored exactly as the config field spells it so the two tiers stay
 * interchangeable. `map` is short for `workspaceMap`; the entry is a hot column
 * read on every describe, and the shorter key keeps an entry near 90 bytes.
 *
 * @param {Record<string, any>} input
 * @returns {Record<string, SessionEntry>}
 */
function sanitise(input) {
  /** @type {Record<string, SessionEntry>} */
  const out = {}
  for (const [sessionId, entry] of Object.entries(input)) {
    if (sessionId.length === 0 || !isRecord(entry)) continue
    /** @type {SessionEntry} */
    const clean = {}
    if (typeof entry.enabled === 'boolean') clean.enabled = entry.enabled
    if (typeof entry.gear === 'string' && entry.gear.length > 0) clean.gear = entry.gear
    if (typeof entry.discipline === 'boolean' || entry.discipline === 'late') clean.discipline = entry.discipline
    if (Number.isFinite(entry.stepBudget) && entry.stepBudget >= 0) clean.stepBudget = Math.floor(Number(entry.stepBudget))
    if (typeof entry.map === 'boolean') clean.map = entry.map
    if (Number.isFinite(entry.ts)) clean.ts = Number(entry.ts)
    if (
      clean.enabled === undefined
      && clean.gear === undefined
      && clean.discipline === undefined
      && clean.stepBudget === undefined
      && clean.map === undefined
    ) continue
    out[sessionId] = clean
  }
  return out
}

/**
 * The override for one conversation, or `undefined` when it inherits.
 *
 * @param {unknown} raw - the `sessions` config value.
 * @param {string|undefined} sessionId
 * @returns {SessionEntry|undefined}
 */
export function choiceFor(raw, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const entry = parseChoices(raw)[sessionId]
  if (entry === undefined) return undefined
  /** @type {SessionEntry} */
  const choice = {}
  if (entry.enabled !== undefined) choice.enabled = entry.enabled
  if (entry.gear !== undefined) choice.gear = entry.gear
  if (entry.discipline !== undefined) choice.discipline = entry.discipline
  if (entry.stepBudget !== undefined) choice.stepBudget = entry.stepBudget
  if (entry.map !== undefined) choice.map = entry.map
  return choice
}

/**
 * The same entry, spelled as config fields so `resolveConfig` can merge it.
 *
 * This is the one place the two vocabularies meet: the column is compact, the
 * config is what the policy reads. Keeping the mapping here means the host half
 * never has to remember that `map` means `workspaceMap`.
 *
 * @param {unknown} raw
 * @param {string|undefined} sessionId
 * @returns {Record<string, unknown>|undefined}
 */
export function configOverridesFor(raw, sessionId) {
  const choice = choiceFor(raw, sessionId)
  if (choice === undefined) return undefined
  /** @type {Record<string, unknown>} */
  const overrides = {}
  if (choice.enabled !== undefined) overrides.enabled = choice.enabled
  if (choice.gear !== undefined) overrides.gear = choice.gear
  if (choice.discipline !== undefined) overrides.outputDiscipline = choice.discipline
  if (choice.stepBudget !== undefined) overrides.stepBudget = choice.stepBudget
  if (choice.map !== undefined) overrides.workspaceMap = choice.map
  return Object.keys(overrides).length === 0 ? undefined : overrides
}

/**
 * The effective pair for one conversation: its own entry when it has one, the
 * configured default otherwise. Kept for the two-field shape callers had before
 * the panel grew; the field-by-field fallback is the same rule the host applies.
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
 * Fields absent from `choice` keep their previous value, which is what lets the
 * panel write one row without restating the other three.
 *
 * @param {unknown} raw - current `sessions` value.
 * @param {string} sessionId
 * @param {SessionEntry} choice
 * @param {number} [now]
 * @returns {{sessions: string, map: Record<string, SessionEntry>}}
 */
export function writeChoice(raw, sessionId, choice, now) {
  const map = parseChoices(raw)
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { sessions: encodeChoices(map), map }
  }
  const current = map[sessionId] ?? {}
  /** @type {SessionEntry} */
  const next = { ...current, ts: Number.isFinite(now) ? Number(now) : Date.now() }
  if (typeof choice.enabled === 'boolean') next.enabled = choice.enabled
  if (typeof choice.gear === 'string' && choice.gear.length > 0) next.gear = choice.gear
  if (typeof choice.discipline === 'boolean' || choice.discipline === 'late') next.discipline = choice.discipline
  if (Number.isFinite(choice.stepBudget) && choice.stepBudget >= 0) next.stepBudget = Math.floor(Number(choice.stepBudget))
  if (typeof choice.map === 'boolean') next.map = choice.map
  map[sessionId] = next
  return { sessions: encodeChoices(map), map }
}

/** @typedef {{enabled?: boolean, gear?: string, discipline?: boolean|'late', stepBudget?: number, map?: boolean, ts?: number}} SessionEntry */

/**
 * Serialise the map, dropping the oldest entries beyond {@link SESSIONS_LIMIT}.
 *
 * @param {Record<string, SessionEntry>} map
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
