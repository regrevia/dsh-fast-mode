// 一条真实的失败输出：失败那行埋在 4000 行噪声中间，既不在开头也不在结尾。
// `audit/tasks.output-heavy.jsonl` 用它验证压缩之后模型还看得见这行、行号也指得回去。
const FAIL_AT = 2000
for (let i = 1; i <= 4000; i += 1) {
  if (i === FAIL_AT) {
    console.log('FAIL src/renameme.test.js: expected 1 got 2')
  } else {
    console.log(`noise line ${i}: filler content that no one needs to read`)
  }
}
process.exitCode = 1
