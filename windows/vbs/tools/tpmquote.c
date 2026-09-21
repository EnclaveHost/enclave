// TPM2_CreatePrimary (NULL hierarchy, restricted RSA-2048 signing key) + TPM2_Quote over selected PCRs,
// through Windows TBS. Writes aik_pub.bin (TPMT_PUBLIC), quoted.bin (TPMS_ATTEST), sig.bin (raw RSASSA sig).
#include <windows.h>
#include <tbs.h>
#include <stdio.h>
#include <string.h>
#pragma comment(lib, "tbs.lib")
static BYTE cmd[4096], rsp[4096]; static UINT32 clen, rlen;
static void put8(BYTE b){ cmd[clen++] = b; } static void put16(UINT16 v){ put8(v>>8); put8(v&0xff); }
static void put32(UINT32 v){ put16(v>>16); put16(v&0xffff); } static void putbuf(const BYTE* p, int n){ memcpy(cmd+clen, p, n); clen += n; }
static UINT32 g16(const BYTE* p){ return (p[0]<<8)|p[1]; } static UINT32 g32(const BYTE* p){ return (g16(p)<<16)|g16(p+2); }
static void save(const char* n, const BYTE* p, int len){ FILE* f = fopen(n, "wb"); fwrite(p, 1, len, f); fclose(f); }
static TBS_HCONTEXT h;
static int submit(const char* what){
    cmd[2] = (clen>>24)&0xff; cmd[3] = (clen>>16)&0xff; cmd[4] = (clen>>8)&0xff; cmd[5] = clen&0xff; rlen = sizeof rsp;
    TBS_RESULT r = Tbsip_Submit_Command(h, TBS_COMMAND_LOCALITY_ZERO, TBS_COMMAND_PRIORITY_NORMAL, cmd, clen, rsp, &rlen);
    if (r != TBS_SUCCESS) { printf("%s: TBS error 0x%08x\n", what, r); return -1; }
    UINT32 rc = g32(rsp+6); if (rc) { printf("%s: TPM rc 0x%08x\n", what, rc); return -1; }
    return 0;
}
int main(int argc, char** argv){
    TBS_CONTEXT_PARAMS2 prm = {0}; prm.version = TBS_CONTEXT_VERSION_TWO; prm.includeTpm20 = 1;
    if (Tbsi_Context_Create((PCTBS_CONTEXT_PARAMS)&prm, &h) != TBS_SUCCESS) { puts("ctx fail"); return 1; }
    // ---- CreatePrimary under TPM_RH_NULL: no auth needed, key is ephemeral for this boot
    clen = 0; put16(0x8002); put32(0); put32(0x131); put32(0x40000007);
    put32(9); put32(0x40000009); put16(0); put8(0); put16(0);                  // password session, empty
    put16(4); put16(0); put16(0);                                               // inSensitive
    put16(24); put16(0x0001); put16(0x000B); put32(0x00050072); put16(0);       // RSA, SHA256, fixedTPM|fixedParent|sensitiveDataOrigin|userWithAuth|restricted|sign
    put16(0x0010); put16(0x0014); put16(0x000B); put16(2048); put32(0); put16(0); // sym NULL, RSASSA/SHA256, 2048, exp default, unique empty
    put16(0); put32(0);                                                         // outsideInfo, creationPCR
    if (submit("CreatePrimary")) return 2;
    UINT32 handle = g32(rsp+10); const BYTE* p = rsp + 14; p += 4;             // paramSize
    UINT32 pubsz = g16(p); const BYTE* tpmt = p + 2; save("aik_pub.bin", tpmt, pubsz);
    printf("CreatePrimary: handle=0x%08x TPMT_PUBLIC=%u bytes\n", handle, pubsz);
    // ---- Quote
    BYTE nonce[32]; for (int i = 0; i < 32; i++) nonce[i] = (BYTE)(0x5A ^ (i*7));
    clen = 0; put16(0x8002); put32(0); put32(0x158); put32(handle);
    put32(9); put32(0x40000009); put16(0); put8(0); put16(0);
    put16(32); putbuf(nonce, 32);                                               // qualifyingData
    put16(0x0010);                                                              // inScheme NULL -> key's RSASSA/SHA256
    put32(1); put16(0x000B); put8(3); put8(0x81); put8(0x70); put8(0x00);        // PCR 0,7 | 12,13,14
    if (submit("Quote")) return 3;
    p = rsp + 10; p += 4;                                                       // paramSize
    UINT32 qsz = g16(p); const BYTE* quoted = p + 2; p += 2 + qsz;
    UINT32 sigalg = g16(p), sighash = g16(p+2), siglen = g16(p+4); const BYTE* sig = p + 6;
    save("quoted.bin", quoted, qsz); save("quote_sig.bin", sig, siglen); save("quote_nonce.bin", nonce, 32);
    printf("Quote: TPMS_ATTEST=%u bytes, sigAlg=0x%04x hash=0x%04x sig=%u bytes\n", qsz, sigalg, sighash, siglen);
    // ---- FlushContext
    clen = 0; put16(0x8001); put32(0); put32(0x165); put32(handle); submit("FlushContext");
    Tbsip_Context_Close(h); return 0;
}
