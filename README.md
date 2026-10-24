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

| 任务（形状） | 墙钟：关 → 开 | 加速比 | 95 % CI |
|---|---|---|---|
| t1：8 文件抽摘要 | 8.6 s → 11.3 s | 0.78× | 0.43–1.30 |
| t2：40 个独立文件计数 | 7.2 s → 6.4 s | 1.14× | 0.93–1.24 |
| t3：6 目录逐个求和（shell 为主） | 5.0 s → 6.5 s | 0.81× | 0.53–1.20 |
| t4：12 模块审计报告 | 8.7 s → 13.1 s | 0.71× | 0.55–1.21 |
| t5：12 模块 × 5 文件查热符号 | 13.9 s → 12.2 s | 1.14× | 0.90–1.82 |
| t6：24 个日志文件按级别求和 | 5.7 s → 5.2 s | 1.28× | 0.68–1.59 |
| t7：18 节点依赖链（必须串行） | 4.6 s → 5.6 s | 0.98× | 0.38–1.51 |
| t8：16 个 manifest 找重复依赖 | 6.8 s → 6.0 s | 1.04× | 0.68–1.27 |

**40 对合并：中位加速比 0.96×，CI 0.80–1.14×，19/40 对变快。** 换句话说，这一版**没有**证明普遍变快；可复现的收益集中在“大量互不依赖的读”（t2/t5/t6：1.1–1.3×），而摘要、审计这类需要反复回看的任务反而变慢。

为什么“只加速可并行形状”还没完全兑现：调度器的判据来自**会话内已发生的调用**，而上面 8 个任务都是单轮任务 —— 它们只看到新会话那一次 4 宽探测，形状证据还没积累，任务就结束了。多轮会话里，第二轮的请求会直接继承上一轮的形状；单轮任务没有这个机会。

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

判断“这一步值不值得提速”的可编程信号目前只有两个：上一步的调用是否全为只读且目标两两不同，以及连续只读步数。下一步是把**任务入口的形状**也变成信号（请求里出现多少独立文件/目录），并对宽度做在线选择（bandit），这样单轮任务也能在第一步就吃到并行，而不是先付一次探测。

[实测与复现](BENCHMARK.md) · [参考手册](docs/REFERENCE.md) · [改了什么](CHANGELOG.md) · [English](README.en.md)

## 许可

MIT。
