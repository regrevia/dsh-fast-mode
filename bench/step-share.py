#!/usr/bin/env python3
"""Where does a turn's reasoning go?

Splits every turn's reasoning characters by step index, and reports how much of it
is written *after* a length reminder has already arrived. The point is to tell, for
one arm, which mechanism can even reach the mass: step 1 happens before any tool
result, so a reminder that fires at step boundaries cannot touch it.

Usage:
  python3 bench/step-share.py --tag ABL4 --arm t2all [--arm tact]

Reads the session transcripts recorded under `$TMPDIR/dsh-runs/suite-<tag>-*`.
"""
import argparse
import json
import sys

sys.path.insert(0, __file__.rsplit('/', 1)[0])
import textshare as ts

MARKER = 'characters of reasoning in this turn'


def events(dirpath):
    """[(seq, kind, (turn, step), chars)] in transcript order."""
    out = []
    for line in ts.read_transcript(dirpath).splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        data = rec.get('data')
        if not isinstance(data, dict):
            continue
        if rec.get('type') == 'assistant/message':
            chars = 0
            for blk in ((data.get('message') or {}).get('content') or []):
                if isinstance(blk, dict) and blk.get('type') == 'reasoning':
                    chars += len(blk.get('text') or '')
            if chars:
                out.append((rec.get('seq') or 0, 'reason', (data.get('turn'), data.get('step')), chars))
        elif MARKER in json.dumps(data, ensure_ascii=False):
            out.append((rec.get('seq') or 0, 'nudge', None, 0))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tag', required=True)
    ap.add_argument('--arm', action='append', required=True)
    args = ap.parse_args()
    for arm in args.arm:
        sessions = ts.collect(arm, args.tag, 0)
        totals = {'turns': 0, 'chars': 0, 'first': 0, 'after': 0, 'nudged': 0, 'steps': 0}
        print(f'--- {arm} ({len(sessions)} sessions)')
        for dirpath, name in sessions:
            ev = events(dirpath)
            turns = {}
            for idx, (seq, kind, key, chars) in enumerate(ev):
                if kind == 'reason':
                    turns.setdefault(key[0], []).append((idx, chars))
            s = {'chars': 0, 'first': 0, 'after': 0}
            for turn, items in turns.items():
                totals['turns'] += 1
                totals['steps'] += len(items)
                c = sum(chars for _, chars in items)
                s['chars'] += c
                s['first'] += items[0][1]
                nudged = [i for i, (idx, _) in enumerate(items)
                          if any(k == 'nudge' for _, k, _, _ in ev[:idx])]
                if nudged:
                    totals['nudged'] += 1
                s['after'] += sum(items[i][1] for i in nudged)
            for k in s:
                totals[k] += s[k]
            short = name.split('suite-')[-1]
            print(f'  {short[:34]:34s} turns={len(turns)} chars={s["chars"]:6d} '
                  f'first={s["first"]:6d} afterNudge={s["after"]:6d}')
        c = totals['chars'] or 1
        print(f'  TOTAL turns={totals["turns"]} steps={totals["steps"]} chars={totals["chars"]} '
              f'firstStep={100*totals["first"]/c:.1f}% afterNudge={100*totals["after"]/c:.1f}% '
              f'nudgedTurns={totals["nudged"]}')


main()
