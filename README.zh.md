# dsh-fast-mode

**DeepSeek Harness 自己的 fast 模式：把思考预算花在真正决定事情的那一步，而不是每个执行步都付一遍。**

一个零依赖、免构建的 DSH 宿主插件。它观察工具调用实际进行得怎么样——失败、卡住、结果过大、重复调用——据此调整下一个模型调用的 `reasoningEffort`，而且只使用当前 provider **真正声明过**的档位。

[English](./README.md)

## 为什么做这个

DSH 的一轮不是一个模型调用。harness 会在**每一步**重新解析请求配置，每一步都要先付一笔思考预算，才决定下一步做什么。

在一个真实的 10 轮会话（617 次工具调用）里实测：**91% 的步只发出一次工具调用**，95% 的调用在 100 毫秒内结束。时间不是花在跑工具上，而是花在工具之间的思考上。

按这套部署使用的预算表：

| 档位 | 思考预算 |
|---|---|
| `off` | 0 |
| `minimal` | 1024 |
| `low` | 2048 |
| `medium` | 8192 |
| `high` | 16384 |

一轮跑在 `medium` 上，第 2、3、4 步每步都付 8192 token 的规划预算去想"下一个该读哪个文件"。`dsh-fast-mode` 让这些步更便宜，而一旦活儿不再例行，就立刻把预算还回去。

## 它怎么判断

没有任何按工具名写死的规则。策略读的是这一轮的运行情况。

**要求保留完整思考的信号**（质量护栏）。最近窗口里出现任何一个，就说明下一步不是例行操作：

- 某个工具调用失败了；
- 某次调用超过 `slowMs`——这一轮卡在 I/O 上，思考不是瓶颈，砍掉它只会削掉诊断能力；
- 单次结果超过 `bigChars`——有大量东西要消化；
- 同一个调用（名字加归一化参数）跑了第二次——死循环。

**允许降得更深的信号：**

- 连续一段干净调用——成功、快、结果小。达到 `deepAfter` 次后，允许再降一档。

**始终如此：**

- 一轮的第 1 步保留完整思考：计划是在那里做的；
- 永不低于 `floor`（默认 `low`）；
- 永不向 `floor` **上调**——已经在比 floor 更便宜的档位上跑，就原样放过，因为上调等于把"提速"悄悄变成"减速"；
- 不在该路由声明列表里的档位 id 原样传下去，绝不猜；
- 观察数据按轮重置，难的一轮不会拖慢下一轮。

## Provider 支持：先问，从不假设

档位词表到处都不一样：不同 provider 之间不同，provider 和自建网关之间不同，同一个 provider 的不同模型之间也不同。所以写死一份列表的插件在大多数路由上都是错的，而且是**静默地错**——它发一个看着合理的 id，线上把这个 id 翻译成模型本来就在做的事，于是"提速"测出来是噪声。

所以插件先问 harness。在降档之前，先解析当前路由自己的声明：

```js
const llm = ctx.get('llm')
const info = await llm.resolveModelInfo(provider, model)
info.reasoning.efforts          // [{ id, name, description? }, …]
info.reasoning.defaultEffort    // 该路由本来就会用的档位（若声明了）
```

这个列表就是唯一事实来源。策略只在**这些** id 之间降档。

### 官方 DeepSeek API

以下事实读自线上适配器源码（`@deepseek-ai/dsh-llm-deepseek`），不是从公开文档推断的——协议是适配器自己翻译的，所以它声明什么，harness 就校验什么：

| 事实 | 值 |
|---|---|
| provider id | `deepseek-official` |
| 协议 | Anthropic Messages，`https://api.deepseek.com/anthropic` |
| 默认模型 | `deepseek-flash`、`deepseek-v4-pro` |
| 声明档位 | **`off`、`low`、`high`、`max`** —— 只有四个真实档位 |
| 默认档位 | 连接未配置时是 `high` |
| 线上编码 | `off` 时发 `thinking: { type: "disabled" }`，其余发 `thinking: { type: "enabled" }` + `output_config: { effort }` |

两个推论，也是这一节存在的理由：

1. **官方路由上的一档是 `high` → `low`。** 没有 `medium` 可以落，所以"一个声明档位"就是这条路由能表达的最小降幅。`high`→`low` 是真实削减（上表 16384 → 2048），不是装饰性的。
2. **默认 floor 永远不会选到 `off`。** 在这条路由上 `off` 不是"更便宜的思考预算"，而是彻底关掉思考。默认 `floor: low` 把它挡在外面；只有显式写 `floor: off` 才会启用。

如果你觉得在四档的粗粒度路由上降一档都太激进，设 `floor: high`——这条路由上插件就变成空操作，且不影响其他 provider。

公开的 OpenAI 兼容端点文档了一个更宽的兼容面（`reasoning_effort` 接受 `minimal`、`medium`、`xhigh`，分别映射到 `low`/`high`/`high`）。如果有网关把这些 id **作为声明档位**暴露出来，也同样处理：降档前先折叠到它们实际生效的档位，所以插件永远不会把一次线上的空操作报成 `high`→`medium` 的降档。线上官方适配器不暴露它们——它只声明四个诚实的档位——所以这条路只对 OpenAI 协议的网关有意义。

### 自建与其他 provider

声明五个互不相同档位的网关，五个都保留；降档是 `high`→`medium`。插件里**没有任何 provider 名字判断**——判别依据就是那份声明列表本身，这也是它对一个我们都没听说过的 provider 依然有效的原因。

### 安全规则

harness 会在**发起 provider I/O 之前**用路由的声明校验档位，不支持的档位直接抛 `UNSUPPORTED_REASONING_EFFORT`，整个模型调用失败。所以一个"猜"的插件不只是没用，它会毁掉这一轮。

`dsh-fast-mode` 只发出该路由声明过的 id。问不到的时候——没有 `llm` 服务、适配器抛异常、发现耗时超过 `discoverTimeoutMs`、provider 根本没声明档位——它**什么都不发**，请求按没有插件时的样子继续。最坏情况是"没效果"，绝不会是"弄坏这一轮"。

## 它不做什么

**不往会话里加 token。** 观察数据在进程内存里。它从不写会话、不注入上下文、不碰工具结果。唯一影响是模型思考多少。

**不修改工具结果。** 两个 hook 都是纯观察者：给什么决策就转发什么决策。

**不压缩上下文。** 工具输出原样保留。

**不让模型发出并行工具调用，也不声称能。** DSH 的并行由每个工具定义上的 `isConcurrencySafe` 决定，而且只对模型已经在同一个 block 里发出的调用生效。宿主插件无法凭空造出模型没发出的调用。想减少往返轮次，杠杆是在一个 block 里批处理独立调用——那是模型行为，插件补不回来。

**不消除 I/O 等待。** 一轮如果被 60 秒超时主导，任何档位设置都救不了；策略能识别这种情况并停止降档。

**不改写工具参数。** `tools/pre-execute` 只能返回决策（`allow` / `deny` / `ask` / `cancel`），没有改写分支，所以插件无法从这里缩短某个命令的超时。给慢命令设上限属于 agent 遵循的指令层，不属于 gate。

## 安装

```bash
git clone https://github.com/regrevia/dsh-fast-mode.git
```

然后用插件管理器安装目录（推荐——它会连好 profile 依赖并应用 bundle patch）：

```
plugin_manager install_bundle /absolute/path/to/dsh-fast-mode
```

或者手工在 `~/.dsh/profiles/<profile>/` 里：

```jsonc
// package.json
"dependencies": { "dsh-fast-mode": "link:/absolute/path/to/dsh-fast-mode" }
```

```yaml
# cordis.patch.yml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
```

```bash
pnpm install && dsh web
```

**需要重启。** 导入时不做任何事。

## 配置

全部可选，下面是默认值。

```yaml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
      config:
        enabled: true
        floor: low               # 策略允许选择的最低档位
        deepAfter: 6             # 多少次干净调用后才允许再降一档
        slowMs: 5000             # 慢到这个程度说明卡在 I/O，保住思考
        bigChars: 20000          # 结果大到这个程度说明要消化很多，保住思考
        window: 8                # 信号回看多少次调用
        escalateAfterStep: 0     # 一轮超过 N 步后恢复完整思考；0 关闭
        ladder: ["off", "low", "high", "max"]   # 可选：写死档位，跳过发现
        aliases: auto            # auto | false | { "<声明 id>": "<生效 id>" }
        discoverTimeoutMs: 250   # 询问 provider 声明档位的耗时上限
        baselineFromDefault: true # 未解析出档位时，以路由默认档位为基准降档
        debug: false
        debugFile: ""
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 让插件完全不做任何事 |
| `floor` | `low` | 永不选比它更便宜的档位；官方路由上 `floor: high` 等于完全不降档 |
| `deepAfter` | `6` | 连续干净调用几次后允许第二档降幅 |
| `slowMs` | `5000` | 达到该耗时即保住思考 |
| `bigChars` | `20000` | 结果达到该体积即保住思考 |
| `window` | `8` | 参考的最近调用条数 |
| `escalateAfterStep` | `0` | 很长的轮次恢复完整思考；`0` 关闭 |
| `ladder` | — | 显式固定档位（≥2 个 id），用于发现不可用或不想要发现时 |
| `aliases` | `auto` | 把文档化的兼容别名折叠到生效档位；`false` 关闭，给 map 则覆盖 |
| `discoverTimeoutMs` | `250` | 等路由声明多久，等不到就不带它决策 |
| `baselineFromDefault` | `true` | 没有已解析档位时，把路由的 `defaultEffort` 当作基准往下降 |
| `debug` / `debugFile` | 关 / `""` | 每个请求一行日志，带上决策依据 |

### 确认它在工作

`debug: true` 加一个 `debugFile`，然后跑一轮真正有工具调用的任务：

```
turn=1 step=19 high=>low      route=provider   obs=2 clean=2 err=0 slow=24ms big=114c rep=1
turn=1 step=20 high=>low      route=provider   obs=4 clean=4 err=0 slow=27ms big=1153c rep=1
turn=8 step=21 high=>high     route=provider   obs=5 clean=0 err=1 slow=1820ms big=9002c rep=1 STRUGGLING
```

`route=` 说明档位是从哪来的：`provider`（发现到的）、`provider+aliases`、
`configured`（由 `ladder` 写死）、`provider-none`（该路由没声明档位）、
`none`（发现不可用且没有写死）。`[fast-mode]` logger 还会为每条路由打印一次解析出的档位链。

如果每行都是 `high=>high`，按这个顺序查：步号有没有到 2（规划步按设计豁免）；该路由报的是 `route=provider` 而不是 `none`（没配 `reasoningEfforts` 的路由没有档位可降）；当前档位是否已经高于你设的 `floor`。

## 为什么它对上下文无状态、但对运行有状态

看起来更省事的做法是去读会话里最近的工具调用。但那个输入从请求 hook 里并不可靠地拿得到：会话记录在别的进程里持久化，而 `agent/pre-step` 只带 messages。

建立在拿不到的输入上的策略不会响亮地失败——它读到空列表，判断"没数据，保持当前档位"，然后看起来已经装好了，实际什么也没做。这个插件改从 `tools/post-execute` 取运行行为，那是真正会送到的；即使它抛异常，也退回到纯粹的步号规则。

实际生效的档位是从解析后的配置里读出来的（`await next()`），不是重新拼装的，所以插件从不需要猜 harness 决定了什么。

## 兼容性

两个扩展点：`agent/request`（返回修改后的 `LlmCallConfig`）和 `tools/pre-execute` / `tools/post-execute` 观察者，外加一次前向查询 `ctx.get('llm')` 用于取路由声明。不 import 任何 `@deepseek-ai/*`，所以没有 peer 依赖版本要对齐。

## 测试

```bash
npm test
```

55 个测试，无网络、不需要 harness。策略测试覆盖规划步豁免、单档与双档降幅、floor、"不上调"规则、每个挣扎信号单独生效、按轮重置、按 agent 隔离、观察内存有界、畸形参数处理、配置归一化（`floor` 打错字会退到默认值，而不是取消 floor）。

对可移植性真正关键的是 provider 那组：它们把策略跑在**官方适配器真实的声明**（`off/low/high/max`）、文档里更宽的别名列表、五档自建网关、以及完全不声明档位的路由上——其中包含一个性质测试：任何输入都不可能产出该路由没声明过的 id。集成测试用一个假 context 按 harness 顺序驱动注册进去的 handler（发现存在、缺失、抛异常、慢、缓存升级），这才能证明 hook 真的接上了——只跑策略测试的话，即使 `apply()` 什么都没注册也照样通过。

## 诚实的预期

机制就是执行步更小的思考预算。在五档网关上，一档是 `8192 → 2048`；官方四档链上，一档是 `16384 → 2048`，因为中间没有别的档。省下多少墙钟时间取决于思考在你那一轮里占多大比重——在上面那个会话里，生成占绝对主导（每轮约 44 秒，对比工具调用中位数 67 毫秒），而这正是它针对的情形。

它救不了卡在慢命令上的轮次，也不是批处理独立调用的替代品。

## 许可

MIT
