#!/usr/bin/env python3
"""Paired A/B inside one block, with no `off` anchor.

`pool.py` answers "default against off"; the ablation arms answer a narrower
question — does arm B beat arm A when the *only* difference between them is one
flag? Those blocks have no `off` row, so pool.py cannot read them.

A pair counts only when both cells are valid by the bench rule
(`exit == 0 and steps >= 1 and out > 0 and hasSessionIds and not leak`). The ratio is
always treatment / baseline, so < 1 means the treatment was faster.

    python3 bench/ab.py BV8_IMPL --base def15 --treat bvl15
    python3 bench/ab.py --all-pairs D2_DBG,D2_MIG --base def15 --treat d2

Reports, per block: n, per-pair ratios, geometric mean, median, total-ratio
(sum treatment / sum base), faster count, two-sided exact sign-test p, plus
steps and output totals. Geometric mean and median are the only allowed
estimators here; the arithmetic mean of ratios is not reported because it is
dominated by heavy tails.
"""
import argparse
import importlib.util
import json
import math
import pathlib
import statistics
import sys
from collections import defaultdict

HERE = pathlib.Path(__file__).resolve().parent
RESULTS = HERE / 'results'


def _load_pool():
    spec = importlib.util.spec_from_file_location('pool', HERE / 'pool.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def sign_p(wins, n):
    """Two-sided exact binomial sign test, p = 0.5, ties dropped."""
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, k) for k in range(min(wins, n - wins) + 1))
    return min(1.0, 2 * tail / 2 ** n)


def load_block(tag, base, treat):
    path = RESULTS / f'suite-{tag}.jsonl'
    if not path.exists():
        return None
    rows = {}
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        rows[(row['task'], row['pair'], row['arm'])] = row
    pairs = defaultdict(dict)
    for (task, pair, arm), row in rows.items():
        if arm in (base, treat):
            pairs[(task, pair)][arm] = row
    return pairs


def summarise(tag, pairs, base, treat, pool):
    valid, rejected = [], []
    for (task, pair), cells in sorted(pairs.items()):
        if base not in cells or treat not in cells:
            continue
        b, t = cells[base], cells[treat]
        if not (pool.valid(b) and pool.valid(t)):
            rejected.append((task, pair, b.get('exit'), t.get('exit')))
            continue
        valid.append((task, pair, b, t))
    if not valid:
        print(f'{tag:10s} no valid pairs ({len(rejected)} rejected)')
        return None
    ratios = [t['wall'] / b['wall'] for _, _, b, t in valid]
    steps = [t['steps'] / b['steps'] for _, _, b, t in valid]
    outs = [t['out'] / b['out'] for _, _, b, t in valid]
    geo = math.exp(sum(math.log(r) for r in ratios) / len(ratios))
    faster = sum(1 for r in ratios if r < 1)
    sum_ratio = sum(t['wall'] for _, _, _, t in valid) / sum(b['wall'] for _, _, b, _ in valid)
    print(f'\n== {tag} : {treat} vs {base} ==')
    print(f'pairs={len(valid)}  geo={geo:.3f}x  median={statistics.median(ratios):.3f}x  '
          f'total={sum_ratio:.3f}x  faster={faster}/{len(valid)}  sign_p={sign_p(faster, len(valid)):.4f}')
    print(f'steps_geo={math.exp(sum(math.log(s) for s in steps) / len(steps)):.3f}x  '
          f'out_geo={math.exp(sum(math.log(o) for o in outs) / len(outs)):.3f}x  '
          f'range={min(ratios):.3f}-{max(ratios):.3f}')
    for task, pair, b, t in valid:
        print(f'  {task:14s} p{pair:<2d} wall {b["wall"]:8.2f} -> {t["wall"]:8.2f}  '
              f'{t["wall"] / b["wall"]:6.3f}x  steps {b["steps"]:3d}->{t["steps"]:<3d} '
              f'out {b["out"]:6d}->{t["out"]:<6d} green {int(bool(b.get("green")))}/{int(bool(t.get("green")))}')
    for task, pair, be, te in rejected:
        print(f'  REJECTED {task} p{pair} exit {be}/{te}')
    return dict(tag=tag, n=len(valid), geo=geo, median=statistics.median(ratios),
                total=sum_ratio, faster=faster)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('tags', nargs='*')
    ap.add_argument('--base', default='def15')
    ap.add_argument('--treat', required=True)
    ap.add_argument('--all-pairs', default='')
    a = ap.parse_args()
    tags = a.tags or [t for t in a.all_pairs.split(',') if t]
    if not tags:
        sys.exit('pass a tag or --all-pairs TAG,TAG')
    pool = _load_pool()
    out = []
    for tag in tags:
        pairs = load_block(tag, a.base, a.treat)
        if pairs is None:
            print(f'{tag:10s} no result file')
            continue
        s = summarise(tag, pairs, a.base, a.treat, pool)
        if s:
            out.append(s)
    if len(out) > 1:
        w = sum(s['n'] for s in out)
        print(f'\n== merged over {len(out)} blocks, {w} pairs ==')
        print('  ' + '  '.join(f'{s["tag"]}:{s["geo"]:.3f} ({s["faster"]}/{s["n"]})' for s in out))


if __name__ == '__main__':
    main()
