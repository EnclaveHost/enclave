#include "../../wasm/ggml-shielded/shielded-tee.c"
#include <assert.h>
#include <limits.h>
#include <time.h>

static uint32_t rng = 0x13eb671u;
static uint32_t next(void) { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }
static void reference(const int8_t *w, int64_t K, int64_t N, const int32_t *s, int32_t *out) {
    for (int64_t k = 0; k < K; k++) {
        __int128 acc = 0;
        for (int64_t j = 0; j < N; j++) acc += (__int128)w[j*K+k] * s[j];
        int64_t v = (int64_t)(acc % SH_M_MOD);
        out[k] = (int32_t)(v < 0 ? v + SH_M_MOD : v);
    }
}
static double now(void) { struct timespec t; assert(!clock_gettime(CLOCK_MONOTONIC, &t)); return t.tv_sec + t.tv_nsec * 1e-9; }
static void check(int64_t K, int64_t N, int extremes, int bench) {
    int8_t *w = malloc((size_t)(K*N)); int32_t *s = malloc((size_t)N*sizeof *s);
    int32_t *want = malloc((size_t)K*sizeof *want), *got = malloc((size_t)K*sizeof *got);
    assert(w && s && want && got);
    for (int64_t i = 0; i < K*N; i++) w[i] = extremes ? (i % 3 ? -128 : 127) : (int8_t)((int)(next()%255)-127);
    for (int64_t j = 0; j < N; j++) s[j] = extremes ? (j % 2 ? INT32_MIN : INT32_MAX) : 1+(int32_t)(next() % (SH_FV_S_RANGE-1));
    for (int round = 0; round < (bench ? 3 : 1); round++) {
        double old_s, new_s, t;
        if (round & 1) {
            t = now(); sh_pad_check_tiled(w,K,N,s,got); new_s = now()-t;
            t = now(); reference(w,K,N,s,want); old_s = now()-t;
        } else {
            t = now(); reference(w,K,N,s,want); old_s = now()-t;
            t = now(); sh_pad_check_tiled(w,K,N,s,got); new_s = now()-t;
        }
        assert(!memcmp(want,got,(size_t)K*sizeof *got));
        if (bench) printf("pad-check K=%lld N=%lld round=%d reference_ms=%.3f tiled_ms=%.3f speedup=%.2f exact=yes\n",
            (long long)K,(long long)N,round,old_s*1000,new_s*1000,old_s/new_s);
    }
    // Exercise the real registration selector and its freshly randomized sM.
    if (!extremes && !bench) for (int enabled=0; enabled<2; enabled++) {
        if (enabled) setenv("SHIELDED_PAD_PREPARE_TILED","1",1); else unsetenv("SHIELDED_PAD_PREPARE_TILED");
        sh_node nd = {0}; nd.K=K; nd.N=N; nd.w=w;
        assert(pad_check_prepare(&nd)==SH_OK);
        reference(w,K,N,nd.sM,want);
        assert(!memcmp(want,nd.stM,(size_t)K*sizeof *want));
        node_free_checks(&nd);
    }
    free(w);free(s);free(want);free(got);
}
int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1],"--bench")) { check(5120,17408,0,1); return 0; }
    const int64_t shapes[][2]={{1,1},{31,7},{128,19},{129,257},{256,1024},{65,32767},{65,32768},{65,32769},{257,65537}};
    for (size_t i=0;i<sizeof shapes/sizeof *shapes;i++) for(int extreme=0;extreme<2;extreme++) check(shapes[i][0],shapes[i][1],extreme,0);
    puts("pad-check: tiled/reference exact, tails, row reductions, full integer extremes and registration selector PASS");
    return 0;
}
