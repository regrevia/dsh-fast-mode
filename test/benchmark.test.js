/**
 * The experiment half of the plugin: the assignment must be out of the
 * requester's control, reproducible from the log, and incapable of changing
 * anything outside a running experiment.
 *
 * A benchmark whose gear can be nudged by the person reading the result proves
 * nothing, so the hash walk and the file's inert defaults are contracts, not
 * implementation details.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAssignment, gearFor, hashOf } from '../src/benchmark.js'

const GEARS = ['safe', 'fast', 'turbo', 'max']

const withTempFile = (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fast-mode-bench-test-'))
  try {
    return run(join(dir, 'bench.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const write = (file, value) => writeFileSync(file, JSON.stringify(value))

test('the hash is stable: a gear is reproducible from a session id alone', () => {
  assert.equal(hashOf(''), 0x811c9dc5)
  assert.equal(hashOf('session-1'), hashOf('session-1'))
  assert.notEqual(hashOf('session-1'), hashOf('session-2'))
  // Pinned value, so a change to the hash function cannot silently invalidate
  // a benchmark that was already half-run.
  assert.equal(hashOf('abc'), 440920331)
})

test('the hash walk covers every gear and does not favour one', () => {
  const assignment = { gears: GEARS, sessions: {} }
  const seen = new Map(GEARS.map(gear => [gear, 0]))
  for (let index = 0; index < 2000; index += 1) {
    const gear = gearFor(`session-${index}`, assignment)
    seen.set(gear, seen.get(gear) + 1)
  }
  for (const gear of GEARS) {
    const share = seen.get(gear) / 2000
    assert.ok(share > 0.15 && share < 0.35, `${gear} got ${share.toFixed(2)} of the sessions`)
  }
})

test('an explicit pin beats the hash, and only for a known gear', () => {
  const assignment = { gears: GEARS, sessions: { pinned: 'turbo' } }
  assert.equal(gearFor('pinned', assignment), 'turbo')
  assert.equal(gearFor('pinned', { gears: GEARS, sessions: { pinned: 'warp' } }), gearFor('pinned', { gears: GEARS, sessions: {} }))
})

test('no file means no experiment: the configured gear decides', () => withTempFile((file) => {
  const assignment = createAssignment({ file, gears: GEARS })
  assert.equal(assignment.current, undefined)
  assert.equal(assignment.gearFor('session-1'), undefined)
}))

test('an empty path is inert without touching the disk', () => {
  const assignment = createAssignment({ file: '', gears: GEARS })
  assert.equal(assignment.gearFor('session-1'), undefined)
})

test('enabled:false is inert: a leftover file cannot change behaviour', () => withTempFile((file) => {
  write(file, { enabled: false, gears: GEARS })
  const assignment = createAssignment({ file, gears: GEARS })
  assert.equal(assignment.gearFor('session-1'), undefined)
}))

test('a running experiment assigns one gear per session from the list', () => withTempFile((file) => {
  write(file, { enabled: true, gears: ['safe', 'max'] })
  const assignment = createAssignment({ file, gears: GEARS })
  const gears = new Set()
  for (let index = 0; index < 40; index += 1) {
    const gear = assignment.gearFor(`session-${index}`)
    assert.ok(['safe', 'max'].includes(gear))
    gears.add(gear)
  }
  assert.deepEqual([...gears].sort(), ['max', 'safe'], 'both arms of the experiment must actually be used')
}))

test('unknown and duplicate gears are dropped, not trusted', () => withTempFile((file) => {
  write(file, { enabled: true, gears: ['warp', 'fast', 'fast', 42] })
  const assignment = createAssignment({ file, gears: GEARS })
  assert.deepEqual(assignment.current.gears, ['fast'])
  assert.equal(assignment.gearFor('anything'), 'fast')
}))

test('a file naming no known gear is inert and complains once', () => withTempFile((file) => {
  write(file, { enabled: true, gears: ['warp'] })
  const complaints = []
  const assignment = createAssignment({ file, gears: GEARS, onError: message => complaints.push(message) })
  assert.equal(assignment.gearFor('a'), undefined)
  assert.equal(assignment.gearFor('b'), undefined)
  assert.equal(complaints.length, 1, 'a broken file must not write a line per request')
  assert.match(complaints[0], /no known gear/)
}))

test('broken JSON is reported once and stays inert', () => withTempFile((file) => {
  writeFileSync(file, '{ not json')
  const complaints = []
  const assignment = createAssignment({ file, gears: GEARS, onError: message => complaints.push(message) })
  assert.equal(assignment.gearFor('a'), undefined)
  assignment.gearFor('b')
  assert.equal(complaints.length, 1)
  assert.match(complaints[0], /not JSON/)
}))

test('the file is live: an edit takes effect within the second', () => withTempFile((file) => {
  write(file, { enabled: true, gears: ['safe'] })
  const assignment = createAssignment({ file, gears: GEARS })
  assert.equal(assignment.gearFor('session-1'), 'safe')

  // Editing the file does not require a reload; the cached read expires.
  write(file, { enabled: true, gears: ['max'] })
  const before = assignment.gearFor('session-1')
  assert.equal(before, 'safe', 'within the TTL the previous read still stands')

  const until = Date.now() + 1200
  while (Date.now() < until) { /* the TTL is wall-clock; waiting is the test */ }
  assert.equal(assignment.gearFor('session-1'), 'max')
}))

test('a session pin can point a single named session at one gear', () => withTempFile((file) => {
  write(file, { enabled: true, gears: ['safe', 'max'], sessions: { 'session-pin': 'max', bad: 'warp' } })
  const assignment = createAssignment({ file, gears: GEARS })
  assert.equal(assignment.gearFor('session-pin'), 'max')
  assert.notEqual(assignment.gearFor('bad'), 'warp')
}))
