/* ES256 key custody inside VTL1: mint a P-256 key in the enclave, sign with it, and let nothing
 * but the public half and the signature cross the gate. See p256kern.h for why.
 *
 * The key is a static, minted once and kept for the life of the enclave - which is what a per-boot
 * session-signing key is. A second call reports `reused`, because a key that is regenerated per
 * call would invalidate every token the previous call minted. */
#include <windows.h>
#include <ntenclv.h>
typedef struct _TRUSTLET_BINDING_DATA* PTRUSTLET_BINDING_DATA; /* only referenced by an API this enclave does not use */
#include <winenclaveapi.h>
#include <bcrypt.h>
#include <string.h>
#include "p256kern.h"

const IMAGE_ENCLAVE_CONFIG __enclave_config = {
    sizeof(IMAGE_ENCLAVE_CONFIG),
    IMAGE_ENCLAVE_MINIMUM_CONFIG_SIZE,
    0,                      /* PolicyFlags: not debuggable */
    0, 0, 0,                /* no imports */
    { 0xEC, 0x1A, 0x5E, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01 }, /* FamilyID */
    { 0xEC, 0x1A, 0x5E, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01 }, /* ImageID: the P-256 spike */
    0x00010000,             /* ImageVersion 1.0 */
    7,                      /* SecurityVersion (SVN) */
    0x10000000,             /* EnclaveSize 256 MB (host must create with the same size) */
    4,                      /* NumberOfThreads */
    IMAGE_ENCLAVE_FLAG_PRIMARY_IMAGE
};

#ifndef NT_SUCCESS
#define NT_SUCCESS(s) (((NTSTATUS)(s)) >= 0)
#endif

static BCRYPT_ALG_HANDLE g_alg;
static BCRYPT_KEY_HANDLE g_key;          /* THE PRIVATE HALF. It is a static inside VTL1 and there
                                          * is no path that copies it into the request. */
static UINT8 g_pub[64];
static UINT32 g_pub_len, g_priv_export;

/* Mint once. The caller's own thread runs this inside the enclave, so no lock is needed for the
 * single-threaded host below; a real one would take the enclave's own. */
static UINT32 mint(P256_REQ *r)
{
    NTSTATUS s;
    UINT8 blob[256]; ULONG n = 0;

    s = BCryptOpenAlgorithmProvider(&g_alg, BCRYPT_ECDSA_P256_ALGORITHM, NULL, 0);
    if (!NT_SUCCESS(s)) { r->ntstatus = (UINT32)s; return P256_STEP_OPEN; }
    s = BCryptGenerateKeyPair(g_alg, &g_key, 256, 0);
    if (!NT_SUCCESS(s)) { r->ntstatus = (UINT32)s; return P256_STEP_GENERATE; }
    s = BCryptFinalizeKeyPair(g_key, 0);
    if (!NT_SUCCESS(s)) { r->ntstatus = (UINT32)s; return P256_STEP_FINALIZE; }

    s = BCryptExportKey(g_key, NULL, BCRYPT_ECCPUBLIC_BLOB, blob, sizeof blob, &n, 0);
    if (!NT_SUCCESS(s)) { r->ntstatus = (UINT32)s; return P256_STEP_EXPORTPUB; }
    /* BCRYPT_ECCKEY_BLOB: { Magic, cbKey } then X(cbKey) || Y(cbKey). */
    {
        BCRYPT_ECCKEY_BLOB *h = (BCRYPT_ECCKEY_BLOB *)blob;
        if (n < sizeof *h + 64 || h->cbKey != 32) { r->ntstatus = n; return P256_STEP_BLOBSHAPE; }
        memcpy(g_pub, blob + sizeof *h, 64);
        g_pub_len = (UINT32)n;
    }
    /* Recorded, not used: whether the enclave COULD export its own private half. The claim this
     * spike supports is that it never does, not that the platform forbids it. */
    {
        UINT8 pblob[256]; ULONG pn = 0;
        NTSTATUS ps = BCryptExportKey(g_key, NULL, BCRYPT_ECCPRIVATE_BLOB, pblob, sizeof pblob, &pn, 0);
        g_priv_export = (UINT32)ps;
        SecureZeroMemory(pblob, sizeof pblob);
    }
    return P256_STEP_OK;
}

__declspec(dllexport) void* WINAPI SignP256(void* param)
{
    P256_REQ *r = (P256_REQ *)param;    /* VTL0 memory: read once, write only what may leave */
    P256_REQ in;
    NTSTATUS s;
    ULONG n = 0;
    UINT32 step;

    memcpy(&in, r, sizeof in);
    memset(r, 0, sizeof *r);

    r->reused = g_key ? 1 : 0;
    if (!g_key) { step = mint(r); if (step != P256_STEP_OK) { r->step = step; return (void*)(UINT_PTR)step; } }

    s = BCryptSignHash(g_key, NULL, in.digest, 32, r->sig, 64, &n, 0);
    if (!NT_SUCCESS(s)) { r->ntstatus = (UINT32)s; r->step = P256_STEP_SIGN; return (void*)(UINT_PTR)P256_STEP_SIGN; }
    if (n != 64)        { r->ntstatus = n;         r->step = P256_STEP_SIGSHAPE; return (void*)(UINT_PTR)P256_STEP_SIGSHAPE; }

    memcpy(r->pub, g_pub, 64);
    r->pub_len = g_pub_len;
    r->priv_export = g_priv_export;
    r->step = P256_STEP_OK;
    return (void*)0;
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved)
{
    (void)h; (void)reason; (void)reserved;
    return TRUE;
}
