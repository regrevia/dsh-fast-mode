# 参考手册：原理、配置与边界

本手册描述 **dsh-fast-mode 1.0.0** 的实际行为，对应仓库里的 `index.js`、`src/` 与 `client.js`。它不是宣传页：凡是能测量的地方给出数字，凡是没测量的地方直接说没测量。

**唯一的契约：Fast 模式从不改变思考强度、thinking 预算或模型。** `agent/request` 钩子只做一件事——`await next()`，读一下请求携带的 `reasoningEffort` 记进测量，然后原样返回。用户选的是哪一档（会话里的 UI 选择，或者 profile 里 agent-default-model 固定下来的那一档），每个请求就用哪一档。

快的部分只来自三件事：更少的往返、更少的过程文字、更少的卡顿等待。下面逐条说明。

## 交互细节：闪电开关与会话归属

- **一个图标就是开关。** 会话输入区的活动槽（`conversation.input.activity`）里只有一个闪电按钮：关闭时空心，开启时实心。点一下切换，再点一下切回。没有档位选择器，没有箭头，没有"选择 gear"的二级菜单，也没有面板。
- **按钮只表达一个问题：这个会话开不开。** `aria-pressed` 就是状态，tooltip 写清"仅本会话 · 思考强度不变 · 点击关闭"。为什么快、快在哪里、单次调用上限这类说明放在插件介绍（`meta.description` 与配置项描述）里，不再占用输入区。
- **实时行引用的是被执行的数字**，而不是产品形容词：
  - 开启、看门狗有上限：`自动调度 · 并行 2–8 · 单次调用 ≤ 2 分`
  - 开启、看门狗关闭（`stallGuard: false`，或 `toolTimeoutMs` 为负数）：`自动调度 · 并行 2–8 · 单次调用不限时`
  - 关闭：`已关闭 · 完全回到原生行为`
- **按钮只写它确定的事。** 一次点击只写 `enabled`、`gear`（恒为 `auto`）与 `sessions` 列里本会话的条目，并带上读到的 revision。它不写思考强度，也不写并行宽度：宽度是 host 端按步变化的内部状态，界面展示不了，也就不假装展示。
- **写路径。** 点开关会用一次 `settings/update` 同时提交 `enabled`、`gear`、`sessions` 三个字段，并带上它读到的 `revision`；先乐观更新，再在短时间内轮询确认。被拒绝（revision 过期、profile 只读）就整体回滚并显示原因，按钮不会卡死；读取失败显示错误，点击可重试。写入的 `gear` 永远是常量 `auto`。

## 怎么做的

### 一、不变的部分：模型、供应商、思考强度

1.0.0 把整套"降档"机制**删掉了，而不是关掉了**：`floor`、`ladder`、`aliases`、`deepAfter`、按步降档的阶梯、`ludicrous → off` 的特殊行为，以及按错误/延迟自选 effort 的启发式，都随代码一起消失。在配置里继续写这些字段不会报错（schemastery 会原样保留未声明的键），但**没有任何效果**。

请求钩子的完整逻辑是：

1. `const resolved = await next()`；
2. 读 `resolved.reasoningEffort`、路由名，写进测量标签；
3. `return resolved`。

它不写 `reasoningEffort`，不写 thinking 预算，不换模型，也不添加任何 provider 专用字段。因此"更快"只剩下三个真实杠杆：并行扇出（减少往返）、输出纪律（减少过程文字）、卡顿看门狗（减少工具等待）。思考深度和解码速度不在其中——前者是用户的契约，后者任何提示词都做不到。

### 二、自适应调度器：`gear: auto`

`auto` 是唯一面向用户的档位。它按会话自己的历史，每步重新决定两件事：这一步要不要提速（以及多宽），和单次工具调用最多等多久。**只在证据表明这一步是“多个互不依赖的读”时才提速，其余保持原生。**

常量都在 `src/auto.js` 的 `AUTO_LIMITS` 里：

| 名字 | 值 | 含义 |
|---|---|---|
| `parallelMin` / `parallelBase` / `parallelMax` | 1 / 4 / 8 | 原生（不提速）、首次探测、最宽 |
| `widenAfterSteps` | 2 | 进入"按表现调宽度"的步数门槛 |
| `stallFloorMs` / `stallCeilMs` | 120000 / 300000 | 看门狗预算的夹取区间（2–5 分钟） |
| `stallMultiplier` | 3 | 用最近延迟的 p90 乘 3 作为预算 |
| `noProgressWarn` / `noProgressStop` | 6 / 12 | 连续无进展的提醒线、停止线 |
| `turnStepBudget` | 30 | 累计步数达到后要求停下来汇报 |
| `waitWindow` | 32 | 参与 p90 的最近调用数 |
| `directiveCooldown` | 3 | 两条调度指令之间的最小步距 |

宽度按下面的顺序算，命中即停：

1. 会话里还没有任何调用：**4**（只做一次低成本探测）；
2. 连续无进展 ≥ 3 步，或者错误数 ≥ 3：**1**（原生，整段提示不渲染）；
3. 上一步是纯读，且每个调用的目标互不相同（“独立读块”）：**8**；
4. 连续 ≥ 2 步纯读、且上一步 ≥ 2 个调用：**8**；
5. 轮内已走 ≥ 1 步、上一步纯读且 ≥ 3 个调用：**8**；
6. 轮内 ≥ 2 步、上一步 ≥ 2 个调用：**8**；
7. 新的一轮请求、历史里没有并行形状：**1**（原生）；
8. 其余：**1**。

**宽度 1 就是原生。** 提示段在宽度 ≤ 1 时整段渲染为空，看门狗仍按自己的预算工作。所以写密集、强依赖、或一直在报错的回合，不会被催着批处理，也不用为这段提示付输入 token。

**“独立读块”是程序化判据**：这一步所有调用都在 `SAFE_CALLS` 里（`bash` 故意不在），且参数签名两两不同（没有两个调用读同一个目标）。这排除了“看起来批了、实际是链”的形状——两个调用读同一路径时，后者很可能依赖前者的结果。

"无进展"的判定是可见的，不是语义的：同一组（工具名, 参数）再次出现，返回字符数与上次相同，且上次没有报错，就算一次无进展；新签名、上次失败这次成功、返回大小变化，都算进展。这样同一命令的成功重跑不会被当成新信息。

看门狗预算：取最近 32 次工具调用时长的 p90，乘以 3，夹在 120–300 秒之间。还没有样本时 p90 为 0，夹取后就是起点 120 秒，随会话变慢而放宽、变快而收紧。

调度指令：连续无进展达到 6 步发一条"换个做法"；达到 12 步，或累计步数达到 30，发一条"停下来汇报"。两条指令之间至少隔 3 步。指令以 producer-owned notice 的形式插进消息列表（source 是 `plugin:fast-mode`），模型读得到，会话记录里也看得到。

计数口径：`turnSteps` 按轮计数。`index.js` 在 `session/event` 的 `turn/start` 上调用 `noteTurn` 清零每轮计数，会话级的"试过什么、卡了多久"记忆则保留——这正是卡住时循环要重读的东西。所以 30 步的停止线是**每轮** 30 步，不是整段会话的总预算。

### 三、提示词引导：`fast-mode:execution-speed`

提示段的名字与顺序是固定的：`fast-mode:execution-speed`，`order: 520`，紧挨着计划策略和其他跨领域执行引导。它按请求渲染，内容随会话的实时宽度变化：

- 关闭，或宽度 ≤ 1：整段不注册（渲染成空字符串被丢弃）；
- 开启且宽度 > 1：依次是批量规则、扇出目标、可选的预取、有界的调用方式、输出纪律。

几个值得注意的细节：

- **扇出目标里的数字就是调度器算出的宽度。** `auto` 下提示段和看门狗共用同一个 `autoSchedule` 结果，所以模型读到的数字和被执行的数字不会漂移。
- **预取只在宽度 ≥ 4 时出现。** 宽度不够时多取一个调用只会挤占别的工作。
- **有界调用那一段只在 `stallGuard !== false` 时出现**，因为它描述的规则和看门狗是一套东西。
- **输出纪律有两档**：`light` 给旧档位 `fast` 用，`full` 给 `auto`/`turbo`/`max`/`ludicrous` 用。两档只裁剪过程叙述——不预告调用、不复述结果、不写进度报告；最后一步的答案仍然要完整写出。`full` 只多一句"不需要文字时只发调用"。**它不会让答案变短，更不会让模型跳过检查。**
- **`parallel: 1` 是"开着但不要求扇出"的正式写法**：开关仍然生效于看门狗，提示段整体消失。

成本是明码标价的：`auto` 下这一段约 2.7 千字符，每个请求都要付这部分输入 token。这是有意的交换——用输入 token 换更少的往返。

### 四、卡顿看门狗：单次调用的天花板

它挂在 `tools/execute` 这个 waterfall 上，遵守文档允许的唯一改法：只替换 `exec.signal`，让调用体与一个计时器赛跑，超时就 abort 并把失败结果交还给模型；取消时留 250 ms 宽限，让工具自己收尾；无论结果如何，调用方原来的 signal 都会在 `finally` 里恢复。

它只作用于 **shell / 脚本类**工具（名字匹配 `bash|shell|sh|zsh|exec|pwsh|powershell|cmd|script|monitor|terminal`）。问用户、等后台任务、等子代理这类"本来就要等"的工具被显式豁免：`ask_user_question`、`wait_agent`、`job_output`、`job_list`、`task_board_run`、`workflow`、`subagent`、`subagent_fork`、`run_code`。

预算优先级从高到低：

1. `stallGuard: false` → 0（完全不看门狗）；
2. `toolTimeoutMs < 0` → 0（同上，用数值表达）；
3. `toolTimeoutMs > 0` → 这个固定值，所有档位一致；
4. 否则按档位表取初始值：

   | 档位 | 初始上限 |
   |---|---|
   | `safe` | 0（不看门狗） |
   | `auto` | 120 秒，随后由调度器接管 |
   | `turbo` | 180 秒 |
   | `max` | 120 秒 |
   | `ludicrous` | 90 秒 |
   | `fast` | 300 秒 |
   | 未知名 | 300 秒 |

5. 在 `auto` 下，如果初始值非 0 且没有显式 `toolTimeoutMs`，就用调度器按最近 p90 算出的实时预算覆盖上表。

被取消时返回的是正常的工具失败结果（`isError: true`），正文告诉模型"这次调用跑了 N 秒被取消了"，并给三条具体建议：把服务/监听放到后台、把长命令写进文件再执行、把全量扫描收窄成一次窄探测。最后一句明确：不要原样重发同一条命令，它还会被取消。

### 五、开关状态跟着会话走

状态分两层，都在配置的同一个 `sessions` 列里：

- **共享字段 `enabled` / `gear`** 是默认值，也是最近一次选择。新会话没有自己的条目时沿用它。
- **`sessions` 列**是每个会话自己的条目：`{"<sessionId>": {"enabled": true, "gear": "auto", "ts": 1730000000000}}`。读取时逐字段优先于共享字段；写入时两者在同一次 patch 里更新，所以不会出现"开关已经切了、档位还没跟上"的中间态。

上限是 200 个会话，超出时淘汰 `ts` 最旧的条目——这是内存与配置文件体积的边界，不是权限模型。host 端的实现（`src/state.js`）和浏览器里的副本（`client.js`）是两份代码，测试用同一组 fixture 锁住它们的读写一致。

## 配置

放在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: fast-mode
  config:
    enabled: true
    gear: auto
    # parallel: 4            # 可选：初始并行目标，auto 会随后续步骤调整
    # outputDiscipline: true   # 或 late / false
    # stallGuard: true
    # toolTimeoutMs: 0
    # reassertAfterCompaction: true
    # metrics: true
```

`enabled`、`gear`、`parallel`、`sessions` 四个字段是 `.volatile()`：它们会出现在 Web UI 的插件页表单里，并且修改能直接作用到运行中的 fiber。其余字段是组合级的排障开关，只在 patch 里生效，不占表单。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关。关闭时完全回到原生行为：不注入提示段、不看门狗、不换档。默认关闭是为了让"关掉就是关掉"可验证。 |
| `gear` | `'auto'` | 调度方式。`auto` 是唯一面向用户的档位；`safe` 保留给实验脚本；`fast`/`turbo`/`max`/`ludicrous` 是旧的固定宽度，写在配置里会被解析成 `auto` 并打一条弃用日志。 |
| `parallel` | 由档位推导，`auto` 下为 4 | 并行上限的初始值，1–8。`auto` 只把它当起点；设为 1 表示不注入批量提示段。 |
| `sessions` | `''` | 插件自动维护的会话级覆盖，见上一节。**不要手改。** |
| `outputDiscipline` | `true` | 输出纪律。`true` 全程生效；`late` 只在第 4 步之后由调度器提醒一次（短任务零成本，长任务实测 8 对：步数 16.5→10.5、输出 −26%、墙钟 1.49×、正确性 16/16 不变）；`false` 关闭，仍注入并行与有界调用规则。 |
| `stallGuard` | `true` | 是否给单次 shell/脚本类调用加上限。`auto` 下预算在 2–5 分钟之间自适应。 |
| `toolTimeoutMs` | `0` | 单次调用上限，单位毫秒。`0` = 自适应（见 `stallGuard`），负数 = 关闭看门狗，正数 = 所有档位统一用这个值。 |
| `guidance` | `true` | 是否向模型注入提示段。关掉后调度、宽度计算、看门狗照常，只是不写任何提示文字——用来把“提示词的效果”和“harness 层面的效果”分开测。 |
| `shellParallel` | `false` | 是否注册 `shell_parallel` 工具（一次调用内跑多个独立 shell 作业）。默认关闭：2026-10-24 实测 6 个 5 秒作业，原生 9.1 s vs 开工具 26.3 s（0.35×）——模型本来就会用 `&` + `wait` 自并行，多出的工具诱发复核步骤。 |
| `reassertAfterCompaction` | `true` | 上下文被压缩后的下一次请求，补一条极短 notice，重申批量与有界调用两条规则。提示段本身不受影响。 |
| `metrics` | `true` | 是否写计量文件。关闭则不落任何文件。 |
| `metricsFile` | `~/.dsh/fast-mode-metrics.jsonl` | 计量文件路径，每步一行 JSONL。 |
| `benchmarkFile` | `~/.dsh/fast-mode-bench.json` | 实验分配文件路径。文件不存在或 `enabled` 不为真时不启用分配。 |

关于旧名字：schema 仍然接受 `fast`、`turbo`、`max`、`ludicrous`（否则旧 patch 会加载失败），但用户配置里出现它们时，`resolveConfig` 会改成 `auto` 并在加载日志里警告"这个名字以前会降低思考强度，现在跑自动调度，强度保持不变"。实验脚本的按会话 override 是例外，它保留原样（见"按会话分配档位"）。

关于 `safe`：它是实验对照组，不是给用户选的档位。它声明了 `directive: false`，因此 `resolveConfig` 把宽度压到 1、提示段整段消失、看门狗预算为 0——也就是"插件在场但不干预"。

## 与压缩类插件共存的细节

本插件管的是**执行**：一次请求里能并行几个调用、模型写多少过程文字、单次调用等多久。压缩类插件管的是**输入历史**：消息列表多大、多少旧图片被搬走。两者作用在不同层，字段不重叠，可以叠加。

三条规则让它们真的能一起用：

1. **不抢同一个字段。** 本插件不碰 `reasoningEffort`、`thinking`、`output_config`，所以没有任何"两个组件同时钳制 effort"的问题。
2. **压缩步骤不需要特殊照顾。** 1.0.0 没有"按住某一步"的概念；历史折叠发生在请求发出之前，本插件看到的只是一个普通请求。
3. **摘要调用碰不到。** 压缩器自己的摘要请求往往跑在它自己的进程或 HTTP 层里，不经过 `agent/request`，本插件既不影响它，也不被它影响。

### billion-context

**兼容且互补。** billion-context 以 DSH bundle（`bili-native`）安装，关掉宿主平面 `compaction-basic` 的 auto，并通过 patch HTTP 层拦截模型流量（`globalThis.fetch`），不走 `agent/request`，也不读写 `reasoningEffort`。它和本插件没有共享字段，不需要为对方改配置。

唯一值得看一眼的是它自己的 `compress.outputSteering.effortRouting`：那个开关会在"机械延续"的轮次把 effort 往低压。它不再是本插件的竞争对手（本插件根本不碰 effort），但它会破坏"强度保持你选的那档"这个承诺。如果你在意这个承诺，把它关掉：

```yaml
- id: bili-native
  config:
    compress:
      outputSteering:
        enabled: true
        effortRouting: false    # 强度由用户选择，不由压缩器改写
```

另外两点是事实，不是建议：billion-context 自己的摘要调用跑在它的代理进程里，不经过 harness，本插件碰不到；它会关掉 `compaction-basic` 的自动压缩，所以**别再叠第二个压缩器**。

### 历史图片自动压缩 / 网关适配插件

`image-guard`、`intellif-litellm-adapter` 这类插件修的是另一种失败：在请求发出前重写消息列表（搬走老图片、强制再压一轮、重试 `too_many_images` 的 400），以便穿过网关的图片数量 / 像素 / 上下文上限。它们和本插件不共享任何字段，不需要改配置，也不需要把工具名交给本插件"保护"——1.0.0 没有这样的名单。

同一 profile 里**只留一个图片削减者**（billion-context 也会在服务端折叠媒体），否则两次压缩互相踩。

### `dsh-batch-tool-calls` 与 `dsh-ops`：不能和本插件同时启用

这两个不是"配置一下就能共存"的邻居，是**功能重叠**：同时开会让同一件事被收费两次，有时还会互相打架。

- **`dsh-batch-tool-calls`** 注册的是它自己的批量调用提示段。本插件注册的是它的超集：按会话生效的宽度、随表现变化的并行目标、输出纪律、有界调用规则、压缩后补一条提醒。两个都开着，同一份提示要付两遍钱，而且两段文字可以给出不一致的并行目标。
- **`dsh-ops`** 用自己的工具替掉 shell 与文件工具（`ops_bash`、`ops_grep`、`ops_glob`、`ops_inspect_local_file`、`ops_replace` …），而且只带 Windows 二进制。本插件的引导段讲的是"用那个 shell 做事"——给调用设上限、把服务放后台、别用 heredoc；装了 `dsh-ops` 就等于有两个 shell、两套规则，要么重复要么冲突。

本插件加载时会检测这两个（在 profile 的 `package.json` / `cordis.patch.yml` 里找包名，另外用一次实时的 `ops_bash` 工具探测），命中就在会话里**只说一次**冲突，不阻塞加载。修法只有一条：**删掉其中一个**。

## 官方 API 支持

**完全支持，而且不需要任何配置。** 官方 DeepSeek API（`deepseek-official`）、官方 API 前面挂的代理和中转、自建网关（如 `litellm` + Anthropic Messages）、OpenAI 兼容端点，行为完全一样，原因很简单：

- 请求体原样进出。本插件不写 `reasoningEffort`、不写 `thinking`、不写 `output_config`，也不添加任何 provider 专用字段；
- 不做"这条路由声明了哪些档位"的过滤和降档。没有 `floor`，没有档位阶梯，没有按步降档；
- 路由名只被记进测量和调试日志，不参与任何决策。

所以无论 provider 声明的是 `off/low/high/max`、还是 `minimal/low/medium/high`、还是只有一档、还是什么都没声明，本插件的行为都一样：它注入提示段、给 shell 调用设上限，然后把你选的 effort 原样发出去。

## 测量、实验与报告

测量留在插件里，而且**关闭态也记录**——只记录开启态的话，就没有基线可对比。

### 每个完成的步写一行

计量文件是 JSONL，每个完成的模型步一行，懒创建、失败不影响请求（写不进去就静默放弃）。版本号是 `v: 1`，字段如下：

| 字段 | 含义 |
|---|---|
| `v` | 计量格式版本，当前为 1 |
| `ts` | 这一步结束的 ISO 时间 |
| `sid` / `turn` / `step` | 会话 id、轮次、步号 |
| `mode` / `gear` | `on` 或 `off`；关闭时 gear 记为 `off` |
| `effort` | **请求实际携带的思考强度，原样记录，不做任何改写**——这是"插件没有动 effort"的证据 |
| `route` | 路由/模型的标签，仅用于分组 |
| `ttftMs` | 首字延迟：步开始到第一条 assistant 消息 |
| `llmMs` | 模型耗时：步开始到最后一条 assistant 消息 |
| `stepMs` | 整步耗时，含工具等待 |
| `calls` / `errors` | 本步的工具调用数与失败数 |
| `input` / `output` / `reasoning` | 上游 usage 的输入、输出、推理 token；拿不到就不写 |
| `cacheRead` / `cacheWrite` | 上游 usage 的缓存读写 token |
| `assistantMessages` | 本步的 assistant 消息数 |

`effort` 这一列是理解 1.0.0 的关键：它记录的是请求**实际带出去的**值。如果你在 UI 里选了 `high`，每一行就是 `high`；插件不会把它改成别的。

### 每个会话自己的开关

`sessions` 列的数据契约（也是你在导出配置时会看到的东西）：

```json
{"<sessionId>": {"enabled": true, "gear": "auto", "ts": 1730000000000}}
```

- 读取顺序：本会话条目 → 共享 `enabled`/`gear` → schema 默认值；
- 条目里缺哪个字段，就退回共享字段的那个字段，而不是整体失效；
- 写条目和写共享字段在同一次 patch 里完成；
- 上限 200 条，超出淘汰 `ts` 最旧的；`enabled` 必须是布尔、`gear` 必须是字符串、`ts` 必须是有限数，损坏的条目会被丢弃而不是让整列失效。

### 按会话分配档位

实验文件（默认 `~/.dsh/fast-mode-bench.json`）存在且 `enabled: true` 时，插件按会话 id 的 FNV-1a 哈希把会话分到不同档位，做到同一账号下随机对照：

```json
{
  "enabled": true,
  "gears": ["off", "safe", "fast", "turbo", "max"],
  "sessions": { "<sessionId>": "max" }
}
```

- `sessions` 里的显式钉子优先于哈希，用来把某个重要会话固定到某一档；
- `off` 是对照组，表示关掉插件；
- 不认识的名字被过滤掉并只警告一次；文件坏了也只警告一次，然后当作不存在；
- 文件改动最多 1 秒生效（TTL 1 秒），不需要重启。

分配结果在请求路径上**优先于**按会话的开关——这是实验期间"别手动干预"的原因：按钮显示你上次的选择，而实际执行的可能是分配到的档位。

### 报告：`dsh-fast-mode-report`

```bash
dsh-fast-mode-report                  # 默认文件，全部历史
dsh-fast-mode-report --since 2d       # 只最近两天
dsh-fast-mode-report --json           # 机器可读
dsh-fast-mode-report --file ./m.jsonl # 另一个文件
dsh-fast-mode-report --lan            # 附带局域网用量面板对照
```

输出分三块：

1. **按 `mode|gear` 分桶的主表**：会话数、步数、步/轮、步耗时 p50/p90、模型耗时 p50、首字 p50、输出 token/步、输出 token/会话、工具调用/步、多调用步数；
2. **相对关闭态的倍率表**（有基线时才出现）：模型耗时倍率、步耗时倍率、输出比例、每会话 token 比例、调用数比例。`> 1×` 表示该档位更快或更贵，看列名；
3. **口径说明**：比较单位是"模型步"而不是整个会话（会话墙钟还包含人读和打字）；模型耗时与首字的定义；倍率基于均值，样本少时会抖动。

没有关闭态样本时它不会编倍率，而是直接告诉你"去关掉跑一遍"。`--lan` 需要 `USAGE_TOKEN` 环境变量（`USAGE_BASE` 可选），只读；缺 token 或请求失败只打印一条说明，不影响本机报表。

### 实验：`dsh-fast-mode-experiment`

```bash
dsh-fast-mode-experiment start        # 写实验文件
dsh-fast-mode-experiment status       # 看进度和每档样本数
dsh-fast-mode-experiment stop         # 结束实验
```

选项：`--bench`、`--metrics`、`--gears a,b,c`、`--sessions n`（只影响 status 的提示）、`--force`（覆盖已有实验文件）。默认实验臂是 `off,safe,fast,turbo,max`——注意这些是**旧的固定宽度臂**，按会话 override 原样执行：`fast` 是 4 宽 + 轻量输出纪律，`turbo` 是 6 宽，`max` 是 8 宽，`safe` 是"在场但不干预"，`off` 是对照。想看自适应调度器本身的效果，把 `auto` 加进 `--gears`。

实验文件和计量的配合方式：`start` 后跑任务，`status` 看每档是否够样本，`stop` 结束；再用 `report --since` 看倍率。样本太少时倍率会抖，这是统计事实，不是插件行为。

## 安全边界

- **只观察，不改写。** `tools/pre-execute` / `tools/post-execute` 是纯观察者（记录开始时间和调用结果），`agent/request` 原样返回请求。除了注入提示段和两条 producer-owned notice（压缩后提醒、调度指令），插件不往会话里写任何东西。
- **模型与 effort 不可写。** 源码里没有对 `reasoningEffort` 的赋值；测试会扫描源码，防止将来有人把它加回来。
- **设置只能由这次点击改，且带 revision。** 没有后台静默改配置的路径；冲突写入会失败并回滚，原因是 tooltip。
- **计量是本地的。** 只写 `metricsFile`；`--lan` 是唯一的出网路径，只读，需要显式 token。
- **看门狗只改 signal。** 调用方原来的 signal 在 `finally` 里恢复；取消后调用体的 rejection 被吞掉，不会变成未处理的拒绝。

## 诚实的限制

**时延账本。** 在这套网关上实测，一步的墙钟约等于 `720 ms + 6.63 ms × 输出 token` 再加工具等待（R² = 0.93，689 步样本）。这条式子说明：减少步数、减少工具等待是真杠杆；思考强度和原始解码速度不是——前者改写答案，后者任何提示词都做不到。

**扇出有前提。** 只有一步里真的存在多个互不依赖的查询时，加宽才有收益。单文件类的基准任务（HumanEval / AIME 形态）上，本插件测到的差异在噪声内（0.95×–1.09×），没有可测量的加速——那些任务本来就没有可并行的读集。把"这个插件让所有任务快 30%"当卖点是错的。

**1.0 的调度器还没有大规模 A/B。** 上面的常量来自小样本观测与设计推理；`auto` 的宽度策略、6/12 步的阈值、3 步冷却都还需要真实会话的对照数据。`report` 与 `experiment` 就是为了补这一课，而不是为了证明它已经成立。

**token 可能变多，而且这是接受的交换。** 更宽的步意味着每步塞进更多工具结果，输入 token 上升；输出纪律只减少过程文字，不承诺总 token 下降。不要用"省 token"来介绍这个插件。

**提示是建议，不是强制。** 模型仍可能每步只发一个调用。真正同时执行多少个调用还受 `agentLoop.maxParallelToolCalls` 限制；插件发现目标宽度超过这个上限时会警告一次，并给出一条 `cordis.patch.yml` 的改法。

**看门狗只看 shell 类工具。** 一个卡住的非 shell 调用（比如某个自定义工具的 promise 永不 resolve）不在保护范围内。被豁免的工具按设计不设上限——等用户、等后台任务本来就要等。

**客户端看不到实时宽度。** 它只在插件介绍里写 2–8；host 端为某个会话算出的当前宽度只出现在提示段和调试日志里。

**`turnSteps` 的计数口径。** 每轮由 `turn/start` 清零，30 步的停止线只约束单轮；跨轮保留的是调度记忆，不是步数预算。

## 开发与测试

模块分工：

- `index.js`：组装、钩子、按会话取配置、提示段注册；
- `src/auto.js`：调度器的状态、宽度、预算、指令；
- `src/guidance.js`：模型可见的提示文本；
- `src/stallguard.js`：看门狗与预算优先级；
- `src/effort.js`：档位表与旧名字归一化（不再有 effort 阶梯）；
- `src/config.js`：schema 与表单字段；
- `src/state.js`：`sessions` 列的解析与编码；
- `src/notices.js`：producer-owned notice 的构造与来源校验；
- `src/metrics.js`：JSONL 计量与汇总；
- `src/benchmark.js`：按会话哈希分配；
- `src/peers.js`：冲突插件探测；
- `client.js`：闪电开关（无面板）与按会话的写入。

跑测试：

```bash
node --test test/*.test.js
```

当前 172 个测试全部通过（0 失败）。测试覆盖：调度器宽度与指令、预算优先级、提示段的开关条件、`sessions` 列在 host 与浏览器两份实现间的一致性、notice 来源校验、计量字段、分配哈希、报告与实验 CLI 的参数解析，以及一条扫描源码、确认没有改写 `reasoningEffort` 的回归测试。

文档入口：`README.md`（中文）、`README.en.md`（English）、`BENCHMARK.md`（测量方法与历史数据）、`CHANGELOG.md`（每个版本删了什么、加了什么）。
