// Host-only graph-cache lookup microbenchmark; no CUDA or inference timing.
// Build with -I shielded/worker-cuda. Add -DSH_BORROWED_GRAPH_KEYS for the
// allocation-free caller; omit it when comparing an older cache header.
#include "captured-graphs.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <new>

static bool counting = false;
static size_t allocations = 0, allocated_bytes = 0;
__attribute__((noinline)) void *operator new(size_t n) {
    if (counting) { ++allocations; allocated_bytes += n; }
    if (void *p = std::malloc(n ? n : 1)) return p;
    throw std::bad_alloc();
}
__attribute__((noinline)) void operator delete(void *p) noexcept { std::free(p); }
__attribute__((noinline)) void operator delete(void *p, size_t) noexcept { std::free(p); }
struct Graph { uint32_t id; };
struct Destroy { void operator()(Graph *p) const noexcept { delete p; } };
using Cache = CapturedGraphs<Graph *, Destroy>;

static size_t make_key(uint32_t *key, uint32_t group, bool wide) {
    key[0] = group % 4; key[1] = group % 8 + 1; key[2] = group % 2;
    const size_t n = 3 + (wide ? 64 : 1 + group % 4);
    for (size_t i = 3; i < n; ++i) key[i] = group * 64 + uint32_t(i);
    return n;
}

int main() {
    constexpr size_t iterations = 2000000;
    for (const auto spec : {std::pair<size_t, bool>{274, false}, {514, false}, {274, true}}) {
        Cache cache(1024);
        for (uint32_t group = 0; group < spec.first; ++group) {
            uint32_t key[67]; const size_t n = make_key(key, group, spec.second);
            cache.get(std::vector<uint32_t>(key, key + n), [=] { return new Graph{group}; });
        }
        allocations = allocated_bytes = 0;
        uint64_t checksum = 0;
        counting = true;
        const auto start = std::chrono::steady_clock::now();
        for (size_t i = 0; i < iterations; ++i) {
            const uint32_t group = uint32_t((i * 17) % spec.first);
            uint32_t key[67]; const size_t n = make_key(key, group, spec.second);
#ifdef SH_BORROWED_GRAPH_KEYS
            Graph *g = cache.get(key, n, []() -> Graph * { std::abort(); });
#else
            Graph *g = cache.get(std::vector<uint32_t>(key, key + n), []() -> Graph * { std::abort(); });
#endif
            checksum += g->id;
        }
        const auto elapsed = std::chrono::steady_clock::now() - start;
        counting = false;
        const double ns = std::chrono::duration<double, std::nano>(elapsed).count();
        if (cache.stats.hits != iterations || cache.stats.misses != spec.first) return 1;
        std::printf("{\"keys\":%zu,\"max_nodes\":%d,\"iterations\":%zu,\"ns_per_lookup\":%.3f,"
                    "\"allocations\":%zu,\"allocated_bytes\":%zu,\"checksum\":%llu}\n",
                    spec.first, spec.second ? 64 : 4, iterations, ns / iterations,
                    allocations, allocated_bytes, (unsigned long long)checksum);
    }
}
