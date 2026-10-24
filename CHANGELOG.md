# Changelog

## 0.9.0

Tool wait is the third lever, and the panel stops claiming measurements it never
made.

- **A stall guard bounds one tool call.** `tools/execute` now races a guarded
  shell-style call (`bash`, `script`, `monitor`, `pwsh`…) against a per-gear
  budget: 300 / 180 / 120 / 90 s for Cruise / Sport / Track / Redline, and no
  watch at all on Eco. On expiry the plugin aborts *its own* controller — never
  the caller's signal, which the registry re-fuses anyway — gives the tool 250 ms
  to unwind, restores the caller's signal, and returns a `ToolExecutionFailure`
  telling the model to move the work to `run_in_background`, pass a `script_path`
  instead of a heredoc, narrow the probe, and never re-issue the same command
  unchanged. Waiting tools (`ask_user_question`, `wait_agent`, `job_output`,
  `job_list`, `task_board_run`, `workflow`, `subagent`, `subagent_fork`) and the
  file tools are exempt. The ceiling is a **policy budget, not a measurement**;
  `stallGuard: false` or `toolTimeoutMs: -1` disables it, `toolTimeoutMs: 90000`
  applies one number to every gear.
- **The prompt half ships with it.** Four rules joined the execution-speed
  section: bound any command that can hang, prefer `run_in_background`, write
  long/quoted/multi-line commands to a file instead of a heredoc, and change the
  command before retrying one that was cancelled or came back malformed.
- **`dsh-batch-tool-calls` and `dsh-ops` must not be enabled together with it.**
  The batch plugin is a static, gear-blind subset of this guidance; the ops plugin
  adds two shells plus Windows-only binaries and conflicting timeout advice. The
  host reads the profile's dependency files once on load (and probes for live
  `ops_*` tools); if either is present it logs one warning and appends one notice
  to the next step, then goes quiet. It never hard-fails the user. Both reference
  manuals document the conflict.
- **The panel says "estimate", and shows the one number that is not.** The footer
  now reads `倍率预估 · 单次调用 ≤ 3 分` instead of `倍率 = 相对 Eco 的实测中位数`:
  our own runs do not support a per-gear speed or token ratio — on single-file
  tasks every enabled gear lands within noise of `safe` — so the multipliers are
  labelled as estimates while the stall ceiling is quoted straight from the
  host-side table for the selected gear.
- **The five gears have names now: Eco / Cruise / Sport / Track / Redline.** The
  ids are unchanged (`safe` / `fast` / `turbo` / `max` / `ludicrous`), so existing
  patches, settings and experiment files keep working — only the labels moved.

- **The five gears have names now: Eco / Cruise / Sport / Track / Redline.** The
  ids are unchanged (`safe` / `fast` / `turbo` / `max` / `ludicrous`), so existing
  patches, settings and experiment files keep working — only the labels moved.
- **The gear menu labels its own columns.** The 0.8.0 popover printed
  `1.6x · 1.5x` with no header, so nothing said which number was the speed and
  which was the token cost. A `Gear / speed / token` header row now shares one
  CSS grid with the five gear rows: the numbers sit under their labels, right
  aligned in tabular figures, in both locales. Each row's `aria-label` names the
  columns too, so the pair is not opaque to a screen reader either.
- **The fine print wraps instead of running off the edge.** The old single line
  (`倍率预估：速度 · token * 关闭思考，质量会下降`) was `white-space: nowrap`
  inside a 196 px popover and got clipped mid-sentence. It is two short lines in
  a footer above a hairline now — the estimate note (which also carries the
  selected gear's stall ceiling) and the warning — and both wrap.
- **README: 484 lines to 98.** The front page keeps the principle, the measured
  table, thirty-second setup, the five gears, the coexistence rules and what is
  next, one short paragraph each. Configuration, logging, measurement instruments,
  experiment methodology, safety boundary, limits and the test guide moved to
  `docs/REFERENCE.md`. The result table states the honest part in the open:
  turbo is 537 ms slower and 5 % fatter per step — it wins on step count.

198 tests, green. `test/stallguard.test.js` (12) covers the budget table, the
signal dance, the failure text, the frozen notice messages and the peer scan;
`test/plugin.test.js` adds the wiring cases (registration, a hung `bash`
cancelled at `toolTimeoutMs: 20`, passthrough, the post-compaction reminder);
one `test/client.test.js` case pins the footer to the host-side budget table so
the two halves cannot drift.

## 0.8.0

Everything up to 0.7.0 optimised effort, and Experiment E showed effort is not the
lever on a self-hosted route: raising it does not shorten a session. What does
shorten a session is fewer round trips and less visible text. 0.8.0 pulls both,
and it measures the result instead of asserting it.

- **The execution-speed guidance is one system-prompt section, not a rewritten
  prompt.** `fast-mode:execution-speed` at order 520 states the batching rules,
  the gear's parallel target, the speculative-prefetch line and the
  output-discipline layers. It is injected only for gears marked `directive`, so
  `safe` injects nothing at all — it stays the pre-0.8.0 behaviour and works as
  the control arm.
- **Output discipline is the largest single lever.** `outputDiscipline` (default
  `true`, not volatile, so changing it needs a reload) tells the model not to
  narrate around tool calls, not to restate file contents, and not to write
  end-of-step progress reports. Measured: per-step output **640 → 190 tokens**.
- **Gears gain a `parallel` target and a `discipline` level**: safe 2 / fast 4 /
  turbo 6 / max 8 / ludicrous 8 per step; safe injects no discipline, fast gets
  the light version (three prohibitions), turbo and above the full version plus
  speculative prefetch. An explicit `parallel` overrides the target — `gear:
  turbo` + `parallel: 8` fits two more independent calls into the same round
  trip and never adds a step.
- **A warning when the profile caps the target.** If `agentLoop.maxParallelToolCalls`
  sits below what the gear asks for, one warn names the cap and the line to
  change in `cordis.patch.yml`; it fires once per distinct `parallel` value, not
  once per request.
- **Measurement: `bin/experiment.mjs`, and Experiment E.** 16 same-task sessions
  assigned by hash rather than clicked, `safe` vs `turbo`: median Σ step time
  25.9 s → 15.6 s (−40 %), median steps 7.5 → 4.5, per-session output tokens
  3,798 → 2,180 (−43 %), Mann–Whitney p = 0.008, and all ten answer facts agreed.
  Raw data and the caveats (uneven arms, small n) are in BENCHMARK.md.
- **The trade, stated plainly**: this plugin does not save tokens; it spends
  tokens to buy time. Every lever here adds tokens to the same route's request,
  and none of them works by making the model dumber.

173 tests (8 new in `test/guidance.test.js`); the suite is green.

## 0.7.0

Fast mode was a global switch wearing a per-conversation costume: the bolt sits in
one composer, so clicking it read as "this conversation", and it changed every
conversation in the app. Two sessions side by side, one clicked, both accelerated —
and nothing in the UI said so.

- **The switch and the gear are per conversation now.** A click writes that
  conversation's own `{enabled, gear}` entry; the panel says `仅本会话生效` /
  `This conversation only` under the switch, so the scope is stated where the
  decision is made instead of being inferred.
- **A conversation with no entry inherits the shared pair**, which doubles as the
  record of the last choice made anywhere. A brand-new conversation therefore
  starts from the last selection rather than from the schema default — the
  behaviour asked for, and the reason the shared fields still exist.
- **Precedence is explicit**: experiment assignment > that conversation's entry >
  shared default. An assigned trial still outranks the UI, because a click that
  quietly overrode the arm would empty the control group of the very trial the
  user asked for.
- **One click, one patch.** The shared `enabled` / `gear` and the `sessions` entry
  travel in a single `settings/update` carrying the revision that was read. Two
  writes would mean a window where the panel shows one gear and the request runs
  on another, plus a second revision race; a refused write rolls back all three
  fields and states the reason in the panel.
- **The column is bounded and forgiving.** `sessions` holds at most 200 entries,
  oldest pruned first by `ts` (a pruned conversation just falls back to the
  shared default). A hand-edited or truncated value degrades to "no overrides"
  and never takes the chip down.
- **The two copies of the format are tested against each other.** The host reads
  the column (`src/state.js`), the browser half writes it (`client.js`), and a
  drift between them is a switch that looks on and changes nothing — so the
  shipped `client.js` is loaded in a `vm` and fed the same fixtures as the host
  module. Writing the test found one real drift (the browser copy accepted an
  empty session id the host drops), which is now fixed on both sides.
- The conversation id reaches the client half through the slot's own scoped
  `inject(sessionId)`; the chip also accepts a standard `sessionId` prop, so a
  release that stops injecting one spelling still behaves.
- One caveat, stated where a user will hit it: `sessions` renders as a text input
  on the plugin settings page, because this build of schemastery has no
  `.hidden()`. Its description says it is maintained automatically; editing it by
  hand is how a conversation ends up running a gear nobody chose.

165 tests.

## 0.6.2

The measurement was wrong in the one way that matters most: it counted time but
not tokens, and it lost which step each row belonged to.

- **Read the event payload where it is.** `session/event` carries its payload in
  `event.data` (`{turn, step, usage, …}`); the recorder was reading `event.turn`
  and `event.usage` off the envelope, so every row from 0.6.0 and 0.6.1 had
  `turn`/`step` missing and `input`/`output` at zero while timings looked fine.
  Rows now carry step numbers and real token counts, and both the harness
  spelling (`inputTokens`, `reasoningTokens`, `cacheReadTokens`) and the gateway
  spelling (`uncachedInputTokens`, `thoughtTokens`, `cachedReadTokens`) are
  folded.
- Two regression tests feed the wrapped shape, so this cannot come back quietly.
- Rows already written to `~/.dsh/fast-mode-metrics.jsonl` keep their zeros;
  delete the file or filter by `ts` when comparing against new data.

147 tests.

## 0.6.1

0.6.0 could compare gears, but not against the thing they are supposed to beat.
An assignment always switched the mode on, so a randomized trial had no baseline:
the only "off" sessions were ones somebody happened to run before starting the
experiment, which is not an arm — it is a convenience sample.

- **`"off"` is a legal arm.** The assignment file and
  `dsh-fast-mode-experiment --gears` now accept `off`, meaning the control group:
  the session runs with the plugin switched off **because the experiment said so**,
  not because a switch was left alone. `off` is always accepted even when the
  options do not list it, and the CLI now defaults to
  `off,safe,fast,turbo,max`, so a fresh `start` is a controlled trial rather than
  a ranking. `start` says which kind of run it wrote: with `off` it promises a
  baseline, without it it warns that the report can only rank arms against each
  other.
- **The control arm is deliberately invisible to the switch.** A session assigned
  to `off` returns the request untouched even when the global switch is on — the
  one place where the UI can disagree with what a session actually does, which
  the experiment output and both READMEs now state plainly.
- Also lands in this release: `bin/experiment.mjs` is documented and exposed as
  the `dsh-fast-mode-experiment` bin with an npm script, and `--lan` follows
  `--since` into the dashboard's own `1d`/`7d`/`30d` window (default `7d`) rather
  than always asking for one day and quietly printing nothing.

145 tests.

## 0.6.0

0.5.2 made the switch work. 0.6.0 makes the claim checkable: fast mode measures
itself, assigns gears to sessions for comparison, and reports the result from a
terminal. It also adds one gear above `max`, because on the official route that
is the only honest way past the 2× ceiling.

- **Measurement is built in and on by default.** A `session/event` tap folds
  every step into `~/.dsh/fast-mode-metrics.jsonl`, one JSON line per completed
  step, for sessions with the switch **off** as well as on — a comparison needs
  both sides, and nobody remembers to enable measurement before an A/B. A row
  carries `v, ts, sid, turn, step, mode` (`on|off|unknown`), `gear` (or `off`),
  `effort`, `route`, `ttftMs` (step start → first assistant message), `llmMs`
  (step start → last assistant message), `stepMs` (the whole step), `calls`,
  `errors`, `input`, `output`, `reasoning`, `cacheRead`, `cacheWrite` and
  `assistantMessages`. `metrics: false` disables it; a write failure is
  swallowed and never fails a request.
- **Experiment assignment without a UI.** An optional
  `~/.dsh/fast-mode-bench.json` (`benchmarkFile`) assigns gears per session:
  `{"enabled": true, "gears": ["safe","fast","turbo","max"], "sessions": {"<session id>": "turbo"}}`.
  An explicit pin wins; otherwise the gear is `FNV-1a(session id) mod gears`.
  The file is re-read on a 1 s TTL, so an edit applies to the next request, and
  deleting it returns control to the configured switch. A session an experiment
  assigns runs on that assignment even with the switch off — letting a forgotten
  click decide the arm would silently put the session in the control group.
  Unknown gear names are dropped with one warning.
- **The experiment has a command, not a JSON file you edit by hand.**
  `bin/experiment.mjs` (package bin `dsh-fast-mode-experiment`) writes the
  assignment file, reports how many sessions and steps each arm has collected so
  far (`status`, including whether a disabled-state sample exists at all), and
  refuses to overwrite a running experiment without `--force`. An experiment is
  what makes the numbers trustworthy: the arm is chosen by the session-id hash,
  not by whoever wants the better result.
- **A report command instead of a spreadsheet.** `bin/report.mjs`
  (package bin `dsh-fast-mode-report`) reads the JSONL and prints a per-stance
  table plus a speedup table against the `off` baseline. The unit is the step;
  session wall clock is not used, because it mostly measures the human. Flags:
  `--file`, `--since 2d|12h|90m`, `--json`, `--lan`, `--help`. `--lan` joins
  local rows to the self-hosted usage dashboard by session UUID using
  `USAGE_TOKEN` (optional `USAGE_BASE`): read-only, nothing leaves the LAN, and
  the token is never printed. The dashboard's own window (`1d`/`7d`/`30d`)
  follows `--since` instead of always asking for one day. An unreachable,
  slow or unauthorised dashboard degrades to one note; it never costs you the
  local report.
- **New gear `ludicrous` (极速), above `max`.** It is the only gear whose floor
  is `off`, i.e. it may set `reasoningEffort: 'off'`, with a fan-out target of 8
  and `deepAfter: 1`. That is not "a bit faster than max": the official route
  declares `off/low/high/max`, so with thinking on the only legal cut is
  `high → low` (≈2×) and 3–4× requires turning thinking off, which this gear
  does. The panel therefore marks it `极速*` / `Ludicrous*` and the footer says
  `* 关闭思考，质量会下降`. The plugin still never emits an id the route does
  not declare — on a route without `off`, the gear degrades to what the ladder
  offers.
- **The chip is one bolt, and the panel is behind it.** The caret and its inline
  dropdown are gone. Clicking the bolt opens a panel holding the on/off switch,
  the five gear rows (each with its estimated multipliers, the current one
  marked) and the fine print, plus a status line that states the reason when a
  write is refused. Clicking does not toggle; picking a gear while fast mode is
  off still arms `enabled` in the same write.
- **The gear is a name.** `gear` is a schema union of
  `safe/fast/turbo/max/ludicrous`; a number or a typo is a load-time error, as
  `src/config.js` already documented. The policy layer still normalises
  defensively, so a bad value can never become "unlimited", but it no longer
  silently becomes `safe` either.
- **Measurement paths are composition knobs.** `metricsFile` and
  `benchmarkFile` are deliberately not `.volatile()`: they are read at load and
  do not belong on a live form. Moving the JSONL is a `cordis.patch.yml` edit.

Tests 142: the measurement tap proves off sessions are measured too (one row per
step, first-token vs last-message latency in a multi-message step, token and
error sums, per-session isolation, a missing directory created on first write,
an empty path disabling the sink); the assignment proves a stable hash that
covers every gear, an explicit pin, a single-session pin, a live 1 s re-read,
inertness without a file or with `enabled: false`, and one complaint for a
broken file; the report proves both tables, a one-sided refusal in words,
`--since` including the wider dashboard window, `--json`, `--help` reading no
file, `--lan` without a token and with one (the token is never printed), and an
unreachable dashboard degrading to a note; the client proves the contract after
the caret removal — one icon, clicking opens the panel and writes nothing by
itself, the switch writes once and a second click turns it back off, five rows
with estimates and an asterisk on `ludicrous`, and picking a gear while already
on leaves the toggle alone; and the schema proves an unknown gear name is a
load-time error, measurement is on by default, and exactly
`enabled`/`gear`/`parallel` are volatile.

## 0.5.2

0.5.1 shipped the switch but left it inert, and the reason was one wrong field
access:

- **The remote protocol wraps every answer in `{ ok, value }`.** The chip read
  `remote.settings.describe().namespaces` straight off the envelope, so it always
  got `undefined`, classified this plugin as "not configured", and rendered a
  `disabled` button. Chrome suppresses `title` on a disabled button, so hovering
  said nothing, and the click handler's guard swallowed every click — a control
  that was fully explained inside the code and completely dead on screen.
  `unwrap()` now handles the envelope (and a bare payload, so a service stub
  still works), `ok: false` surfaces `error.message`, and every remote call has a
  deadline so a pending bridge becomes a visible error instead of an endless
  "loading".
- **The chip is never disabled.** Read-only, unknown and missing-namespace states
  all stay clickable and open the menu with the reason in words.
- **The gear lives on the chip.** The caret opens a dropdown listing the four
  gears, each row showing its estimated speed and token multiplier
  (`速度 ~1.6× · token ~1.5×`) and marking the current one. Picking a gear while
  fast mode is off turns it on in the same write. There is deliberately no gear
  form on the plugin page: this harness renders no generic schema form, so one
  working entry point beats a second half-working one.
- **Host-side traceability.** With `debug` on, `apply` writes one line per load
  before the `enabled` check (`apply v0.5.2 entered enabled=… gear=…`), then one
  more saying it registered nothing; after two seconds it also reports whether
  `settings.describe()` actually serves this namespace. A future "the chip does
  nothing" report is now one log line away from an answer.

Tests 89: the client suite runs the real bundle against the real wire envelope,
including the bare-payload tolerance, the refused write, the read-only chip, the
missing namespace, and the gear multipliers.

## 0.5.1

0.5.0 shipped a settings switch that could not be switched. Two defects, both
about how the `settings` service treats a schema field:

- **The three form fields were not `.volatile()`.** `settings.describe()` projects
  a Config through `volatileForm`, which keeps only nodes carrying
  `meta.volatile`; with none, the whole entry disappeared from the form — so
  there was no settings page, the composer chip read it as "absent" and stayed
  greyed out, and `settings.update()` would have refused the write with
  `Config field "enabled" is not volatile`. `enabled`, `gear` and `parallel` are
  now declared volatile, which is also what lets an edit land on a running fiber
  without remounting the plugin.
- **A volatile field is a reference, not a value.** The Loader hands a running
  plugin a frozen `{get()}` reference so it can swap the value in place;
  `config.enabled === true` would therefore have been false with the switch on.
  `resolveConfig` now dereferences at that single boundary (and still accepts a
  plain config object), and the module documents the protocol.

Tests 80: the schema now has to prove every form field is volatile, and that a
reference from the Loader reads as an armed switch.

## 0.5.0

Fast mode becomes something you switch, not something an install decides for you.

- **Opt-in.** `enabled` now defaults to `false`, and `apply()` registers nothing —
  no hooks, no prompt section, no discovery — until something sets it to `true`.
  Only a literal `true` arms it; `1` or `"yes"` do not.
- **A lightning switch in the composer.** New client half (`client.js`, served
  through `dsh.client`) registers on `conversation.input.activity`, beside the
  model selector: hollow bolt = off, filled black = on, the tooltip carries the
  gear and the reason when it is not clickable. It reads and writes the plugin's
  own `enabled` through `remote.settings.describe()` / `update()`, so the chip,
  the generated Settings page, and `cordis.patch.yml` are three views of one
  field. Clicks are optimistic and then verified by polling `describe()`; a failed
  write reverts the icon and surfaces the error in the tooltip. A registration
  taken by another plugin, an unreadable document, or a read-only layer degrades
  to a disabled chip, never to an error thrown into the composer.
- **A config schema.** `Config` (schemastery) declares only the three fields a
  form should show — `enabled`, `gear`, `parallel`. Undeclared patch-level keys
  (`floor`, `holdTools`, `debug`, …) pass through untouched, so existing
  compositions keep working.
- **One dependency.** `@deepseek-ai/schemastery` (`~3.18.5`), which every shipped
  DSH plugin that exposes a settings page already declares; the profile already
  has it hoisted, so this adds no new runtime.
- **Tests.** 78 (up from 64): the default-off contract, non-boolean configs not
  arming the policy, real schemastery validation of the schema (`gear: warp`
  fails loudly, unknown keys survive), the client-half manifest contract
  (`dsh.client.platform`, `exports["./client"]`, packed `client.js`, bundle id,
  and the slot being the one that never shadows the model selector), and eight
  tests that run the shipped `client.js` verbatim in a `vm` sandbox with a stub
  `__ModuleLoader__` and a fake `settings` remote — proving the bundle parses,
  declares its loader contract, paints hollow when off and filled when on, sends
  exactly one `settings/update` with the revision it read, rolls back and explains
  itself when that write is refused, and never renders a clickable chip over a
  read-only layer or an absent entry.

## 0.4.0

Speed becomes a stance, not a single threshold, and the plugin now installs itself ON.

- **Gears.** `gear: 1..4` (`safe` / `fast` / `turbo` / `max`) selects a coherent
  stance: how early a clean streak earns the second effort notch (`deepAfter`
  6/4/3/2), how many observations count (`window` 8/6/5/4), and how many
  independent calls the model is asked to batch per step (none/4/6/8).
  `fast` is the shipped default; `safe` is byte-for-byte 0.3.0 behaviour.
- **An explicit fan-out directive.** Gears 2–4 register a short system-prompt
  section (`fast-mode:execution-speed`, order 520) that tells the model to batch
  independent calls. The number in the text follows the gear, or `parallel`.
- **A loud cap warning.** If `agentLoop.maxParallelToolCalls` is below the gear's
  target, the plugin logs the exact `cordis.patch.yml` line that raises it, once.
- **Display metadata.** `icon.png` at the package root (PNG, 11,607 bytes) plus
  `locale/zh.json` and `locale/en.json` with `meta.title` / `meta.description`, so
  the Plugin Manager and Settings show a real icon and localized copy.
- **Docs.** Chinese README is now the default, English moved to `README.en.md`,
  and both document the gears, the parallel lever, official-API support, and how
  to compose with context-compression plugins.
- **Tests.** 64 (up from 55), including the manifest checks (icon size and type,
  locale metadata, `files[]` completeness) and the guidance registration path.

## 0.3.0

- Discover the route's real effort ladder through `llm.resolveModelInfo()` instead
  of assuming a vocabulary; never emit a level the route did not declare.
- Explicit `ladder`, documented-alias folding, per-route startup logging, and a
  `route=` field in the debug line.
- `holdTools` keeps full thinking after context-management tools, which look
  "clean" from the outside while being anything but.

## 0.2.0

- Observe `tools/pre-execute` / `tools/post-execute` for struggle signals (error,
  slow call, oversized result, repeated identical call) and lower the effort only
  while the streak stays clean.

## 0.1.0

- First working cut: per-request reasoning-effort adjustment for DSH, zero
  dependencies, no session writes.
