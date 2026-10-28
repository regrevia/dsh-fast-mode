#!/usr/bin/env python3
"""Pool every block and report each arm's marginal cost against its own block's anchor.

`pool.py` answers one question ("how does arm X compare with off, on the clean
blocks"). This script answers the question a user actually asks when they look at
the switch list: *what does each switch do on its own, and what happens when
several are on at once?*

Every suite block is an independent experiment with its own anchor arm, and the
arm names are the switch sets. So for each block, pick an anchor (`off` when the
block has it, otherwise `def15`), then pair each other arm with that anchor on
`(tag, task, pair)`. Ratios from different blocks are pooled because they are all
"arm ÷ anchor of the same block, same task, same pair" — the block, the clock and
the task family cancel out inside each pair.

Two honest caveats, printed with the table:

  * arms are not tested on the same task mix; the `tasks` column is the whole
    reason a row can look good (an arm measured only on `ledger` is not a
    statement about `migrate`);
  * a block is one sampling. `REP2` and `LEN3` showed block-level ratios swing
    0.65x-1.79x in *both* directions, so anything with n below ~20 pairs is a
    direction hint, not a number. The sign test p-value is printed for that
    reason and nothing here is significant without it.

    python3 bench/ablate.py [--anchor off] [--min-pairs 1] [--json]
"""
import argparse
import glob
import json
import math
import pathlib
import statistics
from collections import defaultdict

HERE = pathlib.Path(__file__).resolve().parent
RESULTS = HERE / 'results'

# Blocks whose fixtures leaked; their `llm` column is an artefact (see pool.py).
RETRACTED = ('V15', 'TA3', 'TA4')


def valid(row):
    return (row.get('exit') == 0 and row.get('steps', 0) >= 1
            and row.get('out', 0) > 0
            and row.get('hasSessionIds', row.get('exact'))
            and not row.get('leak'))


def load_all():
    """tag -> (task, pair) -> {arm: row}, last write wins like the report."""
    blocks = defaultdict(lambda: defaultdict(dict))
    for path in sorted(glob.glob(str(RESULTS / 'suite-*.jsonl'))):
        tag = path.split('suite-')[1][:-len('.jsonl')]
        if tag in RETRACTED:
            continue
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            blocks[tag][(row['task'], row['pair'])][row['arm']] = row
    return blocks


def anchor_for(arms, wanted):
    if wanted in arms:
        return wanted
    if 'off' in arms:
        return 'off'
    if 'def15' in arms:
        return 'def15'
    return None


def sign_p(k, n):
    from math import comb
    if n == 0:
        return None
    tail = sum(comb(n, i) for i in range(0, min(k, n - k) + 1)) / 2 ** n
    return round(min(1.0, 2 * tail), 4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--anchor', default='off', help="preferred anchor arm name")
    ap.add_argument('--min-pairs', type=int, default=1)
    ap.add_argument('--ci', type=int, default=0,
                    help='bootstrap resamples for a 95%% CI on the geometric mean')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    blocks = load_all()
    per_arm = defaultdict(lambda: {'ratios': [], 'steps': [], 'outs': [],
                                   'tasks': defaultdict(int), 'tags': defaultdict(int),
                                   'anchors': defaultdict(int), 'walls': 0.0, 'anchor_walls': 0.0})
    for tag, cells in blocks.items():
        for (task, pair), arms in cells.items():
            anchor = anchor_for(arms, args.anchor)
            if not anchor:
                continue
            base = arms[anchor]
            if not valid(base):
                continue
            for name, row in arms.items():
                if name == anchor or not valid(row):
                    continue
                a = per_arm[name]
                a['ratios'].append(row['wall'] / base['wall'])
                a['steps'].append(row['steps'] / base['steps'] if base['steps'] else 1.0)
                a['outs'].append(row['out'] / base['out'] if base['out'] else 1.0)
                a['tasks'][task] += 1
                a['tags'][tag] += 1
                a['anchors'][anchor] += 1
                a['walls'] += row['wall']
                a['anchor_walls'] += base['wall']

    rows = []
    for name, a in per_arm.items():
        n = len(a['ratios'])
        if n < args.min_pairs:
            continue
        geo = math.exp(sum(math.log(r) for r in a['ratios']) / n)
        ratio = a['walls'] / a['anchor_walls']
        wins = sum(1 for r in a['ratios'] if r < 1)
        ci = None
        if args.ci > 0 and n >= 3:
            import random
            rnd = random.Random(20261029)
            draws = []
            for _ in range(args.ci):
                sample = [a['ratios'][rnd.randrange(n)] for _ in range(n)]
                draws.append(math.exp(sum(math.log(r) for r in sample) / n))
            draws.sort()
            lo, hi = int(0.025 * len(draws)), int(0.975 * len(draws)) - 1
            ci = [round(draws[lo], 4), round(draws[hi], 4)]
        rows.append({
            'arm': name,
            'pairs': n,
            'wall_geo': round(geo, 4),
            'wall_total': round(ratio, 4),
            'wall_median': round(statistics.median(a['ratios']), 4),
            'steps_geo': round(math.exp(sum(math.log(s) for s in a['steps']) / n), 4),
            'out_geo': round(math.exp(sum(math.log(o) for o in a['outs']) / n), 4),
            'faster': wins,
            'sign_p': sign_p(wins, n),
            'geo_ci95': ci,
            'tasks': dict(sorted(a['tasks'].items(), key=lambda kv: -kv[1])),
            'blocks': len(a['tags']),
            'anchors': dict(a['anchors']),
        })
    rows.sort(key=lambda r: r['wall_geo'])

    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return

    print(f"anchor={args.anchor} (falls back to off/def15 per block), blocks={len(blocks)}")
    print(f"{'arm':10s} {'n':>4s} {'geo (ci95)':>22s} {'median':>7s} {'total':>7s} "
          f"{'steps':>6s} {'out':>6s} {'faster':>9s} {'p':>6s} {'blk':>4s}  tasks")
    for r in rows:
        tasks = ', '.join(f'{k}:{v}' for k, v in list(r['tasks'].items())[:3])
        ci = f" [{r['geo_ci95'][0]:.3f},{r['geo_ci95'][1]:.3f}]" if r['geo_ci95'] else ''
        print(f"{r['arm']:10s} {r['pairs']:4d} {r['wall_geo']:7.3f}{ci:<15s} {r['wall_median']:7.3f} "
              f"{r['wall_total']:7.3f} {r['steps_geo']:6.3f} {r['out_geo']:6.3f} "
              f"{r['faster']:4d}/{r['pairs']:<4d} {str(r['sign_p']):>6s} {r['blocks']:4d}  {tasks}")
    print('\nRead this as a direction table, not as per-switch numbers: rows are '
          'measured on different task mixes and each block is one sampling.')


if __name__ == '__main__':
    main()
