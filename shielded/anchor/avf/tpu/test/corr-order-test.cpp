// corr-order-test.cpp -- the row-major correction (tpu_corr_rows) against the column-major form it replaced: bit-identical
// outputs for random weights, scales and out-of-lane entries, over the lane's real shapes and 1..5 request rows, split
// into arbitrary output chunks (as the correction threads split it).
#include "../../payload/tpu_corr.h"
#include <cstdio>
#include <cstring>
#include <random>
int main() {
    std::mt19937_64 rng(20260922); int fails = 0, checks = 0;
    const struct { size_t n_in; uint32_t n_out; } shapes[] = { {1536, 2048}, {1536, 256}, {2048, 1536}, {1536, 12288}, {12288, 1536}, {6144, 1536} };
    for (auto sh : shapes) for (uint32_t rows = 1; rows <= 5; rows++) {
        std::vector<int8_t> W(sh.n_in * sh.n_out); for (auto &w : W) w = (int8_t)((int)(rng() % 255) - 127);
        std::vector<float> sw(sh.n_out); for (auto &x : sw) x = (float)std::ldexp(1.0 + (rng() % 1000) / 1000.0, -(int)(rng() % 12));
        const float s_in = 0.00137f;
        tpu_outliers ol(rows);
        for (uint32_t r = 0; r < rows; r++) { const int k = (int)(rng() % 250); std::vector<uint32_t> idx; for (int t = 0; t < k; t++) idx.push_back((uint32_t)(rng() % sh.n_in));
            std::sort(idx.begin(), idx.end()); idx.erase(std::unique(idx.begin(), idx.end()), idx.end());
            for (uint32_t i : idx) ol[r].push_back({ i, (int32_t)((int64_t)(rng() % 2000001) - 1000000) }); }
        std::vector<float> a((size_t)rows * sh.n_out), b((size_t)rows * sh.n_out, -1.f);
        for (uint32_t r = 0; r < rows; r++) tpu_corr_col(W.data(), sh.n_in, sh.n_out, sw.data(), s_in, ol, r, a.data());
        for (uint32_t j0 = 0; j0 < sh.n_out; ) { const uint32_t j1 = std::min<uint32_t>(sh.n_out, j0 + 1 + (uint32_t)(rng() % 700)); tpu_corr_rows(W.data(), sh.n_in, sh.n_out, sw.data(), s_in, ol, rows, b.data(), j0, j1); j0 = j1; }
        checks++; if (memcmp(a.data(), b.data(), a.size() * sizeof(float))) { fails++; printf("FAIL n_in %zu n_out %u rows %u: outputs differ\n", sh.n_in, sh.n_out, rows); }
    }
    // association: sums and scales where (a*s_in)*sw and a*(s_in*sw) round differently must still agree with the column form
    { std::vector<int8_t> W(1); tpu_outliers ol(1); std::vector<float> a(1), b(1); int diff_assoc = 0, bad = 0;
      for (int t = 0; t < 200000; t++) {
          W[0] = (int8_t)((int)(rng() % 255) - 127); ol[0] = { { 0u, (int32_t)((int64_t)(rng() % 20000001) - 10000000) } };
          float sw = (float)std::ldexp(1.0 + (rng() % 100000) / 100000.0, -(int)(rng() % 20)), s_in = (float)std::ldexp(1.0 + (rng() % 100000) / 100000.0, -(int)(rng() % 20));
          const double aa = (double)ol[0][0].second * (double)W[0];
          if ((float)(aa * (double)s_in * (double)sw) != (float)(aa * ((double)s_in * (double)sw))) diff_assoc++;
          tpu_corr_col(W.data(), 1, 1, &sw, s_in, ol, 0, a.data()); tpu_corr_rows(W.data(), 1, 1, &sw, s_in, ol, 1, b.data(), 0, 1);
          if (memcmp(a.data(), b.data(), sizeof(float))) bad++; }
      checks++; if (bad) { fails++; printf("FAIL association: %d of 200000 differ\n", bad); }
      printf("(of 200000 random cases, %d round differently under the other association; the kernels agree on all)\n", diff_assoc); }
    printf("%s: %d checks, %d failures\n", fails ? "FAIL" : "PASS", checks, fails); return fails != 0;
}
