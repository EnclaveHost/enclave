#ifndef ANCHOR_STDERR_EXPORT_H
#define ANCHOR_STDERR_EXPORT_H
/* Diagnostic export of the engine's captured stderr (engine.err) over the control channel, in bounded,
 * individually hashed chunks, so the owner's collector can PROVE it holds every exported byte - or see
 * that the engine's cap cut the head off (from>0, truncated=1), never a silent "full". Plain C, shared
 * by the VM engine (engine.cpp) and a compiled host fixture that proves the wire format interoperates
 * with the collector. Default off; the caller decides when to call it (after every producer of stderr
 * has stopped, or the snapshot is named as partial by the caller).
 *
 *   STDERR-EXPORT v1 scope=snapshot-after-engine-main-cleanup file_bytes=N from=F total=T chunk_bytes=C chunks=K sha256=<64 hex> truncated=0|1
 *   STDERR-CHUNK <i> <offset> <len> <first 16 hex of the chunk's sha256> <base64>
 *   STDERR-END v1 chunks=K total=T sha256=<64 hex>
 *   STDERR-EXPORT-FAILED <reason>          (any failure; no END follows, so the collector rejects)
 *
 * SCOPE: this is a FILE SNAPSHOT of engine.err taken by engine_main after its own cleanup. The shielded pool
 * (sh_pool_get) is process-static and its links/refill threads outlive engine_main, so stderr may still grow
 * afterwards; COMPLETE therefore means "every byte of the snapshot up to file_bytes", never "all stderr the
 * process will ever write". The scope token is part of the header and the collector requires it verbatim.
 * Every line stays under 4000 bytes. `cap` bounds the exported range (the LAST cap bytes of a larger
 * file); the file size itself is unbounded (off_t). Returns 0 when END was emitted, -1 otherwise. */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>
#include "shielded-sha256.h"

#define ANCHOR_STDERR_CHUNK 1440u
#define ANCHOR_STDERR_SCOPE "snapshot-after-engine-main-cleanup"
#define ANCHOR_STDERR_CAP_MIN (64u << 10)
#define ANCHOR_STDERR_CAP_MAX (64u << 20)

typedef void (*anchor_stderr_emit_fn)(void *ctx, const char *line);

static inline void anchor_stderr_hex(const uint8_t *d, size_t n, char *out) {
    static const char *h = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) { out[2 * i] = h[d[i] >> 4]; out[2 * i + 1] = h[d[i] & 15]; }
    out[2 * n] = 0;
}
static inline void anchor_stderr_b64(const uint8_t *in, size_t n, char *out) {
    static const char *tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
        const uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < n ? (uint32_t)in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
        out[o++] = tbl[v >> 18 & 63]; out[o++] = tbl[v >> 12 & 63];
        out[o++] = i + 1 < n ? tbl[v >> 6 & 63] : '='; out[o++] = i + 2 < n ? tbl[v & 63] : '=';
    }
    out[o] = 0;
}
/* exact "0" / "1" only: returns 1 and sets *out, or 0 for anything else (unset counts as "0" via *out = 0) */
static inline int anchor_stderr_flag_parse(const char *s, int *out) {
    if (!s) { *out = 0; return 1; }
    if (!strcmp(s, "0")) { *out = 0; return 1; }
    if (!strcmp(s, "1")) { *out = 1; return 1; }
    return 0;
}
/* canonical decimal within [lo, hi]: no sign, no leading zero, digits only, at most 12 digits */
static inline int anchor_stderr_cap_parse(const char *s, uint64_t lo, uint64_t hi, uint64_t *out) {
    if (!s || !*s || strlen(s) > 12 || (s[0] == '0' && s[1])) return 0;
    uint64_t v = 0;
    for (const char *p = s; *p; p++) { if (*p < '0' || *p > '9') return 0; v = v * 10 + (uint64_t)(*p - '0'); }
    if (v < lo || v > hi) return 0;
    *out = v; return 1;
}

static inline int anchor_stderr_export(const char *path, uint64_t cap, anchor_stderr_emit_fn emit, void *ctx) {
    char line[4096];
    if (cap < ANCHOR_STDERR_CAP_MIN || cap > ANCHOR_STDERR_CAP_MAX) { emit(ctx, "STDERR-EXPORT-FAILED config: cap out of bounds"); return -1; }
    FILE *f = fopen(path, "rb");
    if (!f) { snprintf(line, sizeof line, "STDERR-EXPORT-FAILED open: %s", strerror(errno)); emit(ctx, line); return -1; }
    if (fseeko(f, 0, SEEK_END) != 0) { emit(ctx, "STDERR-EXPORT-FAILED seek"); fclose(f); return -1; }
    const off_t fsz = ftello(f);
    if (fsz < 0) { emit(ctx, "STDERR-EXPORT-FAILED tell"); fclose(f); return -1; }
    const uint64_t file_bytes = (uint64_t)fsz, from = file_bytes > cap ? file_bytes - cap : 0, total = file_bytes - from;
    const uint64_t K = (total + ANCHOR_STDERR_CHUNK - 1) / ANCHOR_STDERR_CHUNK;
    uint8_t buf[ANCHOR_STDERR_CHUNK], d[32]; char b64[ANCHOR_STDERR_CHUNK / 3 * 4 + 8], hex[65], chex[17];
    sha256_ctx c; sha_init(&c);
    if (fseeko(f, (off_t)from, SEEK_SET) != 0) { emit(ctx, "STDERR-EXPORT-FAILED seek"); fclose(f); return -1; }
    for (uint64_t left = total; left; ) {
        const size_t want = left < ANCHOR_STDERR_CHUNK ? (size_t)left : ANCHOR_STDERR_CHUNK;
        if (fread(buf, 1, want, f) != want) { emit(ctx, "STDERR-EXPORT-FAILED read (digest pass)"); fclose(f); return -1; }
        sha_update(&c, buf, want); left -= want;
    }
    sha_final(&c, d); anchor_stderr_hex(d, 32, hex);
    snprintf(line, sizeof line, "STDERR-EXPORT v1 scope=%s file_bytes=%llu from=%llu total=%llu chunk_bytes=%u chunks=%llu sha256=%s truncated=%d",
             ANCHOR_STDERR_SCOPE, (unsigned long long)file_bytes, (unsigned long long)from, (unsigned long long)total, ANCHOR_STDERR_CHUNK,
             (unsigned long long)K, hex, from ? 1 : 0);
    emit(ctx, line);
    if (fseeko(f, (off_t)from, SEEK_SET) != 0) { emit(ctx, "STDERR-EXPORT-FAILED seek"); fclose(f); return -1; }
    for (uint64_t i = 0; i < K; i++) {
        const uint64_t off = i * ANCHOR_STDERR_CHUNK;
        const size_t want = (total - off) < ANCHOR_STDERR_CHUNK ? (size_t)(total - off) : ANCHOR_STDERR_CHUNK;
        if (fread(buf, 1, want, f) != want) {
            snprintf(line, sizeof line, "STDERR-EXPORT-FAILED read at %llu", (unsigned long long)off); emit(ctx, line); fclose(f); return -1;
        }
        sha256_ctx cc; sha_init(&cc); sha_update(&cc, buf, want); sha_final(&cc, d); anchor_stderr_hex(d, 8, chex);
        anchor_stderr_b64(buf, want, b64);
        snprintf(line, sizeof line, "STDERR-CHUNK %llu %llu %zu %s %s", (unsigned long long)i, (unsigned long long)off, want, chex, b64);
        emit(ctx, line);
    }
    fclose(f);
    snprintf(line, sizeof line, "STDERR-END v1 chunks=%llu total=%llu sha256=%s", (unsigned long long)K, (unsigned long long)total, hex);
    emit(ctx, line);
    return 0;
}
#endif
