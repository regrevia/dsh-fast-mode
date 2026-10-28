/**
 * The four knobs, resolved per conversation at the host.
 *
 * The client half is tested in `client.test.js` (it writes the column), and the
 * format is tested in `state.test.js` (both copies agree). What is left is the
 * join the user actually feels: two conversations open at once, one with a knob
 * moved, and the other running exactly as before. That, and only that, shows the
 * knobs are not shared — the reason the previous release's panel felt dead was a
 * write the host refused, and the reason a fix could go wrong is a shared field
 * leaking a per-conversation choice.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/** Minimal stand-in for a Cordis context: registers handlers, fires them. */
function fakeContext() {
  const handlers = new Map()
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    inject() {
      return undefined
    },
    get() {
      return undefined
    },
    logger: { info: () => {} },
    fire(event, ...args) {
      const handler = handlers.get(event)
      assert.ok(handler, `no handler registered for ${event}`)
      return handler(...args)
    },
  }
}

const BASE = { enabled: true, gear: 'auto', metrics: false, benchmarkFile: '' }

/**
 * Drive one `agent/pre-step` the way the loop does.
 *
 * @param {any} ctx
 * @param {{id: string, cwd?: string, messages?: any[]}} agent
 */
function preStep(ctx, agent) {
  const claimed = agent.messages ?? []
  const decision = {
    kind: 'enter',
    messages: [{ id: 'sys', role: 'system', content: [] }, ...claimed, { id: 'last', role: 'assistant', content: [] }],
  }
  const payload = { agent: { id: agent.id, session: { header: { cwd: agent.cwd } } }, messages: claimed }
  return ctx.fire('agent/pre-step', payload, async () => decision).then(out => ({ out, decision }))
}

/** Every notice the decision carries, joined, for one readable assertion. */
const noticesOf = (out) => out.messages
  .filter(message => message.source?.form === 'notice')
  .map(message => message.content.map(part => part.text).join('\n'))
  .join('\n')

test('the file list is handed to the conversation that asked for it, and no other', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fm-session-map-'))
  try {
    await writeFile(join(root, 'README.md'), '# fixture\n')

    const ctx = fakeContext()
    apply(ctx, { ...BASE, sessions: JSON.stringify({ 'session-map': { map: true } }) })

    const mapped = await preStep(ctx, { id: 'session-map', cwd: root })
    assert.match(noticesOf(mapped.out), /README\.md/, 'the inventory reaches the conversation that turned it on')

    const plain = await preStep(ctx, { id: 'session-plain', cwd: root })
    assert.equal(plain.out, plain.decision, 'a conversation with no entry is untouched')

    // and the map is one per conversation: asking again does not repeat it.
    const again = await preStep(ctx, { id: 'session-map', cwd: root })
    assert.doesNotMatch(noticesOf(again.out), /README\.md/, 'one inventory per conversation, not per step')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the narration reminder follows the conversation, not the process', async () => {
  const ctx = fakeContext()
  apply(ctx, {
    ...BASE,
    sessions: JSON.stringify({
      'session-late': { discipline: 'late' },
      'session-quiet': { discipline: false },
    }),
  })

  // Four steps is where the late reminder is due; the scheduler counts steps per
  // conversation, so each one has to be driven its own way.
  let late = ''
  let quiet = ''
  for (let index = 0; index < 5; index += 1) {
    late = noticesOf((await preStep(ctx, { id: 'session-late' })).out) || late
    quiet = noticesOf((await preStep(ctx, { id: 'session-quiet' })).out) || quiet
  }

  assert.match(late, /prose is now the cost/, 'the late compressor speaks in the conversation that asked for it')
  assert.doesNotMatch(quiet, /prose is now the cost/, 'and stays out of the one that turned narration off')
})

test('a step budget ends its own conversation, not the one beside it', async () => {
  const ctx = fakeContext()
  apply(ctx, { ...BASE, sessions: JSON.stringify({ 'session-capped': { stepBudget: 2 } }) })

  let capped = ''
  for (let index = 0; index < 4; index += 1) {
    capped = noticesOf((await preStep(ctx, { id: 'session-capped' })).out) || capped
  }
  assert.match(capped, /reached the step budget/, 'the cap is honoured for the conversation that set it')

  let open = ''
  for (let index = 0; index < 6; index += 1) {
    open = noticesOf((await preStep(ctx, { id: 'session-open' })).out) || open
  }
  assert.doesNotMatch(open, /reached the step budget/, 'a conversation with no cap is never stopped by a counter')
})

test('an entry wins over the configured default, on every knob at once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fm-session-all-'))
  try {
    await writeFile(join(root, 'notes.txt'), 'fixture\n')

    const ctx = fakeContext()
    // Configured defaults: map off, narration on ('late'), no cap. The entry turns
    // all three the other way, and the conversation without one keeps them.
    apply(ctx, {
      ...BASE,
      workspaceMap: false,
      outputDiscipline: 'late',
      stepBudget: 0,
      sessions: JSON.stringify({
        'session-custom': { map: true, discipline: false, stepBudget: 1 },
      }),
    })

    const custom = await preStep(ctx, { id: 'session-custom', cwd: root })
    assert.match(noticesOf(custom.out), /notes\.txt/, 'map on for this one')
    assert.match(noticesOf(custom.out), /reached the step budget/, 'a two-step budget stops it on the first step of the count')

    const inherited = await preStep(ctx, { id: 'session-default', cwd: root })
    assert.equal(inherited.out, inherited.decision, 'the other conversation has no map and no cap')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
