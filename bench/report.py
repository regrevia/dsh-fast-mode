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
  python3 bench/report.py --files bench/results/suite-W3.jsonl --baseline off
  python3 bench/report.py --files bench/results/suite-W4.jsonl --baseline def15 --arm bud8
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
    # A run whose transcript reached the fixture (hidden test or reference) cannot
    # be compared: it had the answer. Drop it rather than average it in.
    leaked = [r for r in rows if r.get('leak')]
    if leaked:
        rows = [r for r in rows if not r.get('leak')]
        print(f'leak: dropped {len(leaked)} run(s) that reached the fixture: '
              + ', '.join(f"{r['task']} p{r['pair']} {r['arm']}" for r in leaked))
    inexact = [r for r in rows if r.get('exact') is False]
    if inexact:
        print(f'warning: {len(inexact)} run(s) without session ids; steps/out use the '
              'old byte-window attribution and are not comparable')
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
    # A cell whose session ids were not captured, or where an arm's window came
    # back empty, has no honest denominator for tokens or steps. Counting it as a
    # zero would charge the arm for / credit it with work nobody measured, so the
    # cell still counts for wall (which is a wall-clock truth regardless) and is
    # dropped from the token and step sums with a printed note. Dropping it
    # silently would be the same defect in the other direction.
    totals = collections.defaultdict(lambda: [0.0, 0, 0])
    per = collections.defaultdict(lambda: collections.defaultdict(lambda: [0.0, 0, 0, 0]))
    tokenDrops = []
    for (task, pair), cell in complete.items():
        counted = all(cell[x].get('exact') is True and cell[x]['out'] > 0
                      and cell[x]['steps'] > 0 for x in arms)
        if not counted:
            tokenDrops.append({'task': task, 'pair': pair,
                               'inexact': [x for x in arms if cell[x].get('exact') is not True],
                               'empty': [x for x in arms if cell[x]['out'] <= 0 or cell[x]['steps'] <= 0]})
        for arm in arms:
            r = cell[arm]
            totals[arm][0] += r['wall']
            t = per[task][arm]
            t[0] += r['wall']
            t[3] += 1
            if counted:
                totals[arm][1] += r['out']
                totals[arm][2] += r['steps']
                t[1] += r['out']
                t[2] += r['steps']

    base = totals[a.baseline]
    out = {'rows': len(rows), 'leakDropped': len(leaked), 'inexact': len(inexact),
           'arms': arms, 'baseline': a.baseline,
           'completeCells': len(complete), 'reds': reds, 'gateViolations': gate,
           'totals': {}, 'perFamily': {}, 'paired': {}, 'tail': {},
           'tokenDrops': tokenDrops}
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
                          'wallRatio': round(w / b[0], 3) if b[0] else None,
                          'outRatio': round(o / b[1], 3) if b[1] else None,
                          'stepRatio': round(s / b[2], 3) if b[2] else None}
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

    # Pass rate is reported over every run, never over the surviving cells:
    # dropping red cells from totals is a gate, not a licence to hide a loss.
    out['passRate'] = {}
    for arm in arms:
        mine = [r for r in rows if r['arm'] == arm]
        ok = [r for r in mine if r['exit'] == 0 and r['green']]
        out['passRate'][arm] = {'green': len(ok), 'runs': len(mine),
                                'rate': round(len(ok) / len(mine), 3) if mine else None}
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
    if out['tokenDrops']:
        print(f"token/step sums exclude {len(out['tokenDrops'])} complete cell(s) with no honest "
              f"denominator (wall still counts): " + ', '.join(
                  f"{d['task']} p{d['pair']}" for d in out['tokenDrops']))
    print(f"\n{'arm':<10}{'cells':>6}{'wall s':>10}{'wall x':>8}{'out tok':>11}{'out x':>7}"
          f"{'steps':>8}{'step x':>7}")
    for arm in arms:
        t = out['totals'][arm]
        print(f"{arm:<10}{t['cells']:>6}{t['wall']:>10.1f}{t['wallRatio']:>8.2f}"
              f"{t['out']:>11}{t['outRatio']:>7.2f}{t['steps']:>8}{t['stepRatio']:>7.2f}")
    print(f"\n{'arm':<10}{'green/runs':>12}{'pass rate':>11}")
    for arm in arms:
        pr = out['passRate'][arm]
        print(f"{arm:<10}{str(pr['green']) + '/' + str(pr['runs']):>12}{pr['rate']:>11.3f}")
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
