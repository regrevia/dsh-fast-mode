import unittest

from inventory.api import add_item, get_item, list_items, remove_item, total_value
from inventory.store import Store


class Clock:
    def __init__(self, now=100.0):
        self.now = now

    def __call__(self):
        return self.now

    def tick(self, seconds):
        self.now += seconds


class TtlTest(unittest.TestCase):
    def test_live_entry_before_deadline(self):
        clock = Clock()
        s = Store(clock=clock)
        s.add('k', 'v', ttl=5)
        clock.tick(4.5)
        self.assertEqual(s.get('k'), 'v')

    def test_entry_expires_at_deadline(self):
        clock = Clock()
        s = Store(clock=clock)
        s.add('k', 'v', ttl=5)
        clock.tick(5)
        self.assertIsNone(s.get('k'))

    def test_expired_entry_honours_default(self):
        clock = Clock()
        s = Store(clock=clock)
        s.add('k', 'v', ttl=5)
        clock.tick(9)
        self.assertEqual(s.get('k', 'gone'), 'gone')

    def test_expired_entry_leaves_keys_and_len(self):
        clock = Clock()
        s = Store(clock=clock)
        s.add('a', 1)
        s.add('b', 2, ttl=1)
        clock.tick(2)
        self.assertEqual(s.keys(), ['a'])
        self.assertEqual(len(s), 1)

    def test_no_ttl_never_expires(self):
        clock = Clock()
        s = Store(clock=clock)
        s.add('k', 'v')
        clock.tick(10 ** 6)
        self.assertEqual(s.get('k'), 'v')

    def test_readd_resets_ttl(self):
        clock = Clock()
        s = Store(clock=clock)
        s.add('k', 'v', ttl=5)
        clock.tick(4)
        s.add('k', 'v2', ttl=5)
        clock.tick(4)
        self.assertEqual(s.get('k'), 'v2')
        clock.tick(1)
        self.assertIsNone(s.get('k'))

    def test_remove_expired_key_returns_false(self):
        clock = Clock()
        s = Store(clock=clock)
        s.add('k', 'v', ttl=1)
        clock.tick(2)
        self.assertFalse(s.remove('k'))


class BugFixTest(unittest.TestCase):
    def test_remove_missing_key_returns_false(self):
        s = Store()
        self.assertFalse(s.remove('ghost'))

    def test_remove_live_key_true_and_shrinks(self):
        s = Store()
        s.add('a', 1)
        self.assertTrue(s.remove('a'))
        self.assertEqual(len(s), 0)

    def test_total_value_uses_qty(self):
        s = Store()
        add_item(s, 'hammer', 10, 2)
        add_item(s, 'nail', 1, 100)
        self.assertEqual(total_value(s), 120)

    def test_total_value_empty_store_is_zero(self):
        self.assertEqual(total_value(Store()), 0)

    def test_add_item_defaults_to_one_unit(self):
        s = Store()
        add_item(s, 'saw', 25)
        self.assertEqual(get_item(s, 'saw')['qty'], 1)
        self.assertEqual(total_value(s), 25)


class PaginationTest(unittest.TestCase):
    def make(self, n=7):
        s = Store()
        for i in range(n):
            add_item(s, 'item%02d' % i, i + 1)
        return s

    def test_first_page(self):
        page = list_items(self.make(), page=1, page_size=3)
        self.assertEqual([i['name'] for i in page['items']], ['item00', 'item01', 'item02'])
        self.assertEqual((page['page'], page['total']), (1, 7))

    def test_last_page_partial(self):
        page = list_items(self.make(), page=3, page_size=3)
        self.assertEqual([i['name'] for i in page['items']], ['item06'])
        self.assertEqual(page['total'], 7)

    def test_page_beyond_end_is_empty_but_total_stands(self):
        page = list_items(self.make(), page=9, page_size=3)
        self.assertEqual(page['items'], [])
        self.assertEqual(page['total'], 7)

    def test_invalid_page_rejected(self):
        with self.assertRaises(ValueError):
            list_items(self.make(), page=0)
        with self.assertRaises(ValueError):
            list_items(self.make(), page_size=0)

    def test_expired_items_not_listed(self):
        clock = Clock()
        s = Store(clock=clock)
        add_item(s, 'keep', 2, 1)
        s.add('drop', {'name': 'drop', 'price': 9, 'qty': 1}, ttl=1)
        clock.tick(2)
        page = list_items(s)
        self.assertEqual([i['name'] for i in page['items']], ['keep'])
        self.assertEqual(page['total'], 1)

    def test_remove_item_missing_is_false(self):
        self.assertFalse(remove_item(self.make(), 'ghost'))


if __name__ == '__main__':
    unittest.main()
