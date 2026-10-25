"""Hidden acceptance tests for the shellops (logops) fixture."""

import hashlib
import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = 'ops.sh'


def run(args):
    return subprocess.run(['bash', SCRIPT, *args], capture_output=True, text=True, timeout=120)


def digest(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


class LogOps(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name) / 'logs'
        self.dir.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, text):
        (self.dir / name).write_bytes(text.encode('utf-8'))

    def test_counts_and_ordering(self):
        self.write('b.log', 'INFO ok\nERROR bad\n\n')
        self.write('a.log', 'ERROR one\nERROR two\nERROR three\n')
        p = run([str(self.dir)])
        self.assertEqual(p.returncode, 3)
        self.assertEqual(p.stdout, 'a.log 3 3\nb.log 3 1\nTOTAL 6 4\n')

    def test_marker_is_the_five_character_prefix(self):
        self.write('m.log', 'ERROR x\nERRORS y\n  ERROR z\ninfo ERROR w\n')
        p = run([str(self.dir)])
        self.assertEqual(p.stdout, 'm.log 4 2\nTOTAL 4 2\n')
        self.assertEqual(p.returncode, 3)

    def test_clean_directory_exits_zero(self):
        self.write('a.log', 'INFO a\nWARN b\n')
        p = run([str(self.dir)])
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout, 'a.log 2 0\nTOTAL 2 0\n')

    def test_other_files_and_dirs_are_ignored(self):
        self.write('a.log', 'INFO a\n')
        (self.dir / 'notes.txt').write_text('ERROR nope\n')
        (self.dir / 'logs.bak').write_text('ERROR nope\n')
        (self.dir / 'sub.log').mkdir()
        p = run([str(self.dir)])
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout, 'a.log 1 0\nTOTAL 1 0\n')

    def test_empty_directory(self):
        p = run([str(self.dir)])
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout, 'TOTAL 0 0\n')

    def test_missing_directory(self):
        p = run([str(self.dir / 'nope')])
        self.assertEqual(p.returncode, 2)
        self.assertEqual(p.stdout, '')
        self.assertEqual(p.stderr, f'no such directory: {self.dir / "nope"}\n')

    def test_file_instead_of_directory(self):
        f = pathlib.Path(self.tmp.name) / 'x.log'
        f.write_text('ERROR a\n')
        p = run([str(f)])
        self.assertEqual(p.returncode, 2)
        self.assertEqual(p.stdout, '')
        self.assertIn('no such directory:', p.stderr)

    def test_no_argument_is_usage_error(self):
        p = run([])
        self.assertEqual(p.returncode, 2)
        self.assertEqual(p.stdout, '')
        self.assertEqual(p.stderr, 'usage: ops.sh DIR\n')

    def test_names_with_spaces_quotes_and_unicode(self):
        self.write('a b.log', 'ERROR x\n')
        self.write("it's.log", 'INFO q\n')
        self.write('日誌.log', 'ERROR y\n')
        p = run([str(self.dir)])
        self.assertEqual(p.returncode, 3)
        self.assertEqual(p.stdout,
                         "a b.log 1 1\nit's.log 1 0\n日誌.log 1 1\nTOTAL 3 2\n")

    def test_long_lines_are_not_truncated(self):
        long = 'x' * 20000
        self.write('long.log', f'ERROR {long}\n')
        p = run([str(self.dir)])
        self.assertEqual(p.stdout, 'long.log 1 1\nTOTAL 1 1\n')
        self.assertEqual(p.returncode, 3)

    def test_large_file(self):
        body = ''.join('ERROR boom\n' if i % 100 == 0 else 'INFO line\n' for i in range(3000))
        self.write('big.log', body)
        p = run([str(self.dir)])
        self.assertEqual(p.stdout, 'big.log 3000 30\nTOTAL 3000 30\n')
        self.assertEqual(p.returncode, 3)

    def test_inputs_are_untouched_and_no_temp_files_left(self):
        self.write('a.log', 'ERROR a\n')
        self.write('b.log', 'INFO b\n')
        before = {p.name: digest(p) for p in self.dir.iterdir()}
        p = run([str(self.dir)])
        self.assertEqual(p.returncode, 3)
        after = {q.name: digest(q) for q in self.dir.iterdir()}
        self.assertEqual(before, after, 'input files were modified or created')

    def test_totals_are_the_sum_of_the_rows(self):
        self.write('a.log', 'ERROR 1\nERROR 2\n')
        self.write('b.log', 'ERROR 3\n')
        p = run([str(self.dir)])
        rows = p.stdout.strip().split('\n')
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[-1], 'TOTAL 3 3')

    def test_path_with_spaces(self):
        d = pathlib.Path(self.tmp.name) / 'my logs'
        d.mkdir()
        (d / 'a.log').write_text('ERROR z\n')
        p = run([str(d)])
        self.assertEqual(p.returncode, 3)
        self.assertEqual(p.stdout, 'a.log 1 1\nTOTAL 1 1\n')


if __name__ == '__main__':
    unittest.main()
