/* anchor-striped-read: the opt-in concurrent source read (shielded/anchor/avf/payload/anchor_striped_read.h) is byte-for-byte
 * the serial read for every geometry, never writes outside the destination, and falls back serially only after joining
 * every started thread. Prints {"status","executed_checks"}. Correctness only: it measures nothing about a phone. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static int g_fail_after = -1, g_creates = 0;   /* test hook: pthread_create fails once g_creates reaches g_fail_after */
static int test_create(pthread_t *t, const pthread_attr_t *a, void *(*f)(void *), void *arg) {
    if (g_fail_after >= 0 && g_creates >= g_fail_after) return EAGAIN;
    g_creates++; return pthread_create(t, a, f, arg);
}
#define ANCHOR_STRIPED_CREATE test_create
/* pread hook: when armed, every 3rd call fails with EINTR and every other call returns at most 4097 bytes (a positive short
 * read), so the retry/continue loop is exercised on real data; counters prove the injections happened. */
static int g_inject = 0; static long g_eintr = 0, g_short = 0; static long g_calls = 0;
static ssize_t test_pread(int fd, void *buf, size_t n, off_t off) {
    if (g_inject) {
        const long c = __atomic_add_fetch(&g_calls, 1, __ATOMIC_RELAXED);
        if (c % 3 == 0) { __atomic_add_fetch(&g_eintr, 1, __ATOMIC_RELAXED); errno = EINTR; return -1; }
        if (n > 4097) { __atomic_add_fetch(&g_short, 1, __ATOMIC_RELAXED); n = 4097; }
    }
    return pread(fd, buf, n, off);
}
#define ANCHOR_STRIPED_PREAD test_pread
#include "anchor_striped_read.h"
static int checks = 0, failed = 0;
#define CHECK(c, what) do { const int _r = (c); checks++; if (!_r) { failed++; fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, what); } } while (0)
static uint64_t seed = 88172645463325252ull; static uint64_t rnd(void) { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; return seed; }
int main(void) {
    const char *td = getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp"; char path[512]; snprintf(path, sizeof path, "%s/striped-XXXXXX", td);
    int fd = mkstemp(path); CHECK(fd >= 0, "temp file");
    const uint64_t FILE_BYTES = (uint64_t)37 << 20;                       /* 37 MiB: 9.25 stripes, an odd tail */
    uint8_t *content = (uint8_t *)malloc(FILE_BYTES); CHECK(content != NULL, "content");
    for (uint64_t i = 0; i < FILE_BYTES; i += 8) { const uint64_t v = rnd(); memcpy(content + i, &v, FILE_BYTES - i < 8 ? FILE_BYTES - i : 8); }
    CHECK(pwrite(fd, content, FILE_BYTES, 0) == (ssize_t)FILE_BYTES, "write content");
    uint8_t *dst = (uint8_t *)malloc(FILE_BYTES + 64); CHECK(dst != NULL, "dst");
    /* every geometry: offsets unaligned, sizes across stripe boundaries, thread counts 2..8 and out-of-range, min_bytes on/off */
    const uint64_t offs[] = { 0, 1, 4095, ANCHOR_STRIPE_BYTES - 1, ANCHOR_STRIPE_BYTES, 12345678 };
    const uint64_t sizes[] = { 1, 4096, ANCHOR_STRIPE_BYTES, ANCHOR_STRIPE_BYTES + 1, 3 * ANCHOR_STRIPE_BYTES - 7, (uint64_t)20 << 20, (uint64_t)24 << 20 };
    const int threads[] = { 0, 1, 2, 3, 5, 8, 9, 100 };
    int geoms = 0;
    for (size_t o = 0; o < sizeof offs / sizeof *offs; o++) for (size_t s = 0; s < sizeof sizes / sizeof *sizes; s++) for (size_t t = 0; t < sizeof threads / sizeof *threads; t++) {
        const uint64_t off = offs[o], size = sizes[s]; if (off + size > FILE_BYTES) continue;
        memset(dst, 0xA5, FILE_BYTES + 64); dst[size] = 0x5A; dst[size + 63] = 0x5A;   /* canaries right after the range */
        const int rc = anchor_striped_pread(fd, off, dst, size, threads[t], 0);
        const int same = rc == 0 && memcmp(dst, content + off, size) == 0 && dst[size] == 0x5A && dst[size + 63] == 0x5A;
        if (!same) { failed++; fprintf(stderr, "FAIL geometry off=%llu size=%llu threads=%d rc=%d\n", (unsigned long long)off, (unsigned long long)size, threads[t], rc); }
        geoms++;
    }
    checks++; CHECK(geoms >= 150, "geometries executed");
    /* min_bytes: below it the read is serial (same bytes); above it striped (same bytes) */
    memset(dst, 0, FILE_BYTES); CHECK(anchor_striped_pread(fd, 0, dst, (uint64_t)20 << 20, 4, (uint64_t)32 << 20) == 0 && !memcmp(dst, content, (size_t)20 << 20), "below min_bytes: serial, same bytes");
    memset(dst, 0, FILE_BYTES); CHECK(anchor_striped_pread(fd, 0, dst, (uint64_t)20 << 20, 4, (uint64_t)16 << 20) == 0 && !memcmp(dst, content, (size_t)20 << 20), "above min_bytes: striped, same bytes");
    /* short file: a range past EOF fails (no partial success), serial and striped alike */
    CHECK(anchor_striped_pread(fd, FILE_BYTES - 100, dst, 200, 1, 0) != 0, "serial past EOF fails");
    CHECK(anchor_striped_pread(fd, FILE_BYTES - ANCHOR_STRIPE_BYTES, dst, 3 * ANCHOR_STRIPE_BYTES, 4, 0) != 0, "striped past EOF fails");
    CHECK(anchor_striped_pread(fd, FILE_BYTES + 1, dst, 1, 1, 0) != 0, "start past EOF fails");
    /* argument bounds: bad fd, NULL, zero size, offset/size overflow */
    CHECK(anchor_striped_pread(-1, 0, dst, 1, 4, 0) != 0 && errno == EINVAL, "bad fd");
    CHECK(anchor_striped_pread(fd, 0, NULL, 1, 4, 0) != 0, "NULL dst");
    CHECK(anchor_striped_pread(fd, 0, dst, 0, 4, 0) != 0, "zero size");
    CHECK(anchor_striped_pread(fd, (uint64_t)INT64_MAX, dst, 2, 4, 0) != 0, "offset+size overflow");
    /* an unseekable fd (pipe): pread fails, no bytes claimed */
    { int p[2]; CHECK(pipe(p) == 0, "pipe"); CHECK(anchor_striped_pread(p[0], 0, dst, (uint64_t)9 << 20, 4, 0) != 0, "pipe fd fails"); close(p[0]); close(p[1]); }
    /* thread creation fails after k threads: every started thread is joined, then the serial fallback delivers the bytes */
    for (int k = 0; k <= 3; k++) {
        g_fail_after = k; g_creates = 0; memset(dst, 0, FILE_BYTES);
        const int rc = anchor_striped_pread(fd, 777, dst, (uint64_t)30 << 20, 6, 0);
        CHECK(rc == 0 && !memcmp(dst, content + 777, (size_t)30 << 20) && g_creates == k, "create failure after k threads: joined, serial fallback, same bytes");
    }
    g_fail_after = -1;
    /* EINTR and positive short reads, injected on every path (striped workers and the serial read): same bytes, and the counters prove the injections */
    g_inject = 1; g_eintr = g_short = g_calls = 0; memset(dst, 0, FILE_BYTES);
    CHECK(anchor_striped_pread(fd, 4099, dst, (uint64_t)21 << 20, 4, 0) == 0 && !memcmp(dst, content + 4099, (size_t)21 << 20), "striped read under EINTR + short reads: same bytes");
    CHECK(g_eintr > 100 && g_short > 100, "injections happened on the striped path");
    g_eintr = g_short = g_calls = 0; memset(dst, 0, FILE_BYTES);
    CHECK(anchor_striped_pread(fd, 5, dst, (uint64_t)9 << 20, 1, 0) == 0 && !memcmp(dst, content + 5, (size_t)9 << 20), "serial read under EINTR + short reads: same bytes");
    CHECK(g_eintr > 100 && g_short > 100, "injections happened on the serial path");
    g_inject = 0;
    /* a worker failure mid-way (file truncated under a striped read of a range that was valid at the start): joined, then the serial fallback also fails -> -1, never a partial success */
    CHECK(ftruncate(fd, FILE_BYTES - ((uint64_t)2 << 20)) == 0, "truncate");
    CHECK(anchor_striped_pread(fd, 0, dst, FILE_BYTES, 4, 0) != 0, "truncated file: striped read fails after joins");
    close(fd); unlink(path); free(content); free(dst);
    printf("{\"status\":\"%s\",\"executed_checks\":%d}\n", failed ? "FAIL" : "PASS", checks);
    return failed ? 1 : 0;
}
