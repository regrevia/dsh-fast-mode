/**
 * Keep a long-lived cache inside a fixed number of entries.
 *
 * Every cache in this plugin is keyed by something that never repeats — a
 * session id, a `callId`, a `${sid}${cwd}` pair. A host process stays up for
 * weeks, so an uncapped cache grows with the number of sessions it has ever
 * seen, and eventually the host dies of it. `index.js`, `auto.js` and
 * `src/metrics.js` all take this one shape, so a cache added later cannot
 * forget the cap by writing its own loop differently.
 *
 * Insertion order is the eviction order for both `Map` and `Set`, so the first
 * key returned by `keys()` is the oldest write — unless the caller re-inserts on
 * read, which is what the session cache does to get least-recently-used order.
 *
 * Deleting an entry never breaks a row: a session whose label was evicted is
 * recorded as `unknown`, not as somebody else's mode.
 *
 * @template {Map<any, any> | Set<any>} T
 * @param {T} cache
 * @param {number} cap
 * @returns {T} the same cache, so it can be used as an expression
 */
export function trim(cache, cap) {
  if (!(cap > 0)) return cache
  while (cache.size > cap) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return cache
}
