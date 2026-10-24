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
      { id: 'max', speed: 1.9, tokens: 1.9 },
    ]

    const zh = {
      chip: {
        on: 'Fast 模式已开启',
        off: 'Fast 模式已关闭',
        titleOn: 'Fast 模式：已开启 · {gear}（速度 ~{speed} · token ~{tokens}）。点击关闭',
        titleOff: 'Fast 模式：已关闭 · {gear}（速度 ~{speed} · token ~{tokens}）。点击开启',
        titleLoading: 'Fast 模式：正在读取配置，点击重试',
        readonly: 'Fast 模式配置为只读，无法从界面切换',
        error: 'Fast 模式配置读取失败：{error}',
        absent: 'Fast 模式未在此配置中声明，点击重试',
      },
      menu: {
        title: 'Fast 模式档位',
        open: '选择加速档位',
        headOn: 'Fast 模式：已开启',
        headOff: 'Fast 模式：已关闭',
        toggleOn: '点击关闭',
        toggleOff: '点击开启',
        speed: '速度',
        tokens: 'token',
        note: '倍率为预估：档位越高，越早允许降思考、每步并行目标越宽。实际收益取决于任务形态；选择档位会同时开启 Fast 模式。',
        busy: '正在写入…',
      },
      gears: {
        safe: '安全',
        fast: '快速',
        turbo: '涡轮',
        max: '极限',
      },
    }

    const en = {
      chip: {
        on: 'Fast mode is on',
        off: 'Fast mode is off',
        titleOn: 'Fast mode: on · {gear} (speed ~{speed} · token ~{tokens}). Click to turn off',
        titleOff: 'Fast mode: off · {gear} (speed ~{speed} · token ~{tokens}). Click to turn on',
        titleLoading: 'Fast mode: reading configuration. Click to retry',
        readonly: 'Fast mode configuration is read-only',
        error: 'Fast mode configuration unavailable: {error}',
        absent: 'Fast mode is not configured in this composition. Click to retry',
      },
      menu: {
        title: 'Fast mode gear',
        open: 'Choose a speed gear',
        headOn: 'Fast mode: on',
        headOff: 'Fast mode: off',
        toggleOn: 'Click to turn off',
        toggleOff: 'Click to turn on',
        speed: 'speed',
        tokens: 'token',
        note: 'Multipliers are estimates: a higher gear allows the effort drop earlier and asks for wider steps. Real gains depend on the task; picking a gear also turns Fast mode on.',
        busy: 'Writing…',
      },
      gears: {
        safe: 'Safe',
        fast: 'Fast',
        turbo: 'Turbo',
        max: 'Max',
      },
    }

    const CSS = [
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
      '.fm-chip__caret{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
      'width:13px;height:28px;padding:0;margin:0 0 0 -2px;border:0;border-radius:4px;background:transparent;',
      'color:var(--dsw-alias-label-tertiary,#8b8b8b);cursor:pointer;opacity:.7;transition:opacity .12s ease,background-color .12s ease}',
      '.fm-chip__caret:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.fm-chip__caret:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ',
      'var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px}',
      '.fm-chip__caret::before{content:"";width:0;height:0;border-left:3.5px solid transparent;',
      'border-right:3.5px solid transparent;border-top:4px solid currentColor}',
      '.fm-menu{position:fixed;z-index:2147483000;box-sizing:border-box;width:274px;padding:6px;',
      'border-radius:12px;background:var(--dsw-alias-bg-elevated,#fff);',
      'border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));box-shadow:0 10px 30px rgba(0,0,0,.18);',
      'font:inherit;color:var(--dsw-alias-label-primary,#141414);text-align:left}',
      '.fm-menu--dock{left:50%;bottom:104px;transform:translateX(-50%)}',
      '.fm-menu__head{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:7px 8px;',
      'margin:0;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}',
      '.fm-menu__head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.fm-menu__dot{flex:none;width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.28}',
      '.fm-menu__dot[data-on="true"]{opacity:1;background:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.fm-menu__title{flex:none;font-size:12px;font-weight:600;letter-spacing:.02em}',
      '.fm-menu__hint{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b8b8b);white-space:nowrap}',
      '.fm-menu__sep{height:1px;margin:5px 6px;background:var(--dsw-alias-border-subtle,rgba(0,0,0,.07))}',
      '.fm-menu__item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:7px 8px;',
      'margin:0;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12.5px;',
      'cursor:pointer;text-align:left}',
      '.fm-menu__item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.fm-menu__item[data-current="true"]{background:var(--dsw-alias-interactive-bg-selected,rgba(77,107,254,.1))}',
      '.fm-menu__name{flex:none;font-weight:600;min-width:2.4em}',
      '.fm-menu__meter{margin-left:auto;font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap;',
      'color:var(--dsw-alias-label-secondary,#5c5c5c)}',
      '.fm-menu__tick{flex:none;width:9px;height:9px;border-radius:50%;',
      'background:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.fm-menu__tick[data-empty="true"]{background:transparent}',
      '.fm-menu__note{padding:6px 8px 3px;font-size:10.5px;line-height:1.5;',
      'color:var(--dsw-alias-label-tertiary,#8b8b8b)}',
      '.fm-menu__status{padding:7px 8px;font-size:11px;line-height:1.5;',
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
     * The bolt button. Always acts: writes when the namespace is known, and
     * otherwise re-reads it and reports why it could not — with the menu as the
     * visible surface for that report.
     *
     * @param {{settings: {describe: () => Promise<any>, update: (ns: string, patch: object, revision?: number) => Promise<any>}}} remote
     */
    async function clickBolt(remote) {
      if (store.busy) return
      if (store.phase !== 'ready') {
        await refresh(remote)
        if (store.phase !== 'ready') {
          openMenu(undefined)
          return
        }
      }
      if (!store.writable) {
        openMenu(undefined)
        return
      }
      const accepted = await write(remote, { enabled: !store.enabled })
      if (!accepted) openMenu(undefined)
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
     * The gear menu.
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
          'button',
          {
            type: 'button',
            className: 'fm-menu__head',
            'data-on': on ? 'true' : 'false',
            'aria-pressed': on,
            onClick: () => { void clickBolt(remote) },
          },
          react.createElement('span', { className: 'fm-menu__dot', 'data-on': on ? 'true' : 'false' }),
          react.createElement('span', { className: 'fm-menu__title' }, on ? t('menu.headOn') : t('menu.headOff')),
          react.createElement('span', { className: 'fm-menu__hint' }, store.busy ? t('menu.busy') : t(on ? 'menu.toggleOn' : 'menu.toggleOff')),
        ),
        react.createElement('div', { className: 'fm-menu__sep' }),
      ]

      for (const entry of GEAR_MENU) {
        children.push(react.createElement(
          'button',
          {
            key: entry.id,
            type: 'button',
            className: 'fm-menu__item',
            'data-current': store.gear === entry.id ? 'true' : 'false',
            'aria-label': `${t(`gears.${entry.id}`)} ${t('menu.speed')} ~${formatX(entry.speed)} ${t('menu.tokens')} ~${formatX(entry.tokens)}`,
            onClick: () => { void chooseGear(remote, entry.id) },
          },
          react.createElement('span', { className: 'fm-menu__name' }, t(`gears.${entry.id}`)),
          react.createElement(
            'span',
            { className: 'fm-menu__meter' },
            `${t('menu.speed')} ~${formatX(entry.speed)} · ${t('menu.tokens')} ~${formatX(entry.tokens)}`,
          ),
          react.createElement('span', { className: 'fm-menu__tick', 'data-empty': store.gear === entry.id ? 'false' : 'true' }),
        ))
      }

      children.push(react.createElement('div', { className: 'fm-menu__note' }, t('menu.note')))
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
     * The chip itself: a bolt that toggles, and a caret that opens the gear menu.
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
            'data-busy': store.busy ? 'true' : 'false',
            'aria-pressed': on,
            'aria-label': t(on ? 'chip.on' : 'chip.off'),
            title,
            onClick: () => { void clickBolt(remote) },
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
        react.createElement('button', {
          type: 'button',
          className: 'fm-chip__caret',
          'aria-haspopup': 'dialog',
          'aria-expanded': store.menu !== undefined,
          'aria-label': t('menu.open'),
          title: t('menu.open'),
          onClick: (event) => {
            toggleMenu(event && event.currentTarget)
            if (store.phase !== 'ready') void refresh(remote)
          },
        }),
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
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'fast-mode: dictionaries')

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
