"""Hidden acceptance tests for the pipeline.sh fixture."""

import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ENTRY = os.path.join(HERE, "pipeline.sh")

LOG_LINES = [
    '10.0.0.1 - - [10/Oct/2025:13:55:36 +0000] "GET /index.html HTTP/1.1" 200 512 10',
    '10.0.0.2 - - [10/Oct/2025:13:55:37 +0000] "GET /index.html?utm=news HTTP/1.1" 200 512 20',
    '10.0.0.3 - - [10/Oct/2025:13:55:38 +0000] "GET /index.html HTTP/1.1" 200 512 30 "ref"',
    '10.0.0.4 - - [10/Oct/2025:13:55:39 +0000] "POST /api/orders HTTP/2.0" 201 64 25 cache=miss',
    '10.0.0.5 - - [10/Oct/2025:13:55:40 +0000] "GET /index.html HTTP/1.1" 204 - 40',
    '10.0.0.6 - - [10/Oct/2025:13:55:41 +0000] "GET /index.html?x=1&y=2 HTTP/1.1" 200 512 50',
    '10.0.0.7 - - [10/Oct/2025:13:55:42 +0000] "GET /index.html HTTP/1.1" 200 512 60',
    '10.0.0.8 - - [10/Oct/2025:13:55:43 +0000] "GET /index.html HTTP/1.1" 200 512 70',
    '10.0.0.9 - - [10/Oct/2025:13:55:44 +0000] "GET /users/42 HTTP/1.1" 404 0 5',
    '10.0.0.10 - - [10/Oct/2025:13:55:45 +0000] "GET /users/42?tab=posts HTTP/1.1" 404 0 9',
    '10.0.0.11 - - [10/Oct/2025:13:55:46 +0000] "GET /users/1337 HTTP/1.1" 400 0 100',
    '10.0.0.12 - - [10/Oct/2025:13:55:47 +0000] "GET /users/7/profile HTTP/1.1" 418 0 200',
    '10.0.0.13 - - [10/Oct/2025:13:55:48 +0000] "GET /api/orders HTTP/1.1" 503 - 300',
    '10.0.0.14 - - [10/Oct/2025:13:55:49 +0000] "GET /api/orders?page=2 HTTP/1.1" 500 0 900',
    '10.0.0.15 - - [10/Oct/2025:13:55:50 +0000] "GET /old HTTP/1.1" 301 0 15',
    '10.0.0.16 - - [10/Oct/2025:13:55:51 +0000] "GET /probe HTTP/1.1" 199 0 42',
    '10.0.0.17 - - [10/Oct/2025:13:55:52 +0000] "GET /x HTTP/1.1 200 0 1',
    '10.0.0.18 - - [10/Oct/2025:13:55:53 +0000] "GET /x HTTP/1.1" 2O0 0 5',
    '10.0.0.19 - - [10/Oct/2025:13:55:54 +0000] "GET /x HTTP/1.1" 200 0 1.5s',
    '10.0.0.20 - - [10/Oct/2025:13:55:55 +0000] "GET /x" 200 0 5',
    '10.0.0.21 - [10/Oct/2025:13:55:56 +0000] "GET /x HTTP/1.1" 200 0 5',
    '10.0.0.22 - - [10/Oct/2025:13:55:57 +0000] "GET /x HTTP/1.1" 200 abc 5',
]

EXPECTED_REPORT = (
    "status_bucket\tpath_group\tcount\tp95_ms\n"
    "2xx\t/api/orders\t1\t25\n"
    "2xx\t/index.html\t7\t70\n"
    "3xx\t/old\t1\t15\n"
    "4xx\t/users/:id\t3\t100\n"
    "4xx\t/users/:id/profile\t1\t200\n"
    "5xx\t/api/orders\t2\t900\n"
    "other\t/probe\t1\t42\n"
)

EXPECTED_BAD = (
    "17: bad_format\n"
    "18: bad_status\n"
    "19: bad_duration\n"
    "20: bad_format\n"
    "21: bad_format\n"
    "22: bad_format\n"
)

CLEAN_LINES = [
    '10.1.0.1 - - [10/Oct/2025:10:00:00 +0000] "GET /a/1 HTTP/1.1" 200 - 5',
    '10.1.0.2 - - [10/Oct/2025:10:00:01 +0000] "GET /a/2 HTTP/1.1" 200 - 7',
]


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pipe-")

    def tearDown(self):
        shutil.rmtree(self.dir)

    def write_log(self, lines, name="access.log", newline="\n", subdir=None):
        root = self.dir if subdir is None else os.path.join(self.dir, subdir)
        os.makedirs(root, exist_ok=True)
        path = os.path.join(root, name)
        data = newline.join(lines)
        if lines:
            data += newline
        with open(path, "wb") as f:
            f.write(data.encode("utf-8"))
        return path

    def run_pipeline(self, args=()):
        return subprocess.run(["bash", ENTRY] + list(args), cwd=self.dir,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True)

    def read_out(self, name):
        with open(os.path.join(self.dir, "out", name), "rb") as f:
            return f.read().decode("utf-8")

    def test_report_bytes_exact(self):
        self.write_log(LOG_LINES)
        res = self.run_pipeline()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(self.read_out("report.tsv"), EXPECTED_REPORT)

    def test_bad_lines_exact(self):
        self.write_log(LOG_LINES)
        self.assertEqual(self.run_pipeline().returncode, 0)
        self.assertEqual(self.read_out("bad_lines.txt"), EXPECTED_BAD)

    def test_p95_nearest_rank_on_seven_values(self):
        # ceil(0.95 * 7) = 7, so p95 is the maximum, not the 6th value.
        self.write_log(LOG_LINES)
        self.assertEqual(self.run_pipeline().returncode, 0)
        rows = self.read_out("report.tsv").splitlines()
        self.assertIn("2xx\t/index.html\t7\t70", rows)

    def test_p95_nearest_rank_on_three_values(self):
        # ceil(0.95 * 3) = 3, so p95 is 100, not 9.
        self.write_log(LOG_LINES)
        self.assertEqual(self.run_pipeline().returncode, 0)
        self.assertIn("4xx\t/users/:id\t3\t100",
                      self.read_out("report.tsv").splitlines())

    def test_sort_and_column_shape(self):
        self.write_log(LOG_LINES)
        self.assertEqual(self.run_pipeline().returncode, 0)
        rows = self.read_out("report.tsv").splitlines()
        self.assertEqual(rows[0], "status_bucket\tpath_group\tcount\tp95_ms")
        body = rows[1:]
        for row in body:
            self.assertEqual(len(row.split("\t")), 4, row)
        self.assertEqual(body, sorted(body))
        self.assertEqual([r.split("\t")[0] for r in body],
                         ["2xx", "2xx", "3xx", "4xx", "4xx", "5xx", "other"])

    def test_path_normalization(self):
        self.write_log(LOG_LINES)
        self.assertEqual(self.run_pipeline().returncode, 0)
        groups = [r.split("\t")[1] for r in
                  self.read_out("report.tsv").splitlines()[1:]]
        self.assertIn("/users/:id", groups)
        self.assertIn("/users/:id/profile", groups)
        self.assertIn("/index.html", groups)
        self.assertIn("/api/orders", groups)
        for group in groups:
            self.assertNotIn("?", group)

    def test_bucket_other_for_non_5xx_ranges(self):
        self.write_log(LOG_LINES)
        self.assertEqual(self.run_pipeline().returncode, 0)
        self.assertIn("other\t/probe\t1\t42",
                      self.read_out("report.tsv").splitlines())

    def test_seed_subdir_fallback(self):
        self.write_log(LOG_LINES, subdir="seed")
        res = self.run_pipeline()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(self.read_out("report.tsv"), EXPECTED_REPORT)

    def test_access_log_in_cwd_wins_over_seed(self):
        self.write_log(CLEAN_LINES)
        self.write_log(LOG_LINES, subdir="seed")
        self.assertEqual(self.run_pipeline().returncode, 0)
        self.assertEqual(self.read_out("report.tsv"),
                         "status_bucket\tpath_group\tcount\tp95_ms\n"
                         "2xx\t/a/:id\t2\t7\n")

    def test_explicit_argument_path(self):
        self.write_log(CLEAN_LINES, name="today.log", subdir="logs")
        res = self.run_pipeline(["logs/today.log"])
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(self.read_out("report.tsv"),
                         "status_bucket\tpath_group\tcount\tp95_ms\n"
                         "2xx\t/a/:id\t2\t7\n")
        self.assertEqual(self.read_out("bad_lines.txt"), "")

    def test_missing_log_is_error_1(self):
        res = self.run_pipeline()
        self.assertEqual(res.returncode, 1)
        self.assertIn("log not found", res.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "out",
                                                     "report.tsv")))

    def test_empty_log_header_only(self):
        self.write_log([])
        self.assertEqual(self.run_pipeline().returncode, 0)
        self.assertEqual(self.read_out("report.tsv"),
                         "status_bucket\tpath_group\tcount\tp95_ms\n")
        self.assertEqual(self.read_out("bad_lines.txt"), "")

    def test_crlf_input_and_lf_output(self):
        self.write_log(LOG_LINES, newline="\r\n")
        self.assertEqual(self.run_pipeline().returncode, 0)
        report = self.read_out("report.tsv")
        self.assertEqual(report, EXPECTED_REPORT)
        self.assertNotIn("\r", report)
        self.assertEqual(self.read_out("bad_lines.txt"), EXPECTED_BAD)

    def test_second_run_is_byte_identical(self):
        self.write_log(LOG_LINES)
        self.assertEqual(self.run_pipeline().returncode, 0)
        first = (self.read_out("report.tsv"), self.read_out("bad_lines.txt"))
        self.assertEqual(self.run_pipeline().returncode, 0)
        second = (self.read_out("report.tsv"), self.read_out("bad_lines.txt"))
        self.assertEqual(first, second)

    def test_no_trailing_blank_line(self):
        self.write_log(LOG_LINES)
        self.assertEqual(self.run_pipeline().returncode, 0)
        for name in ("report.tsv", "bad_lines.txt"):
            data = self.read_out(name)
            self.assertTrue(data.endswith("\n"), name)
            self.assertFalse(data.endswith("\n\n"), name)


if __name__ == "__main__":
    unittest.main()
