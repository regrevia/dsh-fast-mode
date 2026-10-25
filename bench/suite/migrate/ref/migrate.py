#!/usr/bin/env python3
"""Migrate v1 JSON records (data/) to the v2 shape (out/v2/)."""

import json
import os
import re
import sys
from decimal import Decimal, ROUND_HALF_UP

CENTS_RE = re.compile(r"^-?[0-9]+(\.[0-9]+)?$")
DIGITS_RE = re.compile(r"^[0-9]+$")

REQUIRED = [
    ("id",),
    ("first_name",),
    ("last_name",),
    ("currency",),
    ("address",),
    ("address", "street"),
    ("address", "city"),
    ("address", "state"),
    ("address", "zip"),
]

USAGE = "usage: migrate.py {migrate,verify} [--data DIR] [--out DIR]"


def parse_args(argv):
    if not argv or argv[0] not in ("migrate", "verify"):
        return None
    cmd = argv[0]
    rest = argv[1:]
    data, out = "data", "out"
    i = 0
    while i < len(rest):
        arg = rest[i]
        if arg == "--data" and i + 1 < len(rest):
            data = rest[i + 1]
            i += 2
        elif arg == "--out" and i + 1 < len(rest):
            out = rest[i + 1]
            i += 2
        else:
            return None
    return cmd, data, out


def usd(cents):
    dollars = Decimal(cents) / Decimal(100)
    return format(dollars.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP), "f")


def lookup(rec, path):
    cur = rec
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return None, False
        cur = cur[key]
    return cur, True


def validate(rec):
    if not isinstance(rec, dict):
        return "bad_json"
    if "address" in rec and not isinstance(rec["address"], dict):
        return "bad_address"
    for path in REQUIRED:
        _, ok = lookup(rec, path)
        if not ok:
            return "missing_field:" + ".".join(path)
    rid = rec["id"]
    if isinstance(rid, bool) or not isinstance(rid, int) or rid < 1:
        return "bad_id"
    if not isinstance(rec["currency"], str):
        return "bad_currency"
    balance = rec["balance_cents"]
    if not isinstance(balance, str) or not CENTS_RE.match(balance):
        return "bad_balance"
    tags = rec.get("tags", [])
    if not isinstance(tags, list) or any(not isinstance(t, str) for t in tags):
        return "bad_tags"
    return None


def to_v2(rec):
    addr = rec["address"]
    out = {
        "id": rec["id"],
        "name": "%s, %s" % (rec["last_name"], rec["first_name"]),
        "currency": rec["currency"].upper(),
        "balance": usd(rec["balance_cents"]),
        "street": addr["street"],
        "city": addr["city"],
        "state": addr["state"],
        "postal_code": addr["zip"],
        "tags": list(rec.get("tags", [])),
    }
    for key in ("email", "phone"):
        if key in rec:
            out[key] = rec[key]
    if "line2" in addr:
        out["line2"] = addr["line2"]
    return out


def dump(obj):
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def source_names(data):
    return sorted(n for n in os.listdir(data) if n.endswith(".json")
                  and os.path.isfile(os.path.join(data, n)))


def load(data, name):
    try:
        with open(os.path.join(data, name), "r", encoding="utf-8") as f:
            return json.load(f)
    except ValueError:
        return None


def cmd_migrate(data, out):
    v2dir = os.path.join(out, "v2")
    os.makedirs(v2dir, exist_ok=True)
    errors = []
    for name in source_names(data):
        rec = load(data, name)
        code = validate(rec)
        if code:
            errors.append((name, code))
            continue
        v2 = to_v2(rec)
        path = os.path.join(v2dir, "%04d.json" % v2["id"])
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(dump(v2))
    with open(os.path.join(out, "errors.txt"), "w", encoding="utf-8", newline="\n") as f:
        for name, code in sorted(errors):
            f.write("%s: %s\n" % (name, code))
    return 0


def cmd_verify(data, out):
    valid = invalid = 0
    for name in source_names(data):
        if validate(load(data, name)):
            invalid += 1
        else:
            valid += 1
    sys.stdout.write("verify: %d valid, %d invalid\n" % (valid, invalid))
    return 2 if invalid else 0


def main(argv):
    parsed = parse_args(argv)
    if parsed is None:
        sys.stderr.write(USAGE + "\n")
        return 2
    cmd, data, out = parsed
    if not os.path.isdir(data):
        sys.stderr.write("error: no input directory: %s\n" % data)
        return 1
    if cmd == "migrate":
        return cmd_migrate(data, out)
    return cmd_verify(data, out)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
