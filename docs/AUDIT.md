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
      --on-config compactResults=true --on-config gear=aggressive

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

- **凭据**：本机这个 shell 跑真调用会失败在 `MISSING_CREDENTIAL: llm-pi-ai: no credential for
  provider route "company"`。CLI 入口、`--json` 事件结构、metrics 归集都已实测；**真实端到端
  的墙钟数字在这里没有跑出来过**，第一次真跑要在有凭据的环境里做。跑到这种失败时工具会让你
  看见 `turn_end.reason.error.code`，不会把它算成一次测量。
- **profile**：`headless` 的 node_modules 里没有 dsh-fast-mode，在那儿做 A/B 两臂都关着；
  `desktop` 由 Electron 独占，dump 不了。默认值 `bench` 是实测能 dump、且 `--patch` 真能把
  `enabled` 从 false 翻到 true 的那个（证据写在 `DETECTED.evidence`）。
- **顺序**：必须串行跑。并行跑会让两臂互相抢 CPU 和模型侧并发额度，测出来的差异是调度差异。
- **缓存**：同一台机器上多轮之间模型侧缓存会变热，配对设计只能抵消一部分，所以样本量比单次
  精度重要。
- 墙钟包含进程启动（约几百毫秒）。要更纯的对比得看 token 那一列，或者把 `--rounds` 加大让固定
  开销摊薄。

## 一次完整的复核

    node audit/run.mjs --dry-run --cwd . --tasks my-tasks.jsonl   # 先确认命令行
    node audit/run.mjs --cwd . --tasks my-tasks.jsonl --rounds 4  # 真跑
    cat audit-out/<时间戳>/report.md                              # 读表

报告里每一行都是"某任务/合池 + 几何均值比 + 区间 + 结论"，配对不够的行会自己写"样本不足"。
把这些行原样贴出来，比任何形容词都可靠。
