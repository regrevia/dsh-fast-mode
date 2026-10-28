#!/usr/bin/env python3
"""Does the late-discipline reminder re-arm per turn, and only once per turn?

The reminder is a once-per-turn lever: `disciplineSent` latches it so a long turn
is told to stop narrating exactly once, and `noteTurn` clears the latch so the
next request in the same session is told again. Both halves are invisible in the
wall-clock numbers — a turn that never got the reminder looks like a turn that
ignored it, and a turn that got it twice looks like a model that keeps forgetting.

This reads retained transcripts, segments them on `turn/start`, and reports:

- turns per session, steps per turn;
- turns long enough to qualify (>= 4 steps) that got **no** reminder;
- turns that got **two or more** reminders (the latch leaking);
- re-arm rate: in multi-turn sessions, the share of later qualifying turns that
  were reminded again.

Usage:
  python3 bench/turns.py                  # suite sessions
  python3 bench/turns.py --limit 100      # first 100 transcripts
  python3 bench/turns.py --min-steps 4 --json
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import subprocess
import time

SESS = os.path.expanduser('~/.dsh/sessions')
NEEDLE = 'this turn is long enough that prose'
# A delivered directive is a message part; the model quoting it back inside its
# own prose is an echo, so assistant-authored text never counts as delivery.
PLUGIN_ROLES = {'user/message', 'agent/inbox/spliced', 'system/message'}


def transcripts(pattern, limit, exclude_arm=('off',)):
    """Session transcripts whose run directory (the slug) is not one of `exclude_arm`.

    The slug mirrors the run directory, so `...-suite-D2G2-ledger-p1-def15--`
    identifies the arm without re-reading the YAML.
    """
    out = []
    for d in sorted(glob.glob(os.path.join(SESS, pattern))):
        name = os.path.basename(d)
        if any(name.endswith(f'-{arm}--') for arm in exclude_arm):
            continue
        out.extend(glob.glob(os.path.join(d, 'session-*', 'session.v4.jsonl.zstd')))
    return out[:limit] if limit else out


def text_of(data):
    msg = data.get('message') or data
    parts = msg.get('content') if isinstance(msg, dict) else None
    if not isinstance(parts, list):
        return ''
    return ' '.join(p.get('text') or '' for p in parts
                    if isinstance(p, dict) and p.get('type') == 'text')


def scan(path):
    """Return (started_ms, turns) for one transcript, or None if unreadable."""
    p = subprocess.run(['zstd', '-dc', path], capture_output=True)
    if p.returncode != 0:
        return None
    started = 0
    turns = []
    cur = {'steps': 0, 'reminders': 0, 'reminderSeqs': [], 'compactions': []}
    for line in p.stdout.decode('utf-8', 'replace').splitlines():
        if ('turn/start' not in line and 'step/start' not in line
                and 'Auto schedule' not in line and 'compaction/start' not in line):
            continue
        try:
            o = json.loads(line)
        except Exception:  # noqa: BLE001 - a torn line is not fatal
            continue
        kind = o.get('type')
        data = o.get('data') or {}
        if not started and isinstance(o.get('time'), int):
            started = o['time']
        if kind == 'turn/start':
            if cur['steps'] or cur['reminders']:
                turns.append(cur)
            cur = {'steps': 0, 'reminders': 0, 'reminderSeqs': [], 'compactions': []}
        elif kind == 'step/start':
            cur['steps'] += 1
        elif kind == 'compaction/start':
            cur['compactions'].append(o.get('seq'))
        elif kind in PLUGIN_ROLES and NEEDLE in text_of(data):
            cur['reminders'] += 1
            cur['reminderSeqs'].append(o.get('seq'))
    if cur['steps'] or cur['reminders']:
        turns.append(cur)
    return started, turns


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0, help='transcripts; 0 = all')
    ap.add_argument('--dir', default='--*dsh-runs-suite-*')
    ap.add_argument('--min-steps', type=int, default=4)
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--exclude-arm', action='append', default=[],
                    help='skip sessions whose run directory ends in this arm (default: off)')
    ap.add_argument('--since-hours', type=float, default=0,
                    help='only sessions started within this many hours')
    a = ap.parse_args()

    sessions = turns_total = multi = 0
    qualifying = reminded = 0
    misses = doubled = doubled_compacted = 0
    later_qualifying = later_reminded = 0
    per_session_turns = collections.Counter()
    cutoff = (time.time() - a.since_hours * 3600) * 1000 if a.since_hours else 0
    skipped_old = 0
    for f in transcripts(a.dir, a.limit, tuple(a.exclude_arm or ['off'])):
        r = scan(f)
        if not r:
            continue
        started, turns = r
        if cutoff and started and started < cutoff:
            skipped_old += 1
            continue
        if not turns:
            continue
        sessions += 1
        turns_total += len(turns)
        per_session_turns[len(turns)] += 1
        if len(turns) > 1:
            multi += 1
        for i, t in enumerate(turns):
            if t['steps'] >= a.min_steps:
                qualifying += 1
                if t['reminders']:
                    reminded += 1
                else:
                    misses += 1
                if i > 0:
                    later_qualifying += 1
                    later_reminded += 1 if t['reminders'] else 0
            if t['reminders'] > 1:
                doubled += 1
                seqs = t['reminderSeqs']
                if any(c is not None and seqs and seqs[0] < c < seqs[-1] for c in t['compactions']):
                    doubled_compacted += 1

    out = {
        'sessions': sessions,
        'turns': turns_total,
        'multi_turn_sessions': multi,
        'turns_per_session': dict(sorted(per_session_turns.items())),
        'min_steps': a.min_steps,
        'qualifying_turns': qualifying,
        'reminded': reminded,
        'missed': misses,
        'doubled': doubled,
        'doubled_with_compaction_between': doubled_compacted,
        'later_qualifying_turns': later_qualifying,
        'later_reminded': later_reminded,
        'skipped_old': skipped_old,
        'since_hours': a.since_hours,
    }
    if a.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return
    print(f"sessions {sessions}  turns {turns_total}  multi-turn {multi} "
          f"({100 * multi / max(sessions, 1):.0f} %)")
    print(f"turns per session: {dict(sorted(per_session_turns.items()))}")
    print(f"qualifying turns (>= {a.min_steps} steps) {qualifying}  "
          f"reminded {reminded} ({100 * reminded / max(qualifying, 1):.0f} %)  "
          f"missed {misses}  doubled {doubled} "
          f"(with a compaction between: {doubled_compacted})")
    print(f"later turns in multi-turn sessions: qualifying {later_qualifying}  "
          f"reminded {later_reminded} "
          f"({100 * later_reminded / max(later_qualifying, 1):.0f} %)")


if __name__ == '__main__':
    main()
