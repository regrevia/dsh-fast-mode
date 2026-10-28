#!/usr/bin/env python3
"""Pool every clean block and recompute the default arm against `off`.

The published headline used to be a per-block number (1.5.1: 0.72x). That is a
number about *one* block. This script answers the bigger question — with every
clean block we have, paired against the `off` arm of its *own* block, what is
the total wall-clock ratio? It mixes nothing across blocks: a pair only counts
when both cells are valid and live in the same `(tag, task, pair)`.

Validity is the bench rule, not `green`: `exit == 0 and steps >= 1 and out > 0
and hasSessionIds and not leak`. `green` only says the hidden assertions passed; a
crashed session that wrote nothing can still be green, so it cannot be used as
a unit of measurement.

Retracted blocks (V15, TA3, TA4) are skipped by name: their fixtures leaked and
their `llm` column is a byte-window artefact.

    python3 bench/pool.py [--arm def15] [--blocks W1,W3,...]
"""
import argparse
import glob
import json
import pathlib
import statistics
from collections import defaultdict

HERE = pathlib.Path(__file__).resolve().parent
RESULTS = HERE / 'results'

# Blocks measured under the current validity rule, with an `off` anchor.
CLEAN = ('W1', 'W3', 'W5', 'W6', 'W7', 'W8b', 'REL16', 'PPX2', 'SG2',
         'NX1_IMPL', 'NX1_PIPE', 'NX1_SG')
RETRACTED = ('V15', 'TA3', 'TA4')


def valid(row):
    return (row.get('exit') == 0 and row.get('steps', 0) >= 1
            and row.get('out', 0) > 0
            and row.get('hasSessionIds', row.get('exact'))
            and not row.get('leak'))


def load(blocks):
    rows = {}
    seen = defaultdict(int)
    for path in sorted(glob.glob(str(RESULTS / 'suite-*.jsonl'))):
        tag = path.split('suite-')[1][:-len('.jsonl')]
        if tag not in blocks:
            continue
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            row['tag'] = tag
            key = (tag, row['task'], row['pair'], row['arm'])
            if key in rows:
                seen[key] += 1          # keep the last write, like the report
            rows[key] = row
    return rows, seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm', default='def15')
    ap.add_argument('--blocks', default=','.join(CLEAN))
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--ci', type=int, default=0,
                    help='bootstrap resamples for a 95%% CI on the pooled ratio')
    args = ap.parse_args()
    blocks = tuple(b for b in args.blocks.split(',') if b)

    rows, dups = load(blocks)
    cells = defaultdict(dict)
    for (tag, task, pair, arm), row in rows.items():
        cells[(tag, task, pair)][arm] = row

    per_block = defaultdict(lambda: [0.0, 0.0, 0.0, 0, 0])
    per_task = defaultdict(lambda: [0.0, 0.0, 0, 0])
    total = [0.0, 0.0, 0, 0, 0, 0.0, 0.0]   # arm wall, off wall, arm steps, off steps, n, arm out, off out
    ratios = []
    pairs = []                            # (arm wall, off wall) for bootstrap
    for (tag, task, pair), arms in sorted(cells.items()):
        a, b = arms.get('off'), arms.get(args.arm)
        if not (a and b and valid(a) and valid(b)):
            continue
        total[0] += b['wall']; total[1] += a['wall']
        total[2] += b['steps']; total[3] += a['steps']; total[4] += 1
        total[5] += b['out']; total[6] += a['out']
        ratios.append(b['wall'] / a['wall'])
        pairs.append((b['wall'], a['wall']))
        blk = per_block[tag]
        blk[0] += b['wall']; blk[1] += a['wall']; blk[2] += b['out'] / a['out'] if a['out'] else 1
        blk[3] += 1; blk[4] += b['wall'] < a['wall']
        tsk = per_task[task]
        tsk[0] += b['wall']; tsk[1] += a['wall']
        tsk[2] += 1; tsk[3] += b['wall'] < a['wall']

    # The sum ratio answers "what does a whole workload cost", but it is dominated by
    # whichever pairs happened to be expensive; the geometric mean of per-pair ratios
    # answers "what does a typical pair cost" and is the more stable estimator. Report
    # both, never only one.
    import math
    geo = math.exp(sum(math.log(r) for r in ratios) / len(ratios)) if ratios else 0.0
    wins = sum(1 for r in ratios if r < 1)
    # exact two-sided sign test against "no effect" (p = 0.5)
    def _sign_p(k, n):
        from math import comb
        tail = sum(comb(n, i) for i in range(0, min(k, n - k) + 1)) / 2 ** n
        return min(1.0, 2 * tail)
    out = {
        'arm': args.arm,
        'blocks': list(blocks),
        'pairs': total[4],
        'wall_total_ratio': round(total[0] / total[1], 4),
        'steps_total_ratio': round(total[2] / total[3], 4),
        'wall_median_ratio': round(statistics.median(ratios), 4),
        'wall_geo_ratio': round(geo, 4),
        'out_total_ratio': round(total[5] / total[6], 4) if total[6] else None,
        'sign_test_p': round(_sign_p(wins, len(ratios)), 4) if ratios else None,
        'faster': wins,
        'duplicate_keys': len(dups),
        'per_block': {k: {'n': v[3], 'wall': round(v[0] / v[1], 4), 'faster': v[4]}
                      for k, v in sorted(per_block.items())},
        'per_task': {k: {'n': v[2], 'wall': round(v[0] / v[1], 4), 'faster': v[3]}
                     for k, v in sorted(per_task.items(), key=lambda kv: kv[1][0] / kv[1][1])},
    }
    if args.ci > 0 and pairs:
        import random
        rnd = random.Random(20261027)
        tot, med, geos = [], [], []
        for _ in range(args.ci):
            draw = [pairs[rnd.randrange(len(pairs))] for _ in range(len(pairs))]
            tot.append(sum(x for x, _ in draw) / sum(y for _, y in draw))
            med.append(statistics.median([x / y for x, y in draw]))
            geos.append(math.exp(sum(math.log(x / y) for x, y in draw) / len(draw)))
        tot.sort(); med.sort()
        lo, hi = int(0.025 * len(tot)), int(0.975 * len(tot)) - 1
        out['wall_total_ci95'] = [round(tot[lo], 4), round(tot[hi], 4)]
        out['wall_median_ci95'] = [round(med[lo], 4), round(med[hi], 4)]
        geos.sort()
        out['wall_geo_ci95'] = [round(geos[lo], 4), round(geos[hi], 4)]
        out['ci_resamples'] = args.ci

    if args.json:
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return

    print(f"arm={args.arm} blocks={','.join(blocks)}")
    print(f"pairs={out['pairs']} wall_total={out['wall_total_ratio']}x "
          f"steps_total={out['steps_total_ratio']}x median={out['wall_median_ratio']}x "
          f"geo={out['wall_geo_ratio']}x out_total={out['out_total_ratio']}x "
          f"faster={out['faster']}/{out['pairs']} sign_p={out['sign_test_p']} "
          f"dup_keys={out['duplicate_keys']}")
    if out.get('wall_total_ci95'):
        print(f"ci95 wall_total={out['wall_total_ci95']} median={out['wall_median_ci95']} "
              f"geo={out['wall_geo_ci95']} "
              f"({out['ci_resamples']} resamples)")
    print('\nblock            n   wall  faster')
    for k, v in out['per_block'].items():
        print(f'{k:12s} {v["n"]:4d} {v["wall"]:6.3f}  {v["faster"]}/{v["n"]}')
    print('\ntask              n   wall  faster')
    for k, v in out['per_task'].items():
        print(f'{k:14s} {v["n"]:4d} {v["wall"]:6.3f}  {v["faster"]}/{v["n"]}')


if __name__ == '__main__':
    main()
