<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>Same thinking strength. Speed only where reads can run together.</b><br>
  Wide when there is evidence, native when there is not; the request body is untouched.
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

No model switch, no `reasoningEffort` rewrite, no request-body injection. DeepSeek's official API, an OpenAI-compatible relay, a self-hosted gateway, Anthropic routes — all work the same.

## Three words, defined

- **Wall clock**: end-to-end time from the task being issued to the headless process exiting, including model latency, tool waits and plugin overhead. Every "X s" below is this.
- **Rate**: the reciprocal of wall clock (1/wall). 10 s → 8 s is a 1.25× rate.
- **Speedup**: `wall(off) / wall(on)`. **Above 1 means faster**: 1.28× means 22 % less time; 0.8× means 25 % slower. A 95 % CI that crosses 1 means "indistinguishable from off".

## Measured on v1.2.0 (relative only)

Same model (`deepseek-v4.1-flash`), same route, same `reasoningEffort: medium`; the only difference between arms is the plugin switch. 8 multi-file tasks × 5 ABBA pairs = 80 real headless runs, deterministic quality gate **80/80 passed** (5/5 per arm per task).

| Task (shape) | Wall: off → on | Speedup | 95 % CI |
|---|---|---|---|
| t1: 8 files, per-item table (native by rule) | 10.0 s → 9.5 s | 1.02× | 0.86–1.40 | 12 |
| t2: 40 files counted | 5.8 s → 6.0 s | 0.98× | 0.82–1.34 | 8 |
| t3: 6 dirs summed (shell) | 5.6 s → 4.9 s | 1.03× | 0.67–1.36 | 15 |
| t4: 12 modules audited (serial) | 9.1 s → 11.0 s | 1.03× | 0.55–1.19 | 5 |
| t5: 12×5 hot symbol | 6.8 s → 7.6 s | 1.07× | 0.43–1.35 | 5 |
| t6: 24 logs totalled | 8.7 s → 5.6 s | 1.43× | 1.00–2.57 | 5 |
| t7: 18-node chain (serial) | 4.4 s → 4.3 s | 1.06× | 0.76–1.30 | 5 |
| t8: 16 manifests, dupes | 6.9 s → 5.4 s | 1.29× | 0.98–1.61 | 5 |
| t9: 6 modules edited (write fan-out) | 9.6 s → 8.8 s | 0.98× | 0.73–1.59 | 8 |
| t10: 10 logs, aggregate report (mixed) | 7.0 s → 6.4 s | 1.11× | 0.84–1.39 | 8 |

**All 76 pairs: median speedup 1.06× (CI 1.00–1.15×), 45/76 pairs faster, mean 1.15×.** This is the honest number after enlarging the sample: there is **no** reliable large speedup. The 1.86× (t1) and 1.77× (t3) quoted in 1.4.0 rested on 5 pairs each; at 15 pairs they fall to 1.02× and 1.03× — a small-sample multiple is noise, not a win.

One mechanism survives: **only shapes whose step count actually drops get faster** (t3 shell fan-out 4.7→3.5 steps, t9 5.9→5.2, t10 5.1→4.9); wall time is dominated by decode tokens, so the ~0.7 s/step saved is often eaten by a larger single-step output. The 1.4×/1.3× on t6/t8 still rest on 5 pairs and should be read as provisional.

Why "accelerate only the parallel shape" has not fully landed yet: the scheduler's evidence comes from calls that have **already happened**, and these eight tasks are single-turn — they saw only the 4-wide probe of a fresh session before they finished. 1.3.0 removes that probe: the shape is read from the request's own wording instead.

Method, raw numbers and failure modes: [BENCHMARK.md](BENCHMARK.md).

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

## The switch

The bolt is the switch: one click writes on/off, per conversation, restored on reload. No panel, no dropdown, no multiplier estimate.

The idea draws on `dsh-batch-tool-calls` and `dsh-ops` (batched calls, bounded execution), but their widths are static while this width comes from the conversation's own call evidence; do not install all three. Context-compaction plugins coexist.

## Limits and next step

There are three programmatic signals now: the request's own wording (serial / fan-out / shell, see `src/shape.js`), whether the last step's calls were all read-only with pairwise-distinct targets, and how many read-only steps in a row. The first lets a single-turn task choose its width on the very first request.

Online selection (UCB / Thompson) is **not** in this version. The blocker is not networking — a bandit is local arithmetic and adds no request and no round trip; its cost is negligible. The blocker is reward noise: across our paired runs, within-task variance swamps the width effect, and feeding that to UCB would learn jitter, not policy. Once request-shape classification filters for genuinely wide samples, a discounted Thompson sampler (Gaussian prior, separate posteriors for the fan-out and unknown contexts) is the design to try — not a global UCB.

[Measurements](BENCHMARK.md) · [Reference](docs/REFERENCE.en.md) · [Changelog](CHANGELOG.md) · [中文](README.md)

## License

MIT.
