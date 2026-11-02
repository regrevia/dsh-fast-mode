import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

import { compactResult } from '../src/compact.js'

const ON = { enabled: true }
const ELIDE = /^([\s\S]*?)… \[fast-mode: elided (\d+) chars(?:, lines (\d+)–(\d+))?(; kept [^\]]*)?\] …([\s\S]*)$/
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const lines = (n, body = (i) => `line ${i} ${'x'.repeat(40)}`) =>
  Array.from({ length: n }, (_, i) => body(i)).join('\n')

test('a result at or under maxChars is returned untouched', () => {
  const text = lines(20)
  const out = compactResult({ name: 'read', text }, { enabled: true, maxChars: text.length })
  assert.equal(out.changed, false)
  assert.equal(out.text, text)
  assert.equal(out.kind, 'none')
  assert.equal(out.originalChars, text.length)
  assert.equal(out.compactedChars, text.length)
})

test('compaction is off unless policy.enabled is exactly true', () => {
  const text = lines(400)
  for (const policy of [undefined, null, {}, { enabled: false }, { enabled: 'yes' }]) {
    const out = compactResult({ name: 'read', text }, policy)
    assert.equal(out.changed, false, String(JSON.stringify(policy)))
    assert.equal(out.text, text)
  }
})

test('error results are never compacted, however large', () => {
  const text = lines(400)
  const out = compactResult({ name: 'read', text, isError: true }, ON)
  assert.equal(out.changed, false)
  assert.equal(out.text, text)
  assert.equal(out.kind, 'none')
})

test('an already-marked text is not compacted again', () => {
  const text = `head\n… [fast-mode: elided 10 chars] …\ntail`
  assert.equal(compactResult({ name: 'read', text }, ON).changed, false)
  assert.equal(compactResult({ name: 'grep', text }, ON).changed, false)
})

test('head and tail survive, the middle is replaced by one marker', () => {
  const text = lines(500)
  const out = compactResult({ name: 'bash', text }, { ...ON, maxChars: 4000 })
  assert.equal(out.changed, true)
  assert.equal(out.kind, 'shell')
  assert.ok(out.compactedChars < out.originalChars)
  assert.ok(out.compactedChars <= 4000, `got ${out.compactedChars} chars`)

  const m = ELIDE.exec(out.text)
  assert.ok(m, 'marker line present')
  const [, head, elided, firstLine, lastLine, keptBand, tail] = m
  assert.equal(keptBand, undefined, 'no failure line in this text, so nothing is carried')
  assert.ok(text.startsWith(head), 'head is a prefix of the original')
  assert.ok(text.endsWith(tail), 'tail is a suffix of the original')
  assert.equal(head.length + tail.length + Number(elided), text.length)
  const elidedBody = text.slice(head.length, text.length - tail.length)
  assert.deepEqual(
    text.split('\n').slice(Number(firstLine) - 1, Number(lastLine)),
    elidedBody.split('\n').slice(0, -1),
    'the line range names exactly the elided band',
  )
  assert.ok(head.endsWith('\n'), 'head cuts on a line boundary')
  assert.ok(tail.startsWith('\n') || tail.startsWith('line'), 'tail starts on a line boundary')
})

test('headRatio and tailRatio are honoured', () => {
  const text = lines(1000)
  const out = compactResult(
    { name: 'bash', text },
    { ...ON, maxChars: 2000, headRatio: 0.6, tailRatio: 0.1 },
  )
  const [, head, , , , , tail] = ELIDE.exec(out.text)
  assert.ok(head.length > tail.length * 3, `head ${head.length} vs tail ${tail.length}`)
})

test('custom maxChars is respected on a single very long line', () => {
  const text = 'y'.repeat(5000)
  const out = compactResult({ name: 'bash', text }, { ...ON, maxChars: 1000 })
  assert.equal(out.changed, true)
  assert.ok(out.text.length <= 1000 + 80)
  assert.ok(out.text.startsWith('y'))
  assert.ok(out.text.endsWith('y'))
})

test('chinese text is cut without producing broken characters', () => {
  const text = lines(3000, () => '中文测试行：结果稳定')
  const out = compactResult({ name: 'read', text }, { ...ON, maxChars: 3000 })
  assert.equal(out.changed, true)
  assert.ok(out.text.length < text.length)
  assert.equal(LONE.test(out.text), false)
  assert.equal(Buffer.from(out.text, 'utf8').toString('utf8'), out.text)
  const [, head, , , , , tail] = ELIDE.exec(out.text)
  for (const ch of head + tail) {
    assert.ok(ch === '\n' || '中文测试行：结果稳定'.includes(ch), `unexpected char ${JSON.stringify(ch)}`)
  }
})

test('a cut that lands inside an emoji pair backs off to the pair edge', () => {
  const text = `a${'😀'.repeat(100)}`
  const out = compactResult({ name: 'bash', text }, { ...ON, maxChars: 60 })
  assert.equal(out.changed, true)
  assert.equal(LONE.test(out.text), false)
  assert.equal(Buffer.from(out.text, 'utf8').toString('utf8'), out.text)
  assert.ok(out.text.startsWith('a😀'), 'kept whole emoji only')
})

test('grep results keep the first maxPerFile hits per file plus one marker', () => {
  const a = Array.from({ length: 100 }, (_, i) => `src/a.js:${i + 1}: hit ${i}`)
  const b = Array.from({ length: 100 }, (_, i) => `src/b.js:${i + 1}: hit ${i}`)
  const text = [...a, ...b].join('\n')
  const out = compactResult({ name: 'grep', text }, { ...ON, maxChars: 400, maxPerFile: 5, maxMatches: 120 })
  assert.equal(out.changed, true)
  assert.equal(out.kind, 'grep')
  assert.ok(out.text.includes('src/a.js:5: hit 4'))
  assert.ok(!out.text.includes('src/a.js:6: hit 5'))
  assert.ok(out.text.includes('… [fast-mode: 95 more matches in src/a.js] …'))
  assert.ok(out.text.includes('src/b.js:1: hit 0'))
  assert.ok(!out.text.includes('more matches elided'))
})

test('grep is detected by the text shape when the tool is named differently', () => {
  const text = Array.from({ length: 400 }, (_, i) => `lib/x.js:${i + 1}: needle`).join('\n')
  const out = compactResult({ name: 'search_files', text }, { ...ON, maxChars: 2000, maxPerFile: 2 })
  assert.equal(out.kind, 'grep')
  assert.ok(out.text.includes('… [fast-mode: 398 more matches in lib/x.js] …'))
})

test('a result over maxMatches gets one summary line on top of the folding', () => {
  const text = Array.from({ length: 60 }, (_, i) => `src/f${i}.js:1: hit`).join('\n')
  const out = compactResult({ name: 'grep', text }, { ...ON, maxChars: 300, maxPerFile: 5, maxMatches: 5 })
  assert.equal(out.changed, true)
  assert.equal(out.kind, 'grep')
  assert.ok(out.text.includes('src/f4.js:1: hit'))
  assert.ok(!out.text.includes('src/f5.js:1: hit'))
  assert.ok(out.text.includes('… [fast-mode: 55 more matches elided] …'))
})

test('read results only get head-and-tail treatment, never grep folding', () => {
  const text = Array.from({ length: 200 }, (_, i) => `src/r.js:${i + 1}: ${'z'.repeat(30)}`).join('\n')
  const out = compactResult({ name: 'read', text }, { ...ON, maxChars: 500, maxPerFile: 1 })
  assert.equal(out.kind, 'read')
  assert.ok(!out.text.includes('more matches in'))
  assert.ok(ELIDE.test(out.text))
})

test('compaction is idempotent for both kinds', () => {
  for (const [name, text, policy] of [
    ['bash', lines(600), { maxChars: 2000 }],
    ['grep', Array.from({ length: 60 }, (_, i) => `s/m${i}.js:${i + 1}: hit`).join('\n'), { maxChars: 30, maxPerFile: 2, maxMatches: 10 }],
    ['read', lines(400, () => '中文内容'.repeat(10)), { maxChars: 2000 }],
  ]) {
    const once = compactResult({ name, text }, { ...ON, ...policy })
    assert.equal(once.changed, true, `${name} should compact once`)
    const twice = compactResult({ name, text: once.text }, { ...ON, ...policy })
    assert.equal(twice.changed, false, `${name} must not compact twice`)
    assert.equal(twice.text, once.text)
    assert.equal(twice.compactedChars, once.compactedChars)
  }
})

test('non-string or empty results pass through without throwing', () => {
  for (const text of ['', undefined, null, 42]) {
    const out = compactResult({ name: 'read', text }, ON)
    assert.equal(out.changed, false)
  }
  assert.equal(compactResult(undefined, ON).changed, false)
})

test('silly policy numbers fall back to usable values instead of corrupting output', () => {
  const text = lines(300)
  for (const policy of [
    { enabled: true, maxChars: Number.NaN },
    { enabled: true, maxChars: -5 },
    { enabled: true, maxChars: 0, headRatio: 0, tailRatio: 0 },
    { enabled: true, maxChars: 500, headRatio: 2, tailRatio: -1 },
  ]) {
    const out = compactResult({ name: 'bash', text }, policy)
    assert.equal(typeof out.text, 'string')
    assert.equal(LONE.test(out.text), false)
  }
})

test('a shell failure line inside the elided band is carried out by the marker', () => {
  const body = (i) => (i === 120 ? 'FAIL src/a.test.js: expected 1 got 2' : `line ${i} ${'x'.repeat(40)}`)
  const text = lines(500, body)
  const out = compactResult({ name: 'bash', text }, { ...ON, maxChars: 4000 })
  assert.equal(out.changed, true)
  assert.equal(out.kind, 'shell')
  const m = ELIDE.exec(out.text)
  assert.ok(m, 'one marker, nothing else replaced')
  const [, , , firstLine, lastLine, keptBand] = m
  assert.ok(Number(firstLine) <= 121 && Number(lastLine) >= 121, 'the failure line really was in the band')
  assert.ok(keptBand && keptBand.includes('121:FAIL src/a.test.js'), String(keptBand))
  assert.equal(out.text.split('[fast-mode:').length, 2, 'still a single marker')
})

test('shell output with nothing salient gets no carried band', () => {
  const out = compactResult({ name: 'bash', text: lines(500) }, { ...ON, maxChars: 4000 })
  assert.equal(out.kind, 'shell')
  assert.equal(out.text.includes('kept'), false)
})

test('carried failure lines stay inside the char budget', () => {
  const body = (i) => (i % 7 === 0 ? `error ${i} ${'e'.repeat(200)}` : `line ${i}`)
  const out = compactResult({ name: 'bash', text: lines(2000, body) }, { ...ON, maxChars: 4000 })
  assert.ok(out.compactedChars <= 4000 + 400, `got ${out.compactedChars} chars`)
  const kept = ELIDE.exec(out.text)?.[5] ?? ''
  assert.ok(kept.length <= 1000 + 400, `carried budget too big: ${kept.length}`)
})

test('a read result never gets the shell treatment', () => {
  const body = (i) => (i === 120 ? 'error: this is source code, keep it' : `line ${i} ${'x'.repeat(40)}`)
  const out = compactResult({ name: 'read', text: lines(500, body) }, { ...ON, maxChars: 4000 })
  assert.equal(out.kind, 'read')
  assert.equal(out.text.includes('kept'), false)
})

test('真实的失败输出被压缩后，那一行 FAIL 还在', () => {
  let output = ''
  try {
    output = execFileSync(process.execPath, ['audit/fixtures/noisy-fail.mjs'], { encoding: 'utf8' })
  } catch (err) {
    output = err.stdout
  }
  const out = compactResult({ name: 'bash', text: output }, { enabled: true, maxChars: 2000 })
  assert.equal(out.changed, true)
  const text = out.text
  // 失败行在正文中间，只有"把关键行带到 marker 里"这条路径能保住它。
  assert.match(text, /kept 1 matching line 2000:FAIL src\/renameme\.test\.js: expected 1 got 2\]/)
  assert.match(text, /… \[fast-mode: elided \d+ chars/)
  assert.ok(text.length < output.length / 4, '压缩后不到原文的四分之一')
})
