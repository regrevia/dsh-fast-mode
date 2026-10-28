#!/usr/bin/env python3
"""Drop rows that fail the validity rule from result files, so the cell is retried.

A row that fails `pool.valid` (exit != 0, steps < 1, out <= 0, no session ids, or a leak)
can never be pooled. Leaving it in place is worse than having no row at all: the
resume logic in `suite-run.py` skips any cell that already has a row, so an invalid
row silently freezes that cell as "measured" forever. This tool rewrites the file
without those rows and reports what it removed.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pool  # noqa: E402
import json

RESULTS = Path(__file__).resolve().parent / 'results'


def scrub(tag: str) -> tuple[int, int]:
    path = RESULTS / f'suite-{tag}.jsonl'
    if not path.exists():
        return 0, 0
    keep, drop = [], []
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        (keep if pool.valid(row) else drop).append(line)
    if drop:
        path.write_text('\n'.join(keep) + ('\n' if keep else ''), encoding='utf-8')
    return len(keep), len(drop)


def main() -> int:
    tags = sys.argv[1:]
    if not tags:
        tags = [p.name[len('suite-'):-len('.jsonl')]
                for p in sorted(RESULTS.glob('suite-*.jsonl'))]
    for tag in tags:
        kept, dropped = scrub(tag)
        if dropped:
            print(f'{tag}: kept {kept}, dropped {dropped} invalid')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
