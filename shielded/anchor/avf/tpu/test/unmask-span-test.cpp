// unmask-span-test.cpp -- payload/tpu_unmask_span.h: chunked (parallel) == serial bit for bit, the self-check replay never
// debits the rail budget, a near-exhausted budget refuses in the real pass and not in the replay, a corrupted verified output
// refuses, and tpu_unmask_same rejects a single changed output.
#include "../../payload/tpu_unmask_span.h"
#include <cstdio>
#include <cstring>
#include <random>
#include <stdexcept>
#include <vector>
static int checks = 0, fails = 0;
static void expect(bool ok, const char *w) { checks++; if (!ok) { fails++; printf("FAIL %s\n", w); } }
struct Refused : std::runtime_error { using std::runtime_error::runtime_error; };
struct Fixture {
    uint32_t n_in = 384, n_out = 700, rows = 3; float s_out = 0.0123f;
    std::vector<int8_t> W; std::vector<double> M; std::vector<int16_t> q, rx; std::vector<std::vector<int16_t>> P; std::vector<float> y0;
    std::vector<uint32_t> rails;   // outputs whose hi reply is forced to +32767 (row 1)
    Fixture(uint64_t seed, int nrails) {
        std::mt19937_64 rng(seed);
        W.resize((size_t)n_out * n_in); for (auto &w : W) w = (int8_t)((int)(rng() % 255) - 127);
        M.resize(n_out); for (auto &m : M) m = 1e-4 * (1.0 + (rng() % 1000) / 1000.0);
        q.resize((size_t)rows * n_in); for (auto &v : q) v = (int16_t)((int)(rng() % 32769) - 16384);
        P.assign(rows, std::vector<int16_t>(n_out)); for (auto &pr : P) for (auto &v : pr) v = (int16_t)((int)(rng() % 60001) - 30000);
        y0.resize((size_t)rows * n_out); for (auto &v : y0) v = (float)((rng() % 2001) / 100.0 - 10.0);
        rx.assign((size_t)2 * rows * n_out, 0);
        for (uint32_t r = 0; r < rows; r++) for (uint32_t j = 0; j < n_out; j++) {   // an honest reply: the reference's own rounding, clamped
            const int16_t *qr = &q[(size_t)r * n_in];
            int64_t ea = llround((double)tpu_dot_i8_digit(&W[(size_t)j * n_in], qr, n_in, true) * M[j] * 102.4);
            int64_t eb = llround((double)tpu_dot_i8_digit(&W[(size_t)j * n_in], qr, n_in, false) * M[j] * 102.4);
            rx[(size_t)r * n_out + j] = (int16_t)(ea > 32767 ? 32767 : ea < -32768 ? -32768 : ea);
            rx[(size_t)(rows + r) * n_out + j] = (int16_t)(eb > 32767 ? 32767 : eb < -32768 ? -32768 : eb);
        }
        for (int k = 0; k < nrails; k++) { uint32_t j = 50 + 97 * k; rails.push_back(j); rx[(size_t)1 * n_out + j] = 32767; }   // false rails
    }
    tpu_span_ctx ctx(std::vector<float> &y, std::vector<const int16_t *> &Pp, uint32_t jv) {
        Pp.resize(rows); for (uint32_t r = 0; r < rows; r++) Pp[r] = P[r].data();
        return tpu_span_ctx{ W.data(), n_in, n_out, M.data(), s_out, rows, rx.data(), Pp.data(), q.data(), y.data(), jv, 1, true };
    }
};
static int64_t fake_now() { return 0; }
int main() {
    { Fixture f(1, 3); std::vector<const int16_t *> Pp;
      // serial, with a budget that has room
      std::vector<float> ys = f.y0; ggml_backend_tpu_stats_t As{}; uint64_t rrs = 0; int budget = 100, taken = 0;
      tpu_unmask_digit_span(f.ctx(ys, Pp, 123), 0, f.n_out, As, rrs, [&]{ if (!budget) return false; budget--; taken++; return true; },
                            []{ throw Refused("budget"); }, [](uint32_t, uint64_t, uint64_t){ throw Refused("verify"); }, fake_now);
      expect(taken == 3 && rrs == 3 && As.false_rails == 3, "three forced rails: three budget tokens, three recomputations, three false rails");
      // chunked (the parallel form): random chunk sizes, local counters merged
      std::vector<float> yp = f.y0; ggml_backend_tpu_stats_t Ap{}; uint64_t rrp = 0; int budget2 = 100; std::mt19937_64 rng(7);
      for (uint32_t j0 = 0; j0 < f.n_out; ) { uint32_t j1 = std::min<uint32_t>(f.n_out, j0 + 1 + rng() % 150); ggml_backend_tpu_stats_t L{}; uint64_t rr = 0;
          tpu_unmask_digit_span(f.ctx(yp, Pp, 123), j0, j1, L, rr, [&]{ if (!budget2) return false; budget2--; return true; },
                                []{ throw Refused("budget"); }, [](uint32_t, uint64_t, uint64_t){ throw Refused("verify"); }, fake_now);
          Ap.ver_n += L.ver_n; Ap.ver_bad += L.ver_bad; Ap.saturated += L.saturated; Ap.false_rails += L.false_rails; Ap.cancel_n += L.cancel_n; rrp += rr; j0 = j1; }
      expect(memcmp(ys.data(), yp.data(), ys.size() * sizeof(float)) == 0, "chunked (parallel form) == serial, bit for bit");
      expect(Ap.ver_n == As.ver_n && Ap.saturated == As.saturated && Ap.false_rails == As.false_rails && Ap.cancel_n == As.cancel_n && rrp == rrs, "integer counters identical");
      // the self-check replay: must not debit the budget, and must reproduce the same outputs
      std::vector<float> yr = f.y0; ggml_backend_tpu_stats_t Ar{}; uint64_t rrr = 0; int replay_takes = 0;
      tpu_unmask_digit_span(f.ctx(yr, Pp, 123), 0, f.n_out, Ar, rrr, [&]{ replay_takes++; return true; },
                            []{ throw Refused("budget"); }, [](uint32_t, uint64_t, uint64_t){ throw Refused("verify"); }, fake_now);
      expect(memcmp(ys.data(), yr.data(), ys.size() * sizeof(float)) == 0, "the replay reproduces the outputs");
      expect(tpu_unmask_same({ys}, {yr}), "tpu_unmask_same: identical results agree");
      std::vector<float> yx = yr; uint32_t bits; memcpy(&bits, &yx[417], 4); bits ^= 1; memcpy(&yx[417], &bits, 4);
      expect(!tpu_unmask_same({ys}, {yx}), "tpu_unmask_same: ONE changed output (one bit) is a mismatch");
      expect(!tpu_unmask_same({ys, ys}, {ys}), "tpu_unmask_same: a missing projection is a mismatch");
    }
    { // near-budget: one token left, two rails -> the REAL pass refuses at the second rail; the replay does not, and debits nothing
      Fixture f(2, 2); std::vector<const int16_t *> Pp; std::vector<float> y = f.y0; ggml_backend_tpu_stats_t A{}; uint64_t rr = 0; int budget = 1; bool refused = false;
      try { tpu_unmask_digit_span(f.ctx(y, Pp, UINT32_MAX), 0, f.n_out, A, rr, [&]{ if (!budget) return false; budget--; return true; },
                                  []{ throw Refused("budget"); }, [](uint32_t, uint64_t, uint64_t){ throw Refused("verify"); }, fake_now); }
      catch (const Refused &e) { refused = std::string(e.what()) == "budget"; }
      expect(refused && budget == 0 && rr == 1, "one token, two rails: the real pass spends it on the first and refuses at the second");
      int shared_budget = 1; std::vector<float> y2 = f.y0; ggml_backend_tpu_stats_t A2{}; uint64_t rr2 = 0; bool refused2 = false;
      try { tpu_unmask_digit_span(f.ctx(y2, Pp, UINT32_MAX), 0, f.n_out, A2, rr2, [&]{ return true; /* replay: no debit */ },
                                  []{ throw Refused("budget"); }, [](uint32_t, uint64_t, uint64_t){ throw Refused("verify"); }, fake_now); }
      catch (const Refused &) { refused2 = true; }
      expect(!refused2 && shared_budget == 1 && rr2 == 2, "the replay recomputes both rails and leaves the shared budget untouched");
    }
    { // a verified output corrupted by 2 digit units refuses
      Fixture f(3, 0); f.rx[(size_t)0 * f.n_out + 200] += 2; std::vector<const int16_t *> Pp; std::vector<float> y = f.y0; ggml_backend_tpu_stats_t A{}; uint64_t rr = 0;
      bool refused = false; uint64_t got = 0;
      try { tpu_unmask_digit_span(f.ctx(y, Pp, 200), 0, f.n_out, A, rr, []{ return true; }, []{ throw Refused("budget"); },
                                  [&](uint32_t, uint64_t da, uint64_t){ got = da; throw Refused("verify"); }, fake_now); }
      catch (const Refused &e) { refused = std::string(e.what()) == "verify"; }
      expect(refused && got == 2, "a verified output off by 2 digit units: refused");
    }
    printf("%s: %d checks, %d failures\n", fails ? "FAIL" : "PASS", checks, fails); return fails != 0;
}
