/**
 * Read de-duplication: the same file, read twice, costs one read.
 *
 * A turn often reads a file, greps, then reads the same file again, or re-reads
 * after a test run that changed nothing. The text is identical, so sending it
 * again only spends prompt tokens. This cache hands the caller back the text it
 * already has — but only while the file is provably the same file.
 *
 * Version check: `mtimeMs`, `size` and `ino` must all match the stat taken right
 * before the read. mtime alone is too weak (a same-millisecond write), size alone
 * too weak (a same-size edit), and `ino` catches the file being replaced rather
 * than edited. Any mismatch means "read it again" and counts as stale, never as
 * a hit.
 *
 * Pure module: no filesystem, no path resolution. The caller keys by whatever it
 * considers absolute and passes the stat it already has.
 */

const DEFAULTS = { maxEntries: 128, maxChars: 200000 }

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Collapse an `fs.stat` result (or a `fs.Stats`-like object) to the three
 * fields the cache compares. `null`/`undefined` in, `null` out.
 *
 * @param {*} fsStat
 * @returns {{ mtimeMs: number, size: number, ino: number } | null}
 */
export function statKey(fsStat) {
  if (!fsStat || typeof fsStat !== 'object') return null
  let mtimeMs = fsStat.mtimeMs
  if (mtimeMs === undefined && fsStat.mtime instanceof Date) mtimeMs = fsStat.mtime.getTime()
  const size = fsStat.size
  const ino = fsStat.ino ?? 0
  if (mtimeMs === undefined || mtimeMs === null) return null
  const n = (v) => (typeof v === 'bigint' ? Number(v) : Number(v))
  const key = { mtimeMs: n(mtimeMs), size: n(size ?? Number.NaN), ino: n(ino) }
  return Number.isFinite(key.mtimeMs) && Number.isFinite(key.size) && Number.isFinite(key.ino) ? key : null
}

function usable(stat) {
  if (!stat || typeof stat !== 'object') return null
  const { mtimeMs, size, ino = 0 } = stat
  if (typeof mtimeMs !== 'number' || typeof size !== 'number') return null
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) return null
  return { mtimeMs, size, ino: typeof ino === 'number' ? ino : 0 }
}

/**
 * @param {{ maxEntries?: number, maxChars?: number }} [options]
 */
export function createReadCache(options) {
  const opts = options ?? {}
  const maxEntries = positive(opts.maxEntries, DEFAULTS.maxEntries)
  const maxChars = positive(opts.maxChars, DEFAULTS.maxChars)

  /** @type {Map<string, { text: string, stat: { mtimeMs: number, size: number, ino: number } }>} */
  const entries = new Map()
  const stats = { hits: 0, misses: 0, stale: 0, stores: 0, evictions: 0, skipped: 0 }

  return {
    get size() {
      return entries.size
    },

    stats,

    lookup(key, stat) {
      const entry = entries.get(key)
      if (!entry) {
        stats.misses += 1
        return { hit: false, stale: false }
      }
      const now = usable(stat)
      const fresh =
        now !== null &&
        now.mtimeMs === entry.stat.mtimeMs &&
        now.size === entry.stat.size &&
        now.ino === entry.stat.ino
      if (!fresh) {
        entries.delete(key)
        stats.stale += 1
        return { hit: false, stale: true }
      }
      entries.delete(key)
      entries.set(key, entry)
      stats.hits += 1
      return { hit: true, text: entry.text, savedChars: entry.text.length }
    },

    store(key, text, stat) {
      if (typeof key !== 'string' || key.length === 0) return false
      if (typeof text !== 'string' || text.length === 0) return false
      const now = usable(stat)
      if (now === null || text.length > maxChars) {
        stats.skipped += 1
        return false
      }
      if (entries.has(key)) entries.delete(key)
      entries.set(key, { text, stat: now })
      stats.stores += 1
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
        stats.evictions += 1
      }
      return true
    },

    clear() {
      entries.clear()
      stats.hits = 0
      stats.misses = 0
      stats.stale = 0
      stats.stores = 0
      stats.evictions = 0
      stats.skipped = 0
    },
  }
}
