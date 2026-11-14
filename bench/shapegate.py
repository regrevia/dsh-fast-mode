#!/usr/bin/env python3
"""Measure the shape gate against the retained transcripts, at zero cost.

`step-share.py` slices per-step reasoning and `turns.py` counts reminder
delivery, but neither reads `tool-call` records, so neither can answer any
of the questions that decide whether `shapeGate` is usable:

  1. How often does the gate fire at all, and how often does it fire exactly
     at step 4 of a long turn -- the one step where the compression reminder
     would otherwise go out?
  2. Why does it fire that often?  Which tools make up the unsafe share?
  3. What would a repair cost?  Re-run the same predicate counting only
     `MUTATING_CALLS`, which is the smallest change that keeps the gate's
     documented contract intact.

The predicate mirrors `src/auto.js`: `stats.turnCalls >= 4` and
`stats.turnUnsafe * 10 >= stats.turnCalls * 6`, where `turnUnsafe` counts
every call whose name is not in `SAFE_CALLS`.  Reminders are not replayed --
this measures the gate condition, not its effect on a turn.

Usage:
    python3 bench/shapegate.py              # summary tables
    python3 bench/shapegate.py --json       # same numbers as JSON
    python3 bench/shapegate.py --limit 60   # first 60 sessions only
"""

import argparse
import collections
import glob
import json
import os
import subprocess

SESS = os.path.expanduser('~/.dsh/sessions')

# Kept in sync with src/auto.js by hand; both lists are asserted below against
# the source file so a drift fails loudly instead of silently changing numbers.
SAFE_CALLS = {'read', 'grep', 'glob', 'list', 'ls', 'find', 'web_fetch',
              'web_search', 'fetch', 'search', 'journal'}
MUTATING_CALLS = {'write', 'write_file', 'create_file', 'edit', 'multi_edit',
                  'apply_patch', 'patch'}

LONG_TURN_STEPS = 10
GATE_MIN_CALLS = 4
GATE_SHARE_TENTHS = 6


def check_against_source():
    """Fail if the two lists have drifted from src/auto.js."""
    here = os.path.dirname(os.path.abspath(__file__))
    src = os.path.join(here, os.pardir, 'src', 'auto.js')
    if not os.path.exists(src):
        return 'src/auto.js not found, lists not verified'
    lines = open(src, encoding='utf-8').read().splitlines()
    problems = []
    for name, want in (('SAFE_CALLS', SAFE_CALLS), ('MUTATING_CALLS', MUTATING_CALLS)):
        start = next((i for i, l in enumerate(lines)
                      if l.strip().startswith('const ' + name + ' =')), None)
        if start is None:
            problems.append('%s not found in src/auto.js' % name)
            continue
        # The declaration may wrap over several lines; collect until it closes.
        block, depth = [], 0
        for line in lines[start:start + 8]:
            block.append(line)
            depth += line.count('[') - line.count(']')
            if depth <= 0:
                break
        text_of_block = '\n'.join(block)
        missing = [n for n in want if "'%s'" % n not in text_of_block]
        if missing:
            problems.append('%s drifted, missing %s' % (name, ', '.join(missing)))
    return '; '.join(problems) if problems else None


def session_turns(directory):
    """Return one list per turn, each a list per step, each a list of tool names."""
    files = glob.glob(os.path.join(directory, 'session-*', 'session.v4.jsonl.zstd'))
    if not files:
        return []
    proc = subprocess.run(['zstd', '-dc', files[0]], capture_output=True)
    if proc.returncode:
        return []
    order, per_step = {}, collections.defaultdict(list)
    for line in proc.stdout.decode('utf-8', 'replace').splitlines():
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
        for block in ((data.get('message') or {}).get('content') or []):
            if isinstance(block, dict) and block.get('type') == 'tool-call':
                per_step[key].append(block.get('name') or '?')
    turns, current, buf = [], None, []
    for key in sorted(order, key=lambda k: order[k]):
        if key[0] != current:
            if current is not None:
                turns.append(buf)
            current, buf = key[0], []
        buf.append(per_step[key])
    if current is not None:
        turns.append(buf)
    return turns


def gate_fires(turn, upto_step, mode):
    """Whether the gate is closed when deciding the reminder for `upto_step`."""
    names = [n for step in turn[:upto_step] for n in step]
    calls = len(names)
    if calls < GATE_MIN_CALLS:
        return False
    if mode == 'current':
        unsafe = sum(1 for n in names if n not in SAFE_CALLS)
        return unsafe * 10 >= calls * GATE_SHARE_TENTHS
    writes = sum(1 for n in names if n in MUTATING_CALLS)
    if mode == 'writes':
        return writes >= 2 and writes * 10 >= calls * GATE_SHARE_TENTHS
    if mode == 'writes1':
        return writes * 10 >= calls * GATE_SHARE_TENTHS
    raise ValueError(mode)


def unsafe_share(turn):
    names = [n for step in turn for n in step]
    if not names:
        return None
    return sum(1 for n in names if n not in SAFE_CALLS) / len(names)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0,
                    help='only scan the first N session directories')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    dirs = sorted(glob.glob(os.path.join(SESS, '--*dsh-runs-suite-*')))
    if args.limit:
        dirs = dirs[:args.limit]
    turns = []
    for d in dirs:
        turns.extend(session_turns(d))
    long_turns = [t for t in turns if len(t) >= LONG_TURN_STEPS]
    if not turns:
        raise SystemExit('no transcripts under %s' % SESS)

    tool_counts = collections.Counter(
        n for t in turns for step in t for n in step)
    total_calls = sum(tool_counts.values())
    safe_calls = sum(c for n, c in tool_counts.items() if n in SAFE_CALLS)

    result = {
        'sessions': len(dirs),
        'turns': len(turns),
        'long_turns': len(long_turns),
        'total_tool_calls': total_calls,
        'safe_calls': safe_calls,
        'safe_share': safe_calls / total_calls if total_calls else None,
        'tools': tool_counts.most_common(),
        'gates': {},
        'long_turn_unsafe_share': {},
    }
    for mode in ('current', 'writes', 'writes1'):
        fires = sum(1 for t in turns if any(gate_fires(t, i, mode)
                                            for i in range(1, len(t) + 1)))
        at_step4 = sum(1 for t in long_turns if gate_fires(t, 3, mode))
        result['gates'][mode] = {
            'fires': fires,
            'fires_share': fires / len(turns),
            'long_blocked_at_step4': at_step4,
            'long_blocked_share': at_step4 / len(long_turns) if long_turns else None,
        }
    shares = sorted(s for s in (unsafe_share(t) for t in long_turns) if s is not None)
    if shares:
        mid = len(shares) // 2
        median = (shares[mid] if len(shares) % 2 else
                  (shares[mid - 1] + shares[mid]) / 2)
        result['long_turn_unsafe_share'] = {
            'median': median,
            'mean': sum(shares) / len(shares),
            'at_or_above_60pct': sum(1 for s in shares if s >= 0.6),
        }

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    drift = check_against_source()
    if drift:
        print('WARNING: %s\n' % drift)
    print('sessions %d  turns %d  long turns (>=%d steps) %d  tool calls %d'
          % (len(dirs), len(turns), LONG_TURN_STEPS, len(long_turns), total_calls))
    print('\ntool mix (SAFE_CALLS membership decides "unsafe"):')
    for name, count in tool_counts.most_common(8):
        kind = 'safe  ' if name in SAFE_CALLS else 'unsafe'
        print('  %-12s %5d  %5.1f%%  %s' % (name, count, 100 * count / total_calls, kind))
    print('  safe-classified %d = %.1f%%   unsafe %.1f%%'
          % (safe_calls, 100 * safe_calls / total_calls,
             100 * (1 - safe_calls / total_calls)))
    print('\ngate definitions (>= %d calls and >= %d%% of them unsafe):'
          % (GATE_MIN_CALLS, 10 * GATE_SHARE_TENTHS))
    for mode in ('current', 'writes', 'writes1'):
        g = result['gates'][mode]
        print('  %-8s fires in %d/%d = %5.1f%%   long turns blocked at step 4: %d/%d = %5.1f%%'
              % (mode, g['fires'], len(turns), 100 * g['fires_share'],
                 g['long_blocked_at_step4'], len(long_turns),
                 100 * (g['long_blocked_share'] or 0)))
    if shares:
        s = result['long_turn_unsafe_share']
        print('\nlong-turn unsafe share: median %.1f%%  mean %.1f%%  '
              '>=60%% in %d/%d turns'
              % (100 * s['median'], 100 * s['mean'], s['at_or_above_60pct'], len(shares)))


if __name__ == '__main__':
    main()
