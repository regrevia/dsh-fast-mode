#!/usr/bin/env python3
"""Split a turn's output growth by channel: reasoning vs visible prose vs tool arguments.

The compression reminder's premise was written against "output" as one number.
It is three channels, and they behave differently after the step-4 reminder:

  * visible prose    keeps shrinking (the reminder works on it)
  * tool arguments   keeps shrinking
  * reasoning        rebounds in most long turns -- and reasoning is 39 % of
                     the model-visible text, so this is the channel that
                     actually decides wall clock

That split is why `disciplineRepeatAtSteps` is closed for the right reason: the
rebound is real, but it lives in reasoning, where re-sending the same sentence
measured slower (`DR8_MIG`, 1.394x).

Usage:
    python3 bench/channels.py            # tables
    python3 bench/channels.py --json     # same numbers as JSON
    python3 bench/channels.py --limit 60 # first 60 session dirs only
"""

import argparse
import collections
import glob
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import textshare as ts  # noqa: E402  (shares the transcript reader)

SESS = os.path.expanduser('~/.dsh/sessions')
LONG_TURN_STEPS = 10
EARLY_STEPS = 8          # the reminders own roughly the first 8 steps of a turn


def steps_of(directory):
    """[(turn, step, prose, args, reasoning)] summed per (turn, step), in order."""
    per, order = collections.OrderedDict(), {}
    for line in ts.read_transcript(directory).splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if rec.get('type') != 'assistant/message':
            continue
        data = rec.get('data') or {}
        key = (data.get('turn'), data.get('step'))
        order.setdefault(key, len(order))
        prose = args = reasoning = 0
        for block in ((data.get('message') or {}).get('content') or []):
            if not isinstance(block, dict):
                continue
            kind = block.get('type')
            if kind == 'text':
                prose += len(block.get('text') or '')
            elif kind == 'tool-call':
                args += len(block.get('arguments') or '')
            elif kind == 'reasoning':
                reasoning += len(block.get('text') or '')
        row = per.setdefault(key, [0, 0, 0])
        row[0] += prose
        row[1] += args
        row[2] += reasoning
    return [per[k] for k in sorted(order, key=lambda k: order[k])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    dirs = sorted(glob.glob(os.path.join(SESS, '--*dsh-runs-suite-*')))
    if args.limit:
        dirs = dirs[:args.limit]

    turns = []
    for d in dirs:
        try:
            rows = steps_of(d)
        except Exception:
            continue
        if rows:
            turns.append(rows)
    long_turns = [t for t in turns if len(t) >= LONG_TURN_STEPS]
    if not long_turns:
        raise SystemExit('no long turns (>= %d steps) under %s' % (LONG_TURN_STEPS, SESS))

    later_steps = sum(len(t) - EARLY_STEPS for t in long_turns)
    result = {
        'sessions': len(dirs),
        'turns': len(turns),
        'long_turns': len(long_turns),
    }
    for idx, name in enumerate(('prose', 'args', 'reasoning')):
        early = sum(row[idx] for t in long_turns for row in t[:EARLY_STEPS])
        late = sum(row[idx] for t in long_turns for row in t[EARLY_STEPS:])
        result[name] = {
            'early_per_step': early / (EARLY_STEPS * len(long_turns)),
            'late_per_step': late / later_steps if later_steps else None,
            'early_total': early,
            'late_total': late,
            'late_share': late / (early + late) if early + late else None,
        }

    medians = []
    for i in range(20):
        vals = [t[i][2] for t in long_turns if len(t) > i]
        if not vals:
            break
        medians.append(statistics.median(vals))
    result['reasoning_median_per_step'] = medians

    rebound, ratios = 0, []
    for t in long_turns:
        if len(t) < 8:
            continue
        early = [row[2] for row in t[3:6]] or [0]
        late = [row[2] for row in t[-3:]]
        e = sum(early) / len(early)
        if e <= 0:
            continue
        l = sum(late) / len(late)
        ratios.append(l / e)
        if l > e:
            rebound += 1
    result['reasoning_rebound'] = {
        'turns': len(ratios),
        'rebounded': rebound,
        'median_ratio': statistics.median(ratios) if ratios else None,
    }

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    print('session dirs %d  turns %d  long turns (>=%d steps) %d  later steps %d'
          % (len(dirs), len(turns), LONG_TURN_STEPS, len(long_turns), later_steps))
    print('\nchannel              first %d steps   later steps   change   late share'
          % EARLY_STEPS)
    for idx, name in enumerate(('prose', 'args', 'reasoning')):
        c = result[('prose', 'args', 'reasoning')[idx]]
        change = (c['late_per_step'] / c['early_per_step'] - 1) if c['early_per_step'] else 0
        print('  %-18s %8.1f   %10.1f   %+6.1f%%   %5.1f%%'
              % (name, c['early_per_step'], c['late_per_step'] or 0,
                 100 * change, 100 * (c['late_share'] or 0)))
    print('\nreasoning median chars/step (long turns):')
    print('  ' + ' '.join('%d' % m for m in medians))
    r = result['reasoning_rebound']
    if r['turns']:
        print('\nrebound (steps 4-6 mean vs last-3 mean): %d/%d long turns, median ratio %.2f'
              % (r['rebounded'], r['turns'], r['median_ratio']))
        print('prose and args above are the channel that does NOT rebound: '
              'the lever targets reasoning and the reasoning channel is where it fails.')
    else:
        print('\nno turns long enough for the rebound check')


if __name__ == '__main__':
    main()
