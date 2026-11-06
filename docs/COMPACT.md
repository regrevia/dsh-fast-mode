# 结果压缩与重复读去重

两个纯模块，作用在**工具结果进入模型上下文之前**。它们不改变工具做了什么，只改变模型读到什么。默认关闭；关闭时行为与不装插件一致。

开不开只由 `compactResults` 决定：配置里的（YAML / 设置页），或 `sessions` 列里某个会话条目里的同名键（逐会话生效，关掉即原文回上下文）。1.7.12–1.7.30 右键面板里曾有「截短工具输出」开关，1.7.31 撤掉——它改变模型所见证据，而单独开的对照从未跑过，按「没验证的开关不出现」的规则不再给用户选；配置键与逐会话键都照旧可用。

| 模块 | 作用 | 省的是 |
| --- | --- | --- |
| `src/compact.js` | 超长工具结果做头尾保留 + grep 折叠 | 单条结果的 prompt token |
| `src/readcache.js` | 同一文件同版本重复读取直接复用 | 重复读取的整段正文 |

两个模块都不读环境变量、不读文件、不 import 配置；是否启用、阈值多少，全部由调用方（`index.js`，由 Lead 接线）传入。这样功能可以按开关整体退回。

## 一、结果压缩 `compactResult`

```js
import { compactResult } from './src/compact.js'

const { text, changed, originalChars, compactedChars, kind } =
  compactResult({ name, args, text, isError }, policy)
```

`policy` 默认值：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | 无（必须显式 `true`） | 关闭时原样返回 |
| `maxChars` | `8000` | 超过才压缩；头尾预算也按它算 |
| `headRatio` | `0.40` | 保留头部占 `maxChars` 的比例 |
| `tailRatio` | `0.25` | 保留尾部占 `maxChars` 的比例 |
| `maxPerFile` | `5` | grep 每个文件最多留几条命中 |
| `maxMatches` | `120` | grep 折叠后最多留几条命中 |

什么时候值得开：默认预算（`maxChars=8000`）的对照组跑过 6 轮 24–30 对，墙钟 `0.756×`
（CI 0.611–0.921）、输出 token `0.786×`（CI 0.623–0.990），两个区间都在 1 以下。所以「开压缩有用」
和「把预算调小有用」是两件事：前者量到了，后者没量到——预算调到 2000 时合池墙钟 `0.855×` 但
`run-tests` 的 token 反而 `1.414×`（CI 1.049–1.939）更差，预算 4000 的组合臂 `0.867×` 跨过 1
分不开。默认 8000 就是实测最好的那档，输出很大的命令（整份测试日志、构建日志、深目录列表）才
开它；每个任务的方向并不一致，`grep-geomean` 最强（`0.416×`），`read-package` 只有 `0.874×`。

真实 PR 上也测过：6 个 `pallets/click` 的 PR、每个 4 轮共 24 对，只开这个开关（默认 8000），
合池墙钟 `0.805×`（CI 0.656–0.985）、输出 token `0.768×`（CI 0.618–0.960），两边校验 24/24。
细节和边界见 `AUDIT.md` 的「真实 PR 任务」一节。

规则：

- **只压缩成功且超长的结果。** `isError: true` 的结果永不压缩——错误信息往往整段都关键。
- **头尾保留，中间一行标记。** 保留头 `headRatio` + 尾 `tailRatio`，中间替换为 `… [fast-mode: elided N chars, lines A–B] …`——行区间就是被省略的那一段，模型可以直接按行范围回读，不用整份重读；单行正文没有行号，标记里只给字符数。切点在换行处；没有换行时退到字符边界。
- **多字节不切坏。** 中文等 BMP 字符不会被拆开；emoji 这类代理对（surrogate pair）会先退到配对边界，输出里不会出现孤立代理项，UTF-8 往返一致。
- **shell 输出保留报错行。** 工具名是 `bash`/`shell`/`exec`/`run`/`terminal`/`command` 时，被省略的区间里若有报错行（`error`/`failed`/`fatal`/`panic`/`exception`/`traceback`/`denied`/`refused`/`timeout`/`cannot`/`unable`/`not found`，或以 `✖`/`✗`/`FAIL`/`ERR!` 开头），会把它们连同行号塞进同一条标记：`… [fast-mode: elided 61044 chars, lines 41–812; kept 2 matching lines 121:FAIL … | 400:error: …] …`。默认最多 12 条，总长不超过压缩预算的四分之一；带出的行里的 `[` 与 `]` 换成 `)`，保证标记仍是单行、单标记。
- **grep 折叠。** 工具名含 `grep`，或正文形如 `path:line:` 时：同一文件超过 `maxPerFile` 条只留前几条，加一行 `… [fast-mode: M more matches in <file>] …`；折叠后总命中超过 `maxMatches` 再加一行 `… [fast-mode: K more matches elided] …`。
- **read 类只做头尾。** 名字含 `read`/`view`/`open` 时不做 grep 折叠，避免把正文里的 `xx:12:` 误当命中。
- **幂等。** 输出里只要已经含 `[fast-mode: …]` 标记，再压缩一次返回 `changed: false`、文本不变。所以接线即使对同一结果多压一遍也不会二次截断。
- `kind` 取值：`none`（未改）、`text`（普通头尾截断）、`read`（read 类头尾截断）、`shell`（shell 输出头尾截断，可能带回报错行）、`grep`（发生了折叠）。

## 二、重复读去重 `createReadCache`

```js
import { createReadCache, statKey } from './src/readcache.js'

const cache = createReadCache({ maxEntries: 128, maxChars: 200000 })
cache.store(absPath, text, statKey(fs.statSync(absPath)))
const got = cache.lookup(absPath, statKey(fs.statSync(absPath)))
if (got.hit) return got.text // 省下 savedChars 个字符
```

- `key` 由调用方给，模块不解析路径，直接用调用方的绝对路径。
- **版本校验**：`mtimeMs`、`size`、`ino` 三项全等才算命中。只比 mtime 会漏掉同一毫秒内的写入；只比 size 会漏掉等长改写；`ino` 能发现文件是「被替换」而不是「被编辑」。任一不等即 miss，计入 `stats.stale`，并丢弃旧条目。
- 命中返回 `{ hit: true, text, savedChars }`，`savedChars` 就是省下的字符数；命中会刷新为最近使用。
- **LRU**：用 `Map` 插入顺序，超 `maxEntries` 逐出最旧，计入 `stats.evictions`。
- 单条正文超过 `maxChars` 不入缓存（缓存本身不能成为内存增长点），计入 `stats.skipped`。
- `statKey(fsStat)` 把 `fs.stat` 结果收敛成 `{ mtimeMs, size, ino }`；`null`/无时间戳返回 `null`（即不可缓存）。
- `clear()` 清空条目并重置计数器；`size` 是实时条目数；`stats` 是活对象：`hits`、`misses`、`stale`、`stores`、`evictions`、`skipped`。

## 三、开启后模型看到的内容会变（风险）

这是这组功能唯一需要认真对待的地方，写在这里而不是藏在代码注释里：

- **过度截断会让模型误判。** 模型只看到头 40% 和尾 25% 时，如果答案恰好落在被省略的中间，它可能根据头尾「推断」出一个错的结论，而不是承认自己没看到。这正是默认关闭的原因。
- **每次改写都留标记。** 被省略的地方有 `… [fast-mode: …] …` 一行，模型能据此知道自己读到的是压缩结果，可以改用更窄的读取（指定行范围、更精确的 grep）而不是硬猜。但标记只是提示，模型仍可能忽略它。
- **grep 折叠按文件分组，不按重要性。** 前 `maxPerFile` 条命中未必是最相关的那几条；`maxMatches` 汇总后，后面文件的命中完全不可见。
- **缓存命中意味着模型看到的是「上次读到的文本」。** 版本三项全等只能证明文件没变，不能证明模型理解的上下文没变；如果两次读取之间别的内容变了，模型可能把旧文本当成新证据。缓存按路径键控，不区分任务。
- **数字不会撒谎，但省略的字符数会。** `originalChars` / `compactedChars` 可用来在指标里核对压缩比；它只反映长度，不反映信息损失。

## 四、配置项（由接线方暴露）

```js
// 建议的配置形状，键名由 Lead 在 src/config.js 里定
compact: {
  enabled: false,   // 默认关
  maxChars: 8000,
  headRatio: 0.40,
  tailRatio: 0.25,
  maxPerFile: 5,
  maxMatches: 120,
},
readCache: {
  enabled: false,   // 默认关
  maxEntries: 128,
  maxChars: 200000,
},
```

两个开关互相独立：只开压缩、只开缓存、都开、都不开，都不改变其余行为。

## 五、回退

- **最省事**：把 `enabled` 设回 `false`。两个模块都只做纯计算，关掉后 `compactResult` 原样返回、`lookup` 不命中，模型看到的就是原始工具结果。
- **完全不接线**：不 import 这两个文件即可，`index.js` 不调用就等同于没有依赖；两个模块不注册任何 hook、不发任何请求。
- **单个标记绕过**：如果某条结果确实需要完整内容，让工具改用分页/行范围读取，或让接线方对该工具名跳过压缩。
- 缓存侧回退还可以直接 `clear()` 或把 `maxEntries` 设为 0——后者等于每次都不缓存（`maxEntries` 非正数会回落到默认 128，因此推荐用 `enabled: false` 而不是 0）。

## 六、测试

```bash
node --test test/compact.test.js test/readcache.test.js
```

覆盖：阈值内不变、头尾截断、中文/emoji 边界、grep 折叠与总条目上限、幂等、错误不压缩、缓存命中 / mtime（及 size、ino）变化失效 / LRU 逐出 / 超大不入 / clear / `statKey` 收敛。
