/* Real mask/unmask, socket framing, pads and SIMD checks. The synthetic peer
 * knows only public weights and masked planes and forms its own scalar CRT
 * product. No GPU, model, shipment service or production worker is contacted. */
#include "../../wasm/ggml-shielded/shielded-wire.c"
#include "../../wasm/ggml-shielded/shielded-tee.c"
#include <assert.h>
#include <signal.h>

enum { K = 64, N0 = 17, N1 = 5, MAX_M = 16, DEPTH = 256 };
enum { HONEST, CORRUPT, WRAP, SHORT_LENGTH, OVERSIZE, REFUSE, TRUNCATE, DISCONNECT,
       EXTREME_POS, EXTREME_NEG, ABOVE_FIELD, BELOW_FIELD };
typedef struct {
    int fd, mode, width, rows, count, nodes[2], calls, expected;
    bool overlap, received, ready;
    uint8_t *ring;
    const int8_t *weights[2];
    pthread_mutex_t mu;
    pthread_cond_t cv;
} peer;
static peer *active;
static const sh_simd *base_simd;

static void send_bytes(int fd, const void *data, size_t size) {
    struct iovec iov = { (void *)data, size };
    assert(write_all(fd, &iov, 1) == SH_OK);
}
static void checked_rhs(const int64_t *x, const int32_t *s, int reps, int64_t n, int64_t *out) {
    peer *p = active;
    assert(p);
    if (p->overlap) {
        pthread_mutex_lock(&p->mu);
        while (!p->received) pthread_cond_wait(&p->cv, &p->mu);
        pthread_mutex_unlock(&p->mu);
    }
    base_simd->fv_dots_x(x, s, reps, n, out);
    if (++p->calls == p->expected && p->overlap) {
        pthread_mutex_lock(&p->mu);
        p->ready = true;
        pthread_cond_signal(&p->cv);
        pthread_mutex_unlock(&p->mu);
    }
}
static uint32_t read_u32(const uint8_t *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
static void *serve(void *arg) {
    peer *p = arg;
    uint8_t h[9], req[16 + 3 * MAX_M * K];
    uint64_t seq = 0;
    if (p->ring) {
        while (!(seq = ld_acq(p->ring + SH_RING_OFF_REQ))) sched_yield();
        memcpy(h, p->ring + SH_RING_OFF_RQH, sizeof h);
    } else assert(read_all(p->fd, h, sizeof h) == SH_OK);
    assert(h[0] == (p->width == 3 ? SH_CMD_FIELD_GEMM24 : SH_CMD_FIELD_GEMM));
    size_t size = get_u64(h + 1), hn = 8 + 4 * p->count;
    assert(size == hn + 3 * (size_t)p->rows * K && size <= sizeof req);
    if (p->ring) memcpy(req, p->ring + SH_RING_OFF_RQP, size);
    else assert(read_all(p->fd, req, size) == SH_OK);
    assert(read_u32(req) == (uint32_t)p->count && read_u32(req + 4) == (uint32_t)p->rows);
    for (int i = 0; i < p->count; i++) assert(read_u32(req + 8 + 4 * i) == (uint32_t)p->nodes[i]);
    pthread_mutex_lock(&p->mu);
    p->received = true;
    pthread_cond_signal(&p->cv);
    while (p->overlap && !p->ready) pthread_cond_wait(&p->cv, &p->mu);
    pthread_mutex_unlock(&p->mu);

    uint8_t reply[4 * MAX_M * (N0 + N1)];
    const int8_t *planes = (const int8_t *)req + hn;
    size_t used = 0;
    for (int i = 0; i < p->count; i++) {
        int node = p->nodes[i], n = node == 0 ? N0 : N1;
        for (int row = 0; row < p->rows; row++) for (int j = 0; j < n; j++) {
            int32_t residues[3] = {0};
            for (int q = 0; q < 3; q++) for (int k = 0; k < K; k++)
                residues[q] += planes[(q * p->rows + row) * K + k] * p->weights[node][j * K + k];
            int64_t value = sh_crt(residues[0], residues[1], residues[2]);
            if (p->mode == EXTREME_POS) value = INT32_MAX;
            if (p->mode == EXTREME_NEG) value = INT32_MIN;
            if (p->mode == ABOVE_FIELD) value = SH_HALF_M + 1;
            if (p->mode == BELOW_FIELD) value = -SH_HALF_M - 1;
            if (p->mode == CORRUPT && i == p->count - 1 && row == p->rows - 1 && j == 0)
                value = sh_balanced(value + 1);
            uint32_t bits = (uint32_t)(int32_t)value;
            for (int b = 0; b < p->width; b++) reply[used++] = (uint8_t)(bits >> (8 * b));
        }
    }
    memset(h, 0, sizeof h);
    h[0] = p->mode == REFUSE;
    put_u64(h + 1, p->mode == OVERSIZE ? SH_MAX_FRAME + 1 : used - (p->mode == SHORT_LENGTH));
    if (p->ring) {
        assert(p->mode <= WRAP || p->mode >= EXTREME_POS);
        memcpy(p->ring + SH_RING_OFF_RPH, h, sizeof h);
        memcpy(p->ring + SH_RING_OFF_RPP, reply, used);
        st_rel(p->ring + SH_RING_OFF_REP, seq);
    } else if (p->mode != DISCONNECT) {
        send_bytes(p->fd, h, sizeof h);
        if (p->mode != OVERSIZE)
            send_bytes(p->fd, reply, used - (p->mode == SHORT_LENGTH || p->mode == TRUNCATE));
    }
    close(p->fd);
    return NULL;
}

static void exchange(sh_link *l, const int8_t *w0, const int8_t *w1, int width, int m, int mode, int count, bool reverse, int ring_mode) {
    peer p = { .mode = mode, .width = ring_mode ? 4 : width, .rows = m, .count = count,
        .nodes = {reverse ? 1 : 0, reverse ? 0 : 1}, .expected = l->verify ? count * m : 0,
        .overlap = l->verify && l->overlap_verify && !ring_mode, .weights = {w0, w1} };
    pthread_mutex_init(&p.mu, NULL); pthread_cond_init(&p.cv, NULL);
    int sockets[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    sh_pipe_close(l->pipe);
    l->pipe = calloc(1, sizeof *l->pipe); assert(l->pipe); l->pipe->fd = sockets[0];
    if (ring_mode) {
        l->pipe->map = mmap(NULL, SH_RING_BYTES, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        assert(l->pipe->map != MAP_FAILED);
        l->pipe->map_len = SH_RING_BYTES; l->pipe->ring = l->pipe->map;
        if (ring_mode == 1) p.ring = l->pipe->ring;
        /* mode 2 leaves the ring unanswered, forcing a same-frame socket
         * retry. Even that exchange must retain the synchronous RHS path. */
    }
    l->ywidth = width; p.fd = sockets[1]; active = &p;
    pthread_t thread; assert(pthread_create(&thread, NULL, serve, &p) == 0);
    int64_t x[MAX_M * K], y0[MAX_M * N0], y1[MAX_M * N1];
    const int64_t untouched = INT64_C(0x123456789abcdef);
    for (size_t i = 0; i < sizeof y0 / sizeof y0[0]; i++) y0[i] = untouched;
    for (size_t i = 0; i < sizeof y1 / sizeof y1[0]; i++) y1[i] = untouched;
    int64_t *out[2] = {reverse ? y1 : y0, reverse ? y0 : y1};
    for (int i = 0; i < m * K; i++) x[i] = mode == WRAP ? 1000000 : (i * 13 + m) % 101 - 50;
    const int head = l->groups[0].head, before = l->groups[0].count;
    const uint64_t used_before = l->pads_used;
    int rc = sh_link_gemm(l, p.nodes, count, x, m, out);
    pthread_join(thread, NULL);
    assert(l->groups[0].held == 0 && l->groups[0].count == before - m);
    assert(l->groups[0].head == (head + m) % DEPTH && l->pads_used == used_before + m);
    if (p.overlap) assert(p.calls == p.expected && p.ready);
    int expected_rc = mode == HONEST ? SH_OK :
        (mode == CORRUPT || mode == WRAP) ? SH_ERR_VERIFY :
        (mode == TRUNCATE || mode == DISCONNECT) ? SH_ERR_IO : SH_ERR_VIOLATION;
    assert(rc == expected_rc);
    if (mode >= EXTREME_POS) {
        /* Reject invalid wire values before a kernel writes any output, even
         * if verification is disabled or the peer used the shared ring. */
        for (size_t i = 0; i < sizeof y0 / sizeof y0[0]; i++) assert(y0[i] == untouched);
        for (size_t i = 0; i < sizeof y1 / sizeof y1[0]; i++) assert(y1[i] == untouched);
    }
    if (rc == SH_OK) {
        assert(p.calls == p.expected);
        for (int i = 0; i < count; i++) {
            int node = p.nodes[i], n = node == 0 ? N0 : N1;
            for (int row = 0; row < m; row++) for (int j = 0; j < n; j++) {
                int64_t want = 0;
                for (int k = 0; k < K; k++) want += x[row * K + k] * p.weights[node][j * K + k];
                assert(out[i][row * n + j] == want);
            }
        }
    }
    pthread_mutex_destroy(&p.mu); pthread_cond_destroy(&p.cv); active = NULL;
}

static void run_case(int enabled, bool verify, int width, int ring_mode) {
    if (enabled < 0) unsetenv("SHIELDED_OVERLAP_VERIFY");
    else setenv("SHIELDED_OVERLAP_VERIFY", enabled ? "1" : "0", 1);
    int err = 0;
    sh_link *l = sh_link_open("unused", 1, verify, &err); assert(l && err == SH_OK);
    assert(l->overlap_verify == (enabled > 0));
    base_simd = l->simd;
    sh_simd monitored = *base_simd; monitored.fv_dots_x = checked_rhs; l->simd = &monitored;
    int8_t w0[N0 * K], w1[N1 * K];
    for (int i = 0; i < N0 * K; i++) w0[i] = i < K ? 119 : i % 11 - 5;
    for (int i = 0; i < N1 * K; i++) w1[i] = i % 7 - 3;
    assert(sh_link_add_weight(l, "a", w0, K, N0, MAX_M, -1) == 0);
    assert(sh_link_add_weight(l, "b", w1, K, N1, MAX_M, 0) == 1);
    // Invalid integer inputs are rejected before ANY pad or output is used,
    // even when the ordinary path would use the local exact fallback.
    const int ids[] = {0, 1};
    int64_t x_bad[K] = {0}, untouched0[N0], untouched1[N1];
    int64_t *rejected[] = {untouched0, untouched1};
    const int64_t bad_values[] = {INT64_MIN, -SH_FV_X_LIMIT, SH_FV_X_LIMIT, INT64_C(1) << 32, INT64_MAX};
    for (size_t b = 0; b < sizeof bad_values / sizeof bad_values[0]; b++) {
        x_bad[K - 1] = bad_values[b];
        for (int j = 0; j < N0; j++) untouched0[j] = 123;
        for (int j = 0; j < N1; j++) untouched1[j] = 456;
        assert(sh_link_gemm(l, ids, 2, x_bad, 1, rejected) == SH_ERR_VERIFY);
        assert(sh_link_gemm_local(l, ids, 2, x_bad, 1, rejected) == SH_ERR_VERIFY);
        assert(!sh_link_verify(l, 0, x_bad, untouched0, 1));
        assert(l->pads_used == 0 && l->exchanges == 0);
        for (int j = 0; j < N0; j++) assert(untouched0[j] == 123);
        for (int j = 0; j < N1; j++) assert(untouched1[j] == 456);
    }
    for (int sign = -1; sign <= 1; sign += 2) {
        x_bad[K - 1] = sign * (SH_FV_X_LIMIT - 1);
        assert(sh_link_gemm_local(l, ids, 2, x_bad, 1, rejected) == SH_OK);
        for (int j = 0; j < N0; j++) assert(untouched0[j] == sh_balanced(x_bad[K - 1] * w0[j * K + K - 1]));
    }
    x_bad[K - 1] = 0;
    untouched0[0] = INT64_MAX;
    assert(!sh_link_verify(l, 0, x_bad, untouched0, 1));
    sh_group *g = &l->groups[0];
    g->depth = DEPTH; g->head = DEPTH - 2; g->count = DEPTH;
    g->r_store = malloc(DEPTH * K * sizeof(int32_t));
    g->u_store = malloc(DEPTH * (N0 + N1) * sizeof(int32_t));
    assert(g->r_store && g->u_store);
    gen_scratch scratch; assert(gen_scratch_init(l, &scratch, DEPTH) == SH_OK);
    assert(generate(l, g, DEPTH, g->r_store, g->u_store, &scratch) == SH_OK);
    free(scratch.planes); free(scratch.acc);
    /* A synthetic imported bank: no refill thread and no on-path minting.
     * Exercise the real held-slot lifecycle, including wrap and failures. */
    l->dealt = true; l->threads_running = true;
    const int widths[] = {1, 3, 8, 16, 3};
    for (size_t i = 0; i < sizeof widths / sizeof widths[0]; i++)
        exchange(l, w0, w1, width, widths[i], HONEST, i == 4 ? 1 : 2, i % 2 != 0, ring_mode);
    if (verify) for (int mode = CORRUPT; mode <= (ring_mode == 1 ? WRAP : DISCONNECT); mode++)
        exchange(l, w0, w1, width, 3, mode, 2, mode % 2 != 0, ring_mode);
    if (width == 4 || ring_mode) for (int mode = EXTREME_POS; mode <= BELOW_FIELD; mode++)
        exchange(l, w0, w1, width, 3, mode, 2, mode % 2 != 0, ring_mode);
    assert(l->pads_missed == 0);
    assert((l->fv_rhs != NULL) == (enabled > 0 && verify && !ring_mode));
    assert(l->verify_fail == (verify ? 2 : 0));
    sh_link_close(l);
}

int main(void) {
    signal(SIGPIPE, SIG_IGN);
    int32_t bounds[] = { -(int32_t)SH_HALF_M, -1, 0, 1, (int32_t)SH_HALF_M };
    assert(sh_reply32_balanced(bounds, sizeof bounds / sizeof bounds[0]));
    const int32_t invalid[] = { INT32_MIN, -(int32_t)SH_HALF_M - 1, (int32_t)SH_HALF_M + 1, INT32_MAX };
    for (size_t i = 0; i < sizeof invalid / sizeof invalid[0]; i++) {
        bounds[2] = invalid[i];
        assert(!sh_reply32_balanced(bounds, sizeof bounds / sizeof bounds[0]));
    }
    for (int width = 3; width <= 4; width++) {
        for (int enabled = -1; enabled <= 1; enabled++) run_case(enabled, true, width, 0);
        run_case(1, false, width, 0);
    }
    run_case(1, true, 3, 1);
    run_case(1, true, 3, 2);
}
