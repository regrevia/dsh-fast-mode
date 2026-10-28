# Reference: principles, configuration and limits

This manual describes what **dsh-fast-mode 1.5.17** actually does (injection behaviour under the default config is identical to 1.5.0; 1.5.14 added the right-click panel, and as of 1.5.17 it has four rows that all apply to this conversation only), matching `index.js`, `src/` and `client.js` in the repository. It is not a brochure: where something can be measured it gets a number, and where it has not been measured it says so.

**The one contract: fast mode never changes reasoning effort, the thinking budget, or the model.** The `agent/request` hook does exactly one thing — `await next()`, read the `reasoningEffort` the request already carries for measurement, then return it unchanged. Whatever effort the user picked (the per-session choice in the UI, or the effort pinned by the profile's agent-default-model) is the effort every request uses.

Speed comes from three things only: fewer round trips, less redundant output, less tool wait. Each gets a section below.

## Interaction details: the bolt switch and which conversation it applies to

- **One icon, and it is the switch.** The conversation input's activity slot (`conversation.input.activity`) holds a single bolt button: hollow when off, filled when on. One click toggles it, another click toggles back, and that click writes only this conversation. There is no gear selector, no caret, no second-level "choose a gear" menu.
- **Right-click is the panel.** Right-clicking the bolt opens four rows, all scoped to the current conversation: faster (`enabled`), less narration (`outputDiscipline`), step cap (`stepBudget`, cycling 0/15/30), and file list first (`workspaceMap`). Each row records the choice in this conversation's entry in the `sessions` column, leaves the shared defaults alone, and applies from the next request; the whole block is disabled while read-only or mid-write, and a refused write rolls back. A conversation with no entry keeps the configured defaults (`enabled`/`gear`/`outputDiscipline`/`stepBudget`/`workspaceMap`). The panel does not expose `disciplineAfterSteps`, `disciplineEarlyCalls`, `shapeGate`, `finishLineSteps`, `shellParallel` or `disciplineRepeatAtSteps` — untested or held.
- **Conversations never affect each other, and that is a hard constraint.** Each conversation resolves `enabled`, `gear`, `outputDiscipline`, `stepBudget` and `workspaceMap` from its own entry in the `sessions` column: A can be faster + less narration while B is faster + full narration at the same time, and C, never touched, keeps the configured defaults. The panel and the bolt write only this conversation's entry and never the shared defaults; at most 200 entries are kept, oldest `ts` pruned first, and a pruned conversation falls back to the defaults.
- **The button answers one question: is this conversation on.** `aria-pressed` is the state, and the tooltip spells out "this conversation · effort unchanged · click to turn off". What makes the mode faster, where the speed comes from, and the per-call ceiling live in the plugin description (`meta.description` and the config descriptions), not in the composer.
- **The live line quotes the number being enforced**, not an adjective:
  - on, with a guard ceiling: `Automatic · parallel 2–8 · one call ≤ 2 min`
  - on, with the guard disabled (`stallGuard: false`, or a negative `toolTimeoutMs`): `Automatic · parallel 2–8 · calls unbounded`
  - off: `Off · the harness behaves exactly as shipped`
- **The button writes only what it knows.** One click writes `enabled`, `gear` (always `auto`), and this conversation's entry in the `sessions` column, carrying the revision it read. It never writes thinking effort and never writes the parallel width: width is host-side state that changes per step, so the UI does not pretend to display it.
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
| `parallelBase` / `parallelMax` | 4 / 8 | First probe, ceiling (`1` is the documented "native" value, so the scheduler can pick it) |
| `widenAfterSteps` | 2 | Steps before width starts following recent behaviour |
| `stallFloorMs` / `stallCeilMs` | 120000 / 300000 | Clamp for the stall budget (2–5 minutes) |
| `stallMultiplier` | 3 | Budget = 3× the p90 of recent call latency |
| `noProgressWarn` | 6 | Consecutive no-progress steps that earn one "change the approach" reminder; a reminder only, never an ending |
| `turnStepBudget` | 0 | The scheduler's own hard step ceiling; 0 = off, which is the default |
| `outputBudget` | 0 | Optional output-token budget: at that many cumulative `outputTokens` (upstream usage) in a turn, one reminder to close the current loop and run the check that proves it; 0 = off, which is the default |
| `finishLineSteps` | 0 | Optional soft finish line; 0 = off, which is the default. `10` is the retired 1.4.4 default and is kept only as an ablation arm |
| `disciplineAfterSteps` | 4 | Step at which the late output discipline starts |
| `disciplineRepeatAtSteps` | 0 | Step at which the same compression reminder fires a second time; 0 = never (still at most twice per turn). Unproven, off by default |
| `disciplineEarlyCalls` | 0 | With a positive N, the `disciplineAfterSteps` early entry applies only to a turn that already made at least N tool calls before the current step, otherwise it falls back to the built-in 4; 0 = unconditional, i.e. the 1.5.12 behaviour |
| `waitWindow` | 32 | Recent calls that feed the p90 |
| `directiveCooldown` | 3 | Minimum steps between two scheduler directives |

Width is computed in this order, first match wins:

1. 3 or more errors: **1** (native). Error evidence outranks the request classifier, so a turn that keeps failing is never pushed to batch;
2. the turn already has steps and the request classifier produced a width: **that width** (1–8). It is the only signal available on the first step of a turn, so it precedes the "nothing observed yet" probe;
3. the session has not issued any call yet: **4** (one cheap probe);
4. 3 or more consecutive no-progress steps: **1** (native, the whole guidance section is not rendered);
5. the previous step was read-only, issued at least 2 calls, and no two calls touched the same target (a "distinct read block"): **8**;
6. 2 or more consecutive read-only steps and the previous step issued at least 2 calls: **8**;
7. at least 1 step into the turn, the previous step was read-only and issued at least 3 calls: **8**;
8. at least 2 steps into the turn and the previous step issued at least 2 calls: **8**;
9. a new turn with no parallel shape in its history: **1** (native);
10. otherwise: **1**.

"No progress" is judged on **result content**, not on character counts and not on call counts: every finished call is keyed by its `(tool name, arguments)` signature, and a step counts as progress when a result digest changed, when a call that used to fail now succeeds, or when the signature is one never seen before. An identical successful rerun does not count. A status poll that walks `completed 10 / 99` → `11 / 99` is therefore progress (the content moved), while running the same command eight times verbatim inside one step is one signature and the step is still unproductive. The unit is the **step**: one call with new information makes the whole step productive.

Stall budget: take the p90 of the last 32 tool-call durations, multiply by 3, clamp to 120–300 seconds. With no samples the p90 is 0, which clamps to the 120-second starting point; the ceiling loosens as the session slows down and tightens as it speeds up.

Directives: 6 consecutive no-progress steps emit "change the approach" — it asks for a different method, not for the turn to end. No step-count directive ends a turn by default: `stepBudget` above 0 emits one "report where you are" at its line, and `finishLineSteps` above 0 emits one "stop widening scope" at its line. At least 3 steps pass between directives. Directives are inserted into the message list as producer-owned notices (source `plugin:fast-mode`), so the model reads them and they remain visible in the transcript.

**Reusing a check result (`reuse-check`).** When a call with arguments succeeds, its result is stored under its signature together with the artifact epoch it ran under. If the model then re-runs that same check verbatim and nothing wrote in between, the scheduler stops pestering it and says once: "that check already passed on the current files, rely on its result and finish the remaining requirements." A write, an edit, `apply_patch`/`patch`, or a shell call carrying a redirection or a common mutator (`sed -i`, `git apply`, `npm`, `make`, …) bumps the epoch, and one bump invalidates every stored check at once — so "passed" can never be mistaken for "still passed after the code changed". It is **advice only**: the plugin returns no cached result, skips no call, and never ends the turn; the model may still re-run it. Note that in 951 local suite transcripts this reminder was **never delivered** (`python3 bench/reminders.py`): those tasks do not re-run a check verbatim. It is a defensive correctness property, not a measured source of the speedup.

On the counting: `turnSteps` is genuinely per turn. `index.js` calls `noteTurn` on the session's `turn/start` event, which clears the per-turn counters while the session-level memory of what has been tried and how long it has stalled survives — that memory is exactly what a stuck loop re-reads. There is no step-count stop line by default; if `stepBudget` is set above 0, that ceiling is **per turn**, not a budget for the whole session.

### 3. Prompt guidance: `fast-mode:execution-speed`

The section name and order are fixed: `fast-mode:execution-speed`, `order: 520`, next to the plan policy and the other cross-cutting execution guidance. It renders per request and follows the session's live width:

- off, or width ≤ 1: the section is not registered at all (an empty string is dropped);
- on with width > 1: batching rules, the fan-out target, optional prefetch, bounded calls, and output discipline.

Details worth knowing:

- **The fan-out number is the width the scheduler computed.** Under `auto` the section and the stall guard share one `autoSchedule` result, so the number the model reads and the number being enforced cannot drift apart.
- **Prefetch appears only at width ≥ 4.** Below that, an extra call just competes with the work the step already has.
- **The bounded-calls block appears only when `stallGuard !== false`**, because it describes the same policy the guard enforces.
- **Output discipline has two strengths**: `light` for the legacy `fast` gear, `full` for `auto`/`turbo`/`max`/`ludicrous`. Both ask the model to skip call previews, restatements and progress reports; the last step still writes the answer in full. `full` adds one sentence: send bare calls when a step needs no prose. **It never shortens the answer and never tells the model to skip a check.** Scope matters: visible prose is only 1.19 % of the characters in (prose + tool arguments) (def15, 385 sessions; excludes reasoning and tool results; recompute with `python3 bench/textshare.py --limit 0`), so its value is not the words it deletes: it also shortens per-step reasoning (pooled 168 pairs: reasoning characters 0.75×, emitted 0.82×). Switching that one item off (`bench/arms/nodisc.yml`) cannot be sized at block level today: the same block (debugfix, 7 pairs) run twice gives `nodisc/def15` of 1.79× and then 0.648×, opposite directions, neither sign test significant, with the block ratio decided by one or two outlier cells (see the LEN3 section of `BENCHMARK.md`). Only the pooled main effect, 0.823×, is reportable, and inside it the discipline line acts together with the rest of the mechanism, so a single-block split is not available; it still does not license the claim that "the work itself is unaffected".
- **`parallel: 1` is the documented "on but no fan-out" setting**: the switch still applies to the stall guard, and the guidance section disappears entirely.

The cost is explicit: about 2,700 characters under `auto`, paid as input tokens on every request. That is the intended trade — input tokens for fewer round trips.

### 4. The stall guard: a ceiling on one call

It hangs off the `tools/execute` waterfall and honours the only mutation that hook allows: it replaces `exec.signal`, races the call body against a timer, aborts on timeout, and hands the model a failure result instead of waiting forever. After the abort it waits for the cancelled body to actually settle in two stages — the grace window first (up to 5 s on a large budget, scaled down with the budget, floor 250 ms), then a separate exit-confirmation window, 15 s in total — and records `quiesced`, `confirmed` and `waitedMs` on the observation. `confirmed: false` means the exit was **not observed**: the failure text does not claim the call was cancelled, it says the command may still be running, warns against touching files it may be writing, and asks for `pgrep -fl` / `ps -o pid,stat,command -p` before retrying. The caller's original signal is restored in `finally` either way.

It only guards **shell and script** tool names (matching `bash|shell|sh|zsh|exec|pwsh|powershell|cmd|script|monitor|terminal`). Tools whose purpose is to wait are explicitly exempt: `ask_user_question`, `wait_agent`, `job_output`, `job_list`, `task_board_run`, `workflow`, `subagent`, `subagent_fork`, `run_code`.

Budget precedence, highest first:

1. `enabled: false` → 0. The master switch is outermost: once it is off, no call is cancelled even if `stallGuard` is still its default `true` or a `toolTimeoutMs` was set. Before 1.5.0 the lookup fell through to the gear table, so an off mode kept cancelling calls;
2. `stallGuard: false` → 0 (no guard at all);
3. `toolTimeoutMs < 0` → 0 (same thing, said numerically);
4. `toolTimeoutMs > 0` → that fixed value, for every gear;
5. otherwise the per-gear starting value:

   | Gear | Starting ceiling |
   |---|---|
   | `safe` | 0 (no guard) |
   | `auto` | 120 s, then the scheduler takes over |
   | `turbo` | 180 s |
   | `max` | 120 s |
   | `ludicrous` | 90 s |
   | `fast` | 300 s |
   | unknown | 300 s |

6. Under `auto`, when the starting value is non-zero and no explicit `toolTimeoutMs` was set, the scheduler's live budget (from the recent p90) replaces the table value.

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
    # outputDiscipline: late   # or true / false
    # stepBudget: 0            # per-turn hard step ceiling, 0 = none (default)
    # finishLineSteps: 0       # optional soft finish line, 0 = off (default)
    # outputBudget: 0          # output-token budget, 0 = off (default)
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
| `outputDiscipline` | `'late'` | Output discipline. `late` (default) writes no output constraint for the first 4 steps and has the scheduler remind once from step 4; `true` applies for the whole turn; `false` still injects batching and bounded-call rules. |
| `openBatch` | `false` | Opening batch: one notice on the first step of each turn asking for every independent call in one block and shell commands chained with `&&`. A short task spends its time on per-call fixed cost (TTFT ≈ 0.5 s), so one fewer round trip is one fewer TTFT. It only touches the first step of a turn. In the old batches it measured no faster than the default, but **those numbers are retracted** (run directories lived inside the repo and metrics were sliced by byte offset); it has not been re-measured cleanly yet. Stays `false`, experimental only. |
| `shapeGate` | `false` | Shape gate: once a turn has accumulated at least 4 tool calls with 60 % or more of them writes (tools outside the read-only list), **no reminder is injected for the rest of that turn** and behaviour falls back to native. It only reads tool names — no request, no request-body field. It exists so a task the scheduler cannot accelerate gets left alone: write-heavy work has nothing to batch, and every reminder is a round trip it cannot reuse. An explicit `stepBudget` outranks the gate — "don't accelerate this" must not mean "ignore my stop line". Off by default, because it also suppresses the finish-line reminder that sometimes rescues a long tail. |
| `preferPatch` | `false` | After a whole-file write, remind the model once to send only the changed lines (an edit hunk) when it edits a file that already exists. It arms on a `write` whose body is ≥ 2000 characters, fires on the following step at most once per turn, and the text asks for a byte-identical result — it does not limit what gets written or when the turn may end. Off by default: it only changes the form of the model's output (tool-call arguments), and correctness is decided by file contents, not by how they were sent. Whether it actually saves wall clock is measured by the `pp16` arm in `BENCHMARK.md`. |
| `compactRereadHint` | false | One extra sentence in the compression reminder: do not re-read whole files this turn already wrote. Experimental, off by default |
| `workspaceMap` | `false` | One workspace inventory per conversation: before the first tool call the harness walks the session's working directory itself (depth 2, at most `mapEntries` rows, skipping `node_modules`, `.git`, `dist` and similar) and hands the model one notice with relative paths and byte sizes plus the test entry points it can see (an `npm test` script, `tests/`, pytest config, `go`/`cargo`/`make`). It replaces exactly the "what is in the directory" round trip (35.7 % of recorded calls in W8b) — it hides nothing, limits no read, and has no say in when the turn ends; the inventory is passed through unedited and which file to open stays the model's call. Off by default: it is a hint, not a proof of speed; measured by the `map15` arm in `BENCHMARK.md`. |
| `mapEntries` | `60` | Row cap for `workspaceMap`, 10–200. The notice text has its own ~1.4 kB ceiling; when it truncates it says "first N of M" and keeps the test-entry line. |
| `stepBudget` | `0` | Per-turn hard step ceiling. `0` = unlimited, which is the default: a step count measures cost, not whether the task is done, so nothing is asked to wrap up on a counter. Set above 0, the line sends one "report where you are" notice without blocking tools — a hard cut would land mid-edit. |
| `outputBudget` | `0` | Output-token budget: once cumulative `outputTokens` in the turn (the upstream `usage.outputTokens`, not an estimate) reach this value, one reminder to close the current loop, run the check that proves it, and report — at most once per turn. `0` = off, which is the default. It triggers on real decode volume rather than step count — three steps that write 30 000 tokens are expensive, twenty steps that write 2 000 are not — but tokens are still a cost signal, not evidence of completion, so it ships off. |
| `finishLineSteps` | `0` | Optional soft finish line: at step N the scheduler asks once to stop widening scope, skip checks that already passed, and fix only what still fails. `0` = off, which is the default. **`10` is the retired 1.4.4 default and is kept only as an ablation arm, not as a recommendation**: it was the fastest configuration measured in the old batches (**those numbers are retracted** for the two measurement defects above), but it fails the gate — on `ledger` p1 both the baseline and the default were green and it was red (21/22; five reruns green, a 1/6 failure rate), so it stays off. The 1.86× over 14 pairs across 7 families was a paired median measured on the 1.4.4 default and does not carry over to this version. It saves re-verification, but on a task that edits after its tests pass it also suppresses the second verification that task needs, so it went back to off. Numbers and boundaries: `BENCHMARK.md`; the 1.5.0 default's clean rebaseline is 10 families and 30 complete units at **0.72× wall / 0.74× output / 0.71× steps** in total, per-cell wall median **0.64×**, hidden tests 60/60 green, broken down in that page's `## 1.5.1` section. |
| `stallGuard` | `true` | Whether to cap a single shell/script call. Under `auto` the budget self-tunes between 2 and 5 minutes. |
| `toolTimeoutMs` | `0` | Per-call ceiling in milliseconds. `0` = adaptive (see `stallGuard`), negative = no guard, positive = that value for every gear. |
| `guidance` | `true` | Whether to inject the prompt section. Off keeps the scheduler, width computation and watchdog exactly as they are and only stops the text, so "what the text does" can be measured apart from "what the harness does". |
| `shellParallel` | `false` | Whether to register the `shell_parallel` tool (one call, a bounded pool of independent shell jobs). Off by default: measured 2026-10-24 on six 5 s jobs, 9.1 s native vs 26.3 s with the tool (0.35×) — the model already fans shell work out with inline `&` + `wait`, and the extra tool invited a verification pass. |
| `reassertAfterCompaction` | `true` | After a compaction, the next request carries one very short notice restating batching and bounded calls. The guidance section itself is unaffected. |
| `metrics` | `true` | Whether to write the metrics file. Off writes nothing. |
| `metricsFile` | `~/.dsh/fast-mode-metrics.jsonl` | Metrics path, one JSONL row per step; rotated to `.1` past 8 MB. |
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
- the route name is recorded for metrics and debug logs only and takes part in no decision;
- token usage is read in whatever spelling the upstream speaks, with no vendor assumption: the harness's `inputTokens/outputTokens/…`, OpenAI Chat's `prompt_tokens/completion_tokens` (including `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens`), the newer OpenAI `input_tokens/output_tokens`, Anthropic's `cache_read_input_tokens/cache_creation_input_tokens`, and Google's `candidatesTokenCount` all fold to the same numbers, and usage is found under `usage`, `message.usage` or `response.usage`. A gateway that reports no usage at all counts as 0 — step time and call counts come from the harness, not from the provider.

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

On the request path the assignment **outranks** the per-conversation switch — which is why you should not touch the switch during an experiment: the button shows your last choice, while the request may run the assigned arm.

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
- **Settings change only through that click, and only with a revision.** There is no background path that silently edits config; a conflicting write fails and rolls back, and the reason appears in the tooltip.
- **Metrics stay local.** Only `metricsFile` is written; `--lan` is the sole network path, read-only, and needs an explicit token.
- **The guard changes only the signal.** The caller's original signal is restored in `finally`, and the body's rejection after a lost race is swallowed rather than surfacing as an unhandled rejection.

## Honest limitations

**The latency ledger.** Measured on this gateway, a step's wall clock is about `720 ms + 6.63 ms × output tokens` plus tool wait (R² = 0.93 over 689 steps). That equation says reducing steps and reducing tool wait are real levers; thinking effort and raw decode speed are not — the first changes the answer, and no prompt can move the second.

**Fan-out has a precondition.** Widening pays off only when a step really contains several independent queries. On single-file benchmark tasks (HumanEval / AIME shaped) this plugin measured differences inside the noise (0.95×–1.09×) with no measurable speed-up — those tasks have no parallel read set to begin with. "This plugin makes every task 30% faster" is a false claim.

**There is no step-count stop line by default.** 1.5.0 sets both `finishLineSteps` and `stepBudget` to 0: a turn that is still producing new results is not ended by a counter, and not asked to wrap up — cutting a half-finished long task on a step count costs more than being slow. The only recurring directive left is one "change the approach" after 6 consecutive no-progress steps, which swaps method without ending the turn. The constant values still come from small-sample observation and design reasoning; controlled data from real sessions is missing, and `report` and `experiment` exist to close that gap, not to prove it already holds.

**Token use may rise, and that is the accepted trade.** Wider steps mean more tool output per step, hence more input tokens; output discipline trims narration and promises nothing about total tokens. Do not introduce this plugin as "token saving".

**Guidance is advisory, not enforcement.** A model may still issue one call per step. How many calls actually run concurrently is also capped by `agentLoop.maxParallelToolCalls`; when the target width exceeds that cap the plugin warns once and prints a `cordis.patch.yml` fix.

**The guard only sees shell-class tools.** A hung non-shell call (say, a custom tool whose promise never resolves) is outside its scope. Exempt tools are deliberately unbounded — waiting for a user or a background job is supposed to wait.

**The client cannot show live width.** It states 2–8 only in the plugin description; the width the host computed for a given conversation appears only in the guidance section and the debug log.

**The `turnSteps` counting caveat.** It resets on every `turn/start`; if `stepBudget` is set above 0, that ceiling constrains a single turn, and what survives across turns is the scheduler memory, not a spent step budget.

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
- `client.js`: the bolt switch, the right-click panel (three shared settings) and the per-conversation write.

Run the tests:

```bash
node --test test/*.test.js
```

All 223 tests currently pass on Node 20.20.2, 22.23.4 and 24 (223/223 on each, 0 failures). Coverage includes scheduler width and directives, budget precedence, the guidance section's on/off conditions, `sessions` parity between the host and browser implementations, notice source validation, metrics fields, assignment hashing, report and experiment CLI argument parsing, and a regression test that scans the source to confirm nothing assigns `reasoningEffort`.

Documentation entry points: `README.md` (Chinese), `README.en.md` (English), `BENCHMARK.md` (method and historical data), `CHANGELOG.md` (what each version deleted and added).
