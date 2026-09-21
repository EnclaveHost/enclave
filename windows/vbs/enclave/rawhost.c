// Raw-API host: create, load, initialize, and call the enclave; print every step; save the report.
#include <windows.h>
#include <enclaveapi.h>
#include <ntenclv.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    UINT8   nonce[64];
    UINT32  report_size;
    HRESULT hr_report;
    HRESULT hr_info;
    UINT32  marker;
    ENCLAVE_INFORMATION info;
    UINT8   report[8192];
} REPORT_REQUEST;

static void hex(const char* label, const UINT8* p, int n) { printf("%s", label); for (int i = 0; i < n; i++) printf("%02x", p[i]); printf("\n"); fflush(stdout); }
#define STEP(fmt, ...) do { printf(fmt "\n", __VA_ARGS__); fflush(stdout); } while (0)

int main(int argc, char** argv)
{
    const wchar_t* dll = L"%ENCLAVE_DIR%\\rawenclave.dll";
    STEP("IsEnclaveTypeSupported(VBS) = %d", IsEnclaveTypeSupported(ENCLAVE_TYPE_VBS));
    ENCLAVE_CREATE_INFO_VBS ci; memset(&ci, 0, sizeof ci); ci.Flags = 0; memset(ci.OwnerID, 0x42, sizeof ci.OwnerID);
    DWORD err = 0;
    LPVOID base = CreateEnclave(GetCurrentProcess(), NULL, 0x10000000, 0, ENCLAVE_TYPE_VBS, &ci, sizeof ci, &err);
    STEP("CreateEnclave -> base=%p enclaveError=0x%08lx lastError=%lu", base, err, GetLastError());
    if (!base) return 2;
    BOOL ok = LoadEnclaveImageW(base, dll);
    STEP("LoadEnclaveImageW -> %d lastError=%lu", ok, GetLastError());
    if (!ok) return 3;
    ENCLAVE_INIT_INFO_VBS ii; ii.Length = sizeof ii; ii.ThreadCount = 2;
    ok = InitializeEnclave(GetCurrentProcess(), base, &ii, sizeof ii, &err);
    STEP("InitializeEnclave -> %d enclaveError=0x%08lx lastError=%lu", ok, err, GetLastError());
    if (!ok) return 4;
    FARPROC fn = GetProcAddress((HMODULE)base, "GetReport");
    STEP("GetProcAddress(GetReport) -> %p lastError=%lu", (void*)fn, GetLastError());
    if (!fn) return 5;
    REPORT_REQUEST* req = (REPORT_REQUEST*)calloc(1, sizeof *req);
    for (int i = 0; i < 64; i++) req->nonce[i] = (UINT8)(0xA0 + i);
    LPVOID ret = NULL;
    ok = CallEnclave((LPENCLAVE_ROUTINE)fn, req, TRUE, &ret);
    STEP("CallEnclave -> %d ret=%p lastError=%lu marker=0x%08x", ok, ret, GetLastError(), req->marker);
    STEP("EnclaveGetAttestationReport hr=0x%08lx size=%u", req->hr_report, req->report_size);
    STEP("EnclaveGetEnclaveInformation hr=0x%08lx type=%lu base=%p size=0x%zx", req->hr_info, req->info.EnclaveType, req->info.BaseAddress, req->info.Size);
    ENCLAVE_IDENTITY* id = &req->info.Identity;
    hex("  OwnerId   = ", id->OwnerId, 32); hex("  UniqueId  = ", id->UniqueId, 32); hex("  AuthorId  = ", id->AuthorId, 32);
    hex("  FamilyId  = ", id->FamilyId, 16); hex("  ImageId   = ", id->ImageId, 16);
    STEP("  EnclaveSvn=%u SecureKernelSvn=%u PlatformSvn=%u Flags=0x%x SigningLevel=%u EnclaveType=%u", id->EnclaveSvn, id->SecureKernelSvn, id->PlatformSvn, id->Flags, id->SigningLevel, id->EnclaveType);
    if (SUCCEEDED(req->hr_report) && req->report_size) {
        FILE* f = fopen("%ENCLAVE_DIR%\\report.bin", "wb"); fwrite(req->report, 1, req->report_size, f); fclose(f);
        f = fopen("%ENCLAVE_DIR%\\nonce.bin", "wb"); fwrite(req->nonce, 1, 64, f); fclose(f);
        STEP("report written (%u bytes)", req->report_size);
    }
    ok = DeleteEnclave(base);
    STEP("DeleteEnclave -> %d", ok);
    return 0;
}
