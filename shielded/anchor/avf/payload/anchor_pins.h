/* Measured pins for the phone anchor (PAD-BOOTSTRAP.md, "Required consumer integration").
 *
 * Everything that decides what this payload trusts comes from the APK's assets, which the
 * pVM measures (idsig): the mode, the platform's pad-ledger key, the expected model digest and
 * the shared-prefix key. The owner app forwards the same values over the control channel
 * for routing convenience; a pinned build compares and refuses, it never adopts. */
#ifndef ANCHOR_PINS_H
#define ANCHOR_PINS_H
#include <stddef.h>
#include <stdint.h>

enum { ANCHOR_MODE_INVALID = 0, ANCHOR_MODE_DEV = 1, ANCHOR_MODE_PROTECTED = 2 };

typedef struct {
    int mode;                                   /* ANCHOR_MODE_* */
    int has_ledger, has_model, has_prefix;      /* which pins the build carries */
    uint8_t ledger_pk[32], model_sha256[32], prefix_pk[32];
    /* Catalog pins (CATALOG.md): the measured identities of assets/model.agcat (source catalog), assets/model.ewcat
     * (encoded-artifact catalog) and the offline converter. Optional in either mode; present-but-malformed is INVALID
     * like every other pin, and an encoded pin without both the source-catalog and converter pins is INVALID. */
    int has_source_catalog, has_encoded_catalog, has_converter;
    uint8_t source_catalog_sha256[32], encoded_catalog_sha256[32], converter_sha256[32];
    char err[160];                              /* why the pins are not usable */
} anchor_pins;

/* Reads <dir>/anchor.mode ("dev" | "protected"), <dir>/ledger.pk, <dir>/model.sha256, <dir>/prefix.pk, and the
 * optional <dir>/source-catalog.sha256, <dir>/encoded-catalog.sha256, <dir>/converter.sha256
 * (64 lowercase hex, one trailing newline allowed). Returns 1 when the build's pins are usable, 0 when
 * they are not (pins->err says why, pins->mode is ANCHOR_MODE_INVALID). A protected build needs all
 * three pins well-formed; a dev build may lack pins, but a pin that is present and malformed is an
 * error in either mode - a corrupt asset never silently selects a weaker trust path. A missing or
 * unknown mode file is an error: the mode is an explicit, measured build option. */
int anchor_pins_load(const char *dir, anchor_pins *pins);

/* SHA-256 (FIPS 180-4) of a file, streamed; returns 0 on success. */
int anchor_sha256_file(const char *path, uint8_t out[32], uint64_t *bytes);
void anchor_sha256(const uint8_t *m, size_t n, uint8_t out[32]);
/* Incremental form for hashing the pin and tensor ranges from the same read.
 * Context storage is opaque and need not be aligned; callers may use this
 * typedef or at least sizeof(anchor_sha256_ctx) bytes. Initialize before use,
 * update zero or more times, finalize once. Finalization clears the context. */
typedef struct { uint8_t opaque[128]; } anchor_sha256_ctx;
void anchor_sha256_init(void *ctx);
void anchor_sha256_update(void *ctx, const uint8_t *m, size_t n);
void anchor_sha256_final(void *ctx, uint8_t out[32]);
/* Runtime-selected implementation, for confirming guest CPU capabilities in logs. */
const char *anchor_sha256_backend(void);

/* SHA-256 of an open descriptor from offset 0 (pread; the offset is left alone). 0 on success. */
int anchor_sha256_fd(int fd, uint8_t out[32], uint64_t *bytes);

/* The model that will actually be parsed, as an OPEN descriptor after the last write to it, against the
 * build's pin and, when `frozen` is set, the digest a seed grant was issued for. 1 = usable and digest_out
 * holds its SHA-256; 0 = refuse (err: unreadable or empty, differs from the pin, differs from the grant).
 * Without a pin and without a frozen digest (a dev build before its grant) the bytes are only hashed. */
int anchor_pins_model_fd_check(const anchor_pins *pins, int fd, const uint8_t *frozen, uint8_t digest_out[32], char *err, size_t errcap);

/* The model file against the pin. 1 = the file's SHA-256 equals model_sha256; 0 = it differs, the file is
 * unreadable, or the build has no model pin (err says which). digest_out receives the actual digest. */
int anchor_pins_model_matches(const anchor_pins *pins, const char *path, uint8_t digest_out[32], char *err, size_t errcap);
#endif
