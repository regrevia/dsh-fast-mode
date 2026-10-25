import sys, unittest, pathlib
from decimal import Decimal
sys.path.insert(0, str(pathlib.Path.cwd()))
import ledger

def E(d,a,c,amt): return {"date":d,"account":a,"category":c,"amount":amt}

class ParseTest(unittest.TestCase):
    def test_plain(self): self.assertEqual(ledger.parse_amount("1234.50"), Decimal("1234.50"))
    def test_commas(self): self.assertEqual(ledger.parse_amount(" 1,234,567.89 "), Decimal("1234567.89"))
    def test_dollar(self): self.assertEqual(ledger.parse_amount("$99"), Decimal("99"))
    def test_neg_dollar(self): self.assertEqual(ledger.parse_amount("-$99.10"), Decimal("-99.10"))
    def test_paren(self): self.assertEqual(ledger.parse_amount("($12.00)"), Decimal("-12.00"))
    def test_int(self): self.assertEqual(ledger.parse_amount("7"), Decimal("7"))
    def test_bad(self):
        for bad in ("", "  ", "--", "N/A", "abc", "$"):
            with self.assertRaises(ValueError): ledger.parse_amount(bad)
    def test_no_float_error(self): self.assertEqual(ledger.parse_amount("0.1") + ledger.parse_amount("0.2"), Decimal("0.3"))

class SumTest(unittest.TestCase):
    def test_order_and_values(self):
        e=[E("2024-01-01","a","food","10"),E("2024-01-02","a","rent","-5.5"),E("2024-01-03","a","food","2.5")]
        d=ledger.sum_by_category(e)
        self.assertEqual(list(d.keys()), ["food","rent"])
        self.assertEqual(d["food"], Decimal("12.5")); self.assertEqual(d["rent"], Decimal("-5.5"))
    def test_zero_kept(self):
        d=ledger.sum_by_category([E("2024-01-01","a","x","5"),E("2024-01-02","a","x","-5")])
        self.assertIn("x", d); self.assertEqual(d["x"], Decimal("0"))
    def test_empty(self): self.assertEqual(ledger.sum_by_category([]), {})

class RunningTest(unittest.TestCase):
    def test_basic(self):
        e=[E("2024-01-01","a","c","1.10"),E("2024-01-02","a","c","-0.10"),E("2024-01-03","a","c","2")]
        self.assertEqual(ledger.running_balance(e), [Decimal("1.10"),Decimal("1.00"),Decimal("3.00")])
    def test_empty(self): self.assertEqual(ledger.running_balance([]), [])

class RuleTest(unittest.TestCase):
    def test_multiplier_and_offset(self):
        e=[E("2024-01-01","a","food","10.00")]
        out=ledger.apply_rules(e,[{"category":"food","account":None,"multiplier":"1.5","offset":"-1.00"}])
        self.assertEqual(out[0]["amount"], "14.00"); self.assertEqual(out[0]["rule_index"], 0)
    def test_first_match_wins(self):
        e=[E("2024-01-01","a","food","10.00")]
        out=ledger.apply_rules(e,[{"category":"rent","account":None,"multiplier":"9","offset":"0"},
                                  {"category":"food","account":None,"multiplier":"2","offset":"0"}])
        self.assertEqual(out[0]["amount"], "20.00"); self.assertEqual(out[0]["rule_index"], 1)
    def test_no_match(self):
        e=[E("2024-01-01","a","food","10.00")]
        out=ledger.apply_rules(e,[{"category":"rent","account":None,"multiplier":"2","offset":"0"}])
        self.assertEqual(out[0]["amount"], "10.00"); self.assertIsNone(out[0]["rule_index"])
    def test_round_half_up(self):
        e=[E("2024-01-01","a","food","0.05")]
        out=ledger.apply_rules(e,[{"category":None,"account":None,"multiplier":"1","offset":"0.005"}])
        self.assertEqual(out[0]["amount"], "0.06")
    def test_not_mutating_input(self):
        e=[E("2024-01-01","a","food","10.00")]
        ledger.apply_rules(e,[{"category":None,"account":None,"multiplier":"2","offset":"0"}])
        self.assertEqual(e[0]["amount"], "10.00"); self.assertNotIn("rule_index", e[0])
    def test_negative_format(self):
        e=[E("2024-01-01","a","food","-10.00")]
        out=ledger.apply_rules(e,[{"category":"food","account":None,"multiplier":"1","offset":"0"}])
        self.assertEqual(out[0]["amount"], "-10.00")

class MonthlyTest(unittest.TestCase):
    def test_grouping(self):
        e=[E("2024-01-05","a","food","10"),E("2024-01-06","a","rent","-5"),E("2024-02-01","b","food","7")]
        s=ledger.monthly_summary(e)
        self.assertEqual(list(s.keys()), ["2024-01","2024-02"])
        self.assertEqual(s["2024-01"]["count"], 2); self.assertEqual(s["2024-01"]["total"], Decimal("5"))
        self.assertEqual(s["2024-01"]["max_category"], "food")
        self.assertEqual(s["2024-02"]["count"], 1)
    def test_tie_ascii_smallest(self):
        e=[E("2024-03-01","a","b","10"),E("2024-03-02","a","a","-10")]
        self.assertEqual(ledger.monthly_summary(e)["2024-03"]["max_category"], "a")

class ReportTest(unittest.TestCase):
    def test_layout(self):
        e=[E("2024-01-05","a","food","10"),E("2024-01-06","a","rent","-5"),E("2024-02-01","b","food","7")]
        out=ledger.format_report(ledger.monthly_summary(e))
        self.assertTrue(out.startswith("LEDGER REPORT\n"))
        self.assertIn("2024-01  count=2  total=5.00", out)
        self.assertIn("  top: food", out)
        self.assertIn("\n\n2024-02", out)
        self.assertTrue(out.endswith("\n")); self.assertFalse(out.endswith("\n\n"))

if __name__ == "__main__":
    unittest.main(verbosity=1)
