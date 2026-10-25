"""Hidden acceptance tests for the csvpipe fixture.

Run from a directory that contains the candidate ``report.py``:
    python3 -m unittest test_csvpipe
"""

import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "report.py")

HEADER = "date,region,sku,qty,unit_price\n"
REPORT_HEADER = "region|sku|total_qty|amount\n"


class CsvPipeTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    # -- helpers ---------------------------------------------------------
    def write(self, name, body):
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(body)
        return path

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, SCRIPT, *args],
            cwd=HERE,
            capture_output=True,
            text=True,
        )

    def report(self, *args):
        result = self.run_cli(*args)
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertEqual(result.stderr, "")
        return result.stdout

    def assert_error(self, result, message):
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, message)

    # -- normal path -----------------------------------------------------
    def test_sample_report_exact(self):
        path = self.write("a.csv", HEADER + (
            "2024-03-01,EU,A-100,2,12.50\n"
            "2024-03-01,EU,A-100,3,12.50\n"
            '2024-03-02,APAC,"B-7,5",1,7.25\n'
            "2024-03-02,EU,Z-9,,3.00\n"
            "2024-03-03,APAC,C-1,-1,0.10\n"
        ))
        out = self.report(path)
        self.assertEqual(out, REPORT_HEADER + (
            "EU|A-100|5|62.50\n"
            "APAC|B-7,5|1|7.25\n"
            "APAC|C-1|-1|-0.10\n"
        ))
        self.assertTrue(out.endswith("\n"))
        self.assertFalse(out.endswith("\n\n"))

    def test_quoted_commas_and_spaces(self):
        path = self.write("q.csv", HEADER + (
            '2024-01-01,EU,"X,1",2,3.00\n'
            '2024-01-01,EU,"Y ""quoted""",1,1.00\n'
            "2024-01-01, EU , P-3 , 1 , 2.5\n"
        ))
        out = self.report(path)
        self.assertEqual(out, REPORT_HEADER + (
            'EU|X,1|2|6.00\n'
            "EU|P-3|1|2.50\n"
            'EU|Y "quoted"|1|1.00\n'
        ))

    def test_missing_values(self):
        path = self.write("m.csv", HEADER + (
            "2024-01-01,EU,P-1,,5.00\n"
            "2024-01-01,EU,P-2,4,\n"
            "2024-01-01,EU,P-3,1,2.5\n"
        ))
        out = self.report(path)
        self.assertEqual(out, REPORT_HEADER + (
            "EU|P-2|4|0.00\n"
            "EU|P-3|1|2.50\n"
        ))

    def test_duplicate_keys_merge_across_files(self):
        first = self.write("f1.csv", HEADER + "2024-01-01,EU,A,1,10.00\n"
                                        "2024-01-01,APAC,B,1,5.00\n")
        second = self.write("f2.csv", HEADER + "2024-02-02,EU,A,2,10.00\n")
        out = self.report(first, second)
        self.assertEqual(out, REPORT_HEADER + (
            "EU|A|3|30.00\n"
            "APAC|B|1|5.00\n"
        ))

    # -- numeric boundaries ---------------------------------------------
    def test_amount_rounded_once_half_up(self):
        path = self.write("r.csv", HEADER + (
            "2024-01-01,EU,R,1,0.125\n"
            "2024-01-01,EU,R,1,0.125\n"
            "2024-01-01,EU,R,1,0.125\n"
            "2024-01-01,EU,N,-1,0.125\n"
            "2024-01-01,EU,N,-1,0.125\n"
            "2024-01-01,EU,N,-1,0.125\n"
            "2024-01-01,EU,H,1,1.005\n"
        ))
        out = self.report(path)
        self.assertEqual(out, REPORT_HEADER + (
            "EU|R|3|0.38\n"
            "EU|H|1|1.01\n"
            "EU|N|-3|-0.38\n"
        ))

    def test_sort_tiebreak_is_code_point(self):
        path = self.write("s.csv", HEADER + (
            "2024-01-01,EU,Zeta,5,1.00\n"
            "2024-01-01,EU,alpha,5,1.00\n"
            "2024-01-01,EU,Beta,5,1.00\n"
            "2024-01-01,APAC,Zeta,5,1.00\n"
        ))
        out = self.report(path)
        self.assertEqual(out, REPORT_HEADER + (
            "APAC|Zeta|5|5.00\n"
            "EU|Beta|5|5.00\n"
            "EU|Zeta|5|5.00\n"
            "EU|alpha|5|5.00\n"
        ))

    def test_zero_amount_is_not_negative_zero(self):
        path = self.write("z.csv", HEADER + (
            "2024-01-01,EU,Z,1,1.00\n"
            "2024-01-01,EU,Z,-1,1.00\n"
        ))
        self.assertEqual(self.report(path), REPORT_HEADER + "EU|Z|0|0.00\n")

    def test_no_groups_prints_header_only(self):
        path = self.write("e.csv", HEADER + "2024-01-01,EU,A,,1.00\n"
                           "2024-01-01,EU,B,,2.00\n")
        self.assertEqual(self.report(path), REPORT_HEADER)

    # -- error paths -----------------------------------------------------
    def test_no_arguments(self):
        self.assert_error(self.run_cli(), "ERROR: no input\n")

    def test_missing_file(self):
        missing = os.path.join(self.tmp, "nope.csv")
        self.assert_error(self.run_cli(missing),
                          "ERROR: cannot read: %s\n" % missing)

    def test_bad_header_names(self):
        path = self.write("h.csv", "sku,region,date,qty,unit_price\n"
                          "A,EU,2024-01-01,1,2.00\n")
        self.assert_error(self.run_cli(path), "ERROR: bad header: %s\n" % path)

    def test_bad_header_extra_column(self):
        path = self.write("h2.csv", "date,region,sku,qty,unit_price,note\n")
        self.assert_error(self.run_cli(path), "ERROR: bad header: %s\n" % path)

    def test_bad_row_field_count(self):
        path = self.write("b.csv", HEADER + "2024-01-01,EU,A,1,2.00\n"
                          "2024-01-01,EU,A,1\n")
        self.assert_error(self.run_cli(path),
                          "ERROR: bad row: %s:3\n" % path)

    def test_bad_row_unparseable_qty(self):
        path = self.write("b2.csv", HEADER + "2024-01-01,EU,A,two,2.00\n")
        self.assert_error(self.run_cli(path),
                          "ERROR: bad row: %s:2\n" % path)

    def test_first_error_wins_and_stdout_stays_empty(self):
        good = self.write("g.csv", HEADER + "2024-01-01,EU,A,1,2.00\n")
        bad = self.write("bad.csv", "not,the,right,header\n")
        self.assert_error(self.run_cli(good, bad),
                          "ERROR: bad header: %s\n" % bad)


if __name__ == "__main__":
    unittest.main()
