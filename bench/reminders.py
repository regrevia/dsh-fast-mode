#!/usr/bin/env python3
"""Which scheduler reminders actually reached the model, and what followed.

A reminder is only a lever if it is delivered. This counts, over retained
transcripts, every directive text the plugin injected (`Auto schedule: ...`),
grouped by kind, plus how often the quoted text shows up inside the model's own
prose (the model echoing the instruction back is not delivery).

Usage:
  python3 bench/reminders.py                     # suite sessions, default cap
  python3 bench/reminders.py --limit 0           # every retained session
  python3 bench/reminders.py --dir '--*dsh-runs-suite-*'
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import subprocess

SESS = os.path.expanduser('~/.dsh/sessions')
KINDS = (
    ('that exact check already passed', 'reuse-check'),
    ('this turn is long enough that prose', 'output-discipline'),
    ('batch now. Put every independent tool call', 'batch-now'),
    ('files changed since the last run', 'write-and-verify'),
    ('reached the step budget', 'step-budget'),
    ('consecutive steps produced nothing new', 'change-approach'),
    ('consecutive steps produced nothing', 'change-approach'),
)


def transcripts(pattern, limit):
    out = []
    for d in sorted(glob.glob(os.path.join(SESS, pattern))):
        for f in glob.glob(os.path.join(d, 'session-*', 'session.v4.jsonl.zstd')):
            out.append((d, f))
    return out[:limit] if limit else out


def scan(path):
    p = subprocess.run(['zstd', '-dc', path], capture_output=True)
    if p.returncode != 0:
        return None
    text = p.stdout.decode('utf-8', 'replace')
    counts = collections.Counter()
    echoed = collections.Counter()
    delivered = 0
    for needle, kind in KINDS:
        n = text.count(needle)
        if n == 0:
            continue
        counts[kind] += n
    # A directive is delivered as its own message part; the model repeating the
    # phrase inside an assistant text block is an echo, so count both and report
    # the delivery count only when it is separable.
    for line in text.splitlines():
        if 'Auto schedule:' not in line:
            continue
        try:
            o = json.loads(line)
        except Exception:  # noqa: BLE001 - a torn line is not fatal
            continue
        role = o.get('type')
        data = o.get('data') or {}
        msg = data.get('message') or data
        body = ' '.join(part.get('text') or '' for part in msg.get('content') or []
                        if isinstance(part, dict) and part.get('type') == 'text')
        if 'Auto schedule:' not in body:
            continue
        for needle, kind in KINDS:
            if needle in body:
                if role == 'assistant/message':
                    echoed[kind] += 1
                else:
                    delivered += 1
                break
    return counts, echoed, delivered


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0, help='transcripts; 0 = all')
    ap.add_argument('--dir', default='--*dsh-runs-suite-*')
    a = ap.parse_args()
    files = transcripts(a.dir, a.limit)
    total = collections.Counter()
    echo = collections.Counter()
    delivered = 0
    with_any = 0
    scanned = 0
    for d, f in files:
        r = scan(f)
        if not r:
            continue
        scanned += 1
        counts, echoed, n = r
        delivered += n
        total.update(counts)
        echo.update(echoed)
        with_any += 1 if sum(counts.values()) > 0 else 0
    print(f'transcripts {scanned}  with any directive {with_any} '
          f'({100 * with_any / max(scanned, 1):.0f} %)  delivered {delivered}')
    for kind, n in total.most_common():
        print(f'  {kind:18} raw {n:4}  echoed-in-prose {echo[kind]:4}')


if __name__ == '__main__':
    main()
