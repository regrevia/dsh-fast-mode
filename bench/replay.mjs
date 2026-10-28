#!/usr/bin/env node
/**
 * Replay one retained transcript through the plugin's own hooks.
 *
 * The reminder is delivered at a step boundary, so a transcript could only ever
 * count *delivered* reminders, never the ones the plugin would have sent under a
 * different version. This replays the recorded event stream into `apply()` with a
 * stand-in context, counts what the scheduler decides to emit, and prints one
 * line per turn: steps, reminders, and the step each reminder landed on.
 *
 * That is how the 1.5.28 latch fix is checked against real traffic instead of
 * synthetic test events: same transcript, same hook order, two versions of
 * `noteTurn`, two counts.
 *
 * Usage:
 *   node bench/replay.mjs ~/.dsh/sessions/<slug>/session-<uuid>/session.v4.jsonl.zstd
 *   node bench/replay.mjs <transcript> --min-steps 4 --json
 *   node bench/replay.mjs <transcript> --simulate-reentry
 *
 * `--simulate-reentry` adds the event the transcript cannot show: after each
 * `compaction/start` it re-fires `turn/start` with the same turn number, which is
 * the hypothesis for the doubled reminders (the harness re-enters a turn it
 * compacted mid-flight, and that re-entry is not persisted). With the event
 * added, the pre-1.5.28 latch resets and the same turn is reminded twice; with
 * the turn guard it is not.
 *
 * The session id is synthetic, so the run never touches `~/.dsh` state; metrics
 * and benchmark output are switched off in the config passed to `apply()`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { apply } from '../index.js'

const NEEDLE = 'prose is now the cost'
const CONFIG = { enabled: true, gear: 'auto', outputDiscipline: 'late', metrics: false, benchmarkFile: '' }

/** Minimal stand-in for the Cordis context: handlers plus a silent logger. */
function fakeContext() {
  const handlers = new Map()
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    inject: () => undefined,
    get: () => undefined,
    logger: { info: () => {} },
    fire(event, ...args) {
      const handler = handlers.get(event)
      if (!handler) return undefined
      return handler(...args)
    },
  }
}

/** Decide the way the harness does: enter, and keep whatever the plugin added. */
const preStep = (ctx, agentId, step) => {
  const decision = {
    kind: 'enter',
    messages: [{ id: 'sys', role: 'system', content: [] }, { id: `last-${step}`, role: 'assistant', content: [] }],
  }
  return ctx.fire('agent/pre-step', { agent: { id: agentId }, messages: [] }, async () => decision)
}

const events = path => {
  const raw = path.endsWith('.zstd')
    ? execFileSync('zstd', ['-dc', path], { maxBuffer: 1 << 30 })
    : readFileSync(path)
  const out = []
  for (const line of raw.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // a torn tail line is not fatal: the replay is a census, not a forensic read
    }
  }
  return out
}

const reminderText = notice => {
  const text = notice?.content?.[0]?.text ?? ''
  return text.includes(NEEDLE)
}

async function main() {
  const argv = process.argv.slice(2)
  const path = argv.find(arg => !arg.startsWith('--'))
  if (!path) throw new Error('usage: node bench/replay.mjs <transcript.jsonl.zstd> [--min-steps N] [--json]')
  const minSteps = Number(argv[argv.indexOf('--min-steps') + 1]) || 4
  const asJson = argv.includes('--json')
  const reentry = argv.includes('--simulate-reentry')

  const ctx = fakeContext()
  apply(ctx, CONFIG)
  const session = { id: 'replay' }
  const turns = []
  let cur = { steps: 0, reminders: [], compactions: 0, turnNo: 0 }
  for (const event of events(path)) {
    const type = event.type
    const data = event.data ?? {}
    if (type === 'turn/start') {
      if (cur.steps || cur.reminders.length) turns.push(cur)
      cur = { steps: 0, reminders: [], compactions: 0, turnNo: data.turn ?? turns.length + 1 }
      await ctx.fire('session/event', session, event)
    } else if (type === 'step/start') {
      cur.steps += 1
      await ctx.fire('session/event', session, event)
      const decision = await preStep(ctx, session.id, cur.steps)
      const added = (decision?.messages ?? []).filter(message => message?.source?.form === 'notice' && reminderText(message))
      if (added.length) cur.reminders.push(cur.steps)
    } else if (type === 'compaction/start') {
      cur.compactions += 1
      await ctx.fire('session/event', session, event)
      if (reentry) {
        // Same turn number, delivered the way the harness delivers it: the event
        // exists in the hook stream but never reaches the transcript.
        await ctx.fire('session/event', session, { type: 'turn/start', turn: cur.turnNo, time: event.time })
      }
    } else if (type === 'compaction/end') {
      await ctx.fire('session/event', session, event)
    } else if (type === 'assistant/message' || type === 'tool/call' || type === 'tool/result') {
      await ctx.fire('session/event', session, event)
    }
  }
  if (cur.steps || cur.reminders.length) turns.push(cur)

  const rows = turns.map((turn, index) => ({
    turn: index + 1,
    steps: turn.steps,
    compactions: turn.compactions,
    reminders: turn.reminders.length,
    at: turn.reminders,
  }))
  if (asJson) {
    console.log(JSON.stringify({ path, minSteps, simulateReentry: reentry, turns: rows }, null, 2))
    return
  }
  const qualifying = rows.filter(row => row.steps >= minSteps)
  const doubled = qualifying.filter(row => row.reminders > 1)
  console.log(`${path}`)
  for (const row of qualifying) {
    console.log(`  turn ${row.turn}: steps ${row.steps} compactions ${row.compactions} `
      + `reminders ${row.reminders}${row.at.length ? ` at ${row.at.join(',')}` : ''}`)
  }
  console.log(`qualifying turns (>= ${minSteps} steps) ${qualifying.length}  doubled ${doubled.length}`)
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
