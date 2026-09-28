/* Public deterministic test inputs only; never used by a production bank. */
#include "../../wasm/ggml-shielded/shielded-tee.c"
#include <assert.h>

static void reference(const uint32_t key[8], uint64_t ctr, int32_t *out, size_t n) {
    size_t done = 0;
    while (done < n) {
        uint32_t block[16]; sh_chacha20_block(key, ctr++, block);
        for (int j = 0; j < 8 && done < n; j++)
            out[done++] = (int32_t)((((uint64_t)block[2*j+1] << 32) | block[2*j]) % SH_M_MOD);
    }
}
static uint32_t rng = 791;
static uint32_t next(void) { rng = rng * 1664525 + 1013904223; return rng; }
static void check(const uint32_t key[8], uint64_t ctr, size_t n) {
    int32_t *a = malloc((n + 2) * sizeof *a), *b = malloc((n + 2) * sizeof *b);
    assert(a && b);
    a[0] = b[0] = a[n+1] = b[n+1] = INT32_MIN;
    reference(key, ctr, a + 1, n);
    sh_simd_avx512_mask_stream(key, ctr, b + 1, n);
    assert(!memcmp(a, b, (n + 2) * sizeof *a));
    for (size_t i = 1; i <= n; i++) assert(b[i] >= 0 && b[i] < SH_M_MOD);
    free(a); free(b);
}

enum {THREADS=8, CALLS=32, VALUES=129};
static sh_maskbank bank;
static int32_t issued[THREADS][CALLS][VALUES];
static void *issue_thread(void *arg) {
    size_t t = (size_t)arg;
    for (int i = 0; i < CALLS; i++) assert(maskbank_issue(&bank, issued[t][i], VALUES) == SH_OK);
    return NULL;
}
int main(void) {
    __builtin_cpu_init();
    if (!__builtin_cpu_supports("avx512vnni") || !__builtin_cpu_supports("avx512bw") ||
        !__builtin_cpu_supports("avx512dq") || !__builtin_cpu_supports("avx512vl")) return 77;
    uint32_t key[8] = {0};
    /* ChaCha20 all-zero key/counter/nonce known-answer first 64 bytes. */
    const uint32_t kat[16] = {
        0xade0b876,0x903df1a0,0xe56a5d40,0x28bd8653,0xb819d2bd,0x1aed8da0,0xccef36a8,0xc70d778b,
        0x7c5941da,0x8d485751,0x3fe02477,0x374ad8b8,0xf4b8436a,0x1ca11815,0x69b687c3,0x8665eeb2};
    uint32_t block[16]; sh_chacha20_block(key, 0, block); assert(!memcmp(block, kat, sizeof kat));
    int32_t out[8]; sh_simd_avx512_mask_stream(key, 0, out, 8);
    for (int j = 0; j < 8; j++) assert(out[j] == (int32_t)((((uint64_t)kat[2*j+1] << 32) | kat[2*j]) % SH_M_MOD));
    const uint64_t counters[] = {0, 1, 0xfffffff1, 0xffffffff, UINT64_C(1)<<32,
        (UINT64_C(1)<<48)-7, UINT64_MAX - (UINT64_C(1)<<24) + 1};
    for (size_t c = 0; c < sizeof counters / sizeof *counters; c++) {
        for (int j = 0; j < 8; j++) key[j] = next();
        for (size_t n = 0; n <= 513; n++) check(key, counters[c], n);
        check(key, counters[c], 17408 * 64);
    }
    for (int t = 0; t < 100; t++) {
        for (int j = 0; j < 8; j++) key[j] = next();
        check(key, ((uint64_t)next() << 24), next() % 10000);
    }
    assert(mask_stream_agrees());
    assert(maskbank_init(&bank));
    const char *opt = getenv("SHIELDED_MASK_CHACHA16"), *off = getenv("SHIELDED_NO_SIMD");
    int enabled = opt && !strcmp(opt, "1") && !(off && *off && strcmp(off, "0"));
    assert((bank.stream != NULL) == enabled);
    memcpy(bank.key, key, sizeof key);
    assert(maskbank_issue(&bank, out, (UINT64_C(1)<<27)+1) == SH_ERR_RANGE);
    assert(maskbank_issue(&bank, NULL, 1) == SH_ERR_RANGE);
    assert(bank.counter == 0);
    pthread_t threads[THREADS];
    for (size_t t = 0; t < THREADS; t++) assert(!pthread_create(&threads[t], NULL, issue_thread, (void *)t));
    for (int t = 0; t < THREADS; t++) assert(!pthread_join(threads[t], NULL));
    assert(bank.counter == THREADS * CALLS && bank.issued_hi == bank.counter);
    unsigned char seen[THREADS * CALLS] = {0};
    for (int t = 0; t < THREADS; t++) for (int c = 0; c < CALLS; c++) {
        int found = -1;
        for (int i = 0; i < THREADS * CALLS; i++) {
            int32_t expected[VALUES]; reference(key, (uint64_t)i << 24, expected, VALUES);
            if (!memcmp(expected, issued[t][c], sizeof expected)) { found = i; break; }
        }
        assert(found >= 0 && !seen[found]); seen[found] = 1;
    }
    bank.counter = bank.issued_hi = bank.capacity - 1;
    int32_t expected[VALUES]; reference(key, bank.counter << 24, expected, VALUES);
    assert(maskbank_issue(&bank, issued[0][0], VALUES) == SH_OK);
    assert(!memcmp(expected, issued[0][0], sizeof expected));
    memset(out, 0x5a, sizeof out);
    assert(maskbank_issue(&bank, out, 8) == SH_ERR_EXHAUST);
    for (int i = 0; i < 8; i++) assert(out[i] == 0x5a5a5a5a);
    pthread_mutex_destroy(&bank.mu);
    puts("mask-stream: exact stream, tails, counter carries, one-use concurrency and exhaustion PASS");
}
