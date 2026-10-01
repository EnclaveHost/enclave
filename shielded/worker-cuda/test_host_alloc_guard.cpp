// Linux/CUDA integration-test interposer; never load into a production worker.
// Guard the requested pinned allocation size, including sub-page tails that a
// driver allocation would otherwise hide. Trace requested bytes, not the guard.
#include <dlfcn.h>
#include <pthread.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstddef>

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
struct Slot { unsigned char *p; size_t n; unsigned flags; };
static Slot slots[256];
static constexpr size_t tail = 64;

static void check(const Slot &s) {
    for (size_t i = 0; i < tail; ++i) if (s.p[s.n + i] != 0xa5) {
        std::fprintf(stderr, "pinned allocation overrun: %zu bytes, flags %u, tail %zu\n", s.n, s.flags, i);
        std::abort();
    }
}
static void record(const Slot &s) {
    const char *path = std::getenv("SH_HOST_ALLOC_TRACE");
    FILE *f = path ? std::fopen(path, "a") : nullptr;
    if (!f) std::abort();
    std::fprintf(f, "%zu %u\n", s.n, s.flags);
    std::fclose(f);
}
extern "C" int cudaHostAlloc(void **p, size_t n, unsigned flags) {
    static auto real = reinterpret_cast<int (*)(void **, size_t, unsigned)>(dlsym(RTLD_NEXT, "cudaHostAlloc"));
    if (!real || n > size_t(-1) - tail) std::abort();
    int rc = real(p, n + tail, flags);
    if (rc) return rc;
    pthread_mutex_lock(&mu);
    for (auto &s : slots) if (!s.p) {
        s = {static_cast<unsigned char *>(*p), n, flags};
        std::memset(s.p + n, 0xa5, tail);
        record(s);
        pthread_mutex_unlock(&mu);
        return rc;
    }
    std::abort();
}
extern "C" int cudaFreeHost(void *p) {
    static auto real = reinterpret_cast<int (*)(void *)>(dlsym(RTLD_NEXT, "cudaFreeHost"));
    if (!real) std::abort();
    pthread_mutex_lock(&mu);
    for (auto &s : slots) if (s.p && s.p == p) { check(s); s = {}; break; }
    pthread_mutex_unlock(&mu);
    return real(p);
}
extern "C" int cudaStreamSynchronize(void *stream) {
    static auto real = reinterpret_cast<int (*)(void *)>(dlsym(RTLD_NEXT, "cudaStreamSynchronize"));
    if (!real) std::abort();
    int rc = real(stream);
    if (!rc) {
        pthread_mutex_lock(&mu);
        for (const auto &s : slots) if (s.p) check(s);
        pthread_mutex_unlock(&mu);
    }
    return rc;
}
