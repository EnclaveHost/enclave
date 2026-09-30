// Public integers only. Used by the release builder before accepting oneDNN.
#include <oneapi/dnnl/dnnl.h>
#include <cstdio>
#include <vector>
int main() {
    const int m=96, n=384, k=5120;
    std::vector<unsigned char> a(m*k, 127);
    std::vector<signed char> b(n*k, 3);
    std::vector<int> c(m*n);
    int co=0;
    auto rc=dnnl_gemm_u8s8s32('N','T','F',m,n,k,1,a.data(),k,0,b.data(),k,0,0,c.data(),n,&co);
    if (rc != dnnl_success) return 1;
    for (int x:c) if (x != 127*3*k) return 2;
    FILE *f=fopen("/proc/self/maps","r"); if (!f) return 3;
    char line[4096], perm[5]; bool clean=true;
    while (fgets(line,sizeof line,f))
        if (sscanf(line,"%*s %4s",perm)==1 && perm[1]=='w' && perm[2]=='x') clean=false;
    clean=clean && !ferror(f);fclose(f);
    if (!clean) {fputs("oneDNN refused: writable executable JIT mapping\n",stderr);return 4;}
    puts("oneDNN exact integer GEMM and W^X passed");
}
