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

一句话：**在这台自建网关的 `company/deepseek-v4.1-flash` 上，调档位不会让生成变快。** 想真的更快，只有两条路——更少的步，或更少的输出。

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

In one line: **on `company/deepseek-v4.1-flash` behind a self-hosted gateway, turning the gear up does not make generation faster.** The only real levers are fewer steps and less output.

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

Do not read the ratio tables when task shapes differ: the full-sample table shows `fast` at "0.89× model time" purely because those sessions happened to emit longer outputs. Compare same-task, same-step-count samples like Experiment B, or compare residuals against the latency model, which is immune to task shape.
