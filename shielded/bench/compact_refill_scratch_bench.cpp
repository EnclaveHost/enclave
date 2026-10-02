#include "shielded-compact.h"
#include "shielded-field.h"
#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <malloc.h>
#include <new>
#include <sys/resource.h>
#include <vector>

static bool counting;
static size_t calls, bytes, largest;
void *operator new(size_t n) {
    void *p = std::malloc(n ? n : 1); if (!p) throw std::bad_alloc();
    if (counting) { ++calls; bytes += n; largest = std::max(largest, n); }
    return p;
}
void *operator new[](size_t n) { return ::operator new(n); }
void operator delete(void *p) noexcept { std::free(p); }
void operator delete[](void *p) noexcept { std::free(p); }
void operator delete(void *p, size_t) noexcept { std::free(p); }
void operator delete[](void *p, size_t) noexcept { std::free(p); }
static void begin_count() { calls=bytes=largest=0; counting=true; }
static long rss_kib() {
    FILE *f=std::fopen("/proc/self/status","r"); assert(f);
    char line[256]; long value=-1;
    while (std::fgets(line,sizeof line,f)) if (std::sscanf(line,"VmRSS: %ld kB",&value)==1) break;
    std::fclose(f); assert(value>=0); return value;
}
static long peak_kib() { rusage r{}; assert(!getrusage(RUSAGE_SELF,&r)); return r.ru_maxrss; }
static double now_us() {
    return std::chrono::duration<double,std::micro>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
static int8_t weight(size_t i, int bits) {
    // Pattern 9: nearly incompressible, with one four-bit frame per 64 frames.
    if (bits==9) bits=(i/64)%64==63?4:8;
    return bits==0 ? -7 : bits==8 ? int((i*17)%239)-119 :
        int((i*17)%(1u<<bits))-int(1u<<(bits-1));
}
int main(int argc, char **argv) {
    assert(argc==5);
    const size_t K=std::strtoul(argv[1],nullptr,10), N=std::strtoul(argv[2],nullptr,10);
    const int b=std::atoi(argv[3]), bits=std::atoi(argv[4]);
    assert(K>0 && K<=65536 && N>0 && N<=17408 && b>0 && b<=64 && bits>=0 && bits<=9);
    std::vector<int8_t> w(K*N);
    for (size_t i=0; i<w.size(); ++i) w[i]=weight(i,bits);
    (void)rss_kib(); // initialize measurement I/O before the snapshots
    const long create_rss0=rss_kib(), create_peak0=peak_kib();
    double started=now_us(); begin_count();
    auto *s=sh_compact_create(w.data(),K,N); assert(s);
    counting=false; const double create_us=now_us()-started;
    const size_t create_calls=calls, create_bytes=bytes, create_largest=largest, store_bytes=sh_compact_bytes(s);
    const long create_rss1=rss_kib(), create_peak1=peak_kib();
    std::vector<int8_t>().swap(w);
    std::vector<int32_t> r((size_t)b*K),u((size_t)b*(N+3),INT32_MIN);
    for (size_t i=0; i<r.size(); ++i) r[i]=(i*7919+12345)%SH_M_MOD;
    // Reset freed admission storage equally in both processes, so a retained
    // malloc arena does not hide the first refill's touched scratch pages.
    malloc_trim(0);
    const long refill_rss0=rss_kib();
    started=now_us(); begin_count();
    assert(sh_compact_refill(s,r.data(),b,u.data(),N+3)==SH_OK);
    counting=false; const double first_us=now_us()-started;
    const size_t refill_calls=calls, refill_bytes=bytes, refill_largest=largest;
    const long refill_rss1=rss_kib();
    // Small matrices have an independent integer oracle; larger controls are
    // paired by their full output hash and covered by the sanitizer fixture.
    if (N<=384) for (int row=0; row<b; ++row) for (size_t j=0; j<N; ++j) {
        int64_t sum=0;
        for (size_t k=0; k<K; ++k) sum+=(int64_t)r[(size_t)row*K+k]*weight(j*K+k,bits);
        assert(u[(size_t)row*(N+3)+j]==sh_balanced(sum));
    }
    for (int row=0; row<b; ++row) for (size_t j=N; j<N+3; ++j)
        assert(u[(size_t)row*(N+3)+j]==INT32_MIN);
    for (int i=0; i<3; ++i) assert(sh_compact_refill(s,r.data(),b,u.data(),N+3)==SH_OK);
    started=now_us(); assert(sh_compact_refill(s,r.data(),b,u.data(),N+3)==SH_OK);
    const double estimate=std::max(0.001,now_us()-started);
    const int inner=std::max(1,std::min(1000,int(1000/estimate)+1));
    constexpr int iterations=15;
    double times[iterations]; begin_count();
    for (int i=0; i<iterations; ++i) {
        started=now_us();
        for (int j=0; j<inner; ++j) assert(sh_compact_refill(s,r.data(),b,u.data(),N+3)==SH_OK);
        times[i]=(now_us()-started)/inner;
    }
    counting=false; std::sort(times,times+iterations);
    uint64_t hash=UINT64_C(1469598103934665603);
    for (int32_t v:u) { hash^=(uint32_t)v; hash*=UINT64_C(1099511628211); }
    std::printf("{\"K\":%zu,\"N\":%zu,\"batch\":%d,\"bits\":%d,"
        "\"create_allocations\":%zu,\"create_allocated_bytes\":%zu,\"create_largest_bytes\":%zu,\"store_bytes\":%zu,"
        "\"create_us\":%.3f,\"create_rss_delta_kib\":%ld,\"create_peak_delta_kib\":%ld,"
        "\"refill_allocations\":%zu,\"refill_allocated_bytes\":%zu,\"refill_largest_bytes\":%zu,"
        "\"first_refill_us\":%.3f,\"refill_rss_delta_kib\":%ld,"
        "\"warm_iterations\":%d,\"warm_allocations\":%zu,\"warm_allocated_bytes\":%zu,\"warm_refill_us\":%.3f,\"output_hash\":\"%016llx\"}\n",
        K,N,b,bits,create_calls,create_bytes,create_largest,store_bytes,create_us,create_rss1-create_rss0,create_peak1-create_peak0,
        refill_calls,refill_bytes,refill_largest,first_us,refill_rss1-refill_rss0,
        iterations*inner,calls,bytes,times[iterations/2],(unsigned long long)hash);
    sh_compact_free(s);
}
