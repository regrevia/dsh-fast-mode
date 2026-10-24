import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyEntry } from '../src/shape.js'

const cases = [
  ['t1', 'Audit the eight files under data/ independently. For each file, report its final token line.', 8],
  ['t2', 'Count how many times each marker appears across every file under data/.', 8],
  ['t3', 'Six independent jobs live in job-01 .. job-06. Run `python3 gen.py` inside each directory with the bash tool.', 8],
  ['t4', 'Audit the twelve modules under repo/ one by one, in ascending filename order.', 1],
  ['t5', 'Across every file under data/ count each symbol and how many modules contain it.', 8],
  ['t6', 'Under data/ there are many log files. Total the count per level.', 8],
  ['t7', 'The files under data/nodes/ form one chain: each file has next: <id>. Start at START and follow next until END.', 1],
  ['t8', 'Every manifest under data/manifests/ lists a deps array. Find dependency ids that appear in more than one manifest.', 8],
]

for (const [name, prompt, width] of cases) {
  test(`${name}: request shape -> width ${width}`, () => {
    const got = classifyEntry(prompt)
    assert.equal(got.width, width, JSON.stringify(got))
    assert.ok(got.signals.length > 0)
  })
}

test('empty or unknown requests stay native', () => {
  assert.equal(classifyEntry('').width, 1)
  assert.equal(classifyEntry('why does this test fail?').width, 1)
})

test('chinese fan-out requests go wide, chinese serial orders stay native', () => {
  assert.equal(classifyEntry('帮我把每个文件里的 token 行都找出来，分别写进 summary.json').width, 8)
  assert.equal(classifyEntry('按顺序逐个目录执行，前一个结果作为后一个的输入').width, 1)
})

test('a chain that names many files is still a chain', () => {
  const r = classifyEntry('There are 20 files under data/, but they form a dependency chain: follow next: from START until END.')
  assert.equal(r.width, 1)
  assert.equal(r.reason, 'serial')
})
