/* Diagnostic source spans. No payload data. Default off; append-only bounded
 * storage, no file IO on the measured path. Wall minus thread CPU includes ALL
 * off-CPU time; it cannot by itself distinguish scheduler delay from IO wait. */
#ifndef SHIELDED_SOURCE_PROFILE_H
#define SHIELDED_SOURCE_PROFILE_H
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <pthread.h>
#include <unistd.h>
#include <sys/syscall.h>
typedef struct { uint64_t wall, cpu; } sh_sp_stamp;
typedef struct {
    sh_sp_stamp start, end;
    uint64_t a, b;
    unsigned tid, line, ready;
    const char *tag;
} sh_sp_row;
#define SH_SP_CAP 65536u
static sh_sp_row sh_sp_rows[SH_SP_CAP];
static unsigned sh_sp_count, sh_sp_dumped;
static int sh_sp_on;
static pthread_once_t sh_sp_once = PTHREAD_ONCE_INIT;
static void sh_sp_init(void) {
    const char *e = getenv("SHIELDED_SOURCE_PROFILE");
    sh_sp_on = e && !strcmp(e, "1");
#ifdef SH_SP_LOCAL_ENABLE_ENV
    /* A translation unit can expose a narrower diagnostic independently. */
    e = getenv(SH_SP_LOCAL_ENABLE_ENV);
    sh_sp_on |= e && !strcmp(e, "1");
#endif
}
static int sh_sp_enabled(void) { pthread_once(&sh_sp_once, sh_sp_init); return sh_sp_on; }
static uint64_t sh_sp_ns(clockid_t c) { struct timespec t = {0}; clock_gettime(c, &t); return (uint64_t)t.tv_sec * 1000000000 + t.tv_nsec; }
static sh_sp_stamp sh_sp_now(void) {
    sh_sp_stamp s = {0, 0};
    if (sh_sp_enabled()) { s.wall = sh_sp_ns(CLOCK_MONOTONIC); s.cpu = sh_sp_ns(CLOCK_THREAD_CPUTIME_ID); }
    return s;
}
static void sh_sp_end(sh_sp_stamp start, const char *tag, unsigned line, uint64_t a, uint64_t b) {
    if (!start.wall) return;
    sh_sp_stamp end = sh_sp_now();
    unsigned n = __atomic_fetch_add(&sh_sp_count, 1u, __ATOMIC_RELAXED);
    if (n >= SH_SP_CAP) return;
    sh_sp_row *r = &sh_sp_rows[n]; r->start = start; r->end = end;
    r->tag = tag; r->line = line; r->a = a; r->b = b; r->tid = (unsigned)syscall(SYS_gettid);
    __atomic_store_n(&r->ready, 1u, __ATOMIC_RELEASE);
}
#define SH_SP_END(start, tag, a, b) sh_sp_end(start, tag, __LINE__, (uint64_t)(a), (uint64_t)(b))
/* Called only by the existing serial benchmark snapshot path. Producers can
 * continue appending: never read an unpublished row or overwrite a live row. */
static void sh_sp_dump(const char *unit) {
    if (!sh_sp_enabled()) return;
    unsigned n = __atomic_load_n(&sh_sp_count, __ATOMIC_ACQUIRE), cap = n < SH_SP_CAP ? n : SH_SP_CAP;
    while (sh_sp_dumped < cap) {
        const sh_sp_row *r = &sh_sp_rows[sh_sp_dumped];
        if (!__atomic_load_n(&r->ready, __ATOMIC_ACQUIRE)) break;
        fprintf(stderr, "SP %s %s %u %u %llu %llu %llu %llu %llu\n", unit, r->tag, r->line, r->tid,
            (unsigned long long)r->start.wall, (unsigned long long)(r->end.wall-r->start.wall),
            (unsigned long long)(r->end.cpu-r->start.cpu), (unsigned long long)r->a, (unsigned long long)r->b);
        ++sh_sp_dumped;
    }
    fprintf(stderr, "SP_COUNT %s recorded=%u dumped=%u dropped=%u\n", unit, cap, sh_sp_dumped, n-cap);
}
#endif
