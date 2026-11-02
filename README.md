<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>同一个模型，一半的时间。</b><br>
  不换模型、不降思考强度、不写任何一个请求字段——只改「怎么执行」，把绕路的部分省掉。
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

三个开关全开 + 面板默认项，是这套东西最快的一档；只开闪电、不开三个新开关，全池 138 对是 **0.823×**（省 18 %）。

## 怎么装

```bash
dsh plugin install dsh-fast-mode
```

装完在会话里点闪电。右键闪电打开七行面板，**只影响当前会话**。

## 七个按钮在做什么

七个开关都是纯提示词侧：不加请求参数、不改模型、不改完成判定。前两个管输出，后五个管「怎么走」。

| 按钮 | 原理 | 默认 |
|---|---|---|
| **精简输出** | 不预告调用、不复述结果、不写进度，最终答案不缩水 | 开 |
| **步数上限** | 硬上限，到点先汇报现状，不截断任务 | 不限 |
| **开局附文件清单** | 开局把工作目录交给模型，省掉先跑一遍 `ls`/`find` | 关 |
| **批量读文件** | 互不依赖的读取合成一批发出，少几个来回 | 关 |
| **不确定先查证** | 拿不准的事实读一次，别用推理猜——猜错要重来 | 关 |
| **先执行后解释** | 动手前最多一行计划；思考过 4000 字符时提醒「按证据动手」 | 关 |
| **重复时换方法** | 同一调用重发、或连续拿到一样的结果时，提醒换条路 | 关 |

后五个是 1.7.0 起的新机制，**默认关**，理由见下面的边界。

## Benchmark

三开关全开（`trio17`）vs 全关，同一批任务逐对比较，配对 bootstrap 4000 次：

| 实验块 | 对数 | 墙钟几何均值 | 95% 区间 | 更快 |
|---|---|---|---|---|
| DP17 | 12 | 0.647× | [0.501, 0.893] | 10/12 |
| DP18 | 9 | 0.491× | [0.314, 0.788] | 8/9 |
| DP20b（发布版） | 9 | 0.372× | [0.240, 0.563] | 8/9 |
| **合池** | **30** | **0.505×** | **[0.401, 0.635]** | **26/30** |

发布版那一块里，步数 13.2 → 6.7、墙钟 464.9 s → 173.1 s，三开在每一块都是唯一区间不跨 1 的臂。复现命令与原始数据在 [BENCHMARK.md](BENCHMARK.md)。

## 为什么能快，以及哪里不会快

一步的耗时 ≈ 往返开销 × 步数 + 解码时间 × 输出 token + 工具等待。模型不在这个式子里，所以这里只动程序量：少几次往返、少几轮回头读、少写重复的编辑。

- **不承诺所有任务都快。** 1–5 步的小改修和数据整形收不回成本（`perfrefactor` 1.18×、`csvpipe` 1.12×），实现类任务偶尔多绕一步（DP20 有一对 1.04×）。
- **质量优先。** 每个采纳的批次里两臂隐藏断言逐格相同；安全校验、数据删除、无障碍这些场景永远走完整验证，不做提速。
- **开关在你手里。** 默认只开「精简输出」；三个新开关默认关，因为它们的收益按任务形状波动，不适合替所有人默认决定。

推荐：**大多数时候三个全开**。想稳一点只开「不确定先查证」；最在意思考链过长就开「先执行后解释」；「重复时换方法」单开实测等于没变（1.007×，十二个会话只触发 3 次），放在组合里无害。

## 许可

MIT。参考手册见 [docs/REFERENCE.md](docs/REFERENCE.md)，逐版改动见 [CHANGELOG.md](CHANGELOG.md)。
