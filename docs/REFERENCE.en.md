# Reference: principles, configuration and limits

The README keeps only the conclusions. This is the detail: how each step is decided, what every field means, who it coexists with, and which numbers still cannot be trusted. Maintained in step with the plugin version.

## Interaction details: the bolt switch and which conversation it applies to

> A short user-facing version lives in the [README](../README.en.md).

Since 0.5.0 this plugin is **opt-in**: once installed it does nothing until you explicitly turn it on. Both entry points write the same configuration, at different granularities: the bolt writes **this conversation's** switch (and updates the shared default to that choice along the way), while the patch writes the shared default.

| Entry point | What you do | Good for |
|---|---|---|
| **The bolt in the composer** (new) | One bolt button to the right of the model selector: hollow = off, solid black = on; clicking it opens the panel, and the switch lives in the panel | Everyday use |
| **The patch** | Set `enabled: true` in `cordis.patch.yml` | Managing the profile as configuration |

Both go through `settings/update` (`applies: live`), so a click takes effect on the **next model call** — no restart. The first install (or the first upgrade to a build that has the client half) needs one page reload / app restart so the client bundle gets loaded.

**The gear lives on the bolt too** (it is not on the settings page): click the bolt to open the panel, and from top to bottom the panel holds the switch, one `仅本会话生效` (this conversation only) line, the five gears and one line of fine print. Both the switch and the gear act on **the conversation that opened the panel**; every gear is labelled with its multipliers, and a choice is written the moment you make it. **There is exactly one entry point, and it is always the one that works**:

| Gear | Name | Estimated speed | Estimated tokens | Parallel target |
|---|---|---|---|---|
| 1 | Eco `safe` | ~1.0× | ~1.0× | 2 |
| 2 | Cruise `fast` (default) | ~1.3× | ~1.2× | 4 |
| 3 | Sport `turbo` | ~1.6× | ~1.5× | 6 |
| 4 | Track `max` | ~2.2× | ~1.9× | 8 |
| 5 | Redline `ludicrous` * | ~3.4× | ~1.3× | 8 |

Gear 5 carries an asterisk: it is the only gear allowed to push the thinking gear down to `off`, so the panel's footnote says exactly that one sentence — `* 关闭思考，质量会下降` (thinking off, quality will drop).

Those two multiplier columns are **predictions from the latency model, not measurements**: `wall clock ≈ 720 ms × steps + 6.63 ms × output tokens` (least squares over 689 steps, R² = 0.93), and the multiplier is what "batch the n independent queries in one step" is worth. It only holds for a task where one step has several independent actions. The real measurements live in [BENCHMARK.md](../BENCHMARK.md): on step-starved public problems all five gears land inside the noise (0.95×–1.09×), while the step-rich repo task gives `turbo` 1.65× wall clock at −40 % tokens (n=4 vs n=12, U test p≈0.004). In that same raw log the median `calls/step` is 1.00 on every gear — a single-file problem gives batching nothing to work with, and that is exactly where prediction and measurement part ways. Gear 5's token multiplier sits below gear 3's because it turns thinking off while gear 3 keeps `low`.

How to read the bolt:

- **Hollow grey** = off (the default; the plugin does not intervene at all);
- **Solid black** = on, with the current gear in the hover tooltip;
- **A click opens the panel, it does not toggle**: the switch lives in the panel, so you cannot misclick a whole turn into fast mode; the five gears and that line of fine print sit in the same panel, so what you picked and what it costs are in one place;
- **A click always does something**: when the configuration cannot be read (read-only layer / this profile does not have the entry / the bridge is not connected yet) the button **does not grey out** — it opens the panel and writes the reason into the status line. The 0.5.1 build made the button `disabled`, and Chrome shows no `title` on a disabled button, so it neither explained nor responded — that hole was plugged in 0.5.2 with three independent defences (unwrap the `{ok, value}` envelope, a timeout on every remote call, never disabled).

These four fields (`enabled` / `gear` / `parallel` / `sessions`) are all declared `.volatile()`: `settings` projects only volatile fields and only accepts edits to volatile ones (otherwise the whole entry vanishes from `describe` and `update` fails with `is not volatile`). The price is that such a field reaches the plugin as a **reference** rather than a value — the Loader lands an edit on a running fiber by replacing the reference in place, so the plugin dereferences once, in `resolveConfig`. `sessions` is maintained automatically by the client half, not a knob for a human (see [a switch per conversation](#a-switch-per-conversation)).

It registers at `conversation.input.activity` (right of the model selector, left of the stop button) and **does not occupy** `conversation.input.model`, so it can never cover the host's own model selector. Every write from the panel is an optimistic update plus a read-back check: a failed write puts the icon back the way it was and states the reason in the tooltip and in the panel's status line.

Once enabled, the default gear is `fast` (gear 2) — all three levers on. To go all the way back to the silent v0.3.0 behaviour (inject no prompt at all, only downgrade after a clean streak), use `gear: safe`.

## How it works

### 1. Deciding whether this step needs deep thinking

`tools/pre-execute` / `tools/post-execute` are pure observers (they always forward the decision they were handed and can never change a tool result). On that basis the plugin decides whether "this step is going smoothly":

| Signal | Meaning |
|---|---|
| `isError` | something failed → thinking is needed |
| `slowMs` (default 5000) | stuck on I/O → the problem is not thinking; holding thinking does not help, but cutting further would be wrong too |
| `bigChars` (default 20000) | the result is large → it needs digesting |
| the same call with the same arguments ≥ 2 times | going in circles |
| a `holdTools` hit | compression / takeover tools; the step after them must not be cut |

The rules are short:

- planning steps (`step < 2`) are left alone;
- ≥ `deepAfter` consecutive clean calls → down one notch; another clean streak → the second notch is allowed;
- any struggling signal → **straight back** to the resolved original gear (down only, never up; the original gear is the ceiling);
- the gears the current route declares are unknown → do nothing.

### 2. Emit only effort ids the route actually declared

This is what "first-class support for the official API" rests on, and the fundamental difference from scripts that hard-code `reasoning_effort: "low"`: DSH validates the effort id **before** sending the request, so guessing an id that does not exist fails the whole model call instead of being ignored. So the plugin asks first, and only then acts.

The official route (`@deepseek-ai/dsh-llm-deepseek`, read out of the code rather than guessed):

| Item | Value |
|---|---|
| provider id | `deepseek-official` (provided by `@deepseek-ai/dsh-llm-deepseek-api-key`) |
| base URL | `https://api.deepseek.com/anthropic` (Anthropic Messages wire protocol) |
| declared efforts | `off` / `low` / `high` / `max`, default `high` |
| wire fields | `thinking: { type: "disabled" \| "enabled" }` + `output_config.effort` |
| the cut the plugin can make | `high → low` (16384 → 2048 thinking tokens); `off` sits below the floor and is never chosen |
| to make it fully silent | `floor: high` (the plugin becomes a pure observer) |

Self-hosted / gateway routes work the same way, only the ladder differs (for example the local `company` gateway declares `off/minimal/low/medium/high`, all of which are really in effect, and one notch down there is `high → medium`). The plugin assumes no vocabulary: it moves within whatever the route declared, and when the declaration is empty (`route=provider-none`) or cannot be had (`route=unknown`) it does not move at all.

### 3. Trade tokens for time: three levers

One sentence: **This plugin does not save tokens; it spends tokens to buy time.** It spends them in three places, and the third is new in 0.8.0 — and the one that paid off most in measurement.

| Lever | How | Why it is faster | Who pays |
|---|---|---|---|
| **1. Wider steps** | The gear states a per-step parallel target (4/6/8/8) and tells the model to put independent calls into one assistant message | Calls in one message are scheduled **concurrently** by the harness (bounded by `agentLoop.maxParallelToolCalls`, default 10, and only calls declared safe are run concurrently), so N reads collapse from N round trips into one | Input tokens: a step carries more tool results |
| **2. Speculative prefetch** | At gear ≥ `turbo` one extra line: when the evidence already implies which file the next step will read, **read it in the same batch** | Reading one file you did not need costs a few hundred input tokens; an extra round trip costs a whole step (≈ 0.7 s of fixed overhead plus prefill) | Input tokens: the occasional wasted read |
| **3. Less narration** | Tells the model not to narrate around tool calls, not to restate file contents, and not to close a step with a "done" progress report | On this route a step costs ≈ `720 ms + 6.6 ms × output tokens` (R²=0.93), so **visible text is the single largest cost** | Output tokens: the answer states only conclusions |

All three touch exactly one thing: **spending more tokens on the request to the same route.** None of them works by "making the model dumber", and none of them lowers effort — on this self-hosted route reasoning tokens are 0, so lowering effort saves nothing at all (measured; see [BENCHMARK.md](../BENCHMARK.md)).

The third is on by default and can be turned off with `outputDiscipline: false` (the parallel and prefetch prompts stay; the writing style is left alone). `fast` gets the light version (three prohibitions); `turbo` and above get the full version (plus "if this step needs no prose, write none"). `safe` injects nothing.

The parallel prompt also holds four rules that must not be broken: only **mutually independent** calls are parallelized, reads and writes never go into the same batch, a failure in a batch shrinks back to small steps, and a step is **never** split narrow again just to save tokens. The parallelism target is only a target: if the profile pushes the scheduling cap below the gear's target, the plugin logs a warn telling you which line to change in `cordis.patch.yml`.

### 4. State follows the conversation

The `settings` service has a single scope (the whole profile), so it cannot express "this conversation is on", which is why the entries live in the plugin's own `sessions` field and the host resolves them per request by session id (experiment assignment > session entry > shared default; see [a switch per conversation](#a-switch-per-conversation)). How the client half knows which conversation it is painting: `conversation.input.activity` is a session-scoped slot, so the slot kit passes the binding key (the session id) as the first argument to `inject`, and the client half surfaces it as the `chatId` prop; it also accepts the standard `sessionId` prop, because a release that stops injecting one of the two should not silently fall back to global behaviour. The host copy of the column format is `src/state.js` and the browser copy is a second implementation inside `client.js` (the bundle cannot import host ESM); one set of fixtures pins both.

### 5. The stall guard: tool wait has a ceiling too

A step's wall clock is not only round trips and visible output; it also contains **tool wait**. One unbounded foreground call can swallow minutes (a server, a `tail`, a prompt that never arrives, a heredoc that dies as a malformed response), and the model usually re-issues it unchanged — time that hides in the residual of `720 ms + 6.6 ms × output tokens` and is pure loss. So 0.8.1 adds a lever that spends no tokens: a ceiling on a single tool call.

**Mechanism.** The plugin registers the harness's `tools/execute` hook and races each guarded call against a per-gear ceiling. On expiry it aborts that call's own signal, waits a short grace period for the body to settle, restores the caller's original signal, and returns a `ToolExecutionFailure` whose text tells the model to **retry differently** (narrow the command, write it to a file and pass `script_path`, make it a background job) instead of re-sending the same command.

**What is guarded:** shell / script / monitor tools, by name. **Exempt:** calls that legitimately wait — `ask_user_question`, `wait_agent`, `job_output`, `task_board_run`, `workflow`, `subagent*`, `run_code` — and fast tools such as `read` / `write` / `edit`. `safe` sets no ceiling at all: its promise is to change nothing.

| Gear | Ceiling on one tool call |
|---|---|
| Eco `safe` | off |
| Cruise `fast` | 300 s |
| Sport `turbo` | 180 s |
| Track `max` | 120 s |
| Redline `ludicrous` | 90 s |

These are **policy budgets, not measurements**: the higher the gear, the less time one call is allowed to take.

Configuration (composition level, not on the settings page): `stallGuard: false` turns the whole guard off; `toolTimeoutMs` overrides the table (a positive value is used for every gear, a negative value disables the guard, `0` follows the gear).

The prompt half moved too: the guidance section now tells the model to bound shell calls, to run servers and watchers in the background, and to write a long or quoted/multi-line command to a file and pass `script_path` instead of a heredoc.

## Configuration

```yaml
- id: fast-mode
  name: dsh-fast-mode
  config:
    enabled: true              # shared default switch, default false; conversations without their own entry inherit it
    gear: fast                 # safe / fast / turbo / max / ludicrous (default fast)
    parallel: 4                # optional: overrides the gear's parallel target (only the number in the prompt and the warning are affected)
    outputDiscipline: true     # less narration, conclusions only; false = keep the parallel/prefetch prompts and leave the style alone
    stallGuard: true           # stall guard: per-gear ceiling on shell-style tool calls; false = off
    toolTimeoutMs: 0           # override the per-gear ceiling: positive = this many ms on every gear, negative = off, 0 = follow the gear
    floor: low                 # never choose a cheaper gear than this
    deepAfter: 4               # clean calls before the second notch is allowed (default follows the gear)
    slowMs: 5000               # at or above this duration, hold thinking
    bigChars: 20000            # at or above this result size, hold thinking
    window: 6                  # how many recent calls are considered (default follows the gear)
    escalateAfterStep: 0       # restore full thinking past N steps in a turn; 0 disables
    holdTools: [compress, "acp_*"]   # the step after these tools keeps full thinking
    ladder: [off, low, high, max]    # optional: pin the ladder, skipping discovery
    aliases: auto              # auto | false | { "<declared id>": "<effective id>" }
    discoverTimeoutMs: 250     # how long to wait for the route's declaration; if it does not arrive, decide without it
    baselineFromDefault: true  # with no resolved gear, notch below the route's default gear
    metrics: true              # one row per step, on by default
    metricsFile: ~/.dsh/fast-mode-metrics.jsonl
    benchmarkFile: ~/.dsh/fast-mode-bench.json
    reassertAfterCompaction: true   # after a compaction, one very short reminder restating the two calling rules
    debug: false
    debugFile: ""
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | the shared default switch, the value a conversation without an entry of its own inherits; the bolt writes this conversation's entry and updates this field to the last choice. Only `true` makes the plugin intervene |
| `gear` | `fast` | Gear, one of `safe`/`fast`/`turbo`/`max`/`ludicrous`; a number or a typo is a load-time error. Conversations without an entry of their own inherit it |
| `parallel` | follows the gear (4/6/8) | Parallel target in the injected prompt; `1` means no injection. **Left blank** in the settings page means "follow the gear" — it deliberately has no schema default, because a default would pin the field and the gear could never raise it again |
| `sessions` | `""` | per-conversation overrides, maintained by the plugin (**do not edit by hand**): `{"<sessionId>":{"enabled":true,"gear":"turbo","ts":…}}`; past 200 entries the oldest `ts` are dropped and those conversations fall back to the shared default. Volatile; a text input in the settings page |
| `outputDiscipline` | `true` | keeps the model from narrating its work (no commentary around tool calls, no restating file contents, no progress reports), conclusions only. This is the strongest lever in "trade tokens for time": measured, per-step output drops from 640 to 190 tokens and wall clock falls by about a third. `false` keeps the parallel and prefetch prompts and drops only the style constraint. **Not volatile** — changing it needs a reload |
| `stallGuard` | `true` | the stall guard: gives shell / script tools a per-gear ceiling on one call, cancels a call that overruns and writes "retry differently" back to the model (see [the stall guard](#5-the-stall-guard-tool-wait-has-a-ceiling-too)). `safe` sets no ceiling. **Not volatile** — changing it needs a reload |
| `toolTimeoutMs` | `0` | overrides the per-gear ceiling above: positive = that many ms on every gear, negative = guard off, `0` = follow the gear. Likewise **not volatile** |
| `floor` | `low` | never choose a cheaper gear; on the official route `floor: high` means no downgrade at all |
| `deepAfter` | follows the gear (6/4/3/2/1) | how many consecutive clean calls allow the second notch |
| `slowMs` | `5000` | at or above this duration, hold thinking |
| `bigChars` | `20000` | at or above this result size, hold thinking |
| `window` | follows the gear (8/6/5/4/4) | how many recent calls are considered |
| `escalateAfterStep` | `0` | restore full thinking on very long turns; `0` disables |
| `holdTools` | `[]` | tool names or prefixes (`acp_*`); a hit means "unusual work", so the next step keeps its gear |
| `ladder` | — | pin the effort ladder explicitly (≥ 2 ids) |
| `aliases` | `auto` | fold documented compatibility aliases onto effective gears; `false` turns it off, a map overrides it |
| `discoverTimeoutMs` | `250` | how long to wait for the route's declaration; if it does not arrive, decide without it |
| `baselineFromDefault` | `true` | with no resolved gear, take the route's `defaultEffort` as the baseline and notch down from there |
| `metrics` | `true` | write one JSONL row per completed step; `false` writes no file at all |
| `metricsFile` | `~/.dsh/fast-mode-metrics.jsonl` | the measurement file. A **composition knob**: it does not appear on the settings page, and changing it means editing `cordis.patch.yml` |
| `benchmarkFile` | `~/.dsh/fast-mode-bench.json` | the per-session gear-assignment file of the experiment, likewise only read at load time and re-read once a second |
| `reassertAfterCompaction` | `true` | after the context is compacted, one very short notice is added to the next request (`notice` form, `source: plugin`, so the UI folds it) restating the batch and the bounded-call rules — compaction squeezes that section out of the system prompt, and right after it the model is most likely to slip back to one call at a time. `false` only drops the reminder; the prompt section is still injected. **Not volatile** — changing it needs a reload |
| `debug` / `debugFile` | off / `""` | one log line per request, carrying the decision basis |

### `route=` in the log

`route=` says where the effort ladder came from: `provider` (discovered at runtime), `provider+aliases` (the discovered ladder, widened by documented aliases), `provider-none` (that route declares nothing), `configured` (pinned by `ladder`), `builtin` (the built-in default ladder), `unknown` (the route could not be asked). At startup the logger also prints the resolved ladder and gear settings once per route.

If every line reads `high=>high`, check in this order: has the step number reached 2 (planning steps are exempt by design); is it `route=provider-none` or `unknown` (a route with no `reasoningEfforts` has nothing to downgrade); is the current gear already at your `floor`.

## Coexistence and conflicts

A gear manages the **output / thinking** budget; compression plugins manage the **input / history** budget. The two levers are orthogonal, and stacked they multiply:

| Layer | Examples | What it cuts | Where it acts |
|---|---|---|---|
| Output / thinking | **this plugin** | per-step thinking tokens and wall clock | `agent/request` → `reasoningEffort` |
| Input / history | billion-context (ACP proxy), built-in compaction, historical image offloading | prompt tokens, context pressure | the message list or the provider's `baseURL`, before the request leaves |

Three rules that make them actually work together:

1. **A gear is a field, not a sentence.** A proxy that re-serialises the request body keeps `thinking` / `output_config`; this plugin writes the field **before** serialisation, so all the proxy sees is an ordinary request.
2. **Compression steps can be held.** Context-management calls often look very "clean" from the outside (fast, small result, no error) — exactly the moment the clean-streak rule wants to downgrade. Name those tools in `holdTools` so the step after them keeps full thinking.
3. **A knob has one owner.** Do not let two components clamp `reasoningEffort` / `output_config.effort` at the same time: the second clamp cannot know why the first one raised it.

### billion-context

**Compatible and complementary.** billion-context installs as a DSH bundle (`bili-native`), turns off the host-plane `compaction-basic` auto, and intercepts model traffic by patching the HTTP layer (`globalThis.fetch`); it does not go through `agent/request` and does not read or write `reasoningEffort`, so it cannot quietly override this plugin's decision.

Two notes, both **optional**:

1. `compress.outputSteering` is off by default; once it is on, the `effortRouting` inside it pushes effort down to the lowest on "mechanical continuation" turns (on Anthropic it also rewrites `output_config.effort` and `thinking.budget_tokens`). That is exactly the knob this plugin owns, and it cannot see errors, slow calls or explicit holds. Pick one owner:

   ```yaml
   - id: bili-native
     config:
       compress:
         outputSteering:
           enabled: true
           effortRouting: false    # let fast-mode own effort
   ```

2. Put its tools into `holdTools`, so the "fold history" step itself is not downgraded:

   ```yaml
   - id: fast-mode
     config:
       gear: fast
       holdTools: [compress, decompress, search_context, acp_status, acp_retrieve, "acp_delegate*"]
   ```

Two more points are facts, not recommendations: billion-context's own summarisation calls run inside its proxy process and never pass through the harness, so this plugin cannot reach them; and it turns off `compaction-basic`'s automatic compaction, so **do not stack a second compressor**.

### Automatic historical-image compression / gateway adapters

Plugins like `image-guard` and `intellif-litellm-adapter` fix a different failure: they rewrite the message list before the request goes out (move old images away, force another compression round, retry a `too_many_images` 400) so the request gets under the gateway's image count / pixel / context caps. They share no fields with this plugin and need no configuration change; if you want their retry steps to keep thinking, you can also put the matching offload / compaction tool names into `holdTools`.

Keep **only one image reductor** in a profile (billion-context also folds media server-side), or the two compressions step on each other.

### `dsh-batch-tool-calls` and `dsh-ops`: do not enable them with fast mode

These two are not neighbours you can configure into agreement; they **overlap** with what fast mode already does, so running both means paying twice for the same text and sometimes fighting over the same call.

- **`dsh-batch-tool-calls`** registers a batching policy section of its own. This plugin registers a superset: a gear-aware parallel target, per conversation, plus a post-compaction reminder and, since 0.8.1, a per-gear ceiling on a single tool call. With both enabled the prompt is paid for twice, and the two texts can disagree about the fan-out target.
- **`dsh-ops`** replaces the shell and file tools with its own (`ops_bash`, `ops_grep`, `ops_glob`, `ops_inspect_local_file`, `ops_replace`, …) and only ships Windows binaries. This plugin's guidance describes what to do with *its* shell — bound the call, background a server, skip the heredoc — so with `dsh-ops` installed there are two shells and two sets of rules to satisfy: the rule is either duplicated or contradictory.

Fast mode detects both at load time (the package name in the profile's `package.json` / `cordis.patch.yml`, plus a live `ops_bash` tool probe) and announces the conflict **once** in the conversation without blocking the load. The fix is only ever one thing: **remove one of them**.

## Official API support

| Case | Supported | Basis |
|---|---|---|
| Official DeepSeek API (`deepseek-official`) | ✅ | reads the official adapter's declaration (`off/low/high/max`, default `high`); the default gear only moves between `high → low`, and `ludicrous` does use `off` |
| The official API behind a proxy / relay | ✅ | the ladder comes from the provider **connection config** (`resolveModelInfo`), not from what sits at the other end of the network |
| Self-hosted / company gateway (e.g. `litellm` + Anthropic Messages) | ✅ | as many notches as it declares; on `off/minimal/low/medium/high` one notch down is `high → medium` |
| OpenAI-compatible / other providers | ✅ | same thing; the route only has to declare `reasoningEfforts`, and an empty declaration means the plugin does not intervene at all |
| A model with only a `max` notch, or no gears at all | ✅ (quietly) | with one notch there is no room to downgrade; an empty declaration (`provider-none`) or an unanswerable route (`unknown`) likewise does nothing |

On the official API the **finest downgrade step** is `high → low` (there is nothing in between), so the promise here is always "this request is cheaper", never "this request is cheap". To make the official route completely untouched, set `floor: high`. `ludicrous` is the only exception: its own `floor` is `off`, which is also why it carries an asterisk.

## Measurement, experiments and reporting

0.6.0 built measurement into the plugin and added a comparison path that does not rely on eyeballing.

### One row per completed step

Measurement is on by default and **independent of the switch**: sessions with fast mode off are recorded too — otherwise there is no control group. Every completed model step appends one JSON line to `~/.dsh/fast-mode-metrics.jsonl`; the file is created on demand, a failed write is silent and never affects a request.

| Field | Meaning |
|---|---|
| `v` / `ts` / `sid` / `turn` / `step` | format version, time, session id, turn number, step number |
| `mode` | `on` / `off` / `unknown`: the state of the switch for this turn |
| `gear` / `effort` / `route` | the actual gear (`off` when switched off), the effort id actually sent, the `provider/model` this request went to (the `route=` in a debug line is the ladder source, see below) |
| `ttftMs` | step start → first assistant message, i.e. time to first token |
| `llmMs` | step start → last assistant message, i.e. model time |
| `stepMs` | wall clock of the whole step, **including** tool execution |
| `calls` / `errors` | tool calls in this step / how many of them errored |
| `input` / `output` / `reasoning` / `cacheRead` / `cacheWrite` | the measured tokens from upstream `usage` |
| `assistantMessages` | how many assistant messages this step produced |

- `metrics: false` turns measurement off; `metricsFile` changes the path. The latter, like `benchmarkFile`, is a **composition knob** (deliberately not volatile): it is read only at load time, so changing it means editing `cordis.patch.yml`.
- "Model time" in the report is `llmMs`, "first token" is `ttftMs`. Do not read `stepMs` as model speed: it includes the time your own machine spent running tools.

### A switch per conversation

Before 0.6.2 the switch and the gear were profile-level: clicking the bolt in one conversation changed **every** running conversation. 0.7.0 split the state into two layers.

- Each conversation keeps its own `{enabled, gear}`. The switch and the gear in the bolt panel act only on **the conversation that opened the panel**, and the panel says so plainly in the line under the switch: `仅本会话生效`.
- A conversation without an entry of its own inherits the shared `enabled` / `gear`. Those two fields are also the record of **the last choice made anywhere**, so a new conversation starts from that last choice rather than from the schema default.
- Precedence: the experiment file (`fast-mode-bench.json`) > this conversation's entry > the shared default. The experiment arm is unchanged: it still **deliberately** overrides the UI.
- Storage is one volatile field in the settings, `sessions`, whose content is a JSON blob: `{"<sessionId>":{"enabled":true,"gear":"turbo","ts":1792826203058}}`. `ts` is what pruning uses: past 200 entries the oldest are dropped, and dropped conversations fall back to the shared default. The settings page renders it as a text input (this build of schemastery has no `.hidden()`); it is maintained automatically by the client half, so do not edit it by hand.
- A click is **one** `settings/update` that writes the shared `enabled`/`gear` and this conversation's entry together, carrying the revision it read: the panel cannot show one gear while the request runs another, and there is no revision race between two writes. When the write is rejected, all three fields roll back together and the reason is written into the panel's status line.

### Assigning gears per session

When `~/.dsh/fast-mode-bench.json` (or `benchmarkFile`) exists and has `enabled: true`, the plugin assigns gears per session:

```json
{
  "enabled": true,
  "gears": ["off", "safe", "fast", "turbo", "max"],
  "sessions": { "<session id>": "turbo" }
}
```

- `gears` may contain `"off"`: that is the **control group**, and the sessions assigned to it run switched off. Without it an experiment can only answer "which gear is faster", not "how much faster than off" — and the latter is the thing to prove.
- An explicit `sessions` entry wins; otherwise assignment is `FNV-1a(session id) mod gears`, so the same conversation lands on the same gear every time.
- The file takes effect within a second, no restart needed; delete it and the next request goes back to the configured switch and gear.
- An assigned session **runs on its assignment regardless of the current switch**: the arm is decided by the file and the hash, otherwise a session where you forgot to click the switch would quietly land in the control group while you believe you are measuring `turbo`.
- Names not in `gears` are dropped with one warning; if the file is not JSON, or has no known gear at all, the experiment stays inert and complains once.

### The report: `dsh-fast-mode-report`

```bash
node bin/report.mjs --since 2d     # run it straight from the checkout; always works
dsh-fast-mode-report --json        # the packaged bin name; pnpm links it once installed into a profile
```

The npm package of the same name has not been published yet, so `npx dsh-fast-mode-report` cannot fetch anything today (equivalent once it is published).

| Option | Effect |
|---|---|
| `--file <path>` | the measurement file, default `~/.dsh/fast-mode-metrics.jsonl` |
| `--since <when>` | only the recent stretch: `2d` / `12h` / `90m`, or anything `Date.parse` accepts; with `--lan` the panel's query window widens to match |
| `--json` | machine-readable JSON output (`{file,total,used,since,buckets,lan}`) |
| `--lan` | also reconcile against the LAN usage panel (see below) |
| `-h` / `--help` | usage |

The default output has three blocks:

1. one line per `mode|gear`: sessions, steps, steps/turn, step time p50/p90, model time p50, first token p50, output tok/step, output tok/session, tools/step, multi-call steps (steps that issued more than one tool call);
2. a multiplier table relative to the switched-off state: model time, step time, output tok/step, output tok/session, tools/step (>1× means that gear is faster / more expensive);
3. one line of methodology: the unit of comparison is the **step**, not session wall clock — most of wall clock is you reading and typing.

When there are no switched-off samples, the report does not force a multiplier; it tells you to run both sides: first switch the bolt off and run the same task, then switch it on and run it again.

`--lan` matches local rows to the LAN usage panel by session UUID (`/api/v1/sessions/recent`), adding the upstream model name, total/input/output tokens and the full session duration:

- read-only, it sends no write requests;
- the token comes from the `USAGE_TOKEN` environment variable and is never printed; the panel address defaults to the one baked into the build and can be overridden with `USAGE_BASE`;
- with no token it prints one line of explanation and skips `--lan`, while the rest of the report still prints;
- nothing leaves the LAN; the panel's query window follows `--since` (the panel only offers `1d`/`7d`/`30d`, defaulting to `7d` when no `--since` is given), and when the two cannot be matched it says so instead of guessing.

### The experiment: `dsh-fast-mode-experiment`

A report only counts when both sides did comparable work and the gear was not your pick. This command owns that file so nobody has to hand-write JSON:

```bash
node bin/experiment.mjs start                 # four gears, assigned by session-id hash
node bin/experiment.mjs status                # sessions/steps per gear so far, and what is missing
node bin/experiment.mjs stop                  # end it, back to the configured switch and gear
node bin/report.mjs --since 7d                # the comparison
```

| Option | Effect |
|---|---|
| `--bench <path>` | the experiment file, default `~/.dsh/fast-mode-bench.json` |
| `--metrics <path>` | the measurement file, default `~/.dsh/fast-mode-metrics.jsonl` |
| `--gears a,b,c` | gears taking part (default `off,safe,fast,turbo,max`, where `off` is the control group; fewer than two is refused outright) |
| `--sessions n` | the "at least n sessions per gear" threshold in `status`, default 3, affects hints only |
| `--force` | overwrite an experiment file that is already running |

During an experiment, newly opened sessions **run on their assignment automatically** (everything except `off` is switched on), with no bolt click needed — otherwise a session you forgot to click would quietly fall into the control group. `status` says plainly what is still missing: no switched-off samples, a gear with no sessions at all, whether each gear has enough `n` sessions. Remember to `stop` the experiment, or later sessions keep being assigned.

## Safety boundaries

- **Observes only, never changes results.** The two tool hooks always forward the original decision; when the decision logic throws, it falls back to the gear the harness would have chosen anyway.
- **Emits only ids the route declared.** A property test guarantees no input can produce an effort id the route did not declare; the worst case is "did nothing", not "broke the turn".
- **Writes no conversation.** Observation data lives in memory only, isolated per agent and reset per turn; it does not occupy a single token of context.
- **Failure is silence.** An unreachable provider, a timeout, an unwritable log file — all degrade silently.
- **Measurement that cannot be written still does not affect the request.** The JSONL is append-only, the directory is created lazily, exceptions are swallowed; the report side only reads the measurement file, `--lan` only sends GETs, the token is used in memory only, never printed, never leaves the LAN.
- **The client half cannot drag the composer down.** Every remote call of the bolt button is inside try/catch; when the configuration cannot be read the button is still clickable and the reason is written into the panel's status line; if the slot registration is taken by another plugin it logs one warning and does not throw at the host.

## Honest limitations

- Output tokens are serial: within one generation, less thinking only makes this step shorter; it does not overlap this step with the next. Upstream `usage.outputTokens` TPS is unchanged — what moves is model time and step count, not the speed at which one model generates.
- A host plugin cannot "issue parallel calls on the model's behalf"; it can only raise the scheduling cap, or get the model to put independent calls in the same step itself. This plugin does the latter (plus a warning when the cap is too low).
- It can only cap a call stuck on a slow command (cancel it on expiry and let the model retry differently); it cannot make that command faster, and it is not a substitute for batching independent calls.
- It integrates no external "decision model" endpoint (Jev, for example): that would introduce a network round trip, the opposite of this plugin's purpose.
- How much wall clock it saves depends on how big a share thinking has in your turn. In the session above, generation absolutely dominates (about 44 s per turn), which is exactly the case it targets.
- The guidance section is injected only when the gear actually asks for a directive: `safe` and the switched-off state cost nothing, every other gear costs about 1 KB of text per request (≈ 300 input tokens).
- On the official API the only legal cut that keeps thinking on is `high → low` (16384 → 2048 thinking budget); `ludicrous` turns thinking off, and that quality cost is stated, not hidden.
- For numbers, use the measurement and report path above, and make sure both sides do comparable work.

## Development and tests

```bash
npm test        # 175 tests, no network, no harness required
```

The policy tests cover planning-step exemption, single and double notch downgrades, `floor`, the no-upgrade rule, each struggling signal taking effect on its own, `holdTools` hits, per-turn resets, per-agent isolation, bounded observation memory, malformed-argument handling, config normalisation (a typo in `floor` falls back to the default instead of cancelling the floor), and gear normalisation (a bad value never becomes "unlimited"). The provider set runs the policy against the official adapter's real declaration (`off/low/high/max`), a wider alias list, a five-gear self-hosted gateway, and a route that declares no efforts at all — including a property test: no input can possibly produce an id that route did not declare. The integration tests drive the registered handlers through the harness sequence with a fake context, and verify that the system prompt is registered at gear ≥ 2 and does not exist at all at gear 1; the measurement set proves that **switched-off sessions are recorded too** (one row per step, first token taken from the first of several messages), and covers token/error summing, per-session isolation, lazy directory creation and an empty path turning the sink off. The session-state set targets the 0.7.0 per-conversation overrides: it puts the browser implementation inside `client.js` into a `vm`, feeds it the same fixtures, and proves it reads and writes the same column format as the host's `src/state.js` — if the two implementations ever drift, the switch shows "on" while nothing happens; it also covers dropping the oldest rows by `ts` past 200 entries, a corrupt column degrading to "no override", and the host taking each conversation's own entry while conversations without one inherit the shared pair. The experiment-assignment set proves the hash is stable and reaches every gear, an explicit pin wins, a single-session pin, the file taking effect within a second, full inertia with no file or `enabled:false`, and a bad file complaining only once. The reporting set runs the real `bin/report.mjs`: two tables, a text refusal when only one side has samples, `--since` widening the panel's query window too, `--json`, `--help` not reading the file, skipping `--lan` with no token, matching by session id when there is a token and **never printing the token**, and degrading to one line of explanation when the panel is unreachable. The last test inspects the plugin manifest itself — the `icon.png` in the package really is a PNG of at most 256 KiB, bilingual `meta.title`/`meta.description` are complete, and `files[]` covers every file the runtime needs; the same set also checks the client half's manifest conventions (`dsh.client.platform === "web"`, `exports["./client"]`, `client.js` being packaged, the bundle id equal to the package name, the registered slot being `conversation.input.activity` rather than the one that would cover the model selector), and runs the shipped `client.js` verbatim inside a `vm` sandbox (a stub `__ModuleLoader__` plus a fake `settings` remote, and that remote replies with the real protocol's `{ok, value}` envelope — an unwrapped envelope was the root cause of the 0.5.1 "unclickable bolt", so it is part of the fixtures now): it proves the bundle parses, requires only `react`, draws the hollow icon, a click only opens the panel and writes nothing, the switch in the panel sends exactly one `settings/update` with a revision, a second click turns it back off, and a rejection rolls back and states the reason in the tooltip and the status line; it also pins the new interaction contract — the frame is a **single icon** (no caret, no inline dropdown), the button is **never disabled**, read-only / missing entry / `ok:false` all render as "clickable + one reason", the five gear rows each carry speed and token multipliers, `ludicrous` carries an asterisk, picking a gear while switched off writes `enabled` along with it, picking a gear while already on does not touch the switch, the gear ids the client hands over match the host's `GEARS` exactly, and the panel's scope line is non-empty in both the Chinese and English dictionaries (the Chinese sentence is fixed as `仅本会话生效`). Finally it validates the schema with real schemastery: default `enabled: false`, all five gear names pass, `gear: warp` fails on the spot, measurement is on by default, the four volatile fields are exactly `enabled`/`gear`/`parallel`/`sessions` (the last written by the client half, not meant for humans), and patch fields that are not in the schema (`floor`, `holdTools`) survive untouched.
