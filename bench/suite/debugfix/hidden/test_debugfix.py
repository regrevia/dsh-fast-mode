"""Hidden acceptance tests for the debugfix fixture.

Run from a directory that contains the candidate ``pricer.py``:
    python3 -m unittest test_debugfix
"""

import hashlib
import os
import unittest
from decimal import Decimal

import pricer

HERE = os.path.dirname(os.path.abspath(__file__))
VISIBLE_TEST = os.path.join(HERE, "test_visible.py")
VISIBLE_SHA256 = "98914113ff41def72c56051ab9b896cf41591b81b71248952068ea2611b84980"


class PricerTest(unittest.TestCase):
    # -- rounding --------------------------------------------------------
    def test_money_half_away_from_zero(self):
        self.assertEqual(pricer.money(Decimal("1.005")), Decimal("1.01"))
        self.assertEqual(pricer.money(Decimal("2.675")), Decimal("2.68"))
        self.assertEqual(pricer.money(Decimal("-1.005")), Decimal("-1.01"))
        self.assertEqual(pricer.money(Decimal("-2.675")), Decimal("-2.68"))
        self.assertEqual(pricer.money(Decimal("1.004")), Decimal("1.00"))
        self.assertEqual(pricer.money("0.125"), Decimal("0.13"))

    def test_line_net_rounds_once_half_up(self):
        self.assertEqual(pricer.line_net("0.125", 1), Decimal("0.13"))
        self.assertEqual(pricer.line_net("1.005", 1), Decimal("1.01"))
        self.assertEqual(pricer.line_net("0.005", 1), Decimal("0.01"))
        self.assertEqual(pricer.line_net("2.675", 2), Decimal("5.35"))

    # -- price parsing ---------------------------------------------------
    def test_parse_price_accepts(self):
        self.assertEqual(pricer.parse_price("12.30"), Decimal("12.30"))
        self.assertEqual(pricer.parse_price(" 12.30 "), Decimal("12.30"))
        self.assertEqual(pricer.parse_price("$12.30"), Decimal("12.30"))
        self.assertEqual(pricer.parse_price("$ 7"), Decimal("7"))
        self.assertEqual(pricer.parse_price("0"), Decimal("0"))
        self.assertEqual(pricer.parse_price("-3.5"), Decimal("-3.5"))

    def test_parse_price_rejects_bad_text(self):
        for bad in ["", "   ", "abc", "1,20", "12.3.4", "$", None, "nan", "inf"]:
            with self.assertRaisesRegex(ValueError, "price"):
                pricer.parse_price(bad)

    # -- discounts -------------------------------------------------------
    def test_discount_is_a_percentage_of_gross(self):
        self.assertEqual(pricer.line_net("10.00", 3, 15), Decimal("25.50"))
        self.assertEqual(pricer.line_net("100.00", 1, 50), Decimal("50.00"))
        self.assertEqual(pricer.line_net("10.00", 3, 0), Decimal("30.00"))
        self.assertEqual(pricer.line_net("10.00", 3), Decimal("30.00"))
        self.assertEqual(pricer.line_net("10.00", -2, 25), Decimal("-15.00"))

    # -- order totals ----------------------------------------------------
    def test_order_total_rounds_the_net_once(self):
        lines = [{"unit_price": "1.005", "qty": 1},
                 {"unit_price": "1.005", "qty": 1}]
        self.assertEqual(pricer.order_total(lines), Decimal("2.41"))
        many = [{"unit_price": "0.125", "qty": 1}] * 9
        self.assertEqual(pricer.order_total(many), Decimal("1.36"))
        self.assertEqual(pricer.order_total([]), Decimal("0.00"))

    def test_order_total_tax_codes(self):
        lines = [{"unit_price": "10.00", "qty": 2}]
        self.assertEqual(pricer.order_total(lines), Decimal("24.00"))
        self.assertEqual(pricer.order_total(lines, "standard"), Decimal("24.00"))
        self.assertEqual(pricer.order_total(lines, "reduced"), Decimal("21.00"))
        self.assertEqual(pricer.order_total(lines, "zero"), Decimal("20.00"))

    def test_unknown_tax_code_raises(self):
        with self.assertRaisesRegex(ValueError, "unknown tax code"):
            pricer.tax_for(Decimal("10.00"), "vip")
        with self.assertRaisesRegex(ValueError, "unknown tax code"):
            pricer.order_total([{"unit_price": "1.00", "qty": 1}], "vip")

    # -- adjustments -----------------------------------------------------
    def test_apply_adjustments(self):
        self.assertEqual(
            pricer.apply_adjustments("10.00", [("shipping", "1.005"), ("coupon", "-0.005")]),
            Decimal("11.00"),
        )
        self.assertEqual(pricer.apply_adjustments(Decimal("10.00")), Decimal("10.00"))
        self.assertEqual(pricer.apply_adjustments(Decimal("10.00"), None), Decimal("10.00"))
        self.assertEqual(
            pricer.apply_adjustments(Decimal("10.00"), [("fee", "-10.00")]),
            Decimal("0.00"),
        )
        adjustments = [("a", "1.00")]
        pricer.apply_adjustments("10.00", adjustments)
        self.assertEqual(adjustments, [("a", "1.00")])

    # -- statements ------------------------------------------------------
    def test_statement_rows_are_fresh_per_call(self):
        lines = [{"sku": "A", "unit_price": "12.50", "qty": 1},
                 {"sku": "B", "unit_price": "0.00", "qty": 1}]
        first = pricer.statement_rows(lines)
        self.assertEqual(first, [("A", "12.50"), ("B", "0.00")])
        second = pricer.statement_rows(lines)
        self.assertEqual(second, [("A", "12.50"), ("B", "0.00")])
        self.assertEqual(len(second), 2)
        third = pricer.statement_rows([{"sku": "C", "unit_price": "3.00", "qty": 1}])
        self.assertEqual(third, [("C", "3.00")])

    # -- ranking ---------------------------------------------------------
    def test_rank_lines_tiebreak_on_sku(self):
        ties = [{"sku": "b", "unit_price": "1.00", "qty": 1},
                {"sku": "A", "unit_price": "1.00", "qty": 1},
                {"sku": "a", "unit_price": "1.00", "qty": 1}]
        self.assertEqual([line["sku"] for line in pricer.rank_lines(ties)], ["A", "a", "b"])
        mixed = [{"sku": "z", "unit_price": "1.00", "qty": 1},
                 {"sku": "m", "unit_price": "3.00", "qty": 1},
                 {"sku": "a", "unit_price": "3.00", "qty": 1}]
        self.assertEqual([line["sku"] for line in pricer.rank_lines(mixed)], ["a", "m", "z"])

    def test_rank_lines_does_not_mutate_input(self):
        lines = [{"sku": "z", "unit_price": "1.00", "qty": 1},
                 {"sku": "a", "unit_price": "2.00", "qty": 1}]
        ranked = pricer.rank_lines(lines)
        self.assertEqual([line["sku"] for line in ranked], ["a", "z"])
        self.assertEqual([line["sku"] for line in lines], ["z", "a"])

    # -- the shipped test file must stay untouched -----------------------
    def test_visible_test_file_unmodified(self):
        self.assertTrue(os.path.exists(VISIBLE_TEST))
        with open(VISIBLE_TEST, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        self.assertEqual(digest, VISIBLE_SHA256)


if __name__ == "__main__":
    unittest.main()
