/* VTL0 host for the ES256 key-custody spike: create the enclave, ask it to sign a digest we chose,
 * and print what came back as one JSON line for an independent verifier to check.
 *
 * The host deliberately has no way to ask for the private key: the gate structure has no field for
 * it. What this program can show is that a signature made inside VTL1 verifies against a public key
 * that also came from inside, over a digest chosen out here - and that a second call reuses the
 * same key, which is what a per-boot session-signing key must do. */
#include <windows.h>
#include <enclaveapi.h>
#include <ntenclv.h>
#include <stdio.h>
#include <string.h>
#include "p256kern.h"

static void hex(const unsigned char *p, int n) { for (int i = 0; i < n; i++) printf("%02x", p[i]); }

int main(int argc, char **argv)
{
    const wchar_t *dll = L"C:\\Users\\claude\\vbs\\raw\\p256enclave.dll";
    DWORD err = 0;
    ENCLAVE_CREATE_INFO_VBS ci;
    memset(&ci, 0, sizeof ci);
    memset(ci.OwnerID, 0x42, 32);

    LPVOID base = CreateEnclave(GetCurrentProcess(), NULL, 0x10000000, 0, ENCLAVE_TYPE_VBS, &ci, sizeof ci, &err);
    if (!base) { printf("{\"ok\":false,\"where\":\"CreateEnclave\",\"err\":%lu}\n", GetLastError()); return 1; }
    if (!LoadEnclaveImageW(base, dll)) { printf("{\"ok\":false,\"where\":\"LoadEnclaveImageW\",\"err\":%lu}\n", GetLastError()); return 1; }
    ENCLAVE_INIT_INFO_VBS ii = { sizeof ii, 4 };
    if (!InitializeEnclave(GetCurrentProcess(), base, &ii, sizeof ii, &err)) { printf("{\"ok\":false,\"where\":\"InitializeEnclave\",\"err\":%lu}\n", GetLastError()); return 1; }

    FARPROC fn = GetProcAddress((HMODULE)base, "SignP256");
    if (!fn) { printf("{\"ok\":false,\"where\":\"GetProcAddress\",\"err\":%lu}\n", GetLastError()); return 1; }

    /* The digest is the host's choice, so a signature over it cannot have been prepared in advance.
     * argv[1], if given, is 32 bytes of hex; otherwise a fixed one, so a run is reproducible. */
    P256_REQ a; memset(&a, 0, sizeof a);
    for (int i = 0; i < 32; i++) a.digest[i] = (unsigned char)(0xA0 + i);
    if (argc > 1 && strlen(argv[1]) == 64)
        for (int i = 0; i < 32; i++) { unsigned v = 0; sscanf(argv[1] + 2 * i, "%2x", &v); a.digest[i] = (unsigned char)v; }

    /* Our OWN copy. The enclave clears the request before writing its reply - it must not echo
     * back anything the host did not already have - so the host keeps the digest it chose. */
    unsigned char d1[32], d2[32];
    memcpy(d1, a.digest, 32);

    LARGE_INTEGER f, t0, t1, t2; QueryPerformanceFrequency(&f);
    LPVOID ret;
    QueryPerformanceCounter(&t0);
    if (!CallEnclave((LPENCLAVE_ROUTINE)fn, &a, TRUE, &ret)) { printf("{\"ok\":false,\"where\":\"CallEnclave\",\"err\":%lu}\n", GetLastError()); return 1; }
    QueryPerformanceCounter(&t1);

    /* A second call with a different digest: same key, so a token minted before a restart still
     * verifies after one more signature. */
    P256_REQ b; memset(&b, 0, sizeof b);
    for (int i = 0; i < 32; i++) b.digest[i] = (unsigned char)(i * 7 + 1);
    memcpy(d2, b.digest, 32);
    if (!CallEnclave((LPENCLAVE_ROUTINE)fn, &b, TRUE, &ret)) { printf("{\"ok\":false,\"where\":\"CallEnclave2\",\"err\":%lu}\n", GetLastError()); return 1; }
    QueryPerformanceCounter(&t2);

    printf("{\"ok\":%s,\"step\":%u,\"ntstatus\":\"0x%08x\",\"pubLen\":%u,\"privExport\":\"0x%08x\","
           "\"reused\":[%u,%u],\"mintAndSignMs\":%.3f,\"signMs\":%.3f,",
           a.step == P256_STEP_OK && b.step == P256_STEP_OK ? "true" : "false", a.step, a.ntstatus,
           a.pub_len, a.priv_export, a.reused, b.reused,
           (double)(t1.QuadPart - t0.QuadPart) * 1000.0 / f.QuadPart,
           (double)(t2.QuadPart - t1.QuadPart) * 1000.0 / f.QuadPart);
    printf("\"pub\":\""); hex(a.pub, 64); printf("\",");
    printf("\"pub2\":\""); hex(b.pub, 64); printf("\",");
    printf("\"digest\":\""); hex(d1, 32); printf("\",");
    printf("\"sig\":\""); hex(a.sig, 64); printf("\",");
    printf("\"digest2\":\""); hex(d2, 32); printf("\",");
    printf("\"sig2\":\""); hex(b.sig, 64); printf("\"}\n");
    return a.step == P256_STEP_OK && b.step == P256_STEP_OK ? 0 : 2;
}
