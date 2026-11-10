#!/usr/bin/env python3
"""How much of a turn's reasoning the length nudge can still reach.

The shipped ladder fires two nudges per turn, at `REASONING_CHARS` (4000) and
8000 cumulative characters. A nudge can only change the thinking that happens
*after* the step boundary where it is delivered, so every character past the
8000 mark of a turn is thinking the current ladder cannot touch.

Usage:
  python3 bench/reason-headroom.py --tag ABL3 --arm t2all
  python3 bench/reason-headroom.py --tag ABL3 --arm t2all --arm t3nolen
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import textshare as ts  # noqa: E402

CUT = 8000  # last rung of the shipped ladder: REASONING_CHARS * MAX_REASONING_NUDGES


def steps_of(text):
    """{(turn, step): reasoning chars} for one transcript."""
    out = {}
    for line in text.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        data = rec.get('data')
        if not isinstance(data, dict) or rec.get('type') != 'assistant/message':
            continue
        key = (data.get('turn'), data.get('step'))
        for blk in ((data.get('message') or {}).get('content') or []):
            if isinstance(blk, dict) and blk.get('type') == 'reasoning':
                out[key] = out.get(key, 0) + len(blk.get('text') or '')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tag', required=True)
    ap.add_argument('--arm', action='append', required=True)
    args = ap.parse_args()
    for arm in args.arm:
        dirs = ts.collect(arm, args.tag, 0)
        total = reach = turns = 0
        for d, _name in dirs:
            steps = steps_of(ts.read_transcript(d))
            if not steps:
                continue
            turns += 1
            cum = 0
            for key in sorted(steps, key=lambda k: ((k[0] if k[0] is not None else -1),
                                                     (k[1] if k[1] is not None else -1))):
                n = steps[key]
                total += n
                reach += max(0, cum + n - max(cum, CUT))
                cum += n
        if total:
            print(f'{arm}: sessions={turns} reasoning chars={total} '
                  f'past-{CUT}={reach} ({reach / total * 100:.1f}%)')


if __name__ == '__main__':
    main()
