# dsh-fast-mode

**DeepSeek Harness's own fast mode: spend deliberation where it decides something, and stop paying for it on every execution step.**

A zero-dependency, no-build DSH host plugin. It watches how your tool calls are
actually going — failures, hangs, oversized results, repeat calls — and adjusts
`reasoningEffort` for the next model call accordingly, using only effort levels
the current provider actually declares.

[中文文档](./README.zh.md)

## Why this exists

A DSH turn is not one model call. The harness re-resolves the request config for
**every step** of a turn, and each step pays a fresh thinking budget before
deciding what to do next.

Measured on a real 10-turn session (617 tool calls), **91% of steps issued
exactly one tool call**, and 95% of calls finished under 100 ms. The clock was
not spent running tools. It was spent deliberating between them.

With the budget table this deployment uses:

| effort | thinking budget |
|---|---|
| `off` | 0 |
| `minimal` | 1024 |
| `low` | 2048 |
| `medium` | 8192 |
| `high` | 16384 |

a turn running at `medium` pays an 8192-token planning budget on step 2, step 3,
step 4 — to decide which file to read next. `dsh-fast-mode` makes those steps run
cheaper, and keeps them expensive the moment the work stops being routine.

## How it decides

Nothing is hardcoded per tool name. The policy reads the run.

**Signals that hold full deliberation** (the quality guard). Any of these in the
recent window means the next action is not routine:

- a tool call failed;
- a call took longer than `slowMs` — the turn is I/O bound, so thinking is not
  the bottleneck and cutting it only removes the capacity to diagnose;
- a single result exceeded `bigChars` — there is a lot to digest;
- the same call (name plus normalised arguments) ran twice — a loop.

**Signals that earn a deeper cut:**

- a streak of consecutive clean calls — succeeded, fast, small result. After
  `deepAfter` of those, the policy allows a second notch.

**Always:**

- the first step of a turn keeps full effort: that is where the plan is made;
- never below `floor` (default `low`);
- never steps *up* toward the floor — a model already running cheaper than the
  floor is left alone, because raising it would be a speed-up quietly becoming a
  slow-down;
- an effort id outside the route's declared levels is passed through untouched,
  never guessed;
- observations reset per turn, so a hard turn does not slow down the next one.

## Provider support: it asks, it never assumes

The effort vocabulary is not the same everywhere. It differs between providers,
between a provider and a self-hosted gateway, and between models on the same
provider. A plugin that hardcodes a list is therefore wrong on most routes, and
wrong *silently* — it sends a plausible id, the wire translates it to something
the model was already doing, and the "speed-up" measures as noise.

So the plugin asks the harness first. Before it lowers anything it resolves the
current route's own declaration:

```js
const llm = ctx.get('llm')
const info = await llm.resolveModelInfo(provider, model)
info.reasoning.efforts          // [{ id, name, description? }, …]
info.reasoning.defaultEffort    // what this route would have used anyway, if declared
```

That list is the source of truth. The policy notches across **those** ids only.

### Official DeepSeek API

Read from the shipped adapter (`@deepseek-ai/dsh-llm-deepseek`), not inferred
from the public docs — the adapter translates the protocol itself, so its
declaration is what the harness will validate against:

| fact | value |
|---|---|
| provider id | `deepseek-official` |
| protocol | Anthropic Messages, `https://api.deepseek.com/anthropic` |
| default models | `deepseek-flash`, `deepseek-v4-pro` |
| declared efforts | **`off`, `low`, `high`, `max`** — four real levels |
| default effort | `high` when the connection does not set one |
| wire encoding | `thinking: { type: "disabled" }` at `off`, otherwise `thinking: { type: "enabled" }` + `output_config: { effort }` |

Two consequences, and they are the reason this section exists:

1. **On the official route the notch is `high` → `low`.** There is no `medium`
   level to land on, so one declared level is the smallest cut the route can
   express. `high`→`low` is a real reduction (16384 → 2048 on the table above),
   not a cosmetic one.
2. **`off` is never chosen at the default floor.** On this route `off` is not a
   cheaper thinking budget — it disables thinking altogether. The default
   `floor: low` keeps it out of reach; only an explicit `floor: off` opts in.

If you find even one notch too aggressive on a coarse four-level route, set
`floor: high` — that makes the plugin a no-op on that route without touching any
other provider.

The public OpenAI-compatible endpoint documents a wider compatibility surface
(`reasoning_effort` accepts `minimal`, `medium`, `xhigh` and maps them onto
`low`/`high`/`high`). A gateway that exposes those ids *as declared levels* is
handled too: they are collapsed onto their effective level before notching, so
the plugin never reports a `high`→`medium` downgrade that is a no-op on the wire.
The shipped official adapter does not expose them — it declares four honest
levels — so this path only matters for OpenAI-protocol gateways.

### Self-hosted and other providers

A gateway declaring five distinct levels keeps all five; the notch is
`high`→`medium`. The plugin has no provider-name check anywhere — the
discriminator is the declared list itself, which is also why it keeps working
for a provider neither of us has heard of.

### The safety rule

The harness validates an effort against the route **before provider I/O** and
rejects an unsupported one with `UNSUPPORTED_REASONING_EFFORT`, which fails the
whole model call. A plugin that guesses is therefore not merely useless, it
breaks the turn.

`dsh-fast-mode` only ever emits an id the route declared. When the route cannot
be interrogated — no `llm` service, an adapter that throws, discovery slower than
`discoverTimeoutMs`, a provider that declares no levels at all — it emits
**nothing** and the request proceeds exactly as it would have without the
plugin. The worst case is "does nothing", never "breaks the turn".

## What it does not do

**It does not add tokens to your conversation.** The observation store is in
process memory. It never writes to the session, never injects context, never
touches a tool result. Its only effect is how much the model deliberates.

**It does not modify tool results.** Both hooks are pure observers: they forward
the decision they were given, always.

**It does not compress context.** Tool output stays verbatim.

**It does not make the model emit parallel tool calls, and it does not claim to.**
Parallelism in DSH is decided by `isConcurrencySafe` on each tool definition, and
it only applies to calls the model already emitted in one block. A host plugin
cannot create calls the model did not ask for. If you want fewer round trips, the
lever is batching independent calls in one block — a model behaviour, not
something a plugin can retrofit.

**It does not remove I/O waits.** If a turn is dominated by a 60-second timeout,
no effort setting helps; the policy detects that case and stops downgrading.

**It does not rewrite tool arguments.** `tools/pre-execute` returns a decision
(`allow` / `deny` / `ask` / `cancel`) — there is no rewrite arm, so a plugin
cannot shrink a command's timeout from here. Bounding slow commands belongs in
the instructions the agent runs under, not in a gate.

## Install

```bash
git clone https://github.com/regrevia/dsh-fast-mode.git
```

Then install the directory through the plugin manager (recommended — it wires the
profile dependency and applies the bundle patch):

```
plugin_manager install_bundle /absolute/path/to/dsh-fast-mode
```

Or by hand, in `~/.dsh/profiles/<profile>/`:

```jsonc
// package.json
"dependencies": { "dsh-fast-mode": "link:/absolute/path/to/dsh-fast-mode" }
```

```yaml
# cordis.patch.yml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
```

```bash
pnpm install && dsh web
```

**A restart is required.** Nothing happens at import time.

## Configuration

Every field is optional. Defaults shown.

```yaml
- insert:
    - id: fast-mode
      name: dsh-fast-mode
      config:
        enabled: true
        floor: low               # cheapest effort this policy may choose
        deepAfter: 6             # clean calls before a second notch is allowed
        slowMs: 5000             # a call this slow means I/O bound, hold effort
        bigChars: 20000          # a result this big means heavy digest, hold effort
        window: 8                # how many recent calls the signals look at
        escalateAfterStep: 0     # restore full effort past N steps in a turn; 0 disables
        ladder: ["off", "low", "high", "max"]   # optional; pins the ladder, skipping discovery
        aliases: auto            # auto | false | { "<declared id>": "<effective id>" }
        discoverTimeoutMs: 250   # budget for asking the provider what it declares
        baselineFromDefault: true # when no effort resolved, notch below the route default
        debug: false
        debugFile: ""
```

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | `false` makes the plugin do nothing |
| `floor` | `low` | never choose an effort cheaper than this; on the official route `floor: high` disables cuts entirely |
| `deepAfter` | `6` | consecutive clean calls that earn a second notch |
| `slowMs` | `5000` | at or above this duration, hold effort |
| `bigChars` | `20000` | at or above this result size, hold effort |
| `window` | `8` | recent calls considered |
| `escalateAfterStep` | `0` | lift a very long turn back to full effort; `0` disables |
| `ladder` | — | pin the ladder explicitly (≥2 ids) when discovery is unavailable or unwanted |
| `aliases` | `auto` | collapse documented compatibility aliases onto effective levels; `false` disables, a map overrides |
| `discoverTimeoutMs` | `250` | how long to wait for the route's declaration before deciding without it |
| `baselineFromDefault` | `true` | with no resolved effort, treat the route's `defaultEffort` as the baseline to notch below |
| `debug` / `debugFile` | off / `""` | one line per request, with the signals behind the decision |

### Verify it is working

Set `debug: true` and a `debugFile`, then run a turn with real tool calls:

```
turn=1 step=19 high=>low      route=provider   obs=2 clean=2 err=0 slow=24ms big=114c rep=1
turn=1 step=20 high=>low      route=provider   obs=4 clean=4 err=0 slow=27ms big=1153c rep=1
turn=8 step=21 high=>high     route=provider   obs=5 clean=0 err=1 slow=1820ms big=9002c rep=1 STRUGGLING
```

`route=` says where the ladder came from: `provider` (discovered),
`provider+aliases`, `configured` (pinned by `ladder`), `provider-none` (the
route declares no levels), `none` (discovery unavailable and nothing pinned).
The `[fast-mode]` logger also prints the resolved ladder once per route.

If every line reads `high=>high`, check in this order: step number reached 2 (the
planning step is exempt by design); the route reported `route=provider` rather
than `none` (a route with no `reasoningEfforts` has nothing to lower); the
current effort is above your `floor`.

## Why the policy is stateless about context, not about the run

The tempting shortcut is to look at the recent tool calls in the session. That
input is not reliably reachable from a request hook: the session records are
persisted out of process, and `agent/pre-step` carries messages only.

A policy built on unreachable input does not fail loudly — it reads an empty
list, concludes "no data, keep the current effort", and looks installed while
doing nothing. This plugin instead takes the run's behaviour from
`tools/post-execute`, which is genuinely delivered, and falls back to the plain
step rule if even that throws.

The effort actually in force is read from the resolved config (`await next()`),
not reconstructed, so the plugin never has to guess what the harness decided.

## Compatibility

Two extension points: `agent/request` (returns a modified `LlmCallConfig`) and
the `tools/pre-execute` / `tools/post-execute` observers, plus one forward query
`ctx.get('llm')` for the route's declaration. No `@deepseek-ai/*` imports, so
there is no peer-dependency version to track.

## Tests

```bash
npm test
```

55 tests, no network, no harness required. The policy tests cover the
planning-step exemption, single and double notch, the floor, the no-upgrade rule,
each struggle signal separately, per-turn reset, per-agent isolation, bounded
observation memory, malformed argument handling, and config normalisation (a typo
in `floor` degrades to the default rather than removing the floor).

The provider tests are the ones that matter for portability: they run the policy
against the **official adapter's actual declaration** (`off/low/high/max`), the
wider documented alias list, a five-level self-hosted gateway, and a route that
declares nothing — including a property test that no input can produce an id the
route did not declare. The integration tests drive the registered handlers
through a fake context in harness order (discovery present, absent, throwing,
slow, cache upgrade), which is what proves the hooks are actually connected —
the policy tests alone would still pass if `apply()` registered nothing.

## Honest expectations

The mechanism is a smaller thinking budget on execution steps. On a five-level
gateway, one notch is `8192 → 2048`; on the official four-level ladder the notch
is `16384 → 2048` because there is nothing in between. How much wall clock that
saves depends on how large a share deliberation has in your turns — in the
session measured above, generation dominated (about 44 s per turn against a
tool-call p50 of 67 ms), which is exactly the case this targets.

It will not help a turn that is waiting on slow commands, and it is not a
substitute for batching independent calls.

## License

MIT
