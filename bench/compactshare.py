#!/usr/bin/env python3
"""How much of a turn's tool evidence lives in results long enough for
`compactResults` to rewrite them (> compactMaxChars, default 8000).

This is a zero-cost ceiling measurement on retained transcripts: it answers
"if every long result were compacted, how many characters of the model's
evidence would move" *before* spending a single suite run. It is not an A/B
and cannot show a speedup — only whether the mechanism has any surface at all.

Usage:
  python3 bench/compactshare.py                     # every `def15` session on disk
  python3 bench/compactshare.py --arm std --limit 40
  python3 bench/compactshare.py --json

Estimating the saving: the rewrite keeps `headRatio` 0.40 of the head and
`tailRatio` 0.25 of the tail for the shapes that have both (see
`src/compact.js`), so a rewritten result keeps roughly 65 % of its characters.
The estimate below applies that ratio to every result over the threshold; it
is an upper bound on what compaction could remove, not a measurement of what
it did remove.
"""
import argparse
import glob
import json
import os
import pathlib
import subprocess
import sys

THRESHOLD = 8000
KEEP = 0.65  # headRatio + tailRatio for results that have both ends


def transcripts(arm, limit):
    root = pathlib.Path.home() / '.dsh' / 'sessions'
    pat = str(root / f'--*dsh-runs-suite-*-{arm}--' / 'session-*' / 'session.v4.jsonl.zstd')
    files = sorted(glob.glob(pat))
    if limit:
        files = files[:limit]
    return files


def slug_of(path):
    """suite-<tag>-<task>-p<pair>-<arm> -> (tag, task, arm)."""
    d = pathlib.Path(path).parent.parent.name.strip('-')
    parts = d.split('-')
    for i, p in enumerate(parts):
        if p.startswith('suite'):
            rest = parts[i + 1:]
            break
    else:
        return None
    # tag may itself contain '-'; the tail is always task-p<pair>-arm
    arm = rest[-1]
    pair = rest[-2]
    task = rest[-3]
    tag = '-'.join(rest[:-3])
    return tag, task, pair, arm


def scan(path):
    p = subprocess.run(['zstd', '-dc', path], capture_output=True)
    if p.returncode != 0:
        return None
    rows = []
    for line in p.stdout.decode('utf-8', 'replace').splitlines():
        if 'tool/result' not in line:
            continue
        try:
            o = json.loads(line)
        except Exception:  # noqa: BLE001 - torn tail line
            continue
        if o.get('type') != '/tool/result' and o.get('type') != 'tool/result':
            continue
        data = o.get('data') or {}
        if data.get('message', {}).get('source', {}).get('toolCallId'):
            pass
        content = (data.get('message') or {}).get('content')
        if not isinstance(content, list):
            continue
        text = ''.join(part.get('text') or '' for part in content
                       if isinstance(part, dict) and part.get('type') == 'text')
        if text:
            rows.append(len(text))
    return rows or None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm', default='def15')
    ap.add_argument('--limit', type=int, default=0, help='sessions; 0 = all')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()

    files = transcripts(a.arm, a.limit)
    if not files:
        print('no transcripts found', file=sys.stderr)
        return 1

    total = long_chars = long_est_keep = 0
    long_n = n = 0
    by_task = {}
    for f in files:
        rows = scan(f)
        if not rows:
            continue
        s = slug_of(f)
        task = s[1] if s else '?'
        for chars in rows:
            n += 1
            total += chars
            long_hit = chars > THRESHOLD
            if long_hit:
                long_n += 1
                long_chars += chars
                long_est_keep += int(chars * KEEP)
            t = by_task.setdefault(task, {'n': 0, 'chars': 0, 'long': 0, 'longChars': 0})
            t['n'] += 1
            t['chars'] += chars
            if long_hit:
                t['long'] += 1
                t['longChars'] += chars

    summary = {
        'sessions': len(files),
        'results': n,
        'chars': total,
        'longResults': long_n,
        'longChars': long_chars,
        'longShareChars': round(long_chars / total, 4) if total else 0,
        'estSavedChars': long_chars - long_est_keep,
        'estSavedShare': round((long_chars - long_est_keep) / total, 4) if total else 0,
        'byTask': by_task,
    }
    if a.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print(f"sessions {summary['sessions']}  tool results {n}  chars {total:,}")
        print(f"{long_n} results over {THRESHOLD} chars = {long_chars:,} chars "
              f"({summary['longShareChars']:.1%} of all tool-result text)")
        print(f"upper bound on what compaction could remove: {summary['estSavedChars']:,} chars "
              f"= {summary['estSavedShare']:.1%} of tool-result text")
        for task, t in sorted(by_task.items()):
            print(f"  {task:14s} results {t['n']:4d}  long {t['long']:3d}  "
                  f"long share {t['longChars'] / t['chars']:.1%}" if t['chars'] else '')
    return 0


if __name__ == '__main__':
    sys.exit(main())
