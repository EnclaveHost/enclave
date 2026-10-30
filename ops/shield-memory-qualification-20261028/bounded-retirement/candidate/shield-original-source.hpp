#pragma once
// The caller supplies a private file already authenticated by the measured
// model loader. Never derive this table from host storage. Only public model
// bytes are read from backing storage; every reread is authenticated in private
// memory by the Shield source-buffer verifier before GGML can consume it.
#include <array>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <deque>
#include <map>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>
#include <fcntl.h>
#include <unistd.h>
#include <openssl/sha.h>

struct shield_original_source {
    struct entry {
        uint32_t type;
        std::array<int64_t, 4> ne;
        uint64_t offset, size;
        std::array<unsigned char, SHA256_DIGEST_LENGTH> digest;
        bool retired = false;
        bool consumed = false;
    };
    int private_fd = -1, backing_fd = -1;
    uint64_t file_size = 0, released_bytes = 0, reread_bytes = 0;
    size_t page = 0;
    bool defer_retirement = false;
    // Opt-in bound on consumed-but-unretired originals while deferring. Zero
    // keeps every consumed original until release_consumed(), as before.
    uint64_t retire_budget = 0, unretired_bytes = 0;
    std::deque<entry *> unretired;
    std::map<std::string, entry> entries;
    std::mutex mu;
    ~shield_original_source() {
        if (private_fd >= 0) close(private_fd);
        if (backing_fd >= 0) close(backing_fd);
    }
    static bool read_at(int fd, void *dst, size_t n, uint64_t offset) {
        if (fd < 0 || offset > INT64_MAX || n > uint64_t(INT64_MAX) - offset) return false;
        auto *p = static_cast<unsigned char *>(dst);
        while (n) {
            const ssize_t got = pread(fd, p, n, static_cast<off_t>(offset));
            if (got < 0 && errno == EINTR) continue;
            if (got <= 0) return false;
            p += got; n -= got; offset += got;
        }
        return true;
    }
    const entry *find(const char *name, uint32_t type, const int64_t ne[4], size_t n) const {
        if (!name || !ne) return nullptr;
        auto it = entries.find(name);
        if (it == entries.end()) return nullptr;
        const auto &e = it->second;
        return e.type == type && e.size == n && !memcmp(e.ne.data(), ne, sizeof(int64_t)*4) ? &e : nullptr;
    }
    void add(const char *name, uint32_t type, const int64_t ne[4], uint64_t offset, size_t n) {
        if (!n || offset > file_size || n > file_size-offset || entries.count(name))
            throw std::runtime_error("invalid source extent");
        entry e{}; e.type = type; memcpy(e.ne.data(), ne, sizeof(int64_t)*4); e.offset=offset; e.size=n;
        // Bounded temporary storage, independent of the largest tensor.
        SHA256_CTX hash; SHA256_Init(&hash);
        std::array<unsigned char, 64u << 10> buf;
        for (uint64_t at=0; at<n;) {
            const size_t count = std::min<uint64_t>(buf.size(), n-at);
            if (!read_at(private_fd, buf.data(), count, offset+at)) throw std::runtime_error("private source read");
            SHA256_Update(&hash, buf.data(), count); at += count;
        }
        SHA256_Final(e.digest.data(), &hash);
        entries.emplace(name, e);
    }
    bool retire(uint64_t offset, uint64_t n) {
        // Only whole pages inside this tensor. Its boundary pages can contain
        // neighbouring tensors not yet consumed; do not zero any of their bytes.
        if (!page || offset > file_size || n > file_size-offset) return false;
        const uint64_t begin = (offset + page-1) / page * page;
        const uint64_t end = (offset+n) / page * page;
        if (end <= begin) return true;
        if (fallocate(private_fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, begin, end-begin)) return false;
        released_bytes += end-begin;
        return true;
    }
    // Retire the oldest consumed originals until at most retire_budget bytes
    // remain unretired. Never the one just read: column-split registration
    // reads it again for the next card, which must not reread host storage.
    bool retire_over_budget(const entry *keep) {
        for (auto it = unretired.begin(); unretired_bytes > retire_budget && it != unretired.end();) {
            entry *e = *it;
            if (e == keep) { ++it; continue; }
            if (!e->retired) {
                if (!retire(e->offset, e->size)) return false;
                e->retired = true;
            }
            unretired_bytes -= e->size;
            it = unretired.erase(it);
        }
        return true;
    }
    // ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB. Unset or empty keeps the default.
    // Otherwise plain decimal MiB in [64, 65536]; anything else refuses the load.
    static bool parse_retire_budget_mib(const char *v, uint64_t &bytes) {
        bytes = 0;
        if (!v || !*v) return true;
        if (*v == '0' || strnlen(v, 6) > 5) return false;
        uint64_t mib = 0;
        for (const char *p = v; *p; p++) {
            if (*p < '0' || *p > '9') return false;
            mib = mib*10 + uint64_t(*p - '0');
        }
        if (mib < 64 || mib > 65536) return false;
        bytes = mib << 20;
        return true;
    }
    static int release_consumed(void *ctx) {
        auto &s = *static_cast<shield_original_source *>(ctx);
        std::lock_guard<std::mutex> lock(s.mu);
        for (auto &kv : s.entries) {
            auto &e = kv.second;
            if (!e.consumed || e.retired) continue;
            if (!s.retire(e.offset, e.size)) return -1;
            e.retired = true;
        }
        s.unretired.clear(); s.unretired_bytes = 0;
        return 0;
    }
    static int verify(void *ctx, const char *name, uint32_t type, const int64_t ne[4], const void *bytes, size_t n) {
        auto &s = *static_cast<shield_original_source *>(ctx);
        const auto *e = s.find(name, type, ne, n);
        unsigned char digest[SHA256_DIGEST_LENGTH];
        return e && bytes && SHA256(static_cast<const unsigned char *>(bytes), n, digest) &&
            !memcmp(digest, e->digest.data(), sizeof digest) ? 0 : -1;
    }
    static int read(void *ctx, const char *name, uint32_t type, const int64_t ne[4], void *bytes, size_t n) {
        auto &s = *static_cast<shield_original_source *>(ctx);
        std::lock_guard<std::mutex> lock(s.mu);
        if (!s.find(name, type, ne, n)) return -1;
        auto &e = s.entries.at(name);
        const int fd = e.retired ? s.backing_fd : s.private_fd;
        if (!read_at(fd, bytes, n, e.offset)) return -1;
        if (e.retired) {
            s.reread_bytes += n;
            posix_fadvise(fd, e.offset, n, POSIX_FADV_DONTNEED);
        } else {
            if (!e.consumed && s.defer_retirement && s.retire_budget) {
                if (e.size > UINT64_MAX - s.unretired_bytes) return -1;
                s.unretired_bytes += e.size;
                s.unretired.push_back(&e);
            }
            e.consumed = true;
            // Preserve the original allocation order while encoded weights
            // are being built. The planner releases this batch after all its
            // registrations have authenticated and allocated their weights.
            // An opt-in budget retires the oldest earlier in the batch.
            if (s.defer_retirement) return s.retire_over_budget(&e) ? 0 : -1;
            // The verifier consumes this private destination, never this file
            // again. Authentication failure latches the backend closed.
            if (!s.retire(e.offset, e.size)) return -1;
            e.retired = true;
        }
        return 0;
    }
};
