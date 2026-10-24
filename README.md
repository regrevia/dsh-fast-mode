<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>同样的思考强度，更少的往返。</b><br>
  快模式从不调整模型、思考强度或请求协议 —— 它只让每一步少跑几趟、少说几句、少卡几分钟。
</p>

<p align="center">
  <a href="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/regrevia/dsh-fast-mode/releases"><img alt="release" src="https://img.shields.io/github/v/release/regrevia/dsh-fast-mode"></a>
  <img alt="deps" src="https://img.shields.io/badge/dependencies-1%20(schemastery)-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <a href="README.en.md">English</a>
</p>

---

## 原理

一步要多久，账本上只有两项：**约 720 ms 的固定往返**，加上**每个输出 token 约 6.6 ms**（`ms = 720 + 6.63 × outputTokens`，689 步拟合，R² = 0.93），再算上工具等待。思考强度在这条账本上不是变量——reasoning token 实测为 0，降 effort 省不出时间，只会让答案变浅。所以 1.0.0 的 `agent/request` 钩子是纯透传：**你选多深的思考，就一直是多深**。

真正能动的是三处：**把互不依赖的工具调用压进同一步**（少付几次固定开销）、**收掉过程叙述而不动答案**、**给前台命令设可取消的上限**（一条没有上限的 `tail`/起服务能吃掉几分钟）。并行宽度 2–8 由调度器按最近几步的实际表现自动决定，默认 4，顺利时放宽、报错或卡住时收窄。

## 结论

- 单文件、少步骤的题（HumanEval、AIME 这类）本来就没什么可并行，快模式**测不出差别**：0.8 时代所有档位落在对照的 0.95×–1.09×，属于噪声。
- 0.8 时代那个 −40 % 的步时结果不算在 1.0 头上：那一版的档位同时**降了思考强度**，而那条杠杆已经被删掉。1.0 只保留并行、输出纪律、卡顿保护三件事，**尚未做过规模的 A/B**，所以我们不说"快 40 %"。
- 能诚实承诺的是机制：思考强度不变、答案质量不变、token 可能更多（一次读多处），步骤会少一些——前提是任务里真的有可以并行的查询。

完整推导、每组对照和没复现的那一半都在 [BENCHMARK.md](BENCHMARK.md)；"为什么降 effort 没用"的账本也在那里。

## 使用

1. **装**：DSH 桌面版 → 插件管理器 → 安装 bundle，目标填 `github:regrevia/dsh-fast-mode`。终端等价命令：`pnpm add github:regrevia/dsh-fast-mode --dir ~/.dsh/profiles/desktop`。
2. **开**：重载页面，点输入框旁的小闪电，打开开关。没有档位要选——调度器自己决定每一步的宽度。
3. **生效**：下一条请求就生效，不用重启、不用新开会话。开关跟着会话走，一个标签页一个选择。

```yaml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
      config:
        enabled: true   # 装好默认关闭；这一行才是真正的开关
        gear: auto      # 唯一有意义的档位：调度器
```

旧配置里的 `fast` / `turbo` / `max` / `ludicrous` 会被当作 `auto` 并打一条弃用日志，**不会**再动你的思考强度。`safe` 保留给实验脚本做对照（固定并行 2、不设调用上限、不注入提示）。

## 开关

闪电本身就是开关：点一下开，再点一下关。没有面板、没有下拉、没有齿轮、没有倍数估算——那些选择已经不存在了。每个会话各自独立，点完即写；重启后按会话恢复，所以"medium + fast"回到这个会话还是"medium + fast"。为什么快、快在哪里、改了什么，都写在插件介绍里，不占输入区的空间。

与 `dsh-batch-tool-calls` / `dsh-ops` 不能同时启用：它们的提示规则和本插件重叠，同时开启等于同一份指导付两次钱。压缩类插件（billion-context、图片压缩、网关适配）可以共存：一个削输入，一个削往返。细节见 [docs/REFERENCE.md](docs/REFERENCE.md)。

## 接下来

- **多文件任务上的 A/B**：fan-out 只在"一步能问好几处"的任务上有收益，下一步是把对照搬到多仓库、多文件任务，而不是继续堆单文件题。
- **卡顿保护到底救回多少**：上限目前是策略值加自适应，还没有量过它挡下了多少分钟的工具等待。
- **真实 TTFT**：现在测的是请求级延迟，接上流式信号后才叫真 TTFT。

## 更多

[实测与复现方法](BENCHMARK.md) · [原理、配置与边界（参考手册）](docs/REFERENCE.md) · [改了什么](CHANGELOG.md) · [English](README.en.md)

## 许可

MIT。logo 是鲸鱼与闪电 —— 快，但不许骗自己。
