"""Visible smoke tests shipped with the seed. Do not modify this file."""

import unittest

import dedupe


def key_of(item):
    return item


class TestVisibleDedupe(unittest.TestCase):
    def test_empty_input(self):
        self.assertEqual(dedupe.resolve([], key_of), [])

    def test_exact_duplicates_are_removed_in_order(self):
        items = ["alpha", "beta", "alpha", "gamma", "beta"]
        self.assertEqual(dedupe.resolve(items, key_of), ["alpha", "beta", "gamma"])

    def test_normalized_near_duplicates(self):
        items = ["Hello, World", "  hello__world ", "other"]
        self.assertEqual(dedupe.resolve(items, key_of), ["  hello__world ", "other"])

    def test_default_window_ignores_far_duplicates(self):
        items = ["dup", "a", "b", "c", "dup"]
        self.assertEqual(dedupe.resolve(items, key_of), ["dup", "a", "b", "c", "dup"])

    def test_window_zero_keeps_everything(self):
        items = ["a", "a", "a"]
        self.assertEqual(dedupe.resolve(items, key_of, window=0), ["a", "a", "a"])

    def test_stats_shape(self):
        self.assertIsInstance(dedupe.STATS, dict)
        self.assertIsInstance(dedupe.STATS["calls"], int)


if __name__ == "__main__":
    unittest.main()
