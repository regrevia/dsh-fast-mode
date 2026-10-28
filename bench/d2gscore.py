#!/usr/bin/env python3
"""Gate for the conditional early entry (`d2g`), exactly as pre-registered.

Usage: python3 bench/d2gscore.py

d2g = disciplineAfterSteps: 2 + disciplineEarlyCalls: 2, i.e. the early reminder
is spent only on a turn whose first step already made >= 2 tool calls.
Criteria (written before any D2G row existed):
 1. D2G_IMPL 8 pairs: geo <= 0.95 AND faster >= 5/8 (must not repeat 1.073x).
 2. D2G_DBG 7 pairs: geo <= 0.80.
 3. D2G_MIG 6 pairs: geo <= 0.90.
 4. merged 21 pairs: geo <= 0.85 AND median <= 0.90.
 5. quality: no cell regresses in green/passed, and delivery is as pre-registered.
Delivery (criterion 5's other half) is asserted by calling bench/d2gsign.py, which
reads the session transcripts: expected step 4 for def15 everywhere, step 4 for d2g
on D2G_IMPL (fallback) and step 2 on D2G_DBG / D2G_MIG.
"""
import pathlib
import statistics as st

import json
import math
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
RESULTS = HERE / 'results'
BLOCKS = ['D2G_IMPL', 'D2G_DBG', 'D2G_MIG']
TREAT = 'd2g'


def has_ids(row):
    """Steps/out attributable to this run's own sessions (historical name: exact)."""
    return bool(row.get('hasSessionIds', row.get('exact')))


def load(tag):
    f = RESULTS / f'suite-{tag}.jsonl'
    if not f.exists():
        return []
    d = {}
    for line in f.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        d.setdefault(r['pair'], {})[r['arm']] = r
    return [(p, v['def15'], v[TREAT]) for p, v in sorted(d.items())
            if 'def15' in v and TREAT in v]


geo = lambda xs: math.exp(sum(map(math.log, xs)) / len(xs))


def stats(rs):
    w = [b['wall'] / a['wall'] for _, a, b in rs]
    s = [b['steps'] / a['steps'] for _, a, b in rs]
    o = [b['out'] / a['out'] for _, a, b in rs]
    return dict(n=len(rs), geo=geo(w), med=st.median(w),
                tot=sum(b['wall'] for _, a, b in rs) / sum(a['wall'] for _, a, b in rs),
                fast=sum(1 for x in w if x < 1),
                steps=geo(s), out=geo(o), lo=min(w), hi=max(w))


def delivery(tag):
    """What bench/d2gsign.py reports: how many sessions fired, at which step."""
    p = subprocess.run([sys.executable, str(HERE / 'd2gsign.py'), tag],
                       capture_output=True, text=True)
    out = {}
    for line in p.stdout.splitlines():
        m = re.match(r'^(\w+)\s+sessions=\s*(\d+)\s+fired=\s*(\d+)\s+steps=\[([^\]]*)\]',
                     line.strip())
        if not m:
            continue
        steps = [int(x) for x in m.group(4).split(',') if x.strip()]
        out[m.group(1)] = (int(m.group(2)), int(m.group(3)), steps)
    return out


def main():
    rows = {tag: load(tag) for tag in BLOCKS}
    title = (f"{'block':10s} {'n':>3s} {'geo':>6s} {'med':>6s} {'total':>6s} "
             f"{'faster':>7s} {'steps':>6s} {'out':>6s}  range")
    print(title)
    allrs = []
    for tag in BLOCKS:
        rs = rows[tag]
        if not rs:
            print(f'{tag:10s}  -  (no rows yet)')
            continue
        allrs += rs
        x = stats(rs)
        print(f"{tag:10s} {x['n']:3d} {x['geo']:6.3f} {x['med']:6.3f} {x['tot']:6.3f} "
              f"{x['fast']:3d}/{x['n']:<3d} {x['steps']:6.3f} {x['out']:6.3f}  "
              f"{x['lo']:.3f}-{x['hi']:.3f}")
    bad = [(tag, p) for tag in BLOCKS for p, a, b in rows[tag]
           if not (has_ids(a) and has_ids(b) and a.get('green') and b.get('green'))]
    if allrs:
        m = stats(allrs)
        print(f"{'MERGED':10s} {m['n']:3d} {m['geo']:6.3f} {m['med']:6.3f} {m['tot']:6.3f} "
              f"{m['fast']:3d}/{m['n']:<3d} {m['steps']:6.3f} {m['out']:6.3f}  "
              f"{m['lo']:.3f}-{m['hi']:.3f}")

    checks = []
    impl, dbg, mig = rows['D2G_IMPL'], rows['D2G_DBG'], rows['D2G_MIG']
    if impl:
        i = stats(impl)
        checks += [('1 impl 8 pairs', i['n'] == 8, f"{i['n']}/8"),
                   ('1 impl geo <= 0.95', i['geo'] <= 0.95, f"{i['geo']:.3f}"),
                   ('1 impl faster >= 5/8', i['fast'] >= 5, f"{i['fast']}/8")]
    else:
        checks.append(('1 impl 8 pairs', False, 'block missing'))
    if dbg:
        d = stats(dbg)
        checks += [('2 dbg 7 pairs', d['n'] == 7, f"{d['n']}/7"),
                   ('2 dbg geo <= 0.80', d['geo'] <= 0.80, f"{d['geo']:.3f}")]
    else:
        checks.append(('2 dbg 7 pairs', False, 'block missing'))
    if mig:
        g = stats(mig)
        checks += [('3 mig 6 pairs', g['n'] == 6, f"{g['n']}/6"),
                   ('3 mig geo <= 0.90', g['geo'] <= 0.90, f"{g['geo']:.3f}")]
    else:
        checks.append(('3 mig 6 pairs', False, 'block missing'))
    if len(allrs) >= 21:
        m = stats(allrs)
        checks += [('4 merged geo <= 0.85', m['geo'] <= 0.85, f"{m['geo']:.3f}"),
                   ('4 merged median <= 0.90', m['med'] <= 0.90, f"{m['med']:.3f}")]
    else:
        checks.append(('4 merged 21 pairs', False, f'{len(allrs)} pairs'))
    checks.append(('5 quality: no green/passed regression', not bad, f'{len(bad)} bad cells'))

    expect = {'D2G_IMPL': 4, 'D2G_DBG': 2, 'D2G_MIG': 2}
    for tag in BLOCKS:
        got = delivery(tag)
        for arm in ('def15', TREAT):
            if arm not in got:
                checks.append((f'5 delivery {tag} {arm}', False, 'no sessions'))
                continue
            sess, fired, steps = got[arm]
            want = 4 if arm == 'def15' else expect[tag]
            ok = fired == sess and bool(steps) and all(x == want for x in steps)
            checks.append((f'5 delivery {tag} {arm} step {want}', ok,
                           f'{fired}/{sess} fired {sorted(set(steps)) or "-"}'))
    print()
    for name, ok, val in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {val}")
    print('  [INFO] delivery by block: python3 bench/d2gsign.py D2G_IMPL')
    ship = all(ok for _, ok, _ in checks)
    print('\nVERDICT:', 'SHIP default=d2g' if ship
          else 'HOLD default=4 under the pre-registered rule')
    return 0 if ship else 1


if __name__ == '__main__':
    sys.exit(main())
