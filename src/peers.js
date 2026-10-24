/**
 * Peer detection: which installed plugin already does part of this one's job.
 *
 * Two plugins overlap with fast mode, and neither can be made to compose with it
 * honestly:
 *
 * - **`dsh-batch-tool-calls`** registers its own batching policy section. Fast
 *   mode registers a superset of that text (gear-aware, per-session, plus the
 *   output discipline and the stall rules), so enabling both pays the prompt
 *   twice and lets the two texts disagree about the fan-out target.
 * - **`dsh-ops`** replaces the shell and file tools with its own (`ops_bash`,
 *   `ops_grep`, `ops_glob`, …) and only ships Windows x64 binaries. Fast mode's
 *   guidance describes what to do with *the* shell — bound the call, background
 *   a server, avoid a heredoc — and with `dsh-ops` installed there are two
 *   shells and two policies to satisfy.
 *
 * Detection has to be cheap and must not depend on a service being mounted at
 * load time, because the composition order is not ours. Two independent probes:
 *
 * 1. **The install record.** The profile's `package.json` lists every bundle and
 *    dependency; a peer that is installed but currently disabled is still a
 *    conflict the user should know about before they re-enable it.
 * 2. **A live registry probe.** `tools.get('ops_bash')` answers whether the ops
 *    tools are actually registered for this agent, which catches a peer that was
 *    wired without a package entry.
 *
 * @module dsh-fast-mode/peers
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The plugin ids this one supersedes, in reporting order. */
export const PEER_PLUGINS = Object.freeze(['dsh-batch-tool-calls', 'dsh-ops'])

/** Tool names that only exist when `dsh-ops` is live. */
const OPS_TOOLS = Object.freeze(['ops_bash', 'ops_grep', 'ops_glob', 'ops_inspect_local_file', 'ops_replace'])

/**
 * Does `text` mention the package `id` as a package name?
 *
 * A plain `includes` would match `dsh-ops-tools` or a comment that merely
 * mentions the peer, so the id must be followed by a version/range separator or
 * the end of a quoted string.
 *
 * @param {string} text
 * @param {string} id
 */
function mentionsPackage(text, id) {
  if (typeof text !== 'string' || text.length === 0) return false
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[/"'@:\\s,{])${escaped}(?=$|["'@#:\\s,}]|:\\s|@)`, 'm').test(text)
}

/**
 * Drop YAML comment lines before matching.
 *
 * A patch file that documents the conflict ("# dsh-ops must not be enabled with
 * fast mode") would otherwise read as an install record. Inline `#` is left
 * alone: a version pin like `github:...#v0.8.0` must keep matching.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutComments(text) {
  return text
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n')
}

/**
 * Scan a profile directory for installed peer plugins.
 *
 * @param {string} profileDir - `~/.dsh/profiles/<name>`.
 * @param {(file: string) => string} [read] - injectable reader (tests).
 * @returns {string[]} ids in `PEER_PLUGINS` order; empty when clean.
 */
export function detectPeerPlugins(profileDir, read = (file) => readFileSync(file, 'utf8')) {
  if (typeof profileDir !== 'string' || profileDir.length === 0) return []
  const sources = []
  for (const name of ['package.json', 'cordis.patch.yml']) {
    try {
      const text = read(join(profileDir, name))
      sources.push(name.endsWith('.yml') ? withoutComments(text) : text)
    } catch {
      // A missing file is not a conflict; the other probe still answers.
    }
  }
  if (sources.length === 0) return []
  return PEER_PLUGINS.filter(id => sources.some(text => mentionsPackage(text, id)))
}

/**
 * Probe the live tool registry for `dsh-ops`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {boolean}
 */
export function opsToolsLive(ctx) {
  try {
    const tools = ctx?.get?.('tools')
    if (!tools || typeof tools.get !== 'function') return false
    return OPS_TOOLS.some(name => {
      try {
        return tools.get(name) !== undefined
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}
