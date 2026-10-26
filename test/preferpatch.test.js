import assert from 'node:assert/strict'
import test from 'node:test'

import { autoSchedule, createAutoState, notePolicy, noteStep, noteTool } from '../src/auto.js'

/** Two clean reads, so no other reminder is due and the cooldown has passed. */
function quietStart(state, agent) {
  noteStep(state, agent)
  noteTool(state, agent, { name: 'read', argsKey: 'a.js', chars: 10 })
  noteTool(state, agent, { name: 'read', argsKey: 'b.js', chars: 10 })
  noteStep(state, agent)
  noteTool(state, agent, { name: 'read', argsKey: 'c.js', chars: 10 })
  noteTool(state, agent, { name: 'read', argsKey: 'd.js', chars: 10 })
}

const BIG_WRITE = { name: 'write', argsKey: 'app.py', chars: 900, argChars: 12_000 }

test('the hunk reminder stays silent unless the config asked for it', () => {
  const state = createAutoState()
  notePolicy(state, 'a', {})
  quietStart(state, 'a')
  noteTool(state, 'a', BIG_WRITE)
  noteStep(state, 'a')
  assert.notEqual(autoSchedule(state, 'a').directive?.kind, 'prefer-patch')
})

test('a large whole-file write arms one hunk reminder on the next step', () => {
  const state = createAutoState()
  notePolicy(state, 'a', { preferPatch: true })
  quietStart(state, 'a')
  noteTool(state, 'a', BIG_WRITE)
  noteStep(state, 'a')
  const directive = autoSchedule(state, 'a').directive
  assert.equal(directive?.kind, 'prefer-patch')
  assert.match(directive.text, /edit hunk/)
  assert.match(directive.text, /byte-identical/)
})

test('the reminder is one-shot per turn and re-armed next turn', () => {
  const state = createAutoState()
  notePolicy(state, 'a', { preferPatch: true })
  quietStart(state, 'a')
  noteTool(state, 'a', BIG_WRITE)
  noteStep(state, 'a')
  assert.equal(autoSchedule(state, 'a').directive?.kind, 'prefer-patch')
  noteTool(state, 'a', BIG_WRITE)
  noteStep(state, 'a')
  assert.notEqual(autoSchedule(state, 'a').directive?.kind, 'prefer-patch', 'once per turn')

  // A new turn starts with the arm disarmed; only another big write arms it.
  notePolicy(state, 'a', { preferPatch: true })
  noteStep(state, 'a')
  noteTool(state, 'a', { name: 'read', argsKey: 'z.js', chars: 10 })
  noteStep(state, 'a')
  assert.notEqual(autoSchedule(state, 'a').directive?.kind, 'prefer-patch')
})

test('a small write or a hunk edit never arms it', () => {
  const state = createAutoState()
  notePolicy(state, 'a', { preferPatch: true })
  quietStart(state, 'a')
  noteTool(state, 'a', { name: 'write', argsKey: 'tiny.py', chars: 900, argChars: 40 })
  noteStep(state, 'a')
  noteTool(state, 'a', { name: 'read', argsKey: 'q.js', chars: 10 })
  noteStep(state, 'a')
  assert.notEqual(autoSchedule(state, 'a').directive?.kind, 'prefer-patch')
})

test('a hunk edit after a big write cancels the pending reminder', () => {
  const state = createAutoState()
  notePolicy(state, 'a', { preferPatch: true })
  quietStart(state, 'a')
  noteTool(state, 'a', BIG_WRITE)
  noteTool(state, 'a', { name: 'apply_patch', argsKey: 'app.py#hunk', chars: 20 })
  noteStep(state, 'a')
  assert.notEqual(autoSchedule(state, 'a').directive?.kind, 'prefer-patch')
})

test('the hunk reminder never limits the work or ends the turn', () => {
  const state = createAutoState()
  notePolicy(state, 'a', { preferPatch: true })
  quietStart(state, 'a')
  noteTool(state, 'a', BIG_WRITE)
  noteStep(state, 'a')
  const directive = autoSchedule(state, 'a').directive
  assert.equal(directive?.kind, 'prefer-patch')
  assert.doesNotMatch(directive.text, /report now|stop|enough|finish|no more/i)
})

/* Wiring: the hook must measure a whole-file argument even when the host hands
 * it the unparsed JSON string, otherwise the reminder is armed by nothing and
 * the arm looks identical to the default in a benchmark. */
const { apply } = await import('../index.js')

function wiredContext() {
  const handlers = new Map()
  return {
    handlers,
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event) },
    inject(names, callback) {
      const services = { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], defaultEffort: 'medium' } }) } }
      return names.every(n => services[n]) ? callback({ ...services, get: n => services[n], effect: fn => { const d = fn(); return () => (typeof d === 'function' ? d() : {}) } }) : undefined
    },
    get() { return undefined },
    logger: { info() {} },
    fire(event, ...args) {
      const handler = handlers.get(event)
      assert.ok(handler, `no handler for ${event}`)
      return handler(...args)
    },
  }
}

test('a whole-file write handed over as a JSON string still arms the reminder', async () => {
  const ctx = wiredContext()
  apply(ctx, { enabled: true, gear: 'auto', preferPatch: true, metrics: false, benchmarkFile: '' })
  const agent = { id: 'session-wired' }
  const next = async () => ({ kind: 'accept' })
  const enter = async () => ({ kind: 'enter', messages: [] })

  // The request hook resolves the harness config; without it the plugin stays off.
  await ctx.fire('agent/request', { agent, turn: 0, step: 0, signal: new AbortController().signal },
    async () => ({ provider: 'company', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' }))

  const step = async () => ctx.fire('agent/pre-step', { agent, messages: [] }, enter)
  const tool = async (name, args) => {
    await ctx.fire('tools/pre-execute', { callId: `${name}-1`, name, arguments: args, agent }, next)
    return ctx.fire('tools/post-execute', { callId: `${name}-1`, name, arguments: args, agent },
      { isError: false, content: [{ type: 'text', text: 'ok' }] }, next)
  }

  await step()
  await tool('read', { path: 'a.py' })
  await tool('write', JSON.stringify({ path: 'app.py', content: 'x'.repeat(9000) }))
  const decision = await step()
  const said = JSON.stringify(decision.messages ?? [])
  assert.match(said, /edit hunk/, 'the reminder must ride the next step')
})

test('another reminder a step earlier does not swallow the write hint', () => {
  const state = createAutoState()
  notePolicy(state, 'a', { preferPatch: true, lateDiscipline: true })
  // Six steps with prose output: the late discipline reminder fires and starts
  // the cooldown. A big write on the next step must still produce the hint.
  for (let i = 0; i < 5; i += 1) {
    noteStep(state, 'a')
    noteTool(state, 'a', { name: 'read', argsKey: `r${i}.js`, chars: 10 })
  }
  noteStep(state, 'a')
  assert.equal(autoSchedule(state, 'a').directive?.kind, 'compress-output')
  noteTool(state, 'a', BIG_WRITE)
  noteStep(state, 'a')
  assert.equal(autoSchedule(state, 'a').directive?.kind, 'prefer-patch', 'armed by the write, not by the clock')
})

test('a read-only peek at the schedule does not spend the hunk reminder', () => {
  const state = createAutoState()
  notePolicy(state, 'a', { preferPatch: true })
  quietStart(state, 'a')
  noteTool(state, 'a', BIG_WRITE)
  noteStep(state, 'a')

  // The width and stall-budget readers run before the delivery hook on every
  // step. They must not look like a delivery, or the one-shot reminder is
  // consumed by a caller that never showed it to the model.
  assert.equal(autoSchedule(state, 'a', { emit: false }).directive, undefined)
  assert.equal(autoSchedule(state, 'a', { emit: false }).directive, undefined)

  assert.equal(autoSchedule(state, 'a').directive?.kind, 'prefer-patch')
  // And once delivered it stays spent.
  assert.notEqual(autoSchedule(state, 'a').directive?.kind, 'prefer-patch')
})
