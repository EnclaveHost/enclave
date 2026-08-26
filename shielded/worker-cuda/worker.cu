/*
 * worker.cu -- the shielded GPU worker, in C++/CUDA. Runs on the UNTRUSTED
 * host, holds the card.
 *
 * This is the production form of shielded/worker.py: the same wire protocol,
 * the same admission rules (protocol.py is the reference and the tests pin it),
 * the same trust posture. Read the header of worker.py before touching the
 * rules here; this file adds nothing to them and removes nothing from them.
 *
 * WHY IT EXISTS
 * -------------
 * Decode is a chain of ~2 masked exchanges per layer, and the chain is strictly
 * sequential: layer 2's input is a nonlinear function of layer 1's output, so
 * nothing can be pipelined across it. The per-token cost is therefore
 *
 *     (exchanges per token) x (cost of one exchange)
 *
 * and the Python worker's cost per exchange -- five framed commands, each going
 * through the interpreter, torch's dispatcher and a Triton launch -- measured
 * 0.35 ms on loopback. At ~50 exchanges per token that is 17 ms before the GPU
 * has done any work, against a whole-token budget of 14 ms. This worker does one
 * exchange in one frame, one H2D copy, one kernel per node, one D2H copy, and
 * one send, with no interpreter anywhere on the path.
 *
 * WHAT IT COMPUTES
 * ----------------
 * FIELD_GEMM: y = (x+r) . W over Z_M for a one-time pad r it never receives.
 * The activation arrives as three int8 residue planes (one per byte prime), the
 * weight is the fixed-point int8 w_fixed the TEE also holds (|w| <= 119, so
 * w mod q == w for every prime and one weight serves all three planes), and the
 * kernel accumulates each plane with dp4a and recombines the three residues by
 * Garner CRT in the epilogue. One int32 per output. The TEE subtracts u = r.W.
 *
 * The weight layout is GGUF's own: one row per OUTPUT, K contiguous bytes. A
 * decode GEMV is then N dot products over contiguous rows, which is the shape a
 * GPU reads at full bandwidth, and the TEE never transposes anything.
 *
 * TWO WAYS TO SUPPLY A WEIGHT
 * ---------------------------
 * A node may carry "w" (the encoded int8 matrix, (N,K)) or the legacy pair
 * "wq"/"wd" (q8_0 quants (K,N) and fp16 scales (K/32,N)), in which case this
 * worker runs THE shared encoding (shielded-field.c, the same object the TEE
 * links) at install time. The legacy form is what metal/guest/shielded-probe.mjs
 * sends at boot; the engine backend sends "w" because it already has it.
 *
 * FAIL CLOSED. Every malformed frame, unknown command, unlisted op, out-of-range
 * region or undeclared read terminates the connection with a named reason. A
 * dead CUDA context terminates the PROCESS (exit 70) so the launcher can build a
 * fresh one -- see the note in worker.py about the MPS server going away.
 */
#include <cuda_runtime.h>

#include <arpa/inet.h>
#include <errno.h>
#include <linux/vm_sockets.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <tuple>
#include <vector>

extern "C" {
#include "shielded-field.h"
}

/* ---------------------------------------------------------------------------
 * Protocol constants. Mirror protocol.py exactly.
 * ------------------------------------------------------------------------ */
enum : uint8_t {
    CMD_HELLO = 0, CMD_ALLOC_BUFFER = 1, CMD_FREE_BUFFER = 2, CMD_BUFFER_GET_BASE = 3,
    CMD_GET_ALIGNMENT = 4, CMD_GET_MAX_SIZE = 5, CMD_GET_DEVICE_MEMORY = 6, CMD_DEVICE_COUNT = 7,
    CMD_SET_TENSOR = 8, CMD_GET_TENSOR = 9, CMD_GRAPH_INSTALL = 10, CMD_GRAPH_RECOMPUTE = 11,
    CMD_FIELD_GEMM = 12,
    CMD_COUNT = 13,
};
static const int PROTO_MAJOR = 1, PROTO_MINOR = 1, PROTO_PATCH = 0;
static const uint8_t STATUS_OK = 0, STATUS_VIOLATION = 1;
static const size_t MAX_FRAME = (size_t)256 << 20;
static const size_t SH_HDR = 9;

static const char *OP_ALLOWLIST[] = { "FIELD_GEMM", "VIEW", "RESHAPE", "PERMUTE", "TRANSPOSE", "CONT", "CPY" };
static const std::pair<const char *, const char *> OP_DENYLIST[] = {
    { "SOFT_MAX", "nonlinear on secret data; TEE-only" },
    { "RMS_NORM", "nonlinear on secret data; TEE-only" },
    { "NORM", "nonlinear on secret data; TEE-only" },
    { "SILU", "nonlinear on secret data; TEE-only" },
    { "GELU", "nonlinear on secret data; TEE-only" },
    { "ROPE", "consumes token positions; TEE-only" },
    { "FLASH_ATTN_EXT", "activation-activation product; TwinShield m=1 is broken" },
    { "MUL_MAT", "plain matmul would run on UNMASKED data; use FIELD_GEMM" },
    { "ARGSORT", "sampling-adjacent; TEE-only" },
    { "GET_ROWS", "embedding gather keyed by a secret token id; TEE-only" },
};

struct Violation {
    std::string why;
    explicit Violation(std::string w) : why(std::move(w)) {}
};
static std::string fmt(const char *f, ...) {
    char buf[1024]; va_list ap; va_start(ap, f); vsnprintf(buf, sizeof buf, f, ap); va_end(ap);
    return buf;
}
#define VIOLATE(...) throw Violation(fmt(__VA_ARGS__))

static bool g_quiet = false;
static void logf(const char *f, ...) {
    if (g_quiet) return;
    char buf[1024]; va_list ap; va_start(ap, f); vsnprintf(buf, sizeof buf, f, ap); va_end(ap);
    fprintf(stdout, "[shielded-worker] %s\n", buf); fflush(stdout);
}

/* ---------------------------------------------------------------------------
 * CUDA errors. A bad request is refused; a broken context kills the process.
 * ------------------------------------------------------------------------ */
static bool fatal_cuda(cudaError_t e) {
    switch (e) {
        case cudaErrorIllegalAddress: case cudaErrorLaunchFailure: case cudaErrorAssert:
        case cudaErrorHardwareStackError: case cudaErrorIllegalInstruction:
        case cudaErrorMisalignedAddress: case cudaErrorInvalidAddressSpace:
        case cudaErrorInvalidPc: case cudaErrorECCUncorrectable: case cudaErrorMpsRpcFailure:
        case cudaErrorMpsServerNotReady: case cudaErrorMpsConnectionFailed:
        case cudaErrorUnknown: case cudaErrorDeviceUninitialized:
            return true;
        default: return false;
    }
}
static void ck(cudaError_t e, const char *what) {
    if (e == cudaSuccess) return;
    const char *msg = cudaGetErrorString(e);
    if (fatal_cuda(e)) {
        fprintf(stderr, "[shielded-worker] FATAL: %s: %s. The CUDA context is gone; exiting so "
                        "the launcher can restart with a fresh one.\n", what, msg);
        fflush(stderr);
        _exit(70);
    }
    VIOLATE("internal: %s: %s", what, msg);
}

/* ---------------------------------------------------------------------------
 * The kernel.
 *
 * One warp per output row j. Lanes stride over K in 16-byte steps, so a warp
 * pulls 512 contiguous bytes of W per iteration -- the coalesced, bandwidth-
 * saturating shape. The masked activation rows (up to ROWS of them, three
 * planes each) sit in shared memory, loaded once per block. Each lane keeps
 * 3 x ROWS int32 accumulators fed by dp4a; a shuffle reduction and the CRT
 * finish the row.
 *
 * Accumulator range: |x_p| <= 125, |w| <= 119, so K terms reach K * 14875 --
 * under 2^31 for any K below 144k. No chunking, no saturation.
 * ------------------------------------------------------------------------ */
#define KQ0 251
#define KQ1 241
#define KQ2 239
#define KM  ((long long)KQ0 * KQ1 * KQ2)
#define KINV01  217   /* inv(251 mod 241) mod 241 -- checked against the host at startup */
#define KINV012 10    /* inv(251*241 mod 239) mod 239 */

__device__ __forceinline__ int32_t crt3(int32_t a0, int32_t a1, int32_t a2) {
    int r0 = a0 % KQ0; if (r0 < 0) r0 += KQ0;
    int r1 = a1 % KQ1; if (r1 < 0) r1 += KQ1;
    int r2 = a2 % KQ2; if (r2 < 0) r2 += KQ2;
    int t1 = (r1 - r0) % KQ1; if (t1 < 0) t1 += KQ1;
    t1 = (t1 * KINV01) % KQ1;
    long long x = r0 + (long long)KQ0 * t1;
    int t2 = (int)((r2 - x) % KQ2); if (t2 < 0) t2 += KQ2;
    t2 = (t2 * KINV012) % KQ2;
    x += (long long)KQ0 * KQ1 * t2;
    if (x > KM / 2) x -= KM;
    return (int32_t)x;
}

template <int ROWS>
__global__ void __launch_bounds__(256)
field_gemv_kernel(const int8_t *__restrict__ W, int K, int N,
                  const int8_t *__restrict__ X, long long xstride, long long pstride,
                  int32_t *__restrict__ Y, long long ystride) {
    extern __shared__ int4 xs[];                 /* [3][ROWS][K/16] */
    const int K16 = K >> 4;
    for (int i = threadIdx.x; i < 3 * ROWS * K16; i += blockDim.x) {
        const int p = i / (ROWS * K16);
        const int rem = i - p * ROWS * K16;
        const int r = rem / K16, k16 = rem - r * K16;
        xs[i] = *reinterpret_cast<const int4 *>(X + p * pstride + r * xstride + (long long)k16 * 16);
    }
    __syncthreads();

    const int warp = threadIdx.x >> 5, lane = threadIdx.x & 31;
    const int j = blockIdx.x * 8 + warp;
    if (j >= N) return;
    const int4 *wrow = reinterpret_cast<const int4 *>(W + (size_t)j * K);

    int acc[3][ROWS];
#pragma unroll
    for (int p = 0; p < 3; p++)
#pragma unroll
        for (int r = 0; r < ROWS; r++) acc[p][r] = 0;

    for (int k16 = lane; k16 < K16; k16 += 32) {
        const int4 w = __ldg(wrow + k16);
#pragma unroll
        for (int p = 0; p < 3; p++)
#pragma unroll
            for (int r = 0; r < ROWS; r++) {
                const int4 x = xs[(p * ROWS + r) * K16 + k16];
                int a = acc[p][r];
                a = __dp4a(w.x, x.x, a); a = __dp4a(w.y, x.y, a);
                a = __dp4a(w.z, x.z, a); a = __dp4a(w.w, x.w, a);
                acc[p][r] = a;
            }
    }
#pragma unroll
    for (int p = 0; p < 3; p++)
#pragma unroll
        for (int r = 0; r < ROWS; r++) {
            int a = acc[p][r];
            for (int o = 16; o > 0; o >>= 1) a += __shfl_xor_sync(0xffffffffu, a, o);
            acc[p][r] = a;
        }
    if (lane == 0) {
#pragma unroll
        for (int r = 0; r < ROWS; r++)
            Y[r * ystride + j] = crt3(acc[0][r], acc[1][r], acc[2][r]);
    }
}

static size_t g_smem_limit = 48 * 1024;

template <int ROWS>
static void launch_rows(const int8_t *W, int K, int N, const int8_t *X, long long xstride,
                        long long pstride, int32_t *Y, long long ystride, cudaStream_t s) {
    const size_t smem = (size_t)3 * ROWS * K;
    const dim3 grid((N + 7) / 8);
    field_gemv_kernel<ROWS><<<grid, 256, smem, s>>>(W, K, N, X, xstride, pstride, Y, ystride);
}

/* y[m][N] = (planes . W) for m rows. Rows are processed in passes of up to 8,
 * as many as the activation fits in shared memory for this K. */
static void field_gemm_launch(const int8_t *W, int K, int N, const int8_t *X, int m,
                              long long xstride, long long pstride, int32_t *Y, long long ystride,
                              cudaStream_t s) {
    int row0 = 0;
    while (row0 < m) {
        const int left = m - row0;
        const int8_t *x = X + row0 * xstride;
        int32_t *y = Y + row0 * ystride;
        int rows;
        if (left >= 8 && (size_t)3 * 8 * K <= g_smem_limit) { rows = 8; launch_rows<8>(W, K, N, x, xstride, pstride, y, ystride, s); }
        else if (left >= 4 && (size_t)3 * 4 * K <= g_smem_limit) { rows = 4; launch_rows<4>(W, K, N, x, xstride, pstride, y, ystride, s); }
        else if (left >= 2 && (size_t)3 * 2 * K <= g_smem_limit) { rows = 2; launch_rows<2>(W, K, N, x, xstride, pstride, y, ystride, s); }
        else { rows = 1; launch_rows<1>(W, K, N, x, xstride, pstride, y, ystride, s); }
        ck(cudaGetLastError(), "kernel launch");
        row0 += rows;
    }
}

static void kernel_init() {
    int dev = 0; ck(cudaGetDevice(&dev), "cudaGetDevice");
    int optin = 0;
    cudaDeviceGetAttribute(&optin, cudaDevAttrMaxSharedMemoryPerBlockOptin, dev);
    if (optin > 48 * 1024) {
        const int want = std::min(optin, 96 * 1024);
        cudaFuncSetAttribute(field_gemv_kernel<8>, cudaFuncAttributeMaxDynamicSharedMemorySize, want);
        cudaFuncSetAttribute(field_gemv_kernel<4>, cudaFuncAttributeMaxDynamicSharedMemorySize, want);
        cudaFuncSetAttribute(field_gemv_kernel<2>, cudaFuncAttributeMaxDynamicSharedMemorySize, want);
        cudaFuncSetAttribute(field_gemv_kernel<1>, cudaFuncAttributeMaxDynamicSharedMemorySize, want);
        g_smem_limit = (size_t)want;
    }
}

/* ---------------------------------------------------------------------------
 * Startup self-test: the kernel against an int64 reference, and the CRT
 * constants against the host's. A worker whose arithmetic is wrong is caught by
 * Freivalds in the TEE anyway -- but it would be caught on every request, which
 * is a very expensive way to learn about a typo in KINV01.
 * ------------------------------------------------------------------------ */
static bool selftest() {
    const int K = 96, N = 37, m = 5;
    std::vector<int8_t> W((size_t)N * K), X((size_t)3 * m * K);
    std::vector<int64_t> xr((size_t)m * K);
    uint64_t seed = 0x9e3779b97f4a7c15ull;
    auto rnd = [&]() { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; return seed; };
    for (auto &w : W) w = (int8_t)((int)(rnd() % 239) - 119);
    for (int i = 0; i < m * K; i++) {
        xr[i] = (int64_t)(rnd() % (uint64_t)SH_M_MOD);
        for (int p = 0; p < 3; p++) X[(size_t)p * m * K + i] = sh_residue(xr[i], sh_primes[p]);
    }
    std::vector<int32_t> ref((size_t)m * N);
    for (int r = 0; r < m; r++)
        for (int j = 0; j < N; j++) {
            int64_t acc = 0;
            for (int k = 0; k < K; k++) acc += xr[(size_t)r * K + k] * W[(size_t)j * K + k];
            ref[(size_t)r * N + j] = (int32_t)sh_balanced(acc);
        }
    int8_t *dW = nullptr, *dX = nullptr; int32_t *dY = nullptr;
    ck(cudaMalloc(&dW, W.size()), "selftest malloc");
    ck(cudaMalloc(&dX, X.size()), "selftest malloc");
    ck(cudaMalloc(&dY, ref.size() * 4), "selftest malloc");
    ck(cudaMemcpy(dW, W.data(), W.size(), cudaMemcpyHostToDevice), "selftest copy");
    ck(cudaMemcpy(dX, X.data(), X.size(), cudaMemcpyHostToDevice), "selftest copy");
    field_gemm_launch(dW, K, N, dX, m, K, (long long)m * K, dY, N, 0);
    std::vector<int32_t> got(ref.size());
    ck(cudaMemcpy(got.data(), dY, got.size() * 4, cudaMemcpyDeviceToHost), "selftest readback");
    cudaFree(dW); cudaFree(dX); cudaFree(dY);
    /* The int64 product is far outside Z_M here; balanced() folds it, which is
     * exactly what the GPU's residue arithmetic does implicitly. */
    for (size_t i = 0; i < ref.size(); i++)
        if (got[i] != ref[i]) {
            fprintf(stderr, "[shielded-worker] SELFTEST FAILED at %zu: gpu %d ref %d\n", i, got[i], ref[i]);
            return false;
        }
    /* CRT constants vs the host's Garner. */
    for (int t = 0; t < 1000; t++) {
        const int64_t v = (int64_t)(rnd() % (uint64_t)SH_M_MOD);
        const int64_t h = sh_crt(sh_residue(v, SH_Q0), sh_residue(v, SH_Q1), sh_residue(v, SH_Q2));
        if (h != sh_balanced(v)) { fprintf(stderr, "[shielded-worker] host CRT disagrees with itself\n"); return false; }
    }
    return true;
}

/* Field GEMM throughput on this card, G-MAC/s, on the decode-shaped kernel.
 * Reported in HELLO and advertised to the fleet as this card's rate for the
 * operation it actually performs -- not a spec-sheet FP16 number. */
static double measure_gmacs() {
    const int K = 4096, N = 4096, m = 8, iters = 20;
    int8_t *dW = nullptr, *dX = nullptr; int32_t *dY = nullptr;
    if (cudaMalloc(&dW, (size_t)N * K) != cudaSuccess) return 0.0;
    if (cudaMalloc(&dX, (size_t)3 * m * K) != cudaSuccess) { cudaFree(dW); return 0.0; }
    if (cudaMalloc(&dY, (size_t)m * N * 4) != cudaSuccess) { cudaFree(dW); cudaFree(dX); return 0.0; }
    cudaMemset(dW, 1, (size_t)N * K); cudaMemset(dX, 1, (size_t)3 * m * K);
    for (int i = 0; i < 3; i++) field_gemm_launch(dW, K, N, dX, m, K, (long long)m * K, dY, N, 0);
    cudaDeviceSynchronize();
    const auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < iters; i++) field_gemm_launch(dW, K, N, dX, m, K, (long long)m * K, dY, N, 0);
    cudaDeviceSynchronize();
    const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    cudaFree(dW); cudaFree(dX); cudaFree(dY);
    return dt > 0 ? (double)m * K * N * iters / dt / 1e9 : 0.0;
}

/* ---------------------------------------------------------------------------
 * A JSON reader for the install spec: objects, arrays, strings, numbers, the
 * three literals. Nothing else is needed and nothing else is accepted.
 * ------------------------------------------------------------------------ */
struct JVal {
    enum Kind { NUL, BOOL, NUM, STR, ARR, OBJ } kind = NUL;
    bool b = false; double num = 0; std::string str;
    std::vector<JVal> arr; std::vector<std::pair<std::string, JVal>> obj;
    const JVal *get(const char *k) const {
        if (kind != OBJ) return nullptr;
        for (auto &kv : obj) if (kv.first == k) return &kv.second;
        return nullptr;
    }
    int64_t i64(const char *k) const {
        const JVal *v = get(k);
        if (!v || v->kind != NUM) VIOLATE("graph spec: missing or non-numeric %s", k);
        return (int64_t)v->num;
    }
};
struct JParser {
    const char *p, *end;
    void ws() { while (p < end && (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t')) p++; }
    bool eat(char c) { ws(); if (p < end && *p == c) { p++; return true; } return false; }
    JVal parse() {
        ws();
        if (p >= end) VIOLATE("malformed graph spec: truncated");
        JVal v;
        if (*p == '{') {
            p++; v.kind = JVal::OBJ;
            if (eat('}')) return v;
            for (;;) {
                ws(); if (p >= end || *p != '"') VIOLATE("malformed graph spec: key");
                std::string k = parse_str();
                if (!eat(':')) VIOLATE("malformed graph spec: colon");
                JVal val = parse();
                v.obj.emplace_back(std::move(k), std::move(val));
                if (eat(',')) continue;
                if (eat('}')) return v;
                VIOLATE("malformed graph spec: object");
            }
        }
        if (*p == '[') {
            p++; v.kind = JVal::ARR;
            if (eat(']')) return v;
            for (;;) {
                v.arr.push_back(parse());
                if (eat(',')) continue;
                if (eat(']')) return v;
                VIOLATE("malformed graph spec: array");
            }
        }
        if (*p == '"') { v.kind = JVal::STR; v.str = parse_str(); return v; }
        if (!strncmp(p, "true", 4) && end - p >= 4) { p += 4; v.kind = JVal::BOOL; v.b = true; return v; }
        if (!strncmp(p, "false", 5) && end - p >= 5) { p += 5; v.kind = JVal::BOOL; return v; }
        if (!strncmp(p, "null", 4) && end - p >= 4) { p += 4; return v; }
        char *e = nullptr;
        v.num = strtod(p, &e);
        if (e == p) VIOLATE("malformed graph spec: token");
        p = e; v.kind = JVal::NUM; return v;
    }
    std::string parse_str() {
        p++; std::string s;
        while (p < end && *p != '"') {
            if (*p == '\\') {
                p++; if (p >= end) break;
                switch (*p) { case 'n': s += '\n'; break; case 't': s += '\t'; break;
                              case 'u': p += 4; s += '?'; break; default: s += *p; }
            } else s += *p;
            p++;
        }
        if (p >= end) VIOLATE("malformed graph spec: string");
        p++; return s;
    }
};

/* ---------------------------------------------------------------------------
 * Socket helpers. Frames: | cmd u8 | size u64 LE | payload |, responses
 * | status u8 | size u64 LE | payload |. A violation is the last frame.
 * ------------------------------------------------------------------------ */
static bool read_exact(int fd, void *buf, size_t n) {
    uint8_t *p = (uint8_t *)buf;
    while (n) {
        ssize_t r = read(fd, p, n);
        if (r < 0) { if (errno == EINTR) continue; return false; }
        if (r == 0) return false;
        p += r; n -= (size_t)r;
    }
    return true;
}
static bool write_all(int fd, const void *buf, size_t n) {
    const uint8_t *p = (const uint8_t *)buf;
    while (n) {
        ssize_t r = write(fd, p, n);
        if (r < 0) { if (errno == EINTR) continue; return false; }
        p += r; n -= (size_t)r;
    }
    return true;
}
static uint64_t rd_u64(const uint8_t *p) { uint64_t v = 0; for (int i = 0; i < 8; i++) v |= (uint64_t)p[i] << (8 * i); return v; }
static uint32_t rd_u32(const uint8_t *p) { uint32_t v = 0; for (int i = 0; i < 4; i++) v |= (uint32_t)p[i] << (8 * i); return v; }
static void wr_u64(uint8_t *p, uint64_t v) { for (int i = 0; i < 8; i++) p[i] = (uint8_t)(v >> (8 * i)); }
static void wr_u32(uint8_t *p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i)); }

/* ---------------------------------------------------------------------------
 * Per-connection state: the admission rules of protocol.py, plus the storage
 * they gate. Buffers, graph and scratch die with the connection; only the
 * process-wide card survives.
 * ------------------------------------------------------------------------ */
static std::mutex g_gpu;                 /* one kernel stream at a time */
static long long g_vram_budget = 0;
static double g_gmacs = 0.0;
static cudaDeviceProp g_props;

struct Buffer {
    uint64_t bid = 0, size = 0;
    std::string role;
    int8_t *dev = nullptr;               /* activations: device-resident */
    std::vector<uint8_t> host;           /* weights: host-resident until install */
};
struct Node {
    std::string id;
    bool gemm = false;
    int8_t *w = nullptr;                 /* (N,K) int8 on the device */
    int64_t K = 0, N = 0; int max_m = 0;
    uint64_t xbid = 0, xoff = 0, ybid = 0, yoff = 0;
};

struct Conn {
    int fd;
    std::string peer;
    bool hello_done = false, installed = false;
    std::map<uint64_t, Buffer> buffers;
    uint64_t next_bid = 1;
    long long allocated = 0;
    std::vector<Node> nodes;
    std::set<std::tuple<uint64_t, uint64_t, uint64_t>> outputs;
    cudaStream_t stream = nullptr;
    /* pinned staging for the one-frame exchange */
    uint8_t *h_in = nullptr;  size_t h_in_cap = 0;
    int8_t  *d_x = nullptr;   size_t d_x_cap = 0;
    int32_t *d_y = nullptr;   size_t d_y_cap = 0;
    uint8_t *h_out = nullptr; size_t h_out_cap = 0;
    uint64_t exchanges = 0, recomputes = 0;
    double gemm_ms = 0;

    Conn(int f, std::string p) : fd(f), peer(std::move(p)) {}
    ~Conn() {
        for (auto &kv : buffers) if (kv.second.dev) cudaFree(kv.second.dev);
        for (auto &n : nodes) if (n.w) cudaFree(n.w);
        if (d_x) cudaFree(d_x);
        if (d_y) cudaFree(d_y);
        if (h_in) cudaFreeHost(h_in);
        if (h_out) cudaFreeHost(h_out);
        if (stream) cudaStreamDestroy(stream);
    }

    Buffer &region_ok(uint64_t bid, uint64_t off, uint64_t nbytes) {
        auto it = buffers.find(bid);
        if (it == buffers.end()) VIOLATE("reference to unknown buffer %llu", (unsigned long long)bid);
        Buffer &b = it->second;
        if (off > b.size || nbytes > b.size - off)
            VIOLATE("region [%llu,%llu) outside buffer %llu of %llu",
                    (unsigned long long)off, (unsigned long long)(off + nbytes),
                    (unsigned long long)bid, (unsigned long long)b.size);
        return b;
    }
    void ensure_host_in(size_t n) {
        if (h_in_cap >= n) return;
        if (h_in) cudaFreeHost(h_in);
        ck(cudaHostAlloc((void **)&h_in, n, cudaHostAllocDefault), "pinned alloc"); h_in_cap = n;
    }
    void ensure_host_out(size_t n) {
        if (h_out_cap >= n) return;
        if (h_out) cudaFreeHost(h_out);
        ck(cudaHostAlloc((void **)&h_out, n, cudaHostAllocDefault), "pinned alloc"); h_out_cap = n;
    }
    void ensure_dx(size_t n) {
        if (d_x_cap >= n) return;
        if (d_x) cudaFree(d_x);
        ck(cudaMalloc((void **)&d_x, n), "device scratch alloc"); d_x_cap = n;
    }
    void ensure_dy(size_t n) {
        if (d_y_cap >= n) return;
        if (d_y) cudaFree(d_y);
        ck(cudaMalloc((void **)&d_y, n), "device scratch alloc"); d_y_cap = n;
    }

    std::string hello(const uint8_t *p, size_t n) {
        if (hello_done) VIOLATE("duplicate HELLO");
        if (n < 4) VIOLATE("truncated u32");
        const uint32_t major = rd_u32(p);
        if (major != (uint32_t)PROTO_MAJOR) VIOLATE("protocol major %u != %d", major, PROTO_MAJOR);
        hello_done = true;
        size_t freeb = 0, totalb = 0;
        cudaMemGetInfo(&freeb, &totalb);
        return fmt("{\"version\":[%d,%d,%d],\"device\":\"%s\",\"vram_total\":%llu,\"vram_free\":%llu,"
                   "\"vram_budget\":%lld,\"sm_count\":%d,\"capability\":\"%d.%d\","
                   "\"field_gmac_per_s\":%.1f,\"worker\":\"shielded/worker-cuda\"}",
                   PROTO_MAJOR, PROTO_MINOR, PROTO_PATCH, g_props.name,
                   (unsigned long long)g_props.totalGlobalMem, (unsigned long long)freeb,
                   g_vram_budget, g_props.multiProcessorCount, g_props.major, g_props.minor, g_gmacs);
    }

    std::string alloc(const uint8_t *p, size_t n) {
        if (n < 12) VIOLATE("truncated u64");
        const uint64_t size = rd_u64(p);
        const uint32_t rl = rd_u32(p + 8);
        if (12 + rl > n) VIOLATE("truncated role");
        std::string role((const char *)p + 12, rl);
        if (role != "weights" && role != "activations") VIOLATE("unknown buffer role '%s'", role.c_str());
        if (allocated + (long long)size > g_vram_budget) VIOLATE("allocation exceeds device memory");
        Buffer b; b.bid = next_bid++; b.size = size; b.role = role;
        if (role == "activations") {
            if (cudaMalloc((void **)&b.dev, size ? size : 1) != cudaSuccess)
                VIOLATE("device allocation of %llu failed", (unsigned long long)size);
        } else {
            b.host.assign(size, 0);
        }
        allocated += (long long)size;
        const uint64_t bid = b.bid;
        buffers[bid] = std::move(b);
        std::string r(8, '\0'); wr_u64((uint8_t *)&r[0], bid);
        return r;
    }

    std::string free_buf(const uint8_t *p, size_t n) {
        if (n < 8) VIOLATE("truncated u64");
        const uint64_t bid = rd_u64(p);
        auto it = buffers.find(bid);
        if (it == buffers.end()) VIOLATE("free of unknown buffer %llu", (unsigned long long)bid);
        allocated -= (long long)it->second.size;
        if (it->second.dev) cudaFree(it->second.dev);
        buffers.erase(it);
        return "";
    }

    std::string set_tensor(const uint8_t *p, size_t n) {
        if (n < 24) VIOLATE("truncated u64");
        const uint64_t bid = rd_u64(p), off = rd_u64(p + 8), nbytes = rd_u64(p + 16);
        Buffer &b = region_ok(bid, off, nbytes);
        if (n - 24 != nbytes) VIOLATE("SET_TENSOR declared %llu bytes, frame carries %zu",
                                      (unsigned long long)nbytes, n - 24);
        if (b.dev) {
            std::lock_guard<std::mutex> lk(g_gpu);
            ck(cudaMemcpy(b.dev + off, p + 24, nbytes, cudaMemcpyHostToDevice), "SET_TENSOR copy");
        } else {
            memcpy(b.host.data() + off, p + 24, nbytes);
        }
        return "";
    }

    std::string get_tensor(const uint8_t *p, size_t n) {
        if (n < 24) VIOLATE("truncated u64");
        const uint64_t bid = rd_u64(p), off = rd_u64(p + 8), nbytes = rd_u64(p + 16);
        Buffer &b = region_ok(bid, off, nbytes);
        if (!installed) VIOLATE("GET_TENSOR before any graph was installed");
        if (!outputs.count(std::make_tuple(bid, off, nbytes)))
            VIOLATE("GET_TENSOR region (%llu,%llu,%llu) is not a declared graph output",
                    (unsigned long long)bid, (unsigned long long)off, (unsigned long long)nbytes);
        std::string out(nbytes, '\0');
        if (b.dev) {
            std::lock_guard<std::mutex> lk(g_gpu);
            ck(cudaMemcpy(&out[0], b.dev + off, nbytes, cudaMemcpyDeviceToHost), "GET_TENSOR copy");
        } else {
            memcpy(&out[0], b.host.data() + off, nbytes);
        }
        return out;
    }

    /* Bind every allowlisted node to real storage, or refuse the graph. The
     * invariant that matters: weights come from a 'weights' buffer and
     * activations from an 'activations' buffer, so a masked activation can never
     * be treated as public data by declaring it a weight operand. */
    std::string graph_install(const uint8_t *p, size_t n) {
        if (installed) VIOLATE("graph already installed; reconnect to replace");
        JParser jp{ (const char *)p, (const char *)p + n };
        JVal spec = jp.parse();
        const JVal *jn = spec.get("nodes");
        if (!jn || jn->kind != JVal::ARR || jn->arr.empty()) VIOLATE("graph spec has no nodes");
        std::vector<Node> nn;
        for (size_t i = 0; i < jn->arr.size(); i++) {
            const JVal &nd = jn->arr[i];
            const JVal *op = nd.get("op");
            const std::string ops = (op && op->kind == JVal::STR) ? op->str : "";
            for (auto &d : OP_DENYLIST) if (ops == d.first) VIOLATE("node %zu: op %s refused (%s)", i, ops.c_str(), d.second);
            bool allowed = false;
            for (auto a : OP_ALLOWLIST) if (ops == a) allowed = true;
            if (!allowed) VIOLATE("node %zu: op '%s' not in allowlist", i, ops.c_str());
            Node node;
            const JVal *id = nd.get("id");
            node.id = (id && id->kind == JVal::STR) ? id->str : fmt("node%zu", i);
            if (ops != "FIELD_GEMM") { nn.push_back(std::move(node)); continue; }   /* metadata-only */
            node.gemm = true;
            node.K = nd.i64("K"); node.N = nd.i64("N"); node.max_m = (int)nd.i64("max_m");
            if (node.K <= 0 || node.N <= 0 || node.max_m <= 0) VIOLATE("node %zu: non-positive shape", i);
            if (node.K % SH_QK) VIOLATE("node %zu: K=%lld is not a multiple of %d", i, (long long)node.K, SH_QK);
            if (node.max_m > 4096) VIOLATE("node %zu: max_m=%d exceeds 4096", i, node.max_m);
            const JVal *x = nd.get("x"), *y = nd.get("y");
            if (!x || !y) VIOLATE("node %zu: missing x/y binding", i);
            node.xbid = (uint64_t)x->i64("bid"); node.xoff = (uint64_t)x->i64("offset");
            node.ybid = (uint64_t)y->i64("bid"); node.yoff = (uint64_t)y->i64("offset");
            Buffer &xb = region_ok(node.xbid, node.xoff, (uint64_t)3 * node.max_m * node.K);
            Buffer &yb = region_ok(node.ybid, node.yoff, (uint64_t)node.max_m * node.N * 4);
            if (xb.role != "activations" || yb.role != "activations")
                VIOLATE("node %zu: x/y must bind an 'activations' buffer", i);
            if (node.xoff % 16 || node.yoff % 4) VIOLATE("node %zu: misaligned x/y offset", i);

            std::vector<int8_t> wfix((size_t)node.N * node.K);
            if (const JVal *w = nd.get("w")) {
                Buffer &wb = region_ok((uint64_t)w->i64("bid"), (uint64_t)w->i64("offset"), wfix.size());
                if (wb.role != "weights") VIOLATE("node %zu: w must bind a 'weights' buffer", i);
                memcpy(wfix.data(), wb.host.data() + (uint64_t)w->i64("offset"), wfix.size());
                for (size_t t = 0; t < wfix.size(); t++)
                    if (wfix[t] > SH_WEIGHT_BYTE_LIMIT || wfix[t] < -SH_WEIGHT_BYTE_LIMIT)
                        VIOLATE("node %zu: weight %d exceeds the int8 lane", i, (int)wfix[t]);
            } else {
                const JVal *wq = nd.get("wq"), *wd = nd.get("wd");
                if (!wq || !wd) VIOLATE("node %zu: missing weight binding", i);
                const int64_t nb = node.K / SH_QK;
                Buffer &qb = region_ok((uint64_t)wq->i64("bid"), (uint64_t)wq->i64("offset"), (uint64_t)node.K * node.N);
                Buffer &db = region_ok((uint64_t)wd->i64("bid"), (uint64_t)wd->i64("offset"), (uint64_t)nb * node.N * 2);
                if (qb.role != "weights" || db.role != "weights") VIOLATE("node %zu: wq/wd must bind a 'weights' buffer", i);
                if ((uint64_t)wd->i64("offset") % 2) VIOLATE("node %zu: misaligned wd offset", i);
                const int8_t *q = (const int8_t *)qb.host.data() + (uint64_t)wq->i64("offset");
                const uint16_t *d = (const uint16_t *)(db.host.data() + (uint64_t)wd->i64("offset"));
                /* THE shared encoding, run here by the same object the TEE links. */
                for (int64_t k = 0; k < node.K; k++)
                    for (int64_t j = 0; j < node.N; j++) {
                        const int64_t v = sh_encode_weight_fixed(d[(k / SH_QK) * node.N + j], q[k * node.N + j]);
                        if (v > SH_WEIGHT_BYTE_LIMIT || v < -SH_WEIGHT_BYTE_LIMIT)
                            VIOLATE("node %zu: fixed weight %lld exceeds the int8 lane", i, (long long)v);
                        wfix[(size_t)j * node.K + k] = (int8_t)v;
                    }
            }
            {
                std::lock_guard<std::mutex> lk(g_gpu);
                if (cudaMalloc((void **)&node.w, wfix.size()) != cudaSuccess)
                    VIOLATE("node %zu: device allocation of %zu weight bytes failed", i, wfix.size());
                ck(cudaMemcpy(node.w, wfix.data(), wfix.size(), cudaMemcpyHostToDevice), "weight upload");
            }
            nn.push_back(std::move(node));
        }
        bool any = false;
        for (auto &x : nn) any |= x.gemm;
        if (!any) VIOLATE("graph contains no computable node");
        const JVal *jo = spec.get("outputs");
        std::set<std::tuple<uint64_t, uint64_t, uint64_t>> outs;
        if (jo && jo->kind == JVal::ARR)
            for (auto &o : jo->arr) {
                const uint64_t bid = (uint64_t)o.i64("bid"), off = (uint64_t)o.i64("offset"), nb = (uint64_t)o.i64("nbytes");
                region_ok(bid, off, nb);
                outs.insert(std::make_tuple(bid, off, nb));
            }
        if (outs.empty()) VIOLATE("graph declares no outputs; nothing could be read back");
        /* The weights buffers' host copies are no longer needed once every node
         * has its device-resident encoding. */
        for (auto &kv : buffers) if (!kv.second.dev) { std::vector<uint8_t>().swap(kv.second.host); }
        nodes = std::move(nn); outputs = std::move(outs); installed = true;
        return fmt("{\"nodes\":%zu}", nodes.size());
    }

    Node &node_ok(uint32_t idx) {
        if (!installed) VIOLATE("RECOMPUTE with no installed graph");
        if (idx >= nodes.size()) VIOLATE("recompute of node %u, graph has %zu", idx, nodes.size());
        Node &nd = nodes[idx];
        if (!nd.gemm) VIOLATE("node %u is metadata-only; nothing to compute", idx);
        return nd;
    }

    /* Legacy doorbell: planes already SET_TENSOR'd into the node's x region. */
    std::string recompute(const uint8_t *p, size_t n) {
        if (n < 8) VIOLATE("truncated u32");
        const uint32_t idx = rd_u32(p), m = rd_u32(p + 4);
        Node &nd = node_ok(idx);
        if (m < 1 || (int)m > nd.max_m) VIOLATE("m=%u outside [1,%d] for node %u", m, nd.max_m, idx);
        Buffer &xb = buffers[nd.xbid]; Buffer &yb = buffers[nd.ybid];
        const auto t0 = std::chrono::steady_clock::now();
        {
            std::lock_guard<std::mutex> lk(g_gpu);
            field_gemm_launch(nd.w, (int)nd.K, (int)nd.N, xb.dev + nd.xoff, (int)m,
                              nd.K, (long long)nd.max_m * nd.K,
                              (int32_t *)(yb.dev + nd.yoff), nd.N, stream);
            ck(cudaStreamSynchronize(stream), "recompute sync");
        }
        gemm_ms += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        recomputes++;
        std::string r(4, '\0'); wr_u32((uint8_t *)&r[0], m);
        return r;
    }

    /* The one-frame exchange: | n u32 | m u32 | node u32[n] | planes int8[3][m][K] |
     * -> | y int32[m][N_0] | y int32[m][N_1] | ... |
     *
     * Every node must be an installed FIELD_GEMM with one common K; the planes
     * are the shared masked activation. The response is exactly the products of
     * the nodes named, and nothing else -- the same rule GET_TENSOR enforces
     * through declared outputs, here enforced by construction. */
    std::string field_gemm(const uint8_t *p, size_t n) {
        if (n < 8) VIOLATE("truncated u32");
        const uint32_t nn = rd_u32(p), m = rd_u32(p + 4);
        if (nn < 1 || nn > 64) VIOLATE("FIELD_GEMM names %u nodes", nn);
        if (n < 8 + 4 * (size_t)nn) VIOLATE("truncated node list");
        std::vector<Node *> nds(nn);
        int64_t K = -1; size_t ybytes = 0;
        for (uint32_t i = 0; i < nn; i++) {
            Node &nd = node_ok(rd_u32(p + 8 + 4 * i));
            if (K < 0) K = nd.K;
            if (nd.K != K) VIOLATE("FIELD_GEMM nodes disagree on K");
            if (m < 1 || (int)m > nd.max_m) VIOLATE("m=%u outside [1,%d] for node %s", m, nd.max_m, nd.id.c_str());
            nds[i] = &nd;
            ybytes += (size_t)m * nd.N * 4;
        }
        const size_t xbytes = (size_t)3 * m * K;
        if (n != 8 + 4 * (size_t)nn + xbytes)
            VIOLATE("FIELD_GEMM payload is %zu bytes, expected %zu", n, 8 + 4 * (size_t)nn + xbytes);
        const uint8_t *planes = p + 8 + 4 * nn;

        const auto t0 = std::chrono::steady_clock::now();
        std::string out;
        {
            std::lock_guard<std::mutex> lk(g_gpu);
            ensure_host_in(xbytes); ensure_dx(xbytes); ensure_dy(ybytes); ensure_host_out(ybytes);
            memcpy(h_in, planes, xbytes);
            ck(cudaMemcpyAsync(d_x, h_in, xbytes, cudaMemcpyHostToDevice, stream), "planes upload");
            size_t yoff = 0;
            for (uint32_t i = 0; i < nn; i++) {
                Node &nd = *nds[i];
                field_gemm_launch(nd.w, (int)K, (int)nd.N, d_x, (int)m, K, (long long)m * K,
                                  (int32_t *)((uint8_t *)d_y + yoff), nd.N, stream);
                yoff += (size_t)m * nd.N * 4;
            }
            ck(cudaMemcpyAsync(h_out, d_y, ybytes, cudaMemcpyDeviceToHost, stream), "product readback");
            ck(cudaStreamSynchronize(stream), "exchange sync");
            out.assign((const char *)h_out, ybytes);
        }
        gemm_ms += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        exchanges++;
        return out;
    }

    std::string handle(uint8_t cmd, const uint8_t *p, size_t n) {
        if (cmd == CMD_HELLO) return hello(p, n);
        if (!hello_done) VIOLATE("command before HELLO");
        switch (cmd) {
            case CMD_ALLOC_BUFFER:    return alloc(p, n);
            case CMD_FREE_BUFFER:     return free_buf(p, n);
            case CMD_SET_TENSOR:      return set_tensor(p, n);
            case CMD_GET_TENSOR:      return get_tensor(p, n);
            case CMD_GRAPH_INSTALL:   return graph_install(p, n);
            case CMD_GRAPH_RECOMPUTE: return recompute(p, n);
            case CMD_FIELD_GEMM:      return field_gemm(p, n);
            case CMD_BUFFER_GET_BASE: case CMD_GET_ALIGNMENT: case CMD_GET_MAX_SIZE:
            case CMD_GET_DEVICE_MEMORY: case CMD_DEVICE_COUNT:
                return "";
            default: VIOLATE("unhandled command %u", cmd);
        }
    }

    void serve() {
        ck(cudaStreamCreateWithFlags(&stream, cudaStreamNonBlocking), "stream create");
        std::vector<uint8_t> buf;
        for (;;) {
            uint8_t h[SH_HDR];
            if (!read_exact(fd, h, SH_HDR)) break;
            const uint8_t cmd = h[0];
            const uint64_t size = rd_u64(h + 1);
            std::string resp; bool violation = false;
            if (cmd >= CMD_COUNT || size > MAX_FRAME) {
                resp = cmd >= CMD_COUNT ? fmt("unknown command %u", cmd) : fmt("frame of %llu bytes exceeds cap", (unsigned long long)size);
                violation = true;
                /* drain nothing: the peer is closed on immediately after the reply */
            } else {
                buf.resize((size_t)size);
                if (size && !read_exact(fd, buf.data(), (size_t)size)) break;
                try {
                    resp = handle(cmd, buf.data(), (size_t)size);
                } catch (const Violation &v) {
                    logf("VIOLATION from %s: %s", peer.c_str(), v.why.c_str());
                    resp = v.why; violation = true;
                }
            }
            uint8_t rh[SH_HDR]; rh[0] = violation ? STATUS_VIOLATION : STATUS_OK; wr_u64(rh + 1, resp.size());
            if (!write_all(fd, rh, SH_HDR) || !write_all(fd, resp.data(), resp.size())) break;
            if (violation) break;
        }
        close(fd);
        if (exchanges || recomputes)
            logf("%s closed: %llu exchanges, %llu recomputes, %.1f ms on the card",
                 peer.c_str(), (unsigned long long)exchanges, (unsigned long long)recomputes, gemm_ms);
    }
};

/* ---------------------------------------------------------------------------
 * Listeners: TCP (a slirp guest reaches 127.0.0.1 at 10.0.2.2) and, when asked,
 * AF_VSOCK -- the host is CID 2 to any guest, and a vsock round trip is a
 * fraction of slirp's, which at ~50 exchanges per token is the difference
 * between transport being a rounding error and being the budget.
 * ------------------------------------------------------------------------ */
static void accept_loop(int srv, const char *kind) {
    for (;;) {
        sockaddr_storage sa; socklen_t sl = sizeof sa;
        int fd = accept(srv, (sockaddr *)&sa, &sl);
        if (fd < 0) { if (errno == EINTR) continue; logf("%s accept failed: %s", kind, strerror(errno)); continue; }
        std::string peer = kind;
        if (sa.ss_family == AF_INET) {
            char ip[64]; inet_ntop(AF_INET, &((sockaddr_in *)&sa)->sin_addr, ip, sizeof ip);
            peer = fmt("%s:%d", ip, ntohs(((sockaddr_in *)&sa)->sin_port));
            int one = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
        } else if (sa.ss_family == AF_VSOCK) {
            peer = fmt("vsock:%u:%u", ((sockaddr_vm *)&sa)->svm_cid, ((sockaddr_vm *)&sa)->svm_port);
        }
        std::thread([fd, peer]() {
            auto c = std::make_unique<Conn>(fd, peer);
            c->serve();
        }).detach();
    }
}

int main(int argc, char **argv) {
    const char *host = "127.0.0.1";
    int port = getenv("SHIELDED_PORT") ? atoi(getenv("SHIELDED_PORT")) : 9500;
    int vsock_port = 0;
    double vram_gb = 0.0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--host") && i + 1 < argc) host = argv[++i];
        else if (!strcmp(argv[i], "--port") && i + 1 < argc) port = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--vsock-port") && i + 1 < argc) vsock_port = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--vram-gb") && i + 1 < argc) vram_gb = atof(argv[++i]);
        else if (!strcmp(argv[i], "--quiet")) g_quiet = true;
        else { fprintf(stderr, "usage: shielded-worker [--host H] [--port P] [--vsock-port P] [--vram-gb G] [--quiet]\n"); return 2; }
    }

    int ndev = 0;
    if (cudaGetDeviceCount(&ndev) != cudaSuccess || ndev < 1) {
        fprintf(stderr, "no CUDA device; the shielded worker is the GPU half by definition\n"); return 1;
    }
    cudaSetDevice(0);
    /* Spin on synchronisation: a blocking wait costs tens of microseconds to
     * wake, which at decode is a large fraction of the whole exchange. */
    cudaSetDeviceFlags(cudaDeviceScheduleSpin);
    cudaGetDeviceProperties(&g_props, 0);
    g_vram_budget = vram_gb > 0 ? (long long)(vram_gb * (double)(1ull << 30)) : (long long)(g_props.totalGlobalMem * 0.85);
    logf("%s, sm_%d%d, %.1f GiB total, budget %.1f GiB", g_props.name, g_props.major, g_props.minor,
         g_props.totalGlobalMem / 1073741824.0, g_vram_budget / 1073741824.0);
    kernel_init();
    try {
        if (!selftest()) return 1;
    } catch (const Violation &v) { fprintf(stderr, "selftest: %s\n", v.why.c_str()); return 1; }
    g_gmacs = measure_gmacs();
    if (g_gmacs > 0) logf("field GEMM throughput %.0f G-MAC/s (measured, masked path)", g_gmacs);

    int srv = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1; setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    sockaddr_in sa{}; sa.sin_family = AF_INET; sa.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, host, &sa.sin_addr) != 1) { fprintf(stderr, "bad host %s\n", host); return 2; }
    if (bind(srv, (sockaddr *)&sa, sizeof sa) < 0 || listen(srv, 8) < 0) { perror("bind"); return 1; }
    logf("listening on %s:%d%s", host, port,
         (!strcmp(host, "127.0.0.1") || !strcmp(host, "0.0.0.0")) ? fmt(" (guest reaches it at 10.0.2.2:%d)", port).c_str() : "");

    if (vsock_port > 0) {
        int vs = socket(AF_VSOCK, SOCK_STREAM, 0);
        if (vs < 0) { logf("vsock unavailable (%s); TCP only", strerror(errno)); }
        else {
            sockaddr_vm vm{}; vm.svm_family = AF_VSOCK; vm.svm_cid = VMADDR_CID_ANY; vm.svm_port = (unsigned)vsock_port;
            if (bind(vs, (sockaddr *)&vm, sizeof vm) < 0 || listen(vs, 8) < 0) {
                logf("vsock bind failed (%s); TCP only", strerror(errno)); close(vs);
            } else {
                logf("listening on vsock port %d (guest reaches it at CID 2)", vsock_port);
                std::thread(accept_loop, vs, "vsock").detach();
            }
        }
    }
    accept_loop(srv, "tcp");
    return 0;
}
