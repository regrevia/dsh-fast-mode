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
  const map = buildWorkspaceMap(root, { maxEntries: 200 })
  assert.ok(map.length <= 1400, `map was ${map.length} chars`)
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
