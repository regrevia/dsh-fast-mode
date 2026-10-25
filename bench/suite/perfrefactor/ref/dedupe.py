"""Reference implementation: extracts each item's key exactly once."""

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
        raw = key(item)
        STATS["calls"] += 1
        norm = _normalize(raw)
        match = None
        start = max(0, len(kept) - window)
        for index in range(len(kept) - 1, start - 1, -1):
            if kept[index]["norm"] == norm:
                match = index
                break
        if match is None:
            kept.append({"item": item, "key": raw, "norm": norm})
        elif len(raw) > len(kept[match]["key"]):
            kept[match] = {"item": item, "key": raw, "norm": norm}
    return [record["item"] for record in kept]
