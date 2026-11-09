# Panel: two-tier gear, and what the footer reports

The right-click panel is one settings surface for one conversation. This note
records the two decisions in it that are not self-evident from the row list: the
tier control on the title row, and the numbers (or the absence of numbers) on the
footer.

## The gear control

`safe | auto` — displayed as 保守 / 标准 (Cautious / Standard). It is the only
control in the panel that is not a row, and since 1.7.31 there are two tiers,
not three.

- **Placement** — right side of the title row, in its own `role="radiogroup"`.
  The row is a wrapping flex line, so at narrow widths the whole block moves to
  the next line instead of overlapping or squashing the title. The button labels
  never wrap mid-word, and the group sets no fixed width.
- **What it writes** — through the same `write()` every row uses, so the patch
  is `{ entry: { gear: <value> } }` under the conversation's key in the sessions
  column. Values are exactly `safe`, `auto`. Nothing shared is touched, and
  `enabled` is never sent with it, so picking a tier cannot switch fast mode on
  or off.
- **`auto` is 标准.** It is the factory default (`DEFAULT_GEAR` in
  `src/effort.js`), so the middle tier is the state a conversation starts in.
- **`aggressive` has no button.** The id still resolves (8 lanes) for old configs
  and experiment arms, but 1.7.31 removed the third button: its extra three
  switches are exactly the ones the benchmark could not prove, and offering the
  tier would recommend them.
- **Read-back is normalized** (`gearTier`): `safe` → 保守, everything else —
  `auto`, `fast`/`aggressive`/`turbo`/`max`/`ludicrous` from an older
  configuration, an empty field, an unknown id — shows as 标准. The
  normalization is display-only: a stored value the panel cannot write is left
  untouched until the user picks a tier, and the panel never writes a retired id
  back.
- **The two tiers differ in behavior.** `safe` runs 2 parallel calls and turns
  the directive off (`directive: false`), `auto` runs 4 with the full discipline,
  adaptive nudging, the three deliberation switches, and (since 1.7.32) the
  opening file inventory and batched reads that only pay off as a bundle. `safe` is the only gate:
  under it the panel greys the four prompt rows, reads them as off and writes nothing. The fifth row (the tool-call timeout guard) is not gated: the safe tier already computes budget 0 and writes `stallGuard:false`, so that row shows its real state.
  Legacy folding applies only to *unpinned* gears (`const legacyGear = !pinned
  && LEGACY_GEARS.includes(named)`), and this plugin pins the gear per session,
  so a chosen tier reaches the scheduler as itself.
- **Accessibility** — `radiogroup` + `radio` with `aria-checked`; roving tab
  index (the checked tier holds the single tab stop); Arrow keys move and wrap,
  Enter and Space pick. The group's tooltip says the tiers change only how wide
  calls run and how often it nudges, not the mechanism.

## The footer

The footer used to read 只影响本会话 / "This conversation only" — a scope note
standing in for the readout the panel was supposed to have. It now reports the
conversation's real steps and output when those numbers exist:

    12 步 · 输出 3.2k
    12 steps · 3.2k out

**Where the numbers come from.** The client reaches them through the `sessions`
service the session controller provides (`dsh-api-session-controller`), not
through a settings namespace:

- `sessions.projectionValues(sessionId)` → the projection store's `values()`:
  an object keyed by projection name, `undefined` before the first store exists.
- `sessionStats` (`dsh-session-stats`) carries `steps`, incremented on each
  `step/end`; this is the step count shown on the left.
- `tokenUsage` (`dsh-token-meter`) exposes `view: (state) => state.totals`; the
  wire shape has `outputTokens`, accumulated from provider-reported usage in the
  durable log. This is the number shown as `输出`.
- `sessions.subscribe(listener)` re-renders the panel when a projection changes;
  the wiring removes its listener on plugin dispose.

So the data **is** obtainable on the client today, with no new dependency in
`package.json`: `exports.inject` names services, not packages, and `sessions` is
already mounted by the session controller.

**When it is not obtainable**, the footer keeps the original scope line
(`panel.scope`) and adds a `title` (`panel.scopeTitle`) saying the conversation's
steps and output cannot be read here. That is the honest fallback, not an error
state: the panel still works, it just does not invent a count.

Rules the readout obeys:

- **No benefit percentages, ever.** No multiplier, no "N× faster", no "saves
  N%" anywhere in the panel copy. The footer states counts that were measured,
  which is the only claim this half can support.
- **A missing field is omitted, never zeroed.** Steps alone renders
  `7 步` (`panel.savedSteps`); output alone renders `输出 1.2k`
  (`panel.savedTokens`); neither renders the scope line. A number that is not a
  finite non-negative value is treated as missing, and a throwing projection
  counts as missing too.
- **Compact on screen, exact in the tooltip.** The visible line abbreviates
  thousands (`1.2k`, `20.5k`, `1.1M`); the `title` carries the full value
  (`1234 步 · 输出 3218`). Truncation at narrow widths is ellipsis plus the same
  tooltip, never a clipped number.
- **No new visual tokens.** Same 12px quaternary label color, same spacing as the
  static line it replaced; no shadow, border, or radius was added.

## Tests

`test/client-gear.test.js` covers the two decisions against the shipped bundle:
the group's shape and labels, all the read-back cases (including the retired
ladder), write-only-the-gear, the no-op click, arrow wrapping and roving tab
index, disabled state, the four footer states (both numbers, steps only, output
only, neither), a live projection push, dispose, a throwing projection, and the
absence of any percentage claim in the dictionary.
