# Changelog

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
