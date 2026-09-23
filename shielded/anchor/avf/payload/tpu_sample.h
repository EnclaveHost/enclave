/* tpu_sample.h -- WHICH outputs the kernel verification recomputes and WHICH exchanges the parallel-unmask self-check
 * replays, stratified by the finest unit each means to cover (the lesson of the Shielded-27B soak, REPORT 18.38-18.40).
 *
 * The first version keyed both on the GLOBAL exchange counter. A decode pass is exactly 35 blocks x 4 kinds = 140
 * exchanges, and 140 shares a factor of 4 with 16 and with every E2B output width, so:
 *   - the self-check (exchanges % 16 == 0) only ever replayed kind-0 exchanges (140t + p = 0 mod 16 forces p = 0 mod 4);
 *   - the verified output (exchanges % n_out) of any one projection was always the same residue mod 4, so 3/4 of each
 *     projection's outputs were never recomputed, whatever the run length.
 * And it was PUBLIC: the worker counts exchanges, so it knew which output would be recomputed.
 *
 * Now each group (one block's one kind) keeps its own visit counter:
 *   - the self-check runs on the FIRST visit of every (group, rows) cell and on every `period`-th visit of that cell;
 *   - the verified output of projection p on visit v is (off_p + v * stride_p) mod n_out_p, with off_p and stride_p
 *     drawn inside the VM at first use (stride coprime to n_out), so every output of every projection is recomputed
 *     exactly once per n_out visits, in an order the worker cannot know.
 * What this does NOT change: it is still ONE output per projection per exchange. A worker wrong on a fraction f of a
 * projection's outputs is caught with probability f per exchange, not with certainty. The defence against a
 * deliberately lying worker remains the masking and the bounded repair; this counter detects drift, with coverage. */
#ifndef TPU_SAMPLE_H
#define TPU_SAMPLE_H
#include <cstdint>
#include <cstddef>
#include <vector>

static constexpr uint32_t kSampleRowsCells = 8;   /* rows 0..7; the graphs are compiled for <= 5 */

struct tpu_sampler {
    bool ready = false;
    uint64_t visits = 0;                          /* this group's exchanges so far */
    uint64_t row_visits[kSampleRowsCells] = {};   /* per (group, rows) cell, for the self-check */
    std::vector<uint32_t> off, stride;            /* per projection; secret to the VM */
};

static inline uint32_t tpu_gcd(uint32_t a, uint32_t b) { while (b) { const uint32_t t = a % b; a = b; b = t; } return a; }

/* rnd(): a uniform 64-bit value from a source the worker cannot see. Returns false if n_out is empty or zero. */
template <class Rnd>
static inline bool tpu_sampler_init(tpu_sampler &s, const std::vector<uint32_t> &n_out, Rnd rnd) {
    s.off.assign(n_out.size(), 0); s.stride.assign(n_out.size(), 1);
    for (size_t p = 0; p < n_out.size(); p++) {
        const uint32_t n = n_out[p]; if (!n) return false;
        s.off[p] = (uint32_t)(rnd() % n);
        if (n == 1) continue;
        for (int tries = 0; tries < 1000; tries++) {           /* coprime density is >= ~0.3 for any n here */
            const uint32_t c = 1 + (uint32_t)(rnd() % (n - 1));
            if (tpu_gcd(c, n) == 1) { s.stride[p] = c; break; }
        }
        if (tpu_gcd(s.stride[p], n) != 1) return false;
    }
    s.ready = true; return true;
}
/* The output of projection p to verify on this visit. */
static inline uint32_t tpu_sample_jv(const tpu_sampler &s, size_t p, uint32_t n_out) {
    return (uint32_t)((s.off[p] + (s.visits % n_out) * (uint64_t)s.stride[p]) % n_out);
}
/* Whether this visit's parallel unmask is replayed serially: first visit of the (group, rows) cell, then every period-th. */
static inline bool tpu_sample_selfcheck(const tpu_sampler &s, uint32_t rows, uint32_t period) {
    const uint64_t v = s.row_visits[rows < kSampleRowsCells ? rows : kSampleRowsCells - 1];
    return v == 0 || (period && v % period == 0);
}
/* Called once per exchange of the group, after both decisions were taken. */
static inline void tpu_sample_advance(tpu_sampler &s, uint32_t rows) {
    s.visits++; s.row_visits[rows < kSampleRowsCells ? rows : kSampleRowsCells - 1]++;
}
#endif
