# 官方 SWE-bench Lite 上量一次：跑得通，量不出加速

前面两份数字都是自造任务和手挑的真实 PR。这里换一种证据：**官方 SWE-bench Lite 的题目定义**
（`princeton-nlp/SWE-bench_Lite`，300 条里的 6 条），用本机 `uv` 建环境、按官方
`FAIL_TO_PASS` / `PASS_TO_PASS` 的差分判分，再拿同一套 `audit/run.mjs` 掐两臂。

先说清楚边界，免得被当成排行榜成绩：

- **不是 leaderboard 提交**。官方评测用 `swebench/sweb.eval.x86_64.<instance>` 容器镜像和
  `swebench.harness.run_evaluation` 跑；这里是本机 venv + 直接 `pytest`，环境、依赖版本、
  判分脚本都和官方不同。这只能说明「在官方题目定义上」，不能和 60%+ 的解决率对比。
- **6 条题**，不是 300 条。选的是几个便宜仓库（pytest / sphinx / sympy）的高版本实例，
  能在一两分钟内建好环境、测试量级在几百个 node 的。
- 每题都过了差分门（见下），**没过门的一律不用**，也不拿它凑数。

## 分母是怎么来的

官方 parquet 给的 `FAIL_TO_PASS` / `PASS_TO_PASS` 不能直接当命令行用，两个坑：

1. **参数化用例的 id 被截断**。比如 `pytest-dev__pytest-11143` 的 `PASS_TO_PASS` 字段里
   `test_get_assertion_exprs[assert` 就断了——官方字段本身在 `[` 内的第一个空格处切开，
   300 条里带参数化的实例普遍如此。
2. **多数 id 不含目录前缀**。比如 `testing/test_skipping.py::...` 在本地 checkout 里要么是
   `src/_pytest/...`、要么是 `pytest/...`，直接传给 pytest 是 `UsageError`（rc 4）。

所以判分前先做**节点解析**，四级降级：

| 级 | 规则 | 用于 |
| --- | --- | --- |
| exact | 收集到的 nodeid 完全相同 | 首选 |
| prefix | `startswith` | 参数化 id 被截断，但截断处恰好是前缀 |
| suffix | `endswith` | id 少了目录前缀 |
| segment | `endswith('/' + id)` | 少了多层目录，只在路径边界匹配 |

唯一命中就采；多命中时 `p2p` 全采并记 `expanded`，`f2p` 判 `ambiguous` 整题不用。
一条都没命中的（`missing`）或 `f2p` 有歧义的（`unresolved`）**整题丢弃**。

差分门（两遍真实跑测试，不是看 diff）：

- 先跑 baseline：在 `base_commit` 上应用官方 `test_patch`，记录每个 nodeid 的状态 →
  `/Volumes/US202/swebench/baseline/<iid>.json`。
- 再打官方 gold `patch`：`f2p` 必须从红变绿，`p2p` 不许出现「base 绿、gold 之后不绿」的回归。
- base 上本来就红的 `p2p` 节点是宿主环境噪声，**排除并计数**（每题写进报告）。

门槛是**两道**：`f2p` 在 gold 之后必须全绿；`p2p` 不许出现 regression。base 上本来就红的
`p2p` 节点算宿主噪声、排除并计数（允许排除，但排除数必须写出来）——7490 有 6 个这种节点，
regression 是 0，所以收进来。过了门的 6 条：

| instance | 包版本 | Python | f2p | p2p | p2p 排除 | gold 后回归 |
| --- | --- | --- | --- | --- | --- | --- |
| `pytest-dev__pytest-11148` | 8.0 | 3.11 | 2 | 129 | 3 | 0 |
| `pytest-dev__pytest-9359` | 7.0 | 3.11 | 1 | 54 | 0 | 0 |
| `sphinx-doc__sphinx-11445` | 7.1 | 3.8 | 2 | 8 | 0 | 0 |
| `sympy__sympy-24066` | 1.12 | 3.8 | 1 | 38 | 0 | 0 |
| `pytest-dev__pytest-8365` | 6.3 | 3.9.6 | 1 | 32 | 0 | 0 |
| `pytest-dev__pytest-7490` | 6.0 | 3.9.6 | 2 | 79 | 6 | 0 |

Python 版本是逐题试出来的，不是猜的：pytest 6.x 在 3.11 上做断言重写会挂
（`TypeError: required field "lineno" missing from alias`），所以 8365/7490 用系统 3.9.6；
sphinx 4.0 那两条要 `setuptools<81` 才有 `pkg_resources`，补了也还是收不全，**没用**。
11148 的 gold 跑整体 rc 还是 1（有一个不在这题的 f2p/p2p 里的用例仍红），这题只看
f2p 变绿和 p2p 零回归。

判分脚本是 `check_agent.py`：把 agent 改过的 worktree 原样保留，只在上面应用 `test_patch`
跑一遍、再 `git apply -R` 撤回——**不清工作区**，所以 agent 的改动不会被判分自己抹掉。
exit 0 才叫修好；它是 `audit/run.mjs` 里每题的 `check`。

## 量的是什么

`audit/run.mjs`，5（后来 6）题 × 3 轮 × 2 臂：

    COMPANY_LLM_TOKEN=... node audit/run.mjs \
      --tasks /Volumes/US202/swebench/tasks.swebench.jsonl \
      --cwd /Volumes/US202/swebench/work --rounds 3 \
      --on-config compactResults=true --out /tmp/fm-swe-3r --timeout-ms 1800000

- off 臂：插件 `enabled: false`（等于没装）。
- on 臂：`enabled: true` + `compactResults=true`（发布时默认关着的那个截短开关）。
- 每臂之间串行，一次一个进程；校验命令的退出码单独记，不看模型自己说不说"修好了"。

## 结果：方向不确定，量级不到噪声

| 跑法 | 对 | 合池墙钟 | 合池输出 token | 校验 off/on |
| --- | --- | --- | --- | --- |
| 第一轮（每轮都是 off 先跑） | 15 | 1.317× [0.988, 1.747]，分不开 | **1.208×** [1.006, 1.479]，反而更多 | 15/15 / 15/15 |
| 第二轮（单数轮 off 先、双数轮 on 先） | 15 | 0.783× [0.620, 1.003]，分不开 | 0.922× [0.761, 1.132]，分不开 | 15/15 / 15/15 |
| 两轮合池 | 30 | 1.016× [0.823, 1.261]，分不开 | 1.055× [0.915, 1.229]，分不开 | 30/30 / 30/30 |
| 第三轮：只开 `enabled: true`（不带截短） | 15 | 0.881× [0.660, 1.162]，分不开 | 1.081× [0.818, 1.447]，分不开 | 15/15 / 15/15 |
| 第四轮：6 条题（含 7490） | 18 | 0.912× [0.676, 1.246]，分不开 | 1.007× [0.895, 1.136]，分不开 | 15/18 / 15/18 |
| 同上，去掉两臂都没修好的 7490 | 15 | 0.993× [0.706, 1.422]，分不开 | 1.032× [0.914, 1.177]，分不开 | 15/15 / 15/15 |

第一轮和第二轮**方向相反、量级都是三成上下**，合池之后贴到 1.0。这不是"插件没用"，
是**顺序偏差比效应大**：同一台机器上，第二个跑的臂天然吃亏或占便宜（页面缓存、GC、机器变热），
3 轮的样本分不开这个。所以我给 `audit/run.mjs` 加了**逐轮换序**（单数轮 off→on，双数轮 on→off），
报告头里写明；这两轮数据正好是加它前后的对照。

能说的话只有一句：**在这类任务上，这个开关的收益量级小于测量噪声，30 对也分不开**。
第三轮把截短开关摘掉、只留 `enabled: true`，结论一样（0.881× / 1.081×，两个区间都跨 1）——
不是截短开关一个人的问题，是这类工作负载上 fast mode 整体没有可省的东西。
第四轮把 7490 加进来做 6 条题：两臂各 15/18 通过，**同一条题（7490）两臂三轮全没修好**，
去掉它重算是 0.993× / 1.032×，还是跨 1；留着它是 0.912× / 1.007×，也跨 1。
两臂失败集合完全一样，所以这不是"插件让模型变笨"，是那条题本身在这套 prompt 下太难。

## 为什么这里没有收益（和工作负载有关，不是矛盾）

- SWE-bench 的题是"看 issue、改源码、测试变绿"。工具输出普遍只有几百到几千字，
  `compactResults` 的截短阈值（默认 8000 字）**根本没触发**——没有大输出可截。
- 这类任务的墙钟大头是模型往返和 `pytest` 本身（单次校验 0.3–2.4 s，占整轮 1%–3%），
  插件改的是写给模型的那段话，碰不到这些时间。
- 真实 PR 的 24 对能测出 0.805×，恰恰因为那些任务里有 `pytest`/`npm test` 的大段输出被截短
  （231 KB → 1.3 KB）。工作负载不同，结论就不同，这两组数字应该并排读，不能拿一组去否另一组。

## 复现

    # 1) 准备（一次性的，环境在 /Volumes/US202/swebench/work/<iid>）
    python3 /tmp/swebench/pipeline.py <iid> ...        # clone + venv + 解析 nodeid + 差分门
    # 2) 量
    COMPANY_LLM_TOKEN=... node audit/run.mjs --tasks /Volumes/US202/swebench/tasks.swebench.jsonl \
      --cwd /Volumes/US202/swebench/work --rounds 3 --on-config compactResults=true \
      --out /tmp/fm-swe-3r --timeout-ms 1800000

产物：`pairs.jsonl`（逐对原始数字）、`report.md`（合池 + 逐题 + 读法）、`arm-off/on.patch.yml`。
