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

## 怎么跑

```bash
# 一条命令跑一块：3 个臂 × 2 个家族 × 6 对 = 36 次运行
python3 bench/suite-run.py --tasks codeimpl,shellops --arms off,def15,fl10 --pairs 6 --tag LOCAL1

# 汇总（--baseline 必填；--arm 不给就报所有臂）
python3 bench/report.py --files bench/results/suite-LOCAL1.jsonl --baseline off
```

依赖与约定：

- macOS 上的 DeepSeek Harness 应用；默认路径写在 `suite-run.py` 顶部，可用 `--dsh-exe` / `--dsh-cli` 或环境变量 `DSH_BENCH_EXE` / `DSH_BENCH_CLI` 覆盖。
- 模型凭据从 `COMPANY_LLM_TOKEN` 或 `~/.dsh/.credentials.yaml` 的 `refs.COMPANY_LLM_TOKEN` 取。
- 每轮运行的逐步数据追加在 `~/.dsh/fast-mode-metrics.jsonl`；`suite-run.py` 用文件偏移切出本次运行的步数与 token。
- 单轮上限 1500 秒，超时记为 `exit: -9`，该单元判红。

## 三块已发布实验（本目录可复算）

| tag | 设计 | 单元 | 结果 |
|---|---|---|---|
| `V15` | 9 家族 × 6 对，`off`/`def15`/`fl10` 交错 | 54 | `def15` 0.86× 墙钟 / 0.95× 输出；`fl10` 0.78× / 0.79× |
| `TA3` | 同上，换成 `off`/`fl10`/`open15` | 51 | `fl10` 0.66× / 0.69×；`open15` 0.68× / 0.68×；两臂都因门禁不合格 |
| `TA4` | 5 家族，`def15` vs `open15` 交错 | 30 | `open15` 1.03× 墙钟 / 0.99× 输出；`shellops` p7 门禁不合格 |

```bash
python3 bench/report.py --files bench/results/suite-V15.jsonl --baseline off
python3 bench/report.py --files bench/results/suite-TA3.jsonl --baseline off
python3 bench/report.py --files bench/results/suite-TA4.jsonl --baseline def15
```

三块各自还留下 `--dedupe first` 下的旧块（同一单元重跑前）可供对照；`report.py` 会把红行与门禁违规逐条列出来，不做静默剔除。

## 加一个家族

照 `suite/CONTRACT.md` 写：`PROMPT.txt`（规格完整到只有一个合理解）、`hidden/test_<id>.py`（≥ 12 条断言，参考实现全绿、改坏一个边界必须红）、`ref/`、`meta.json`（10–25 步难度）。然后把这个家族加进跑批的 `--tasks`，至少在两个臂上各跑 6 对，再看 `report.py` 的门禁那一行。

## 读这些数字时要知道

- **绝对墙钟不可跨日比较**：机器是共享的，本轮期间同机还有另一个基准在跑（约 20 load / 12 核）。比值与同单元配对是有效的，绝对值不是。
- **门禁只覆盖隐藏测试**：解释质量、代码风格、可维护性不在断言里。
- **家族是合成的**：10 个家族覆盖写文件、读文件、状态机、shell 运维、调试和性能重构，但不等于你的真实仓库。真实任务里写密集家族的加速本来就不稳定（`migrate` 1.02×、`codeimpl` 1.09×、`perfrefactor` 1.33×）。
