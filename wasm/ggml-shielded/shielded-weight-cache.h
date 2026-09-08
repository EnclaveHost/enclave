#ifndef SHIELDED_WEIGHT_CACHE_H
#define SHIELDED_WEIGHT_CACHE_H

/* A per-process cache of PUBLIC encoded weights. The unlinked file is not
 * trusted: hashes of each block stay in private RAM, and reads authenticate
 * the same private buffer the caller consumes. No mmap, keys or activations.
 * This does not authenticate the original GGUF used to produce the encoding. */
extern "C" {
#include "tweetnacl.h"
}
#include "shielded-sha256.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <unistd.h>
#include <vector>

class sh_weight_cache {
public:
    static constexpr size_t block_bytes = 1u << 20;
    ~sh_weight_cache() { if (fd_ >= 0) close(fd_); }
    sh_weight_cache(const sh_weight_cache &) = delete;
    sh_weight_cache &operator=(const sh_weight_cache &) = delete;

    static std::unique_ptr<sh_weight_cache> create(const char *directory,
            const int8_t *weights, size_t bytes) {
        if (!directory || !*directory || !weights || !bytes || bytes > INT64_MAX) return nullptr;
        std::unique_ptr<sh_weight_cache> out(new (std::nothrow) sh_weight_cache);
        if (!out) return nullptr;
        try {
            const char *mode = getenv("SHIELDED_WEIGHT_CACHE_SHA256");
            out->sha256_ = mode && !strcmp(mode, "1");
            std::string path = std::string(directory) + "/.shielded-weights-XXXXXX";
            out->hashes_.resize((bytes - 1) / block_bytes + 1);
            out->fd_ = mkstemp(&path[0]);
            if (out->fd_ < 0) return nullptr;
            const int flags = fcntl(out->fd_, F_GETFD);
            const bool protected_fd = flags >= 0 && fcntl(out->fd_, F_SETFD, flags | FD_CLOEXEC) == 0;
            const bool removed = unlink(path.c_str()) == 0;
            if (!protected_fd || !removed) return nullptr;
            out->bytes_ = bytes;
            for (size_t off = 0, b = 0; off < bytes; off += block_bytes, b++) {
                const size_t n = std::min(block_bytes, bytes - off);
                out->hash_block((const uint8_t *)weights + off, n, out->hashes_[b]);
                size_t wrote = 0;
                while (wrote < n) {
                    const ssize_t w = pwrite(out->fd_, weights + off + wrote, n - wrote, (off_t)(off + wrote));
                    if (w < 0 && errno == EINTR) continue;
                    if (w <= 0) return nullptr;
                    wrote += (size_t)w;
                }
            }
            // Permit the kernel to reclaim dirty cache pages during registration.
            int rc; do { rc = fdatasync(out->fd_); } while (rc < 0 && errno == EINTR);
            if (rc < 0) return nullptr;
            (void)posix_fadvise(out->fd_, 0, 0, POSIX_FADV_DONTNEED);
            return out;
        } catch (const std::bad_alloc &) { return nullptr; }
          catch (const std::length_error &) { return nullptr; }
    }

    // Failure invalidates the entire output, including any earlier blocks.
    int read(uint64_t offset, uint8_t *out, size_t n) const {
        if (!out || offset > bytes_ || n > bytes_ - (size_t)offset) return -1;
        if (!n) return 0;
        read_calls_.fetch_add(1, std::memory_order_relaxed);
        std::unique_ptr<uint8_t[]> block(new (std::nothrow) uint8_t[block_bytes]);
        if (!block) return -1;
        while (n) {
            const size_t b = (size_t)offset / block_bytes, begin = b * block_bytes;
            const size_t size = std::min(block_bytes, bytes_ - begin);
            size_t have = 0;
            while (have < size) {
                const ssize_t r = pread(fd_, block.get() + have, size - have, (off_t)(begin + have));
                if (r < 0 && errno == EINTR) continue;
                if (r <= 0) return -1;
                read_bytes_.fetch_add((uint64_t)r, std::memory_order_relaxed);
                have += (size_t)r;
            }
            std::array<uint8_t, 64> hash;
            hash_block(block.get(), size, hash);
            if (hash != hashes_[b]) return -1;
            const size_t skip = (size_t)offset - begin, take = std::min(n, size - skip);
            memcpy(out, block.get() + skip, take);
            out += take; offset += take; n -= take;
        }
        return 0;
    }
    static int reader(void *ctx, uint64_t offset, uint8_t *out, size_t bytes) {
        return static_cast<sh_weight_cache *>(ctx)->read(offset, out, bytes);
    }
    size_t hash_bytes() const { return hashes_.size() * 64; }
    const char *hash_algorithm() const { return sha256_ ? "sha256" : "sha512"; }
    uint64_t read_calls() const { return read_calls_.load(std::memory_order_relaxed); }
    uint64_t read_bytes() const { return read_bytes_.load(std::memory_order_relaxed); }
private:
    void hash_block(const uint8_t *bytes, size_t n, std::array<uint8_t, 64> &out) const {
        if (sha256_) {
            // Private per-cache policy; never inferred from a host file.
            // Preserve fixed hash storage so both algorithms share the same
            // cache reader. Unused bytes must compare deterministically.
            out.fill(0);
            sha256_ctx h; sha_init(&h); sha_update(&h, bytes, n); sha_final(&h, out.data());
        } else crypto_hash(out.data(), bytes, n);
    }
    sh_weight_cache() = default;
    int fd_ = -1;
    bool sha256_ = false;
    size_t bytes_ = 0;
    std::vector<std::array<uint8_t, 64>> hashes_;
    mutable std::atomic<uint64_t> read_calls_{0}, read_bytes_{0};
};
#endif
