/* tpu-mint-bench.cpp -- the Shielded-TPU pad minter alone (payload/ggml-tpu.cpp): exactness, then rate.
 *   tpu-mint-bench <lanes.etpu> <positions> <threads> [scalar_positions]
 * CHECK: every group mints 8 pads on the batched path and each P is recomputed from the pad's own r with the scalar
 * reference dot; any differing value fails the run. Then `positions` pads per group on `threads` threads (batched), and,
 * when asked, `scalar_positions` on the one-at-a-time reference path for the comparison. Needs only ggml. */
#include "ggml-tpu.h"
#include <cstdio>
#include <cstdlib>
int main(int argc, char **argv) {
    if (argc < 4) { fprintf(stderr, "usage: tpu-mint-bench <lanes.etpu> <positions> <threads> [scalar_positions]\n"); return 2; }
    const int positions = atoi(argv[2]), threads = atoi(argv[3]), scalar = argc > 4 ? atoi(argv[4]) : 0;
    if (ggml_backend_tpu_open_bundle(argv[1]) != 0) return 2;
    const long bad = ggml_backend_tpu_mint_check(8); printf("CHECK differing=%ld\n", bad); if (bad != 0) return 1;
    ggml_backend_tpu_stats_t st;
    if (positions > 0) { const double sec = ggml_backend_tpu_mint_bench(positions, threads, 0); ggml_backend_tpu_get_stats(&st, 1);
        printf("BATCHED positions=%d threads=%d seconds=%.2f positions_per_s=%.1f redrawn=%llu\n", positions, threads, sec, positions / sec, (unsigned long long)st.pads_redrawn); }
    if (scalar > 0) { const double sec = ggml_backend_tpu_mint_bench(scalar, threads, 1); ggml_backend_tpu_get_stats(&st, 1);
        printf("SCALAR positions=%d threads=%d seconds=%.2f positions_per_s=%.1f redrawn=%llu\n", scalar, threads, sec, scalar / sec, (unsigned long long)st.pads_redrawn); }
    return 0;
}
