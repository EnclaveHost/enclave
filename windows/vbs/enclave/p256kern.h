/* The one structure that crosses the gate for the ES256 key-custody spike.
 *
 * What this spike is for: metal0 mints its session-signing key inside the measured guest, so its
 * operator never holds the private half and cannot forge a session for somebody else's wallet. The
 * Windows node mints the same ES256 key with node:crypto in VTL0, where the machine owner can read
 * it out of process memory. windows/PARITY.md records that as the one SECURITY GAP rather than a
 * difference, and closing it means minting and using the key inside VTL1.
 *
 * The enclave's existing crypto is TweetNaCl - Ed25519 and X25519, no P-256 - so the question is
 * whether the enclave-flavoured bcrypt.dll (already linked, already used for BCryptGenRandom)
 * offers ASYMMETRIC primitives inside an enclave, or only the RNG. That is a measurement, not an
 * argument, which is what this is.
 *
 * Note what does NOT cross: there is no field for the private key. The host gets a public key and
 * a signature over a digest it chose, and nothing else - which is the property the whole exercise
 * is about. */
#pragma once
#include <windows.h>

#define P256_STEP_OK        0
#define P256_STEP_OPEN      1   /* BCryptOpenAlgorithmProvider(ECDSA_P256) */
#define P256_STEP_GENERATE  2   /* BCryptGenerateKeyPair */
#define P256_STEP_FINALIZE  3   /* BCryptFinalizeKeyPair */
#define P256_STEP_EXPORTPUB 4   /* BCryptExportKey(BCRYPT_ECCPUBLIC_BLOB) */
#define P256_STEP_BLOBSHAPE 5   /* the exported blob was not the 32+32 we expect */
#define P256_STEP_SIGN      6   /* BCryptSignHash */
#define P256_STEP_SIGSHAPE  7   /* the signature was not 64 bytes of R||S */

typedef struct {
    UINT8  digest[32];      /* in : the SHA-256 the host wants signed */
    UINT8  pub[64];         /* out: the public key as X||Y */
    UINT8  sig[64];         /* out: R||S - exactly the IEEE P-1363 form an ES256 JWT carries */
    UINT32 step;            /* out: P256_STEP_OK, or the step that failed */
    UINT32 ntstatus;        /* out: what BCrypt said at that step */
    UINT32 pub_len;         /* out: the exported public blob's length, for the record */
    UINT32 priv_export;     /* out: what exporting the PRIVATE blob from inside returned. Recorded
                             *      because the honest claim is "the private half never crosses the
                             *      gate", not "the enclave could not export it if it wanted to". */
    UINT32 reused;          /* out: 1 if this call reused the key minted by the first call, which is
                             *      what a per-boot session key would do. */
} P256_REQ;
