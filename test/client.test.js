/**
 * The client half, executed the way the browser executes it.
 *
 * `client.js` is a static bundle: it calls `window.__ModuleLoader__.load()` with
 * its own id and a factory. Here that loader is a one-line stub, so the file runs
 * verbatim inside a `vm` context with a fake `document` — no bundler, no DOM
 * implementation, no harness. What this proves is the part the host-side tests
 * cannot: the shipped bundle parses, exports the loader contract, registers on
 * the composer slot that sits beside the model selector, and turns a click into
 * exactly one `settings/update` carrying the revision it read.
 *
 * The fake remote speaks the real wire shape: every answer is the
 * `{ ok, value }` envelope. Reading the payload without unwrapping that envelope
 * is what made the shipped chip inert, so the envelope is part of the fixture,
 * not a detail.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'


const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** `createElement` as data: enough to find the button and call its handler. */
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (effect) => { effect() },
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Load the bundle in a sandbox and hand back its exports.
 *
 * @param {{describe?: () => Promise<any>, update?: (ns: string, patch: object, revision?: number) => Promise<any>}} [settings]
 */
function loadClient(settings) {
  const loaded = []
  const styles = []
  const document = {
    querySelector: () => null,
    createElement: () => {
      const tag = { dataset: {}, textContent: '', remove() { tag.removed = true } }
      return tag
    },
    head: { appendChild: (tag) => styles.push(tag) },
  }
  const listeners = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (bundle) => loaded.push(bundle) },
      addEventListener: (type, fn) => listeners.push({ type, fn }),
      removeEventListener: () => {},
    },
    document,
    setTimeout,
    clearTimeout,
    console,
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.equal(loaded.length, 1, 'the bundle must call __ModuleLoader__.load exactly once')
  const bundle = loaded[0]
  const module = bundle.factory((name) => {
    assert.equal(name, 'react', `the bundle may only require react, asked for ${name}`)
    return react
  })
  return { bundle, module, styles, listeners }
}

/**
 * A settings remote backed by one mutable namespace, which is what the host is:
 * `update` merges into the user layer and bumps the revision. Answers wear the
 * wire envelope.
 */
function fakeRemote(initial = { enabled: false, gear: 'fast' }, { writable = true, fail = false } = {}) {
  const state = { value: { ...initial }, revision: 3 }
  const calls = []
  return {
    calls,
    state,
    settings: {
      async describe() {
        return {
          ok: true,
          value: {
            writable,
            hasDocument: true,
            namespaces: [{ ns: 'fast-mode', autoGenerate: true, schema: {}, value: { ...state.value }, applies: 'live', secrets: [], revision: state.revision }],
          },
        }
      },
      async update(ns, patch, revision) {
        calls.push({ ns, patch, revision })
        if (fail) return { ok: false, error: { code: 'settings/conflict', message: 'revision conflict' } }
        assert.equal(ns, 'fast-mode')
        state.value = { ...state.value, ...patch }
        state.revision += 1
        return {
          ok: true,
          value: { ns, autoGenerate: true, schema: {}, value: { ...state.value }, applies: 'live', secrets: [], revision: state.revision },
        }
      },
    },
  }
}

/** A context shaped like the client root, capturing whatever the bundle registers. */
function fakeContext(remote) {
  const registered = []
  const injected = []
  const labels = []
  return {
    registered,
    injected,
    labels,
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { warn: () => {}, info: () => {} },
    locale: {
      register: (ns, dict) => { labels.push({ ns, dict }); return () => {} },
      bind: (ns) => (key, params) => `[${ns}] ${key}${params ? ` ${JSON.stringify(params)}` : ''}`,
    },
    slots: {
      inject(key, callback) {
        injected.push(key)
        callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
    remote,
  }
}

/**
 * Mount the chip against a remote and return its renderer.
 *
 * `sessionId` is handed to the registration's `inject` the way the slot kit does
 * it (the binding key comes first), so the component sees a conversation. Pass
 * `undefined` to model a page that injects nothing, and pass props to `render` to
 * model the standard-prop spelling instead.
 */
async function mount(remote, sessionId = 'session-alpha') {
  const ctx = fakeContext(remote)
  const { module } = loadClient(remote)
  module.apply(ctx)
  await sleep(5)
  assert.equal(ctx.registered.length, 1)
  const { component, options } = ctx.registered[0]
  const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
  const render = (extra = {}) => component({ t, ...options.inject(sessionId), ...extra })
  // The chip refreshes from an effect, so the very first render paints the
  // defaults. Render once and let the describe land, otherwise every test would
  // be asserting on that first paint instead of on the state it mounted for.
  render()
  await sleep(10)
  return { ctx, module, render, t }
}

/** The bolt: the chip carries exactly one control, and it *is* the switch. */
function boltOf(tree) {
  return tree.children[0]
}

/** One click on the bolt. The handler is async internally; callers await sleep. */
function clickBolt(render) {
  boltOf(render()).props.onClick()
  return sleep(20)
}

/** Read the `sessions` column out of one recorded patch. */
function columnOf(call) {
  return JSON.parse(call.patch.sessions)
}

test('the bundle declares the loader contract and the services it needs', () => {
  const { bundle, module } = loadClient(fakeRemote())
  assert.equal(bundle.id, 'dsh-fast-mode')
  assert.deepEqual([...module.inject], ['slots', 'locale', 'remote', 'remote.settings'])
  assert.equal(typeof module.apply, 'function')
})

test('it registers one chip on the composer slot beside the model selector, never on the selector itself', async () => {
  const remote = fakeRemote()
  const ctx = fakeContext(remote)
  const { module } = loadClient(remote)
  module.apply(ctx)
  await sleep(5)

  assert.deepEqual([...ctx.injected], ['conversation.input.activity'])
  assert.equal(ctx.registered.length, 1)
  const { options } = ctx.registered[0]
  assert.equal(options.name, 'conversation.input.activity')
  assert.equal(options.locale, 'fast-mode', 'the chip must own a dictionary namespace')
  assert.equal(options.inject().remote, remote, 'the component needs the settings remote')
  assert.equal(ctx.labels.length, 1, 'dictionaries are registered once')
  const dict = ctx.labels[0].dict
  assert.equal(typeof dict.zh['chip.on'], 'string', 'both languages are shipped inline')
  assert.equal(typeof dict.en['chip.on'], 'string')
  assert.equal(dict['zh-CN'], dict.zh, 'the zh-CN tag falls back to the same strings')
})

test('the bolt is the switch: no popover, no caret, no dialog affordance', async () => {
  const { module, render } = await mount(fakeRemote({ enabled: true, gear: 'auto' }))
  assert.equal(module.GEAR_MENU, undefined, 'there is no client-side gear table to drift from the host')

  const tree = render()
  assert.equal(tree.children.length, 1, 'the chip paints the bolt and nothing else')
  const bolt = boltOf(tree)
  assert.equal(bolt.props.role, undefined, 'a pressed button is a switch, not a dialog trigger')
  assert.equal(bolt.props['aria-haspopup'], undefined, 'there is nothing to open')
  assert.equal(bolt.props['aria-expanded'], undefined)
  assert.equal(bolt.props['aria-pressed'], true, 'the pressed state is the on/off state')
  assert.equal(bolt.props['data-on'], 'true')
  assert.equal(bolt.children.length, 1, 'one icon, no panel slot')
})

test('one click turns fast mode on for this conversation and writes immediately', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'turbo' })
  const { render } = await mount(remote, 'session-alpha')
  assert.equal(boltOf(render()).props['data-on'], 'false')

  await clickBolt(render)

  assert.equal(remote.calls.length, 1, 'the click is the write; nothing opens in between')
  assert.equal(remote.calls[0].ns, 'fast-mode')
  assert.equal(remote.calls[0].patch.enabled, true)
  assert.equal(remote.calls[0].patch.gear, 'auto', 'the scheduler is the only mode')
  assert.equal(remote.calls[0].revision, 3, 'the write echoes the revision it read')
  assert.equal(boltOf(render()).props['data-on'], 'true', 'the bolt fills after the host echoes')
  assert.equal(boltOf(render()).props.title, 'chip.titleOn')
})

test('a second click turns it back off, still echoing the current revision', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'auto' })
  const { render } = await mount(remote)
  assert.equal(boltOf(render()).props['data-on'], 'true')

  await clickBolt(render)

  assert.equal(remote.calls[0].patch.enabled, false)
  assert.equal(boltOf(render()).props['data-on'], 'false')
})

test('the chip never writes a thinking effort, so the user choice cannot drift', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'auto' })
  const { render } = await mount(remote, 'session-alpha')
  await clickBolt(render)

  const patch = remote.calls[0].patch
  assert.deepEqual(Object.keys(patch).sort(), ['enabled', 'gear', 'sessions'],
    'three fields: the switch, the scheduler, and the per-conversation column')
  assert.equal(JSON.stringify(patch).includes('reasoningEffort'), false)
  assert.equal(JSON.stringify(patch).includes('effort'), false)
})

test('a refused write reverts the bolt and explains itself in the tooltip', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'auto' }, { fail: true })
  const { render } = await mount(remote)
  await clickBolt(render)

  const after = render()
  assert.equal(boltOf(after).props['data-on'], 'false', 'the optimistic paint must roll back')
  assert.match(boltOf(after).props.title, /error/, 'the tooltip reports the failure')
  assert.match(boltOf(after).props.title, /revision conflict/)
  assert.equal(after.children.length, 1, 'and there is no surface left open to explain it in')
})

test('a read-only configuration accepts no writes and says so on the bolt', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'auto' }, { writable: false })
  const { render } = await mount(remote)

  assert.match(boltOf(render()).props.title, /chip.readonly/)
  await clickBolt(render)
  assert.equal(remote.calls.length, 0, 'read-only means read-only')
})

test('the chip is never disabled: an unreadable configuration stays clickable and explains the error', async () => {
  const remote = fakeRemote()
  remote.settings.describe = async () => ({ ok: false, error: { code: 'remote/closed', message: 'bridge is down' } })
  const { render } = await mount(remote)

  const tree = render()
  assert.equal(boltOf(tree).props.disabled, undefined, 'a disabled button drops its tooltip in Chrome')
  assert.match(boltOf(tree).props.title, /bridge is down/)
})

test('the chip answers the wire envelope: a payload-only describe still resolves the namespace', async () => {
  const remote = fakeRemote()
  const { render } = await mount(remote)
  assert.equal(boltOf(render()).props.title.includes('chip.absent'), false, 'the namespace was found')
})

test('a namespace with an empty value is still recognised by its declared schema', async () => {
  const remote = fakeRemote()
  remote.settings.describe = async () => ({
    ok: true,
    value: {
      writable: true,
      hasDocument: true,
      namespaces: [{
        ns: 'include:fast-mode',
        autoGenerate: true,
        schema: { type: 'object', dict: { enabled: { type: 'boolean' }, gear: { type: 'string' } } },
        value: {},
        applies: 'live',
        secrets: [],
        revision: 9,
      }],
    },
  })
  const { render } = await mount(remote)

  assert.equal(boltOf(render()).props.title.includes('chip.absent'), false, 'the schema identified the namespace')
  await clickBolt(render)
  assert.equal(remote.calls.length, 1)
  assert.equal(remote.calls[0].ns, 'include:fast-mode')
  assert.equal(remote.calls[0].revision, 9)
})

test('every dictionary key is flat, because the locale lookup indexes it flat', async () => {
  const { ctx } = await mount(fakeRemote())
  const dict = ctx.labels[0].dict

  for (const lang of ['zh', 'en']) {
    for (const key of Object.keys(dict[lang])) {
      assert.match(key, /^[a-z]+(\.[a-zA-Z]+)+$/, `${lang}: "${key}" must be a dotted flat key`)
    }
  }
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort(), 'both languages carry the same keys')
  assert.equal(Object.keys(dict.zh).some(key => key.startsWith('menu.')), false,
    'the popover dictionary is gone; the explanation lives in the plugin description')
})

test('the copy states the two things the mode promises: same effort, this conversation only', async () => {
  const { ctx } = await mount(fakeRemote())
  const dict = ctx.labels[0].dict

  assert.match(dict.zh['chip.titleOn'], /思考强度不变/, 'the tooltip states the contract: effort is untouched')
  assert.match(dict.zh['chip.titleOn'], /本会话/, 'and that the choice is scoped to the conversation')
  assert.match(dict.zh['chip.titleOn'], /点击关闭/, 'and what the click does')
  assert.match(dict.en['chip.titleOn'], /effort unchanged/i, 'English says the same thing')
  assert.equal(/×/.test(JSON.stringify(dict)), false, 'no multiplier claim survives anywhere in the chip copy')
})

test('styles are injected once per page, not once per apply', () => {
  const remote = fakeRemote()
  const { module, styles } = loadClient(remote)
  module.apply(fakeContext(remote))
  assert.equal(styles.length, 1, 'one <style> tag')
  assert.match(styles[0].textContent, /\.fm-chip__button/, 'the chip CSS travels with the bundle')
  assert.equal(styles[0].textContent.includes('.fm-menu'), false, 'the popover CSS is gone with the popover')
  assert.match(styles[0].textContent, /data-on="true"\]\{color:/, 'on is a filled bolt, not a panel')
  assert.equal(styles[0].textContent.includes('.fm-chip__caret'), false, 'the caret is gone for good')
  assert.equal(styles[0].textContent.includes('nowrap'), false, 'nothing is clipped any more')
  assert.equal(styles[0].dataset.pluginCss, 'dsh-fast-mode/chip.css')
})

/* ------------------------------------------------- per-conversation state */

test('a click records the choice for its own conversation, next to the shared default', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'turbo' })
  const { render } = await mount(remote, 'session-alpha')
  await clickBolt(render)

  assert.equal(remote.calls.length, 1, 'one patch carries both tiers')
  const patch = remote.calls[0].patch
  assert.equal(patch.enabled, true, 'the shared field doubles as the last choice')
  assert.equal(patch.gear, 'auto', 'and normalises the retired gear to the scheduler')
  const column = columnOf(remote.calls[0])
  assert.deepEqual(Object.keys(column), ['session-alpha'], 'only the clicked conversation gets an entry')
  assert.equal(column['session-alpha'].enabled, true)
  assert.equal(column['session-alpha'].gear, 'auto')
})

test('a conversation with its own entry keeps it when the shared switch moves', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'auto' })

  const alpha = await mount(remote, 'session-alpha')
  await clickBolt(alpha.render)
  assert.equal(boltOf(alpha.render()).props['data-on'], 'true')

  const beta = await mount(remote, 'session-beta')
  await clickBolt(beta.render)

  assert.equal(remote.calls.at(-1).patch.enabled, false, 'beta turned the shared switch off')
  const column = columnOf(remote.calls.at(-1))
  assert.equal(column['session-beta'].enabled, false)
  assert.equal(column['session-alpha'].enabled, true, 'alpha was never touched')

  const again = await mount(remote, 'session-alpha')
  assert.equal(boltOf(again.render()).props['data-on'], 'true', 'reopening alpha paints its own entry')
})

test('a restart restores the last choice per conversation, not a global default', async () => {
  const remote = fakeRemote({
    enabled: true,
    gear: 'auto',
    sessions: JSON.stringify({ 'session-alpha': { enabled: false, gear: 'auto', ts: 2 } }),
  })

  const alpha = await mount(remote, 'session-alpha')
  assert.equal(boltOf(alpha.render()).props['data-on'], 'false', 'alpha turned fast mode off before the restart')

  const fresh = await mount(remote, 'session-brand-new')
  assert.equal(boltOf(fresh.render()).props['data-on'], 'true', 'a new conversation starts from the last shared choice')
})

test('a conversation with no entry inherits the most recent choice', async () => {
  const remote = fakeRemote({
    enabled: true,
    gear: 'max',
    sessions: JSON.stringify({ 'session-alpha': { enabled: false, gear: 'safe', ts: 1 } }),
  })

  const fresh = await mount(remote, 'session-brand-new')
  const tree = fresh.render()
  assert.equal(boltOf(tree).props['data-on'], 'true', 'a new session starts where the user left off')
  assert.equal(boltOf(tree).props.title, 'chip.titleOn', 'the tooltip never quotes a gear any more')

  const scoped = await mount(remote, 'session-alpha')
  assert.equal(boltOf(scoped.render()).props['data-on'], 'false', 'an entry still outranks the shared default')
})

test('an entry that pins only the gear still inherits the shared switch', async () => {
  const remote = fakeRemote({
    enabled: true,
    gear: 'fast',
    sessions: JSON.stringify({ 'session-alpha': { gear: 'turbo', ts: 7 } }),
  })
  const { render } = await mount(remote, 'session-alpha')
  assert.equal(boltOf(render()).props['data-on'], 'true')

  await clickBolt(render)
  const column = columnOf(remote.calls[0])
  assert.equal(column['session-alpha'].enabled, false, 'the click is now pinned for this conversation')
  assert.equal(column['session-alpha'].gear, 'auto', 'the chip only ever writes the scheduler')
})

test('the conversation id is honoured whether it arrives injected or as a standard prop', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'auto' })
  const { render } = await mount(remote, undefined)
  const withProp = () => render({ sessionId: 'session-standard' })

  boltOf(withProp()).props.onClick()
  await sleep(20)

  assert.equal(remote.calls.length, 1)
  const column = columnOf(remote.calls[0])
  assert.deepEqual(Object.keys(column), ['session-standard'], 'the standard prop is enough on its own')
})

/* ------------------------------------------------------- right-click panel */

/** Right click the bolt: opens (or closes) the settings panel. */
function rightClick(render) {
  boltOf(render()).props.onContextMenu({ preventDefault() {} })
  return sleep(10)
}

/** The panel is the chip's second child; absent means closed. */
function panelOf(tree) {
  return tree.children[1]
}

/** The one preference row inside the panel. */
function rowOf(panel) {
  return panel.children[1]
}

/** The step-cap row: the second control in the panel. */
function budgetRowOf(panel) {
  return panel.children[2]
}

test('right click opens the panel and writes nothing: the left click is still the switch', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'auto' })
  const { render } = await mount(remote)

  assert.equal(panelOf(render()), undefined, 'a closed chip renders one control')

  await rightClick(render)
  const panel = panelOf(render())
  assert.ok(panel, 'right click opens the panel')
  assert.equal(panel.props.role, 'menu')
  assert.equal(remote.calls.length, 0, 'opening a panel is not a write')

  await rightClick(render)
  assert.equal(panelOf(render()), undefined, 'a second right click closes it')
})

test('the panel switch turns the narration reminder off and on through the shared field', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'auto' })
  const { render } = await mount(remote)

  await rightClick(render)
  assert.equal(rowOf(panelOf(render())).props['aria-checked'], true, 'the shipped default is on')
  await rowOf(panelOf(render())).props.onClick()
  await sleep(30)

  assert.equal(remote.calls.length, 1)
  const patch = remote.calls[0].patch
  assert.equal(patch.outputDiscipline, false, 'off is a real value, not a missing field')
  assert.equal('enabled' in patch, false, 'the switch must not flip the mode as a side effect')
  assert.equal(panelOf(render()), undefined, 'the panel closes after a choice')
  assert.equal(remote.state.value.outputDiscipline, false)

  await rightClick(render)
  assert.equal(rowOf(panelOf(render())).props['aria-checked'], false, 'the panel paints the host value')
  await rowOf(panelOf(render())).props.onClick()
  await sleep(30)
  assert.equal(remote.calls[1].patch.outputDiscipline, 'late', 'back to the shipped default')
})

test('a read-only configuration disables the panel row instead of swallowing the click', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'auto' }, { writable: false })
  const { render } = await mount(remote)

  await rightClick(render)
  assert.equal(rowOf(panelOf(render())).props.disabled, true)
  await rowOf(panelOf(render())).props.onClick()
  await sleep(20)
  assert.equal(remote.calls.length, 0)
})

test('the step cap cycles through 0, 15 and 30 without touching the switch or the session entry', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'auto' })
  const { render } = await mount(remote)

  await rightClick(render)
  assert.equal(budgetRowOf(panelOf(render())).props.disabled, false, 'the cap row is live')
  const valueOf = () => budgetRowOf(panelOf(render())).children[1].children[0]

  assert.equal(valueOf(), 'panel.budgetOff', 'no cap is the shipped default')

  for (const want of [15, 30, 0]) {
    await budgetRowOf(panelOf(render())).props.onClick()
    await sleep(40)
    const call = remote.calls[remote.calls.length - 1]
    assert.equal(call.patch.stepBudget, want, 'three caps, then back off')
    assert.equal('sessions' in call.patch, false, 'a shared cap must not rewrite the per-conversation entry')
    assert.equal('enabled' in call.patch, false, 'the cap is not the mode switch')
    assert.ok(panelOf(render()), 'the panel stays open while cycling a cap')
  }
})
