# dsh-fast-mode

**DeepSeek Harness 自己的 fast 模式：把思考花在真正做决定的地方，不再为每个执行步重复付费。**

零依赖、免构建的 DSH 宿主插件。它观察你的工具调用实际进行得如何——失败、挂起、超大结果、重复调用——并据此调整下一次模型调用的 `reasoningEffort`。

[English](./README.md)

## 为什么做这个

DSH 的一"轮"不是一次模型调用。宿主会为**每一步**重新解析请求配置，每步都付一次思考预算来决定"接下来做什么"。

在一个真实的 10 轮会话上实测（617 次工具调用）：**91% 的步只发出 1 个工具调用**，且 95% 的调用在 100ms 内完成。时间不是花在跑工具上，而是花在两次工具之间的反复斟酌上。

按多数部署使用的预算表：

| 档位 | 思考预算 |
|---|---|
| `off` | 0 |
| `minimal` | 1024 |
| `low` | 2048 |
| `medium` | 8192 |
| `high` | 16384 |

一轮跑在 `medium` 上，第 2、3、4 步每步都付 8192 token 的规划预算去想"下一个该读哪个文件"。`dsh-fast-mode` 让这些步更便宜，而一旦活儿不再例行，就立刻把预算还回去。

## 它怎么判断

**没有任何按工具名写死的规则。**策略读的是这一轮的实际表现。

**保持全档思考的信号**（质量守门），近期窗口里出现任一即认为下一步不是例行操作：

- 有工具调用失败；
- 某次调用超过 `slowMs`——这一轮是 I/O 受限，思考不是瓶颈，砍掉它只会砍掉诊断能力；
- 单个结果超过 `bigChars`——有大量内容要消化；
- 同一个调用（名称+归一化参数）跑了两次——是循环。

**允许更深降档的信号：**

- 连续干净调用形成的连胜——成功、快速、结果小。连胜达到 `deepAfter` 后允许再降一档。

**始终如此：**

- 一轮的第 1 步保持全档：计划在那里成型；
- 永不低于 `floor`（默认 `low`）；
- 永不向 `floor` 方向**回升**——已经比下限更便宜的模型不会被抬价，因为那等于提速悄悄变成减速；
- 词表之外的档位原样透传，绝不猜；
- 观察随轮次重置，难的一轮不会拖慢下一轮。

## 它不做什么

**它不给你的对话增加 token。**观察数据只在进程内存里，不写会话、不注入上下文、不碰工具结果。它唯一的作用是模型思考多少。

**它不修改工具结果。**两个钩子都是纯观察者：永远把收到的决定原样转发。

**它不压缩上下文。**工具输出原样保留。

**它不让模型发出并行的工具调用，也不声称能做到。**DSH 里的并行由每个工具定义的 `isConcurrencySafe` 决定，且只作用于模型**已经**在同一块里发出的多个调用。宿主插件无法凭空创造模型没要求的调用。想减少往返次数，杠杆是"把无依赖的调用并在一次发出"——那是模型行为，插件补不回来。

**它不消除 I/O 等待。**如果一轮主要卡在 60 秒超时上，任何档位都救不了；策略会识别这种情况并停止降档。

## 安装

```bash
git clone https://github.com/regrevia/dsh-fast-mode.git
```

然后通过插件管理器安装该目录（推荐——它会接好 profile 依赖并应用 bundle patch）：

```
plugin_manager install_bundle /绝对路径/dsh-fast-mode
```

或手工装进 `~/.dsh/profiles/<profile>/`：

```jsonc
// package.json
"dependencies": { "dsh-fast-mode": "link:/绝对路径/dsh-fast-mode" }
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

**必须重启。**import 阶段什么都不做。

## 配置

全部字段可选，以下是默认值。

```yaml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
      config:
        enabled: true
        floor: low             # 允许的最低档位
        deepAfter: 6           # 连续干净调用多少次后允许再降一档
        slowMs: 5000           # 调用慢于此值视为 I/O 受限，保持全档
        bigChars: 20000        # 结果大于此值视为重活，保持全档
        window: 8              # 信号回看多少次近期调用
        escalateAfterStep: 0   # 一轮超过 N 步后恢复全档；0 关闭
        debug: false
        debugFile: ""          # debug:true 时把决策追加到这里
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时插件完全不做任何事 |
| `floor` | `low` | 永不选择比这更低的档位 |
| `deepAfter` | `6` | 连续干净调用多少次可获第二档降幅 |
| `slowMs` | `5000` | 达到该耗时即保持全档 |
| `bigChars` | `20000` | 结果达到该体量即保持全档 |
| `window` | `8` | 参与判断的近期调用数 |
| `escalateAfterStep` | `0` | 一轮过长时恢复全档；`0` 关闭 |
| `ladder` | `off, minimal, low, medium, high` | 由低到高的档位名，仅在 provider 词表不同时候覆盖 |
| `debug` / `debugFile` | 关 / `""` | 每次请求一行，含决策依据的信号 |

### 确认它在工作

设 `debug: true` 和 `debugFile`，跑一轮有真实工具调用的任务：

```
turn=0 step=1 medium=>medium obs=0 clean=0 err=0 slow=0ms big=0c rep=0
turn=0 step=2 medium=>low    obs=1 clean=1 err=0 slow=61ms big=420c rep=1
turn=0 step=3 medium=>low    obs=3 clean=3 err=0 slow=61ms big=420c rep=1
turn=0 step=4 medium=>medium obs=4 clean=0 err=1 slow=61ms big=420c rep=1 STRUGGLING
```

第四行是关键：出现了失败，所以思考被立刻还回来了。

如果每行都是 `medium=>medium`，请确认 `enabled` 为 true、步号确实到了 2、以及你的 provider 解析出了档位（没有配 `reasoningEfforts` 的 provider 没有档位可降）。

## 为什么它对上下文无状态、但对运行有状态

最省事的写法是去翻会话里最近的工具调用。但那个输入从请求钩子里并不可靠可达：agent 句柄只带一个 id、`agent/pre-step` 只带用户消息、会话记录是跨进程持久化的。

**建立在拿不到的输入上的策略不会报错**——它读到空列表，判断"没数据，保持当前档位"，然后看起来装好了、其实一直在空转。本插件改为从 `tools/post-execute` 取这一轮的真实行为（那是确实会送达的），并且即使它抛错，也退回纯步号规则。

## 兼容性

两个扩展点：`agent/request`（返回修改后的 `LlmCallConfig`）与 `tools/pre-execute` / `tools/post-execute` 观察者。不 import 任何 `@deepseek-ai/*` 包，因此没有 peer 依赖版本要跟。

## 测试

```bash
npm test
```

23 个策略测试加 10 个集成测试，`npm test` 全部运行。策略测试覆盖：规划步豁免、单档与双档降幅、下限、不回升规则、四类"挣扎"信号各自独立生效、按轮重置、按 agent 隔离、观察内存有界、畸形参数处理，以及配置归一化（`floor` 拼错时退化为默认值、而不是取消下限）。集成测试用假 ctx 按宿主真实顺序驱动已注册的处理器——这才证明钩子真的接上了；只有策略测试的话，`apply()` 什么都没注册也照样全绿。

## 诚实的预期

机制就是执行步更小的思考预算。在 `medium` 上降一档是 `8192 → 2048`；从 `high` 降两档也到 `2048`。省下多少墙钟时间取决于思考在你那一轮里占多大比重——在上面那个会话里，生成占绝对主导（每轮约 44 秒，对比工具调用中位数 67 毫秒），而这正是它针对的情形。

它帮不了卡在慢命令上的轮次，也不能替代"把无依赖调用批量发出"。

## 许可

MIT
