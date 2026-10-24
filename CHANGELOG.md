# Changelog

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
