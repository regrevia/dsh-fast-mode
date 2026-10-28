#!/usr/bin/env python3
"""How much of the reuse lever was switched off by patch-shaped edits.

1.5.19 marked a mutation whose target it could not locate as "uncertain" and then
stopped offering check-reuse suggestions for the rest of that session. Patch calls
(`apply_patch` / `patch`) name their targets inside the diff body, so before 1.5.20
any session that edited once with a patch paid that cost for every later check.
This counts, from retained transcripts, how common that shape is: sessions that
call a patch tool, and the tool calls that follow it in those sessions.

Usage:
  python3 bench/patchshare.py              # all local sessions
  python3 bench/patchshare.py --limit 0    # explicit: all
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess

SESS = os.path.expanduser('~/.dsh/sessions')
PATCH_CALLS = {'apply_patch', 'patch', 'apply_diff', 'edit_patch'}
WRITE_CALLS = {'write', 'write_file', 'create_file', 'edit', 'multi_edit'} | PATCH_CALLS


def sessions(limit):
    out = []
    for d in sorted(glob.glob(os.path.join(SESS, '--*'))):
        files = glob.glob(os.path.join(d, 'session-*', 'session.v4.jsonl.zstd'))
        if files:
            out.append((d, files[0]))
    return out[:limit] if limit else out


def tally(path):
    p = subprocess.run(['zstd', '-dc', path], capture_output=True)
    if p.returncode != 0:
        return None
    calls = []
    for line in p.stdout.decode('utf-8', 'replace').splitlines():
        try:
            o = json.loads(line)
        except Exception:  # noqa: BLE001 - a torn line is not fatal
            continue
        if o.get('type') != 'assistant/message':
            continue
        for part in (o.get('data') or {}).get('message', {}).get('content') or []:
            if isinstance(part, dict) and part.get('type') == 'tool-call':
                calls.append(part.get('toolName') or part.get('name') or '')
    if not calls:
        return None
    first_patch = next((i for i, n in enumerate(calls) if n in PATCH_CALLS), None)
    return {
        'calls': len(calls),
        'patch_calls': sum(1 for n in calls if n in PATCH_CALLS),
        'write_calls': sum(1 for n in calls if n in WRITE_CALLS),
        'first_patch': first_patch,
        'after_patch': 0 if first_patch is None else len(calls) - first_patch - 1,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=60, help='sessions, most recent first; 0 = all')
    a = ap.parse_args()
    rows = []
    for d, f in reversed(sessions(a.limit)):
        r = tally(f)
        if r:
            r['session'] = os.path.basename(d)[:24]
            rows.append(r)
    if not rows:
        print('no sessions')
        return
    with_patch = [r for r in rows if r['patch_calls'] > 0]
    calls = sum(r['calls'] for r in rows)
    pcalls = sum(r['patch_calls'] for r in rows)
    after = sum(r['after_patch'] for r in with_patch)
    print(f"sessions {len(rows)}  calls {calls}")
    print(f"sessions that patched {len(with_patch)} ({100 * len(with_patch) / len(rows):.0f} %)")
    print(f"patch calls {pcalls} ({100 * pcalls / calls:.1f} % of calls)")
    print(f"calls after the first patch, in patching sessions {after} "
          f"({100 * after / calls:.1f} % of all calls)")
    closed = [r for r in with_patch if r['after_patch'] > 0]
    print(f"patching sessions with work still to do after the patch {len(closed)}")
    med = sorted(r['after_patch'] for r in closed)
    if med:
        print(f"  median calls still to do after the first patch: {med[len(med) // 2]}")


if __name__ == '__main__':
    main()
