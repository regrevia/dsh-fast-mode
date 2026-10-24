# dsh-fast-mode

**DeepSeek Harness's own fast mode: spend deliberation where it decides something, and stop paying for it on every execution step.**

A zero-dependency, no-build DSH host plugin. It watches how your tool calls are
actually going — failures, hangs, oversized results, repeat calls — and adjusts
`reasoningEffort` for the next model call accordingly.

[中文文档](./README.zh.md)

## Why this exists

A DSH turn is not one model call. The harness re-resolves the request config for
**every step** of a turn, and each step pays a fresh thinking budget before
deciding what to do next.

Measured on a real 10-turn session (617 tool calls), **91% of steps issued
exactly one tool call**, and 95% of calls finished under 100 ms. The clock was
not spent running tools. It was spent deliberating between them.

With the budget table most deployments use:

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
- an effort id outside the known ladder is passed through untouched, never
  guessed;
- observations reset per turn, so a hard turn does not slow down the next one.

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
        floor: low             # cheapest effort this policy may choose
        deepAfter: 6           # clean calls before a second notch is allowed
        slowMs: 5000           # a call this slow means I/O bound, hold effort
        bigChars: 20000        # a result this big means heavy digest, hold effort
        window: 8              # how many recent calls the signals look at
        escalateAfterStep: 0   # restore full effort past N steps in a turn; 0 disables
        debug: false
        debugFile: ""          # with debug:true, append decisions here
```

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | `false` makes the plugin do nothing |
| `floor` | `low` | never choose an effort cheaper than this |
| `deepAfter` | `6` | consecutive clean calls that earn a second notch |
| `slowMs` | `5000` | at or above this duration, hold effort |
| `bigChars` | `20000` | at or above this result size, hold effort |
| `window` | `8` | recent calls considered |
| `escalateAfterStep` | `0` | lift a very long turn back to full effort; `0` disables |
| `ladder` | `off, minimal, low, medium, high` | cheapest-first ids; override only for a different provider vocabulary |
| `debug` / `debugFile` | off / `""` | one line per request, with the signals behind the decision |

### Verify it is working

Set `debug: true` and a `debugFile`, then run a turn with real tool calls:

```
turn=0 step=1 medium=>medium obs=0 clean=0 err=0 slow=0ms big=0c rep=0
turn=0 step=2 medium=>low    obs=1 clean=1 err=0 slow=61ms big=420c rep=1
turn=0 step=3 medium=>low    obs=3 clean=3 err=0 slow=61ms big=420c rep=1
turn=0 step=4 medium=>medium obs=4 clean=0 err=1 slow=61ms big=420c rep=1 STRUGGLING
```

The fourth line is the point: a failure arrived, so deliberation came back.

If every line reads `medium=>medium`, check that `enabled` is true, that the step
counter reaches 2, and that your provider resolved an effort at all (a provider
without `reasoningEfforts` gives the policy nothing to lower).

## Why the policy is stateless about context, not about the run

The tempting shortcut is to look at the recent tool calls in the session. That
input is not reliably reachable from a request hook: the agent handle carries an
id and nothing else, `agent/pre-step` carries user messages only, and session
records are persisted out of process.

A policy built on unreachable input does not fail loudly — it reads an empty
list, concludes "no data, keep the current effort", and looks installed while
doing nothing. This plugin instead takes the run's behaviour from
`tools/post-execute`, which is genuinely delivered, and falls back to the plain
step rule if even that throws.

## Compatibility

Two extension points: `agent/request` (returns a modified `LlmCallConfig`) and
the `tools/pre-execute` / `tools/post-execute` observers. No `@deepseek-ai/*`
imports, so there is no peer-dependency version to track.

## Tests

```bash
npm test
```

23 policy tests plus 10 integration tests, `npm test` runs both: the policy tests
cover the planning-step exemption, single and double notch, the floor, the
no-upgrade rule, each struggle signal separately, per-turn reset, per-agent
isolation, bounded observation memory, malformed argument handling, and config
normalisation (a typo in `floor` degrades to the default rather than removing the
floor). The integration tests drive the registered handlers through a fake
context in harness order, which is what proves the hooks are actually connected —
the policy tests alone would still pass if `apply()` registered nothing.

## Honest expectations

The mechanism is a smaller thinking budget on execution steps. On a turn at
`medium`, one notch is `8192 → 2048`; from `high`, two notches reach `2048`. How
much wall clock that saves depends on how large a share deliberation has in your
turns — in the session measured above, generation dominated (about 44 s per turn
against a tool-call p50 of 67 ms), which is exactly the case this targets.

It will not help a turn that is waiting on slow commands, and it is not a
substitute for batching independent calls.

## License

MIT
