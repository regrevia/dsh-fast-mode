<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>DeepSeek Harness 自己的 fast mode：同一个模型，只消耗一半的输出，最快快一倍。</b><br>
  多种开关自由组合，全在提示词侧：不换模型、不降思考强度、不写任何一个请求字段。<br>
  实测最快 <b>0.505×</b> 耗时、输出 token <b>−42%</b>、判分 <b>438/438</b> 全绿 —— <a href="BENCHMARK.md">benchmark 与复现</a>。
</p>

<p align="center">
  <a href="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/regrevia/dsh-fast-mode/releases"><img alt="release" src="https://img.shields.io/github/v/release/regrevia/dsh-fast-mode"></a>
  <img alt="deps" src="https://img.shields.io/badge/dependencies-1%20(schemastery)-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <a href="README.en.md">English</a>
</p>

---

## 一眼看完

30 对完整任务、同一模型同一设置，只差三个开关：

| 指标 | 结果 |
|---|---|
| **墙钟耗时** | **0.505×**（快约一倍，30 对 26 对更快） |
| **输出 token** | **−42%**（16037 → 9380） |
| **思考字符** | **−51%**（42380 → 20872） |
| **任务质量** | 判分 **438/438** 全绿，30/30 运行通过 |

标准档全开（精简输出 + 三条思考开关 + 开局文件清单 + 批量读文件）是这套东西最快的一档：四个任务族 16 对实测墙钟 **0.683×**（省 32 %，CI95〔0.520, 0.893〕），隐藏测试 32/32 绿、输出 token 0.712×、步数中位 1.000×。另一块 8 对（`codeimpl`、`shellpipeline`）里步数 **0.651×**〔0.486, 0.804〕、8/8 更快，但墙钟 0.954×〔0.699, 1.339〕跨 1、无结论：这两族的收益只算到「步数更少、质量全绿」，不算到墙钟。单独开其中任何一个都不成立——文件清单单独 0.927×、批量读单独 1.136×——所以它们不作为面板开关，只跟标准档成组出现。

## 怎么装

```bash
dsh plugin install dsh-fast-mode
```

装完在会话里点闪电。右键闪电打开面板，**只影响当前会话**。

## 四个按钮在做什么

四个开关都是纯提示词侧：不加请求参数、不改模型、不改完成判定。一个管输出，三个管「怎么走」。

| 按钮 | 原理 | 默认 |
|---|---|---|
| **精简输出** | 不预告调用、不复述结果、不写进度，最终答案不缩水 | 开 |
| **不确定先查证** | 拿不准就读一次；不是纯提速，省的是猜错后的重来 | 开（标准） |
| **先执行后解释** | 动手前最多一行计划；思考过 4000 字符时提醒「按证据动手」 | 开（标准） |
| **重复时换方法** | 同一调用重发、或连续三次结果一样时，提醒换条路 | 开（标准） |

只有这四个。另有四个旋钮（步数上限、开局附文件清单、批量读文件、截短工具输出）单开或成组都测不到稳定提速——步数上限只在 3/12 个回合里真的发出提醒、墙钟 1.02× 且区间跨 1；文件清单 0.927×；批量读 1.136×；截短工具输出从未单独测过。按「没验证的开关不出现给用户选用」的规则，它们从面板撤掉，配置键保留，行为不变。三条思考开关 1.7.26 曾收回，1.7.29 依据 15 对实测放回并随标准档一起载入（叠在精简输出之上 0.526×，14/15 更快），保守档全关。

## Benchmark

三开关全开（`trio17`）vs 全关，同一批任务逐对比较，配对 bootstrap 4000 次：

| 实验块 | 对数 | 墙钟几何均值 | 95% 区间 | 更快 |
|---|---|---|---|---|
| TRI（叠在标准之上） | 15 | 0.526× | [0.390, 0.753] | 14/15 |
| DP17 | 12 | 0.647× | [0.501, 0.893] | 10/12 |
| DP18 | 9 | 0.491× | [0.314, 0.788] | 8/9 |
| DP20b（发布版） | 9 | 0.372× | [0.240, 0.563] | 8/9 |
| **合池** | **30** | **0.505×** | **[0.401, 0.635]** | **26/30** |

发布版那一块里，步数 13.2 → 6.7、墙钟 464.9 s → 173.1 s，三开在每一块都是唯一区间不跨 1 的臂。复现命令与原始数据在 [BENCHMARK.md](BENCHMARK.md)。

## 为什么能快，以及哪里不会快

一步的耗时 ≈ 往返开销 × 步数 + 解码时间 × 输出 token + 工具等待。模型不在这个式子里，所以这里只动程序量：少几次往返、少几轮回头读、少写重复的编辑。

- **有些情况会变慢，别指望它全场景加速。** 1–5 步的小改修和数据整形收不回成本（`perfrefactor` 1.18×、`csvpipe` 1.12×），实现类任务偶尔多绕一步（DP20 有一对 1.04×）。
- **质量优先。** 每个采纳的批次里两臂隐藏断言逐格相同；安全校验、数据删除、无障碍这些场景永远走完整验证，不做提速。
- **开关在你手里。** 默认只开「精简输出」；三个新开关默认关，因为它们的收益按任务形状波动，不适合替所有人默认决定。

推荐：**大多数时候三个全开**。想稳一点只开「不确定先查证」；最在意思考链过长就开「先执行后解释」；「重复时换方法」单开实测等于没变（1.007×，十二个会话只触发 3 次），放在组合里无害。

## 自己量一遍

上面的数字都来自本仓库的 bench，换到你的机器和你的任务上未必一样。先 `node audit/run.mjs --dry-run --cwd <仓库> --tasks <清单>` 看它要展开成什么命令，去掉 `--dry-run` 就是配对真跑（每任务每臂 3 轮），产物落在 `audit-out/<时间戳>/`：原始读数 `pairs.jsonl` 和带几何均值比与区间的人看报告 `report.md`。配对数不足 6 时报告只写「样本不足，不做结论」。

方法与结论边界见 [docs/AUDIT.md](docs/AUDIT.md)，清单怎么写见 [audit/tasks.example.jsonl](audit/tasks.example.jsonl)，agent 操作手册见 [skills/fast-mode-audit/SKILL.md](skills/fast-mode-audit/SKILL.md)。

## 许可

MIT。参考手册见 [docs/REFERENCE.md](docs/REFERENCE.md)，逐版改动见 [CHANGELOG.md](CHANGELOG.md)。
