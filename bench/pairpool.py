#!/usr/bin/env python3
"""Pool paired blocks: per-pair ratios of one arm against a baseline arm.

    python3 bench/pairpool.py --files results/suite-PANEL1.jsonl results/suite-PANEL1B.jsonl \
        --baseline std --arm agg

Reads the same jsonl the runner appends. A pair is one (task, pair) cell with both
arms complete and green; anything else is listed as dropped, never silently
averaged. Geometric mean over cells, 4000-resample bootstrap CI.
"""
import argparse, collections, json, math, random, sys

METRICS = [("wall", "wall s"), ("out", "out tok"), ("steps", "steps")]


def geo(xs):
    return math.exp(sum(math.log(x) for x in xs) / len(xs))


def ci(xs, n):
    rnd = random.Random(7)
    out = sorted(geo([rnd.choice(xs) for _ in xs]) for _ in range(n))
    return out[int(0.025 * n)], out[int(0.975 * n)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--files", nargs="+", required=True)
    ap.add_argument("--baseline", default="off")
    ap.add_argument("--arm", required=True)
    ap.add_argument("--ci", type=int, default=4000)
    a = ap.parse_args()

    cells, dropped = collections.defaultdict(dict), []
    for path in a.files:
        for line in open(path):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            cells[(path, r["task"], r["pair"])][r["arm"]] = r
    ratios = collections.defaultdict(list)
    for (path, task, pair), arms in sorted(cells.items()):
        if a.baseline not in arms or a.arm not in arms:
            dropped.append(f"{task}-p{pair}: missing arm")
            continue
        b, t = arms[a.baseline], arms[a.arm]
        if not (b.get("green") and t.get("green")):
            dropped.append(f"{task}-p{pair}: red ({a.baseline}={b.get('green')},{a.arm}={t.get('green')})")
            continue
        for key, _label in METRICS:
            ratios[key].append(t[key] / b[key])
    if not ratios["wall"]:
        sys.exit("no complete green pair")
    print(f"pairs {len(ratios['wall'])}  baseline {a.baseline}  arm {a.arm}")
    for key, label in METRICS:
        xs = ratios[key]
        lo, hi = ci(xs, a.ci)
        print(
            f"  {label:8s} geo {geo(xs):.3f}x  CI95 [{lo:.3f}, {hi:.3f}]  "
            f"faster {sum(x < 1 for x in xs)}/{len(xs)}  median {sorted(xs)[len(xs)//2]:.3f}x"
        )
    for d in dropped:
        print(f"  dropped: {d}")


if __name__ == "__main__":
    main()
