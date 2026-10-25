import re
from decimal import Decimal, ROUND_HALF_UP

_CENT = Decimal("0.01")

def parse_amount(s):
    t = (s or "").strip().replace(",", "")
    if not t:
        raise ValueError(s)
    neg = False
    if t.startswith("(") and t.endswith(")"):
        neg = True; t = t[1:-1].strip()
    if t.startswith("-"):
        neg = not neg; t = t[1:].strip()
    if t.startswith("$"):
        t = t[1:].strip()
    if not re.fullmatch(r"\d+(\.\d+)?", t):
        raise ValueError(s)
    v = Decimal(t).quantize(_CENT, rounding=ROUND_HALF_UP)
    return -v if neg else v

def _fmt(v):
    v = v.quantize(_CENT, rounding=ROUND_HALF_UP)
    return f"{v:.2f}"

def sum_by_category(entries):
    totals = {}
    for e in entries:
        c = e["category"]
        totals[c] = totals.get(c, Decimal("0")) + parse_amount(e["amount"])
    return {k: totals[k] for k in sorted(totals)}

def running_balance(entries):
    out, run = [], Decimal("0")
    for e in entries:
        run += parse_amount(e["amount"])
        out.append(run.quantize(_CENT))
    return out

def apply_rules(entries, rules):
    out = []
    for e in entries:
        amt = parse_amount(e["amount"]); idx = None
        for i, r in enumerate(rules):
            if r.get("category") is not None and r["category"] != e["category"]: continue
            if r.get("account") is not None and r["account"] != e["account"]: continue
            amt = (amt * Decimal(r["multiplier"]) + Decimal(r["offset"])).quantize(_CENT, rounding=ROUND_HALF_UP)
            idx = i; break
        ne = dict(e); ne["amount"] = _fmt(amt); ne["rule_index"] = idx
        out.append(ne)
    return out

def monthly_summary(entries):
    months = {}
    for e in entries:
        m = e["date"][:7]
        per = months.setdefault(m, {"count": 0, "total": Decimal("0"), "cats": {}})
        amt = parse_amount(e["amount"]); c = e["category"]
        per["count"] += 1; per["total"] += amt
        per["cats"][c] = per["cats"].get(c, Decimal("0")) + abs(amt)
    res = {}
    for m in sorted(months):
        p = months[m]
        top = min(p["cats"], key=lambda k: (-p["cats"][k], k))
        res[m] = {"count": p["count"], "total": p["total"].quantize(_CENT), "max_category": top}
    return res

def format_report(summary, width=72):
    out = "LEDGER REPORT"
    for m in sorted(summary):
        v = summary[m]
        out += f"\n\n{m}  count={v['count']}  total={_fmt(v['total'])}\n  top: {v['max_category']}"
    return out + "\n"
