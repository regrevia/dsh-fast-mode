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

**1.5.0 ships no step-based finish line by default.** `finishLineSteps` and `stepBudget` both default to `0`: there is no "remind me at step 10" and no "stop at step 30". When to finish is decided by task state and completion evidence — repeating an already-passing check verbatim against the same artifact suggests reusing the result and spending the step on what is left; several steps with no new result suggests changing the method (a reminder only, it never ends the turn); a stuck tool is cancelled by the watchdog and awaited until it really stops. A finished task is reported normally; a reminder never votes to stop for you.

**1.5.0 rebaseline (9 families, 54 complete units, hidden tests all green).** Totals over whole completed tasks, no runs dropped: off **7142.3 s / 1 196 707 tokens / 1155 steps**; the default arm **0.86× wall / 0.95× output / 0.85× steps**; the retired `fl10` **0.78× / 0.79× / 0.72×**. The gain sits in read-heavy and from-scratch work (`csvpipe` 0.79×, `debugfix` 0.56×, `ledger` 0.73×, `shellpipeline` 0.87×, `stategraph` 0.82×); **the three write-file families show no stable speedup** (`migrate` 1.02×, `codeimpl` 1.09×, `perfrefactor` 1.33×), which is why `fl10` stays an ablation arm. On the everyday "fix bugs and add TTL plus pagination in a small repo" family the default arm is 0.84× wall and 0.79× output. Two baseline runs looped on their own; dropping them moves the default arm's wall ratio back to 0.88× — that sensitivity is in [BENCHMARK.md](BENCHMARK.md).
A same-day **9-family × 6-pair interleaved three-arm ABBA** (162 runs, 51 complete units) confirms the direction: `fl10` **0.66× wall / 0.69× output**, `open15` **0.68× / 0.68×** — but neither arm passes the gate. `fl10` goes red 21/22 on `ledger` p1 while the baseline is green, `open15` goes red 13/14 on `shellops` p7 while the baseline is green, and `openBatch` measures 1.03× wall against the default on five further families with one 325-step cell that burned 5.2× the output tokens. **The 1.5.0 defaults therefore stay as they are**; both faster configurations remain ablation arms. Per-cell data is in the `H2`/`H3` sections of BENCHMARK.

**The retired default: `finishLineSteps: 10`.** On 7 families and 14 pairs it produced a median **1.86×**, 13/14 pairs faster (sign test **p = 0.002**), output **−52 %**, steps **−10.0**, hidden tests **14/14 green**. That line was genuinely fast, and the cost was real too: it fired at step 10 even on a long task that was still making progress. So 1.5.0 demotes it to an ablation arm (`fl10`), off by default.

**Honest history:** after 1.4.1 grew the sample from 5 pairs to 76, the 1.4.0 1.86× fell to a median **1.06×** (45/76 pairs faster) — small-sample multiples are noise. Short tasks (1–5 steps) have little to save; the gain appears with step count.

**One-line conclusion:** speed-up was observed on the limited tasks measured; no regression was observed on their hidden assertions. That is not a general quality guarantee.

Every raw number, the step buckets, the rejected candidates and the failure modes: [BENCHMARK.md](BENCHMARK.md).

## Install

1. **Install**: DSH desktop → plugin manager → install bundle, target `github:regrevia/dsh-fast-mode`. Terminal equivalent: `pnpm add github:regrevia/dsh-fast-mode --dir ~/.dsh/profiles/desktop`.
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
