<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/regrevia/dsh-fast-mode/main/assets/logo.png" width="120" alt="dsh-fast-mode">
  </picture>
</p>

<h1 align="center">dsh-fast-mode</h1>

<p align="center">
  <b>DeepSeek Harness's own fast mode.</b><br>
  Think less where less thinking is due, and send independent calls as one parallel batch — no model change, no provider change.
</p>

<p align="center">
  <a href="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/regrevia/dsh-fast-mode/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/regrevia/dsh-fast-mode/releases"><img alt="release" src="https://img.shields.io/github/v/release/regrevia/dsh-fast-mode"></a>
  <img alt="deps" src="https://img.shields.io/badge/dependencies-1%20(schemastery)-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
</p>

[中文](README.md)

---

A plugin that removes the "dead waiting time in multi-step tasks" from models that are **not slow to begin with**, like `deepseek-v4.1-flash`: one host plugin plus one small client widget, no session changes, no context writes. Its only dependency is `@deepseek-ai/schemastery`, which the profile already contains — it declares the settings-page schema and carries no runtime logic.

It does three things, all of them acting on the same request's **thinking gear** and **how many calls each step issues**:

| # | What it does | Where it acts |
|---|---|---|
| 1 | Decide whether "this step actually needs deep thinking": downgrade only after a clean streak; on an error, a slow call, a big result, a repeat call, or a `holdTools` hit, snap straight back to the original gear | `tools/post-execute` observes → `agent/request` decides |
| 2 | Emit only effort ids **the current route actually declares**, never a guess | `llm.resolveModelInfo()` discovers → notch only along that route's ladder |
| 3 | At gear ≥ 2, inject a short "batch independent calls in parallel" instruction into the model, so one step performs reads that would have taken three | `systemPrompt.section` (order 520) |

Since 0.6.0 it also **measures itself**: every completed step appends one JSONL row (sessions with fast mode off are recorded too), and a terminal report command turns "how much faster" from a feeling into numbers you can compare.

## The lightning switch: off by default, armed from its panel

Since 0.5.0 this plugin is **opt-in**: once installed it does nothing until you explicitly turn it on. Both entry points write the same `enabled` field:

| Entry point | Action | Good for |
|---|---|---|
| **The lightning in the composer** (new) | A bolt button right of the model selector: hollow = off, filled black = on; clicking it opens the panel that holds the switch | Everyday use |
| **The patch** | Write `enabled: true` in `cordis.patch.yml` | Profiles managed by configuration |

Both write the same user-layer configuration (`settings/update` → `applies: live`), so a click takes effect on the **next model call** with no restart. The first install (or a fresh upgrade to a build with a client half) needs one page reload / app restart so the client bundle is loaded.

**The gear lives on the bolt too** — there is no settings-page form. Click the bolt and a panel opens holding, top to bottom, the switch, five gear rows and a line of fine print. Each row is labelled with its estimated multipliers, and picking one writes it immediately. One entry point, and it is the one that works:

| Gear | Name | Est. speed | Est. tokens | Parallel target |
|---|---|---|---|---|
| 1 | Safe `safe` | ~1.0× | ~1.0× | 2 |
| 2 | Fast `fast` (default) | ~1.3× | ~1.2× | 4 |
| 3 | Turbo `turbo` | ~1.6× | ~1.5× | 6 |
| 4 | Max `max` | ~2.2× | ~1.9× | 8 |
| 5 | Ludicrous `ludicrous` * | ~3.4× | ~1.3× | 8 |

The fifth row carries an asterisk: `ludicrous` is the only gear allowed to push the thinking level to `off`, so the panel footer says exactly one thing — `* deliberation off, quality drops`.

The multipliers are **estimates**, not measurements: a gear changes how early a downgrade is allowed and how many calls the model is asked to batch into one step. On the official API the biggest legal cut *without* turning thinking off is only `high → low` (16384 → 2048 thinking budget) — roughly 2× is the ceiling; the 3.4× row is bought by turning thinking off, not for free.

How to read the bolt:

- **Hollow grey** = off (the default; the plugin does not intervene at all);
- **Filled black** = on, and the hover tooltip carries the current gear;
- **Clicking opens the panel; it does not toggle.** The switch lives inside, so a mis-click cannot silently make a whole session faster; the five rows and the fine print sit in the same panel, which keeps "what was chosen" and "what it costs" in one place;
- **A click always does something.** When the configuration cannot be read (read-only layer, no entry in this profile, bridge not connected yet) the button is **never disabled**; it opens the panel with the reason spelled out in the status line. 0.5.1 set `disabled`, and Chrome suppresses `title` on a disabled button, so it neither explained nor switched — 0.5.2 closes that hole with three independent defences: unwrapping the `{ok, value}` envelope, a deadline on every remote call, and never disabling the button.

Those three fields are declared `.volatile()`: `settings` projects only volatile fields and only accepts edits to volatile ones — a non-volatile field makes the entry vanish from `describe` and the write fail with `is not volatile`. The price is that such a field reaches the plugin as a **reference** rather than a value (that is how the Loader lands an edit on a running fiber), so the plugin dereferences once, in `resolveConfig`.

It registers on `conversation.input.activity` (right of the model selector, left of the stop button) and **never** occupies `conversation.input.model`, so it cannot shadow the harness's own model selector. Every write inside the panel is an optimistic update plus a read-back check: if the write fails the icon reverts and both the tooltip and the panel's status line explain why.

Once armed, the default gear is `fast` (gear 2), which is all three mechanisms above turned on; to go fully back to the silent v0.3.0 behavior — no prompt injected, downgrades only after a clean streak — use `gear: safe`.

## Measured: where the time goes

Sampled on one real machine over 10 turns and 617 tool calls (`deepseek-v4.1-flash`, a company self-hosted gateway, five levels `off/minimal/low/medium/high`):

| Metric | Value | Notes |
|---|---|---|
| Steps that issued only 1 tool call | **91%** | Most steps are "read one thing → one model round trip → read the next"; every round trip is serialized |
| Tool duration median / p90 / worst | 67 ms / 5553 ms / 818.7 s | Fast calls take milliseconds; a few slow ones eat most of the wall clock |
| Idle gaps > 30 s (10 turns combined) | 14 gaps, 2259 s | The visible cost of waiting and round trips |
| Generation time per turn | ≈ 44 s | Generation absolutely dominates; the tool median is 67 ms |

Conclusion: what can be compressed is not the tools themselves, but **each step's thinking budget** and **each step's number of round trips**. This plugin compresses only those two. These numbers come from one sampling run, not a promise; since 0.6.0 you can rerun the same measurement on your own machine (see [Measurement, experiments and reporting](#measurement-experiments-and-reporting)).

## How it works

### 1. Decide whether this step needs deep thinking

`tools/pre-execute` / `tools/post-execute` are pure observers (they always forward the decision they were handed; they cannot change a tool result). The plugin uses them to judge whether "this step went smoothly":

| Signal | Meaning |
|---|---|
| `isError` | Something failed → thinking is needed |
| `slowMs` (default 5000) | Stuck on I/O → thinking is not the problem; holding full thinking does not help, but going cheaper is not right either |
| `bigChars` (default 20000) | A big result → there is a lot to digest |
| The same call with the same arguments ≥ 2 times | Spinning in place |
| A `holdTools` hit | Compression / takeover tools; the step after them must not be cut |

The rules are short:

- The planning step (`step < 2`) is left alone;
- A clean streak ≥ `deepAfter` → one notch down; another clean streak → a second notch is allowed;
- Any struggle signal → **immediately** back to the resolved original gear (it only lowers, never raises; the original gear is the ceiling);
- No idea which gears the current route has → do nothing.

### 2. Emit only the effort levels this route really declares

This is the key to "perfect support for the official API", and the fundamental difference from scripts that hardcode `reasoning_effort: "low"`: DSH validates the effort id **before** sending the request, so guessing an id that does not exist fails the whole model call instead of being ignored. So the plugin asks first, then acts.

The official route (`@deepseek-ai/dsh-llm-deepseek`, read out of the code, not guessed):

| Item | Value |
|---|---|
| provider id | `deepseek-official` (provided by `@deepseek-ai/dsh-llm-deepseek-api-key`) |
| base URL | `https://api.deepseek.com/anthropic` (Anthropic Messages wire protocol) |
| declared levels | `off` / `low` / `high` / `max`, default `high` |
| wire fields | `thinking: { type: "disabled" \| "enabled" }` + `output_config.effort` |
| the downgrade the plugin can make | `high → low` (16384 → 2048 thinking tokens); `off` sits below the floor and is never selected |
| to make it completely quiet | `floor: high` (the plugin becomes a pure observer) |

Self-hosted / gateway routes work the same way, only the ladder differs (for example, this machine's `company` gateway declares `off/minimal/low/medium/high` and every level really takes effect; one notch is `high → medium`). The plugin assumes no vocabulary: whatever the route declares is what it notches across; when the declaration is empty (`route=provider-none`) or cannot be obtained (`route=unknown`), it does not act at all.

### 3. Batch in parallel per gear

The effort level only decides "how long to think", not "how many calls a step issues". Multiple tool calls in one assistant message are scheduled **concurrently** by the harness (bounded by `agentLoop.maxParallelToolCalls`, default 10, and only calls declared safe are run concurrently), so the only honest way to raise real concurrency is to get the model to put independent calls in the same step — so at gear ≥ 2 the plugin registers a system-prompt section that states a different parallelism target per gear.

It also holds three rules that must not be broken: only **mutually independent** calls are parallelized, reads and writes never go into the same batch, and a failure in a batch shrinks back to small steps. The parallelism target is only a target: if the profile pushes the scheduling cap below the gear's target, the plugin logs a warn telling you which line to change in `cordis.patch.yml`.

## One-step install

Install into the current profile (DSH desktop → Plugin Manager → Install bundle). Three equivalent paths:

| Path | Action | Notes |
|---|---|---|
| **A. Plugin Manager (recommended)** | Install bundle, target `github:regrevia/dsh-fast-mode` | One spec; it fetches and links automatically, and upgrading is the same spec |
| **B. One terminal command** | `pnpm add github:regrevia/dsh-fast-mode --dir ~/.dsh/profiles/desktop` | Then see the patch snippet below |
| **C. Local development** | `pnpm add link:/path/to/dsh-fast-mode --dir ~/.dsh/profiles/desktop` | Code changes take effect immediately |

**Verified**: on DSH `0.2.1-rc.2` / `DSH_PROFILE=desktop`, pointing the Plugin Manager at `github:regrevia/dsh-fast-mode` fetched the tarball and applied it directly (`application: applied`, no warnings); the profile records `"dsh-fast-mode": "github:regrevia/dsh-fast-mode"`. That was 0.4.0, which had no client half. 0.5.0 adds the client half (the bolt) and applies just the same, but you **must reload the page / restart the app once** to see the icon — the host only scans `dsh.client` declarations at startup.

0.6.0 adds measurement and a report command, but the install path is unchanged: once installed it starts writing the metrics file, and a write failure cannot affect a request.

The npm package of the same name **is not published yet** (`npm whoami` has no credentials on this machine), so for now do not use an npm spec like `dsh-fast-mode@0.6.0`; use the `github:` form above.

Paths B / C need the plugin line inserted into the profile's `cordis.patch.yml` (path A writes it itself):

```yaml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
      config:
        enabled: true      # off by default after install; this line is the real switch
        gear: fast         # safe / fast / turbo / max / ludicrous (default: fast)
        debug: true
        debugFile: /tmp/fast-mode.log
```

Then run one turn with tool calls and read the log to see it working:

```
turn=1 step=19 gear=fast high=>low      route=provider obs=2 clean=2 err=0 slow=24ms big=114c rep=1 hold=0
turn=8 step=21 gear=fast high=>high     route=provider obs=5 clean=0 err=1 slow=1820ms big=9002c rep=1 hold=0 STRUGGLING
```

## Speed gears

A gear is not a set of switches but **one posture**: how early downgrading is allowed, how far back the signals look, and how many calls the model is asked to issue per step.

| Gear | Name | `floor` | `deepAfter` | `window` | Parallel target | Good for |
|---|---|---|---|---|---|---|
| 1 | Safe `safe` | `low` | 6 | 8 | 2 per step | Critical changes, wanting to read the logs first, zero prompt-change requirements |
| 2 | Fast `fast` | `low` | 4 | 6 | 4 per step | **Default, recommended for daily use** |
| 3 | Turbo `turbo` | `low` | 3 | 5 | 6 per step | Heavy code reading, research, bulk triage |
| 4 | Max `max` | `low` | 2 | 4 | 8 per step | Mechanical batch work; not recommended for critical changes unattended |
| 5 | Ludicrous `ludicrous` * | `off` | 1 | 4 | 8 per step | Batch work where you explicitly do not want quality: thinking off, fastest and riskiest |

- Use a name (`gear: turbo`): the schema accepts exactly `safe`/`fast`/`turbo`/`max`/`ludicrous`. A number or a typo (`gear: 5`, `gear: warp`) is a **load-time error**, not a silent fallback to some gear. The policy layer still normalises defensively, so a bad value can never become "unlimited".
- Explicit fields always beat the gear: `gear: turbo` + `deepAfter: 8` is "turbo parallelism with a conservative downgrade rhythm".
- Apart from `ludicrous`, whose own `floor` is `off`, no gear ever goes below `floor` (default `low`). To push harder, set `floor: minimal` or `floor: off` yourself; that amounts to allowing thinking to be turned off, and the quality risk is yours.
- `ludicrous` is the only gear that actually emits `reasoningEffort: 'off'`: the official route declares `off`, which is where the 3–4× lives; the quality drop is part of the design, and the panel marks it with an asterisk and one line of fine print.
- `safe`'s parallel target is 2, but it is the only gear that **injects no guidance** (`directive: false`), so that target never reaches the model — its behaviour is the pre-fast-mode release.
- The higher the gear, the more input tokens a step usually carries (more tool results per step) and the fewer round trips — exactly the "trade tokens for time" deal.

## Using it with context-compression plugins: more tokens, faster

The gear manages the **output / thinking** budget; compression plugins manage the **input / history** budget. The two levers are orthogonal, and stacked they multiply:

| Layer | Examples | What it cuts | Where it acts |
|---|---|---|---|
| Output / thinking | **this plugin** | Per-step thinking tokens and wall clock | `agent/request` → `reasoningEffort` |
| Input / history | billion-context (ACP proxy), built-in compaction, historical image offload | Prompt tokens, context pressure | The message list or the provider `baseURL`, before the request leaves |

Three rules make them actually work together:

1. **A gear is a field, not a sentence.** When a proxy re-serializes the request body it preserves `thinking` / `output_config`; this plugin writes that field **before** serialization, so the proxy only sees an ordinary request.
2. **Compression steps can be held.** A context-management call often looks very "clean" from the outside (fast, small result, no error) — exactly the moment the clean-streak rule wants to downgrade; name those tools in `holdTools` so the step after them keeps full thinking.
3. **One knob, one owner.** Do not let two components clamp `reasoningEffort` / `output_config.effort` at the same time: the second clamp does not know why the first raised it.

### billion-context

**Compatible, and complementary.** billion-context installs as a DSH bundle (`bili-native`), turns off the host-plane `compaction-basic` auto, and intercepts model traffic by patching the HTTP layer (`globalThis.fetch`); it does not go through `agent/request` and does not read or write `reasoningEffort`, so it cannot silently overturn this plugin's decisions.

Both caveats are **optional**:

1. `compress.outputSteering` is off by default; once enabled, the `effortRouting` inside it pushes effort to the lowest level on "mechanical continuation" turns (on Anthropic it changes `output_config.effort` and `thinking.budget_tokens` at the same time). That is exactly the knob this plugin owns, and it cannot see errors, slow calls, or explicit holds. Pick one owner:

   ```yaml
   - id: bili-native
     config:
       compress:
         outputSteering:
           enabled: true
           effortRouting: false    # let fast-mode own effort
   ```

2. Add its tools to `holdTools` so the "fold history" step itself is never downgraded:

   ```yaml
   - id: fast-mode
     config:
       gear: fast
       holdTools: [compress, decompress, search_context, acp_status, acp_retrieve, "acp_delegate*"]
   ```

Two further points are facts, not advice: billion-context's own summarizer calls run inside its proxy process, not through the harness, so this plugin cannot touch them; and it turns off `compaction-basic`'s automatic compaction, so **do not stack a second compressor**.

### Historical image auto-compression / gateway adapter plugins

Plugins like `image-guard` and `intellif-litellm-adapter` fix a different failure: rewriting the message list before the request goes out (moving old images away, forcing another compression round, retrying the 400 from `too_many_images`) so the request fits through a gateway's image-count / pixel / context caps. They share no field with this plugin and need no configuration change; if you want their retry steps to keep full thinking, you can also put the relevant offload / compaction tool names into `holdTools`.

Keep **only one image reducer** in a profile (billion-context also folds media server-side), otherwise the two compressions step on each other.

## Official API support

| Scenario | Supported | Basis |
|---|---|---|
| Official DeepSeek API (`deepseek-official`) | ✅ | Reads the official adapter's declaration (`off/low/high/max`, default `high`); the default gears notch only between `high → low`, `ludicrous` reaches `off` |
| A proxy / relay in front of the official API | ✅ | The ladder comes from the provider's **connection config** (`resolveModelInfo`), not from the network peer |
| Self-hosted / company gateway (e.g. `llm-pi-ai` + Anthropic Messages) | ✅ | As many levels as it declares, that many notches; on `off/minimal/low/medium/high` one notch is `high → medium` |
| OpenAI-compatible / other providers | ✅ | Same as above; the route only has to declare `reasoningEfforts`, and an empty declaration means the plugin does not intervene at all |
| A model with only `max`, or with no gears at all | ✅ (quiet) | with a single gear there is nothing to notch down; an empty declaration (`provider-none`) or an unanswerable route (`unknown`) also means it does nothing |

On the official API the **finest downgrade grain** is `high → low` (there is nothing in between), so the promise here is always "this request is cheaper", never "this request is cheap". To leave the official route completely unaffected, set `floor: high`. `ludicrous` is the single exception: its own `floor` is `off`, which is where the 3–4× comes from and why it carries an asterisk.

## Measurement, experiments and reporting

The multipliers are estimates; the real gain can only be measured on your own machine. 0.6.0 builds the measurement into the plugin and adds a comparison path that does not depend on eyeballing.

### One row per completed step

Measurement is on by default and **independent of the switch**: sessions with fast mode off are recorded too, otherwise there is no control arm. Every completed model step appends one JSON line to `~/.dsh/fast-mode-metrics.jsonl`; the directory is created lazily, write failures are silent, and a request is never affected.

| Field | Meaning |
|---|---|
| `v` / `ts` / `sid` / `turn` / `step` | format version, timestamp, session id, turn number, step number |
| `mode` | `on` / `off` / `unknown`: the switch's state for that turn |
| `gear` / `effort` / `route` | effective gear (`off` when disabled), the effort id actually emitted, and this request's `provider/model` route (the debug line's `route=` is the ladder source; see below) |
| `ttftMs` | step start → first assistant message, i.e. time to first token |
| `llmMs` | step start → last assistant message, i.e. model time |
| `stepMs` | wall clock of the whole step, **including** tool execution |
| `calls` / `errors` | tool calls in that step / how many of them errored |
| `input` / `output` / `reasoning` / `cacheRead` / `cacheWrite` | the upstream `usage` token counts, as measured |
| `assistantMessages` | how many assistant messages that step produced |

- `metrics: false` turns measurement off; `metricsFile` moves the file. Like `benchmarkFile`, the path is a **composition knob** (deliberately not volatile): it is read at load, so changing it means editing `cordis.patch.yml`.
- The report's "model time" is `llmMs` and "first token" is `ttftMs`. Do not read `stepMs` as model speed: it includes the time your own machine spends running tools.

### Assigning gears per session

When `~/.dsh/fast-mode-bench.json` (or `benchmarkFile`) exists with `enabled: true`, the plugin assigns gears per session:

```json
{
  "enabled": true,
  "gears": ["off", "safe", "fast", "turbo", "max"],
  "sessions": { "<session id>": "turbo" }
}
```

- `gears` may contain `"off"` — the **control arm**, whose sessions run switched off. Without it an experiment can only rank gears against each other, never answer "faster than nothing", which is the claim to prove.
- An explicit `sessions` pin wins; otherwise `FNV-1a(session id) mod gears` picks one, so the same session lands in the same arm every time.
- The file takes effect within a second, no restart needed; delete it and the next request falls back to the configured switch and gear.
- An assigned session **runs as assigned regardless of the switch**: the arm is decided by the file and the hash. Otherwise a session where you forgot to flip the switch would quietly join the control arm while you believe you are measuring `turbo`.
- Names not in `gears` are dropped with one warning; a file that is not JSON, or contains no known gear, leaves the experiment inert and complains once.

### The report: `dsh-fast-mode-report`

```bash
node bin/report.mjs --since 2d     # run it straight from the checkout; always works
dsh-fast-mode-report --json        # the package's bin name; linked into the profile after install
```

The npm package of the same name is not published yet, so `npx dsh-fast-mode-report` cannot fetch it today (equivalent once published).

| Option | Effect |
|---|---|
| `--file <path>` | measurement file, default `~/.dsh/fast-mode-metrics.jsonl` |
| `--since <when>` | only recent rows: `2d` / `12h` / `90m`, or anything `Date.parse` accepts; with `--lan` it also widens the dashboard's query window |
| `--json` | machine-readable output (`{file,total,used,since,buckets,lan}`) |
| `--lan` | also reconcile against the LAN usage dashboard (below) |
| `-h` / `--help` | usage |

The default output has three parts:

1. one row per `mode|gear`: sessions, steps, steps/turn, step-time p50/p90, model-time p50, first-token p50, output tok/step, output tok/session, tools/step, multi-call steps (steps that issued more than one tool call);
2. a ratio table against the disabled state: model time, step time, output tok/step, output tok/session, tools/step (>1× means that gear is faster / more expensive);
3. a line stating the unit: comparisons are per **step**, not per session wall clock — most of a session's wall clock is a human reading and typing.

With no disabled-state samples the report does not invent a ratio; it tells you to run the same task twice, once with the bolt off.

`--lan` joins local rows to the LAN usage dashboard (`/api/v1/sessions/recent`) by session UUID and adds the upstream model name, total/input/output tokens and the whole-session duration:

- read-only, it issues no write requests;
- the token comes from the `USAGE_TOKEN` environment variable and is never printed; the dashboard base defaults to the address compiled into the build and can be overridden with `USAGE_BASE`;
- without a token it prints one note and skips `--lan`, the rest of the report still renders;
- nothing leaves the LAN; the dashboard's window follows `--since` (its own bins are `1d`/`7d`/`30d`, and `7d` is used when no `--since` is given), and when a session cannot be matched the report says so instead of guessing.

### The experiment: `dsh-fast-mode-experiment`

The report only means something when both arms did comparable work and the gear was not chosen by the person reading the numbers. This command owns the assignment file so nobody hand-edits JSON:

```bash
node bin/experiment.mjs start                 # four gears, assigned by session-id hash
node bin/experiment.mjs status                # sessions/steps per arm so far, and what is missing
node bin/experiment.mjs stop                  # end it, back to the configured switch and gear
node bin/report.mjs --since 7d                # the comparison
```

| Option | Effect |
|---|---|
| `--bench <path>` | assignment file, default `~/.dsh/fast-mode-bench.json` |
| `--metrics <path>` | measurement file, default `~/.dsh/fast-mode-metrics.jsonl` |
| `--gears a,b,c` | arms to include (default `off,safe,fast,turbo,max`, where `off` is the control arm; fewer than two is refused) |
| `--sessions n` | the "at least this many sessions per arm" bar `status` reports against, default 3; advisory |
| `--force` | overwrite a running assignment file |

While an experiment runs, **new sessions run as assigned** (anything but `off` arms itself), no bolt-clicking, or a forgotten click would quietly land a session in the control arm. `status` says exactly what is still missing: no disabled-state samples, an arm with zero sessions, whether each arm has reached `n` sessions. Remember to `stop`; otherwise later sessions keep being assigned.

## Configuration

```yaml
- id: fast-mode
  name: dsh-fast-mode
  config:
    enabled: true              # the switch, default false; same field the composer bolt writes
    gear: fast                 # safe / fast / turbo / max / ludicrous (default: fast)
    parallel: 4                # optional: overrides the gear's parallel target (only the number in the prompt and the warning are affected)
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
    debug: false
    debugFile: ""
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | the switch, and the field the composer bolt writes; only `true` makes the plugin intervene |
| `gear` | `fast` | Gear, one of `safe`/`fast`/`turbo`/`max`/`ludicrous`; a number or a typo is a load-time error |
| `parallel` | follows the gear (4/6/8) | Parallel target in the injected prompt; `1` means no injection. **Left blank** in the settings page means "follow the gear" — it deliberately has no schema default, because a default would pin the field and the gear could never raise it again |
| `floor` | `low` | never choose a cheaper gear; on the official route `floor: high` means no downgrade at all |
| `deepAfter` | follows the gear (6/4/3/2/1) | how many consecutive clean calls allow the second notch |
| `slowMs` | `5000` | at or above this duration, hold thinking |
| `bigChars` | `20000` | at or above this result size, hold thinking |
| `window` | follows the gear (8/6/5/4/4) | how many recent calls are considered |
| `escalateAfterStep` | `0` | restore full thinking on very long turns; `0` disables |
| `holdTools` | `[]` | tool names or prefixes (`acp_*`); a hit counts as "not routine work" and keeps the gear for the next step |
| `ladder` | — | explicitly pin the ladder (≥2 ids) |
| `aliases` | `auto` | collapse documented compatibility aliases onto the effective gear; `false` disables, a map overrides |
| `discoverTimeoutMs` | `250` | how long to wait for the route's declaration; if it does not arrive, decide without it |
| `baselineFromDefault` | `true` | with no resolved gear, treat the route's `defaultEffort` as the baseline to notch below |
| `metrics` | `true` | write one JSONL row per completed step; `false` writes nothing |
| `metricsFile` | `~/.dsh/fast-mode-metrics.jsonl` | where the measurement file lives. A **composition knob**: it never appears in the settings form, so changing it means editing `cordis.patch.yml` |
| `benchmarkFile` | `~/.dsh/fast-mode-bench.json` | per-session gear assignment file, read the same way (at load, re-read with a 1 s TTL) |
| `debug` / `debugFile` | off / `""` | one line per request, with the basis for the decision |

### `route=` in the log

`route=` says where the ladder came from: `provider` (discovered at runtime), `provider+aliases` (discovered, widened by the documented aliases), `provider-none` (the route declares nothing), `configured` (pinned by `ladder`), `builtin` (the built-in default ladder), `unknown` (the route could not be interrogated). At startup the logger also prints the resolved ladder and gear settings once per route.

If every line reads `high=>high`, check in this order: whether the step number reached 2 (the planning step is exempt by design); whether it is `route=provider-none` or `unknown` (a route without `reasoningEfforts` has no gear to lower); whether the current gear already equals the `floor` you set.

## Safety boundaries

- **Observe only, never change results.** Both tool hooks always forward the original decision; when the decision logic throws, it falls back to the gear the harness originally chose.
- **Emit only ids the route declared.** A property test guarantees that no input can produce a gear the route did not declare; the worst case is "did nothing", never "broke the turn".
- **No session writes.** Observation data stays in memory, isolated per agent and reset per turn; it does not occupy a single token of context.
- **Failure is silent.** An unreachable provider, a timeout, an unwritable log file — all degrade silently.
- **A metrics write cannot affect a request.** The JSONL is append-only, the directory is created lazily, and errors are swallowed; the report side only reads the metrics file, `--lan` issues GETs only, and the token lives in memory, is never printed, and does not leave the LAN.
- **The client half cannot take the composer down.** Every remote call behind the bolt sits in a try/catch behind a deadline; an unreadable configuration keeps the button clickable and states the reason in the panel's status line, and a slot registration taken by another plugin only logs a warn instead of escaping `apply`.

## Honest limitations

- Output tokens are serial: within one generation, less thinking only makes this step shorter; it does not overlap this step with the next. Upstream `usage.outputTokens` TPS is unchanged — what moves is model time and step count, not the speed at which one model generates.
- A host plugin cannot "issue parallel calls on the model's behalf"; it can only raise the scheduling cap, or get the model to put independent calls in the same step itself. This plugin does the latter (plus a warning when the cap is too low).
- It does not rescue a turn stuck on slow commands, and it is not a substitute for batching independent calls.
- It integrates no external "decision model" endpoint (Jev, for example): that would introduce a network round trip, the opposite of this plugin's purpose.
- How much wall clock it saves depends on how big a share thinking has in your turn. In the session above, generation absolutely dominates (about 44 s per turn), which is exactly the case it targets.
- The guidance section is injected only when the gear actually asks for a directive: `safe` and the switched-off state cost nothing, every other gear costs about 1 KB of text per request (≈300 input tokens).
- On the official API the only legal cut that keeps thinking on is `high → low` (16384 → 2048 thinking budget), so roughly 2× is the ceiling; 3–4× requires `ludicrous` to turn thinking off, and that quality cost is stated, not hidden.
- The multipliers on the panel are **estimates**, not measurements; for numbers, use the measurement and report path above, and make sure both sides do comparable work.

## Development and tests

```bash
npm test        # 147 tests, no network, no harness required
```

The policy tests cover the planning-step exemption, single and double notches, `floor`, the no-upgrade rule, each struggle signal working on its own, a `holdTools` hit, per-turn reset, per-agent isolation, bounded observation memory, malformed argument handling, config normalization (a typo in `floor` degrades to the default rather than removing the floor), and gear normalization (a bad value never becomes "unlimited"). The provider group runs the policy against the official adapter's real declaration (`off/low/high/max`), a wider alias list, a five-level self-hosted gateway, and a route that declares no gears at all — including a property test that no input can produce an id the route did not declare. The integration tests drive the registered handlers through a fake context in harness order, and verify that the system prompt is registered at gear ≥ 2 and completely absent at gear 1. The metrics group proves that **sessions with the switch off are recorded too** (one row per step, time-to-first-token taken from the first assistant message), and covers token/error summing, per-session isolation, lazy directory creation, and an empty path turning the sink off. The experiment-assignment group proves the hash is stable and covers every gear, an explicit pin wins, a single session can be pinned, the file takes effect within a second, no file or `enabled:false` keeps it completely inert, and a broken file complains once. The report group runs the real `bin/report.mjs`: both tables, a text-only refusal when only one arm has samples, `--since` (which also widens the dashboard window), `--json`, `--help` reading no file, skipping `--lan` without a token, matching by session id when a token is present while **never printing the token**, and degrading to a note when the dashboard is unreachable. One last test checks the plugin manifest itself — the `icon.png` in the package really is a PNG no larger than 256 KiB, both languages of `meta.title` / `meta.description` are present, and `files[]` covers every file the runtime needs. The same group also checks the client-half manifest contract (`dsh.client.platform === "web"`, `exports["./client"]`, `client.js` packed, the bundle id equal to the package name, and the registered slot being `conversation.input.activity` rather than the one that would shadow the model selector), and runs the shipped `client.js` verbatim in a `vm` sandbox with a stub `__ModuleLoader__` and a fake `settings` remote that answers with the real wire envelope (`{ok, value}`) — the missing unwrap is what made 0.5.1's bolt inert, so the envelope is part of the fixture now: the bundle parses, requires only `react`, paints hollow when off, a click only opens the panel and writes nothing, the switch inside sends exactly one `settings/update` carrying the revision it read, a second click turns it back off, rolls back with a stated reason when that write is refused, and pins the new interaction contract — the outer control is **one icon** (no caret, no inline dropdown), the button is **never** disabled, read-only / absent / `ok:false` all render as "clickable with a reason", the five rows are labelled with their speed and token multipliers, `ludicrous` carries its asterisk, picking a gear while off arms `enabled` in the same write, picking one while already on leaves the toggle alone, and the client gear ids match the host `GEARS` exactly. Another group validates the schema against real schemastery: `enabled` defaults to `false`, all five gear names pass, `gear: warp` fails loudly, measurement is on by default, exactly `enabled`/`gear`/`parallel` are volatile, and patch-level keys the schema does not declare (`floor`, `holdTools`) survive untouched.

## License

MIT © regrevia · [Chinese README](README.md)
