<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>思考强度不变，只给“能并行的读”提速。</b><br>
  有证据才并行，没证据就原生；不加请求字段、不改思考强度。
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

没有模型切换、没有 `reasoningEffort` 改写、没有请求字段注入；开着时模型输入里会多出本插件自己的调度提示与提醒（这是机制本身），关掉后连这些也不存在。DeepSeek 官方 API、OpenAI 兼容中转、自建网关、Anthropic 协议 —— 走哪条路由都成立。

## 先把三个词说清楚

- **墙钟（wall clock）**：任务从发出到 headless 进程退出的端到端真实耗时，包含模型延迟、工具等待、插件开销。下文“X 秒”都是它。
- **速率**：墙钟的倒数（1/墙钟）。墙钟从 10 s 降到 8 s，速率就是 1.25 倍。
- **加速比**：`关掉时的墙钟 ÷ 打开时的墙钟`。**大于 1 才是变快**；1.28× 等于省 22 % 的时间，0.8× 等于慢了 25 %。95 % 区间（CI）跨过 1 就是“和没开分不出来”。

## 实测

**1.5.0 的默认不做步数收尾。** `finishLineSteps` 与 `stepBudget` 默认都是 `0`：没有“第 10 步提醒收尾”，也没有“30 步停止”。结束由任务状态和完成证据决定 —— 同一份产物上逐字重复一条已通过的检查，建议复用结果、把这一步留给剩下的工作；连续几步没有新结果，建议换方法（只是提醒，不结束回合）；工具卡住，看门狗取消它并等它真正停下。任务做完就正常报告，提醒不会替你判停。

**1.5.0 重基线（9 家族、54 个完整单元、隐藏测试全绿）**：不剔任何运行、按整任务总量加总 —— 关闭 **7142.3 s / 1 196 707 token / 1155 步**；默认臂 **0.86× 墙钟 / 0.95× 输出 / 0.85× 步数**；退役的 `fl10` **0.78× / 0.79× / 0.72×**。收益集中在读多写少和从零实现的任务（`csvpipe` 0.79×、`debugfix` 0.56×、`ledger` 0.73×、`shellpipeline` 0.87×、`stategraph` 0.82×）；**三个写文件型家族没有稳定加速**（`migrate` 1.02×、`codeimpl` 1.09×、`perfrefactor` 1.33×），所以 `fl10` 仍然只作消融臂。贴近日常的「改一个小仓库（修 bug + 加 TTL + 分页）」家族上默认臂 0.84× 墙钟、0.79× 输出。基线里有两次自己打转的长运行，剔掉后默认臂的墙钟比回到 0.88× —— 这层敏感性写在 [BENCHMARK.md](BENCHMARK.md)。
同日的 **9 家族 × 6 对三臂交错 ABBA**（162 次运行、51 个完整单元）复核了方向：`fl10` **0.66× 墙钟 / 0.69× 输出**、`open15` **0.68× / 0.68×**——但两臂都没过门禁，`fl10` 在 `ledger` p1（基线绿）红 21/22，`open15` 在 `shellops` p7（基线绿）红 13/14，且 `openBatch` 补测 5 个家族后相对默认是 1.03× 墙钟（输出与步数持平或略少）、还出现过 325 步 / 5.2 倍 token 的失控。**所以 1.5.0 的默认不变**，两个更快的配置都只作消融臂；单元级数据在 BENCHMARK 的 `H2`/`H3`。

**已退役的默认：`finishLineSteps: 10`。** 1.4.4 用它跑出 7 家族 14 对中位 **1.86×**、13/14 更快（符号检验 **p = 0.002**）、输出 **−52 %**、步数 **−10.0**、隐藏测试 **14/14 全绿**。这条线的速度是真的，代价也是真的：它到第 10 步就要求停止扩大范围，对**仍在推进的长任务**同样开火。所以 1.5.0 把它降级为消融臂（`fl10`），默认关闭。

**诚实的历史边界**：1.4.1 把样本从 5 对扩到 76 对后，1.4.0 的 1.86× 回落到中位 **1.06×**（45/76 对更快）—— 小样本倍数是噪声。短任务（1–5 步）没有可省的，收益随步数出现。

**一句话结论**：在已测的有限任务中观察到加速，未观察到这些隐藏断言上的退化。这不是对所有任务的普遍质量保证。

每个原始数字、步数分桶、被否掉的候选与失败模式：[BENCHMARK.md](BENCHMARK.md)。

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

**排错**：如果本应在跑的任务被一条 `Stop working now and report instead` 强制收尾，说明装的是 1.1.0 或更早的版本——那版在「单轮 30 步」或「连续 12 步没有新产出」时无条件叫停。1.5.0 起默认没有任何按步数收尾的提醒：无进展只换方法，不结束回合；硬停只在你自己设了 `stepBudget` 时存在。升级到当前版本后重启一次即可（host 侧代码是启动时加载的）。

## 开关

闪电就是开关：开/关即写，按会话独立，重启按会话恢复。没有面板、没有下拉、没有倍数估算。

思路参考了 `dsh-batch-tool-calls` 与 `dsh-ops`（批量调用、有界执行），但它们的规则是静态的，这里的宽度来自会话自身的调用证据；不需要同时装。压缩类插件可以共存。

## 边界与下一步

判断“这一步值不值得提速”的可编程信号现在有三个：请求自身的措辞（串行/扇出/shell，见 `src/shape.js`）、上一步的调用是否全为只读且目标两两不同、以及连续只读步数。前两个让单轮任务第一步就能选对宽度。

在线选择（UCB/Thompson）**不在**这一版里，原因不是网络 —— bandit 全是本地算术，不额外发请求、不增加往返，实测代价可以忽略。真正的问题是奖励太吵：本项目 40 对配对里，同一任务两臂的方差远大于宽度带来的效应；把这种噪声喂给 UCB，学到的会是抖动而不是策略。等请求形状分类把“该宽的样本”筛出来、每步墙钟的方差降下来，再上 bandit 才有意义；设计上会用折扣 Thompson 采样（先验 N(0, σ²)，只对“扇出/未知”两类上下文分别维护宽度后验），而不是全局 UCB。

[实测与复现](BENCHMARK.md) · [参考手册](docs/REFERENCE.md) · [改了什么](CHANGELOG.md) · [English](README.en.md)

## 许可

MIT。
