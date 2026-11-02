# 量一量 fast mode 到底快不快

这份文档给的是**方法**，不是结论。同一份代码在不同机器、不同任务上的结果会不一样，所以这里
只提供一件东西：一个能在你自己的机器、你自己的任务上跑出数字的工具，以及读这些数字的规则。
工具是 [`audit/run.mjs`](../audit/run.mjs)，样例清单是
[`audit/tasks.example.jsonl`](../audit/tasks.example.jsonl)。

## 它改的是什么（也是它为什么不总是有用）

fast mode 只在**写给模型的那段话**上动手：先给结论、别复述任务、少讲过程、别把工具输出再抄一遍。
它不改模型、不改推理档位、不改请求体，也不改工具的执行方式。所以可能省下来的只有一类东西——
**模型自己产出的 token**；而这些 token 又串行地决定解码时间。链条是：

    提示词更短 → 输出更短 → 解码更少 → 这一次的墙钟更少

链条上任何一环不成立，收益就不出现：

- 任务的大头是读文件、跑测试、装依赖、等网络——这些时间里模型不在说话，fast mode 碰不到。
- 任务本来就需要完整输出（导出数据、生成代码、长清单）——省不了，甚至因为"别复述"的约束而返工。
- 模型侧排队、限流、缓存冷热——这些噪声比效应大，单次比较读不出任何东西。

所以这个工具默认就假定**你不该相信单次结果**，它只给配对比值和区间。

## 怎么跑

先看它到底会执行什么（什么都不跑，只展开命令行）：

    node audit/run.mjs --dry-run --cwd . --tasks audit/tasks.example.jsonl

真跑（默认每个任务每臂 3 轮，共 5 个任务 → 30 次调用）：

    node audit/run.mjs --cwd . --tasks audit/tasks.example.jsonl

产物落在 `audit-out/<时间戳>/`：`pairs.jsonl`（每次调用的原始读数，一行一对）和
`report.md`（人看的表格 + 结论）。

`--cwd` 必须是 `check` 命令能跑的那个仓库；`check` 是每次调用**之后**执行的一条 shell 命令，
退出码 0 记为通过。它守的是"这次跑没跑成/仓库有没有被写坏"，不是给答案打分——模型答得好不好
不在这份工量具的判据里。

常用开关：

    --rounds 5              每臂轮数（配对不足 6 对时报告会明写"样本不足，不做结论"）
    --profile bench         用哪个 profile（必须装了 dsh-fast-mode；见下）
    --dsh-bin <path>        换 launcher；默认是探测到的那一个
    --arm-style override    强制覆盖形式（auto 会先 --dump-config 判断）
    --arm-style none        两臂同命令：量的是噪声底，不是加速
    --on-config k=v         给 on 臂多开一个配置项，可重复（见下）
    --metrics-file <path>   换 metrics jsonl（默认 ~/.dsh/fast-mode-metrics.jsonl）
    --timeout-ms 900000     单次调用上限

## 两个臂怎么造出来

两个臂加载的是**同一个**插件包，只差 `config.enabled`。每次调用都带一份 `--patch` 覆盖：

    # arm-off.patch.yml            # arm-on.patch.yml
    - id: fast-mode                - id: fast-mode
      config:                        config:
        enabled: false                 enabled: true
        gear: auto                     gear: auto

`--on-config` 只写进 on 臂，所以一次跑一个开关组合：

    # 只量压缩：on = 开启 + compactResults
    node audit/run.mjs --tasks tasks.jsonl --cwd . --profile bench \
      --on-config compactResults=true --on-config compactMaxChars=4000

    # 量"省 token"和"改齿轮"一起开：两个都没动 off 臂，比值仍是同一基线
    node audit/run.mjs --tasks tasks.jsonl --cwd . --profile bench \
      --on-config compactResults=true --on-config gear=fast

两个都开是本机实测过的组合（见下「本机实测」），结论是分不开；`gear` 写别的值同样能跑，
但没量过就别在文档里当成结论。`enabled` 和 `gear` 这类基础键由 `--on-config` **覆盖**，
不是追加——1.7.11 之前会写出两行 `gear:`，严格解析器直接报错（on 臂每次 70 毫秒就失败，
报告里看着像"快得离谱"）。

值的写法保持类型：`true`/`false` 是布尔、纯数字是数字、其余按字符串。写错键名会在启动前报
`--on-config 的键名不合法`，不会跑完一轮才发现 on 臂其实用的默认值。

`--arm-style auto`（默认）先用 `dsh --profile <p> --dump-config` 看这个 profile 里
有没有 `- id: fast-mode`：有就走 override，没有就走 insert。这一步不能省，因为两种错法都不响：

- 该 override 却 insert：dump 里出现两条 fast-mode，后一条赢，两臂可能都在同一个开关上。
- 该 insert 却 override：覆盖没命中任何条目 → 什么都没变 → 两臂完全相同。
- 两种情况都会得到"比值接近 1.0"的漂亮报告，但那不是结论，是没做实验。

真跑遇到 profile 探不通（例如 `profile "desktop" is managed exclusively by the Electron
application`）或里面压根没有 fast-mode 条目，工具会直接停下并说明该换什么，不会继续跑出一个假报告。

## 两个指标，一种读法

**墙钟**：`process.hrtime.bigint()` 包住子进程，从 spawn 到退出。**输出 token**：优先取 CLI
`--json` 事件里 `step_end.usage.outputTokens` 的累加；没有就按本次 `session` 事件的
`sessionId` 去 metrics jsonl 里过滤求和；两者都没有就写 `N/A`，不做任何估算——估算混进测量
里，报告就失去意义。

统计口径：

- 每对的比值 = on / off，多个任务/多轮取**几何均值**（时间比值相乘取平均，不能算术平均）。
- 区间用**配对 bootstrap**：4000 次有放回重采样，取 2.5 / 97.5 分位，固定种子 → 重跑结果一致。
- 区间整体 < 1 才算变快，整体 > 1 算变慢，跨 1 一律写"无法区分"。
- 配对数 < 6 时不看区间，直接写"样本不足，不做结论"。少于 6 对时 bootstrap 区间会窄得不像话。

## 该说"没有加速"的时候

下面每一条都够格写进报告，而不是含糊过去：

- 区间跨 1，或中心值离 1 不到几个百分点（本机噪声常在 5% 上下）。
- 任务大头是工具执行，输出本来就短。
- `--arm-style none` 的噪声底跑出来，区间宽度和"加速"差不多——那说明测到的就是噪声。
- 任务清单里有任务每次都失败（检查项没通过）——失败重试的耗时是另一种东西。

说"变慢"也一样直接。fast mode 的约束（先给结论、别复述）在需要完整输出的任务上会真的让人
多花一轮，报告里出现 > 1 的区间是正常结果，不是工具坏了。

## 已知限制（含本机未验证的点）

- **凭据**：本机这个 shell 直接跑真调用会失败在 `MISSING_CREDENTIAL: llm-pi-ai: no credential
  for provider route "company"`；补上 `COMPANY_LLM_TOKEN` 后才能跑（下面「本机实测」就是这么跑
  的）。跑到凭据失败时工具会让你看见 `turn_end.reason.error.code`，不会把它算成一次测量。
- **profile**：`headless` 的 node_modules 里没有 dsh-fast-mode，在那儿做 A/B 两臂都关着；
  `desktop` 由 Electron 独占，dump 不了。默认值 `bench` 是实测能 dump、且 `--patch` 真能把
  `enabled` 从 false 翻到 true 的那个（证据写在 `DETECTED.evidence`）。
- **顺序**：必须串行跑。并行跑会让两臂互相抢 CPU 和模型侧并发额度，测出来的差异是调度差异。
- **缓存**：同一台机器上多轮之间模型侧缓存会变热，配对设计只能抵消一部分，所以样本量比单次
  精度重要。
- 墙钟包含进程启动（约几百毫秒）。要更纯的对比得看 token 那一列，或者把 `--rounds` 加大让固定
  开销摊薄。

## 本机实测（可复核的原始数字）

同一台机器、`--profile bench`、串行跑、配对 bootstrap 4000 次、种子 20261102；任务是
`audit/tasks.example.jsonl` 的 5 个（list-files / read-package / grep-geomean / run-tests /
explain-config），目标仓库就是本仓库。

| 日期 | on 臂比 off 臂多了什么 | 任务×轮 | 合池墙钟 | 合池输出 token | 校验 off/on |
| --- | --- | --- | --- | --- | --- |
| 2026-11-02 | 只有 `enabled: true`（`gear: auto`） | 5×3 | **0.781×** [0.656, 0.923]，省 21.9% | **0.667×** [0.547, 0.806]，省 33.3% | 12/12 / 12/12 |
| 2026-11-03 | 只有 `enabled: true`，样本加到 6 轮 | 5×6 | **0.787×** [0.671, 0.928]，省 21.3% | 0.901× [0.751, 1.097]，分不开 | 24/24 / 24/24 |
| 2026-11-03 | 再加 `compactResults=true, compactMaxChars=4000` | 5×3 | 0.900× [0.732, 1.152]，分不开 | 0.967× [0.766, 1.282]，分不开 | 12/12 / 12/12 |
| 2026-11-03 | 再加 `gear=fast`（两个开关一起开） | 5×3 | 0.858× [0.640, 1.140]，分不开 | 0.858× [0.643, 1.136]，分不开 | 12/12 / 12/12 |
| 2026-11-03 | 同一组合（`compactResults` + `gear=fast`），样本加到 6 轮 | 5×6 | 0.867× [0.745, 1.005]，分不开 | 0.934× [0.775, 1.138]，分不开 | 24/24 / 24/24 |
| 2026-11-03 | 再加 `gear=aggressive`（开到最猛） | 5×3 | 0.980× [0.833, 1.141]，分不开 | 1.085× [0.872, 1.309]，甚至略多 | 12/12 / 12/12 |
| 2026-11-03 | 两臂完全相同（`--arm-style none`，噪声地板） | 5×3 | 0.940× [0.726, 1.192] | 0.913× [0.667, 1.229] | 12/12 / 12/12 |

6 轮那行是目前最硬的一条：30 对，墙钟区间整体落在 1 以下。同一批数据里也有两处真的变慢/变多，
照写不误：`run-tests` 1.198× [1.046, 1.421]（工具本身占大头，被要求先给结论时反而多绕一圈）、
`list-files` 输出 token 1.285× [1.026, 1.583]（不是每个任务都省 token，合池之后才落回噪声）。

最后一行是同条件下**什么都不改**的两个臂：区间一样宽、一样跨过 1。上面三行的区间宽度和它基本
重合，所以那些"分不开"不是样本不够到能看见真差异，而是这台机器上 5×3 的分辨率就这么大。

### 输出很大、结论埋在中间

`audit/tasks.output-heavy.jsonl` 是一个专项任务：脚本刷 4000 行噪声，唯一那行 `FAIL
src/renameme.test.js: expected 1 got 2` 在第 2000 行，既不在开头也不在结尾。压缩开着
（`compactMaxChars=2000`）跑一次：输出 231 KB → 1.3 KB，失败行连同行号被带进 marker
（`kept 1 matching line 2000:FAIL …`），模型答对了整行内容、文件名和期望值；这 1 对是
11.1 秒 / 1080 token，对比关掉的 20.7 秒 / 1827 token，两边校验都过。单对不构成统计结论，
它证明的是**这条路径端到端能走通、答案没被截掉**。

读法：

- 第一行是"只开主开关"的基线，也是唯一一次区间整体落在 1 以下的组合。
- 加压缩的两行区间都跨过 1：**这点样本分不开"压缩帮了忙"和"噪声"**，不能写成压缩有效。第一行
  与"只开关主开关"的差别只有 15 对样本，同一台机器上模型侧缓存冷热就能吃掉这个幅度。
- 加压缩那次 `list-files` 单任务先给出 1.927× 墙钟 / 2.245× token（3 对，CI 都不跨 1），看着像
  "截短输出以后模型多跑几轮"。拿同一个任务重跑 6 对：1.200× [0.833, 1.755] 和 1.092×
  [0.667, 1.907]，都跨过 1；同样 6 对、两臂完全没差别的噪声地板是 0.967× [0.619, 1.546]。
  所以那个"代价"是 3 对样本上的噪声，**不能写成结论**——这也是为什么单任务那一列永远只该看
  `样本不足`，结论只从合池读。
- 三个开关全开（压缩 + aggressive）既没有更快、token 还略多：**开关不是叠加的**，多开一个不等于
  多省一点。这也说明"能开就全开"是错的做法，默认把几项关着是有依据的。
- `--on-config gear=fast` 交接时踩过一次坑：1.7.10 会把 `gear:` 写两遍，on 臂 70 毫秒就失败，
  报告里显示"快得离谱"。1.7.11 修好后才有上表第三行。

复现（两个组合各跑一次，输出目录别覆盖）：

    COMPANY_LLM_TOKEN=... node audit/run.mjs --tasks audit/tasks.example.jsonl --cwd . \
      --rounds 3 --on-config compactResults=true --on-config compactMaxChars=4000 \
      --out /tmp/fm-audit-comboA

    COMPANY_LLM_TOKEN=... node audit/run.mjs --tasks audit/tasks.example.jsonl --cwd . \
      --rounds 3 --on-config compactResults=true --on-config gear=fast \
      --out /tmp/fm-audit-fast

## 一次完整的复核

    node audit/run.mjs --dry-run --cwd . --tasks my-tasks.jsonl   # 先确认命令行
    node audit/run.mjs --cwd . --tasks my-tasks.jsonl --rounds 4  # 真跑
    cat audit-out/<时间戳>/report.md                              # 读表

报告里每一行都是"某任务/合池 + 几何均值比 + 区间 + 结论"，配对不够的行会自己写"样本不足"。
把这些行原样贴出来，比任何形容词都可靠。
