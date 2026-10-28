#!/usr/bin/env python3
"""Paired wall-clock analysis for one two-arm block.

Usage: block_score.py TAG BASE ARM [--min-steps N] [--json]

Ratios are computed inside each (task, pair) cell so machine load cancels.
A row is usable only when the runner marked it as attributable to its own
session ids (field `hasSessionIds`, formerly `exact`) and green with a real transcript; probe-dead rows (one step, zero output, ~2 s wall) are dropped and
counted separately, never averaged in.
"""
import json
import math
import pathlib
import statistics
import sys

ROOT = pathlib.Path('/Users/apple/Desktop/DSH/dsh-fast-mode')


def usable(row, min_steps):
    if not row:
        return False
    # steps/out are attributable only if the run reported its own session ids;
    # the legacy field name for that boolean was `exact`.
    if row.get('exit') != 0 or not row.get('hasSessionIds', row.get('exact')) or row.get('leak'):
        return False
    if not row.get('green', True):
        return False
    return row.get('steps', 0) >= min_steps and row.get('out', 0) > 0


def geo(values):
    return math.exp(sum(math.log(v) for v in values) / len(values)) if values else float('nan')


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith('--')]
    tag, base_arm, arm = argv[0], argv[1], argv[2]
    min_steps = 3
    if '--min-steps' in sys.argv:
        min_steps = int(sys.argv[sys.argv.index('--min-steps') + 1])
    rows = [json.loads(l) for l in (ROOT / f'bench/results/suite-{tag}.jsonl').read_text().splitlines() if l.strip()]
    cells = {}
    for row in rows:
        cells.setdefault((row['task'], row['pair']), {})[row['arm']] = row
    wall, steps, out = [], [], []
    dropped = []
    for (task, pair), arms in sorted(cells.items()):
        b, a = arms.get(base_arm), arms.get(arm)
        if not (usable(b, min_steps) and usable(a, min_steps)):
            dropped.append(f'{task} p{pair}')
            continue
        wall.append(a['wall'] / b['wall'])
        steps.append(a['steps'] / b['steps'])
        out.append(a['out'] / b['out'])
        print(f'{task:14s} p{pair}  {base_arm}={b["wall"]:7.1f}s  {arm}={a["wall"]:7.1f}s  '
              f'wall={wall[-1]:.3f}  steps {b["steps"]}->{a["steps"]}  out {b["out"]}->{a["out"]}')
    n = len(wall)
    print(f'\n{tag}: {n} usable pair(s), dropped {len(dropped)}'
          + (f' ({", ".join(dropped)})' if dropped else ''))
    if not n:
        sys.exit(1)
    wins = sum(1 for v in wall if v < 1)
    print(f'wall  geo={geo(wall):.3f}  median={statistics.median(wall):.3f}  '
          f'wins={wins}/{n}  min={min(wall):.3f}  max={max(wall):.3f}')
    print(f'steps geo={geo(steps):.3f}  out geo={geo(out):.3f}')
    # exact sign test, two-sided
    if 0 < wins < n:
        tail = sum(math.comb(n, k) for k in range(min(wins, n - wins) + 1)) / 2 ** n
        print(f'sign test p={min(1.0, 2 * tail):.3f}')


if __name__ == '__main__':
    main()
