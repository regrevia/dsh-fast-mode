#!/usr/bin/env python3
"""Break the model-visible text of a session arm down by where it came from.

This is the denominator behind the `compactResults` verdict: the removable part of
a tool result is a share of tool-result text, and tool-result text is only a share
of everything the model reads. Without that second share, a 6.4 % figure reads as
"6.4 % of the prompt" when it is 0.77 %.

Channels (one `assistant/message` or `/tool/result` record is the unit):
  * `reasoning`        assistant/message, content parts of type `reasoning`
  * `prose`            assistant/message, content parts of type `text`
  * `args`             assistant/message, content parts of type `tool-call` (`arguments`)
  * `toolresult`       /tool/result, `data.message.content[].text`
  * `user/message`     whole `data` as JSON, the record shape these transcripts use
  * `system/message`   ditto
  * `agent/inbox/spliced`  ditto -- this is how the plugin's own reminders land

The record shapes matter. An earlier pass matched only `data['result']` and got
near-zero tool-result text; `/tool/result` carries it at
`data.message.content[].text`. `compactshare.py` reads the same path, so the two
scripts agree on what a tool result is.

Usage:
  python3 bench/mix.py                       # std, first 135 sessions
  python3 bench/mix.py --arm off --limit 0   # every off-arm session on disk
  python3 bench/mix.py --limit 0 --json      # machine-readable summary

Sampling rule (deterministic, no RNG): inherited from `textshare.collect`, which
sorts run directories by name and takes the first `--limit` (`--limit 0` = all).
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import textshare as ts  # noqa: E402 - shares the transcript decoder and sampler

# A tool result over this size is what `compactResults` can touch at all.
BIG_RESULT = 8000
# It keeps head 40 % + tail 25 %, so at most 35 % of such a result is removable.
KEEP = 0.65

LABELS = (
    ('reasoning', 'reasoning'),
    ('user/message', 'user 消息'),
    ('toolresult', '工具结果'),
    ('args', '工具参数'),
    ('system/message', 'system 消息'),
    ('agent/inbox/spliced', '插件注入的提醒'),
    ('prose', 'assistant 可见文字'),
)


def walk(text, c):
    """Accumulate one transcript's channels into counter `c`."""
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue  # a torn line is not fatal; see textshare.counts
        t = rec.get('type') or ''
        data = rec.get('data') or {}
        if t == 'assistant/message':
            msg = (data.get('message') or {}).get('content') or []
            for blk in msg:
                if not isinstance(blk, dict):
                    continue
                k = blk.get('type')
                if k == 'reasoning':
                    c['reasoning'] += len(blk.get('text') or '')
                elif k == 'text':
                    c['prose'] += len(blk.get('text') or '')
                elif k == 'tool-call':
                    c['args'] += len(blk.get('arguments') or '')
        elif t in ('/tool/result', 'tool/result'):
            content = (data.get('message') or {}).get('content')
            if isinstance(content, list):
                txt = ''.join(x.get('text') or '' for x in content
                              if isinstance(x, dict) and x.get('type') == 'text')
                c['toolresult'] += len(txt)
                if len(txt) > BIG_RESULT:
                    c['big'] += len(txt)
                    c['bigcount'] += 1
        elif t in ('user/message', 'system/message', 'agent/inbox/spliced'):
            # These records carry the text somewhere other than message.content[],
            # so serialise the whole data blob. It slightly over-counts the
            # envelope, which is why this is a share estimate, not a byte census.
            c[t] += len(json.dumps(data, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm', default='std', help='arm name (default std)')
    ap.add_argument('--tag', default='', help='restrict to one suite tag')
    ap.add_argument('--limit', type=int, default=135, help='sessions, 0 = all')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()

    c = dict.fromkeys([k for k, _ in LABELS], 0)
    c['big'] = c['bigcount'] = 0
    dirs = ts.collect(a.arm, a.tag, a.limit)
    used = 0
    for d, _name in dirs:
        text = ts.read_transcript(d)
        if not text:
            continue
        walk(text, c)
        used += 1

    total = sum(c[k] for k, _ in LABELS)
    if not total:
        print(f'no transcripts for arm {a.arm!r}', file=sys.stderr)
        return 1
    tr = c['toolresult'] or 1
    removable = (1 - KEEP) * c['big']

    if a.json:
        print(json.dumps({
            'arm': a.arm, 'tag': a.tag, 'sessions': used, 'of': len(dirs),
            'channels': {k: c[k] for k, _ in LABELS},
            'total': total,
            'big_result_chars': c['big'], 'big_result_count': c['bigcount'],
            'removable_chars': round(removable),
            'removable_share_of_tool_results': removable / tr,
            'removable_share_of_visible': removable / total,
        }, indent=2))
        return 0

    print(f'{a.arm} sessions {used}/{len(dirs)}')
    for k, label in sorted(LABELS, key=lambda kv: -c[kv[0]]):
        print(f'  {label:20s} {c[k]:>9d}  {100 * c[k] / total:5.2f} %')
    print(f'  {"合计":20s} {total:>9d}  100 %')
    print()
    print(f'  results >{BIG_RESULT} chars: {c["bigcount"]} = {c["big"]} chars '
          f'= {100 * c["big"] / tr:.1f} % of tool-result text')
    print(f'  compaction removable <= {removable:.0f} chars = '
          f'{100 * removable / tr:.1f} % of tool-result text = '
          f'{100 * removable / total:.2f} % of all visible text')
    return 0


if __name__ == '__main__':
    sys.exit(main())
