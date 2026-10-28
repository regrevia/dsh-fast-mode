#!/usr/bin/env python3
"""Visible assistant prose vs tool-call argument characters.

Recomputes the claim "visible assistant prose is only ~1.2 % of (prose + tool
arguments)" from retained session transcripts, so the number in the docs has a
command behind it.

Counting unit is one `assistant/message` record of a session transcript:
  * numerator   = sum of len(text) over `content` parts of type `text`;
  * denominator = numerator + sum of len(arguments) over parts of type `tool-call`.
Reasoning parts, tool *results*, and user/system messages are excluded; a tool-call
part's `arguments` is the raw JSON string the model emitted, so the ratio compares
what the model wrote out of band with what it said in prose.

Usage:
  python3 bench/textshare.py                      # 40 def15 sessions, fixed rule
  python3 bench/textshare.py --all                # every def15 session on disk
  python3 bench/textshare.py --arm disc-only --limit 0 --tag D2B_MIG
  python3 bench/textshare.py --json               # machine-readable summary

Sampling rule (deterministic, no RNG): all session directories whose run-directory
name matches `suite-<tag>-<task>-p<pair>-<arm>` are collected, sorted by that
directory name, and the first --limit are used (--limit 0 = all). The same corpus
therefore always yields the same number.
"""
import argparse
import glob
import json
import os
import re
import statistics as st
import subprocess
import sys

SESS = os.path.expanduser('~/.dsh/sessions')
RUN_RE = re.compile(r'suite-(?P<tag>[A-Za-z0-9_]+)-(?P<task>\w+)-p(?P<pair>\d+)'
                    r'-(?P<arm>[A-Za-z0-9_]+)$')


def collect(arm, tag, limit):
    """[(session_dir, run_name)] for one arm, in a fixed sorted order."""
    out = []
    for d in glob.glob(os.path.join(SESS, '--*dsh-runs-suite-*')):
        name = os.path.basename(d).strip('-')
        m = RUN_RE.search(name)
        if not m or m.group('arm') != arm:
            continue
        if tag and m.group('tag') != tag:
            continue
        out.append((d, name))
    out.sort(key=lambda x: x[1])
    return out[:limit] if limit else out


def read_transcript(d):
    files = glob.glob(os.path.join(d, 'session-*', 'session.v4.jsonl.zstd'))
    for f in files:
        p = subprocess.run(['zstd', '-dc', f], capture_output=True)
        if p.returncode == 0:
            return p.stdout.decode('utf-8', 'replace')
    return ''


def tally(text):
    """(prose chars, tool-arg chars, messages, tool calls, multi-call messages).

    The docstring on `counts` lists what each number is; this wrapper keeps the
    historical tuple shape for callers that only need those six.
    """
    c = counts(text)
    return c['prose'], c['args'], c['messages'], c['calls'], c['multi'], c['textonly']


def counts(text):
    """Every per-run count, including the reasoning text the model emitted.

    `reasoning` is the part type the transcript uses for a route's thinking
    tokens. It is not billed as output prose, but it is decoded the same way and
    dominates emitted characters, which is why the mechanism report compares it.
    """
    prose = args = msgs = calls = multi = textonly = reasoning = 0
    for line in text.splitlines():
        try:
            o = json.loads(line)
        except Exception:  # noqa: BLE001 - a torn transcript line is not fatal
            continue
        if o.get('type') != 'assistant/message':
            continue
        msgs += 1
        this = 0
        for part in (o.get('data') or {}).get('message', {}).get('content') or []:
            if not isinstance(part, dict):
                continue
            if part.get('type') == 'text':
                prose += len(part.get('text') or '')
            elif part.get('type') == 'reasoning':
                reasoning += len(part.get('text') or '')
            elif part.get('type') == 'tool-call':
                calls += 1
                this += 1
                args += len(part.get('arguments') or '')
        if this >= 2:
            multi += 1
        elif this == 0:
            textonly += 1
    return {'prose': prose, 'args': args, 'messages': msgs, 'calls': calls, 'multi': multi,
            'textonly': textonly, 'reasoning': reasoning}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm', default='def15', help='arm name to sample (default def15)')
    ap.add_argument('--tag', default='', help='restrict to one block tag, e.g. D2B_MIG')
    ap.add_argument('--limit', type=int, default=40, help='sessions, first in sorted order; 0 = all')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()

    rows = collect(a.arm, a.tag, a.limit)
    per = []
    for d, name in rows:
        c = counts(read_transcript(d))
        if c['messages']:
            per.append({'run': name, 'prose': c['prose'], 'args': c['args'],
                        'reasoning': c['reasoning'], 'messages': c['messages'],
                        'calls': c['calls'], 'multi': c['multi'], 'textonly': c['textonly'],
                        'share': c['prose'] / (c['prose'] + c['args'])
                        if c['prose'] + c['args'] else 0})
    if not per:
        print(f'no transcripts for arm={a.arm} tag={a.tag or "*"}; nothing to compute')
        return 1
    prose = sum(r['prose'] for r in per)
    args = sum(r['args'] for r in per)
    total = prose + args
    shares = sorted(r['share'] for r in per)
    summary = {
        'arm': a.arm, 'tag': a.tag or '*', 'limit': a.limit,
        'sessions': len(per), 'messages': sum(r['messages'] for r in per),
        'calls': sum(r['calls'] for r in per),
        'multiCallMessages': sum(r['multi'] for r in per),
        'multiCallShare': (sum(r['multi'] for r in per) /
                           max(sum(r['messages'] for r in per), 1)),
        'textOnlyMessages': sum(r['textonly'] for r in per),
        'textOnlyShare': (sum(r['textonly'] for r in per) /
                          max(sum(r['messages'] for r in per), 1)),
        'proseChars': prose, 'toolArgChars': args, 'totalChars': total,
        'reasoningChars': sum(r['reasoning'] for r in per),
        'share': prose / total if total else None,
        'medianShare': st.median(shares), 'p10': shares[int(0.1 * (len(shares) - 1))],
        'p90': shares[int(0.9 * (len(shares) - 1))],
        'rule': f'sorted by run name, first {a.limit or "all"} of arm={a.arm}' +
                (f' tag={a.tag}' if a.tag else ''),
        'command': 'python3 bench/textshare.py' + ('' if a.arm == 'def15' else f' --arm {a.arm}') +
                   (f' --tag {a.tag}' if a.tag else '') +
                   ('' if a.limit == 40 else f' --limit {a.limit}'),
    }
    if a.json:
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return 0
    print(f"arm {a.arm} tag {a.tag or '*'}  {summary['rule']}")
    print(f"  sessions {summary['sessions']}  messages {summary['messages']}  "
          f"tool calls {summary['calls']}")
    print(f"  prose {prose:,} chars  tool args {args:,} chars  total {total:,} chars")
    if summary['reasoningChars']:
        print(f"  reasoning {summary['reasoningChars']:,} chars")
    print(f"  prose share {100 * summary['share']:.2f} %  "
          f"(median {100 * summary['medianShare']:.2f} %, "
          f"p10 {100 * summary['p10']:.2f} %, p90 {100 * summary['p90']:.2f} %)")
    print(f"  command: {summary['command']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
