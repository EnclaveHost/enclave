/* Default-off pad-receiver progress diagnostic. No file names, keys or bytes
 * from the shipment are recorded. One writer publishes its current operation;
 * a low-frequency observer can report a syscall that has not yet returned. */
#ifndef ANCHOR_RX_PROFILE_H
#define ANCHOR_RX_PROFILE_H
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <errno.h>
#ifndef ANCHOR_RX_PROFILE_INTERVAL_MS
#define ANCHOR_RX_PROFILE_INTERVAL_MS 1000
#endif
enum anchor_rx_stage { ARX_ACK, ARX_OPEN, ARX_READ, ARX_WRITE, ARX_HASH, ARX_FSYNC, ARX_PUBLISH, ARX_DONE };
typedef void (*anchor_rx_profile_sink)(void *, const char *);
typedef struct {
    pthread_t thread;
    pthread_mutex_t mutex;
    pthread_cond_t cond;
    int made, stop;
    unsigned seq, stage;
    uint64_t step_us, got, expected;
    anchor_rx_profile_sink sink;
    void *sink_ctx;
} anchor_rx_profile;
static uint64_t anchor_rx_profile_now(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000000 + (uint64_t)t.tv_nsec / 1000;
}
static void anchor_rx_profile_mark(anchor_rx_profile *p, unsigned stage, uint64_t got) {
    if (!p->made) return;
    __atomic_fetch_add(&p->seq, 1u, __ATOMIC_ACQ_REL);
    __atomic_store_n(&p->stage, stage, __ATOMIC_RELAXED);
    __atomic_store_n(&p->got, got, __ATOMIC_RELAXED);
    __atomic_store_n(&p->step_us, anchor_rx_profile_now(), __ATOMIC_RELAXED);
    __atomic_fetch_add(&p->seq, 1u, __ATOMIC_RELEASE);
}
static void anchor_rx_profile_emit(anchor_rx_profile *p) {
    static const char *names[] = {"ack_ready", "open_file", "read_stream", "write_file", "hash", "fsync", "judge_publish", "done"};
    for (int attempt = 0; attempt < 4; ++attempt) {
        const unsigned a = __atomic_load_n(&p->seq, __ATOMIC_ACQUIRE);
        if (a & 1u) continue;
        const unsigned stage = __atomic_load_n(&p->stage, __ATOMIC_RELAXED);
        const uint64_t got = __atomic_load_n(&p->got, __ATOMIC_RELAXED);
        const uint64_t since = __atomic_load_n(&p->step_us, __ATOMIC_RELAXED);
        __atomic_thread_fence(__ATOMIC_ACQUIRE);
        if (a != __atomic_load_n(&p->seq, __ATOMIC_ACQUIRE)) continue;
        const uint64_t now = anchor_rx_profile_now();
        char line[240];
        snprintf(line, sizeof line, "PAD_RX progress mono_us=%llu stage=%s stage_age_us=%llu written=%llu expected=%llu",
            (unsigned long long)now, stage < 8 ? names[stage] : "invalid",
            (unsigned long long)(now >= since ? now-since : 0),
            (unsigned long long)got, (unsigned long long)p->expected);
        p->sink(p->sink_ctx, line);
        return;
    }
}
static void *anchor_rx_profile_watch(void *arg) {
    anchor_rx_profile *p = (anchor_rx_profile *)arg;
    pthread_mutex_lock(&p->mutex);
    while (!p->stop) {
        struct timespec until; clock_gettime(CLOCK_REALTIME, &until);
        until.tv_nsec += (long)ANCHOR_RX_PROFILE_INTERVAL_MS * 1000000L;
        until.tv_sec += until.tv_nsec / 1000000000L; until.tv_nsec %= 1000000000L;
        int rc = 0;
        while (!p->stop && rc == 0) rc = pthread_cond_timedwait(&p->cond, &p->mutex, &until);
        if (p->stop) break;
        if (rc != ETIMEDOUT) break;
        pthread_mutex_unlock(&p->mutex);
        anchor_rx_profile_emit(p);
        pthread_mutex_lock(&p->mutex);
    }
    pthread_mutex_unlock(&p->mutex);
    return NULL;
}
static int anchor_rx_profile_start(anchor_rx_profile *p, uint64_t expected, anchor_rx_profile_sink sink, void *ctx) {
    memset(p, 0, sizeof *p); p->expected=expected; p->sink=sink; p->sink_ctx=ctx;
    p->stage=ARX_ACK; p->step_us=anchor_rx_profile_now();
    if (pthread_mutex_init(&p->mutex, NULL)) return -1;
    if (pthread_cond_init(&p->cond, NULL)) { pthread_mutex_destroy(&p->mutex); return -1; }
    if (pthread_create(&p->thread, NULL, anchor_rx_profile_watch, p)) {
        pthread_cond_destroy(&p->cond); pthread_mutex_destroy(&p->mutex); return -1;
    }
    p->made=1; return 0;
}
static void anchor_rx_profile_stop(anchor_rx_profile *p) {
    if (!p->made) return;
    pthread_mutex_lock(&p->mutex); p->stop=1; pthread_cond_broadcast(&p->cond); pthread_mutex_unlock(&p->mutex);
    pthread_join(p->thread, NULL); p->made=0;
    pthread_cond_destroy(&p->cond); pthread_mutex_destroy(&p->mutex);
}
#endif
