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
 * ## The gear menu
 *
 * Gear selection lives here rather than on the generated Settings page: the page
 * is for composition-level knobs, the chip is where speed is chosen. Each row
 * states the trade it offers as an *estimate* — speed multiplier and token
 * multiplier — derived from what a gear actually changes (`deepAfter` and the
 * model-facing fan-out target), never presented as a guarantee.
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
     * The gear ladder as the menu presents it.
     *
     * `speed` / `tokens` are *estimates* relative to `safe`, not measurements.
     * A gear changes two things: how early the policy is allowed to drop the
     * effort notch (`deepAfter`) and how many tool calls the model-facing
     * guidance asks for per step (`parallel`). Both cut wall-clock time by doing
     * more work per step; neither can reorder the serial part of a turn, and
     * wider steps cost input tokens for the extra calls. The numbers are rounded
     * from that trade, and every row says so in the footer.
     *
     * The ids must match `GEARS` in `src/effort.js`; `test/client.test.js`
     * asserts that they do, because a client-side id the host does not know
     * would be rejected by the schema union.
     */
    const GEAR_MENU = [
      { id: 'safe', speed: 1, tokens: 1 },
      { id: 'fast', speed: 1.3, tokens: 1.2 },
      { id: 'turbo', speed: 1.6, tokens: 1.5 },
      { id: 'max', speed: 2.2, tokens: 1.9 },
      // The only gear that reaches past ~2x, because it is the only one allowed
      // to drop reasoning to `off`. It carries a visible asterisk for that.
      { id: 'ludicrous', speed: 3.4, tokens: 1.3, risky: true },
    ]

    /**
     * Dictionaries, written with **dotted top-level keys on purpose**.
     *
     * `dsh-client-locale` resolves a key by indexing the dictionary flat —
     * `dicts.get(ns).get(locale)?.[key]` (`dsh-client-locale/lib/client.js`
     * lookup) — and falls back to returning the key itself. A nested
     * `{ menu: { speed: … } }` therefore never resolves `'menu.speed'`: the chip
     * painted raw keys (`menu.headOff`, `gears.safe`) instead of words. Flat
     * keys make the lookup hit.
     *
     * Chinese is registered under `zh` *and* `zh-CN`: the active locale may be
     * either tag, and a miss falls through to English.
     */
    const zh = {
      'chip.on': 'Fast 模式已开启',
      'chip.off': 'Fast 模式已关闭',
      'chip.titleOn': 'Fast 模式：已开启 · {gear}（速度 ~{speed} · token ~{tokens}）。点击进入设置',
      'chip.titleOff': 'Fast 模式：已关闭 · {gear}（速度 ~{speed} · token ~{tokens}）。点击进入设置',
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
      'menu.note': '倍率预估：速度 · token',
      'menu.warn': '* 关闭思考，质量会下降',
      'gears.safe': '安全',
      'gears.fast': '快速',
      'gears.turbo': '涡轮',
      'gears.max': '极限',
      'gears.ludicrous': '极速',
    }

    const en = {
      'chip.on': 'Fast mode is on',
      'chip.off': 'Fast mode is off',
      'chip.titleOn': 'Fast mode: on · {gear} (speed ~{speed} · token ~{tokens}). Click for settings',
      'chip.titleOff': 'Fast mode: off · {gear} (speed ~{speed} · token ~{tokens}). Click for settings',
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
      'menu.note': 'Estimates: speed · token',
      'menu.warn': '* reasoning off, quality drops',
      'gears.safe': 'Safe',
      'gears.fast': 'Fast',
      'gears.turbo': 'Turbo',
      'gears.max': 'Max',
      'gears.ludicrous': 'Ludicrous',
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
      // The panel. Narrow on purpose: every row is `name  numbers`, and the
      // explanatory text is one line at the bottom.
      '.fm-menu{position:fixed;z-index:2147483000;box-sizing:border-box;width:196px;padding:5px;',
      'border-radius:12px;background:var(--dsw-alias-bg-elevated,#fff);',
      'border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));box-shadow:0 10px 30px rgba(0,0,0,.18);',
      'font:inherit;color:var(--dsw-alias-label-primary,#141414);text-align:left}',
      '.fm-menu--dock{left:50%;bottom:104px;transform:translateX(-50%)}',
      '.fm-menu__head{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 7px;',
      'margin:0;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}',
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
      '.fm-menu__sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-subtle,rgba(0,0,0,.07))}',
      '.fm-menu__item{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:5px 7px;',
      'margin:0;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;',
      'cursor:pointer;text-align:left}',
      '.fm-menu__item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.fm-menu__item[data-current="true"]{background:var(--dsw-alias-interactive-bg-selected,rgba(77,107,254,.1))}',
      '.fm-menu__item[data-off="true"]{opacity:.5}',
      '.fm-menu__name{flex:none;font-weight:600;white-space:nowrap}',
      '.fm-menu__meter{margin-left:auto;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;',
      'color:var(--dsw-alias-label-secondary,#5c5c5c)}',
      '.fm-menu__tick{flex:none;width:6px;height:6px;border-radius:50%;',
      'background:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.fm-menu__tick[data-empty="true"]{background:transparent}',
      '.fm-menu__note{padding:4px 7px 2px;font-size:10px;line-height:1.4;',
      'color:var(--dsw-alias-label-tertiary,#8b8b8b);white-space:nowrap}',
      '.fm-menu__status{padding:6px 7px;font-size:11px;line-height:1.45;',
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
       * gear menu: `{right, bottom}` in pixels, or `'dock'` when the chip has no
       * measurable box (tests, a detached node).
       */
      menu: undefined,
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

    /** @param {number} value */
    const formatX = value => `${(Math.round(value * 10) / 10).toFixed(1)}×`

    /** @param {string} id */
    function gearEntry(id) {
      return GEAR_MENU.find(entry => entry.id === id)
    }

    /**
     * The gear the menu paints as current. Falls back to `fast` (the schema
     * default) when the read did not carry the field, so the menu is never
     * blank: an unreadable field is not a reason to show nothing.
     */
    function currentGear() {
      return gearEntry(store.gear) ?? gearEntry('fast') ?? GEAR_MENU[0]
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
     * @param {{settings: {describe: () => Promise<any>}}} remote
     */
    async function refresh(remote) {
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
          // A layer that carries the field wins; otherwise keep what we already
          // know instead of flattening the menu back to the default.
          const seenGear = typeof value.gear === 'string' ? value.gear : store.gear
          store.phase = 'ready'
          store.error = ''
          store.ns = view.ns
          store.revision = typeof view.revision === 'number' ? view.revision : undefined
          store.writable = !(result && result.writable === false)
          store.gear = seenGear
          // A write we have not seen echoed yet wins: the Loader applies the new
          // section asynchronously, and flipping back to the old paint in that
          // window would read as a failed click.
          const observed = value.enabled === true
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
      const before = { enabled: store.enabled, gear: store.gear }
      store.busy = true
      store.writeError = ''
      if (typeof patch.enabled === 'boolean') {
        store.enabled = patch.enabled
        store.pending = patch.enabled
      }
      if (typeof patch.gear === 'string') store.gear = patch.gear
      emit()
      try {
        unwrap(await withTimeout(remote.settings.update(store.ns, patch, store.revision), 15000, 'settings/update'))
        store.busy = false
        await settle(remote, typeof patch.enabled === 'boolean' ? patch.enabled : store.enabled)
        emit()
        return true
      } catch (error) {
        store.busy = false
        store.enabled = before.enabled
        store.gear = before.gear
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
     * Pick a gear. Selecting one while Fast mode is off turns it on as well:
     * the user's intent in this menu is "go faster", and a gear silently stored
     * behind a disabled mode would be indistinguishable from a broken click.
     *
     * @param {{settings: {describe: () => Promise<any>, update: (ns: string, patch: object, revision?: number) => Promise<any>}}} remote
     * @param {string} id
     */
    async function chooseGear(remote, id) {
      if (store.busy) return
      if (store.phase !== 'ready') await refresh(remote)
      if (store.phase !== 'ready') {
        emit()
        return
      }
      if (!store.writable) {
        emit()
        return
      }
      /** @type {{gear: string, enabled?: boolean}} */
      const patch = { gear: id }
      if (!store.enabled) patch.enabled = true
      const accepted = await write(remote, patch)
      if (accepted) closeMenu()
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
      await write(remote, { enabled: !store.enabled })
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
     * One switch, one gear list, one line of fine print — the earlier version
     * repeated `速度` / `token` on every row and overflowed its own box. The
     * numbers are absolute estimates, so the footer only has to explain the pair
     * once, and the menu stays narrow enough to sit above the composer.
     *
     * @param {{t: (key: string, params?: object) => string, remote: any}} props
     */
    function GearMenu(props) {
      const { t, remote } = props
      const anchor = store.menu
      const style = anchor !== undefined && anchor !== 'dock'
        ? { right: `${anchor.right}px`, bottom: `${anchor.bottom}px` }
        : undefined
      const status = statusLine(t)
      const on = store.phase === 'ready' && store.enabled

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
      ]

      for (const entry of GEAR_MENU) {
        const name = t(`gears.${entry.id}`)
        const meter = `${formatX(entry.speed)} · ${formatX(entry.tokens)}`
        children.push(react.createElement(
          'button',
          {
            key: entry.id,
            type: 'button',
            className: 'fm-menu__item',
            'data-current': store.gear === entry.id ? 'true' : 'false',
            'data-off': on ? 'false' : 'true',
            title: `${name} ${meter}`,
            'aria-label': entry.risky === true ? `${name} ${meter} ${t('menu.warn')}` : `${name} ${meter}`,
            onClick: () => { void chooseGear(remote, entry.id) },
          },
          react.createElement(
            'span',
            { className: 'fm-menu__name' },
            entry.risky === true ? `${name}*` : name,
          ),
          react.createElement('span', { className: 'fm-menu__meter' }, meter),
          react.createElement('span', { className: 'fm-menu__tick', 'data-empty': store.gear === entry.id ? 'false' : 'true' }),
        ))
      }

      children.push(react.createElement(
        'div',
        { className: 'fm-menu__note' },
        GEAR_MENU.some(entry => entry.risky === true) ? `${t('menu.note')} ${t('menu.warn')}` : t('menu.note'),
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

      const on = store.phase === 'ready' && store.enabled
      const gear = currentGear()
      const status = statusLine(t)
      const open = store.menu !== undefined
      const title = status !== ''
        ? status
        : t(on ? 'chip.titleOn' : 'chip.titleOff', {
          gear: t(`gears.${gear.id}`),
          speed: formatX(gear.speed).slice(0, -1),
          tokens: formatX(gear.tokens).slice(0, -1),
        })

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
        store.menu === undefined ? null : react.createElement(GearMenu, { t, remote }),
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
          inject: () => ({ remote }),
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
    exports.GEAR_MENU = GEAR_MENU
    return module.exports
  },
})
