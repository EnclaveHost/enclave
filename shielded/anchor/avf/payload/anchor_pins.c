#include "anchor_pins.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "../../../../wasm/ggml-shielded/shielded-sha256.h"

const char *anchor_sha256_backend(void) {
#ifdef ANCHOR_SHA2_ARM
    if (sha_select() == sha_blocks_arm) return "arm_sha2";
#endif
    return "scalar";
}
void anchor_sha256(const uint8_t *m, size_t n, uint8_t out[32]) { sha256_ctx c; sha_init(&c); sha_update(&c, m, n); sha_final(&c, out); }
_Static_assert(sizeof(sha256_ctx) <= sizeof(anchor_sha256_ctx), "incremental SHA context is too small");
/* Copying the small state avoids alignment and aliasing requirements for an
 * opaque caller buffer; bulk message bytes still go directly to SHA2. */
void anchor_sha256_init(void *ctx) {
    sha256_ctx c = {0}; sha_init(&c);
    memset(ctx, 0, sizeof(anchor_sha256_ctx)); memcpy(ctx, &c, sizeof c);
}
void anchor_sha256_update(void *ctx, const uint8_t *m, size_t n) {
    sha256_ctx c; memcpy(&c, ctx, sizeof c); sha_update(&c, m, n); memcpy(ctx, &c, sizeof c);
}
void anchor_sha256_final(void *ctx, uint8_t out[32]) {
    sha256_ctx c; memcpy(&c, ctx, sizeof c); sha_final(&c, out);
    memset(ctx, 0, sizeof(anchor_sha256_ctx));
}
/* -1 on ANY failure, including a read error mid-file: a short digest must never pass for the file's. */
int anchor_sha256_file(const char *path, uint8_t out[32], uint64_t *bytes) {
    return sh_sha256_file(path, out, bytes);
}

/* ---- pins ------------------------------------------------------------------------- */
/* 0 = absent, 1 = well-formed 32 bytes, -1 = present but malformed */
static int read_hex32(const char *dir, const char *name, uint8_t out[32]) {
    char path[600]; snprintf(path, sizeof path, "%s/%s", dir, name);
    FILE *f = fopen(path, "rb"); if (!f) return errno == ENOENT ? 0 : -1;   /* present but unreadable is NOT absent */
    char buf[80]; size_t n = fread(buf, 1, sizeof buf, f); const int bad = ferror(f); fclose(f);
    if (bad) return -1;
    if (n == 65 && buf[64] == '\n') n = 64;
    if (n != 64) return -1;
    for (size_t i = 0; i < 64; i++) {
        const char c = buf[i]; int v;
        if (c >= '0' && c <= '9') v = c - '0'; else if (c >= 'a' && c <= 'f') v = c - 'a' + 10; else return -1;   /* lowercase only: one canonical spelling */
        if (i & 1) out[i / 2] = (uint8_t)(out[i / 2] | v); else out[i / 2] = (uint8_t)(v << 4);
    }
    return 1;
}

int anchor_pins_load(const char *dir, anchor_pins *p) {
    if (!p) return 0;
    memset(p, 0, sizeof *p);
    char path[600]; snprintf(path, sizeof path, "%s/anchor.mode", dir ? dir : "");
    FILE *f = fopen(path, "rb");
    if (!f) { snprintf(p->err, sizeof p->err, "anchor.mode missing: the trust mode is a measured build option, not a default"); return 0; }
    /* exact canonical bytes: "dev" or "protected", at most one trailing newline, nothing else - no
     * embedded NUL (strcmp would stop there), no padding, no longer file */
    char m[32]; size_t n = fread(m, 1, sizeof m, f); const int bad = ferror(f); fclose(f);
    if (bad || n == sizeof m) { snprintf(p->err, sizeof p->err, "anchor.mode unreadable or too long"); return 0; }
    if (n && m[n - 1] == '\n') n--;
    if (n == 3 && !memcmp(m, "dev", 3)) p->mode = ANCHOR_MODE_DEV;
    else if (n == 9 && !memcmp(m, "protected", 9)) p->mode = ANCHOR_MODE_PROTECTED;
    else { snprintf(p->err, sizeof p->err, "anchor.mode is neither dev nor protected"); return 0; }
    const int rl = read_hex32(dir, "ledger.pk", p->ledger_pk), rm = read_hex32(dir, "model.sha256", p->model_sha256), rp = read_hex32(dir, "prefix.pk", p->prefix_pk);
    if (rl < 0) { snprintf(p->err, sizeof p->err, "ledger.pk present but malformed or unreadable"); p->mode = ANCHOR_MODE_INVALID; return 0; }
    if (rm < 0) { snprintf(p->err, sizeof p->err, "model.sha256 present but malformed or unreadable"); p->mode = ANCHOR_MODE_INVALID; return 0; }
    if (rp < 0) { snprintf(p->err, sizeof p->err, "prefix.pk present but malformed or unreadable"); p->mode = ANCHOR_MODE_INVALID; return 0; }
    p->has_ledger = rl == 1; p->has_model = rm == 1; p->has_prefix = rp == 1;
    const int rs = read_hex32(dir, "source-catalog.sha256", p->source_catalog_sha256), re = read_hex32(dir, "encoded-catalog.sha256", p->encoded_catalog_sha256), rc = read_hex32(dir, "converter.sha256", p->converter_sha256);
    if (rs < 0) { snprintf(p->err, sizeof p->err, "source-catalog.sha256 present but malformed or unreadable"); p->mode = ANCHOR_MODE_INVALID; return 0; }
    if (re < 0) { snprintf(p->err, sizeof p->err, "encoded-catalog.sha256 present but malformed or unreadable"); p->mode = ANCHOR_MODE_INVALID; return 0; }
    if (rc < 0) { snprintf(p->err, sizeof p->err, "converter.sha256 present but malformed or unreadable"); p->mode = ANCHOR_MODE_INVALID; return 0; }
    p->has_source_catalog = rs == 1; p->has_encoded_catalog = re == 1; p->has_converter = rc == 1;
    if (p->has_encoded_catalog && !(p->has_source_catalog && p->has_converter)) {   /* an encoded catalog binds both; a build that pins one without the others is inconsistent, not "partially on" */
        snprintf(p->err, sizeof p->err, "encoded-catalog.sha256 without%s%s", p->has_source_catalog ? "" : " source-catalog.sha256", p->has_converter ? "" : " converter.sha256");
        p->mode = ANCHOR_MODE_INVALID; return 0;
    }
    if (p->mode == ANCHOR_MODE_PROTECTED && !(p->has_ledger && p->has_model && p->has_prefix)) {
        snprintf(p->err, sizeof p->err, "protected build without pins:%s%s%s", p->has_ledger ? "" : " ledger", p->has_model ? "" : " model", p->has_prefix ? "" : " prefix");
        p->mode = ANCHOR_MODE_INVALID; return 0;
    }
    return 1;
}

int anchor_pins_model_matches(const anchor_pins *p, const char *path, uint8_t digest_out[32], char *err, size_t errcap) {
    uint8_t d[32]; uint64_t bytes = 0;
    if (!p || !p->has_model) { if (err) snprintf(err, errcap, "no model pin in this build"); return 0; }
    if (anchor_sha256_file(path, d, &bytes) != 0 || bytes == 0) { if (err) snprintf(err, errcap, "model unreadable or empty"); return 0; }
    if (digest_out) memcpy(digest_out, d, 32);
    if (memcmp(d, p->model_sha256, 32) != 0) { if (err) snprintf(err, errcap, "model digest differs from the measured pin"); return 0; }
    return 1;
}

int anchor_sha256_fd(int fd, uint8_t out[32], uint64_t *bytes) {
    if (fd < 0) return -1;
    uint8_t *buf = (uint8_t *)malloc(1 << 20); if (!buf) return -1;
    sha256_ctx c; sha_init(&c); uint64_t off = 0;
    for (;;) {
        ssize_t r = pread(fd, buf, 1 << 20, (off_t)off);   /* by offset: the caller's file position is untouched */
        if (r < 0) { if (errno == EINTR) continue; free(buf); return -1; }
        if (r == 0) break;
        sha_update(&c, buf, (size_t)r); off += (uint64_t)r;
    }
    free(buf);
    sha_final(&c, out); if (bytes) *bytes = off; return 0;
}

int anchor_pins_model_fd_check(const anchor_pins *p, int fd, const uint8_t *frozen, uint8_t digest_out[32], char *err, size_t errcap) {
    uint8_t d[32]; uint64_t bytes = 0;
    if (anchor_sha256_fd(fd, d, &bytes) != 0 || bytes == 0) { if (err) snprintf(err, errcap, "model unreadable or empty"); return 0; }
    if (digest_out) memcpy(digest_out, d, 32);
    if (p && p->has_model && memcmp(d, p->model_sha256, 32) != 0) { if (err) snprintf(err, errcap, "model differs from the measured pin"); return 0; }
    if (frozen && memcmp(d, frozen, 32) != 0) { if (err) snprintf(err, errcap, "model differs from the one the seed was granted for"); return 0; }
    return 1;
}
