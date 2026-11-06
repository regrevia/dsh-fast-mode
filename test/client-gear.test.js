/**
 * The two things the panel learned that this half cannot get from its own
 * settings column: the three-way tier control on the title row, and the footer
 * that reports the conversation's real steps and output.
 *
 * Same sandbox as `client.test.js` (the bundle is executed as shipped, with a
 * fake `react` that returns data), plus a fake `sessions` service so the footer
 * path is exercised against the projection shape the session controller really
 * hands out: `projectionValues(id)` -> `{ sessionStats: { steps }, tokenUsage:
 * { outputTokens } }`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (effect) => { effect() },
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function loadClient() {
  const loaded = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (bundle) => loaded.push(bundle) },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
      head: { appendChild: () => {} },
    },
    setTimeout,
    clearTimeout,
    console,
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.equal(loaded.length, 1)
  return loaded[0].factory((name) => {
    assert.equal(name, 'react', 'the bundle may only require react')
    return react
  })
}

function fakeRemote(initial = { enabled: true, gear: 'auto' }) {
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
            writable: true,
            hasDocument: true,
            namespaces: [{ ns: 'fast-mode', autoGenerate: true, schema: {}, value: { ...state.value }, applies: 'live', secrets: [], revision: state.revision }],
          },
        }
      },
      async update(ns, patch, revision) {
        calls.push({ ns, patch, revision })
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

/**
 * A context with the sessions service:
 * `values` is what `projectionValues` answers for any id it is asked about,
 * `subscribe` records its listener so a test can push an update through it.
 */
function fakeContext(remote, { sessions } = {}) {
  const registered = []
  const labels = []
  const disposes = []
  const listeners = []
  let disposed = false
  const injectors = []
  const ctx = {
    registered,
    labels,
    listeners,
    get disposed() { return disposed },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { warn: () => {}, info: () => {} },
    locale: {
      register: (ns, dict) => { labels.push({ ns, dict }); return () => {} },
      bind: (ns) => (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`),
    },
    slots: {
      inject(key, callback) { callback() },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
    remote,
  }
  if (sessions) {
    ctx.inject = (names, callback) => {
      injectors.push(names)
      callback({
        sessions,
        on(name, fn) { if (name === 'dispose') disposes.push(fn) },
      })
    }
  }
  ctx.dispose = () => {
    disposed = true
    for (const fn of disposes) fn()
  }
  return ctx
}

function fakeSessions(values) {
  const listeners = []
  const api = {
    values,
    listeners,
    projectionValues: () => api.values,
    subscribe(listener) { listeners.push(listener); return () => { listeners.splice(listeners.indexOf(listener), 1) } },
  }
  return api
}

async function mount(remote, sessionId = 'session-alpha', options = {}) {
  const ctx = fakeContext(remote, options)
  const module = loadClient()
  module.apply(ctx)
  await sleep(5)
  const { component, options: registration } = ctx.registered[0]
  const t = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
  const render = (extra = {}) => component({ t, ...registration.inject(sessionId), ...extra })
  render()
  await sleep(10)
  return { ctx, module, render, t }
}

const boltOf = tree => tree.children[0]
const panelOf = tree => tree.children[1]

async function openPanel(render) {
  let tree = render()
  if (!panelOf(tree)) {
    boltOf(tree).props.onContextMenu({ preventDefault() {} })
    await sleep(10)
    tree = render()
  }
  return panelOf(tree)
}

const titleRowOf = panel => panel.children[0]
// `map` is handed to `createElement` as one child, which real react walks;
// flatten it so a test can address a tier by index.
const gearOf = (panel) => {
  const group = titleRowOf(panel).children[1]
  return { ...group, children: group.children.flat() }
}
const footerOf = panel => panel.children[panel.children.length - 1]

const checkedOf = (control) => control.children.find(node => node.props['aria-checked'] === true)?.props.key

/* ------------------------------------------------------------- three tiers */

test('the title row keeps its words and grows a radiogroup of exactly two tiers', async () => {
  const { render } = await mount(fakeRemote({ enabled: true, gear: 'auto' }))
  const row = titleRowOf(await openPanel(render))

  assert.equal(row.children.length, 2, 'heading plus the control, nothing else')
  assert.equal(row.children[0].props.className, 'fm-panel__heading')
  assert.equal(row.children[0].children[0], 'panel.title', 'the frozen title text is untouched')

  const gear = gearOf(await openPanel(render))
  assert.equal(gear.props.role, 'radiogroup')
  assert.equal(gear.props['aria-label'], 'panel.gear')
  assert.equal(gear.props.title, 'panel.gearTitle', 'the group explains what the tiers do')
  assert.equal(gear.children.length, 2, 'two tiers only: every offered tier is proven')
  for (const button of gear.children) {
    assert.equal(button.props.role, 'radio')
    assert.equal(button.props.type, 'button', 'a plain button, so Enter and Space both work')
    assert.equal(button.props.className, 'fm-panel__gear')
  }
})

test('the four frozen rows keep their labels and their order', async () => {
  const { render } = await mount(fakeRemote())
  const panel = await openPanel(render)
  const labels = panel.children.slice(1, -1).map(node => node.children[0].children[0])
  assert.deepEqual(labels, ['panel.prose', 'panel.probe', 'panel.act', 'panel.repeat'],
    'only switches with paired evidence behind them are offered')
})

test('the cautious tier greys the prose row instead of leaving a dead switch', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'safe' })
  const { render } = await mount(remote)
  const panel = await openPanel(render)
  const rows = panel.children.slice(1, -1)
  assert.equal(rows.length, 4)

  for (const row of rows) {
    assert.equal(row.props.disabled, true, 'a gated row refuses the click instead of writing nothing')
    assert.equal(row.children[1].children[0], 'panel.off', 'and reads off, because the tier resolves the field off')
  }
  assert.equal(remote.calls.length, 0, 'rendering the gated state writes nothing')
})

test('leaving the cautious tier brings the gated rows back', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'safe' })
  const { render } = await mount(remote)
  const gear = gearOf(await openPanel(render))
  gear.children[1].props.onClick()
  await sleep(20)

  const rows = (await openPanel(render)).children.slice(1, -1)
  for (const row of rows) assert.equal(row.props.disabled, false, 'every row is live again')
  assert.equal(rows[0].children[1].children[0], 'panel.on')
  assert.equal(rows[1].children[1].children[0], 'panel.on', 'the standard preset carried the deliberation switches too')
})

test('a row that matches a tier highlights it, and a retired name with a custom row does not', async () => {
  const trio = { probeFirst: true, actBeforePlan: true, repeatNudge: true }
  // 1.7.32 made the two prompt-side hints part of the standard tier, so a row
  // that matches it now carries them as well.
  const standard = { outputDiscipline: 'late', workspaceMap: true, openBatch: true, ...trio }
  const cautious = { outputDiscipline: false, map: false, batch: false, compactResults: false, probeFirst: false, actBeforePlan: false, repeatNudge: false }
  const legacy = { outputDiscipline: true, workspaceMap: true, openBatch: true, compactResults: true, ...trio }
  const cases = [
    ['safe', cautious, 'safe'],
    ['auto', standard, 'auto'],
    ['fast', legacy, undefined],
    ['aggressive', legacy, undefined],
    ['turbo', standard, 'auto'],
    ['max', standard, 'auto'],
    ['ludicrous', standard, 'auto'],
    ['nonsense', standard, 'auto'],
    [undefined, standard, 'auto'],
  ]
  for (const [stored, switches, tier] of cases) {
    const { render } = await mount(fakeRemote({ enabled: true, gear: stored, ...switches }))
    const gear = gearOf(await openPanel(render))
    assert.equal(checkedOf(gear), tier, `${String(stored)} with those switches reads as ${String(tier)}`)
    assert.equal(gear.children.filter(button => button.props['aria-checked'] === true).length, tier ? 1 : 0, 'at most one tier is checked')
  }
})

test('a bare gear name over switches the tier does not own highlights nothing', async () => {
  // The reported bug reached this shape: 激进 pressed, then one switch turned
  // back off by hand. The stored gear still says aggressive, but no preset
  // describes the row, so no tier may claim it.
  const cases = [
    { gear: 'aggressive' },
    { gear: 'aggressive', outputDiscipline: true, workspaceMap: true, openBatch: true },
    { gear: 'auto', compactResults: true, probeFirst: true, actBeforePlan: true, repeatNudge: true },
    { gear: 'auto', probeFirst: true, actBeforePlan: true },
  ]
  for (const stored of cases) {
    const { render } = await mount(fakeRemote({ enabled: true, ...stored }))
    const gear = gearOf(await openPanel(render))
    assert.equal(checkedOf(gear), undefined, `${JSON.stringify(stored)} is a custom row`)
    assert.equal(gear.children.filter(button => button.props['aria-checked'] === true).length, 0)
  }
})

test('a tier click loads that tier into this conversation, at the revision it read', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'auto' })
  const { render } = await mount(remote, 'session-alpha')
  const gear = gearOf(await openPanel(render))

  gear.children[0].props.onClick()
  await sleep(20)

  assert.equal(remote.calls.length, 1)
  assert.equal(remote.calls[0].ns, 'fast-mode')
  assert.deepEqual(Object.keys(remote.calls[0].patch), ['sessions'], 'nothing shared is written')
  const entry = JSON.parse(remote.calls[0].patch.sessions)['session-alpha']
  assert.equal(entry.gear, 'safe')
  assert.equal(entry.discipline, false, 'the cautious tier turns the prose rule off with the rest')
  assert.equal(entry.map, false)
  assert.equal(entry.batch, false)
  assert.equal(entry.compactResults, false)
  assert.equal(entry.probeFirst, false, 'the cautious tier turns deliberation off too')
  assert.equal(entry.actBeforePlan, false)
  assert.equal(entry.repeatNudge, false)
  assert.equal(entry.enabled, undefined, 'the bolt is a separate switch')
  assert.equal(entry.stepBudget, undefined, 'a preset never touches the step cap')
  assert.equal(remote.calls[0].revision, 3)

  const after = gearOf(await openPanel(render))
  assert.equal(checkedOf(after), 'safe', 'the panel shows the new tier after the echo')
})

test('the standard tier turns the prose rule and three deliberation switches on in the same click', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'safe' })
  const { render } = await mount(remote)
  let rows = (await openPanel(render)).children.slice(1, -1)
  assert.deepEqual(rows.map(row => row.children[1].children[0]), ['panel.off', 'panel.off', 'panel.off', 'panel.off'])

  const gear = gearOf(await openPanel(render))
  gear.children[1].props.onClick()
  await sleep(20)

  const entry = JSON.parse(remote.calls[0].patch.sessions)['session-alpha']
  const { ts, ...preset } = entry
  assert.equal(typeof ts, 'number', 'the row is stamped like every other write')
  assert.deepEqual(preset, {
    gear: 'auto',
    discipline: 'late',
    map: true,
    batch: true,
    compactResults: false,
    probeFirst: true,
    actBeforePlan: true,
    repeatNudge: true,
  }, 'one patch carries the whole preset, and no falsified switch rides along')
  rows = (await openPanel(render)).children.slice(1, -1)
  assert.deepEqual(rows.map(row => row.children[1].children[0]), ['panel.on', 'panel.on', 'panel.on', 'panel.on'])
})

test('clicking the tier this conversation already matches writes nothing', async () => {
  const remote = fakeRemote({
    enabled: true,
    gear: 'auto',
    outputDiscipline: 'late',
    workspaceMap: true,
    openBatch: true,
    probeFirst: true,
    actBeforePlan: true,
    repeatNudge: true,
  })
  const { render } = await mount(remote)
  const gear = gearOf(await openPanel(render))
  assert.equal(checkedOf(gear), 'auto')
  gear.children[1].props.onClick()
  await sleep(20)
  assert.equal(remote.calls.length, 0)
})

test('editing one switch by hand drops the tier highlight instead of leaving a stale label', async () => {
  const remote = fakeRemote({
    enabled: true,
    gear: 'auto',
    outputDiscipline: true,
    workspaceMap: true,
    openBatch: true,
    compactResults: false,
    probeFirst: true,
    actBeforePlan: true,
    repeatNudge: true,
  })
  const { render } = await mount(remote)
  let gear = gearOf(await openPanel(render))
  assert.equal(checkedOf(gear), 'auto')

  const rows = (await openPanel(render)).children.slice(1, -1)
  rows[3].props.onClick()
  await sleep(20)
  const entry = JSON.parse(remote.calls[0].patch.sessions)['session-alpha']
  assert.equal(entry.repeatNudge, false)
  assert.equal(entry.gear, undefined, 'the hand edit is one switch, not a tier load')

  gear = gearOf(await openPanel(render))
  assert.equal(checkedOf(gear), undefined, 'no tier claims to describe this row set')
  for (const button of gear.children) {
    assert.equal(button.props['aria-checked'], false)
  }
  assert.equal(gear.children[1].props.tabIndex, 0, 'the group still has one tab stop')
})

test('arrow keys move between tiers and wrap; the checked one holds the tab stop', async () => {
  const remote = fakeRemote({ enabled: true, gear: 'auto' })
  const { render } = await mount(remote, 'session-alpha')
  let gear = gearOf(await openPanel(render))

  assert.equal(gear.children[1].props.tabIndex, 0)
  assert.equal(gear.children[0].props.tabIndex, -1, 'roving tabindex: one stop for the whole group')

  gear.children[1].props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  await sleep(20)
  assert.equal(JSON.parse(remote.calls[0].patch.sessions)['session-alpha'].gear, 'safe', 'right wraps past the last tier')

  gear = gearOf(await openPanel(render))
  gear.children[0].props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} })
  await sleep(20)
  assert.equal(JSON.parse(remote.calls[1].patch.sessions)['session-alpha'].gear, 'auto', 'left wraps past the first tier')

  gear = gearOf(await openPanel(render))
  gear.children[1].props.onKeyDown({ key: 'ArrowUp', preventDefault() {} })
  await sleep(20)
  assert.equal(JSON.parse(remote.calls[2].patch.sessions)['session-alpha'].gear, 'safe')
})

test('a readonly configuration disables the tiers instead of swallowing the click', async () => {
  const remote = fakeRemote()
  const describe = remote.settings.describe
  remote.settings.describe = async () => {
    const answer = await describe()
    answer.value.writable = false
    return answer
  }
  const { render } = await mount(remote)
  const gear = gearOf(await openPanel(render))
  for (const button of gear.children) assert.equal(button.props.disabled, true)
})

/* ------------------------------------------------------------------ footer */

test('without the sessions service the footer keeps its scope line and says why', async () => {
  const { render } = await mount(fakeRemote())
  const footer = footerOf(await openPanel(render))
  assert.equal(footer.props.className, 'fm-panel__scope')
  assert.equal(footer.props.title, 'panel.scopeTitle', 'the tooltip explains the silence')
  assert.equal(footer.children[0], 'panel.scope', 'the shipped line survives')
  assert.equal(/\d/.test(String(footer.children[0])), false, 'no number is invented')
})

test('with the projections the footer reports the real steps and output', async () => {
  const sessions = fakeSessions({ sessionStats: { steps: 12 }, tokenUsage: { outputTokens: 3218 } })
  const { render } = await mount(fakeRemote(), 'session-alpha', { sessions })
  const footer = footerOf(await openPanel(render))

  assert.equal(footer.children[0], 'panel.saved {"steps":"12","tokens":"3.2k"}', 'compact numbers')
  assert.equal(footer.props.title, 'panel.saved {"steps":"12","tokens":"3218"}', 'the exact count rides in the tooltip')
  assert.equal(/只影响本会话/.test(String(footer.children[0])), false)
})

test('a missing projection is omitted, never rendered as zero', async () => {
  const stepsOnly = fakeSessions({ sessionStats: { steps: 7 } })
  const first = await mount(fakeRemote(), 'session-alpha', { sessions: stepsOnly })
  let footer = footerOf(await openPanel(first.render))
  assert.equal(footer.children[0], 'panel.savedSteps {"steps":"7"}', 'steps alone')
  assert.equal(/0/.test(footer.children[0]), false)

  const tokensOnly = fakeSessions({ tokenUsage: { outputTokens: 1200 } })
  const second = await mount(fakeRemote(), 'session-alpha', { sessions: tokensOnly })
  footer = footerOf(await openPanel(second.render))
  assert.equal(footer.children[0], 'panel.savedTokens {"tokens":"1.2k"}', 'output alone')

  const empty = fakeSessions({})
  const third = await mount(fakeRemote(), 'session-alpha', { sessions: empty })
  footer = footerOf(await openPanel(third.render))
  assert.equal(footer.children[0], 'panel.scope', 'nothing to report keeps the scope line')
})

test('a projection push repaints the footer, and dispose unhooks it', async () => {
  const sessions = fakeSessions({ sessionStats: { steps: 2 }, tokenUsage: { outputTokens: 40 } })
  const { render, ctx } = await mount(fakeRemote(), 'session-alpha', { sessions })
  assert.equal(footerOf(await openPanel(render)).children[0], 'panel.saved {"steps":"2","tokens":"40"}')
  assert.equal(sessions.listeners.length, 1, 'one subscription for the whole panel')

  sessions.values = { sessionStats: { steps: 9 }, tokenUsage: { outputTokens: 20480 } }
  sessions.listeners[0]()
  assert.equal(footerOf(await openPanel(render)).children[0], 'panel.saved {"steps":"9","tokens":"20.5k"}')

  ctx.dispose()
  assert.equal(sessions.listeners.length, 0, 'the listener goes with the plugin')
  assert.equal(footerOf(await openPanel(render)).children[0], 'panel.scope', 'and the footer falls back')
})

test('a throwing projection does not take the panel down', async () => {
  const sessions = fakeSessions({})
  sessions.projectionValues = () => { throw new Error('not mounted') }
  const { render } = await mount(fakeRemote(), 'session-alpha', { sessions })
  const footer = footerOf(await openPanel(render))
  assert.equal(footer.children[0], 'panel.scope')
})

test('the copy offers no benefit percentage anywhere, only counts', async () => {
  const { ctx } = await mount(fakeRemote())
  const dict = ctx.labels[0].dict
  const text = JSON.stringify(dict)
  assert.equal(/[×x]\s*\d|\d+\s*%|快\s*\d|省\s*\d/.test(text), false, 'no multiplier and no percentage claim')
  assert.match(dict.zh['panel.saved'], /\{steps\}.*\{tokens\}/, 'the compact line is two counts')
  assert.match(dict.en['panel.saved'], /\{steps\}.*\{tokens\}/)
})
