#!/usr/bin/env python3
"""Where did each arm's compression reminder actually fire in this block?

Usage: python3 bench/d2gsign.py TAG      e.g. python3 bench/d2gsign.py D2G_IMPL

Prints, per arm, the step index of the first injected reminder per session, so the
pre-registered "d2g falls back to step 4 on impl and fires at step 2 elsewhere" can
be checked instead of assumed.

Evidence is the session transcript, not the metrics file: the reminder reaches the
model as a user-message part, while `~/.dsh/fast-mode-metrics.jsonl` has no field
for directives. Sessions are found under `~/.dsh/sessions`, whose directory name
encodes the run directory (`.../dsh-runs/suite-<TAG>-<task>-p<pair>-<arm>`), so
this works after the temp run directories are gone.
"""
import glob
import json
import os
import pathlib
import re
import subprocess
import sys
from collections import defaultdict

HERE = pathlib.Path(__file__).resolve().parent
SESS = pathlib.Path.home() / '.dsh' / 'sessions'
NEEDLE = 'prose is now the cost'


def sessions_by_arm(tag):
    """{arm: [session dir]} for one block tag, from the persistent session store."""
    pat = re.compile(r'suite-' + re.escape(tag) + r'-(\w+)-p(\d+)-([A-Za-z0-9_]+)$')
    found = defaultdict(list)
    for d in glob.glob(str(SESS / f'--*dsh-runs-suite-{tag}-*')):
        m = pat.search(os.path.basename(d).strip('-'))
        if m:
            found[m.group(3)].append(d)
    return found


def first_hit(rd):
    step = 0
    for f in glob.glob(os.path.join(rd, 'session-*', 'session.v4.jsonl.zstd')):
        p = subprocess.run(['zstd', '-dc', f], capture_output=True)
        if p.returncode:
            continue
        step = 0
        for line in p.stdout.decode('utf-8', 'replace').splitlines():
            try:
                o = json.loads(line)
            except Exception:  # noqa: BLE001 - a torn transcript line is not fatal
                continue
            t, d = o.get('type'), o.get('data') or {}
            if t == 'step/start':
                step += 1
            elif t == 'user/message':
                if any(isinstance(c, dict) and NEEDLE in (c.get('text') or '')
                       for c in (d.get('content') or [])):
                    return step
    return None


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip().splitlines()[2].strip())
        print('usage: python3 bench/d2gsign.py TAG')
        return 2
    tag = sys.argv[1]
    by_arm = sessions_by_arm(tag)
    for arm in ('def15', 'd2', 'd2g', 'd2x'):
        dirs = sorted(by_arm.get(arm, []))
        hits = [h for h in (first_hit(rd) for rd in dirs) if h is not None]
        print(f'{arm:6s} sessions={len(dirs):2d} fired={len(hits):2d} steps={sorted(hits)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
