// Native public-fixture qualification: target decoding plus MTP observation.
// Does not perform speculative acceptance; do not label this Eyesoff-AI tok/s.
#include "../../wasm/llama-shim/enclave_llama.h"
#include "../../isolation/m2/app-seccomp.h"
#include <vector>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <chrono>
static double now() {
    return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
static bool clean_wx() {
    FILE *f = fopen("/proc/self/maps", "r");
    if (!f) return false;
    char line[4096], perm[5]; bool clean = true;
    while (fgets(line, sizeof line, f)) {
        if (sscanf(line, "%*s %4s", perm) == 1 && perm[1] == 'w' && perm[2] == 'x') clean = false;
    }
    clean = clean && !ferror(f); fclose(f); return clean;
}
int main(int argc, char **argv) {
    if (argc != 2 && argc != 3) return 1;
    int rounds = argc == 3 ? atoi(argv[2]) : 3;
    if (rounds < 1 || rounds > 8) return 1;
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || app_seccomp_install()) return 7;
    char statement[160];
    if (app_seccomp_statement(statement, sizeof statement) < 0) return 8;
    fputs(statement, stderr);
    ell_init();
    auto *m = ell_load_model(argv[1], 0); if (!m) return 2;
    auto *c = ell_new_server(m, 8192, 64, 22, 0, 0, 1); if (!c) return 3;
    auto *mtp = ell_mtp_new(m, c, 8192, 64, 22, 0, 0, 1); if (!mtp) return 5;
    const char *prompt = "The capital of France is";
    int nv = ell_n_vocab(m);
    std::vector<float> logits(64 * nv);
    for (int round = 0; round < rounds; round++) {
        if (round) { ell_seq_remove(c, 0); ell_mtp_reset(mtp, 0); }
        int32_t ids[64]; int n = ell_tokenize(m, prompt, strlen(prompt), ids, 64), pos = 0;
        double started = now(), first_s = 0, decode_s = 0;
        for (int step = 0; step < 64; step++) {
            double a = now();
            int rc = ell_decode_seq_full(c, m, 0, pos, ids, n, logits.data());
            if (rc) { fprintf(stderr, "PUBLIC_ERROR decode=%d\n", rc); return 4; }
            ell_mtp_harvest(mtp, c, 0, n);
            int mrc = ell_mtp_observe(mtp, 0, pos, ids, n);
            if (mrc) { fprintf(stderr, "PUBLIC_ERROR mtp=%d\n", mrc); return 6; }
            double dt = now() - a;
            if (!step) first_s = dt; else decode_s += dt;
            if (!clean_wx()) { fputs("PUBLIC_ERROR writable executable mapping\n", stderr); return 9; }
            pos += n;
            auto last = logits.begin() + (n-1) * nv;
            ids[0] = std::max_element(last, last+nv) - last; n = 1;
            printf("PUBLIC_TOKEN round=%d step=%d id=%d\n", round, step, ids[0]); fflush(stdout);
        }
        printf("PUBLIC_TIMING round=%d first_s=%.6f decode_s=%.6f tok_s=%.6f total_s=%.6f\n",
               round, first_s, decode_s, 63/decode_s, now()-started); fflush(stdout);
    }
    ell_mtp_free(mtp); ell_free_context(c); ell_free_model(m);
    puts("PUBLIC_CLEAN_SHUTDOWN");
}
