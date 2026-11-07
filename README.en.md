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
  Best measured: <b>0.505x</b> wall clock, output tokens <b>−42%</b>, <b>438/438</b> checks green — <a href="BENCHMARK.md">benchmark and repro</a>.
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
| **Wall clock** | **0.505x** (about twice as fast; 26 of 30 pairs faster) |
| **Output tokens** | **−42%** (16037 → 9380) |
| **Reasoning characters** | **−51%** (42380 → 20872) |
| **Task quality** | **438/438** checks green, 30/30 runs passing |

Standard tier — Concise output, the three deliberation switches, the opening file inventory and batched reads — is the fastest setting: **0.683x** wall clock over 16 pairs across four task families (32 % saved, CI95 [0.520, 0.893]), with hidden tests 32/32 green, output tokens 0.712x and a median step ratio of 1.000x. A second block of 8 pairs (`codeimpl`, `shellpipeline`) shows steps **0.651x** [0.486, 0.804], faster in 8/8, but wall clock 0.954x [0.699, 1.339] crosses 1 — no conclusion there, so those two families are claimed for fewer steps and green quality only, not for wall clock. No single member stands on its own — the inventory alone is 0.927x, batched reads alone 1.136x — so neither is a panel switch; they ship only as part of the standard tier.

## Install

```bash
dsh plugin install dsh-fast-mode
```

Click the bolt in a conversation. Right-click it for the panel — four rows, two tiers, each affecting that conversation only.

## What the four switches do

All four are prompt-side: no request parameter, no model change, no change to completion checks. One shapes output, three shape how the turn is routed.

| Button | How it works | Default |
|---|---|---|
| **Concise output** | No call previews, no restating results, no progress reports; the final answer is not shortened | On |
| **Verify before guessing** | Read the uncertain fact once; not pure speed — it saves the retry a wrong guess costs | Off |
| **Act before explaining** | At most one line of plan; past 4000 characters of reasoning, a nudge to act on evidence | Off |
| **Nudge on repeats** | The same call again, or three identical results: one line saying to change the approach | Off |

Only verified switches are here. Four more (step cap, file inventory, batched reads, trim tool output) had panel rows until 1.7.31; none showed a stable gain alone or in a measured bundle — the step cap came out at 1.021x with its notice firing in only 3/12 turns, file inventory 0.927x, batched reads 1.136x, and trim tool output was never A/B'd alone — so they are removed from the panel rather than defaulted off. The config keys still work. The three deliberation switches were added in 1.7.29 on top of Concise output (0.526x over 15 pairs) and are loaded by the Standard tier.

## Benchmark

All three on (`trio17`) vs all off, paired per task, 4000 bootstrap resamples:

| Block | Pairs | Wall clock (geometric) | 95 % CI | Faster |
|---|---|---|---|---|
| DP17 | 12 | 0.647x | [0.501, 0.893] | 10/12 |
| DP18 | 9 | 0.491x | [0.314, 0.788] | 8/9 |
| DP20b (shipped build) | 9 | 0.372x | [0.240, 0.563] | 8/9 |
| **Pooled** | **30** | **0.505x** | **[0.401, 0.635]** | **26/30** |

On the shipped build: steps 13.2 → 6.7, wall clock 464.9 s → 173.1 s. In every block, all-three-on is the only arm whose interval stays below 1. Raw data and recompute commands are in [BENCHMARK.md](BENCHMARK.md).

## Why it is faster, and where it is not

A step costs roughly round-trip overhead × steps + decode time × output tokens + tool wait. The model is not in that equation, so this only moves programmatic quantities: fewer round trips, fewer re-reads, fewer repeated edits.

- **Some tasks get slower — do not expect a win everywhere.** 1–5 step repairs and data reshaping do not repay the hint cost (`perfrefactor` 1.18x, `csvpipe` 1.12x); implementation-shaped tasks occasionally take one extra step (one 1.04x pair in DP20).
- **Quality first.** In every accepted batch both arms produced identical hidden assertions; safety checks, destructive operations and accessibility paths always run the full validation.
- **The switch is yours.** A new conversation starts with concise output only; the three deliberation switches, the opening file inventory and batched reads load with the **standard tier**, and the conservative tier turns all of them off. No single switch has a marginal effect large enough to resolve — `ABL1`/`ABL2` intervals both cross 1 — so the panel sells two tiers, not individual switches.

Recommendation: **most of the time, turn all three on.** If you want the safest single switch, take *Verify before guessing*; for long reasoning chains take *Act before explaining*; *Nudge on repeats* alone measured 1.007x and fired 3 times across twelve sessions — harmless in the combination, not worth switching alone.

## License

MIT. Reference: [docs/REFERENCE.en.md](docs/REFERENCE.en.md). Changes: [CHANGELOG.md](CHANGELOG.md).
