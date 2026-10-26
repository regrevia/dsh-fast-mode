#!/usr/bin/env python3
"""Count how often a given notice text reached the model, per run of a block.

Protocol item 13 in bench/README.md: an arm is only a measurement of its
mechanism if the notice it adds actually appeared in the session transcript.
This reads the harness session directories for one tag and prints, per task x
pair x arm, how many times the needle showed up. A control arm must be 0, a
treatment arm must be >= 1, and a treatment row at 0 makes that cell
"untested" rather than "slower".

Usage:
    python3 bench/audit-delivery.py --tag W10 --needle "Auto map: one inventory"
"""
import argparse
import glob
import os
import subprocess


def read_session(directory):
    """Concatenate every transcript file in one session directory."""
    out = []
    for root, _, files in os.walk(directory):
        for name in files:
            path = os.path.join(root, name)
            if name.endswith('.zstd'):
                done = subprocess.run(['zstd', '-dc', path], capture_output=True, text=True)
                out.append(done.stdout or '')
            elif name.endswith('.jsonl'):
                try:
                    out.append(open(path, errors='ignore').read())
                except OSError:
                    pass
    return ''.join(out)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tag', required=True)
    parser.add_argument('--needle', required=True)
    parser.add_argument('--sessions', default=os.path.expanduser('~/.dsh/sessions'))
    args = parser.parse_args()

    pattern = os.path.join(args.sessions, f'*suite-{args.tag}-*')
    rows = []
    for directory in sorted(glob.glob(pattern)):
        tag = os.path.basename(directory).split(f'-suite-{args.tag}-')[-1].rstrip('-')
        text = read_session(directory)
        rows.append((tag, text.count(args.needle), len(text)))

    if not rows:
        raise SystemExit(f'no session directories for tag {args.tag} under {args.sessions}')
    print(f'{"cell":30}{"hits":>6}{"transcript":>12}')
    for tag, hits, size in rows:
        print(f'{tag:30}{hits:>6}{size:>12}')
    zero = [tag for tag, hits, _ in rows if hits == 0]
    print(f'\n{len(rows) - len(zero)}/{len(rows)} sessions delivered the notice'
          + (f'; zero-hit: {", ".join(zero)}' if zero else ''))


if __name__ == '__main__':
    main()
