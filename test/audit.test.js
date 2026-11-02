/**
 * audit/run.mjs 的纯函数测试。
 *
 * 这里测的是"读数算得对不对"：配对 bootstrap、几何均值、样本不足的判定、
 * 任务清单解析、两个臂的 patch 缩进、token 归集顺序、命令行展开。
 *
 * 不测的（也没法在 CI 里测）：真实跑一次 dsh 的耗时——那要凭据、要几分钟、
 * 结果还因机器而异。所以 run.mjs 把测量和计算分开，这里只钉计算那半边。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  MIN_PAIRS,
  RESAMPLES,
  SEED,
  armPatch,
  bootstrapCi,
  buildArgv,
  formatCommand,
  geomean,
  parseArgs,
  parseTasks,
  patchStyleFor,
  percentile,
  ratioOf,
  resolveTokens,
  shellQuote,
  splitArgs,
  summarise,
  tokensFromJournal,
  usageFromEvents,
  verdict,
} from '../audit/run.mjs'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const runner = resolve(here, '..', 'audit', 'run.mjs')

/** 一次成功的读数的形状，测试里只改需要改的字段。 */
function reading(wallMs, tokens = null) {
  return { wallMs, tokens, ok: true, exitCode: 0, check: null }
}

function pair(id, offWall, onWall, offTokens = null, onTokens = null) {
  return {
    id,
    round: 1,
    off: reading(offWall, offTokens),
    on: reading(onWall, onTokens),
  }
}

test('parseTasks 读得懂带注释的清单', () => {
  const tasks = parseTasks([
    '# 这是注释',
    '',
    '{"id": "a", "prompt": "列文件"}',
    '{"id": "b", "prompt": "读文件", "check": "test -f package.json"}',
    '{"id": "c", "prompt": "跑测试", "check": null}',
  ].join('\n'))
  assert.equal(tasks.length, 3)
  assert.deepEqual(tasks[0], { id: 'a', prompt: '列文件', check: null })
  assert.equal(tasks[1].check, 'test -f package.json')
  assert.equal(tasks[2].check, null)
})

test('parseTasks 空串或纯注释当没给任务', () => {
  assert.throws(() => parseTasks(''), /没有任何任务/)
  assert.throws(() => parseTasks('# 只有注释\n\n'), /没有任何任务/)
})

test('parseTasks 每条错误都点名行号', () => {
  assert.throws(
    () => parseTasks('{"id": "a", "prompt": "x"}\n{不是 json'),
    /第 2 行不是合法 JSON/,
  )
  assert.throws(() => parseTasks('\n\n{"prompt": "x"}'), /第 3 行缺少非空 id/)
  assert.throws(
    () => parseTasks('{"id": "a", "prompt": "x"}\n\n{"id": "a", "prompt": "y"}'),
    /第 3 行的 id "a" 重复/,
  )
  assert.throws(() => parseTasks('{"id": "a"}'), /缺少非空 prompt/)
  assert.throws(() => parseTasks('{"id": "a", "prompt": "   "}'), /缺少非空 prompt/)
  assert.throws(() => parseTasks('["id"]'), /必须是 JSON 对象/)
  assert.throws(() => parseTasks('null'), /必须是 JSON 对象/)
  assert.throws(() => parseTasks('{"id": "a", "prompt": "x", "check": 1}'), /check 必须是字符串或 null/)
})

test('geomean 算的是对数平均', () => {
  assert.equal(geomean([1, 4]), 2)
  assert.ok(Math.abs(geomean([2, 8]) - 4) < 1e-12)
  assert.equal(geomean([]), null)
  assert.equal(geomean([NaN, undefined]), null)
  // 一个 0 会让对数发散，宁可报错，也不悄悄当成 1 摊平
  assert.throws(() => geomean([0, 2]), /所有值 > 0/)
})

test('percentile 在两点之间线性插值', () => {
  const sorted = [1, 2, 3, 4, 5]
  assert.equal(percentile(sorted, 0), 1)
  assert.equal(percentile(sorted, 0.5), 3)
  assert.equal(percentile(sorted, 1), 5)
  assert.equal(percentile(sorted, 0.125), 1.5)
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile([7], 0.9), 7)
})

test('bootstrapCi 用固定种子，重跑结果一致', () => {
  const ratios = [0.5, 0.6, 0.55, 0.7, 0.45, 0.62, 0.58, 0.66]
  const first = bootstrapCi(ratios)
  const again = bootstrapCi(ratios)
  assert.deepEqual(first, again)
  assert.equal(first.n, 8)
  assert.equal(first.resamples, RESAMPLES)
  assert.ok(Math.abs(first.center - geomean(ratios)) < 1e-12)
  assert.ok(first.lo <= first.center && first.center <= first.hi)
  assert.ok(first.lo < 1 && first.hi < 1, '这组数明显都快于 1')
})

test('bootstrapCi 换种子会动，但落点仍在中心附近', () => {
  const ratios = [0.9, 1.1, 1.0, 0.95, 1.05, 1.02]
  const a = bootstrapCi(ratios, { seed: 1, resamples: 500 })
  const b = bootstrapCi(ratios, { seed: 2, resamples: 500 })
  assert.notDeepEqual([a.lo, a.hi], [b.lo, b.hi])
  assert.ok(a.lo < 1 && a.hi > 1, '这组数跨过 1，区间就该跨过 1')
})

test('bootstrapCi 全 1 的样本区间退化成 1', () => {
  const ci = bootstrapCi([1, 1, 1, 1, 1, 1], { resamples: 200 })
  assert.equal(ci.lo, 1)
  assert.equal(ci.hi, 1)
  assert.equal(ci.center, 1)
})

test('bootstrapCi 空样本不制造数字', () => {
  const ci = bootstrapCi([])
  assert.deepEqual([ci.n, ci.center, ci.lo, ci.hi], [0, null, null, null])
  assert.throws(() => bootstrapCi([1.2, -0.5]), /必须 > 0/)
})

test('ratioOf 只在一对数都可用时给值', () => {
  assert.equal(ratioOf(pair('x', 1000, 500), 'wallMs'), 0.5)
  assert.equal(ratioOf(pair('x', 1000, 500, 300, 150), 'tokens'), 0.5)
  assert.equal(ratioOf(pair('x', 1000, 500, null, 150), 'tokens'), null)
  assert.equal(ratioOf(pair('x', 0, 500), 'wallMs'), null)
  assert.equal(ratioOf({}, 'wallMs'), null)
  assert.equal(ratioOf(null, 'wallMs'), null)
})

test('verdict 在样本不足时明说不做结论', () => {
  const ci = bootstrapCi([0.5, 0.5, 0.5], { resamples: 100 })
  assert.equal(ci.n, 3)
  const line = verdict(ci, '合池墙钟')
  assert.match(line, /样本不足/)
  assert.match(line, new RegExp(`${MIN_PAIRS}`))
  assert.doesNotMatch(line, /变快/)
})

test('verdict 的三条岔路', () => {
  const fast = bootstrapCi([0.5, 0.55, 0.6, 0.45, 0.52, 0.58, 0.5, 0.54])
  assert.match(verdict(fast, '墙钟'), /变快/)
  assert.match(verdict(fast, '墙钟'), /省/)

  const slow = bootstrapCi([2, 2.2, 2.1, 1.9, 2.05, 2.15, 2.02, 1.98])
  assert.match(verdict(slow, '墙钟'), /变慢/)
  assert.match(verdict(slow, '墙钟'), /多花/)

  const flat = bootstrapCi([0.9, 1.1, 1.0, 0.95, 1.05, 1.0, 0.98, 1.02])
  assert.match(verdict(flat, '墙钟'), /无法区分/)

  assert.match(verdict(bootstrapCi([]), '墙钟'), /无配对数据/)
  assert.match(verdict(null, '墙钟'), /无配对数据/)
})

test('summarise 逐任务归组，并把样本不足标出来', () => {
  const pairs = [
    pair('a', 1000, 500, 300, 150),
    pair('a', 1000, 600, 300, 180),
    pair('b', 2000, 1000, null, null),
  ]
  const summary = summarise(pairs, { resamples: 200 })
  assert.equal(summary.rows.length, 2)
  const rowA = summary.rows.find(r => r.id === 'a')
  assert.equal(rowA.n, 2)
  assert.ok(Math.abs(rowA.wallCi.center - Math.sqrt(0.5 * 0.6)) < 1e-12)
  assert.match(rowA.tokenVerdict, /样本不足/)
  const rowB = summary.rows.find(r => r.id === 'b')
  assert.equal(rowB.tokenCi.n, 0)
  assert.match(rowB.tokenVerdict, /N\/A/)
  assert.equal(summary.insufficient, true)
  assert.match(summary.wallVerdict, /样本不足/)
  assert.equal(summary.wall.n, 3)
})

test('summarise 够 6 对时才给结论，并数校验通过', () => {
  const pairs = []
  for (let i = 0; i < 6; i += 1) {
    const p = pair(`t${i}`, 1000, 500, 300, 150)
    p.off.check = 'pass'
    p.on.check = i === 0 ? 'fail' : 'pass'
    pairs.push(p)
  }
  const summary = summarise(pairs, { resamples: 300 })
  assert.equal(summary.insufficient, false)
  assert.match(summary.wallVerdict, /变快/)
  assert.equal(summary.checkOff, 6)
  assert.equal(summary.checkOn, 5)
  assert.equal(summary.checked, 6)
})

test('armPatch 两个臂只差一个开关，且子键比 config 多缩两格', () => {
  const off = armPatch('override', false)
  const on = armPatch('override', true)
  assert.match(off, /^- id: fast-mode$/m)
  assert.match(off, /^  config:$/m)
  assert.match(off, /^    enabled: false$/m)
  assert.match(on, /^    enabled: true$/m)
  assert.equal(on.split('\n').filter(l => l.includes('gear')).length, 1)

  const inserted = armPatch('insert', false)
  assert.match(inserted, /^- insert:$/m)
  assert.match(inserted, /^    config:$/m)
  assert.match(inserted, /^      enabled: false$/m)
  assert.match(inserted, /^    name: dsh-fast-mode$/m)

  const indentOf = (text, key) => text.split('\n').find(l => l.trim().startsWith(key)).match(/^ */)[0].length
  for (const text of [off, inserted]) {
    assert.equal(indentOf(text, 'enabled:'), indentOf(text, 'config:') + 2, 'YAML 子键必须比父键深两格')
  }
})

test('patchStyleFor 按 profile 自己 dump 出来的内容选覆盖形式', () => {
  assert.equal(patchStyleFor('- id: session-title\n  name: x\n- id: fast-mode\n  config:\n    enabled: false\n'), 'override')
  assert.equal(patchStyleFor('  - id: fast-mode\n'), 'override')
  assert.equal(patchStyleFor(''), 'insert')
  assert.equal(patchStyleFor('- id: fast-mode-extra\n'), 'insert')
  assert.equal(patchStyleFor(null), 'insert')
})

test('buildArgv 的顺序：launcher 参数在前，任务原文最后且只占一个参数', () => {
  assert.deepEqual(
    buildArgv({ profile: 'bench', appArgs: ['--json'], prompt: '读一下 README', patch: '/tmp/a.yml' }),
    ['--profile', 'bench', '--patch', '/tmp/a.yml', '--json', '读一下 README'],
  )
  assert.deepEqual(
    buildArgv({ profile: null, appArgs: [], prompt: 'hi' }),
    ['hi'],
  )
  assert.deepEqual(
    buildArgv({ profile: 'bench', appArgs: ['--json'], prompt: 'a b  c' }),
    ['--profile', 'bench', '--json', 'a b  c'],
  )
})

test('shellQuote 让复制出去的命令能直接跑', () => {
  assert.equal(shellQuote('--json'), '--json')
  assert.equal(shellQuote('/Users/a b/x.yml'), `'/Users/a b/x.yml'`)
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.equal(shellQuote(''), `''`)
  assert.equal(shellQuote('中文 任务'), `'中文 任务'`)
})

test('formatCommand 拼出可复现的完整命令行', () => {
  const text = formatCommand('/bin/dsh.js', ['--profile', 'bench', '--json', '跑测试'], { node: 'node' })
  assert.equal(text, `node /bin/dsh.js --profile bench --json '跑测试'`)
})

test('splitArgs 自己解析引号，不经过 shell', () => {
  assert.deepEqual(splitArgs('--json'), ['--json'])
  assert.deepEqual(splitArgs('--a "b c" --d'), ['--a', 'b c', '--d'])
  assert.deepEqual(splitArgs("--a 'b c'"), ['--a', 'b c'])
  assert.deepEqual(splitArgs('   '), [])
  assert.equal(splitArgs(null), null)
  assert.throws(() => splitArgs('--a "b'), /引号没闭合/)
})

test('parseArgs 默认值就是探测到的那套', () => {
  const options = parseArgs([])
  assert.equal(options.profile, 'bench')
  assert.match(options.dshBin, /dsh\/lib\/bin\.js$/)
  assert.deepEqual(options.appArgs, ['--json'])
  assert.equal(options.rounds, 3)
  assert.equal(options.armStyle, 'auto')
  assert.equal(options.seed, SEED)
  assert.equal(options.resamples, RESAMPLES)
  assert.equal(options.dryRun, false)
})

test('parseArgs 认 --k v 与 --k=v，并校验数字', () => {
  const options = parseArgs(['--tasks', 't.jsonl', '--rounds=5', '--dry-run', '--seed', '7'])
  assert.equal(options.tasks, 't.jsonl')
  assert.equal(options.rounds, 5)
  assert.equal(options.seed, 7)
  assert.equal(options.dryRun, true)
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
  assert.throws(() => parseArgs(['--rounds']), /缺少值/)
  assert.throws(() => parseArgs(['--rounds', '0']), /必须是正数/)
  assert.throws(() => parseArgs(['--rounds', 'abc']), /必须是正数/)
  assert.equal(parseArgs(['--help']).help, true)
})

test('usageFromEvents 累加 step_end 的 outputTokens 并记住 sessionId', () => {
  const events = [
    '{"type":"session","sessionId":"s-1","cwd":"/tmp"}',
    '{"type":"status","phase":"turn_start","turn":1}',
    '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":100,"outputTokens":40}}',
    '{"type":"status","phase":"step_end","turn":1,"step":2,"usage":{"inputTokens":100,"outputTokens":25}}',
    '{"type":"final","text":"ok"}',
  ].join('\n')
  assert.deepEqual(usageFromEvents(events), { tokens: 65, steps: 2, sessionId: 's-1' })
})

test('usageFromEvents 缺 usage 就是 null，不当成 0', () => {
  const events = [
    '{"type":"session","sessionId":"s-2"}',
    '{"type":"status","phase":"step_end","step":1}',
    '',
    'not json',
  ].join('\n')
  const result = usageFromEvents(events)
  assert.equal(result.tokens, null)
  assert.equal(result.steps, 1)
  assert.equal(result.sessionId, 's-2')
  assert.deepEqual(usageFromEvents(''), { tokens: null, steps: 0, sessionId: null })
})

test('tokensFromJournal 只认这个 session 的行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-journal-'))
  try {
    const file = join(dir, 'metrics.jsonl')
    writeFileSync(file, [
      '{"v":2,"sid":"other","step":1,"output":999}',
      '{"v":2,"sid":"s-1","step":1,"output":40}',
      '{"v":2,"sid":"s-1","step":2,"output":25}',
      'half a line',
    ].join('\n'))
    assert.deepEqual(tokensFromJournal(file, 's-1'), { tokens: 65, steps: 2, rows: 2 })
    assert.deepEqual(tokensFromJournal(file, 'missing'), { tokens: null, steps: 0, rows: 0 })
    assert.deepEqual(tokensFromJournal(file, null), { tokens: null, steps: 0, rows: 0 })
    assert.deepEqual(tokensFromJournal(join(dir, 'nope.jsonl'), 's-1'), { tokens: null, steps: 0, rows: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveTokens 先 CLI 事件、再 journal，都没有就 N/A', () => {
  const fromCli = resolveTokens({ events: { tokens: 100, steps: 2 }, journal: { tokens: 90, steps: 2 } })
  assert.deepEqual(fromCli, { tokens: 100, source: 'cli --json step_end usage', steps: 2 })

  const fromJournal = resolveTokens({ events: { tokens: null, steps: 2 }, journal: { tokens: 90, steps: 2 } })
  assert.deepEqual(fromJournal, { tokens: 90, source: 'metrics jsonl (sid match)', steps: 2 })

  const none = resolveTokens({ events: { tokens: null, steps: 0 }, journal: { tokens: null } })
  assert.deepEqual(none, { tokens: null, source: null, steps: 0 })
})

test('CLI --dry-run 打印真实展开的命令，不跑任何东西', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-dry-'))
  try {
    const tasks = join(dir, 'tasks.jsonl')
    writeFileSync(tasks, [
      '{"id": "one", "prompt": "列目录", "check": "test -f package.json"}',
      '{"id": "two", "prompt": "读 README"}',
    ].join('\n'))
    const { stdout } = await run('node', [
      runner, '--dry-run', '--tasks', tasks, '--cwd', dir, '--profile', 'bench', '--arm-style', 'override',
    ], { timeout: 30000 })

    assert.match(stdout, /dry-run：不执行任何命令/)
    assert.match(stdout, /--profile bench/)
    assert.match(stdout, /--patch \S*arm-off\.patch\.yml/)
    assert.match(stdout, /--patch \S*arm-on\.patch\.yml/)
    assert.match(stdout, /enabled: false/)
    assert.match(stdout, /enabled: true/)
    assert.match(stdout, /one \[off\] .*'列目录'/)
    assert.match(stdout, /one \[on\] check: \/bin\/sh -c 'test -f package\.json'/)
    assert.match(stdout, /two \[on\] .*'读 README'/)
    // dry-run 不该留下任何产物
    assert.deepEqual((await run('/bin/sh', ['-c', `ls -A ${JSON.stringify(dir)}`], { timeout: 10000 }))
      .stdout.trim().split('\n').sort(), ['tasks.jsonl'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI 的错误走退出码 2，并且说清要改什么', async () => {
  const failures = [
    { args: ['--tasks', 'nope.jsonl'], pattern: /读不到任务清单/ },
    { args: [], pattern: /缺少 --tasks/ },
    { args: ['--tasks', 'x', '--bogus'], pattern: /未知参数/ },
    { args: ['--tasks', 'x', '--cwd', '/definitely/not/here'], pattern: /--cwd 不存在/ },
  ]
  for (const { args, pattern } of failures) {
    await assert.rejects(
      run('node', [runner, ...args], { timeout: 30000 }),
      (error) => {
        assert.equal(error.code, 2, `${args.join(' ')} 应该退 2`)
        assert.match(error.stderr, pattern)
        return true
      },
    )
  }
})
