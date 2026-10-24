/**
 * The plugin's `Config` schema.
 *
 * Two audiences, one declaration:
 *
 * - The Loader validates a composition patch against it, so a typo in
 *   `cordis.patch.yml` is a load-time error instead of a silently ignored
 *   field.
 * - The `settings` service projects it into the Web UI's plugin page, which is
 *   why the on/off switch and the gear selector exist there without a line of
 *   client code.
 *
 * Every declared field is `.volatile()`: that is what makes it appear in the
 * generated form *and* what lets an edit reach a running fiber instead of
 * forcing a remount. A non-volatile declaration is invisible here — `describe()`
 * drops it from the form and `update()` refuses the path with "is not volatile".
 *
 * Only the fields that belong on a settings page are declared. Every other
 * knob (`floor`, `ladder`, `aliases`, `deepAfter`, `slowMs`, `bigChars`,
 * `window`, `holdTools`, `escalateAfterStep`, `discoverTimeoutMs`,
 * `baselineFromDefault`, `debug`, `debugFile`) is a composition-level
 * troubleshooting value: schemastery passes undeclared keys through untouched,
 * so a hand-written patch keeps working without cluttering the form.
 *
 * `enabled` defaults to **false** on purpose. Fast mode changes how much the
 * model deliberates, so it is opt-in: the composer chip starts hollow and the
 * user turns it on when they want speed over depth.
 *
 * @module dsh-fast-mode/config
 */
import z from '@deepseek-ai/schemastery'

import { GEARS } from './effort.js'

/**
 * The gear names, in ascending order, as a schema the settings page renders as
 * a selector.
 *
 * Built from `GEARS` rather than a second hand-written list: a gear that exists
 * in the policy but not in the form would be unselectable.
 */
const GEAR_NAMES = Object.keys(GEARS).sort((a, b) => GEARS[a].level - GEARS[b].level)

export const Config = z.object({
  enabled: z
    .boolean()
    .default(false)
    .volatile()
    .description('开启 Fast 模式 / Turn fast mode on. 关闭时不改写档位、不注入提示词。'),

  gear: z
    .union(GEAR_NAMES.map(name => z.const(name)))
    .default('fast')
    .volatile()
    .description(
      '档位 / Gear: safe < fast < turbo < max. 越高越早允许降档，模型侧并行目标 4/6/8 次调用；档位只抬高并行上限，不改变最低档位。',
    ),

  parallel: z
    .number()
    .step(1)
    .min(1)
    .max(8)
    .volatile()
    .description(
      '并行上限 / Parallel ceiling: 覆盖档位默认的每步并行目标（1 表示不注入批量提示）。',
    ),
})
