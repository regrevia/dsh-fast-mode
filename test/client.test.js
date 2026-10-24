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

import { GEARS } from '../src/effort.js'

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

/** Mount the chip against a remote and return its renderer. */
async function mount(remote) {
  const ctx = fakeContext(remote)
  const { module } = loadClient(remote)
  module.apply(ctx)
  await sleep(5)
  assert.equal(ctx.registered.length, 1)
  const { component, options } = ctx.registered[0]
  const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
  const render = () => component({ t, ...options.inject() })
  return { ctx, module, render, t }
}

/** The gear menu element, rendered (the fake react does not call components). */
function renderMenu(tree) {
  const element = tree.children[2]
  if (element === null || element === undefined) return undefined
  return element.type(element.props)
}

/** The four gear rows of a rendered menu: head and separator come first. */
function gearRows(menu) {
  return menu.children.slice(2, 6).map(element => element.props)
}

test('the bundle declares the loader contract and the services it needs', () => {
  const { bundle, module } = loadClient(fakeRemote())
  assert.equal(bundle.id, 'dsh-fast-mode')
  assert.deepEqual([...module.inject], ['slots', 'locale', 'remote', 'remote.settings'])
  assert.equal(typeof module.apply, 'function')
})

test('the offered gears are exactly the gears the host half implements', async () => {
  const { module } = await mount(fakeRemote())
  const offered = [...module.GEAR_MENU].map(entry => entry.id)
  const implemented = Object.keys(GEARS)
  assert.deepEqual(offered, implemented, 'a client-only gear id would be refused by the schema union')
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
  assert.ok(ctx.labels[0].dict.zh.chip && ctx.labels[0].dict.en.chip, 'both languages are shipped inline')
  assert.ok(ctx.labels[0].dict.zh.menu && ctx.labels[0].dict.zh.gears, 'the gear menu is translated too')
})

test('the chip answers the wire envelope: a payload-only describe still resolves the namespace', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'turbo' })
  // No envelope at all: the unwrapper must pass it through, not choke on it.
  const describe = remote.settings.describe
  remote.settings.describe = async () => (await describe()).value

  const { render } = await mount(remote)
  const tree = render()
  assert.equal(tree.children[0].props['data-on'], 'false')
  assert.match(tree.children[0].props.title, /turbo/, 'the gear was read through the bare payload')
})

test('the chip starts hollow and a click writes enabled:true with the revision it read', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'turbo' })
  const { render } = await mount(remote)
  const tree = render()
  const button = tree.children[0]

  assert.equal(button.props['data-on'], 'false', 'off is hollow')
  assert.equal(button.props['aria-pressed'], false)
  assert.equal(button.props.disabled, undefined, 'the chip is never a dead button')
  assert.match(button.props.title, /titleOff/, 'the tooltip names the gear while off')
  assert.match(button.props.title, /turbo/)
  assert.equal(button.children[0].children[0].props.fill, 'none', 'the bolt is hollow when off')

  button.props.onClick()
  await sleep(10)

  assert.equal(remote.calls.length, 1)
  // The call is assembled inside the vm realm, so compare fields, not identity.
  assert.equal(remote.calls[0].ns, 'fast-mode')
  assert.equal(remote.calls[0].patch.enabled, true)
  assert.equal(remote.calls[0].revision, 3)

  const onButton = render().children[0]
  assert.equal(onButton.props['data-on'], 'true', 'on is filled')
  assert.equal(onButton.children[0].children[0].props.fill, 'currentColor')
  assert.match(onButton.props.title, /titleOn/)
})

test('a second click turns it back off, still echoing the current revision', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'fast' })
  const { render } = await mount(remote)
  assert.equal(render().children[0].props['data-on'], 'true')

  render().children[0].props.onClick()
  await sleep(10)

  assert.equal(remote.calls[0].ns, 'fast-mode')
  assert.equal(remote.calls[0].patch.enabled, false)
  assert.equal(remote.calls[0].revision, 3)
  assert.equal(render().children[0].props['data-on'], 'false')
})

test('a refused write reverts the chip and explains itself in the tooltip', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'fast' }, { fail: true })
  const { render } = await mount(remote)
  render().children[0].props.onClick()
  await sleep(20)

  const after = render()
  assert.equal(after.children[0].props['data-on'], 'false', 'the optimistic paint must roll back')
  assert.match(after.children[0].props.title, /error/, 'the tooltip reports the failure')
  assert.match(after.children[0].props.title, /revision conflict/)

  const menu = renderMenu(after)
  assert.ok(menu !== undefined, 'a failed click opens the menu instead of doing nothing')
  assert.match(menu.children.at(-1).children.join(''), /revision conflict/, 'the menu states the reason')
})

test('the caret opens the gear menu, and every row states its speed and token estimate', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'fast' })
  const { ctx, render } = await mount(remote)

  const caret = render().children[1]
  assert.equal(caret.props.className, 'fm-chip__caret')
  assert.equal(caret.props['aria-haspopup'], 'dialog')
  assert.equal(renderMenu(render()), undefined, 'the menu starts closed')

  caret.props.onClick()
  const menu = renderMenu(render())
  assert.ok(menu !== undefined, 'the caret opens the menu')
  assert.match(menu.props.className, /^fm-menu( |$)/, 'the menu is the fixed-position popover')

  const rows = gearRows(menu)
  assert.equal(rows.length, 4)
  const meters = rows.map(row => row['aria-label'])
  assert.match(meters[0], /speed ~1\.0×/)
  assert.match(meters[0], /tokens ~1\.0×/)
  assert.match(meters[2], /speed ~1\.6×/)
  assert.match(meters[2], /tokens ~1\.5×/)
  assert.match(meters[3], /speed ~1\.9×/)
  assert.equal(rows[1]['data-current'], 'true', 'the current gear is marked')
  assert.equal(menu.children[6].props.className, 'fm-menu__note')
  const dict = ctx.labels[0].dict
  assert.match(dict.zh.menu.note, /预估/, 'the multipliers are labelled as estimates')
  assert.match(dict.en.menu.note, /estimates/i)
  assert.match(dict.zh.gears.turbo, /涡轮/, 'the gears carry their own names')
})

test('picking a gear in the menu writes it, and turns Fast mode on if it was off', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'fast' })
  const { render } = await mount(remote)

  render().children[1].props.onClick()
  gearRows(renderMenu(render()))[2].onClick() // turbo
  await sleep(20)

  assert.equal(remote.calls.length, 1, 'choosing a gear is one write')
  assert.equal(remote.calls[0].patch.gear, 'turbo')
  assert.equal(remote.calls[0].patch.enabled, true, 'a gear behind a disabled mode would look broken')
  assert.equal(remote.calls[0].revision, 3)

  const after = render()
  assert.equal(after.children[0].props['data-on'], 'true')
  assert.equal(renderMenu(after), undefined, 'a successful pick closes the menu')
  assert.match(after.children[0].props.title, /turbo/, 'the chip now reports the new gear')
})

test('picking a gear while Fast mode is already on leaves the toggle alone', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'safe' })
  const { render } = await mount(remote)

  render().children[1].props.onClick()
  gearRows(renderMenu(render()))[3].onClick() // max
  await sleep(20)

  assert.equal(remote.calls.length, 1)
  assert.equal(remote.calls[0].patch.gear, 'max')
  assert.equal('enabled' in remote.calls[0].patch, false, 'no redundant toggle field')
})

test('a read-only layer refuses to write and says so instead of going dead', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'fast' }, { writable: false })
  const { render } = await mount(remote)

  const tree = render()
  assert.equal(tree.children[0].props.disabled, undefined, 'read-only is explained, not disabled')
  assert.equal(tree.children[0].props.title, 'chip.readonly')

  tree.children[0].props.onClick()
  await sleep(10)
  assert.equal(remote.calls.length, 0, 'a read-only chip must never write')

  const menu = renderMenu(render())
  assert.ok(menu !== undefined)
  assert.equal(menu.children.at(-1).children.join(''), 'chip.readonly')
})

test('a composition without this entry opens an explanation and never throws', async () => {
  const remote = fakeRemote()
  remote.settings.describe = async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } })
  const { render } = await mount(remote)

  const tree = render()
  assert.equal(tree.children[0].props.disabled, undefined)
  assert.equal(tree.children[0].props['data-on'], 'false')
  assert.equal(tree.children[0].props.title, 'chip.absent')

  tree.children[0].props.onClick()
  await sleep(10)
  assert.equal(remote.calls.length, 0)
  const menu = renderMenu(render())
  assert.ok(menu !== undefined, 'an unknown configuration opens the menu with the reason')
  assert.equal(menu.children.at(-1).children.join(''), 'chip.absent')
})

test('a namespace with an empty value is still recognised by its declared schema', async () => {
  const remote = fakeRemote()
  // The mount reported no projected value, only the schema. That used to be
  // classified as "absent", which is what disabled the chip.
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

  const tree = render()
  assert.equal(tree.children[0].props.title.includes('chip.absent'), false, 'the schema identified the namespace')
  tree.children[0].props.onClick()
  await sleep(10)
  assert.equal(remote.calls.length, 1)
  assert.equal(remote.calls[0].ns, 'include:fast-mode')
  assert.equal(remote.calls[0].revision, 9)
})

test('an unsuccessful describe surfaces the error message rather than silence', async () => {
  const remote = fakeRemote()
  remote.settings.describe = async () => ({ ok: false, error: { code: 'remote/closed', message: 'bridge is down' } })
  const { render } = await mount(remote)

  const tree = render()
  assert.equal(tree.children[0].props.disabled, undefined)
  assert.match(tree.children[0].props.title, /bridge is down/)
})

test('styles are injected once per page, not once per apply', () => {
  const remote = fakeRemote()
  const { module, styles } = loadClient(remote)
  module.apply(fakeContext(remote))
  assert.equal(styles.length, 1, 'one <style> tag')
  assert.match(styles[0].textContent, /\.fm-chip__button/, 'the chip CSS travels with the bundle')
  assert.match(styles[0].textContent, /\.fm-menu__item/, 'the menu CSS travels with the bundle')
  assert.equal(styles[0].dataset.pluginCss, 'dsh-fast-mode/chip.css')
})
