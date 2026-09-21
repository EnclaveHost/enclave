// Minimal VBS enclave: one exported routine that returns the enclave's attestation report
// over a caller-supplied 64-byte nonce, plus the enclave's own identity as the secure kernel sees it.
#include <windows.h>
#include <ntenclv.h>
typedef struct _TRUSTLET_BINDING_DATA* PTRUSTLET_BINDING_DATA; /* only referenced by an API this enclave does not use */
#include <winenclaveapi.h>
#include <string.h>
#include "benchkern.h"

const IMAGE_ENCLAVE_CONFIG __enclave_config = {
    sizeof(IMAGE_ENCLAVE_CONFIG),
    IMAGE_ENCLAVE_MINIMUM_CONFIG_SIZE,
    0,                      /* PolicyFlags: not debuggable */
    0, 0, 0,                /* no imports */
    { 0xEC, 0x1A, 0x5E, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01 }, /* FamilyID */
    { 0xEC, 0x1A, 0x5E, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01 }, /* ImageID */
    0x00010000,             /* ImageVersion 1.0 */
    7,                      /* SecurityVersion (SVN) */
    0x10000000,             /* EnclaveSize 256 MB (host must create with the same size) */
    4,                      /* NumberOfThreads */
    IMAGE_ENCLAVE_FLAG_PRIMARY_IMAGE
};

typedef struct {
    UINT8   nonce[64];
    UINT32  report_size;
    HRESULT hr_report;
    HRESULT hr_info;
    UINT32  marker;
    ENCLAVE_INFORMATION info;
    UINT8   report[8192];
} REPORT_REQUEST;

static UINT8 g_buf[8192];

__declspec(dllexport) void* WINAPI GetReport(void* param)
{
    REPORT_REQUEST* r = (REPORT_REQUEST*)param;      /* lives in VTL0 host memory */
    UINT32 sz = 0;
    r->marker = 0xEC1A5E01;
    r->hr_report = EnclaveGetAttestationReport(r->nonce, g_buf, sizeof g_buf, &sz);
    if (SUCCEEDED(r->hr_report) && sz <= sizeof g_buf) {
        memcpy(r->report, g_buf, sz);
        r->report_size = sz;
    } else {
        r->report_size = sz;
    }
    ENCLAVE_INFORMATION info;
    memset(&info, 0, sizeof info);
    r->hr_info = EnclaveGetEnclaveInformation(sizeof info, &info);
    memcpy(&r->info, &info, sizeof info);
    return (void*)(UINT_PTR)0x600D;
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved)
{
    (void)h; (void)reason; (void)reserved;
    return TRUE;
}

__declspec(dllexport) void* WINAPI Bench(void* param)
{
    run_bench((BENCH_REQ*)param);   /* buffer lives in VTL0; the enclave streams it directly */
    return (void*)(UINT_PTR)0xBE;
}
