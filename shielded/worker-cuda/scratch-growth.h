#ifndef SHIELDED_WORKER_SCRATCH_GROWTH_H
#define SHIELDED_WORKER_SCRATCH_GROWTH_H
#include <cstddef>

/* Caller serializes storage use and finishes in-flight GPU work first. On
 * growth, invalidate captured references before releasing old storage. Clear
 * ownership before release so a failed allocation cannot leave a stale pointer
 * for connection cleanup. Allocate writes directly into owned storage: if an
 * asynchronous allocation succeeds but its synchronization throws, that new
 * pointer remains owned for cleanup, with capacity still zero.
 *
 * release must not throw. allocate either succeeds or throws; on failure it
 * leaves storage null or holding an allocation the caller must release. A
 * failure ends this connection; the helper does not make it reusable. */
template<class T, class Invalidate, class Release, class Allocate>
void grow_worker_scratch(T *&storage, std::size_t &capacity, std::size_t needed,
                         Invalidate invalidate, Release release, Allocate allocate) {
    if (capacity >= needed) return;
    invalidate();
    T *old = storage;
    storage = nullptr;
    capacity = 0;
    if (old) release(old);
    allocate(&storage, needed);
    capacity = needed;
}
#endif
