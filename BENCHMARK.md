# 实测：快在哪儿，不快在哪儿

## 1.4.3：速度随步数增长——短任务 0 收益，长任务 1.49×（2026-10-24）

这一轮回答“A 对短任务收尾是不是收益不够”。答案是够的，只是**收益随步数出现**：短任务里没有多少可省的东西，长任务里输出 token 与步数都会被压下来。

### G. 步数分桶：1–5 步无收益，6–10 步 1.23×

同一份 80 对 ABBA 语料（`results.jsonl`，外部墙钟 `elapsedSec`，全部运行 `exit 0`）按 off 组步数分桶：

| 桶 | 对数 | 中位加速 | p25–p75 | 变快对 |
|---|---|---|---|---|
| 1–5 步 | 47 | **1.00×** | 0.82–1.20 | 23/47 |
| 6–10 步 | 33 | **1.23×**（符号检验 p = 0.035） | 0.99–1.43 | 23/33 |
| 11 步以上 | 0 | — | — | — |

`corr(输出 token 变化, 加速) = −0.77`：快的那些对，都是模型写得少。输出 token 中位 831 → 756。这条规律解释了为什么“总体中位 1.06×”看起来弱——它把 47 对几乎没有可省空间的短任务平均进去了。

同一份语料还证明**并发不是来源**：短任务上并行宽度早就够用，长任务上的加速与工具扇出无关。

### H. 输出纪律 A/B：−15.4% token，正确性零损失，墙钟测不出来

深 fixture（4 模块 / 20 测试）12 对 ABBA，24 次运行全部 `exit 0`、测试文件未改：

| 组 | 墙钟中位 | 步数 | 输出 token | 测试 |
|---|---|---|---|---|
| 关 | 29.9 s | 9.0 | 4558 | 96/96 |
| 开 | 25.2 s | 9.0 | 3858 | 96/96 |

token **−15.4%**，未达预设的 20% 门槛；配对中位 1.13×，但只有 7/12 对更快（p = 0.774），配对 token 变化中位 −14.5%、仅 7/12 对下降（最差一对 +47%）。单看这一项，**在 n=12 上与 ±30% 的任务内噪声分不开**。验收条件“token 降 ≥20% 或判负即结案”由此触发的结论是：不作为独立卖点，正确性零损失这一条成立。

### I. 长任务 A/B：16.5 步 → 10.5 步，墙钟 1.49×，隐藏测试 22/22 全对

fixture 是“从零实现一个模块”——`ledger.py`，6 个函数，规范写清但边界很多（会计括号负数、货币符号、千位逗号、`Decimal` 精度、ROUND_HALF_UP、规则优先序、并列取 ASCII 最小、报表排版）。**隐藏测试**放在模型看不到的目录，跑完由 runner 复制进去执行，22 条断言；写不出来就是 0 分，等于把“正确性”做成可观测量而不是主观判断。8 对 ABBA、16 次运行：

| 组 | 墙钟中位 | 步数中位 | 输出 token 中位 | 隐藏测试 | 绿 |
|---|---|---|---|---|---|
| 关 | 215.2 s | **16.5** | 32 718 | 22.0/22 | 8/8 |
| 开 | 144.5 s | **10.5** | 24 274 | 22.0/22 | 8/8 |

- 墙钟 **1.49×**（配对中位 1.56×，均值 1.66×；5/8 对更快，p = 0.29——赢的三对赢得大，2.3–2.7×，输的三对只输 5–24%）。
- **步数 8/8 对全部下降**（符号检验 p = 0.008）：这是最干净的一条，机制也直接——少写过程就少一步“先说明再动手”，少一次重复验证。
- 输出 token **−25.8%**（配对中位 −38.6%，5/8 对下降），这次越过了 20% 门槛。
- **正确性 16/16 次运行、22/22 全对，两个臂都一样**。这是本轮最重要的质量证据：省下来的是过程文字，不是实现质量。

对照实验：上一版“12 个 bug 的修复型 fixture”只花 4–6 步就被模型一次改完，结果 **0.94×、输出 +11%**——它压根不是长任务，只是“短任务 + 更多文件”。它反过来印证 G 的分桶：步数不够，收益就是零甚至是负的。

### J. 结论与产品含义

- 可辩护的说法：**6 步以上约 1.2×；真长任务（16 步量级）1.49×，步数 −36%，输出 −26%，正确性不变；≤5 步为 0**。
- 因为收益随步数出现，**“短任务不介入、长任务自动介入”有实测依据**，`outputDiscipline: 'late'` 由此实现：系统提示里不放文风规则（短任务零成本），第 4 步由调度器注入一次压缩提醒（`src/auto.js` 的 `compress-output` 指令，每轮一次）。

### J. 迟到介入 A/B：长任务 2.68×，正确性同样零损失

同一 fixture、同一 runner，6 对 ABBA（12 次运行），比较 `off` 与 `outputDiscipline: 'late'`：

| 组 | 墙钟中位 | 步数中位 | 输出 token 中位 | 隐藏测试 | 绿 |
|---|---|---|---|---|---|
| 关 | 184.2 s | 10.5 | 30 178 | 22.0/22 | 6/6 |
| late | **68.6 s** | **7.5** | **14 480** | 22.0/22 | 6/6 |

- 墙钟 **2.68×**（配对中位 2.82×；4/6 对更快，输的两对 0.77×/0.79×）。
- 步数 5/6 对下降，中位 −3 步；输出 token **−52.0%**（配对中位 −59.6%，4/6 对下降）。
- 正确性仍是 12/12 次运行、22/22 全对。n=6 是 pilot，只能当方向；但它与上一节 8 对的 1.49× 同向，且“全程纪律”那一版在同一 fixture 上是 1.49×——迟到介入没有变慢。
- 因此**默认值改为 `late`**：短任务不付提示税，长任务在第 4 步拿到同一句压缩指令。

## 1.4.2：把“并发”量出来——子代理是真并行，shell 扇出工具是负收益（2026-10-24）

这一轮只问两个问题：harness 层面到底还有多少并发没被用上？我们为此加的提示段和工具，究竟赚还是亏？

### A. 子代理并发：4 路，跨度 21 秒（串行应 80 秒）

四个真实子代理，每个只做 `sleep 20`，各自把开始/结束时间戳追加到同一个日志：

| 探针 | 开始 | 结束 |
|---|---|---|
| agent1 | +0 s | +20 s |
| agent2 | +0 s | +21 s |
| agent3 | +1 s | +21 s |
| agent4 | +0 s | +20 s |

整段跨度 **21 s**，串行基线 80 s → **约 3.8×**。四个子代理的启动在 1 秒内完成，说明限制不在调度器，而在**模型是否愿意把工作拆给子代理**。这条与早前 k=4 的并发测量（4 个相同请求并发 6.5 s vs 串行 23.2 s = 3.6× 吞吐，单步 llm 只涨 14%）互相独立、结论一致。

### B. `shell_parallel` 工具：工具本身有效，产品化是负收益（3 对 ABBA）

fixture 是 6 个互不依赖的作业，每个 `sleep 5`（`tp`），同题三对、顺序轮转、六次运行全部 `exit 0`：

| 组 | 墙钟 | 步数 | 工具内时间 |
|---|---|---|---|
| on p1 | 26.3 s | 7 | 15.3 s |
| off p1 | 16.0 s | 6 | 5.2 s |
| on p2 | 54.5 s | 7 | 45.5 s |
| off p2 | 8.9 s | 3 | 5.1 s |
| on p3 | 15.2 s | 6 | 5.2 s |
| off p3 | 9.1 s | 3 | 5.1 s |
| **中位** | **26.3 s** | 7 | 15.3 s |
| **中位** | **9.1 s** | 3 | 5.1 s |

**0.35×（on / off）**。会话日志给出了确切机制，两条都不是“工具写错了”：

1. **工具确实是并发的**：6 个 5 秒作业在 5.1 秒内跑完（`tool/call` +1.4 s → `tool/result` +6.5 s）。
2. **基线本来就会并行**：off 组一次 `bash` 里就写了 `for d in job-0*; do (cd $d && python3 slow.py) & done; wait`，模型自己把六个作业并行起来了。
3. **多出来的工具诱发复核**：on 组先跑 `shell_parallel`，再 `cat slow.py`、再 `date; ls done.txt`、再跑第二遍；其中一次落进串行 `for` 循环验证（+22.1 s → +52.4 s，正好 30 s）。六次工具调用、七步，墙钟翻倍还多。

结论：**默认关闭**（`shellParallel: false`），提示段也只在工具真的注册时才提它的名字（否则模型会去调一个不存在的工具）。需要时一个开关打开。

### C. 一次把自己证伪的三臂实验（诚实记录）

我本想用 `guidance: false` 做“有提示段 / 无提示段 / 关插件”三臂对照，跑了 3 任务 × 6 对 = 54 次（全部 `exit 0`）。结果出来后复核代码才发现：**`resolveConfig` 没有把 `guidance` 透传出去**，三臂里其实有两臂配置完全相同。

| 任务 | off | 名义 notext | 名义 text |
|---|---|---|---|
| t2 | 5.6 s | 5.5 s | 5.6 s |
| t3 | 3.9 s | 7.5 s | 5.2 s |
| tp | 9.7 s | 17.6 s | 16.0 s |
| **总体中位** | **5.6 s** | **7.5 s** | **5.6 s** |

于是这组数据不能当 A/B 用，但它**变成了一次噪声标定**：两个完全相同的配置，在每任务 6 对的样本下给出了 **0.75× 和 1.01×** 两种“效应”。也就是说，本套小任务上 n=6 的每任务中位数**噪声达 ±30%**——任何小于这个幅度的单任务差异都不该被当成结论。我此前“notext 1.01× / text 0.88×”的说法**作废**（`guidance` 开关当时并未生效）。

### D. 子代理扇出做真实工作：小任务上是 0.25×（2 对 pilot）

A 证明了“并发原语能用”，但没用它做任何事。这一组把真实工作交给子代理：fixture 有 4 个模块，每个模块 120 行 `key=value`，规则写在各自 `NOTES.md`（能被 7 整除的 key 是 hot），要求算 hot 条数、最大 cold 值并汇总成表。两臂都用 `off`，唯一差别是提示里是否明确要求“为每个模块开一个子代理并行分析”。两对 ABBA、四次运行全部 `exit 0`：

| 臂 | 墙钟 | 步数 | sum(llm) | sum(tool) | 输出 token |
|---|---|---|---|---|---|
| 自己串行做 p1 | 10.9 s | 6 | 9.9 s | 0.2 s | 1798 |
| 子代理扇出 p1 | 49.4 s | 27 | 54.2 s | 30.8 s | 9130 |
| 子代理扇出 p2 | 23.2 s | 30 | 66.0 s | 0.7 s | 10054 |
| 自己串行做 p2 | 7.4 s | 5 | 6.4 s | 0.1 s | 1348 |
| **中位，串行** | **9.2 s** | 5.5 | 8.2 s | 0.2 s | 1573 |
| **中位，扇出** | **36.3 s** | 28.5 | 60.1 s | 0.7 s | 9592 |

**0.25×（扇出 / 串行）**，而且不是调度器的问题：`sum(llm)` 60 s 是**四个子代理各自的解码之和**，它们确实在并行跑（单次跨度只有 23–49 s）；真正的代价是

1. 每个子代理都要付一次完整启动 + 系统提示 + 至少 4–5 步（读 data、读 notes、算、写报告），4 个孩子就是 4 份固定成本；
2. 子代理的报告天生啰嗦：输出 token 从 ~1.5 K 涨到 ~9.6 K，**6 倍**；
3. 父会话还要额外花步数去派发与等待（步数 5.5 → 28.5）。

**这说明扇出的盈亏线不在“并发度”，在“子任务本身的深度”。** 每个子任务只有一两千 token 级别的活时，拆出去必亏；只有当单个子任务本身就要跑十几步、几千 token 时，扇出才可能赢。真实任务大多落在前者。

### E. 深子任务扇出：仍然是 0.60×（2 对 pilot，含会话取证）

D 的反对意见是“每个子任务太浅，所以扇出当然亏”。E 把子任务做深：4 个模块，每个 5 个分片共 300 行 `<class>:<key>=<value>`，规则在 `NOTES.md`（值能被 7 整除即 hot），权重在 `weights.txt`，每个模块要写出 `hot` / `cold_sum`（冷样本加权和）/ `cold_max`，最后汇总。串行做要 11–14 步、3–7 K 输出 token。两臂都用 `off`，差别只在提示是否要求“每模块各开一个子代理”。

| 臂 | 墙钟 | 步数 | sum(llm) | 输出 token | 正确性 |
|---|---|---|---|---|---|
| 串行 p1 | 20.4 s | 11 | 18.8 s | 3253 | **4/4** |
| 扇出 p1 | 45.8 s | 42 | 93.0 s | 13817 | **4/4** |
| 扇出 p2 | 50.7 s | 44 | 127.5 s | 20004 | **0/4** |
| 串行 p2 | 37.3 s | 14 | 35.6 s | 6931 | **4/4** |
| **中位，串行** | **28.8 s** | 12.5 | 27.2 s | 5092 | 4/4、4/4 |
| **中位，扇出** | **48.2 s** | 43 | 110.3 s | 16910 | 4/4、0/4 |

**0.60×（扇出 / 串行），而且一次还做错了。** 会话取证说明问题不在“有没有并行”：

- 扇出臂确实开了 **4 个子会话**，四个 `createdAt` 相差 **3 毫秒**——派发是**同一瞬间**发生的，调度器没有排队；
- 但每个孩子耗了 **44–81 个事件（约 15–25 步）** 才算完一个模块，而串行臂用 **11–14 步** 就把四个模块全做完了；
- 输出 token 5.1 K → 16.9 K（3–4 倍），`sum(llm)` 27 s → 110 s（四个孩子各自的解码之和）；
- 父会话在派发后还要读四份报告、写汇总，步数 12.5 → 43。

**换句话说：把活切成四份之后，每一份的代价几乎和整份一样大。** 子代理的启动、系统提示、以及“自己重新摸清这个模块”的探索成本，与切片大小基本无关；切片越小，摊销得越差。这是子代理架构的固定成本，不是插件能改的。

结论：**扇出在这套 harness 上已经两次被证伪**——浅子任务 0.25×（D），深子任务 0.60× 且有一次结果错误（E）。并发原语是真的（A：4 路 21 s；E：4 个孩子 3 ms 内派出），但“把活交给更多 agent”不是提速手段，反而放大 token 与出错面。

### F. “重复调用就短路”这条机制：先做人群统计，然后否掉（1198 个会话日志）

思路本来是纯程序化的、不碰提示词：如果某一步又调了**同一个工具、同样的参数**，就把上一步的结果直接回灌，省掉一次执行。在动手之前先数了一下它到底能命中多少——把仓库里所有 bench 会话日志（**560 个会话目录、1198 个日志、7168 次工具调用**）全扫了一遍：

| 判重口径 | 命中率 | 命中的工具 |
|---|---|---|
| 严格（参数逐字节相同） | **10 / 7168 = 0.1%** | `shell_parallel` 8 次（就是这个已经被关掉的工具）、`list_agents` 2 次 |
| 宽松（去 `cd … &&`、压空白、去 `\| head`） | **314 / 7168 = 4.4%** | `bash` 300、`grep` 4、`shell_parallel` 8 |

而且命中是**极度集中**的：4.4% 里绝大部分来自 74 个会话（占 1198 的 **6%**），典型形态是「同一形状的复核命令连发 5 次」。抽查最集中的那个会话（t3-on-p2），七次调用里六次是：

```
1..6  bash | python3 gen.py      ← 同一个生成脚本，连跑六遍
7     write
```

三条否掉理由：

1. **量太小**：严格口径 0.1%，宽松口径 4.4%，且集中在 6% 的会话里；对总体墙钟的期望收益是毫秒级——这些重复是 `ls`/`cat`/`date`/`python3 gen.py` 这类**便宜调用**，不是重跑 5 秒作业那种贵调用。
2. **省的不是那 0.5 秒**：短路能省的是**工具执行时间**，省不掉**那一步的 LLM 开销**（模型仍然要生成这次调用、仍然要等一次 TTFT）。而整套测量的结论恰恰是每步 `TTFT ≈ 0.5 s` 是主要固定成本——这一步该由既有的步数预算/停滞看门狗去砍，不是由结果缓存去砍。
3. **会引入正确性风险**：命中最多的 `python3 gen.py` 是**有状态**的命令（重新生成数据文件）。把它的第二次调用短路成“上次的结果”，等于把一个会改变现场的命令当成纯读——这是会静默写坏状态的优化。

结论：**不做**。同时说明一件事——`shell_parallel` 那个工具的 8 次重复，是它自己诱发出来的，这也是它被关掉的第三个理由。

### 这一轮的净结论

- 唯一有量级的杠杆是**并发**：子代理 3.8×、k=4 吞吐 3.6×，都不需要改提示词。
- 提示段和 `shell_parallel` 都没有带来可测收益；后者在本 fixture 上稳定更慢，已改默认关闭。
- 小任务上的 `1.06×`（76 对）仍是仓库里唯一的大样本结论，且它落在 CI 下沿——按上面的噪声标定，它应当被读作“几个百分点”，不是“快一截”。
- **扇出到子代理已经两次证伪**：浅子任务 **0.25×**（D），深子任务 **0.60×** 且两次里有一次算错（E）。取证显示四个孩子在 3 毫秒内同时派出——并行是真的，亏在“切片后每一片的固定成本几乎和整片一样大”。这条线到此为止。
- “重复调用短路”也被否掉（F：严格 0.1%、宽松 4.4%，且都是便宜调用与有状态命令）——它省的是执行时间，省不掉那一步 0.5 s 的 TTFT。
- 时间构成的实测比例是：**TTFT/排队约 31%、解码约 58%、工具与间隙约 11%**，解码按 `4.0 ms / output token` 计。因此唯一还剩量级的杠杆是**减少输出 token**（`outputDiscipline` 从未被单独 A/B 过），而不是并行、不是缓存。
- 因此不再做 `fanout` 工具，也不在提示里推子代理。插件能碰的只剩“每步少一次派发、每步少解码一点”，而上界由 76 对样本给出：**中位 1.06×**。产品的诚实定位是“小幅提速 + 卡死看门狗 + 每步计量”，不是倍数级加速。

## 1.4.1 修正：扩大样本后，1.4.0 的 1.86× 被证伪（76 对）

1.4.0 发布时的每任务数字只有 5 对，我把 t1/t3 扩到 15 对（另加两个新形状：t9 写扇出、t10 读写混合，各 8 对）之后，结论变了：

- t1：5 对时 1.86× → **15 对时 0.85×**（升级后再测，判为“逐项输出”走原生，回到 **1.02×**）。原因是“一次抓全”把八次读并成一步，但那一步要一次解码整张 per-file 表，输出 token 从 1069 涨到 1197，比省下的轮次贵。
- t3：5 对时 1.77× → **15 对时 1.03×**；步数确实从 4.7 降到 3.5、`llmMs` 从 4578 降到 3752，但墙钟只有 ~8% 的改善，中位数被几个慢跑抵消。
- t9（6 模块独立改写，写扇出）：**0.98×（8 对）**。宽块里写六个独立文件是安全的，但没有变快——模型本来就会在一次里写多个。
- t10（10 日志聚合报告，读写混合）：**1.11×（8 对）**，方向为正但不显著。

合并 76 对：**中位 1.06×，CI 0.996–1.155×，45/76 对变快，均值 1.15×**。也就是说，在本套任务和这条网关上，fast mode 的真实收益是“几个百分点 + 更大的方差”，不是“明显快一截”。

为什么：一步的墙钟 ≈ `720 ms + 6.6 ms × 输出 token + 预填充`；把 N 步压成 1 步，省下 N×0.7 s 的固定开销，却常常让那一步多解码几百 token（≈2 s）。只有“步数下降且单步输出不涨”的形状能净赚，t3 的 shell 扇出是唯一稳定的例子。

1.4.1 因此只留一个行为改动：**逐项输出形状（`one object keyed by file`）判原生**，避免 0.85× 的回归；同时保留 shell 扇出与聚合命令。

## 1.4.0：形状分类 + 一次抓全 + 聚合命令（43 对，2026-10-24）

三项调度改动，全部是程序化并行，不改请求体、不改 `reasoningEffort`：

1. **请求形状分类**（1.3.0 起）：串行/shell/聚合/扇出，第一步就决定宽窄，不再有新会话 4 宽探测。
2. **一次抓全**：已知的目标集合必须在第一个块里抓完，不许为决定读什么而先读一个。
3. **聚合命令**：目标超过约十个或是求和/计数/求交集时，用一条 `rg -c` / `grep -r` / 短脚本，而不是把每个文件都读进上下文；shell 扇出（每目录一个作业）也允许同一块。

口径同前：真实 headless 启动，`company/deepseek-v4.1-flash`，`reasoningEffort: medium`，ABBA 配对，每对同一任务同一 fixture 的两份独立副本；质量 120/120 全部 PASS；表中墙钟是各臂均值。

| 任务（形状） | 墙钟：关 → 开 | 加速比 | 95 % CI |
|---|---|---|---|
| t1：8 文件抽摘要 | 14.9 s → 8.8 s | 1.86× | 0.86–3.77 |
| t2：40 个独立文件计数 | 5.8 s → 6.0 s | 0.98× | 0.82–1.34 |
| t3：6 目录逐个求和（shell 为主） | 8.5 s → 6.6 s | 1.77× | 0.41–2.19 |
| t4：12 模块审计报告 | 9.1 s → 11.0 s | 1.03× | 0.55–1.19 |
| t5：12 模块 × 5 文件查热符号 | 6.8 s → 7.6 s | 1.07× | 0.43–1.35 |
| t6：24 个日志文件按级别求和 | 8.7 s → 5.6 s | 1.43× | 1.00–2.57 |
| t7：18 节点依赖链（必须串行） | 4.4 s → 4.3 s | 1.06× | 0.76–1.30 |
| t8：16 个 manifest 找重复依赖 | 6.9 s → 5.4 s | 1.29× | 0.98–1.61 |

- 43 对合并：**中位加速比 1.09×（10 000 次 bootstrap CI 1.03–1.33×）**，30/43 对变快，均值 1.26×；平均步数 5.5 → 4.7。
- CI 首次不跨 1，但每任务只有 5–8 对，单任务数字只能看方向；t1/t3 的 1.8× 来自“抓全 + shell 扇出”，t2/t4/t7 基本是设计的无操作对照组（聚合、串行、必须串行）。
- 输出 token 均值反而略降（884 → 767/次运行），因为输出纪律同时生效；输入 token 上升，是本版有意用 token 换轮次。

## 1.3.0 pilot：请求形状分类（32 对）

`src/shape.js` 从用户消息本身判断形状：串行词（chain / one by one / 依次 / 逐个）或 shell 词（bash / python3 / 执行）→ 原生；扇出词（independently / every file / across / per file / 每个 / 所有）或 ≥4 个指名目标 → 8；其余原生。新会话不再有 4 宽探测。

- 8 任务 × 4 对 ABBA = 64 次运行；质量 63/64（唯一失败在**对照组** t8，与插件无关）。
- 32 对合并：**中位加速比 1.08×（10 000 次 bootstrap CI 0.88–1.21×），18/32 对变快**，均值 1.11×。
- 分任务（各 4 对，只看方向）：t1 1.16×、t2 1.08×、t3 1.03×、t4 1.20×、t5 0.83×、t6 0.92×、t7 1.32×、t8 0.97×。
- 与 1.2.1 的 80 对相比，点估计 0.96× → 1.08×，t1/t4 不再倒挂；但 CI 仍跨 1，**不构成显著结论**，只是从“有代价”变成“看不出代价、方向为正”。

## 1.2.1：8 任务 80 次运行（相对值，2026-10-24）

这是当前版本唯一权威的一组数据：**8 个多文件任务 × 5 对 ABBA 配对 = 80 次真实 headless 运行**，同 provider（`company/deepseek-v4.1-flash`）、同路由、同 `reasoningEffort: medium`，两臂只差 `fast-mode.enabled`。每次运行使用全新工作目录，确定性 `verify.py` 判定，**80/80 全部 PASS**（每任务两臂各 5/5）。

口径（和 README 一致，务必按这个读）：

- **墙钟**：进程启动到 headless 回合结束的端到端秒数，含模型延迟、工具等待与插件开销。
- **加速比** = `墙钟(关) / 墙钟(开)`，大于 1 才是变快；1.28× 即省 22 % 时间。95 % CI 用 10 000 次配对 bootstrap 得到，跨过 1 表示与关闭不可区分。
- 只报相对值；`ms = 720 + 6.63 × 输出tok` 那类绝对模型是 1.0.0 之前的数据，已不作为本版依据。

| 任务（形状） | 对数 | 质量 | 墙钟 关 → 开 | 加速比 | 95 % CI | 输出 token 比 |
|---|---|---|---|---|---|---|
| t1 8 文件抽摘要 | 5 | 5/5 + 5/5 | 8.6 s → 11.3 s | 0.78× | 0.43–1.30 | 0.96 |
| t2 40 独立文件计数 | 5 | 5/5 + 5/5 | 7.2 s → 6.4 s | 1.14× | 0.93–1.24 | 0.90 |
| t3 6 目录逐个求和 | 5 | 5/5 + 5/5 | 5.0 s → 6.5 s | 0.81× | 0.53–1.20 | 1.13 |
| t4 12 模块审计 | 5 | 5/5 + 5/5 | 8.7 s → 13.1 s | 0.71× | 0.55–1.21 | 1.43 |
| t5 12 模块 × 5 文件热符号 | 5 | 5/5 + 5/5 | 13.9 s → 12.2 s | 1.14× | 0.90–1.82 | 0.81 |
| t6 24 日志文件求和 | 5 | 5/5 + 5/5 | 5.7 s → 5.2 s | 1.28× | 0.68–1.59 | 0.87 |
| t7 18 节点依赖链 | 5 | 5/5 + 5/5 | 4.6 s → 5.6 s | 0.98× | 0.38–1.51 | 1.02 |
| t8 16 manifest 找重复依赖 | 5 | 5/5 + 5/5 | 6.8 s → 6.0 s | 1.04× | 0.68–1.27 | 0.90 |

合并：**中位加速比 0.96×（CI 0.80–1.14×），19/40 对变快。**

怎么读：

- **收益集中在"大量互不依赖的读"**：t2/t5/t6 为 1.14×–1.28×，t5 的步数比 0.62、输入 token 比 0.63。
- **摘要/审计形状会变慢**（t1/t4），说明第一步那 4 宽探测在不需要扇出的任务上仍是净成本；这是本版已知的代价，不是噪声。
- **单轮任务的先天限制**：形状判据来自已经发生的调用，而 8 个任务都在一轮内结束，只能吃到新会话那一次探测。多轮会话的第二轮会继承第一轮的形状，单轮任务没有这个机会。把宽度选择改成读请求入口形状 + 在线 bandit，是下一步。

这份文件回答一个问题，只回答这个问题：**开了这个插件，请求真的更快了吗？**

先把版本交代清楚，因为这份文件的大部分内容是历史：

- 实验 A、B、E、F 全部跑在 **1.0.0 之前**：E 和 F 在 0.8.0 上，A 和 B 更早。那时候每个开启的档位除了「一步多宽」，还带一套从第二步开始逐步下调 `reasoning_effort` 的阶梯。
- 1.0.0 把那套阶梯**整条删了**：`agent/request` 现在只是 await 之后原样返回请求，快速模式**永不改变思考强度**。所以下面凡是「档位更高所以更快」的表格，描述的都是一个已经不存在的东西。
- 保留它们的理由：它们正好解释了那条阶梯为什么该删（实验 B、F 直接测出降档没有用），以及 1.0.0 还剩下什么、还缺哪一块证据。

1.0.0 能诚实说的只有一句话：**同样的思考强度，任务允许的时候更少往返。** 没有百分比。

- 已知的：每步的耗时账记得下来，而且几乎全由输出长度决定（`ms = 720 + 6.63 × 输出tok`，R² = 0.93）。这台路由**不产出思考 token**，所以减思考不是杠杆。
- 历史证据：0.8.0 的 `turbo` 臂（扇出 + 预读 + 输出纪律 + 降档阶梯）在 16 个同任务会话上比 `safe` 快 40 % —— 但那是四样东西的合力，其中降档那一条在 1.0.0 已经不存在了（实验 E）。
- 已知测不出的：干净的单文件任务上，各档位是控制组的 0.95×–1.09×，在噪声内（实验 F）。这不是插件坏了，是那类任务没有「几个互相独立的查询」可以并行。
- **未测**：1.0.0 现在这套（自适应扇出 2–8 + 卡顿取消 + 循环中断）**还没有在 1.0 规模上做过 A/B**。

## 结论速览

| 结论 | 证据 | 强度 |
| --- | --- | --- |
| 单步耗时几乎完全由**输出 token 数**决定 | `ms = 720 + 6.63 × 输出tok`，R² = 0.93，n = 689 | 强 |
| 这条路由**不产出思考 token** | 750 行拟合数据里 `reasoning` 全为 0；同一份实验日志的 1,888 步同样全为 0 | 强 |
| 因此降 `reasoning_effort` 不可能省下解码时间 | 四个档位 ms/token 9.0–10.6；按输出长度回归后，残差都在 ±350 ms 内且符号互相矛盾（实验 B、F） | 强 |
| 档位越高、一步里的并行调用越多（**0.8.0 数据**） | 多调用步占比：关闭 2% → `turbo`/`max` 22–23% | 中 |
| 0.8.0 的 `turbo` 整包比 `safe` 快 40 %（**0.8.0 数据，不是 1.0.0 的预测**） | 同任务 16 会话：中位 Σ步时 25.9 s → 15.6 s，步数中位 7.5 → 4.5，p = 0.008；其中降档那一条 1.0.0 已删除 | 强（n 小、两臂不均，见实验 E） |
| 1.0.0 剩下的整包（扇出 + 卡顿取消 + 循环中断）快多少 | 没有测过 | **未测** |
| 公开单文件题上，各档位落在控制组的 0.95×–1.09× | HumanEval 100 会话 + AIME 39 会话（0.8.0） | 强（只证明「该形状测不出差异」） |

一句话：**在这台自建网关的 `company/deepseek-v4.1-flash` 上，拧 `reasoning_effort` 不会让生成变快，因为这条路由根本不思考。** 剩下的杠杆只有「更少的往返」和「更少的空转」；1.0.0 只做这两件事，而它们加起来到底快多少，还没有人量过。

## 方法

- **比较单位是「步」，不是会话。** 会话墙钟里大部分是人在读和打字（本机 12 轮里，生成只占 59%），拿会话时长比快慢等于在测打字速度。
- 每步记一行 JSONL：`llmMs`（`step/start` → 最后一条 `assistant/message`）、`stepMs`、`output`/`input`/`cacheRead`/`reasoning`、`calls`、`effort`、`mode`/`gear`、`route`。
- **分档不靠手点**：实验文件按 `FNV-1a(会话 id) mod 档位数` 分配，同一个会话每次进来都落在同一档；`off` 是合法的对照组。手点分档会让"我觉得这档快"悄悄决定结果。
- 关闭状态的会话也照常记录，否则没有对照组。
- **来源**：A、B、E、F 四组实验都在 1.0.0 之前跑。当时开启的档位是「宽度 + 输出纪律 + 逐步降 effort」的整包，所以表格里写的「档位」是这个整包，不是单一变量。1.0.0 的档位只剩宽度，没有 effort 这一层。

## 实验 A：被自己的工具结果污染了

六个会话、24 步、同一个任务。其中一个收到了 **33,763 字符**的工具结果，触发 `bigChars`，把 `signals.struggling` 置上，于是后面几步的 effort 被钉住。两组不可比，实验作废。

它暴露的是当时的真实缺陷：一次 `git diff` 就能让降档卡住六步。1.0.0 里这条路径连同整个 effort 策略一起删了（`bigChars` / `struggling` 在代码里已经不存在），所以这个 bug 不再存在。留在这里是因为它说明「用一个观察信号直接决定策略」有多脆 —— 1.0.0 的调度器仍然读会话观察，但改的是宽度和上限，不是用户选的思考强度。

## 实验 B：控制住变量之后

八个独立会话，同一提示词、同一模型、同一台机器、同一分钟启动，每个三步，每步以 `BENCH-DONE` 结束。四个臂：`off` ×3、`safe` ×3、`turbo` ×1、`max` ×1 —— 共 24 步。

| 档位 | 步数 | effort（第 1→3 步） | LLM p50 | 输出 tok/步 | **ms/token** |
| --- | --- | --- | --- | --- | --- |
| `off`（对照） | 9 | `medium` / `medium` / `medium` | 1978 ms | 247 | 9.08 |
| `safe` | 9 | `medium` / `low` / `low` | 1974 ms | 227 | 9.11 |
| `turbo` | 3 | `medium` / `low` / `low` | 2262 ms | 254 | 9.01 |
| `max` | 3 | `medium` / `low` / `low` | 2216 ms | 220 | 9.47 |

插件确实降了档 —— `safe`/`turbo`/`max` 从第 2 步起把 `medium` 降到 `low`，对照臂一直停在 `medium`。但它没有变成任何东西：每 token 成本一致（9.01–9.47，5% 的散布），平均 LLM 时间也一致（2244 / 2071 / 2293 / 2081 ms）。**这张表现在的作用是反向的：它是 1.0.0 删掉降档的依据。** 一条能把 effort 从 `medium` 走到 `low`、却一分钟都没省下来的机制，正确的处理是移除，而不是再调低一档。

## 实验 E：0.8.0 的三个杠杆真的更快

> **先说边界：这是 0.8.0 的整包结果，不是 1.0.0 的预测。** 治疗臂 `turbo` = 扇出目标 6 + 投机预读 + 完整输出纪律 **+ 逐步降 effort 的阶梯**。−40 % 是这四样东西的合力，实验 E 没有把它们拆开；其中 effort 那一条在 1.0.0 已经不存在了。

实验 A 和 B 只证明了 effort 不是杠杆。实验 E 检验的是 0.8.0 真正换上的东西：**更宽的步（扇出 + 预读）、更少的步（少往返）、更短的步（输出纪律）**。

- **任务有可核对的答案**：读一个仓库，报四件事 —— ① `test/` 下每个文件的 `test(` 数，② `src/` 下每个文件的行数，③ `package.json` 的版本 / 导出键数 / 依赖，④ `git log -3` 和 `git status --porcelain`。
- **16 个独立会话，两波各八个**，同一路由（`company/deepseek-v4.1-flash`）、同一提示词、同时启动。分档同样按 `FNV-1a(会话 id) mod 2` 分配 —— 没有人手点。
- 对照 `safe`（不注入 guidance，即插件 0.8.0 之前的行为）；治疗 `turbo`（扇出目标 6 + 投机预读 + 完整输出纪律 + 降档阶梯）。

**结果（每会话 Σ step time = 该会话的 `stepMs` 之和）**

| 指标 | `safe` (n=4) | `turbo` (n=12) | 变化 |
| --- | --- | --- | --- |
| Σ步时，中位 | 25.9 s | **15.6 s** | **−40 %** |
| Σ步时，均值 | 25.7 s | 17.4 s | −33 % |
| 步数，中位 | 7.5 | **4.5** | **−40 %** |
| 输出 token/会话，中位 | 3,798 | **2,180** | −43 % |
| 输出 token/步 | 510 | 535 | +5 %（一步里干更多活，这是预期的） |
| 工具调用/步 | 1.41 | 1.37 | 持平 |
| Mann–Whitney U（Σ步时） | — | — | U = 46, z = 2.67, **p = 0.008** |

> `输出 token/会话` 那一行是整包的副产物（步少了，总量自然少），**不是 1.0.0 的目标**；1.0.0 明确接受更多 token，见后面「1.0.0 改了什么」。

两波方向一致：第一波 −32 %，第二波 −40 %。单会话在 3–8 步之间，所以这个差不是某一个离群值拖出来的中位数。

**质量没掉。** 16 个会话报的 ①②③ 完全一致（唯一看着不一致的 175 vs 173，是字面 `test(` 数和真实用例数的差别，两个都对）。④ 的差异只是我一边跑一边在改 README，脏文件数从 7 变成 8。这是一个确定性的事实题，十个数字全对上了。

**诚实的读法**

- **扇出的直接证据反而没有出现**：calls/step 1.41 → 1.37，没升。这 40 % 不是「每步更宽」挣来的，而是「步更少」（7.5 → 4.5）和「每步更短」。任务只有四个查找，对照臂本来就已经一步两个调用了，没有多少可并的余地。实验 E 也没有单独测「只开扇出、不降 effort」那一臂，所以 −40 % **既不能记在扇出头上，也不能记在降档上**（B 和 F 都说降档是 0）—— 它是一个拆不开的整包。
- 两臂人数不均（4 vs 12），是 `FNV-1a` 哈希分档的运气问题，不是挑选。n 也小（16 个会话、29 vs 54 步）。
- 实验期间有 1 个**非实验**会话在同时跑（07:21–07:37），两臂平均受它干扰，但它不进统计。
- `turbo` 的并行目标是内置的 6。1.0.0 的 `auto` 改成 2–8 自适应、默认目标 4；宽度本身没有单独做过对照。

## 实验 F：公开 benchmark 上的对照（HumanEval 100 会话，AIME 2025 39 会话）

实验 E 只有 16 个会话，而且是一个仓库任务。为了回答"换个任务还成不成立"，又跑了两组公认的公开题。**结论先写在前面：这两个 benchmark 在结构上就测不出 fan-out，所以它们能证伪的东西很少 —— 但它们证伪了"档位普遍更快"这个说法。**

**来源**：这轮同样跑在 0.8.0 上，每个开启的臂都带着降 effort 的阶梯。那条阶梯解释不了任何差异（每一行 `reasoning` 都是 0），但下面几张表里的「档位」仍然是整包，数字是历史，不是 1.0.0 的预测。

### 设计

- **任务**：HumanEval 前 10 题（题面全文给出，实现写进各自目录的 `solution.py`，用官方 `test` 本地跑通）；AIME 2025 前 10 题（最终整数写进 `answer.txt`，与官方答案比对）。
- **一题一个沙箱**：每题独立目录、独立进程、独立输出文件，互不可见；跑完逐题校验，不靠模型自述。
- **档位由 hash 分配**，不是手点：`FNV-1a(会话 id) mod 档位数`，`off` 是合法对照臂。手点会让"我觉得这档快"悄悄决定分组。
- **AB 轮转抵消时段与缓存**：每波 10 个会话同分钟启动，波内五档轮转，波与波之间重排档位。会话级取中位数，再跨会话取中位数（两级中位数，避免长尾把均值拖走）。
- **缓存变量单独看**：prompt cache 在所有臂上命中规模相同（`cacheRead` 80–85 k/会话，平的），所以"总 token"只算 `input + output`（新 token），`cacheRead` 单列 —— 否则 91–92% 的数字是缓存读，档位差异会被稀释成噪声。

下面三张表只保留原始中位数。旧版还有"最快于 safe"和"新 token ×"两列倍率，**已经去掉**：按档位切出来的单步中位数不是加速比，token 倍率也不是 1.0.0 要下的结论。**同一档位两轮之间就能漂 ±11 %**（见下面第 2 条），所以任何一位小数上的"更快"都不该发布。

### HumanEval（100 会话，10 波 × 10 题，每波 10/10 通过）

RUN A（第 1–6 波，60 会话）：

| 档位 | n | 步数/会话 | Σ步时 中位 | 步时 中位 | 输出/步 | 新 token/会话 | cacheRead | 调用/步 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `safe` | 14 | 4.2 | 6 754 ms | 1 519 ms | 481 | 550 | 83 744 | 0.80 |
| `fast` | 11 | 4.0 | 5 369 ms | 1 342 ms | 313 | 455 | 82 816 | 0.75 |
| `turbo` | 9 | 4.2 | 6 793 ms | 1 491 ms | 440 | 650 | 84 224 | 0.79 |
| `max` | 12 | 4.2 | 5 394 ms | 1 310 ms | 346 | 430 | 83 040 | 0.80 |
| `ludicrous` | 14 | 4.1 | 5 370 ms | 1 342 ms | 315 | 442 | 80 384 | 0.84 |

RUN B（第 7–10 波，40 会话）：

| 档位 | n | 步数/会话 | Σ步时 中位 | 步时 中位 | 输出/步 | 新 token/会话 | cacheRead | 调用/步 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `off` | 9 | 4.4 | 6 411 ms | 1 361 ms | 337 | 464 | 83 712 | 0.82 |
| `safe` | 12 | 4.3 | 6 064 ms | 1 364 ms | 423 | 537 | 83 776 | 0.78 |
| `turbo` | 9 | 4.0 | 5 554 ms | 1 388 ms | 341 | 466 | 85 376 | 0.78 |
| `ludicrous` | 10 | 3.9 | 5 656 ms | 1 420 ms | 339 | 469 | 84 544 | 0.85 |

### AIME 2025（39 会话，4 波）

| 档位 | n | 步数/会话 | Σ步时 中位 | 步时 中位 | 输出/步 | 新 token/会话 | cacheRead | 调用/步 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `off` | 9 | 5 | 19 357 ms | 2 047 ms | 234 | 2 810 | 103 936 | 0.80 |
| `safe` | 4 | 4.5 | 13 494 ms | 2 105 ms | 197 | 1 396 | 93 216 | 0.78 |
| `fast` | 8 | 5 | 16 572 ms | 2 510 ms | 184 | 1 724 | 107 552 | 0.80 |
| `turbo` | 8 | 4 | 10 147 ms | 1 894 ms | 136 | 968 | 81 248 | 0.75 |
| `ludicrous` | 10 | 6 | 12 432 ms | 2 007 ms | 148 | 1 252 | 122 080 | 0.90 |

`fast` 的 Σ步时中位（16 572 ms）比 `safe`（13 494 ms）还高，只是因为 `safe` 只有 4 个会话 —— 这正是这张表不报倍率的原因。

### 这两个 benchmark 教给我们的事

1. **步数被任务形状钉死。** HumanEval 每题 4–5 步，AIME 4–6 步，92 % 的会话 ≤ 15 步。fan-out 的收益随"独立查询的条数"增长，而单文件题的条数是 1 —— 所以**不是档位没效果，是这个任务没有效果可给**。
2. **`off` 和所有开启档位在噪声内。** HumanEval RUN B：`off` 0.95×、`turbo` 1.09×、`ludicrous` 1.07×（相对 `safe`）；AIME 的散布更宽（0.70×–1.33×）。而同一档位在两轮之间的漂移就有这么大（`safe` RUN A 6 754 ms vs RUN B 6 064 ms，±11 %）。**组间差 ≤ 组内漂移，就不下结论。**
3. **唯一稳定的可见差异是输出长度，而它没有变成速度。** `safe` 在两组里都是最啰嗦的一臂（输出/步 481、423），其余臂更低。方向与"输出纪律"一致，但它没有穿过上面那 ±11 % 的漂移；而且 1.0.0 不卖"省 token"这件事 —— 一步变宽会读进更多上下文，token 变多是接受的代价，不是回归。
4. **质量没有掉。** HumanEval 100 会话逐题跑官方 `test`，每波 10/10 通过；AIME 4 波分别是 9/1、9/1、8/2、7/3（通过/未通过）。没有一例因为档位而变得更差。
5. **AIME 这一轮暴露了真正的墙钟大敌 —— 不是档位，是长尾。** 39 个会话里有 5 个在执行被 task board 判超时后仍在写，单会话 550–597 s、77–132 步。把它们剔除后，`ludicrous` 的中位 Σ步时从 12 432 掉到 6 633 ms、均值从 178 s 掉到 12 s；`fast` 臂的中位从 16 572 掉到 12 840 ms。**中位数能活下来，均值活不下来 —— 但这几对数字也说明中位数不能当加速比发布**：5 个尾部会话就能让同一档的中位挪一倍，两个档位之间 0.95×–1.09× 的差在这些数字面前没有意义。这也是 0.9.0 起加"单次调用上限"、1.0.0 保留它的原因：真正吃掉时间的是少数几个停不下来的调用，而不是每步多 100 ms。

**所以这张表能认证什么、不能认证什么**：能认证"公开题上不掉质量、`off` 不慢"；不能认证"档位让公开题变快"。fan-out 的证据仍然只有实验 E 那一个 —— 而且是 0.8.0 的整包，没有单独隔离扇出的那一臂。把两组结论放在同一页，而不是只挑好看的那组 —— 这才是可复现的意思。

原始日志：[`docs/bench-raw-2026-10-24.jsonl.gz`](docs/bench-raw-2026-10-24.jsonl.gz) —— 这 179 个实验会话（含试点、实验 E 和 F）逐步骤的 `ts / sid / gear / route / ttftMs / llmMs / stepMs / calls / errors / input / output / cacheRead / cacheWrite`。会话本身和逐题沙箱在跑完后已经删掉，上面每个数字都能只靠这份日志、按声明的约定（两级中位数、波内轮转）重算出来。

## 为什么没效果：延迟模型

把 689 步全放进去做最小二乘，`llmMs` 对输出 token 数的拟合是：

```
ms = 720 + 6.63 × 输出tok        R² = 0.93
```

- **720 ms 的固定开销**（首字 + 排队 + 预处理），与输出长短无关。
- **6.63 ms/token** 的解码速度，约 150 tok/s。
- 输出长度解释了 93% 的耗时差异。剩下 7% 才是工具、路由、调度能碰的地方。

于是一步的墙钟是三项之和：

```
墙钟 ≈ 720 ms × 步数 + 6.63 ms × 输出 token + 工具等待
```

前两项来自那 689 步的拟合；第三项不在拟合里（它是 `stepMs − llmMs`），也正是长尾和卡顿待的地方 —— 1.0.0 的单次调用上限就是冲它去的。

再看 effort 的残差（扣掉输出长度影响后的平均偏差）：

| effort | 步数 | 平均输出 | 平均耗时 | 残差 |
| --- | --- | --- | --- | --- |
| `minimal` | 45 | 625 | 5356 ms | **+488 ms** |
| `low` | 451 | 534 | 4152 ms | −110 ms |
| `medium` | 87 | 402 | 3347 ms | −39 ms |
| `high` | 106 | 500 | 4328 ms | +292 ms |

中位残差全部落在 ±350 ms 内，符号还互相矛盾（最"省"的 `minimal` 残差最正）。**这不是快慢，这是噪声。**

直接证据更简单：750 行拟合数据里 `reasoning` 全为 0；同一份实验日志的 1,888 步也全为 0 —— 四个臂、五个档位，一个例外都没有。这条自建路由不产出思考 token，**所以降 effort 不可能省下任何解码时间：没有可省的解码。** 插件的降档逻辑没有写错，它只是在一个没有思考可省的路由上工作。

这正是 1.0.0 **删掉**而不是**再调低一点**的原因：在一个不产出思考的路由上把 effort 重新标定一次，仍然是在改用户的问题，而不是在改回答的速度；而且改写会随请求头变成宿主的"最近使用档位"，用户选的 Medium 会漂到 Low 并跨重启留在那里（0.9.x 之前确实如此，1.0.0 的 CHANGELOG 记了这条）。删掉之后，请求是纯透传。

顺带一个反直觉的数字：输入侧几乎免费。全部 750 步里 `cacheRead` 累计 4,086 万 token，而真正新读入的 `input` 只有 2.4 万 —— 提示缓存把输入侧抹平了，所以"省输入"也不是一个有用的方向。反过来，1.0.0 让一步变宽时多读的那点输入，在这本账上很便宜。

## 1.0.0 改了什么

1. **删掉的**：`floor`、`decideEffort`、每步降一档、`ludicrous` 发 `reasoningEffort: 'off'`、面板上的档位选择器。`agent/request` 现在只做一件事：`const resolved = await next()` …… `return resolved`。代码里唯一还读 `reasoningEffort` 的地方是把它记进指标（记录用户选了什么），从不写回。测试里有一条扫描源码、保证不再出现 effort 改写。
2. **留下的只有两类**，都只影响"同样的思考怎么走完"：
   - **让一步更宽**：`auto` 的扇出目标从 4 起，顺利两步且上一步至少 2 个调用时放到 8，报错或无进展时收窄到 2 —— 它只是"目标"，模型自己决定发几个；输出纪律只收叙述、不收答案（`light` / `full`）。
   - **让停不下来的停下来**：单次调用上限在 `auto` 下从 120 s 起，按本会话最近调用时长的 p90 × 3 往上抬、封顶 300 s（`safe` 不设限）；到点取消调用，并把"换个做法"写回给模型。循环中断：连续 6 步没有新东西 → 警告改法；12 步 → 要求停下报告；一轮 30 步同样触发。
3. **这套组合没有在 1.0 规模上做过 A/B。** 实验 E 的 −40 % 是 0.8.0 的整包，其中 effort 那一层已经被删了；实验 F 说明单文件题上本来就测不出。所以对 1.0.0 我们只有机制和方向，没有百分比。**任何把 −40 % 当成 1.0.0 数字的写法都是错的。**
4. **诚实的话术**：「同样思考强度，任务允许时更少往返」。不要说"快 40 %"，也不要说"省 43 % token" —— 后一句在 1.0.0 的方向上是反的。
5. **token 是交易，不是回归。** 一步更宽意味着一次读入更多上下文，token 可能变多；1.0.0 明确接受这一点并写进了 CHANGELOG。要报 token，必须报在"同任务、同质量、同思考强度"的 A/B 上，否则报的只是任务形状的差。
6. **下一次该测什么**：多仓库、多文件任务，每步有好几个互相独立的查询（例如一次看 5 个仓库的版本、5 个目录的测试数、5 份文件的导出）。对照用 `--gears off,safe,auto`（1.0.0 的默认是 `auto`，不是 `turbo`）；指标用 calls/step、steps/session、Σ step time，并把工具等待单列。单文件题上测不出差异是**预期**，不该再拿它当反例或正例。

## 那什么才真的更快

延迟模型自己给出了答案：`720 ms × 步数 + 6.63 ms × 输出 token + 工具等待`。可动的量只有两个，都不是"解码速度"。

| 杠杆 | 现状（本机，1.0.0 之前的日志） | 1.0.0 动不动 |
| --- | --- | --- |
| **步数** | 关闭态每轮 12.9 步；一步固定烧掉 720 ms | 动：更宽的步 + 循环中断，目标是十几次试探并成几次 |
| **工具等待** | 4,480 s 总耗时里 1,536 s 在工具里；bash p90 5.5 s、最长一次 818 s | 动：并行摊开，加上唯一一个硬上限（单次调用到点取消） |
| 输出 token | 平均 ~500 tok/步 | 只动叙述，答案不动；**不承诺总量下降** |
| 解码速度 | ~150 tok/s | 不动（1.0.0 连 effort 都不碰） |
| 首字 | 720 ms 里的固定部分 | 不动（没有流式首字信号可测，见下） |

旧版这里写的是"并行把 token 从 58 k 推到 142 k，这笔账是亏的"。1.0.0 不再这么算：token 是买墙钟的货币，账要记在同任务、同质量、同思考强度的 A/B 上，而那个 A/B 还没有做。能确认的只有一个方向性结果：0.8.0 的 16 个同任务会话少用 3 步、少 40 % 墙钟，代价是每步多 5 % 输出。它说明方向，不构成 1.0.0 的证据。

## 这份实测的局限

- **一条路由**。`company/deepseek-v4.1-flash` 经自建网关；官方 DeepSeek 路由声明了 `off/low/high/max` 并有真实的思考 token，结论不能直接搬过去。
- **样本小**。实验 B 每档 1–3 个会话，够看出"没有差异"，不够看出"差异是 3%"。
- **没有 1.0.0 的 A/B**。A/B/E/F 全部是 1.0.0 之前的；1.0.0 的扇出、卡顿取消、循环中断从未在同一个任务上与 `safe` 对照过。这是这份文档最大的缺口。
- **所有档位数字都是旧整包的**。实验 E 的 −40 % 和实验 F 的 0.95×–1.09× 都带着降 effort 那一层；去掉之后会变成什么样，没有测过。
- **首字是近似值**。`assistant/message` 每步只提交一次，所以 `ttftMs` 就是 `llmMs`，不是真正的流式首字。这一栏目前只能当"整步耗时"读。
- **实验 F 的臂不均、有长尾**。档位由哈希分配，`safe` 只有 4 个会话而 `off` 有 9 个；5 个 550–597 s 的超时会话能把同一档的中位数挪一倍。

## 复现

```bash
# 仓库里直接跑，等价于安装后的 dsh-fast-mode-experiment / dsh-fast-mode-report
node bin/experiment.mjs start --gears off,safe,auto   # 1.0.0 该测的对照：关 / 只有边界 / 自适应整包
node bin/experiment.mjs status                        # 每档已有多少会话/步
node bin/report.mjs --since 2d                        # 两张表 + 相对关闭态的倍率
node bin/experiment.mjs stop                          # 结束，之后的会话回到插件配置
```

- `--gears` 不传时默认是 `off,safe,fast,turbo,max`；A/B/E/F 那几轮用的就是这套固定宽度臂（`--gears safe,turbo` 是实验 E 的最小复现）。1.0.0 里实验臂会按名字原样生效（包括 `off`），`turbo`/`max` 仍是固定宽度 6/8，但**不再降 effort** —— 所以重跑得到的是"扇出 + 纪律 + 卡顿上限"，数字不会等于当年的 −40 %。
- 报告的两个倍率表在**任务形状不一致**时不要读：本机那两张全量表里 `fast` 显示"模型耗时 0.89×"，那是它恰好落在长输出会话里的结果，不是加速。要比就比实验 B 那种同任务、同步数的小样本，或者直接用上面的延迟模型做残差比较 —— 后者对任务形状免疫。
- 实验 E 的最小复现：`--gears safe,turbo`，然后并发跑两波、每波 8 个同提示词的会话，最后按 `gear` 分组算每会话的 `ΣstepMs` 中位数。原始行在 `~/.dsh/fast-mode-metrics.jsonl` 里（本机存在），按 `sid` 分组即可重算，不需要重跑模型。
- 0.8.0 那一轮的原始日志在 [`docs/bench-raw-2026-10-24.jsonl.gz`](docs/bench-raw-2026-10-24.jsonl.gz)（已随仓库提交），按上面的约定可以重算实验 E 和 F 的每一个数。
- 测多仓库任务时，不要直接读 `dsh-fast-mode-report` 的全量倍率表当结论；先按任务分组，再比同组内的中位数。

---

# Measured: where it is faster, and where it is not

One question, one answer: **did the request actually get faster?**

Version first, because most of this file is history:

- Experiments A, B, E and F all predate **1.0.0**: E and F ran on 0.8.0, A and B earlier still. Back then every enabled gear carried a ladder that lowered `reasoning_effort` from the second step of a turn, on top of "how wide is one step".
- 1.0.0 deleted that ladder outright: `agent/request` now awaits and returns the resolved request unchanged, and fast mode **never touches the thinking effort**. Every table below that reads "higher gear, faster" describes a bundle that no longer exists.
- They stay because they are the evidence for deleting it (B and F measured the downshift doing nothing), and because they show what 1.0.0 kept and which measurement is still missing.

The only honest 1.0.0 claim: **same thinking effort, fewer round trips where the task allows them.** No percentage.

- Known: the per-step ledger, and that step latency is almost entirely output length (`ms = 720 + 6.63 × outTok`, R² = 0.93). This route emits no reasoning tokens, so trimming thought is not a lever.
- Historical: 0.8.0's `turbo` arm (fan-out + prefetch + output discipline + effort ladder) beat `safe` by 40 % on 16 same-task sessions — a bundle of four things, and the effort one is gone (Experiment E).
- Known to be unmeasurable here: on clean single-file tasks gears land at 0.95×–1.09× of control, inside the noise (Experiment F). That is the task shape having no independent queries to fan out, not the plugin failing.
- **Unmeasured**: 1.0.0's current bundle (adaptive fan-out 2–8 + stalled-call cancellation + loop breaking) has never been A/B measured at 1.0 scale.

## Summary

| Claim | Evidence | Strength |
| --- | --- | --- |
| Step latency is almost entirely output tokens | `ms = 720 + 6.63 × outTok`, R² = 0.93, n = 689 | strong |
| This route emits no reasoning tokens | `reasoning` is 0 in all 750 fit rows; also 0 in all 1,888 steps of the same experiment log | strong |
| So lowering `reasoning_effort` cannot save decode time | per-token latency 9.0–10.6 ms across four gears; residuals within ±350 ms with contradictory signs (B, F) | strong |
| Higher gears fan out more tool calls per step (**0.8.0 data**) | multi-call steps: off 2% → `turbo`/`max` 22–23% | medium |
| 0.8.0's `turbo` bundle beat `safe` by 40 % (**0.8.0 data, not a 1.0.0 prediction**) | 16 same-task sessions: median Σ step time 25.9 s → 15.6 s, median steps 7.5 → 4.5, p = 0.008; the effort layer is deleted in 1.0.0 | strong (small n, uneven arms — see Experiment E) |
| How much 1.0.0's remaining bundle (fan-out + stall cancellation + loop breaking) is worth | not measured | **unmeasured** |
| On public single-file suites every gear sits at 0.95×–1.09× of control | HumanEval 100 + AIME 39 (0.8.0) | strong (only that the shape cannot show a difference) |

In one line: **on `company/deepseek-v4.1-flash` behind a self-hosted gateway, turning `reasoning_effort` up does not make generation faster, because this route does not think.** The only levers left are fewer round trips and less spinning; 1.0.0 does exactly those two, and how much they are worth together has not been measured.

## Method

- The unit is the **step**, not the session: most of a session's wall clock is a human reading and typing (generation was 59% of step time across 12 turns here).
- Each step appends one JSONL row: `llmMs`, `stepMs`, `output`/`input`/`cacheRead`/`reasoning`, `calls`, `effort`, `mode`/`gear`, `route`.
- **Arms are assigned, not clicked**: the experiment file assigns by `FNV-1a(session id) mod gears`, so a session keeps its arm and nobody's hunch picks it. `off` is a legal control arm. Sessions with the switch off are recorded too, otherwise there is no baseline.
- **Provenance**: A, B, E and F all predate 1.0.0. An enabled arm was then the bundle "width + output discipline + a per-step effort downshift", so "gear" in those tables means the bundle, not one variable. A 1.0.0 gear is width only.

## Experiment A: contaminated by its own tool output

Six sessions, 24 steps, identical task. One of them received a **33,763-character** tool result, tripping `bigChars`, which set `signals.struggling` and pinned the effort for the following steps. The comparison is void, and it exposed a real plugin defect: one `git diff` can block downshifting for six steps.

That path is gone with the rest of the effort policy (`bigChars` / `struggling` no longer exist in the code), so the bug is gone too. It stays here because it shows how brittle "one observation directly sets the policy" is — 1.0.0's scheduler still reads session observations, but it changes width and ceilings, never the thinking effort the user chose.

## Experiment B: variables controlled

Eight independent sessions, one prompt, one model, one machine, started in the same minute. Three steps each, every one ending in `BENCH-DONE`. Four arms: `off` ×3, `safe` ×3, `turbo` ×1, `max` ×1 — 24 steps total.

| Gear | Steps | Effort (step 1→3) | LLM p50 | Output tok/step | **ms/token** |
| --- | --- | --- | --- | --- | --- |
| `off` (control) | 9 | `medium` / `medium` / `medium` | 1978 ms | 247 | 9.08 |
| `safe` | 9 | `medium` / `low` / `low` | 1974 ms | 227 | 9.11 |
| `turbo` | 3 | `medium` / `low` / `low` | 2262 ms | 254 | 9.01 |
| `max` | 3 | `medium` / `low` / `low` | 2216 ms | 220 | 9.47 |

The plugin did downshift — `safe`/`turbo`/`max` drop `medium` → `low` from step 2 while the control stays at `medium`. But it bought nothing: the per-token cost is identical (9.01–9.47, a 5% spread), and so is mean LLM time (2244 / 2071 / 2293 / 2081 ms). **The table now works in reverse: it is the reason 1.0.0 deleted the downshift.** A mechanism that can walk effort from `medium` to `low` without saving a single minute should be removed, not tuned one notch lower.

## Experiment E: 0.8.0's three levers are actually faster

> **Boundary first: this is 0.8.0's bundle, not a 1.0.0 prediction.** The treatment arm `turbo` = fan-out target 6 + speculative prefetch + full output discipline **+ the per-step effort ladder**. The −40 % is the four together; E did not isolate them, and the effort one is gone in 1.0.0.

Experiments A and B only proved that effort is not a lever. Experiment E tests the levers 0.8.0 does pull: **wider steps (fan-out + prefetch), fewer steps (fewer round trips), shorter steps (output discipline)**.

- **Identical task with a checkable answer**: read one repository and report four things — ① per-file `test(` counts under `test/`, ② per-file line counts under `src/`, ③ `package.json` version / export-key count / dependencies, ④ `git log -3` and `git status --porcelain`.
- **16 independent sessions in two waves of eight**, same route (`company/deepseek-v4.1-flash`), same prompt, started concurrently. Arms again assigned by `FNV-1a(session id) mod 2` — nobody clicked anything.
- Control `safe` (no guidance section injected, i.e. the plugin's pre-0.8.0 behaviour); treatment `turbo` (fan-out target 6 + speculative prefetch + full discipline + effort ladder).

**Results (per-session Σ step time = sum of that session's `stepMs`)**

| Metric | `safe` (n=4) | `turbo` (n=12) | Change |
| --- | --- | --- | --- |
| Σ step time, median | 25.9 s | **15.6 s** | **−40 %** |
| Σ step time, mean | 25.7 s | 17.4 s | −33 % |
| Steps, median | 7.5 | **4.5** | **−40 %** |
| Output tokens per session, median | 3,798 | **2,180** | −43 % |
| Output tokens per step | 510 | 535 | +5 % (a fatter step is the point) |
| Tool calls per step | 1.41 | 1.37 | flat |
| Mann–Whitney U (Σ step time) | — | — | U = 46, z = 2.67, **p = 0.008** |

> The `output tokens per session` row is a by-product of the bundle (fewer steps, smaller total), **not a 1.0.0 goal**: 1.0.0 explicitly accepts more tokens. See "What 1.0.0 changes" below.

Both waves agree in direction: −32 % in wave one, −40 % in wave two. Individual sessions range from 3 to 8 steps, so the gain is not one outlier dragging the median.

**Quality did not drop.** All 16 sessions reported items ①②③ identically (the one apparent disagreement, 175 vs 173, is the literal `test(` count versus the real test-case count — both correct). Item ④ differed only because I was editing the README while they ran, so the dirty-file count moved from 7 to 8. This was a deterministic fact task and all ten numbers landed.

**Honest reading**

- **The direct fan-out evidence is missing**: calls per step went 1.41 → 1.37, i.e. it did not rise. The win came from fewer steps (7.5 → 4.5) and shorter steps. The task has four lookups and the control arm already batched two calls into one step, so there was little to merge. E also had no arm that isolated fan-out from the effort ladder, so the −40 % **cannot be credited to fan-out, and cannot be credited to the downshift** (B and F say that was zero) — it is one bundle that cannot be split.
- The arms are uneven (4 vs 12) because of the `FNV-1a` hash, not because of selection, and n is small (29 vs 54 steps).
- One **non-experiment** session ran alongside (07:21–07:37). It hits both arms equally and is excluded from the statistics.
- `turbo`'s built-in fan-out target is 6. 1.0.0's `auto` replaces it with adaptive 2–8 starting at 4; the widths themselves were never compared.

## Experiment F: the same comparison on public benchmarks (HumanEval 100 sessions, AIME 2025 39 sessions)

Experiment E had 16 sessions and one repo task. To ask whether it generalises, two
well-known public suites were run. **The answer up front: both are structurally
unable to exercise fan-out — but they do falsify "every gear is faster".**

**Provenance**: this run is also from 0.8.0, where every enabled arm still carried
the effort ladder. That ladder cannot explain any of the differences in either
direction (`reasoning` is 0 in every row), but the arms are still bundles, so the
numbers below are history, not a 1.0.0 prediction.

### Design

- **Tasks**: the first 10 HumanEval problems (full statement given; the solution
  goes into its own `solution.py`, checked with the official `test` locally) and
  the first 10 AIME 2025 problems (final integer into `answer.txt`, compared with
  the official answer).
- **One sandbox per problem**: own directory, own process, own output file; every
  answer is checked, never taken on the model's word.
- **Arms are hashed, not clicked**: `FNV-1a(session id) mod gears`; `off` is a
  legal control. Clicking lets a hunch pick the groups.
- **AB rotation cancels time-of-day and cache drift**: ten sessions start in the
  same minute per wave, gears rotate inside the wave and are reshuffled between
  waves. Per-session medians, then a median across sessions — a two-stage median,
  so a long tail cannot drag the mean.
- **Cache is looked at separately**: `cacheRead` is flat across arms (80–85 k per
  session), so "total tokens" counts `input + output` (new tokens) only and
  `cacheRead` gets its own column. Otherwise 91–92 % of the sum is cache reads and
  the gear difference drowns.

The three tables keep raw medians only. The old `faster than safe` and
`new tokens ×` multiplier columns are **gone on purpose**: a per-gear step-time
median is not a speed ratio, and a token ratio is not the claim 1.0.0 makes. One
arm drifts ±11 % between two runs (point 2 below), so no "faster" worth a decimal
place can be published from them.

### HumanEval (100 sessions, 10 waves × 10 problems, 10/10 passing per wave)

RUN A (waves 1–6, 60 sessions):

| Gear | n | steps/session | median Σ step ms | median step ms | out/step | new tok/session | cacheRead | calls/step |
|---|---|---|---|---|---|---|---|---|
| `safe` | 14 | 4.2 | 6 754 ms | 1 519 ms | 481 | 550 | 83 744 | 0.80 |
| `fast` | 11 | 4.0 | 5 369 ms | 1 342 ms | 313 | 455 | 82 816 | 0.75 |
| `turbo` | 9 | 4.2 | 6 793 ms | 1 491 ms | 440 | 650 | 84 224 | 0.79 |
| `max` | 12 | 4.2 | 5 394 ms | 1 310 ms | 346 | 430 | 83 040 | 0.80 |
| `ludicrous` | 14 | 4.1 | 5 370 ms | 1 342 ms | 315 | 442 | 80 384 | 0.84 |

RUN B (waves 7–10, 40 sessions):

| Gear | n | steps/session | median Σ step ms | median step ms | out/step | new tok/session | cacheRead | calls/step |
|---|---|---|---|---|---|---|---|---|
| `off` | 9 | 4.4 | 6 411 ms | 1 361 ms | 337 | 464 | 83 712 | 0.82 |
| `safe` | 12 | 4.3 | 6 064 ms | 1 364 ms | 423 | 537 | 83 776 | 0.78 |
| `turbo` | 9 | 4.0 | 5 554 ms | 1 388 ms | 341 | 466 | 85 376 | 0.78 |
| `ludicrous` | 10 | 3.9 | 5 656 ms | 1 420 ms | 339 | 469 | 84 544 | 0.85 |

### AIME 2025 (39 sessions, 4 waves)

| Gear | n | steps/session | median Σ step ms | median step ms | out/step | new tok/session | cacheRead | calls/step |
|---|---|---|---|---|---|---|---|---|
| `off` | 9 | 5 | 19 357 ms | 2 047 ms | 234 | 2 810 | 103 936 | 0.80 |
| `safe` | 4 | 4.5 | 13 494 ms | 2 105 ms | 197 | 1 396 | 93 216 | 0.78 |
| `fast` | 8 | 5 | 16 572 ms | 2 510 ms | 184 | 1 724 | 107 552 | 0.80 |
| `turbo` | 8 | 4 | 10 147 ms | 1 894 ms | 136 | 968 | 81 248 | 0.75 |
| `ludicrous` | 10 | 6 | 12 432 ms | 2 007 ms | 148 | 1 252 | 122 080 | 0.90 |

`fast`'s median Σ step time (16 572 ms) is higher than `safe`'s (13 494 ms) only
because `safe` has 4 sessions — which is exactly why this table carries no ratio.

### What these two benchmarks taught us

1. **Step count is pinned by the task shape.** 4–5 steps per HumanEval problem,
   4–6 per AIME problem, 92 % of sessions ≤ 15 steps. Fan-out pays per independent
   query, and a single-file problem has one — so this is not "the gear does
   nothing", it is "this task has nothing to give".
2. **`off` and every enabled gear sit inside the noise.** HumanEval RUN B: `off`
   0.95×, `turbo` 1.09×, `ludicrous` 1.07× against `safe`; AIME spreads wider
   (0.70×–1.33×). The drift of one arm between the two runs is the same size
   (`safe` 6 754 ms in RUN A vs 6 064 ms in RUN B, ±11 %). **When the between-group
   gap is ≤ the within-group drift, no conclusion is drawn.**
3. **The only stable visible difference is output length, and it does not become
   speed.** `safe` is the verbose arm in both suites (481 and 423 out/step); the
   rest are lower. That is the direction output discipline predicts, but it never
   crossed the ±11 % drift above — and 1.0.0 does not sell a token saving: a wider
   step reads more context, so more tokens are an accepted cost, not a regression.
4. **Quality did not drop.** HumanEval ran the official `test` on all 100 sessions,
   10/10 passing in every wave; AIME's four waves scored 9/1, 9/1, 8/2, 7/3. No
   case got worse because of the gear.
5. **The AIME run exposed the real wall-clock enemy, and it is not the gear.** Five
   of 39 sessions kept writing after the task board judged them timed out — 550–597 s
   and 77–132 steps each. Drop them and `ludicrous`'s median Σ step time falls from
   12 432 to 6 633 ms while its mean falls from 178 s to 12 s; the `fast` arm's
   median falls from 16 572 to 12 840 ms. **The median survives, the mean does not —
   and these same pairs show why a median must not be published as a speed ratio**:
   five tail sessions can move one arm's median by a factor of two, so the
   0.95×–1.09× gap between arms means nothing next to them. It is also why 0.9.0
   added a ceiling on one tool call and 1.0.0 kept it: what eats the clock is a few
   calls that never stop, not 100 ms per step.

**What this table can and cannot certify**: it certifies that public tasks keep
their quality and that `off` is not slower. It does not certify that a gear makes a
public task faster. The fan-out evidence is still Experiment E alone — and that is
0.8.0's bundle, with no arm that isolates fan-out. Both results stay on the same
page instead of publishing the flattering one — that is what reproducible means
here.

Raw log: [`docs/bench-raw-2026-10-24.jsonl.gz`](docs/bench-raw-2026-10-24.jsonl.gz)
— per-step rows (`ts / sid / gear / route / ttftMs / llmMs / stepMs / calls /
errors / input / output / cacheRead / cacheWrite`) for the 179 experiment sessions,
including the pilot and Experiments E and F. The sessions themselves and the
per-problem sandboxes were deleted once the run finished; every number above is
reproducible from this log alone under the stated conventions (two-stage medians,
in-wave gear rotation).

## Why: the latency model

Least squares over 689 steps:

```
ms = 720 + 6.63 × outTok        R² = 0.93
```

720 ms of fixed cost per step, 6.63 ms per output token (~150 tok/s). Output length explains 93% of the variance; tools, routing and scheduling share what is left.

So one step's wall clock is three terms:

```
wall clock ≈ 720 ms × steps + 6.63 ms × output tokens + tool wait
```

The first two come from that 689-step fit; the third is not in the fit (it is `stepMs − llmMs`) and is exactly where the long tail and the stalls live — which is why 1.0.0's per-call ceiling is aimed there.

Effort residuals (mean deviation after removing the length effect): `minimal` +488 ms, `low` −110 ms, `medium` −39 ms, `high` +292 ms — median residuals all within ±350 ms with contradictory signs. That is noise, not speed.

The simplest evidence: `reasoning` is 0 in all 750 fit rows, and also 0 in all 1,888 steps of the same experiment log — four arms, five gears, not one exception. This route produces no thinking tokens, **so lowering effort could not have saved any decode time: there was no decode to save.** The downshift logic was not wrong; it was working on a route with nothing to save.

That is why 1.0.0 **removes** the lever instead of tuning it lower: re-calibrating effort on a route that does not think is still changing the user's question, not the speed of the answer — and the rewrite reached the provider as a request header, so the composer kept showing "last used effort" and a conversation chosen at Medium drifted to Low across restarts (true before 0.9.x; the 1.0.0 CHANGELOG records the fix). With the rewrite gone, the request is a pass-through.

One counter-intuitive number to finish: input is nearly free. Across all 750 steps `cacheRead` accumulates 40.86 M tokens while genuinely new `input` is 24 k — prompt caching flattens the input side, so "save input" is not a useful direction either. Which also means the extra input a wider step reads is cheap on this ledger.

## What 1.0.0 changes about these conclusions

1. **Deleted**: `floor`, `decideEffort`, the per-step drop, `ludicrous` sending `reasoningEffort: 'off'`, and the gear picker in the panel. `agent/request` now does one thing: `const resolved = await next()` … `return resolved`. The only place that still reads `reasoningEffort` is the metrics label — it records what the user chose and never writes back, and a test scans the source to keep it that way.
2. **Kept, and it only comes in two kinds**, both about how the same thinking gets carried out:
   - **making a step wider**: `auto` starts with a fan-out target of 4, widens to 8 after two clean steps that each carried ≥2 calls, and narrows to 2 after errors or no progress — a *target*, the model still chooses the calls; output discipline trims narration and never the answer (`light` / `full`).
   - **stopping what will not stop**: under `auto` the per-call ceiling starts at 120 s and grows with the session's own p90 call latency ×3, capped at 300 s (`safe` has no ceiling); at the deadline the call is cancelled and "change the approach" is written back to the model. Loop breaking: 6 consecutive no-progress steps → change-approach warning; 12 → stop and report; 30 steps in one turn does the same.
3. **This combination has not been A/B measured at 1.0 scale.** E's −40 % is 0.8.0's bundle with the effort layer still in it; F says single-file tasks cannot show the effect anyway. So 1.0.0 has a mechanism and a direction, not a percentage. **Quoting −40 % as a 1.0.0 number is wrong.**
4. **The honest line**: "same thinking effort, fewer round trips where the task allows them". Not "40 % faster", and not "43 % fewer output tokens" — the latter is backwards for 1.0.0.
5. **Tokens are a trade, not a regression.** A wider step reads more context, so token counts may rise; 1.0.0 accepts that explicitly (it is in the CHANGELOG). A token number only means something in a same-task, same-quality, same-effort A/B, and that A/B has not been run.
6. **What to measure next**: multi-repository, multi-file tasks with several independent queries per step (five repos' versions, five directories' test counts, five files' exports). Arms: `--gears off,safe,auto` (`auto` is the 1.0.0 default, not `turbo`). Metrics: calls/step, steps/session, Σ step time, tool wait on its own line. Showing no difference on a single-file task is **expected**, and is no longer a useful counter-example in either direction.

## What would actually be faster

The model answers it itself: `720 ms × steps + 6.63 ms × output tokens + tool wait`. Only two terms can move, and neither is "decode rate".

| Lever | Here (local log, pre-1.0.0) | 1.0.0 moves it? |
| --- | --- | --- |
| **Steps** | 12.9 steps per turn with the switch off; each burns 720 ms of fixed cost | yes — wider steps plus the breaker, so a dozen probes become a few |
| **Tool wait** | 1,536 s of 4,480 s total sat in tools; bash p90 5.5 s, one call 818 s | yes — spread out in parallel, plus the one hard ceiling (a call is cancelled at its deadline) |
| Output tokens | ~500 tok/step on average | only narration, never the answer; **no promise of a lower total** |
| Decode rate | ~150 tok/s | no (1.0.0 does not even touch effort) |
| Time to first token | the fixed part of the 720 ms | no (no streaming signal to measure — see Limits) |

The old version of this section argued "fan-out pushed tokens from 58 k to 142 k per session, so the trade is a loss". 1.0.0 does not do that arithmetic: tokens are the currency that buys wall clock, and the ledger is only valid on a same-task, same-quality, same-effort A/B that has not been run. The one directional result is 0.8.0's: 16 same-task sessions, three steps fewer, 40 % less wall clock, at 5 % more output per step. That shows a direction; it is not 1.0.0's evidence.

## Limits

- **One route.** `company/deepseek-v4.1-flash` through a self-hosted gateway; the official DeepSeek route declares `off/low/high/max` and does produce thinking tokens, so these conclusions do not transfer.
- **Small sample.** Experiment B has 1–3 sessions per arm: enough to see "no difference", not enough to see "a 3 % difference".
- **No 1.0.0 A/B.** A/B/E/F all predate 1.0.0; 1.0.0's fan-out, stalled-call cancellation and loop breaking have never been compared with `safe` on one task. This is the largest gap in this document.
- **Every gear number is a bundle.** E's −40 % and F's 0.95×–1.09× both carry the effort layer; what they become without it has not been measured.
- **Time to first token is approximate.** `assistant/message` is emitted once per step, so `ttftMs` equals `llmMs`; read that column as "whole-step time".
- **F's arms are uneven and long-tailed.** Hash assignment gave `safe` 4 sessions against `off`'s 9, and five 550–597 s timeout sessions can move one arm's median by a factor of two.

## Reproduce

```bash
# from the repo, equivalent to the installed dsh-fast-mode-experiment / dsh-fast-mode-report
node bin/experiment.mjs start --gears off,safe,auto   # what 1.0.0 should be compared on: off / edges only / the adaptive bundle
node bin/experiment.mjs status                        # sessions and steps per arm
node bin/report.mjs --since 2d                        # the two tables plus ratios against the off arm
node bin/experiment.mjs stop                          # end it; later sessions go back to the plugin config
```

- Without `--gears` the default is `off,safe,fast,turbo,max`, which is the fixed-width set A/B/E/F used (`--gears safe,turbo` is E's minimal reproduction). In 1.0.0 an experiment arm is honoured as written, including `off`; `turbo`/`max` are still fixed widths 6/8 but **no longer lower effort**, so a rerun measures "fan-out + discipline + stall ceiling" and will not reproduce −40 %.
- Do not read the report's two ratio tables when **task shapes differ**: in the local full-history table `fast` shows "model time 0.89×" only because it happened to land on long-output sessions, which is not speed. Compare a same-task, same-step-count sample like Experiment B, or use the latency model's residual comparison — that one is immune to task shape.
- Experiment E's minimal reproduction: `--gears safe,turbo`, then two concurrent waves of eight sessions on one prompt, and a per-session `ΣstepMs` median grouped by `gear`. The raw rows are in `~/.dsh/fast-mode-metrics.jsonl` (present on this machine); grouping by `sid` recomputes the table without re-running a model.
- The 0.8.0 raw log is [`docs/bench-raw-2026-10-24.jsonl.gz`](docs/bench-raw-2026-10-24.jsonl.gz) (committed with the repo); under the stated conventions it reproduces every number in Experiments E and F.
- For multi-repo tasks, do not treat the whole-history ratio table from `dsh-fast-mode-report` as a conclusion; group by task first, then compare medians inside a group.
