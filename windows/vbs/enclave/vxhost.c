/* Host for the VTL1 executable-page capability probe. Creates the enclave, calls Probe, prints
 * what the secure kernel allowed. See vxprobe.c for what is being asked and why. */
#include <windows.h>
#include <enclaveapi.h>
#include <ntenclv.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NPROBE 8
typedef struct {
    UINT32 marker;
    UINT32 n;
    struct { UINT32 alloc_prot; UINT32 then_prot; UINT32 ok; UINT32 err; UINT64 addr; } r[NPROBE];
} VXREQ;

static const char* protname(UINT32 p)
{
    switch (p) {
    case 0: return "-";
    case PAGE_READONLY: return "R";
    case PAGE_READWRITE: return "RW";
    case PAGE_EXECUTE: return "X";
    case PAGE_EXECUTE_READ: return "RX";
    case PAGE_EXECUTE_READWRITE: return "RWX";
    default: return "?";
    }
}

int main(void)
{
    printf("IsEnclaveTypeSupported(VBS) = %d\n", IsEnclaveTypeSupported(ENCLAVE_TYPE_VBS));
    ENCLAVE_CREATE_INFO_VBS ci; memset(&ci, 0, sizeof ci);
    ci.Flags = 0; memset(ci.OwnerID, 0x42, sizeof ci.OwnerID);
    DWORD err = 0;
    LPVOID base = CreateEnclave(GetCurrentProcess(), NULL, 0x10000000, 0,
                                ENCLAVE_TYPE_VBS, &ci, sizeof ci, &err);
    printf("CreateEnclave -> base=%p enclaveError=0x%08lx lastError=%lu\n", base, err, GetLastError());
    if (!base) return 2;
    if (!LoadEnclaveImageW(base, L"C:\\Users\\claude\\vbs\\raw\\vxprobe.dll")) {
        printf("LoadEnclaveImageW failed: %lu\n", GetLastError()); return 3;
    }
    ENCLAVE_INIT_INFO_VBS ii; memset(&ii, 0, sizeof ii); ii.Length = sizeof ii; ii.ThreadCount = 2;
    if (!InitializeEnclave(GetCurrentProcess(), base, &ii, sizeof ii, &err)) {
        printf("InitializeEnclave failed: enclaveError=0x%08lx lastError=%lu\n", err, GetLastError()); return 4;
    }
    printf("InitializeEnclave -> ok (the image is now measured and sealed)\n");
    FARPROC fn = GetProcAddress((HMODULE)base, "Probe");
    if (!fn) { printf("GetProcAddress(Probe) failed: %lu\n", GetLastError()); return 5; }
    VXREQ* q = (VXREQ*)calloc(1, sizeof *q);
    LPVOID ret = NULL;
    BOOL ok = CallEnclave((LPENCLAVE_ROUTINE)fn, q, TRUE, &ret);
    printf("CallEnclave -> %d ret=%p marker=0x%08x probes=%u\n\n", ok, ret, q->marker, q->n);
    printf("  %-5s %-5s %-8s %-8s %s\n", "alloc", "then", "result", "err", "address");
    for (UINT32 i = 0; i < q->n && i < NPROBE; i++) {
        printf("  %-5s %-5s %-8s %-8lu %s\n",
               protname(q->r[i].alloc_prot), protname(q->r[i].then_prot),
               q->r[i].ok ? "ALLOWED" : "REFUSED", (unsigned long)q->r[i].err,
               q->r[i].ok ? "granted" : "-");
    }
    DeleteEnclave(base);
    return 0;
}
