# Reference: principles, configuration and limits

This manual describes what **dsh-fast-mode 1.0.0** actually does, matching `index.js`, `src/` and `client.js` in the repository. It is not a brochure: where something can be measured it gets a number, and where it has not been measured it says so.

**The one contract: fast mode never changes reasoning effort, the thinking budget, or the model.** The `agent/request` hook does exactly one thing — `await next()`, read the `reasoningEffort` the request already carries for measurement, then return it unchanged. Whatever effort the user picked (the per-session choice in the UI, or the effort pinned by the profile's agent-default-model) is the effort every request uses.

Speed comes from three things only: fewer round trips, less narration, less tool wait. Each gets a section below.

## Interaction details: the bolt switch and which conversation it applies to

- **One icon, no dropdown.** The conversation input's activity slot (`conversation.input.activity`) holds a single bolt button: hollow when off, filled when on. Clicking it opens the panel. There is no gear selector, no caret, no second-level "choose a gear" menu.
- **The panel answers one question: is this conversation on.** It is 196 px wide and contains a title, one switch, a scope line ("This conversation only"), one live scheduling line, and two lines of fine print (effort is unchanged; what makes it faster).
- **The live line quotes the number being enforced**, not an adjective:
  - on, with a guard ceiling: `Automatic · parallel 2–8 · one call ≤ 2 min`
  - on, with the guard disabled (`stallGuard: false`, or a negative `toolTimeoutMs`): `Automatic · parallel 2–8 · calls unbounded`
  - off: `Off · the harness behaves exactly as shipped`
- **The panel can only quote the config it can read.** It reads `stallGuard` and `toolTimeoutMs` from `settings/describe`, uses an explicit positive value when present, and otherwise falls back to the `auto` starting point of 120 seconds. It cannot see an experiment assignment's per-session override (that happens on the host request path), and it cannot see the live width the scheduler computed for this session — width is host-side state that changes per step. So the line states the 2–8 range, not "6 lanes right now".
- **Write path.** Flipping the switch sends one `settings/update` carrying `enabled`, `gear` and `sessions` together, with the `revision` it read; it updates optimistically and polls briefly to confirm. A refusal (stale revision, read-only profile) rolls all of it back and shows the reason, so the button never becomes a dead control; a failed read shows the error and a click retries. The `gear` it writes is always the constant `auto`.

## How it works

### 1. What does not change: model, provider, thinking effort

1.0.0 **deleted** the whole "lower the effort" machinery rather than disabling it: `floor`, `ladder`, `aliases`, `deepAfter`, the per-step effort ladder, the `ludicrous → off` special case, and the heuristic that picked an effort from errors or latency all went away with the code. Writing those fields in a config still does not fail (schemastery passes undeclared keys through), but it has **no effect**.

The request hook in full:

1. `const resolved = await next()`;
2. read `resolved.reasoningEffort` and the route name into the metrics label;
3. `return resolved`.

It does not write `reasoningEffort`, does not write a thinking budget, does not switch models, and adds no provider-specific fields. That leaves three real levers: parallel fan-out (fewer round trips), output discipline (less narration), and the stall guard (less tool wait). Thinking depth and decode speed are not among them — the first is the user's contract, and no prompt can make the second happen.

### 2. The adaptive scheduler: `gear: auto`

`auto` is the only user-facing gear in 1.0.0. On every step it re-decides two things from the session's own history: how many tool calls the next step may issue in parallel, and how long one tool call may run before it is cancelled.

The constants live in `AUTO_LIMITS` in `src/auto.js`:

| Name | Value | Meaning |
|---|---|---|
| `parallelMin` / `parallelBase` / `parallelMax` | 2 / 4 / 8 | Width floor, starting point, ceiling |
| `widenAfterSteps` | 2 | Steps before width starts following recent behaviour |
| `stallFloorMs` / `stallCeilMs` | 120000 / 300000 | Clamp for the stall budget (2–5 minutes) |
| `stallMultiplier` | 3 | Budget = 3× the p90 of recent call latency |
| `noProgressWarn` / `noProgressStop` | 6 / 12 | Consecutive no-progress warning line, stop line |
| `turnStepBudget` | 30 | Step count at which the model is told to stop and report |
| `waitWindow` | 32 | Recent calls that feed the p90 |
| `directiveCooldown` | 3 | Minimum steps between two scheduler directives |

Width is computed in this order, first match wins:

1. 3 or more consecutive no-progress steps, or 3 or more errors: **2**;
2. otherwise, at least 2 steps and the previous step issued at least 2 calls: **8**;
3. otherwise, at least 2 steps: **6**;
4. otherwise (the first step or two): **4**.

"No progress" is observable, not semantic: the same `(tool name, arguments)` signature appears again, returns the same number of characters, and did not fail last time. A new signature, a previously failing call that now succeeds, or a result whose size changed all count as progress. That keeps a successful rerun of an identical command from being mistaken for new information.

Stall budget: take the p90 of the last 32 tool-call durations, multiply by 3, clamp to 120–300 seconds. With no samples the p90 is 0, which clamps to the 120-second starting point; the ceiling loosens as the session slows down and tightens as it speeds up.

Directives: 6 consecutive no-progress steps emit "change the approach"; 12 steps, or a cumulative 30 steps, emit "stop and report". At least 3 steps pass between directives. Directives are inserted into the message list as producer-owned notices (source `plugin:fast-mode`), so the model reads them and they remain visible in the transcript.

On the counting: `turnSteps` is genuinely per turn. `index.js` calls `noteTurn` on the session's `turn/start` event, which clears the per-turn counters while the session-level memory of what has been tried and how long it has stalled survives — that memory is exactly what a stuck loop re-reads. The 30-step stop line is therefore **30 steps per turn**, not a budget for the whole session.

### 3. Prompt guidance: `fast-mode:execution-speed`

The section name and order are fixed: `fast-mode:execution-speed`, `order: 520`, next to the plan policy and the other cross-cutting execution guidance. It renders per request and follows the session's live width:

- off, or width ≤ 1: the section is not registered at all (an empty string is dropped);
- on with width > 1: batching rules, the fan-out target, optional prefetch, bounded calls, and output discipline.

Details worth knowing:

- **The fan-out number is the width the scheduler computed.** Under `auto` the section and the stall guard share one `autoSchedule` result, so the number the model reads and the number being enforced cannot drift apart.
- **Prefetch appears only at width ≥ 4.** Below that, an extra call just competes with the work the step already has.
- **The bounded-calls block appears only when `stallGuard !== false`**, because it describes the same policy the guard enforces.
- **Output discipline has two strengths**: `light` for the legacy `fast` gear, `full` for `auto`/`turbo`/`max`/`ludicrous`. Both trim narration only — no announcing a call, no restating a result, no progress report; the last step still writes the answer in full. `full` adds one sentence: send bare calls when a step needs no prose. **It never shortens the answer and never tells the model to skip a check.**
- **`parallel: 1` is the documented "on but no fan-out" setting**: the switch still applies to the stall guard, and the guidance section disappears entirely.

The cost is explicit: about 2,700 characters under `auto`, paid as input tokens on every request. That is the intended trade — input tokens for fewer round trips.

### 4. The stall guard: a ceiling on one call

It hangs off the `tools/execute` waterfall and honours the only mutation that hook allows: it replaces `exec.signal`, races the call body against a timer, aborts on timeout, and hands the model a failure result instead of waiting forever. Cancellation leaves a 250 ms grace period for the tool to unwind, and the caller's original signal is restored in `finally` either way.

It only guards **shell and script** tool names (matching `bash|shell|sh|zsh|exec|pwsh|powershell|cmd|script|monitor|terminal`). Tools whose purpose is to wait are explicitly exempt: `ask_user_question`, `wait_agent`, `job_output`, `job_list`, `task_board_run`, `workflow`, `subagent`, `subagent_fork`, `run_code`.

Budget precedence, highest first:

1. `stallGuard: false` → 0 (no guard at all);
2. `toolTimeoutMs < 0` → 0 (same thing, said numerically);
3. `toolTimeoutMs > 0` → that fixed value, for every gear;
4. otherwise the per-gear starting value:

   | Gear | Starting ceiling |
   |---|---|
   | `safe` | 0 (no guard) |
   | `auto` | 120 s, then the scheduler takes over |
   | `turbo` | 180 s |
   | `max` | 120 s |
   | `ludicrous` | 90 s |
   | `fast` | 300 s |
   | unknown | 300 s |

5. Under `auto`, when the starting value is non-zero and no explicit `toolTimeoutMs` was set, the scheduler's live budget (from the recent p90) replaces the table value.

A cancelled call returns a normal tool failure (`isError: true`). Its text says the call ran N seconds and was cancelled, gives three concrete suggestions (background the server/watcher, write the long command to a file and run the file, narrow a full sweep to one probe), and closes by saying not to re-issue the same command unchanged — it will be cancelled again.

### 5. State follows the conversation

There are two tiers of state, both in the config's single `sessions` column:

- **The shared `enabled` / `gear` fields** are the default and the most recent choice. A conversation without its own entry inherits them.
- **The `sessions` column** holds per-conversation entries: `{"<sessionId>": {"enabled": true, "gear": "auto", "ts": 1730000000000}}`. Reads prefer the entry field by field; writes update both tiers in one patch, so there is no window where the switch has flipped but the gear has not caught up.

The cap is 200 conversations, evicting the oldest `ts` when exceeded — a bound on memory and config size, not a permissions model. The host implementation (`src/state.js`) and the browser copy (`client.js`) are two pieces of code; tests pin their read/write agreement with the same fixtures.

## Configuration

In the profile's `cordis.patch.yml`:

```yaml
- id: fast-mode
  config:
    enabled: true
    gear: auto
    # parallel: 4            # optional starting width; auto adjusts it later
    # outputDiscipline: true
    # stallGuard: true
    # toolTimeoutMs: 0
    # reassertAfterCompaction: true
    # metrics: true
```

`enabled`, `gear`, `parallel` and `sessions` are `.volatile()`: they appear on the Web UI plugin page's form and an edit reaches a running fiber. Every other field is a composition-level troubleshooting knob that only works in a patch and stays off the form.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. Off means exactly native behaviour: no guidance section, no guard, no scheduling. Default-off is what makes "off is off" verifiable. |
| `gear` | `'auto'` | Scheduling mode. `auto` is the only user-facing gear; `safe` is kept for experiment scripts; `fast`/`turbo`/`max`/`ludicrous` are the old fixed widths and a config naming one resolves to `auto` with a deprecation log. |
| `parallel` | derived, 4 under `auto` | Starting parallel ceiling, 1–8. `auto` treats it as a starting point only; `1` means "no batching section". |
| `sessions` | `''` | Plugin-maintained per-conversation overrides, see above. **Do not edit by hand.** |
| `outputDiscipline` | `true` | Whether to inject output discipline. Off still injects batching and bounded-call rules; it only stops steering the prose. |
| `stallGuard` | `true` | Whether to cap a single shell/script call. Under `auto` the budget self-tunes between 2 and 5 minutes. |
| `toolTimeoutMs` | `0` | Per-call ceiling in milliseconds. `0` = adaptive (see `stallGuard`), negative = no guard, positive = that value for every gear. |
| `reassertAfterCompaction` | `true` | After a compaction, the next request carries one very short notice restating batching and bounded calls. The guidance section itself is unaffected. |
| `metrics` | `true` | Whether to write the metrics file. Off writes nothing. |
| `metricsFile` | `~/.dsh/fast-mode-metrics.jsonl` | Metrics path, one JSONL row per step. |
| `benchmarkFile` | `~/.dsh/fast-mode-bench.json` | Experiment assignment path. Missing file, or `enabled` not true, means no assignment. |

On the old names: the schema still accepts `fast`, `turbo`, `max` and `ludicrous` (otherwise an old patch would fail to load), but when one appears in a user config `resolveConfig` maps it to `auto` and logs a warning that the name used to lower thinking effort, that it now runs the auto scheduler, and that the effort stays whatever the user chose. The experiment path's per-session override is the exception and keeps the name verbatim (see "Assigning gears per session").

On `safe`: it is an experiment control arm, not a gear for users. It declares `directive: false`, so `resolveConfig` forces width to 1, the guidance section disappears, and the stall budget is 0 — the plugin is present but does nothing.

## Coexistence and conflicts

This plugin manages **execution**: how many calls share one request, how much prose the model writes, how long one call may run. Compression plugins manage **input history**: how large the message list is, how many old images get moved out. They act on different layers with no shared fields, and they stack.

Three rules make that work in practice:

1. **No shared field to fight over.** This plugin does not touch `reasoningEffort`, `thinking` or `output_config`, so the "two components clamping effort" problem does not exist.
2. **Compaction steps need no special handling.** 1.0.0 has no notion of holding a step; history folding happens before the request is sent, and this plugin only sees an ordinary request.
3. **Summariser calls are out of reach.** A compressor's own summary requests usually run in its own process or HTTP layer, not through `agent/request`, so neither side affects the other.

### billion-context

**Compatible and complementary.** billion-context installs as a DSH bundle (`bili-native`), turns off the host plane's `compaction-basic` auto mode, and intercepts model traffic at the HTTP layer (patching `globalThis.fetch`). It does not go through `agent/request` and does not read or write `reasoningEffort`, so the two share no fields and neither needs configuration for the other.

The one thing worth checking is billion-context's own `compress.outputSteering.effortRouting`: that switch lowers effort on "mechanical continuation" turns. It is no longer a competitor to this plugin (this plugin does not touch effort at all), but it does break the promise that effort stays what you chose. If that promise matters to you, turn it off:

```yaml
- id: bili-native
  config:
    compress:
      outputSteering:
        enabled: true
        effortRouting: false    # effort is the user's choice, not the compressor's
```

Two further facts, not recommendations: billion-context's own summary calls run in its proxy process and never pass through the harness, so this plugin cannot reach them; and it disables `compaction-basic`'s automatic compaction, so **do not stack a second compressor**.

### Automatic historical-image compression / gateway adapters

Plugins such as `image-guard` and `intellif-litellm-adapter` fix a different failure: they rewrite the message list before the request leaves (moving old images out, forcing another compression pass, retrying a `too_many_images` 400) so the request fits a gateway's image-count, pixel or context limit. They share no fields with this plugin, need no configuration, and do not need to hand tool names to this plugin for "protection" — 1.0.0 has no such list.

Keep **only one image reducer** in a profile (billion-context also folds media server-side), or the two passes step on each other.

### `dsh-batch-tool-calls` and `dsh-ops`: do not enable them with fast mode

These are not neighbours that can be configured into coexistence; they are **overlapping features**. Enabling both charges the same work twice and sometimes makes the two disagree.

- **`dsh-batch-tool-calls`** registers its own batching guidance section. This plugin registers a superset: per-conversation width, a fan-out target that follows recent behaviour, output discipline, bounded-call rules, and a post-compaction reminder. With both on you pay for the same prompt twice, and the two texts can state different fan-out targets.
- **`dsh-ops`** replaces the shell and file tools with its own (`ops_bash`, `ops_grep`, `ops_glob`, `ops_inspect_local_file`, `ops_replace`, …) and ships Windows binaries only. This plugin's guidance is about what to do with *the* shell — bound the call, background a server, avoid a heredoc — so `dsh-ops` means two shells and two policies: either duplicated or in conflict.

The plugin detects both at load (looking for the package names in the profile's `package.json` / `cordis.patch.yml`, plus a live `ops_bash` tool probe) and, on a hit, states the conflict in the conversation **once**. It does not block loading. There is one fix: **remove one of them**.

## Official API support

**Fully supported, and no configuration is needed.** The official DeepSeek API (`deepseek-official`), a proxy or relay in front of it, a self-hosted gateway (such as `litellm` with Anthropic Messages), and OpenAI-compatible endpoints all behave identically, for a simple reason:

- the request body goes in and comes out unchanged. This plugin does not write `reasoningEffort`, `thinking` or `output_config`, and adds no provider-specific fields;
- it does not filter or lower "the effort ids this route declared". There is no `floor`, no ladder, no per-step downgrade;
- the route name is recorded for metrics and debug logs only and takes part in no decision.

So whether a provider declares `off/low/high/max`, or `minimal/low/medium/high`, or a single level, or nothing at all, this plugin behaves the same way: it injects its guidance section, bounds shell calls, and sends the effort you chose unchanged.

## Measurement, experiments and reporting

Measurement lives in the plugin, and it **records the off state too** — with no baseline there is nothing to compare.

### One row per completed step

The metrics file is JSONL, one row per completed model step, created lazily, and best-effort: if it cannot be written, the request is unaffected. The format version is `v: 1` and the fields are:

| Field | Meaning |
|---|---|
| `v` | Metrics format version, currently 1 |
| `ts` | ISO timestamp when the step ended |
| `sid` / `turn` / `step` | Session id, turn, step number |
| `mode` / `gear` | `on` or `off`; gear is recorded as `off` when disabled |
| `effort` | **The reasoning effort the request actually carried, recorded verbatim** — the evidence that the plugin did not rewrite it |
| `route` | Route/model label, used only for grouping |
| `ttftMs` | Time to first token: step start to the first assistant message |
| `llmMs` | Model time: step start to the last assistant message |
| `stepMs` | Whole-step time, including tool wait |
| `calls` / `errors` | Tool calls in the step, and how many failed |
| `input` / `output` / `reasoning` | Upstream usage tokens; omitted when unavailable |
| `cacheRead` / `cacheWrite` | Upstream usage cache tokens |
| `assistantMessages` | Assistant messages in the step |

The `effort` column is the heart of 1.0.0: it records what the request **actually sent**. If you chose `high` in the UI, every row says `high`; the plugin never changes it.

### A switch per conversation

The data contract of the `sessions` column (also what you see when you export the config):

```json
{"<sessionId>": {"enabled": true, "gear": "auto", "ts": 1730000000000}}
```

- read order: this conversation's entry → shared `enabled`/`gear` → schema default;
- a missing field in an entry falls back per field, not for the whole entry;
- the entry and the shared fields are written in one patch;
- the cap is 200 entries, evicting the oldest `ts`; `enabled` must be a boolean, `gear` a string, `ts` a finite number, and a corrupt entry is dropped rather than invalidating the column.

### Assigning gears per session

When the experiment file (default `~/.dsh/fast-mode-bench.json`) exists with `enabled: true`, the plugin assigns each conversation to a gear by an FNV-1a hash of its session id, giving randomised control within one account:

```json
{
  "enabled": true,
  "gears": ["off", "safe", "fast", "turbo", "max"],
  "sessions": { "<sessionId>": "max" }
}
```

- a pin in `sessions` outranks the hash, which is how an important conversation gets fixed to one arm;
- `off` is the control arm and means the plugin is disabled;
- unknown names are filtered out with a single warning; a broken file is reported once and treated as absent;
- edits take effect within a second (1 s TTL), with no restart.

On the request path the assignment **outranks** the panel's per-conversation switch — which is why you should not touch the switch during an experiment: the panel shows your last choice, while the request may run the assigned arm. This is also one reason the panel only quotes the config it can read.

### The report: `dsh-fast-mode-report`

```bash
dsh-fast-mode-report                  # default file, all history
dsh-fast-mode-report --since 2d       # last two days only
dsh-fast-mode-report --json           # machine readable
dsh-fast-mode-report --file ./m.jsonl # another sink
dsh-fast-mode-report --lan            # also join the LAN usage dashboard
```

The output has three parts:

1. **the main table, bucketed by `mode|gear`**: sessions, steps, steps/turn, step-time p50/p90, model-time p50, first-token p50, output tokens/step, output tokens/session, calls/step, multi-call steps;
2. **a ratios table against the off baseline** (only when a baseline exists): model-time ratio, step-time ratio, output ratio, tokens-per-session ratio, calls ratio. A value `> 1×` means that arm is faster or more expensive; check the column name;
3. **the definitions**: the unit is the model step, not the whole session (session wall clock includes reading and typing); how model time and first token are defined; ratios are means and wobble when samples are few.

With no off samples it refuses to invent ratios and tells you to run the same task with the switch off. `--lan` needs a `USAGE_TOKEN` environment variable (`USAGE_BASE` is optional) and is read-only; a missing token or a failed request prints one note and leaves the local report intact.

### The experiment: `dsh-fast-mode-experiment`

```bash
dsh-fast-mode-experiment start        # write the experiment file
dsh-fast-mode-experiment status       # progress and samples per arm
dsh-fast-mode-experiment stop         # end the experiment
```

Options: `--bench`, `--metrics`, `--gears a,b,c`, `--sessions n` (only affects the status hint), `--force` (overwrite an existing experiment file). The default arms are `off,safe,fast,turbo,max` — note that these are the **legacy fixed-width arms**, executed verbatim through the per-session override: `fast` is 4 wide with light output discipline, `turbo` is 6 wide, `max` is 8 wide, `safe` is "present but idle", and `off` is the control. To measure the adaptive scheduler itself, add `auto` to `--gears`.

How the file and the metrics work together: `start`, run tasks, use `status` to see whether each arm has enough samples, `stop`, then read ratios with `report --since`. Few samples make ratios wobble; that is statistics, not plugin behaviour.

## Safety boundaries

- **Observe, do not rewrite.** `tools/pre-execute` / `tools/post-execute` are pure observers (start time, call result), and `agent/request` returns the request unchanged. Beyond the guidance section and two producer-owned notices (the post-compaction reminder and a scheduler directive), the plugin writes nothing into the conversation.
- **Model and effort are not writable.** There is no assignment to `reasoningEffort` anywhere in the source; a test scans for it so it cannot come back unnoticed.
- **Settings are changed only by the panel, and only with a revision.** There is no background path that silently edits config; a conflicting write fails and rolls back.
- **Metrics stay local.** Only `metricsFile` is written; `--lan` is the sole network path, read-only, and needs an explicit token.
- **The guard changes only the signal.** The caller's original signal is restored in `finally`, and the body's rejection after a lost race is swallowed rather than surfacing as an unhandled rejection.

## Honest limitations

**The latency ledger.** Measured on this gateway, a step's wall clock is about `720 ms + 6.63 ms × output tokens` plus tool wait (R² = 0.93 over 689 steps). That equation says reducing steps and reducing tool wait are real levers; thinking effort and raw decode speed are not — the first changes the answer, and no prompt can move the second.

**Fan-out has a precondition.** Widening pays off only when a step really contains several independent queries. On single-file benchmark tasks (HumanEval / AIME shaped) this plugin measured differences inside the noise (0.95×–1.09×) with no measurable speed-up — those tasks have no parallel read set to begin with. "This plugin makes every task 30% faster" is a false claim.

**The 1.0 scheduler has not been A/B measured at scale.** The constants above come from small-sample observation and design reasoning; the `auto` width policy, the 6/12-step thresholds and the 3-step cooldown still need controlled data from real sessions. `report` and `experiment` exist to close that gap, not to prove it already holds.

**Token use may rise, and that is the accepted trade.** Wider steps mean more tool output per step, hence more input tokens; output discipline trims narration and promises nothing about total tokens. Do not introduce this plugin as "token saving".

**Guidance is advisory, not enforcement.** A model may still issue one call per step. How many calls actually run concurrently is also capped by `agentLoop.maxParallelToolCalls`; when the target width exceeds that cap the plugin warns once and prints a `cordis.patch.yml` fix.

**The guard only sees shell-class tools.** A hung non-shell call (say, a custom tool whose promise never resolves) is outside its scope. Exempt tools are deliberately unbounded — waiting for a user or a background job is supposed to wait.

**The panel cannot show live width.** It states the 2–8 range and the ceiling it can read; the width the host computed for a given conversation appears only in the guidance section and the debug log.

**The `turnSteps` counting caveat.** It resets on every `turn/start`, so the 30-step stop line constrains a single turn; what survives across turns is the scheduler memory, not a spent step budget.

## Development and tests

Module layout:

- `index.js`: assembly, hooks, per-session config resolution, guidance section registration;
- `src/auto.js`: scheduler state, width, budget, directives;
- `src/guidance.js`: the model-facing text;
- `src/stallguard.js`: the guard and budget precedence;
- `src/effort.js`: gear table and legacy-name normalisation (no effort ladder anymore);
- `src/config.js`: schema and form fields;
- `src/state.js`: parsing and encoding the `sessions` column;
- `src/notices.js`: producer-owned notice construction and source validation;
- `src/metrics.js`: JSONL metrics and summaries;
- `src/benchmark.js`: per-session hash assignment;
- `src/peers.js`: conflicting-plugin detection;
- `client.js`: the bolt chip and the panel.

Run the tests:

```bash
node --test test/*.test.js
```

All 172 tests currently pass (0 failures). Coverage includes scheduler width and directives, budget precedence, the guidance section's on/off conditions, `sessions` parity between the host and browser implementations, notice source validation, metrics fields, assignment hashing, report and experiment CLI argument parsing, and a regression test that scans the source to confirm nothing assigns `reasoningEffort`.

Documentation entry points: `README.md` (Chinese), `README.en.md` (English), `BENCHMARK.md` (method and historical data), `CHANGELOG.md` (what each version deleted and added).
