#include "../../shielded/worker-cuda/scratch-growth.h"
#include <cassert>
#include <cstdlib>
#include <set>
#include <stdexcept>
#include <vector>

struct FakeDevice {
    std::set<void *> live;
    std::vector<int> events;
    void *captured = nullptr;
    int *owned = nullptr;
    std::size_t cap = 0;
    int failure = 0;
    ~FakeDevice() { if (owned) release(owned); assert(live.empty()); }
    void release(int *p) {
        assert(captured != p); // no graph retains a released allocation
        assert(live.erase(p) == 1); // exactly-once release, never a stale pointer
        events.push_back(2); std::free(p);
    }
    void grow(std::size_t size) {
        grow_worker_scratch(owned, cap, size,
            [&] { events.push_back(1); captured = nullptr; },
            [&](int *p) { assert(owned == nullptr && cap == 0); release(p); },
            [&](int **p, std::size_t n) {
                assert(*p == nullptr && cap == 0); events.push_back(3);
                if (failure == 1) throw std::runtime_error("allocation failed without writing pointer");
                *p = static_cast<int *>(std::malloc(n)); assert(*p); assert(live.insert(*p).second);
                if (failure == 2) throw std::runtime_error("allocation succeeded; synchronization failed");
            });
    }
};
int main() {
    { FakeDevice d; d.grow(0); assert(d.events.empty() && !d.owned);
      d.grow(16); assert(d.owned && d.cap == 16); d.captured = d.owned;
      int *old = d.owned; d.events.clear(); d.grow(8); d.grow(16);
      assert(d.events.empty() && d.owned == old && d.captured == old);
      d.grow(64); assert((d.events == std::vector<int>{1,2,3}));
      assert(d.cap == 64 && d.live.size() == 1 && !d.captured); }
    for (int mode : {1,2}) {
        FakeDevice d; d.grow(16); d.captured = d.owned; d.events.clear(); d.failure = mode;
        bool failed = false; try { d.grow(64); } catch (const std::runtime_error &) { failed = true; }
        assert(failed && d.cap == 0 && !d.captured);
        assert((d.events == std::vector<int>{1,2,3}));
        assert(mode == 1 ? (!d.owned && d.live.empty()) : (d.owned && d.live.size() == 1));
        // Destructor must release the partial new allocation exactly once, or nothing after OOM.
    }
}
