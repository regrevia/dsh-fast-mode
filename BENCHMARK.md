# 实测：快在哪儿，不快在哪儿

这份文件回答一个问题，只回答这个问题：**开了这个插件，请求真的更快了吗？**

答案分两半，而且第二半不太好听：

- 插件**能**确定的：它把每步的耗时账目记了下来，并且在自建网关上把「一步里发多个工具调用」从 2% 提到 22–23%。
- 插件**不能**确定的：在一个干净的小任务上，档位高低对**单步耗时没有任何可测的影响**。四个档位每输出一个 token 的耗时都在 9.0–10.6 ms 之间，差距在噪声里。

数据来自本机真实会话（750 行、689 步可用于拟合），没有模拟、没有假设。下面每个数字都能用最后一节的命令重跑出来。

## 结论速览

| 结论 | 证据 | 强度 |
| --- | --- | --- |
| 单步耗时几乎完全由**输出 token 数**决定 | `ms = 720 + 6.63 × 输出tok`，R² = 0.93，n = 689 | 强 |
| `reasoning_effort` 在这条路由上**没有效果** | 四个档位 ms/token 9.0–10.6；按输出长度回归后，各档位残差都在 ±0.5 s 内 | 强 |
| 这条路由**不产出思考 token**，所以没有思考可削减 | 750 行里 `reasoning` 全为 0 | 强 |
| 档位越高、单步并行调用越多 | 多调用步占比：关闭 2% → `turbo`/`max` 22–23% | 中 |
| 档位越高、token 消耗越大 | 输出 tok/会话：关闭 58 k → `turbo` 142 k | 中（样本混杂，见下） |
| 0.8.0 的三个杠杆（更宽的步、投机预读、输出纪律）**确实更快** | 同任务 16 会话：中位 Σ步时 25.9 s → 15.6 s（−40 %），步数中位 7.5 → 4.5，p = 0.008 | 强（n 小、两臂不均，见实验 E） |

一句话：**在这台自建网关的 `company/deepseek-v4.1-flash` 上，调 `reasoning_effort` 不会让生成变快。** 想真的更快，只有两条路——更少的步，或更少的输出。0.8.0 就是照这两条路做的，实验 E 量到了它。

## 方法

- **比较单位是「步」，不是会话。** 会话墙钟里大部分是人在读和打字（本机 12 轮里，生成只占 59%），拿会话时长比快慢等于在测打字速度。
- 每步记一行 JSONL：`llmMs`（`step/start` → 最后一条 `assistant/message`）、`stepMs`、`output`/`input`/`cacheRead`/`reasoning`、`calls`、`effort`、`mode`/`gear`、`route`。
- **分档不靠手点**：实验文件按 `FNV-1a(会话 id) mod 档位数` 分配，同一个会话每次进来都落在同一档；`off` 是合法的对照组。手点分档会让"我觉得这档快"悄悄决定结果。
- 关闭状态的会话也照常记录，否则没有对照组。

## 实验 A：被自己的工具结果污染了

第一轮 6 个会话、24 步，任务一样，看似能比了。但它被一个信号卡住：会话里有一次工具调用返回了 **33,763 字符**的内容，超过 `bigChars` 阈值，`signals.struggling` 从此为真，于是降档逻辑一路把 effort 钉住。六个会话里有一个正好踩中，整组比较因此作废。

这一轮没有结论，写在这里是因为它暴露了插件自己的一个设计问题：`bigChars` 阈值太容易触发，一次 `git diff` 就能让插件在接下来的 6 步里拒绝降档。**这是插件的 bug，不是数据的问题。**

## 实验 B：控制住变量之后

8 个独立会话，同一条提示，同一个模型，同一台机器，同一分钟跑；每个会话正好 3 步，各自打印 `BENCH-DONE` 收尾。四组：`off` ×3、`safe` ×3、`turbo` ×1、`max` ×1，共 24 步。

| 档位 | 步数 | effort（步 1→3） | 模型耗时 p50 | 输出 tok/步 | **ms/token** |
| --- | --- | --- | --- | --- | --- |
| `off`（对照） | 9 | `medium` / `medium` / `medium` | 1978 ms | 247 | 9.08 |
| `safe` | 9 | `medium` / `low` / `low` | 1974 ms | 227 | 9.11 |
| `turbo` | 3 | `medium` / `low` / `low` | 2262 ms | 254 | 9.01 |
| `max` | 3 | `medium` / `low` / `low` | 2216 ms | 220 | 9.47 |

读法：

- 插件确实降了档 —— `safe`/`turbo`/`max` 从第 2 步起把 effort 从 `medium` 压到 `low`，对照组一直停在 `medium`。
- 但**每 token 的耗时一样**（9.01–9.47，波幅 5%），模型耗时均值也一样（2244 / 2071 / 2293 / 2081 ms）。降下去的那一档，模型没有反映在速度上。
- `turbo` 的总耗时略高，是因为它的输出更长（254 tok/步 vs 247），不是因为它慢。

## 实验 E：0.8.0 的三个杠杆真的更快

实验 A/B 只证明了「effort 不是杠杆」。实验 E 检验 0.8.0 换上的真杠杆：**让一步更宽（并行 + 预读）、让一步更少（少往返）、让每步更短（输出纪律）**。

- **任务完全一样**，而且答案可判定：读同一个仓库，回答四件事 —— ① `test/` 各文件 `test(` 次数、② `src/` 各文件行数、③ `package.json` 的 version / exports 键数 / 依赖、④ `git log -3` 与 `git status --porcelain`。
- **16 个独立会话，分两波各 8 个**，同一条路由（`company/deepseek-v4.1-flash`），同一份提示词，同时并发。档位仍由 `FNV-1a(会话 id) mod 2` 分配 —— 没有手点。
- 对照臂 `safe`（不注入任何引导段，等于插件之前的行为）；实验臂 `turbo`（并行目标 6 + 投机预读 + 完整输出纪律）。

**结果（每会话 Σ步时 = 该会话所有 stepMs 之和）**

| 指标 | `safe`（n=4） | `turbo`（n=12） | 变化 |
| --- | --- | --- | --- |
| Σ步时 中位数 | 25.9 s | **15.6 s** | **−40 %** |
| Σ步时 平均值 | 25.7 s | 17.4 s | −33 % |
| 步数 中位数 | 7.5 | **4.5** | **−40 %** |
| 每会话输出 token 中位数 | 3,798 | **2,180** | **−43 %** |
| 每步输出 token | 510 | 535 | +5 %（一步更胖，正是预期） |
| 每步工具调用 | 1.41 | 1.37 | 基本持平 |
| Mann–Whitney U（Σ步时） | — | — | U = 46，z = 2.67，**p = 0.008** |

两波各自的方向一致：第一波 −32 %，第二波 −40 %。单个会话的步数从 3 到 8 都有，说明收益不是靠某一个异常会话拉出来的。

**质量没有掉。** 16 个会话对第 ①②③ 项的答案逐字一致（唯一的分歧是有人报 175、有人报 173 —— 那是 `test(` 字面数 vs 真实用例数的口径差异，两边都对；第 ④ 项不一致是因为我在它们跑的同时改了 README，`git status` 的脏文件数从 7 变成 8）—— 这是一个确定性事实任务，10 个数字全部命中。

**诚实的读法**

- **这次的收益主要来自「步更少」和「每步更短」，而不是「每步更宽」**：每步工具调用 1.41 → 1.37 没有上升。任务太小（4 次查询），对照臂本来就在一步里合了两个调用，并行的空间不大。并行的收益要在"十几次独立查询"的任务上才会显形 —— 那种任务上调用数会明显上去。
- 两臂人数不均（4 vs 12），是 `FNV-1a` 哈希分档的运气问题，不是挑选。n 也小（16 个会话、29 vs 54 步）。
- 实验期间有 1 个**非实验**会话在同时跑（07:21–07:37），两臂平均受它干扰，但它不进统计。
- `turbo` 的并行目标是内置的 6。把它抬到 `parallel: 8` 只会让一步更宽，不会更慢；本次没有单独测 8 那一档。

## 为什么没效果：延迟模型

把 689 步全放进去做最小二乘，`llmMs` 对输出 token 数的拟合是：

```
ms = 720 + 6.63 × 输出tok        R² = 0.93
```

- **720 ms 的固定开销**（首字 + 排队 + 预处理），与输出长短无关。
- **6.63 ms/token** 的解码速度，约 150 tok/s。
- 输出长度解释了 93% 的耗时差异。剩下 7% 才是档位、工具、路由能碰的地方。

再看 effort 的残差（扣掉输出长度影响后的平均偏差）：

| effort | 步数 | 平均输出 | 平均耗时 | 残差 |
| --- | --- | --- | --- | --- |
| `minimal` | 45 | 625 | 5356 ms | **+488 ms** |
| `low` | 451 | 534 | 4152 ms | −110 ms |
| `medium` | 87 | 402 | 3347 ms | −39 ms |
| `high` | 106 | 500 | 4328 ms | +292 ms |

中位残差全部落在 ±350 ms 内，符号还互相矛盾（最"省"的 `minimal` 残差最正）。**这不是快慢，这是噪声。**

直接证据更简单：750 行里 `reasoning` 全为 0。这条自建路由不产出思考 token —— 也就是说，effort 这个旋钮拧的是一台空转的马达。插件的降档逻辑没有写错，它只是在一个没有思考可省的路由上工作。

顺带一个反直觉的数字：输入侧几乎免费。全部 750 步里 `cacheRead` 累计 4,086 万 token，而真正新读入的 `input` 只有 2.4 万 —— 提示缓存把输入侧抹平了，所以「省输入」也不是一个有用的方向。

## 那什么才真的更快

延迟模型自己给出了答案：`720 ms × 步数 + 6.63 ms × 输出token`。两个可动的量都不是"解码速度"。

| 杠杆 | 现状（本机） | 能不能省 |
| --- | --- | --- |
| **步数** | 每轮 12.9 步（关闭态）；一步固定烧掉 720 ms | 能，前提是别让模型把一个任务拆成十几次试探 |
| **输出 token** | 平均 500 tok/步 | 能，但这是任务的形状，不是插件能改的 |
| **工具等待** | 4,480 s 总耗时里 1,536 s 在工具里 | 能，靠并行 —— 插件唯一真正动到的杠杆 |
| 解码速度 | 150 tok/s | **不能**。档位、effort、温度都不动它 |
| 首字 | 720 ms 里的固定部分 | **不能**（没有流式首字信号可测，见下） |

插件把多调用步从 2% 提到 22–23%，方向是对的 —— 但代价是输出 tok/会话从 58 k 涨到 142 k。**这笔账目前是亏的**，除非被并行的那些工具调用本身很慢（本机 bash p90 5.5 s、最长一次 818 s，说明确实有慢工具）。诚实的说法是：并行对慢工具任务有利，对短任务不利，而这次的样本偏短。

## 这份实测的局限

- **一条路由**。`company/deepseek-v4.1-flash` 经自建网关；官方 DeepSeek 路由声明了 `off/low/high/max` 并有真实的思考 token，结论不能直接搬过去。
- **样本小**。实验 B 每档 1–3 个会话，够看出"没有差异"，不够看出"差异是 3%"。
- **`ludicrous` 档没测**。它请求 `reasoningEffort: 'off'`，是唯一还没排除的档位；但如果这条路由根本不思考（`reasoning` = 0），它大概率同样无效。想验证就按最后一节跑一次，把 `off` 和 `ludicrous` 两档分进同一次实验。
- **首字是近似值**。`assistant/message` 每步只提交一次，所以 `ttftMs` 就是 `llmMs`，不是真正的流式首字。这一栏目前只能当"整步耗时"读。

## 复现

```bash
dsh-fast-mode-experiment start --gears off,safe,fast,turbo,max   # 按会话哈希分档
dsh-fast-mode-experiment status                                  # 每档已有多少会话/步
dsh-fast-mode-report --since 2d                                  # 两张表 + 相对关闭态的倍率
dsh-fast-mode-experiment stop                                    # 结束，之后的会话回到插件配置
```

报告的两个倍率表在**任务形状不一致**时不要读：本机那两张全量表里 `fast` 显示"模型耗时 0.89×", 那是它恰好落在长输出会话里的结果，不是加速。要比就比实验 B 那种同任务、同步数的小样本，或者直接用上面的延迟模型做残差比较 —— 后者对任务形状免疫。

实验 E 用的就是最小的那种复现：`--gears safe,turbo`，然后并发跑两波、每波 8 个同提示词的会话，最后按 `gear` 分组算每会话的 `ΣstepMs` 中位数。原始行在 `~/.dsh/fast-mode-metrics.jsonl` 里，按 `sid` 分组即可重算，不需要重跑模型。

---

# Measured: where it is faster, and where it is not

One question, one answer: **did the request actually get faster?**

- What the plugin demonstrably does: it records the per-step ledger, and on this gateway it raised multi-call steps from 2% to 22–23%.
- What it cannot claim: on a clean small task, **gear level has no measurable effect on per-step latency**. Every gear lands at 9.0–10.6 ms per output token — inside the noise.

Numbers come from real local sessions (750 rows, 689 steps usable for the fit).

## Summary

| Claim | Evidence | Strength |
| --- | --- | --- |
| Step latency is almost entirely output tokens | `ms = 720 + 6.63 × outTok`, R² = 0.93, n = 689 | strong |
| `reasoning_effort` does nothing on this route | per-token latency 9.0–10.6 ms across four gears; residuals within ±0.5 s after controlling for length | strong |
| This route emits no reasoning tokens, so there is nothing to trim | `reasoning` is 0 in all 750 rows | strong |
| Higher gears fan out more tool calls per step | multi-call steps: off 2% → `turbo`/`max` 22–23% | medium |
| Higher gears cost more tokens | output per session: off 58 k → `turbo` 142 k | medium (confounded sample) |
| 0.8.0's three levers (wider steps, speculative prefetch, output discipline) **do** make it faster | 16 same-task sessions: median Σ step time 25.9 s → 15.6 s (−40 %), median steps 7.5 → 4.5, p = 0.008 | strong (small n, uneven arms — see Experiment E) |

In one line: **on `company/deepseek-v4.1-flash` behind a self-hosted gateway, turning `reasoning_effort` up does not make generation faster.** The only real levers are fewer steps and less output — which is exactly what 0.8.0 does, and Experiment E measured it.

## Method

- The unit is the **step**, not the session: most of a session's wall clock is a human reading and typing (generation was 59% of step time across 12 turns here).
- Each step appends one JSONL row: `llmMs`, `stepMs`, `output`/`input`/`cacheRead`/`reasoning`, `calls`, `effort`, `mode`/`gear`, `route`.
- **Arms are assigned, not clicked**: the experiment file assigns by `FNV-1a(session id) mod gears`, so a session keeps its arm and nobody's hunch picks it. `off` is a legal control arm. Sessions with the switch off are recorded too, otherwise there is no baseline.

## Experiment A: contaminated by its own tool output

Six sessions, 24 steps, identical task. One of them received a **33,763-character** tool result, tripping `bigChars`, which set `signals.struggling` and pinned the effort for the following steps. The comparison is void, and it exposed a real plugin defect: one `git diff` can block downshifting for six steps.

## Experiment B: variables controlled

Eight independent sessions, one prompt, one model, one machine, started in the same minute. Three steps each, every one ending in `BENCH-DONE`. Four arms: `off` ×3, `safe` ×3, `turbo` ×1, `max` ×1 — 24 steps total.

| Gear | Steps | Effort (step 1→3) | LLM p50 | Output tok/step | **ms/token** |
| --- | --- | --- | --- | --- | --- |
| `off` (control) | 9 | `medium` / `medium` / `medium` | 1978 ms | 247 | 9.08 |
| `safe` | 9 | `medium` / `low` / `low` | 1974 ms | 227 | 9.11 |
| `turbo` | 3 | `medium` / `low` / `low` | 2262 ms | 254 | 9.01 |
| `max` | 3 | `medium` / `low` / `low` | 2216 ms | 220 | 9.47 |

The plugin did downshift — `safe`/`turbo`/`max` drop `medium` → `low` from step 2 while the control stays at `medium`. But the per-token cost is identical (9.01–9.47, a 5% spread), and so is mean LLM time (2244 / 2071 / 2293 / 2081 ms). The lower gear never reached the wire in a way the model acted on.

## Experiment E: 0.8.0's three levers are actually faster

Experiments A and B only proved that effort is not a lever. Experiment E tests the levers 0.8.0 does pull: **wider steps (fan-out + prefetch), fewer steps (fewer round trips), shorter steps (output discipline)**.

- **Identical task with a checkable answer**: read one repository and report four things — ① per-file `test(` counts under `test/`, ② per-file line counts under `src/`, ③ `package.json` version / export-key count / dependencies, ④ `git log -3` and `git status --porcelain`.
- **16 independent sessions in two waves of eight**, same route (`company/deepseek-v4.1-flash`), same prompt, started concurrently. Arms again assigned by `FNV-1a(session id) mod 2` — nobody clicked anything.
- Control `safe` (no guidance section injected, i.e. the plugin's pre-0.8.0 behaviour); treatment `turbo` (fan-out target 6 + speculative prefetch + full output discipline).

**Results (per-session Σ step time = sum of that session's `stepMs`)**

| Metric | `safe` (n=4) | `turbo` (n=12) | Change |
| --- | --- | --- | --- |
| Σ step time, median | 25.9 s | **15.6 s** | **−40 %** |
| Σ step time, mean | 25.7 s | 17.4 s | −33 % |
| Steps, median | 7.5 | **4.5** | **−40 %** |
| Output tokens per session, median | 3,798 | **2,180** | **−43 %** |
| Output tokens per step | 510 | 535 | +5 % (a fatter step is the point) |
| Tool calls per step | 1.41 | 1.37 | flat |
| Mann–Whitney U (Σ step time) | — | — | U = 46, z = 2.67, **p = 0.008** |

Both waves agree in direction: −32 % in wave one, −40 % in wave two. Individual sessions range from 3 to 8 steps, so the gain is not one outlier dragging the median.

**Quality did not drop.** All 16 sessions reported items ①②③ identically (the one apparent disagreement, 175 vs 173, is the literal `test(` count versus the real test-case count — both correct). Item ④ differed only because I was editing the README while they ran, so the dirty-file count moved from 7 to 8. This was a deterministic fact task and all ten numbers landed.

**Honest reading**

- **The win here came from fewer steps and shorter steps, not from wider steps**: calls per step went 1.41 → 1.37, i.e. it did not rise. The task is too small (four lookups); the control arm already batched two calls into one step, so there was little room. Fan-out shows up on tasks with a dozen independent queries.
- The arms are uneven (4 vs 12) because of the `FNV-1a` hash, not because of selection, and n is small (29 vs 54 steps).
- One **non-experiment** session ran alongside (07:21–07:37). It hits both arms equally and is excluded from the statistics.
- `turbo`'s built-in fan-out target is 6. Raising it to `parallel: 8` only makes a step wider, never slower; the 8 setting was not measured separately.

## Why: the latency model

Least squares over 689 steps:

```
ms = 720 + 6.63 × outTok        R² = 0.93
```

720 ms of fixed cost per step, 6.63 ms per output token (~150 tok/s). Output length explains 93% of the variance; gears, tools and routing share what is left.

Effort residuals (mean deviation after removing the length effect): `minimal` +488 ms, `low` −110 ms, `medium` −39 ms, `high` +292 ms — median residuals all within ±350 ms with contradictory signs. That is noise, not speed.

The simplest evidence: `reasoning` is 0 in every row. This route produces no thinking tokens, so the effort knob turns an idling motor. The downshift logic is not wrong; it is working on a route with nothing to save.

Also counter-intuitive: the input side is already free. Across 750 steps, `cacheRead` totals 40.86 M tokens against 24 k of fresh `input`.

## What would actually be faster

`720 ms × steps + 6.63 ms × output tokens`. Neither term is decode speed.

| Lever | Here | Reducible |
| --- | --- | --- |
| **Steps** | 12.9 per turn (switch off); each costs 720 ms of fixed overhead | yes — by not letting the model probe ten times |
| **Output tokens** | ~500 per step | yes, but that is the task's shape, not the plugin's |
| **Tool wait** | 1,536 s of 4,480 s total | yes, via fan-out — the one lever the plugin really moves |
| Decode speed | 150 tok/s | **no** |
| Time to first token | the fixed part of the 720 ms | **no** measurement yet (no streaming signal) |

Fan-out goes the right way on slow tools (bash p90 5.5 s, worst case 818 s here) and the wrong way on short tasks, where the token cost dominates: output per session rose from 58 k to 142 k. That trade is currently a loss on short work, and this sample is mostly short work.

## Limits

- **One route.** `company/deepseek-v4.1-flash` behind a self-hosted gateway. The official DeepSeek route declares `off/low/high/max` and does emit thinking tokens; do not carry these numbers over.
- **Small sample.** 1–3 sessions per arm rules out a large effect, not a 3% one.
- **`ludicrous` untested.** It requests `reasoningEffort: 'off'`, the last unexcluded gear — though a route that reports zero reasoning tokens will probably ignore it too.
- **TTFT is approximate.** One `assistant/message` per step means `ttftMs` equals `llmMs`; read that column as whole-step time.

## Reproduce

```bash
dsh-fast-mode-experiment start --gears off,safe,fast,turbo,max
dsh-fast-mode-experiment status
dsh-fast-mode-report --since 2d
dsh-fast-mode-experiment stop
```

Do not read the ratio tables when task shapes differ: the full-sample table shows `fast` at "0.89× model time" purely because those sessions happened to emit longer outputs. Compare same-task, same-step-count samples like Experiment B, or compare residuals against the latency model, which is immune to task shape. Experiment E is the minimal form of that: `--gears safe,turbo`, two waves of eight identical sessions, then group the raw rows by `gear` and compare per-session Σ `stepMs` medians. The raw rows live in `~/.dsh/fast-mode-metrics.jsonl`; grouping by `sid` reproduces the table without re-running any model.
