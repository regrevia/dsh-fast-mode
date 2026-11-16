import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildWorkspaceMap } from '../src/map.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fm-map-'))
}

test('lists files with sizes and marks directories', () => {
  const root = tmpdir()
  fs.mkdirSync(path.join(root, 'tests'))
  fs.writeFileSync(path.join(root, 'lib.py'), 'x'.repeat(120))
  fs.writeFileSync(path.join(root, 'tests', 'test_lib.py'), 'ok')

  const map = buildWorkspaceMap(root)
  assert.match(map, /lib\.py 120B/)
  assert.match(map, /tests\//)
  assert.match(map, /tests\/test_lib\.py/)
  assert.match(map, /Test entry points present: tests\//)
})

test('skips clutter so the map stays a map', () => {
  const root = tmpdir()
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x')
  fs.writeFileSync(path.join(root, 'main.js'), 'x')

  const map = buildWorkspaceMap(root)
  assert.match(map, /main\.js/)
  assert.doesNotMatch(map, /node_modules/)
})

test('reports a package.json test script as a real entry point', () => {
  const root = tmpdir()
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  const map = buildWorkspaceMap(root)
  assert.match(map, /npm test \(node --test\)/)
})

test('caps the listing and says so', () => {
  const root = tmpdir()
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, `f${i}.py`), 'x')
  const map = buildWorkspaceMap(root, { maxEntries: 10 })
  assert.match(map, /first 10 of 30/)
  assert.equal((map.match(/^- f\d+\.py/mg) || []).length, 10)
})

test('stays under the text bound even on a wide tree', () => {
  const root = tmpdir()
  for (let i = 0; i < 200; i++) {
    fs.writeFileSync(path.join(root, `file-with-a-long-name-${i}.txt`), 'x'.repeat(i))
  }
  const map = buildWorkspaceMap(root)
  assert.ok(map.length <= 1400, `default map was ${map.length} chars`)
})

test('raising the cap scales the bound instead of being swallowed by it', () => {
  const root = tmpdir()
  for (let i = 0; i < 200; i++) {
    fs.writeFileSync(path.join(root, `file-with-a-long-name-${i}.txt`), 'x'.repeat(i))
  }
  const base = buildWorkspaceMap(root)
  const wide = buildWorkspaceMap(root, { maxEntries: 200 })
  const listed = (m) => (m.match(/^- /mg) || []).length
  assert.ok(wide.length > base.length, 'a raised cap must add paths')
  assert.ok(listed(wide) > listed(base), `${listed(wide)} vs ${listed(base)} paths`)
  assert.ok(wide.length <= 6000, `wide map was ${wide.length} chars`)
})

test('never cuts a path in half', () => {
  const root = tmpdir()
  for (let i = 0; i < 200; i++) {
    fs.writeFileSync(path.join(root, `file-with-a-long-name-${i}.txt`), 'x'.repeat(i))
  }
  for (const maxEntries of [10, 60, 200]) {
    const map = buildWorkspaceMap(root, { maxEntries })
    assert.doesNotMatch(map, /truncated/)
    for (const line of map.split('\n').filter(l => l.startsWith('- '))) {
      const rel = line.slice(2).replace(/ \d+B$/, '')
      assert.ok(fs.existsSync(path.join(root, rel)), `listed a path that does not exist: ${rel}`)
    }
  }
})

test('states a total only when the walk actually saw it', () => {
  const root = tmpdir()
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(root, `f${i}.py`), 'x')
  assert.match(buildWorkspaceMap(root, { maxEntries: 10 }), /first 10 of 12/)
  // 200 files is past cap + overscan for maxEntries 10, so the walk stops
  // collecting before it knows the real total and must not invent one.
  for (let i = 12; i < 200; i++) fs.writeFileSync(path.join(root, `f${i}.py`), 'x')
  assert.match(buildWorkspaceMap(root, { maxEntries: 10 }), /first 10 of more/)
})

test('returns null instead of throwing when there is nothing to show', () => {
  assert.equal(buildWorkspaceMap(undefined), null)
  assert.equal(buildWorkspaceMap(''), null)
  assert.equal(buildWorkspaceMap('/definitely/not/a/real/path/for/fm-map'), null)
  assert.equal(buildWorkspaceMap(tmpdir()), null, 'an empty directory has no map')
})

test('a file path is not a workspace', () => {
  const root = tmpdir()
  const file = path.join(root, 'a.txt')
  fs.writeFileSync(file, 'x')
  assert.equal(buildWorkspaceMap(file), null)
})
