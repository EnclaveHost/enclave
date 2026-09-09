/* anchor_striped_read.h -- one bounded, opt-in way to read a large staged tensor faster: several threads pread
 * disjoint 4 MiB stripes of the SAME range into the SAME already-allocated destination, then join. Nothing else
 * changes: the bytes land where the serial pread put them, the caller authenticates them afterwards exactly as
 * before, and no thread touches memory outside [dst, dst+size). Below `min_bytes`, with fewer than 2 threads, or on
 * any failure (thread creation, a short read, a read error) the range is read serially -- only after every started
 * thread has been joined. Returns 0 when all `size` bytes are in place, -1 otherwise (errno from the last failure
 * where one exists). Header-only C so the engine (C++) and a host fixture compile the identical code. */
#ifndef ANCHOR_STRIPED_READ_H
#define ANCHOR_STRIPED_READ_H
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stddef.h>
#include <unistd.h>

#define ANCHOR_STRIPE_BYTES   ((uint64_t)4 << 20)
#define ANCHOR_STRIPED_MAX_THREADS 8

/* The fixture may replace pread to inject EINTR and positive short reads; production uses pread. */
#ifndef ANCHOR_STRIPED_PREAD
#define ANCHOR_STRIPED_PREAD pread
#endif
/* The whole range, serially: pread until done; EINTR retries; a positive short read continues; 0 bytes = short file = failure. */
static inline int anchor_read_range(int fd, uint64_t off, uint8_t *dst, uint64_t len) {
    uint64_t got = 0;
    while (got < len) {
        const size_t want = len - got > ((size_t)1 << 30) ? ((size_t)1 << 30) : (size_t)(len - got);
        const ssize_t n = ANCHOR_STRIPED_PREAD(fd, dst + got, want, (off_t)(off + got));
        if (n < 0) { if (errno == EINTR) continue; return -1; }
        if (n == 0) { errno = EIO; return -1; }
        got += (uint64_t)n;
    }
    return 0;
}

typedef struct {
    int fd; uint64_t off; uint8_t *dst; uint64_t size;
    int index, threads;               /* this worker takes stripes index, index+threads, ... (interleaved: balanced finish) */
    int rc;
} anchor_stripe_job;

static void *anchor_stripe_main(void *arg) {
    anchor_stripe_job *j = (anchor_stripe_job *)arg;
    j->rc = 0;
    for (uint64_t s = (uint64_t)j->index * ANCHOR_STRIPE_BYTES; s < j->size; s += (uint64_t)j->threads * ANCHOR_STRIPE_BYTES) {
        const uint64_t len = j->size - s < ANCHOR_STRIPE_BYTES ? j->size - s : ANCHOR_STRIPE_BYTES;
        if (anchor_read_range(j->fd, j->off + s, j->dst + s, len) != 0) { j->rc = -1; return NULL; }   /* the rest of this worker's stripes are left to the serial fallback */
    }
    return NULL;
}

/* The fixture may replace thread creation to prove the join-then-fallback path; production uses pthread_create. */
#ifndef ANCHOR_STRIPED_CREATE
#define ANCHOR_STRIPED_CREATE pthread_create
#endif

static inline int anchor_striped_pread(int fd, uint64_t off, uint8_t *dst, uint64_t size, int threads, uint64_t min_bytes) {
    if (fd < 0 || !dst || size == 0 || off > (uint64_t)INT64_MAX || size > (uint64_t)INT64_MAX - off) { errno = EINVAL; return -1; }
    if (threads > ANCHOR_STRIPED_MAX_THREADS) threads = ANCHOR_STRIPED_MAX_THREADS;
    if (threads < 2 || size < min_bytes || size <= ANCHOR_STRIPE_BYTES) return anchor_read_range(fd, off, dst, size);
    {   /* never more workers than stripes */
        const uint64_t stripes = (size + ANCHOR_STRIPE_BYTES - 1) / ANCHOR_STRIPE_BYTES;
        if ((uint64_t)threads > stripes) threads = (int)stripes;
    }
    anchor_stripe_job jobs[ANCHOR_STRIPED_MAX_THREADS]; pthread_t th[ANCHOR_STRIPED_MAX_THREADS];
    int started = 0, ok = 1;
    for (int t = 0; t < threads; t++) {
        jobs[t].fd = fd; jobs[t].off = off; jobs[t].dst = dst; jobs[t].size = size; jobs[t].index = t; jobs[t].threads = threads; jobs[t].rc = -1;
        if (ANCHOR_STRIPED_CREATE(&th[t], NULL, anchor_stripe_main, &jobs[t]) != 0) { ok = 0; break; }
        started++;
    }
    for (int t = 0; t < started; t++) { pthread_join(th[t], NULL); if (jobs[t].rc != 0) ok = 0; }   /* EVERY started thread is joined before any decision */
    if (ok) return 0;
    return anchor_read_range(fd, off, dst, size);                        /* serial fallback over the whole range, after the joins */
}
#endif
