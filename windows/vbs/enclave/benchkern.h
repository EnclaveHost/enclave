// Shared kernels: stream a host int8 buffer against a fixed int8 vector, three ways. Returns a checksum.
#include <immintrin.h>
#include <intrin.h>
typedef struct { const unsigned char* buf; unsigned long long size; int iters; int which; /* 0 scalar 1 avx2 2 avx512vnni 3 caps */
                 unsigned long long cycles; long long checksum; unsigned int xcr0_lo, cpuid7_ebx, cpuid7_ecx; unsigned int ok; } BENCH_REQ;
static long long k_scalar(const unsigned char* p, unsigned long long n){ long long s = 0; const unsigned long long* q = (const unsigned long long*)p; for (unsigned long long i = 0; i < n/8; i++) s += (long long)(q[i] ^ 0x0101010101010101ull); return s; }
static long long k_avx2(const unsigned char* p, unsigned long long n){ __m256i acc = _mm256_setzero_si256(), r = _mm256_set1_epi8(3); for (unsigned long long i = 0; i + 32 <= n; i += 32) { __m256i w = _mm256_loadu_si256((const __m256i*)(p+i)); acc = _mm256_add_epi32(acc, _mm256_madd_epi16(_mm256_maddubs_epi16(w, r), _mm256_set1_epi16(1))); } long long s = 0; int t[8]; _mm256_storeu_si256((__m256i*)t, acc); for (int i = 0; i < 8; i++) s += t[i]; return s; }
static long long k_vnni(const unsigned char* p, unsigned long long n){ __m512i acc = _mm512_setzero_si512(), r = _mm512_set1_epi8(3); for (unsigned long long i = 0; i + 64 <= n; i += 64) { __m512i w = _mm512_loadu_si512((const void*)(p+i)); acc = _mm512_dpbusd_epi32(acc, w, r); } return _mm512_reduce_add_epi32(acc); }
static void run_bench(BENCH_REQ* b){
    int ci[4]; __cpuidex(ci, 7, 0); b->cpuid7_ebx = ci[1]; b->cpuid7_ecx = ci[2]; b->xcr0_lo = (unsigned int)_xgetbv(0); b->ok = 1;
    if (b->which == 3) return;
    int avx  = (b->xcr0_lo & 6) == 6;                         /* SSE+AVX state enabled by the (secure) kernel */
    int avx512 = avx && (b->xcr0_lo & 0xE0) == 0xE0 && (b->cpuid7_ebx & (1u<<16)) && (b->cpuid7_ecx & (1u<<11)); /* ZMM state + AVX512F + VNNI */
    if ((b->which == 1 && !avx) || (b->which == 2 && !avx512)) { b->ok = 0; return; }
    long long cs = 0; unsigned long long t0 = __rdtsc();
    for (int it = 0; it < b->iters; it++) cs += b->which == 0 ? k_scalar(b->buf, b->size) : b->which == 1 ? k_avx2(b->buf, b->size) : k_vnni(b->buf, b->size);
    b->cycles = __rdtsc() - t0; b->checksum = cs;
}
