/* Capability probe: does VTL1's VirtualAlloc/VirtualProtect honour PAGE_EXECUTE_*?
 *
 * This answers one architecture question and nothing else: whether a VBS enclave can obtain a
 * page it is allowed to execute AFTER InitializeEnclave has measured it. That decides whether
 * compiled (rather than interpreted) wasm can ever be loaded dynamically the way Pulley
 * bytecode is today.
 *
 * It only asks for the pages and reports the return code. It writes no instructions and calls
 * nothing it allocated -- the success or failure of the request is the entire answer.
 */
#include <windows.h>
#include <ntenclv.h>
typedef struct _TRUSTLET_BINDING_DATA* PTRUSTLET_BINDING_DATA;
#include <winenclaveapi.h>
#include <string.h>

const IMAGE_ENCLAVE_CONFIG __enclave_config = {
    sizeof(IMAGE_ENCLAVE_CONFIG),
    IMAGE_ENCLAVE_MINIMUM_CONFIG_SIZE,
    0,                      /* not debuggable */
    0, 0, 0,                /* no imports */
    { 0xEC, 0x1A, 0x5E, 0x00, 0x00, 0x00, 0x00, 0x05, 0, 0, 0, 0, 0, 0, 0, 0x01 },
    { 0xEC, 0x1A, 0x5E, 0x00, 0x00, 0x00, 0x00, 0x06, 0, 0, 0, 0, 0, 0, 0, 0x01 },
    0x00010000,             /* ImageVersion 1.0 */
    1,                      /* SVN */
    0x10000000,             /* 256 MB, host must match */
    4,                      /* threads */
    IMAGE_ENCLAVE_FLAG_PRIMARY_IMAGE
};

#define NPROBE 8
typedef struct {
    UINT32 marker;
    UINT32 n;
    struct { UINT32 alloc_prot; UINT32 then_prot; UINT32 ok; UINT32 err; UINT64 addr; } r[NPROBE];
} VXREQ;

/* Ask for one page at `alloc_prot`; if `then_prot`, try to move it there afterwards.
   Records the outcome and releases the page. Nothing is written into it and nothing is called. */
static void probe(VXREQ* q, DWORD alloc_prot, DWORD then_prot)
{
    UINT32 i = q->n;
    if (i >= NPROBE) return;
    q->n = i + 1;
    q->r[i].alloc_prot = alloc_prot;
    q->r[i].then_prot = then_prot;
    q->r[i].ok = 0; q->r[i].err = 0; q->r[i].addr = 0;

    SetLastError(0);
    void* p = VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, alloc_prot);
    if (!p) { q->r[i].err = GetLastError(); return; }
    q->r[i].addr = (UINT64)(UINT_PTR)p;

    if (then_prot) {
        DWORD old = 0;
        SetLastError(0);
        if (!VirtualProtect(p, 4096, then_prot, &old)) {
            q->r[i].err = GetLastError();
            VirtualFree(p, 0, MEM_RELEASE);
            return;
        }
    }
    q->r[i].ok = 1;
    VirtualFree(p, 0, MEM_RELEASE);
}

__declspec(dllexport) void* WINAPI Probe(void* param)
{
    VXREQ* q = (VXREQ*)param;        /* VTL0 memory */
    q->marker = 0xEC1A5E05;
    q->n = 0;
    probe(q, PAGE_READWRITE, 0);                        /* control: plain RW must work */
    probe(q, PAGE_READONLY, 0);                         /* control */
    probe(q, PAGE_EXECUTE_READWRITE, 0);                /* direct W|X */
    probe(q, PAGE_EXECUTE_READ, 0);                     /* direct X */
    probe(q, PAGE_EXECUTE, 0);                          /* direct X only */
    probe(q, PAGE_READWRITE, PAGE_EXECUTE_READ);        /* the JIT pattern: W then X */
    probe(q, PAGE_READWRITE, PAGE_EXECUTE_READWRITE);   /* W then W|X */
    probe(q, PAGE_READWRITE, PAGE_READONLY);            /* control: a benign reprotect */
    return (void*)(UINT_PTR)0x5D05;
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved)
{
    (void)h; (void)reason; (void)reserved;
    return TRUE;
}
