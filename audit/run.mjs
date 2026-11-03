#!/usr/bin/env node
/**
 * A/B audit runner: does fast mode actually finish *your* repo's work sooner?
 *
 * The plugin's own numbers live in BENCHMARK.md, on the author's fixtures. They
 * are not evidence about anyone else's repository, so this script reproduces the
 * same measurement shape — paired arms, one task list, wall clock and output
 * tokens — on whatever repository you point --cwd at.
 *
 * ## What is actually measured
 *
 * - wall clock: process.hrtime.bigint() around the child process. Real elapsed
 *   time of one whole non-interactive run, not a sum of steps.
 * - output tokens: the fast-mode metrics journal rows whose `sid` is the session
 *   the run reported (`type: "session"`, `sessionId`). When the journal has
 *   nothing for that session, the `usage.outputTokens` that `dsh ... --json`
 *   prints on its `step_end` events. When neither exists the run is N/A;
 *   nothing is estimated.
 *
 * ## The arms
 *
 * Both arms load the same plugin package and differ only in `config.enabled`,
 * applied through a launcher `--patch` overlay written into the output
 * directory. `--arm-style auto` reads `--dump-config` once and picks an
 * id-targeted override when the profile already lists `fast-mode`, an insert
 * when it does not. --off-args / --on-args replace the whole overlay for a
 * profile that needs something else.
 *
 * ## Statistics
 *
 * Paired bootstrap over pairs (task x round), 4000 resamples, fixed seed,
 * percentile 2.5/97.5, geometric mean of the on/off ratio. A CI strictly below
 * 1 is faster, strictly above 1 is slower, a CI spanning 1 is "cannot tell from
 * this sample". Under 6 pairs no conclusion is printed at all — an interval
 * built from five numbers is decoration.
 *
 * Usage:
 *   node audit/run.mjs --tasks audit/tasks.example.jsonl --cwd . --rounds 3
 *   node audit/run.mjs --tasks my-tasks.jsonl --cwd ~/work/repo --dry-run
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The non-interactive entry detected on this machine (2026-11-02, dsh 0.2.1-rc.5).
 *
 * `command -v dsh` finds nothing: the desktop app does not put its bundled CLI on
 * PATH. The real entry is the app's own launcher, and the real subcommand is
 * `--profile <name>`; `dsh run` does not exist, `run` is read as a profile name
 * and fails with `profile "run" does not exist`. Verified from the launcher's own
 * help: `dsh --profile <name> [options] [task...]`, where --json writes
 * newline-delimited run events instead of the final message.
 *
 * The profile is `bench` because that is a profile where the plugin is actually
 * installed — `--profile bench --patch <off/on>.yml --dump-config` was seen
 * flipping `config.enabled` between false and true. `headless` has no
 * dsh-fast-mode in its node_modules, so an A/B there would compare an arm that
 * cannot be switched; `desktop` refuses (`profile "desktop" is managed
 * exclusively by the Electron application`). Both are why the profile is a flag
 * and the plugin's presence is probed rather than assumed.
 */
export const DETECTED = Object.freeze({
  node: 'node',
  bin: '/Applications/DSH-6G.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
  profile: 'bench',
  appArgs: ['--json'],
  evidence: 'node <bin> --profile bench --patch arm-on.yml --dump-config -> config.enabled: true',
})

export const MIN_PAIRS = 6
export const RESAMPLES = 4000
export const SEED = 20261102
export const TASK_TIMEOUT_MS = 15 * 60 * 1000
const PROBE_TIMEOUT_MS = 20 * 1000

/** Raised for anything the operator has to fix; printed without a stack. */
class UsageError extends Error {}

// ---------------------------------------------------------------- task list

/**
 * Parse the task list: one JSON object per line, {id, prompt, check?}.
 *
 * Blank lines and #-prefixed lines are skipped so a list can carry comments.
 * Every problem names the line number: a task list is edited by hand, and
 * "invalid JSON" without a line is useless.
 *
 * @param {string} text
 * @returns {{id: string, prompt: string, check: string|null, cwd: string|null, setup: string|null}[]}
 */
export function parseTasks(text) {
  const tasks = []
  const seen = new Set()
  String(text ?? '').split('\n').forEach((raw, index) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const where = `第 ${index + 1} 行`
    let row
    try {
      row = JSON.parse(line)
    } catch (error) {
      throw new UsageError(`${where}不是合法 JSON：${error.message}`)
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new UsageError(`${where}必须是 JSON 对象`)
    }
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (id === '') throw new UsageError(`${where}缺少非空 id`)
    if (seen.has(id)) throw new UsageError(`${where}的 id ${JSON.stringify(id)} 重复`)
    seen.add(id)
    if (typeof row.prompt !== 'string' || row.prompt.trim() === '') {
      throw new UsageError(`${where}（id=${id}）缺少非空 prompt`)
    }
    if (row.check !== undefined && row.check !== null && typeof row.check !== 'string') {
      throw new UsageError(`${where}（id=${id}）的 check 必须是字符串或 null`)
    }
    const check = typeof row.check === 'string' && row.check.trim() !== '' ? row.check : null
    if (row.cwd !== undefined && row.cwd !== null && (typeof row.cwd !== 'string' || row.cwd.trim() === '')) {
      throw new UsageError(`${where}（id=${id}）的 cwd 必须是绝对路径字符串`)
    }
    const taskCwd = typeof row.cwd === 'string' ? row.cwd.trim() : null
    if (row.setup !== undefined && row.setup !== null && typeof row.setup !== 'string') {
      throw new UsageError(`${where}（id=${id}）的 setup 必须是字符串或 null`)
    }
    const setup = typeof row.setup === 'string' && row.setup.trim() !== '' ? row.setup : null
    tasks.push({ id, prompt: row.prompt, check, cwd: taskCwd, setup })
  })
  if (tasks.length === 0) throw new UsageError('任务清单里没有任何任务')
  return tasks
}

// ---------------------------------------------------------------- statistics

/** Deterministic PRNG so a reported CI can be reproduced bit for bit. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Geometric mean. Returns null for an empty list; a non-positive value is
 * rejected rather than silently dropped, because a zero ratio can only come from
 * a broken measurement.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
export function geomean(values) {
  const nums = (values ?? []).filter(v => typeof v === 'number' && Number.isFinite(v))
  if (nums.length === 0) return null
  if (nums.some(v => v <= 0)) throw new UsageError('几何均值要求所有值 > 0')
  return Math.exp(nums.reduce((sum, v) => sum + Math.log(v), 0) / nums.length)
}

/** Percentile with linear interpolation between the two nearest samples. */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null
  const q = Math.min(1, Math.max(0, p)) * (sorted.length - 1)
  const lo = Math.floor(q)
  const hi = Math.ceil(q)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (q - lo)
}

/**
 * Paired bootstrap over ratios.
 *
 * A pair is one (task, round) unit measured in both arms, so resampling pair
 * indices keeps each task's off/on coupling intact. That is the whole point of
 * paired arms: the between-task spread is huge, and resampling arms
 * independently would drown the effect in it.
 *
 * @param {number[]} ratios on/off per pair, all > 0
 * @param {{resamples?: number, seed?: number}} [options]
 */
export function bootstrapCi(ratios, options = {}) {
  const values = (ratios ?? []).filter(v => typeof v === 'number' && Number.isFinite(v))
  const resamples = options.resamples ?? RESAMPLES
  const seed = options.seed ?? SEED
  if (values.length === 0) return { n: 0, center: null, lo: null, hi: null, resamples }
  if (values.some(v => v <= 0)) throw new UsageError('bootstrap 的比值必须 > 0')
  const center = geomean(values)
  const random = mulberry32(seed)
  const draws = new Array(resamples)
  for (let i = 0; i < resamples; i += 1) {
    let sum = 0
    for (let j = 0; j < values.length; j += 1) {
      sum += Math.log(values[Math.floor(random() * values.length)])
    }
    draws[i] = Math.exp(sum / values.length)
  }
  draws.sort((a, b) => a - b)
  return {
    n: values.length,
    center,
    lo: percentile(draws, 0.025),
    hi: percentile(draws, 0.975),
    resamples,
  }
}

/** on/off for one metric, or null when either side is missing. */
export function ratioOf(pair, metric) {
  const off = pair?.off?.[metric]
  const on = pair?.on?.[metric]
  const usable = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0
  if (!usable(off) || !usable(on)) return null
  return on / off
}

/**
 * The verdict, stated so it cannot be read as more than the sample supports.
 *
 * @param {{n: number, center: number|null, lo: number|null, hi: number|null}} ci
 * @param {string} label
 */
export function verdict(ci, label) {
  if (!ci || !Number.isFinite(ci.center)) return `${label}：无配对数据，不做结论。`
  if (ci.n < MIN_PAIRS) {
    return `${label}：样本不足（${ci.n} 对 < ${MIN_PAIRS} 对），不做结论。`
  }
  const pct = (v) => `${((1 - v) * 100).toFixed(1)}%`
  if (ci.hi < 1) {
    return `${label}：变快，几何均值 ${ci.center.toFixed(3)}×（CI ${ci.lo.toFixed(3)}–${ci.hi.toFixed(3)}），约省 ${pct(ci.center)}。`
  }
  if (ci.lo > 1) {
    return `${label}：变慢，几何均值 ${ci.center.toFixed(3)}×（CI ${ci.lo.toFixed(3)}–${ci.hi.toFixed(3)}），约多花 ${pct(ci.center)}。`
  }
  return `${label}：无法区分，几何均值 ${ci.center.toFixed(3)}×（CI ${ci.lo.toFixed(3)}–${ci.hi.toFixed(3)} 跨过 1），差异落在噪声范围内。`
}

/** Split pairs by task and summarise both metrics plus check pass counts. */
export function summarise(pairs, options = {}) {
  const minPairs = options.minPairs ?? MIN_PAIRS
  const rows = []
  const byTask = new Map()
  for (const pair of pairs ?? []) {
    if (!byTask.has(pair.id)) byTask.set(pair.id, [])
    byTask.get(pair.id).push(pair)
  }
  for (const [id, group] of byTask) {
    const wall = group.map(p => ratioOf(p, 'wallMs')).filter(v => v !== null)
    const tokens = group.map(p => ratioOf(p, 'tokens')).filter(v => v !== null)
    const wallCi = bootstrapCi(wall, options)
    const tokenCi = bootstrapCi(tokens, options)
    rows.push({
      id,
      n: group.length,
      wallCi,
      tokenCi,
      wallVerdict: verdict(wallCi, `${id} 墙钟`),
      tokenVerdict: tokenCi.n === 0
        ? `${id} 输出 token：该轮没有可用 token 数据（N/A），不估算。`
        : verdict(tokenCi, `${id} 输出 token`),
      offPass: group.filter(p => p.off?.check === 'pass').length,
      onPass: group.filter(p => p.on?.check === 'pass').length,
      checked: group.filter(p => typeof p.off?.check === 'string').length,
    })
  }
  const allWall = (pairs ?? []).map(p => ratioOf(p, 'wallMs')).filter(v => v !== null)
  const allTokens = (pairs ?? []).map(p => ratioOf(p, 'tokens')).filter(v => v !== null)
  const overallWall = bootstrapCi(allWall, options)
  const overallTokens = bootstrapCi(allTokens, options)
  const checked = (pairs ?? []).filter(p => typeof p.off?.check === 'string')
  return {
    rows,
    wall: overallWall,
    tokens: overallTokens,
    wallVerdict: verdict(overallWall, '合池墙钟'),
    tokenVerdict: overallTokens.n === 0
      ? '合池输出 token：没有可用的 token 数据（N/A），不估算。'
      : verdict(overallTokens, '合池输出 token'),
    insufficient: overallWall.n < minPairs,
    minPairs,
    checkOff: checked.filter(p => p.off.check === 'pass').length,
    checkOn: checked.filter(p => p.on.check === 'pass').length,
    checked: checked.length,
  }
}

// ------------------------------------------------------------ token reading

/**
 * Sum outputTokens from the --json run events.
 *
 * A step that had to retry reports usage only when every attempt reported it
 * (the headless projection drops a partial sum), so a missing field is treated
 * as missing, never as zero: absent tokens stay N/A instead of shaving the
 * average down.
 *
 * @param {string} text newline-delimited JSON events
 * @returns {{tokens: number|null, steps: number, sessionId: string|null}}
 */
export function usageFromEvents(text) {
  let tokens = 0
  let seen = false
  let steps = 0
  let sessionId = null
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event?.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId
    if (event?.type === 'status' && event.phase === 'step_end') {
      steps += 1
      const value = event.usage?.outputTokens
      if (typeof value === 'number' && Number.isFinite(value)) {
        tokens += value
        seen = true
      }
    }
  }
  return { tokens: seen ? tokens : null, steps, sessionId }
}

/**
 * Sum the metrics journal rows belonging to one session.
 *
 * The journal is the plugin's own record (~/.dsh/fast-mode-metrics.jsonl, or
 * DSH_FAST_MODE_METRICS_FILE), one row per step. Rows are matched by `sid`
 * rather than by byte offset, so a concurrent session cannot leak into the sum.
 * A journal that does not exist is not an error; it just means tokens are N/A.
 *
 * @param {string} file
 * @param {string|null} sessionId
 */
export function tokensFromJournal(file, sessionId) {
  if (!sessionId) return { tokens: null, steps: 0, rows: 0 }
  if (!existsSync(file)) return { tokens: null, steps: 0, rows: 0 }
  let text
  try {
    text = readJournalTail(file)
  } catch (error) {
    return { tokens: null, steps: 0, rows: 0, error: error.message }
  }
  let tokens = 0
  let rows = 0
  let steps = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!row || row.sid !== sessionId) continue
    rows += 1
    steps = Math.max(steps, Number.isFinite(row.step) ? row.step : steps)
    if (Number.isFinite(row.output)) tokens += row.output
  }
  return { tokens: rows > 0 ? tokens : null, steps, rows }
}

/**
 * Read the journal without loading 5 MB on every run.
 *
 * The tail is enough: one run's rows are written during that run, so they sit at
 * the end. The 8 MB window is far more than a single task can append.
 */
export function readJournalTail(file, window = 8 * 1024 * 1024) {
  const size = statSync(file).size
  const length = Math.min(size, window)
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, length, size - length)
  } finally {
    closeSync(fd)
  }
  const text = buffer.toString('utf8')
  // Drop the first, possibly partial, line when the window did not start at 0.
  return size > length ? text.slice(text.indexOf('\n') + 1) : text
}

/** Prefer the CLI's own event totals, then the journal; never guess. */
export function resolveTokens({ events, journal }) {
  if (Number.isFinite(events?.tokens) && events.tokens > 0) {
    return { tokens: events.tokens, source: 'cli --json step_end usage', steps: events.steps }
  }
  if (Number.isFinite(journal?.tokens) && journal.tokens > 0) {
    return { tokens: journal.tokens, source: 'metrics jsonl (sid match)', steps: journal.steps }
  }
  return { tokens: null, source: null, steps: events?.steps ?? 0 }
}

// ------------------------------------------------------------- command line

/**
 * Build the argv for one run.
 *
 * Launcher flags come first (--profile, --patch), then the app's own flags
 * (--json), then the task text as a single argument: the headless help joins
 * several words by spaces, so one argv element is correct and quoting never has
 * to survive a shell.
 */
export function buildArgv({ profile, appArgs, prompt, patch }) {
  const argv = []
  if (profile) argv.push('--profile', profile)
  if (patch) argv.push('--patch', patch)
  argv.push(...(appArgs ?? []))
  argv.push(prompt)
  return argv
}

/** POSIX-quote one argv element so a copy-paste runs the same thing. */
export function shellQuote(value) {
  const text = String(value)
  if (text !== '' && /^[A-Za-z0-9_./:=@%+-]+$/.test(text)) return text
  return `'${text.split("'").join(`'\\''`)}'`
}

/** The full command line, node and bin included, exactly as spawned. */
export function formatCommand(bin, argv, options = {}) {
  const parts = [options.node ?? DETECTED.node]
  if (bin) parts.push(bin)
  parts.push(...argv)
  return parts.map(shellQuote).join(' ')
}

// -------------------------------------------------------------- arm patches

/**
 * The two overlay files.
 *
 * Same plugin, same package, one switch flipped. `enabled: false` is the arm the
 * plugin's own schema documents, and it is what keeps this a fair A/B: both runs
 * pay for loading the package.
 */
/**
 * `--on-config` values keep their JavaScript type: a bare `true` must land as a
 * YAML boolean, not the string "true", or the plugin reads it as an override
 * string and the arm silently measures the default instead of the setting.
 */
export function parseConfigValue(raw) {
  const text = String(raw)
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return text
}

/** Split repeated `--on-config` entries into one object, rejecting junk keys. */
export function parseConfigPairs(values) {
  const out = {}
  for (const entry of values ?? []) {
    const at = entry.indexOf('=')
    if (at <= 0) throw new UsageError(`--on-config 要 key=value，收到 ${JSON.stringify(entry)}`)
    const key = entry.slice(0, at).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new UsageError(`--on-config 的键名不合法：${JSON.stringify(key)}`)
    out[key] = parseConfigValue(entry.slice(at + 1).trim())
  }
  return out
}

function yamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  return /^[A-Za-z0-9_./-]+$/.test(text) ? text : JSON.stringify(text)
}

export function armPatch(style, enabled, extra = {}) {
  // `config:` sits at 4 spaces in the insert form and at 2 in the override form, so
  // its children have to follow it. YAML that indents a key's children level with
  // the key is at best a parse error and at worst a different tree that loads.
  const insert = style === 'insert'
  const indent = insert ? '      ' : '    '
  // 覆盖来的键要顶掉同名的基础键：YAML 里同一个 key 写两遍，严格解析器会直接报错，
  // 宽松的只会留最后一个——两种结果都不该由一条 --on-config 决定。
  const merged = { enabled, gear: 'auto', ...extra }
  const config = Object.entries(merged).map(([key, value]) => `${indent}${key}: ${yamlScalar(value)}`)
  if (insert) {
    return ['- insert:', '  - id: fast-mode', '    name: dsh-fast-mode', '    config:', ...config, ''].join('\n')
  }
  return ['- id: fast-mode', '  config:', ...config, ''].join('\n')
}

// ------------------------------------------------------------------ process

/** Run one child to completion with a hard timeout. */
export function runOne({ bin, argv, cwd, timeoutMs, node }) {
  return new Promise((resolvePromise) => {
    const started = process.hrtime.bigint()
    const child = spawn(node ?? DETECTED.node, bin ? [bin, ...argv] : argv, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({
        ok: false,
        code: null,
        wallMs: Number(process.hrtime.bigint() - started) / 1e6,
        stdout,
        stderr: `${stderr}\nspawn error: ${error.message}`,
        timedOut,
      })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({
        ok: code === 0 && !timedOut,
        code,
        signal,
        wallMs: Number(process.hrtime.bigint() - started) / 1e6,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}

/**
 * The check command is written by the task author as a POSIX one-liner, so on
 * Windows it goes through ComSpec instead of a shell that is not there.
 */
const IS_WIN = process.platform === 'win32'
const CHECK_SHELL = IS_WIN ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
const checkArgv = (command) => (IS_WIN ? ['/d', '/s', '/c', command] : ['-c', command])
const checkShellLabel = IS_WIN ? `${CHECK_SHELL} /d /s /c` : '/bin/sh -c'

/** Run a task's check in the target repo; exit code 0 is a pass. */
async function runCheck({ command, cwd, timeoutMs }) {
  if (!command) return { status: 'none', code: null, wallMs: 0 }
  const started = process.hrtime.bigint()
  const result = await new Promise((resolvePromise) => {
    const child = spawn(CHECK_SHELL, checkArgv(command), { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.min(timeoutMs, TASK_TIMEOUT_MS))
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: null, stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stderr })
    })
  })
  return {
    status: result.code === 0 ? 'pass' : 'fail',
    code: result.code,
    wallMs: Number(process.hrtime.bigint() - started) / 1e6,
    stderr: result.stderr.slice(-2000),
  }
}

// -------------------------------------------------------------------- cli

const USAGE = `用法：node audit/run.mjs --tasks <tasks.jsonl> --cwd <repo> [选项]

选项：
  --tasks <file>        任务清单 JSONL（每行 {id, prompt, check?, cwd?}），必填
  --cwd <dir>           目标仓库，两个臂都在这里执行，默认当前目录
  --rounds <n>          每臂轮数，默认 3
  --dsh-bin <path>      dsh 启动脚本，默认用本机探测到的真实入口
  --dsh-node <path>     跑 dsh 用的 node，默认 node
  --profile <name>      启动的 profile，默认 headless
  --app-args <args>     profile 自己的参数，默认 "--json"
  --arm-style <mode>    auto（默认）| insert | override | none
  --off-args <args>     覆盖 off 臂的启动参数（替换 --patch 方案）
  --on-args <args>      覆盖 on 臂的启动参数
  --on-config <k=v>     给 on 臂加的配置项，可重复（例：--on-config compactResults=true）
  --metrics-file <path> fast-mode 指标 jsonl，默认 $DSH_FAST_MODE_METRICS_FILE 或 ~/.dsh/fast-mode-metrics.jsonl
  --timeout-ms <n>      单次运行超时，默认 900000
  --out <dir>           产物目录，默认 audit-out/<timestamp>
  --seed <n>            bootstrap 种子，默认 ${SEED}
  --resamples <n>       重采样次数，默认 ${RESAMPLES}
  --dry-run             只打印展开后的完整命令行，不执行任何东西
  -h, --help            这份帮助`

/** Minimal flag parser: --key value, --key=value, and boolean switches. */
export function parseArgs(argv) {
  const options = {
    tasks: null,
    cwd: process.cwd(),
    rounds: 3,
    dshBin: DETECTED.bin,
    dshNode: DETECTED.node,
    profile: DETECTED.profile,
    appArgs: [...DETECTED.appArgs],
    armStyle: 'auto',
    offArgs: null,
    onArgs: null,
    onConfig: [],
    metricsFile: null,
    timeoutMs: TASK_TIMEOUT_MS,
    out: null,
    seed: SEED,
    resamples: RESAMPLES,
    dryRun: false,
    help: false,
  }
  const takesValue = new Map([
    ['--tasks', 'tasks'], ['--cwd', 'cwd'], ['--rounds', 'rounds'], ['--dsh-bin', 'dshBin'],
    ['--dsh-node', 'dshNode'], ['--profile', 'profile'], ['--app-args', 'appArgs'],
    ['--arm-style', 'armStyle'], ['--off-args', 'offArgs'], ['--on-args', 'onArgs'],
    ['--metrics-file', 'metricsFile'], ['--timeout-ms', 'timeoutMs'], ['--out', 'out'],
    ['--seed', 'seed'], ['--resamples', 'resamples'],
  ])
  const numeric = new Set(['rounds', 'timeoutMs', 'seed', 'resamples'])
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '-h' || token === '--help') {
      options.help = true
      continue
    }
    if (token === '--dry-run') {
      options.dryRun = true
      continue
    }
    const split = token.indexOf('=')
    const flag = split === -1 ? token : token.slice(0, split)
    if (flag === '--on-config') {
      let entry = split === -1 ? argv[i + 1] : token.slice(split + 1)
      if (split === -1) i += 1
      if (entry === undefined) throw new UsageError('--on-config 缺少值')
      options.onConfig.push(entry)
      continue
    }
    if (!takesValue.has(flag)) throw new UsageError(`未知参数 ${token}，用 --help 看可用选项`)
    const key = takesValue.get(flag)
    let value = split === -1 ? argv[i + 1] : token.slice(split + 1)
    if (split === -1) i += 1
    if (value === undefined) throw new UsageError(`${flag} 缺少值`)
    if (numeric.has(key)) {
      const num = Number(value)
      if (!Number.isFinite(num) || num <= 0) throw new UsageError(`${flag} 必须是正数，收到 ${JSON.stringify(value)}`)
      options[key] = Math.floor(num)
    } else {
      options[key] = value
    }
  }
  return options
}

/** Split a --off-args string into argv elements without a shell. */
export function splitArgs(text) {
  if (text === null || text === undefined) return null
  const out = []
  let current = ''
  let quote = null
  for (const ch of String(text)) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current !== '') {
        out.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (quote) throw new UsageError(`引号没闭合：${text}`)
  if (current !== '') out.push(current)
  return out
}

function firstLine(text) {
  return String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean)[0] ?? ''
}

/**
 * Which overlay form the profile needs, from its own dumped config.
 *
 * `insert` appends a new entry; `override` patches the existing one by id. Doing
 * the wrong one is not a loud failure: insert leaves *two* fast-mode entries with
 * the second one's config winning, and override against an absent entry changes
 * nothing at all — the A/B then measures the same arm twice and reports a ratio
 * near 1.0 as if that were the answer.
 *
 * @param {string} dumpText
 * @returns {'insert'|'override'}
 */
export function patchStyleFor(dumpText) {
  const text = String(dumpText ?? '')
  for (const line of text.split('\n')) {
    if (/^\s*-\s*id:\s*fast-mode\s*$/.test(line)) return 'override'
  }
  return 'insert'
}

/**
 * Read-only probe: which dsh is this, and does the profile already list the
 * plugin? Both answers change the command, so both are asked once up front, and
 * a profile that cannot be dumped is a hard stop — an A/B on a profile whose arms
 * cannot be toggled measures nothing.
 */
export async function probe({ bin, node, profile, cwd }) {
  const findings = []
  const reason = (result) => firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`
  const help = await runOne({ bin, node, argv: ['--help'], cwd, timeoutMs: PROBE_TIMEOUT_MS })
  findings.push({ step: `${node} ${bin} --help`, ok: help.ok, code: help.code, firstLine: firstLine(help.stdout) })
  if (!help.ok) return { ok: false, findings, listsFastMode: false, reason: reason(help) }
  const dump = await runOne({ bin, node, argv: ['--profile', profile, '--dump-config'], cwd, timeoutMs: 60 * 1000 })
  const listsFastMode = dump.ok && patchStyleFor(dump.stdout) === 'override'
  findings.push({
    step: `${node} ${bin} --profile ${profile} --dump-config`,
    ok: dump.ok,
    code: dump.code,
    listsFastMode,
  })
  return { ok: dump.ok, findings, listsFastMode, reason: dump.ok ? null : reason(dump) }
}

/** audit-out/2026-11-02T21-30-00Z: sortable, no colons in a filename. */
function stamp(date = new Date()) {
  return date.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z')
}

function fmtPct(numerator, denominator) {
  return denominator > 0 ? `${numerator}/${denominator}` : '—/—'
}

function cell(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'N/A'
}

function cellCi(ci) {
  return Number.isFinite(ci?.center) ? `[${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]` : 'N/A'
}

function judge(wallCi, n, minPairs) {
  if (n < minPairs) return '样本不足'
  if (wallCi.hi < 1) return '变快'
  if (wallCi.lo > 1) return '变慢'
  return '无法区分'
}

/** The markdown the operator keeps: Chinese tables, verdicts as computed. */
export function renderReport({ meta, tasks, pairs, summary }) {
  const lines = []
  lines.push('# fast-mode A/B 审计报告', '')
  lines.push(`- 时间：${meta.startedAt}`)
  lines.push(`- 目标仓库：${meta.cwd}`)
  lines.push(`- dsh：${meta.command}`)
  lines.push(`- off 臂：${meta.offLabel}`)
  lines.push(`- on 臂：${meta.onLabel}`)
  lines.push(`- 每臂轮数：${meta.rounds}（串行，一次只跑一个进程）`)
  lines.push(`- 墙钟：process.hrtime 包裹子进程；输出 token：${meta.tokenSource}`)
  lines.push(`- 配对 bootstrap：${meta.resamples} 次重采样，种子 ${meta.seed}，percentile 2.5/97.5，几何均值比 on/off（<1 表示变快）`)
  lines.push('')
  lines.push('## 合池结论', '')
  lines.push(`- ${summary.wallVerdict}`)
  lines.push(`- ${summary.tokenVerdict}`)
  if (summary.checked > 0) {
    lines.push(`- 校验命令通过：off ${fmtPct(summary.checkOff, summary.checked)}，on ${fmtPct(summary.checkOn, summary.checked)}`)
  }
  lines.push('')
  lines.push('## 逐任务', '')
  lines.push('| 任务 | 对 | 墙钟比 | 墙钟 CI | token 比 | token CI | 校验 off/on | 墙钟结论 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const row of summary.rows) {
    lines.push(`| ${row.id} | ${row.n} | ${cell(row.wallCi.center)} | ${cellCi(row.wallCi)} | ${cell(row.tokenCi.center)} | ${cellCi(row.tokenCi)} | ${fmtPct(row.offPass, row.checked)} / ${fmtPct(row.onPass, row.checked)} | ${judge(row.wallCi, row.n, summary.minPairs)} |`)
  }
  lines.push('')
  if (summary.insufficient) {
    lines.push(`> 样本不足：合池只有 ${summary.wall.n} 对（少于 ${summary.minPairs} 对），上面的区间只当噪声描述，不构成结论。加 --rounds 或加任务再来一次。`)
    lines.push('')
  }
  lines.push('## 怎么读这张表', '')
  lines.push('- 比值 <1 是 on 臂更快；CI 完全在 1 以下才算「这次量到了」；CI 跨 1 只说明这组样本分不开。')
  lines.push('- 墙钟含进程启动、模型往返、工具等待和校验前的全部时间，与仓库 BENCHMARK.md 口径一致。')
  lines.push(`- token 来自 ${meta.metricsFile}（按 session id 归集）或 --json 的 step_end.usage.outputTokens；两者都没有就写 N/A，不估算。`)
  lines.push('- 任务太短（几秒）时启动开销占比很高，比值会被拉向 1：这是测法的问题，不是插件的问题。')
  lines.push('')
  lines.push(`任务数：${tasks.length}；配对数：${pairs.length}。`)
  lines.push('')
  return lines.join('\n')
}

// -------------------------------------------------------------------- main

/** One arm's reading for one task round. */
async function measureArm({ item, arm, style, options, cwd, metricsFile }) {
  // A task may name its own checkout, so one task list can mix repositories.
  const taskCwd = item.task.cwd ? resolve(item.task.cwd) : cwd
  const patch = style === 'patch' ? item.patches[arm] : undefined
  const empty = {
    wallMs: 0, tokens: null, tokenSource: 'none', steps: 0, exitCode: null, timedOut: false,
    sessionId: null, ok: false, setupFail: true, check: null, checkCode: null, checkWallMs: 0, stderrTail: '',
  }
  if (item.task.setup) {
    // Real-PR tasks mutate their checkout, so every round starts from the same tree.
    // A setup that cannot restore it is reported, never silently measured.
    const reset = await runCheck({ command: item.task.setup, cwd: taskCwd, timeoutMs: options.timeoutMs })
    if (reset.status !== 'pass') {
      return { ...empty, stderrTail: String(reset.stderr ?? '').slice(-600) }
    }
  }
  const argv = buildArgv({
    profile: options.profile,
    appArgs: options.appArgs,
    prompt: item.task.prompt,
    patch,
  })
  const result = await runOne({ bin: options.dshBin, node: options.dshNode, argv, cwd: taskCwd, timeoutMs: options.timeoutMs })
  const events = usageFromEvents(result.stdout)
  const journal = tokensFromJournal(metricsFile, events.sessionId)
  const tokenInfo = resolveTokens({ events, journal })
  const check = await runCheck({ command: item.task.check, cwd: taskCwd, timeoutMs: options.timeoutMs })
  return {
    wallMs: Math.round(result.wallMs),
    tokens: tokenInfo.tokens,
    tokenSource: tokenInfo.source,
    steps: tokenInfo.steps,
    exitCode: result.code,
    timedOut: result.timedOut,
    sessionId: events.sessionId,
    ok: result.ok,
    check: item.task.check ? check.status : null,
    checkCode: check.code,
    checkWallMs: Math.round(check.wallMs),
    stderrTail: result.ok ? '' : result.stderr.slice(-600),
  }
}

async function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!options.tasks) throw new UsageError('缺少 --tasks；先复制 audit/tasks.example.jsonl 改成你自己的任务')
  const cwd = resolve(options.cwd)
  if (!existsSync(cwd)) throw new UsageError(`--cwd 不存在：${cwd}`)
  let taskText
  try {
    taskText = readFileSync(resolve(options.tasks), 'utf8')
  } catch (error) {
    throw new UsageError(`读不到任务清单 ${options.tasks}：${error.code ?? error.message}`)
  }
  const tasks = parseTasks(taskText)
  for (const task of tasks) {
    if (task.cwd && !existsSync(task.cwd)) {
      throw new UsageError(`任务 ${task.id} 的 cwd 不存在：${task.cwd}`)
    }
  }
  const metricsFile = resolve(options.metricsFile
    ?? process.env.DSH_FAST_MODE_METRICS_FILE
    ?? join(homedir(), '.dsh', 'fast-mode-metrics.jsonl'))

  const outDir = resolve(options.out ?? join('audit-out', stamp()))
  const customArgs = options.offArgs !== null || options.onArgs !== null
  let style
  let probeFindings = []
  if (customArgs) {
    style = 'args'
  } else if (options.armStyle === 'none') {
    style = 'none'
  } else if (options.armStyle === 'insert' || options.armStyle === 'override') {
    style = 'patch'
  } else if (options.dryRun) {
    // A dry run must not spawn anything, so the profile is not queried here.
    style = 'patch'
  } else {
    const result = await probe({ bin: options.dshBin, node: options.dshNode, profile: options.profile, cwd })
    probeFindings = result.findings
    if (!result.ok) {
      throw new UsageError([
        `profile ${options.profile} 探测失败：${result.reason}`,
        '换一个装了 dsh-fast-mode 的 profile（--profile <名字>），或指定 --dsh-bin。',
        '看看有哪些 profile：ls ~/.dsh/profiles；确认插件在里面：ls ~/.dsh/profiles/<名字>/node_modules/dsh-fast-mode',
      ].join('\n'))
    }
    if (!result.listsFastMode) {
      throw new UsageError([
        `profile ${options.profile} 里没有 fast-mode 条目，没法做 A/B：on 臂插进去了也不会生效。`,
        '在装了插件的 profile 上跑，或者先按 README 把它加进该 profile。',
      ].join('\n'))
    }
    style = 'patch'
    options.armStyle = 'override'
  }
  const patchStyle = style === 'patch' ? (options.armStyle === 'override' ? 'override' : 'insert') : null
  const onConfig = options.onConfig.length > 0 ? parseConfigPairs(options.onConfig) : {}

  const patches = {
    off: join(outDir, 'arm-off.patch.yml'),
    on: join(outDir, 'arm-on.patch.yml'),
  }
  const armArgs = {
    off: customArgs ? (splitArgs(options.offArgs) ?? []) : null,
    on: customArgs ? (splitArgs(options.onArgs) ?? []) : null,
  }
  const items = tasks.map(task => ({ task, patches }))

  if (options.dryRun) {
    const lines = []
    lines.push('# dry-run：不执行任何命令，只展开真实命令行')
    lines.push(`# dsh bin：${options.dshBin}`)
    lines.push(`# profile：${options.profile}；app args：${options.appArgs.join(' ')}`)
    lines.push(`# 臂样式：${style === 'patch' ? `${patchStyle}（${options.armStyle === 'auto' ? 'auto 未探测，实跑会先用 --dump-config 判断' : '显式指定，不探测'}）` : style}`)
    lines.push(`# 目标仓库：${cwd}`)
    lines.push(`# 产物目录：${outDir}`)
    lines.push('')
    for (const item of items) {
      for (const arm of ['off', 'on']) {
        const argvForRun = buildArgv({
          profile: options.profile,
          appArgs: [...options.appArgs, ...(armArgs[arm] ?? [])],
          prompt: item.task.prompt,
          patch: style === 'patch' ? patches[arm] : undefined,
        })
        lines.push(`${item.task.id} [${arm}] ${formatCommand(options.dshBin, argvForRun, { node: options.dshNode })}`)
        if (item.task.check) {
          lines.push(`${item.task.id} [${arm}] check: ${checkShellLabel} ${shellQuote(item.task.check)}   (cwd=${cwd})`)
        }
      }
    }
    if (style === 'patch') {
      lines.push('')
      lines.push(`# ${patches.off}（实跑时才写盘）`)
      for (const line of armPatch(patchStyle, false).trimEnd().split('\n')) lines.push(`#   ${line}`)
      lines.push(`# ${patches.on}`)
      for (const line of armPatch(patchStyle, true, onConfig).trimEnd().split('\n')) lines.push(`#   ${line}`)
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  }

  mkdirSync(outDir, { recursive: true })
  if (style === 'patch') {
    writeFileSync(patches.off, armPatch(patchStyle, false))
    writeFileSync(patches.on, armPatch(patchStyle, true, onConfig))
  }

  const startedAt = new Date().toISOString()
  const pairs = []
  const failures = []
  for (let round = 1; round <= options.rounds; round += 1) {
    for (const item of items) {
      const record = { id: item.task.id, round, off: null, on: null }
      for (const arm of ['off', 'on']) {
        const reading = await measureArm({ item, arm, style, options, cwd, metricsFile })
        record[arm] = reading
        if (reading.setupFail) {
          failures.push(`${item.task.id} [${arm}] round ${round}: setup 失败`)
        }
        if (!reading.ok) {
          failures.push(`${item.task.id} [${arm}] round ${round}: exit ${reading.exitCode}${reading.timedOut ? '（超时）' : ''}`)
        }
        process.stderr.write(`[${round}/${options.rounds}] ${item.task.id} ${arm}: ${reading.wallMs} ms，token ${reading.tokens ?? 'N/A'}\n`)
      }
      if (record.off?.setupFail || record.on?.setupFail) continue
      pairs.push(record)
      writeFileSync(join(outDir, 'pairs.jsonl'), `${pairs.map(p => JSON.stringify(p)).join('\n')}\n`)
    }
  }

  const summary = summarise(pairs, { seed: options.seed, resamples: options.resamples })
  const meta = {
    startedAt,
    cwd,
    command: formatCommand(options.dshBin, ['--profile', options.profile, ...options.appArgs, '<prompt>'], { node: options.dshNode }),
    offLabel: style === 'patch' ? `--patch ${patches.off}（enabled: false）` : style === 'args' ? options.offArgs : '不加任何覆盖',
    onLabel: style === 'patch' ? `--patch ${patches.on}（enabled: true）` : style === 'args' ? options.onArgs : '不加任何覆盖',
    rounds: options.rounds,
    tokenSource: pairs.some(p => p.off?.tokens || p.on?.tokens)
      ? 'metrics jsonl 按 session id 归集，缺失时回落到 --json 的 step_end.usage.outputTokens'
      : 'N/A（这次一个 token 字段都没拿到，只报墙钟）',
    metricsFile,
    resamples: options.resamples,
    seed: options.seed,
    probe: probeFindings,
  }
  writeFileSync(join(outDir, 'report.md'), renderReport({ meta, tasks, pairs, summary }))
  process.stdout.write(`${outDir}\n${summary.wallVerdict}\n${summary.tokenVerdict}\n`)
  if (failures.length > 0) {
    process.stderr.write(`\n有 ${failures.length} 次运行失败（没有从样本里剔除，报告记的是它的真实耗时）：\n`)
    for (const line of failures) process.stderr.write(`  - ${line}\n`)
  }
  return 0
}

/** True when this file is the process entry, so importing it in tests is inert. */
function isEntry() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (isEntry()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  }).catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`audit: ${error.message}\n`)
      process.exitCode = 2
      return
    }
    process.stderr.write(`audit: ${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}
