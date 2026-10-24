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
    apply(ctx, { enabled: true, gear: 'auto', benchmarkFile: '', metricsFile: file })
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
    assert.equal(row.gear, 'auto')
    assert.equal(row.calls, 1)
    assert.equal(row.stepMs, 900)
    assert.equal(row.route, 'company/deepseek-v4.1-flash')
    assert.equal(row.effort, 'medium', 'the label records the effort that was actually sent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the effort the user chose survives every step, error, and turn', async () => {
  // Regression for the 0.9.x defect: the plugin lowered `reasoningEffort` from
  // step 2 onwards, the rewrite reached the provider as a request header, and the
  // composer capsule (which projects "last used effort") drifted from the user's
  // Medium to Low and stayed there after a restart. Fast mode must not touch it.
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
  })
  apply(ctx, ON)

  const chosen = { provider: 'company', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' }
  for (const step of [1, 2, 3, 4]) {
    const resolved = await request(ctx, { step, effort: 'medium' })
    assert.deepEqual(resolved, chosen, `step ${step} must carry the chosen effort unchanged`)
    await runTool(ctx, { callId: `c${step}`, name: 'read', args: { path: `f${step}` } })
  }

  // A failure and a new turn change what the scheduler does, never the effort.
  await runTool(ctx, { callId: 'boom', name: 'bash', args: {}, isError: true })
  assert.deepEqual(await request(ctx, { step: 5, effort: 'medium' }), chosen)
  assert.deepEqual(await request(ctx, { step: 1, turn: 1, effort: 'high' }), { ...chosen, reasoningEffort: 'high' })

  // A route with no declared levels, an unknown id, and no llm service at all.
  assert.deepEqual(await request(ctx, { step: 6, effort: 'turbo' }), { ...chosen, reasoningEffort: 'turbo' })
})

test('an old gear id in the patch becomes the scheduler, not a pinned ladder', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-fast-mode-legacy-'))
  const file = join(dir, 'metrics.jsonl')
  try {
    const ctx = fakeContext({
      services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
    })
    const debugFile = file.replace('metrics', 'debug')
    apply(ctx, {
      enabled: true,
      gear: 'turbo',
      debug: true,
      debugFile,
      benchmarkFile: '',
      metricsFile: file,
    })

    const session = { id: 'session-legacy' }
    const resolved = { provider: 'company', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' }
    const payload = { agent: session, turn: 0, step: 2, signal: new AbortController().signal }
    assert.equal(await ctx.handlers.get('agent/request')(payload, async () => resolved), resolved)
    for (const event of [
      { type: 'step/start', turn: 0, step: 2, time: 1000 },
      { type: 'assistant/message', turn: 0, step: 2, time: 1800, usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'step/end', turn: 0, step: 2, time: 1900 },
    ]) ctx.handlers.get('session/event')(session, event)

    const [row] = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(row.gear, 'auto', 'the retired name is not honoured as a width/effort pair')
    assert.equal(row.effort, 'medium', 'and the effort is the one that was asked for')
    assert.match(
      readFileSync(debugFile, 'utf8'),
      /legacyGear=turbo resolved=auto/,
      'the load trace names the retired id so the operator can clean the patch up',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
  assert.equal(after.reasoningEffort, 'medium', 'request still resolves, effort untouched')
})

test('debug writes one line per request with the schedule', async () => {
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
    assert.match(lines[0], /apply v\d+\.\d+\.\d+ entered enabled=true gear=auto parallel=4/)

    const requests = lines.filter(line => / step=/.test(line))
    assert.equal(requests.length, 1, 'one line per request, no per-hook noise')
    assert.match(requests[0], /step=2 gear=auto effort=medium \(unchanged\)/)
    assert.match(requests[0], /parallel=1/)
    assert.match(requests[0], /route=company\/deepseek-v4\.1-flash/)
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

  // The fan-out number is configurable, and the text follows it. A pinned
  // session arm is how a fixed width is expressed now that a patch gear means
  // "run the scheduler".
  const custom = fakeContext({ services: services() })
  apply(custom, {
    enabled: true,
    parallel: 7,
    sessions: JSON.stringify({ 'session-1': { enabled: true, gear: 'max' } }),
    metrics: false,
    benchmarkFile: '',
  })
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
  // The assignment, not the user, decides the arm — and the arm is only a width
  // and a ceiling now. The request object must come back identical in every arm:
  // an experiment is allowed to change how much work one step may carry, never
  // what the model was asked to think about.
  const sections = []
  const services = () => ({
    llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'medium' } }),
    systemPrompt: { section: entry => sections.push(entry) },
    agentLoop: { config: { maxParallelToolCalls: { get: () => 16 } } },
  })
  const context = { scope: { id: 'session-assigned' } }
  const bench = join(await mkdtemp(join(tmpdir(), 'dsh-fast-mode-assign-')), 'bench.json')
  try {
    await writeFile(bench, JSON.stringify({ enabled: true, gears: ['turbo'] }))
    const ctx = fakeContext({ services: services() })
    apply(ctx, { metrics: false, benchmarkFile: bench, enabled: false, gear: 'safe' })

    const resolved = { provider: 'company', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' }
    const payload = { agent: { id: 'session-assigned' }, turn: 0, step: 2, signal: new AbortController().signal }
    const out = await ctx.handlers.get('agent/request')(payload, async () => resolved)
    assert.equal(out, resolved, 'no arm may rewrite the request')
    assert.match(sections.at(-1).text(context), /up to 6 independent calls/, 'the arm reaches the prompt, not the effort')

    // With the experiment stopped, the configured switch wins again: off stays off.
    await rm(bench)
    const off = fakeContext({ services: services() })
    apply(off, { metrics: false, benchmarkFile: bench, enabled: false, gear: 'safe' })
    const untouched = { provider: 'company', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' }
    assert.equal(
      await off.handlers.get('agent/request')(payload, async () => untouched),
      untouched,
      'without an assignment the switch decides',
    )
  } finally {
    await rm(bench, { force: true })
    await rm(dirname(bench), { recursive: true, force: true })
  }
})

test('a session assigned to the control arm runs switched off, not accelerated', async () => {
  // The baseline has to be an assignment too. If the control arm were "whatever
  // the switch happens to be", the trial would silently lose its comparison.
  const sections = []
  const ctx = fakeContext({
    services: {
      llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }),
      systemPrompt: { section: entry => sections.push(entry) },
      agentLoop: { config: { maxParallelToolCalls: { get: () => 16 } } },
    },
  })
  const bench = join(await mkdtemp(join(tmpdir(), 'dsh-fast-mode-control-')), 'bench.json')
  try {
    await writeFile(bench, JSON.stringify({ enabled: true, gears: ['off'] }))
    apply(ctx, { metrics: false, benchmarkFile: bench, enabled: true, gear: 'auto' })

    const resolved = { provider: 'company', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }
    const payload = { agent: { id: 'session-control' }, turn: 0, step: 4, signal: new AbortController().signal }
    assert.equal(
      await ctx.handlers.get('agent/request')(payload, async () => resolved),
      resolved,
      'the control arm is untouched even though the plugin is switched on globally',
    )
    assert.equal(sections.at(-1).text({ scope: { id: 'session-control' } }), '', 'and it injects no prompt')
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
  const sections = []
  const ctx = fakeContext({
    services: {
      llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }),
      systemPrompt: { section: entry => sections.push(entry) },
      agentLoop: { config: { maxParallelToolCalls: { get: () => 16 } } },
    },
  })
  apply(ctx, {
    enabled: true,
    gear: 'max',
    metrics: false,
    benchmarkFile: '',
    sessions: JSON.stringify({
      'session-quiet': { enabled: false },
      'session-pinned': { enabled: true, gear: 'fast' },
    }),
  })

  const handler = ctx.handlers.get('agent/request')
  const run = async (id) => {
    const resolved = { provider: 'company', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }
    const payload = { agent: { id }, turn: 0, step: 2, signal: new AbortController().signal }
    const out = await handler(payload, async () => resolved)
    assert.equal(out, resolved, 'no entry may rewrite the request')
    return sections.at(-1).text({ scope: { id } })
  }

  assert.equal(await run('session-quiet'), '', 'a conversation that turned the mode off is handed back untouched')
  assert.match(await run('session-pinned'), /up to 4 independent calls/, 'the pinned entry sets its own width')


  // An entry is authoritative for its conversation and inapplicable to the
  // others: the quiet one stays quiet even though the shared default is on.
  assert.equal(await run('session-quiet'), '', 'the quiet one stays quiet')

  // A conversation with no entry inherits the shared pair, which is what a fresh
  // session starts from: the last choice made anywhere.
  assert.match(await run('session-never-seen'), /up to \d+ independent calls/, 'inherits the shared gear')
})

test('the turn boundary resets the step budget instead of spending it for the session', async () => {
  const ctx = fakeContext()
  apply(ctx, ON)
  const noticesOf = out => out.messages.filter(m => m.source?.form === 'notice')

  // The 30-step breaker fires inside one very long turn.
  let noticed = 0
  for (let i = 0; i < 30; i += 1) {
    const { out } = await step(ctx)
    noticed += noticesOf(out).length
  }
  assert.equal(noticed, 2, 'the finish line and the stop notice each fire exactly once')

  // A new turn starts with a fresh budget, not a spent one.
  ctx.fire('session/event', { id: 'session-1' }, { type: 'turn/start' })
  const { out } = await step(ctx)
  assert.equal(noticesOf(out).length, 0, 'the next turn is not immediately told to stop')

  // And the breaker is re-armed: another 30 steps in this turn speak again.
  let again = 0
  for (let i = 0; i < 30; i += 1) {
    const result = await step(ctx)
    again += noticesOf(result.out).length
  }
  assert.equal(again, 2, 'the budget applies per turn, so the next long turn is caught too')
})

test('the third lever is wired: the stall guard, the compaction reminder, the peer probe', () => {
  const ctx = fakeContext()
  apply(ctx, ON)
  for (const event of ['session/event', 'tools/execute', 'agent/pre-step']) {
    assert.ok(ctx.handlers.has(event), `missing ${event}`)
  }
})

/** The guard only protects shells; run a hung call with an explicit ceiling. */
test('a hung shell call is cancelled at the configured ceiling', async () => {
  const ctx = fakeContext()
  apply(ctx, { ...ON, gear: 'turbo', toolTimeoutMs: 20 })

  let bodySignal
  const exec = { name: 'bash', callId: 'c1', agent, signal: new AbortController().signal }
  const result = await ctx.fire('tools/execute', exec, () => {
    bodySignal = exec.signal
    return new Promise(() => {})
  })

  assert.equal(result.isError, true, 'the model gets a failure instead of a hung turn')
  assert.match(result.content[0].text, /run_in_background/)
  assert.equal(bodySignal.aborted, true)
})

test('the guard leaves a tool it cannot stall, and the switched-off gear, alone', async () => {
  const passthrough = async () => ({ isError: false, value: 'read-ok', content: [] })
  const caller = new AbortController()

  const guarded = fakeContext()
  apply(guarded, { ...ON, gear: 'turbo', toolTimeoutMs: 10_000 })
  const read = await guarded.fire('tools/execute', { name: 'read', callId: 'c1', agent, signal: caller.signal }, passthrough)
  assert.equal(read.value, 'read-ok', 'a slow file read is not a stall')

  const safe = fakeContext()
  apply(safe, { ...ON, gear: 'safe' })
  const bash = await safe.fire('tools/execute', { name: 'bash', callId: 'c2', agent, signal: caller.signal }, passthrough)
  assert.equal(bash.value, 'read-ok', 'safe promises to intervene in nothing')
})

/** Drive one pre-step decision the way the harness would. */
const step = (ctx, { sessionId = 'session-1', claimed = [] } = {}) => {
  const decision = {
    kind: 'enter',
    messages: [{ id: 'sys', role: 'system', content: [] }, ...claimed, { id: 'last', role: 'assistant', content: [] }],
  }
  return ctx
    .fire('agent/pre-step', { agent: { id: sessionId }, messages: claimed }, async () => decision)
    .then(out => ({ out, decision }))
}

test('a compacted session is reminded on its next step, in its own conversation only', async () => {
  const ctx = fakeContext()
  apply(ctx, { ...ON, gear: 'turbo', parallel: 6 })

  const claimed = [{ id: 'u1', role: 'user', content: [] }]
  const before = await step(ctx, { claimed })
  assert.equal(before.out, before.decision, 'a step with nothing to say is handed back untouched')

  ctx.fire('session/event', { id: 'session-1' }, { type: 'compaction/end' })

  const other = await step(ctx, { sessionId: 'session-2', claimed })
  assert.equal(other.out, other.decision, 'another conversation does not inherit the reminder')

  const after = await step(ctx, { claimed })
  const notice = after.out.messages[2]
  assert.equal(notice.source.form, 'notice')
  // v4 admission: a producer-owned kind, and no retired `plugin` field — a bare
  // `plugin` kind makes the session encoder throw and fails the whole turn.
  assert.equal(notice.source.kind, 'plugin:fast-mode')
  assert.equal(Object.hasOwn(notice.source, 'plugin'), false)
  assert.match(notice.content[0].text, /up to 6 independent calls/)
  assert.deepEqual(after.out.messages.map(m => m.id), ['sys', 'u1', notice.id, 'last'], 'the reminder sits after the message it belongs to')

  const again = await step(ctx, { claimed })
  assert.equal(again.out, again.decision, 'one reminder per compaction, not one per step')
})

test('a failed compaction schedules no reminder', async () => {
  const ctx = fakeContext()
  apply(ctx, ON)

  ctx.fire('session/event', { id: 'session-1' }, { type: 'compaction/end', error: new Error('summariser failed') })
  const { out, decision } = await step(ctx)
  assert.equal(out, decision, 'the history is intact when the compaction failed')
})

test('the reminder can be switched off without switching the mode off', async () => {
  const ctx = fakeContext()
  apply(ctx, { ...ON, gear: 'turbo', reassertAfterCompaction: false })

  ctx.fire('session/event', { id: 'session-1' }, { type: 'compaction/end' })
  const { out, decision } = await step(ctx)
  assert.equal(out, decision)
})
