#include "../../shielded/worker-cuda/captured-graphs.h"
#include <cassert>
#include <cstdlib>
#include <new>
#include <set>
#include <string>

static int fail_allocation_after = -1;
// Keep the paired replacement allocation functions out of callers so GCC
// does not mistake their deliberately shared malloc/free implementation for
// mixing the normal global new with free after inlining only one side.
__attribute__((noinline)) void *operator new(size_t n) {
    if (fail_allocation_after == 0) { fail_allocation_after = -1; throw std::bad_alloc(); }
    if (fail_allocation_after > 0) --fail_allocation_after;
    if (void *p = std::malloc(n ? n : 1)) return p;
    throw std::bad_alloc();
}
__attribute__((noinline)) void operator delete(void *p) noexcept { std::free(p); }
__attribute__((noinline)) void operator delete(void *p, size_t) noexcept { std::free(p); }
static int live = 0, created = 0, destroyed = 0;
struct FakeGraph { int identity; };
struct Destroy {
    void operator()(FakeGraph *p) const noexcept { if (p) { --live; ++destroyed; delete p; } }
};
using Cache = CapturedGraphs<FakeGraph *, Destroy>;
static FakeGraph *capture() { FakeGraph *p = new FakeGraph{++created}; ++live; return p; }

static void limits() {
    size_t out = 77;
    assert(sh_graph_cache_limit(nullptr, &out) && out == 256);
    assert(sh_graph_cache_limit("1", &out) && out == 1);
    assert(sh_graph_cache_limit("4096", &out) && out == 4096);
    for (const char *bad : {"", "0", "00", "01", "-1", "+1", " 2", "2 ", "1.0", "NaN", "inf", "4097", "999999999999999999999999"}) {
        out = 77; assert(!sh_graph_cache_limit(bad, &out) && out == 77);
    }
    assert(!sh_graph_cache_limit("2", nullptr));
    for (size_t bad : {size_t(0), size_t(4097)}) {
        bool refused = false;
        try { Cache c(bad); } catch (const std::invalid_argument &) { refused = true; }
        assert(refused);
    }
}

static void ownership() {
    {
        Cache c(2);
        const std::vector<uint32_t> key{1, 4, 10, 11};
        FakeGraph *first = c.get(key, capture);
        assert(c.get(key, []() -> FakeGraph * { std::abort(); }) == first);
        assert(c.stats.hits == 1 && c.stats.misses == 1 && live == 1);
        c.get({1, 3, 10, 11}, capture); // m changes the captured source/output layout
        assert(c.size() == 2 && live == 2);
        const int before = destroyed;
        c.get({1, 4, 11, 10}, capture); // node order also changes reply layout
        assert(c.stats.capacity_flushes == 1 && c.size() == 1 && live == 1 && destroyed == before + 2);
        c.invalidate(); // pinned/device staging pointer has changed
        assert(c.size() == 0 && live == 0 && c.stats.invalidations == 1);
        c.invalidate(); assert(c.stats.invalidations == 1);
        c.get(key, capture);
        assert(live == 1 && c.stats.high_water == 2);
    }
    assert(live == 0);
}

static void failure() {
    Cache c(4);
    const std::vector<uint32_t> old{1, 1, 1}, key{1, 4, 2, 3};
    FakeGraph *saved = c.get(old, capture);
    for (int allocation : {0, 1}) {
        const int before = destroyed;
        bool refused = false;
        try {
            c.get(key, [&]() {
                auto *p = capture();
                fail_allocation_after = allocation; // fail map-node or key-copy allocation after CUDA capture
                return p;
            });
        } catch (const std::bad_alloc &) { refused = true; }
        fail_allocation_after = -1;
        assert(refused && destroyed == before + 1 && live == 1 && c.size() == 1);
        assert(c.get(old, []() -> FakeGraph * { std::abort(); }) == saved);
    }
    bool refused = false;
    try { c.get(key, []() -> FakeGraph * { throw std::runtime_error("capture failed"); }); }
    catch (const std::runtime_error &) { refused = true; }
    assert(refused && live == 1 && c.size() == 1);
    refused = false;
    try { c.get(key, []() -> FakeGraph * { return nullptr; }); }
    catch (const std::runtime_error &) { refused = true; }
    assert(refused && live == 1 && c.size() == 1);
}

static void repeated_passes() {
    // This is a controlled key trace, not a replay of measured phone traffic.
    // A 257-key pass straddles the old 256-entry whole-cache eviction boundary.
    for (size_t limit : {size_t(256), size_t(2048)}) {
        Cache c(limit);
        for (int round = 0; round < 6; ++round)
            for (uint32_t group = 0; group < 257; ++group) {
                c.get({1, 4, group}, capture);
                assert(c.size() <= limit && live == static_cast<int>(c.size()));
            }
        if (limit == 256) assert(c.stats.misses == 6*257 && c.stats.hits == 0);
        else assert(c.stats.misses == 257 && c.stats.hits == 5*257 && c.stats.capacity_flushes == 0);
    }
    assert(live == 0);
    // Five m variants still fit the opt-in bound and remain separate keys.
    Cache c(2048);
    for (int round = 0; round < 2; ++round)
        for (uint32_t m = 1; m <= 5; ++m)
            for (uint32_t group = 0; group < 262; ++group) c.get({1, m, group}, capture);
    assert(c.stats.misses == 1310 && c.stats.hits == 1310 && c.size() == 1310);
    c.invalidate(); assert(live == 0);
    c.get({1, 1, 0}, capture); assert(c.stats.misses == 1311);
}

int main() {
    limits(); ownership(); failure(); assert(live == 0);
    repeated_passes(); assert(live == 0 && created == destroyed);
}
