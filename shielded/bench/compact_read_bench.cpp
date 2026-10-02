#include "shielded-compact.h"
#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <vector>
static bool counting;
static size_t calls, bytes, largest;
void *operator new(size_t n) {
    void *p = std::malloc(n ? n : 1); if (!p) throw std::bad_alloc();
    if (counting) { ++calls; bytes += n; largest = std::max(largest, n); }
    return p;
}
void *operator new[](size_t n) { return ::operator new(n); }
void operator delete(void *p) noexcept { std::free(p); }
void operator delete[](void *p) noexcept { std::free(p); }
void operator delete(void *p, size_t) noexcept { std::free(p); }
void operator delete[](void *p, size_t) noexcept { std::free(p); }
int main(int argc, char **argv) {
    assert(argc == 4);
    const size_t K = std::strtoul(argv[1], nullptr, 10), N = 385;
    const bool partial = std::atoi(argv[2]);
    const int bits = std::atoi(argv[3]);
    std::vector<int8_t> w(K * N);
    for (size_t i = 0; i < w.size(); ++i)
        w[i] = bits == 8 ? int((i * 17) % 239) - 119 : int((i * 17) % 16) - 8;
    auto *store = sh_compact_create(w.data(), K, N); assert(store);
    const size_t off = partial ? 63 : 0, n = partial ? 127 : w.size();
    std::vector<uint8_t> out(n + 2, 0xa5);
    for (int i = 0; i < 3; ++i) assert(sh_compact_read(store, off, out.data()+1, n) == SH_OK);
    assert(!std::memcmp(out.data()+1, w.data()+off, n));
    constexpr int iterations = 30;
    const auto start = std::chrono::steady_clock::now();
    counting = true;
    for (int i = 0; i < iterations; ++i) assert(sh_compact_read(store, off, out.data()+1, n) == SH_OK);
    counting = false;
    const double us = std::chrono::duration<double,std::micro>(std::chrono::steady_clock::now()-start).count()/iterations;
    assert(!std::memcmp(out.data()+1, w.data()+off, n));
    assert(out.front()==0xa5 && out.back()==0xa5);
    printf("{\"K\":%zu,\"N\":%zu,\"partial\":%d,\"bits\":%d,\"iterations\":%d,\"allocations\":%zu,\"allocated_bytes\":%zu,\"largest_allocation_bytes\":%zu,\"us_per_read\":%.3f}\n",K,N,int(partial),bits,iterations,calls,bytes,largest,us);
    sh_compact_free(store);
}
