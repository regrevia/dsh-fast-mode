/**
 * Integration test for the plugin wiring, without a running harness.
 *
 * A fake context captures the handlers the plugin registers, then the test
 * drives them in the order the harness would: a planning request, tool calls,
 * then execution requests. This is what proves the hooks are connected — the
 * policy tests alone would still pass if `apply()` registered nothing.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'

/** Minimal stand-in for a Cordis context. */
function fakeContext() {
  const handlers = new Map()
  const logs = []
  return {
    handlers,
    logs,
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    logger: { info: (...args) => logs.push(args) },
    fire(event, ...args) {
      const handler = handlers.get(event)
      assert.ok(handler, `no handler registered for ${event}`)
      return handler(...args)
    },
  }
}

const agent = { id: 'session-1' }
const accept = async () => ({ kind: 'accept' })

/** A request whose `next()` resolves to the harness-resolved config. */
const request = (ctx, { step, effort, turn = 0 }) =>
  ctx.fire('agent/request', { agent, turn, step, signal: new AbortController().signal }, async () => ({
    provider: 'company',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: effort,
  }))

const runTool = async (ctx, { callId, name, args, isError = false, text = 'ok' }) => {
  await ctx.fire('tools/pre-execute', { callId, name, arguments: args, agent }, accept)
  return ctx.fire(
    'tools/post-execute',
    { callId, name, arguments: args, agent },
    { isError, content: [{ type: 'text', text }] },
    accept,
  )
}

test('the plugin registers both tool hooks and the request hook', () => {
  const ctx = fakeContext()
  apply(ctx, {})
  for (const event of ['agent/request', 'tools/pre-execute', 'tools/post-execute']) {
    assert.ok(ctx.handlers.has(event), `missing ${event}`)
  }
})

test('enabled:false registers nothing', () => {
  const ctx = fakeContext()
  apply(ctx, { enabled: false })
  assert.equal(ctx.handlers.size, 0)
})

test('planning step keeps effort; execution step after clean calls is lowered', async () => {
  const ctx = fakeContext()
  apply(ctx, {})

  const planning = await request(ctx, { step: 1, effort: 'medium' })
  assert.equal(planning.reasoningEffort, 'medium', 'step 1 untouched')

  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a.ts' } })
  const execution = await request(ctx, { step: 2, effort: 'medium' })
  assert.equal(execution.reasoningEffort, 'low', 'medium drops one notch to low')
  assert.equal(execution.provider, 'company', 'the rest of the config is preserved')
})

test('a failing tool restores effort on the next step', async () => {
  const ctx = fakeContext()
  apply(ctx, {})

  await runTool(ctx, { callId: 'c1', name: 'bash', args: { command: 'false' }, isError: true })
  const after = await request(ctx, { step: 2, effort: 'medium' })
  assert.equal(after.reasoningEffort, 'medium', 'a failure means the next action is not routine')
})

test('tool hooks never alter the tool result', async () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const decision = await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' }, text: 'contents' })
  assert.deepEqual(decision, { kind: 'accept' }, 'observer forwarded the unmodified decision')

  const failing = await ctx.fire(
    'tools/post-execute',
    { callId: 'c2', name: 'bash', arguments: {}, agent },
    { isError: true, content: [{ type: 'text', text: 'boom' }] },
    async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'denied' }] }),
  )
  assert.deepEqual(failing, { kind: 'block', feedback: [{ type: 'text', text: 'denied' }] })
})

test('a fresh turn does not inherit the previous turn struggle', async () => {
  const ctx = fakeContext()
  apply(ctx, {})

  await runTool(ctx, { callId: 'c1', name: 'bash', args: {}, isError: true })
  const sameTurn = await request(ctx, { step: 2, effort: 'medium', turn: 0 })
  assert.equal(sameTurn.reasoningEffort, 'medium')

  const nextTurn = await request(ctx, { step: 1, effort: 'medium', turn: 1 })
  assert.equal(nextTurn.reasoningEffort, 'medium', 'planning step of the new turn')

  await runTool(ctx, { callId: 'c2', name: 'read', args: { path: 'b' } })
  const nextTurnExecution = await request(ctx, { step: 2, effort: 'medium', turn: 1 })
  assert.equal(nextTurnExecution.reasoningEffort, 'low', 'clean new turn earns the notch')
})

test('a long clean streak earns the second notch', async () => {
  const ctx = fakeContext()
  apply(ctx, { floor: 'minimal' })
  for (let index = 0; index < 8; index += 1) {
    await runTool(ctx, { callId: `c${index}`, name: 'read', args: { path: `f${index}` } })
  }
  const deep = await request(ctx, { step: 9, effort: 'high' })
  assert.equal(deep.reasoningEffort, 'low', 'high minus two notches')
})

test('an unknown effort id is passed through untouched', async () => {
  const ctx = fakeContext()
  apply(ctx, {})
  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
  const result = await request(ctx, { step: 2, effort: 'xhigh' })
  assert.equal(result.reasoningEffort, 'xhigh')
})

test('a throwing tool payload does not break the request', async () => {
  const ctx = fakeContext()
  apply(ctx, {})
  // A hostile/getter-only arguments object: observation must swallow this.
  const args = {}
  Object.defineProperty(args, 'path', { enumerable: true, get() { throw new Error('boom') } })
  await ctx.fire('tools/pre-execute', { callId: 'c1', name: 'read', arguments: args, agent }, accept)
  const decision = await ctx.fire(
    'tools/post-execute',
    { callId: 'c1', name: 'read', arguments: args, agent },
    { isError: false, content: [] },
    accept,
  )
  assert.deepEqual(decision, { kind: 'accept' }, 'tool result unaffected')

  const after = await request(ctx, { step: 2, effort: 'medium' })
  assert.ok(['low', 'medium'].includes(after.reasoningEffort), 'request still resolves')
})

test('debug writes one line per request with the signals', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-fast-mode-'))
  const file = join(dir, 'debug.log')
  try {
    const ctx = fakeContext()
    apply(ctx, { debug: true, debugFile: file })
    await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
    await request(ctx, { step: 2, effort: 'medium' })
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /step=2 medium=>low/)
    assert.match(lines[0], /clean=1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
