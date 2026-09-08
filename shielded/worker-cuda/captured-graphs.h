#ifndef SHIELDED_CAPTURED_GRAPHS_H
#define SHIELDED_CAPTURED_GRAPHS_H

#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <stdexcept>
#include <type_traits>
#include <vector>

// Per-connection bound. Preserve the existing clear-at-capacity policy so an
// experiment changes only capacity. Staging-pointer changes still invalidate
// every captured graph, independent of this bound.
static constexpr size_t SH_GRAPH_CACHE_DEFAULT = 256;
static constexpr size_t SH_GRAPH_CACHE_MAX = 4096;

inline bool sh_graph_cache_limit(const char *value, size_t *out) {
    if (!out) return false;
    if (!value) { *out = SH_GRAPH_CACHE_DEFAULT; return true; }
    if (*value < '1' || *value > '9') return false;
    size_t n = 0;
    for (const char *p = value; *p; ++p) {
        if (*p < '0' || *p > '9') return false;
        const size_t digit = static_cast<size_t>(*p - '0');
        if (n > (SH_GRAPH_CACHE_MAX - digit) / 10) return false;
        n = n * 10 + digit;
    }
    *out = n;
    return true;
}

template<class Handle, class Destroy> class CapturedGraphs {
    static_assert(std::is_pointer<Handle>::value, "graph handles must be pointers");
    using Key = std::vector<uint32_t>;
    using Owned = std::unique_ptr<typename std::remove_pointer<Handle>::type, Destroy>;
    std::map<Key, Owned> entries_;
    const size_t limit_;
public:
    struct Stats {
        uint64_t hits = 0, misses = 0, capacity_flushes = 0, invalidations = 0;
        size_t high_water = 0;
    } stats;

    explicit CapturedGraphs(size_t limit) : limit_(limit) {
        if (!limit || limit > SH_GRAPH_CACHE_MAX) throw std::invalid_argument("graph cache limit");
    }
    CapturedGraphs(const CapturedGraphs &) = delete;
    CapturedGraphs &operator=(const CapturedGraphs &) = delete;
    size_t size() const { return entries_.size(); }
    size_t limit() const { return limit_; }
    void invalidate() {
        if (!entries_.empty()) ++stats.invalidations;
        entries_.clear();
    }
    template<class Capture> Handle get(const Key &key, Capture capture) {
        auto it = entries_.find(key);
        if (it != entries_.end()) { ++stats.hits; return it->second.get(); }
        ++stats.misses;
        if (entries_.size() == limit_) {
            ++stats.capacity_flushes;
            entries_.clear();
        }
        // Own the CUDA handle before any map/key allocation can throw. A
        // failed insertion destroys this new graph instead of leaking it.
        Owned owned(capture());
        if (!owned) throw std::runtime_error("capture returned a null graph");
        const Handle value = owned.get();
        entries_.emplace(key, std::move(owned));
        if (entries_.size() > stats.high_water) stats.high_water = entries_.size();
        return value;
    }
};
#endif
