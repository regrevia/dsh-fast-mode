<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>同样的任务，快 40%。</b><br>
  不是把模型想笨，是把它的往返和废话砍掉 —— 不换模型，不换供应商，不改一行请求协议。
</p>

<p align="center">
  <a href="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/regrevia/dsh-fast-mode/releases"><img alt="release" src="https://img.shields.io/github/v/release/regrevia/dsh-fast-mode"></a>
  <img alt="deps" src="https://img.shields.io/badge/dependencies-1%20(schemastery)-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <a href="README.en.md">English</a>
</p>

---

## 原理：延迟是一本账

一步要花多久，拆开只有两项：**约 720 ms 的固定往返开销**，加上**每个输出 token 约 6.6 ms**（`ms = 720 + 6.63 × outputTokens`，689 步拟合，R² = 0.93）。所以"省 thinking"在这条路由上省不出速度 —— reasoning token 本来就是 0；调低 effort 一分钱也降不下来。

这个插件只动两处：**把互不依赖的工具调用压进同一步**（少跑几趟），**把过度发的文字和思考收掉**（少搬几趟）。一步干完三步的活，账本上的固定开销就少付两次。还有一项不在这个公式里：**工具等待** —— 一条没有上限的前台命令（起服务、tail 日志、heredoc 死成畸形响应）能一口气吃掉几分钟，模型往往还照着原样再来一遍。现在 shell 类调用会按档位设上限，超时就取消，并把"换个做法"写回给模型。

## 结论：真实的数字

同一任务、同一模型、同一路由、16 个会话、83 步，`safe` 对照 `turbo`：

| 指标 | safe | turbo | 变化 |
|---|---|---|---|
| Σ 步时（中位） | 25.9 s | 15.6 s | **−40 %** |
| 步数（中位） | 7.5 | 4.5 | −40 % |
| 每会话输出 token（中位） | 3 798 | 2 180 | −43 % |
| 每步工具调用 | 1.41 | 1.37 | 持平 |
| 每步并发上限 | 2 | 6 | 3× |
| 进程内存（200 会话状态） | — | — | **+192 KB RSS / +38 KB heap** |
| 总 token（新 token + 缓存读） | 3 798 + 83 k | 2 180 + 84 k | 缓存读持平，占 91–92 % |
| Mann–Whitney U | — | — | **p = 0.008** |

10/10 的事实题答案完全一致。注意诚实的部分：turbo 每步其实**更慢也更胖**（+537 ms、+5 % token），它赢在只用 4.5 步干完 7.5 步的活 —— 省的是往返，不是每步的智力。

这个收益**不是普遍成立**。同一套对照搬到 HumanEval（100 会话）和 AIME 2025（39 会话）上，`off` 和所有档位都落在噪声内（0.95×–1.09×），因为单文件题只有 4–5 步、没有可并行的查询。两组公开题的结果、以及"为什么测不出来"的完整推导，都写在 [BENCHMARK.md](BENCHMARK.md#实验-f公开-benchmark-上的对照humaneval-100-会话aime-2025-39-会话) 里 —— 包括没复现的那一半。

## 三十秒用起来

1. **装**：DSH 桌面版 → 插件管理器 → 安装 bundle，目标填 `github:regrevia/dsh-fast-mode`。终端等价命令：`pnpm add github:regrevia/dsh-fast-mode --dir ~/.dsh/profiles/desktop`（然后把下面这段加进 `cordis.patch.yml`，插件管理器会自动写）。
2. **开**：重载页面，点输入框旁的小闪电 → 打开开关 → 选一个档位。
3. **生效**：下一条请求就按新档位跑，不用重启、不用新开会话。开关跟着会话走，一个标签页一个选择。

```yaml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
      config:
        enabled: true      # 装好默认关闭；这一行才是真正的开关
        gear: turbo        # safe / fast / turbo / max / ludicrous（默认 fast）
```

与 `dsh-batch-tool-calls` / `dsh-ops` 不能同时启用（功能重叠，见 [docs/REFERENCE.md](docs/REFERENCE.md#与压缩类插件共存的细节) 的冲突小节）。

## 五个档位

档位不是"关得多狠"，是一套姿态：多早允许降档、让模型一步发几个调用、要不要收输出。

| 档位 | 并行目标 | 要不要用 |
|---|---|---|
| **Eco** `safe` | 2 个/步 | 关键改动、先看日志、要求零提示变更；也是实验的对照臂 |
| **Cruise** `fast` | 4 个/步 | 默认，日常够用 |
| **Sport** `turbo` | 6 个/步 | **要更快就选这档**：大量读代码、调研、批量排查 |
| **Track** `max` | 8 个/步 | 机械批量任务，不建议无人值守跑关键改动 |
| **Redline** `ludicrous` * | 8 个/步 | 明确不要质量的批量任务：关掉思考，最快也最险 |

\* 唯一会真的发 `reasoningEffort: 'off'` 的档位。显式字段永远优先于档位（`gear: turbo` + `deepAfter: 8` = Sport 的并行 + 保守的降档节奏）。

## 和别的插件一起用

它只碰五处：系统提示里一个 section、`agent/request` 里的 `reasoningEffort`、读一次 `maxParallelToolCalls`、`tools/execute` 里给 shell 类调用加的可取消上限、`agent/pre-step` 里在压缩之后补的一条提醒（`source.kind = 'plugin'`，不冒充用户消息）。不删改历史、不拦 `fetch`、不发网络请求。

- ✅ **压缩类**（billion-context、内置 compaction、图片压缩、网关适配）：一个削输入，一个削往返，相乘。把压缩工具加进 `holdTools` 就互不打扰。
- ✅ **纯 UI / 只读观测类**：零交集。
- ❌ **另一个改 `reasoningEffort` 的插件**：一个旋钮只能有一个主人，二选一。
- ❌ **另一个也叫 "fast mode" 的插件**：settings 命名空间和 patch id 会撞。
- ❌ **把 `maxParallelToolCalls` 压回 1–2 的"省 token"插件**：并行目标变成空话，只剩假快。
- ❌ **`dsh-batch-tool-calls` / `dsh-ops`**：前者的批量规则是本插件的一个静态子集，还不看档位；后者自带两套 shell 和 Windows-only 的二进制，超时建议也各说各话。同时开等于同一份提示付两次钱，二选一。

完整清单、判定依据和配置片段见 [docs/REFERENCE.md](docs/REFERENCE.md#与压缩类插件共存的细节)。

## 接下来

- **步骤多的真实任务上的 A/B**：fan-out 只在"一次能问好几处"的任务上有收益，下一步是把实验 E 扩到多仓库、多文件的任务上，而不是继续堆单文件题。
- **卡顿上限的实测**：0.9.0 的单次调用上限目前是策略值（300/180/120/90 s），还没量过"它到底救回了多少分钟"。
- **官方 API 与真实 TTFT**：现在测的是请求级延迟，接上流式信号后才叫真 TTFT。

## 更多

[实测与复现方法](BENCHMARK.md) · [原理、配置与边界（参考手册）](docs/REFERENCE.md) · [改了什么](CHANGELOG.md) · [English](README.en.md)

## 许可

MIT。logo 是鲸鱼与闪电 —— 快，但不许骗自己。
