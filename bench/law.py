#!/usr/bin/env python3
"""What does wall clock actually track?

Re-scans every historical ``bench/results/suite-*.jsonl`` row (no new runs) and
asks one question: is wall-clock variation dominated by the number of round
trips, or by how long each step takes? The answer decides which levers can ever
produce a speedup and which are capped by the noise floor, so it is checked here
rather than argued from single blocks with n = 6..16.

Usage:
  python3 bench/law.py         # correlations + per-arm medians
  python3 bench/law.py --var   # variance decomposition of log(wall)

The decomposition is descriptive, not causal: rows mix task families, arms and
machine moments, and family is a confounder. It constrains what a lever can do;
it does not measure any single lever. See BENCHMARK.md `LAW1`.
"""
import argparse
import collections
import glob
import json
import math
import os
import pathlib
import statistics

HERE = pathlib.Path(__file__).resolve().parent


def load():
    rows = []
    for path in sorted(glob.glob(str(HERE / 'results' / 'suite-*.jsonl'))):
        for line in open(path, errors='replace'):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get('wall') and r.get('steps') and r.get('reasoning'):
                r['_f'] = os.path.basename(path)
                rows.append(r)
    return rows


def corr(a, b):
    la = [math.log(x) for x in a]
    lb = [math.log(x) for x in b]
    ma, mb = statistics.mean(la), statistics.mean(lb)
    cov = sum((x - ma) * (y - mb) for x, y in zip(la, lb)) / len(la)
    return cov / (statistics.pstdev(la) * statistics.pstdev(lb))


def cov2(a, b):
    ma, mb = statistics.mean(a), statistics.mean(b)
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / len(a)


def var(a):
    m = statistics.mean(a)
    return sum((x - m) ** 2 for x in a) / len(a)


def pct(values, q):
    s = sorted(values)
    return s[min(len(s) - 1, int(q * len(s)))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--var', action='store_true', help='variance decomposition only')
    ap.add_argument('--min', type=int, default=12, help='per-arm minimum n (default 12)')
    a = ap.parse_args()
    rows = load()
    if not rows:
        raise SystemExit('no usable rows under bench/results/')

    wall = [r['wall'] for r in rows]
    steps = [r['steps'] for r in rows]
    reason = [r['reasoning'] for r in rows]
    sstep = [r['wall'] / r['steps'] for r in rows]
    rstep = [r['reasoning'] / r['steps'] for r in rows]
    per1k = [r['wall'] / r['reasoning'] * 1000 for r in rows]

    if not a.var:
        print(f'rows {len(rows)} from {len(set(r["_f"] for r in rows))} blocks')
        print(f'corr(log wall, log reasoning)      = {corr(wall, reason):.3f}  R2 {corr(wall, reason) ** 2:.3f}')
        print(f'corr(log wall, log steps)          = {corr(wall, steps):.3f}')
        print(f'corr(log s/step, log reason/step)  = {corr(sstep, rstep):.3f}')
        print(f'wall per 1k reasoning tokens  p5 {pct(per1k, .05):.1f}s  p50 {pct(per1k, .5):.1f}s  p95 {pct(per1k, .95):.1f}s')
        print(f'seconds per step             p5 {pct(sstep, .05):.1f}s  p50 {pct(sstep, .5):.1f}s  p95 {pct(sstep, .95):.1f}s')
        print(f'reasoning tokens per step    p50 {statistics.median(rstep):.0f}')

    lw = [math.log(x) for x in wall]
    ls = [math.log(x) for x in steps]
    lsp = [math.log(x) for x in sstep]
    total = var(lw)
    print()
    print(f'log wall variance {total:.3f} = steps {var(ls):.3f} + s/step {var(lsp):.3f} + 2cov {2 * cov2(ls, lsp):.3f}')
    print(f'  share from step count   {cov2(lw, ls) / total * 100:.1f}%')
    print(f'  share from per-step cost {cov2(lw, lsp) / total * 100:.1f}%')

    if not a.var:
        agg = collections.defaultdict(list)
        for r in rows:
            agg[r['arm']].append(r)
        print(f'\n{"arm":12} {"n":>4} {"steps/run":>9} {"reason/step":>11} {"s/step":>7}')
        for arm, v in sorted(agg.items(), key=lambda kv: -len(kv[1])):
            if len(v) < a.min:
                continue
            print(f'{arm:12} {len(v):>4} '
                  f'{statistics.median(x["steps"] for x in v):>9.0f} '
                  f'{statistics.median(x["reasoning"] / x["steps"] for x in v):>11.0f} '
                  f'{statistics.median(x["wall"] / x["steps"] for x in v):>7.1f}')


if __name__ == '__main__':
    main()
