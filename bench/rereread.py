#!/usr/bin/env python3
"""How much of a turn's step budget is spent re-reading a file it already read.

Zero-cost ceiling measurement on retained transcripts, for two levers that share
one surface: `readCache` (answers a repeat read from cache — same text, saves a
disk read only) and `compactRereadHint` (tells the model not to re-read a file it
just wrote). Only the second can remove a *step*; both are bounded by how often a
repeat read happens at all.

Definitions, per turn:
  read      a `read` call with no `offset`/`limit` (whole file; slice reads are a
            different evidence request and are not repeats of a whole file)
  write     a `write`/`edit`/`patch` call naming `file_path`
  repeat    a whole-file read of a path already whole-file-read earlier in the turn
  reread-after-write
            a whole-file read of a path this turn already wrote

Usage:
  python3 bench/rereread.py                    # every suite session on disk
  python3 bench/rereread.py --arm def15 --limit 40
  python3 bench/rereread.py --json
"""
import argparse
import glob
import json
import pathlib
import subprocess
import sys

MUTATORS = {'write', 'edit', 'patch'}


def transcripts(arm, limit):
    root = pathlib.Path.home() / '.dsh' / 'sessions'
    pat = str(root / (f'--*dsh-runs-suite-*-{arm}--' if arm else '--*dsh-runs-suite-*--')
              / 'session-*' / 'session.v4.jsonl.zstd')
    files = sorted(glob.glob(pat))
    return files[:limit] if limit else files


def slug_of(path):
    d = pathlib.Path(path).parent.parent.name.strip('-')
    parts = d.split('-')
    for i, p in enumerate(parts):
        if p == 'suite':
            rest = parts[i + 1:]
            return ('-'.join(rest[:-3]), rest[-3], rest[-2], rest[-1])
    return ('?', '?', '?', '?')


def scan(path):
    p = subprocess.run(['zstd', '-dc', path], capture_output=True)
    if p.returncode != 0:
        return None
    calls = {}
    out = []
    for line in p.stdout.decode('utf-8', 'replace').splitlines():
        if 'tool/call' in line:
            try:
                o = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if o.get('type') != 'tool/call':
                continue
            d = o.get('data') or {}
            try:
                args = json.loads(d.get('arguments') or '{}')
            except Exception:  # noqa: BLE001
                args = {}
            calls[d.get('callId')] = (d.get('turn'), d.get('step'), d.get('name'), args)
            out.append(('call', d.get('turn'), d.get('step'), d.get('callId'), d.get('name'), args))
        elif 'tool/result' in line:
            try:
                o = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if o.get('type') != 'tool/result':
                continue
            d = o.get('data') or {}
            cid = d.get('toolCallId')
            content = (d.get('message') or {}).get('content')
            if cid not in calls or not isinstance(content, list):
                continue
            text = ''.join(p.get('text') or '' for p in content
                           if isinstance(p, dict) and p.get('type') == 'text')
            turn, step, name, args = calls[cid]
            out.append(('result', turn, step, cid, name, args, len(text)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm', default='')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()

    files = transcripts(a.arm, a.limit)
    if not files:
        print('no transcripts found', file=sys.stderr)
        return 1

    agg = {'sessions': 0, 'turns': 0, 'steps': 0, 'reads': 0, 'repeat': 0,
           'rereadAfterWrite': 0, 'repeatChars': 0, 'readChars': 0}
    by_task = {}
    per_session = []
    for f in files:
        rows = scan(f)
        if not rows:
            continue
        agg['sessions'] += 1
        seen = {}          # turn -> path -> True
        written = {}       # turn -> path -> True
        turn_steps = {}
        s_repeat = s_read = 0
        for row in rows:
            if row[0] != 'call':
                continue
            _, turn, step, cid, name, args = row
            turn_steps.setdefault(turn, set()).add(step)
            if name == 'read' and isinstance(args, dict) and 'file_path' in args:
                if args.get('offset') is not None or args.get('limit') is not None:
                    continue
                path = args['file_path']
                agg['reads'] += 1
                s_read += 1
                turn_seen = seen.setdefault(turn, {})
                if path in turn_seen:
                    agg['repeat'] += 1
                    s_repeat += 1
                else:
                    turn_seen[path] = True
                if path in written.setdefault(turn, {}):
                    agg['rereadAfterWrite'] += 1
            elif name in MUTATORS and isinstance(args, dict):
                path = args.get('file_path') or args.get('path')
                if path:
                    written.setdefault(turn, {})[path] = True
        agg['turns'] += len(turn_steps)
        agg['steps'] += sum(len(v) for v in turn_steps.values())
        per_session.append((slug_of(f), s_read, s_repeat))

    total = agg['steps'] or 1
    summary = dict(
        sessions=agg['sessions'], turns=agg['turns'], steps=agg['steps'],
        reads=agg['reads'], repeat=agg['repeat'],
        rereadAfterWrite=agg['rereadAfterWrite'],
        repeatShareOfReads=round(agg['repeat'] / agg['reads'], 4) if agg['reads'] else 0,
        rereadAfterWriteShareOfReads=round(agg['rereadAfterWrite'] / agg['reads'], 4) if agg['reads'] else 0,
        repeatShareOfSteps=round(agg['repeat'] / total, 4),
        rereadAfterWriteShareOfSteps=round(agg['rereadAfterWrite'] / total, 4),
        perTask={}, byArm={},
    )
    for (tag, task, pair, arm), s_read, s_repeat in per_session:
        t = summary['perTask'].setdefault(task, {'reads': 0, 'repeat': 0})
        t['reads'] += s_read
        t['repeat'] += s_repeat
        b = summary['byArm'].setdefault(arm, {'reads': 0, 'repeat': 0, 'sessions': 0})
        b['reads'] += s_read
        b['repeat'] += s_repeat
        b['sessions'] += 1

    if a.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print(f"sessions {summary['sessions']}  turns {summary['turns']}  steps {summary['steps']}")
        print(f"whole-file reads {summary['reads']}  repeats {summary['repeat']} "
              f"({summary['repeatShareOfReads']:.1%} of reads, "
              f"{summary['repeatShareOfSteps']:.1%} of steps)")
        print(f"re-read after write {summary['rereadAfterWrite']} "
              f"({summary['rereadAfterWriteShareOfSteps']:.1%} of steps)  <- the reread hint's target")
        for arm, b in sorted(summary['byArm'].items()):
            print(f"  {arm:8s} sessions {b['sessions']:3d} reads {b['reads']:4d} repeats {b['repeat']:4d}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
