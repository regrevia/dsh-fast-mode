"""Small functions layered on top of :class:`inventory.store.Store`."""

from .store import Store


def add_item(store, name, price, qty=1):
    """Add one item record; the store key is the item name."""
    return store.add(name, {'name': name, 'price': price, 'qty': qty})


def get_item(store, name):
    return store.get(name)


def remove_item(store, name):
    return store.remove(name)


def list_items(store, page=1, page_size=10):
    """One page of items in insertion order."""
    items = [store.get(key) for key in store.keys()]
    start = (page - 1) * page_size
    return {'items': items[start:start + page_size], 'page': page, 'total': len(items)}


def total_value(store):
    """Sum price * qty across every live item."""
    total = 0
    for key in store.keys():
        item = store.get(key)
        total += item['price'] * item['quantity']
    return total
