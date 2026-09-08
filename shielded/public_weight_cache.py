"""Bounded process-local copies of public weights; no disk or activation cache.

The CUDA worker mirrors this in public-weight-cache.h. Internal callbacks must
not retain a cache entry: copy_to holds the lock until the destination owns its bytes.
Per-connection GPU and staging charges are independent of this extra RAM budget.
"""
from collections import OrderedDict
import hashlib
import threading


class PublicWeightCache:
    MAX_ENTRIES = 4096

    def __init__(self, budget=0):
        if not isinstance(budget, int) or budget < 0:
            raise ValueError("public weight cache budget must be a nonnegative integer")
        self.budget = budget
        self.used = 0
        self._entries = OrderedDict()
        self._lock = threading.Lock()

    def copy_to(self, digest, nbytes, destination):
        if len(digest) != 32 or not 0 < nbytes <= self.budget:
            return False
        key = (bytes(digest), nbytes)
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return False
            destination(entry)
            self._entries.move_to_end(key)
            return True

    def admit(self, digest, source):
        source = memoryview(source).cast("B")
        nbytes = len(source)
        if len(digest) != 32:
            raise ValueError("public weight digest must be SHA256")
        if not 0 < nbytes <= self.budget:
            return False
        key = (bytes(digest), nbytes)
        with self._lock:
            existing = self._entries.get(key)
            if existing is not None:
                if source != existing:
                    raise ValueError("public weight cache digest mismatch")
                self._entries.move_to_end(key)
                return True
            while self.used > self.budget - nbytes or len(self._entries) >= self.MAX_ENTRIES:
                _, old = self._entries.popitem(last=False)
                self.used -= len(old)
                del old
            snapshot = bytes(source)
            if hashlib.sha256(snapshot).digest() != digest:
                raise ValueError("public weight cache digest mismatch")
            self._entries[key] = snapshot
            self.used += nbytes
            return True
