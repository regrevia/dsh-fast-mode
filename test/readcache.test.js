import assert from 'node:assert/strict'
import test from 'node:test'

import { createReadCache, statKey } from '../src/readcache.js'

const stat = (mtimeMs, size, ino) => ({ mtimeMs, size, ino })

test('a stored read is returned with its saved characters', () => {
  const cache = createReadCache()
  const text = 'export const x = 1\n'
  assert.equal(cache.store('/abs/a.js', text, stat(1, text.length, 7)), true)
  const got = cache.lookup('/abs/a.js', stat(1, text.length, 7))
  assert.deepEqual(got, { hit: true, text, savedChars: text.length })
  assert.equal(cache.size, 1)
  assert.equal(cache.stats.hits, 1)
  assert.equal(cache.stats.stores, 1)
})

test('an unknown key is a plain miss', () => {
  const cache = createReadCache()
  assert.deepEqual(cache.lookup('/abs/none.js', stat(1, 10, 1)), { hit: false, stale: false })
  assert.equal(cache.stats.misses, 1)
  assert.equal(cache.size, 0)
})

test('every one of mtime, size and ino must match, or the read goes stale', () => {
  for (const drift of ['mtimeMs', 'size', 'ino']) {
    const cache = createReadCache()
    const text = 'body'
    cache.store('/abs/a.js', text, stat(1000, 4, 11))
    const got = cache.lookup('/abs/a.js', { ...stat(1000, 4, 11), [drift]: 9999 })
    assert.deepEqual(got, { hit: false, stale: true }, `drift in ${drift}`)
    assert.equal(cache.stats.stale, 1)
    assert.equal(cache.stats.hits, 0)
    assert.equal(cache.size, 0, 'a stale entry is dropped, not served again')
    assert.deepEqual(cache.lookup('/abs/a.js', stat(1000, 4, 11)), { hit: false, stale: false })
  }
})

test('a stat with a missing field can never produce a hit', () => {
  const cache = createReadCache()
  cache.store('/abs/a.js', 'body', stat(1000, 4, 11))
  for (const bad of [null, {}, { mtimeMs: 1000 }, { mtimeMs: 1000, size: 4 }]) {
    if (bad && 'mtimeMs' in bad && !('size' in bad)) {
      const got = cache.lookup('/abs/a.js', bad)
      assert.equal(got.hit, false)
    }
  }
  assert.equal(cache.lookup('/abs/a.js', null).hit, false)
  assert.equal(cache.store('/abs/b.js', 'body', {}), false)
})

test('the least recently used entry is evicted at the cap', () => {
  const cache = createReadCache({ maxEntries: 2 })
  cache.store('a', 'aaa', stat(1, 3, 1))
  cache.store('b', 'bbb', stat(1, 3, 2))
  assert.equal(cache.lookup('a', stat(1, 3, 1)).hit, true, 'a is now the newest')
  cache.store('c', 'ccc', stat(1, 3, 3))
  assert.equal(cache.size, 2)
  assert.equal(cache.lookup('b', stat(1, 3, 2)).hit, false, 'b was the oldest')
  assert.equal(cache.lookup('a', stat(1, 3, 1)).hit, true)
  assert.equal(cache.lookup('c', stat(1, 3, 3)).hit, true)
  assert.equal(cache.stats.evictions, 1)
})

test('re-storing a key refreshes its position and never duplicates it', () => {
  const cache = createReadCache({ maxEntries: 2 })
  cache.store('a', 'a1', stat(1, 1, 1))
  cache.store('b', 'b1', stat(1, 1, 2))
  cache.store('a', 'a2', stat(2, 2, 1))
  assert.equal(cache.size, 2)
  assert.equal(cache.lookup('a', stat(2, 2, 1)).text, 'a2')
  cache.store('c', 'c1', stat(1, 1, 3))
  assert.equal(cache.lookup('b', stat(1, 1, 2)).hit, false)
})

test('a single read over maxChars is not cached', () => {
  const cache = createReadCache({ maxChars: 10 })
  const big = 'x'.repeat(11)
  assert.equal(cache.store('/abs/big', big, stat(1, big.length, 1)), false)
  assert.equal(cache.size, 0)
  assert.equal(cache.lookup('/abs/big', stat(1, big.length, 1)).hit, false)
  assert.equal(cache.stats.skipped, 1)
  const exact = 'y'.repeat(10)
  assert.equal(cache.store('/abs/exact', exact, stat(1, 10, 2)), true, 'exactly maxChars fits')
  assert.equal(cache.lookup('/abs/exact', stat(1, 10, 2)).hit, true)
})

test('clear empties the cache and its counters', () => {
  const cache = createReadCache()
  cache.store('a', 'aaa', stat(1, 3, 1))
  cache.lookup('a', stat(1, 3, 1))
  cache.lookup('zzz', stat(1, 3, 2))
  cache.clear()
  assert.equal(cache.size, 0)
  assert.deepEqual(cache.stats, { hits: 0, misses: 0, stale: 0, stores: 0, evictions: 0, skipped: 0 })
  assert.equal(cache.lookup('a', stat(1, 3, 1)).hit, false)
})

test('an empty key or empty text is not cached', () => {
  const cache = createReadCache()
  assert.equal(cache.store('', 'text', stat(1, 4, 1)), false)
  assert.equal(cache.store('k', '', stat(1, 0, 1)), false)
  assert.equal(cache.size, 0)
})

test('statKey collapses an fs.stat result to the three compared fields', () => {
  assert.deepEqual(statKey({ mtimeMs: 12.5, size: 3, ino: 9, mode: 33188, isFile: () => true }), {
    mtimeMs: 12.5,
    size: 3,
    ino: 9,
  })
  assert.deepEqual(statKey({ mtime: new Date(1234), size: 0 }), { mtimeMs: 1234, size: 0, ino: 0 })
  assert.deepEqual(statKey({ mtimeMs: 5n, size: 6n, ino: 7n }), { mtimeMs: 5, size: 6, ino: 7 })
  assert.equal(statKey(null), null)
  assert.equal(statKey(undefined), null)
  assert.equal(statKey({ size: 3 }), null, 'no timestamp means no version')
  assert.equal(statKey({ mtimeMs: Number.NaN, size: 3, ino: 1 }), null)
})

test('a file replaced on disk misses the cache instead of serving stale text', () => {
  const cache = createReadCache()
  const oldText = 'old\n'
  cache.store('/repo/x.md', oldText, stat(100, 4, 42))
  // Same path, new inode: the file was replaced with identical length.
  assert.deepEqual(cache.lookup('/repo/x.md', stat(100, 4, 43)), { hit: false, stale: true })
  const newText = 'new\n'
  cache.store('/repo/x.md', newText, stat(100, 4, 43))
  assert.equal(cache.lookup('/repo/x.md', stat(100, 4, 43)).text, newText)
})
