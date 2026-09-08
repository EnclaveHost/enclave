#ifndef SH_PUBLIC_WEIGHT_CACHE_H
#define SH_PUBLIC_WEIGHT_CACHE_H
/* Optional, process-local RAM cache of PUBLIC weight bytes. Never a tenant
 * trust boundary: the protected caller still verifies every matrix product.
 * Copies are immutable and never leave this lock by reference. GPU allocations
 * remain per connection and are charged exactly as for an ordinary upload. */
#include <array>
#include <cstdint>
#include <cstring>
#include <list>
#include <mutex>
#include <vector>
#include "shielded-sha256.h"

struct PublicWeightRequest {
    uint8_t action;                 // 0: copy hit to weights; 1: admit uploaded bytes
    uint64_t bid, offset, nbytes;
    std::array<uint8_t, 32> digest;
};

static inline bool public_weight_request(const uint8_t *p, size_t n, PublicWeightRequest &r) {
    if (n != 57 || p[0] > 1) return false;
    r.action = p[0];
    uint64_t values[3] = {};
    for (int j = 0; j < 3; ++j)
        for (int i = 0; i < 8; ++i) values[j] |= (uint64_t)p[1 + j*8 + i] << (i*8);
    r.bid = values[0]; r.offset = values[1]; r.nbytes = values[2];
    memcpy(r.digest.data(), p + 25, 32);
    return r.nbytes != 0;
}

class PublicWeightCache {
    struct Entry { std::array<uint8_t, 32> digest; std::vector<uint8_t> data; };
    const size_t budget_;
    size_t used_ = 0;
    std::list<Entry> entries_;       // most recently used first; metadata capped too
    mutable std::mutex mutex_;
    static constexpr size_t max_entries_ = 4096;
    auto find(const uint8_t *digest, size_t n) -> std::list<Entry>::iterator {
        for (auto it = entries_.begin(); it != entries_.end(); ++it)
            if (it->data.size() == n && !memcmp(it->digest.data(), digest, 32)) return it;
        return entries_.end();
    }
public:
    explicit PublicWeightCache(size_t budget = 0) : budget_(budget) {}
    size_t budget() const { return budget_; }
    size_t used() const { std::lock_guard<std::mutex> lk(mutex_); return used_; }
    size_t count() const { std::lock_guard<std::mutex> lk(mutex_); return entries_.size(); }
    bool copy(const uint8_t *digest, size_t n, uint8_t *destination) {
        if (!n || n > budget_) return false;
        std::lock_guard<std::mutex> lk(mutex_);
        auto it = find(digest, n);
        if (it == entries_.end()) return false;
        memcpy(destination, it->data.data(), n);
        entries_.splice(entries_.begin(), entries_, it);
        return true;
    }
    // Return -1 for an identity mismatch, 0 for an entry too large/disabled,
    // 1 for admission. Hash the OWNED snapshot, never the peer's claimed digest
    // or a mutable view. Evict BEFORE allocating: retained bytes plus this
    // pending snapshot never exceed budget_, even with concurrent connections.
    int admit(const uint8_t *digest, const uint8_t *source, size_t n) {
        if (!n || n > budget_) return 0;
        std::lock_guard<std::mutex> lk(mutex_);
        auto old = find(digest, n);
        if (old != entries_.end()) {
            if (memcmp(old->data.data(), source, n)) return -1;
            entries_.splice(entries_.begin(), entries_, old);
            return 1;
        }
        while (used_ > budget_ - n || entries_.size() >= max_entries_) {
            used_ -= entries_.back().data.size(); entries_.pop_back();
        }
        Entry entry;
        entry.data.assign(source, source + n);
        sha256_ctx sha; sha_init(&sha); sha_update(&sha, entry.data.data(), n);
        sha_final(&sha, entry.digest.data());
        if (memcmp(entry.digest.data(), digest, 32)) return -1;
        entries_.push_front(std::move(entry));
        used_ += n;
        return 1;
    }
};
#endif
