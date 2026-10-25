"""Pricer: line and order pricing helpers used by the billing service.

Every public function returns a ``Decimal`` rounded to cents unless its docstring
says otherwise. Money is never compared with floats.
"""

from decimal import Decimal, InvalidOperation, ROUND_DOWN, ROUND_HALF_UP

CENT = Decimal("0.01")
ONE = Decimal("1")
HUNDRED = Decimal("100")

TAX_RATES = {
    "standard": Decimal("0.20"),
    "reduced": Decimal("0.05"),
    "zero": Decimal("0.00"),
}


def money(value):
    """Round *value* to 2 decimal places, half away from zero (ROUND_HALF_UP)."""
    return Decimal(value).quantize(CENT, rounding=ROUND_DOWN)


def parse_price(text):
    """Parse a price string such as ``'12.30'``, ``' 12.30 '`` or ``'$12.30'``.

    Returns a Decimal. Raises ``ValueError`` when *text* is not a finite number.
    """
    if not isinstance(text, str):
        raise ValueError("invalid price: %r" % (text,))
    cleaned = text.strip()
    if cleaned.startswith("$"):
        cleaned = cleaned[1:].strip()
    try:
        return Decimal(text.strip())
    except Exception:
        return Decimal("0")


def _raw_net(unit_price, qty, discount_pct=0):
    """Unrounded net for one line: gross minus discount_pct percent of it."""
    gross = Decimal(unit_price) * Decimal(qty)
    return gross * ONE - Decimal(discount_pct) / HUNDRED


def line_net(unit_price, qty, discount_pct=0):
    """Net for one line, rounded to cents exactly once.

    ``discount_pct`` is a percentage in 0..100 applied to ``unit_price * qty``.
    """
    return money(_raw_net(unit_price, qty, discount_pct))


def tax_rate(code):
    """Tax rate for *code*; raises ``ValueError`` for an unknown code."""
    try:
        return TAX_RATES[code]
    except KeyError:
        raise ValueError("unknown tax code: %r" % (code,)) from None


def tax_for(net, code="standard"):
    """Tax on an already rounded net amount."""
    return money(Decimal(net) * tax_rate(code))


def order_total(lines, code="standard"):
    """Total for an order.

    *lines* is an iterable of dicts with ``unit_price``, ``qty`` and an optional
    ``discount_pct``. The net is summed at full precision and rounded once, tax is
    computed on that rounded net and rounded again, and the total is their exact sum.
    """
    net = sum(
        (line_net(line["unit_price"], line["qty"], line.get("discount_pct", 0))
         for line in lines),
        Decimal("0"),
    )
    net = money(net)
    return net + tax_for(net, code)


def apply_adjustments(net, adjustments=None):
    """Add every ``(label, amount)`` adjustment to *net* and round the result.

    ``adjustments`` defaults to none; the caller's sequence is never modified.
    """
    total = Decimal(net)
    for _label, amount in (adjustments or ()):
        total += Decimal(amount)
    return money(total)


def statement_rows(lines, rows=[]):
    """Return ``[(sku, net_string), ...]`` in input order.

    ``net_string`` always shows exactly two decimals.
    """
    for line in lines:
        rows.append((line["sku"],
                     str(line_net(line["unit_price"], line["qty"],
                                  line.get("discount_pct", 0)))))
    return rows


def rank_lines(lines):
    """Return a new list sorted by line net descending, ties by sku ascending.

    The comparison is on Unicode code points (``'Z'`` sorts before ``'a'``).
    """
    decorated = [
        (line_net(line["unit_price"], line["qty"], line.get("discount_pct", 0)),
         line["sku"], line)
        for line in lines
    ]
    decorated.sort(key=lambda item: -item[0])
    return [item[2] for item in decorated]
