/* exbench-test.c -- payload/exbench.h against a responder that follows the protocol, one that hangs up, one that stays
 * silent, and one that answers part of the reply and stalls. Every failure must come back as -1 within the wait bound. */
#define EXBENCH_WAIT_MS 300
#include "../../payload/exbench.h"
#include <pthread.h>
#include <stdio.h>
static int checks = 0, fails = 0;
static void expect(int ok, const char *w) { checks++; if (!ok) { fails++; printf("FAIL %s\n", w); } }
static int mode;   /* 0 proper, 1 hang up at once, 2 silent, 3 partial then stall */
static void *responder(void *arg) {
    int fd = *(int *)arg; unsigned char h[8]; static unsigned char buf[1 << 20];
    for (;;) {
        if (mode == 1) { close(fd); return NULL; }
        size_t o = 0; while (o < 8) { ssize_t r = read(fd, h + o, 8 - o); if (r <= 0) { close(fd); return NULL; } o += (size_t)r; }
        uint32_t rep, req; memcpy(&rep, h, 4); memcpy(&req, h + 4, 4); rep &= 0x7fffffffu;
        size_t got = 0; while (got < req) { ssize_t r = read(fd, buf, req - got < sizeof buf ? req - got : sizeof buf); if (r <= 0) { close(fd); return NULL; } got += (size_t)r; }
        if (mode == 2) { usleep(1000000); close(fd); return NULL; }
        size_t send_n = mode == 3 ? rep / 2 : rep;
        size_t s = 0; while (s < send_n) { ssize_t w = write(fd, buf, send_n - s < sizeof buf ? send_n - s : sizeof buf); if (w <= 0) { close(fd); return NULL; } s += (size_t)w; }
        if (mode == 3) { usleep(1000000); close(fd); return NULL; }
    }
}
static int one(int m, size_t req, size_t rep, int iters, int waitall, exbench_stat *st, double *ms) {
    int sp[2]; socketpair(AF_UNIX, SOCK_STREAM, 0, sp); mode = m; pthread_t th; pthread_create(&th, NULL, responder, &sp[1]);
    long reads = 0; double a = exb_now_ms(); int rc = exbench_run(sp[0], req, rep, iters, 0, waitall, st, &reads); *ms = exb_now_ms() - a;
    close(sp[0]); pthread_join(th, NULL); return rc;
}
int main(void) {
    exbench_stat st; double ms;
    expect(one(0, 7400, 24500, 50, 0, &st, &ms) == 0 && st.n == 50 && st.min_ms > 0 && st.min_ms <= st.med_ms && st.med_ms <= st.p90_ms, "a proper responder: 50 round trips, ordered stats");
    expect(one(0, 16 * 7400, 16 * 24500, 20, 1, &st, &ms) == 0 && st.n == 20, "16-row shape with MSG_WAITALL");
    expect(one(1, 7400, 24500, 5, 0, &st, &ms) == -1 && ms < 1000, "a peer that hangs up: -1 at once");
    expect(one(2, 7400, 24500, 5, 0, &st, &ms) == -1 && ms < 1000, "a silent peer: -1 within the wait bound");
    expect(one(3, 7400, 24500, 5, 0, &st, &ms) == -1 && ms < 1000, "a partial reply then a stall: -1 within the wait bound");
    expect(one(0, 7400, 24500, 0, 0, &st, &ms) == -1, "zero iterations refused");
    printf("%s: %d checks, %d failures\n", fails ? "FAIL" : "PASS", checks, fails); return fails != 0;
}
