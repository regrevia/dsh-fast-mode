<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>Same thinking effort, fewer round trips.</b><br>
  Fast mode never touches the model, the thinking effort, or the request protocol —
  it just makes each step take fewer trips, say less, and get stuck less.
</p>

<p align="center">
  <a href="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/regrevia/dsh-fast-mode/releases"><img alt="release" src="https://img.shields.io/github/v/release/regrevia/dsh-fast-mode"></a>
  <img alt="deps" src="https://img.shields.io/badge/dependencies-1%20(schemastery)-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <a href="README.md">中文</a>
</p>

---

## The principle

A step costs two things: **about 720 ms of fixed round trip**, plus **about 6.6 ms per output token** (`ms = 720 + 6.63 × outputTokens`, 689 steps, R² = 0.93), plus tool wait. Thinking effort is not a variable in that ledger — reasoning tokens measured 0, so lowering effort buys no time and only makes the answer shallower. That is why the `agent/request` hook in 1.0.0 is a pass-through: **whatever thinking depth you chose is what every request gets.**

Three things do move the number: **packing independent tool calls into one step** (pay the fixed cost fewer times), **trimming narration without touching the answer**, and **putting a cancellable ceiling on foreground commands** (an unbounded `tail` or server start can eat minutes). Parallel width 2–8 is chosen by a scheduler from how the last few steps actually went: 4 by default, widening when steps go well, narrowing on errors or stalls.

## The conclusion

- Single-file, few-step tasks (HumanEval, AIME and friends) have nothing to parallelize, so fast mode **shows no measurable difference**: in the 0.8-era runs every gear landed within 0.95×–1.09× of the control, i.e. noise.
- The −40 % step-time result from 0.8 does **not** transfer to 1.0: those gears also lowered thinking effort, and that lever has been deleted. 1.0 keeps only fan-out, output discipline and stall protection, and **has not yet been A/B measured at scale** — so we do not claim "40 % faster".
- What we can honestly promise is the mechanism: same thinking effort, same answer quality, possibly more tokens (reading several places at once), and fewer steps — when the task really has independent queries to fan out.

The full derivation, every control and the half that did not reproduce are in [BENCHMARK.md](BENCHMARK.md), including the ledger for why lowering effort cannot help.

## Using it

1. **Install**: DSH desktop → plugin manager → install bundle, target `github:regrevia/dsh-fast-mode`. Terminal equivalent: `pnpm add github:regrevia/dsh-fast-mode --dir ~/.dsh/profiles/desktop`.
2. **Turn on**: reload the page, click the small bolt next to the composer, flip the switch. There is no gear to pick — the scheduler decides the width per step.
3. **It applies**: the next request, no restart and no new conversation. The switch is per conversation.

```yaml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
      config:
        enabled: true   # off by default; this line is the real switch
        gear: auto      # the only meaningful gear: the scheduler
```

Legacy `fast` / `turbo` / `max` / `ludicrous` values resolve to `auto` and log a deprecation warning; they will **not** touch your thinking effort. `safe` remains for experiment scripts as a control arm (fixed width 2, no call ceiling, no prompt section).

## The switch

The bolt *is* the switch: one click on, another click off. No popover, no dropdown, no gears, no multiplier estimates — those choices no longer exist. Every conversation keeps its own state, written on click and restored after a restart, so "medium + fast" comes back as "medium + fast" in that conversation. What makes it faster and what it changes live in the plugin description, not in the composer.

Do not enable it together with `dsh-batch-tool-calls` or `dsh-ops` — their prompt guidance overlaps, so both would be paying twice for the same advice. Compression plugins (billion-context, image compression, gateway adapters) compose fine: one shrinks the input, the other shrinks the round trips. Details in [docs/REFERENCE.en.md](docs/REFERENCE.en.md).

## What's next

- **A/B on multi-file tasks**: fan-out only pays when a step has several independent queries. The next comparison moves to multi-repository, multi-file work instead of more single-file problems.
- **How much stall protection actually saves**: the ceiling is policy plus adaptation today; we have not measured the minutes it prevents.
- **Real TTFT**: we measure request-level latency now; it only becomes true TTFT once streaming signals are wired in.

## More

[Measurements and reproduction](BENCHMARK.md) · [Principle, configuration, boundaries (reference)](docs/REFERENCE.en.md) · [What changed](CHANGELOG.md) · [中文](README.md)

## License

MIT. The logo is a whale with a lightning bolt — fast, but not allowed to fool itself.
