#pragma once
// Experimental only: not included by the runtime. The reader must authenticate
// into private memory before returning success. No pad may be published until
// this whole call succeeds. The caller still owns pad uniqueness and lifetime.
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <future>
#include <numeric>
#include <vector>

namespace streamed_prototype {
using kernel_fn = void (*)(const uint8_t *, int, const int8_t *, int64_t,
                           int64_t, int32_t *, int64_t, int32_t *);
struct metrics { size_t weight_buffer_bytes = 0, scratch_bytes = 0, chunks = 0; };

template<class Reader>
bool refill(Reader &&read, const uint8_t *planes, int b, int64_t K, int64_t N,
            int32_t *u, int64_t stride, size_t target_bytes, kernel_fn kernel,
            bool prefetch, metrics &stats) {
    stats = {};
    // Deliberately bounded prototype interface, not a new runtime ABI.
    if (!planes || !u || !kernel || b < 1 || b > 512 || K < 1 || K > (1<<18) ||
        N < 1 || N > (1<<20) || stride < N || stride > (1<<21) ||
        target_bytes < (size_t)K || target_bytes > (64u<<20)) return false;
    auto wipe = [&] { for (int i=0; i<b; ++i) memset(u+(int64_t)i*stride,0,(size_t)N*4); };
    try {
        int64_t rows = std::min<int64_t>(N, target_bytes / K);
        // Align whole rows with 1 MiB authentication blocks where possible.
        // Otherwise adjacent calls would reread and rehash boundary blocks.
        const int64_t align_rows=(1<<20)/std::gcd<int64_t>(K,1<<20);
        if (rows>=align_rows) rows-=rows%align_rows;
        if (rows >= 16) rows -= rows % 16;
        std::vector<int8_t> buf[2];
        buf[0].resize((size_t)rows*K);
        if (prefetch) buf[1].resize(buf[0].size());
        std::vector<int32_t> acc((size_t)12*rows);
        stats.weight_buffer_bytes = buf[0].size()+buf[1].size();
        stats.scratch_bytes = acc.size()*sizeof(int32_t);
        auto fetch = [&](int slot, int64_t start) {
            return read((uint64_t)start*K, (uint8_t *)buf[slot].data(),
                        (size_t)std::min(rows,N-start)*K) == 0;
        };
        if (!fetch(0,0)) { wipe(); return false; }
        int slot = 0;
        for (int64_t j=0; j<N; j+=rows) {
            const int64_t nr = std::min(rows,N-j), next=j+nr;
            std::future<bool> pending;
            if (prefetch && next<N)
                pending=std::async(std::launch::async,fetch,1-slot,next);
            // Kernel receives only the already authenticated private block.
            kernel(planes,b,buf[slot].data(),K,nr,u+j,stride,acc.data());
            stats.chunks++;
            if (next<N) {
                const bool ok=prefetch ? pending.get() : fetch(0,next);
                if (!ok) { wipe(); return false; }
                if (prefetch) slot=1-slot;
            }
        }
        return true;
    } catch (...) { wipe(); return false; }
}
}
