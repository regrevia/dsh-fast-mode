<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>DeepSeek Harness's own fast mode: the same model, half the output, up to twice as fast.</b><br>
  Several switches you combine freely, all prompt-side: no model swap, no lower reasoning effort, no request field written.<br>
  Best measured: <b>half the total time</b>, output tokens <b>−42%</b>, <b>438/438</b> checks green — <a href="BENCHMARK.md">benchmark and repro</a>.
</p>

<p align="center">
  <a href="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/regrevia/dsh-fast-mode/releases"><img alt="release" src="https://img.shields.io/github/v/release/regrevia/dsh-fast-mode"></a>
  <img alt="deps" src="https://img.shields.io/badge/dependencies-1%20(schemastery)-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <a href="README.md">中文</a>
</p>

---

## At a glance

30 complete task pairs, same model, same settings, only three switches apart:

| Metric | Result |
|---|---|
| **Total time** | **halved** (about 50% of baseline; 26 of 30 pairs faster) |
| **Output tokens** | **−42%** (16037 → 9380) |
| **Reasoning characters** | **−51%** (42380 → 20872) |
| **Task quality** | **438/438** checks green, 30/30 runs passing |

Standard tier — Concise output, the three deliberation switches, the opening file inventory and batched reads — is the fastest setting: **32% less total time** over 16 pairs across four task families (the upper end of the interval is still below baseline, so the direction holds), with hidden tests 32/32 green, output tokens **−29%** and the step count essentially unchanged. A second block of 8 pairs (`codeimpl`, `shellpipeline`) shows **35% fewer steps**, faster in 8/8, but total time is only 5% lower and the interval crosses 1 — not a claim; those two families are credited for fewer steps and green quality only. No single member stands on its own — the inventory alone is 7% slower, batched reads alone 14% slower — so neither is a panel switch; they ship only as part of the standard tier.

## Install

```bash
dsh plugin install dsh-fast-mode
```

Click the bolt in a conversation. Right-click it for the panel — five rows, two tiers, each affecting that conversation only.

## What the five switches do

Four of them are prompt-side: no request parameter, no model change, no change to completion checks. One shapes output, three shape how the turn is routed. The fifth sits in the execution layer instead — it caps a single tool call and hands control back.

| Button | How it works | Default |
|---|---|---|
| **Concise output** | No call previews, no restating results, no progress reports; the final answer is not shortened | On |
| **Verify before guessing** | Read the uncertain fact once; not pure speed — it saves the retry a wrong guess costs | Off |
| **Act before explaining** | At most one line of plan; past 4000 characters of reasoning, a nudge to act on evidence | Off |
| **Nudge on repeats** | The same call again, or three identical results: one line saying to change the approach | Off |
| **Tool-call timeout** | A single shell-shaped call past its limit is cancelled and returned as a failed call — a fault guard, not a speed claim | On |

Only verified switches are here, with one deliberate exception: the tool-call timeout is a safety bound, so it carries no speed claim and is exempt from the "verified gain" rule. Under the Standard tier the limit starts at 120 s and stretches with the session's own latency (3× the recent P90, capped at 300 s); the Cautious tier's budget is 0. Its known cost: a legitimate long job (Gradle, `npm install`, a large test suite) can be cut at that floor — such jobs belong in the background. A cancelled signal is not proof the process group exited, and the failure message says so when it could not confirm. Four more (step cap, file inventory, batched reads, trim tool output) had panel rows until 1.7.31; none showed a stable gain alone or in a measured bundle — the step cap left total time unchanged with its notice firing in only 3/12 turns, file inventory alone was 7% slower, batched reads alone 14% slower, and trim tool output was never A/B'd alone — so they are removed from the panel rather than defaulted off. The config keys still work. The three deliberation switches were added in 1.7.29 on top of Concise output (**47% faster** over 15 pairs) and are loaded by the Standard tier.

## Benchmark

All three on (`trio17`) vs all off, paired per task, 4000 bootstrap resamples:

| Block | Pairs | Total time (vs all off) | Faster by | 95 % CI | Faster |
|---|---|---|---|---|---|
| Trio on top of Standard | 15 | 0.526 | **47%** | [0.390, 0.753] | 14/15 |
| DP17 | 12 | 0.647 | **35%** | [0.501, 0.893] | 10/12 |
| DP18 | 9 | 0.491 | **51%** | [0.314, 0.788] | 8/9 |
| DP20b (shipped build) | 9 | 0.372 | **63%** | [0.240, 0.563] | 8/9 |
| **Pooled** | **30** | **0.505** | **50%** | **[0.401, 0.635]** | **26/30** |

On the shipped build: steps 13.2 → 6.7 (49% fewer), total time 464.9 s → 173.1 s (63% less). In every block, all-three-on is the only arm whose interval stays below 1. Raw data and recompute commands are in [BENCHMARK.md](BENCHMARK.md).

## Why it is faster, and where it is not

A step costs roughly round-trip overhead × steps + decode time × output tokens + tool wait. The model is not in that equation, so this only moves programmatic quantities: fewer round trips, fewer re-reads, fewer repeated edits.

- **Some tasks get slower — do not expect a win everywhere.** 1–5 step repairs and data reshaping do not repay the hint cost (`perfrefactor` 18% slower, `csvpipe` 12% slower); implementation-shaped tasks occasionally take one extra step (one pair 4% slower in DP20).
- **Quality first.** In every accepted batch both arms produced identical hidden assertions; safety checks, destructive operations and accessibility paths always run the full validation.
- **The switch is yours.** A new conversation starts with concise output only; the three deliberation switches, the opening file inventory and batched reads load with the **standard tier**, and the conservative tier turns all of them off. No single switch has a marginal effect large enough to resolve — `ABL1`/`ABL2` intervals both cross 1 — so the panel sells two tiers, not individual switches. The third row is the exception: the tool-call timeout is a fault guard, not speed — past the per-call limit it cancels and hands control back, on by default, promising no speedup.

Recommendation: **most of the time, turn all three on.** If you want the safest single switch, take *Verify before guessing*; for long reasoning chains take *Act before explaining*; *Nudge on repeats* alone measured no change and fired 3 times across twelve sessions — harmless in the combination, not worth switching alone.

## License

MIT. Reference: [docs/REFERENCE.en.md](docs/REFERENCE.en.md). Changes: [CHANGELOG.md](CHANGELOG.md).
