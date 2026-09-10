/* The quiet-pads control transaction, over a real socketpair.
 *
 * Includes the CANDIDATE anchor_ctl_txn.h, so every assertion runs the actual
 * helper, and the channel is a real SOCK_STREAM pair so poll, MSG_DONTWAIT,
 * partial writes and EOF behave as they do on the vsock.
 *
 * The cases that matter most are the concurrency ones: two engine threads in the
 * two transaction kinds at once is the shape that splits lines today, because the
 * window provider is a process global installed on every link, per-link pool_mu
 * cannot serialise it, and dealt_open's reserve holds no pool_mu at all.
 *
 * No engine, no pVM, no pad, no ledger, no device: two descriptors and a thread
 * pretending to be the owner app.
 */
#include "anchor_ctl_txn.h"

#include <assert.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static int failures = 0;
static void expect(const char *what, int got, int want) {
    if (got != want) { failures++; fprintf(stderr, "FAIL %s: %s, want %s\n", what,
                                           anchor_ctl_txn_str(got), anchor_ctl_txn_str(want)); }
    else printf("ok   %s\n", what);
}
static void expect_true(const char *what, int cond) {
    if (!cond) { failures++; fprintf(stderr, "FAIL %s\n", what); } else printf("ok   %s\n", what);
}

/* Process-lifetime mutex, exactly as the engine holds one: created once by the
 * static initialiser and NEVER re-initialised, because the backend pool and its
 * refill threads outlive engine_main. */
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;

/* ---- writers ---------------------------------------------------------------- */
struct side { int fd; int mode; };      /* mode 0 = write it, 1 = stall (write nothing), 2 = partial */
static int wr(void *ctx, const char *line, size_t len, uint64_t deadline_ns) {
    struct side *s = (struct side *)ctx;
    (void)deadline_ns;
    if (s->mode == 1) return -1;                       /* nothing written: recoverable */
    if (s->mode == 2) {                                /* a fragment reaches the peer */
        const size_t half = len / 2 ? len / 2 : 1;
        (void)!write(s->fd, line, half);
        return -2;
    }
    const ssize_t w = write(s->fd, line, len);
    return w == (ssize_t)len ? 0 : (w > 0 ? -2 : -1);
}
static void nolog(void *ctx, const char *msg) { (void)ctx; (void)msg; }

/* ---- the fake owner app ------------------------------------------------------ */
struct app {
    int fd; int answer; int rounds; const char *force; int padwin_instead; unsigned delay_ms;
};
static int app_read_line(int fd, char *buf, size_t cap) {
    size_t n = 0;
    while (n + 1 < cap) {
        char c; const ssize_t r = read(fd, &c, 1);
        if (r <= 0) return -1;
        if (c == '\n') { buf[n] = 0; return (int)n; }
        buf[n++] = c;
    }
    return -1;
}
static void *app_thread(void *arg) {
    struct app *a = (struct app *)arg;
    char line[ANCHOR_CTL_TXN_LINE_MAX];
    for (int i = 0; a->rounds < 0 || i < a->rounds; i++) {
        if (app_read_line(a->fd, line, sizeof line) < 0) return NULL;
        if (!a->answer) continue;
        if (a->delay_ms) { struct timespec d = { a->delay_ms / 1000, (long)(a->delay_ms % 1000) * 1000000L }; nanosleep(&d, NULL); }
        char out[ANCHOR_CTL_TXN_LINE_MAX + 2];
        if (a->force) snprintf(out, sizeof out, "%s\n", a->force);
        else if (a->padwin_instead && !strncmp(line, ANCHOR_CTL_TXN_TAG "pause ", 19))
            snprintf(out, sizeof out, "PADWIN 0 64 1 deadbeef\n");
        else if (!strncmp(line, "PADWIN ", 7)) snprintf(out, sizeof out, "PADWIN 0 64 1 deadbeef\n");
        else {
            unsigned long long t = 0; unsigned ms = 0;
            if (sscanf(line, ANCHOR_CTL_TXN_TAG "pause %llu %u", &t, &ms) == 2)
                snprintf(out, sizeof out, ANCHOR_CTL_TXN_TAG "paused %llu\n", t);
            else if (sscanf(line, ANCHOR_CTL_TXN_TAG "resume %llu", &t) == 1)
                snprintf(out, sizeof out, ANCHOR_CTL_TXN_TAG "resumed %llu\n", t);
            else snprintf(out, sizeof out, ANCHOR_CTL_TXN_TAG "refused 0 unparsed\n");
        }
        const size_t n = strlen(out);
        if (write(a->fd, out, n) != (ssize_t)n) return NULL;
    }
    return NULL;
}

/* A stand-in for pads_window under its wrapper: same transaction, own request and
 * own reply, bounded exactly as the opt-in path is. */
static int fake_padwin(anchor_ctl_txn *t) {
    uint64_t start;
    if (!anchor_ctl_txn_now(&start)) return ANCHOR_CTL_TXN_IO;
    const uint64_t deadline = start + t->total_ns;
    uint64_t acq = start + t->acquire_ns; if (acq > deadline) acq = deadline;
    const int got = anchor_ctl_txn_begin_until(t, acq);
    if (got != ANCHOR_CTL_TXN_OK) return got;
    char line[ANCHOR_CTL_TXN_LINE_MAX];
    int rc = t->write(t->write_ctx, "PADWIN 64 nonce sig\n", 20, deadline) == 0
                 ? ANCHOR_CTL_TXN_OK : ANCHOR_CTL_TXN_TIMEOUT;
    if (rc == ANCHOR_CTL_TXN_OK) {
        rc = anchor_ctl_txn_read_line(t, line, sizeof line, deadline);
        if (rc == ANCHOR_CTL_TXN_OK && !strncmp(line, ANCHOR_CTL_TXN_TAG, sizeof ANCHOR_CTL_TXN_TAG - 1))
            rc = ANCHOR_CTL_TXN_PROTOCOL;                 /* recognised, not ours: refuse, never skip */
        else if (rc == ANCHOR_CTL_TXN_OK && strncmp(line, "PADWIN ", 7)) rc = ANCHOR_CTL_TXN_PROTOCOL;
    }
    anchor_ctl_txn_end(t);
    return rc;
}

struct racer { anchor_ctl_txn *t; int rounds; int bad; unsigned base; };
static void *race_pause(void *arg) {
    struct racer *r = (struct racer *)arg;
    for (int i = 0; i < r->rounds; i++) {
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        if (anchor_ctl_txn_pause(r->t, r->base + (unsigned)i, 1000, why, sizeof why) != ANCHOR_CTL_TXN_OK) r->bad++;
    }
    return NULL;
}
static void *race_padwin(void *arg) {
    struct racer *r = (struct racer *)arg;
    for (int i = 0; i < r->rounds; i++) if (fake_padwin(r->t) != ANCHOR_CTL_TXN_OK) r->bad++;
    return NULL;
}

static void mk(anchor_ctl_txn *t, struct side *s, int fd, int enabled, uint64_t acquire_ms, uint64_t total_ms) {
    s->fd = fd; s->mode = 0;
    anchor_ctl_txn_init(t, fd, enabled, &g_mu, wr, s, nolog, NULL,
                        acquire_ms * 1000000ull, total_ms * 1000000ull, 4u);
}
static void pair(int *engine, int *app) {
    int sv[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0);
    *engine = sv[0]; *app = sv[1];
}

int main(void) {
    signal(SIGPIPE, SIG_IGN);

    /* Default OFF: no lock, no byte written, no byte read. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 0, 100, 200);
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        expect("default off pause", anchor_ctl_txn_pause(&t, 1, 2000, why, sizeof why), ANCHOR_CTL_TXN_DISABLED);
        expect("default off resume", anchor_ctl_txn_resume(&t, 1), ANCHOR_CTL_TXN_DISABLED);
        expect("default off begin", anchor_ctl_txn_begin_until(&t, 0), ANCHOR_CTL_TXN_DISABLED);
        struct pollfd p; p.fd = a; p.events = POLLIN; p.revents = 0;
        expect_true("default off wrote nothing at all", poll(&p, 1, 50) == 0);
        close(e); close(a);
    }

    /* No bounded writer: refuse, never fall back to a blocking one. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 100, 200);
        t.write = NULL;
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        expect("no bounded writer", anchor_ctl_txn_pause(&t, 1, 2000, why, sizeof why), ANCHOR_CTL_TXN_NOWRITER);
        close(e); close(a);
    }

    /* Ordinary path. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 1000, 3000);
        struct app ap = { a, 1, 2, NULL, 0, 0 }; pthread_t th;
        assert(pthread_create(&th, NULL, app_thread, &ap) == 0);
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        expect("pause acknowledged", anchor_ctl_txn_pause(&t, 7, 2000, why, sizeof why), ANCHOR_CTL_TXN_OK);
        expect("resume acknowledged", anchor_ctl_txn_resume(&t, 7), ANCHOR_CTL_TXN_OK);
        pthread_join(th, NULL); close(e); close(a);
    }

    /* A stalled writer that writes NOTHING is recoverable. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 100, 300);
        s.mode = 1;
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        expect("stalled writer", anchor_ctl_txn_pause(&t, 1, 2000, why, sizeof why), ANCHOR_CTL_TXN_TIMEOUT);
        struct pollfd p; p.fd = a; p.events = POLLIN; p.revents = 0;
        expect_true("stalled writer put nothing on the wire", poll(&p, 1, 50) == 0);
        close(e); close(a);
    }

    /* A PARTIAL request poisons the channel: its own terminal status. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 100, 300);
        s.mode = 2;
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        expect("partial request poisons the channel", anchor_ctl_txn_pause(&t, 1, 2000, why, sizeof why),
               ANCHOR_CTL_TXN_POISONED);
        close(e); close(a);
    }

    /* No answer: bounded timeout, and the transaction is released afterwards. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 100, 400);
        struct app ap = { a, 0, 1, NULL, 0, 0 }; pthread_t th;
        assert(pthread_create(&th, NULL, app_thread, &ap) == 0);
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        uint64_t t0; assert(anchor_ctl_txn_now(&t0));
        expect("missing ack times out", anchor_ctl_txn_pause(&t, 1, 1000, why, sizeof why), ANCHOR_CTL_TXN_TIMEOUT);
        uint64_t t1; assert(anchor_ctl_txn_now(&t1));
        expect_true("timeout respected its absolute deadline", t1 - t0 >= 300000000ull && t1 - t0 < 4000000000ull);
        expect_true("the transaction was released", pthread_mutex_trylock(&g_mu) == 0);
        pthread_mutex_unlock(&g_mu);
        pthread_join(th, NULL); close(e); close(a);
    }

    /* A LATE ack, arriving after its transaction timed out, must not be taken by
     * the NEXT transaction: every reply names the trial that asked. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 100, 400);
        struct app ap = { a, 1, 1, NULL, 0, 700 }; pthread_t th;   /* answers trial 1, far too late */
        assert(pthread_create(&th, NULL, app_thread, &ap) == 0);
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        expect("first transaction times out", anchor_ctl_txn_pause(&t, 1, 1000, why, sizeof why), ANCHOR_CTL_TXN_TIMEOUT);
        pthread_join(th, NULL);                                    /* the late "paused 1" is now queued */
        const int rc = anchor_ctl_txn_pause(&t, 2, 1000, why, sizeof why);
        expect_true("a late ack is never consumed as the next trial's",
                    rc != ANCHOR_CTL_TXN_OK);
        expect("late ack is a bounded protocol failure", rc, ANCHOR_CTL_TXN_PROTOCOL);
        close(e); close(a);
    }

    /* NO LATE ACK CLAIM. A complete, correct reply already sitting in the socket
     * must still NOT be reported as success when the transaction has no time
     * left. The budget is zero here, so the deadline has passed by the time the
     * clock is checked after the trylock - deterministic, unlike trying to make
     * the deadline expire between poll and the final byte, which is racy from
     * outside and is covered by reading instead. The assertion is the property,
     * never OK, rather than which of the three checks caught it. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 0, 0);
        const char *ready = ANCHOR_CTL_TXN_TAG "paused 1\n";
        assert(write(a, ready, strlen(ready)) == (ssize_t)strlen(ready));
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        const int rc = anchor_ctl_txn_pause(&t, 1, 1000, why, sizeof why);
        expect_true("a ready reply is never claimed once the budget is gone", rc != ANCHOR_CTL_TXN_OK);
        expect_true("and it fails bounded", rc == ANCHOR_CTL_TXN_TIMEOUT || rc == ANCHOR_CTL_TXN_BUSY);
        expect_true("the transaction was released", pthread_mutex_trylock(&g_mu) == 0);
        pthread_mutex_unlock(&g_mu);
        close(e); close(a);
    }

    /* A never-terminated line times out rather than half-matching. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 100, 400);
        const char *partial = ANCHOR_CTL_TXN_TAG "paus";
        assert(write(a, partial, strlen(partial)) == (ssize_t)strlen(partial));
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        expect("partial reply times out", anchor_ctl_txn_pause(&t, 2, 1000, why, sizeof why), ANCHOR_CTL_TXN_TIMEOUT);
        close(e); close(a);
    }

    /* Refusal, with its reason. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 500, 1500);
        struct app ap = { a, 1, 1, ANCHOR_CTL_TXN_TAG "refused 5 drain_incomplete", 0, 0 }; pthread_t th;
        assert(pthread_create(&th, NULL, app_thread, &ap) == 0);
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        expect("drain refusal", anchor_ctl_txn_pause(&t, 5, 2000, why, sizeof why), ANCHOR_CTL_TXN_REFUSED);
        expect_true("refusal reason kept", !strcmp(why, "drain_incomplete"));
        pthread_join(th, NULL); close(e); close(a);
    }

    /* Grammar: wrong trial, non-canonical id, and a tail where none is allowed. */
    {
        static const char *bad[] = {
            ANCHOR_CTL_TXN_TAG "paused 9",            /* another trial */
            ANCHOR_CTL_TXN_TAG "paused 04",           /* leading zero */
            ANCHOR_CTL_TXN_TAG "paused 4 extra",      /* a tail where none is allowed */
            ANCHOR_CTL_TXN_TAG "paused",              /* no id at all */
            ANCHOR_CTL_TXN_TAG "refused 4",           /* refusal with no reason */
        };
        for (size_t i = 0; i < sizeof bad / sizeof *bad; i++) {
            int e, a; pair(&e, &a);
            anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 300, 1000);
            struct app ap = { a, 1, 1, bad[i], 0, 0 }; pthread_t th;
            assert(pthread_create(&th, NULL, app_thread, &ap) == 0);
            char why[ANCHOR_CTL_TXN_REASON_MAX];
            expect(bad[i], anchor_ctl_txn_pause(&t, 4, 2000, why, sizeof why), ANCHOR_CTL_TXN_PROTOCOL);
            pthread_join(th, NULL); close(e); close(a);
        }
    }

    /* An embedded NUL is refused before it can truncate a later comparison: a
     * line carrying a valid-looking prefix plus hidden bytes must not be read as
     * that prefix. Written with an explicit length, since strlen stops at the NUL. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 300, 1000);
        static const char nul_line[] = ANCHOR_CTL_TXN_TAG "paused 4\0 extra\n";
        assert(write(a, nul_line, sizeof nul_line - 1) == (ssize_t)(sizeof nul_line - 1));
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        expect("an embedded NUL is refused", anchor_ctl_txn_pause(&t, 4, 2000, why, sizeof why),
               ANCHOR_CTL_TXN_PROTOCOL);
        close(e); close(a);
    }

    /* A PADWIN reply inside a quiet transaction: reported, never consumed. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 300, 1500);
        struct app ap = { a, 1, 1, NULL, 1, 0 }; pthread_t th;
        assert(pthread_create(&th, NULL, app_thread, &ap) == 0);
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        expect("PADWIN inside a quiet transaction", anchor_ctl_txn_pause(&t, 3, 2000, why, sizeof why),
               ANCHOR_CTL_TXN_PADWIN);
        pthread_join(th, NULL); close(e); close(a);
    }

    /* EOF is bounded. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 300, 2000);
        close(a);
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        const int rc = anchor_ctl_txn_pause(&t, 1, 2000, why, sizeof why);
        expect_true("closed channel fails bounded",
                    rc == ANCHOR_CTL_TXN_IO || rc == ANCHOR_CTL_TXN_TIMEOUT || rc == ANCHOR_CTL_TXN_POISONED);
        close(e);
    }

    /* The control lock held elsewhere: BUSY, not a wait. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 150, 1000);
        assert(pthread_mutex_trylock(&g_mu) == 0);
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        uint64_t t0; assert(anchor_ctl_txn_now(&t0));
        expect("control lock busy", anchor_ctl_txn_pause(&t, 1, 2000, why, sizeof why), ANCHOR_CTL_TXN_BUSY);
        uint64_t t1; assert(anchor_ctl_txn_now(&t1));
        expect_true("busy respected its acquisition slice", t1 - t0 >= 150000000ull);
        pthread_mutex_unlock(&g_mu);
        close(e); close(a);
    }

    /* Repeated entry with the opt-in turned OFF the second time: the same
     * process-lifetime mutex is reused and never re-initialised, and nothing is
     * written once it is off. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s;
        mk(&t, &s, e, 1, 300, 1500);
        struct app ap = { a, 1, 1, NULL, 0, 0 }; pthread_t th;
        assert(pthread_create(&th, NULL, app_thread, &ap) == 0);
        char why[ANCHOR_CTL_TXN_REASON_MAX];
        expect("first entry, opt-in on", anchor_ctl_txn_pause(&t, 1, 2000, why, sizeof why), ANCHOR_CTL_TXN_OK);
        pthread_join(th, NULL);
        mk(&t, &s, e, 0, 300, 1500);                       /* second entry: off */
        expect("second entry, opt-in off", anchor_ctl_txn_pause(&t, 2, 2000, why, sizeof why), ANCHOR_CTL_TXN_DISABLED);
        struct pollfd p; p.fd = a; p.events = POLLIN; p.revents = 0;
        expect_true("nothing written after the opt-in went off", poll(&p, 1, 50) == 0);
        expect_true("the mutex still works after re-init of the struct", pthread_mutex_trylock(&g_mu) == 0);
        pthread_mutex_unlock(&g_mu);
        close(e); close(a);
    }

    /* MULTI-LINK: two window transactions at once, which per-link pool_mu does
     * NOT serialise, plus the quiet kind. All three must keep their own replies. */
    {
        int e, a; pair(&e, &a);
        anchor_ctl_txn t; struct side s; mk(&t, &s, e, 1, 8000, 9000);
        enum { ROUNDS = 150 };
        struct app ap = { a, 1, 3 * ROUNDS, NULL, 0, 0 }; pthread_t th;
        assert(pthread_create(&th, NULL, app_thread, &ap) == 0);
        struct racer p = { &t, ROUNDS, 0, 1000 }, w1 = { &t, ROUNDS, 0, 0 }, w2 = { &t, ROUNDS, 0, 0 };
        pthread_t tp, tw1, tw2;
        assert(pthread_create(&tp, NULL, race_pause, &p) == 0);
        assert(pthread_create(&tw1, NULL, race_padwin, &w1) == 0);
        assert(pthread_create(&tw2, NULL, race_padwin, &w2) == 0);
        pthread_join(tp, NULL); pthread_join(tw1, NULL); pthread_join(tw2, NULL); pthread_join(th, NULL);
        expect_true("quiet transactions never split a line", p.bad == 0);
        expect_true("link 1 window transactions never split a line", w1.bad == 0);
        expect_true("link 2 window transactions never split a line", w2.bad == 0);
        close(e); close(a);
    }

    if (failures) { fprintf(stderr, "\n%d FAILURE(S)\n", failures); return 1; }
    printf("\nquiet-ctl-txn: all checks passed\n");
    return 0;
}
