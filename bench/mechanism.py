#!/usr/bin/env python3
"""What actually changes between two arms: steps, tool calls, batching, prose.

The wall-clock win of fast mode is a step-count win (see BENCHMARK.md). This
script opens the retained transcripts behind matched runs and reports *which*
count moved, so the mechanism can be named instead of inferred:

  messages      assistant messages = steps as the runner counts them
  calls         tool calls emitted
  calls/msg     batching width
  multiShare    share of messages carrying >= 2 tool calls
  textOnlyShare share of messages carrying no tool call (narration-only steps)
  proseShare    visible prose chars / (prose + tool-argument chars)

Usage:
  python3 bench/mechanism.py --arm off --arm def15            # every matched pair
  python3 bench/mechanism.py --arm off --arm def15 --tag DEF_MIG
  python3 bench/mechanism.py --arm off --arm def15 --json
  python3 bench/mechanism.py --list-arms                     # what is on disk

Runs are the session directories named `suite-<tag>-<task>-p<pair>-<arm>`;
only (tag, task, pair) groups that contain **both** arms are used, so the task
mix cancels exactly like the wall-clock block score does.
"""
import argparse
import collections
import glob
import importlib.util
import json
import os
import statistics as st
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SESS = os.path.expanduser('~/.dsh/sessions')

spec = importlib.util.spec_from_file_location('textshare', os.path.join(HERE, 'textshare.py'))
textshare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(textshare)


def collect_all():
    out = []
    for d in glob.glob(os.path.join(SESS, '--*dsh-runs-suite-*')):
        name = os.path.basename(d).strip('-')
        m = textshare.RUN_RE.search(name)
        if not m:
            continue
        out.append((m.group('tag'), m.group('task'), int(m.group('pair')), m.group('arm'), d, name))
    out.sort(key=lambda x: x[5])
    return out


def stats_for(run):
    text = textshare.read_transcript(run[4])
    c = textshare.counts(text)
    prose, args, msgs, calls, multi, textonly = (c['prose'], c['args'], c['messages'],
                                                 c['calls'], c['multi'], c['textonly'])
    if not msgs:
        return None
    return {'prose': prose, 'args': args, 'messages': msgs, 'calls': calls,
            'multi': multi, 'textonly': textonly, 'reasoning': c['reasoning'],
            'emitted': prose + args + c['reasoning'],
            'callsPerMsg': calls / msgs,
            'multiShare': multi / msgs,
            'textOnlyShare': textonly / msgs,
            'proseShare': prose / (prose + args) if prose + args else 0.0}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm', action='append', default=[])
    ap.add_argument('--tag', default='')
    ap.add_argument('--limit', type=int, default=0, help='max matched groups; 0 = all')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--list-arms', action='store_true')
    a = ap.parse_args()

    runs = collect_all()
    if a.list_arms:
        c = collections.Counter(r[3] for r in runs)
        for arm, n in c.most_common():
            print(f'{arm:12} {n:5} runs')
        return 0
    arms = a.arm or ['off', 'def15']
    if len(arms) != 2:
        print('give exactly two --arm values', file=sys.stderr)
        return 2

    groups = collections.defaultdict(dict)
    for tag, task, pair, arm, d, name in runs:
        if a.tag and tag != a.tag:
            continue
        if arm not in arms:
            continue
        groups[(tag, task, pair)][arm] = (tag, task, pair, arm, d, name)

    cells = []
    for key in sorted(groups):
        g = groups[key]
        if not all(x in g for x in arms):
            continue
        row = {x: stats_for(g[x]) for x in arms}
        if any(v is None for v in row.values()):
            continue
        cells.append(row)
    if a.limit:
        cells = cells[:a.limit]
    if not cells:
        print('no matched groups with transcripts; nothing to compute', file=sys.stderr)
        return 1

    keys = ['messages', 'calls', 'callsPerMsg', 'multiShare', 'textOnlyShare', 'proseShare',
            'prose', 'args', 'reasoning', 'emitted']
    med = {x: {k: st.median([c[x][k] for c in cells]) for k in keys} for x in arms}
    summary = {'arms': arms, 'tag': a.tag or '*', 'groups': len(cells)}
    for k in keys:
        summary[k] = {'median': {x: med[x][k] for x in arms}}
        ratios = [c[arms[1]][k] / c[arms[0]][k] for c in cells if c[arms[0]][k]]
        summary[k]['medianRatio'] = st.median(ratios) if ratios else None
    if a.json:
        print(json.dumps(summary, indent=2))
        return 0
    print(f"matched groups: {len(cells)}  (arm A = {arms[0]}, arm B = {arms[1]})")
    print(f"{'metric':16} {arms[0]:>12} {arms[1]:>12} {'B/A':>7}")
    def fmt(v):
        """Shares are small floats, counts are characters; keep both readable."""
        return f'{v:.3f}' if isinstance(v, float) and abs(v) < 100 else f'{v:,.0f}'

    for k in keys:
        b, r = med[arms[1]][k], summary[k]['medianRatio']
        print(f"{k:16} {fmt(med[arms[0]][k]):>12} {fmt(b):>12} "
              f"{(r if r is not None else float('nan')):7.3f}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
