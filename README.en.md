<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>Same thinking strength. Speed only where reads can run together.</b><br>
  Wide when there is evidence, native when there is not; no request fields are added or changed.
</p>

<p align="center">
  <a href="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/regrevia/dsh-fast-mode/releases"><img alt="release" src="https://img.shields.io/github/v/release/regrevia/dsh-fast-mode"></a>
  <img alt="deps" src="https://img.shields.io/badge/dependencies-1%20(schemastery)-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <a href="README.md">中文</a>
</p>

---

## What it does

A step costs round-trip overhead × steps + decode time × output tokens + tool wait. Model and thinking strength are not in that equation, so fast mode only moves three programmatic quantities:

- **Parallel fan-out.** The scheduler asks whether this step is "several reads of different targets"; only then does it go wide (up to 8) and remember that shape across turns. Write steps, single-call steps, erroring or stalled turns **stay native** — the whole batching section is not rendered, so it costs no input tokens.
- **Output discipline.** It trims process narration (no call previews, no restating results, no progress reports); the final answer is untouched.
- **Stall watchdog.** Shell/script calls get a 120–300 s adaptive cap; a stuck call is cancelled and "change the approach" is written back into the context.

No model switch, no `reasoningEffort` rewrite, no request-field injection (`service_tier`, `max_tokens`, anything like them). While the mode is on, the model's input carries this plugin's own scheduling guidance and reminders — that is the mechanism; switch the mode off and they are gone. DeepSeek's official API, an OpenAI-compatible relay, a self-hosted gateway, Anthropic routes — all work the same.

## Three words, defined

- **Wall clock**: end-to-end time from the task being issued to the headless process exiting, including model latency, tool waits and plugin overhead. Every "X s" below is this.
- **Rate**: the reciprocal of wall clock (1/wall). 10 s → 8 s is a 1.25× rate.
- **Speedup**: `wall(off) / wall(on)`. **Above 1 means faster**: 1.28× means 22 % less time; 0.8× means 25 % slower. A 95 % CI that crosses 1 means "indistinguishable from off".

## Measured

**Toggle it on and the headline is: about 18% faster in total, and 25–30% faster on the shapes it fits.** That is every clean block with an `off` anchor pooled (12 blocks, 138 valid pairs, 10 task families; recompute with `python3 bench/pool.py`): total wall clock **0.823×** (18% less), output tokens 0.818×, steps 0.806×, per-cell median 0.799×, faster in 93 of 138 pairs (sign test p = 0.0001). Bootstrapping those 138 pairs 2000 times puts the total ratio at a 95% interval of **[0.742, 0.913]** (9% to 26% faster), the per-cell median at [0.703, 0.885], and the geometric mean at 0.825× (interval 0.753–0.900) — "about 18%" is a point estimate, not a floor. The only quality statement at the same denominator: hidden assertions matched cell for cell across the 138 pairs (`off` 2038/2038, default 2037/2038, the one difference being a 21/22 cell) — that is **assertion parity**, not "zero quality loss". Per-family stability and sign tests are in [BENCHMARK.md](BENCHMARK.md), section "合池的自助区间与逐任务稳定性", which also explains why per-family numbers cannot be quoted across blocks.

**When to turn it on, and when not to.** On: mid-length tasks with several artifacts and repeated re-checks — `codeimpl` 0.663x (faster in 13 of 15 pairs, sign test p = 0.007) and `shellpipeline` 0.749x (p = 0.039), with `stategraph` 0.708x, `shellops` 0.748x, `codebase` 0.808x and `migrate` 0.822x on the same side but with too few pairs to stand alone. Off: one-to-five-step repairs and data reshaping — `debugfix` 1.032x (output actually 1.29x longer) and `perfrefactor` 1.009x, where the injected reminder cannot pay for itself. `ledger` 0.915x and `csvpipe` 0.982x are a wash. The switch is the lightning bolt per conversation; it remembers your last choice and applies from the next request.

**1.5.0 ships no step-based finish line by default.** `finishLineSteps` and `stepBudget` both default to `0`: there is no "remind me at step 10" and no "stop at step 30". When to finish is decided by task state and completion evidence — repeating an already-passing check verbatim against the same artifact suggests reusing the result and spending the step on what is left; several steps with no new result suggests changing the method (a reminder only, it never ends the turn); a stuck tool is cancelled by the watchdog and awaited until it really stops. A finished task is reported normally; a reminder never votes to stop for you.

**1.5.1 clean rebaseline (10 families, 30 complete units, hidden tests 60/60 green).** Totals over whole completed tasks with no runs dropped except rows that leaked fixture material: off **3434.7 s / 591 244 tokens / 390 steps**; the default arm **0.72× wall / 0.74× output / 0.71× steps**; per-cell median **0.64×**, mean 0.84×, 90% interval [0.59, 0.79]. The gain sits in tasks that otherwise re-run the same check (`migrate` 0.45×, `shellops` 0.57×, `codebase` 0.55×, `stategraph` 0.64×, `ledger` 0.64×); short tasks are unstable — `perfrefactor` 1.18×, `csvpipe` 1.12×, and `debugfix` wrote 2.01× the output — because they have no repeated verification to save and the reminder itself costs a turn. This round also fixed two measurement defects that distorted the old numbers (run directories used to live inside the repo; metrics used to be sliced by byte offset). The old `0.86×` is retracted; see `1.5.1` and `1.5.0 rebaseline (retracted)` in [BENCHMARK.md](BENCHMARK.md).
**Replication block W5 (2026-10-26, 19 complete units).** Three arms compared inside one block: `off` 1855.5 s, the default arm 0.73× wall / 0.77× output / 0.89× steps, matching 0.72× from 1.5.1. The `batchVerify` arm in the same block recorded 0.84×, but its notice **was never actually delivered** in any of the 20 sessions (0 hits when searched session by session), so `batchVerify` was **untested** then — not slower and not falsified. It was later retested with the wiring fixed and **dropped**: `codeimpl` 8 pairs 1.478×, `shellpipeline` 8 pairs 0.956×, pooled 16 pairs **1.188×**, median 1.148×, only 7/16 faster, all green and the notice verifiably delivered in 8/16 sessions. See the BV8 section of [BENCHMARK.md](BENCHMARK.md). One row leaked (`shellpipeline` p1 `bv15` read the hidden test and the reference solution) and is named and excluded; the runner now makes `hidden/` and `ref/` unreadable for the duration of a block. See "复现块 W5" in [BENCHMARK.md](BENCHMARK.md) and protocol item 12 in [bench/README.md](bench/README.md).
**Replication block W7 (2026-10-26, 17 valid units).** The default arm measured **0.73×** wall / 0.75× output / 0.59× steps (longest cell 36 steps → 17), matching 0.72× in 1.5.1 and 0.73× in W5; the three blocks pool to **0.74×** over 65 valid units. `openBatch` in the same block was 0.91× and 1.136× head-to-head against the default, so W6's 0.77× did not replicate and it is **dropped**. The block also produced 7 crash rows (`exit=1`, 1 step, 0 output at session startup) which voided 3 units, named in the doc; from this block on a unit only counts when `exit == 0 && steps >= 1 && output > 0 && grading completed && no leak`, so "all green" always means all valid units green (1.5.1 29/29, W5 19/19, W7 17/17). See "复现块 W7" in [BENCHMARK.md](BENCHMARK.md).

**Screen W10 + replication W11 (2026-10-26, 23 valid units combined): `workspaceMap` only half delivered, stays off by default.** 1.5.2 adds one knob, off by default: before the first action the harness hands the model a one-shot inventory of the working tree (depth 2, ≤60 entries, dependency and build directories skipped) so it does not have to spend a step listing files itself. Both blocks compare it with `def15` inside the same block: across 23 valid units **wall 0.927×, output 0.896×, steps 1.099×**, per-cell median 0.791×, 13/23 faster, zero gate reds. Half of the mechanism is confirmed: output really is 10 % lower (0.90× and 0.89× in the two blocks). But steps rise 10 % and the tail gets worse — p90 559 s versus 369 s and max 714 s versus 510 s, with the same reverse cells in both blocks (`stategraph` at 1.4×–1.77× in each). **Because a long task must not get slower, it is not promoted**: the 1.5.2 default behaves exactly like 1.5.1, and the knob ships with its numbers. The same round accounted for the remaining headroom: repeated verification is only 6 % of wall, tool results have a 1.2 kB median, rewriting an already written file is 0.8 % — so **0.67× is not reachable inside the "do not touch `reasoningEffort`, add no request fields" constraints**. See "复现块 W11" and "0.67× 在现有约束下的可达性" in [BENCHMARK.md](BENCHMARK.md).

**Pre-release re-check (REL16, 10 units)**: the then-current default was run against `off` once more, purely to ask whether shipping had damaged quality. Both arms came back **10/10 green with identical per-task pass counts** (14/14, 22/22, 18/18, 10/10, 14/14) and no leaks; wall summed to **0.967×**, per-cell median 0.999×, faster in 3/5 cells. That is one pair at n=5, a wider noise band than the pooled total, so it is reported as a re-check and does not replace the pooled 0.798× figure — see [BENCHMARK.md](BENCHMARK.md).

**Faster configurations that failed the gate stay ablation arms only.** `fl10` (a step-10 finish reminder) is the fastest configuration measured, but it suppresses re-verification after the tests pass and once went red on a cell where both the baseline and the default were green, so it stays an ablation arm (those numbers came from a retracted batch and are kept only as a decision record). `openBatch` (one opening reminder to put independent calls in one block) beat the default 0.77× vs 0.93× in the W6 screen, but an independent W7 rerun brought it back to 0.91× and 1.136× head-to-head — **not replicated, so dropped**. `batchVerify` was 0.84× against the default inside W5 with the notice never delivered (untested then); with the wiring fixed the BV8 block measured **1.188× slower** over 16 pairs (`codeimpl` 1.478×, `shellpipeline` 0.956× — inconsistent direction), so it is **dropped** and stays `false`. **The defaults therefore stay as they are**: no step-based finish line, `stepBudget: 0`, and all three mechanisms off. Per-cell data and gate results are in the `H2`/`H3` sections of BENCHMARK.

**The retired default: `finishLineSteps: 10`.** On 7 families and 14 pairs it produced a median **1.86×**, 13/14 pairs faster (sign test **p = 0.002**), output **−52 %**, steps **−10.0**, hidden tests **14/14 green**. That line was genuinely fast, and the cost was real too: it fired at step 10 even on a long task that was still making progress. So 1.5.0 demotes it to an ablation arm (`fl10`), off by default.

**Honest history:** after 1.4.1 grew the sample from 5 pairs to 76, the 1.4.0 1.86× fell to a median **1.06×** (45/76 pairs faster) — small-sample multiples are noise. Short tasks (1–5 steps) have little to save; the gain appears with step count.

**One-line conclusion:** speed-up was observed on the limited tasks measured; no regression was observed on their hidden assertions. That is not a general quality guarantee.

Every raw number, the step buckets, the rejected candidates and the failure modes: [BENCHMARK.md](BENCHMARK.md). The fixtures, runner, report tool and the three raw result sets live in [bench/](bench/README.md); running `bench/report.py` reproduces the same totals, per-family table and gate violations.

## Install

1. **Install** (any one):
   - **npm** (recommended): plugin manager → install bundle, target `dsh-fast-mode`; terminal equivalent `pnpm add dsh-fast-mode --dir ~/.dsh/profiles/desktop`. Package page <https://www.npmjs.com/package/dsh-fast-mode>.
   - **GitHub**: target `github:regrevia/dsh-fast-mode`; terminal equivalent `pnpm add github:regrevia/dsh-fast-mode --dir ~/.dsh/profiles/desktop`.
   - **Market index**: Plugins → Discover → index sources, add `https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/market/index.json` (format 1, checked with the host index parser). The curated-list submission is [#9650](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9650); once merged, dshmarket and the site pick it up automatically and no manual source is needed.
2. **Enable**: reload the page, click the small lightning bolt next to the composer. No mode to pick.
3. **Takes effect** on the next request — no restart, no new conversation.

```yaml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
      config:
        enabled: true   # off by default; this line is the real switch
```

Legacy `fast` / `turbo` / `max` / `ludicrous` values are read as `auto` with a deprecation log; they **never** lower thinking strength.

**Troubleshooting**: a task cut short by `Stop working now and report instead` means an install at 1.1.0 or older — that build stops unconditionally at 30 steps in a turn or 12 steps without new output. From 1.5.0 nothing wraps up on a step counter by default: no progress changes the approach instead of ending the turn, and a hard stop exists only when you set `stepBudget` yourself. Upgrade and restart once (host-side code loads at start).

## The switch

The bolt is the switch: one click writes on/off, per conversation, restored on reload. No panel, no dropdown, no multiplier estimate.

The idea draws on `dsh-batch-tool-calls` and `dsh-ops` (batched calls, bounded execution), but their widths are static while this width comes from the conversation's own call evidence; do not install all three. Context-compaction plugins coexist.

## Limits and next step

There are three programmatic signals now: the request's own wording (serial / fan-out / shell, see `src/shape.js`), whether the last step's calls were all read-only with pairwise-distinct targets, and how many read-only steps in a row. The first lets a single-turn task choose its width on the very first request.

Online selection (UCB / Thompson) is **not** in this version. The blocker is not networking — a bandit is local arithmetic and adds no request and no round trip; its cost is negligible. The blocker is reward noise: across our paired runs, within-task variance swamps the width effect, and feeding that to UCB would learn jitter, not policy. Once request-shape classification filters for genuinely wide samples, a discounted Thompson sampler (Gaussian prior, separate posteriors for the fan-out and unknown contexts) is the design to try — not a global UCB.

[Measurements](BENCHMARK.md) · [Reference](docs/REFERENCE.en.md) · [Changelog](CHANGELOG.md) · [中文](README.md)

## License

MIT.
