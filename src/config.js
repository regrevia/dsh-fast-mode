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
 * The four form fields (`enabled`, `gear`, `parallel`, `sessions`) are `.volatile()`: that
 * is what makes them appear in the generated form *and* what lets an edit reach
 * a running fiber instead of forcing a remount. A non-volatile declaration is
 * invisible in the form — `describe()` drops it and `update()` refuses the path
 * with "is not volatile". The measurement paths below are deliberately *not*
 * volatile: they are read once at load, like `debugFile`.
 *
 * Only the fields that belong on a settings page are declared. Every other
 * knob (`floor`, `ladder`, `aliases`, `deepAfter`, `slowMs`, `bigChars`,
 * `window`, `holdTools`, `escalateAfterStep`, `discoverTimeoutMs`,
 * `baselineFromDefault`, `metrics`, `metricsFile`, `benchmarkFile`, `debug`,
 * `debugFile`, `stallGuard`, `toolTimeoutMs`, `reassertAfterCompaction`) is a
 * composition-level
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
      '档位 / Gear: safe < fast < turbo < max < ludicrous。档位拧的是“用 token 换往返次数”：并行目标 4/6/8/8 次调用，turbo 起再加投机预读与更严的输出纪律，同时越高的档越早把推理档压下来。safe 完全不干预；ludicrous 连思考档一起取消（reasoning off），只适合明确不要质量的批量任务。',
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

  sessions: z
    .string()
    .default('')
    .volatile()
    .description(
      '会话级覆盖 / Per-session overrides（插件自动维护，请勿手动编辑）: {"sessionId":{"enabled":true,"gear":"turbo"}}。渲染闪电面板时按会话读写；没有条目的会话沿用 enabled/gear，也就是“上次的选择”。',
    ),

  outputDiscipline: z
    .boolean()
    .default(true)
    .description(
      '输出纪律 / Output discipline: 让模型少写过程、只在结论处落笔（实测同一任务把每步可见输出从约 640 降到约 190 token，墙钟快约三分之一）。默认开启；关掉后只注入并行提示，不干预文风。',
    ),

  stallGuard: z
    .boolean()
    .default(true)
    .description(
      '卡顿看门狗 / Stall guard: 给单次工具调用加按档位收紧的上限（safe 不限；fast 300s、turbo 180s、max 120s、ludicrous 90s）。超时就取消这次调用并把“换个做法重试”写回给模型。只作用于 shell/脚本类工具，问用户、等后台任务、等子代理这类本来就要等的调用不受影响。',
    ),

  toolTimeoutMs: z
    .number()
    .default(0)
    .description(
      '单次工具调用上限 / Per-call ceiling in milliseconds: 0 = 按档位（见 stallGuard），负数 = 关闭看门狗，正数 = 所有档位都用这个值。',
    ),

  reassertAfterCompaction: z
    .boolean()
    .default(true)
    .description(
      '压缩后补提醒 / Reassert after compaction: 上下文被压缩后，在下一次请求里写一条极短的 notice，重申批量调用与有界调用两条规则。默认开启；关掉后提示段仍然生效，只是不再补这条消息。',
    ),

  metrics: z
    .boolean()
    .default(true)
    .description(
      '记录每步耗时与 token / Record per-step latency and tokens: 写入 metricsFile，用于对比开启与关闭档位的真实效果。默认开启，关闭则不写任何文件。',
    ),

  metricsFile: z
    .string()
    .default('~/.dsh/fast-mode-metrics.jsonl')
    .description(
      '计量文件 / Metrics file: 每步一行的 JSONL（会话、档位、首字延迟、模型耗时、输出 token、工具调用数）。',
    ),

  benchmarkFile: z
    .string()
    .default('~/.dsh/fast-mode-bench.json')
    .description(
      '实验分配文件 / Experiment assignment file: 存在且 enabled=true 时按会话哈希分配档位（内容 {"enabled":true,"gears":[...]}）；默认文件不存在即不启用，改动最多 1 秒生效。',
    ),
})
