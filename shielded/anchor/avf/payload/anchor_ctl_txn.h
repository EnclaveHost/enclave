/* Control-channel transactions for the opt-in quiet-pads handshake.
 *
 * WHY. The control socket already has more than one reader inside the pVM and
 * the read path has no lock. engine.cpp's ctl_read_line is static with exactly
 * one caller, pads_window, which is the window provider installed as a PROCESS
 * GLOBAL on every link the backend opens, so per-link pool_mu cannot serialise
 * it: two refill workers on two links can be inside it at once in the build as
 * it stands. dealt_open's reserve reaches it with no pool_mu held at all. The
 * unit of mutual exclusion therefore has to be process-global and cover the
 * WHOLE transaction - request line plus its reply - not a byte-read.
 *
 * MUTEX LIFETIME. The mutex is NOT owned by this struct and is never initialised
 * here: the backend pool, and any refill thread in it, outlives engine_main, so a
 * thread from an earlier entry can still reach pads_window. Re-initialising a
 * live mutex is undefined, so the caller passes one with static storage and
 * PTHREAD_MUTEX_INITIALIZER, created once for the process.
 *
 * ONE DEADLINE, COVERING THE WRITE TOO. Each transaction computes a single
 * absolute CLOCK_MONOTONIC deadline before it acquires anything, and acquisition,
 * the request write and every poll/read are bounded by that same deadline, never
 * restarted. The write matters as much as the read: the payload's ordinary writer
 * holds its output lock across a BLOCKING write, so a full control buffer would
 * pin the lock and block every later line, the resume included. This helper
 * therefore writes through a caller-supplied BOUNDED writer and treats its
 * absence as a reason to refuse rather than to fall back.
 *
 * A PARTIAL WRITE POISONS THE CHANNEL. If a request goes out in part, the peer
 * will parse a fragment and the next transaction would read a reply to something
 * that was never asked. That is reported as its own terminal status; the caller
 * must fail the run rather than continue.
 *
 * DEFAULT OFF AND INERT. With `enabled` zero every entry point returns DISABLED
 * without taking a lock, writing a byte or reading one, so an ordinary run keeps
 * exactly today's behaviour and today's PADWIN timeouts.
 *
 * TRUST. Nothing here signs, verifies, reserves or touches an epoch, a pad, a
 * ledger window or a receipt. It gates when the OWNER APP may push already
 * encrypted shipments over the pads port; refusing or failing it changes only
 * timing, and the engine's existing strict checks still decide every pad.
 */
#ifndef ANCHOR_CTL_TXN_H
#define ANCHOR_CTL_TXN_H

#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>

#define ANCHOR_CTL_TXN_OK        0
#define ANCHOR_CTL_TXN_DISABLED  1   /* opt-in off: nothing locked, written or read */
#define ANCHOR_CTL_TXN_BUSY      2   /* the transaction lock was not acquired in budget */
#define ANCHOR_CTL_TXN_TIMEOUT   3   /* no reply inside the single deadline */
#define ANCHOR_CTL_TXN_REFUSED   4   /* the peer answered "refused" */
#define ANCHOR_CTL_TXN_PROTOCOL  5   /* malformed, non-canonical, wrong trial, oversize, budget spent */
#define ANCHOR_CTL_TXN_IO        6   /* EOF, poll, recv, or the monotonic clock failed */
#define ANCHOR_CTL_TXN_PADWIN    7   /* a PADWIN reply appeared: exclusion is broken; not consumed as ours */
#define ANCHOR_CTL_TXN_POISONED  8   /* a request was written in part: the channel is unusable, fail the run */
#define ANCHOR_CTL_TXN_NOWRITER  9   /* no bounded writer was supplied: refuse, never fall back to a blocking one */

#define ANCHOR_CTL_TXN_TAG        "QUIETPADS v1 "
#define ANCHOR_CTL_TXN_LINE_MAX   512
#define ANCHOR_CTL_TXN_REASON_MAX 64

/* A bounded writer. 0 = the whole line went out; -1 = NOTHING was written (busy
 * or out of time), which is recoverable; -2 = a PARTIAL write, which is not.
 * It must serialise against the payload's other control writers, and must not
 * block past `deadline_ns` (an absolute CLOCK_MONOTONIC value). */
typedef int (*anchor_ctl_txn_write_fn)(void *ctx, const char *line, size_t len, uint64_t deadline_ns);

typedef struct {
    int      fd;                 /* the control socket; recv() requires a socket */
    int      enabled;            /* 0 = every entry point is a no-op */
    pthread_mutex_t *mu;         /* NOT owned, NOT initialised here: static, process-lifetime */
    anchor_ctl_txn_write_fn write;
    void    *write_ctx;
    void   (*log)(void *ctx, const char *msg);
    void    *log_ctx;
    uint64_t acquire_ns;         /* the slice of the deadline acquisition may use */
    uint64_t total_ns;           /* the WHOLE transaction: acquire + write + read */
    unsigned skip_budget;        /* unrelated lines tolerated before giving up */
} anchor_ctl_txn;

/* False when CLOCK_MONOTONIC failed. A zero clock would make every deadline
 * comparison meaningless and a wait unbounded, so callers refuse instead. */
static int anchor_ctl_txn_now(uint64_t *out) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) { *out = 0; return 0; }
    *out = (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
    return 1;
}

static void anchor_ctl_txn_init(anchor_ctl_txn *t, int fd, int enabled, pthread_mutex_t *mu,
                                anchor_ctl_txn_write_fn write, void *write_ctx,
                                void (*log)(void *, const char *), void *log_ctx,
                                uint64_t acquire_ns, uint64_t total_ns, unsigned skip_budget) {
    memset(t, 0, sizeof *t);
    t->fd = fd; t->enabled = enabled ? 1 : 0; t->mu = mu;
    t->write = write; t->write_ctx = write_ctx; t->log = log; t->log_ctx = log_ctx;
    t->acquire_ns = acquire_ns; t->total_ns = total_ns;
    t->skip_budget = skip_budget ? skip_budget : 32u;
}

static void anchor_ctl_txn_say(const anchor_ctl_txn *t, const char *msg) {
    if (t->log) t->log(t->log_ctx, msg);
}

/* Trylock to an absolute monotonic deadline. pthread_mutex_timedlock is
 * CLOCK_REALTIME, which a clock step could stretch, and the clocklock variant is
 * not available everywhere this builds, so the wait is a bounded trylock loop on
 * the same clock every other budget here uses. */
static int anchor_ctl_txn_begin_until(anchor_ctl_txn *t, uint64_t deadline) {
    if (!t->enabled) return ANCHOR_CTL_TXN_DISABLED;
    for (;;) {
        if (pthread_mutex_trylock(t->mu) == 0) {
            /* Acquired, but possibly at or past the deadline: re-check BEFORE any
             * socket I/O, so a transaction that has already run out of time never
             * writes a request it could not wait for. */
            uint64_t got;
            if (!anchor_ctl_txn_now(&got)) { pthread_mutex_unlock(t->mu); return ANCHOR_CTL_TXN_IO; }
            if (got >= deadline) { pthread_mutex_unlock(t->mu); return ANCHOR_CTL_TXN_BUSY; }
            return ANCHOR_CTL_TXN_OK;
        }
        uint64_t now;
        if (!anchor_ctl_txn_now(&now)) return ANCHOR_CTL_TXN_IO;
        if (now >= deadline) return ANCHOR_CTL_TXN_BUSY;
        struct timespec nap = { 0, 200000 };   /* 0.2 ms */
        nanosleep(&nap, NULL);
    }
}
static void anchor_ctl_txn_end(anchor_ctl_txn *t) {
    if (t->enabled) pthread_mutex_unlock(t->mu);
}

/* One line, or a bounded failure. Never blocks after poll says readable, and
 * re-checks the absolute deadline every iteration so a dribble of partial writes
 * cannot extend it. */
static int anchor_ctl_txn_read_line(const anchor_ctl_txn *t, char *buf, size_t cap, uint64_t deadline) {
    size_t n = 0;
    for (;;) {
        if (n + 1 >= cap) return ANCHOR_CTL_TXN_PROTOCOL;          /* oversize: refuse, never truncate into a reply */
        uint64_t now;
        if (!anchor_ctl_txn_now(&now)) return ANCHOR_CTL_TXN_IO;
        if (now >= deadline) return ANCHOR_CTL_TXN_TIMEOUT;
        uint64_t left_ms = (deadline - now) / 1000000ull;
        if (left_ms > 250) left_ms = 250;
        struct pollfd p; p.fd = t->fd; p.events = POLLIN; p.revents = 0;
        const int pr = poll(&p, 1, (int)left_ms);
        if (pr < 0) { if (errno == EINTR) continue; return ANCHOR_CTL_TXN_IO; }
        if (pr == 0) continue;
        /* Readable, but the deadline may have passed while poll returned: check
         * BEFORE the read rather than after it. */
        uint64_t ready;
        if (!anchor_ctl_txn_now(&ready)) return ANCHOR_CTL_TXN_IO;
        if (ready >= deadline) return ANCHOR_CTL_TXN_TIMEOUT;
        char c;
        const ssize_t r = recv(t->fd, &c, 1, MSG_DONTWAIT);
        if (r < 0) {
            if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue;
            return ANCHOR_CTL_TXN_IO;
        }
        if (r == 0) return ANCHOR_CTL_TXN_IO;                      /* EOF */
        if (c == 0) return ANCHOR_CTL_TXN_PROTOCOL;   /* an embedded NUL would truncate every
                                                      * later strncmp, so a line could carry a
                                                      * valid-looking prefix and hidden bytes */
        if (c == '\n') {
            buf[n] = 0;
            /* A line that only completed after the deadline is LATE, not a
             * success: accepting it would let a stale acknowledgement be claimed
             * as this transaction's. */
            uint64_t done;
            if (!anchor_ctl_txn_now(&done)) return ANCHOR_CTL_TXN_IO;
            if (done >= deadline) return ANCHOR_CTL_TXN_TIMEOUT;
            return ANCHOR_CTL_TXN_OK;
        }
        buf[n++] = c;
    }
}

/* Read until one of OUR lines arrives. Unrelated lines are skipped under the
 * budget; a PADWIN reply is its own failure and is never treated as ours. */
static int anchor_ctl_txn_await(const anchor_ctl_txn *t, char *buf, size_t cap, uint64_t deadline) {
    for (unsigned skipped = 0; ; ) {
        const int rc = anchor_ctl_txn_read_line(t, buf, cap, deadline);
        if (rc != ANCHOR_CTL_TXN_OK) return rc;
        if (!strncmp(buf, "PADWIN ", 7)) {
            anchor_ctl_txn_say(t, "a PADWIN reply arrived inside a quiet transaction; control-channel "
                                  "exclusion is broken and this reply is NOT consumed as an ack");
            return ANCHOR_CTL_TXN_PADWIN;
        }
        if (!strncmp(buf, ANCHOR_CTL_TXN_TAG, sizeof ANCHOR_CTL_TXN_TAG - 1)) return ANCHOR_CTL_TXN_OK;
        if (++skipped > t->skip_budget) return ANCHOR_CTL_TXN_PROTOCOL;
    }
}

/* Exactly "QUIETPADS v1 <verb> <id>" with a CANONICAL id - no leading zero
 * unless the id is the single digit 0 - and then either end of line, or a single
 * space and a non-empty tail when (and only when) a tail is allowed. */
static int anchor_ctl_txn_match(const char *line, const char *verb, unsigned long long id,
                                int tail_allowed, const char **tail) {
    const size_t tag = sizeof ANCHOR_CTL_TXN_TAG - 1;
    if (strncmp(line, ANCHOR_CTL_TXN_TAG, tag)) return 0;
    const char *p = line + tag;
    const size_t vl = strlen(verb);
    if (strncmp(p, verb, vl) || p[vl] != ' ') return 0;
    p += vl + 1;
    if (*p < '0' || *p > '9') return 0;
    if (p[0] == '0' && p[1] >= '0' && p[1] <= '9') return 0;        /* non-canonical: leading zero */
    unsigned long long got = 0;
    while (*p >= '0' && *p <= '9') {
        if (got > (~0ull - 9) / 10) return 0;
        got = got * 10 + (unsigned)(*p++ - '0');
    }
    if (got != id) return 0;
    if (tail_allowed) {                       /* a tail is REQUIRED and must be non-empty */
        if (*p != ' ' || p[1] == 0) return 0;
        if (tail) *tail = p + 1;
        return 1;
    }
    if (*p != 0) return 0;                    /* no tail is permitted at all */
    if (tail) *tail = p;
    return 1;
}

/* The whole transaction under one deadline: acquire, write, read. */
static int anchor_ctl_txn_exchange(anchor_ctl_txn *t, const char *request, const char *reply_verb,
                                   unsigned long long id, char *reason, size_t reason_cap) {
    if (reason && reason_cap) reason[0] = 0;
    if (!t->enabled) return ANCHOR_CTL_TXN_DISABLED;
    if (!t->write) return ANCHOR_CTL_TXN_NOWRITER;
    uint64_t start;
    if (!anchor_ctl_txn_now(&start)) return ANCHOR_CTL_TXN_IO;
    const uint64_t deadline = start + t->total_ns;
    uint64_t acq = start + t->acquire_ns;
    if (acq > deadline) acq = deadline;

    const int got = anchor_ctl_txn_begin_until(t, acq);
    if (got != ANCHOR_CTL_TXN_OK) return got;

    char line[ANCHOR_CTL_TXN_LINE_MAX + 2];
    const int n = snprintf(line, sizeof line, "%s\n", request);
    int rc;
    if (n <= 0 || (size_t)n >= sizeof line) { rc = ANCHOR_CTL_TXN_PROTOCOL; goto done; }
    {
        const int w = t->write(t->write_ctx, line, (size_t)n, deadline);
        if (w == -2) {                                    /* part of a request is on the wire */
            anchor_ctl_txn_say(t, "a request was written in part: the control channel can no longer be "
                                  "parsed and this run must fail rather than read a reply to a fragment");
            rc = ANCHOR_CTL_TXN_POISONED; goto done;
        }
        if (w != 0) { rc = ANCHOR_CTL_TXN_TIMEOUT; goto done; }   /* nothing written: recoverable */
    }
    for (;;) {
        rc = anchor_ctl_txn_await(t, line, sizeof line, deadline);
        if (rc != ANCHOR_CTL_TXN_OK) break;
        const char *tail = NULL;
        if (anchor_ctl_txn_match(line, reply_verb, id, 0, &tail)) { rc = ANCHOR_CTL_TXN_OK; break; }
        if (anchor_ctl_txn_match(line, "refused", id, 1, &tail)) {
            if (reason && reason_cap) snprintf(reason, reason_cap, "%.*s", (int)reason_cap - 1, tail ? tail : "");
            rc = ANCHOR_CTL_TXN_REFUSED; break;
        }
        rc = ANCHOR_CTL_TXN_PROTOCOL; break;   /* recognised prefix, wrong content: refuse, never skip or wait again */
    }
done:
    anchor_ctl_txn_end(t);
    return rc;
}

static int anchor_ctl_txn_pause(anchor_ctl_txn *t, unsigned long long trial, unsigned budget_ms,
                                char *reason, size_t reason_cap) {
    char req[ANCHOR_CTL_TXN_LINE_MAX];
    snprintf(req, sizeof req, ANCHOR_CTL_TXN_TAG "pause %llu %u", trial, budget_ms);
    return anchor_ctl_txn_exchange(t, req, "paused", trial, reason, reason_cap);
}

/* Best effort by design: the app's own session cleanup owns the sending state,
 * so a lost or unanswered resume must never wedge the engine, and nothing here
 * claims the pVM can restore a flag in an app that has gone away. */
static int anchor_ctl_txn_resume(anchor_ctl_txn *t, unsigned long long trial) {
    char req[ANCHOR_CTL_TXN_LINE_MAX];
    snprintf(req, sizeof req, ANCHOR_CTL_TXN_TAG "resume %llu", trial);
    return anchor_ctl_txn_exchange(t, req, "resumed", trial, NULL, 0);
}

static const char *anchor_ctl_txn_str(int rc) {
    switch (rc) {
        case ANCHOR_CTL_TXN_OK:       return "ok";
        case ANCHOR_CTL_TXN_DISABLED: return "disabled";
        case ANCHOR_CTL_TXN_BUSY:     return "busy";
        case ANCHOR_CTL_TXN_TIMEOUT:  return "timeout";
        case ANCHOR_CTL_TXN_REFUSED:  return "refused";
        case ANCHOR_CTL_TXN_PROTOCOL: return "protocol";
        case ANCHOR_CTL_TXN_IO:       return "io";
        case ANCHOR_CTL_TXN_PADWIN:   return "padwin_collision";
        case ANCHOR_CTL_TXN_POISONED: return "channel_poisoned";
        case ANCHOR_CTL_TXN_NOWRITER: return "no_bounded_writer";
        default:                      return "unknown";
    }
}

#endif
