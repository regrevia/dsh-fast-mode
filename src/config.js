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
 * knob (`metrics`, `metricsFile`, `benchmarkFile`, `debug`, `debugFile`,
 * `toolTimeoutMs`, `stallGuard`, `reassertAfterCompaction`) is a
 * composition-level troubleshooting value: schemastery passes undeclared keys
 * through untouched, so a hand-written patch keeps working without cluttering
 * the form.
 *
 * `enabled` defaults to **false** on purpose: opt-in is what makes "off means
 * completely off" verifiable. Nothing here can change the model's thinking
 * effort — the old `floor` / `ladder` / `aliases` knobs are gone, along with the
 * code that read them.
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
    .description('开启 Fast 模式 / Turn fast mode on. 触发更宽的工具并行、更少的过程文字、单次工具调用上限；不改动思考强度。关闭时完全回到原生行为。'),

  gear: z
    .union(GEAR_NAMES.map(name => z.const(name)))
    .default('auto')
    .volatile()
    .description(
      '调度 / Schedule: auto 是唯一面向用户的档位——按会话实测的步数与工具延迟自选并行宽度和单次调用上限。safe 表示完全不干预；fast/turbo/max/ludicrous 是旧的固定宽度，保留给实验脚本，配置里写它们会被当作 auto 并打一条弃用日志。所有档位都不改变思考强度。',
    ),

  parallel: z
    .number()
    .step(1)
    .min(1)
    .max(8)
    .volatile()
    .description(
      '并行上限 / Parallel ceiling: 覆盖每步并行目标；auto 下只作为初始值，调度器会随后续步骤调整（1 表示不注入批量提示）。',
    ),

  sessions: z
    .string()
    .default('')
    .volatile()
    .description(
      '会话级覆盖 / Per-session overrides（插件自动维护，请勿手动编辑）: {"sessionId":{"enabled":true}}。闪电每次点击只写本会话的条目；没有条目的会话沿用 enabled/gear，也就是“上次的选择”。重启后按条目恢复，所以每个会话记得自己的状态。',
    ),

  outputDiscipline: z
    .boolean()
    .default(true)
    .description(
      '输出纪律 / Output discipline: 让模型少写过程、只在结论处落笔（实测同一任务把每步可见输出从约 640 降到约 190 token，墙钟快约三分之一）。默认开启；关掉后只注入并行提示，不干预文风。',
    ),

  shellParallel: z
    .boolean()
    .default(false)
    .description(
      'shell_parallel 工具 / Shell fan-out tool: 注册一个单次调用内跑多个独立 shell 作业的工具。默认关闭——2026-10-24 实测：模型本来就会用 `&` + `wait` 把独立命令并行起来（6 个 5 秒作业 5.1 秒跑完），而多一个工具反而诱发“再复核一遍”的额外步骤，同一 fixture 墙钟从 9.1 秒涨到 16–26 秒。需要时再打开。',
    ),

  guidance: z
    .boolean()
    .default(true)
    .description(
      '提示段 / Prompt section: 是否向模型注入并行提示与输出纪律。关闭后调度、宽度计算、看门狗都照常，只是不再往系统提示里写任何一句话——用于把“写提示词的效果”和“harness 层面的效果”分开测量。',
    ),

  stallGuard: z
    .boolean()
    .default(true)
    .description(
      '卡顿看门狗 / Stall guard: 给单次工具调用加上限。auto 下默认 120 秒，并按最近调用的实际延迟在 2–5 分钟之间自适应；safe 不限。超时就取消这次调用并把“换个做法重试”写回给模型。只作用于 shell/脚本类工具，问用户、等后台任务、等子代理这类本来就要等的调用不受影响。',
    ),

  toolTimeoutMs: z
    .number()
    .default(0)
    .description(
      '单次工具调用上限 / Per-call ceiling in milliseconds: 0 = 自适应（见 stallGuard），负数 = 关闭看门狗，正数 = 一律使用这个值。',
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
