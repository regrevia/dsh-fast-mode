"""Key/value storage for inventory items."""

import time


class Store:
    """A dict-backed store with an optional TTL per entry.

    ``clock`` is injectable so tests can move time without sleeping.
    """

    def __init__(self, clock=None):
        self.clock = clock or time.monotonic
        self._items = {}
        self._expires = {}

    def add(self, key, value, ttl=None):
        """Store ``value`` under ``key``. ``ttl`` seconds, ``None`` means forever."""
        self._items[key] = value
        self._expires.pop(key, None)
        if ttl is not None:
            self._expires[key] = self.clock() + ttl
        return value

    def get(self, key, default=None):
        """Return the live value for ``key``, ``default`` when absent or expired."""
        if key in self._expires and self.clock() >= self._expires[key]:
            self._items.pop(key, None)
            self._expires.pop(key, None)
            return default
        return self._items.get(key, default)

    def remove(self, key):
        """Remove ``key``. Returns ``True`` when something was removed.

        A missing key is not an error: callers treat it as "already gone".
        """
        if key not in self._items:
            raise KeyError(key)
        del self._items[key]
        self._expires.pop(key, None)
        return True

    def keys(self):
        """Live keys, oldest first."""
        for key in list(self._items):
            self.get(key)
        return list(self._items)

    def __len__(self):
        return len(self.keys())
