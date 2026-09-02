/*
 * attest_probe -- the first thing that runs INSIDE a protected VM on the Pixel.
 *
 * It answers the one question no property on the device can: does THIS unit's
 * pVM produce an RKP-backed attestation? Every other gate (protected-VM support,
 * the VINTF /avf declaration, the shipped service_vm.bin, the sysprop default)
 * was read off the device and is open. The fifth gate -- whether Google's RKP
 * factory registered this unit's UDS-rooted key -- only shows up as the return
 * code of AVmPayload_requestAttestation().
 *
 * Output goes to the VM console (visible on the host with `--console <file>`
 * for a debuggable VM), one tagged line per fact, so the host side can grep it:
 *   STEP <name>                        printed BEFORE each call, so a crash is located
 *   ATTEST status=<name> code=<n>
 *   DICE chain_bytes=<n> hex=<...>     the local DICE chain (no RKP needed)
 *   CERT[i] bytes=<n> hex=<DER>        the RKP-issued X.509 chain, if any
 *
 * Every libvm_payload call that can abort on an internal RPC failure
 * (unwrap_or_abort in the Rust side) is announced first, and buffers are real
 * rather than NULL/0 size queries, so an abort is attributable to one call.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <android/log.h>

#include "vm_payload.h"

#define TAG "anchor-probe"
#define OUT(...) do { printf(__VA_ARGS__); printf("\n"); fflush(stdout); \
                      __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__); } while (0)
#define STEP(s) OUT("STEP %s", s)

static void hexline(const char *label, const uint8_t *p, size_t n) {
    /* liblog truncates long lines; print hex in 512-byte chunks so nothing is lost */
    const size_t CH = 512;
    OUT("%s bytes=%zu chunks=%zu", label, n, (n + CH - 1) / CH);
    for (size_t off = 0; off < n; off += CH) {
        size_t m = n - off < CH ? n - off : CH;
        char s[CH * 2 + 1];
        for (size_t i = 0; i < m; i++) sprintf(s + 2 * i, "%02x", p[off + i]);
        s[2 * m] = 0;
        OUT("%s[%zu] %s", label, off / CH, s);
    }
}

int AVmPayload_main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    OUT("PROBE start apk=%s", AVmPayload_getApkContentsPath());
    STEP("notify-ready");
    AVmPayload_notifyPayloadReady();

    /* NOTE: AVmPayload_getDiceAttestationChain is a RESTRICTED API. Measured on
     * the Pixel 8 Pro: microdroid_manager answers EX_SECURITY "Use of restricted
     * APIs is not allowed" for a payload launched by the vm tool, and libvm_payload
     * aborts on that (lib.rs:90). It is not needed for RKP attestation, so it is
     * not called. */

    /* 2. The real question. 32-byte challenge, as a verifier would send. */
    STEP("request-attestation");
    uint8_t challenge[32];
    for (int i = 0; i < 32; i++) challenge[i] = (uint8_t)(0xA5 ^ i);
    AVmAttestationResult *res = NULL;
    AVmAttestationStatus st = AVmPayload_requestAttestation(challenge, sizeof challenge, &res);
    OUT("ATTEST status=%s code=%d", AVmAttestationStatus_toString(st), (int)st);

    if (st == ATTESTATION_OK && res) {
        STEP("certs");
        size_t n = AVmAttestationResult_getCertificateCount(res);
        OUT("ATTEST certs=%zu", n);
        for (size_t i = 0; i < n; i++) {
            size_t sz = AVmAttestationResult_getCertificateAt(res, i, NULL, 0);
            uint8_t *c = malloc(sz);
            if (!c) continue;
            AVmAttestationResult_getCertificateAt(res, i, c, sz);
            char label[24]; snprintf(label, sizeof label, "CERT%zu", i);
            hexline(label, c, sz);
            free(c);
        }
        STEP("sign");
        size_t ssz = AVmAttestationResult_sign(res, challenge, sizeof challenge, NULL, 0);
        uint8_t *sig = malloc(ssz);
        if (sig) { AVmAttestationResult_sign(res, challenge, sizeof challenge, sig, ssz); hexline("SIG", sig, ssz); free(sig); }
        AVmAttestationResult_free(res);
    }
    OUT("PROBE end");
    sleep(2);           /* let the console drain before the VM goes away */
    return 0;
}
