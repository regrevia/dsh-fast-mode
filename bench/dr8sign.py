#!/usr/bin/env python3
"""Did the second reminder actually go out? (DR8_MIG pre-registration, check 0.)

Usage: python3 bench/dr8sign.py [TAG]      # TAG defaults to DR8_MIG

Searches each session transcript of a tag for the repeat string `still long. Keep`
and prints the first step index per arm. dr8 must be >= 1 hit, def15 must be 0 hits;
a cell with 0 hits is "not measured", not "slower".
"""
import glob
import json
import os
import pathlib
import re
import subprocess
import sys
from collections import defaultdict

SESS = pathlib.Path.home() / '.dsh' / 'sessions'
NEEDLE = 'still long. Keep'


def sessions(tag):
    """{transcript path: arm} from the persistent session store."""
    pat = re.compile(r'suite-' + re.escape(tag) + r'-(\w+)-p(\d+)-([A-Za-z0-9_]+)$')
    out = {}
    for d in glob.glob(str(SESS / f'--*dsh-runs-suite-{tag}-*')):
        m = pat.search(os.path.basename(d).strip('-'))
        if not m:
            continue
        for f in glob.glob(os.path.join(d, 'session-*', 'session.v4.jsonl.zstd')):
            out[f] = m.group(3)
    return out


def first_hit(f):
    p = subprocess.run(['zstd', '-dc', f], capture_output=True)
    if p.returncode:
        return None
    step, hit = 0, None
    for line in p.stdout.decode('utf-8', 'replace').splitlines():
        try:
            o = json.loads(line)
        except Exception:  # noqa: BLE001 - a torn transcript line is not fatal
            continue
        if o.get('type') == 'step/start':
            step += 1
        if NEEDLE in str(o.get('data') or '') and hit is None:
            hit = step or 1
    return hit


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else 'DR8_MIG'
    per = defaultdict(list)
    for f, arm in sorted(sessions(tag).items()):
        per[arm].append(first_hit(f))
    for arm, hits in sorted(per.items()):
        got = [h for h in hits if h]
        print(f'{arm:6s} sessions={len(hits):2d} hit={len(got):2d} steps={sorted(got)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
