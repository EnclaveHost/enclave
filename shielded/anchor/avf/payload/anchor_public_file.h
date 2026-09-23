/* anchor_public_file.h -- a PUBLIC file (the Shielded-TPU lane bundle, a drafter) into this VM's encrypted store, and back
 * out of it on later runs, as one function the host can test (tpu/test/public-file-test.c).
 *
 * Wire, from the owner: u64 size, the file's first 8 bytes, its SHA-256 (32 bytes). This side answers 'K' (the stored copy
 * IS that file) or 'S', and then reads exactly `size` bytes.
 *
 * WHAT THE DIGEST IS. It is the owner's statement of WHICH artifact this run uses -- identity, so that two runs asking for
 * two different bundles can never be served the same stored copy. It is not authentication: the owner (the app) is not
 * trusted, and a hostile one can announce any digest it likes along with matching bytes. Nothing here depends on that: the
 * bundle is public data, a wrong one cannot unmask anything (what crosses the link stays uniformly masked), and the products
 * a wrong one yields are caught by the backend's kernel verification, which refuses the turn beyond 1 LSB (ggml-tpu.cpp).
 *
 * THE INVARIANT, and why it holds without trusting crash ordering: 'K' is answered only after THIS call has read the stored
 * file from start to end and its SHA-256 equals the announced one. Nothing else -- no sidecar, no size or magic, no record
 * from an earlier run -- can produce a 'K'. So an interrupted stream, a failed unlink, a leftover `.part`, a file some other
 * code replaced, or a stored copy whose blocks changed underneath (the encrypted store's host side can corrupt what it
 * cannot read) can only ever cost a restream. That is what failed before 2b993ba7: size and magic matched, and the int4
 * lane was served a cached int8 bundle. The price is one hashing read of the stored copy per run (the model's staging
 * already pays that), and its time is logged.
 *
 * A stream is written to <path>.part, hashed as it arrives, and renamed over <path> only if every byte arrived and the
 * digest matches; otherwise the .part is removed and the call refuses. After a refusal <path> may be absent (it is removed
 * before a restream, because the store has no room for two bundles and the model); the next run restreams.
 *
 * Returns 0 when the stored copy was reused, 1 when the file was streamed and verified, -1 on refusal or failure (logged).
 * APF_CRASH(n) is a test hook that abandons the call at step n as a power loss would (no cleanup); it is 0 in the payload. */
#ifndef ANCHOR_PUBLIC_FILE_H
#define ANCHOR_PUBLIC_FILE_H
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include "anchor_pins.h"
#ifndef APF_CRASH
#define APF_CRASH(n) 0
#endif

typedef void (*apf_log_fn)(const char *line);

static int apf_read_exact(int fd, void *p, size_t n) {
    size_t o = 0; while (o < n) { ssize_t r = read(fd, (char *)p + o, n - o); if (r < 0 && errno == EINTR) continue; if (r <= 0) return -1; o += (size_t)r; }
    return 0;
}

static int apf_receive(int c, uint64_t bytes, const char *path, const char *name, apf_log_fn log) {
    char m[1024];
    uint64_t hdr = 0; uint8_t magic[8], want[32];
    if (apf_read_exact(c, &hdr, 8) != 0 || hdr != bytes) { snprintf(m, sizeof m, "LOCAL %s: header %" PRIu64 " != %" PRIu64, name, hdr, bytes); log(m); return -1; }
    if (apf_read_exact(c, magic, 8) != 0 || apf_read_exact(c, want, 32) != 0) { snprintf(m, sizeof m, "LOCAL %s: no magic/digest in the header", name); log(m); return -1; }
    char wh[17]; for (int i = 0; i < 8; i++) snprintf(wh + 2 * i, 3, "%02x", want[i]);
    struct stat sb;
    if (stat(path, &sb) == 0 && (uint64_t)sb.st_size == bytes) {
        int fd = open(path, O_RDONLY | O_CLOEXEC); uint8_t have[32]; uint64_t hb = 0;
        struct timespec t0, t1; clock_gettime(CLOCK_MONOTONIC, &t0);
        const int ok = fd >= 0 && anchor_sha256_fd(fd, have, &hb) == 0 && hb == bytes && memcmp(have, want, 32) == 0;
        if (fd >= 0) close(fd);
        clock_gettime(CLOCK_MONOTONIC, &t1); const double s = (double)(t1.tv_sec - t0.tv_sec) + (double)(t1.tv_nsec - t0.tv_nsec) / 1e9;
        if (APF_CRASH(1)) return -1;
        if (ok) {
            if (write(c, "K", 1) != 1) { snprintf(m, sizeof m, "LOCAL %s: the owner went away", name); log(m); return -1; }
            snprintf(m, sizeof m, "LOCAL %s: already in the encrypted store (%" PRIu64 " MiB, sha256 %s..., re-hashed in %.1f s)", name, bytes >> 20, wh, s); log(m); return 0;
        }
        snprintf(m, sizeof m, "LOCAL %s: the stored copy is not sha256 %s... (hashed in %.1f s): restreaming", name, wh, s); log(m);
    }
    /* the store has no room for the model plus two bundles, so the old copy goes before the new one streams. A failure to
     * remove it refuses the call: not for correctness (the re-hash above is what guarantees a 'K' is right, whatever is
     * left on disk) but so the store never ends up holding a copy this call could not account for. */
    if (unlink(path) != 0 && errno != ENOENT) { snprintf(m, sizeof m, "LOCAL %s: cannot remove the stored copy: %s", name, strerror(errno)); log(m); return -1; }
    if (APF_CRASH(2)) return -1;
    if (write(c, "S", 1) != 1) { snprintf(m, sizeof m, "LOCAL %s: the owner went away", name); log(m); return -1; }
    char tmp[600]; snprintf(tmp, sizeof tmp, "%s.part", path);
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd < 0) { snprintf(m, sizeof m, "LOCAL %s: cannot create %s: %s", name, tmp, strerror(errno)); log(m); return -1; }
    anchor_sha256_ctx hc; anchor_sha256_init(&hc);
    static uint8_t buf[1 << 20]; uint64_t got = 0; int werr = 0;
    while (got < bytes) {
        const size_t n = bytes - got < sizeof buf ? (size_t)(bytes - got) : sizeof buf;
        ssize_t r = read(c, buf, n); if (r < 0 && errno == EINTR) continue; if (r <= 0) break;
        anchor_sha256_update(&hc, buf, (size_t)r);
        for (size_t o = 0; o < (size_t)r; ) { ssize_t w = write(fd, buf + o, (size_t)r - o); if (w < 0 && errno == EINTR) continue; if (w <= 0) { werr = 1; break; } o += (size_t)w; }
        if (werr) break;
        got += (uint64_t)r;
        if (got >= bytes / 2 && APF_CRASH(3)) { close(fd); return -1; }
    }
    uint8_t have[32]; anchor_sha256_final(&hc, have);
    if (werr || got != bytes || fsync(fd) != 0) { close(fd); unlink(tmp); snprintf(m, sizeof m, "LOCAL %s: stream ended at %" PRIu64 " of %" PRIu64 "%s", name, got, bytes, werr ? " (write failed)" : ""); log(m); return -1; }
    close(fd);
    if (memcmp(have, want, 32) != 0) { unlink(tmp); snprintf(m, sizeof m, "LOCAL %s: REFUSED: the bytes received are not the sha256 %s... the owner announced", name, wh); log(m); return -1; }
    if (APF_CRASH(4)) return -1;
    if (rename(tmp, path) != 0) { unlink(tmp); snprintf(m, sizeof m, "LOCAL %s: rename: %s", name, strerror(errno)); log(m); return -1; }
    snprintf(m, sizeof m, "LOCAL %s: %" PRIu64 " MiB received, sha256 %s... verified", name, bytes >> 20, wh); log(m);
    return 1;
}
#endif
