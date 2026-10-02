// Completion-product storage microbenchmark. The input is generated locally
// inside the balanced field range; no unverified external values are accepted.
// "narrow" measures conversion alone. "checked" also scans the range using
// the existing admitted SIMD kernel. Neither is a production cache change.
#include "shielded-field.h"
#include "shielded-simd.h"
#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

struct Wide {
    std::vector<int64_t> values;
    void assign(const int64_t *p, size_t n, const sh_simd *) { values.assign(p, p+n); }
    size_t bytes() const { return values.capacity() * sizeof(int64_t); }
    void copy_to(int64_t *p) const { std::memcpy(p, values.data(), values.size()*sizeof(int64_t)); }
};
template<bool Checked> struct Narrow {
    std::vector<int32_t> values;
    void assign(const int64_t *p, size_t n, const sh_simd *simd) {
        if (Checked) assert(simd->values_within(p, n, SH_HALF_M+1));
        values.assign(p, p+n);
    }
    size_t bytes() const { return values.capacity() * sizeof(int32_t); }
    void copy_to(int64_t *p) const { std::copy(values.begin(), values.end(), p); }
};
static double us() {
    return std::chrono::duration<double,std::micro>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
static long rss() {
    FILE *f=std::fopen("/proc/self/status","r"); assert(f);
    char line[256]; long n=-1;
    while(std::fgets(line,sizeof line,f)) if(std::sscanf(line,"VmRSS: %ld kB",&n)==1)break;
    std::fclose(f);assert(n>=0);return n;
}
template<class Product> static void run(size_t n, size_t groups, int loops, const char *mode) {
    std::vector<int64_t> input(n), output(n+16,INT64_MIN);
    for(size_t i=0;i<n;i++)input[i]=int64_t((i*7919)%SH_M_MOD)-SH_HALF_M;
    const sh_simd *simd=sh_simd_get();
    (void)rss();const long before=rss();
    std::vector<Product> snapshots(groups);
    for(auto &v:snapshots)v.assign(input.data(),n,simd);
    const long after=rss();
    size_t bytes=0;for(const auto &v:snapshots)bytes+=v.bytes();
    double store=0,restore=0;
    for(int round=0;round<loops;round++) {
        input[0]=round%101-50;
        auto start=us();
        // Like a group's completion miss: discard the old output and own a
        // fresh snapshot. Input keys and map metadata are outside this probe.
        for(auto &v:snapshots){v=Product{};v.assign(input.data(),n,simd);}
        store+=us()-start;
        start=us();
        for(const auto &v:snapshots) {
            v.copy_to(output.data()+8);
            asm volatile("" : : "g"(output.data()) : "memory");
        }
        restore+=us()-start;
    }
    // Exact data and guards, checked outside the measured intervals.
    for(const auto &v:snapshots) {
        v.copy_to(output.data()+8);
        assert(std::equal(input.begin(),input.end(),output.begin()+8));
        for(size_t i=0;i<8;i++)assert(output[i]==INT64_MIN && output[n+8+i]==INT64_MIN);
    }
    std::printf("{\"mode\":\"%s\",\"simd\":\"%s\",\"values\":%zu,\"groups\":%zu,\"loops\":%d,"
                "\"retained_bytes\":%zu,\"retained_rss_kib\":%ld,\"store_us\":%.3f,\"restore_us\":%.3f,"
                "\"cycle_us\":%.3f,\"exact\":true}\n",mode,simd->name,n,groups,loops,bytes,after-before,
                store/loops,restore/loops,(store+restore)/loops);
}
int main(int argc,char **argv) {
    assert(argc==5);
    const size_t n=std::strtoul(argv[2],nullptr,10),groups=std::strtoul(argv[3],nullptr,10);
    const int loops=std::atoi(argv[4]);
    assert(n>0 && n<=16*1024*1024 && groups>0 && groups<=1024 && n<=64*1024*1024/groups && loops>0 && loops<=1000);
    if(!std::strcmp(argv[1],"wide"))run<Wide>(n,groups,loops,argv[1]);
    else if(!std::strcmp(argv[1],"narrow"))run<Narrow<false>>(n,groups,loops,argv[1]);
    else {assert(!std::strcmp(argv[1],"checked"));run<Narrow<true>>(n,groups,loops,argv[1]);}
}
