/**
 * Per-step measurement, so "does fast mode actually make it faster" can be
 * answered with numbers instead of a feeling.
 *
 * The harness already reports what this needs, one event at a time: `step/start`
 * opens a step, `assistant/message` carries the upstream `usage`, `tool/call`
 * and `tool/result` count the work inside the step, `step/end` closes it. This
 * module folds that feed into one JSON line per step and appends it to a file.
 *
 * Why a file and not the session log: measurements are diagnostics, not
 * conversation. Appending to the session would put every timing into the
 * model's context and cost exactly the tokens the plugin exists to save.
 *
 * Both modes are recorded. A log that only covers sessions with fast mode on
 * cannot answer the comparison question, so the "off" rows are as important as
 * the "on" rows — the same task, measured on both sides.
 *
 * @module dsh-fast-mode/metrics
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** The measurement format. Bumped when a field changes meaning. */
export const METRICS_VERSION = 1

/**
 * The step events this recorder folds. Anything else on the session feed
 * (`message/*`, `tool/*` wrappers, model selection) is irrelevant here.
 */
const STEP_START = 'step/start'
const STEP_END = 'step/end'
const ASSISTANT = 'assistant/message'
const TOOL_CALL = 'tool/call'
const TOOL_RESULT = 'tool/result'

/** @param {unknown} value */
const isTime = value => typeof value === 'number' && Number.isFinite(value) && value > 0

/**
 * The bucket key of one step of one session.
 *
 * @param {string} sid @param {unknown} turn @param {unknown} step
 */
const stepKey = (sid, turn, step) => `${sid}\u0000${String(turn)}\u0000${String(step)}`

/**
 * The payload of a session event.
 *
 * The feed wraps every payload in `event.data` (`step/start` appends
 * `{turn, step}`, `assistant/message` appends `{turn, step, message, usage?}`).
 * Reading `event.turn`/`event.usage` compiled and produced rows with no step
 * numbers and zero tokens for a whole release, so this unwrapping is the one
 * place that must not be guessed at again: `data` first, the event itself only
 * as a fallback for shapes that have no wrapper.
 *
 * @param {any} event
 */
const payloadOf = (event) => {
  const data = event && typeof event === 'object' ? event.data : undefined
  return data && typeof data === 'object' ? data : (event ?? {})
}

/**
 * Read one token field from a usage object.
 *
 * The harness reports `TokenUsage` (`inputTokens`, `outputTokens`,
 * `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`), while the session
 * stats projection uses the gateway's own `uncachedInputTokens`/`thoughtTokens`
 * spelling. Both are accepted so a provider that reports either still counts.
 *
 * @param {any} usage @param {string[]} names
 */
const tokenField = (usage, names) => {
  for (const name of names) {
    const value = usage[name]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return 0
}

/**
 * Milliseconds between two event timestamps, never negative.
 *
 * @param {number} from @param {number} to
 */
const span = (from, to) => (isTime(from) && isTime(to) ? Math.max(0, Math.round(to - from)) : undefined)

/**
 * Create a recorder. Construction is cheap and never touches the disk: the file
 * is created lazily on the first completed step.
 *
 * @param {{file?: string}} [options]
 */
export function createRecorder(options = {}) {
  const file = typeof options.file === 'string' ? options.file : ''
  const on = file.length > 0
  /** @type {Map<string, any>} */
  const steps = new Map()
  /** @type {Map<string, {mode: string, gear: string, effort?: string, route?: string}>} */
  const labels = new Map()
  let prepared = false

  const prepare = () => {
    if (prepared || !on) return
    prepared = true
    try {
      mkdirSync(dirname(file), { recursive: true })
    } catch {
      // An unwritable directory disables the sink, not the request.
    }
  }

  const write = (row) => {
    if (!on) return
    prepare()
    try {
      appendFileSync(file, `${JSON.stringify(row)}\n`)
    } catch {
      // A diagnostic sink must never break the request it observes.
    }
  }

  /** Get-or-open the accumulator for an event's step. */
  const accum = (sid, event, time) => {
    const key = stepKey(sid, event.turn, event.step)
    const found = steps.get(key)
    if (found) return { key, entry: found }
    const entry = {
      sid,
      turn: event.turn,
      step: event.step,
      started: time,
      first: undefined,
      last: undefined,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      calls: 0,
      errors: 0,
      seen: 0,
    }
    steps.set(key, entry)
    return { key, entry }
  }

  return {
    /** Whether anything will be written at all. */
    get enabled() { return on },

    /** The file this recorder appends to (empty when disabled). */
    get file() { return file },

    /**
     * Tell the next step rows which stance produced them. Called from the
     * request hook, which is the only place that knows the resolved gear.
     *
     * @param {string|undefined} sid
     * @param {{mode: string, gear: string, effort?: string, route?: string}} label
     */
    label(sid, label) {
      if (typeof sid !== 'string' || sid.length === 0) return
      const previous = labels.get(sid)
      if (previous && previous.mode === label.mode && previous.gear === label.gear
        && previous.effort === label.effort && previous.route === label.route) return
      labels.set(sid, {
        mode: label.mode,
        gear: label.gear,
        effort: label.effort,
        route: label.route,
      })
    },

    /** The last label recorded for a session. */
    labelOf(sid) {
      return labels.get(sid)
    },

    /**
     * Fold one session event.
     *
     * @param {{id?: string}} session
     * @param {{type?: string, time?: number, turn?: number, step?: number, usage?: unknown, error?: unknown}} event
     */
    record(session, event) {
      if (!on || !event || typeof event !== 'object') return
      const sid = session && typeof session.id === 'string' ? session.id : ''
      if (sid.length === 0) return
      const kind = event.type
      const time = isTime(event.time) ? event.time : Date.now()
      const data = payloadOf(event)

      if (kind === STEP_START) {
        const { key, entry } = accum(sid, data, time)
        entry.started = time
        steps.set(key, entry)
        return
      }

      if (kind === ASSISTANT) {
        const { entry } = accum(sid, data, time)
        entry.seen += 1
        if (entry.first === undefined) entry.first = time
        entry.last = time
        // The message is appended with `usage` beside it; older adapters hang it
        // off the message instead. Both are the same numbers.
        const usage = data.usage ?? (data.message && data.message.usage)
        if (usage && typeof usage === 'object') {
          entry.input += tokenField(usage, ['inputTokens', 'uncachedInputTokens'])
          entry.output += tokenField(usage, ['outputTokens'])
          entry.reasoning += tokenField(usage, ['reasoningTokens', 'thoughtTokens'])
          entry.cacheRead += tokenField(usage, ['cacheReadTokens', 'cachedReadTokens'])
          entry.cacheWrite += tokenField(usage, ['cacheWriteTokens', 'cachedWriteTokens'])
        }
        return
      }

      if (kind === TOOL_CALL) {
        const { entry } = accum(sid, data, time)
        entry.calls += 1
        return
      }

      if (kind === TOOL_RESULT) {
        const { entry } = accum(sid, data, time)
        if (data.error) entry.errors += 1
        return
      }

      if (kind !== STEP_END) return

      const key = stepKey(sid, data.turn, data.step)
      const entry = steps.get(key)
      steps.delete(key)
      if (!entry) return
      const label = labels.get(sid)
      write({
        v: METRICS_VERSION,
        ts: new Date(time).toISOString(),
        sid,
        turn: entry.turn,
        step: entry.step,
        mode: label ? label.mode : 'unknown',
        gear: label ? label.gear : 'unknown',
        effort: label ? label.effort : undefined,
        route: label ? label.route : undefined,
        // First token, and the whole model call: `step/start` to the last
        // assistant message. Both in milliseconds.
        ttftMs: span(entry.started, entry.first),
        llmMs: entry.first === undefined ? undefined : span(entry.started, entry.last),
        stepMs: span(entry.started, time),
        calls: entry.calls,
        errors: entry.errors,
        input: entry.input,
        output: entry.output,
        reasoning: entry.reasoning,
        cacheRead: entry.cacheRead,
        cacheWrite: entry.cacheWrite,
        assistantMessages: entry.seen,
      })
    },

    /** Number of steps currently being accumulated (tests, diagnostics). */
    get pending() { return steps.size },
  }
}

/** @param {number[]} values @param {number} fraction */
function percentile(values, fraction) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))
  return sorted[index]
}

/** @param {number[]} values */
const mean = (values) => (values.length === 0 ? undefined : Math.round(values.reduce((a, b) => a + b, 0) / values.length))

/**
 * Turn metric rows into one bucket per stance, which is what a comparison needs.
 *
 * Steps are the comparable unit: a session's wall clock also contains the user
 * reading and typing, so comparing whole sessions mostly measures the human.
 *
 * @param {any[]} rows
 */
export function summarise(rows) {
  /** @type {Map<string, any[]>} */
  const buckets = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue
    const key = `${row.mode ?? 'unknown'}|${row.gear ?? 'unknown'}`
    const list = buckets.get(key) ?? []
    list.push(row)
    buckets.set(key, list)
  }

  const out = []
  for (const [key, list] of buckets) {
    const [mode, gear] = key.split('|')
    const sessions = new Set(list.map(row => row.sid).filter(sid => typeof sid === 'string'))
    const turns = new Map()
    for (const row of list) {
      if (typeof row.sid !== 'string') continue
      const seen = turns.get(row.sid) ?? new Set()
      seen.add(row.turn)
      turns.set(row.sid, seen)
    }
    const turnCount = [...turns.values()].reduce((sum, seen) => sum + seen.size, 0)
    /** @param {(row: any) => number|undefined} pick */
    const numbers = (pick) => list.map(pick).filter(value => typeof value === 'number' && Number.isFinite(value))
    const llm = numbers(row => row.llmMs)
    const step = numbers(row => row.stepMs)
    const ttft = numbers(row => row.ttftMs)
    const output = numbers(row => row.output)
    const input = numbers(row => row.input)
    const calls = numbers(row => row.calls)
    out.push({
      mode,
      gear,
      steps: list.length,
      sessions: sessions.size,
      turns: turnCount,
      stepsPerTurn: turnCount === 0 ? undefined : Math.round((list.length / turnCount) * 100) / 100,
      llmMsP50: percentile(llm, 0.5),
      llmMsP90: percentile(llm, 0.9),
      llmMsMean: mean(llm),
      stepMsP50: percentile(step, 0.5),
      stepMsP90: percentile(step, 0.9),
      ttftMsP50: percentile(ttft, 0.5),
      outputPerStep: mean(output),
      inputPerStep: mean(input),
      outputPerSession: sessions.size === 0 ? undefined
        : Math.round(list.reduce((sum, row) => sum + (typeof row.output === 'number' ? row.output : 0), 0) / sessions.size),
      callsPerStep: calls.length === 0 ? undefined : Math.round((calls.reduce((a, b) => a + b, 0) / calls.length) * 100) / 100,
      multiCallSteps: list.filter(row => (row.calls ?? 0) > 1).length,
      errorCalls: list.reduce((sum, row) => sum + (typeof row.errors === 'number' ? row.errors : 0), 0),
    })
  }
  out.sort((a, b) => (a.mode === b.mode ? String(a.gear).localeCompare(String(b.gear)) : a.mode.localeCompare(b.mode)))
  return out
}

/**
 * Compare two stance buckets: how much of the wall clock fast mode removed.
 *
 * @param {any} baseline the `mode=off` bucket
 * @param {any} candidate an `mode=on` bucket at some gear
 */
export function compare(baseline, candidate) {
  if (!baseline || !candidate) return undefined
  const ratio = (a, b) => (typeof a === 'number' && typeof b === 'number' && b > 0
    ? Math.round((a / b) * 100) / 100
    : undefined)
  return {
    gear: candidate.gear,
    speedupLlm: ratio(baseline.llmMsMean, candidate.llmMsMean),
    speedupStep: ratio(baseline.stepMsP50, candidate.stepMsP50),
    outputRatio: ratio(candidate.outputPerStep, baseline.outputPerStep),
    tokensPerSessionRatio: ratio(candidate.outputPerSession, baseline.outputPerSession),
    callsRatio: ratio(candidate.callsPerStep, baseline.callsPerStep),
  }
}
