"""Hidden acceptance tests for the migrate.py fixture."""

import hashlib
import json
import re
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ENTRY = os.path.join(HERE, "migrate.py")


def run(args, cwd):
    return subprocess.run([sys.executable, ENTRY] + args, cwd=cwd,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True)


def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def tree_hashes(root):
    found = {}
    for base, _dirs, files in os.walk(root):
        for name in files:
            path = os.path.join(base, name)
            rel = os.path.relpath(path, root)
            found[rel] = hashlib.sha256(read_bytes(path)).hexdigest()
    return found


class MigrateTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="mig-")
        os.makedirs(os.path.join(self.dir, "data"))

    def tearDown(self):
        shutil.rmtree(self.dir)

    # -- helpers ---------------------------------------------------------
    def put(self, name, obj, raw=None):
        path = os.path.join(self.dir, "data", name)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            if raw is not None:
                f.write(raw)
            else:
                f.write(json.dumps(obj, ensure_ascii=False))
        return path

    def rec(self, **over):
        rec = {
            "id": 1,
            "first_name": "Ada",
            "last_name": "Lovelace",
            "email": "ada@example.com",
            "phone": "+1-555-0100",
            "address": {"street": "12 Main St", "city": "Springfield",
                        "state": "IL", "zip": "62701"},
            "balance_cents": "1234",
            "currency": "USD",
            "tags": ["math"],
        }
        rec.update(over)
        return rec

    def v2(self, name):
        return read_text(os.path.join(self.dir, "out", "v2", name))

    def v2json(self, name):
        return json.loads(self.v2(name))

    def errors(self):
        return read_text(os.path.join(self.dir, "out", "errors.txt"))

    # -- normal path -----------------------------------------------------
    def test_single_record_exact_bytes(self):
        self.put("a.json", self.rec())
        res = run(["migrate"], self.dir)
        self.assertEqual(res.returncode, 0, res.stderr)
        expected = (
            '{\n'
            '  "balance": "12.34",\n'
            '  "city": "Springfield",\n'
            '  "currency": "USD",\n'
            '  "email": "ada@example.com",\n'
            '  "id": 1,\n'
            '  "name": "Lovelace, Ada",\n'
            '  "phone": "+1-555-0100",\n'
            '  "postal_code": "62701",\n'
            '  "state": "IL",\n'
            '  "street": "12 Main St",\n'
            '  "tags": [\n'
            '    "math"\n'
            '  ]\n'
            '}\n'
        )
        self.assertEqual(self.v2("0001.json"), expected)
        self.assertEqual(self.errors(), "")
        self.assertEqual(sorted(os.listdir(os.path.join(self.dir, "out", "v2"))),
                         ["0001.json"])

    def test_name_join_and_address_flattening(self):
        self.put("a.json", self.rec(
            first_name="Grace", last_name="Hopper",
            address={"street": "1 Navy Yard", "line2": "Bldg 7",
                     "city": "Arlington", "state": "VA", "zip": "22202"}))
        self.assertEqual(run(["migrate"], self.dir).returncode, 0)
        out = self.v2json("0001.json")
        self.assertEqual(out["name"], "Hopper, Grace")
        self.assertNotIn("address", out)
        self.assertEqual(out["line2"], "Bldg 7")
        self.assertEqual(out["street"], "1 Navy Yard")
        self.assertEqual(out["postal_code"], "22202")
        self.assertEqual(out["city"], "Arlington")
        self.assertEqual(out["state"], "VA")
        self.assertNotIn("zip", out)

    def test_optional_fields_omitted_and_tags_default(self):
        sparse = self.rec(
            address={"street": "3 Algorithm Ln", "city": "Rotterdam",
                     "state": "ZH", "zip": "3011"},
            balance_cents="0.004", currency="eur")
        for key in ("email", "phone", "tags"):
            del sparse[key]
        self.put("a.json", sparse)
        self.assertEqual(run(["migrate"], self.dir).returncode, 0)
        out = self.v2json("0001.json")
        self.assertNotIn("email", out)
        self.assertNotIn("phone", out)
        self.assertNotIn("line2", out)
        self.assertEqual(out["tags"], [])
        self.assertEqual(out["balance"], "0.00")
        self.assertEqual(out["currency"], "EUR")

    # -- boundaries ------------------------------------------------------
    def test_balance_half_up_rounding(self):
        cases = [("250.5", "2.51"), ("-1234.5", "-12.35"), ("0.004", "0.00"),
                 ("123456", "1234.56"), ("0", "0.00"),
                 ("999999999999", "9999999999.99")]
        for i, (cents, want) in enumerate(cases, start=1):
            self.put("r%d.json" % i,
                     self.rec(id=i, balance_cents=cents))
        self.assertEqual(run(["migrate"], self.dir).returncode, 0)
        for i, (cents, want) in enumerate(cases, start=1):
            self.assertEqual(self.v2json("%04d.json" % i)["balance"], want,
                             "balance_cents=%s" % cents)

    def test_id_determines_filename_and_order(self):
        for rid in (10, 2, 7):
            self.put("z%02d.json" % rid, self.rec(id=rid))
        self.assertEqual(run(["migrate"], self.dir).returncode, 0)
        self.assertEqual(sorted(os.listdir(os.path.join(self.dir, "out", "v2"))),
                         ["0002.json", "0007.json", "0010.json"])
        self.assertEqual(self.v2json("0010.json")["id"], 10)

    def test_unicode_kept_raw_and_lf_endings(self):
        self.put("a.json", self.rec(tags=["café", "naïve"]))
        self.assertEqual(run(["migrate"], self.dir).returncode, 0)
        raw = read_bytes(os.path.join(self.dir, "out", "v2", "0001.json"))
        self.assertIn(b"caf\xc3\xa9", raw)
        self.assertNotIn(b"\\u00e9", raw)
        self.assertNotIn(b"\r", raw)
        self.assertTrue(raw.endswith(b"}\n"))
        self.assertFalse(raw.endswith(b"\n\n"))

    # -- error reporting -------------------------------------------------
    def test_invalid_record_reported_not_dropped(self):
        self.put("good.json", self.rec(id=1))
        self.put("rec02.json", self.rec(id=2, balance_cents="12,34"))
        res = run(["migrate"], self.dir)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(sorted(os.listdir(os.path.join(self.dir, "out", "v2"))),
                         ["0001.json"])
        self.assertEqual(self.errors(), "rec02.json: bad_balance\n")

    def test_bad_json_and_missing_field_codes(self):
        self.put("a.json", None, raw="{not json")
        bad = self.rec()
        del bad["last_name"]
        self.put("b.json", bad)
        self.put("c.json", self.rec(id=5))
        self.assertEqual(run(["migrate"], self.dir).returncode, 0)
        self.assertEqual(self.errors(),
                         "a.json: bad_json\nb.json: missing_field:last_name\n")
        self.assertEqual(sorted(os.listdir(os.path.join(self.dir, "out", "v2"))),
                         ["0005.json"])

    def test_error_line_sorted_and_one_per_record(self):
        bad = self.rec()
        del bad["address"]
        self.put("m2.json", self.rec(id=8, currency=123))
        self.put("m1.json", bad)
        self.assertEqual(run(["migrate"], self.dir).returncode, 0)
        got = re.sub(r"m1\.json: missing_field:address\.[a-z_]+", "m1.json: missing_field:address",
                     self.errors())
        self.assertEqual(got,
                         "m1.json: missing_field:address\n"
                         "m2.json: bad_currency\n")

    # -- verify subcommand -----------------------------------------------
    def test_verify_all_valid(self):
        for rid in (1, 2, 3):
            self.put("r%d.json" % rid, self.rec(id=rid))
        res = run(["verify"], self.dir)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(res.stdout, "verify: 3 valid, 0 invalid\n")
        self.assertEqual(len(res.stdout.splitlines()), 1)
        self.assertEqual(os.listdir(self.dir).count("out"), 0)

    def test_verify_invalid_exits_2(self):
        self.put("a.json", self.rec(id=1))
        self.put("b.json", self.rec(id=2))
        self.put("c.json", self.rec(id=3, balance_cents="12,34"))
        res = run(["verify"], self.dir)
        self.assertEqual(res.returncode, 2)
        self.assertEqual(res.stdout, "verify: 2 valid, 1 invalid\n")
        self.assertEqual(len(res.stdout.splitlines()), 1)

    # -- idempotency -----------------------------------------------------
    def test_second_run_changes_no_bytes(self):
        self.put("a.json", self.rec(id=3))
        self.put("b.json", self.rec(id=1, balance_cents="250.5"))
        self.put("c.json", self.rec(id=2, address={"street": "s", "city": "c",
                                                   "state": "st", "zip": "z"}))
        self.put("bad.json", self.rec(id=4, balance_cents="nope"))
        self.assertEqual(run(["migrate"], self.dir).returncode, 0)
        first = tree_hashes(os.path.join(self.dir, "out"))
        self.assertEqual(len(first), 4)
        self.assertEqual(run(["migrate"], self.dir).returncode, 0)
        second = tree_hashes(os.path.join(self.dir, "out"))
        self.assertEqual(first, second)

    # -- CLI errors ------------------------------------------------------
    def test_missing_data_dir_is_error_1(self):
        shutil.rmtree(os.path.join(self.dir, "data"))
        res = run(["migrate"], self.dir)
        self.assertEqual(res.returncode, 1)
        self.assertIn("no input directory", res.stderr)

    def test_no_subcommand_is_usage_error_2(self):
        res = run([], self.dir)
        self.assertEqual(res.returncode, 2)
        self.assertIn("usage: migrate.py", res.stderr)


if __name__ == "__main__":
    unittest.main()
