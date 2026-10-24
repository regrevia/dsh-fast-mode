/**
 * dsh-fast-mode — client half: the lightning chip in the composer.
 *
 * One control, one source of truth. The chip is a view of the plugin's own
 * `enabled` and `gear` config fields, read and written through the `settings`
 * service (`settings/describe` → `settings/update`), which is the same surface
 * the Loader uses for its composition patch. There is no second state store: a
 * click writes `{ enabled }` or `{ gear }` to this entry's user layer, the Loader
 * re-applies the host half, and the policy changes on the next model call.
 *
 * Why the chip lives in `conversation.input.activity`: that slot is the one
 * place the composer renders *after* the standard controls and *before* the stop
 * button — beside the model selector, which is where a speed switch belongs.
 * Occupying `conversation.input.model` instead would shadow the shipped
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
 * configuration is unknown re-reads it, and an unreadable configuration opens
 * the menu with the reason spelled out. Nothing is hidden behind a tooltip that
 * cannot show.
 *
 * ## The panel
 *
 * One switch and one honest sentence. Fast mode has no gears to choose any
 * more: it always runs at the thinking effort the user picked (that is the
 * contract), and the scheduler decides the rest per step, so a picker would be
 * offering choices that no longer exist. The panel therefore shows the switch,
 * what the scheduler is currently allowed to do, and the two reasons the mode
 * can be faster without being shallower.
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
    const SLOT = 'conversation.input.activity'
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
     * `{ menu: { speed: … } }` therefore never resolves `'menu.speed'`: the chip
     * painted raw keys (`menu.headOff`, `menu.effort`) instead of words. Flat
     * keys make the lookup hit.
     *
     * Chinese is registered under `zh` *and* `zh-CN`: the active locale may be
     * either tag, and a miss falls through to English.
     */
    const zh = {
      'chip.on': 'Fast 模式已开启',
      'chip.off': 'Fast 模式已关闭',
      'chip.titleOn': 'Fast 模式：已开启 · 自动调度，思考强度不变。点击进入设置',
      'chip.titleOff': 'Fast 模式：已关闭 · 点击开启',
      'chip.titleLoading': 'Fast 模式：正在读取配置，点击重试',
      'chip.readonly': 'Fast 模式配置为只读，无法从这里切换',
      'chip.error': 'Fast 模式配置读取失败：{error}',
      'chip.absent': 'Fast 模式未在此配置中声明，点击重试',
      'menu.title': 'Fast 模式',
      'menu.open': '打开 Fast 模式设置',
      'menu.on': '已开启',
      'menu.off': '已关闭',
      'menu.switchOn': '已开启，点击关闭',
      'menu.switchOff': '已关闭，点击开启',
      'menu.busy': '写入中…',
      'menu.scope': '仅本会话生效',
      'menu.auto': '自动调度 · 并行 2–8 · 单次调用 ≤ {minutes} 分',
      'menu.autoOff': '已关闭 · 完全回到原生行为',
      'menu.autoOpen': '自动调度 · 并行 2–8 · 单次调用不限时',
      'menu.effort': '思考强度保持你选的档，不因开启而降低。',
      'menu.mechanism': '更快来自：更宽的工具并行、更少过程文字、自动打断卡住的调用。',
    }

    const en = {
      'chip.on': 'Fast mode is on',
      'chip.off': 'Fast mode is off',
      'chip.titleOn': 'Fast mode: on · automatic scheduling, thinking effort unchanged. Click for settings',
      'chip.titleOff': 'Fast mode: off · click to turn on',
      'chip.titleLoading': 'Fast mode: reading configuration. Click to retry',
      'chip.readonly': 'Fast mode configuration is read-only',
      'chip.error': 'Fast mode configuration unavailable: {error}',
      'chip.absent': 'Fast mode is not configured in this composition. Click to retry',
      'menu.title': 'Fast mode',
      'menu.open': 'Open fast mode settings',
      'menu.on': 'On',
      'menu.off': 'Off',
      'menu.switchOn': 'On, click to turn off',
      'menu.switchOff': 'Off, click to turn on',
      'menu.busy': 'Writing…',
      'menu.scope': 'This conversation only',
      'menu.auto': 'Automatic · parallel 2–8 · one call ≤ {minutes} min',
      'menu.autoOff': 'Off · the harness behaves exactly as shipped',
      'menu.autoOpen': 'Automatic · parallel 2–8 · calls unbounded',
      'menu.effort': 'Thinking effort stays exactly what you chose.',
      'menu.mechanism': 'Faster because: wider tool batching, less narration, bounded calls.',
    }

    const CSS = [
      // The chip: one icon, nothing else. Clicking it opens the panel; the
      // on/off switch lives inside the panel, not next to the bolt.
      '.fm-chip{display:inline-flex;align-items:center;min-width:0;flex:none;position:relative}',
      '.fm-chip__button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
      'width:28px;height:28px;padding:0;margin:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;',
      'color:var(--dsw-alias-label-tertiary,#8b8b8b);font:inherit;line-height:1;cursor:pointer;',
      'transition:background-color .12s ease,color .12s ease}',
      '.fm-chip__button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));',
      'color:var(--dsw-alias-label-secondary,#5c5c5c)}',
      '.fm-chip__button[data-on="true"]{color:var(--dsw-alias-label-primary,#141414)}',
      '.fm-chip__button[data-open="true"]{background:var(--dsw-alias-interactive-bg-selected,rgba(77,107,254,.12))}',
      '.fm-chip__button[data-busy="true"]{opacity:.55;cursor:progress}',
      '.fm-chip__button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ',
      'var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px}',
      '.fm-chip__button svg{display:block;flex:none}',
      // The panel. Narrow on purpose, and laid out as a three-column table so
      // the two numbers have a labelled home: the earlier version printed
      // `1.6× · 1.5×` with no header, so nothing said which one was the speed
      // and which one was the token cost.
      '.fm-menu{position:fixed;z-index:2147483000;box-sizing:border-box;width:196px;padding:6px;',
      'border-radius:12px;background:var(--dsw-alias-bg-elevated,#fff);',
      'border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));box-shadow:0 10px 30px rgba(0,0,0,.18);',
      'font:inherit;color:var(--dsw-alias-label-primary,#141414);text-align:left}',
      '.fm-menu--dock{left:50%;bottom:104px;transform:translateX(-50%)}',
      '.fm-menu__head{display:flex;align-items:center;gap:8px;padding:4px 6px 7px}',
      '.fm-menu__title{flex:1 1 auto;min-width:0;font-size:12px;font-weight:600;letter-spacing:.02em;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // The switch: a real control, so the state reads without a sentence.
      '.fm-menu__switch{flex:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:flex-end;',
      'width:28px;height:16px;padding:0 2px;margin:0;border:0;border-radius:8px;background:var(--dsw-alias-border-subtle,rgba(0,0,0,.16));',
      'cursor:pointer;transition:background-color .14s ease}',
      '.fm-menu__switch[data-on="true"]{background:var(--dsw-alias-state-business-primary,#4d6bfe);justify-content:flex-start}',
      '.fm-menu__knob{flex:none;width:12px;height:12px;border-radius:50%;background:#fff;',
      'box-shadow:0 1px 2px rgba(0,0,0,.28)}',
      '.fm-menu__switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ',
      'var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px}',
      '.fm-menu__sep{height:1px;margin:0 6px 5px;background:var(--dsw-alias-border-subtle,rgba(0,0,0,.07))}',
      '.fm-menu__scope{padding:0 6px 4px;font-size:10px;line-height:1.5;',
      'color:var(--dsw-alias-label-tertiary,#8b8b8b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // The scheduler line: what the mode is currently allowed to do. One row,
      // no columns, because there is nothing left to choose between.
      '.fm-menu__live{display:flex;align-items:center;gap:6px;padding:3px 6px 4px;font-size:11px;',
      'line-height:1.45;color:var(--dsw-alias-label-secondary,#5c5c5c)}',
      '.fm-menu__dot{flex:none;width:6px;height:6px;border-radius:50%;',
      'background:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.fm-menu__dot[data-on="false"]{background:var(--dsw-alias-label-tertiary,#8b8b8b)}',
      // The fine print wraps; the old one was `white-space:nowrap` and got cut.
      '.fm-menu__foot{margin-top:5px;padding:5px 6px 1px;border-top:1px solid ',
      'var(--dsw-alias-border-subtle,rgba(0,0,0,.07));font-size:10px;line-height:1.5;',
      'color:var(--dsw-alias-label-tertiary,#8b8b8b)}',
      '.fm-menu__foot p{margin:0}',
      '.fm-menu__status{padding:5px 6px;font-size:11px;line-height:1.45;',
      'color:var(--dsw-alias-state-error-primary,#c9353f)}',
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
      phase: 'loading',
      enabled: false,
      gear: '',
      writable: true,
      /** Namespace key and revision of the last successful read. */
      ns: undefined,
      revision: undefined,
      error: '',
      /**
       * The last refused write. Kept apart from `error` because the resync that
       * follows a refusal succeeds, and a successful read must not erase the one
       * message the user needs: why the click did not stick.
       */
      writeError: '',
      /** A write in flight: keeps the button from double-firing. */
      busy: false,
      /** The value we are waiting for the host to echo back after a write. */
      pending: undefined,
      /**
       * `undefined` while closed. Otherwise the fixed-position anchor of the
       * panel: `{right, bottom}` in pixels, or `'dock'` when the chip has no
       * measurable box (tests, a detached node).
       */
      menu: undefined,
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
      /** The ceiling the panel quotes, in whole minutes, read off the host. */
      stallMinutes: '2',
      /** The same ceiling in milliseconds; `0` means the guard is disabled. */
      stallBudget: 120_000,
    }

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

    /* ------------------------------------------------- per-session bookkeeping */

    /**
     * Browser half of the per-session column — the same format the host parses in
     * `src/state.js`. The bundle cannot import host ESM (it is fetched verbatim by
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
     * taking the chip down: the column may be hand-edited, and the panel is the
     * only place a user can see the switch, so throwing here would hide the bug.
     *
     * The shape check is deliberately the same one the host applies
     * (`src/state.js` `sanitise`): this half writes entries the host then reads
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
     * Keep only entries the host would also honour.
     *
     * @param {Record<string, any>} input
     */
    function sanitiseChoices(input) {
      /** @type {Record<string, {enabled?: boolean, gear?: string, ts?: number}>} */
      const out = {}
      for (const [sessionId, entry] of Object.entries(input)) {
        if (sessionId.length === 0 || !isRecord(entry)) continue
        /** @type {{enabled?: boolean, gear?: string, ts?: number}} */
        const clean = {}
        if (typeof entry.enabled === 'boolean') clean.enabled = entry.enabled
        if (typeof entry.gear === 'string' && entry.gear.length > 0) clean.gear = entry.gear
        if (Number.isFinite(entry.ts)) clean.ts = Number(entry.ts)
        if (clean.enabled === undefined && clean.gear === undefined) continue
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
     * A copy of the column with this conversation's entry set to the pair the user
     * just asked for.
     *
     * Both halves of a click travel in one patch: `enabled` / `gear` are the
     * shared default (and therefore the "last choice" a new session inherits),
     * `sessions` is this conversation's own entry (and therefore what the host
     * applies to *this* request stream). Splitting them into two writes would
     * leave a window where the session runs on one gear while the panel shows
     * another — and two writes means two revision races.
     *
     * @param {Record<string, any>} map
     * @param {string|undefined} sessionId
     * @param {boolean} enabled
     * @param {string} gear
     */
    function withOwn(map, sessionId, enabled, gear) {
      const next = { ...map }
      if (typeof sessionId !== 'string' || sessionId.length === 0) return next
      const current = isRecord(next[sessionId]) ? next[sessionId] : {}
      /** @type {{enabled: boolean, gear?: string, ts: number}} */
      const entry = { ...current, enabled: enabled === true, ts: Date.now() }
      if (typeof gear === 'string' && gear.length > 0) entry.gear = gear
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
     * client connects before the host channel is up; without a deadline the chip
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
          // A layer that carries the field wins; otherwise keep what we already
          // know instead of flattening the menu back to the default. The
          // conversation's own entry outranks the shared default, field by field,
          // so an entry that pins only the gear still inherits the switch.
          const sharedGear = typeof value.gear === 'string' ? value.gear : store.gear
          const seenGear = own !== undefined && typeof own.gear === 'string' ? own.gear : sharedGear
          store.phase = 'ready'
          store.error = ''
          store.ns = view.ns
          store.revision = typeof view.revision === 'number' ? view.revision : undefined
          store.writable = !(result && result.writable === false)
          store.gear = seenGear
          // The panel quotes the ceiling the host actually enforces: an explicit
          // `toolTimeoutMs` wins, otherwise the `auto` budget. A disabled guard
          // is not a number, and the panel says so instead of inventing one.
          const budget = value.stallGuard === false
            ? 0
            : (Number(value.toolTimeoutMs) > 0 ? Number(value.toolTimeoutMs) : 120_000)
          store.stallBudget = budget
          store.stallMinutes = `${Math.round((budget / 60_000) * 10) / 10}`
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
     * The host echoes a write a beat later, so poll briefly instead of showing
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
     * The patch is optimistic, then reconciled with what the host reports. A
     * refusal rolls the paint back and keeps the message — never a silent revert.
     *
     * @param {{settings: {update: (ns: string, patch: object, revision?: number) => Promise<any>}}} remote
     * @param {{enabled?: boolean, gear?: string}} patch
     * @returns {Promise<boolean>} whether the write was accepted
     */
    async function write(remote, patch) {
      if (store.phase !== 'ready' || !store.writable || store.busy) return false
      const before = { enabled: store.enabled, gear: store.gear, sessions: store.sessions }
      const finalEnabled = typeof patch.enabled === 'boolean' ? patch.enabled : store.enabled
      const finalGear = typeof patch.gear === 'string' ? patch.gear : store.gear
      const merged = withOwn(store.sessions, store.sessionId, finalEnabled, finalGear)
      const outgoing = { ...patch, sessions: encodeChoices(merged) }
      store.busy = true
      store.writeError = ''
      store.sessions = merged
      if (typeof patch.enabled === 'boolean') {
        store.enabled = patch.enabled
        store.pending = patch.enabled
      }
      if (typeof patch.gear === 'string') store.gear = patch.gear
      emit()
      try {
        unwrap(await withTimeout(remote.settings.update(store.ns, outgoing, store.revision), 15000, 'settings/update'))
        store.busy = false
        await settle(remote, typeof patch.enabled === 'boolean' ? patch.enabled : store.enabled)
        emit()
        return true
      } catch (error) {
        store.busy = false
        store.enabled = before.enabled
        store.gear = before.gear
        store.sessions = before.sessions
        store.pending = undefined
        store.writeError = describeError(error)
        emit()
        // A stale revision is the likeliest refusal; resync so the next click
        // carries the current one.
        await refresh(remote)
        return false
      }
    }

    /* ------------------------------------------------------------------- menu */

    /**
     * Open the gear menu, anchored above the chip when a box is measurable.
     *
     * @param {any} [node] the caret element (`event.currentTarget`).
     */
    function openMenu(node) {
      let anchor = 'dock'
      try {
        const rect = node !== null && typeof node === 'object' && typeof node.getBoundingClientRect === 'function'
          ? node.getBoundingClientRect()
          : undefined
        const viewport = typeof window !== 'undefined' && window !== null ? window : undefined
        if (rect !== undefined && viewport !== undefined
          && typeof rect.right === 'number' && typeof rect.bottom === 'number'
          && typeof viewport.innerWidth === 'number' && typeof viewport.innerHeight === 'number') {
          anchor = {
            right: Math.max(8, Math.round(viewport.innerWidth - rect.right)),
            bottom: Math.round(viewport.innerHeight - rect.bottom + 6),
          }
        }
      } catch {
        anchor = 'dock'
      }
      store.menu = anchor
      emit()
    }

    function closeMenu() {
      if (store.menu === undefined) return
      store.menu = undefined
      emit()
    }

    /** @param {any} node */
    function toggleMenu(node) {
      if (store.menu !== undefined) {
        closeMenu()
        return
      }
      openMenu(node)
    }

    /**
     * Flip fast mode. Called from the switch inside the panel, so the panel is
     * already open — a refusal just leaves the reason on the status line there
     * instead of closing the surface the user is looking at.
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
      // The scheduler rides along so the shared column (which seeds a brand-new
      // conversation) matches what this one just got. `auto` is a constant, not
      // a choice: it is the only value the panel can produce.
      await write(remote, { enabled: !store.enabled, gear: 'auto' })
    }

    /* -------------------------------------------------------------- component */

    /**
     * Why the chip cannot write, as a sentence for the tooltip and the menu.
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
     * The panel the bolt opens.
     *
     * One switch, one scheduler line, two lines of fine print. There is no gear
     * list because there is no gear to pick: the mode runs at the user's chosen
     * thinking effort and the scheduler adapts the width per step. Re-introducing
     * a ladder here would be re-introducing the thing that was removed.
     *
     * @param {{t: (key: string, params?: object) => string, remote: any}} props
     */
    function FastPanel(props) {
      const { t, remote } = props
      const anchor = store.menu
      const style = anchor !== undefined && anchor !== 'dock'
        ? { right: `${anchor.right}px`, bottom: `${anchor.bottom}px` }
        : undefined
      const status = statusLine(t)
      const on = store.phase === 'ready' && store.enabled
      // The ceiling is a policy the user should be able to read off the panel,
      // not a hidden constant. It is the `auto` budget (`AUTO_LIMITS` /
      // `STALL_BUDGET`); a per-request override is a composition knob the client
      // cannot see, so it is not painted here.
      const minutes = store.stallMinutes

      const children = [
        react.createElement(
          'div',
          { className: 'fm-menu__head' },
          react.createElement('span', { className: 'fm-menu__title' }, t('menu.title')),
          react.createElement(
            'button',
            {
              type: 'button',
              className: 'fm-menu__switch',
              role: 'switch',
              'aria-checked': on,
              'aria-label': t(on ? 'chip.on' : 'chip.off'),
              title: t(store.busy ? 'menu.busy' : on ? 'menu.switchOn' : 'menu.switchOff'),
              'data-on': on ? 'true' : 'false',
              'data-busy': store.busy ? 'true' : 'false',
              onClick: () => { void toggleEnabled(remote) },
            },
            react.createElement('span', { className: 'fm-menu__knob' }),
          ),
        ),
        react.createElement('div', { className: 'fm-menu__sep' }),
        react.createElement('div', { className: 'fm-menu__scope' }, t('menu.scope')),
        react.createElement(
          'div',
          { className: 'fm-menu__live' },
          react.createElement('span', { className: 'fm-menu__dot', 'data-on': on ? 'true' : 'false' }),
          react.createElement('span', null, on
            ? (minutes === '0' ? t('menu.autoOpen') : t('menu.auto', { minutes }))
            : t('menu.autoOff')),
        ),
      ]

      children.push(react.createElement(
        'div',
        { className: 'fm-menu__foot' },
        react.createElement('p', null, t('menu.effort')),
        react.createElement('p', null, t('menu.mechanism')),
      ))
      if (status !== '') children.push(react.createElement('div', { className: 'fm-menu__status' }, status))

      return react.createElement(
        'div',
        {
          className: anchor === 'dock' ? 'fm-menu fm-menu--dock' : 'fm-menu',
          role: 'dialog',
          'aria-label': t('menu.title'),
          style,
        },
        ...children,
      )
    }

    /**
     * The chip: one bolt, and nothing else.
     *
     * It is an *entry point*, not a switch: clicking it opens the panel, where
     * the on/off control and the gear list live. A hollow bolt means fast mode
     * is off, a filled one that it is on — that is the whole at-a-glance
     * contract, and it is why the caret that used to sit next to it is gone.
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
      const status = statusLine(t)
      const open = store.menu !== undefined
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
            'data-open': open ? 'true' : 'false',
            'data-busy': store.busy ? 'true' : 'false',
            'aria-pressed': on,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': t(on ? 'chip.on' : 'chip.off'),
            title,
            onClick: (event) => {
              toggleMenu(event && event.currentTarget)
              if (store.phase !== 'ready') void refresh(remote)
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
        store.menu === undefined ? null : react.createElement(FastPanel, { t, remote }),
      )
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

      // Dismissal: a click outside the chip, or Escape. Capture phase so a
      // composer handler cannot swallow the click first.
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        const onPointerDown = (event) => {
          if (store.menu === undefined) return
          const target = event && event.target
          if (target !== null && typeof target === 'object' && typeof target.closest === 'function'
            && target.closest('.fm-chip') !== null) return
          closeMenu()
        }
        const onKeyDown = (event) => {
          if (event && event.key === 'Escape') closeMenu()
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        ctx.effect(() => () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }, 'fast-mode: menu dismissal')
      }

      // Another tab, a hand-edited patch, or the plugin's own host half may be
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
    // the same fixtures to this copy and to `src/state.js`: the host decides what a
    // request runs at from the column this half writes, so a drift between the two
    // is a switch that looks on and does nothing.
    exports.__choices = { SESSIONS_LIMIT, parseChoices, encodeChoices, withOwn }
    return module.exports
  },
})
