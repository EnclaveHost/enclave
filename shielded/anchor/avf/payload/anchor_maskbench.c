#define _GNU_SOURCE
#include "anchor_maskbench.h"
#include "anchor_maskbench_fixture.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

static void mb_fail(anchor_maskbench_line_fn line, const char *what, int en) { char m[300]; if (en) snprintf(m, sizeof m, "CELL_IMPORT FAIL %s: %s", what, strerror(en)); else snprintf(m, sizeof m, "CELL_IMPORT FAIL %s", what); line(m); }
static int write_all(int fd, const uint8_t *p, size_t n) { while (n) { const ssize_t k = write(fd, p, n); if (k <= 0) { if (k < 0 && errno == EINTR) continue; if (k == 0) errno = EIO; return -1; } p += k; n -= (size_t)k; } return 0; }

int anchor_maskbench_import(const char *store, const char *asset, anchor_maskbench_clock_fn clock_us, anchor_maskbench_line_fn line) {
    if (!store || !*store || !asset || !*asset || !clock_us || !line) return 2;
    line("CELL_IMPORT begin: warm encrypted-store file; pread + authenticated open + unpack; no pad Freivalds");
    const int64_t global_start = clock_us();
    if (global_start < 0) { mb_fail(line, "clock", 0); return 2; }
    int rc = 2, err = 0, afd = -1, ofd = -1, made_dir = 0; sh_pads_reader *r = NULL; char dir[640] = "", path[720] = "";
    int32_t *got = (int32_t *)malloc((size_t)mb_widths[MB_GROUPS - 1] * sizeof *got); uint8_t *buf = (uint8_t *)malloc(1u << 20);
    if (!got || !buf) { mb_fail(line, "out of memory", 0); goto out; }
    /* the packaged public shipment: a regular file of sane size */
    do { afd = open(asset, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); } while (afd < 0 && errno == EINTR);
    if (afd < 0) { mb_fail(line, "asset open", errno); goto out; }
    struct stat st; if (fstat(afd, &st) != 0) { mb_fail(line, "asset fstat", errno); goto out; }
    if (!S_ISREG(st.st_mode) || st.st_size <= 0 || st.st_size > (64 << 20)) { mb_fail(line, "asset is not a regular file under 64 MiB", 0); goto out; }
    /* our own directory under the store, the canonical name, checked writes, fsync; no link, no rename */
    if (snprintf(dir, sizeof dir, "%s/.maskbench-XXXXXX", store) >= (int)sizeof dir) { mb_fail(line, "store path too long", 0); goto out; }
    if (!mkdtemp(dir)) { mb_fail(line, "mkdtemp under the store", errno); dir[0] = 0; goto out; }
    made_dir = 1;
    snprintf(path, sizeof path, "%s/%s", dir, MB_FILE_NAME);
    do { ofd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600); } while (ofd < 0 && errno == EINTR);
    if (ofd < 0) { mb_fail(line, "create under the store", errno); goto out; }
    { uint64_t copied = 0;
      for (;;) { const ssize_t k = read(afd, buf, 1u << 20); if (k < 0) { if (errno == EINTR) continue; mb_fail(line, "asset read", errno); goto out; } if (k == 0) break;
                 if (write_all(ofd, buf, (size_t)k) != 0) { mb_fail(line, "store write", errno); goto out; } copied += (uint64_t)k; }
      if (copied != (uint64_t)st.st_size) { mb_fail(line, "asset changed size during the copy", 0); goto out; }
      if (fsync(ofd) != 0) { mb_fail(line, "store fsync", errno); goto out; }
      if (close(ofd) != 0) { ofd = -1; mb_fail(line, "store close", errno); goto out; } ofd = -1;
      close(afd); afd = -1; }
    if (clock_us() - global_start > 10000000) { mb_fail(line, "over the 10 s bound after the copy", 0); goto out; }
    /* the production reader on the file we wrote; bind our public group table; verify every element before any timing */
    r = sh_pads_reader_open(dir, mb_seed_id, mb_consumer_sk, &err);
    if (!r) { char m[64]; snprintf(m, sizeof m, "reader open (%d)", err); mb_fail(line, m, 0); goto out; }
    { sh_pads_group groups[MB_GROUPS]; mb_groups(groups); const int brc = sh_pads_reader_bind(r, groups, MB_GROUPS); if (brc != 0) { char m[64]; snprintf(m, sizeof m, "reader bind (%d)", brc); mb_fail(line, m, 0); goto out; } }
    for (uint64_t index = 0; index < MB_INDICES; index++) for (uint32_t g = 0; g < MB_GROUPS; g++) {
        const int rrc = sh_pads_reader_cell(r, g, index, got);
        if (rrc != 0) { char m[80]; snprintf(m, sizeof m, "verify read %llu/%u (%d)", (unsigned long long)index, g, rrc); mb_fail(line, m, 0); goto out; }
        for (uint64_t j = 0; j < (uint64_t)mb_widths[g]; j++) if (got[j] != mb_value(j, index, g)) { char m[96]; snprintf(m, sizeof m, "verify mismatch at %llu/%u element %llu", (unsigned long long)index, g, (unsigned long long)j); mb_fail(line, m, 0); goto out; }
    }
    if (clock_us() - global_start > 10000000) { mb_fail(line, "over the 10 s bound before timing", 0); goto out; }
    for (uint32_t g = 0; g < MB_GROUPS; g++) {   /* timed: warm-file import of this group's cells, ~1.5 s each, whole bound 10 s */
        const int64_t width = mb_widths[g]; const int64_t start = clock_us(); int64_t now = start; uint64_t calls = 0, checksum = 0;
        if (start < global_start || start - global_start > 10000000) { mb_fail(line, "clock before a case", 0); goto out; }
        do {
            const int rrc = sh_pads_reader_cell(r, g, calls % MB_INDICES, got);
            if (rrc != 0) { char m[64]; snprintf(m, sizeof m, "timed read case %u (%d)", g, rrc); mb_fail(line, m, 0); goto out; }
            checksum += (uint32_t)got[calls % (uint64_t)width]; calls++;
            now = clock_us();
            if (now < start || now - global_start > 10000000) { mb_fail(line, "over the 10 s bound during timing", 0); goto out; }
        } while (calls < (1u << 19) && now - start < 1500000);   /* the call cap only bounds a stalled clock; a case must still span >= 1 s */
        if (now <= start || now - start < 1000000) { mb_fail(line, "case shorter than 1 s (clock or call cap)", 0); goto out; }
        char m[384];
        snprintf(m, sizeof m, "CELL_IMPORT case=%u width=%lld calls=%llu elements=%llu bytes=%llu elapsed_us=%lld checksum=%llu",
                 g, (long long)width, (unsigned long long)calls, (unsigned long long)(calls * (uint64_t)width), (unsigned long long)(calls * (SH_PADS_CELL_TAG + 3ull * (uint64_t)width)), (long long)(now - start), (unsigned long long)checksum);
        line(m);
    }
    rc = 0;
out:
    if (r) sh_pads_reader_close(r);                                  /* reader closed BEFORE the file goes */
    if (ofd >= 0) close(ofd);
    if (afd >= 0) close(afd);
    if (path[0] && unlink(path) != 0 && errno != ENOENT && rc == 0) { mb_fail(line, "unlink", errno); rc = 2; }
    if (made_dir && rmdir(dir) != 0 && rc == 0) { mb_fail(line, "rmdir", errno); rc = 2; }
    if (rc == 0) line("CELL_IMPORT end: complete; three cases; temporary shipment removed");
    free(got); free(buf);
    return rc;
}
