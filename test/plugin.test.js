/**
 * Integration test for the plugin wiring, without a running harness.
 *
 * A fake context captures the handlers the plugin registers, then the test
 * drives them in the order the harness would: a planning request, tool calls,
 * then execution requests. This is what proves the hooks are connected — the
 * policy tests alone would still pass if `apply()` registered nothing.
 *
 * The fake context also exposes an `llm` service, because provider discovery is
 * part of the contract: the plugin must ask which levels the current route
 * declares before it lowers anything, and must do nothing at all when that
 * question cannot be answered.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const SELF_HOSTED = ['off', 'minimal', 'low', 'medium', 'high']
const OFFICIAL = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Minimal stand-in for a Cordis context.
 *
 * @param {{services?: Record<string, unknown>}} [options]
 */
function fakeContext(options = {}) {
  const handlers = new Map()
  const logs = []
  const services = options.services ?? {}
  return {
    handlers,
    logs,
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    // Cordis runs an `inject` callback once the named services exist. The fake
    // only registers the services the test supplied, so a missing service means
    // "not ready yet" and the callback stays unrun — exactly what the real
    // runtime does, which is why the plugin must not call `section()` directly.
    inject(names, callback) {
      if (!names.every(name => services[name])) return undefined
      const child = {
        ...services,
        get(name) {
          return services[name]
        },
        effect(setup) {
          const disposer = setup()
          return typeof disposer === 'function' ? disposer : () => {}
        },
      }
      return callback(child)
    },
    get(name) {
      return services[name]
    },
    logger: { info: (...args) => logs.push(args) },
    fire(event, ...args) {
      const handler = handlers.get(event)
      assert.ok(handler, `no handler registered for ${event}`)
      return handler(...args)
    },
  }
}

/** An `llm` service that answers discovery from a table. */
const llmService = (table, { delayMs = 0, fail = false } = {}) => ({
  resolveModelInfo(provider, model) {
    const answer = () => {
      if (fail) throw new Error('discovery unavailable')
      const entry = table[`${provider}/${model}`]
      if (!entry) throw new Error(`unknown route ${provider}/${model}`)
      return { reasoning: { efforts: entry.efforts.map(id => ({ id })), defaultEffort: entry.default } }
    }
    return delayMs > 0 ? new Promise(resolve => setTimeout(() => resolve(answer()), delayMs)) : Promise.resolve(answer())
  },
})

const agent = { id: 'session-1' }
const accept = async () => ({ kind: 'accept' })
/**
 * Fast mode is opt-in, so every behavioural test arms it explicitly. The
 * measurement and experiment sinks are off here: a test must not append to the
 * developer's home directory, and a live experiment file must not be able to
 * change what a test asserts. Both are covered by their own tests.
 */
const ON = { enabled: true, metrics: false, benchmarkFile: '' }

/** A request whose `next()` resolves to the harness-resolved config. */
const request = (ctx, { step, effort, turn = 0, provider = 'company', model = 'deepseek-v4.1-flash' }) =>
  ctx.fire('agent/request', { agent, turn, step, signal: new AbortController().signal }, async () => ({
    provider,
    model,
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
  apply(ctx, ON)
  for (const event of ['agent/request', 'tools/pre-execute', 'tools/post-execute']) {
    assert.ok(ctx.handlers.has(event), `missing ${event}`)
  }
})

test('a bare composition changes no request: fast mode is opt-in', () => {
  for (const config of [undefined, {}, { gear: 'max' }, { enabled: 'yes' }]) {
    const ctx = fakeContext()
    apply(ctx, { metrics: false, benchmarkFile: '', ...config })
    assert.ok(ctx.handlers.has('agent/request'), 'the pass-through hook is what keeps it switchable')
  }
})

test('enabled:false hands every request back untouched', async () => {
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
  })
  apply(ctx, { enabled: false, metrics: false, benchmarkFile: '' })

  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a.ts' } })
  for (const step of [1, 2, 3]) {
    const resolved = await request(ctx, { step, effort: 'medium' })
    assert.deepEqual(resolved, { provider: 'company', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' })
  }
})

test('the measurement tap outlives the switch: off sessions are measured too', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-fast-mode-metrics-'))
  const file = join(dir, 'metrics.jsonl')
  try {
    const ctx = fakeContext()
    apply(ctx, { enabled: false, benchmarkFile: '', metricsFile: file })
    assert.ok(ctx.handlers.has('session/event'), 'a disabled plugin must still observe: comparison needs the off side')

    const session = { id: 'session-1' }
    const feed = [
      { type: 'step/start', turn: 0, step: 1, time: 1000 },
      { type: 'assistant/message', turn: 0, step: 1, time: 1900, usage: { inputTokens: 120, outputTokens: 40 } },
      { type: 'step/end', turn: 0, step: 1, time: 2000 },
    ]
    await request(ctx, { step: 1, effort: 'high' })
    for (const event of feed) ctx.handlers.get('session/event')(session, event)

    const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].mode, 'off')
    assert.equal(rows[0].gear, 'off')
    assert.equal(rows[0].effort, 'high')
    assert.equal(rows[0].llmMs, 900)
    assert.equal(rows[0].output, 40)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an on request is labelled with the gear and the resolved effort', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-fast-mode-labelled-'))
  const file = join(dir, 'metrics.jsonl')
  try {
    const ctx = fakeContext({
      services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
    })
    apply(ctx, { enabled: true, gear: 'turbo', benchmarkFile: '', metricsFile: file })
    await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a.ts' } })
    await request(ctx, { step: 2, effort: 'medium' })

    const session = { id: 'session-1' }
    for (const event of [
      { type: 'step/start', turn: 0, step: 2, time: 1000 },
      { type: 'tool/call', turn: 0, step: 2, time: 1010, name: 'read' },
      { type: 'assistant/message', turn: 0, step: 2, time: 1800, usage: { inputTokens: 500, outputTokens: 90 } },
      { type: 'step/end', turn: 0, step: 2, time: 1900 },
    ]) ctx.handlers.get('session/event')(session, event)

    const [row] = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(row.mode, 'on')
    assert.equal(row.gear, 'turbo')
    assert.equal(row.calls, 1)
    assert.equal(row.stepMs, 900)
    assert.equal(row.route, 'company/deepseek-v4.1-flash')
    assert.ok(['low', 'medium'].includes(row.effort), 'the label records what the plugin actually resolved')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planning step keeps effort; execution step after clean calls is lowered', async () => {
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
  })
  apply(ctx, ON)

  const planning = await request(ctx, { step: 1, effort: 'medium' })
  assert.equal(planning.reasoningEffort, 'medium', 'step 1 untouched')

  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a.ts' } })
  const execution = await request(ctx, { step: 2, effort: 'medium' })
  assert.equal(execution.reasoningEffort, 'low', 'medium drops one notch to low')
  assert.equal(execution.provider, 'company', 'the rest of the config is preserved')
})

test('a failing tool restores effort on the next step', async () => {
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
  })
  apply(ctx, ON)

  await runTool(ctx, { callId: 'c1', name: 'bash', args: { command: 'false' }, isError: true })
  const after = await request(ctx, { step: 2, effort: 'medium' })
  assert.equal(after.reasoningEffort, 'medium', 'a failure means the next action is not routine')
})

test('tool hooks never alter the tool result', async () => {
  const ctx = fakeContext()
  apply(ctx, ON)
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
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
  })
  apply(ctx, ON)

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
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
  })
  apply(ctx, { metrics: false, benchmarkFile: '', enabled: true, floor: 'minimal' })
  for (let index = 0; index < 8; index += 1) {
    await runTool(ctx, { callId: `c${index}`, name: 'read', args: { path: `f${index}` } })
  }
  const deep = await request(ctx, { step: 9, effort: 'high' })
  assert.equal(deep.reasoningEffort, 'low', 'high minus two notches')
})

test('an unknown effort id is passed through untouched', async () => {
  const ctx = fakeContext({ services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) } })
  apply(ctx, ON)
  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
  const result = await request(ctx, { step: 2, effort: 'turbo' })
  assert.equal(result.reasoningEffort, 'turbo')
})

/* ------------------------------------------------- provider independence */

test('official DeepSeek route gets a real cut, not an alias no-op', async () => {
  const ctx = fakeContext({
    services: { llm: llmService({ 'deepseek/deepseek-flash': { efforts: OFFICIAL, default: 'high' } }) },
  })
  apply(ctx, ON)
  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
  const execution = await request(ctx, {
    step: 2,
    effort: 'high',
    provider: 'deepseek',
    model: 'deepseek-flash',
  })
  assert.equal(execution.reasoningEffort, 'low', 'medium would be a no-op on the wire')
})

test('a route declaring no levels is left untouched', async () => {
  const ctx = fakeContext({
    services: { llm: llmService({ 'deepseek/deepseek-chat': { efforts: [], default: undefined } }) },
  })
  apply(ctx, ON)
  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
  const execution = await request(ctx, { step: 2, effort: 'high', provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(execution.reasoningEffort, 'high', 'no level to cut means no decision')
})

test('when discovery is unavailable the plugin does not guess', async () => {
  // No llm service at all, and a request that still carries an effort. Sending a
  // guessed id would make the harness reject the call before provider I/O, so
  // the only safe action is none.
  const ctx = fakeContext()
  apply(ctx, ON)
  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
  const execution = await request(ctx, { step: 2, effort: 'high' })
  assert.equal(execution.reasoningEffort, 'high')
})

test('a failing discovery call is treated as unknown', async () => {
  const ctx = fakeContext({ services: { llm: llmService({}, { fail: true }) } })
  apply(ctx, ON)
  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
  const execution = await request(ctx, { step: 2, effort: 'high' })
  assert.equal(execution.reasoningEffort, 'high')
})

test('slow discovery never stalls the request, and later steps use the real ladder', async () => {
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }, { delayMs: 60 }) },
  })
  apply(ctx, { metrics: false, benchmarkFile: '', enabled: true, discoverTimeoutMs: 10 })

  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
  const quick = await request(ctx, { step: 2, effort: 'medium' })
  assert.equal(quick.reasoningEffort, 'medium', 'first request must not wait for metadata')

  // The late answer still upgrades the cache, so the plugin does not stay blind.
  await new Promise(resolve => setTimeout(resolve, 90))
  const later = await request(ctx, { step: 3, effort: 'medium' })
  assert.equal(later.reasoningEffort, 'low', 'cached ladder applied on the next request')
})

test('a pinned ladder may be used when discovery is unavailable', async () => {
  const ctx = fakeContext()
  apply(ctx, { metrics: false, benchmarkFile: '', enabled: true, ladder: ['low', 'high'], floor: 'low' })
  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
  const execution = await request(ctx, { step: 2, effort: 'high' })
  assert.equal(execution.reasoningEffort, 'low')
})

test('the route is logged once, proving which ladder was used', async () => {
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
  })
  apply(ctx, ON)
  await request(ctx, { step: 1, effort: 'high' })
  await request(ctx, { step: 2, effort: 'high' })
  const ladderLogs = ctx.logs.filter(args => String(args[0]).includes('ladder='))
  assert.equal(ladderLogs.length, 1, 'logged once per process, not per step')
  assert.match(String(ladderLogs[0].join(' ')), /off>minimal>low>medium>high/)
})

test('a throwing tool payload does not break the request', async () => {
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
  })
  apply(ctx, ON)
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
    const ctx = fakeContext({
      services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
    })
    apply(ctx, { metrics: false, benchmarkFile: '', enabled: true, debug: true, debugFile: file })
    await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
    await request(ctx, { step: 2, effort: 'medium' })
    const lines = readFileSync(file, 'utf8').trim().split('\n')

    // The load trace comes first, so a log that stops there still proves the
    // module ran and says which build and which switch state produced it.
    assert.match(lines[0], /apply v\d+\.\d+\.\d+ entered enabled=true gear=fast parallel=4/)

    const requests = lines.filter(line => / step=/.test(line))
    assert.equal(requests.length, 1, 'one line per request, no per-hook noise')
    assert.match(requests[0], /step=2 gear=fast medium=>low/)
    assert.match(requests[0], /clean=1/)
    assert.match(requests[0], /route=provider/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a disabled plugin still traces the load, and stays silent per request', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-fast-mode-off-'))
  const file = join(dir, 'debug.log')
  try {
    const ctx = fakeContext({
      services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
    })
    apply(ctx, { enabled: false, metrics: false, benchmarkFile: '', debug: true, debugFile: file })
    await request(ctx, { step: 2, effort: 'medium' })

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.match(lines[0], /apply v\d+\.\d+\.\d+ entered enabled=false/)
    assert.equal(lines.filter(line => / step=/.test(line)).length, 0, 'off means off: no per-request trace, no decision')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the traced version is the version the package ships', async () => {
  const { VERSION } = await import('../index.js')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, manifest.version, 'a stale log line must be impossible to mistake for a current build')
})

test('the guidance section is registered once and renders per request', () => {
  const sections = []
  const services = (parallel = 10) => ({
    llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'medium' } }),
    systemPrompt: { section: entry => sections.push(entry) },
    agentLoop: { config: { maxParallelToolCalls: { get: () => parallel } } },
  })
  const context = { scope: { id: 'session-1' } }

  // Safe asks for nothing: the section still exists (the switch must be able to
  // turn it on mid-session) but its text is empty, and the assembler drops
  // empty sections — so the gear costs no tokens.
  const safe = fakeContext({ services: services() })
  apply(safe, { enabled: true, gear: 'safe', metrics: false, benchmarkFile: '' })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'fast-mode:execution-speed')
  assert.equal(typeof sections[0].order, 'number')
  assert.equal(sections[0].text(context), '')

  const fast = fakeContext({ services: services() })
  apply(fast, { enabled: true, gear: 2, metrics: false, benchmarkFile: '' })
  const text = sections[1].text(context)
  assert.match(text, /up to 4 independent calls/)
  assert.match(text, /never report a result you have not received/)

  // The fan-out number is configurable, and the text follows it.
  const custom = fakeContext({ services: services() })
  apply(custom, { enabled: true, gear: 3, parallel: 7, metrics: false, benchmarkFile: '' })
  assert.match(sections[2].text(context), /up to 7 independent calls/)

  // Switched off, the section renders to nothing — an off plugin adds no prompt.
  const off = fakeContext({ services: services() })
  apply(off, { enabled: false, metrics: false, benchmarkFile: '' })
  assert.equal(sections[3].text(context), '')
})

test('a scheduler cap below the gear warns once, and never breaks the request', async () => {
  const warnings = []
  const ctx = fakeContext({
    services: {
      llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'medium' } }),
      systemPrompt: { section: () => {} },
      agentLoop: { config: { maxParallelToolCalls: { get: () => 3 } } },
    },
  })
  ctx.logger.warn = (...args) => warnings.push(args)
  apply(ctx, { metrics: false, benchmarkFile: '', enabled: true, gear: 2 })

  await request(ctx, { step: 2, effort: 'high' })
  await request(ctx, { step: 3, effort: 'high' })
  const mine = warnings.filter(args => String(args[0]).includes('maxParallelToolCalls=%d'))
  assert.equal(mine.length, 1)
  assert.equal(mine[0][3], 4)
  assert.equal(mine[0][4], 3)
})

test('the manifest ships everything a plugin manager reads before activation', async () => {
  const root = new URL('..', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

  // The bundle entry point and its patch must exist and be listed for packing.
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(await stat(new URL('cordis.patch.yml', root)))
  for (const required of ['index.js', 'src/', 'cordis.patch.yml', 'icon.png', 'locale/*.json']) {
    assert.ok(manifest.files.includes(required), `files[] must list ${required}`)
  }

  // Display metadata: an icon inside the package, under the documented cap, and
  // localised title/description for both shipped locales.
  assert.equal(manifest.icon, './icon.png')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  const icon = await readFile(new URL('icon.png', root))
  assert.ok(icon.length <= 256 * 1024, `icon.png is ${icon.length} bytes, cap is 262144`)
  assert.deepEqual([...icon.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'icon must really be a PNG')

  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(await readFile(new URL(`locale/${locale}.json`, root), 'utf8')).meta
    assert.ok(meta.title.length > 1, `${locale}.meta.title is missing`)
    assert.ok(meta.description.length > 20, `${locale}.meta.description is missing`)
  }

  // The client half: the composer chip. A package that declares `dsh.client`
  // must also export './client', the file must be packed, and the bundle must be
  // in the loader's own format with this package's id.
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  for (const service of ['slots', 'locale', 'remote', 'remote.settings']) {
    assert.ok(manifest.dsh.client.inject.includes(service), `client must inject ${service}`)
  }
  assert.equal(manifest.exports['./client'], './client.js')
  assert.ok(manifest.files.includes('client.js'), 'client.js must be packed')
  const client = await readFile(new URL('client.js', root), 'utf8')
  assert.match(client, /__ModuleLoader__\.load\(/)
  assert.match(client, /id: 'dsh-fast-mode'/)
  assert.match(client, /const SLOT = 'conversation\.input\.activity'/)
  assert.doesNotMatch(client, /const SLOT = 'conversation\.input\.model'/, 'never shadow the shipped model selector')
})

test('an experiment assignment picks the gear and turns the mode on by itself', async () => {
  // The assignment, not the user, decides the arm — so it must not depend on a
  // switch that the user could forget to click, or a forgotten click would
  // silently land the session in the control arm.
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'medium' } }) },
  })
  const bench = join(await mkdtemp(join(tmpdir(), 'dsh-fast-mode-assign-')), 'bench.json')
  try {
    await writeFile(bench, JSON.stringify({ enabled: true, gears: ['turbo'] }))
    apply(ctx, { metrics: false, benchmarkFile: bench, enabled: false, gear: 'safe' })

    const handler = ctx.handlers.get('agent/request')
    const resolved = { provider: 'company', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' }
    const payload = { agent: { id: 'session-assigned' }, turn: 0, step: 2, signal: new AbortController().signal }
    const out = await handler(payload, async () => resolved)
    assert.notEqual(out, resolved, 'an assignment is an experiment: it cannot leave the request untouched')
    assert.notEqual(out.reasoningEffort, 'medium', 'the assigned gear must reach the request')

    // With the experiment stopped, the configured switch and gear win again.
    await rm(bench)
    const off = fakeContext({
      services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'medium' } }) },
    })
    apply(off, { metrics: false, benchmarkFile: bench, enabled: false, gear: 'safe' })
    const untouched = { provider: 'company', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' }
    assert.equal(await off.handlers.get('agent/request')(payload, async () => untouched), untouched)
  } finally {
    await rm(bench, { force: true })
    await rm(dirname(bench), { recursive: true, force: true })
  }
})

test('a session assigned to the control arm runs switched off, not accelerated', async () => {
  // The baseline has to be an assignment too. If the control arm were "whatever
  // the switch happens to be", the trial would silently lose its comparison.
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
  })
  const bench = join(await mkdtemp(join(tmpdir(), 'dsh-fast-mode-control-')), 'bench.json')
  try {
    await writeFile(bench, JSON.stringify({ enabled: true, gears: ['off'] }))
    apply(ctx, { metrics: false, benchmarkFile: bench, enabled: true, gear: 'turbo' })

    const resolved = { provider: 'company', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }
    const payload = { agent: { id: 'session-control' }, turn: 0, step: 4, signal: new AbortController().signal }
    assert.equal(
      await ctx.handlers.get('agent/request')(payload, async () => resolved),
      resolved,
      'the control arm is untouched even though the plugin is switched on globally',
    )
  } finally {
    await rm(bench, { force: true })
    await rm(dirname(bench), { recursive: true, force: true })
  }
})

test('two conversations, one settings column: each runs at its own entry', async () => {
  // The point of the per-session column: flipping the switch in one conversation
  // must not silently change what a conversation running next to it does. The
  // shared `enabled` / `gear` stay the default ("last choice"), and an entry is
  // the only thing that outranks it.
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
  })
  apply(ctx, {
    enabled: true,
    gear: 'max',
    metrics: false,
    benchmarkFile: '',
    sessions: JSON.stringify({
      'session-quiet': { enabled: false },
      'session-turbo': { enabled: true, gear: 'turbo' },
    }),
  })

  const handler = ctx.handlers.get('agent/request')
  const run = (id, effort = 'high') => {
    const resolved = { provider: 'company', model: 'deepseek-v4.1-flash', reasoningEffort: effort }
    const payload = { agent: { id }, turn: 0, step: 2, signal: new AbortController().signal }
    return handler(payload, async () => resolved).then(out => ({ out, resolved }))
  }

  const quiet = await run('session-quiet')
  assert.equal(quiet.out, quiet.resolved, 'a conversation that turned the mode off is handed back untouched')

  const turbo = await run('session-turbo')
  assert.notEqual(turbo.out, turbo.resolved, 'the conversation that pinned a gear is accelerated')
  assert.notEqual(turbo.out.reasoningEffort, 'high', 'and its gear reached the request')

  // A conversation with no entry inherits the shared pair, which is what a fresh
  // session starts from: the last choice made anywhere.
  const fresh = await run('session-never-seen')
  assert.notEqual(fresh.out, fresh.resolved, 'a fresh conversation inherits the shared switch')

  // An entry is authoritative for its conversation and inapplicable to the
  // others: the quiet one stays quiet even though the shared default is on.
  const quietAgain = await run('session-quiet')
  assert.equal(quietAgain.out, quietAgain.resolved)
})
