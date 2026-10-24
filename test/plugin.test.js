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
import { readFile, stat } from 'node:fs/promises'
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
  apply(ctx, {})
  for (const event of ['agent/request', 'tools/pre-execute', 'tools/post-execute']) {
    assert.ok(ctx.handlers.has(event), `missing ${event}`)
  }
})

test('enabled:false registers nothing', () => {
  const ctx = fakeContext()
  apply(ctx, { enabled: false })
  assert.equal(ctx.handlers.size, 0)
})

test('planning step keeps effort; execution step after clean calls is lowered', async () => {
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
  })
  apply(ctx, {})

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
  apply(ctx, {})

  await runTool(ctx, { callId: 'c1', name: 'bash', args: { command: 'false' }, isError: true })
  const after = await request(ctx, { step: 2, effort: 'medium' })
  assert.equal(after.reasoningEffort, 'medium', 'a failure means the next action is not routine')
})

test('tool hooks never alter the tool result', async () => {
  const ctx = fakeContext()
  apply(ctx, {})
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
  apply(ctx, {})

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
  apply(ctx, { floor: 'minimal' })
  for (let index = 0; index < 8; index += 1) {
    await runTool(ctx, { callId: `c${index}`, name: 'read', args: { path: `f${index}` } })
  }
  const deep = await request(ctx, { step: 9, effort: 'high' })
  assert.equal(deep.reasoningEffort, 'low', 'high minus two notches')
})

test('an unknown effort id is passed through untouched', async () => {
  const ctx = fakeContext({ services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) } })
  apply(ctx, {})
  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
  const result = await request(ctx, { step: 2, effort: 'turbo' })
  assert.equal(result.reasoningEffort, 'turbo')
})

/* ------------------------------------------------- provider independence */

test('official DeepSeek route gets a real cut, not an alias no-op', async () => {
  const ctx = fakeContext({
    services: { llm: llmService({ 'deepseek/deepseek-flash': { efforts: OFFICIAL, default: 'high' } }) },
  })
  apply(ctx, {})
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
  apply(ctx, {})
  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
  const execution = await request(ctx, { step: 2, effort: 'high', provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(execution.reasoningEffort, 'high', 'no level to cut means no decision')
})

test('when discovery is unavailable the plugin does not guess', async () => {
  // No llm service at all, and a request that still carries an effort. Sending a
  // guessed id would make the harness reject the call before provider I/O, so
  // the only safe action is none.
  const ctx = fakeContext()
  apply(ctx, {})
  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
  const execution = await request(ctx, { step: 2, effort: 'high' })
  assert.equal(execution.reasoningEffort, 'high')
})

test('a failing discovery call is treated as unknown', async () => {
  const ctx = fakeContext({ services: { llm: llmService({}, { fail: true }) } })
  apply(ctx, {})
  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
  const execution = await request(ctx, { step: 2, effort: 'high' })
  assert.equal(execution.reasoningEffort, 'high')
})

test('slow discovery never stalls the request, and later steps use the real ladder', async () => {
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }, { delayMs: 60 }) },
  })
  apply(ctx, { discoverTimeoutMs: 10 })

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
  apply(ctx, { ladder: ['low', 'high'], floor: 'low' })
  await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
  const execution = await request(ctx, { step: 2, effort: 'high' })
  assert.equal(execution.reasoningEffort, 'low')
})

test('the route is logged once, proving which ladder was used', async () => {
  const ctx = fakeContext({
    services: { llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'high' } }) },
  })
  apply(ctx, {})
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
  apply(ctx, {})
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
    apply(ctx, { debug: true, debugFile: file })
    await runTool(ctx, { callId: 'c1', name: 'read', args: { path: 'a' } })
    await request(ctx, { step: 2, effort: 'medium' })
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /step=2 gear=fast medium=>low/)
    assert.match(lines[0], /clean=1/)
    assert.match(lines[0], /route=provider/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a gear above safe registers execution guidance, and safe registers none', () => {
  const sections = []
  const services = (parallel = 10) => ({
    llm: llmService({ 'company/deepseek-v4.1-flash': { efforts: SELF_HOSTED, default: 'medium' } }),
    systemPrompt: { section: entry => sections.push(entry) },
    agentLoop: { config: { maxParallelToolCalls: { get: () => parallel } } },
  })

  const safe = fakeContext({ services: services() })
  apply(safe, { gear: 'safe' })
  assert.equal(sections.length, 0, 'the safe gear must stay invisible in the prompt')

  const fast = fakeContext({ services: services() })
  apply(fast, { gear: 2 })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'fast-mode:execution-speed')
  assert.equal(typeof sections[0].order, 'number')
  assert.match(sections[0].text, /up to 4 independent calls/)
  assert.match(sections[0].text, /never report a result you have not received/)

  // The fan-out number is configurable, and the text follows it.
  const custom = fakeContext({ services: services() })
  apply(custom, { gear: 3, parallel: 7 })
  assert.match(sections[1].text, /up to 7 independent calls/)
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
  apply(ctx, { gear: 2 })

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
})
