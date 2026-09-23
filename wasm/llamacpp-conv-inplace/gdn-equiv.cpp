// GATED_DELTA_NET, token-fused against per-token, bit for bit.
//
// The token-fused CPU path (ENCLAVE_GGML_GDN_TOKFUSE, default on) runs every
// token of a small batch through one state row before moving to the next row;
// the per-token path sweeps the whole state once per token. Each row's
// operations and their order are the same in both, so outputs, the state and
// every rollback snapshot must be byte-identical. The switch is read once per
// process, so run this binary twice and compare the dumps:
//
//   ENCLAVE_GGML_GDN_TOKFUSE=1 gdn-equiv A.bin
//   ENCLAVE_GGML_GDN_TOKFUSE=0 gdn-equiv B.bin
//   cmp A.bin B.bin
//
// Each case dumps the op's output and the WHOLE state buffer it wrote into
// (for the in-place form: every slot of the simulated cache, padding included,
// so a stray write outside the snapshots shows up too). Cases cover n_tokens
// 1..17 (1 and 17 fall outside the fused path and must be unaffected), K 1..3
// and K > n_tokens, both forms, grouped q/k heads, several sequences, signed
// zeros, the scalar-gate form the model uses and the per-channel (KDA) gate,
// and thread counts 1/3/8. The per-case line printed to stdout carries a
// checksum so a mismatch can be located by diffing the two logs.
#include "ggml.h"
#include "ggml-cpu.h"
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <vector>

static FILE * out;
static long long bytes_written;
static int n_cases;

static void put(const void * p, size_t n) {
    if (fwrite(p, 1, n, out) != n) { fprintf(stderr, "short write\n"); exit(4); }
    bytes_written += (long long) n;
}

static uint64_t fnv(const void * p, size_t n, uint64_t h) {
    const unsigned char * c = (const unsigned char *) p;
    for (size_t i = 0; i < n; i++) { h ^= c[i]; h *= 1099511628211ull; }
    return h;
}

struct Case { int64_t S_v, H, H_k, n_t, n_s, K; bool inplace, kda, zeros; int threads; };

static void run(const Case & c, uint32_t seed) {
    ggml_init_params ip = { (size_t) 1 << 30, nullptr, false };
    ggml_context * ctx = ggml_init(ip);
    std::mt19937 rng(seed);
    std::normal_distribution<float> nd(0.f, 1.f);
    auto fill = [&](ggml_tensor * t, float sc, float off) { float * p = (float *) t->data;
        for (int64_t i = 0; i < ggml_nelements(t); i++) {
            float v = nd(rng) * sc + off;
            if (c.zeros) { const uint32_t r = rng() % 8; if (r == 0) v = 0.0f; else if (r == 1) v = -0.0f; }
            p[i] = v;
        } };
    ggml_tensor * q = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, c.S_v, c.H_k, c.n_t, c.n_s);
    ggml_tensor * k = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, c.S_v, c.H_k, c.n_t, c.n_s);
    ggml_tensor * v = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, c.S_v, c.H, c.n_t, c.n_s);
    ggml_tensor * g = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, c.kda ? c.S_v : 1, c.H, c.n_t, c.n_s);
    ggml_tensor * b = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, 1, c.H, c.n_t, c.n_s);
    fill(q, 0.1f, 0.f); fill(k, 0.1f, 0.f); fill(v, 1.f, 0.f);
    fill(g, 0.2f, -0.3f);   // log-decay: exp(g) mostly below 1, as the model has it
    fill(b, 0.2f, 0.5f);
    const size_t st_bytes = (size_t) c.S_v * c.S_v * c.H * c.n_s * sizeof(float);
    ggml_tensor * res;
    ggml_tensor * dumped_state;
    if (c.inplace) {
        // a cache of K slots, each larger than the state (stride past the active
        // state), the state at a nonzero offset inside slot 0
        const size_t pad = 4096;
        const size_t stride = st_bytes + pad + 64;
        ggml_tensor * cache = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, (int64_t) ((stride * c.K + pad) / sizeof(float)));
        fill(cache, 0.1f, 0.f);
        ggml_tensor * st = ggml_view_4d(ctx, cache, c.S_v, c.S_v, c.H, c.n_s,
                                        c.S_v * sizeof(float), c.S_v * c.S_v * sizeof(float),
                                        c.S_v * c.S_v * c.H * sizeof(float), 64);
        res = ggml_gated_delta_net_inplace(ctx, q, k, v, g, b, st, c.K, stride);
        dumped_state = cache;
    } else {
        ggml_tensor * st = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, c.S_v, c.S_v, c.H, c.n_s);
        fill(st, 0.1f, 0.f);
        res = ggml_gated_delta_net(ctx, q, k, v, g, b, st, c.K);
        dumped_state = st;   // must be left untouched
    }
    ggml_cgraph * gr = ggml_new_graph(ctx);
    ggml_build_forward_expand(gr, res);
    if (c.K > 1 && !c.inplace) {
        // slots older than n_tokens are caller-owned and not written: give them a
        // known value so both runs dump the same bytes
        float * p = (float *) res->data;
        for (int64_t i = 0; i < ggml_nelements(res); i++) p[i] = 7.0f;
    }
    if (ggml_graph_compute_with_ctx(ctx, gr, c.threads) != GGML_STATUS_SUCCESS) { fprintf(stderr, "compute failed\n"); exit(2); }
    const uint64_t h = fnv(dumped_state->data, ggml_nbytes(dumped_state), fnv(res->data, ggml_nbytes(res), 1469598103934665603ull));
    put(res->data, ggml_nbytes(res));
    put(dumped_state->data, ggml_nbytes(dumped_state));
    printf("case %d: S_v=%lld H=%lld H_k=%lld n_t=%lld n_s=%lld K=%lld %s %s%s threads=%d  %016llx\n", n_cases,
           (long long) c.S_v, (long long) c.H, (long long) c.H_k, (long long) c.n_t, (long long) c.n_s, (long long) c.K,
           c.inplace ? "inplace" : "copy", c.kda ? "kda" : "scalar-gate", c.zeros ? " zeros" : "", c.threads,
           (unsigned long long) h);
    n_cases++;
    ggml_free(ctx);
}

int main(int argc, char ** argv) {
    if (argc != 2) { fprintf(stderr, "usage: gdn-equiv OUT.bin\n"); return 2; }
    out = fopen(argv[1], "wb");
    if (!out) { fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }
    uint32_t seed = 1;
    // the model's shape (S_v 128, 48 value heads over 16 key heads), every
    // n_tokens across and past the fused window, K 1..3, both forms
    for (int64_t n_t : {1, 2, 3, 4, 5, 8, 16, 17}) for (int64_t K : {1, 2, 3}) for (bool inpl : {true, false})
        run({128, 48, 16, n_t, 1, K, inpl, false, (n_t % 2) == 0, 8}, seed++);
    // K > n_tokens: older slots untouched
    for (int64_t n_t : {2, 3}) for (bool inpl : {true, false})
        run({128, 48, 16, n_t, 1, 4, inpl, false, true, 8}, seed++);
    // several sequences, odd shapes, thread counts that split heads unevenly
    for (int threads : {1, 3, 8}) for (bool inpl : {true, false}) {
        run({64, 6, 3, 2, 3, 2, inpl, false, true, threads}, seed++);
        run({33, 5, 5, 7, 2, 3, inpl, false, false, threads}, seed++);
        run({16, 4, 2, 16, 2, 1, inpl, false, true, threads}, seed++);
    }
    // the per-channel gate never takes the fused path; it must be unaffected
    for (bool inpl : {true, false}) run({64, 4, 4, 3, 1, 2, inpl, true, true, 8}, seed++);
    if (fflush(out) != 0 || ferror(out) || fclose(out) != 0) { fprintf(stderr, "dump did not close cleanly\n"); return 4; }
    if (n_cases <= 0 || bytes_written <= 0) { fprintf(stderr, "incomplete run\n"); return 5; }
    printf("cases=%d bytes=%lld\n", n_cases, bytes_written);
    return 0;
}
