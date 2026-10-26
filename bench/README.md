# 基准：确定性长任务套件

`BENCHMARK.md` 里所有 1.5.0 的数字都由这个目录里的三样东西生成：**fixture**（`suite/`）、**跑批器**（`suite-run.py`）、**汇总器**（`report.py`）。把它们放进仓库，是为了让「快了多少、有没有掉正确性」这件事可以被别人重新跑一遍，而不是只有一段自述。

## 目录

```
bench/
  suite/<family>/        10 个家族，每个一个可独立跑的 fixture（见 suite/CONTRACT.md）
    PROMPT.txt           交给 agent 的任务描述（agent 的工作目录是空的 run 目录）
    hidden/test_<id>.py  隐藏测试，agent 看不到，跑完一轮由 runner 复制进去执行
    ref/<entrypoint>     参考实现，必须 100% 通过隐藏测试
    meta.json            id / entrypoint / minSteps / maxSteps / seed（可选起始仓库）
  arms/<arm>.yml         每个臂一行 fast-mode 配置，作为 `dsh bench --patch` 的补丁
  suite-run.py           跑批：一次 (task, pair, arm) 一行 JSON，断点续跑
  report.py              汇总：总量、分家族、逐对中位、尾部、门禁判定
  results/suite-*.jsonl  上面三块主实验的原始行（可重算 BENCHMARK 的每个数字）
```

## 协议（为什么数字能拿来比）

1. **一个单元 = 一次完整任务。** 一个 turn 跑完，隐藏测试事后执行。判定只看隐藏测试，不看模型自己说「做完了」。
2. **ABBA 配对。** 第 `p` 对里奇数对按 `--arms` 给定顺序跑，偶数对倒序。机器负载在块内漂移时，两个臂在时间上对称分布。
3. **只统计完整单元。** 总量只加「所有臂都在该单元里跑完且隐藏测试全绿」的那些 `(task, pair)`；被剔掉的单元、红掉的运行都单独列出来，不参与比值。
4. **门禁规则。** 基线绿、某个臂红 ⇒ 该臂**不合格**，不许做默认值，哪怕总量更快。这是「宁慢不降质」的可执行版本，`report.py` 会打印 `GATE VIOLATIONS`。
5. **指标是整任务总量**：墙钟（含排队/等待）、输出 token、步数。逐对中位只是辅助，不做结论。
6. **重跑覆盖。** 同一单元出现多行时取最后一行（`--dedupe last`，默认）；想复盘重跑前的块用 `--dedupe first`。
7. **断点续跑。** 结果追加写入 `results/suite-<tag>.jsonl`，已存在的 `(task, pair, arm)` 会跳过，所以 app 重启、机器休眠都不会毁掉一整块。
8. **运行目录要离 fixture 远。** run 目录默认放 `$TMPDIR/dsh-runs/`（macOS 上是 `/var/folders/.../T/`）。这条协议修补过两次：先是 run 目录在仓库内（`bench/.runs/`，fixture 只隔两层 `../../suite/<task>/hidden`，探索型运行读到过答案）；后来 run 目录搬到 `/tmp`，但 `/tmp` 里留着上一轮的 fixture 镜像 `/tmp/fm-bench/suite/`，一次 `migrate` 运行列了 `/tmp` 就找到它，读了 `hidden/test_migrate.py` 和 `ref/migrate.py`（`W1` 里被 canary 抓到，那一行已作废）。现在：任何 `bench/suite` 的外部副本都不许留在临时目录，run 根在 OS 临时根下。每次运行结束会扫自己的会话记录，命中 `/hidden/`、`/ref/`、`bench/suite/`、`fm-bench/suite`、`MANIFEST.json` 就在行里记 `leak: true`，这类行必须丢弃重跑。`report.py` 默认会删掉它们并打印 `leak: dropped`。
9. **步数与 token 只算本会话。** `~/.dsh/fast-mode-metrics.jsonl` 是全机共享的；旧实现按字节窗口切分，会把同一时刻别的会话（例如正在交互的会话）的行算进来，`steps` 因此虚高（实测一次约 12 步的运行被记成 156 步）。现在按 run 目录对应的 session id 过滤：`steps` 是精确值，`stepsRaw` 保留旧窗口值，`exact` 说明是否命中 session id。墙钟由 runner 直接计时，不受影响。

10. **判分在产物目录的副本里做。** 任务可能把自己的工作目录改成只读（`shellops` 家族真的会 `chmod -R a-w`），旧写法直接把隐藏测试写进产物目录，于是 `EACCES` 让整块批次中断（`W3` 在 31/60 行处崩过一次）。现在 `verify()` 先 `copytree` 到临时目录、跑完删掉，隐藏测试与测试产生的文件都不会落进被统计的产物里。
11. **一块对应一个 fixture 摘要。** `bench/MANIFEST.json` 的 `aggregate` 是整套 fixture 的 sha256，跑批器开跑前校验，对不上就 `fixture drift` 拒绝运行。改过题面/隐藏测试后必须先重生成摘要，新旧摘要的批次不要混在一起报数。`W3` 是 `2699cd64…`，`W4` 起是 `2d7546f8…`（`ledger` 题面补明系数按 Decimal 解析）。

12. **跑批期间对模型隐藏判分与参考解。** 模型和跑批器用同一个用户、同一台机器，用户能读的路径模型都能读。`W5` 的 `shellpipeline p1 bv15` 就从临时工作目录一路 `find` 到仓库，读了 `hidden/test_shellpipeline.py` 和 `ref/`（这一行已按泄漏剔除，不计入任何比值）。现在跑批器开跑前先把每个任务的 `hidden/`、`ref/` 改成 `chmod 000`：题面和测试模块此时已读进内存，`verify()` 从内存把测试写进临时副本再判分，`seed` 复制不受影响；块结束、`SIGINT` 或 `SIGTERM` 时恢复原权限。仓库内旧的 `bench/.runs/` 已删除并写进 `.gitignore`，仓库外的历史批次归档也一并置为不可读。泄漏哨兵（`LEAK_MARKERS`）保留，任何一块出现泄漏行都必须点名，不能静默丢弃。

13. **一个臂必须先证明自己的提醒真的到过模型，才能拿来比。** `W8b` 的 `pp16` 与 `W5` 的 `bv15` 都栽在这上面：跑批正常、门禁全绿、数字齐全，但提醒一条都没下发，于是「臂」和「默认」其实是同一个东西，差值只是噪声。判据分两层：① 跑批器/插件日志里出现该指令的 `directive=<kind>`；② 该次运行的会话记录里出现该指令的下发文案（例如 `that step sent a whole file`）。两层都要有，缺一层就当**未测**，不能当「证伪」也不能当「变慢」。改完这类机制的代码之后，先在单格上验证「修复前 0 次、修复后 ≥1 次」，再开整块。
14. **一次性提醒只能由真正投递的那一次消耗。** 同一步里调度结果会被多个钩子读取（动手前的投递点、系统提示解析、策略钩子），只有投递点会显示提醒。只读的调用方必须传 `{emit: false}`，否则它们会把「已发」标记写掉却不显示——提醒在日志里像发过，在会话里根本没有。`index.js` 里三处 `autoSchedule` 调用：只有 `agent/pre-step` 那处投递，另外两处是只读。

15. **先量一个机制的余量，再为它开一块。** 新机制上线前先在已有会话记录上估值：它要替代的那类动作在一次运行里占多少。`workspaceMap` 就是这么定下来的——W8b 的 `def15` 会话里 `ls`/`find`/`cat`/`grep` 这类探索调用 79/221（35.7 %），一个会话前两次调用里 40 % 是它，中位 11.5 次调用/会话；相比之下整文件重写重复率只有 0.8 %（`preferPatch` 的上限），精确重复调用 2.1 %（去重没有余量）。余量不足一个百分点的机制不值得用 20 格去测，先在 transcript 上算清楚能省多少。
16. **工作目录落地有先后，空读不能记成「已发」。** 基准的 fixture 在会话建好之后才拷进运行目录，所以第 1 步读到的目录是空的；`workspaceMap` 因此只有在真正建出清单后才标记为已发，空读留到下一步重试（`MAPDBG4` 上第 1、2 步为空，第 3 步建出 291 字符的清单）。一次性提醒如果在这一层被消耗掉，整臂就会像没下发一样安静。

16. **投递审计用脚本，不用眼数。** `python3 bench/audit-delivery.py --tag W10 --needle "Auto map: one inventory"` 按「任务 × 对 × 臂」列出该文案在会话记录里出现的次数：对照臂必须 0、处理臂必须 ≥ 1，处理臂某格 0 就把那格记成**未测**。W10 的结果是 10/20 命中（10 个 `map15` 全 1、10 个 `def15` 全 0），一句命令就能复核，不用再逐目录 grep。

## 怎么跑

```bash
# 一条命令跑一块：10 个家族 × 2 个臂 × 3 对 = 60 次运行（约 1.5–2 小时）
python3 bench/suite-run.py --tasks codebase,codeimpl,csvpipe,debugfix,ledger,migrate,perfrefactor,shellops,shellpipeline,stategraph \
    --arms off,def15 --pairs 3 --tag LOCAL1

# 汇总（--baseline 必填；--arm 不给就报所有臂）
python3 bench/report.py --files bench/results/suite-LOCAL1.jsonl --baseline off
```

依赖与约定：

- macOS 上的 DeepSeek Harness 应用；默认路径写在 `suite-run.py` 顶部，可用 `--dsh-exe` / `--dsh-cli` 或环境变量 `DSH_BENCH_EXE` / `DSH_BENCH_CLI` 覆盖。
- 模型凭据从 `COMPANY_LLM_TOKEN` 或 `~/.dsh/.credentials.yaml` 的 `refs.COMPANY_LLM_TOKEN` 取。
- 每轮运行的逐步数据追加在 `~/.dsh/fast-mode-metrics.jsonl`；`suite-run.py` 按本次运行的 session id 切出步数与 token（`stepsRaw` 是旧的字节窗口口径）。
- 单轮上限 1500 秒，超时记为 `exit: -9`，该单元判红。

## 已发布实验（本目录可复算）

> **撤回（2026-10-26）**：下表前三块（`V15`/`TA3`/`TA4`）的数字全部作废。两个测量缺陷：运行目录曾在仓库内，会话能读到 `../../suite/<task>/hidden` 与 `ref/`；指标按字节偏移切片，把同机器其他会话的行算进来（12 步被记成 156 步）。数字保留仅为记录，**不要引用**。

| tag | 设计 | 状态与结果 |
|---|---|---|
| `V15` / `TA3` / `TA4` | 见旧记录 | **已撤回**（fixture 泄漏 + 跨会话指标混合） |
| `W1` | 6 家族 × 2 对，`off`/`def15`/`odt15` 三臂 | 干净复测首块：36 次运行、12 个完整格、1 行泄漏作废、1 红（`ledger` p1 `def15` 21/22）。`def15` 总和 **0.65× 墙钟 / 0.68× 输出 / 0.64× 步数**（10 个过门禁的格）；单格中位 **0.98×**。`odt15` 0.85× / 0.83×（常开“压缩输出”只有微弱收益，且是步数带来的，不是 token） |
| `W3` | 10 家族 × 3 对，`off` vs `def15` | **当前声明来源**：60 次运行、30 个完整格、0 行泄漏、60/60 全绿。`def15` 总和 **0.72× 墙钟 / 0.74× 输出 / 0.71× 步数**；逐格墙钟中位 **0.64×**、均值 0.84×、90 % 区间 [0.59, 0.79]、30 格里 24 格更快。`off` 3434.7 s / 591 244 token / 390 步 → `def15` 2472.5 s / 439 708 token / 276 步。批次中途因 `shellops` 把产物目录 `chmod` 成只读、判分 `EACCES` 中断过一次（31/60 行），修好判分后从断点续跑补齐。 |

`W1` 的总和比与单格中位差得很远（0.65× vs 0.98×），而 `W3` 把两者收拢到 0.72× / 0.64×：**总和比被少数反向尾部抬起，单格中位代表典型收益，两个必须一起报**，只报一个都会误导。`W3` 用的是旧版 `ledger` 题面（摘要 `2699cd64…`）；`ledger` 题面在 `W3` 之后补明了「规则里的系数/偏移按 Decimal 原样解析」，摘要变为 `2d7546f8…`，`W4` 起全部用新版题面，因此 `W3` 的 `ledger` 三格与之后的批次不逐字可比（两臂看到的是同一份题面，结论方向不变）。

```bash
python3 bench/report.py --files bench/results/suite-W1.jsonl --baseline off
python3 bench/report.py --files bench/results/suite-W3.jsonl --baseline off
```

`report.py` 会把红行与门禁违规逐条列出来，不做静默剔除；已撤回的 `suite-{SG1,SG2,V15,TA3,TA4}.jsonl` 不再保留在仓库里。

## 加一个家族

照 `suite/CONTRACT.md` 写：`PROMPT.txt`（规格完整到只有一个合理解）、`hidden/test_<id>.py`（≥ 12 条断言，参考实现全绿、改坏一个边界必须红）、`ref/`、`meta.json`（10–25 步难度）。然后把这个家族加进跑批的 `--tasks`，至少在两个臂上各跑 6 对，再看 `report.py` 的门禁那一行。

## 读这些数字时要知道

- **绝对墙钟不可跨日比较**：机器是共享的，本轮期间同机还有另一个基准在跑（约 20 load / 12 核）。比值与同单元配对是有效的，绝对值不是。
- **门禁只覆盖隐藏测试**：解释质量、代码风格、可维护性不在断言里。
- **家族是合成的**：10 个家族覆盖写文件、读文件、状态机、shell 运维、调试和性能重构，但不等于你的真实仓库。
- **总和比与单格中位必须一起看。** `W1` 里 `def15` 总和 0.65×、单格中位 0.98×：加速集中在少数「基线自己绕远」的格子上。只报总和会把少数长尾当成人人受益；只报中位会抹掉真实存在的大幅加速。两个都写，并给出格数。
