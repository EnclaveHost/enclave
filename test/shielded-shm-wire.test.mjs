import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('ring discovery skips occupied slots, stays within its BAR and stops on invalid peer replies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-shm-wire-'));
  const source = fileURLToPath(new URL('../wasm/ggml-shielded/shielded-wire.c', import.meta.url));
  try {
    writeFileSync(join(dir, 'test.c'), `
#include ${JSON.stringify(source)}
#include <assert.h>
#include <pthread.h>

typedef struct { int fd, mode, seen; } peer;
static void *serve(void *arg) {
    peer *p = arg;
    const int requests = p->mode < 2 ? 2 : 1;
    for (int i = 0; i < requests; i++) {
        uint8_t req[13]; assert(read_all(p->fd, req, sizeof req, NULL) == SH_OK);
        assert(req[0] == SH_CMD_SHM_ATTACH && get_u64(req + 1) == 4);
        assert(req[9] == i && req[10] == 0 && req[11] == 0 && req[12] == 0);
        p->seen++;
        uint8_t reply[35] = {0};
        const size_t size = p->mode == 3 ? 26 : 25;
        reply[0] = p->mode == 4 ? 1 : 0;
        put_u64(reply + 1, size);
        reply[9] = p->mode == 1 ? 0 : (p->mode >= 2 || i == 1);
        put_u64(reply + 10, SH_RING_BYTES + (p->mode == 2));
        put_u64(reply + 18, SH_RING_REQ_CAP);
        put_u64(reply + 26, SH_RING_REP_CAP);
        size_t offset = 0;
        while (offset < size + 9) {
            ssize_t n = write(p->fd, reply + offset, size + 9 - offset);
            assert(n > 0); offset += (size_t)n;
        }
    }
    close(p->fd);
    return NULL;
}
static void run_case(int mode, const char *file) {
    int sockets[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    sh_pipe *p = calloc(1, sizeof *p); assert(p); p->fd = sockets[0];
    peer worker = {sockets[1], mode, 0}; pthread_t thread;
    assert(pthread_create(&thread, NULL, serve, &worker) == 0);
    int index = -1;
    int rc = sh_pipe_shm_attach_available(p, file, 2 * SH_RING_BYTES, &index);
    pthread_join(thread, NULL);
    if (mode == 0) {
        assert(rc == SH_OK && index == 1 && worker.seen == 2);
        assert(sh_pipe_ring_live(p) && p->ring == p->map + SH_RING_BYTES);
    } else if (mode == 1) {
        assert(rc == SH_ERR_IO && index == -1 && worker.seen == 2);
        assert(!sh_pipe_ring_live(p));
    } else {
        assert(rc == (mode == 4 ? SH_ERR_VIOLATION : SH_ERR_PROTO));
        assert(index == -1 && worker.seen == 1 && !sh_pipe_ring_live(p));
    }
    sh_pipe_close(p);
}
int main(int argc, char **argv) {
    assert(argc == 2);
    int fd = open(argv[1], O_CREAT | O_TRUNC | O_RDWR, 0600); assert(fd >= 0);
    assert(ftruncate(fd, 2 * SH_RING_BYTES) == 0); close(fd);
    for (int mode = 0; mode < 5; mode++) run_case(mode, argv[1]);
    unlink(argv[1]);
}
`);
    execFileSync('cc', ['-std=c11', '-O1', '-Wall', '-Wextra', '-ffunction-sections', '-fdata-sections',
      join(dir, 'test.c'), '-Wl,--gc-sections', '-lpthread', '-o', join(dir, 'test')], { timeout: 30_000 });
    execFileSync(join(dir, 'test'), [join(dir, 'bar')], { timeout: 5_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The spin window is dead time on the one thread a decode round is serialized
// on, so the ring exchange takes the same overlap callback the socket path has
// always had. The contract is what needs pinning: the work runs AFTER the
// request is published (so the peer can already be computing), exactly once,
// and it still runs when no reply ever arrives - because the caller then
// resends on the socket and must not compute the same Freivalds RHS twice.
test('ring exchange runs overlap work once, after publishing, even when no reply comes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-ring-overlap-'));
  const source = fileURLToPath(new URL('../wasm/ggml-shielded/shielded-wire.c', import.meta.url));
  try {
    writeFileSync(join(dir, 'test.c'), `
#include ${JSON.stringify(source)}
#include <assert.h>
#include <pthread.h>

typedef struct { int fd, mode, seen; } peer;
static void *attach_serve(void *arg) {           /* the mode-0 attach dance */
    peer *p = arg;
    for (int i = 0; i < 2; i++) {
        uint8_t req[13]; assert(read_all(p->fd, req, sizeof req, NULL) == SH_OK);
        p->seen++;
        uint8_t reply[35] = {0};                  /* the mode-0 reply, verbatim */
        put_u64(reply + 1, 25);
        reply[9] = (i == 1);                      /* slot 0 occupied, slot 1 free */
        put_u64(reply + 10, SH_RING_BYTES);
        put_u64(reply + 18, SH_RING_REQ_CAP);
        put_u64(reply + 26, SH_RING_REP_CAP);
        size_t off = 0;
        while (off < 25 + 9) {
            ssize_t n = write(p->fd, reply + off, 25 + 9 - off);
            assert(n > 0); off += (size_t)n;
        }
    }
    close(p->fd);
    return NULL;
}

static uint8_t *g_ring;
static int g_calls, g_published;
static void note_work(void *ctx) {
    (void)ctx;
    g_calls++;
    /* the peer can see the request the moment the work starts */
    g_published += ld_acq(g_ring + SH_RING_OFF_REQ) != 0;
}

typedef struct { uint8_t *ring; size_t want; int answer; } ringpeer;
static void *ring_serve(void *arg) {
    ringpeer *rp = arg;
    for (int i = 0; i < 4000; i++) {
        const uint64_t seq = ld_acq(rp->ring + SH_RING_OFF_REQ);
        if (seq) {
            if (!rp->answer) return NULL;
            rp->ring[SH_RING_OFF_RPH] = 0;
            put_u64(rp->ring + SH_RING_OFF_RPH + 1, rp->want);
            memset(rp->ring + SH_RING_OFF_RPP, 0, rp->want);
            st_rel(rp->ring + SH_RING_OFF_REP, seq);
            return NULL;
        }
        usleep(200);
    }
    return NULL;
}

static void run_overlap(int answer, const char *file, int *rc_out) {
    int sockets[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    sh_pipe *p = calloc(1, sizeof *p); assert(p); p->fd = sockets[0];
    peer w = {sockets[1], 0, 0}; pthread_t t;
    assert(pthread_create(&t, NULL, attach_serve, &w) == 0);
    int index = -1;
    assert(sh_pipe_shm_attach_available(p, file, 2 * SH_RING_BYTES, &index) == SH_OK);
    pthread_join(t, NULL);
    assert(sh_pipe_ring_live(p));

    g_ring = p->ring; g_calls = 0; g_published = 0;
    uint8_t hdr[16] = {0}, payload[32] = {0};
    const size_t want = 64;
    ringpeer rp = { p->ring, want, answer }; pthread_t rt;
    assert(pthread_create(&rt, NULL, ring_serve, &rp) == 0);
    sh_frame f = { SH_CMD_FIELD_GEMM, hdr, sizeof hdr, payload, sizeof payload };
    sh_reply rep;
    *rc_out = sh_pipe_ring_exchange_work(p, &f, want, &rep, note_work, NULL);
    pthread_join(rt, NULL);
    assert(g_calls == 1);            /* exactly once, either way */
    assert(g_published == 1);        /* and only after the peer could see it */
    sh_pipe_close(p);
}

int main(int argc, char **argv) {
    assert(argc == 2);
    setenv("SHIELDED_SHM_SPIN_US", "50000", 1);   /* 50 ms: answered fast, unanswered bounded */
    int fd = open(argv[1], O_CREAT | O_TRUNC | O_RDWR, 0600); assert(fd >= 0);
    assert(ftruncate(fd, 2 * SH_RING_BYTES) == 0); close(fd);
    int rc_answered = -1, rc_silent = -1;
    run_overlap(1, argv[1], &rc_answered);
    run_overlap(0, argv[1], &rc_silent);
    assert(rc_answered == SH_OK);
    assert(rc_silent == SH_ERR_IO);  /* caller resends on the socket - without redoing the work */
    unlink(argv[1]);
}
`);
    execFileSync('cc', ['-std=c11', '-O1', '-Wall', '-Wextra', '-ffunction-sections', '-fdata-sections',
      join(dir, 'test.c'), '-Wl,--gc-sections', '-lpthread', '-o', join(dir, 'test')], { timeout: 60_000 });
    execFileSync(join(dir, 'test'), [join(dir, 'bar')], { timeout: 20_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
