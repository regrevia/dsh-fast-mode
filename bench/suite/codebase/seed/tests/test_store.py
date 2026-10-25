import unittest

from inventory.store import Store


class FakeClock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


class StoreTest(unittest.TestCase):
    def test_add_and_get(self):
        s = Store()
        s.add('a', 1)
        self.assertEqual(s.get('a'), 1)

    def test_get_missing_returns_default(self):
        s = Store()
        self.assertIsNone(s.get('nope'))
        self.assertEqual(s.get('nope', 0), 0)

    def test_remove_returns_true(self):
        s = Store()
        s.add('a', 1)
        self.assertTrue(s.remove('a'))
        self.assertIsNone(s.get('a'))

    def test_keys_are_insertion_ordered(self):
        s = Store()
        for key in ('b', 'a', 'c'):
            s.add(key, key)
        self.assertEqual(s.keys(), ['b', 'a', 'c'])


if __name__ == '__main__':
    unittest.main()
