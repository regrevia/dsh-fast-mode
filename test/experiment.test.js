/**
 * The experiment CLI: the file it owns, the refusal that protects a running
 * experiment, and the coverage numbers it reports.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CLI = fileURLToPath(new URL('../bin/experiment.mjs', import.meta.url))

/** A scratch pair of files; the CLI gets absolute paths so it never sees `~`. */
const scratch = (operation) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fast-mode-experiment-test-'))
  const bench = join(dir, 'bench.json')
  const metrics = join(dir, 'metrics.jsonl')
  const call = (...args) => run(process.execPath, [CLI, '--bench', bench, '--metrics', metrics, ...args])
  return Promise.resolve(operation({ bench, metrics, call })).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const row = (sid, gear, step) => ({
  v: 1,
  ts: '2026-01-01T00:00:00.000Z',
  sid,
  turn: 0,
  step,
  mode: gear === 'off' ? 'off' : 'on',
  gear,
  effort: 'low',
  llmMs: 500,
  stepMs: 600,
  ttftMs: 200,
  calls: 1,
  errors: 0,
  input: 1000,
  output: 100,
})

test('--help lists the three commands', async () => {
  const { stdout } = await run(process.execPath, [CLI, '--help'])
  assert.match(stdout, /start/)
  assert.match(stdout, /status/)
  assert.match(stdout, /stop/)
})

test('start writes an experiment the plugin can read, and stop removes it', () => scratch(async ({ bench, call }) => {
  const started = await call('start')
  assert.match(started.stdout, /实验开始/)
  const file = JSON.parse(readFileSync(bench, 'utf8'))
  assert.equal(file.enabled, true)
  assert.deepEqual(file.gears, ['safe', 'fast', 'turbo', 'max'])

  const stopped = await call('stop')
  assert.match(stopped.stdout, /实验已结束/)
  assert.equal(existsSync(bench), false)

  const again = await call('stop')
  assert.match(again.stdout, /没有实验在跑/)
}))

test('start refuses to overwrite a running experiment without --force', () => scratch(async ({ bench, call }) => {
  await call('start')
  writeFileSync(bench, JSON.stringify({ enabled: true, gears: ['fast'] }))
  const second = await call('start')
  assert.match(second.stdout, /实验已经在跑/)
  assert.deepEqual(JSON.parse(readFileSync(bench, 'utf8')).gears, ['fast'], 'a running arm is not silently replaced')

  const forced = await call('start', '--gears', 'turbo,max', '--force')
  assert.match(forced.stdout, /实验开始/)
  assert.deepEqual(JSON.parse(readFileSync(bench, 'utf8')).gears, ['turbo', 'max'])
}))

test('a single gear is not an experiment', () => scratch(async ({ call, bench }) => {
  let failed
  try {
    await call('start', '--gears', 'fast')
  } catch (error) {
    failed = error
  }
  assert.ok(failed, 'one arm cannot be compared with anything')
  assert.equal(failed.code, 2)
  assert.match(String(failed.stderr), /至少需要两个档位/)
  assert.equal(existsSync(bench), false, 'a refused start leaves no file behind')
}))

test('unknown gear names are dropped instead of written', () => scratch(async ({ call, bench }) => {
  await call('start', '--gears', 'safe,warp,max')
  assert.deepEqual(JSON.parse(readFileSync(bench, 'utf8')).gears, ['safe', 'max'])
}))

test('status counts sessions and steps per arm, and says what is missing', () => scratch(async ({ call, bench, metrics }) => {
  const quiet = await call('status')
  assert.match(quiet.stdout, /不在跑/)
  assert.match(quiet.stdout, /还没有数据/)

  await call('start')
  writeFileSync(metrics, [
    row('a', 'safe', 1), row('a', 'safe', 2),
    row('b', 'fast', 1), row('b', 'fast', 2), row('b', 'fast', 3),
  ].map(entry => JSON.stringify(entry)).join('\n'))

  const busy = await call('status')
  assert.match(busy.stdout, /safe/)
  assert.match(busy.stdout, /fast/)
  // safe: 1 session / 2 steps, fast: 1 session / 3 steps
  assert.match(busy.stdout, /safe\s+1\s+2/)
  assert.match(busy.stdout, /fast\s+1\s+3/)
  assert.match(busy.stdout, /还没有关闭态的样本/)
  assert.match(busy.stdout, /dsh-fast-mode-report --since 7d/)
}))

test('status is silent about a broken metrics line and keeps the good ones', () => scratch(async ({ call, metrics }) => {
  writeFileSync(metrics, `${JSON.stringify(row('a', 'turbo', 1))}\n{not json\n`)
  const { stdout } = await call('status')
  assert.match(stdout, /turbo\s+1\s+1/)
}))

test('an unknown command prints usage and exits 2', async () => {
  let failed
  try {
    await run(process.execPath, [CLI, 'wat'])
  } catch (error) {
    failed = error
  }
  assert.ok(failed)
  assert.equal(failed.code, 2)
  assert.match(String(failed.stderr), /未知命令/)
})
