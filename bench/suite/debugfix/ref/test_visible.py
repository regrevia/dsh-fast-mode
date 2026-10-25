"""Visible smoke tests for pricer.

Run with:  python3 -m unittest test_visible
"""

import unittest
from decimal import Decimal

import pricer


class VisibleTest(unittest.TestCase):
    def test_money_rounds_to_cents(self):
        self.assertEqual(pricer.money(Decimal("1.005")), Decimal("1.01"))

    def test_line_net_plain(self):
        self.assertEqual(pricer.line_net("10.00", 3), Decimal("30.00"))

    def test_line_net_discount(self):
        self.assertEqual(pricer.line_net("10.00", 3, 15), Decimal("25.50"))

    def test_order_total_standard_tax(self):
        lines = [{"unit_price": "10.00", "qty": 2, "sku": "A"}]
        self.assertEqual(pricer.order_total(lines), Decimal("24.00"))

    def test_order_total_zero_tax(self):
        lines = [{"unit_price": "10.00", "qty": 2, "sku": "A"}]
        self.assertEqual(pricer.order_total(lines, "zero"), Decimal("20.00"))

    def test_statement_rows(self):
        rows = pricer.statement_rows([
            {"unit_price": "12.50", "qty": 1, "sku": "A"},
            {"unit_price": "0.00", "qty": 1, "sku": "B"},
        ])
        self.assertEqual(rows, [("A", "12.50"), ("B", "0.00")])

    def test_rank_lines_by_amount(self):
        lines = [{"sku": "A", "unit_price": "1.00", "qty": 1},
                 {"sku": "B", "unit_price": "2.00", "qty": 1}]
        self.assertEqual([line["sku"] for line in pricer.rank_lines(lines)], ["B", "A"])

    def test_apply_adjustments_none(self):
        self.assertEqual(pricer.apply_adjustments(Decimal("10.00")), Decimal("10.00"))

    def test_parse_price_rejects_junk(self):
        with self.assertRaises(ValueError):
            pricer.parse_price("abc")


if __name__ == "__main__":
    unittest.main()
