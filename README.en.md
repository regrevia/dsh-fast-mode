<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>Same task, 40% faster.</b><br>
  Not by making the model dumber — by cutting its round trips and its narration. No model change, no provider change, not one line of the request protocol.
</p>

<p align="center">
  <a href="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/regrevia/dsh-fast-mode/releases"><img alt="release" src="https://img.shields.io/github/v/release/regrevia/dsh-fast-mode"></a>
  <img alt="deps" src="https://img.shields.io/badge/dependencies-1%20(schemastery)-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <a href="README.md">中文</a>
</p>

---

## The principle: latency is a ledger

A step's cost splits into exactly two terms: **≈ 720 ms of fixed round-trip overhead** plus **≈ 6.6 ms per output token** (`ms = 720 + 6.63 × outputTokens`, fitted over 689 steps, R² = 0.93). Which is why "save thinking" saves no time on this route — reasoning tokens are 0 to begin with, and lowering effort shaves nothing off the bill.

This plugin touches only two things: **pack independent tool calls into the same step** (fewer trips) and **cut the excess prose and thinking** (less carried per trip). One step doing the work of three means the fixed overhead gets paid two times less. One term is not in that formula: **tool wait** — a single unbounded foreground command (a server, a `tail`, a heredoc that dies as a malformed response) can eat minutes, and the model usually re-issues it unchanged. Shell-style calls now carry a per-gear ceiling: on expiry the call is cancelled and the model gets told how to retry differently.

## The numbers

Same task, same model, same route, 16 sessions, 83 steps, `safe` against `turbo`:

| Metric | safe | turbo | Change |
|---|---|---|---|
| Σ step time (median) | 25.9 s | 15.6 s | **−40 %** |
| Steps (median) | 7.5 | 4.5 | −40 % |
| Output tokens per session (median) | 3 798 | 2 180 | −43 % |
| Tool calls per step | 1.41 | 1.37 | flat |
| Mann–Whitney U | — | — | **p = 0.008** |

10/10 factual answers identical. Note the honest part: per step, turbo is actually **slower and fatter** (+537 ms, +5 % tokens); it wins by doing 7.5 steps of work in 4.5 — what it saves is round trips, not per-step intelligence. The experiment is still growing (more sessions, more routes, an official-API arm), and new numbers land in this table first.

## Thirty seconds

1. **Install**: DSH desktop → plugin manager → install bundle, target `github:regrevia/dsh-fast-mode`. Terminal equivalent: `pnpm add github:regrevia/dsh-fast-mode --dir ~/.dsh/profiles/desktop` (then add the block below to `cordis.patch.yml`; the plugin manager writes it for you).
2. **Turn it on**: reload the page, click the little bolt next to the composer → flip the switch → pick a gear.
3. **Takes effect**: the next request runs on the new gear — no restart, no new conversation. The switch follows the conversation: one tab, one choice.

```yaml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
      config:
        enabled: true      # off by default after install; this line is the real switch
        gear: turbo        # safe / fast / turbo / max / ludicrous (default fast)
```

This plugin cannot be enabled together with `dsh-batch-tool-calls` / `dsh-ops` (overlapping features; see the conflict subsection in [docs/REFERENCE.en.md](docs/REFERENCE.en.md#coexistence-and-conflicts)).

## The five gears

A gear is not "how hard to crank it down" but one posture: how early downgrading is allowed, how many calls the model issues per step, and whether output gets cut.

| Gear | Parallel target | When to use |
|---|---|---|
| **Eco** `safe` | 2 per step | Critical changes, reading the logs first, a zero-prompt-change requirement; also the control arm of the experiment |
| **Cruise** `fast` | 4 per step | The default; enough for daily work |
| **Sport** `turbo` | 6 per step | **Pick this gear when you want faster**: heavy code reading, research, bulk triage |
| **Track** `max` | 8 per step | Mechanical batch work; not recommended for critical changes unattended |
| **Redline** `ludicrous` * | 8 per step | Batch work where you explicitly do not want quality: thinking off, fastest and riskiest |

\* The only gear that actually emits `reasoningEffort: 'off'`. Explicit fields always beat the gear (`gear: turbo` + `deepAfter: 8` = Sport's parallelism with a conservative downgrade rhythm).

## Playing well with other plugins

It touches exactly five things: one section in the system prompt, `reasoningEffort` on `agent/request`, one read of `maxParallelToolCalls`, a cancellable ceiling on shell-style calls inside `tools/execute`, and one reminder appended after a compaction from `agent/pre-step` (`source.kind = 'plugin'`, never posing as a user message). It edits no history, does not intercept `fetch`, and makes no network requests.

- ✅ **Compression plugins** (billion-context, built-in compaction, historical image compression, gateway adapters): one cuts input, the other cuts round trips — they multiply. Put the compression tools into `holdTools` and they leave each other alone.
- ✅ **Pure UI / read-only observation**: zero overlap.
- ❌ **Another plugin that writes `reasoningEffort`**: a knob can have only one owner; pick one.
- ❌ **Another plugin also named "fast mode"**: the settings namespace and the patch id collide.
- ❌ **A "save tokens" plugin that clamps `maxParallelToolCalls` back to 1–2**: the parallel target becomes empty words, and all that is left is fake speed.
- ❌ **`dsh-batch-tool-calls` / `dsh-ops`**: the former's batching rules are a static subset of this plugin's guidance and ignore the gear; the latter ships two shells, Windows-only binaries and its own timeout advice. Enabling either together means paying for the same guidance twice — pick one.

The full list, the reasoning behind each verdict and the config snippets are in [docs/REFERENCE.en.md](docs/REFERENCE.en.md#coexistence-and-conflicts).

## What's next

- **A larger controlled experiment**: more sessions, more routes, the official API and self-hosted gateways run separately; results go straight into the table above.
- **Real TTFT**: what is measured today is request-level latency; it only becomes true TTFT once a streaming signal exists.

## More

[Measurement and how to reproduce](BENCHMARK.md) · [Principles, configuration and limits (reference)](docs/REFERENCE.en.md) · [What changed](CHANGELOG.md) · [中文](README.md)

## License

MIT. The logo is a whale with a bolt — fast, but not allowed to lie to itself.
