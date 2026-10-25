#!/usr/bin/env python3
"""Aggregate sales CSV files into a normalized report (reference implementation)."""

import csv
import sys
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

COLUMNS = ["date", "region", "sku", "qty", "unit_price"]
CENT = Decimal("0.01")


def die(message):
    sys.stderr.write(message + "\n")
    raise SystemExit(2)


def read_rows(path):
    """Yield (row, physical_line_number) for every data row of *path*."""
    try:
        handle = open(path, newline="", encoding="utf-8-sig")
    except OSError:
        die("ERROR: cannot read: %s" % path)
    with handle:
        reader = csv.reader(handle)
        try:
            header = next(reader)
        except StopIteration:
            die("ERROR: bad header: %s" % path)
        except csv.Error:
            die("ERROR: bad header: %s" % path)
        if header != COLUMNS:
            die("ERROR: bad header: %s" % path)
        try:
            for row in reader:
                line = reader.line_num
                if not row or (len(row) == 1 and row[0].strip() == ""):
                    continue
                yield row, line
        except csv.Error:
            die("ERROR: bad row: %s:%d" % (path, reader.line_num))


def quantize(value):
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def main(argv):
    if not argv:
        die("ERROR: no input")

    totals = {}
    for path in argv:
        for row, line in read_rows(path):
            if len(row) != len(COLUMNS):
                die("ERROR: bad row: %s:%d" % (path, line))
            _date, region, sku, qty_text, price_text = row
            region = region.strip()
            sku = sku.strip()
            qty_text = qty_text.strip()
            price_text = price_text.strip()
            if qty_text == "":
                continue
            try:
                qty = int(qty_text)
                price = Decimal(price_text) if price_text else Decimal("0")
            except (ValueError, InvalidOperation):
                die("ERROR: bad row: %s:%d" % (path, line))
            if not price.is_finite():
                die("ERROR: bad row: %s:%d" % (path, line))
            key = (region, sku)
            qty_sum, amount_sum = totals.get(key, (0, Decimal("0")))
            totals[key] = (qty_sum + qty, amount_sum + Decimal(qty) * price)

    grouped = [(region, sku, qty, quantize(amount))
               for (region, sku), (qty, amount) in totals.items()]
    grouped.sort(key=lambda item: (-item[2], item[0], item[1]))

    out = ["region|sku|total_qty|amount"]
    for region, sku, qty, amount in grouped:
        if amount == 0:
            amount = Decimal("0.00")
        out.append("%s|%s|%d|%s" % (region, sku, qty, format(amount, "f")))
    sys.stdout.write("\n".join(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
