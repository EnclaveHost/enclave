// tpmattest.c: the TPM half of a Windows consumer node's attestation (windows/vbs/EVIDENCE.md, handshake steps 3-5),
// driven by the node agent (agent.mjs) over stdin/stdout. Raw TPM 2.0 commands through TBS (tbs.dll); no TSS.
// Build: windows/node/build-tpmattest.cmd (cl + tbs.lib bcrypt.lib ncrypt.lib crypt32.lib). Needs an elevated (admin) token
// for Tbsi_Get_OwnerAuth; everything else works as a plain user.
//
// GRAMMAR. One command per line on stdin. A reply is zero or more "<key> <value...>" lines followed by exactly one
// terminator line: "ok" or "err <step> <detail>". Byte strings are lowercase hex. The agent reads until the terminator.
//   (startup)      -> "ready tpmattest/1" once the TBS context is open and the AIK exists (or "err createprimary-aik ...", exit 2).
//   keys           -> ek-cert <hex DER of the RSA EK certificate>
//                     [ek-cert-nv-failed <step tpm-rc=...>]   the TCG NV index is absent (AMD fTPMs: the certificate comes
//                                                             from AMD's service and Windows keeps it in its EK cert store)
//                     [ek-cert-store <n> certificates, modulus match yes|no]
//                     ek-cert-source nv:0x01c00002 | ncrypt:PCP_EKCERT | none     (none = no ek-cert line)
//                     aik-pub <hex TPMT_PUBLIC>          the quoting key: restricted RSA-2048 signing key, RSASSA/SHA-256,
//                     aik-name <hex 34 bytes>            0x000b || sha256(TPMT_PUBLIC); created by CreatePrimary in the NULL
//                     ok                                 hierarchy at startup and kept loaded until quit (ephemeral per process)
//   activate <credentialBlob hex> <secret hex>
//                  -> endorsement-auth windows:<n>-bytes | empty   (the VALUE is never printed)
//                     [endorsement-auth-tbs 0x<TBS code>]         when Tbsi_Get_OwnerAuth failed and the empty auth was used
//                     [createprimary-ek-failed <step tpm-rc=...>] when the EK had to come from the persistent handle instead
//                     ek-pub <hex TPMT_PUBLIC>  ek-name <hex 34>  ek-source createprimary:endorsement | persistent:0x81010001
//                     ek-cert-match yes | no | unknown            the EK modulus is (is not) the one in the EK certificate
//                     [policy-hmac-retry <first tpm-rc>]          the first attempt with an empty session HMAC was refused
//                     policy-hmac empty | computed                which form of the policy-session HMAC the TPM accepted
//                     credential <hex>                            the bytes ActivateCredential recovered
//                     ok
//                     credentialBlob = TPM2B_ID_OBJECT contents (integrityHMAC TPM2B || encIdentity), secret =
//                     TPM2B_ENCRYPTED_SECRET contents (RSA-OAEP of the seed), exactly what makecredential.py prints.
//   quote <extraData hex, 1..64 bytes>
//                  -> attest <hex TPMS_ATTEST>  sig <hex 256-byte RSASSA-PKCS1v15-SHA256 signature>
//                     sig-scheme 0x<sigAlg> 0x<hashAlg>  aik-pub <hex TPMT_PUBLIC>  ok
//                     PCR selection: sha256 bank, PCRs {0, 7, 12, 13, 14} (bitmap 81 70 00).
//   pcr <n>        -> pcr <n> <hex sha256 value, read live>  ok
//   log            -> log <path of the newest C:\Windows\Logs\MeasuredBoot\*.log, i.e. the current boot>  ok
//   quit           -> ok, then the AIK is flushed and the process exits 0 (EOF on stdin does the same).
//   err detail forms: "tpm-rc=0x<TPM_RC>" (the TPM's response code; session/parameter number encoded as the spec says),
//                     "tbs=0x<TBS_RESULT>" (TBS refused the submission), or a short text.
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <tbs.h>
#include <bcrypt.h>
#include <ncrypt.h>
#include <wincrypt.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#pragma comment(lib, "tbs.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "ncrypt.lib")
#pragma comment(lib, "crypt32.lib")

#define TPM_RH_NULL        0x40000007u
#define TPM_RH_ENDORSEMENT 0x4000000Bu
#define TPM_RS_PW          0x40000009u
#define EK_NV_INDEX        0x01C00002u   // TCG EK Credential Profile: RSA-2048 EK certificate
#define EK_PERSISTENT      0x81010001u   // where Windows keeps the RSA EK loaded
#define AIK_ATTRS          0x00050072u   // fixedTPM|fixedParent|sensitiveDataOrigin|userWithAuth|restricted|sign
#define EK_ATTRS           0x000300B2u   // fixedTPM|fixedParent|sensitiveDataOrigin|adminWithPolicy|restricted|decrypt
static const BYTE EK_POLICY[32] = {      // PolicySecret(TPM_RH_ENDORSEMENT), TCG EK Credential Profile 2.0 default
    0x83,0x71,0x97,0x67,0x44,0x84,0xb3,0xf8,0x1a,0x90,0xcc,0x8d,0x46,0xa5,0xd7,0x24,
    0xfd,0x52,0xd7,0x6e,0x06,0x52,0x0b,0x64,0xf2,0xa1,0xda,0x1b,0x33,0x14,0x69,0xaa };

static BYTE cmd[8192], rsp[8192]; static UINT32 clen, rlen;
static TBS_HCONTEXT h; static BCRYPT_ALG_HANDLE hSha, hHmac;
static char lasterr[256];
static UINT32 aikHandle; static BYTE aikPub[512]; static UINT32 aikPubLen; static BYTE aikName[34];
static BYTE ekCert[4096]; static UINT32 ekCertLen; static const char* ekCertSource = "none"; static int ekCertTried;

// ---- marshalling
static void put8(BYTE b){ cmd[clen++] = b; } static void put16(UINT16 v){ put8((BYTE)(v>>8)); put8((BYTE)v); }
static void put32(UINT32 v){ put16((UINT16)(v>>16)); put16((UINT16)v); }
static void putbuf(const BYTE* p, UINT32 n){ if (n) memcpy(cmd+clen, p, n); clen += n; }
static void put2b(const BYTE* p, UINT32 n){ put16((UINT16)n); putbuf(p, n); }
static UINT32 g16(const BYTE* p){ return ((UINT32)p[0]<<8)|p[1]; } static UINT32 g32(const BYTE* p){ return (g16(p)<<16)|g16(p+2); }
static void begin(UINT16 tag, UINT32 cc){ clen = 0; put16(tag); put32(0); put32(cc); }
static void pwsession(const BYTE* auth, UINT32 n){ put32(9 + n); put32(TPM_RS_PW); put16(0); put8(0); put2b(auth, n); }
// Submits cmd; 0 on success, else the TPM_RC (or the TBS_RESULT, which has bit 31 set) with lasterr filled in.
static UINT32 submit(const char* what){
    cmd[2] = (BYTE)(clen>>24); cmd[3] = (BYTE)(clen>>16); cmd[4] = (BYTE)(clen>>8); cmd[5] = (BYTE)clen; rlen = sizeof rsp;
    TBS_RESULT r = Tbsip_Submit_Command(h, TBS_COMMAND_LOCALITY_ZERO, TBS_COMMAND_PRIORITY_NORMAL, cmd, clen, rsp, &rlen);
    if (r != TBS_SUCCESS) { snprintf(lasterr, sizeof lasterr, "%s tbs=0x%08x", what, r); return r ? r : 0x80000000u; }
    if (rlen < 10) { snprintf(lasterr, sizeof lasterr, "%s short-response %u", what, rlen); return 0x80000001u; }
    UINT32 rc = g32(rsp+6); if (rc) snprintf(lasterr, sizeof lasterr, "%s tpm-rc=0x%08x", what, rc);
    return rc;
}
static void flush(UINT32 handle){ begin(0x8001, 0x165); put32(handle); submit("flushcontext"); }

// ---- hex + crypto helpers
static void hexline(const char* key, const BYTE* p, UINT32 n){ printf("%s ", key); for (UINT32 i = 0; i < n; i++) printf("%02x", p[i]); printf("\n"); }
static int nib(char c){ if (c >= '0' && c <= '9') return c - '0'; c |= 0x20; if (c >= 'a' && c <= 'f') return c - 'a' + 10; return -1; }
static int unhex(const char* s, BYTE* out, int max){
    size_t n = strlen(s); if (n & 1 || (int)(n/2) > max) return -1;
    for (size_t i = 0; i < n; i += 2) { int a = nib(s[i]), b = nib(s[i+1]); if (a < 0 || b < 0) return -1; out[i/2] = (BYTE)(a*16 + b); }
    return (int)(n/2);
}
static void sha256(const BYTE* p, UINT32 n, BYTE out[32]){ BCryptHash(hSha, NULL, 0, (PUCHAR)p, n, out, 32); }
static void hmac256(const BYTE* k, UINT32 kn, const BYTE* p, UINT32 n, BYTE out[32]){ BCryptHash(hHmac, (PUCHAR)k, kn, (PUCHAR)p, n, out, 32); }
static void rnd(BYTE* p, UINT32 n){ BCryptGenRandom(NULL, p, n, BCRYPT_USE_SYSTEM_PREFERRED_RNG); }
static void name_of(const BYTE* pub, UINT32 n, BYTE name[34]){ name[0] = 0; name[1] = 0x0B; sha256(pub, n, name+2); }
// The RSA modulus inside a TPMT_PUBLIC (type RSA): walks authPolicy, TPMT_SYM_DEF_OBJECT, scheme, keyBits, exponent, unique.
static int rsa_unique(const BYTE* pub, UINT32 len, const BYTE** mod, UINT32* modlen){
    if (len < 10 || g16(pub) != 0x0001) return -1;
    UINT32 o = 8; o += 2 + g16(pub+o); if (o + 2 > len) return -1;
    UINT32 sym = g16(pub+o); o += 2; if (sym != 0x0010) o += 4;
    UINT32 scheme = g16(pub+o); o += 2; if (scheme != 0x0010) o += 2;
    o += 2 + 4; if (o + 2 > len) return -1;
    *modlen = g16(pub+o); *mod = pub + o + 2; return (o + 2 + *modlen > len) ? -1 : 0;
}
static UINT32 der_len(const BYTE* p, UINT32 n){   // total length of the DER element at p, 0 if not a SEQUENCE header
    if (n < 4 || p[0] != 0x30) return 0;
    if (p[1] < 0x80) return 2 + p[1]; if (p[1] == 0x81) return 3 + p[2]; if (p[1] == 0x82) return 4 + (((UINT32)p[2]<<8) | p[3]); return 0;
}

// ---- the EK certificate: NV 0x01c00002 first, then what Windows' platform crypto provider exposes
static int read_ek_cert_nv(void){
    begin(0x8001, 0x169); put32(EK_NV_INDEX); if (submit("nv-readpublic")) return -1;
    const BYTE* p = rsp + 10; UINT32 polsz = g16(p+12); UINT32 dataSize = g16(p+14+polsz);
    if (dataSize > sizeof ekCert) dataSize = sizeof ekCert;
    UINT32 chunk = 512;                                            // TPM_PT_NV_BUFFER_MAX, if the TPM tells us
    begin(0x8001, 0x17A); put32(6); put32(0x12C); put32(1);
    if (!submit("getcapability") && g32(rsp+15) >= 1 && g32(rsp+19) == 0x12C) { UINT32 v = g32(rsp+23); if (v >= 64 && v <= 2048) chunk = v; }
    UINT32 off = 0;
    while (off < dataSize) {
        UINT32 n = dataSize - off; if (n > chunk) n = chunk;
        begin(0x8002, 0x14E); put32(EK_NV_INDEX); put32(EK_NV_INDEX); pwsession(NULL, 0); put16((UINT16)n); put16((UINT16)off);
        UINT32 rc = submit("nv-read");
        if (rc == 0x1C4 && chunk > 64) { chunk /= 2; continue; }   // TPM_RC_VALUE on 'size': the buffer max lied; shrink
        if (rc) return -1;
        p = rsp + 14; UINT32 got = g16(p); if (!got || off + got > sizeof ekCert) break; memcpy(ekCert + off, p + 2, got); off += got;
    }
    ekCertLen = off; UINT32 dl = der_len(ekCert, ekCertLen);                              // the index may be padded past the DER
    if (!dl || dl > ekCertLen) { snprintf(lasterr, sizeof lasterr, "nv data is not a DER certificate"); ekCertLen = 0; return -1; }
    ekCertLen = dl; ekCertSource = "nv:0x01c00002"; return 0;
}
static int read_ek_cert_ncrypt(void){
    // Windows keeps the certificates it obtained (NV, or the vendor's service for AMD fTPMs) in a registry cert store;
    // the platform crypto provider's PCP_EKCERT property hands out an HCERTSTORE onto it (as Microsoft's PCPTool reads it).
    NCRYPT_PROV_HANDLE prov = 0; DWORD n = 0; HCERTSTORE store = NULL;
    SECURITY_STATUS s = NCryptOpenStorageProvider(&prov, MS_PLATFORM_CRYPTO_PROVIDER, 0);
    if (s != ERROR_SUCCESS) { snprintf(lasterr, sizeof lasterr, "ncrypt-open 0x%08x", s); return -1; }
    s = NCryptGetProperty(prov, L"PCP_EKCERT", (PBYTE)&store, sizeof store, &n, 0); NCryptFreeObject(prov);
    if (s != ERROR_SUCCESS || n != sizeof store || !store) { snprintf(lasterr, sizeof lasterr, "ncrypt PCP_EKCERT 0x%08x n=%u", s, n); return -1; }
    // pick the certificate whose DER carries the modulus of the persistent RSA EK (0x81010001); else the first one
    const BYTE* mod = NULL; UINT32 modlen = 0; BYTE ekp[512];
    begin(0x8001, 0x173); put32(EK_PERSISTENT);
    if (!submit("readpublic-0x81010001") && g16(rsp+10) <= sizeof ekp) { memcpy(ekp, rsp+12, g16(rsp+10)); if (rsa_unique(ekp, g16(rsp+10), &mod, &modlen)) mod = NULL; }
    PCCERT_CONTEXT c = NULL; int count = 0, matched = 0;
    while ((c = CertEnumCertificatesInStore(store, c)) != NULL) {
        count++; int has = 0;
        if (mod && c->cbCertEncoded >= modlen) for (DWORD i = 0; i + modlen <= c->cbCertEncoded; i++) if (!memcmp(c->pbCertEncoded + i, mod, modlen)) { has = 1; break; }
        if ((has || !ekCertLen) && !matched && c->cbCertEncoded <= sizeof ekCert) { memcpy(ekCert, c->pbCertEncoded, c->cbCertEncoded); ekCertLen = c->cbCertEncoded; matched = has; }
    }
    CertCloseStore(store, 0);
    printf("ek-cert-store %d certificates, modulus match %s\n", count, matched ? "yes" : "no");
    UINT32 dl = ekCertLen ? der_len(ekCert, ekCertLen) : 0;
    if (!dl || dl > ekCertLen) { snprintf(lasterr, sizeof lasterr, "PCP_EKCERT store has no usable certificate (%d)", count); ekCertLen = 0; return -1; }
    ekCertLen = dl; ekCertSource = "ncrypt:PCP_EKCERT"; return 0;
}
static void load_ek_cert(void){
    if (ekCertTried) return; ekCertTried = 1;
    if (read_ek_cert_nv() == 0) return;
    printf("ek-cert-nv-failed %s\n", lasterr);   // tpm-rc=0x8b = no such index: AMD fTPMs get their certificate from AMD's service, Windows stores it
    if (read_ek_cert_ncrypt()) { printf("ek-cert-unavailable %s\n", lasterr); ekCertLen = 0; }
}

// ---- the AIK: CreatePrimary in the NULL hierarchy (no auth), kept loaded for the life of the process
static int create_aik(void){
    begin(0x8002, 0x131); put32(TPM_RH_NULL); pwsession(NULL, 0);
    put16(4); put16(0); put16(0);                                                    // inSensitive: no auth, no data
    put16(24); put16(0x0001); put16(0x000B); put32(AIK_ATTRS); put16(0);             // RSA, SHA-256 name, no policy
    put16(0x0010); put16(0x0014); put16(0x000B); put16(2048); put32(0); put16(0);    // sym NULL, RSASSA/SHA-256, 2048, e=default, unique empty
    put16(0); put32(0);                                                              // outsideInfo, creationPCR
    if (submit("createprimary-aik")) return -1;
    aikHandle = g32(rsp+10); aikPubLen = g16(rsp+18); if (aikPubLen > sizeof aikPub) { snprintf(lasterr, sizeof lasterr, "aik public too large"); return -1; }
    memcpy(aikPub, rsp+20, aikPubLen); name_of(aikPub, aikPubLen, aikName);
    const BYTE* p = rsp + 20 + aikPubLen; p += 2 + g16(p); p += 2 + g16(p);          // creationData, creationHash
    p += 6; p += 2 + g16(p);                                                          // TPMT_TK_CREATION: tag, hierarchy, digest
    if (g16(p) != 34 || memcmp(p+2, aikName, 34)) { snprintf(lasterr, sizeof lasterr, "aik name mismatch (TPM vs sha256 of TPMT_PUBLIC)"); return -1; }
    return 0;
}

static void cmd_keys(void){
    load_ek_cert();
    if (ekCertLen) hexline("ek-cert", ekCert, ekCertLen);
    printf("ek-cert-source %s\n", ekCertSource);
    hexline("aik-pub", aikPub, aikPubLen); hexline("aik-name", aikName, 34); puts("ok");
}

// ---- activate: EK under the endorsement hierarchy, PolicySecret(ENDORSEMENT) session, ActivateCredential(AIK, EK)
static void cmd_activate(const char* blobHex, const char* secretHex){
    BYTE blob[1024], secret[1024]; int bl = unhex(blobHex, blob, sizeof blob), sl = unhex(secretHex, secret, sizeof secret);
    if (bl <= 0 || sl <= 0) { puts("err activate bad-hex"); return; }
    // 1. the endorsement hierarchy's auth value, which Windows set at provisioning and keeps for administrators
    BYTE eauth[256]; UINT32 eauthLen = sizeof eauth;
    TBS_RESULT tr = Tbsi_Get_OwnerAuth(h, TBS_OWNERAUTH_TYPE_ENDORSEMENT_20, eauth, &eauthLen);
    if (tr != TBS_SUCCESS) { printf("endorsement-auth-tbs 0x%08x\n", tr); eauthLen = 0; }
    if (eauthLen) printf("endorsement-auth windows:%u-bytes\n", eauthLen); else puts("endorsement-auth empty");
    // 2. the EK, from the TCG default RSA-2048 template (Template L-1: unique = 256 zero bytes)
    UINT32 ek = 0, rc; int ekCreated = 0; BYTE ekPub[512]; UINT32 ekPubLen = 0; const char* ekSource;
    begin(0x8002, 0x131); put32(TPM_RH_ENDORSEMENT); pwsession(eauth, eauthLen);
    put16(4); put16(0); put16(0);
    put16(314); put16(0x0001); put16(0x000B); put32(EK_ATTRS); put2b(EK_POLICY, 32);
    put16(0x0006); put16(128); put16(0x0043); put16(0x0010); put16(2048); put32(0);
    { BYTE z[256] = {0}; put2b(z, 256); }
    put16(0); put32(0);
    rc = submit("createprimary-ek");
    if (rc == 0) { ek = g32(rsp+10); ekCreated = 1; ekPubLen = g16(rsp+18); memcpy(ekPub, rsp+20, ekPubLen); ekSource = "createprimary:endorsement"; }
    else {
        printf("createprimary-ek-failed %s\n", lasterr);
        begin(0x8001, 0x173); put32(EK_PERSISTENT);
        if (submit("readpublic-0x81010001")) { printf("err activate ek-unavailable %s\n", lasterr); return; }
        ek = EK_PERSISTENT; ekPubLen = g16(rsp+10); memcpy(ekPub, rsp+12, ekPubLen); ekSource = "persistent:0x81010001";
    }
    BYTE ekName[34]; name_of(ekPub, ekPubLen, ekName);
    hexline("ek-pub", ekPub, ekPubLen); hexline("ek-name", ekName, 34); printf("ek-source %s\n", ekSource);
    // 3. the EK public must be the key in the EK certificate (the modulus appears verbatim in the DER)
    const BYTE* mod; UINT32 modlen; load_ek_cert(); int match = -1;
    if (rsa_unique(ekPub, ekPubLen, &mod, &modlen)) { if (ekCreated) flush(ek); puts("err activate ek-public-unparsable"); return; }
    if (ekCertLen >= modlen) { match = 0; for (UINT32 i = 0; i + modlen <= ekCertLen; i++) if (!memcmp(ekCert + i, mod, modlen)) { match = 1; break; } }
    printf("ek-cert-match %s\n", match == 1 ? "yes" : match == 0 ? "no" : "unknown");
    if (match == 0) { if (ekCreated) flush(ek); puts("err activate ek-public-mismatch"); return; }
    // 4. a policy session (unsalted, unbound, SHA-256) and PolicySecret against the endorsement hierarchy
    BYTE nonceCaller[32], nonceTpm[64]; UINT32 nonceTpmLen; rnd(nonceCaller, 32);
    begin(0x8001, 0x176); put32(TPM_RH_NULL); put32(TPM_RH_NULL); put2b(nonceCaller, 32); put16(0); put8(0x01); put16(0x0010); put16(0x000B);
    if (submit("startauthsession")) { if (ekCreated) flush(ek); printf("err activate %s\n", lasterr); return; }
    UINT32 sess = g32(rsp+10); nonceTpmLen = g16(rsp+14); if (nonceTpmLen > sizeof nonceTpm) nonceTpmLen = sizeof nonceTpm; memcpy(nonceTpm, rsp+16, nonceTpmLen);
    begin(0x8002, 0x151); put32(TPM_RH_ENDORSEMENT); put32(sess); pwsession(eauth, eauthLen);
    put2b(nonceTpm, nonceTpmLen); put16(0); put16(0); put32(0);                      // nonceTPM, cpHashA, policyRef, expiration
    if (submit("policysecret")) { flush(sess); if (ekCreated) flush(ek); printf("err activate %s\n", lasterr); return; }
    // 5. ActivateCredential: AIK with a password session (ADMIN role, empty auth), EK with the policy session.
    //    The session is unsalted and unbound and PolicySecret does not set isAuthValueNeeded, so the HMAC key is empty;
    //    Part 1 (19.6.5) lets the hmac field be empty then. If the TPM refuses that, retry once with the real HMAC over cpHash.
    BYTE nc[32], hmac[32]; UINT32 hmacLen = 0; const char* mode = "empty"; rnd(nc, 32);
    for (int attempt = 0; attempt < 2; attempt++) {
        begin(0x8002, 0x147); put32(aikHandle); put32(ek);
        put32(9 + (4 + 2 + 32 + 1 + 2 + hmacLen));
        put32(TPM_RS_PW); put16(0); put8(0); put16(0);
        put32(sess); put2b(nc, 32); put8(0x01); put2b(hmac, hmacLen);
        put2b(blob, bl); put2b(secret, sl);
        rc = submit("activatecredential");
        if (rc == 0 || attempt) break;
        if ((rc & 0xFFFF0000u) == 0 && (rc & 0x80) && ((rc & 0x3F) == 0x0E || (rc & 0x3F) == 0x22)) {   // TPM_RC_AUTH_FAIL / BAD_AUTH
            printf("policy-hmac-retry %s\n", lasterr);
            static BYTE buf[4 + 34 + 34 + 2 + 1024 + 2 + 1024]; UINT32 n = 0; BYTE cp[32], m[32 + 32 + 64 + 1];
            buf[n++] = 0; buf[n++] = 0; buf[n++] = 0x01; buf[n++] = 0x47; memcpy(buf+n, aikName, 34); n += 34; memcpy(buf+n, ekName, 34); n += 34;
            buf[n++] = (BYTE)(bl>>8); buf[n++] = (BYTE)bl; memcpy(buf+n, blob, bl); n += bl; buf[n++] = (BYTE)(sl>>8); buf[n++] = (BYTE)sl; memcpy(buf+n, secret, sl); n += sl;
            sha256(buf, n, cp); n = 0; memcpy(m, cp, 32); n = 32; memcpy(m+n, nc, 32); n += 32; memcpy(m+n, nonceTpm, nonceTpmLen); n += nonceTpmLen; m[n++] = 0x01;
            hmac256(NULL, 0, m, n, hmac); hmacLen = 32; mode = "computed"; continue;
        }
        break;
    }
    flush(sess); if (ekCreated) flush(ek);
    if (rc) { printf("err activate %s\n", lasterr); return; }
    const BYTE* p = rsp + 14; UINT32 cl = g16(p);
    printf("policy-hmac %s\n", mode); hexline("credential", p+2, cl); puts("ok");
}

static void cmd_quote(const char* extraHex){
    BYTE extra[64]; int el = unhex(extraHex, extra, sizeof extra); if (el <= 0) { puts("err quote bad-hex"); return; }
    begin(0x8002, 0x158); put32(aikHandle); pwsession(NULL, 0);
    put2b(extra, el); put16(0x0010);                                                 // qualifyingData, inScheme NULL -> key's RSASSA/SHA-256
    put32(1); put16(0x000B); put8(3); put8(0x81); put8(0x70); put8(0x00);            // sha256 bank: PCR 0,7 | 12,13,14
    if (submit("quote")) { printf("err quote %s\n", lasterr); return; }
    const BYTE* p = rsp + 14; UINT32 qsz = g16(p); const BYTE* quoted = p + 2; p += 2 + qsz;
    UINT32 sigalg = g16(p), sighash = g16(p+2), siglen = g16(p+4); const BYTE* sig = p + 6;
    hexline("attest", quoted, qsz); hexline("sig", sig, siglen); printf("sig-scheme 0x%04x 0x%04x\n", sigalg, sighash); hexline("aik-pub", aikPub, aikPubLen); puts("ok");
}

static void cmd_pcr(const char* arg){
    int n = atoi(arg); if (n < 0 || n > 23) { puts("err pcr range"); return; }
    begin(0x8001, 0x17E); put32(1); put16(0x000B); put8(3); put8(n < 8 ? (BYTE)(1 << n) : 0); put8(n >= 8 && n < 16 ? (BYTE)(1 << (n-8)) : 0); put8(n >= 16 ? (BYTE)(1 << (n-16)) : 0);
    if (submit("pcr-read")) { printf("err pcr %s\n", lasterr); return; }
    const BYTE* p = rsp + 14; UINT32 nsel = g32(p); p += 4;
    for (UINT32 i = 0; i < nsel; i++) p += 3 + p[2];
    UINT32 ndig = g32(p); p += 4; if (ndig < 1) { puts("err pcr no-digest"); return; }
    char key[16]; snprintf(key, sizeof key, "pcr %d", n); hexline(key, p+2, g16(p)); puts("ok");
}

static void cmd_log(void){
    WIN32_FIND_DATAA fd; char best[MAX_PATH] = "";
    HANDLE f = FindFirstFileA("C:\\Windows\\Logs\\MeasuredBoot\\*.log", &fd);
    if (f == INVALID_HANDLE_VALUE) { printf("err log no-measured-boot-log 0x%08x\n", GetLastError()); return; }
    do { if (strcmp(fd.cFileName, best) > 0) strcpy(best, fd.cFileName); } while (FindNextFileA(f, &fd));   // names are zero-padded boot counters
    FindClose(f); printf("log C:\\Windows\\Logs\\MeasuredBoot\\%s\n", best); puts("ok");
}

int main(void){
    setvbuf(stdout, NULL, _IONBF, 0);
    if (BCryptOpenAlgorithmProvider(&hSha, BCRYPT_SHA256_ALGORITHM, NULL, 0) || BCryptOpenAlgorithmProvider(&hHmac, BCRYPT_SHA256_ALGORITHM, NULL, BCRYPT_ALG_HANDLE_HMAC_FLAG)) { puts("err bcrypt open"); return 2; }
    TBS_CONTEXT_PARAMS2 prm = {0}; prm.version = TBS_CONTEXT_VERSION_TWO; prm.includeTpm20 = 1;
    TBS_RESULT r = Tbsi_Context_Create((PCTBS_CONTEXT_PARAMS)&prm, &h); if (r != TBS_SUCCESS) { printf("err tbs-context 0x%08x\n", r); return 2; }
    if (create_aik()) { printf("err %s\n", lasterr); Tbsip_Context_Close(h); return 2; }
    puts("ready tpmattest/1");
    static char line[8192];
    while (fgets(line, sizeof line, stdin)) {
        const char* sep = " \t\r\n"; char* c = strtok(line, sep); if (!c) continue;
        char* a1 = strtok(NULL, sep); char* a2 = strtok(NULL, sep);
        if (!strcmp(c, "keys")) cmd_keys();
        else if (!strcmp(c, "activate")) { if (!a1 || !a2) puts("err activate usage: activate <credentialBlob hex> <secret hex>"); else cmd_activate(a1, a2); }
        else if (!strcmp(c, "quote")) { if (!a1) puts("err quote usage: quote <extraData hex>"); else cmd_quote(a1); }
        else if (!strcmp(c, "pcr")) { if (!a1) puts("err pcr usage: pcr <n>"); else cmd_pcr(a1); }
        else if (!strcmp(c, "log")) cmd_log();
        else if (!strcmp(c, "quit")) { puts("ok"); break; }
        else printf("err unknown-command %s\n", c);
    }
    flush(aikHandle); Tbsip_Context_Close(h); return 0;
}
