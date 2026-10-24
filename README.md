<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>思考强度不变，把能并行的读压进同一个来回。</b><br>
  在任务里找独立查询、一次发出去、少写过程、给命令设上限 —— 请求体一个字节都不改。
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

一步的墙钟 = 往返开销 × 步数 + 解码时间 × 输出 token + 工具等待。模型和思考强度不在这个式子里 —— 快模式只动三个程序量：

- **并行扇出**：调度器按最近几步的实测表现决定每步宽度（2–8）。一步里全是读类调用就放宽到 8，报错、变慢或步骤无进展就收窄。跨轮记住上一步的形态，所以"上一轮最后一步是宽读"会让下一轮开局就是宽的。
- **输出纪律**：过程文字压到结论处，同样的答案更少 token、更少解码。
- **卡顿看门狗**：给 shell/脚本类调用设 120–300 秒自适应上限，卡住的调用被取消并把"换做法"写回上下文，而不是吃掉几分钟。

没有模型切换、没有 `reasoningEffort` 改写、没有请求体注入。DeepSeek 官方 API、OpenAI 兼容中转、自建网关、Anthropic 协议 —— 走哪条路由都成立，因为它只改本地调度。

## 实测（相对值）

同一模型、同一路由、同一 `reasoningEffort: medium`，两臂只差插件开关；4 个多文件任务 × 6 对 ABBA 配对，共 48 次真实 headless 运行，质量门禁两臂 **24/24 全过**。下表是每任务 6 对的**配对中位数比值**（fast / off，越小越快）：

| 任务（形状） | 墙钟 | 步数 | 输出 token | 工具调用 |
|---|---|---|---|---|
| t2：5 个目录 × 8 个文件找计数 | **0.69×** | 1.00× | 0.72× | 0.88× |
| t1：8 个文件抽摘要 | **0.89×** | 0.92× | 0.90× | 0.75× |
| t4：12 个模块审计报告 | 1.04× | 0.93× | 0.90× | 0.89× |
| t3：6 个任务目录求和 | 1.24× | 1.00× | 1.49× | 1.60× |

- **能并行的形状才吃得到收益。** t2 是 40 个互不依赖的读：−31 % 墙钟、−28 % 输出、−12 % 调用。t3 是"每个目录都要先看再决定"，并行的前提不成立，反而多了一次往返。
- **24 对合并的中位是 0.96×，范围 0.40×–2.72×。** 方差比效应大，所以不发布单一"快 X %"的数字。
- **质量不变**：所有 run 的确定性 verify 都通过；输出更短不等于答案更浅，因为答案字段一个没少。
- **token 不是固定变多**：宽读把多次重复读同一批文件换成一次读，实测 t1/t4 的输入 token 反而更低；只有当模型把无关文件也预读进来时才会变多 —— 这是可以接受的价格。

完整方法、每对原始数字与没复现的部分见 [BENCHMARK.md](BENCHMARK.md)。

## 使用

1. **装**：DSH 桌面版 → 插件管理器 → 安装 bundle，目标填 `github:regrevia/dsh-fast-mode`。终端等价命令：`pnpm add github:regrevia/dsh-fast-mode --dir ~/.dsh/profiles/desktop`。
2. **开**：重载页面，点输入框旁的小闪电。没有档位要选 —— 调度器自己决定每一步的宽度。
3. **生效**：下一条请求就生效，不用重启、不用新开会话。

```yaml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
      config:
        enabled: true   # 装好默认关闭；这一行才是真正的开关
```

旧配置里的 `fast` / `turbo` / `max` / `ludicrous` 会被当作 `auto` 并打一条弃用日志，**不会**再动思考强度。`safe` 留给实验脚本当对照。

## 开关

闪电就是开关：点一下开，再点一下关。每个会话各自独立，点完即写；重启后按会话恢复，所以"medium + fast"回到这个会话还是"medium + fast"。没有面板、没有下拉、没有倍数估算。

思路参考了 `dsh-batch-tool-calls` 与 `dsh-ops`（批量调用、有界执行），但它们的规则是静态的，这里的宽度是**按实测调的**；不需要同时装，同时开会重复付同一份指导的钱。压缩类插件（billion-context、图片压缩、网关适配）可以共存。

## 边界

单文件、少步骤的题没有可并行的查询，快模式测不出差别 —— 这是任务形状，不是插件失效。真正的长尾是少数停不下来的调用，那由看门狗兜底；它救回多少分钟还没有单独量化。

[实测与复现方法](BENCHMARK.md) · [原理、配置与边界（参考手册）](docs/REFERENCE.md) · [改了什么](CHANGELOG.md) · [English](README.en.md)

## 许可

MIT。logo 是鲸鱼与闪电 —— 快，但不许骗自己。
