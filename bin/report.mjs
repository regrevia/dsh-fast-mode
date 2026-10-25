#!/usr/bin/env node
/**
 * Read the fast-mode measurement file and print the comparison it exists for:
 * did a gear actually finish steps faster, and what did that cost in tokens.
 *
 * The measurement file is written by the plugin itself (one JSON line per model
 * step), which is why this report can compare *off* sessions with *on* sessions:
 * both are recorded by the same code, in the same format, on the same machine.
 *
 * Usage:
 *   node bin/report.mjs                     # ~/.dsh/fast-mode-metrics.jsonl
 *   node bin/report.mjs --file ./m.jsonl    # another sink
 *   node bin/report.mjs --since 2d          # last two days only
 *   node bin/report.mjs --json              # machine readable
 *   node bin/report.mjs --lan               # also join the LAN usage dashboard
 *
 * The LAN half is optional and read-only: it asks the self-hosted dashboard for
 * recent sessions and matches them by session id. Its credential is never in
 * this file, never in the repository, and never in the output — it is read from
 * the USAGE_TOKEN environment variable. Without that variable the flag says so
 * and does nothing.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { compare, summarise } from '../src/metrics.js'

const DEFAULT_FILE = '~/.dsh/fast-mode-metrics.jsonl'
const DEFAULT_BASE = 'http://192.168.11.18:30054'

/** Expand a leading `~`. */
function expandHome(file) {
  if (file === '~') return homedir()
  if (file.startsWith('~/')) return join(homedir(), file.slice(2))
  return file
}

/** Parse `argv` into a small flag map. Unknown flags are reported, not ignored. */
function parseArgs(argv) {
  const options = { file: DEFAULT_FILE, json: false, lan: false, since: undefined, help: false }
  const unknown = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--lan') options.lan = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--file') options.file = argv[++index] ?? ''
    else if (arg === '--since') options.since = argv[++index] ?? ''
    else unknown.push(arg)
  }
  return { options, unknown }
}

/**
 * A `--since` window: `2d`, `12h`, `90m` or anything `Date.parse` accepts.
 *
 * @param {string|undefined} text
 * @returns {number|undefined} epoch milliseconds
 */
function parseSince(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  const relative = /^(\d+(?:\.\d+)?)([dhm])$/.exec(text)
  if (relative) {
    const amount = Number(relative[1])
    const unit = { d: 86400000, h: 3600000, m: 60000 }[relative[2]]
    return Date.now() - amount * unit
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Read one file; a missing file is "nothing here", not an error. */
function readText(file) {
  try {
    return { text: readFileSync(file, 'utf8'), missing: false }
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    if (code === 'ENOENT') return { text: '', missing: true }
    throw error
  }
}

/**
 * Read a JSONL sink, including its one rotated generation.
 *
 * The writer rotates at `METRICS_ROTATE_BYTES` and keeps `<file>.1`; a report
 * that ignored it would lose all history the moment rotation ran.
 */
function readRows(file) {
  const current = readText(file)
  const rotated = readText(`${file}.1`)
  if (current.missing && rotated.missing) return { rows: [], missing: true }
  const text = `${rotated.text}${rotated.text ? '\n' : ''}${current.text}`
  const rows = []
  let broken = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const row = JSON.parse(trimmed)
      if (row && typeof row === 'object') rows.push(row)
      else broken += 1
    } catch {
      broken += 1
    }
  }
  return { rows, missing: false, broken }
}

/** Display width, counting CJK as two columns. */
function width(text) {
  let total = 0
  for (const char of String(text)) {
    const code = char.codePointAt(0) ?? 0
    total += (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6))) ? 2 : 1
  }
  return total
}

/** Pad to a display width. */
function pad(text, target, align = 'left') {
  const value = text === undefined || text === null ? '-' : String(text)
  const space = Math.max(0, target - width(value))
  return align === 'right' ? ' '.repeat(space) + value : value + ' '.repeat(space)
}

/** Render an aligned table. */
function table(headers, aligns, rows) {
  const widths = headers.map((header, index) => Math.max(
    width(header),
    ...rows.map(row => width(row[index] ?? '-')),
  ))
  const line = cells => cells.map((cell, index) => pad(cell, widths[index], aligns[index])).join('  ')
  return [line(headers), widths.map(size => '-'.repeat(size)).join('  '), ...rows.map(line)].join('\n')
}

/** A number, or `-`. */
const show = value => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '-')

/** A ratio with an `×` suffix, or `-`. */
const ratio = value => (typeof value === 'number' && Number.isFinite(value) ? `${value}×` : '-')

/**
 * The main comparison table: one row per stance, ordered off → safe → fast → …
 */
function renderStances(buckets) {
  const order = ['off', 'safe', 'fast', 'turbo', 'max', 'ludicrous']
  const rank = gear => {
    const index = order.indexOf(gear)
    return index < 0 ? order.length : index
  }
  const sorted = [...buckets].sort((a, b) => {
    if (a.mode !== b.mode) return a.mode === 'off' ? -1 : b.mode === 'off' ? 1 : a.mode.localeCompare(b.mode)
    return rank(a.gear) - rank(b.gear)
  })
  const rows = sorted.map((bucket) => {
    const label = bucket.mode === 'off' ? '关闭' : `${bucket.gear}${bucket.mode === 'on' ? '' : ` (${bucket.mode})`}`
    return [
      label,
      show(bucket.sessions),
      show(bucket.steps),
      show(bucket.stepsPerTurn),
      show(bucket.stepMsP50),
      show(bucket.stepMsP90),
      show(bucket.llmMsP50),
      show(bucket.ttftMsP50),
      show(bucket.outputPerStep),
      show(bucket.outputPerSession),
      show(bucket.callsPerStep),
      show(bucket.multiCallSteps),
    ]
  })
  return table(
    ['档位', '会话', '步数', '步/轮', '步耗时p50', '步耗时p90', '模型耗时p50', '首字p50', '输出tok/步', '输出tok/会话', '工具/步', '多调步'],
    ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
    rows,
  )
}

/** The speedup table: each gear against the off baseline. */
function renderSpeedups(buckets) {
  const baseline = buckets.find(bucket => bucket.mode === 'off')
  if (!baseline) return undefined
  const rows = buckets
    .filter(bucket => bucket.mode === 'on')
    .map((bucket) => {
      const delta = compare(baseline, bucket) ?? {}
      return [
        bucket.gear,
        show(bucket.steps),
        ratio(delta.speedupLlm),
        ratio(delta.speedupStep),
        ratio(delta.outputRatio),
        ratio(delta.tokensPerSessionRatio),
        ratio(delta.callsRatio),
      ]
    })
  if (rows.length === 0) return undefined
  return table(
    ['档位', '步数', '模型耗时倍率', '步耗时倍率', '输出tok/步倍率', '输出tok/会话倍率', '工具/步倍率'],
    ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
    rows,
  )
}

/** The dashboard's coarsest matching window for a `--since` cutoff. */
function windowOf(since) {
  if (since === undefined) return '7d'
  const days = (Date.now() - since) / 86400000
  if (days <= 1) return '1d'
  if (days <= 7) return '7d'
  return '30d'
}

/**
 * Ask the LAN dashboard for recent sessions and match them to what we measured.
 *
 * Read-only, LAN-only, and deliberately tolerant: the dashboard is somebody
 * else's service, so a shape change prints a note instead of failing the report.
 *
 * @param {any[]} rows
 * The dashboard's own window is coarse (`1d` / `7d` / `30d`), so it follows the
 * `--since` window instead of always asking for one day and silently dropping
 * the sessions an experiment spent a week collecting.
 *
 * @param {{base?: string, token?: string, range?: string}} settings
 */
async function fetchLanSessions(rows, settings) {
  const base = (settings.base ?? DEFAULT_BASE).replace(/\/+$/, '')
  const token = settings.token
  const range = settings.range ?? '7d'
  if (typeof token !== 'string' || token.length === 0) {
    return { note: '--lan 需要环境变量 USAGE_TOKEN（Bearer token），未提供则跳过。' }
  }
  // The dashboard is somebody else's service on the LAN: unreachable, slow and
  // unauthorised are all ordinary outcomes, and none of them may cost the user
  // the local report they already have.
  let response
  try {
    response = await fetch(`${base}/api/v1/sessions/recent?page=1&pageSize=50&range=${range}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    })
  } catch (error) {
    const cause = error && typeof error === 'object' ? error.cause : undefined
    const reason = (cause && (cause.code || cause.message)) || (error && error.message) || String(error)
    return { note: `--lan 请求失败：${reason}` }
  }
  if (!response.ok) return { note: `--lan 请求失败：HTTP ${response.status}` }
  const payload = await response.json().catch(() => undefined)
  const list = payload && payload.data && Array.isArray(payload.data.list) ? payload.data.list : undefined
  if (!list) return { note: '--lan 响应格式不符合预期（缺少 data.list）。' }

  const seen = new Map()
  for (const row of rows) {
    if (typeof row.sid === 'string' && !seen.has(row.sid)) {
      seen.set(row.sid, { gear: row.mode === 'off' ? 'off' : row.gear, steps: 0 })
    }
    const found = typeof row.sid === 'string' ? seen.get(row.sid) : undefined
    if (found) found.steps += 1
  }

  const matched = []
  for (const session of list) {
    const id = session && typeof session === 'object' ? session.id : undefined
    const mine = typeof id === 'string' ? seen.get(id) : undefined
    if (!mine) continue
    const stats = session.tokenStats && typeof session.tokenStats === 'object' ? session.tokenStats : {}
    matched.push({
      sid: id,
      gear: mine.gear,
      steps: mine.steps,
      model: session.modelName,
      tokens: typeof stats.total_tokens === 'number' ? stats.total_tokens : undefined,
      input: typeof stats.input_tokens === 'number' ? stats.input_tokens : undefined,
      output: typeof stats.output_tokens === 'number' ? stats.output_tokens : undefined,
      seconds: typeof session.durationSeconds === 'number' ? session.durationSeconds : undefined,
      createdAt: session.createdAt,
    })
  }
  return { matched, listed: list.length, note: matched.length === 0 ? '本机测量文件里的会话 id 未出现在面板最近 50 条中（面板只保留近 1 天）。' : undefined }
}

/** Print the LAN half. */
function renderLan(lan) {
  if (!lan || lan.note) return lan?.note ?? ''
  const rows = lan.matched.map(session => [
    session.gear,
    String(session.sid).slice(0, 8),
    show(session.steps),
    session.model ?? '-',
    show(session.tokens),
    show(session.input),
    show(session.output),
    show(session.seconds),
    typeof session.createdAt === 'string' ? session.createdAt.replace('T', ' ').slice(0, 19) : '-',
  ])
  return table(
    ['档位', '会话', '本机步数', '上游模型', '总tok', '输入tok', '输出tok', '面板时长s', '创建时间'],
    ['left', 'left', 'right', 'left', 'right', 'right', 'right', 'right', 'left'],
    rows,
  )
}

const USAGE = `用法: dsh-fast-mode-report [选项]

  --file <path>   测量文件，默认 ~/.dsh/fast-mode-metrics.jsonl
  --since <when>  只看最近一段：2d / 12h / 90m，或任意可解析的时间
  --json          输出机器可读的 JSON
  --lan           同时对照局域网用量面板（需要 USAGE_TOKEN 环境变量）
  -h, --help      显示本帮助

测量文件由插件自动写入：每个模型步一行，包含档位、首字延迟、模型耗时、
输出 token、工具调用数。关闭（off）与开启的会话都会记录，否则无法对比。
`

async function main() {
  const { options, unknown } = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (unknown.length > 0) process.stderr.write(`忽略未知参数: ${unknown.join(' ')}\n`)

  const file = expandHome(options.file)
  const { rows, missing, broken } = readRows(file)
  const since = parseSince(options.since)
  const filtered = since === undefined
    ? rows
    : rows.filter(row => {
      const time = typeof row.ts === 'string' ? Date.parse(row.ts) : Number.NaN
      return Number.isNaN(time) ? true : time >= since
    })
  const buckets = summarise(filtered)
  const lan = options.lan ? await fetchLanSessions(filtered, {
    base: process.env.USAGE_BASE,
    token: process.env.USAGE_TOKEN,
    range: windowOf(since),
  }) : undefined

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ file, total: rows.length, used: filtered.length, since: options.since, buckets, lan }, null, 2)}\n`)
    return 0
  }

  if (missing) {
    process.stdout.write(`没有测量文件：${file}\n\n`
      + '插件默认开启计量。确认 fast-mode 已启用，并在任意会话里跑一轮，然后再看。\n')
    return 0
  }

  const stances = renderStances(buckets)
  const speedups = renderSpeedups(buckets)
  const off = filtered.filter(row => row.mode === 'off').length
  const on = filtered.length - off

  process.stdout.write(`测量文件: ${file}\n`)
  process.stdout.write(`行数: ${rows.length}${broken ? `（跳过无法解析的 ${broken} 行）` : ''}`
    + ` / 本次统计: ${filtered.length} 步（开启 ${on}，关闭 ${off}）${options.since ? `，区间 ${options.since}` : ''}\n\n`)
  process.stdout.write(`${stances}\n`)

  if (speedups) {
    process.stdout.write(`\n相对关闭状态的均值/中位数对比（>1× 表示该档位更快/更贵）：\n${speedups}\n`)
  } else if (off === 0) {
    process.stdout.write('\n没有关闭状态的样本，无法计算倍率。'
      + '对比需要两边都有数据：先把小闪电关掉跑同样的任务，再开启跑一遍。\n')
  }

  if (lan) {
    process.stdout.write('\n局域网用量面板对照（read-only）：\n')
    const rendered = renderLan(lan)
    if (rendered) process.stdout.write(`${rendered}\n`)
  }

  process.stdout.write('\n口径说明：\n'
    + '- 比较单位是「模型步」，不是整个会话：会话墙钟还包含人读和打字的时间。\n'
    + '- 模型耗时 = step/start 到最后一条 assistant/message；首字 = step/start 到第一条。\n'
    + '- 输出 token 是上游 usage 的实测值；倍率基于各档位均值，样本少时会抖动。\n'
    + '- 面板里的 durationSeconds 是整段会话时长，只能旁证，不能替代步级对比。\n')
  return 0
}

main().then(
  code => process.exit(code),
  error => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`)
    process.exit(1)
  },
)
