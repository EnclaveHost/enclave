#include <windows.h>
#include <enclaveapi.h>
#include <ntenclv.h>
#include <stdio.h>
#include <stdlib.h>
#include "benchkern.h"
static double tsc_ghz(void){ LARGE_INTEGER f, a, b; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&a); unsigned long long t0 = __rdtsc(); Sleep(200); QueryPerformanceCounter(&b); unsigned long long t1 = __rdtsc(); return (double)(t1-t0) / ((double)(b.QuadPart-a.QuadPart) / f.QuadPart) / 1e9; }
typedef struct { FARPROC fn; BENCH_REQ req; } THR;
static DWORD WINAPI thr_enclave(LPVOID p){ THR* t = (THR*)p; LPVOID r; CallEnclave((LPENCLAVE_ROUTINE)t->fn, &t->req, TRUE, &r); return 0; }
static DWORD WINAPI thr_host(LPVOID p){ run_bench(&((THR*)p)->req); return 0; }
int main(void){
    const unsigned long long SZ = 1ull<<30; int iters = 3; double ghz = tsc_ghz();
    unsigned char* buf = (unsigned char*)VirtualAlloc(NULL, SZ, MEM_COMMIT|MEM_RESERVE, PAGE_READWRITE);
    for (unsigned long long i = 0; i < SZ; i += 4096) buf[i] = (unsigned char)i;      /* touch every page */
    printf("TSC %.3f GHz, buffer %llu MB in VTL0 host memory, %d passes per measurement\n", ghz, SZ>>20, iters); fflush(stdout);
    ENCLAVE_CREATE_INFO_VBS ci; memset(&ci, 0, sizeof ci); memset(ci.OwnerID, 0x42, 32); DWORD err = 0;
    LPVOID base = CreateEnclave(GetCurrentProcess(), NULL, 0x10000000, 0, ENCLAVE_TYPE_VBS, &ci, sizeof ci, &err);
    if (!base || !LoadEnclaveImageW(base, L"C:\\Users\\claude\\vbs\\raw\\rawenclave.dll")) { printf("create/load failed %lu\n", GetLastError()); return 1; }
    ENCLAVE_INIT_INFO_VBS ii = { sizeof ii, 4 };
    if (!InitializeEnclave(GetCurrentProcess(), base, &ii, sizeof ii, &err)) { printf("init failed %lu\n", GetLastError()); return 1; }
    printf("enclave initialized with %lu threads\n", ii.ThreadCount); fflush(stdout);
    FARPROC fn = GetProcAddress((HMODULE)base, "Bench");
    BENCH_REQ caps = {0}; caps.which = 3; LPVOID r; CallEnclave((LPENCLAVE_ROUTINE)fn, &caps, TRUE, &r);
    BENCH_REQ hcaps = {0}; hcaps.which = 3; run_bench(&hcaps);
    printf("XCR0 lo: host=0x%x enclave=0x%x   CPUID7.EBX: host=0x%08x enclave=0x%08x   CPUID7.ECX: host=0x%08x enclave=0x%08x\n", hcaps.xcr0_lo, caps.xcr0_lo, hcaps.cpuid7_ebx, caps.cpuid7_ebx, hcaps.cpuid7_ecx, caps.cpuid7_ecx);
    printf("  AVX512F host=%d enclave=%d  VNNI host=%d enclave=%d  ZMM-state host=%d enclave=%d\n", !!(hcaps.cpuid7_ebx>>16&1), !!(caps.cpuid7_ebx>>16&1), !!(hcaps.cpuid7_ecx>>11&1), !!(caps.cpuid7_ecx>>11&1), (hcaps.xcr0_lo&0xE0)==0xE0, (caps.xcr0_lo&0xE0)==0xE0); fflush(stdout);
    const char* names[3] = { "scalar 64-bit xor-sum", "AVX2 maddubs int8 dot", "AVX-512 VNNI vpdpbusd" };
    for (int nt = 1; nt <= 4; nt *= 2) {
        for (int which = 0; which < 3; which++) {
            for (int where = 0; where < 2; where++) {
                THR t[4]; HANDLE h[4]; unsigned long long slice = SZ / nt;
                for (int i = 0; i < nt; i++) { memset(&t[i], 0, sizeof t[i]); t[i].fn = fn; t[i].req.buf = buf + i*slice; t[i].req.size = slice; t[i].req.iters = iters; t[i].req.which = which; }
                LARGE_INTEGER f, a, b; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&a);
                for (int i = 0; i < nt; i++) h[i] = CreateThread(NULL, 0, where ? thr_enclave : thr_host, &t[i], 0, NULL);
                WaitForMultipleObjects(nt, h, TRUE, INFINITE); QueryPerformanceCounter(&b);
                for (int i = 0; i < nt; i++) CloseHandle(h[i]);
                double secs = (double)(b.QuadPart-a.QuadPart)/f.QuadPart; int ok = 1; for (int i = 0; i < nt; i++) ok &= t[i].req.ok;
                if (!ok) printf("  %-8s %d thr  %-24s NOT AVAILABLE (state/feature disabled)\n", where ? "enclave" : "host", nt, names[which]);
                else printf("  %-8s %d thr  %-24s %7.2f GB/s  (%.3f s, cycles/thread0 %.2f G)\n", where ? "enclave" : "host", nt, names[which], (double)SZ*iters/secs/1e9, secs, t[0].req.cycles/1e9);
                fflush(stdout);
            }
        }
    }
    TerminateEnclave(base, TRUE); DeleteEnclave(base); return 0;
}
