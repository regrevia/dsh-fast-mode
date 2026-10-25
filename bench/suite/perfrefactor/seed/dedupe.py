"""Seed implementation: correct, but re-extracts keys inside every comparison.

`resolve` below calls `key()` O(n^2) times. Keep the public API and the observable
behaviour identical while making it call `key()` at most once per item.
"""

STATS = {"calls": 0}


def _normalize(value):
    if not isinstance(value, str):
        raise TypeError("key must return str")
    chars = []
    for ch in value.strip().lower():
        chars.append(ch if ("a" <= ch <= "z" or "0" <= ch <= "9") else " ")
    return " ".join("".join(chars).split())


def _check_window(window):
    if isinstance(window, bool) or not isinstance(window, int) or window < 0:
        raise ValueError("window must be a non-negative int")


def resolve(items, key, *, window=3):
    _check_window(window)
    kept = []
    for item in items:
        match = None
        start = max(0, len(kept) - window)
        for index in range(len(kept) - 1, start - 1, -1):
            left = key(item)
            STATS["calls"] += 1
            right = key(kept[index]["item"])
            STATS["calls"] += 1
            if _normalize(left) == _normalize(right):
                match = index
                break
        raw = key(item)
        STATS["calls"] += 1
        _normalize(raw)
        if match is None:
            kept.append({"item": item, "key": raw})
        elif len(raw) > len(kept[match]["key"]):
            kept[match] = {"item": item, "key": raw}
    return [record["item"] for record in kept]
