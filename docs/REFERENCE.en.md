# Reference: principles, configuration and limits

This manual describes what **dsh-fast-mode 1.7.37** actually does (injection behaviour under the default config is identical to 1.5.0; 1.5.14 added the right-click panel, 1.7.0 gave that panel its seven rows and the three per-session prompt switches, 1.7.1 added the second signal to `actBeforePlan`, 1.7.5 put the three-tier width control in the panel's title row, 1.7.6 made the result-elision marker report the missing line range as well as the character count, 1.7.7 moved the bolt to the list slot beside the model selector and fixed how the footer reads its counts, 1.7.12 made result compaction the eighth panel row, 1.7.28 turned the three tiers into stateless presets whose highlight is derived from the switches, and 1.7.29 put the three deliberation rows back into the panel — measured on top of the `late` prose rule at 0.526x wall clock over 15 pairs — with the Standard and Aggressive tiers loading them; 1.7.30 switched the panel background and border to tokens the theme really defines, so dark mode no longer paints white on white; 1.7.31 cut the panel to four verified rows and two tiers and fixed the Windows hang-job test fixture that depended on an external `sleep`; 1.7.33 fixed a false positive in `repeatNudge`, where different calls returning the same short confirmation counted as "nothing changed"; 1.7.34 added a fifth panel row, the tool-call timeout guard (`stallGuard`, on by default) — a fault guard rather than a speed switch, so it is exempt from the "only verified gains" rule, with its budget and known defects in the watchdog section; 1.7.35 matched monitored tools by word rather than substring and gave the fixed gears an upward-only headroom; 1.7.36 raised every guarding gear to a 150 s floor so the guard can no longer abort a command the host was about to promote to the background, and let a call's own `timeoutMs` widen the ceiling; 1.7.37 changes no behaviour and only corrects two claims measurement had refuted — the `disciplineRepeatAtSteps` premise that long-turn output grows back, and `shapeGate`'s cost — and puts the two scanners under `bench/`), matching `index.js`, `src/` and `client.js` in the repository. It is not a brochure: where something can be measured it gets a number, and where it has not been measured it says so.

**The one contract: fast mode never changes reasoning effort, the thinking budget, or the model.** The `agent/request` hook does exactly one thing — `await next()`, read the `reasoningEffort` the request already carries for measurement, then return it unchanged. Whatever effort the user picked (the per-session choice in the UI, or the effort pinned by the profile's agent-default-model) is the effort every request uses.

Speed comes from three things only: fewer round trips, less redundant output, less tool wait. Each gets a section below.

## Interaction details: the bolt switch and which conversation it applies to

- **One icon, and it is the switch.** The control slot to the right of the conversation input (`conversation.input.right`, a *list* slot, so it sits beside other controls by `id`/`order`) holds a single bolt button: hollow when off, filled when on. One click toggles it, another click toggles back, and that click writes only this conversation. The bolt itself has no gear selector, no caret, no second-level "choose a gear" menu. The single-value activity slot (`conversation.input.activity`) is not used: it renders only its first registrant, so it would fight the plan button and the voice microphone for the same seat.
- **Right-click is the panel, and it has five rows.** Right-clicking the bolt opens the panel, all scoped to the current conversation, in this order: Concise output (`outputDiscipline`), Probe first (`probeFirst`), Act before planning (`actBeforePlan`), Change method on repeat (`repeatNudge`), Tool-call timeout (`stallGuard`). The first four are prompt-side switches and only verified ones are in the panel: `stepBudget`, `workspaceMap`, `openBatch` and `compactResults` were removed in 1.7.31 because none of them showed a stable gain alone or in a measured bundle (the step cap was 1.021x [0.602, 1.807] over 10 valid pairs with the reminder actually firing in 3/12 turns; file inventory 0.927x; batched reads 1.136x; result truncation was never A/B'd alone), and the config keys still work. The three deliberation rows were withdrawn in 1.7.26 and restored in 1.7.29: stacked on top of the `late` prose rule they were 0.526x wall clock [0.390, 0.753] over 15 pairs (14/15 faster, 0 gate violations, reasoning characters 0.431x), the `ledger` family at 1.21x being the only slower one; the honest claim is less thinking and less rework, not that every task gets faster. Since 1.7.28 the tiers are stateless presets: one click writes that tier's switch values into this conversation's entry (Cautious all off; Standard Concise output, the three deliberation switches, and — since 1.7.32 — the opening file inventory and batched reads, which have no panel rows because only the bundle measures a gain), the panel stores no "current tier", the highlight is derived from the switch values, and changing any switch by hand leaves no tier highlighted. Under the Cautious tier `directive: false` turns the four prompt rows off, so the panel reads them as off, greys them out, and writes nothing; switching back to Standard makes them live again. The fifth row is not gated by it — the watchdog lives in the execution layer, Cautious already computes budget 0 and also writes `stallGuard: false`, so that row keeps showing its real state. Each row has a one-line tooltip, records the choice in this conversation's entry in the `sessions` column, leaves the shared defaults alone, and applies from the next request; the whole block is disabled while read-only or mid-write, and a refused write rolls back. A conversation with no entry keeps the configured defaults (`outputDiscipline`/`probeFirst`/`actBeforePlan`/`repeatNudge`/`stallGuard`). The tool-call timeout is the one deliberate exception to "only verified switches appear": it is a fault guard, not an accelerator, and promises no speedup — it just states the per-call ceiling and hands control back. Its costs are stated too: a ceiling that adapts upward from 150 s can still, on a conversation that has never run anything long, be shorter than a one-off job (Gradle, `npm install`, a large test suite) — run those in the background or give the call its own `timeoutMs`, which the guard now honours; the P90 is historical latency, not a prediction of the current task; an abort is a signal, not proof that the whole process group exited (the failure text says so when it could not confirm); monitored tools are matched by word rather than an allow-list. The panel does not expose `disciplineAfterSteps`, `disciplineEarlyCalls`, `disciplineRepeatAtSteps`, `shapeGate`, `finishLineSteps` or `shellParallel`, and not because they went unmeasured: all three compression-reminder knobs were A/B'd. `disciplineAfterSteps: 2` reads 0.695× on debugfix and 0.756× pooled with the two families pointing opposite ways, `disciplineRepeatAtSteps: 8` was 1.394× slower on migrate (`DR8_MIG`), and both directions flip by family with variance too large to sit in a default; `shapeGate` has no measurable gain (1.014× over 6 pairs) and silences the whole reminder channel in 81.7 % of turns, which costs more than it saves.
- **The two-tier width control sits at the right of the panel's title row.** It is not a row of its own: a `role="radiogroup"` labelled `Parallel width` with two `role="radio"` buttons — **Cautious** (`safe`, 2 lanes, no guidance section) and **Standard** (`auto`, the factory default, a 4-lane start that widens and narrows with the recent steps, loading the three deliberation switches) — each carrying `aria-checked` and reaching the other with the arrow keys (only the checked one is in the tab order), and the group is pushed right by `margin-left: auto` in the stylesheet. Its tooltip states the whole point: "The tiers change only how many calls run in parallel, not the mechanism". The tier is saved per conversation like every row, `auto` is what a conversation without a choice gets, and the retired ladder names read as Standard without ever being written back. `aggressive` still resolves internally (8 lanes) for old configs and experiment arms but has no button: its extra three switches are the ones 1.7.31 found unproven, and listing it as a choice would recommend them. `safe` declares `directive: false`, so at Cautious no guidance section is rendered and the scheduler asks for native width 1; `auto` carries the section.
- **Conversations never affect each other, and that is a hard constraint.** Each conversation resolves `enabled`, `gear`, `outputDiscipline`, `probeFirst`, `actBeforePlan` and `repeatNudge` from its own entry in the `sessions` column: A can be faster + less narration while B is faster + full narration at the same time, and C, never touched, keeps the configured defaults. The panel and the bolt write only this conversation's entry and never the shared defaults; at most 200 entries are kept, oldest `ts` pruned first, and a pruned conversation falls back to the defaults.
- **The button answers one question: is this conversation on.** `aria-pressed` is the state and the tooltip is a state sentence, not a number: on reads `Fast mode: on · this conversation · thinking effort unchanged, click to turn off · right-click for settings`, off reads `Fast mode: off · click to turn on · right-click for settings`, and a loading, absent, read-only or refused-write state replaces both with its own line. What makes the mode faster, where the speed comes from, and the per-call ceiling live in the plugin description (`meta.description` and the config descriptions), not in the composer.
- **The panel's footer counts this conversation, not the width.** It is the scope line `This conversation only` with a one-line detail that becomes `{steps} steps · {tokens} out` once the conversation has been measured, falling back to steps alone, tokens alone, or the scope sentence when the figures are not available. The enforced parallel width is deliberately not shown: it is host-side state that changes per step.
- **The bolt writes only what it knows.** One click writes `enabled`, `gear` and this conversation's entry in the `sessions` column, carrying the revision it read. The `gear` it writes is always the constant `auto` — the bolt is not a width picker; the tier control is the only thing that writes a tier choice, and it writes only `gear`. Neither write touches thinking effort or the parallel width measured on a step: width is host-side state that changes per step, so the UI does not pretend to display it.
- **Write path.** Flipping the switch sends one `settings/update` carrying `enabled`, `gear` and `sessions` together, with the `revision` it read; it updates optimistically and polls briefly to confirm. A refusal (stale revision, read-only profile) rolls all of it back and shows the reason, so the button never becomes a dead control; a failed read shows the error and a click retries. Picking a tier sends one `settings/update` carrying only `gear`, and early-returns when that tier is already selected.

## How it works

### 1. What does not change: model, provider, thinking effort

1.0.0 **deleted** the whole "lower the effort" machinery rather than disabling it: `floor`, `ladder`, `aliases`, `deepAfter`, the per-step effort ladder, the `ludicrous → off` special case, and the heuristic that picked an effort from errors or latency all went away with the code. Writing those fields in a config still does not fail (schemastery passes undeclared keys through), but it has **no effect**.

The request hook in full:

1. `const resolved = await next()`;
2. read `resolved.reasoningEffort` and the route name into the metrics label;
3. `return resolved`.

It does not write `reasoningEffort`, does not write a thinking budget, does not switch models, and adds no provider-specific fields. That leaves three real levers: parallel fan-out (fewer round trips), output discipline (less narration), and the stall guard (less tool wait). Thinking depth and decode speed are not among them — the first is the user's contract, and no prompt can make the second happen.

### 2. The adaptive scheduler: width tiers, one mechanism

`auto` is the factory default and the only tier that schedules adaptively; `safe` and `aggressive` are the two fixed ends of the same ladder. Under `auto` the scheduler re-decides two things on every step from the session's own history: how many tool calls the next step may issue in parallel, and how long one tool call may run before it is cancelled. The tiers move only the first of those and the strength of the prompt — never the mechanism, the switches or the thresholds. Since 1.7.31 the panel offers two of them (`safe`, `auto`); `aggressive` still resolves for old configs and experiment arms.

The constants live in `AUTO_LIMITS` in `src/auto.js`:

| Name | Value | Meaning |
|---|---|---|
| `parallelBase` / `parallelMax` | 4 / 8 | First probe, ceiling (`1` is the documented "native" value, so the scheduler can pick it) |
| `widenAfterSteps` | 2 | Steps before width starts following recent behaviour |
| `stallFloorMs` / `stallCeilMs` | 150000 / 300000 | Clamp for the stall budget (2.5–5 minutes; the floor sits above the host's 120 s promotion point) |
| `stallMultiplier` | 3 | Budget = 3× the p90 of recent call latency |
| `noProgressWarn` | 6 | Consecutive no-progress steps that earn one "change the approach" reminder; a reminder only, never an ending |
| `turnStepBudget` | 0 | The scheduler's own hard step ceiling; 0 = off, which is the default |
| `outputBudget` | 0 | Optional output-token budget: at that many cumulative `outputTokens` (upstream usage) in a turn, one reminder to close the current loop and run the check that proves it; 0 = off, which is the default |
| `finishLineSteps` | 0 | Optional soft finish line; 0 = off, which is the default. `10` is the retired 1.4.4 default and is kept only as an ablation arm |
| `disciplineAfterSteps` | 4 | Step at which the late output discipline starts |
| `disciplineRepeatAtSteps` | 0 | Step at which the same compression reminder fires a second time; 0 = never (still at most twice per turn). **Measured and closed**: the premise holds only in part — across long turns the visible prose and tool arguments keep shrinking after the reminder (6.7 → 5.2 characters per step; arguments −62 %), while the rebound is confined to reasoning (75 of 118 long turns, median ratio 2.61); `DR8_MIG` measured 1.394× slower with 1.365× more output over 6 pairs, so the default stays 0 |
| `disciplineEarlyCalls` | 0 | With a positive N, the `disciplineAfterSteps` early entry applies only to a turn that already made at least N tool calls before the current step, otherwise it falls back to the built-in 4; 0 = unconditional, i.e. the 1.5.12 behaviour |
| `waitWindow` | 32 | Recent calls that feed the p90 |
| `directiveCooldown` | 3 | Minimum steps between two scheduler directives |

Width is computed in this order, first match wins:

1. 3 or more errors: **1** (native). Error evidence outranks the request classifier, so a turn that keeps failing is never pushed to batch;
2. the turn already has steps and the request classifier produced a width: **that width** (1–8). It is the only signal available on the first step of a turn, which is why it precedes the "nothing observed yet" probe;
3. no calls in the conversation yet: **4** (one low-cost probe);
4. 3 or more consecutive no-progress steps: **1** (native, and the whole guidance section is not rendered);
5. the previous step was pure reads, made 2 or more calls, and every call's target was distinct (an "independent read block"): **8**;
6. 2 or more consecutive pure-read steps and the previous step made 2 or more calls: **8**;
7. at least one step in the turn, previous step pure reads with 3 or more calls: **8**;
8. 2 or more steps in the turn and the previous step made 2 or more calls: **8**;
9. a new turn's request with no parallel shape in its history: **1** (native);
10. otherwise: **1**.

**Width 1 is native.** At width ≤ 1 the guidance section renders as an empty string; the stall guard still works from its own budget. A write-heavy, strongly sequential or repeatedly failing turn is therefore never pushed to batch, and pays no input tokens for that section.

**"Independent read block" is a programmatic test**: every call in the step is in `SAFE_CALLS` (`bash` deliberately is not), and the parameter signatures are pairwise distinct (no two calls read the same target). That excludes the "looks batched, is actually a chain" shape — when two calls read the same path, the second most likely depends on the first's result.

"No progress" is decided by **result content**, not by character count or call count: each completed call is recorded under a `(tool name, parameters)` signature, and a step has made progress when a result digest changed, when a failure became a success, or when the signature is one not seen before; the same signature succeeding again unchanged does not count. So a status poll whose length never changes, `completed 10 / 99` → `11 / 99`, still counts as progress (the content moved), while re-running one command eight times unchanged in a single step produces one signature and leaves that step without progress. The unit is the **step**: one call bringing a new result makes the step progress.

The stall budget is the p90 of the last 32 tool-call durations, multiplied by 3, clamped to 150–300 s (the floor sits above the host's 120 s promotion point; see the budget precedence above). With no samples yet the p90 is 0, so it clamps to the 150 s starting point; it widens as the conversation slows down and tightens as it speeds up.

Scheduler directives: after `noProgressWarn` (6) consecutive no-progress steps, one "change the approach" — it asks for a different method, not for a stop. There is no step-count-based closing line by default: a positive `stepBudget` sends one "report as-is" at the line, a positive `finishLineSteps` sends one "stop widening scope", and at least 3 steps separate two directives. Directives are injected as a producer-owned notice (`source` is `plugin:fast-mode`), so the model reads them and the conversation record keeps them.

**Check-result reuse (`reuse-check`).** After a parameterised call succeeds, its result is kept under its signature together with the artifact epoch at that moment. If the model then re-runs the same check verbatim with no write in between, the scheduler does not nag it to re-verify; it says the check already passed on the current files, that the result can be relied on, and to finish what remains. Writes, edits, `apply_patch`/`patch`, and shell calls with redirection or one of the common rewrite commands (`sed -i`, `git apply`, `npm`, `make`, …) bump the epoch, and one bump invalidates every stored check at once — so "passed" is never mistaken for "still passes after the code changed". It is **advisory**: no cached result is returned, no call is skipped, no turn is ended, and the model may still re-run. Worth stating plainly: in the local 951 suite transcripts this advice was **never delivered once** (`python3 bench/reminders.py`) — those tasks do not re-run checks verbatim. It is a defensively correct mechanism, not a measured speed source.

Counting: `turnSteps` counts per turn. `index.js` calls `noteTurn` on the `session/event` `turn/start` to zero the per-turn counters, while the conversation-level memory of "what was tried, how long it has been stuck" survives — that is exactly what the loop needs to re-read when it is stuck. There is no default step stop line; setting `stepBudget` above 0 makes that a **per-turn** ceiling, not a budget for the whole conversation.

### 3. Prompt guidance: `fast-mode:execution-speed`

The section's name and order are fixed: `fast-mode:execution-speed`, `order: 520`, right next to the plan strategy and the other cross-cutting execution guidance. It renders per request, and its content follows the conversation's live width:

- off, or width ≤ 1: the whole section is not registered (it renders as an empty string and is dropped);
- on with width > 1: batching rules, the fan-out target, optional prefetch, the bounded-call section, output discipline.

A few details worth knowing:

- **The number in the fan-out target is the width the scheduler computed.** Under `auto` the guidance section and the stall guard share one `autoSchedule` result, so the number the model reads cannot drift from the number being enforced.
- **Prefetch appears only at width ≥ 4.** Below that, fetching one more call only crowds out other work.
- **The bounded-call section appears only when `stallGuard !== false`**, because the rules it states and the guard are one mechanism.
- **Output discipline has two levels**: `light` for the legacy `fast` gear, `full` for `auto`/`turbo`/`max`/`ludicrous`. Both ask the model not to announce calls, not to restate results and not to write progress reports; the final step's answer is still written out in full. `full` only adds "when you need no text, send the call alone". **It does not shorten answers and it certainly does not let the model skip checks.** State the ratio honestly: visible prose is 1.19 % of "prose + tool arguments" characters (def15, all 385 sessions; excluding reasoning and tool results; recompute with `python3 bench/textshare.py --limit 0`), so its value is not in the "deleted characters" themselves but in the fact that it also shortens each step's reasoning (pooled over 168 pairs: `reasoning` characters 0.75×, `emitted` 0.82×). Turning this item off alone (`bench/arms/nodisc.yml`) has a share that is **not measurable today**: the same block (debugfix, 7 pairs) run twice gives `nodisc/def15` of 1.79× and then 0.648×, opposite directions, neither sign test significant, with the block ratio decided by one or two outlier cells (see the LEN3 section of `BENCHMARK.md`). Only the pooled main effect, 0.823×, is reportable, and inside it the discipline line acts together with the rest of the mechanism, so a single-block split is not available (since 1.7.32 the standard tier sells the whole bundle: `QC1` 16 pairs at 0.683x [0.520, 0.893], still a bundle-level result, not a single-switch one); it still does not license the claim that "the work itself is unaffected". To ask whether turning one more switch on top of the default helps, use `python3 bench/ablate.py --ci 2000 --anchor def15`: it pools all blocks by same block, same task and same pair into a geometric ratio with a 95 % CI for each switch against the default (current reading: every optional switch has a CI crossing 1, so stacking one buys nothing measurable).
- **`parallel: 1` is the documented "on but no fan-out" setting**: the switch still applies to the stall guard, and the guidance section disappears entirely.

The cost is explicit: about 2,700 characters under `auto`, paid as input tokens on every request. That is the intended trade — input tokens for fewer round trips.

### 4. The stall guard: a ceiling on one call

It hangs off the `tools/execute` waterfall and follows the only change the documentation allows: replace `exec.signal` so the call body races a timer, abort on timeout, and hand a failure result back to the model. After the abort it waits in two stages for the cancelled body to actually land (a grace period first — up to 5 s when the budget is large, scaled to the budget with a 250 ms floor when it is small — then an **exit confirmation** stage, both together capped at 15 s), and records `quiesced` / `confirmed` / `waitedMs` in the observation. `confirmed: false` means **the process was not seen exiting**: the failure text then does not claim it was cancelled, but says the command may still be running, not to touch the files it may write, and to check with `pgrep -fl` / `ps -o pid,stat,command -p` before retrying. Either way the caller's original signal is restored in `finally`.

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
   | `auto` | 150 s, then the scheduler takes over |
   | `turbo` | 180 s |
   | `max` | 150 s |
   | `ludicrous` | 150 s |
   | `fast` | 300 s |
   | unknown | 300 s |

6. **The floor no guarding gear may go below is 150 s**, because the host's own foreground wait is 120 s: a `bash` call still running after 120 s is promoted to a background job (`promoteOnTimeout` is on by default) and the turn stops waiting on it. A watchdog sitting at 120 s fires first and aborts a command that was working — the guard manufacturing the failure it exists to prevent, which is what happened before 1.7.36. 150 s = the host's 120 s plus a 30 s margin, so promotion always wins.
7. Under `auto`, when the starting value is non-zero and no explicit `toolTimeoutMs` was set, the scheduler's live budget (from the recent p90) replaces the table value — never below the 150 s floor. `auto` is the only adaptive gear; the other names in that table are the legacy fixed-width gears, kept so old configs load and so ablation arms can still name a starting width.
8. **A deadline the call itself declares outranks the guard.** When the tool call carries its own `timeoutMs` (or `timeout_ms`, or `timeout`), the ceiling becomes `max(budget, that value + 30 s)`: the caller said how long to wait, the host's timeout handling will wait that long, and the guard should not cut in halfway. This only ever widens, never tightens; a call without one uses the budget computed above.

A cancelled call returns a normal tool failure (`isError: true`). Its text says the call ran N seconds and was cancelled, gives three concrete suggestions (background the server/watcher, write the long command to a file and run the file, narrow a full sweep to one probe), and closes by saying not to re-issue the same command unchanged — it will be cancelled again.

### 5. State follows the conversation

There are two tiers of state, both in the config's single `sessions` column:

- **The shared `enabled` / `gear` fields** are the default and the most recent choice. A conversation without its own entry inherits them.
- **The `sessions` column** holds per-conversation entries: `{"<sessionId>": {"enabled": true, "gear": "auto", "ts": 1730000000000}}`. Reads prefer the entry field by field; writes update both tiers in one patch, so there is no window where the switch has flipped but the gear has not caught up.

The cap is 200 conversations, evicting the oldest `ts` when exceeded — a bound on memory and config size, not a permissions model. The host implementation (`src/state.js`) and the browser copy (`client.js`) are two pieces of code; tests pin their read/write agreement with the same fixtures.

### 6. The three per-session prompt switches (since 1.7.0, all off by default; 1.7.1 added `actBeforePlan`'s second signal)

All three live on the prompt side: they write not a single character into the request and change no call. What they change is how the model starts this turn (read or think first, act or explain first), and, when it is visibly spinning in place, the fact it is told. The panel turns them on per conversation; the config default is `false`.

After 1.7.1, `actBeforePlan` is one switch with two behaviours pointing the same way: compressing the plan at the start of the turn, and a reminder about reasoning length in the middle of it (see the end of this section). The row count only changed again in 1.7.12, when the compaction switch took it from seven to eight; `actBeforePlan` itself added no config key.

**One shared message.** `probeFirst` and `actBeforePlan` merge into one notice on the turn's first step; both off means nothing is sent, and both on still means one message with one shared GUARD (`GUARD` in `src/deliberation.js`): `None of this cuts validation at trust boundaries, data-loss handling, security, or accessibility.`

**`probeFirst` "look before you guess".** When: on an enabled turn, first step, once. Text (`PROBE_TEXT`, verbatim): ``When you are unsure of a fact about the codebase — a file's contents, a signature, a test's expectation — read it once instead of reasoning about it. One call, the cheapest that answers the question: `grep` before `read`, a range before the whole file. Guessing costs a step and is usually wrong; looking costs the same step and settles it. Read again when a result surprises you, before theorising about why it surprised you.`` It does not name a file to check, does not replace judgement, and does not force any call.

**`actBeforePlan` "act, then explain".** When: the same turn's first step, inside the same message. Text (`ACT_TEXT`): `Do not restate the task and do not re-explain the plan: the reader already has it. Before your first tool call, one line of plan is enough; when the next action is already clear, take it now and explain afterwards only if the result is not self-evident.` "One line of plan" is advisory wording, not machine truncation: the plugin does not count lines and does not intercept calls.

**`repeatNudge` "change method when repeating".** When: mid-turn, only with evidence. Either trigger — the same call (tool name + stable parameters, i.e. `signature`) has already run ≥ `REPEAT_CALLS` (2) times this turn; or different calls returned the same content, i.e. the third consecutive identical result (`STALE_RESULTS` = 2, comparing result digests) where each result is at least `STALE_MIN_CHARS` = 400 characters — a short confirmation (a receipt like "file updated", ~171 characters) does not count: across 78 measured sessions the old rule fired 45 times and all 45 were distinct `edit` calls returning the same 171-character receipt, not one real loop. A single call returning the same thing repeatedly is covered by the first trigger, not this one. The text follows the actual count: `The call you are about to reason about has already run N times in this turn and returned what you have. If the answer did not change, a different call is what changes it — not more thinking about this one.`; or `The last N calls returned the same content. Nothing new is arriving from that direction: decide with what you have, or ask a different question.` Caps: at most `MAX_REPEAT_NUDGES` (2) per turn; the same evidence (`signature` + `digest`) is mentioned once; error results **do not** count as a loop and reset the "result unchanged" streak — an error is the case that deserves more thought. Implementation in `src/deliberation.js` (`createProgressWatch` / `beginTurn` / `noteCall` / `planRepeatNudge`), with the observation table bounded by `RUN_MAX` = 64 conversations and `HISTORY_MAX` = 8 recent calls per conversation; everything sits inside an existing `catch`, so an exception cannot change a tool result.

**`actBeforePlan`'s second signal: reasoning length (1.7.1).** It does not look at tool calls, only at how many characters of reasoning this turn has written. The reading comes from the `reasoning` blocks of the `assistant/message` event, summed by `readReasoningChars` in `src/usage.js` (a missing block or one without `text` counts as 0 — when the route emits no reasoning blocks this switch stays silent), accumulated into `noteReasoning`'s `reasonChars` per turn; `beginTurn` zeroes it on a new user message. The threshold is `REASONING_CHARS` (4000) characters, the n-th reminder's line is `REASONING_CHARS × (n + 1)`, and the cap is `MAX_REASONING_NUDGES` (2) per turn. Text verbatim: ``You have written about N characters of reasoning in this turn. Past that length, more thinking about facts you already have rarely changes the next action: take the action the evidence supports, or read the one fact that is still missing.`` Because the trigger is length alone, this text does **not** say "there is no new information" — it offers two exits: act on the evidence you have, or go read the one missing fact. It writes no request field and changes no return value of `agent/request`.

**What they do not do.** They write no request field (including `reasoningEffort`), change no model and no thinking budget, rewrite no answer, force no tool call, and cut no validation. The wall-clock gain of a single switch is small, and only `actBeforePlan` comes close to significant: across 12 pairs of `debugfix` + `migrate` and 60 runs over 5 arms, `probeFirst` is 0.883× per pair 〔CI 0.663–1.176〕 with 7/12 faster, `actBeforePlan` 0.761× 〔0.578–1.032〕 with 8/12 faster (`debugfix` alone 0.582×, 6/6), `repeatNudge` 1.007× 〔0.839–1.227〕 essentially flat; all three together is 0.647× 〔0.501–0.893〕 with 10/12 faster — only that CI excludes 1. So the panel offers "try it for this task shape", not a "turn one on and it gets fast" promise.

**How to turn them on (after 1.7.1).** Most of the time, all three. Across the four measured blocks only the all-three arm has a CI that excludes 1 in every block: `DP17` 12 pairs 0.647× 〔0.501–0.893〕, `DP18` three families 9 pairs 0.491× 〔0.314–0.788〕, `DP19` pre-release `ab17` 8 pairs 0.701× 〔0.516–0.930〕, `DP20` on the release version 9 pairs 0.372× 〔0.240–0.563〕; pooled 30 pairs 0.505× 〔0.401–0.635〕, 26/30 faster, 30/30 green, 438/438 items. When picking one, pick by symptom: unsure means read once (`probeFirst`, 21 pairs 0.809×, the most conservative), an over-long reasoning chain means `actBeforePlan` (`debugfix` 0.582×), and `repeatNudge` alone buys nothing and is only harmless in the combination. Implementation-shaped tasks (`codeimpl`) occasionally take one extra step (`DP20` has one pair at 1.04×), hence "most of the time", not unconditionally.

**History: why `lazy` was deleted (1.6.0 → 1.7.0).** `lazy`, `lazyEffort`, `lazyVariant`, `src/lazy.js` and the request-side `reasoningEffort` rewrite are all deleted, not default-off. Evidence: in `LZ1`'s 12 pairs and 36 runs, "text only" is 0.389× per-pair geometric wall clock 〔CI 0.252–0.600〕, "text + downgrade" 0.430× 〔CI 0.273–0.677〕, and the two arms head to head 1.106× 〔CI 0.682–1.792〕 — the interval crosses 1, so the downgrade half measured no gain; and it was the only mechanism that changes the answer rather than just the latency, while the route reported reasoning usage 0 across all 9,678 metered rows, so "it really downgraded" could never be confirmed. An unverifiable knob that can also change the answer is not worth keeping, so it went with the code.

## Configuration

In the profile's `cordis.patch.yml`:

```yaml
- id: fast-mode
  config:
    enabled: true
    gear: auto                 # tier the panel writes: safe / auto / aggressive
    # parallel: 4              # optional starting width; auto adjusts it later
    # outputDiscipline: late   # or true / false
    # stepBudget: 0            # per-turn hard step ceiling, 0 = none (default)
    # finishLineSteps: 0       # optional soft finish line, 0 = off (default)
    # outputBudget: 0          # output-token budget, 0 = off (default)
    # probeFirst: false        # per-session panel switches, all off by default
    # actBeforePlan: false
    # repeatNudge: false
    # compactResults: false    # elide the middle of long tool results
    # compactMaxChars: 8000
    # readCache: false
    # stallGuard: true
    # toolTimeoutMs: 0
    # reassertAfterCompaction: true
    # metrics: true
```

`enabled`, `gear`, `parallel` and `sessions` are `.volatile()`: they appear on the Web UI plugin page's form and an edit reaches a running fiber. Every other field is a composition-level troubleshooting knob that only works in a patch and stays off the form.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. Off means exactly native behaviour: no guidance section, no guard, no scheduling. Default-off is what makes "off is off" verifiable. |
| `gear` | `'auto'` | The width tier. The panel writes one of two: `safe` (Cautious — 2 lanes, no output discipline) and `auto` (Standard, the factory default — a 4-lane start that widens and narrows with the recent steps, loading the three deliberation switches; see the panel section). `aggressive` (8 lanes) still resolves for old configs and experiment arms but has no button since 1.7.31. Cautious declares `directive: false`, so `resolveConfig` drops the width to 1, removes the prompt section, and turns off output discipline and the three deliberation channels. The panel greys the four prompt rows under Cautious and reads them as off, so a click can never write a value the gear would silently ignore; the guard row is not gated, because Cautious already computes budget 0 and writes `stallGuard:false`. A non-panel source naming `fast`/`turbo`/`max`/`ludicrous` is parsed to `auto` with one deprecation log; a `fast` already pinned in a conversation's `sessions` entry is the compatibility alias of the Aggressive tier and reads as `aggressive`. |
| `parallel` | derived, 4 under `auto` | Starting parallel ceiling, 1–8. `auto` treats it as a starting point only; `1` means "no batching section". |
| `sessions` | `''` | Plugin-maintained per-conversation overrides, see above. **Do not edit by hand.** |
| `outputDiscipline` | `'late'` | Output discipline. `late` (default) writes no output constraint for the first 4 steps and has the scheduler remind once from step 4; `true` applies for the whole turn; `false` still injects batching and bounded-call rules. |
| `openBatch` | `true` | Opening batch: one notice on the first step of each turn asking for every independent call in one block and shell commands chained with `&&`. A short task spends its time on per-call fixed cost (TTFT ≈ 0.5 s), so one fewer round trip is one fewer TTFT. It only touches the first step of a turn. In the old batches it measured no faster than the default, but **those numbers are retracted** (run directories lived inside the repo and metrics were sliced by byte offset); the clean re-measurement was 1.136x (`open15/def15`, faster in 10/20 pairs). On by default as of 1.7.32: alone it is 1.136x (`open15/def15`, faster in 10/20 pairs), but as one member of the standard tier it helped take `QC1` to 0.683x [0.520, 0.893] over 16 pairs, so it ships with the tier; an explicit `false` still turns it off. 1.5.33–1.7.30 had a panel row; 1.7.31 removed it for lack of a standalone gain, and it is not a panel switch. |
| `probeFirst` | `false` | "Look before you guess": on the turn's first step, one notice telling the model that an uncertain fact about the codebase is cheaper to read once than to reason about, with the cheapest call that settles it. Merged with `actBeforePlan` into a single notice; never forces a call. Off by default. Since 1.7.0. |
| `actBeforePlan` | `false` | "Act, then explain": one notice saying one line of plan is enough before the first tool call and an already-clear action should be taken now. Merged into the same first-step notice. Since 1.7.1 it also carries a second, mid-turn signal that fires on reasoning length (`REASONING_CHARS` = 4000 characters, at most twice per turn) without writing any request field. Off by default. |
| `repeatNudge` | `false` | "Change method when repeating": mid-turn, with evidence only — the same call has already run ≥ 2 times this turn, or three consecutive results were identical and each at least 400 characters (short confirmations do not count). At most twice per turn, the same evidence once, error results do not count and reset the streak. Reads the turn's own calls only; writes no request field. Off by default. Since 1.7.0. |
| `shapeGate` | `false` | Shape gate: once a turn has accumulated at least 4 tool calls with 60 % or more of them writes (tools outside the read-only list), **no reminder is injected for the rest of that turn** and behaviour falls back to native. It only reads tool names — no request, no request-body field. It exists so a task the scheduler cannot accelerate gets left alone: write-heavy work has nothing to batch, and every reminder is a round trip it cannot reuse. An explicit `stepBudget` outranks the gate — "don't accelerate this" must not mean "ignore my stop line". Off by default. Both halves were measured: it has no measurable gain (1.014× over 6 pairs, 3/6 faster, output 0.949×), and it costs a great deal — it closes in **81.7 % of turns (357/437)**, and in long turns it lands at exactly step 4, suppressing the compression reminder, in **50.8 % of them (60/118)**, so it also suppresses the finish-line reminder that sometimes rescues a long tail. That cost comes from counting `bash` as a write: across 4076 real calls `bash` is 60.3 %, `read` 15.7 %, `edit` 14.2 %, `write` 9.0 %, and the read-only list covers only 16.0 % of calls — so the median non-read-only share of a long turn is 91.7 % and 118 of 118 are above 60 %. Counterfactual: counting only `MUTATING_CALLS` (the seven `write`/`edit` names) drops the hit rate to 16.5 % (72/437) and blocks only 0.8 % of long turns (1/118) — that is the shape this gate was meant to have, but with no gain at 1.014× it stays off. **Any future attempt should judge on a per-call signal** (the same file written twice in a row, or a duplicated read-only call inside one step) **instead of a share threshold**. |
| `preferPatch` | `false` | After a whole-file write, remind the model once to send only the changed lines (an edit hunk) when it edits a file that already exists. It arms on a `write` whose body is ≥ 2000 characters, fires on the following step at most once per turn, and the text asks for a byte-identical result — it does not limit what gets written or when the turn may end. Off by default: it only changes the form of the model's output (tool-call arguments), and correctness is decided by file contents, not by how they were sent. Whether it actually saves wall clock is measured by the `pp16` arm in `BENCHMARK.md`. |
| `compactResults` | `false` | Compact tool results. On, a non-error tool result longer than `compactMaxChars` keeps the first 40 % and the last 25 % and replaces the middle with one marker line; grep-shaped results are folded by file and total. The marker names both the dropped characters and the missing line band: `… [fast-mode: elided 4210 chars, lines 88–412] …`; a single-line body has no range and reports characters only, and a folded match count uses its own `[fast-mode: N more matches elided]`. For shell-shaped output the marker also carries the failure lines found inside the dropped band, with their line numbers (`; kept 2 matching lines 121:FAIL …`, at most 12 by default), because a build log that fails in the middle otherwise reads as a clean run. This changes what the model reads, not just the prompt text: it saves input tokens at the cost of the model possibly not seeing the middle and misjudging from what is left. Error results, short results and already-compacted results are untouched, and off restores the original text. Default off, and it is the one switch here that changes the answer's evidence rather than its presentation. 1.7.12–1.7.30 the panel carried a per-conversation row for it too; 1.7.31 removed that row — it changes the model's evidence rather than its presentation, its solo A/B was never run, and the post-hoc `CR` exploration looked unfavourable without preregistration or a delivery audit, so the honest verdict is "no conclusion" and it is not offered as a choice. The config key and the per-conversation `sessions` key still work. |
| `compactMaxChars` | `8000` | Compaction threshold: a tool result is only compacted above this many characters (and only with `compactResults` on). 200–200000. The 8000 default sits below a whole-file read or a long shell output and above ordinary listings and short commands, so those are not touched. |
| `readCache` | `false` | Read dedupe: on, reading the same file again in the same conversation returns the previous result without touching disk when `mtimeMs`, `size` and `inode` are all unchanged; any change invalidates it and re-reads. Single-file reads only — paged reads with `offset`/`limit` do not participate. It does not rewrite the result content; what it saves is wall clock. |
| `compactRereadHint` | `false` | One extra sentence in the compression reminder: do not re-read whole files this turn already wrote. Experimental, off by default |
| `workspaceMap` | `true` | One workspace inventory per conversation: before the first tool call the harness walks the session's working directory itself (depth 2, at most `mapEntries` rows, skipping `node_modules`, `.git`, `dist` and similar) and hands the model one notice with relative paths and byte sizes plus the test entry points it can see (an `npm test` script, `tests/`, pytest config, `go`/`cargo`/`make`). It replaces exactly the "what is in the directory" round trip (35.7 % of recorded calls in W8b) — it hides nothing, limits no read, and has no say in when the turn ends; the inventory is passed through unedited and which file to open stays the model's call. On by default as of 1.7.32, as part of the standard tier only: on its own it measured 0.927x (output −10 %, steps +10 %), but bundled with batched reads, concise output and the three deliberation switches it took `QC1` to 0.683x [0.520, 0.893] over 16 pairs, so it ships with the tier; an explicit `false` still turns it off. 1.7.31 removed its panel row and it stays off the panel — no single member of the bundle shows a speedup. |
| `mapEntries` | `60` | Row cap for `workspaceMap`, 10–200. The notice text has its own ~1.4 kB ceiling; when it truncates it says "first N of M" and keeps the test-entry line. |
| `stepBudget` | `0` | Per-turn hard step ceiling. `0` = unlimited, which is the default: a step count measures cost, not whether the task is done, so nothing is asked to wrap up on a counter. The panel row that cycled 0/15/30 was removed in 1.7.31: `PANEL2` measured 1.021x [0.602, 1.807] over 10 valid pairs and the notice only fired in 3/12 turns, so it is a guardrail, not a speedup, and stays a config key. Set above 0, the line sends one "report where you are" notice without blocking tools — a hard cut would land mid-edit. |
| `outputBudget` | `0` | Output-token budget: once cumulative `outputTokens` in the turn (the upstream `usage.outputTokens`, not an estimate) reach this value, one reminder to close the current loop, run the check that proves it, and report — at most once per turn. `0` = off, which is the default. It triggers on real decode volume rather than step count — three steps that write 30 000 tokens are expensive, twenty steps that write 2 000 are not — but tokens are still a cost signal, not evidence of completion, so it ships off. |
| `finishLineSteps` | `0` | Optional soft finish line: at step N the scheduler asks once to stop widening scope, skip checks that already passed, and fix only what still fails. `0` = off, which is the default. **`10` is the retired 1.4.4 default and is kept only as an ablation arm, not as a recommendation**: it was the fastest configuration measured in the old batches (**those numbers are retracted** for the two measurement defects above), but it fails the gate — on `ledger` p1 both the baseline and the default were green and it was red (21/22; five reruns green, a 1/6 failure rate), so it stays off. The 1.86× over 14 pairs across 7 families was a paired median measured on the 1.4.4 default and does not carry over to this version. It saves re-verification, but on a task that edits after its tests pass it also suppresses the second verification that task needs, so it went back to off. Numbers and boundaries: `BENCHMARK.md`; the 1.5.0 default's clean rebaseline is 10 families and 30 complete units at **0.72× wall / 0.74× output / 0.71× steps** in total, per-cell wall median **0.64×**, hidden tests 60/60 green, broken down in that page's `## 1.5.1` section. |
| `stallGuard` | `true` | Whether to cap a single shell/script call. Under `auto` the budget self-tunes between 2.5 and 5 minutes. |
| `toolTimeoutMs` | `0` | Per-call ceiling in milliseconds. `0` = adaptive (see `stallGuard`), negative = no guard, positive = that value for every gear. |
| `guidance` | `true` | Whether to inject the prompt section. Off keeps the scheduler, width computation and watchdog exactly as they are and only stops the text, so "what the text does" can be measured apart from "what the harness does". |
| `shellParallel` | `false` | Whether to register the `shell_parallel` tool (one call, a bounded pool of independent shell jobs). Off by default: measured 2026-10-24 on six 5 s jobs, 9.1 s native vs 26.3 s with the tool (0.35×) — the model already fans shell work out with inline `&` + `wait`, and the extra tool invited a verification pass. |
| `reassertAfterCompaction` | `true` | After a compaction, the next request carries one very short notice restating batching and bounded calls. The guidance section itself is unaffected. |
| `metrics` | `true` | Whether to write the metrics file. Off writes nothing. |
| `metricsFile` | `~/.dsh/fast-mode-metrics.jsonl` | Metrics path, one JSONL row per step; rotated to `.1` past 8 MB. `DSH_FAST_MODE_METRICS_MAX_BYTES` raises that cap for the duration of a benchmark window, so a byte-offset read is not cut in half by a rotation. |
| `benchmarkFile` | `~/.dsh/fast-mode-bench.json` | Experiment assignment path. Missing file, or `enabled` not true, means no assignment. |

On the old names: the schema still accepts `fast`, `turbo`, `max` and `ludicrous` (otherwise an old patch would fail to load), but when one appears in a user config `resolveConfig` maps it to `auto` and logs a warning that the name used to lower thinking effort, that it now runs the auto scheduler, and that the effort stays whatever the user chose. The experiment path's per-session override is the exception and keeps the name verbatim (see "Assigning gears per session"); a `fast` pinned in a conversation's own `sessions` entry is the documented compatibility alias of the Aggressive tier, so it reads as `aggressive`.

On `safe`: it is now the Cautious tier of the panel, not an experiment control arm. It declares `directive: false`, so no guidance section is registered and the width the scheduler actually asks for collapses to native 1; what the tier promises is two lanes and no output discipline, and what it does not do is add prompt text or a device. The other retired names (`turbo`, `max`, `ludicrous`, and `fast` whenever it is not the tier alias) remain experiment-arm spellings only.

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
| `effort` | **The reasoning effort the request actually carried** — exactly the level picked in the UI, verbatim. Since 1.7.0 no path can make it differ from that choice |
| `effortBase` | Legacy field: 1.6.x used it to record the pre-downgrade choice. 1.7.0's code never sets it, so new rows usually lack the key; it is kept only to read old metrics files |
| `route` | Route/model label, used only for grouping |
| `ttftMs` | Time to first token: step start to the first assistant message |
| `llmMs` | Model time: step start to the last assistant message |
| `stepMs` | Whole-step time, including tool wait |
| `calls` / `errors` | Tool calls in the step, and how many failed |
| `input` / `output` / `reasoning` | Upstream usage tokens; omitted when unavailable |
| `cacheRead` / `cacheWrite` | Upstream usage cache tokens |
| `assistantMessages` | Assistant messages in the step |

The `effort` column is how you read the request path: it records what the request **actually sent**, so choosing `high` in the UI means every row says `high`. Since 1.7.0 that column is a reading, not evidence of a write by the plugin — no path exists that can make it differ from the choice. There is also a separate `reasoningChars` channel: the reasoning character count taken from `agent/assistant-stream`, which does not depend on the provider reporting `reasoning_tokens` and is used to judge whether a step thought for a long time, independent of the gear.

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

- **Observe, do not rewrite.** `tools/pre-execute` / `tools/post-execute` are pure observers (start time, call result), and `agent/request` returns the request unchanged. Beyond the guidance section and three producer-owned notices (the post-compaction reminder, a scheduler directive, and the repeat nudge that only exists in a conversation with `repeatNudge` on), the plugin writes nothing into the conversation.
- **Model and effort are not writable.** There is no assignment to `reasoningEffort` anywhere in the source, and no `decideEffort` from 0.9.x: `test/effort.test.js` scans every file, requires the match count of `/reasoningEffort\s*:/` to be **0**, and still bans the old `thinking:` and `floor`/`effort` field names. "The plugin secretly lowered the effort" is not forbidden; that code simply does not exist.
- **Settings change only through that click, and only with a revision.** There is no background path that silently edits config; a conflicting write fails and rolls back, and the reason appears in the tooltip.
- **Metrics stay local.** Only `metricsFile` is written; `--lan` is the sole network path, read-only, and needs an explicit token.
- **The guard changes only the signal.** The caller's original signal is restored in `finally`, and the body's rejection after a lost race is swallowed rather than surfacing as an unhandled rejection.
- **Every cache has a bound.** All 8 caches the plugin holds are keyed by ids that never repeat (session id, `callId`, `${sid}${cwd}`), and a host process lives for weeks, so none is left unbounded: `compacted` 200, `mapSent` 500, `autoBudgets` 200, `startedAt` 2000, `warnedCaps` bounded, the measurement sink's `labels` 2000 / `steps` 2000 / `open` 2000 / `pendingChunk` 1000, and `src/auto.js`'s conversation state 200 (LRU). Eviction goes through `trim(cache, cap)` in `src/bounded.js`, in insertion order. The caps sit far above real concurrency, so normal use evicts no live entry; evicting one still cannot write a wrong row — a metrics row records `mode: 'unknown'` rather than borrowing another gear. With the sink closed, `label()` writes nothing (and the default config leaves it closed). `bench/soak.mjs` verifies this black-box over 20 000 conversations (−0.1 KB/conversation).

## Honest limitations

**The latency ledger.** Measured on this gateway, a step's wall clock is about `720 ms + 6.63 ms × output tokens` plus tool wait (R² = 0.93 over 689 steps). That equation says reducing steps and reducing tool wait are real levers; thinking effort and raw decode speed are not — the first changes the answer, and no prompt can move the second.

**Fan-out has a precondition.** Widening pays off only when a step really contains several independent queries. On single-file benchmark tasks (HumanEval / AIME shaped) this plugin measured differences inside the noise (0.95×–1.09×) with no measurable speed-up — those tasks have no parallel read set to begin with. "This plugin makes every task 30% faster" is a false claim.

**There is no step-count stop line by default.** 1.5.0 sets both `finishLineSteps` and `stepBudget` to 0: a turn that is still producing new results is not ended by a counter, and not asked to wrap up — cutting a half-finished long task on a step count costs more than being slow. The only recurring directive left is one "change the approach" after 6 consecutive no-progress steps, which swaps method without ending the turn; 1.7.0's `repeatNudge` is a separate path again, off by default and evidence-only (the same call already run ≥ 2 times, or three identical results in a row of at least 400 characters each), and the two thresholds must not be read as one. The constant values still come from small-sample observation and design reasoning; controlled data from real sessions is missing, and `report` and `experiment` exist to close that gap, not to prove it already holds.

**Token use may rise, and that is the accepted trade.** Wider steps mean more tool output per step, hence more input tokens; output discipline trims narration and promises nothing about total tokens. Do not introduce this plugin as "token saving".

**Guidance is advisory, not enforcement.** A model may still issue one call per step. How many calls actually run concurrently is also capped by `agentLoop.maxParallelToolCalls`; when the target width exceeds that cap the plugin warns once and prints a `cordis.patch.yml` fix.

**The guard only sees shell-class tools.** A hung non-shell call (say, a custom tool whose promise never resolves) is outside its scope. Exempt tools are deliberately unbounded — waiting for a user or a background job is supposed to wait.

**The client cannot show live width.** The bolt, the panel and the tier control show state, never the number the scheduler computed: the 2–8 range lives in the plugin description and the config descriptions, and the width chosen for a given conversation appears only in the guidance section the model reads and in the debug log.

**The `turnSteps` counting caveat.** It resets on every `turn/start`; if `stepBudget` is set above 0, that ceiling constrains a single turn, and what survives across turns is the scheduler memory, not a spent step budget.

**Result compaction can hide the one line that mattered.** `compactResults` is off by default on purpose: it is the only switch here that changes what the model reads. A middle band that turns out to be the bug is exactly the part it elides, and the marker (character count plus line range) is the only recovery path — the model has to re-read that band. Prefer it when results are large and repetitive, not when an error's surroundings are the point.

## Development and tests

Module layout:

- `index.js`: assembly, hooks, per-session config resolution, guidance section registration;
- `src/auto.js`: scheduler state, width, budget, directives;
- `src/guidance.js`: the model-facing text;
- `src/stallguard.js`: the guard and budget precedence;
- `src/effort.js`: gear table and legacy-name normalisation (no effort ladder anymore);
- `src/deliberation.js`: the three prompt switches (`PROBE_TEXT` / `ACT_TEXT` / `GUARD`), progress watching, the repeat-nudge decision, and the reasoning-length nudge (`REASONING_CHARS` / `noteReasoning` / `planReasoningNudge`);
- `src/config.js`: schema and form fields;
- `src/state.js`: parsing and encoding the `sessions` column;
- `src/notices.js`: producer-owned notice construction and source validation;
- `src/metrics.js`: JSONL metrics and summaries;
- `src/compact.js`: tool-result elision and its marker;
- `src/benchmark.js`: per-session hash assignment;
- `src/peers.js`: conflicting-plugin detection;
- `client.js`: the bolt switch, the right-click panel (five rows, plus the two-tier width control in the title row) and the per-conversation write.

Run the tests:

```bash
node --test test/*.test.js
```

All 426 tests currently pass on Node 24.16.0 (426/426, 0 failures, `node --test test/*.test.js`, about 10.6 s). Coverage includes scheduler width and directives, budget precedence, the guidance section's on/off conditions, `sessions` parity between the host and browser implementations, notice source validation, metrics fields, assignment hashing, report and experiment CLI argument parsing, the two-tier panel control (`test/client-gear.test.js`), result elision (`test/compact.test.js`), read dedupe (`test/readcache.test.js`), the three prompt switches' text and progress watching (`test/deliberation.test.js`), and a regression test that scans the source to confirm nothing assigns `reasoningEffort`.

Documentation entry points: `README.md` (Chinese), `README.en.md` (English), `BENCHMARK.md` (method and historical data), `CHANGELOG.md` (what each version deleted and added).
