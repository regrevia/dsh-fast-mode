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
  const header = { cwd: agent.cwd }
  if (agent.parentSession !== undefined) header.parentSession = agent.parentSession
  const payload = { agent: { id: agent.id, session: { header } }, messages: claimed }
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

test('a subagent follows the conversation that dispatched it, entry and all', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fm-session-child-'))
  try {
    await writeFile(join(root, 'README.md'), '# fixture\n')

    // The shared defaults are off. Only one conversation was clicked on, and it
    // wrote an entry; a subagent's own id is a bare UUID that no panel can ever
    // write, so the only way the child can start on is by inheriting.
    const ctx = fakeContext()
    apply(ctx, {
      ...BASE,
      enabled: false,
      workspaceMap: false,
      sessions: JSON.stringify({ 'session-parent': { enabled: true, map: true } }),
    })

    const child = await preStep(ctx, { id: '9f3c1a44-0b21-4d7e-9c55-2ad0f1c8b7e6', cwd: root, parentSession: 'session-parent' })
    assert.match(noticesOf(child.out), /README\.md/, 'the dispatch the user turned on runs on')

    const orphan = await preStep(ctx, { id: '1b0d77e2-5c9a-4f33-8e10-77c4a2b6d001', cwd: root })
    assert.equal(orphan.out, orphan.decision, 'a subagent with no parent in the header keeps the shared default')

    const stranger = await preStep(ctx, { id: 'c4a8e901-3f27-4b6d-a1c8-90e5d3b7f2aa', cwd: root, parentSession: 'session-other' })
    assert.equal(stranger.out, stranger.decision, 'and one from another conversation is not pulled on by it')

    const parent = await preStep(ctx, { id: 'session-parent', cwd: root })
    assert.match(noticesOf(parent.out), /README\.md/, 'the conversation itself is unchanged by the child rule')

    // Turning the parent off turns everything it dispatches off with it, which is
    // the half a global default gets wrong: father off, child on.
    const off = fakeContext()
    apply(off, {
      ...BASE,
      enabled: true,
      workspaceMap: true,
      sessions: JSON.stringify({ 'session-parent': { enabled: false } }),
    })
    const muted = await preStep(off, { id: 'e7c22051-8a4d-4b19-bf60-1c9d5a3e8877', cwd: root, parentSession: 'session-parent' })
    assert.equal(muted.out, muted.decision, 'a muted conversation dispatches muted work')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
