#!/usr/bin/env node
/**
 * Start, inspect and stop a gear experiment.
 *
 * The report CLI answers "did it get faster", but only if the sessions it reads
 * were split across gears by something other than the person who wants a
 * particular answer. This command owns that file, so nobody has to hand-edit
 * JSON and nobody has to remember which gears the run was using:
 *
 *   dsh-fast-mode-experiment start          # four gears, hash-assigned
 *   dsh-fast-mode-experiment status         # samples per gear so far
 *   dsh-fast-mode-experiment stop           # back to the configured gear
 *   dsh-fast-mode-report                    # the comparison
 *
 * Local only: it writes one file and reads one file. No network, no telemetry.
 *
 * @module dsh-fast-mode/bin/experiment
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createAssignment } from '../src/benchmark.js'
import { GEARS } from '../src/effort.js'
import { summarise } from '../src/metrics.js'

const DEFAULT_GEARS = ['off', 'safe', 'fast', 'turbo', 'max']

const USAGE = `用法: dsh-fast-mode-experiment <command> [options]

命令:
  start     写入实验文件，让接下来的会话按 session id 哈希分档
  status    看每个档位已经有几个会话/几步，还差多少
  stop      删除实验文件，回到插件配置里的档位

选项:
  --bench <file>    实验文件（默认 ~/.dsh/fast-mode-bench.json）
  --metrics <file>  测量文件（默认 ~/.dsh/fast-mode-metrics.jsonl）
  --gears a,b,c     参与实验的档位（默认 ${DEFAULT_GEARS.join(',')}；off 是对照组）
  --sessions n      目标：每个档位至少 n 个会话（默认 3，只影响 status 的提示）
  --force           start 时覆盖已有实验文件
  -h, --help        显示本帮助

档位: off（对照组） / ${Object.keys(GEARS).join(' / ')}

对比看: dsh-fast-mode-report --since 2d
实验结束后记得 stop：留着文件不影响安全，但会让后续会话继续被分档。`

const expandHome = (path) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)

function parseArgs(argv) {
  const options = {
    command: 'help',
    bench: '~/.dsh/fast-mode-bench.json',
    metrics: '~/.dsh/fast-mode-metrics.jsonl',
    gears: DEFAULT_GEARS,
    sessions: 3,
    force: false,
  }
  const unknown = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') options.command = 'help'
    else if (arg === '--force') options.force = true
    else if (arg === '--bench') options.bench = argv[++index] ?? options.bench
    else if (arg === '--metrics') options.metrics = argv[++index] ?? options.metrics
    else if (arg === '--gears') options.gears = (argv[++index] ?? '').split(',').map(name => name.trim()).filter(Boolean)
    else if (arg === '--sessions') {
      const parsed = Number(argv[++index])
      if (Number.isFinite(parsed) && parsed > 0) options.sessions = Math.floor(parsed)
      else unknown.push('--sessions')
    } else if (!arg.startsWith('-') && options.command === 'help') options.command = arg
    else unknown.push(arg)
  }
  return { options, unknown }
}

/** Terminal columns: CJK and full-width glyphs take two. */
function width(text) {
  let total = 0
  for (const char of String(text)) {
    const code = char.codePointAt(0) ?? 0
    total += (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff))) ? 2 : 1
  }
  return total
}

/** Left-align, measuring what a terminal actually measures. */
function pad(text, target) {
  const value = String(text)
  return value + ' '.repeat(Math.max(0, target - width(value)))
}

/** Right-align the same way. */
function padLeft(text, target) {
  const value = String(text)
  return ' '.repeat(Math.max(0, target - width(value))) + value
}

/* ------------------------------------------------------------------ files */

function readRows(file) {
  if (!existsSync(file)) return []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') rows.push(parsed)
    } catch {
      // A half-written last line is normal; skip it rather than lose the rest.
    }
  }
  return rows
}

/** Sessions per stance, the unit the experiment actually needs. */
function coverage(rows) {
  const stances = new Map()
  for (const row of rows) {
    const gear = row.mode === 'off' ? 'off' : row.gear
    if (typeof gear !== 'string' || gear.length === 0) continue
    const id = typeof row.sid === 'string' ? row.sid : ''
    if (!stances.has(gear)) stances.set(gear, { sessions: new Set(), steps: 0 })
    const stance = stances.get(gear)
    stance.steps += 1
    if (id.length > 0) stance.sessions.add(id)
  }
  return stances
}

/* --------------------------------------------------------------- commands */

function start(options) {
  const file = expandHome(options.bench)
  const gears = [...new Set(options.gears.filter((name) => name === 'off' || Object.hasOwn(GEARS, name)))]
  if (gears.length < 2) {
    process.stderr.write(`至少需要两个档位才能对比，收到: ${options.gears.join(',') || '空'}\n`)
    return 2
  }
  if (existsSync(file) && !options.force) {
    process.stdout.write(`实验已经在跑: ${file}\n` +
      '要换档位或重新开始，加 --force；要结束，用 stop。\n')
    return 0
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ enabled: true, gears }, null, 2)}\n`)
  process.stdout.write(`实验开始: ${file}\n` +
    `档位: ${gears.join(' / ')}（按 session id 哈希分配，新建会话生效）\n` +
    (gears.includes('off')
      ? 'off 是对照组：被分到的会话不加速，报告拿它当基准；其余档位自动开着跑，不用点小闪电。\n'
      : '这次没有 off 对照组，报告只能两档之间互比，不能回答「比不开快多少」。\n') +
    '同一类任务多跑几次再对比；面板上的开关是全局的，被分到 off 的会话实际不加速。\n' +
    `进度: dsh-fast-mode-experiment status --bench ${options.bench}\n`)
  return 0
}

function stop(options) {
  const file = expandHome(options.bench)
  if (!existsSync(file)) {
    process.stdout.write(`没有实验在跑（${file} 不存在）。\n`)
    return 0
  }
  rmSync(file)
  process.stdout.write(`实验已结束: ${file} 已删除。\n` +
    '之后的会话按插件配置里的档位运行；已测数据还在 metrics 文件里，可以随时报告。\n')
  return 0
}

function status(options) {
  const bench = expandHome(options.bench)
  const metrics = expandHome(options.metrics)
  let gears = DEFAULT_GEARS
  if (existsSync(bench)) {
    const assignment = createAssignment({ file: bench, gears: Object.keys(GEARS) })
    gears = (assignment.current && assignment.current.gears) || gears
  }
  const rows = readRows(metrics)
  const stances = coverage(rows)
  const buckets = new Map(summarise(rows).map(bucket => [bucket.mode === 'off' ? 'off' : bucket.gear, bucket]))

  const lines = []
  lines.push(`实验文件: ${existsSync(bench) ? bench : `${bench}（不在跑）`}`)
  lines.push(`测量文件: ${existsSync(metrics) ? metrics : `${metrics}（还没有数据）`}`)
  if (existsSync(bench)) lines.push(`档位: ${gears.join(' / ')}`)
  lines.push('')

  const wanted = [...new Set(existsSync(bench) ? gears : ['off', ...gears])]
  const labelWidth = Math.max(...wanted.map(name => width(name)), width('档位')) + 2
  lines.push(`${pad('档位', labelWidth)}${padLeft('会话', 6)}${padLeft('步数', 8)}${padLeft('模型耗时p50', 16)}`)
  let short = 0
  for (const gear of wanted) {
    const stance = stances.get(gear)
    const bucket = buckets.get(gear)
    const sessions = stance ? stance.sessions.size : 0
    if (!stance) short += 1
    const p50 = bucket && bucket.llmMsP50 !== undefined ? `${bucket.llmMsP50} ms` : '-'
    lines.push(
      `${pad(gear, labelWidth)}${padLeft(sessions, 6)}${padLeft(stance ? stance.steps : 0, 8)}${padLeft(p50, 16)}`,
    )
  }
  if (!stances.has('off')) short += 1
  lines.push('')
  if (existsSync(bench)) {
    if (!stances.has('off')) {
      lines.push('还没有关闭态的样本：对比需要一个反例。')
      lines.push('办法：先停掉实验、把小闪电关掉跑同样的任务，再 start 继续。')
    }
    if (short > 0) {
      lines.push(`还有 ${short} 个档位没有数据；每档至少 ${options.sessions} 个会话更有说服力。`)
    } else {
      lines.push(`每个档位都有数据了；每档至少 ${options.sessions} 个会话更有说服力。`)
    }
    lines.push('对比: dsh-fast-mode-report --since 7d')
  } else {
    lines.push('没有实验在跑；上面的数字只是历史记录。开始一个: dsh-fast-mode-experiment start')
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

/* ------------------------------------------------------------------- main */

async function main() {
  const { options, unknown } = parseArgs(process.argv.slice(2))
  if (options.command === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (unknown.length > 0) process.stderr.write(`忽略未知参数: ${unknown.join(' ')}\n`)
  if (options.command === 'start') return start(options)
  if (options.command === 'stop') return stop(options)
  if (options.command === 'status') return status(options)
  process.stderr.write(`未知命令: ${options.command}\n\n${USAGE}\n`)
  return 2
}

main().then(
  code => process.exit(code),
  (error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`)
    process.exit(1)
  },
)
