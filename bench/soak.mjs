#!/usr/bin/env node
/**
 * Soak the plugin in a long-lived host process and watch the heap.
 *
 * 1.5.34 bounded every long-lived cache the plugin owns (`compacted`,
 * `mapSent`, `autoBudgets`, `startedAt`, and the metrics sink's labels/steps/
 * open/pending sets). A unit test can check the mapping logic but not the
 * growth, because the caches are private to the closure. This script mounts the
 * real plugin exactly like the harness does and then plays a host that never
 * restarts: thousands of sessions, each with its own turns and tool calls,
 * interleaved so every cache sees churn.
 *
 * It reports heap after warm-up and at the end. Growth stays flat when the caps
 * work; without them the heap climbs with the session count and a real host
 * eventually dies.
 *
 *   node --expose-gc bench/soak.mjs                  # 4000 sessions, 4 turns each
 *   node --expose-gc bench/soak.mjs --sessions 8000  # longer
 *   node --expose-gc bench/soak.mjs --metrics        # exercise the metrics sink
 *                                                     # (temp file, then removed)
 *
 * Two notes from building this. The event feed has to be *awaited*: firing
 * `agent/request` without awaiting left 16 000 promises pending and reported
 * +49 MB that belonged to the test, not the plugin. And the heap baseline is
 * taken after a warm-up batch, because the first sessions pay for lazily built
 * module state that is not growth.
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

/** Same fake-Cordis shape as `test/plugin.test.js`, trimmed to what the soak drives. */
function fakeContext(services = {}) {
  const handlers = new Map()
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    inject(names, callback) {
      if (!names.every(name => services[name])) return undefined
      const child = {
        ...services,
        get: name => services[name],
        effect(setup) {
          const disposer = setup()
          return typeof disposer === 'function' ? disposer : () => {}
        },
      }
      return callback(child)
    },
    get: name => services[name],
    logger: { info() {}, warn() {}, debug() {} },
    fire(event, ...args) {
      const handler = handlers.get(event)
      return handler ? handler(...args) : undefined
    },
  }
}

const llm = {
  resolveModelInfo: () => ({
    reasoning: { efforts: ['none', 'minimal', 'low', 'medium', 'high'].map(id => ({ id })), defaultEffort: 'high' },
  }),
}

const argOf = (flag, fallback) => {
  const hit = process.argv.indexOf(flag)
  return hit > -1 ? Number(process.argv[hit + 1]) : fallback
}

const SESSIONS = argOf('--sessions', 4000)
const TURNS = argOf('--turns', 4)
const STEPS = 3

const mb = () => process.memoryUsage().heapUsed / 1024 / 1024

/**
 * Measure retained heap, not allocated heap. Without a collection the number is
 * mostly garbage from the steps just driven, which is what makes a healthy run
 * look like it leaks. `--expose-gc` is required for a meaningful number; without
 * it the script says so instead of reporting a false failure.
 */
const settle = () => {
  if (typeof global.gc === 'function') {
    global.gc()
    global.gc()
    return true
  }
  return false
}

/** One turn: the pre-step notice path plus a request, as the harness orders them. */
const SKIP_EVENT = process.argv.includes('--no-event')
const SKIP_REQUEST = process.argv.includes('--no-request')

async function drive(ctx, session, turn, bump) {
  const agent = { id: session.id, session }
  const emit = (event) => {
    if (!SKIP_EVENT) ctx.fire('session/event', session, event)
  }
  emit({ type: 'turn/start', turn })
  for (let step = 1; step <= STEPS; step += 1) {
    emit({ type: 'step/start', turn, step, time: Date.now() })
    if (!SKIP_REQUEST) {
      await ctx.fire(
        'agent/request',
        { agent, turn, step, signal: new AbortController().signal },
        async () => ({ provider: 'company', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' }),
      )
    }
    emit({ type: 'assistant/message', turn, step, time: Date.now(), usage: { inputTokens: 200, outputTokens: 30 } })
    emit({ type: 'step/end', turn, step, time: Date.now() })
    bump()
  }
  // Compaction happens on a turn boundary in the real host; emitting it here keeps
  // the post-compaction reminder cache under churn.
  if (turn % 2 === 1) emit({ type: 'turn/compacted', turn })
}

async function main() {
  const ctx = fakeContext({ llm })
  // Metrics and the experiment file off: a soak must not touch the developer's
  // home directory, and it must not be steered by a live experiment file.
  const OFF = process.argv.includes('--off')
  // `--metrics` writes the same JSONL sink a real session writes, to a temp file
  // outside the home directory, so the label/step caches see the same churn.
  const METRICS = process.argv.includes('--metrics')
  const metricsFile = METRICS ? join(tmpdir(), `dsh-fast-mode-soak-${process.pid}.jsonl`) : ''
  apply(ctx, { enabled: !OFF, metrics: METRICS, metricsFile, benchmarkFile: '' })

  // `--one-id` reuses a single session id, which separates per-session caches
  // from anything retained per call.
  const ONE = process.argv.includes('--one-id')
  const sessions = Array.from({ length: SESSIONS }, (_, i) => ({ id: ONE ? 'soak-shared' : `soak-${i}` }))
  const started = Date.now()
  let steps = 0
  const bump = () => { steps += 1 }

  // Warm-up: the first sessions pay for module-level lazily built things
  // (regexes, the gear table), which would otherwise look like growth.
  for (const session of sessions.slice(0, Math.min(200, SESSIONS))) {
    for (let turn = 0; turn < TURNS; turn += 1) await drive(ctx, session, turn, bump)
  }
  const collected = settle()
  const warm = mb()

  for (const session of sessions) {
    for (let turn = 0; turn < TURNS; turn += 1) await drive(ctx, session, turn, bump)
  }
  settle()
  const end = mb()

  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  const growth = end - warm
  const perSession = growth / SESSIONS
  console.log(`sessions        ${SESSIONS} × ${TURNS} turns, ${steps} steps`)
  console.log(`heap warm       ${warm.toFixed(2)} MB`)
  console.log(`heap end        ${end.toFixed(2)} MB`)
  console.log(`growth          ${growth >= 0 ? '+' : ''}${growth.toFixed(2)} MB over ${SESSIONS} sessions`)
  console.log(`per session     ${(perSession * 1024).toFixed(1)} KB`)
  console.log(`elapsed         ${elapsed} s`)
  if (!collected) console.log('note            run with --expose-gc for a retained-heap number')
  // Without the caps this adds a Map entry and a Set entry per session; V8's own
  // noise is a few MB, so the threshold is generous on purpose — this checks
  // "bounded", not "exact".
  if (METRICS) {
    // The sink is a diagnostic file, not a result: leave nothing behind.
    try {
      rmSync(metricsFile, { force: true })
      rmSync(`${metricsFile}.1`, { force: true })
    } catch {
      // Temp file; a failed cleanup must not fail the soak.
    }
    console.log(`metrics         ${steps} steps written, caches trimmed`)
  }
  if (perSession > 0.004) {
    console.error('FAIL: heap grows with the session count — a cache is unbounded')
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
