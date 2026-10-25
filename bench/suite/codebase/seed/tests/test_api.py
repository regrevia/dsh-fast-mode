import unittest

from inventory.api import add_item, list_items, total_value
from inventory.store import Store


class ApiTest(unittest.TestCase):
    def make(self):
        s = Store()
        for name, price, qty in (('hammer', 10, 2), ('nail', 1, 100), ('saw', 25, 1)):
            add_item(s, name, price, qty)
        return s

    def test_list_items_returns_everything(self):
        page = list_items(self.make())
        self.assertEqual(page['total'], 3)
        self.assertEqual([item['name'] for item in page['items']], ['hammer', 'nail', 'saw'])

    def test_total_value_sums_price_times_quantity(self):
        self.assertEqual(total_value(self.make()), 10 * 2 + 1 * 100 + 25)

    def test_remove_missing_item_is_not_an_error(self):
        s = Store()
        self.assertFalse(s.remove('ghost'))


if __name__ == '__main__':
    unittest.main()
