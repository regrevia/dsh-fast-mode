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
| t1: 8 files summarised | 14.9 s → 8.8 s | 1.86× | 0.86–3.77 |
| t2: 40 independent files counted | 5.8 s → 6.0 s | 0.98× | 0.82–1.34 |
| t3: 6 directories summed (shell-heavy) | 8.5 s → 6.6 s | 1.77× | 0.41–2.19 |
| t4: 12 modules audited | 9.1 s → 11.0 s | 1.03× | 0.55–1.19 |
| t5: 12 modules × 5 files, hot symbol | 6.8 s → 7.6 s | 1.07× | 0.43–1.35 |
| t6: 24 log files totalled by level | 8.7 s → 5.6 s | 1.43× | 1.00–2.57 |
| t7: 18-node dependency chain (serial) | 4.4 s → 4.3 s | 1.06× | 0.76–1.30 |
| t8: 16 manifests, duplicate deps | 6.9 s → 5.4 s | 1.29× | 0.98–1.61 |

**All 43 pairs: median speedup 1.09×, CI 1.03–1.33×, 30/43 pairs faster, mean 1.26×, mean steps 5.5 → 4.7.** Gains concentrate on "gather the known target set in one block" and "independent shell jobs in one block" (t1 1.86×, t3 1.77×, t6 1.43×, t8 1.29×); t2/t4/t7 are deliberate no-op controls (aggregate, serial, must-be-serial) at about 1.0×. The CI no longer crosses 1, but with 5–8 pairs per task treat the direction as credible and the per-task multiple as approximate.

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
