/* i6_kernel_bench.cu -- can a packed 6-bit weight lane pay on this card?
 *
 * ANSWER, measured on a V100-PCIE-32GB (sm_70), 2026-09-21: NO, by 3.2x.
 *
 *   shape              K       N |  int8 us   int6 us |  i8 GB/s  i6 GB/s
 *   27B gate|up     5120   17408 |    163.2     529.2 |      546      137
 *   27B down       17408    5120 |    124.3     474.1 |      717      153
 *   27B qkv         5120   10240 |    100.7     315.0 |      521      135
 *   27B lm_head     5120  248320 |   2143.8    6737.6 |      593      153
 *
 * WHY THIS EXISTS. REPORT.md 15.5 priced narrower weight lanes by their
 * ENCODING ERROR and concluded int6 with an integer block scale was "the
 * usable end of that table". 16.10 then costed it as the last lever worth
 * more than a few percent: 0.8125 bytes per weight against 1.0625 is 19% off
 * a streaming term that is 12.7 ms of a 56 ms token. This measures the half
 * that pricing left out -- what the CARD pays to read it.
 *
 * The int8 lane is one byte per weight and dp4a eats it four at a time, so
 * the kernel is comfortably memory-bound. A 6-bit lane packs 32 weights into
 * 24 bytes, and every one of them has to be unpacked before any dp4a can
 * touch it. The version here is not the naive one: the +32 bias is folded
 * into a per-block correction (sum (q+32)x = sum qx + 32 sum x) so no value
 * is ever sign-adjusted individually, and each group of four values is
 * extracted from one 24-bit window with 4 ands, 3 shifts and 3 ors -- the
 * shape the compiler folds into LOP3. The first, naive form ran at 83-94
 * GB/s; this one reaches 137-153, against 546-717 for int8.
 *
 * So the lane turns a memory-bound kernel into an ALU-bound one, which is
 * exactly what shielded-field.h records about the v1 fused kernel: "keeping
 * the modulos made v1 ALU-bound and WORSE than not fusing at all". The 19%
 * of bytes it saves cannot be collected on this hardware at any encoding
 * quality, so the encoding-error question 15.5 asked never arises.
 *
 * This is a property of sm_70's ratio of integer throughput to bandwidth, not
 * of the scheme. Re-run it before assuming the same holds on a card whose
 * bandwidth is the harder constraint.
 *
 * Build (the V100 needs clang against the cached CUDA 12.6, as the worker does):
 *   CH=/home/steven/.cache/sd-gpu-repro/cuda-home
 *   clang++ -O3 -x cuda --cuda-path=$CH --no-cuda-version-check \
 *     --cuda-gpu-arch=sm_70 -o i6bench i6_kernel_bench.cu \
 *     -L$CH/lib64 -lcudart -ldl -lrt -lpthread -Wl,-rpath,$CH/lib64
 */
#include <cstdio>
#include <cstdint>
#include <vector>
#include <cuda_runtime.h>

#define CK(e) do { cudaError_t _e = (e); if (_e != cudaSuccess) { \
    printf("CUDA %s at %d\n", cudaGetErrorString(_e), __LINE__); return 1; } } while (0)

__device__ __forceinline__ int dp4a_(int a, int b, int c) {
#if __CUDA_ARCH__ >= 610
    int d; asm("dp4a.s32.s32 %0, %1, %2, %3;" : "=r"(d) : "r"(a), "r"(b), "r"(c)); return d;
#else
    int r = c; for (int i = 0; i < 4; i++) r += (int)(int8_t)(a >> (8*i)) * (int)(int8_t)(b >> (8*i)); return r;
#endif
}

/* int8 lane: 16 weights per int4 load, 4 dp4a per plane. */
__global__ void gemm_i8(const int4 *__restrict__ W, const int4 *__restrict__ X,
                        int K16, int N, int *__restrict__ Y) {
    const int j = blockIdx.x;
    const int lane = threadIdx.x;
    int acc[3] = {0, 0, 0};
    const int4 *wrow = W + (size_t)j * K16;
    for (int k = lane; k < K16; k += blockDim.x) {
        const int4 w = __ldg(wrow + k);
#pragma unroll
        for (int p = 0; p < 3; p++) {
            const int4 x = __ldg(X + (size_t)p * K16 + k);
            int a = acc[p];
            a = dp4a_(w.x, x.x, a); a = dp4a_(w.y, x.y, a);
            a = dp4a_(w.z, x.z, a); a = dp4a_(w.w, x.w, a);
            acc[p] = a;
        }
    }
    __shared__ int red[3][256];
    for (int p = 0; p < 3; p++) red[p][lane] = acc[p];
    __syncthreads();
    if (lane == 0) { int s = 0; for (int p = 0; p < 3; p++) for (int i = 0; i < blockDim.x; i++) s += red[p][i]; Y[j] = s; }
}

/* int6 lane: 32 weights per 24-byte block + one uint16 multiplier. Unpack to
 * 8 int32 words of 4 int8 each, then the same dp4a, then scale by m. */
__global__ void gemm_i6(const uint8_t *__restrict__ Q, const uint16_t *__restrict__ M,
                        const int4 *__restrict__ X, int nblk, int N, int *__restrict__ Y) {
    const int j = blockIdx.x;
    const int lane = threadIdx.x;
    int acc[3] = {0, 0, 0};
    const uint8_t *qrow = Q + (size_t)j * nblk * 24;
    const uint16_t *mrow = M + (size_t)j * nblk;
    for (int b = lane; b < nblk; b += blockDim.x) {
        const uint8_t *qb = qrow + (size_t)b * 24;
        /* 24 bytes as six uint32 loads (the row base is 24-byte aligned only
         * every 4 blocks, so this is the honest unaligned form). */
        uint32_t r[6];
#pragma unroll
        for (int i = 0; i < 6; i++)
            r[i] = (uint32_t)qb[4*i] | ((uint32_t)qb[4*i+1] << 8) | ((uint32_t)qb[4*i+2] << 16) | ((uint32_t)qb[4*i+3] << 24);
        /* 32 six-bit fields -> 8 words of 4 bytes. The +32 bias is NOT
         * subtracted per value: sum (q+32)*x = sum q*x + 32*sum x, so the bias
         * comes out once per block as a correction against the activation sum.
         * Each group of 4 values lives in 3 bytes, so one 24-bit window gives
         * four byte lanes with 4 ands, 3 shifts and 3 ors -- the form the
         * compiler can fold into LOP3. */
        int wv[8];
#pragma unroll
        for (int g = 0; g < 8; g++) {
            const int bitbase = g * 24;                 /* 4 values * 6 bits */
            const int wi = bitbase >> 5, off = bitbase & 31;
            uint32_t w = r[wi] >> off;
            if (off > 8) w |= r[wi + 1] << (32 - off);   /* 24-bit window */
            wv[g] = (int)((w & 0x3fu) | ((w & (0x3fu << 6)) << 2) |
                          ((w & (0x3fu << 12)) << 4) | ((w & (0x3fu << 18)) << 6));
        }
        const int mm = (int)__ldg(mrow + b);
        const int4 *xb = X + (size_t)b * 8;
#pragma unroll
        for (int p = 0; p < 3; p++) {
            const int4 *xp = xb + (size_t)p * nblk * 8;
            int a = 0, sx = 0;                          /* sum q*x, and sum x */
#pragma unroll
            for (int q4 = 0; q4 < 2; q4++) {
                const int4 x0 = __ldg(xp + q4 * 4 + 0), x1 = __ldg(xp + q4 * 4 + 1);
                a = dp4a_(wv[q4 * 4 + 0], x0.x, a); a = dp4a_(wv[q4 * 4 + 1], x0.y, a);
                a = dp4a_(wv[q4 * 4 + 2], x0.z, a); a = dp4a_(wv[q4 * 4 + 3], x0.w, a);
                sx = dp4a_(0x01010101, x0.x, sx); sx = dp4a_(0x01010101, x0.y, sx);
                sx = dp4a_(0x01010101, x1.z, sx); sx = dp4a_(0x01010101, x1.w, sx);
            }
            acc[p] += (a - 32 * sx) * mm;               /* undo the +32 bias once */
        }
    }
    __shared__ int red[3][256];
    for (int p = 0; p < 3; p++) red[p][lane] = acc[p];
    __syncthreads();
    if (lane == 0) { int s = 0; for (int p = 0; p < 3; p++) for (int i = 0; i < blockDim.x; i++) s += red[p][i]; Y[j] = s; }
}

static float time_ms(void (*launch)(void), int reps) {
    cudaEvent_t a, b; cudaEventCreate(&a); cudaEventCreate(&b);
    launch(); cudaDeviceSynchronize();
    cudaEventRecord(a);
    for (int i = 0; i < reps; i++) launch();
    cudaEventRecord(b); cudaEventSynchronize(b);
    float ms = 0; cudaEventElapsedTime(&ms, a, b);
    cudaEventDestroy(a); cudaEventDestroy(b);
    return ms / reps;
}

static int K_, N_, nblk_, K16_;
static int4 *dW_; static uint8_t *dQ_; static uint16_t *dM_; static int4 *dX_; static int *dY_;
static void l_i8(void) { gemm_i8<<<N_, 256>>>(dW_, dX_, K16_, N_, dY_); }
static void l_i6(void) { gemm_i6<<<N_, 256>>>(dQ_, dM_, dX_, nblk_, N_, dY_); }

int main(int argc, char **argv) {
    struct { int K, N; const char *name; } shapes[] = {
        {5120, 17408, "27B gate|up"}, {17408, 5120, "27B down"},
        {5120, 10240, "27B qkv"},     {5120, 248320, "27B lm_head"},
    };
    printf("%-14s %7s %7s | %9s %9s | %8s %8s | %s\n",
           "shape", "K", "N", "int8 us", "int6 us", "i8 GB/s", "i6 GB/s", "verdict");
    for (auto &s : shapes) {
        K_ = s.K; N_ = s.N; K16_ = K_ / 16; nblk_ = K_ / 32;
        const size_t wb = (size_t)K_ * N_, qb = (size_t)nblk_ * 24 * N_, mb = (size_t)nblk_ * 2 * N_;
        CK(cudaMalloc(&dW_, wb)); CK(cudaMalloc(&dQ_, qb)); CK(cudaMalloc(&dM_, mb));
        CK(cudaMalloc(&dX_, (size_t)3 * K_)); CK(cudaMalloc(&dY_, (size_t)N_ * 4));
        CK(cudaMemset(dW_, 3, wb)); CK(cudaMemset(dQ_, 0x24, qb));
        CK(cudaMemset(dM_, 1, mb)); CK(cudaMemset(dX_, 2, (size_t)3 * K_));
        const int reps = N_ > 100000 ? 20 : 60;
        const float t8 = time_ms(l_i8, reps), t6 = time_ms(l_i6, reps);
        const double g8 = (wb + 3.0 * K_) / (t8 * 1e-3) / 1e9, g6 = (qb + mb + 3.0 * K_) / (t6 * 1e-3) / 1e9;
        printf("%-14s %7d %7d | %9.1f %9.1f | %8.0f %8.0f | %s\n", s.name, K_, N_,
               t8 * 1e3, t6 * 1e3, g8, g6, t6 < t8 ? "int6 FASTER" : "int6 slower");
        cudaFree(dW_); cudaFree(dQ_); cudaFree(dM_); cudaFree(dX_); cudaFree(dY_);
    }
    return 0;
}
