/* appbundle.h: the component a plane RUNS, cut from the bundle bytes the SVSM ADMITTED.
 *
 * WHY THIS EXISTS. The SVSM admits the bundle: it hashes the bytes the plane staged and compares them with the
 * AppID compiled into its measured image (APP_TABLE), and the AppID is sha256 of the whole bundle. But the plane
 * used to run /app.wasm, a SEPARATE file that build-plane-guest.sh extracted from the bundle at build time. So the
 * admitted bytes and the executed bytes were two files, and the only thing tying them together was the build. A
 * genuine bundle beside a different /app.wasm would have been admitted, named as the bundle's app, and would have
 * served the other one.
 *
 * Now the bundle file is read ONCE into memory. Those exact bytes are what is staged and admitted. After the SVSM
 * accepts them, the component is cut from the SAME buffer, checked against the hash the manifest names, and handed to
 * the runtime as a SEALED memfd: no write, no grow, no shrink, and no further sealing, enforced by the kernel for
 * everyone, root included. The image no longer carries an /app.wasm at all.
 *
 * THE FRAMING, which must agree with isolation/contract/bundle.go Parse on every bundle Parse accepts:
 *
 *     "ENCLAVE-BUNDLE/1\n"   17 bytes
 *     u32le ml, manifest[ml]  ml <= 64 KiB; canonical JSON, keys sorted
 *     u32le al, artifact[al]  al == exactly the bytes that remain
 *
 * The manifest is not re-parsed as JSON. It is canonical (Parse refuses anything else), its keys are sorted, and
 * "abi" and "artifact" are its first two keys, so a bundle Parse accepts begins its manifest with exactly
 *
 *     {"abi":"enclave-domain-abi/1","artifact":{"kind":"wasm-component","sha256":"<hex of the artifact>"}
 *
 * followed by ',' or '}'. That prefix is what this code requires, byte for byte, after hashing the artifact itself.
 * This code is STRICTER than Parse in one place only: it refuses an empty artifact, which Parse would accept but no
 * runtime could run.
 *
 * Soundness does not rest on this parser. The whole bundle is pinned by the AppID, so there is exactly one byte
 * string this plane can be admitted with, and a parser can only mis-cut THAT string. The manifest-hash check
 * catches a mis-cut, and m4/test-appbundle.sh compares the cut with the contract's own extractor.
 */
#ifndef ENCLAVE_APPBUNDLE_H
#define ENCLAVE_APPBUNDLE_H

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#define APPBUNDLE_MAGIC "ENCLAVE-BUNDLE/1\n"
#define APPBUNDLE_MAGIC_LEN (sizeof APPBUNDLE_MAGIC - 1)
#define APPBUNDLE_MAX_MANIFEST (64u << 10)
/* The module's bundle slot (appidmod.c slot_cap[KIND_BUNDLE]): a larger bundle could not be staged anyway. */
#define APPBUNDLE_MAX_BYTES (4u << 20)
#define APPBUNDLE_SEALS (F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE | F_SEAL_SEAL)

/* SHA-256 (FIPS 180-4). The plane has no crypto library and needs exactly one hash, of the component it hands the
 * runtime; test-appbundle.sh checks this against sha256sum across the padding boundaries. */
struct ab_sha256 {
    uint32_t h[8];
    uint64_t bytes;
    unsigned char blk[64];
    size_t fill;
};

static const uint32_t ab_k[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

static uint32_t ab_ror(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

static void ab_block(struct ab_sha256 *s, const unsigned char *p) {
    uint32_t w[64], a, b, c, d, e, f, g, h;
    for (int i = 0; i < 16; i++)
        w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 | (uint32_t)p[4 * i + 2] << 8 | p[4 * i + 3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = ab_ror(w[i - 15], 7) ^ ab_ror(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = ab_ror(w[i - 2], 17) ^ ab_ror(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    a = s->h[0]; b = s->h[1]; c = s->h[2]; d = s->h[3]; e = s->h[4]; f = s->h[5]; g = s->h[6]; h = s->h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t t1 = h + (ab_ror(e, 6) ^ ab_ror(e, 11) ^ ab_ror(e, 25)) + ((e & f) ^ (~e & g)) + ab_k[i] + w[i];
        uint32_t t2 = (ab_ror(a, 2) ^ ab_ror(a, 13) ^ ab_ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
        h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    s->h[0] += a; s->h[1] += b; s->h[2] += c; s->h[3] += d; s->h[4] += e; s->h[5] += f; s->h[6] += g; s->h[7] += h;
}

static void ab_sha256_init(struct ab_sha256 *s) {
    static const uint32_t iv[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    memcpy(s->h, iv, sizeof iv);
    s->bytes = 0;
    s->fill = 0;
}

static void ab_sha256_update(struct ab_sha256 *s, const void *data, size_t n) {
    const unsigned char *p = data;
    s->bytes += n;
    while (n) {
        size_t k = 64 - s->fill;
        if (k > n) k = n;
        memcpy(s->blk + s->fill, p, k);
        s->fill += k;
        p += k;
        n -= k;
        if (s->fill == 64) { ab_block(s, s->blk); s->fill = 0; }
    }
}

static void ab_sha256_hex(struct ab_sha256 *s, char out[65]) {
    uint64_t bits = s->bytes * 8;
    unsigned char pad = 0x80, zero = 0, len[8];
    ab_sha256_update(s, &pad, 1);
    while (s->fill != 56) ab_sha256_update(s, &zero, 1);
    for (int i = 0; i < 8; i++) len[i] = (unsigned char)(bits >> (56 - 8 * i));
    ab_sha256_update(s, len, 8);
    for (int i = 0; i < 8; i++) snprintf(out + 8 * i, 9, "%08x", s->h[i]);
}

struct appbundle {
    unsigned char *buf;   /* the bundle file's bytes, read ONCE: staged for admission, and cut for execution */
    size_t len;
    size_t man_off, man_len, art_off, art_len;
    char art_hex[65];
};

static uint32_t ab_le32(const unsigned char *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

/* Read the bundle file once, whole. A file that changes size under the read is refused, not truncated. */
static int appbundle_read(struct appbundle *b, const char *path, char *err, size_t el) {
    memset(b, 0, sizeof *b);
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    struct stat st;
    if (fd < 0 || fstat(fd, &st) != 0) {
        snprintf(err, el, "%s: %s", path, strerror(errno));
        if (fd >= 0) close(fd);
        return -1;
    }
    if (!S_ISREG(st.st_mode) || st.st_size <= 0 || (uint64_t)st.st_size > APPBUNDLE_MAX_BYTES) {
        snprintf(err, el, "%s: not a regular file of 1..%u bytes", path, APPBUNDLE_MAX_BYTES);
        close(fd);
        return -1;
    }
    b->len = (size_t)st.st_size;
    b->buf = malloc(b->len);
    if (!b->buf) { snprintf(err, el, "out of memory"); close(fd); return -1; }
    size_t got = 0;
    while (got < b->len) {
        ssize_t r = read(fd, b->buf + got, b->len - got);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) {
            snprintf(err, el, "%s: %s", path, r < 0 ? strerror(errno) : "shrank while reading");
            close(fd);
            return -1;
        }
        got += (size_t)r;
    }
    unsigned char one;
    ssize_t more = read(fd, &one, 1);
    close(fd);
    if (more != 0) { snprintf(err, el, "%s: grew while reading", path); return -1; }
    return 0;
}

/* Cut the bundle already read into manifest and component, and check the manifest names that component. */
static int appbundle_frame(struct appbundle *b, char *err, size_t el) {
    const size_t head = APPBUNDLE_MAGIC_LEN + 4;
    if (b->len < head || memcmp(b->buf, APPBUNDLE_MAGIC, APPBUNDLE_MAGIC_LEN)) {
        snprintf(err, el, "not a bundle: no %s magic", "ENCLAVE-BUNDLE/1");
        return -1;
    }
    uint32_t ml = ab_le32(b->buf + APPBUNDLE_MAGIC_LEN);
    if (ml > APPBUNDLE_MAX_MANIFEST || (size_t)ml > b->len - head) {
        snprintf(err, el, "manifest length %u out of range", ml);
        return -1;
    }
    b->man_off = head;
    b->man_len = ml;
    size_t rest = b->len - head - ml;
    if (rest < 4) { snprintf(err, el, "truncated at the artifact length"); return -1; }
    uint32_t al = ab_le32(b->buf + head + ml);
    b->art_off = head + ml + 4;
    b->art_len = rest - 4;
    if ((size_t)al != b->art_len) {
        snprintf(err, el, "artifact length %u does not match the %zu bytes present", al, b->art_len);
        return -1;
    }
    if (al == 0) { snprintf(err, el, "an empty artifact: nothing to run"); return -1; }
    struct ab_sha256 s;
    ab_sha256_init(&s);
    ab_sha256_update(&s, b->buf + b->art_off, b->art_len);
    ab_sha256_hex(&s, b->art_hex);
    char want[160];
    int wl = snprintf(want, sizeof want,
                      "{\"abi\":\"enclave-domain-abi/1\",\"artifact\":{\"kind\":\"wasm-component\",\"sha256\":\"%s\"}",
                      b->art_hex);
    const char *m = (const char *)b->buf + b->man_off;
    if (wl <= 0 || (size_t)wl >= b->man_len || memcmp(m, want, (size_t)wl) || (m[wl] != ',' && m[wl] != '}')) {
        snprintf(err, el, "the manifest does not begin by naming this component (abi, kind wasm-component, "
                 "sha256 %.16s...): not a bundle Parse would accept", b->art_hex);
        return -1;
    }
    return 0;
}

/* Hand the component to the runtime as a sealed memfd. Returns the fd (CLOEXEC; the spawn moves it to fd 3). */
static int appbundle_memfd(const struct appbundle *b, char *err, size_t el) {
    int fd = memfd_create("app-component", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (fd < 0) { snprintf(err, el, "memfd_create: %s", strerror(errno)); return -1; }
    size_t off = 0;
    while (off < b->art_len) {
        ssize_t w = write(fd, b->buf + b->art_off + off, b->art_len - off);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) { snprintf(err, el, "writing the component: %s", strerror(errno)); close(fd); return -1; }
        off += (size_t)w;
    }
    if (lseek(fd, 0, SEEK_SET) != 0 || fcntl(fd, F_ADD_SEALS, APPBUNDLE_SEALS) != 0) {
        snprintf(err, el, "sealing the component: %s", strerror(errno));
        close(fd);
        return -1;
    }
    int got = fcntl(fd, F_GET_SEALS);
    if (got < 0 || (got & APPBUNDLE_SEALS) != APPBUNDLE_SEALS) {
        snprintf(err, el, "the component's seals read back as %#x, not %#x", got, APPBUNDLE_SEALS);
        close(fd);
        return -1;
    }
    return fd;
}

#endif /* ENCLAVE_APPBUNDLE_H */
