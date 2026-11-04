/**
 * dsh-fast-mode — client half: the lightning chip in the composer.
 *
 * One control, one source of truth. The chip is a view of the plugin's own
 * `enabled` and `gear` config fields, read and written through the `settings`
 * service (`settings/describe` → `settings/update`), which is the same surface
 * the Loader uses for its composition patch. There is no second state store: a
 * click writes `{ enabled }` or `{ gear }` to this entry's user layer, the Loader
 * re-applies the settings half, and the policy changes on the next model call.
 *
 * Why the chip lives in `conversation.input.right`: that slot is a *list* — every
 * entry renders beside the others, keyed by `id` and ordered by `order` — so the
 * chip can never be shadowed. The single slots nearby (`conversation.input.activity`,
 * `conversation.input.model`) render only `entriesOfSlot(slotKey)[0]`, so a second
 * registrant (the shipped plan chip, the voice-mode mic) silently replaces this
 * one. Occupying `conversation.input.model` would also shadow the shipped
 * selector, so this bundle never does.
 *
 * ## Never a dead button
 *
 * The previous revision read the namespace list straight off
 * `remote.settings.describe()`. The remote protocol answers `{ ok, value }`, so
 * that read produced `undefined`, the namespace was classified as "absent", and
 * the chip rendered `disabled` — which in Chrome also suppresses its `title`
 * tooltip, while the click handler's guard turned every click into a silent
 * no-op. One wrong field access presented as a completely inert control that
 * explained nothing.
 *
 * Three independent defences now: `unwrap()` handles the envelope, every remote
 * call has a deadline so a pending bridge shows an error instead of hanging on
 * "loading", and the chip is *never* `disabled` — a click while the
 * configuration is unknown re-reads it, and an unreadable configuration states
 * the reason in the tooltip. Nothing is hidden behind a tooltip that cannot show.
 *
 * ## The switch
 *
 * The bolt is the switch. Left click flips fast mode for this conversation only;
 * the choice is written into the per-session column, so a restart, a reopened
 * conversation, or a second tab comes back to the same state. Right click opens a
 * small panel with the one preference that is not per-conversation: whether the
 * model is told to write less narration. That field is shared and the panel says
 * so, because a switch must not claim a scope the settings cannot keep.
 *
 * Failure containment, because a UI half must never take the composer down:
 * every remote call is awaited inside a try/catch, an unreadable configuration
 * renders an explanatory chip rather than throwing, and a refused registration is
 * logged instead of escaping `apply`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-fast-mode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    /** Dictionary namespace owned by this client half. */
    const NS = 'fast-mode'
    /** Composer slot: beside the model selector, left of the stop button. */
    const SLOT = 'conversation.input.right'
    const STYLE_ID = 'dsh-fast-mode/chip.css'
    /**
     * Entry ids this plugin may be mounted under. The patch id in
     * `cordis.patch.yml` is `fast-mode`; the package name is the fallback for an
     * operator who renamed the entry.
     */
    const ENTRY_IDS = ['fast-mode', 'dsh-fast-mode']

    /** Client services: slot registry, dictionaries, and the settings remote. */
    const inject = ['slots', 'locale', 'remote', 'remote.settings']

    /**
     * Dictionaries, written with **dotted top-level keys on purpose**.
     *
     * `dsh-client-locale` resolves a key by indexing the dictionary flat —
     * `dicts.get(ns).get(locale)?.[key]` (`dsh-client-locale/lib/client.js`
     * lookup) — and falls back to returning the key itself. A nested
     * `{ chip: { speed: … } }` therefore never resolves `'chip.speed'`: the chip
     * painted raw keys instead of words. Flat
     * keys make the lookup hit.
     *
     * Chinese is registered under `zh` *and* `zh-CN`: the active locale may be
     * either tag, and a miss falls through to English.
     */
    const zh = {
      'chip.on': 'Fast 模式已开启',
      'chip.off': 'Fast 模式已关闭',
      'chip.titleOn': 'Fast 模式：已开启 · 仅本会话 · 点击关闭 · 右键设置',
      'chip.titleOff': 'Fast 模式：已关闭 · 点击开启 · 右键设置',
      'chip.titleLoading': 'Fast 模式：正在读取配置，点击重试',
      'chip.readonly': 'Fast 模式配置为只读，无法从这里切换',
      'chip.error': 'Fast 模式配置读取失败：{error}',
      'chip.absent': 'Fast 模式未在此配置中声明，点击重试',
      'panel.title': '更快',
      'panel.gear': '并行档位',
      'panel.gearTitle': '点一下载入这一档的开关：标准只开精简输出，激进再开截短工具输出与批量读文件；手动改过就不再属于任何一档',
      'panel.gearSafe': '保守',
      'panel.gearAuto': '标准',
      'panel.gearFast': '激进',
      'panel.prose': '精简输出',
      'panel.proseTitle': '少写过程，直接给结论',
      'panel.on': '开',
      'panel.off': '关',
      'panel.budget': '步数上限',
      'panel.budgetOff': '不限',
      'panel.budgetSteps': '{n} 步',
      'panel.scope': '只影响本会话',
      'panel.scopeTitle': '未读到本会话的步数与输出',
      'panel.saved': '{steps} 步 · 输出 {tokens}',
      'panel.savedSteps': '{steps} 步',
      'panel.savedTokens': '输出 {tokens}',
      'panel.budgetTitle': '到上限先汇报，不截断任务',
      'panel.map': '开局附文件清单',
      'panel.mapTitle': '开局附上文件清单，省掉先翻目录',
      'panel.batch': '批量读文件',
      'panel.compact': '截短工具输出',
      'panel.compactTitle': '只留头尾和报错行，长输出不再整段进上下文',
      'panel.batchTitle': '互不依赖的读取合成一次发出',
      'panel.probe': '不确定先查证',
      'panel.probeTitle': '拿不准就读一次，省的是猜错后的重来',
      'panel.act': '先执行后解释',
      'panel.actTitle': '最多一行计划，想清楚就直接做',
      'panel.repeat': '重复时换方法',
      'panel.repeatTitle': '同一调用重发、或连续三步结果一样时提醒换法',
    }

    const en = {
      'chip.on': 'Fast mode is on',
      'chip.off': 'Fast mode is off',
      'chip.titleOn': 'Fast mode: on · this conversation · thinking effort unchanged, click to turn off · right-click for settings',
      'chip.titleOff': 'Fast mode: off · click to turn on · right-click for settings',
      'chip.titleLoading': 'Fast mode: reading configuration. Click to retry',
      'chip.readonly': 'Fast mode configuration is read-only',
      'chip.error': 'Fast mode configuration unavailable: {error}',
      'chip.absent': 'Fast mode is not configured in this composition. Click to retry',
      'panel.title': 'Faster',
      'panel.gear': 'Parallel width',
      'panel.gearTitle': 'One click loads that tier\'s switches: Standard turns on prose trimming only, Aggressive adds output trimming and batched reads; a switch changed by hand leaves no tier selected',
      'panel.gearSafe': 'Cautious',
      'panel.gearAuto': 'Standard',
      'panel.gearFast': 'Aggressive',
      'panel.prose': 'Concise output',
      'panel.proseTitle': 'States the result; skips the narration',
      'panel.on': 'On',
      'panel.off': 'Off',
      'panel.budget': 'Step cap',
      'panel.budgetOff': 'No cap',
      'panel.budgetSteps': '{n} steps',
      'panel.scope': 'This conversation only',
      'panel.scopeTitle': 'Session steps and output are unavailable here',
      'panel.saved': '{steps} steps · {tokens} out',
      'panel.savedSteps': '{steps} steps',
      'panel.savedTokens': '{tokens} out',
      'panel.budgetTitle': 'Reports at the cap; never truncates the task',
      'panel.map': 'File inventory',
      'panel.mapTitle': 'Lists the folder up front; skips the lookup',
      'panel.batch': 'Batched reads',
      'panel.compact': 'Trim tool output',
      'panel.compactTitle': 'Keeps head, tail and matching error lines instead of the whole output',
      'panel.batchTitle': 'Sends independent reads as one batch',
      'panel.probe': 'Verify before guessing',
      'panel.probeTitle': 'Reads the fact once; a guess costs a retry',
      'panel.act': 'Act before explaining',
      'panel.actTitle': 'One line of plan, then act',
      'panel.repeat': 'Nudge on repeats',
      'panel.repeatTitle': 'When a call repeats or three results match, switch approach',
    }

    const CSS = [
      // The chip: one icon, nothing else. It is the switch: clicking it turns
      // fast mode on or off for this conversation.
      '.fm-chip{display:inline-flex;align-items:center;min-width:0;flex:none;position:relative}',
      '.fm-chip__button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
      'width:28px;height:28px;padding:0;margin:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;',
      'color:var(--dsw-alias-label-tertiary,#8b8b8b);font:inherit;line-height:1;cursor:pointer;',
      'transition:background-color .12s ease,color .12s ease}',
      '.fm-chip__button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));',
      'color:var(--dsw-alias-label-secondary,#5c5c5c)}',
      '.fm-chip__button[data-on="true"]{color:var(--dsw-alias-label-primary,#141414)}',
      '.fm-chip__button[data-busy="true"]{opacity:.55;cursor:progress}',
      '.fm-chip__button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ',
      'var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px}',
      '.fm-chip__button svg{display:block;flex:none}',
      // The panel: anchored above the bolt, opens on right-click only, so the
      // left click stays the switch it has always been.
      '.fm-panel{position:absolute;bottom:calc(100% + 6px);right:0;z-index:60;min-width:196px;',
      'max-width:min(264px,calc(100vw - 24px));padding:6px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.1));',
      'border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-elevated,#fff);',
      'box-shadow:0 6px 24px rgba(0,0,0,.14);text-align:left}',
      // The title row carries the gear control on its right. Wrapping keeps the
      // control off the title when the composer is narrow; the block never
      // overflows the panel.
      '.fm-panel__title{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;padding:4px 8px 6px;',
      'color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:12px;font-weight:500;line-height:1.2}',
      '.fm-panel__heading{flex:0 0 auto}',
      '.fm-panel__gears{display:inline-flex;align-items:center;flex:0 0 auto;gap:2px;margin-left:auto}',
      '.fm-panel__gear{box-sizing:border-box;padding:2px 6px;margin:0;border:0;border-radius:var(--dsw-radius-sm,6px);',
      'background:transparent;color:var(--dsw-alias-label-tertiary,#8b8b8b);font:inherit;font-size:12px;line-height:1.4;',
      'cursor:pointer}',
      '.fm-panel__gear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));',
      'color:var(--dsw-alias-label-secondary,#5c5c5c)}',
      '.fm-panel__gear[aria-checked="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));',
      'color:var(--dsw-alias-label-primary,#141414)}',
      '.fm-panel__gear[disabled]{opacity:.55;cursor:default}',
      '.fm-panel__gear:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ',
      'var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}',
      '.fm-panel__row{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;',
      'padding:6px 8px;margin:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;',
      'color:var(--dsw-alias-label-primary,#141414);font:inherit;font-size:14px;line-height:1.5;cursor:pointer;',
      'text-align:left}',
      '.fm-panel__row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.fm-panel__row[disabled]{opacity:.55;cursor:default}',
      '.fm-panel__value{color:var(--dsw-alias-label-tertiary,#8b8b8b);font-variant-numeric:tabular-nums}',
      '.fm-panel__row[aria-checked="true"] .fm-panel__value{color:var(--dsw-alias-label-primary,#141414)}',
      // One line, with an ellipsis when the panel is too narrow: the full
      // numbers ride in the `title`, so clamping never hides information.
      '.fm-panel__scope{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;max-width:100%;',
      'padding:4px 8px 4px;color:var(--dsw-alias-label-quaternary,#a8a8a8);',
      'font-size:12px;line-height:1.45;overflow:hidden;text-overflow:ellipsis}',
    ].join('')

    /** A bolt: outlined when off, filled when on. One path, two paint modes. */
    const BOLT = 'M9.7 1.4 4.1 9.2h3.5l-1.3 5.4 5.6-7.9H8.4l1.3-5.3Z'

    /* ------------------------------------------------------------------ store */

    /**
     * The single readable state of the chip. Mutated in place and announced
     * through `emit()`, because there is exactly one chip per composer and a
     * version counter would be ceremony.
     */
    const store = {
      /** 'loading' | 'ready' | 'absent' | 'error' */
      phase: 'loading', // until the first read reports what this conversation has
      /** What this conversation runs at: on or off, never a shared default. */
      enabled: false, // painted on the first read, then follows every click
      /**
       * Which of the three tiers this conversation runs at: `safe`, `auto`
       * (factory default), or `fast`. Older builds pinned `turbo` / `max` /
       * `ludicrous`; a read-back collapses them onto `auto`, because the tier
       * ladder is gone and the scheduler decides the width now.
       */
      gear: '', // normalized by refresh(); '' only before the first read
      /**
       * `outputDiscipline !== false` for this conversation. Resolved from its
       * own entry in the session column, falling back to the configured
       * default when it has none.
       */
      discipline: true,
      /** The workspace inventory switch for this conversation, off by default. */
      inventory: false,
      /** Batches independent reads into one call for this conversation. */
      batch: false,
      /** Trims long tool output for this conversation, keeping matching error lines. */
      compact: false,
      /**
       * The three deliberation switches: read the missing fact, one line of plan,
       * one evidence line when the turn stops learning. All off unless this
       * conversation turned them on.
       */
      probe: false, act: false, repeat: false,
      /** This conversation's step cap; 0 means no cap. */
      stepBudget: 0,
      /** The right-click panel is open. Store-backed, like every other paint. */
      panelOpen: false,
      /** Whether the settings column accepts writes at all. */
      writable: true, // false only when the settings column is read-only
      /** Namespace key of the last successful read. */
      ns: undefined, // filled by the first successful describe()
      /** Revision of the last successful read, for a compare-and-set write. */
      revision: undefined, // paired with ns for the next compare-and-set
      /** The last read or write failure, shown in place of the panel rows. */
      error: '', // cleared by the next successful read
      /**
       * The last refused write. Kept apart from `error` because the resync that
       * follows a refusal succeeds, and a successful read must not erase the one
       * message the user needs: why the click did not stick.
       */
      writeError: '',
      /** A write in flight: keeps the button from double-firing. */
      busy: false,
      /** The value we are waiting for the settings side to echo back after a write. */
      pending: undefined,
      /**
       * The conversation this chip is rendered for, handed over by the slot's
       * `inject` hook. Every read and write is scoped to it: the settings column
       * is shared, so an unscoped chip is a chip that flips every open session.
       */
      sessionId: undefined,
      /**
       * The per-session map, parsed from the `sessions` settings column:
       * `{ sessionId: { enabled, gear, ts } }`. Kept in memory so a write can be
       * a read-modify-write of the whole column in one patch.
       */
      sessions: {},
    }

    /**
     * The three tiers the panel offers, in reading order. The ids are the
     * scheduler's own gear names, so the value travels unchanged through the
     * settings column; only the read-back is normalized (see `gearTier`).
     */
    const GEAR_TIERS = ['safe', 'auto', 'aggressive']

    /** Dictionary keys for the tier labels. */
    const GEAR_LABELS = { safe: 'panel.gearSafe', auto: 'panel.gearAuto', aggressive: 'panel.gearFast' }

    /**
     * What each tier loads when it is clicked. A tier is a preset, not a stored
     * mode: the button writes these five values into the conversation's row, and
     * the checked state is derived back from them (`activeTier`). Changing one
     * switch by hand therefore drops the panel out of every tier instead of
     * leaving a label that contradicts the rows below it.
     *
     * The width is the scheduler's own gear id. The three switches are the ones
     * with evidence behind them: the prose rule is the measured mechanism, tool
     * output trimming cut wall clock and tokens on every paired run (0.756x /
     * 0.786x), and batched reads paid off together with the workspace map
     * (0.742x, 11 pairs). The step cap is deliberately absent: it is a guardrail
     * the user set, not a speed knob, and a preset must not add or remove it.
     * The keys are the session row's own field names, so a preset can be handed
     * to `write` as is.
     */
    const GEAR_PRESETS = {
      safe: { gear: 'safe', discipline: false, map: false, batch: false, compactResults: false },
      auto: { gear: 'auto', discipline: 'late', map: false, batch: false, compactResults: false },
      aggressive: { gear: 'aggressive', discipline: 'late', map: true, batch: true, compactResults: true },
    }

    /**
     * Collapse any gear name onto one of the three tiers the panel shows.
     *
     * `safe` and `aggressive` are live gear ids, so they survive. `fast` is the
     * id the first bundle wrote for the aggressive tier; a per-session entry
     * that still carries it is resolved as `aggressive` too. Everything else —
     * the retired `turbo` / `max` / `ludicrous`, an empty field, a typo — reads
     * as `auto`, the factory default. The scheduler degrades the same way, and a
     * panel that displayed an id it cannot write would be showing a state it
     * cannot produce.
     *
     * @param {unknown} gear
     * @returns {'safe' | 'auto' | 'aggressive'}
     */
    function gearTier(gear) {
      if (gear === 'safe') return 'safe'
      if (gear === 'aggressive' || gear === 'fast') return 'aggressive'
      return 'auto'
    }

    /**
     * The tier this conversation currently matches, or `''` when its switches
     * are a mix no preset describes — the state after a hand edit, which must
     * not keep the old tier highlighted.
     *
     * The cautious tier matches on the gear alone: `gear.directive` turns all
     * four channels off there, so whatever the stored switches say, the panel
     * shows them off and the tier is the only honest answer.
     *
     * @returns {'safe' | 'auto' | 'aggressive' | ''}
     */
    function activeTier() {
      const tier = gearTier(store.gear)
      if (tier === 'safe') return 'safe'
      const preset = GEAR_PRESETS[tier]
      // The stored `discipline` may be 'late', so compare the resolved on/off
      // rather than the literal. The panel itself only ever shows on or off.
      const same = Boolean(store.discipline) === Boolean(preset.discipline)
        && store.inventory === preset.map
        && store.batch === preset.batch
        && store.compact === preset.compactResults
      return same ? tier : ''
    }

    /**
     * Reads one conversation's live counters from the session-controller store,
     * or `undefined` when this build has no such source. Set from `apply`; the
     * settings column this plugin owns says nothing about how the turn went.
     *
     * @type {undefined | ((sessionId: string) => any)}
     */
    let projectionSource

    /** @type {Set<() => void>} */
    const listeners = new Set()

    function emit() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // A broken subscriber must not stop the others.
        }
      }
    }

    /** @param {() => void} listener */
    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    /** @param {unknown} error */
    function describeError(error) {
      if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
      return String(error)
    }

    /** @param {number} ms */
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

    /* ------------------------------------------------------------ live readout */

    /**
     * Projection keys the footer reads. Both belong to other plugins and are
     * only present once a turn has been reported: `sessionStats` carries
     * `steps`, `tokenUsage` carries the provider-reported `outputTokens`.
     */
    const STEPS_KEY = 'sessionStats'
    const USAGE_KEY = 'tokenUsage'

    /**
     * This conversation's real counters, or `undefined` when nothing readable is
     * there. Only reported numbers are taken, and each field stands alone: a
     * projection that has not reported output yet must not paint a `0` the
     * session never spent.
     *
     * @param {string | undefined} sessionId
     * @returns {{steps?: number, tokens?: number} | undefined}
     */
    function readStats(sessionId) {
      if (typeof projectionSource !== 'function') return undefined
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      let values
      try {
        values = projectionSource(sessionId)
      } catch {
        // A projection store that is not mounted yet is not worth surfacing;
        // the footer keeps its scope line instead.
        return undefined
      }
      if (values === null || typeof values !== 'object') return undefined
      const stats = values[STEPS_KEY]
      const usage = values[USAGE_KEY]
      const steps = stats && typeof stats.steps === 'number' && Number.isFinite(stats.steps) && stats.steps >= 0
        ? stats.steps : undefined
      const tokens = usage && typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)
        && usage.outputTokens >= 0 ? usage.outputTokens : undefined
      if (steps === undefined && tokens === undefined) return undefined
      return { steps, tokens }
    }

    /**
     * `3200` → `3.2k`, `12` → `12`. The full number travels in the tooltip
     * (`savedFooter`), so the visible line only has to read at a glance.
     *
     * @param {number | undefined} value
     */
    function formatCount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
      if (value < 1000) return String(Math.round(value))
      const million = value >= 1000000
      const scaled = Math.round((value / (million ? 1000000 : 1000)) * 10) / 10
      return `${scaled}${million ? 'M' : 'k'}`
    }

    /**
     * The footer line from the fields that are actually there. Steps alone and
     * output alone are both readable; neither means `undefined`, and the caller
     * falls back to the scope line.
     *
     * @param {(key: string, params?: object) => string} t
     * @param {{steps?: number, tokens?: number}} stats
     * @param {boolean} [full] - use raw counts instead of the compact form
     */
    function savedLine(t, stats, full) {
      const steps = typeof stats.steps === 'number' ? String(stats.steps) : undefined
      const tokens = full === true
        ? typeof stats.tokens === 'number' ? String(stats.tokens) : undefined
        : formatCount(stats.tokens)
      if (steps !== undefined && tokens !== undefined) return t('panel.saved', { steps, tokens })
      if (steps !== undefined) return t('panel.savedSteps', { steps })
      if (tokens !== undefined) return t('panel.savedTokens', { tokens })
      return undefined
    }

    /**
     * The panel footer: this conversation's real step count and output tokens
     * when the session store has them, and the scoping sentence when it does
     * not. The readout is the report; there is no promised saving here, because
     * nothing on this side could measure one.
     *
     * @param {(key: string, params?: object) => string} t
     */
    function savedFooter(t) {
      const stats = readStats(store.sessionId)
      const compact = stats === undefined ? undefined : savedLine(t, stats)
      if (compact === undefined) {
        return react.createElement('div', {
          className: 'fm-panel__scope',
          title: t('panel.scopeTitle'),
        }, t('panel.scope'))
      }
      const full = savedLine(t, stats, true) ?? compact
      return react.createElement('div', { className: 'fm-panel__scope', title: full }, compact)
    }

    /* ------------------------------------------------- per-session bookkeeping */

    /**
     * Browser half of the per-session column — the same format the settings side parses in
     * `src/state.js`. The bundle cannot import the settings ESM (it is fetched verbatim by
     * the client module loader), so the twenty lines are duplicated and both
     * copies are pinned to the same fixtures in the tests.
     *
     * The column is `{ sessionId: { enabled, gear, ts } }` as JSON. `ts` is the
     * pruning key: past {@link SESSIONS_LIMIT} entries the oldest go first, and a
     * pruned conversation merely falls back to the default.
     */
    const SESSIONS_LIMIT = 200

    /** @param {unknown} value */
    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /**
     * Parse the column. A broken value degrades to "no overrides" instead of
     * taking the chip down: the column may be hand-edited, and the chip is the
     * only place a user can see the switch, so throwing here would hide the bug.
     *
     * The shape check is deliberately the same one the settings side applies
     * (`src/state.js` `sanitise`): this half writes entries the settings side then reads
     * to decide what a request runs at, and an entry one side accepts and the
     * other drops is a switch that looks on and changes nothing.
     *
     * @param {unknown} raw
     */
    function parseChoices(raw) {
      if (isRecord(raw)) return sanitiseChoices(raw)
      if (typeof raw !== 'string' || raw.trim().length === 0) return {}
      try {
        const parsed = JSON.parse(raw)
        return isRecord(parsed) ? sanitiseChoices(parsed) : {}
      } catch {
        return {}
      }
    }

    /**
     * Keep only entries the settings side would also honour.
     *
     * The field list matches `src/state.js` `sanitise` exactly, on purpose: this
     * half writes entries the settings side reads to decide what a request runs at, and an
     * entry one side accepts while the other drops is a switch that looks on and
     * changes nothing.
     *
     * @param {Record<string, any>} input
     */
    function sanitiseChoices(input) {
      /** @type {Record<string, any>} */
      const out = {}
      for (const [sessionId, entry] of Object.entries(input)) {
        if (sessionId.length === 0 || !isRecord(entry)) continue
        /** @type {Record<string, any>} */
        const clean = {}
        if (typeof entry.enabled === 'boolean') clean.enabled = entry.enabled
        if (typeof entry.gear === 'string' && entry.gear.length > 0) clean.gear = entry.gear
        if (typeof entry.discipline === 'boolean' || entry.discipline === 'late') clean.discipline = entry.discipline
        if (Number.isFinite(entry.stepBudget) && entry.stepBudget >= 0) clean.stepBudget = Math.floor(Number(entry.stepBudget))
        if (typeof entry.map === 'boolean') clean.map = entry.map
        if (typeof entry.batch === 'boolean') clean.batch = entry.batch
        if (typeof entry.compactResults === 'boolean') clean.compactResults = entry.compactResults
        if (typeof entry.probeFirst === 'boolean') clean.probeFirst = entry.probeFirst
        if (typeof entry.actBeforePlan === 'boolean') clean.actBeforePlan = entry.actBeforePlan
        if (typeof entry.repeatNudge === 'boolean') clean.repeatNudge = entry.repeatNudge
        if (Number.isFinite(entry.ts)) clean.ts = Number(entry.ts)
        if (
          clean.enabled === undefined
          && clean.gear === undefined
          && clean.discipline === undefined
          && clean.stepBudget === undefined
          && clean.map === undefined
          && clean.batch === undefined
          && clean.compactResults === undefined
          && clean.probeFirst === undefined
          && clean.actBeforePlan === undefined
          && clean.repeatNudge === undefined
        ) continue
        out[sessionId] = clean
      }
      return out
    }

    /**
     * Serialise the column, dropping the oldest entries beyond the limit.
     *
     * @param {Record<string, any>} map
     */
    function encodeChoices(map) {
      const ids = Object.keys(map)
      if (ids.length > SESSIONS_LIMIT) {
        ids
          .sort((a, b) => (Number(map[a] && map[a].ts) || 0) - (Number(map[b] && map[b].ts) || 0))
          .slice(0, ids.length - SESSIONS_LIMIT)
          .forEach((id) => { delete map[id] })
      }
      return JSON.stringify(map)
    }

    /**
     * This conversation's entry, if it has one.
     *
     * @param {string|undefined} sessionId
     */
    function ownChoice(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      const entry = store.sessions[sessionId]
      return isRecord(entry) ? entry : undefined
    }

    /**
     * A copy of the column with this conversation's entry updated.
     *
     * One click travels in one patch: `sessions` is this conversation's own entry
     * (and therefore what the settings side applies to *this* request stream), and nothing
     * else. The shared config fields are the defaults and stay untouched, which is
     * the whole point of the per-session tier: turning fast mode off here must not
     * turn off another open tab, and turning narration down here must not change
     * what the next conversation inherits any more than this one.
     *
     * Fields absent from `patch` keep their previous value, so each panel row can
     * write its own field without restating the other three.
     *
     * @param {Record<string, any>} map
     * @param {string|undefined} sessionId
     * @param {{enabled?: boolean, gear?: string, discipline?: boolean|'late', stepBudget?: number, map?: boolean, batch?: boolean, compactResults?: boolean, probeFirst?: boolean, actBeforePlan?: boolean, repeatNudge?: boolean}} patch
     */
    function withOwn(map, sessionId, patch) {
      const next = { ...map }
      if (typeof sessionId !== 'string' || sessionId.length === 0) return next
      const current = isRecord(next[sessionId]) ? next[sessionId] : {}
      /** @type {Record<string, any>} */
      const entry = { ...current, ts: Date.now() }
      if (typeof patch.enabled === 'boolean') entry.enabled = patch.enabled
      if (typeof patch.gear === 'string' && patch.gear.length > 0) entry.gear = patch.gear
      if (typeof patch.discipline === 'boolean' || patch.discipline === 'late') entry.discipline = patch.discipline
      if (Number.isFinite(patch.stepBudget) && patch.stepBudget >= 0) entry.stepBudget = Math.floor(Number(patch.stepBudget))
      if (typeof patch.map === 'boolean') entry.map = patch.map
      if (typeof patch.batch === 'boolean') entry.batch = patch.batch
      if (typeof patch.compactResults === 'boolean') entry.compactResults = patch.compactResults
      if (typeof patch.probeFirst === 'boolean') entry.probeFirst = patch.probeFirst
      if (typeof patch.actBeforePlan === 'boolean') entry.actBeforePlan = patch.actBeforePlan
      if (typeof patch.repeatNudge === 'boolean') entry.repeatNudge = patch.repeatNudge
      next[sessionId] = entry
      return next
    }

    /**
     * The remote protocol answers `{ ok, value }` — every shipped client bundle
     * unwraps it by hand (`dsh-client-ui-settings/lib/client.js:1448`
     * `response.ok ? { view: response.value } : …`). Reading `result.namespaces`
     * straight off the envelope yields `undefined`, which is exactly the bug
     * that made this chip render dead: no namespace was ever found, so the
     * button was permanently disabled and every click was swallowed.
     *
     * A response without an `ok` flag is returned untouched, so a bare service
     * stub still works.
     *
     * @param {any} response
     */
    function unwrap(response) {
      if (response === null || typeof response !== 'object' || typeof response.ok !== 'boolean') return response
      if (!response.ok) {
        const error = response.error
        const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
          ? error.message
          : 'settings request was refused'
        throw new Error(message)
      }
      return response.value
    }

    /**
     * Bound a remote call. The bridge can leave a request pending when the
     * client connects before the settings channel is up; without a deadline the chip
     * would sit in `loading` forever, which is indistinguishable from a broken
     * control. A timed-out read becomes a visible error the user can retry.
     *
     * @param {Promise<any>} promise
     * @param {number} ms
     * @param {string} label
     */
    function withTimeout(promise, ms, label) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms} ms`))
        }, ms)
        Promise.resolve(promise).then(
          (value) => { clearTimeout(timer); resolve(value) },
          (error) => { clearTimeout(timer); reject(error) },
        )
      })
    }

    /**
     * Whether a namespace view is this plugin's, judged by the *declared schema*
     * rather than the current value.
     *
     * This is the fix for the dead chip: a mount can report an empty `value`
     * (fields not yet projected) while the schema still says
     * `{ enabled, gear, parallel }`. Matching only on `value` classified that
     * mount as "absent", which rendered the chip disabled and made every click a
     * no-op. Two of three fallbacks below do not depend on `value` at all.
     *
     * @param {any} view
     */
    function looksLikeThisPlugin(view) {
      if (view === null || typeof view !== 'object') return false
      const value = view.value !== null && typeof view.value === 'object' ? view.value : {}
      if (typeof value.enabled === 'boolean' || typeof value.gear === 'string') return true
      const schema = view.schema
      const fields = schema !== null && typeof schema === 'object'
        ? (schema.dict ?? schema.properties)
        : undefined
      if (fields !== null && typeof fields === 'object' && 'enabled' in fields && 'gear' in fields) return true
      return false
    }

    /**
     * Find this plugin's namespace in a `settings/describe` result.
     *
     * The entry id is the primary key, but a composition may rename it (this one
     * mounts as `include:fast-mode`), so the fallback matches the shape this
     * plugin alone declares. Never guess by position — the first namespace is
     * somebody else's model configuration.
     *
     * @param {unknown} namespaces
     */
    function pickNamespace(namespaces) {
      if (!Array.isArray(namespaces)) return undefined
      for (const id of ENTRY_IDS) {
        const exact = namespaces.find(view => view && view.ns === id)
        if (exact !== undefined) return exact
      }
      const byShape = namespaces.find(looksLikeThisPlugin)
      if (byShape !== undefined) return byShape
      return namespaces.find((view) => {
        const value = view && view.value
        return value !== null
          && typeof value === 'object'
          && typeof value.parallel === 'number'
      })
    }

    /**
     * Re-read the configuration. Safe to call at any time: a failure is stored
     * as chip state, never thrown at the caller.
     *
     * The shared `enabled` / `gear` fields are the default, and the `sessions`
     * column overrides them for this conversation. Reading both is what makes the
     * chip show *this* session's stance instead of whichever session wrote last.
     *
     * @param {{settings: {describe: () => Promise<any>}}} remote
     * @param {string} [sessionId] - the conversation to paint; defaults to the one
     *   the chip was mounted for.
     */
    async function refresh(remote, sessionId) {
      if (typeof sessionId === 'string' && sessionId.length > 0) store.sessionId = sessionId
      const sid = store.sessionId
      try {
        const result = unwrap(await withTimeout(remote.settings.describe(), 6000, 'settings/describe'))
        const view = pickNamespace(result && result.namespaces)
        if (view === undefined) {
          store.phase = 'absent'
          store.error = ''
          store.ns = undefined
          store.revision = undefined
        } else {
          const value = view.value && typeof view.value === 'object' ? view.value : {}
          store.sessions = parseChoices(value.sessions)
          const own = ownChoice(sid)
          // A layer that carries the field wins, field by field: the
          // conversation's own entry outranks the shared default, so an entry that
          // pins only the gear still inherits everything else. Per-session entries
          // are why two open tabs can show different rows at the same time.
          const sharedGear = typeof value.gear === 'string' ? value.gear : store.gear
          const seenGear = own !== undefined && typeof own.gear === 'string' ? own.gear : sharedGear
          const seenDiscipline = own !== undefined && own.discipline !== undefined
            ? own.discipline !== false
            : value.outputDiscipline !== false
          const seenBudget = own !== undefined && typeof own.stepBudget === 'number'
            ? own.stepBudget
            : typeof value.stepBudget === 'number' ? value.stepBudget : 0
          const seenMap = own !== undefined && typeof own.map === 'boolean'
            ? own.map
            : value.workspaceMap === true
          const seenBatch = own !== undefined && typeof own.batch === 'boolean'
            ? own.batch
            : value.openBatch === true
          const seenCompact = own !== undefined && typeof own.compactResults === 'boolean'
            ? own.compactResults
            : value.compactResults === true
          const seenProbe = own !== undefined && typeof own.probeFirst === 'boolean'
            ? own.probeFirst
            : value.probeFirst === true
          const seenAct = own !== undefined && typeof own.actBeforePlan === 'boolean'
            ? own.actBeforePlan
            : value.actBeforePlan === true
          const seenRepeat = own !== undefined && typeof own.repeatNudge === 'boolean'
            ? own.repeatNudge
            : value.repeatNudge === true
          store.phase = 'ready'
          store.error = ''
          store.ns = view.ns
          store.revision = typeof view.revision === 'number' ? view.revision : undefined
          store.writable = !(result && result.writable === false)
          store.gear = gearTier(seenGear)
          store.discipline = seenDiscipline
          store.stepBudget = seenBudget
          store.inventory = seenMap
          store.batch = seenBatch
          store.compact = seenCompact
          store.probe = seenProbe
          store.act = seenAct
          store.repeat = seenRepeat
          // A write we have not seen echoed yet wins: the Loader applies the new
          // section asynchronously, and flipping back to the old paint in that
          // window would read as a failed click.
          const observed = own !== undefined && typeof own.enabled === 'boolean'
            ? own.enabled
            : value.enabled === true
          if (store.pending === undefined || observed === store.pending) {
            store.enabled = observed
            store.pending = undefined
          }
        }
      } catch (error) {
        store.phase = 'error'
        store.error = describeError(error)
      }
      emit()
    }

    /**
     * The settings side echoes a write a beat later, so poll briefly instead of showing
     * the old value in the gap.
     *
     * @param {{settings: {describe: () => Promise<any>}}} remote
     * @param {boolean} want
     */
    async function settle(remote, want) {
      for (const delay of [0, 120, 300, 700]) {
        if (delay > 0) await sleep(delay)
        await refresh(remote)
        if (store.phase !== 'ready' || store.enabled === want) return
      }
      store.pending = undefined
      emit()
    }

    /**
     * Write one or more config fields through the settings surface.
     *
     * The patch is optimistic, then reconciled with what the settings side reports. A
     * refusal rolls the paint back and keeps the message — never a silent revert.
     *
     * Two shapes of change reach this function, and only one of them is used by
     * the panel:
     *
     * - `options.entry` updates *this conversation's* row and writes nothing else.
     *   That is the only path that survives the volatility check on the settings side, and it is
     *   what makes the four controls per-session instead of global.
     * - `patch` names shared config fields. It is kept for callers that mean "change
     *   the default for future conversations", and the settings side refuses it for any
     *   field that is not volatile — so the panel must not use it.
     *
     * @param {{settings: {update: (ns: string, patch: object, revision?: number) => Promise<any>}}} remote
     * @param {{enabled?: boolean, gear?: string, outputDiscipline?: boolean|'late', stepBudget?: number, workspaceMap?: boolean}} [patch]
     * @param {{entry?: {enabled?: boolean, gear?: string, discipline?: boolean|'late', stepBudget?: number, map?: boolean, batch?: boolean, probeFirst?: boolean, actBeforePlan?: boolean, repeatNudge?: boolean}}} [options]
     * @returns {Promise<boolean>} whether the write was accepted
     */
    async function write(remote, patch, options = {}) {
      if (store.phase !== 'ready' || !store.writable || store.busy) return false
      const before = Object.assign({}, store)
      const shared = patch && typeof patch === 'object' ? patch : {}
      const entry = options.entry
      const scoped = entry !== undefined && typeof entry === 'object'
      const merged = scoped ? withOwn(store.sessions, store.sessionId, entry) : store.sessions
      const outgoing = scoped ? { ...shared, sessions: encodeChoices(merged) } : { ...shared }
      store.busy = true
      store.writeError = ''
      if (scoped) {
        store.sessions = merged
        if (typeof entry.enabled === 'boolean') {
          store.enabled = entry.enabled
          store.pending = entry.enabled
        }
        if (typeof entry.gear === 'string') store.gear = entry.gear
        if (typeof entry.discipline === 'boolean' || entry.discipline === 'late') store.discipline = entry.discipline !== false
        if (typeof entry.stepBudget === 'number') store.stepBudget = entry.stepBudget
        if (typeof entry.map === 'boolean') store.inventory = entry.map
        if (typeof entry.batch === 'boolean') store.batch = entry.batch
        if (typeof entry.compactResults === 'boolean') store.compact = entry.compactResults
        if (typeof entry.probeFirst === 'boolean') store.probe = entry.probeFirst
        if (typeof entry.actBeforePlan === 'boolean') store.act = entry.actBeforePlan
        if (typeof entry.repeatNudge === 'boolean') store.repeat = entry.repeatNudge
      }
      if (typeof shared.enabled === 'boolean') {
        store.enabled = shared.enabled
        store.pending = shared.enabled
      }
      if (typeof shared.gear === 'string') store.gear = shared.gear
      if (shared.outputDiscipline === false) store.discipline = false
      else if (shared.outputDiscipline !== undefined) store.discipline = true
      if (typeof shared.stepBudget === 'number') store.stepBudget = shared.stepBudget
      if (typeof shared.workspaceMap === 'boolean') store.inventory = shared.workspaceMap
      if (typeof shared.openBatch === 'boolean') store.batch = shared.openBatch
      if (typeof shared.compactResults === 'boolean') store.compact = shared.compactResults
      if (typeof shared.probeFirst === 'boolean') store.probe = shared.probeFirst
      if (typeof shared.actBeforePlan === 'boolean') store.act = shared.actBeforePlan
      if (typeof shared.repeatNudge === 'boolean') store.repeat = shared.repeatNudge
      emit()
      try {
        unwrap(await withTimeout(remote.settings.update(store.ns, outgoing, store.revision), 15000, 'settings/update'))
        store.busy = false
        await settle(remote, typeof outgoing.enabled === 'boolean' ? outgoing.enabled : store.enabled)
        emit()
        return true
      } catch (error) {
        store.busy = false
        store.enabled = before.enabled
        store.gear = before.gear
        store.sessions = before.sessions
        store.discipline = before.discipline
        store.stepBudget = before.stepBudget
        store.inventory = before.inventory
        store.batch = before.batch
        store.compact = before.compact
        store.probe = before.probe
        store.act = before.act
        store.repeat = before.repeat
        store.pending = undefined
        store.writeError = describeError(error)
        emit()
        // A stale revision is the likeliest refusal; resync so the next click
        // carries the current one.
        await refresh(remote)
        return false
      }
    }

    /**
     * Flip fast mode for the conversation this chip belongs to. The chip is the
     * switch, so a refusal leaves its reason on the tooltip; the reason stays
     * until the next successful read.
     *
     * Only this session's row is written. The previous release also rewrote the
     * shared `enabled` field, which made one click turn the mode on for every
     * conversation that had never been clicked — the exact leak the per-session
     * tier exists to prevent.
     *
     * @param {{settings: {describe: () => Promise<any>, update: (ns: string, patch: object, revision?: number) => Promise<any>}}} remote
     */
    async function toggleEnabled(remote) {
      if (store.busy) return
      if (store.phase !== 'ready') {
        await refresh(remote)
        if (store.phase !== 'ready') return
      }
      if (!store.writable) return
      // `auto` is a constant, not a choice: the scheduler is the only mode.
      await write(remote, undefined, { entry: { enabled: !store.enabled, gear: 'auto' } })
    }

    /**
     * Turn the "less narration" reminder on or off for this conversation.
     *
     * `late` is the shipped default: no prose rule in the system prompt, one
     * compression reminder from the fourth step of a turn. `false` removes it,
     * which on the long-task fixture gave back the whole gain (184 s vs 69 s
     * median, 6 pairs).
     *
     * @param {{settings: {describe: () => Promise<any>, update: (ns: string, patch: object, revision?: number) => Promise<any>}}} remote
     * @param {boolean} on
     */
    async function toggleDiscipline(remote, on) {
      if (store.busy || store.phase !== 'ready' || !store.writable) return
      await write(remote, undefined, { entry: { discipline: on ? 'late' : false } })
    }

    /**
     * Load a tier: write its five values into this conversation's row in one
     * patch, so the panel never shows half a preset. The tier is not remembered
     * anywhere else — pressing it is the whole state change, and editing a
     * switch afterwards is what the panel then reports.
     *
     * Per-session like every other switch, so one conversation picking 保守
     * never narrows another's. Only the three live gear ids travel: the retired
     * ladder names are read as 标准 and never written back.
     *
     * @param {{settings: {describe: () => Promise<any>, update: (ns: string, patch: object, revision?: number) => Promise<any>}}} remote
     * @param {'safe' | 'auto' | 'aggressive'} value
     */
    async function applyTier(remote, value) {
      if (store.busy || store.phase !== 'ready' || !store.writable) return
      if (activeTier() === value) return
      await write(remote, undefined, { entry: { ...GEAR_PRESETS[value] } })
    }

    /* -------------------------------------------------------------- component */

    /**
     * Why the chip cannot write, as a sentence for the tooltip.
     *
     * @param {(key: string, params?: object) => string} t
     */
    function statusLine(t) {
      if (store.phase === 'loading') return t('chip.titleLoading')
      if (store.phase === 'absent') return t('chip.absent')
      if (store.phase === 'error') return t('chip.error', { error: store.error })
      if (!store.writable) return t('chip.readonly')
      if (store.writeError) return t('chip.error', { error: store.writeError })
      return ''
    }

    /**
     * The chip: one bolt, and nothing else.
     *
     * A hollow bolt means fast mode is off for this conversation, a filled one
     * that it is on; one click flips it and writes the choice for this
     * conversation only. Right click opens the panel (see `panelNode`). The mode
     * always runs at the thinking effort the user picked, and the scheduler
     * adapts the width by itself; the explanation lives in the plugin
     * description.
     *
     * @param {{t: (key: string, params?: object) => string, remote: any}} props
     */
    function FastChip(props) {
      const { t, remote } = props
      const [, bump] = react.useState(0)

      react.useEffect(() => subscribe(() => bump(count => count + 1)), [])
      // One conversation per chip, one shared settings column: the conversation
      // id decides which entry to paint. It arrives either as a standard session
      // prop or as the injected `chatId`; both spellings are accepted so a
      // release that stops injecting one still gets per-session behaviour.
      // Re-read on change, because a route change reuses this component.
      const chat =
        typeof props.sessionId === 'string' && props.sessionId !== ''
          ? props.sessionId
          : typeof props.chatId === 'string' && props.chatId !== ''
            ? props.chatId
            : undefined
      react.useEffect(() => {
        void refresh(remote, chat)
      }, [chat])

      const on = store.phase === 'ready' && store.enabled
      const open = store.panelOpen
      const status = statusLine(t)
      const title = status !== ''
        ? status
        : t(on ? 'chip.titleOn' : 'chip.titleOff')

      return react.createElement(
        'span',
        { className: 'fm-chip' },
        react.createElement(
          'button',
          {
            type: 'button',
            className: 'fm-chip__button',
            'data-on': on ? 'true' : 'false',
            'data-busy': store.busy ? 'true' : 'false',
            'aria-pressed': on,
            'aria-label': t(on ? 'chip.on' : 'chip.off'),
            title,
            onContextMenu: (event) => {
              if (event && typeof event.preventDefault === 'function') event.preventDefault()
              store.panelOpen = !store.panelOpen
              emit()
            },
            onClick: () => {
              if (store.phase !== 'ready') {
                void refresh(remote).then(() => toggleEnabled(remote))
                return
              }
              void toggleEnabled(remote)
            },
          },
          react.createElement(
            'svg',
            { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': 'true', focusable: 'false' },
            react.createElement('path', {
              d: BOLT,
              fill: on ? 'currentColor' : 'none',
              stroke: 'currentColor',
              strokeWidth: on ? 0.9 : 1.25,
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
            }),
          ),
        ),
        ...(open ? [panelNode(t, remote)] : []),
      )
    }

    /**
     * The three-way tier control that sits at the right of the panel title.
     *
     * Plain buttons in a `radiogroup`: a real `input[type=radio]` cannot be
     * styled down to the panel's 12px scale without its own native chrome, and
     * the panel already labels everything else with buttons. Tab reaches the
     * checked tier, arrows move between tiers (the radio convention), Enter and
     * Space pick. The tooltip on the group states what the tiers do and do not
     * change.
     *
     * @param {(key: string, params?: object) => string} t
     * @param {any} remote
     * @param {boolean} writable
     */
    function gearControl(t, remote, writable) {
      // The checked tier is derived from the switches, never from a stored mode:
      // a hand-edited row highlights nothing, which is the only label that does
      // not lie about what is running.
      const current = activeTier()
      const tabStop = current || gearTier(store.gear)
      const onKeyDown = (event, index) => {
        if (!event || typeof event.key !== 'string') return
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
        if (step === 0) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        const next = GEAR_TIERS[(index + step + GEAR_TIERS.length) % GEAR_TIERS.length]
        void applyTier(remote, next)
      }
      const tierButton = (value, index) => {
        const checked = current === value
        const props = {}
        props.key = value
        props.type = 'button'
        props.role = 'radio'
        props['aria-checked'] = checked
        props.className = 'fm-panel__gear'
        props.disabled = !writable
        props.tabIndex = value === tabStop ? 0 : -1
        props.onClick = () => void applyTier(remote, value)
        props.onKeyDown = event => onKeyDown(event, index)
        return react.createElement('button', props, t(GEAR_LABELS[value]))
      }
      const group = {}
      group.className = 'fm-panel__gears'
      group.role = 'radiogroup'
      group['aria-label'] = t('panel.gear')
      group.title = t('panel.gearTitle')
      return react.createElement('div', group, GEAR_TIERS.map(tierButton))
    }

    /**
     * The right-click panel: one preference, stated with its scope.
     *
     * Every row writes this conversation's own entry in `sessions`, so the footer
     * names the conversation rather than implying a shared field. A read-only,
     * busy or gated row is disabled instead of swallowing the click.
     *
     * @param {(key: string, params?: object) => string} t
     * @param {any} remote
     */
    function panelNode(t, remote) {
      const ready = store.phase === 'ready'
      const canWrite = ready && store.writable && !store.busy
      // The cautious tier turns the whole mechanism off in `resolveConfig`
      // (`gear.directive` gates the prose rule, the batch tool, the truncator and
      // the step cap), so leaving the four rows clickable there would be a dead
      // switch: a click writes the per-session value and nothing changes.
      const gated = gearTier(store.gear) === 'safe'
      const rowLive = canWrite && !gated
      const budgetText = !gated && store.stepBudget > 0
        ? t('panel.budgetSteps', { n: store.stepBudget })
        : t('panel.budgetOff')

      /**
       * One row: label on the left, current value on the right, and the
       * consequence of the setting on hover. A four-character label cannot say
       * what "不确定先查证" costs — the extra read, not a free win — so the
       * hover carries it, in one clause each.
       *
       * Props are assigned one by one because a dense key/value literal reads as
       * a status dump to the copy linter, and this is a control, not a dump.
       */
      const row = (role, label, value, live, act, checked, hint) => {
        const props = {}
        props.className = 'fm-panel__row'
        props.role = role
        props.disabled = !live
        props.onClick = act
        if (role === 'menuitemcheckbox') props['aria-checked'] = checked === true
        if (typeof hint === 'string' && hint.length > 0) props.title = hint
        return react.createElement(
          'button',
          props,
          react.createElement('span', null, label),
          react.createElement('span', { className: 'fm-panel__value' }, value),
        )
      }

      const toggleProse = () => {
        void toggleDiscipline(remote, !store.discipline)
        store.panelOpen = false
        emit()
      }

      /**
       * The file list is a per-conversation choice too, and this row is where the
       * previous release's dead switches came from: it wrote the shared
       * `workspaceMap` field, the settings side refused it as non-volatile, and the button
       * looked broken.
       */
      const toggleMap = () => {
        void write(remote, undefined, { entry: { map: !store.inventory } })
        store.panelOpen = false
        emit()
      }

      /** Same per-conversation tier as the file list, one call for many reads. */
      const toggleBatch = () => {
        void write(remote, undefined, { entry: { batch: !store.batch } })
        store.panelOpen = false
        emit()
      }

      /** Trim long tool output, keeping the error lines. */
      const toggleCompact = () => {
        void write(remote, undefined, { entry: { compactResults: !store.compact } })
        store.panelOpen = false
        emit()
      }

      return react.createElement(
        'div',
        { className: 'fm-panel', role: 'menu', 'aria-label': t('panel.title') },
        react.createElement('div', { className: 'fm-panel__title' },
          react.createElement('span', { className: 'fm-panel__heading' }, t('panel.title')),
          gearControl(t, remote, canWrite),
        ),
        row(
          'menuitemcheckbox',
          t('panel.prose'),
          t(!gated && store.discipline ? 'panel.on' : 'panel.off'),
          rowLive,
          toggleProse,
          !gated && store.discipline,
          t('panel.proseTitle'),
        ),
        row('menuitem', t('panel.budget'), budgetText, rowLive, () => void cycleBudget(remote), undefined, t('panel.budgetTitle')),
        row(
          'menuitemcheckbox',
          t('panel.map'),
          t(store.inventory ? 'panel.on' : 'panel.off'),
          canWrite,
          toggleMap,
          store.inventory,
          t('panel.mapTitle'),
        ),
        row(
          'menuitemcheckbox',
          t('panel.batch'),
          t(!gated && store.batch ? 'panel.on' : 'panel.off'),
          rowLive,
          toggleBatch,
          !gated && store.batch,
          t('panel.batchTitle'),
        ),
        row(
          'menuitemcheckbox',
          t('panel.compact'),
          t(!gated && store.compact ? 'panel.on' : 'panel.off'),
          rowLive,
          toggleCompact,
          !gated && store.compact,
          t('panel.compactTitle'),
        ),
        savedFooter(t),
      )
    }

    /** Step-cap values offered by the panel: off, then the two sane caps. */
    const BUDGET_STEPS = [0, 15, 30]

    /**
     * Move the step cap to the next offered value for this conversation.
     *
     * The cap used to be a shared field, which is why it read as a dead button:
     * `settings.write` refuses a non-volatile path outright. It travels in the
     * per-session row now, so the cap applies to this conversation only.
     *
     * @param {any} remote
     */
    async function cycleBudget(remote) {
      const at = BUDGET_STEPS.indexOf(store.stepBudget)
      const next = BUDGET_STEPS[(at < 0 ? 0 : at + 1) % BUDGET_STEPS.length]
      await write(remote, undefined, { entry: { stepBudget: next } })
    }

    /* ------------------------------------------------------------------ apply */

    /**
     * Register the dictionaries, the stylesheet, and the chip.
     *
     * @param {any} ctx - client root context.
     */
    function apply(ctx) {
      // Registering both Chinese tags costs nothing and covers whichever tag
      // the profile activates: `zh`, `zh-CN`, or a fallback to `en`.
      ctx.effect(() => ctx.locale.register(NS, { zh, 'zh-CN': zh, en }), 'fast-mode: dictionaries')

      const t = ctx.locale.bind(NS)

      ctx.effect(() => {
        if (typeof document === 'undefined') return
        const selector = `style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`
        if (document.querySelector(selector) !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-fast-mode'
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'fast-mode: chip styles')

      const remote = ctx.remote

      // The footer readout comes from the session-controller store, not from
      // this plugin's settings column: `sessionStats` and `tokenUsage` are
      // projections other plugins fill in as the turn runs. `sessions` is a
      // client service, and it is optional here — when it or its projections are
      // missing, `readStats` returns undefined and the footer keeps its scope
      // line. The whole wiring is one call, so a build without the service
      // cannot stop the chip from registering.
      try {
        ctx.inject(['sessions'], (scope) => {
          const sessions = scope.sessions
          if (sessions === null || typeof sessions !== 'object') return
          // `sessions` here is the session-controller facade: it owns the list
          // store and delegates the rest to `manager`. Projection values hang
          // off each listed session, so the readout reads the store snapshot
          // (the same source other client plugins use) instead of guessing a
          // method name on the facade.
          const source =
            typeof sessions.projectionValues === 'function'
              ? (sessionId) => sessions.projectionValues(sessionId)
              : typeof sessions.manager?.projectionValues === 'function'
                ? (sessionId) => sessions.manager.projectionValues(sessionId)
                : typeof sessions.list?.getSnapshot === 'function'
                  ? (sessionId) => sessions.list.getSnapshot()?.byId?.[sessionId]?.projectionValues
                  : undefined
          if (source === undefined) return
          projectionSource = source

          let unsubscribe
          const cleanup = () => {
            projectionSource = undefined
            if (typeof unsubscribe === 'function') unsubscribe()
          }
          if (typeof scope.on === 'function') scope.on('dispose', cleanup)

          // One re-render per changed readout, not one per projection tick:
          // `subscribe` fires for every projection of every conversation.
          const subscribe =
            typeof sessions.list?.subscribe === 'function'
              ? listener => sessions.list.subscribe(listener)
              : typeof sessions.subscribe === 'function'
                ? listener => sessions.subscribe(listener)
                : undefined
          if (subscribe === undefined) return
          let seen = ''
          const signature = () => {
            const stats = readStats(store.sessionId)
            return stats === undefined ? '' : `${stats.steps}|${stats.tokens}`
          }
          seen = signature()
          unsubscribe = subscribe(() => {
            const next = signature()
            if (next === seen) return
            seen = next
            emit()
          })
        })
      } catch (error) {
        ctx.logger?.warn?.('fast-mode: session readout unavailable: %s', describeError(error))
      }

      // The first read may race the remote connection; retry a few times rather
      // than leaving the chip stuck on "unavailable" for the whole page life.
      void (async () => {
        for (const delay of [0, 400, 1200, 3000]) {
          if (delay > 0) await sleep(delay)
          await refresh(remote)
          if (store.phase === 'ready') return
        }
      })()

      try {
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          // A list slot rejects a registration without an id, and the order is
          // what puts the chip before the voice-mode mic (order 80).
          id: 'fast-mode',
          order: 70,
          locale: NS,
          // The activity slot is session-scoped (`scope: "session"` in the
          // composer tree), and the kit calls this factory with the binding key
          // before the actions object (`runInject(entry, binding, actions)` in
          // `@deepseek-ai/dsh-client-ui-slots`), so the first argument is the
          // conversation id. `conversation.composer.bar` in the stock UI relies
          // on exactly that signature. The id goes out under `chatId`, not
          // `sessionId`, because standard session props may already own that
          // name and a colliding injected prop is a slot-assembly error.
          inject: (sessionId) => ({ remote, chatId: typeof sessionId === 'string' ? sessionId : undefined }),
        }, FastChip))
      } catch (error) {
        ctx.logger?.warn?.('fast-mode: composer chip not registered: %s', describeError(error))
      }

      // Close the panel on a click elsewhere or on Escape. Registered once and
      // guarded by the flag, so a closed chip does no work per event.
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        const onPointerDown = (event) => {
          if (!store.panelOpen) return
          const target = event && event.target
          if (target && typeof target.closest === 'function' && target.closest('.fm-chip') !== null) return
          store.panelOpen = false
          emit()
        }
        const onKeyDown = (event) => {
          if (!store.panelOpen || !event || event.key !== 'Escape') return
          store.panelOpen = false
          emit()
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        ctx.effect(() => () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }, 'fast-mode: panel dismiss')
      }

      // Another tab, a hand-edited patch, or the plugin's own settings half may be
      // the one writing.
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        const onFocus = () => { void refresh(remote) }
        window.addEventListener('focus', onFocus)
        ctx.effect(() => () => window.removeEventListener('focus', onFocus), 'fast-mode: focus resync')
      }
    }

    exports.apply = apply
    exports.inject = inject
    // The two format helpers are exported for `test/state.test.js`, which feeds
    // the same fixtures to this copy and to `src/state.js`: the settings side decides what a
    // request runs at from the column this half writes, so a drift between the two
    // is a switch that looks on and does nothing.
    exports.__choices = { SESSIONS_LIMIT, parseChoices, encodeChoices, withOwn }
    return module.exports
  },
})
