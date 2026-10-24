<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>DeepSeek Harness 自己的 fast 模式。</b><br>
  该少想的地方少想，该并行的调用一次并行发出去 —— 不用换模型，不用换供应商。
</p>

<p align="center">
  <a href="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/regrevia/dsh-fast-mode/releases"><img alt="release" src="https://img.shields.io/github/v/release/regrevia/dsh-fast-mode"></a>
  <img alt="deps" src="https://img.shields.io/badge/dependencies-1%20(schemastery)-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <a href="README.en.md">English</a>
</p>

---

这是给 `deepseek-v4.1-flash` 这类**本来就不慢的模型**去掉"多步任务里白等的时间"的插件：一个 Host 插件 + 一个客户端小挂件，不改会话、不写上下文。唯一的依赖是宿主 profile 里本来就有的 `@deepseek-ai/schemastery`（只用来声明设置页的配置 schema，不含运行时逻辑）。

它做三件事，全部作用在同一个请求的**思考档位**和**每一步的调用宽度**上：

| # | 做法 | 作用点 |
|---|---|---|
| 1 | 判断"这一步到底要不要深度思考"：连续干净才降档，遇到错误/慢调用/大结果/重复调用/命中 `holdTools` 立刻回到原档 | `tools/post-execute` 观察 → `agent/request` 决策 |
| 2 | 只发**当前路由真正声明过**的档位 id，绝不猜 | `llm.resolveModelInfo()` 发现 → 只在该路由的档位链上挪 |
| 3 | 档位 ≥ 2 时，向模型注入一小段"独立调用请批量并行"的指令，让一步做完本来要三步的读 | `systemPrompt.section`（order 520） |

## 闪电开关：默认关闭，点一下才开

从 0.5.0 起这个插件是 **opt-in**：装好之后它什么都不做，直到你明确打开它。三个入口写的是同一个字段 `enabled`：

| 入口 | 操作 | 适合 |
|---|---|---|
| **对话框里的闪电**（新） | 模型选择器右边一枚闪电按钮：空心 = 关闭，实心黑色 = 开启，点一下就切换 | 日常 |
| **设置页**（新） | 设置 → 插件 → `fast-mode`，改 `enabled` / `gear` / `parallel` | 顺手调档位 |
| **patch** | `cordis.patch.yml` 里写 `enabled: true` | 用配置管理 profile |

三处写的是同一份用户层配置（`settings/update` → `applies: live`），所以点完**下一次模型调用**就生效，不用重启。第一次装（或刚升级到带客户端半的版本）要重载一次页面 / 重启应用，让客户端 bundle 加载出来。

闪电的读法：

- **空心灰** = 关闭（默认，插件完全不干预）；
- **实心黑** = 开启，hover 提示里带当前档位；
- **灰掉不可点** = 这层配置只读，或本 profile 里没有声明这个插件条目 —— hover 提示会写明是哪一种，不会假装切换成功。

它注册在 `conversation.input.activity`（模型选择器右侧、停止按钮左侧），**不占用** `conversation.input.model`，所以永远不会遮住宿主自己的模型选择器。点击是乐观更新 + 回读校验：写失败会把图标退回原状，并在提示里给出错误原因。

开启后的默认档位是 `fast`（档位 2），也就是上面三件事全开；想完全回到 v0.3.0 那种"不注入任何提示、只在干净连击后降档"的静默行为，用 `gear: safe`。

## 实测：慢在哪

在一台真实机器上采样 10 轮、617 次工具调用（`deepseek-v4.1-flash`，公司自建网关，五档 `off/minimal/low/medium/high`）：

| 指标 | 数值 | 说明 |
|---|---|---|
| 只发 1 个工具调用的步骤 | **91%** | 绝大多数步骤是"读一个 → 回一次模型 → 再读一个"，往返全串着 |
| 工具耗时中位数 / p90 / 最坏 | 67 ms / 5553 ms / 818.7 s | 快的调用几毫秒，慢的几条吃掉大半墙钟 |
| >30 s 的空转间隔（10 轮合计） | 14 段，2259 s | 等待与往返的可见成本 |
| 每轮生成耗时 | ≈ 44 s | 生成占绝对主导，工具中位数 67 ms |

结论：能压的不是工具本身，而是**每步的思考预算**和**每步的往返次数**。这个插件只压这两样。

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

自建 / 网关路由同理，只是档位链不同（例如本机 `company` 网关声明 `off/minimal/low/medium/high` 且都真实生效，降一档是 `high → medium`）。插件不假设任何词汇：路由声明什么，它就在什么上面挪；声明为空（`route=provider-none`）或问不到（`route=none`）时它完全不动。

### 三、按档位批量并行

思考档位只决定"想多久"，决定不了"一步发几个调用"。同一 assistant message 里的多个工具调用会被 harness **并发**调度（受 `agentLoop.maxParallelToolCalls` 限制，默认 10，且只并发声明为安全的调用），所以提高真实并发的唯一诚实办法是让模型把独立调用放在同一步里 —— 于是档位 ≥ 2 时插件注册一段系统提示，随档位给出不同的并行目标。

它同时守住三条不许破的规则：只并行**互不依赖**的调用、读与写不放进同一批、批里失败就缩回小步。并行目标只是目标：如果 profile 把调度上限压得比档位目标还低，插件会打一条 warn 告诉你在 `cordis.patch.yml` 里改哪一行。

## 一键安装

装进当前 profile（DSH 桌面版 → 插件管理器 → 安装 bundle），三种等价路径：

| 方式 | 操作 | 说明 |
|---|---|---|
| **A. 插件管理器（推荐）** | 安装 bundle，目标填 `github:regrevia/dsh-fast-mode` | 一条 spec，自动拉取并链接；升级同样一条 |
| **B. 终端一条命令** | `pnpm add github:regrevia/dsh-fast-mode --dir ~/.dsh/profiles/desktop` | 然后见下方 patch 片段 |
| **C. 本地开发** | `pnpm add link:/path/to/dsh-fast-mode --dir ~/.dsh/profiles/desktop` | 改代码即时生效 |

**已实测**：在 DSH `0.2.1-rc.2` / `DSH_PROFILE=desktop` 上，把插件管理器的安装目标填成 `github:regrevia/dsh-fast-mode`，它拉下 tarball 并直接生效（`application: applied`，无 warning），profile 里记录为 `"dsh-fast-mode": "github:regrevia/dsh-fast-mode"`。0.4.0 无客户端半时就这样跑通；0.5.0 多了客户端半（闪电），重装后同样 applied，只是**必须重载一次页面 / 重启应用**才会看到图标 —— 宿主只在启动时扫描 `dsh.client` 声明。

同名 npm 包**尚未发布**（这台机器上 `npm whoami` 无凭据），所以暂时不要用 `dsh-fast-mode@0.5.0` 这类 npm spec，用上面的 `github:` 形式。

方式 B / C 需要在 profile 的 `cordis.patch.yml` 里插入插件行（方式 A 会自己写）：

```yaml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
      config:
        enabled: true      # 装好默认关闭；这一行才是真正的开关
        gear: 2            # 1 稳 / 2 快 / 3 极速 / 4 极限；默认为 2
        debug: true
        debugFile: /tmp/fast-mode.log
```

装好后跑一轮带工具调用的任务，看日志就知道它在工作：

```
turn=1 step=19 gear=fast high=>low      route=provider obs=2 clean=2 err=0 slow=24ms big=114c rep=1 hold=0
turn=8 step=21 gear=fast high=>high     route=provider obs=5 clean=0 err=1 slow=1820ms big=9002c rep=1 hold=0 STRUGGLING
```

## 加速档位

档位不是"开关多档"，而是**一套姿态**：多早允许降档、信号回看多长、让模型一步发几个调用。

| 档位 | 名字 | `floor` | `deepAfter` | `window` | 并行目标 | 适合 |
|---|---|---|---|---|---|---|
| 1 | 稳 `safe` | `low` | 6 | 8 | 不注入提示（纯 v0.3 行为） | 关键改动、想先看日志、要求零提示变更 |
| 2 | 快 `fast` | `low` | 4 | 6 | 4 个/步 | **默认，日常推荐** |
| 3 | 极速 `turbo` | `low` | 3 | 5 | 6 个/步 | 大量读代码、调研、批量排查 |
| 4 | 极限 `max` | `low` | 2 | 4 | 8 个/步 | 机械批量任务；不建议无人值守跑关键改动 |

- 可以用数字（`gear: 3`）或名字（`gear: turbo`）；开启后不写就是 `fast`，写错一律退回 `safe`，不会退回"无限制"。
- 显式字段永远优先于档位：`gear: 3` + `deepAfter: 8` 就是"极速的并行 + 保守的降档节奏"。
- 任何档位都**不会**低于 `floor`（默认 `low`）。想要更狠可以自己设 `floor: minimal` 或 `floor: off`；那等于允许关掉思考，质量风险由你承担。
- 档位越高，输入 token 通常越多（一步带更多工具结果），往返越少 —— 这正是"用 token 换时间"的那笔交易。

## 和上下文压缩类插件一起用：更多 token，更快

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
       gear: 2
       holdTools: [compress, decompress, search_context, acp_status, acp_retrieve, "acp_delegate*"]
   ```

另外两点是事实，不是建议：billion-context 自己的摘要调用跑在它的代理进程里，不经过 harness，本插件碰不到；它会关掉 `compaction-basic` 的自动压缩，所以**别再叠第二个压缩器**。

### 历史图片自动压缩 / 网关适配插件

`image-guard`、`intellif-litellm-adapter` 这类插件修的是另一种失败：在请求发出前重写消息列表（搬走老图片、强制再压一轮、重试 `too_many_images` 的 400），以便穿过网关的图片数量 / 像素 / 上下文上限。它们和本插件不共享任何字段，不需要改配置；想让它们的重试步保住思考，也可以把相应的 offload / compaction 工具名放进 `holdTools`。

同一 profile 里**只留一个图片削减者**（billion-context 也会在服务端折叠媒体），否则两次压缩互相踩。

## 官方 API 支持

| 场景 | 是否支持 | 依据 |
|---|---|---|
| 官方 DeepSeek API（`deepseek-official`） | ✅ | 读官方 adapter 的声明（`off/low/high/max`，默认 `high`）；只在 `high → low` 之间挪 |
| 官方 API 前面挂代理 / 中转 | ✅ | 档位链来自 provider **连接配置**（`resolveModelInfo`），不取决于网络对端 |
| 自建 / 公司网关（如 `llm-pi-ai` + Anthropic Messages） | ✅ | 声明几档就挪几档；`off/minimal/low/medium/high` 上降一档是 `high → medium` |
| OpenAI 兼容 / 别的 provider | ✅ | 同上；路由声明 `reasoningEfforts` 即可，声明为空则插件完全不干预 |
| 只有 `max` 一档、或没有档位的模型 | ✅（安静） | `route=provider-none` / `none` → 什么都不做 |

官方 API 上的**最细降档粒度**是 `high → low`（中间没有别的档），所以这里的承诺永远是"这个请求更便宜"，不是"这个请求很便宜"。想让官方路由彻底不受影响，设 `floor: high`。

## 配置

```yaml
- id: fast-mode
  name: dsh-fast-mode
  config:
    enabled: true              # 总开关，默认 false；等价于点对话框里的闪电
    gear: 2                    # 1 稳 / 2 快 / 3 极速 / 4 极限（默认 2）
    parallel: 4                # 可选：覆盖档位给的并行目标（只影响提示词里的数字与告警）
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
    debug: false
    debugFile: ""
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关，也是对话框里那枚闪电写的字段；只有 `true` 才会干预请求 |
| `gear` | `fast` | 档位；`1..4` 或 `safe`/`fast`/`turbo`/`max`；写错退回 `safe` |
| `parallel` | 随档位（4/6/8） | 注入提示里的并行目标；`1` 等于不注入 |
| `floor` | `low` | 永不选比它更便宜的档位；官方路由上 `floor: high` 等于完全不降档 |
| `deepAfter` | 随档位（6/4/3/2） | 连续干净调用几次后允许第二档降幅 |
| `slowMs` | `5000` | 达到该耗时即保住思考 |
| `bigChars` | `20000` | 结果达到该体积即保住思考 |
| `window` | 随档位（8/6/5/4） | 参考的最近调用条数 |
| `escalateAfterStep` | `0` | 很长的轮次恢复完整思考；`0` 关闭 |
| `holdTools` | `[]` | 工具名或前缀（`acp_*`）列表；命中即视为"不常规工作"，下一步保住档位 |
| `ladder` | — | 显式固定档位链（≥2 个 id） |
| `aliases` | `auto` | 把文档化的兼容别名折叠到生效档位；`false` 关闭，给 map 则覆盖 |
| `discoverTimeoutMs` | `250` | 等路由声明多久，等不到就不带它决策 |
| `baselineFromDefault` | `true` | 没有已解析档位时，把路由的 `defaultEffort` 当作基准往下降 |
| `debug` / `debugFile` | 关 / `""` | 每个请求一行日志，带上决策依据 |

### 日志里的 `route=`

`route=` 说明档位从哪来：`provider`（发现到的）、`provider+aliases`、`configured`（由 `ladder` 写死）、`provider-none`（该路由没声明档位）、`none`（发现不可用且没有写死）。启动时 logger 还会为每条路由打印一次解析出的档位链与档位设置。

如果每行都是 `high=>high`，按这个顺序查：步号有没有到 2（规划步按设计豁免）；是不是 `route=none`（没配 `reasoningEfforts` 的路由没有档位可降）；当前档位是否已经等于你设的 `floor`。

## 安全边界

- **只观察，不改结果。** 两个工具 hook 永远转发原决策；决策逻辑抛异常时回退到 harness 原本选的档位。
- **只发路由声明过的 id。** 有性质测试保证任何输入都不会产出该路由没声明过的档位；最坏情况是"什么都没做"，不是"这一轮坏了"。
- **不写会话。** 观察数据只在内存里，按 agent 隔离、按轮重置，不占一个 token 的上下文。
- **失败即沉默。** 问不到 provider、超时、日志文件不可写，全部静默降级。
- **客户端半不会拖垮输入框。** 闪电按钮的每一次远端调用都在 try/catch 里；配置读不到就渲染成不可点的灰色按钮并写明原因，slot 注册被别的插件占用就只打一条 warn，不抛给宿主。

## 诚实的限制

- 输出 token 是串行的：一次生成里，思考变少只会让这一步更短，不会让这一步和下一步重叠。
- 宿主插件无法"替模型发出并行调用"，只能抬高调度上限、或让模型自己把独立调用放进同一步。本插件做的是后者（外加在上限不足时提醒）。
- 它救不了卡在慢命令上的轮次，也不是批处理独立调用的替代品。
- 不集成任何外部"决策模型"端点（比如 Jev）：那会引入一个网络往返，与本插件的目的相反。
- 省下多少墙钟取决于思考在你那一轮里占多大比重。上面那个会话里生成占绝对主导（每轮约 44 秒），这正是它针对的情形。

## 开发与测试

```bash
npm test        # 78 个测试，无网络、不需要 harness
```

策略测试覆盖规划步豁免、单档与双档降幅、`floor`、不上调规则、每个挣扎信号单独生效、`holdTools` 命中、按轮重置、按 agent 隔离、观察内存有界、畸形参数处理、配置归一化（`floor` 打错字退到默认值而不是取消 floor）、档位归一化（写错退回 `safe`）。provider 那组把策略跑在官方适配器真实的声明（`off/low/high/max`）、更宽的别名列表、五档自建网关、以及完全不声明档位的路由上 —— 其中包含一个性质测试：任何输入都不可能产出该路由没声明过的 id。集成测试用假 context 按 harness 顺序驱动注册进去的 handler，并验证档位 ≥2 时系统提示被注册、档位 1 时提示完全不存在；最后一个测试检查插件清单本身——包里的 `icon.png` 真的是一张不超过 256 KiB 的 PNG，双语 `meta.title`/`meta.description` 齐全，`files[]` 覆盖了运行时要用到的每个文件；同一组测试还检查客户端半的清单约定（`dsh.client.platform === "web"`、`exports["./client"]`、`client.js` 被打包、bundle id 等于包名、注册的 slot 是 `conversation.input.activity` 而不是会遮住模型选择器的那个），最后一组把发布出去的 `client.js` 原样放进 `vm` 沙箱里跑（桩 `__ModuleLoader__` + 假的 `settings` 远端）：证明 bundle 能解析、只 require `react`、空心画得出来、点击只发一次带 revision 的 `settings/update`、被拒时回滚并在提示里给出原因、只读层和"没有这个条目"都渲染成不可点。另一组用 schemastery 真实校验 schema：默认 `enabled: false`、四个档位名都能过、`gear: warp` 会当场报错、不写进 schema 的 patch 字段（`floor`、`holdTools`）原样保留。

## 许可

MIT © regrevia · [English README](README.en.md)
