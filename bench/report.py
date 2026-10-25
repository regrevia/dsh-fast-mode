#!/usr/bin/env python3
"""Turn suite-run.py JSONL into the numbers quoted in BENCHMARK.md.

Reads one or more resumable result files, dedupes rows by (task, pair, arm)
keeping the last occurrence (a rerun supersedes the earlier attempt), then reports:

  * reds (any arm that failed its hidden tests), including the gate check:
    "baseline green but this arm red" is a disqualifying result;
  * totals per arm over complete cells (every requested arm present and green),
    with ratios against --baseline;
  * the same per family;
  * paired wall-clock ratios (per (task, pair) cell) with the win count;
  * tail shape per arm: wall p50 / p90 / max and max steps.

Usage:
  python3 bench/report.py --files bench/results/suite-V15.jsonl --baseline off
  python3 bench/report.py --files bench/results/suite-TA4.jsonl --baseline def15 --arm open15
"""
import argparse
import collections
import json
import statistics as st


def load(files, dedupe='last'):
    """Dedupe by (task, pair, arm).

    A cell that was rerun appears more than once; the later row is the
    measurement that counts, so the default keeps the last occurrence. Pass
    dedupe='first' to inspect the pre-rerun block instead.
    """
    kept = {}
    for path in files:
        for line in open(path):
            if not line.strip():
                continue
            r = json.loads(line)
            key = (r['task'], r['pair'], r['arm'])
            if dedupe == 'first' and key in kept:
                continue
            kept[key] = r
    return list(kept.values())


def pct(values, q):
    if not values:
        return float('nan')
    values = sorted(values)
    k = (len(values) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--files', nargs='+', required=True)
    ap.add_argument('--baseline', required=True)
    ap.add_argument('--arm', nargs='*', default=None,
                    help='arms to report (default: every arm present)')
    ap.add_argument('--dedupe', choices=['first', 'last'], default='last')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()

    rows = load(a.files, a.dedupe)
    arms = a.arm or sorted({r['arm'] for r in rows})
    if a.baseline not in arms:
        arms.insert(0, a.baseline)
    cells = collections.defaultdict(dict)
    for r in rows:
        if r['arm'] in arms:
            cells[(r['task'], r['pair'])][r['arm']] = r

    reds = [r for r in rows if r['arm'] in arms and not (r['exit'] == 0 and r['green'])]
    gate = []
    for key, cell in sorted(cells.items()):
        base = cell.get(a.baseline)
        if not base or not (base['exit'] == 0 and base['green']):
            continue
        for arm, r in cell.items():
            if arm != a.baseline and not (r['exit'] == 0 and r['green']):
                gate.append({'task': key[0], 'pair': key[1], 'arm': arm,
                             'armGreen': r['green'], 'armExit': r['exit'],
                             'baselinePassed': f"{base['passed']}/{base['total']}"})

    complete = {k: v for k, v in cells.items()
                if all(x in v and v[x]['exit'] == 0 and v[x]['green'] for x in arms)}
    totals = collections.defaultdict(lambda: [0.0, 0, 0])
    per = collections.defaultdict(lambda: collections.defaultdict(lambda: [0.0, 0, 0, 0]))
    for (task, _pair), cell in complete.items():
        for arm in arms:
            r = cell[arm]
            totals[arm][0] += r['wall']
            totals[arm][1] += r['out']
            totals[arm][2] += r['steps']
            t = per[task][arm]
            t[0] += r['wall']
            t[1] += r['out']
            t[2] += r['steps']
            t[3] += 1

    base = totals[a.baseline]
    out = {'rows': len(rows), 'arms': arms, 'baseline': a.baseline,
           'completeCells': len(complete), 'reds': reds, 'gateViolations': gate,
           'totals': {}, 'perFamily': {}, 'paired': {}, 'tail': {}}
    for arm in arms:
        w, o, s = totals[arm]
        out['totals'][arm] = {'cells': len(complete), 'wall': round(w, 1),
                              'out': o, 'steps': s,
                              'wallRatio': round(w / base[0], 3),
                              'outRatio': round(o / base[1], 3),
                              'stepRatio': round(s / base[2], 3)}
    for task in sorted(per):
        entry = {}
        b = per[task][a.baseline]
        for arm in arms:
            w, o, s, n = per[task][arm]
            entry[arm] = {'cells': n, 'wall': round(w, 1), 'out': o, 'steps': s,
                          'wallRatio': round(w / b[0], 3),
                          'outRatio': round(o / b[1], 3),
                          'stepRatio': round(s / b[2], 3)}
        out['perFamily'][task] = entry
    for arm in arms:
        if arm == a.baseline:
            continue
        ratios = [cell[arm]['wall'] / cell[a.baseline]['wall']
                  for cell in complete.values() if cell[a.baseline]['wall'] > 0]
        out['paired'][arm] = {'medianWallRatio': round(st.median(ratios), 3) if ratios else None,
                              'faster': sum(x < 1 for x in ratios), 'cells': len(ratios)}
    for arm in arms:
        mine = [r for r in rows if r['arm'] == arm and r['exit'] == 0 and r['green']]
        walls = [r['wall'] for r in mine]
        out['tail'][arm] = {'runs': len(mine),
                            'p50': round(pct(walls, 0.5), 1) if walls else None,
                            'p90': round(pct(walls, 0.9), 1) if walls else None,
                            'max': round(max(walls), 1) if walls else None,
                            'maxSteps': max((r['steps'] for r in mine), default=None)}

    if a.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return
    print(f"rows {out['rows']}  arms {','.join(arms)}  baseline {a.baseline}  "
          f"complete cells {out['completeCells']}")
    if reds:
        print(f"reds {len(reds)}: " + ', '.join(
            f"{r['task']} p{r['pair']} {r['arm']}" for r in reds))
    if gate:
        print(f"GATE VIOLATIONS {len(gate)}: " + ', '.join(
            f"{g['task']} p{g['pair']} {g['arm']} (baseline {g['baselinePassed']} green)"
            for g in gate))
    print(f"\n{'arm':<10}{'cells':>6}{'wall s':>10}{'wall x':>8}{'out tok':>11}{'out x':>7}"
          f"{'steps':>8}{'step x':>7}")
    for arm in arms:
        t = out['totals'][arm]
        print(f"{arm:<10}{t['cells']:>6}{t['wall']:>10.1f}{t['wallRatio']:>8.2f}"
              f"{t['out']:>11}{t['outRatio']:>7.2f}{t['steps']:>8}{t['stepRatio']:>7.2f}")
    print(f"\n{'family':<13}{'n':>3}  per-arm wall/out/step ratios vs {a.baseline}")
    for task, entry in out['perFamily'].items():
        parts = [f"{arm} {e['wallRatio']:.2f}/{e['outRatio']:.2f}/{e['stepRatio']:.2f}"
                 for arm, e in entry.items() if arm != a.baseline]
        print(f"{task:<13}{entry[a.baseline]['cells']:>3}  " + '   '.join(parts))
    for arm, p in out['paired'].items():
        print(f"\npaired wall {arm}/{a.baseline}: median {p['medianWallRatio']}x, "
              f"faster in {p['faster']}/{p['cells']} cells")
    print(f"\n{'arm':<10}{'runs':>5}{'p50 s':>9}{'p90 s':>9}{'max s':>9}{'max steps':>10}")
    for arm in arms:
        t = out['tail'][arm]
        print(f"{arm:<10}{t['runs']:>5}{t['p50']:>9}{t['p90']:>9}{t['max']:>9}{t['maxSteps']:>10}")


if __name__ == '__main__':
    main()
