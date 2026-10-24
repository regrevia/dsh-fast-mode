# 参考手册：原理、配置与边界

README 只留结论。这里放细节：每一步怎么判定、每个字段是什么、和谁共存、
哪些数字还不能信。内容与插件版本同步维护。

## 交互细节：闪电开关与会话归属

> 面向使用者的简短说明见 [README](../README.md)。

从 0.5.0 起这个插件是 **opt-in**：装好之后它什么都不做，直到你明确打开它。两个入口写的是同一份配置，但粒度不同：闪电写的是**当前这个会话**的开关（顺带把共享默认值更新成这次的选择），patch 写的是共享默认值。

| 入口 | 操作 | 适合 |
|---|---|---|
| **对话框里的闪电**（新） | 模型选择器右边一枚闪电按钮：空心 = 关闭，实心黑色 = 开启；点它打开面板，开关在面板里 | 日常 |
| **patch** | `cordis.patch.yml` 里写 `enabled: true` | 用配置管理 profile |

两处都走 `settings/update`（`applies: live`），所以点完**下一次模型调用**就生效，不用重启。第一次装（或刚升级到带客户端半的版本）要重载一次页面 / 重启应用，让客户端 bundle 加载出来。

**档位也在闪电上**（设置页里没有）：点闪电打开面板，面板里从上到下是开关、一行 `仅本会话生效`、五档档位和一行小字。开关和档位都作用于**打开面板的那个会话**；每档都标着它的倍率，选完立刻写入。**入口只有一个，而且一定是能用的那一个**：

| 档位 | 名字 | 预估速度 | 预估 token | 并行目标 |
|---|---|---|---|---|
| 1 | Eco `safe` | ~1.0× | ~1.0× | 2 |
| 2 | Cruise `fast`（默认） | ~1.3× | ~1.2× | 4 |
| 3 | Sport `turbo` | ~1.6× | ~1.5× | 6 |
| 4 | Track `max` | ~2.2× | ~1.9× | 8 |
| 5 | Redline `ludicrous` * | ~3.4× | ~1.3× | 8 |

第 5 档带星号：它是唯一允许把思考档压到 `off` 的档位，所以面板脚注只写这一句 —— `* 关闭思考，质量会下降`。

闪电的读法：

- **空心灰** = 关闭（默认，插件完全不干预）；
- **实心黑** = 开启，hover 提示里带当前档位；
- **点一下打开面板，不直接切换**：开关在面板里，所以不会误触把一整轮变快；五档和那句小字也在同一个面板里，选了什么、代价是什么放在一处；
- **点了一定有反应**：读不到配置（只读层 / 本 profile 没装这个条目 / 桥接还没连上）时按钮**不会灰掉**，而是打开面板把原因写在状态行里。0.5.1 那版把按钮设成 `disabled`，Chrome 对 disabled 按钮不显示 `title`，于是既不提示也点不动 —— 这个坑在 0.5.2 里用三条独立防线堵掉了（解包 `{ok, value}` 信封、每次远程调用带超时、永不 disabled）。

这四个字段（`enabled` / `gear` / `parallel` / `sessions`）都声明了 `.volatile()`：`settings` 只会把 volatile 字段投影出来，也只允许改 volatile 字段（否则 `describe` 里整个条目直接消失、`update` 报 `is not volatile`）。代价是这些字段传到插件里是**引用**而不是值——Loader 靠原地替换引用来让改动落到正在运行的 fiber 上，插件侧在 `resolveConfig` 一处统一解引用。其中 `sessions` 由客户端半自动维护，不是给人调的旋钮（见[每个会话自己的开关](#每个会话自己的开关)）。

它注册在 `conversation.input.activity`（模型选择器右侧、停止按钮左侧），**不占用** `conversation.input.model`，所以永远不会遮住宿主自己的模型选择器。面板里的每次写入都是乐观更新 + 回读校验：写失败会把图标退回原状，并在提示和面板状态行里给出错误原因。

开启后的默认档位是 `fast`（档位 2），也就是上面三件事全开；想完全回到 v0.3.0 那种"不注入任何提示、只在干净连击后降档"的静默行为，用 `gear: safe`。

## 怎么做的

### 一、判断这一步要不要深度思考

`tools/pre-execute` / `tools/post-execute` 是纯观察者（永远转发拿到的决策，不可能改工具结果）。插件据此判断"这一步顺不顺"：

| 信号 | 含义 |
|---|---|
| `isError` | 出错了 → 需要想 |
| `slowMs`（默认 5000） | 卡在 I/O → 问题不在思考，保住思考没用但也不该更省 |
| `bigChars`（默认 20000） | 结果很大 → 需要消化 |
| 同参数重复调用 ≥ 2 次 | 在原地打转 |
| 命中 `holdTools` | 压缩/接管类工具，它的下一步不能省 |

规则很短：

- 规划步（`step < 2`）不动；
- 连续干净调用 ≥ `deepAfter` → 降一档；再连续干净 → 允许第二档；
- 任何一个挣扎信号 → **立刻**回到解析后的原始档位（只降不上调，原档就是上限）；
- 不知道当前路由有哪些档位 → 什么都不做。

### 二、只发这条路由真声明过的档位

这是"完美支持官方 API"的关键，也是它和那些硬编码 `reasoning_effort: "low"` 的脚本的根本区别：DSH 在发请求**之前**会校验档位 id，猜一个不存在的 id 会让整次模型调用失败，而不是被忽略。所以插件先问，再动手。

官方路由（`@deepseek-ai/dsh-llm-deepseek`，从代码里读出，不靠猜）：

| 项 | 值 |
|---|---|
| provider id | `deepseek-official`（由 `@deepseek-ai/dsh-llm-deepseek-api-key` 提供） |
| base URL | `https://api.deepseek.com/anthropic`（Anthropic Messages 线上协议） |
| 声明的档位 | `off` / `low` / `high` / `max`，默认 `high` |
| 线上字段 | `thinking: { type: "disabled" \| "enabled" }` + `output_config.effort` |
| 插件能做的降档 | `high → low`（16384 → 2048 thinking tokens）；`off` 在 floor 之下，不会被选中 |
| 想让它彻底安静 | `floor: high`（插件变成纯观察者） |

自建 / 网关路由同理，只是档位链不同（例如本机 `company` 网关声明 `off/minimal/low/medium/high` 且都真实生效，降一档是 `high → medium`）。插件不假设任何词汇：路由声明什么，它就在什么上面挪；声明为空（`route=provider-none`）或问不到（`route=unknown`）时它完全不动。

### 三、用 token 换时间：三个杠杆

一句话：**这个插件不省 token，它花 token 买时间。** 花在三个地方，第三个是 0.8.0 新加的，也是实测收益最大的一个。

| 杠杆 | 怎么做 | 为什么快 | 谁在付钱 |
|---|---|---|---|
| **1. 步更宽** | 档位给出每步并行目标（4/6/8/8），提示模型把互不依赖的调用放进同一条 assistant message | 同一 message 里的调用被 harness **并发**调度（受 `agentLoop.maxParallelToolCalls` 限制，默认 10，且只并发声明为安全的调用），N 个读从 N 次往返压成 1 次 | 输入 token：一步带更多工具结果 |
| **2. 投机预读** | 档位 ≥ `turbo` 时追加一句：证据已经暗示下一步要读哪个文件，就**在同一批里读掉** | 多读一个用不上的文件只要几百输入 token，多一次往返要一整个步（≈0.7 s 固定开销 + prefill） | 输入 token：偶尔白读 |
| **3. 少写过程** | 提示模型别在工具调用前后叙述、别复述文件内容、别在步末写"已完成"的进度报告 | 这条路由上每步耗时 ≈ `720 ms + 6.6 ms × 输出 token`（R²=0.93），**可见文字就是最大单项成本** | 输出 token：答案只写结论 |

三个杠杆都只动一个东西：**同一条路由的请求里多花些 token**。没有一项依赖"降低模型能力"，也没有一项靠调低 effort —— 在这条自建路由上 reasoning token 是 0，调低 effort 一分钱也省不下来（实测见 [BENCHMARK.md](../BENCHMARK.md)）。

第三条默认开启，可以用 `outputDiscipline: false` 关掉（只保留并行与预读提示，不动文风）。`fast` 用轻量版（三条禁令），`turbo` 及以上用完整版（再加一条"这一步不需要文字就别写"）。`safe` 什么都不注入。

并行提示同时守住四条不许破的规则：只并行**互不依赖**的调用、读与写不放进同一批、批里失败就缩回小步、绝不为了省 token 把步重新切窄。并行目标只是目标：如果 profile 把调度上限压得比档位目标还低，插件会打一条 warn 告诉你在 `cordis.patch.yml` 里改哪一行。

### 四、开关状态跟着会话走

`settings` 服务只有一个作用域（整个 profile），表达不了"这个会话开没开"，所以会话条目放在插件自己的 `sessions` 字段里，host 每次请求按会话 id 解析一次（实验分配 > 会话条目 > 共享默认，见[每个会话自己的开关](#每个会话自己的开关)）。客户端半怎么知道自己在哪个会话：`conversation.input.activity` 是 session 作用域的 slot，slot kit 调 `inject` 时会把绑定键（会话 id）作为第一个参数传进来，客户端半拿它当 `chatId` prop；同时它也接受标准的 `sessionId` prop，两种拼写都认，否则某个版本停止注入其中之一就会退回全局行为。列格式的 host 版在 `src/state.js`，浏览器版在 `client.js` 里另存一份（bundle 不能 import host ESM），两边由同一组夹具钉住。

### 五、卡顿看门狗：工具等待也有上限

一步的墙钟不只有往返和可见输出，还有**工具等待**：一条没有上限的前台调用就能吃掉几分钟（起服务、`tail` 日志、等一个永远不会来的输入，或者一个 heredoc 死成畸形响应），而模型往往原样再发一遍 —— 这段时间落在 `720 ms + 6.6 ms × token` 这套模型看不见的残差里，是纯亏损。所以 0.8.1 加了一条不花 token 的杠杆：给单次工具调用设上限。

**机制**：本插件注册 harness 的 `tools/execute` 钩子，把每个受保护的调用和一个按档位的上限赛跑。到期就 abort 这次调用自己的 signal，等一小段宽限期让调用体收尾，再把调用方原来的 signal 还回去，最后返回一个 `ToolExecutionFailure`，其正文告诉模型**换个做法重试**（收窄命令、写进文件用 `script_path`、改成后台任务），而不是再发一遍同样的命令。

**保护谁**：shell / 脚本 / 监控类工具（按名字匹配）。**不保护谁**：本来就该等的调用 —— `ask_user_question`、`wait_agent`、`job_output`、`task_board_run`、`workflow`、`subagent*`、`run_code` —— 以及本来就不会卡住的 `read` / `write` / `edit`。`safe` 档不设看门狗：它的承诺就是什么都不改。

| 档位 | 单次工具调用上限 |
|---|---|
| Eco `safe` | 关闭 |
| Cruise `fast` | 300 s |
| Sport `turbo` | 180 s |
| Track `max` | 120 s |
| Redline `ludicrous` | 90 s |

这些是**策略预算，不是测量结果**：档位越高，允许一次调用占用的时间越少。

配置（composition 层，设置页里没有）：`stallGuard: false` 整个关掉；`toolTimeoutMs` 覆盖上表（正数 = 所有档位都用这个毫秒数，负数 = 关闭看门狗，`0` = 按档位）。

提示词那一半也同步了：引导段现在会要求模型给 shell 调用设边界、把服务 / watcher 放后台、长命令或带引号的多行命令先写进文件再用 `script_path` 传，而不是塞 heredoc。

## 配置

```yaml
- id: fast-mode
  name: dsh-fast-mode
  config:
    enabled: true              # 共享默认开关，默认 false；没有自己条目的会话沿用它
    gear: fast                 # safe / fast / turbo / max / ludicrous（默认 fast）
    parallel: 4                # 可选：覆盖档位给的并行目标（只影响提示词里的数字与告警）
    outputDiscipline: true     # 少写过程、只写结论；false = 只保留并行/预读提示，不动文风
    stallGuard: true           # 卡顿看门狗：给 shell 类工具按档位设单次上限；false = 关闭
    toolTimeoutMs: 0           # 覆盖档位上限：正数 = 所有档位用这个毫秒数，负数 = 关闭，0 = 按档位
    floor: low                 # 永不选比它更便宜的档位
    deepAfter: 4               # 连续干净几次后允许第二档降幅（默认随档位）
    slowMs: 5000               # 慢到这个程度即保住思考
    bigChars: 20000            # 结果达到这个体积即保住思考
    window: 6                  # 参考最近几次调用（默认随档位）
    escalateAfterStep: 0       # 一轮超过 N 步后恢复完整思考；0 关闭
    holdTools: [compress, "acp_*"]   # 这些工具之后的下一步保住完整思考
    ladder: [off, low, high, max]    # 可选：写死档位链，跳过发现
    aliases: auto              # auto | false | { "<声明 id>": "<生效 id>" }
    discoverTimeoutMs: 250     # 等路由声明多久，等不到就不带它决策
    baselineFromDefault: true  # 没解析出档位时，以路由默认档位为基准往下降
    metrics: true              # 每步一行测量，默认开
    metricsFile: ~/.dsh/fast-mode-metrics.jsonl
    benchmarkFile: ~/.dsh/fast-mode-bench.json
    debug: false
    debugFile: ""
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 共享默认开关，也是没有自己条目的会话沿用的值；闪电写的是当前会话的条目，同时把这个字段更新成上次的选择。只有 `true` 才会干预请求 |
| `gear` | `fast` | 档位，只能是 `safe`/`fast`/`turbo`/`max`/`ludicrous`；写数字或写错都是加载时报错。没有自己条目的会话沿用它 |
| `parallel` | 随档位（4/6/8） | 注入提示里的并行目标；`1` 等于不注入。设置页里**留空**就是跟随档位——所以它故意没有默认值，给了默认值档位就再也抬不动它了 |
| `sessions` | `""` | 会话级覆盖，插件自动维护（**别手改**）：`{"<sessionId>":{"enabled":true,"gear":"turbo","ts":…}}`；超过 200 条按 `ts` 丢最旧的，被丢的会话回到共享默认。volatile；设置页里是一个文本框 |
| `outputDiscipline` | `true` | 让模型少写过程（不叙述工具调用、不复述文件内容、不写进度报告），只写结论。这是"用 token 换时间"里最有效的杠杆：实测每步输出从 640 降到 190 token，墙钟约 −⅓。`false` 保留并行与预读提示，只关掉文风约束。**非 volatile**，改它要重新加载 |
| `stallGuard` | `true` | 卡顿看门狗：给 shell / 脚本类工具加一个按档位收紧的单次上限，超时取消这次调用，并把"换个做法重试"写回给模型（见[卡顿看门狗](#五卡顿看门狗工具等待也有上限)）。`safe` 档不设上限。**非 volatile**，改它要重新加载 |
| `toolTimeoutMs` | `0` | 覆盖上表的档位上限：正数 = 所有档位都用这个毫秒数，负数 = 关闭看门狗，`0` = 按档位。同样**非 volatile** |
| `floor` | `low` | 永不选比它更便宜的档位；官方路由上 `floor: high` 等于完全不降档 |
| `deepAfter` | 随档位（6/4/3/2/1） | 连续干净调用几次后允许第二档降幅 |
| `slowMs` | `5000` | 达到该耗时即保住思考 |
| `bigChars` | `20000` | 结果达到该体积即保住思考 |
| `window` | 随档位（8/6/5/4/4） | 参考的最近调用条数 |
| `escalateAfterStep` | `0` | 很长的轮次恢复完整思考；`0` 关闭 |
| `holdTools` | `[]` | 工具名或前缀（`acp_*`）列表；命中即视为"不常规工作"，下一步保住档位 |
| `ladder` | — | 显式固定档位链（≥2 个 id） |
| `aliases` | `auto` | 把文档化的兼容别名折叠到生效档位；`false` 关闭，给 map 则覆盖 |
| `discoverTimeoutMs` | `250` | 等路由声明多久，等不到就不带它决策 |
| `baselineFromDefault` | `true` | 没有已解析档位时，把路由的 `defaultEffort` 当作基准往下降 |
| `metrics` | `true` | 每个完成的步写一行 JSONL；`false` 完全不写文件 |
| `metricsFile` | `~/.dsh/fast-mode-metrics.jsonl` | 测量文件路径。**composition 旋钮**：不在设置页出现，改它要动 `cordis.patch.yml` |
| `benchmarkFile` | `~/.dsh/fast-mode-bench.json` | 按会话分配档位的实验文件，同样只在加载/每秒重读时用 |
| `debug` / `debugFile` | 关 / `""` | 每个请求一行日志，带上决策依据 |

### 日志里的 `route=`

`route=` 说明档位链从哪来：`provider`（运行时发现的）、`provider+aliases`（发现的链，并按文档别名放宽过）、`provider-none`（该路由声明为空）、`configured`（由 `ladder` 写死）、`builtin`（内置默认链）、`unknown`（问不到路由）。启动时 logger 还会为每条路由打印一次解析出的档位链与档位设置。

如果每行都是 `high=>high`，按这个顺序查：步号有没有到 2（规划步按设计豁免）；是不是 `route=provider-none` 或 `unknown`（没配 `reasoningEfforts` 的路由没有档位可降）；当前档位是否已经等于你设的 `floor`。

## 与压缩类插件共存的细节

档位管的是**输出/思考**预算，压缩类插件管的是**输入/历史**预算，两个杠杆正交，叠起来是相乘的效果：

| 层 | 例子 | 削什么 | 作用点 |
|---|---|---|---|
| 输出 / 思考 | **本插件** | 每步思考 token 与墙钟 | `agent/request` → `reasoningEffort` |
| 输入 / 历史 | billion-context（ACP 代理）、内置 compaction、历史图片搬运 | prompt token、上下文压力 | 消息列表或 provider `baseURL`，在请求离开前 |

三条规则让它们真的能一起用：

1. **档位是个字段，不是一句话。** 代理重新序列化请求体时会保留 `thinking` / `output_config`；本插件在序列化**之前**写好这个字段，代理看到的只是一个普通请求。
2. **压缩步骤可以被按住。** 上下文管理类调用从外面看往往很"干净"（快、结果小、不报错），正好是干净连击规则想降档的时刻 —— 用 `holdTools` 点名这些工具，让它们之后的下一步保住完整思考。
3. **一个旋钮只有一个主人。** 不要让两个组件同时钳制 `reasoningEffort` / `output_config.effort`：第二个钳子不知道第一个为什么抬高。

### billion-context

**兼容且互补。** billion-context 以 DSH bundle（`bili-native`）安装，关掉宿主平面 `compaction-basic` 的 auto，并通过 patch HTTP 层拦截模型流量（`globalThis.fetch`），不走 `agent/request`，也不读写 `reasoningEffort`，所以它不可能悄悄推翻本插件的决定。

两个都是**可选**的注意事项：

1. `compress.outputSteering` 默认关闭；一旦开启，它内含的 `effortRouting` 会在"机械延续"的轮次把 effort 往最低压（Anthropic 上同时改 `output_config.effort` 和 `thinking.budget_tokens`）。那正是本插件拥有的旋钮，而且它看不到错误、慢调用与显式 hold。选一个主人：

   ```yaml
   - id: bili-native
     config:
       compress:
         outputSteering:
           enabled: true
           effortRouting: false    # 让 fast-mode 独占 effort
   ```

2. 把它的工具加进 `holdTools`，让"折叠历史"这一步本身不会被降档：

   ```yaml
   - id: fast-mode
     config:
       gear: fast
       holdTools: [compress, decompress, search_context, acp_status, acp_retrieve, "acp_delegate*"]
   ```

另外两点是事实，不是建议：billion-context 自己的摘要调用跑在它的代理进程里，不经过 harness，本插件碰不到；它会关掉 `compaction-basic` 的自动压缩，所以**别再叠第二个压缩器**。

### 历史图片自动压缩 / 网关适配插件

`image-guard`、`intellif-litellm-adapter` 这类插件修的是另一种失败：在请求发出前重写消息列表（搬走老图片、强制再压一轮、重试 `too_many_images` 的 400），以便穿过网关的图片数量 / 像素 / 上下文上限。它们和本插件不共享任何字段，不需要改配置；想让它们的重试步保住思考，也可以把相应的 offload / compaction 工具名放进 `holdTools`。

同一 profile 里**只留一个图片削减者**（billion-context 也会在服务端折叠媒体），否则两次压缩互相踩。

### `dsh-batch-tool-calls` 与 `dsh-ops`：不能和本插件同时启用

这两个不是"配置一下就能共存"的邻居，是**功能重叠**：同时开会让同一件事被收费两次，有时还会互相打架。

- **`dsh-batch-tool-calls`** 注册的是它自己的批量调用提示段。本插件注册的是它的超集：按档位的并行目标、按会话生效、压缩后补一条提醒，0.8.1 起还多了单次工具调用的按档上限。两个都开着，同一份提示要付两遍钱，而且两段文字可以给出不一致的并行目标。
- **`dsh-ops`** 用自己的工具替掉 shell 与文件工具（`ops_bash`、`ops_grep`、`ops_glob`、`ops_inspect_local_file`、`ops_replace` …），而且只带 Windows 二进制。本插件的引导段讲的是"用那个 shell 做事"——给调用设上限、把服务放后台、别用 heredoc；装了 `dsh-ops` 就等于有两个 shell、两套规则，要么重复要么冲突。

本插件加载时会检测这两个（在 profile 的 `package.json` / `cordis.patch.yml` 里找包名，另外用一次实时的 `ops_bash` 工具探测），命中就在会话里**只说一次**冲突，不阻塞加载。修法只有一条：**删掉其中一个**。

## 官方 API 支持

| 场景 | 是否支持 | 依据 |
|---|---|---|
| 官方 DeepSeek API（`deepseek-official`） | ✅ | 读官方 adapter 的声明（`off/low/high/max`，默认 `high`）；默认档位只在 `high → low` 之间挪，`ludicrous` 会用到 `off` |
| 官方 API 前面挂代理 / 中转 | ✅ | 档位链来自 provider **连接配置**（`resolveModelInfo`），不取决于网络对端 |
| 自建网关（如 `litellm` + Anthropic Messages） | ✅ | 声明几档就挪几档；`off/minimal/low/medium/high` 上降一档是 `high → medium` |
| OpenAI 兼容 / 别的 provider | ✅ | 同上；路由声明 `reasoningEfforts` 即可，声明为空则插件完全不干预 |
| 只有 `max` 一档、或没有档位的模型 | ✅（安静） | 只有一档时没有可降的空间；声明为空（`provider-none`）或问不到（`unknown`）时同样什么都不做 |

官方 API 上的**最细降档粒度**是 `high → low`（中间没有别的档），所以这里的承诺永远是"这个请求更便宜"，不是"这个请求很便宜"。想让官方路由彻底不受影响，设 `floor: high`。`ludicrous` 是唯一例外：它自己的 `floor` 就是 `off`，也是它带星号的原因。

## 测量、实验与报告

0.6.0 把测量做进插件，并给了一条不靠肉眼的对比路径。

### 每个完成的步写一行

计量默认开启，且**和开关无关**：关闭状态的会话也会记录，否则没有对照组。每个完成的模型步往 `~/.dsh/fast-mode-metrics.jsonl` 追加一行 JSON；文件按需创建，写失败静默，绝不影响请求。

| 字段 | 含义 |
|---|---|
| `v` / `ts` / `sid` / `turn` / `step` | 格式版本、时间、会话 id、轮号、步号 |
| `mode` | `on` / `off` / `unknown`：这一轮开关的状态 |
| `gear` / `effort` / `route` | 实际档位（关闭时是 `off`）、实际发出的档位 id、这条请求的路由 `provider/model`（调试行里的 `route=` 才是档位链来源，见下文） |
| `ttftMs` | 步开始 → 第一条 assistant 消息，也就是首字延迟 |
| `llmMs` | 步开始 → 最后一条 assistant 消息，也就是模型用时 |
| `stepMs` | 整个步的墙钟，**包含**工具执行 |
| `calls` / `errors` | 这一步的工具调用数 / 其中报错的调用数 |
| `input` / `output` / `reasoning` / `cacheRead` / `cacheWrite` | 上游 `usage` 的实测 token |
| `assistantMessages` | 这一步产生了几条 assistant 消息 |

- `metrics: false` 关掉计量；`metricsFile` 改路径。后者和 `benchmarkFile` 一样是 **composition 旋钮**（故意不是 volatile），只在加载时读，改它要动 `cordis.patch.yml`。
- 报告里的"模型耗时"就是 `llmMs`，"首字"就是 `ttftMs`。别拿 `stepMs` 当模型速度：它包含你机器上工具跑的时间。

### 每个会话自己的开关

0.6.2 之前，开关和档位是 profile 级的：在一个对话里点闪电，**所有**正在跑的会话都跟着变。0.7.0 把状态拆成两层。

- 每个会话记自己的 `{enabled, gear}`。闪电面板里的开关和档位只作用于**打开面板的那个会话**，面板里开关下面那行写得很清楚：`仅本会话生效`。
- 没有自己条目的会话沿用共享的 `enabled` / `gear`。这两个字段同时是**上次在任何地方做的选择**的记录，所以新开的会话从上次的选择开始，而不是从 schema 默认值开始。
- 优先级：实验文件（`fast-mode-bench.json`）> 这个会话的条目 > 共享默认。实验分支没变，仍然**故意**压过 UI。
- 存储是设置里一个 volatile 字段 `sessions`，内容是一段 JSON：`{"<sessionId>":{"enabled":true,"gear":"turbo","ts":1792826203058}}`。`ts` 是裁剪依据：超过 200 条就丢最旧的，被丢掉的会话回到共享默认。设置页里它会显示成一个文本框（这一版 schemastery 没有 `.hidden()`），由客户端半自动维护，别手改。
- 点一下是**一次** `settings/update`，同时写共享的 `enabled`/`gear` 和这个会话的条目，带的是读到的 revision：不会出现面板显示一档、请求跑另一档，也没有两次写的 revision 竞争。写入被拒时三个字段一起回滚，原因写在面板状态行里。

### 按会话分配档位

`~/.dsh/fast-mode-bench.json`（或 `benchmarkFile`）存在且 `enabled: true` 时，插件按会话分配档位：

```json
{
  "enabled": true,
  "gears": ["off", "safe", "fast", "turbo", "max"],
  "sessions": { "<session id>": "turbo" }
}
```

- `gears` 里可以写 `"off"`：那是**对照组**，被分到的会话按关闭状态运行。没有它，实验只能回答"哪档更快"，回答不了"比不开快多少"——后者才是要证明的事。
- 有显式 `sessions` 就用它；没有就按 `FNV-1a(会话 id) mod gears` 分配，同一个会话每次进来都落在同一档。
- 文件最多 1 秒后生效，不用重启；删掉文件，下一次请求就回到配置里的开关与档位。
- 被分配的会话**按分配结果运行，不看当前开关**：实验的 arm 由文件和哈希决定，否则忘了点开关的会话会悄悄落进对照组，而你以为在测 `turbo`。
- 不在 `gears` 里的名字会被丢掉并打一条 warn；文件不是 JSON、或者一个已知档位都没有，实验保持惰性并抱怨一次。

### 报告：`dsh-fast-mode-report`

```bash
node bin/report.mjs --since 2d     # checkout 里直接跑，一定可用
dsh-fast-mode-report --json        # 包里的 bin 名；装进 profile 后由 pnpm 链接出来
```

同名 npm 包还没发布，所以 `npx dsh-fast-mode-report` 现在拉不到（发布后等价）。

| 选项 | 作用 |
|---|---|
| `--file <path>` | 测量文件，默认 `~/.dsh/fast-mode-metrics.jsonl` |
| `--since <when>` | 只看最近一段：`2d` / `12h` / `90m`，或任何 `Date.parse` 接受的写法；`--lan` 时面板的查询窗口也跟着它放大 |
| `--json` | 输出机器可读的 JSON（`{file,total,used,since,buckets,lan}`） |
| `--lan` | 再对一遍局域网用量面板（见下） |
| `-h` / `--help` | 用法 |

默认输出三块：

1. 每个 `mode|gear` 一行：会话数、步数、步/轮、步耗时 p50/p90、模型耗时 p50、首字 p50、输出 tok/步、输出 tok/会话、工具/步、多调步（一步里发了多个工具调用的步数）；
2. 相对关闭状态的倍率表：模型耗时、步耗时、输出 tok/步、输出 tok/会话、工具/步（>1× 表示该档位更快 / 更贵）；
3. 一行口径说明：比较单位是**步**，不是会话墙钟 —— 墙钟里大部分是人在读和打字。

没有关闭状态的样本时，报告不会硬算倍率，而是告诉你要两边都跑：先关闪电跑同样的任务，再开启跑一遍。

`--lan` 把本机行按会话 UUID 对到局域网里的用量面板（`/api/v1/sessions/recent`），补上上游模型名、总/输入/输出 token 和整段会话时长：

- 只读，不发任何写请求；
- token 从环境变量 `USAGE_TOKEN` 读，从不打印；面板地址默认是构建里写死的那个，可用 `USAGE_BASE` 覆盖；
- 没有 token 就打印一句说明并跳过 `--lan`，报告其余部分照常输出；
- 整个过程不出局域网；面板的查询窗口跟着 `--since` 走（面板只有 `1d`/`7d`/`30d` 三档，不给 `--since` 时默认 `7d`），对不上就直说，不猜。

### 实验：`dsh-fast-mode-experiment`

报告只在"两边的活儿是同类的、分档不是你挑的"时候才算数。这个命令管的就是那个文件，省得手写 JSON：

```bash
node bin/experiment.mjs start                 # 四个档位，按会话 id 哈希分配
node bin/experiment.mjs status                # 每档已有几个会话/几步、还缺什么
node bin/experiment.mjs stop                  # 结束实验，回到配置里的开关与档位
node bin/report.mjs --since 7d                # 对比
```

| 选项 | 作用 |
|---|---|
| `--bench <path>` | 实验文件，默认 `~/.dsh/fast-mode-bench.json` |
| `--metrics <path>` | 测量文件，默认 `~/.dsh/fast-mode-metrics.jsonl` |
| `--gears a,b,c` | 参与实验的档位（默认 `off,safe,fast,turbo,max`，`off` 是对照组；少于两个直接拒绝） |
| `--sessions n` | `status` 里"每档至少几个会话"的门槛，默认 3，只影响提示 |
| `--force` | 覆盖正在跑的实验文件 |

实验期间新开的会话**自动按分配结果运行**（`off` 之外都开着跑），不用点小闪电——否则忘了点的会话会悄悄落进对照组。`status` 会直说还缺哪些：没有关闭态样本、哪一档一个会话都没有、每档够不够 `n` 个会话。实验结束记得 `stop`，否则后续会话会继续被分档。

## 安全边界

- **只观察，不改结果。** 两个工具 hook 永远转发原决策；决策逻辑抛异常时回退到 harness 原本选的档位。
- **只发路由声明过的 id。** 有性质测试保证任何输入都不会产出该路由没声明过的档位；最坏情况是"什么都没做"，不是"这一轮坏了"。
- **不写会话。** 观察数据只在内存里，按 agent 隔离、按轮重置，不占一个 token 的上下文。
- **失败即沉默。** 问不到 provider、超时、日志文件不可写，全部静默降级。
- **计量写不进去也不影响请求。** JSONL 只追加，目录懒创建，异常吞掉；报告侧只读测量文件，`--lan` 只发 GET，token 只在内存里用、不打印、不出内网。
- **客户端半不会拖垮输入框。** 闪电按钮的每一次远端调用都在 try/catch 里；配置读不到时按钮仍然可点，点开在面板状态行里写明原因；slot 注册被别的插件占用就只打一条 warn，不抛给宿主。

## 诚实的限制

- 输出 token 是串行的：一次生成里，思考变少只会让这一步更短，不会让这一步和下一步重叠。上游 `usage.outputTokens` 的 TPS 没有变，动的是模型用时和步数，不是"单个模型生成变快"。
- 宿主插件无法"替模型发出并行调用"，只能抬高调度上限、或让模型自己把独立调用放进同一步。本插件做的是后者（外加在上限不足时提醒）。
- 它只能给卡在慢命令上的调用设上限（超时取消后再让模型换个做法），不能替你把那条命令变快，也不是批处理独立调用的替代品。
- 不集成任何外部"决策模型"端点（比如 Jev）：那会引入一个网络往返，与本插件的目的相反。
- 省下多少墙钟取决于思考在你那一轮里占多大比重。上面那个会话里生成占绝对主导（每轮约 44 秒），这正是它针对的情形。
- 引导段只在档位真的要指令时才注入：`safe` 和关闭状态零成本，其余档位每请求约 1 KB 文本（≈300 input tokens）。
- 官方 API 上不关思考的合法降幅只有 `high → low`（16384 → 2048 思考预算）；`ludicrous` 关掉思考，质量代价是明示的，不是隐藏的。
- 要数字请用上面那套测量与报告，而且比较的两边得做同类工作。

## 开发与测试

```bash
npm test        # 175 个测试，无网络、不需要 harness
```

策略测试覆盖规划步豁免、单档与双档降幅、`floor`、不上调规则、每个挣扎信号单独生效、`holdTools` 命中、按轮重置、按 agent 隔离、观察内存有界、畸形参数处理、配置归一化（`floor` 打错字退到默认值而不是取消 floor）、档位归一化（坏值不会变成"无限制"）。provider 那组把策略跑在官方适配器真实的声明（`off/low/high/max`）、更宽的别名列表、五档自建网关、以及完全不声明档位的路由上 —— 其中包含一个性质测试：任何输入都不可能产出该路由没声明过的 id。集成测试用假 context 按 harness 顺序驱动注册进去的 handler，并验证档位 ≥2 时系统提示被注册、档位 1 时提示完全不存在；计量那组证明**关闭状态的会话也被记录**（一步一行、多消息步的首字取第一条），并覆盖 token/错误求和、按会话隔离、目录懒创建、空路径关掉 sink。会话状态那组针对 0.7.0 的会话级覆盖：把 `client.js` 里那份浏览器实现放进 `vm`、喂同一组夹具，证明它和 host 的 `src/state.js` 对同一列格式读写一致 —— 两份实现一旦漂移，开关就会显示"开着"而实际什么都不做；同时覆盖超过 200 条时按 `ts` 丢最旧、坏列退化成"没有覆盖"、host 对每个会话取自己的条目而没有条目的会话沿用共享的一对。实验分派那组证明哈希稳定且覆盖全部档位、显式 pin 优先、单会话 pin、文件 1 秒内生效、没有文件或 `enabled:false` 时完全惰性、坏文件只抱怨一次。报告那组跑真实的 `bin/report.mjs`：两张表、只有一边样本时用文字拒绝、`--since` 也放大面板查询窗口、`--json`、`--help` 不读文件、没 token 时跳过 `--lan`、有 token 时按会话 id 对上且**从不打印 token**、面板不通时降级成一句说明。最后一个测试检查插件清单本身——包里的 `icon.png` 真的是一张不超过 256 KiB 的 PNG，双语 `meta.title`/`meta.description` 齐全，`files[]` 覆盖了运行时要用到的每个文件；同一组测试还检查客户端半的清单约定（`dsh.client.platform === "web"`、`exports["./client"]`、`client.js` 被打包、bundle id 等于包名、注册的 slot 是 `conversation.input.activity` 而不是会遮住模型选择器的那个），并把发布出去的 `client.js` 原样放进 `vm` 沙箱里跑（桩 `__ModuleLoader__` + 假的 `settings` 远端，而且这个远端按真实协议回 `{ok, value}` 信封 —— 信封没解包正是 0.5.1 那个"点不动的闪电"的根因，所以它现在是测试夹具的一部分）：证明 bundle 能解析、只 require `react`、空心画得出来、点一下只打开面板而不写任何东西、面板里的开关只发一次带 revision 的 `settings/update`、再点一次把它关回去、被拒时回滚并在提示与状态行里给出原因；同时钉住新的交互契约 —— 外框是**单个图标**（没有小三角、没有内联下拉）、按钮**永不 disabled**、只读/缺条目/`ok:false` 都渲染成"可点 + 一句原因"、五行档位各带速度与 token 倍率、`ludicrous` 带星号、选档在关闭状态下顺手把 `enabled` 一起写、已开启时选档不碰开关、客户端给出的档位 id 与 host 端 `GEARS` 完全一致、面板里的范围说明在中英两套词典里都非空（中文那句固定为 `仅本会话生效`）。最后用 schemastery 真实校验 schema：默认 `enabled: false`、五个档位名都能过、`gear: warp` 会当场报错、计量默认开启、四个 volatile 字段正好是 `enabled`/`gear`/`parallel`/`sessions`（最后一个由客户端半写，不是给人调的）、不写进 schema 的 patch 字段（`floor`、`holdTools`）原样保留。
