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
  return { bundle, module, styles }
}

/**
 * A settings remote backed by one mutable namespace, which is what the host is:
 * `update` merges into the user layer and bumps the revision.
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
          writable,
          hasDocument: true,
          namespaces: [{ ns: 'fast-mode', autoGenerate: true, schema: {}, value: { ...state.value }, applies: 'live', secrets: [], revision: state.revision }],
        }
      },
      async update(ns, patch, revision) {
        calls.push({ ns, patch, revision })
        if (fail) throw new Error('revision conflict')
        assert.equal(ns, 'fast-mode')
        state.value = { ...state.value, ...patch }
        state.revision += 1
        return { revision: state.revision }
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
  assert.ok(ctx.labels[0].dict.zh.chip && ctx.labels[0].dict.en.chip, 'both languages are shipped inline')
})

test('the chip starts hollow and a click writes enabled:true with the revision it read', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'turbo' })
  const ctx = fakeContext(remote)
  const { module } = loadClient(remote)
  module.apply(ctx)
  await sleep(5)

  const { component, options } = ctx.registered[0]
  const t = (key, params) => JSON.stringify({ key, params })
  const tree = component({ t, ...options.inject() })
  const button = tree.children[0]

  assert.equal(button.props['data-on'], 'false', 'off is hollow')
  assert.equal(button.props['aria-pressed'], false)
  assert.equal(button.props.disabled, false)
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

  const after = component({ t, ...options.inject() })
  const onButton = after.children[0]
  assert.equal(onButton.props['data-on'], 'true', 'on is filled')
  assert.equal(onButton.children[0].children[0].props.fill, 'currentColor')
  assert.match(onButton.props.title, /titleOn/)
})

test('a second click turns it back off, still echoing the current revision', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'fast' })
  const ctx = fakeContext(remote)
  const { module } = loadClient(remote)
  module.apply(ctx)
  await sleep(5)

  const { component, options } = ctx.registered[0]
  const t = (key) => key
  const tree = component({ t, ...options.inject() })
  assert.equal(tree.children[0].props['data-on'], 'true')

  tree.children[0].props.onClick()
  await sleep(10)

  assert.equal(remote.calls[0].ns, 'fast-mode')
  assert.equal(remote.calls[0].patch.enabled, false)
  assert.equal(remote.calls[0].revision, 3)
  assert.equal(component({ t, ...options.inject() }).children[0].props['data-on'], 'false')
})

test('a refused write reverts the chip and explains itself in the tooltip', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'fast' }, { fail: true })
  const ctx = fakeContext(remote)
  const { module } = loadClient(remote)
  module.apply(ctx)
  await sleep(5)

  const { component, options } = ctx.registered[0]
  const t = (key, params) => JSON.stringify({ key, params })
  const tree = component({ t, ...options.inject() })
  tree.children[0].props.onClick()
  await sleep(20)

  const after = component({ t, ...options.inject() })
  assert.equal(after.children[0].props['data-on'], 'false', 'the optimistic paint must roll back')
  assert.match(after.children[0].props.title, /error/, 'the tooltip reports the failure')
  assert.match(after.children[0].props.title, /revision conflict/)
})

test('a read-only layer renders a disabled chip instead of pretending to toggle', async () => {
  const remote = fakeRemote({ enabled: false, gear: 'fast' }, { writable: false })
  const ctx = fakeContext(remote)
  const { module } = loadClient(remote)
  module.apply(ctx)
  await sleep(5)

  const { component, options } = ctx.registered[0]
  const tree = component({ t: (key) => key, ...options.inject() })
  assert.equal(tree.children[0].props.disabled, true)
  assert.equal(tree.children[0].props.title, 'chip.readonly')
  tree.children[0].props.onClick()
  await sleep(10)
  assert.equal(remote.calls.length, 0, 'a read-only chip must never write')
})

test('a composition without this entry renders a disabled chip and never throws', async () => {
  const remote = fakeRemote()
  remote.settings.describe = async () => ({ writable: true, hasDocument: true, namespaces: [] })
  const ctx = fakeContext(remote)
  const { module } = loadClient(remote)
  module.apply(ctx)
  await sleep(5)

  const { component, options } = ctx.registered[0]
  const tree = component({ t: (key) => key, ...options.inject() })
  assert.equal(tree.children[0].props.disabled, true, 'not configured is not the same as on')
  assert.equal(tree.children[0].props['data-on'], 'false')
})

test('styles are injected once per page, not once per apply', () => {
  const remote = fakeRemote()
  const { module, styles } = loadClient(remote)
  module.apply(fakeContext(remote))
  assert.equal(styles.length, 1, 'one <style> tag')
  assert.match(styles[0].textContent, /\.fm-chip__button/, 'the chip CSS travels with the bundle')
  assert.equal(styles[0].dataset.pluginCss, 'dsh-fast-mode/chip.css')
})
