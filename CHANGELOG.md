# Changelog

## 1.5.0

**默认不再按步数收尾：什么时候结束由任务状态和完成证据决定，不由计数器决定。**

1.4.4 把「第 10 步提醒收尾」设成默认，速度确实上去了，但它对**还在推进的长任务**同样开火：第 10 步一到就要求停止扩大范围，等于用一个和完成度无关的数字替模型决定“做完了没有”。1.5.0 取消这条默认。

- **默认无收尾线、无步数上限**：`finishLineSteps` 与 `stepBudget` 默认都是 `0`（关闭）。只有用户自己把某个值设成正数时，才各发一次对应提醒；`0` 就是关，不再回落到旧默认值。
- **无进展只是诊断，不是判决**：连续若干步没有产出新结果时，只发一次「换方法」提醒（后台跑+轮询、把脚本写到文件再执行、缩小到一条路径），**不结束回合**。任务做完就正常报告，不会被提醒逼停。
- **检查复用绑定产物版本**：同一份产物上逐字重复一条已通过的检查，才提示「这个检查在当前文件上已经通过，结果可复用，把这一步花在剩下的工作上」。任何写操作、编辑、或改写类 shell 命令都会让该版本失效，旧结果立即作废；逐字重复的检查命令本身不会让自己失效（否则 `npm test` 永远无法触发这条提示）。
- **新增 `outputBudget`（默认关闭）**：本轮累计输出 token（上游 `usage.outputTokens`，不是估算）达到该值，调度器发一次「收掉当前闭环、跑一次证明它的检查、汇报」，每轮最多一次。它盯的是真实解码量而不是步数——三步写出三万 token 的任务很贵，二十步只写两千 token 的任务不贵；但 token 同样是成本而非完成度证据，所以默认 `0`，只作对照臂。对照臂 `outputBudget: 8000` 在 `codeimpl`/`migrate`/`codebase` 各 3 对上跑过（9 个完整单元、27 次运行全绿）：总量 0.68× 墙钟 / 0.70× 输出，其中 `codeimpl` 输出再降 23 %（0.60× → 0.46×），而单步写入短的 `codebase` 反而 1.16× 输出——所以它是可配项，不是默认。
- **新增 `shapeGate`（默认关闭）**：本轮累计工具调用 ≥ 4 且写入类（不在只读名单里的工具）占比 ≥ 60 % 时，**整轮不再注入任何提醒**，退回原生。它给写密集型任务一条「别管我」的退路——这类任务没有可并行的调用，每条提醒都只是一次用不上的往返。判据只用已有工具名，不发请求、不加请求体字段；默认关，因为它同时会压掉本可救长尾的收尾提醒，尚未单独跑对照臂。
- **本轮主实验：9 家族 × 6 对三臂交错 ABBA（162 次运行、51 个完整单元）**。`off` 6846.7 s / 1 770 746 输出 token / 3518 步；`fl10` **0.66× 墙钟 / 0.69× 输出 / 0.69× 步数**（逐对 41/51 更快）；`open15` **0.68× / 0.68× / 0.69×**（38/51）。分家族上两臂互补：`open15` 在 `csvpipe` 0.46×、`perfrefactor` 0.62×、`stategraph` 0.63× 上更狠，`fl10` 在 `shellpipeline` 0.52×、`debugfix` 0.69×、`codeimpl` 0.68× 上更好；两者都在 `migrate`/`debugfix` 上留了输出回升（`open15` 分别 1.07× / 1.24×）。
- **两个更快的配置都没通过门禁，1.5.0 默认不变**。`fl10`：`ledger` p1 基线与默认都绿、它红 21/22（重跑 5 次全绿，1/6 失败率）；`open15`：补测 5 个家族、29 个单元后相对默认 `def15` 是 **1.04× 墙钟 / 1.03× 输出**，`shellops` p7 基线绿而它红，`csvpipe` p5 用掉 325 步 / 499 s / 5.2 倍输出 token。按「基线绿而该臂红即不合格」，两者都退回实验旋钮，`finishLineSteps: 0` 与 `openBatch: false` 保持默认——宁慢不降质。分家族与单元级数据见 `BENCHMARK.md` 的 `H2`/`H3`。
- **进展按结果内容判定**：用结果内容的摘要（digest）而不是输出长度判断“这一步有没有新东西”。`completed 10 / 99` → `11 / 99` 这种等长轮询算进展，不会被误判成卡住；判定单位是整步，不是单次调用。
- **证据优先级**：最近三次调用都报错时，扇出宽度直接回到 1，压过“请求措辞像扇出”的分类。
- **看门狗取消后等真实收尾**：取消一个卡住的调用后，先等它真正停下（窗口随预算缩放，250 ms–5 s）再返回失败，并把 `quiesced` 记进日志。以前是“先告诉模型已取消，清理还在跑”，下一个步骤可能和上一个进程并发写同一个目录。
- **`enabled: false` 是真的关**：关闭态下看门狗预算为 0，不再按档位表在两分钟后取消调用。
- **测试与 CI**：223 个测试在 Node 20.20.2、22.23.4、24 上全绿。顺带修掉 Node 20/22 上 `node:test` 报 “Promise resolution is still pending but the event loop has already resolved” 并取消 17 个用例的问题（看门狗定时器不再 `unref`，它本来就会被 `clearTimeout`）。
- **措辞更正**：不再声称“请求体逐字节不变”——真实契约是**不加请求字段**（不改 `reasoningEffort`、不注入 `service_tier` / `max_tokens`）；开着时模型输入里多出的内容是本插件自己的调度提示与提醒，关掉后不存在。
- 移除从未被读取的常量 `AUTO_LIMITS.parallelMin`。
- 1.4.4 的 1.86×（7 家族 14 对、`finishLineSteps: 10`）保留为**已退役默认的消融证据**，不是 1.5.0 的速度声明。1.5.0 的重基线：9 家族 54 个完整单元、隐藏测试全绿，总量 **0.86× 墙钟 / 0.95× 输出 / 0.85× 步数**；写文件型三家族（`migrate` 1.02×、`codeimpl` 1.09×、`perfrefactor` 1.33×）没有稳定加速，见 BENCHMARK.md。
- **计量日志有上限**：`~/.dsh/fast-mode-metrics.jsonl` 每步一行、只追加，装几个月会无限长（本机 7.6 MB）。现在超过 8 MB 就把当前文件改名成 `.1`、新开一份继续写，最多留两代（约 16 MB）；`bin/report.mjs` 会把两代一起读，轮转不丢历史。

## 1.4.4

**收尾线定版：7 家族 14 对中位 1.86×、输出 −52%、正确性 14/14 零损失。**

- 新增 `finishLineSteps` 并**设为默认 10**：第 10 步由调度器注入一次「别再扩大范围、不重跑已通过的检查、只修还在报的错、然后报告」，不阻断工具、不截断步骤。E1 七家族 14 对 ABBA：中位 **1.86×**、**13/14 更快**（符号检验 **p=0.002**）、输出 **−52 %**、步数 **−10.0**、隐藏测试 **14/14 全绿**；旧默认 `late` 同轮 1.31×（11/14，p=0.057）。
- 同轮直接配对（`fl10` ÷ `late`，14 对）：中位 **1.27×**、11/14 更快（p=0.057）、输出 **−22 %**、步数中位不变——收尾线省的是**重复验证的输出**，不是步骤。
- 新增 `stepBudget`（默认 30，可配 4–80）：硬预算只发一次「停止扩大范围、跑一次验证、直接报告」，仍不阻断工具，因为硬截断会把任务切在编辑中途。
- 被否掉的候选写进 BENCHMARK：`stepBudget: 15`（C1 2.04× / D1 1.26×，短任务桶 0.43–0.77×）、`finishLineSteps: 8`（C1 1.63× / D1 1.50×，6–10 步桶 0.44×）、两条叠加（D1 1.14×）。
- 归因沿用 B1：`late-guid0`（关掉提示段）0.96× vs `late` 1.26×——提示段是载荷；并行宽度 `parallel: 1` 1.10× 不是。
- 语料：5 轮 ABBA、272 次运行、7 个家族、隐藏测试确定性评分，全部 `exit 0`；`migrate` 的 12 次“红”经查是隐藏测试过严（只接受 `address.city`），已归一化为 `missing_field:address`，不是 agent 的错。
- 文档：`docs/REFERENCE.md` / `.en.md` 补上两个旋钮的默认值与实测，`outputDiscipline` 的默认值从旧文案的 `true` 更正为实际的 `late`。
- 205→206 个测试（默认值、第 10 步触发、每轮一次、步边界）。

## 1.4.3

**速度随步数出现：长任务 1.49×（迟到介入 2.68×），正确性 16/16 与 12/12 全对。**

- 步数分桶（80 对 ABBA 语料）：**1–5 步 1.00×**（47 对）、**6–10 步 1.23×**（33 对，符号检验 p=0.035）、11 步以上无数据。`corr(输出 token 变化, 加速) = −0.77`——赢的那些对都是模型写得少，不是并发。
- 输出纪律单独 A/B（12 对，深 fixture）：输出 token **−15.4%**（未达预设 20% 门槛）、墙钟 1.13× 但只有 7/12 对更快（p=0.774）、正确性 **96/96 不变**。结论：单看它自己，与 ±30% 的任务内噪声分不开，不作为独立卖点。
- 新增长任务 fixture：从零实现 `ledger.py`（6 个函数、会计括号负数/货币符号/Decimal/ROUND_HALF_UP/并列取最小等边界），**隐藏 22 条断言**由 runner 事后执行。8 对 ABBA：off 215.2 s / 16.5 步 / 32 718 token → on 144.5 s / 10.5 步 / 24 274 token = **1.49×**、步数 **8/8 对下降**（p=0.008）、输出 **−25.8%**、**16/16 次运行 22/22 全对**。
- 对照：上一版“12 个 bug”的修复型 fixture 4–6 步就被做完，实测 **0.94×、输出 +11%**——它不是长任务，正好印证分桶：步数不够就没有可省的。
- 新增 `outputDiscipline: 'late'` 并**设为默认**：系统提示不再放文风规则（短任务零成本），第 4 步由调度器注入一次压缩提醒（`src/auto.js` 的 `compress-output`，每轮一次）。6 对 A/B：184.2 s → 68.6 s = **2.68×**、步数 10.5→7.5、输出 **−52%**、**12/12 次运行 22/22 全对**。`true` 仍可全程生效，`false` 关闭。
- 短任务对照（4–6 步 fixture，6 对）：late 13.5 s vs 关 17.6 s（中位 1.31×、配对中位 1.26×、4/6 对更快、步数不变）——在 ±30% 噪声内，可读作“短任务没有付出代价”，与“短任务不介入”的产品设想一致。
- 撤回旧说法：配置说明里的“每步输出 640→190 token、墙钟快约三分之一”从未被单独测过，已换成上面的实测数字。
- `src/auto.js`：新增 `notePolicy()` 与 `compress-output` 指令，`AUTO_LIMITS.disciplineAfterSteps = 4`，按轮重置 `disciplineSent`。
- 198→202 个测试（三档取值、每轮只提醒一次、新默认值）。

## 1.4.2

**量化并发，并撤回一个自己造出来的结论。**

- `shell_parallel` 改为**默认关闭**（`shellParallel: false`）。6 个 5 秒作业的 fixture 上三对 ABBA：原生 9.1 s vs 开工具 26.3 s（**0.35×**）。工具本身是并发的（5.1 s 跑完），但基线模型本来就用 `&` + `wait` 自并行，多出的工具诱发一次“再复核”的额外步骤。
- 提示段只在工具真的注册时才提 `shell_parallel`（`src/guidance.js` 拆出 `SHELL_JOBS`），避免指着不存在的工具。
- 新增 `guidance` 开关并**修好透传**：`resolveConfig` 之前没把它（和新加的 `shellParallel`）返回出去，导致一次 54 次运行的三臂实验实际上只有两臂配置相同。该实验降级为**噪声标定**：同配置在 n=6 下能给出 0.75× 与 1.01× 两种“效应” → 小任务每任务中位数噪声约 ±30%。此前“notext 1.01× / text 0.88×”的说法**作废**。
- 新增实测：4 个子代理各 `sleep 20`，整段跨度 **21 s**（串行 80 s，约 3.8×）——并发原语可用，瓶颈在模型是否拆活。
- 新增实测：把 4 个模块的真实分析交给子代理扇出，**0.25×**（中位 36.3 s vs 9.2 s，步数 5.5→28.5，输出 token 1.5 K→9.6 K）。并发是真的（4 个孩子的 llm 时间确实重叠），但每个子代理的固定成本在小任务上吃掉全部收益——扇出只在深子任务上有意义。
- 新增实测（pilot，2 对）：深子任务扇出仍 **0.60×**（中位 48.2 s vs 28.8 s，步数 12.5→43，输出 token 5.1 K→16.9 K），且两次里有一次 4 个模块全算错（串行两次全对）。会话取证：4 个子会话在 3 毫秒内同时创建，派发确实并行；亏在每个孩子要 15–25 步才做完一个模块，而串行 11–14 步做完全部四个。扇出到此结案。
- 196→198 个测试（提示段门控、工具默认值）。
- 新增人群统计，否掉“重复调用短路”：7168 次工具调用里严格重复 0.1%、宽松 4.4%，且都是 `ls`/`cat`/`python3 gen.py` 这类便宜或有状态的命令——省不到每步 0.5 s 的 TTFT，还会把有状态命令误当纯读。不做。

## 1.4.1

**诚实修正：扩大样本后 1.4.0 的 1.86× 被证伪，并修掉由此暴露的回归。**

- `src/shape.js`：新增 `PER_ITEM` 形状（`one object keyed by file` 这类逐项输出表）判**原生**。1.4.0 的“一次抓全”在这个形状上实测 **0.85×**（15 对）：八次读并成一步，但该步要一次解码整张表，输出 token 1069 → 1197。
- 实测扩样（76 对，ABBA，全部 PASS）：**中位 1.06×，CI 0.996–1.155×，45/76 对变快，均值 1.15×**。t1 0.85×→1.02×（修掉回归）、t3 1.77×→1.03×（15 对）、t9 写扇出 0.98×、t10 读写混合 1.11×。
- 结论写在 `BENCHMARK.md` 顶部：墙钟由输出 token 主导，只有“步数下降且单步输出不涨”的形状（shell 扇出）能稳定赚到 ~8%；t6/t8 的 1.4×/1.3× 仍只有 5 对，只能当方向。
- 181→185 个测试（新增逐项输出、聚合报告两个用例）。

## 1.4.0

**三步合并成一步：形状第一步就判、已知目标一次抓全、聚合用一条命令。**

- `src/guidance.js`：新增 GATHER 规则（已知目标必须进第一个块；>10 个目标或求聚合时改用一条 `rg -c` / `grep -r` / 只打印的短脚本；独立 shell 作业可以同块，不许写成 `&&` 长链）。
- `src/auto.js`：分类出的宽度**整轮保持**，不再只在第一步生效；同轮后续步骤不会因为上一次调用是写或单条 shell 就退回原生。
- `src/shape.js`：shell + 扇出（每个目录一个作业）判为宽；纯 shell、串行、聚合之外仍原生。
- 实测 43 对（8 任务，ABBA，120/120 PASS）：**中位加速比 1.09×（CI 1.03–1.33×），30/43 对变快**，平均步数 5.5 → 4.7；t1 1.86×、t3 1.77×、t6 1.43×、t8 1.29×，t2/t4/t7 为设计的无操作对照（约 1.0×）。
- 代价：输入 token 上升（抓全 + 聚合），输出 token 略降；单任务 5–8 对，方差仍大于单任务效应。

## 1.3.0

**第一步就知道该不该宽：形状从请求本身的措辞读出来，不再付探测费。**

- 新增 `src/shape.js`：一次正则遍历判断请求形状。串行词（chain / one by one / 依次 / 逐个 / 依赖链）→ 原生；shell 词（bash / python3 / 执行 / 运行）→ 原生（宽块在 shell 上本来就会串行化）；扇出词（independently / every file / across / per file / 每个 / 所有）或 ≥4 个被指名的目标 → 宽度 8；其余一律原生。
- 分类结果由 `noteEntry` 记入该轮，只被本轮第一步消费；同一轮后续步骤不能中途改判。
- 因此**新会话不再有 4 宽探测**：判不出形状的请求直接原生，和没装插件同宽；判得出扇出的请求第一步就宽。
- 试跑（8 任务 × 4 对 ABBA，32 对，64 次运行，质量 63/64，唯一失败在对照组）：中位加速比 1.08×（CI 0.88–1.21×），18/32 对变快；t1 从 0.78× 回到 1.16×、t4 从 0.71× 回到 1.20×，即“不再对非扇出任务下批处理指令”确实拿回了探测的成本。样本仍小，作为 pilot 而非结论。
- 新增 11 个形状测试（含中文扇出/串行、链式命名多文件的陷阱），全套 183 通过。

## 1.2.1

**把"独立读块"变成程序化判据，并且真的用 8 个任务量过一遍。**

- 调度器新增 `lastStepDistinct`：这一步所有调用都在 `SAFE_CALLS` 里，且参数签名两两不同，才算"独立读块"。两个调用读同一路径会被判成链而不是批，不进入宽模式。
- 新的一轮请求如果没有并行形状的历史，宽度直接是 1（原生、整段提示不渲染），不再每轮先付一次 4 宽的探测；只有会话历史里出现过独立读块或连续纯读才提速。
- 独立读块一旦出现（≥2 个调用）就立刻 → 8，不需要等第二步；单调用步骤即使只读也保持原生。
- 实测（8 任务 × 5 对 ABBA，80 次真实 headless 运行，质量 80/80，同模型同 `effort: medium`）：40 对合并中位加速比 0.96×（CI 0.80–1.14×），19/40 对变快；可并行形状 t2 1.14×、t5 1.14×、t6 1.28×，摘要/审计形状 t1 0.78×、t4 0.71×。**结论：没有普遍变快，收益集中在独立读。**
- 局限已写进 README：判据只能用"已经发生的调用"，单轮任务只看到新会话那一次 4 宽探测，形状证据来不及积累。下一步是把请求入口的形状（独立文件/目录数）也变成信号，并对宽度做在线选择。

## 1.2.0

**只在值得的地方提速。** 调度器不再固定给一个"快"的宽度，而是每一步先判断形状：只有证据表明这一步是"多个互不依赖的读"才要宽，其余保持原生（宽度 1 = 整段指导不渲染）。

- 新会话先用 4 做一次探测；连续两步纯读 → 8；上一步同块 ≥3 个读 → 8；跨轮记住上一轮末尾的宽读，下一轮开局直接 8。
- 出现写调用、单调用步骤、或连续 3 步无进展 / 连续 3 次报错 → 回到原生，不再要求批处理，也不再付这段提示的输入钱。
- 实测（4 任务 × 6 对 ABBA，同模型同 effort，质量 24/24）：可并行的 t2 墙钟 0.69×、输出 0.72×；t1 0.89×；t4 1.04×；无可并行形状的 t3 1.24×。24 对中位 0.96×，方差大于效应 —— 不发布单一加速比。
- 不新增配置项；旧 `auto` 含义保持不变，行为按上面的证据规则细化。

## 1.1.0

**只剩一个开关。** 闪电本身就是开/关：点一下开，再点一下关。196 px 的面板整个删除——没有弹层、没有下拉、没有第二层界面，也没有一件只有面板里才能做的事。

- `client.js`：删除 `FastPanel`、菜单开关逻辑、点击外部/Esc 关闭、`aria-haspopup`/`aria-expanded`、`data-open`、全部 `.fm-menu*` 样式与 `menu.*` 词条（941 → 716 行）。按钮保留 `aria-pressed` 与 tooltip；未就绪时先重读再切换，拒绝写入仍在 tooltip 说明原因。
- **说明搬进插件介绍**：`meta.description` 与配置项描述现在完整讲清“同强度、并行 2–8、压输出、卡顿上限、每会话独立、重启记得”，不再占输入区空间。
- **每会话记忆**：一次点击只写本会话在 `sessions` 列里的条目连同 `enabled`/`gear`；`settings` 服务把 volatile 配置原子写回 profile patch，所以重启、重开会话、切标签页都回到该会话自己的选择（例如 medium + fast）。
- 测试重写为 20 个直点开关的用例（单击即写、二次关闭、写出的三个字段里没有 effort、拒绝回滚、只读不写、字典无 `menu.*`、CSS 无 `.fm-menu`、按会话/重启恢复）。全套 168 通过。

## 1.0.1

**修复"每轮 30 步"实际变成"整段会话 30 步"。**

- `index.js` 现在在 `session/event` 的 `turn/start` 上调用 `noteTurn()`：每轮清零 `turnSteps`、`stepCalls`、`lastStepCalls`，并重新武装停止线；跨轮保留调度记忆（试过什么、卡了多久）。
- 修掉一个连带问题：`stop-and-report` 的去重原先按"上一次指令种类"跨轮生效，导致第二条长轮次永远不再触发。去重现在只依赖本轮的 `stopped` 标志，`turn/start` 会把它复位。
- 新增回归测试：一轮 30 步触发一次停止提示 → `turn/start` 后下一步不再立即停止 → 再走 30 步仍会触发。
- `docs/REFERENCE*.md` 中原先记录的"已知实现缺口"随之删除。

## 1.0.0

**Fast 模式从此不碰思考强度。** 0.9.x 之前它按档位改写 `reasoningEffort`，最高档甚至发 `off`——这是错的。用户选了多深的思考，就应该是多深；开启快模式改变的是往返次数，不是智力。1.0.0 把整条降档机制**删掉**（不是关掉、不是加开关），`agent/request` 钩子现在是纯透传：`return resolved`。

### 删掉了什么

- 整套 effort 策略：`floor`、`decideEffort`、每步降一档的阶梯、`ludicrous` 发 `reasoningEffort: 'off'`、以及所有按档位写死的 effort 表。配置里再写 `floor`/`ladder`/`aliases` 不会生效，源码里也不再有 `reasoningEffort:` 赋值（有一条测试扫描源码来守住这点）。
- 面板里的五档列表、速度/倍数估算、每档的等待上限表。它们展示的是已经不存在的选择。

### 现在靠什么变快

同样的思考强度、同样的模型、同样的供应商，只改三件事：

1. **更宽的工具并行**：一步里允许发多个互不依赖的调用，宽度 2–8 由调度器按最近几步的表现自动决定（默认 4，同一步内连续两步顺利后放宽，报错或卡住时收窄）。
2. **更少过程文字**：输出纪律只收叙述性文字，答案本身一个字不删。
3. **更少的卡顿**：前台命令有可取消的上限（`auto` 下 120 s 起、按最近 p90 实际延迟在 2–5 分钟自适应；`safe` 不限），卡住会取消并把"换个做法"写回给模型；另有 6 步无进展告警、12 步停止、每轮 30 步后不再放宽的循环保护。

代价是 token 可能更多（并行调用、一次读多处），这是明确的交易：**用 token 换墙钟时间，不用智力换**。

### 面板与档位

- 闪电点开只有一个开关、一行调度状态（引用的上限从配置里读，不再写死）、两行说明。196 px 不变，仍然跟着会话走。
- `gear` 对外只剩 `auto` 有意义；旧配置里的 `fast`/`turbo`/`max`/`ludicrous` 会被当作 `auto` 并打一条弃用日志，而不是静默降思考强度。`safe` 保留为实验对照臂（固定并行 2、不设上限、不注入提示）。
- 升级后不会再有"每次进来思考强度都变了"：胶囊显示的是你自己选的档，重启也一样。

### 保留

- 0.9.1 的 v4 会话格式修复（`kind: 'plugin:fast-mode'`）与回归测试。
- 每会话开关、指标日志、报告与实验 CLI、压缩类插件共存、与 `dsh-batch-tool-calls`/`dsh-ops` 的互斥声明。

## 0.9.1

**Upgrade if you installed 0.9.0.** Its post-compaction reminder could fail a
whole turn. Nothing else changed.

- **The fix.** The two notices were built with `source: { kind: 'plugin', plugin: 'fast-mode' }`,
  the pre-v4 shape. DSH's v4 session encoder refuses that pair —
  `SessionFormatError: format v4 message requires a producer-owned source kind`
  (`@deepseek-ai/dsh-session-format-v3-to-v4`, `assertV4MessageSources`) — and it
  refuses it while persisting the event, outside the `agent/pre-step` handler
  that built the message, so the failure landed on the turn rather than on the
  notice. A conversation that compacted and then resumed died at the first step
  after the checkpoint. The source is now `{ kind: 'plugin:fast-mode' }`, which is
  also the kind v3→v4 migration derives for rows written by older versions, so
  old transcripts read back under one shape.
- **Why it cannot come back quietly.** `createNoticeMessage` now validates its
  source against the mirrored v4 rule before returning, and throws *there* — the
  caller's `try/catch` then drops the notice and the step proceeds, which is the
  failure mode this plugin is allowed to have. `isProducerOwnedSource` mirrors
  the encoder's rule, and `test/notices.test.js` pins it: the retired
  `{ kind: 'plugin', plugin }` shape must be refused, `plugin:fast-mode` accepted,
  no leftover `plugin` field. Verified against the released codec extracted from
  `app.asar`: both notices encode, both retired shapes throw the exact error above.
- **Existing sessions are unaffected.** The bad row was only ever written by the
  v4 encoder, which refused it, so nothing was persisted. v0-format sessions under
  `--private-tmp--` that still carry `kind: "plugin"` rows go through the
  documented v3→v4 migration, which rewrites them to `plugin:<name>`.

## 0.9.0

Tool wait is the third lever, and the panel stops claiming measurements it never
made.

- **A stall guard bounds one tool call.** `tools/execute` now races a guarded
  shell-style call (`bash`, `script`, `monitor`, `pwsh`…) against a per-gear
  budget: 300 / 180 / 120 / 90 s for Cruise / Sport / Track / Redline, and no
  watch at all on Eco. On expiry the plugin aborts *its own* controller — never
  the caller's signal, which the registry re-fuses anyway — gives the tool 250 ms
  to unwind, restores the caller's signal, and returns a `ToolExecutionFailure`
  telling the model to move the work to `run_in_background`, pass a `script_path`
  instead of a heredoc, narrow the probe, and never re-issue the same command
  unchanged. Waiting tools (`ask_user_question`, `wait_agent`, `job_output`,
  `job_list`, `task_board_run`, `workflow`, `subagent`, `subagent_fork`) and the
  file tools are exempt. The ceiling is a **policy budget, not a measurement**;
  `stallGuard: false` or `toolTimeoutMs: -1` disables it, `toolTimeoutMs: 90000`
  applies one number to every gear.
- **The prompt half ships with it.** Four rules joined the execution-speed
  section: bound any command that can hang, prefer `run_in_background`, write
  long/quoted/multi-line commands to a file instead of a heredoc, and change the
  command before retrying one that was cancelled or came back malformed.
- **`dsh-batch-tool-calls` and `dsh-ops` must not be enabled together with it.**
  The batch plugin is a static, gear-blind subset of this guidance; the ops plugin
  adds two shells plus Windows-only binaries and conflicting timeout advice. The
  host reads the profile's dependency files once on load (and probes for live
  `ops_*` tools); if either is present it logs one warning and appends one notice
  to the next step, then goes quiet. It never hard-fails the user. Both reference
  manuals document the conflict.
- **The panel says "estimate", and shows the one number that is not.** The footer
  now reads `倍率预估 · 单次调用 ≤ 3 分` instead of `倍率 = 相对 Eco 的实测中位数`:
  our own runs do not support a per-gear speed or token ratio — on single-file
  tasks every enabled gear lands within noise of `safe` — so the multipliers are
  labelled as estimates while the stall ceiling is quoted straight from the
  host-side table for the selected gear.
- **The five gears have names now: Eco / Cruise / Sport / Track / Redline.** The
  ids are unchanged (`safe` / `fast` / `turbo` / `max` / `ludicrous`), so existing
  patches, settings and experiment files keep working — only the labels moved.
- **The gear menu labels its own columns.** The 0.8.0 popover printed
  `1.6x · 1.5x` with no header, so nothing said which number was the speed and
  which was the token cost. A `Gear / speed / token` header row now shares one
  CSS grid with the five gear rows: the numbers sit under their labels, right
  aligned in tabular figures, in both locales. Each row's `aria-label` names the
  columns too, so the pair is not opaque to a screen reader either.
- **The fine print wraps instead of running off the edge.** The old single line
  (`倍率预估：速度 · token * 关闭思考，质量会下降`) was `white-space: nowrap`
  inside a 196 px popover and got clipped mid-sentence. It is two short lines in
  a footer above a hairline now — the estimate note (which also carries the
  selected gear's stall ceiling) and the warning — and both wrap.
- **README: 484 lines to 98.** The front page keeps the principle, the measured
  table, thirty-second setup, the five gears, the coexistence rules and what is
  next, one short paragraph each. Configuration, logging, measurement instruments,
  experiment methodology, safety boundary, limits and the test guide moved to
  `docs/REFERENCE.md`. The result table states the honest part in the open:
  turbo is 537 ms slower and 5 % fatter per step — it wins on step count.

198 tests, green. `test/stallguard.test.js` (12) covers the budget table, the
signal dance, the failure text, the frozen notice messages and the peer scan;
`test/plugin.test.js` adds the wiring cases (registration, a hung `bash`
cancelled at `toolTimeoutMs: 20`, passthrough, the post-compaction reminder);
one `test/client.test.js` case pins the footer to the host-side budget table so
the two halves cannot drift.

## 0.8.0

Everything up to 0.7.0 optimised effort, and Experiment E showed effort is not the
lever on a self-hosted route: raising it does not shorten a session. What does
shorten a session is fewer round trips and less visible text. 0.8.0 pulls both,
and it measures the result instead of asserting it.

- **The execution-speed guidance is one system-prompt section, not a rewritten
  prompt.** `fast-mode:execution-speed` at order 520 states the batching rules,
  the gear's parallel target, the speculative-prefetch line and the
  output-discipline layers. It is injected only for gears marked `directive`, so
  `safe` injects nothing at all — it stays the pre-0.8.0 behaviour and works as
  the control arm.
- **Output discipline is the largest single lever.** `outputDiscipline` (default
  `true`, not volatile, so changing it needs a reload) tells the model not to
  narrate around tool calls, not to restate file contents, and not to write
  end-of-step progress reports. Measured: per-step output **640 → 190 tokens**.
- **Gears gain a `parallel` target and a `discipline` level**: safe 2 / fast 4 /
  turbo 6 / max 8 / ludicrous 8 per step; safe injects no discipline, fast gets
  the light version (three prohibitions), turbo and above the full version plus
  speculative prefetch. An explicit `parallel` overrides the target — `gear:
  turbo` + `parallel: 8` fits two more independent calls into the same round
  trip and never adds a step.
- **A warning when the profile caps the target.** If `agentLoop.maxParallelToolCalls`
  sits below what the gear asks for, one warn names the cap and the line to
  change in `cordis.patch.yml`; it fires once per distinct `parallel` value, not
  once per request.
- **Measurement: `bin/experiment.mjs`, and Experiment E.** 16 same-task sessions
  assigned by hash rather than clicked, `safe` vs `turbo`: median Σ step time
  25.9 s → 15.6 s (−40 %), median steps 7.5 → 4.5, per-session output tokens
  3,798 → 2,180 (−43 %), Mann–Whitney p = 0.008, and all ten answer facts agreed.
  Raw data and the caveats (uneven arms, small n) are in BENCHMARK.md.
- **The trade, stated plainly**: this plugin does not save tokens; it spends
  tokens to buy time. Every lever here adds tokens to the same route's request,
  and none of them works by making the model dumber.

173 tests (8 new in `test/guidance.test.js`); the suite is green.

## 0.7.0

Fast mode was a global switch wearing a per-conversation costume: the bolt sits in
one composer, so clicking it read as "this conversation", and it changed every
conversation in the app. Two sessions side by side, one clicked, both accelerated —
and nothing in the UI said so.

- **The switch and the gear are per conversation now.** A click writes that
  conversation's own `{enabled, gear}` entry; the panel says `仅本会话生效` /
  `This conversation only` under the switch, so the scope is stated where the
  decision is made instead of being inferred.
- **A conversation with no entry inherits the shared pair**, which doubles as the
  record of the last choice made anywhere. A brand-new conversation therefore
  starts from the last selection rather than from the schema default — the
  behaviour asked for, and the reason the shared fields still exist.
- **Precedence is explicit**: experiment assignment > that conversation's entry >
  shared default. An assigned trial still outranks the UI, because a click that
  quietly overrode the arm would empty the control group of the very trial the
  user asked for.
- **One click, one patch.** The shared `enabled` / `gear` and the `sessions` entry
  travel in a single `settings/update` carrying the revision that was read. Two
  writes would mean a window where the panel shows one gear and the request runs
  on another, plus a second revision race; a refused write rolls back all three
  fields and states the reason in the panel.
- **The column is bounded and forgiving.** `sessions` holds at most 200 entries,
  oldest pruned first by `ts` (a pruned conversation just falls back to the
  shared default). A hand-edited or truncated value degrades to "no overrides"
  and never takes the chip down.
- **The two copies of the format are tested against each other.** The host reads
  the column (`src/state.js`), the browser half writes it (`client.js`), and a
  drift between them is a switch that looks on and changes nothing — so the
  shipped `client.js` is loaded in a `vm` and fed the same fixtures as the host
  module. Writing the test found one real drift (the browser copy accepted an
  empty session id the host drops), which is now fixed on both sides.
- The conversation id reaches the client half through the slot's own scoped
  `inject(sessionId)`; the chip also accepts a standard `sessionId` prop, so a
  release that stops injecting one spelling still behaves.
- One caveat, stated where a user will hit it: `sessions` renders as a text input
  on the plugin settings page, because this build of schemastery has no
  `.hidden()`. Its description says it is maintained automatically; editing it by
  hand is how a conversation ends up running a gear nobody chose.

165 tests.

## 0.6.2

The measurement was wrong in the one way that matters most: it counted time but
not tokens, and it lost which step each row belonged to.

- **Read the event payload where it is.** `session/event` carries its payload in
  `event.data` (`{turn, step, usage, …}`); the recorder was reading `event.turn`
  and `event.usage` off the envelope, so every row from 0.6.0 and 0.6.1 had
  `turn`/`step` missing and `input`/`output` at zero while timings looked fine.
  Rows now carry step numbers and real token counts, and both the harness
  spelling (`inputTokens`, `reasoningTokens`, `cacheReadTokens`) and the gateway
  spelling (`uncachedInputTokens`, `thoughtTokens`, `cachedReadTokens`) are
  folded.
- Two regression tests feed the wrapped shape, so this cannot come back quietly.
- Rows already written to `~/.dsh/fast-mode-metrics.jsonl` keep their zeros;
  delete the file or filter by `ts` when comparing against new data.

147 tests.

## 0.6.1

0.6.0 could compare gears, but not against the thing they are supposed to beat.
An assignment always switched the mode on, so a randomized trial had no baseline:
the only "off" sessions were ones somebody happened to run before starting the
experiment, which is not an arm — it is a convenience sample.

- **`"off"` is a legal arm.** The assignment file and
  `dsh-fast-mode-experiment --gears` now accept `off`, meaning the control group:
  the session runs with the plugin switched off **because the experiment said so**,
  not because a switch was left alone. `off` is always accepted even when the
  options do not list it, and the CLI now defaults to
  `off,safe,fast,turbo,max`, so a fresh `start` is a controlled trial rather than
  a ranking. `start` says which kind of run it wrote: with `off` it promises a
  baseline, without it it warns that the report can only rank arms against each
  other.
- **The control arm is deliberately invisible to the switch.** A session assigned
  to `off` returns the request untouched even when the global switch is on — the
  one place where the UI can disagree with what a session actually does, which
  the experiment output and both READMEs now state plainly.
- Also lands in this release: `bin/experiment.mjs` is documented and exposed as
  the `dsh-fast-mode-experiment` bin with an npm script, and `--lan` follows
  `--since` into the dashboard's own `1d`/`7d`/`30d` window (default `7d`) rather
  than always asking for one day and quietly printing nothing.

145 tests.

## 0.6.0

0.5.2 made the switch work. 0.6.0 makes the claim checkable: fast mode measures
itself, assigns gears to sessions for comparison, and reports the result from a
terminal. It also adds one gear above `max`, because on the official route that
is the only honest way past the 2× ceiling.

- **Measurement is built in and on by default.** A `session/event` tap folds
  every step into `~/.dsh/fast-mode-metrics.jsonl`, one JSON line per completed
  step, for sessions with the switch **off** as well as on — a comparison needs
  both sides, and nobody remembers to enable measurement before an A/B. A row
  carries `v, ts, sid, turn, step, mode` (`on|off|unknown`), `gear` (or `off`),
  `effort`, `route`, `ttftMs` (step start → first assistant message), `llmMs`
  (step start → last assistant message), `stepMs` (the whole step), `calls`,
  `errors`, `input`, `output`, `reasoning`, `cacheRead`, `cacheWrite` and
  `assistantMessages`. `metrics: false` disables it; a write failure is
  swallowed and never fails a request.
- **Experiment assignment without a UI.** An optional
  `~/.dsh/fast-mode-bench.json` (`benchmarkFile`) assigns gears per session:
  `{"enabled": true, "gears": ["safe","fast","turbo","max"], "sessions": {"<session id>": "turbo"}}`.
  An explicit pin wins; otherwise the gear is `FNV-1a(session id) mod gears`.
  The file is re-read on a 1 s TTL, so an edit applies to the next request, and
  deleting it returns control to the configured switch. A session an experiment
  assigns runs on that assignment even with the switch off — letting a forgotten
  click decide the arm would silently put the session in the control group.
  Unknown gear names are dropped with one warning.
- **The experiment has a command, not a JSON file you edit by hand.**
  `bin/experiment.mjs` (package bin `dsh-fast-mode-experiment`) writes the
  assignment file, reports how many sessions and steps each arm has collected so
  far (`status`, including whether a disabled-state sample exists at all), and
  refuses to overwrite a running experiment without `--force`. An experiment is
  what makes the numbers trustworthy: the arm is chosen by the session-id hash,
  not by whoever wants the better result.
- **A report command instead of a spreadsheet.** `bin/report.mjs`
  (package bin `dsh-fast-mode-report`) reads the JSONL and prints a per-stance
  table plus a speedup table against the `off` baseline. The unit is the step;
  session wall clock is not used, because it mostly measures the human. Flags:
  `--file`, `--since 2d|12h|90m`, `--json`, `--lan`, `--help`. `--lan` joins
  local rows to the self-hosted usage dashboard by session UUID using
  `USAGE_TOKEN` (optional `USAGE_BASE`): read-only, nothing leaves the LAN, and
  the token is never printed. The dashboard's own window (`1d`/`7d`/`30d`)
  follows `--since` instead of always asking for one day. An unreachable,
  slow or unauthorised dashboard degrades to one note; it never costs you the
  local report.
- **New gear `ludicrous` (极速), above `max`.** It is the only gear whose floor
  is `off`, i.e. it may set `reasoningEffort: 'off'`, with a fan-out target of 8
  and `deepAfter: 1`. That is not "a bit faster than max": the official route
  declares `off/low/high/max`, so with thinking on the only legal cut is
  `high → low` (≈2×) and 3–4× requires turning thinking off, which this gear
  does. The panel therefore marks it `极速*` / `Ludicrous*` and the footer says
  `* 关闭思考，质量会下降`. The plugin still never emits an id the route does
  not declare — on a route without `off`, the gear degrades to what the ladder
  offers.
- **The chip is one bolt, and the panel is behind it.** The caret and its inline
  dropdown are gone. Clicking the bolt opens a panel holding the on/off switch,
  the five gear rows (each with its estimated multipliers, the current one
  marked) and the fine print, plus a status line that states the reason when a
  write is refused. Clicking does not toggle; picking a gear while fast mode is
  off still arms `enabled` in the same write.
- **The gear is a name.** `gear` is a schema union of
  `safe/fast/turbo/max/ludicrous`; a number or a typo is a load-time error, as
  `src/config.js` already documented. The policy layer still normalises
  defensively, so a bad value can never become "unlimited", but it no longer
  silently becomes `safe` either.
- **Measurement paths are composition knobs.** `metricsFile` and
  `benchmarkFile` are deliberately not `.volatile()`: they are read at load and
  do not belong on a live form. Moving the JSONL is a `cordis.patch.yml` edit.

Tests 142: the measurement tap proves off sessions are measured too (one row per
step, first-token vs last-message latency in a multi-message step, token and
error sums, per-session isolation, a missing directory created on first write,
an empty path disabling the sink); the assignment proves a stable hash that
covers every gear, an explicit pin, a single-session pin, a live 1 s re-read,
inertness without a file or with `enabled: false`, and one complaint for a
broken file; the report proves both tables, a one-sided refusal in words,
`--since` including the wider dashboard window, `--json`, `--help` reading no
file, `--lan` without a token and with one (the token is never printed), and an
unreachable dashboard degrading to a note; the client proves the contract after
the caret removal — one icon, clicking opens the panel and writes nothing by
itself, the switch writes once and a second click turns it back off, five rows
with estimates and an asterisk on `ludicrous`, and picking a gear while already
on leaves the toggle alone; and the schema proves an unknown gear name is a
load-time error, measurement is on by default, and exactly
`enabled`/`gear`/`parallel` are volatile.

## 0.5.2

0.5.1 shipped the switch but left it inert, and the reason was one wrong field
access:

- **The remote protocol wraps every answer in `{ ok, value }`.** The chip read
  `remote.settings.describe().namespaces` straight off the envelope, so it always
  got `undefined`, classified this plugin as "not configured", and rendered a
  `disabled` button. Chrome suppresses `title` on a disabled button, so hovering
  said nothing, and the click handler's guard swallowed every click — a control
  that was fully explained inside the code and completely dead on screen.
  `unwrap()` now handles the envelope (and a bare payload, so a service stub
  still works), `ok: false` surfaces `error.message`, and every remote call has a
  deadline so a pending bridge becomes a visible error instead of an endless
  "loading".
- **The chip is never disabled.** Read-only, unknown and missing-namespace states
  all stay clickable and open the menu with the reason in words.
- **The gear lives on the chip.** The caret opens a dropdown listing the four
  gears, each row showing its estimated speed and token multiplier
  (`速度 ~1.6× · token ~1.5×`) and marking the current one. Picking a gear while
  fast mode is off turns it on in the same write. There is deliberately no gear
  form on the plugin page: this harness renders no generic schema form, so one
  working entry point beats a second half-working one.
- **Host-side traceability.** With `debug` on, `apply` writes one line per load
  before the `enabled` check (`apply v0.5.2 entered enabled=… gear=…`), then one
  more saying it registered nothing; after two seconds it also reports whether
  `settings.describe()` actually serves this namespace. A future "the chip does
  nothing" report is now one log line away from an answer.

Tests 89: the client suite runs the real bundle against the real wire envelope,
including the bare-payload tolerance, the refused write, the read-only chip, the
missing namespace, and the gear multipliers.

## 0.5.1

0.5.0 shipped a settings switch that could not be switched. Two defects, both
about how the `settings` service treats a schema field:

- **The three form fields were not `.volatile()`.** `settings.describe()` projects
  a Config through `volatileForm`, which keeps only nodes carrying
  `meta.volatile`; with none, the whole entry disappeared from the form — so
  there was no settings page, the composer chip read it as "absent" and stayed
  greyed out, and `settings.update()` would have refused the write with
  `Config field "enabled" is not volatile`. `enabled`, `gear` and `parallel` are
  now declared volatile, which is also what lets an edit land on a running fiber
  without remounting the plugin.
- **A volatile field is a reference, not a value.** The Loader hands a running
  plugin a frozen `{get()}` reference so it can swap the value in place;
  `config.enabled === true` would therefore have been false with the switch on.
  `resolveConfig` now dereferences at that single boundary (and still accepts a
  plain config object), and the module documents the protocol.

Tests 80: the schema now has to prove every form field is volatile, and that a
reference from the Loader reads as an armed switch.

## 0.5.0

Fast mode becomes something you switch, not something an install decides for you.

- **Opt-in.** `enabled` now defaults to `false`, and `apply()` registers nothing —
  no hooks, no prompt section, no discovery — until something sets it to `true`.
  Only a literal `true` arms it; `1` or `"yes"` do not.
- **A lightning switch in the composer.** New client half (`client.js`, served
  through `dsh.client`) registers on `conversation.input.activity`, beside the
  model selector: hollow bolt = off, filled black = on, the tooltip carries the
  gear and the reason when it is not clickable. It reads and writes the plugin's
  own `enabled` through `remote.settings.describe()` / `update()`, so the chip,
  the generated Settings page, and `cordis.patch.yml` are three views of one
  field. Clicks are optimistic and then verified by polling `describe()`; a failed
  write reverts the icon and surfaces the error in the tooltip. A registration
  taken by another plugin, an unreadable document, or a read-only layer degrades
  to a disabled chip, never to an error thrown into the composer.
- **A config schema.** `Config` (schemastery) declares only the three fields a
  form should show — `enabled`, `gear`, `parallel`. Undeclared patch-level keys
  (`floor`, `holdTools`, `debug`, …) pass through untouched, so existing
  compositions keep working.
- **One dependency.** `@deepseek-ai/schemastery` (`~3.18.5`), which every shipped
  DSH plugin that exposes a settings page already declares; the profile already
  has it hoisted, so this adds no new runtime.
- **Tests.** 78 (up from 64): the default-off contract, non-boolean configs not
  arming the policy, real schemastery validation of the schema (`gear: warp`
  fails loudly, unknown keys survive), the client-half manifest contract
  (`dsh.client.platform`, `exports["./client"]`, packed `client.js`, bundle id,
  and the slot being the one that never shadows the model selector), and eight
  tests that run the shipped `client.js` verbatim in a `vm` sandbox with a stub
  `__ModuleLoader__` and a fake `settings` remote — proving the bundle parses,
  declares its loader contract, paints hollow when off and filled when on, sends
  exactly one `settings/update` with the revision it read, rolls back and explains
  itself when that write is refused, and never renders a clickable chip over a
  read-only layer or an absent entry.

## 0.4.0

Speed becomes a stance, not a single threshold, and the plugin now installs itself ON.

- **Gears.** `gear: 1..4` (`safe` / `fast` / `turbo` / `max`) selects a coherent
  stance: how early a clean streak earns the second effort notch (`deepAfter`
  6/4/3/2), how many observations count (`window` 8/6/5/4), and how many
  independent calls the model is asked to batch per step (none/4/6/8).
  `fast` is the shipped default; `safe` is byte-for-byte 0.3.0 behaviour.
- **An explicit fan-out directive.** Gears 2–4 register a short system-prompt
  section (`fast-mode:execution-speed`, order 520) that tells the model to batch
  independent calls. The number in the text follows the gear, or `parallel`.
- **A loud cap warning.** If `agentLoop.maxParallelToolCalls` is below the gear's
  target, the plugin logs the exact `cordis.patch.yml` line that raises it, once.
- **Display metadata.** `icon.png` at the package root (PNG, 11,607 bytes) plus
  `locale/zh.json` and `locale/en.json` with `meta.title` / `meta.description`, so
  the Plugin Manager and Settings show a real icon and localized copy.
- **Docs.** Chinese README is now the default, English moved to `README.en.md`,
  and both document the gears, the parallel lever, official-API support, and how
  to compose with context-compression plugins.
- **Tests.** 64 (up from 55), including the manifest checks (icon size and type,
  locale metadata, `files[]` completeness) and the guidance registration path.

## 0.3.0

- Discover the route's real effort ladder through `llm.resolveModelInfo()` instead
  of assuming a vocabulary; never emit a level the route did not declare.
- Explicit `ladder`, documented-alias folding, per-route startup logging, and a
  `route=` field in the debug line.
- `holdTools` keeps full thinking after context-management tools, which look
  "clean" from the outside while being anything but.

## 0.2.0

- Observe `tools/pre-execute` / `tools/post-execute` for struggle signals (error,
  slow call, oversized result, repeated identical call) and lower the effort only
  while the streak stays clean.

## 0.1.0

- First working cut: per-request reasoning-effort adjustment for DSH, zero
  dependencies, no session writes.
