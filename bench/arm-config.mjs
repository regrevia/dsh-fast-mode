#!/usr/bin/env node
/**
 * Read one bench arm (`bench/arms/<arm>.yml`) and print the config the plugin
 * would actually run with.
 *
 * The arm files only carry the keys the experiment changes; the plugin fills the
 * rest from the schema defaults inside `resolveConfig`. Those defaults are what
 * decide whether a "switch off" arm is really off (the `disc-only` arm is the
 * cautionary example: it set `scheduler: false` while leaving the reminder that
 * needs the scheduler at `'late'`, so it measured nothing). Every resolved value
 * below therefore comes from the real code path, not from a copy of the defaults
 * in this file.
 *
 * Usage:
 *   node bench/arm-config.mjs bench/arms/def15.yml          # human table
 *   node bench/arm-config.mjs bench/arms/def15.yml --json   # one JSON object
 */
import { readFileSync } from 'node:fs'
import { resolveConfig } from '../src/effort.js'

/** Parse the two-level YAML the arm files use (`- id:` then `config:` map). */
export function parseArm(file) {
  const out = { id: '', config: {} }
  let inConfig = false
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const item = line.match(/^\s*-\s*id:\s*(.+)$/)
    if (item) {
      out.id = unquote(item[1])
      continue
    }
    const flow = line.match(/^\s*config:\s*\{(.*)\}\s*$/)
    if (flow) {
      for (const kv of splitFlow(flow[1])) {
        const m = kv.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
        if (m) out.config[m[1]] = scalar(m[2])
      }
      continue
    }
    if (/^\s*config:\s*$/.test(line)) {
      inConfig = true
      continue
    }
    if (!inConfig) continue
    const kv = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/)
    if (!kv) continue
    out.config[kv[1]] = scalar(kv[2])
  }
  return out
}

/** Split a YAML flow-mapping body on commas that are not inside `{}`/`[]`. */
function splitFlow(body) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of body) {
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      if (cur.trim()) parts.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

function unquote(s) {
  return String(s).trim().replace(/^['"]|['"]$/g, '')
}

function scalar(text) {
  const s = text.trim()
  if (s === '') return ''
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return unquote(s)
}

/** The subset of the resolved config that decides which reminders may fire. */
const POLICY_KEYS = [
  'enabled', 'gear', 'scheduler', 'guidance', 'lateDiscipline', 'discipline',
  'disciplineAfterSteps', 'disciplineRepeatAtSteps', 'disciplineEarlyCalls',
  'rereadHint', 'openBatch', 'preferPatch', 'batchVerify', 'shapeGate',
  'stepBudget', 'finishLineSteps', 'outputBudget', 'outputBudgetAfterSteps',
  'parallel', 'fanoutWidth', 'workspaceMap', 'stallGuard', 'toolTimeoutMs',
  'shellParallel', 'reassertAfterCompaction', 'lazy', 'lazyEffort', 'lazyVariant',
]

/** @param {string} file @returns {{arm: string, config: Record<string, unknown>, resolved: Record<string, unknown>}} */
export function armPolicy(file) {
  const arm = parseArm(file)
  const resolved = resolveConfig(arm.config)
  return {
    arm: arm.id || file,
    config: arm.config,
    resolved: Object.fromEntries(POLICY_KEYS.map(key => [key, resolved[key]])),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2]
  if (!arg) {
    console.error('usage: node bench/arm-config.mjs bench/arms/<arm>.yml [--json]')
    process.exit(2)
  }
  const info = armPolicy(arg)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(info))
  } else {
    console.log(`arm ${info.arm}`)
    for (const [key, value] of Object.entries(info.resolved)) {
      console.log(`  ${key.padEnd(24)} ${JSON.stringify(value)}`)
    }
  }
}
