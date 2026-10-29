#!/usr/bin/env python3
"""How much of a run is not model time, and does fast mode enlarge that share?

Every suite row carries two clocks: `wall` (the headless process, task issue to
exit) and `llm` (time spent inside model calls). Their difference is everything
the plugin can actually make worse — tool execution, host scheduling, and the
plugin's own per-step work. If fast mode won by moving cost into that bucket the
wall ratio would still look good while the run got heavier, so the split is
worth printing next to every wall ratio.

Two questions, answered separately:

  share      overhead / wall, per arm. A ratio near 1.0 means the arms carry the
             same non-model load; a ratio above 1.1 means the fast arm is doing
             something expensive outside the model.
  perStep    overhead / step, per arm. Steps differ between arms by design, so
             this is the fair overhead comparison: it asks whether one step got
             more expensive, not whether there are fewer steps.

Validity is the bench rule (`pool.py`): a cell counts only when
`exit == 0 and steps >= 1 and out > 0 and hasSessionIds and not leak`. Pairs are
matched inside `(tag, task, pair)`, never across blocks.

    python3 bench/overhead.py --blocks COMBO2,COMBO3
    python3 bench/overhead.py --blocks COMBO2 --base off --arm def15 --json
"""
import argparse
import glob
import json
import pathlib
import statistics
from collections import defaultdict

HERE = pathlib.Path(__file__).resolve().parent
RESULTS = HERE / 'results'

RETRACTED = ('V15', 'TA3', 'TA4')


def valid(row):
    return (row.get('exit') == 0 and row.get('steps', 0) >= 1
            and row.get('out', 0) > 0
            and row.get('hasSessionIds', row.get('exact'))
            and not row.get('leak'))


def load(blocks):
    rows = {}
    for path in sorted(glob.glob(str(RESULTS / 'suite-*.jsonl'))):
        tag = path.split('suite-')[1][:-len('.jsonl')]
        if blocks and tag not in blocks:
            continue
        if tag in RETRACTED:
            continue
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            row['tag'] = tag
            rows[(tag, row['task'], row['pair'], row['arm'])] = row
    return rows


def clocks(row):
    wall = float(row.get('wall') or 0)
    llm = float(row.get('llm') or 0)
    return wall, max(0.0, wall - llm)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--blocks', default='', help='comma-separated tags; empty = all')
    ap.add_argument('--base', default='off')
    ap.add_argument('--arm', default='def15')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    blocks = tuple(b for b in args.blocks.split(',') if b)

    rows = load(blocks)
    arms = defaultdict(list)          # arm -> [(wall, overhead, steps)]
    for row in rows.values():
        if not valid(row):
            continue
        wall, over = clocks(row)
        if wall <= 0:
            continue
        arms[row['arm']].append((wall, over, int(row['steps'])))

    report = {}
    for arm, cells in sorted(arms.items()):
        wall = [c[0] for c in cells]
        over = [c[1] for c in cells]
        steps = sum(c[2] for c in cells)
        report[arm] = {
            'n': len(cells),
            'wallMedian': round(statistics.median(wall), 1),
            'overheadMedian': round(statistics.median(over), 1),
            'share': round(sum(over) / sum(wall), 4),
            'perStep': round(sum(over) / steps, 3) if steps else None,
        }

    pairs = []
    for (tag, task, pair, arm), row in rows.items():
        if arm != args.arm or not valid(row):
            continue
        base = rows.get((tag, task, pair, args.base))
        if base is None or not valid(base):
            continue
        bw, bo = clocks(base)
        aw, ao = clocks(row)
        if bw <= 0 or aw <= 0:
            continue
        pairs.append({
            'tag': tag, 'task': task, 'pair': pair,
            'wallRatio': round(aw / bw, 4),
            'overheadRatio': round(ao / bo, 4) if bo > 0 else None,
            'baseShare': round(bo / bw, 4),
            'armShare': round(ao / aw, 4),
        })

    if args.json:
        print(json.dumps({'arms': report, 'pairs': pairs}, indent=2))
        return

    print(f'{"arm":<12}{"n":>4}{"wall":>10}{"overhead":>11}{"share":>8}{"perStep":>9}')
    for arm, r in report.items():
        print(f'{arm:<12}{r["n"]:>4}{r["wallMedian"]:>10}{r["overheadMedian"]:>11}'
              f'{r["share"]:>8.3f}{r["perStep"]:>9.2f}')

    if pairs:
        wr = [p['wallRatio'] for p in pairs]
        ov = [p['overheadRatio'] for p in pairs if p['overheadRatio'] is not None]
        bs = [p['baseShare'] for p in pairs]
        as_ = [p['armShare'] for p in pairs]
        print(f'\n{args.arm} vs {args.base}: {len(pairs)} matched pairs')
        print(f'  wall ratio      median {statistics.median(wr):.3f}')
        if ov:
            print(f'  overhead ratio  median {statistics.median(ov):.3f}'
                  f'  ({sum(1 for x in ov if x < 1)}/{len(ov)} pairs lighter)')
        print(f'  overhead share  {args.base} {statistics.median(bs):.3f}'
              f' -> {args.arm} {statistics.median(as_):.3f}')


if __name__ == '__main__':
    main()
