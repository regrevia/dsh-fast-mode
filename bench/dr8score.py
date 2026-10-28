#!/usr/bin/env python3
"""Gate for DR8_MIG (`disciplineRepeatAtSteps: 8`), exactly as pre-registered.

Usage: python3 bench/dr8score.py

Criteria (BENCHMARK.md, written 2026-10-28 before any DR8 row existed):
 0. repeat reminder delivered: dr8 >= 1 hit, def15 = 0 (else "not measured")
 1. >= 6 valid pairs
 2. geo <= 0.95 AND median <= 1.00
 3. wins >= 4/6
 4. out_geo <= 0.95 (the win must be an output win, not noise)
 5. quality: session ids on every row, green >= baseline in every cell
Any failure => default stays 0, "second reminder ineffective/harmful", no third try.
"""
import json
import math
import pathlib
import re
import statistics as st
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
RESULTS = HERE / 'results'
TAG, BASE, TREAT = 'DR8_MIG', 'def15', 'dr8'


def has_ids(row):
    """Steps/out attributable to this run's own sessions (historical name: exact)."""
    return bool(row.get('hasSessionIds', row.get('exact')))


def load():
    path = RESULTS / f'suite-{TAG}.jsonl'
    if not path.exists():
        return {}
    rows = {}
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if line:
            r = json.loads(line)
            rows[(r['task'], r['pair'], r['arm'])] = r
    return rows


def valid(row):
    return (bool(row) and row.get('exit') == 0 and row.get('steps', 0) >= 1
            and row.get('out', 0) > 0 and has_ids(row) and not row.get('leak'))


def main():
    rows = load()
    pairs = {}
    for (task, pair, arm), r in rows.items():
        if arm in (BASE, TREAT):
            pairs.setdefault((task, pair), {})[arm] = r
    good, bad = [], []
    for k, cells in sorted(pairs.items()):
        b, t = cells.get(BASE), cells.get(TREAT)
        if valid(b) and valid(t):
            good.append((k, b, t))
        elif b or t:
            bad.append((k, b, t))

    checks = [('1 pairs >= 6', len(good) >= 6, f'{len(good)} pairs')]
    if good:
        ratio = [t['wall'] / b['wall'] for _, b, t in good]
        geo = math.exp(sum(math.log(x) for x in ratio) / len(ratio))
        med = st.median(ratio)
        wins = sum(1 for x in ratio if x < 1)
        og = math.exp(sum(math.log(t['out'] / b['out'] if b['out'] else 1.0)
                          for _, b, t in good) / len(good))
        checks += [('2 geo <= 0.95', geo <= 0.95, f'{geo:.3f}'),
                   ('2 median <= 1.00', med <= 1.00, f'{med:.3f}'),
                   ('3 wins >= 4/6', wins >= max(4, math.ceil(len(good) * 2 / 3)),
                    f'{wins}/{len(good)}'),
                   ('4 out_geo <= 0.95', og <= 0.95, f'{og:.3f}')]
    qual = all(b.get('green') and t.get('green') and t.get('passed', 0) >= b.get('passed', 0)
               for _, b, t in good)
    checks.append(('5 quality', qual, '0 regressions' if qual else 'regression'))

    p = subprocess.run([sys.executable, str(HERE / 'dr8sign.py'), TAG],
                       capture_output=True, text=True)
    d = {}
    for line in p.stdout.splitlines():
        m = re.match(r'^(\w+)\s+sessions=\s*(\d+)\s+hit=\s*(\d+)', line.strip())
        if m:
            d[m.group(1)] = int(m.group(3))
    checks.append(('0 repeat delivered (dr8>=1, def15=0)',
                   d.get(TREAT, 0) >= 1 and d.get(BASE, 0) == 0,
                   f"dr8={d.get(TREAT, 0)} def15={d.get(BASE, 0)}"))

    print(f'== {TAG}: {TREAT} vs {BASE} ==')
    for name, ok, val in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {val}")
    ship = all(ok for _, ok, _ in checks)
    print('\nVERDICT:', 'SHIP disciplineRepeatAtSteps: 8' if ship
          else 'HOLD default=0 (second reminder ineffective under the pre-registered rule)')
    return 0 if ship else 1


if __name__ == '__main__':
    sys.exit(main())
