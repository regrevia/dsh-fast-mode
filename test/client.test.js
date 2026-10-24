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

/** The panel element, rendered (the fake react does not call components). */
function renderMenu(tree) {
  const element = tree.children[1]
  if (element === null || element === undefined) return undefined
  return element.type(element.props)
}

/** The bolt: the chip carries exactly one control. */
function boltOf(tree) {
  return tree.children[0]
}

/** Click the bolt and hand back the opened panel. */
function openPanel(render) {
  boltOf(render()).props.onClick()
  return renderMenu(render())
}

/** The on/off switch, inside the panel head row. */
function switchOf(menu) {
  return menu.children[0].children[1]
}

/** The gear rows of a rendered panel, in menu order. */
function gearRows(menu) {
  return menu.children
    .filter(element => element.props && element.props.className === 'fm-menu__item')
    .map(element => element.props)
}

/** The trailing line of a panel: the estimate note, or a status sentence. */
function lastLine(menu) {
  return menu.children.at(-1).children.join('')
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
  const dict = ctx.labels[0].dict
  assert.equal(typeof dict.zh['chip.on'], 'string', 'both languages are shipped inline')
  assert.equal(typeof dict.en['chip.on'], 'string')
  assert.equal(dict['zh-CN'], dict.zh, 'the zh-CN tag falls back to the same strings')
})

test('every dictionary key is flat, because the locale lookup indexes it flat', async () => {
  const { ctx } = await mount(fakeRemote())
  const dict = ctx.labels[0].dict

  // `dsh-client-locale` resolves a key as `dict[locale][key]`. A nested object
  // can never answer `'menu.title'`, which is why the shipped panel painted raw
  // keys instead of words. Every shipped key must therefore be a dotted string.
  for (const locale of ['zh', 'en']) {
    for (const [key, value] of Object.entries(dict[locale])) {
      assert.equal(typeof value, 'string', `${locale}: ${key} must be a string`)
      assert.match(key, /^[a-z]+(\.[a-zA-Z]+)+$/, `${locale}: "${key}" must be a dotted flat key`)
    }
  }
  assert.match(dict.zh['menu.note'], /预估/, 'the multipliers are labelled as estimates')
  assert.match(dict.en['menu.note'], /estimates/i)
  assert.match(dict.zh['gears.turbo'], /涡轮/, 'the gears carry their own names')
  assert.match(dict.zh['gears.ludicrous'], /极速/)
  assert.match(dict.zh['menu.warn'], /质量/, 'the past-2x gear says what it costs')
})

test('the outer control is one icon: no caret, no dropdown affordance', async () => {
  const { render } = await mount(fakeRemote())
  const tree = render()

  assert.deepEqual(tree.children.filter(Boolean).map(el => el.props.className), ['fm-chip__button'],
    'closed: the chip is the bolt and nothing else')
  const bolt = boltOf(tree)
  assert.equal(bolt.props.className, 'fm-chip__button')
  assert.equal(bolt.props['aria-haspopup'], 'dialog', 'the bolt opens the panel')
  assert.equal(bolt.props['aria-expanded'], false)
  assert.equal(bolt.props.title.includes('chip.title'), true, 'the icon still explains itself on hover')
})

test('the chip answers the wire envelope: a payload-only describe still resolves the namespace', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'turbo' })
  // No envelope at all: the unwrapper must pass it through, not choke on it.
  const describe = remote.settings.describe
  remote.settings.describe = async () => (await describe()).value

  const { render } = await mount(remote)
  const tree = render()
  assert.equal(boltOf(tree).props['data-on'], 'false')
  assert.match(boltOf(tree).props.title, /turbo/, 'the gear was read through the bare payload')
})

test('clicking the bolt opens the panel and writes nothing by itself', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'turbo' })
  const { render } = await mount(remote)

  const menu = openPanel(render)
  assert.ok(menu !== undefined, 'the bolt opens the panel')
  assert.equal(remote.calls.length, 0, 'opening the panel is not a configuration write')
  assert.match(menu.props.className, /^fm-menu( |$)/)
  assert.equal(menu.props['aria-label'], 'menu.title')
  assert.equal(boltOf(render()).props['aria-expanded'], true, 'the icon reports the panel state')
})

test('the switch inside the panel turns Fast mode on with the revision it read', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'turbo' })
  const { render } = await mount(remote)
  const menu = openPanel(render)
  assert.equal(switchOf(menu).props['aria-checked'], false, 'the switch starts off (hollow bolt)')

  switchOf(menu).props.onClick()
  await sleep(20)

  assert.equal(remote.calls.length, 1)
  assert.equal(remote.calls[0].ns, 'fast-mode')
  assert.equal(remote.calls[0].patch.enabled, true)
  assert.equal(remote.calls[0].revision, 3)

  const after = render()
  const onBolt = boltOf(after)
  assert.equal(onBolt.props['data-on'], 'true', 'on is filled')
  assert.equal(onBolt.children[0].children[0].props.fill, 'currentColor')
  assert.match(onBolt.props.title, /titleOn/)
  assert.equal(switchOf(renderMenu(after)).props['aria-checked'], true, 'the panel stays open and in sync')
})

test('a second click on the switch turns it back off, still echoing the current revision', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'fast' })
  const { render } = await mount(remote)
  assert.equal(boltOf(render()).props['data-on'], 'true')

  switchOf(openPanel(render)).props.onClick()
  await sleep(20)

  assert.equal(remote.calls[0].ns, 'fast-mode')
  assert.equal(remote.calls[0].patch.enabled, false)
  assert.equal(remote.calls[0].revision, 3)
  assert.equal(boltOf(render()).props['data-on'], 'false')
})

test('a refused write reverts the chip and explains itself in the tooltip and the panel', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'fast' }, { fail: true })
  const { render } = await mount(remote)
  switchOf(openPanel(render)).props.onClick()
  await sleep(20)

  const after = render()
  assert.equal(boltOf(after).props['data-on'], 'false', 'the optimistic paint must roll back')
  assert.match(boltOf(after).props.title, /error/, 'the tooltip reports the failure')
  assert.match(boltOf(after).props.title, /revision conflict/)

  const menu = renderMenu(after)
  assert.ok(menu !== undefined, 'the panel stays open so the reason stays visible')
  assert.match(lastLine(menu), /revision conflict/, 'the panel states the reason')
})

test('every gear row states its speed and token estimate, and the panel stays narrow', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'fast' })
  const { render } = await mount(remote)

  const menu = openPanel(render)
  const rows = gearRows(menu)
  assert.equal(rows.length, 5, 'four tiers plus the past-2x gear')

  assert.match(rows[0]['aria-label'], /1\.0× · 1\.0×/)
  assert.match(rows[2]['aria-label'], /1\.6× · 1\.5×/)
  assert.match(rows[3]['aria-label'], /2\.2× · 1\.9×/, 'max is the last legal cut on a route without `off`')
  assert.match(rows[4]['aria-label'], /3\.4× · 1\.3×/, 'the opt-in gear is where 3x lives')
  assert.match(rows[4]['aria-label'], /质量|quality|warn/, 'the risky gear carries its warning')
  const riskyName = menu.children
    .filter(element => element.props && element.props.className === 'fm-menu__item')[4]
    .children[0].children.join('')
  assert.equal(riskyName, 'gears.ludicrous*', 'and an asterisk next to its name')

  assert.equal(rows[1]['data-current'], 'true', 'the current gear is marked')
  assert.equal(rows[0]['data-current'], 'false')
  assert.equal(lastLine(menu), 'menu.note menu.warn', 'one line of fine print, not one per row')

  // The earlier panel repeated `速度`/`token` on every row and overflowed its
  // own 274px box. The rewritten one is a fixed narrow popover.
  assert.match(menu.props.className, /^fm-menu( |$)/)
})

test('picking a gear in the panel writes it, and turns Fast mode on if it was off', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'fast' })
  const { render } = await mount(remote)

  gearRows(openPanel(render))[2].onClick() // turbo
  await sleep(20)

  assert.equal(remote.calls.length, 1, 'choosing a gear is one write')
  assert.equal(remote.calls[0].patch.gear, 'turbo')
  assert.equal(remote.calls[0].patch.enabled, true, 'a gear behind a disabled mode would look broken')
  assert.equal(remote.calls[0].revision, 3)

  const after = render()
  assert.equal(boltOf(after).props['data-on'], 'true')
  assert.equal(renderMenu(after), undefined, 'a successful pick closes the panel')
  assert.match(boltOf(after).props.title, /turbo/, 'the chip now reports the new gear')
})

test('picking a gear while Fast mode is already on leaves the toggle alone', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'safe' })
  const { render } = await mount(remote)

  gearRows(openPanel(render))[4].onClick() // ludicrous
  await sleep(20)

  assert.equal(remote.calls.length, 1)
  assert.equal(remote.calls[0].patch.gear, 'ludicrous')
  assert.equal('enabled' in remote.calls[0].patch, false, 'no redundant toggle field')
})

test('a read-only layer refuses to write and says so instead of going dead', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'fast' }, { writable: false })
  const { render } = await mount(remote)

  const tree = render()
  assert.equal(boltOf(tree).props.disabled, undefined, 'read-only is explained, not disabled')
  assert.equal(boltOf(tree).props.title, 'chip.readonly')

  const menu = openPanel(render)
  assert.ok(menu !== undefined, 'the panel still opens, with the reason in it')
  assert.equal(lastLine(menu), 'chip.readonly')

  switchOf(menu).props.onClick()
  await sleep(10)
  assert.equal(remote.calls.length, 0, 'a read-only chip must never write')
})

test('a composition without this entry opens an explanation and never throws', async () => {
  const remote = fakeRemote()
  remote.settings.describe = async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } })
  const { render } = await mount(remote)

  const tree = render()
  assert.equal(boltOf(tree).props.disabled, undefined)
  assert.equal(boltOf(tree).props['data-on'], 'false')
  assert.equal(boltOf(tree).props.title, 'chip.absent')

  const menu = openPanel(render)
  assert.ok(menu !== undefined, 'an unknown configuration opens the panel with the reason')
  assert.equal(lastLine(menu), 'chip.absent')
  assert.equal(remote.calls.length, 0)
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
  assert.equal(boltOf(tree).props.title.includes('chip.absent'), false, 'the schema identified the namespace')
  switchOf(openPanel(render)).props.onClick()
  await sleep(20)
  assert.equal(remote.calls.length, 1)
  assert.equal(remote.calls[0].ns, 'include:fast-mode')
  assert.equal(remote.calls[0].revision, 9)
})

test('an unsuccessful describe surfaces the error message rather than silence', async () => {
  const remote = fakeRemote()
  remote.settings.describe = async () => ({ ok: false, error: { code: 'remote/closed', message: 'bridge is down' } })
  const { render } = await mount(remote)

  const tree = render()
  assert.equal(boltOf(tree).props.disabled, undefined)
  assert.match(boltOf(tree).props.title, /bridge is down/)
})

test('styles are injected once per page, not once per apply', () => {
  const remote = fakeRemote()
  const { module, styles } = loadClient(remote)
  module.apply(fakeContext(remote))
  assert.equal(styles.length, 1, 'one <style> tag')
  assert.match(styles[0].textContent, /\.fm-chip__button/, 'the chip CSS travels with the bundle')
  assert.match(styles[0].textContent, /\.fm-menu__item/, 'the menu CSS travels with the bundle')
  assert.match(styles[0].textContent, /\.fm-menu__switch/, 'so does the switch inside the panel')
  assert.equal(styles[0].textContent.includes('.fm-chip__caret'), false, 'the caret is gone for good')
  assert.equal(styles[0].dataset.pluginCss, 'dsh-fast-mode/chip.css')
})
