/* tpu_unmask_span.h -- the digit-split unmask of one projection's outputs [j0, j1) for every row, as a pure template the
 * host can test (tpu/test/unmask-span-test.cpp). ggml-tpu.cpp runs it serially (one correction helper) or in chunks on
 * the helper pool; the per-element arithmetic is the same either way, so the unmasked outputs are bit-identical.
 *
 * Everything it touches comes in through tpu_span_ctx; everything with a side effect outside the outputs and the local
 * counters is a callback, because that is exactly what differs between its uses:
 *   take()             the SHARED rail-recomputation budget (ggml-tpu.cpp's leaky bucket, under a lock). A real unmask
 *                      debits it before each rail recomputation; the serial REPLAY of the self-check passes a callback
 *                      that debits nothing, because the real pass over the same reply already took (or refused) those
 *                      tokens -- replaying must not spend the worker flood bound twice.
 *   refuse_budget()    the budget is exhausted: must not return (the backend logs and aborts).
 *   refuse_verify(...) a sampled product disagrees beyond the tolerance: must not return.
 *   now_us()           the clock for the verification-dot timer.
 * The counters go into the caller's local ggml_backend_tpu_stats_t, merged afterwards; only the ORDER of the diagnostic
 * float sums (cancel_sq, ver_sq, ver_lsb_sq) depends on how the work was split. */
#ifndef TPU_UNMASK_SPAN_H
#define TPU_UNMASK_SPAN_H
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include "ggml-tpu.h"

static inline int32_t tpu_digit_lo(int32_t v) { const int32_t m = (int32_t)((uint32_t)v & 0xFFu); return m >= 128 ? m - 256 : m; }
static inline int32_t tpu_digit_hi(int32_t v) { return (v - tpu_digit_lo(v)) / 256; }
static inline int64_t tpu_dot_i8_digit(const int8_t *w, const int16_t *q, uint32_t n, bool high) {
    int64_t a = 0;
    for (uint32_t i = 0; i < n; i++) { const int32_t v = q[i]; a += (int64_t)w[i] * (int64_t)(high ? tpu_digit_hi(v) : tpu_digit_lo(v)); }
    return a;
}

struct tpu_span_ctx {
    const int8_t *Wq; uint32_t n_in, n_out; const double *M; float s_out;   /* the projection, public */
    uint32_t rows; const int16_t *rx_p;          /* the reply for this projection: hi rows [0, rows), then lo rows [rows, 2*rows) */
    const int16_t *const *P;                     /* P[r]: row r's pad correction for this projection (n_out) */
    const int16_t *q;                            /* the masked request, rows x n_in (for the verification and rail dots) */
    float *y;                                    /* rows x n_out, holding the out-of-lane correction; the reply is ADDED */
    uint32_t jv;                                 /* the one output this exchange verifies (UINT32_MAX: none) */
    uint64_t verify_tol;                         /* digit units */
    bool repair;                                 /* kRepairClips */
};

template <class Take, class RefuseBudget, class RefuseVerify, class Now>
static void tpu_unmask_digit_span(const tpu_span_ctx &c, uint32_t j0, uint32_t j1, ggml_backend_tpu_stats_t &A, uint64_t &rail_recomp,
                                  Take take, RefuseBudget refuse_budget, RefuseVerify refuse_verify, Now now_us) {
    const float s_d = c.s_out / 102.4f;                                     /* DIGIT_OUT_DIV, as make_graphs.py writes it */
    for (uint32_t r = 0; r < c.rows; r++) {
        float *y = c.y + (size_t)r * c.n_out; const int16_t *P = c.P[r];
        const int16_t *vh = c.rx_p + (size_t)r * c.n_out, *vl = c.rx_p + (size_t)(c.rows + r) * c.n_out;
        const int16_t *qr = c.q + (size_t)r * c.n_in;
        for (uint32_t j = j0; j < j1; j++) {
            const int16_t a = vh[j], b2 = vl[j];
            /* KERNEL VERIFICATION: one element per projection per exchange recomputed with the reference's own expression */
            if (j == c.jv) {
                const int64_t tv0 = now_us();
                const int64_t va = llround((double)tpu_dot_i8_digit(c.Wq + (size_t)j * c.n_in, qr, c.n_in, true) * c.M[j] * 102.4);
                const int64_t vb = llround((double)tpu_dot_i8_digit(c.Wq + (size_t)j * c.n_in, qr, c.n_in, false) * c.M[j] * 102.4);
                const int64_t ca = va > 32767 ? 32767 : (va < -32768 ? -32768 : va);
                const int64_t cb = vb > 32767 ? 32767 : (vb < -32768 ? -32768 : vb);
                const uint64_t da = (uint64_t)llabs((int64_t)a - ca), db = (uint64_t)llabs((int64_t)b2 - cb);
                A.ver_n += 2; A.ver_sq += (double)(da * da) + (double)(db * db);
                if (da > A.ver_max) A.ver_max = da;
                if (db > A.ver_max) A.ver_max = db;
                if (da) A.ver_bad++;
                if (db) A.ver_bad++;
                if (da > c.verify_tol || db > c.verify_tol) refuse_verify(j, da, db);   /* FAIL CLOSED: does not return */
                { const double e = fabs((double)s_d * (256.0 * (double)((int64_t)a - ca) + (double)((int64_t)b2 - cb))) / (double)c.s_out;
                  if (e > A.ver_lsb_max) A.ver_lsb_max = e;
                  A.ver_lsb_sq += e * e; A.ver_lsb_n++; }
                A.ver_us += (uint64_t)(now_us() - tv0);
            }
            if (a >= 32767 || a <= -32767 || b2 >= 32767 || b2 <= -32767) {
                /* A RETURNED RAIL IS NOT EVIDENCE: only a trigger to recompute; the recomputed value is used UNCONDITIONALLY */
                A.saturated++;
                if (!take()) refuse_budget();                                   /* the budget is taken BEFORE the dots */
                rail_recomp++;
                if (a == -32768 || b2 == -32768) A.rail_m32768++;
                if (a == -32767 || b2 == -32767) A.rail_m32767++;
                if (a == 32767 || b2 == 32767) A.rail_p32767++;
                const int64_t ea = llround((double)tpu_dot_i8_digit(c.Wq + (size_t)j * c.n_in, qr, c.n_in, true) * c.M[j] * 102.4);
                const int64_t eb = llround((double)tpu_dot_i8_digit(c.Wq + (size_t)j * c.n_in, qr, c.n_in, false) * c.M[j] * 102.4);
                const int64_t xa = ea > 32767 ? ea - 32767 : (ea < -32768 ? -32768 - ea : 0);
                const int64_t xb = eb > 32767 ? eb - 32767 : (eb < -32768 ? -32768 - eb : 0);
                if (xa || xb) {
                    A.sat_clipped++; if (xa) A.sat_hi++; if (xb) A.sat_lo++;
                    const int64_t ex = xa > xb ? xa : xb; if ((uint64_t)ex > A.sat_max_excess) A.sat_max_excess = (uint64_t)ex;
                    const double err = fabs(s_d * (double)(256 * (ea - (int64_t)a) + (eb - (int64_t)b2))) / (double)c.s_out;
                    if (err > A.sat_max_err_lsb) A.sat_max_err_lsb = err;
                } else if (ea != (int64_t)a || eb != (int64_t)b2) {
                    A.false_rails++;
                }
                A.sat_repaired = c.repair ? 1 : 0;
                if (c.repair) { y[j] += (float)((double)s_d * (256.0 * (double)ea + (double)eb) - (double)c.s_out * (double)P[j]); continue; }
            }
            /* CANCELLATION in double; the diagnostic records how far the float form would have been */
            const double yd = (double)s_d * (double)(256 * (int32_t)a + (int32_t)b2) - (double)c.s_out * (double)P[j];
            { const double yf = (double)(s_d * (float)(256 * (int32_t)a + (int32_t)b2) - c.s_out * (float)P[j]);
              const double dd = fabs(yf - yd) / (double)c.s_out;
              if (dd > A.cancel_max_lsb) A.cancel_max_lsb = dd;
              A.cancel_sq += dd * dd; A.cancel_n++; }
            y[j] += (float)yd;
        }
    }
}

/* The self-check's verdict: true only when every output of the parallel unmask equals the serial replay's, byte for byte.
 * The caller must REFUSE (not continue) on false, before the parallel result is used. */
#include <cstring>
#include <vector>
static inline bool tpu_unmask_same(const std::vector<std::vector<float>> &a, const std::vector<std::vector<float>> &b) {
    if (a.size() != b.size()) return false;
    for (size_t p = 0; p < a.size(); p++) if (a[p].size() != b[p].size() || memcmp(a[p].data(), b[p].data(), a[p].size() * sizeof(float)) != 0) return false;
    return true;
}
#endif
