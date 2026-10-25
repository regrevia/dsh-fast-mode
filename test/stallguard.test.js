/**
 * Unit tests for the third lever: the stall guard, the two notices, and the peer
 * probe.
 *
 * These modules are pure policy — no harness imports — which is why they can be
 * tested by driving the waterfall handler directly with an injected clock, an
 * injected budget and an injected observation hook.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildConflictMessage,
  buildReassertMessage,
  createNoticeMessage,
  PLUGIN_SOURCE,
  SUMMARY_MAX_CHARS,
} from '../src/notices.js'
import { detectPeerPlugins, opsToolsLive, PEER_PLUGINS } from '../src/peers.js'
import {
  createStallGuard,
  DEFAULT_STALL_BUDGET,
  shouldGuard,
  STALL_BUDGET,
  stallBudgetFor,
  stallFailure,
} from '../src/stallguard.js'
import { resolveConfig } from '../src/effort.js'

test('the ceiling follows the gear, and every escape hatch is spelled out', () => {
  const budget = (gear, extra = {}) => stallBudgetFor(resolveConfig({ enabled: true, gear, ...extra }))

  // Only two stances are user-facing now: `safe` intervenes in nothing and
  // `auto` bounds a call at two minutes before its own scheduler refines the
  // number. The fixed ids survive as experiment arms, so they are reachable
  // through an override and never through a patch.
  assert.equal(budget('safe'), 0)
  assert.equal(budget('auto'), 120_000)
  assert.equal(budget('turbo'), 120_000, 'a retired patch gear runs auto, so it runs the auto ceiling')
  const arm = (gear) => stallBudgetFor(resolveConfig({ enabled: true }, { enabled: true, gear }))
  assert.equal(arm('fast'), 300_000)
  assert.equal(arm('turbo'), 180_000)
  assert.equal(arm('max'), 120_000)
  assert.equal(arm('ludicrous'), 90_000)

  // A positive `toolTimeoutMs` overrides the table for every gear; a negative
  // one is the kill switch; `stallGuard: false` is the same kill switch.
  assert.equal(budget('safe', { toolTimeoutMs: 5_000 }), 5_000)
  assert.equal(budget('auto', { toolTimeoutMs: 7_500 }), 7_500)
  assert.equal(budget('turbo', { toolTimeoutMs: -1 }), 0)
  assert.equal(budget('turbo', { stallGuard: false }), 0)

  // An unknown gear must still be bounded rather than silently unlimited.
  assert.equal(stallBudgetFor({ gear: 'nonexistent' }), DEFAULT_STALL_BUDGET)
  assert.equal(STALL_BUDGET.safe, 0)
})

test('only shells and scripts are guarded, and a waiting tool never is', () => {
  assert.equal(shouldGuard('bash', 1000), true)
  assert.equal(shouldGuard('pwsh', 1000), true)
  assert.equal(shouldGuard('run_script', 1000), true)
  assert.equal(shouldGuard('read', 1000), false)
  assert.equal(shouldGuard('edit', 1000), false)

  // These exist to wait for a human, a job, or another agent. Cancelling them
  // would break the feature that asked for the wait.
  for (const name of ['ask_user_question', 'wait_agent', 'job_output', 'task_board_run', 'workflow', 'subagent']) {
    assert.equal(shouldGuard(name, 1000), false, `${name} must never be cancelled by the guard`)
  }

  // No budget, no guard — that is how `safe` and an explicit `-1` behave.
  assert.equal(shouldGuard('bash', 0), false)
  assert.equal(shouldGuard('', 1000), false)
})

test('a call that finishes inside its budget is passed through, and the caller signal is restored', async () => {
  const caller = new AbortController()
  const exec = { name: 'bash', signal: caller.signal }
  const guard = createStallGuard({ budgetFor: () => 10_000 })
  let seen
  const result = await guard(exec, async () => {
    seen = exec.signal
    return { isError: false, value: 'ok', content: [] }
  })

  assert.equal(result.value, 'ok')
  // The wrapper installs its own controller for the duration of the call, so the
  // body must see a signal that is not the caller's — and the dispatch object
  // must point back at the caller's afterwards.
  assert.notEqual(seen, caller.signal)
  assert.equal(exec.signal, caller.signal)
})

test('a hung call is cancelled at its budget, and the failure says what to change', async () => {
  const caller = new AbortController()
  const exec = { name: 'bash', signal: caller.signal }
  let stalled
  const guard = createStallGuard({
    budgetFor: () => 20,
    graceMs: 5,
    onStall: (info) => { stalled = info },
  })

  let bodySignal
  const result = await guard(exec, () => {
    bodySignal = exec.signal
    return new Promise(() => {})
  })

  assert.equal(result.isError, true)
  assert.equal(result.value, undefined)
  assert.match(result.error.message, /stall guard cancelled bash/)
  assert.match(result.content[0].text, /run_in_background/)
  assert.match(result.content[0].text, /script_path/)
  assert.match(result.content[0].text, /Never re-issue the same command unchanged/)

  // The body's own signal was aborted before the failure was reported, so the
  // dispatch chain reaches quiescence instead of leaking a live process.
  assert.equal(bodySignal.aborted, true)
  assert.equal(stalled.timedOut, true)
  assert.equal(stalled.budgetMs, 20)
  assert.equal(exec.signal, caller.signal)
})

test('a cancelled call does not report until its body has really stopped', async () => {
  const caller = new AbortController()
  const exec = { name: 'bash', signal: caller.signal }
  let stalled
  const guard = createStallGuard({
    budgetFor: () => 20,
    onStall: (info) => { stalled = info },
  })

  // The body ignores the abort at first and keeps writing for 40 ms after the
  // deadline. Reporting at 20 ms would hand the harness a "cancelled" result
  // while the command is still running.
  const events = []
  const result = await guard(exec, () => new Promise((resolve) => {
    const signal = exec.signal
    signal.addEventListener('abort', () => {
      events.push('aborted')
      setTimeout(() => {
        events.push('settled')
        resolve({ isError: true, error: { message: 'killed' }, content: [] })
      }, 40)
    }, { once: true })
  }))

  assert.equal(result.isError, true)
  assert.deepEqual(events, ['aborted', 'settled'])
  assert.equal(stalled.quiesced, true, 'the body had settled before the failure was returned')
  assert.equal(exec.signal, caller.signal)
})

test('a body that ignores its signal is reported without waiting forever', async () => {
  const caller = new AbortController()
  const exec = { name: 'bash', signal: caller.signal }
  let stalled
  const guard = createStallGuard({
    budgetFor: () => 20,
    graceMs: 10,
    onStall: (info) => { stalled = info },
  })

  const began = Date.now()
  const result = await guard(exec, () => new Promise(() => {}))
  const elapsed = Date.now() - began

  assert.equal(result.isError, true, 'the turn still gets its failure back')
  assert.equal(stalled.quiesced, false, 'the wait was bounded, and the report says so')
  assert.ok(elapsed < 1_000, `a stuck body must not hang the caller (waited ${elapsed} ms)`)
  assert.equal(exec.signal, caller.signal)
})

test('a cancellation from the caller is forwarded, not invented', async () => {
  const caller = new AbortController()
  const exec = { name: 'bash', signal: caller.signal }
  const guard = createStallGuard({ budgetFor: () => 10_000 })

  let relayed = false
  const pending = guard(exec, () => new Promise((resolve) => {
    const signal = exec.signal
    signal.addEventListener('abort', () => {
      relayed = true
      resolve({ isError: true, error: { message: 'cancelled by the caller' }, content: [] })
    }, { once: true })
  }))

  caller.abort(new Error('stop'))
  const result = await pending

  assert.equal(relayed, true)
  assert.equal(result.error.message, 'cancelled by the caller')
  assert.equal(exec.signal, caller.signal)
})

test('a throwing body still restores the caller signal', async () => {
  const caller = new AbortController()
  const exec = { name: 'bash', signal: caller.signal }
  const guard = createStallGuard({ budgetFor: () => 10_000 })

  await assert.rejects(
    guard(exec, async () => { throw new Error('dispatch blew up') }),
    /dispatch blew up/,
  )
  assert.equal(exec.signal, caller.signal)
})

test('the failure text carries no tool-error info it cannot fill in', () => {
  const failure = stallFailure({ name: 'bash', budgetMs: 90_000 })
  assert.equal(failure.isError, true)
  assert.equal(failure.error.info, undefined)
  assert.match(failure.content[0].text, /after 90s/)
})

test('a notice is a frozen plugin message, not something the user said', () => {
  const first = createNoticeMessage('hello')
  const second = createNoticeMessage('hello')

  assert.equal(first.role, 'user')
  assert.deepEqual(first.source.kind, PLUGIN_SOURCE.kind)
  assert.equal(first.source.kind, 'plugin:fast-mode')
  assert.equal(Object.hasOwn(first.source, 'plugin'), false, 'the retired v4 source field is gone')
  assert.equal(first.source.form, 'notice')
  assert.ok(typeof first.source.summary === 'string' && first.source.summary.length > 0)
  assert.notEqual(first.id, second.id, 'every notice is its own message')
  assert.ok(Object.isFrozen(first))
  assert.ok(Object.isFrozen(first.content))
  assert.ok(Object.isFrozen(first.content[0]))
  assert.ok(Object.isFrozen(first.source))
})

test('the reminder follows the configured fan-out and stays within the notice summary limit', () => {
  const message = buildReassertMessage({ parallel: 6 })
  const text = message.content[0].text

  assert.match(text, /up to 6 independent calls/)
  assert.match(text, /compacted/)
  assert.match(text, /background/)
  assert.ok(message.source.summary.length <= SUMMARY_MAX_CHARS)

  // With no usable fan-out the sentence must not promise a number.
  const bare = buildReassertMessage({ parallel: 1 }).content[0].text
  assert.match(bare, /the independent calls/)
})

test('the conflict notice names both the plugin and what to do about it', () => {
  const message = buildConflictMessage(['dsh-batch-tool-calls', 'dsh-ops'])
  const text = message.content[0].text

  assert.match(text, /dsh-batch-tool-calls/)
  assert.match(text, /dsh-ops/)
  assert.match(text, /must not be enabled together/)
  assert.ok(message.source.summary.length <= SUMMARY_MAX_CHARS)
})

test('the install record is read with a package-name boundary', () => {
  const profile = (packageJson, patch = '') => (file) => (file.endsWith('package.json') ? packageJson : patch)

  assert.deepEqual(
    detectPeerPlugins('/p', profile(JSON.stringify({ bundles: ['dsh-batch-tool-calls@1.1.2'] }))),
    ['dsh-batch-tool-calls'],
  )
  assert.deepEqual(detectPeerPlugins('/p', profile('{"dependencies":{"dsh-ops":"^0.2.9"}}')), ['dsh-ops'])

  // A different package that merely starts with the same name, or a prose
  // mention, is not the plugin.
  assert.deepEqual(detectPeerPlugins('/p', profile('{"dependencies":{"dsh-ops-tools":"^1.0.0"}}')), [])
  assert.deepEqual(detectPeerPlugins('/p', profile('{}', '# dsh-ops is mentioned here but not installed')), [])

  // A missing profile is not a conflict.
  assert.deepEqual(detectPeerPlugins('/p', () => { throw new Error('ENOENT') }), [])
  assert.deepEqual(detectPeerPlugins('', profile('{}')), [])
  assert.deepEqual([...PEER_PLUGINS], ['dsh-batch-tool-calls', 'dsh-ops'])
})

test('the live registry probe answers only when an ops tool exists', () => {
  const ctxWith = (tools) => ({ get: (name) => (name === 'tools' ? tools : undefined) })

  assert.equal(opsToolsLive(ctxWith({ get: (name) => (name === 'ops_bash' ? {} : undefined) })), true)
  assert.equal(opsToolsLive(ctxWith({ get: () => undefined })), false)
  assert.equal(opsToolsLive(ctxWith(undefined)), false)
  assert.equal(opsToolsLive(undefined), false)
  assert.equal(opsToolsLive(ctxWith({ get: () => { throw new Error('scope') } })), false)
})
