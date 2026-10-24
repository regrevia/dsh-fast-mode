<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>思考强度不变，只给“能并行的读”提速。</b><br>
  有证据才并行，没证据就原生；请求体一个字节不改。
</p>

<p align="center">
  <a href="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/regrevia/dsh-fast-mode/releases"><img alt="release" src="https://img.shields.io/github/v/release/regrevia/dsh-fast-mode"></a>
  <img alt="deps" src="https://img.shields.io/badge/dependencies-1%20(schemastery)-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <a href="README.en.md">English</a>
</p>

---

## 它到底做什么

一步的用时 = 往返开销 × 步数 + 解码时间 × 输出 token + 工具等待。模型和思考强度不在这个式子里，所以快模式只动三个程序量：

- **并行扇出**：调度器先判断这一步是不是“多个互不依赖的读”，是才要宽（最多 8），并且跨轮记住这个形状；写操作、单调用、连续报错或无进展的回合**保持原生** —— 整段批处理提示不渲染，不为它付输入 token。
- **输出纪律**：只裁剪过程叙述（不预告、不复述、不写进度），最终答案完整保留。
- **卡顿看门狗**：给 shell/脚本类调用设 120–300 秒自适应上限，卡住的调用被取消并把“换做法”写回上下文。

没有模型切换、没有 `reasoningEffort` 改写、没有请求体注入。DeepSeek 官方 API、OpenAI 兼容中转、自建网关、Anthropic 协议 —— 走哪条路由都成立。

## 先把三个词说清楚

- **墙钟（wall clock）**：任务从发出到 headless 进程退出的端到端真实耗时，包含模型延迟、工具等待、插件开销。下文“X 秒”都是它。
- **速率**：墙钟的倒数（1/墙钟）。墙钟从 10 s 降到 8 s，速率就是 1.25 倍。
- **加速比**：`关掉时的墙钟 ÷ 打开时的墙钟`。**大于 1 才是变快**；1.28× 等于省 22 % 的时间，0.8× 等于慢了 25 %。95 % 区间（CI）跨过 1 就是“和没开分不出来”。

## 实测 v1.2.0（相对值）

同一模型（`deepseek-v4.1-flash`）、同一路由、同一 `reasoningEffort: medium`，两臂只差插件开关；8 个多文件任务 × 5 对 ABBA 配对，共 80 次真实 headless 运行，确定性质量门禁 **80/80 全过**（每任务两臂各 5/5）。

| 任务（形状） | 墙钟：关 → 开 | 加速比 | 95 % CI | 样本 |
|---|---|---|---|---|
| t1：8 文件逐项摘要（判原生） | 10.0 s → 9.5 s | 1.02× | 0.86–1.40 | 12 |
| t2：40 文件计数 | 5.8 s → 6.0 s | 0.98× | 0.82–1.34 | 8 |
| t3：6 目录求和（shell） | 5.6 s → 4.9 s | 1.03× | 0.67–1.36 | 15 |
| t4：12 模块审计（串行） | 9.1 s → 11.0 s | 1.03× | 0.55–1.19 | 5 |
| t5：12×5 查热符号 | 6.8 s → 7.6 s | 1.07× | 0.43–1.35 | 5 |
| t6：24 日志求和 | 8.7 s → 5.6 s | 1.43× | 1.00–2.57 | 5 |
| t7：18 节点依赖链（串行） | 4.4 s → 4.3 s | 1.06× | 0.76–1.30 | 5 |
| t8：16 manifest 找重复 | 6.9 s → 5.4 s | 1.29× | 0.98–1.61 | 5 |
| t9：6 模块独立改写（写扇出） | 9.6 s → 8.8 s | 0.98× | 0.73–1.59 | 8 |
| t10：10 日志聚合报告（读写混合） | 7.0 s → 6.4 s | 1.11× | 0.84–1.39 | 8 |

**76 对合并：中位加速比 1.06×（CI 1.00–1.15×），45/76 对变快，均值 1.15×。** 这是扩大样本后的诚实数字：**没有**稳定的大幅提速。1.4.0 发布时 t1 的 1.86×、t3 的 1.77× 各只有 5 对样本，扩到 15 对后回落到 1.02× 和 1.03× —— 小样本的倍数是噪声，不是收益。

真实机制只剩一条：**能把步数真正压下来的形状才变快**（t3 shell 扇出 4.7→3.5 步、t9 5.9→5.2 步、t10 5.1→4.9 步）；而墙钟主要由解码 token 决定，所以步数减少换来的 0.7 s/步 常被“一步里更大的输出”吃掉。t6/t8 的 1.4×/1.3× 仍只有 5 对，按小的看待。

为什么“只加速可并行形状”还没完全兑现：调度器的判据来自**会话内已发生的调用**，而上面 8 个任务都是单轮任务 —— 它们只看到新会话那一次 4 宽探测，形状证据还没积累，任务就结束了。1.3.0 把这一步也省了：新会话不再探测，直接读请求措辞判断形状（见下）。

复现方法、每个原始数字和失败模式：[BENCHMARK.md](BENCHMARK.md)。

## 使用

1. **装**：DSH 桌面版 → 插件管理器 → 安装 bundle，目标填 `github:regrevia/dsh-fast-mode`。终端等价：`pnpm add github:regrevia/dsh-fast-mode --dir ~/.dsh/profiles/desktop`。
2. **开**：重载页面，点输入框旁的小闪电。没有档位要选。
3. **生效**：下一条请求生效，不用重启、不用新开会话。

```yaml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
      config:
        enabled: true   # 装好默认关闭；这一行才是真正的开关
```

旧配置里的 `fast` / `turbo` / `max` / `ludicrous` 会被当作 `auto` 并打一条弃用日志，**不会**再动思考强度。

## 开关

闪电就是开关：开/关即写，按会话独立，重启按会话恢复。没有面板、没有下拉、没有倍数估算。

思路参考了 `dsh-batch-tool-calls` 与 `dsh-ops`（批量调用、有界执行），但它们的规则是静态的，这里的宽度来自会话自身的调用证据；不需要同时装。压缩类插件可以共存。

## 边界与下一步

判断“这一步值不值得提速”的可编程信号现在有三个：请求自身的措辞（串行/扇出/shell，见 `src/shape.js`）、上一步的调用是否全为只读且目标两两不同、以及连续只读步数。前两个让单轮任务第一步就能选对宽度。

在线选择（UCB/Thompson）**不在**这一版里，原因不是网络 —— bandit 全是本地算术，不额外发请求、不增加往返，实测代价可以忽略。真正的问题是奖励太吵：本项目 40 对配对里，同一任务两臂的方差远大于宽度带来的效应；把这种噪声喂给 UCB，学到的会是抖动而不是策略。等请求形状分类把“该宽的样本”筛出来、每步墙钟的方差降下来，再上 bandit 才有意义；设计上会用折扣 Thompson 采样（先验 N(0, σ²)，只对“扇出/未知”两类上下文分别维护宽度后验），而不是全局 UCB。

[实测与复现](BENCHMARK.md) · [参考手册](docs/REFERENCE.md) · [改了什么](CHANGELOG.md) · [English](README.en.md)

## 许可

MIT。
