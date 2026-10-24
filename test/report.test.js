/**
 * The report CLI as a user runs it.
 *
 * The arithmetic is covered in `metrics.test.js`; what matters here is the part
 * a user actually touches — the flags, the Chinese tables, the "no data yet"
 * answer, and the LAN join, which must never echo the token.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CLI = fileURLToPath(new URL('../bin/report.mjs', import.meta.url))

const withRows = (rows, operation) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fast-mode-report-test-'))
  const file = join(dir, 'metrics.jsonl')
  if (rows) writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'))
  return Promise.resolve(operation(file, dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

// Rows are stamped three hours ago so `--since 1h` has something to exclude
// without depending on the wall clock.
let clock = Date.now() - 3 * 3600 * 1000
const row = (sid, mode, gear, overrides = {}) => {
  clock += 1000
  return {
    v: 1,
    ts: new Date(clock).toISOString(),
    sid,
    turn: 0,
    step: 1,
    mode,
    gear,
    effort: mode === 'off' ? 'high' : 'low',
    route: 'deepseek-official/deepseek-v4.1-flash',
    ttftMs: 300,
    llmMs: mode === 'off' ? 2000 : 800,
    stepMs: mode === 'off' ? 2100 : 900,
    calls: 1,
    errors: 0,
    input: 1000,
    output: mode === 'off' ? 100 : 140,
    ...overrides,
  }
}

const comparison = () => [
  row('off-1', 'off', 'off'),
  row('off-1', 'off', 'off', { step: 2 }),
  row('on-1', 'on', 'fast'),
  row('on-1', 'on', 'fast', { step: 2 }),
]

test('--help prints the usage without reading any file', async () => {
  const { stdout } = await run(process.execPath, [CLI, '--help'])
  assert.match(stdout, /--lan/)
  assert.match(stdout, /--since/)
})

test('a missing measurement file explains what to do instead of failing', () => withRows(undefined, async (file) => {
  const { stdout } = await run(process.execPath, [CLI, '--file', file])
  assert.match(stdout, /没有测量文件/)
  assert.match(stdout, /插件默认开启计量/)
}))

test('the tables show both stances and the speedup against off', () => withRows(comparison(), async (file) => {
  const { stdout } = await run(process.execPath, [CLI, '--file', file])
  assert.match(stdout, /档位/)
  assert.match(stdout, /关闭/)
  assert.match(stdout, /fast/)
  assert.match(stdout, /开启 2，关闭 2/)
  // fast: 800 ms against off: 2000 ms
  assert.match(stdout, /2\.5×/)
  // output per step rose 100 → 140
  assert.match(stdout, /1\.4×/)
  assert.match(stdout, /口径说明/)
  assert.match(stdout, /会话墙钟还包含人读和打字的时间/)
}))

test('one side only: the comparison is refused in words, not with a divide-by-zero', () => withRows(
  [row('on-1', 'on', 'fast')],
  async (file) => {
    const { stdout } = await run(process.execPath, [CLI, '--file', file])
    assert.match(stdout, /没有关闭状态的样本/)
    assert.match(stdout, /先把小闪电关掉跑同样的任务/)
  },
))

test('--json is the machine-readable form of the same numbers', () => withRows(comparison(), async (file) => {
  const { stdout } = await run(process.execPath, [CLI, '--file', file, '--json'])
  const payload = JSON.parse(stdout)
  assert.equal(payload.total, 4)
  assert.equal(payload.used, 4)
  assert.equal(payload.buckets.length, 2)
  assert.equal(payload.buckets[0].mode, 'off')
  assert.equal(payload.lan, undefined, 'no --lan, no network call')
}))

test('--since drops rows older than the window', () => withRows(comparison(), async (file) => {
  const all = JSON.parse((await run(process.execPath, [CLI, '--file', file, '--json'])).stdout)
  assert.equal(all.used, 4)

  const recent = JSON.parse((await run(process.execPath, [CLI, '--file', file, '--json', '--since', '1h'])).stdout)
  assert.ok(recent.used < 4, 'the fixture is older than an hour, so a 1h window must exclude rows')
}))

test('--lan without a token says so and reports without it', () => withRows(comparison(), async (file) => {
  const { stdout } = await run(process.execPath, [CLI, '--file', file, '--lan'], {
    env: { ...process.env, USAGE_TOKEN: '', USAGE_BASE: '' },
  })
  assert.match(stdout, /USAGE_TOKEN/)
  assert.match(stdout, /局域网用量面板对照/)
}))

/** A stand-in for the self-hosted dashboard: same envelope, one matching session. */
const dashboard = () => new Promise((resolve) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/api/v1/sessions/recent') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      code: 0,
      data: {
        list: [
          {
            id: 'on-1',
            createdAt: '2026-01-01T00:00:00Z',
            modelName: 'deepseek/deepseek-v4.1-flash',
            tokenStats: { input_tokens: 2000, output_tokens: 280, total_tokens: 2280 },
            durationSeconds: 42,
          },
          {
            id: 'someone-else',
            createdAt: '2026-01-01T00:00:00Z',
            modelName: 'other',
            tokenStats: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            durationSeconds: 1,
          },
        ],
      },
    }))
  })
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
})

test('--lan joins by session id and never prints the token', () => withRows(comparison(), async (file) => {
  const { server, port } = await dashboard()
  try {
    const token = 'not-a-real-token-9f3a'
    const { stdout } = await run(process.execPath, [CLI, '--file', file, '--lan'], {
      env: { ...process.env, USAGE_TOKEN: token, USAGE_BASE: `http://127.0.0.1:${port}` },
    })
    assert.match(stdout, /上游模型/)
    assert.match(stdout, /deepseek\/deepseek-v4\.1-flash/)
    assert.match(stdout, /2280/, 'the dashboard total for the joined session')
    assert.doesNotMatch(stdout, /someone-else/, 'sessions this machine never measured stay out')
    assert.equal(stdout.includes(token), false, 'the credential must never reach stdout')
  } finally {
    server.close()
  }
}))

test('an unreachable dashboard degrades to a note', () => withRows(comparison(), async (file) => {
  const { stdout } = await run(process.execPath, [CLI, '--file', file, '--lan'], {
    env: { ...process.env, USAGE_TOKEN: 'x', USAGE_BASE: 'http://127.0.0.1:1' },
  })
  assert.match(stdout, /--lan 请求失败/)
}))
