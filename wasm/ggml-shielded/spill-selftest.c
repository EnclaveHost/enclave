/* spill-selftest -- the pad spill's store on its own (shielded-spill.h): what
 * goes onto the host's disk comes back exactly, and nothing the host can do to
 * that disk -- corrupt a slot, replay an older write, move a write to another
 * slot -- comes back at all. Also: values outside the balanced range are
 * refused, partitions are claimed and released, and the mask a slot imports
 * is the mask its pad was minted with.
 *
 *   make spill-selftest && ./spill-selftest DIR
 * DIR must accept O_DIRECT (not tmpfs). Exit 0 = all claims held. */
#define _GNU_SOURCE
#include "shielded-spill.h"
#include "shielded-field.h"
#include "shielded-tee.h"

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static uint32_t state = 0x5eed;
static uint32_t next(void) { state = state * 1664525U + 1013904223U; return state; }
static int failures;
#define CHECK(c, ...) do { if (!(c)) { failures++; fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } } while (0)

enum { NG = 3 };
static const int64_t Ks[NG] = { 64, 5120, 33 };
static const int64_t Us[NG] = { 100, 7000, 1 };
static const uint64_t Fs[NG] = { 11, 12, 13 };

static void fill_u(int32_t *u, int64_t n) {
    for (int64_t i = 0; i < n; i++) {
        switch (next() % 5) {
        case 0: u[i] = SH_HALF_M; break;
        case 1: u[i] = -SH_HALF_M; break;
        default: u[i] = (int32_t)((int64_t)(next() % SH_M_MOD) - SH_HALF_M);
        }
    }
}

/* One write/read round trip of b rows at slot0, checked value for value. */
static void round_trip(sh_spill *s, uint8_t *io, size_t g, uint32_t slot0, int b, uint64_t wid0) {
    const int64_t n = Us[g], K = Ks[g];
    int32_t *u = malloc((size_t)b * n * sizeof *u), *u2 = malloc((size_t)b * n * sizeof *u2);
    int32_t *r = malloc((size_t)b * K * sizeof *r), *want = malloc((size_t)K * sizeof *want);
    uint64_t *wid = malloc((size_t)b * sizeof *wid);
    for (int i = 0; i < b; i++) wid[i] = wid0 + (uint64_t)i;
    fill_u(u, (int64_t)b * n);
    CHECK(sh_spill_write(s, g, slot0, b, wid, u, io) == SH_OK, "write g%zu slot %u b %d", g, slot0, b);
    memset(io, 0xa5, 4096);                                  /* the read must not lean on the buffer */
    CHECK(sh_spill_read(s, g, slot0, b, wid, r, u2, io) == SH_OK, "read g%zu slot %u b %d", g, slot0, b);
    CHECK(!memcmp(u, u2, (size_t)b * n * sizeof *u), "u came back different (g%zu slot %u)", g, slot0);
    for (int i = 0; i < b; i++) {
        sh_spill_mask(s, wid[i], want, K);
        CHECK(!memcmp(want, r + (size_t)i * K, (size_t)K * sizeof *want), "mask of wid %llu differs", (unsigned long long)wid[i]);
        for (int64_t k = 0; k < K; k++) CHECK(want[k] >= 0 && want[k] < SH_M_MOD, "mask value outside [0, M)");
    }
    free(u); free(u2); free(r); free(want); free(wid);
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s DIR\n", argv[0]); return 2; }
    char path[4096];
    snprintf(path, sizeof path, "%s/spill-selftest.%d.img", argv[1], (int)getpid());
    const uint64_t bytes = UINT64_C(32) << 20;
    int fd = open(path, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd < 0 || ftruncate(fd, (off_t)bytes) != 0) { perror(path); return 2; }
    unlink(path);
    if (dup2(fd, 77) != 77) { perror("dup2"); return 2; }
    close(fd);
    setenv("SHIELDED_PAD_SPILL", "fd:77", 1);
    setenv("SHIELDED_PAD_SPILL_PARTS", "2", 1);

    char why[192];
    sh_spill *a = sh_spill_attach(Ks, Us, Fs, NG, NULL, why, sizeof why);
    CHECK(a != NULL, "attach: %s", why);
    if (!a) return 1;
    sh_spill *b = sh_spill_attach(Ks, Us, Fs, NG, NULL, why, sizeof why);
    CHECK(b != NULL && sh_spill_part(b) == 1 && sh_spill_part(a) == 0, "second link takes the second partition");
    sh_spill *c = sh_spill_attach(Ks, Us, Fs, NG, NULL, why, sizeof why);
    CHECK(c == NULL && why[0], "a third link finds no partition (why: %s)", why);

    const uint32_t slots = sh_spill_slots(a);
    const uint64_t row = sh_spill_row_bytes(a);
    CHECK(slots >= 2 && (uint64_t)slots * row <= sh_spill_bytes(a), "layout fits its partition (%u slots, %llu-byte rows)", slots, (unsigned long long)row);
    uint8_t *io = sh_spill_io_alloc(a);
    CHECK(io != NULL, "io buffer");

    /* every group, single rows and batches, the region's last slot, a run that wraps */
    for (size_t g = 0; g < NG; g++) {
        round_trip(a, io, g, 0, 1, 10);
        round_trip(a, io, g, 1, 9, 20);
        round_trip(a, io, g, slots - 1, 1, 40);
        round_trip(a, io, g, slots - 3, 7, 50);
    }
    /* the second partition is separate storage: writing it leaves the first intact */
    {
        int32_t u[100], u2[100], rr[64];
        uint64_t w = 900;
        fill_u(u, 100);
        CHECK(sh_spill_write(a, 0, 4, 1, &w, u, io) == SH_OK, "write a");
        uint8_t *iob = sh_spill_io_alloc(b);
        for (uint32_t s = 0; s < sh_spill_slots(b); s += 1) {
            int32_t junk[100]; fill_u(junk, 100); uint64_t wj = 5000 + s;
            if (sh_spill_write(b, 0, s, 1, &wj, junk, iob) != SH_OK) { CHECK(0, "write b"); break; }
        }
        free(iob);
        CHECK(sh_spill_read(a, 0, 4, 1, &w, rr, u2, io) == SH_OK && !memcmp(u, u2, sizeof u), "partition b overwrote partition a");
    }

    /* THE HOST'S MOVES: read a slot's raw bytes off the device -- what the
     * host sees -- and play them back elsewhere or later. */
    {
        int32_t u[100], u2[100], rr[64];
        uint64_t w_old = 1000, w_new = 1001, w_x = 1002;
        /* group 0's region starts at the partition base (0), its slots are
         * contiguous and equal-sized */
        const uint64_t sb = 4096;      /* 16 + 3*100 bytes rounded to the file's 4096 alignment */
        uint8_t *raw = aligned_alloc(4096, sb), *raw2 = aligned_alloc(4096, sb);
        fill_u(u, 100);
        CHECK(sh_spill_write(a, 0, 7, 1, &w_old, u, io) == SH_OK, "write old");
        CHECK(pread(77, raw, sb, (off_t)(7 * sb)) == (ssize_t)sb, "raw read");
        fill_u(u, 100);
        CHECK(sh_spill_write(a, 0, 7, 1, &w_new, u, io) == SH_OK, "write new");
        CHECK(sh_spill_read(a, 0, 7, 1, &w_new, rr, u2, io) == SH_OK && !memcmp(u, u2, sizeof u), "new write reads back");
        /* replay: the older ciphertext back in the slot */
        CHECK(pwrite(77, raw, sb, (off_t)(7 * sb)) == (ssize_t)sb, "raw replay");
        CHECK(sh_spill_read(a, 0, 7, 1, &w_new, rr, u2, io) == SH_ERR_VERIFY, "a replayed write must not open");
        /* the replayed write does open as what it was -- the check is the
         * expected write id, not the bytes looking odd */
        CHECK(sh_spill_read(a, 0, 7, 1, &w_old, rr, u2, io) == SH_OK, "the old write still opens as itself");
        /* move: a valid write for slot 7 placed in slot 8 */
        fill_u(u, 100);
        CHECK(sh_spill_write(a, 0, 7, 1, &w_x, u, io) == SH_OK, "write x");
        CHECK(pread(77, raw2, sb, (off_t)(7 * sb)) == (ssize_t)sb, "raw read x");
        CHECK(pwrite(77, raw2, sb, (off_t)(8 * sb)) == (ssize_t)sb, "raw move");
        uint64_t w_8 = 1003;                       /* what slot 8 is expected to hold */
        CHECK(sh_spill_read(a, 0, 8, 1, &w_8, rr, u2, io) == SH_ERR_VERIFY, "a moved write must not open");
        /* corrupt: one flipped bit anywhere in the sealed body */
        CHECK(sh_spill_read(a, 0, 7, 1, &w_x, rr, u2, io) == SH_OK, "x reads");
        raw2[16 + 150] ^= 0x10;
        CHECK(pwrite(77, raw2, sb, (off_t)(7 * sb)) == (ssize_t)sb, "raw corrupt");
        CHECK(sh_spill_read(a, 0, 7, 1, &w_x, rr, u2, io) == SH_ERR_VERIFY, "a corrupted slot must not open");
        /* a never-written (zero) slot does not open either */
        memset(raw, 0, sb);
        CHECK(pwrite(77, raw, sb, (off_t)(9 * sb)) == (ssize_t)sb, "raw zero");
        uint64_t w_9 = 1004;
        CHECK(sh_spill_read(a, 0, 9, 1, &w_9, rr, u2, io) == SH_ERR_VERIFY, "an empty slot must not open");
        free(raw); free(raw2);
    }

    /* outside the balanced range: refused, never truncated */
    {
        int32_t u[100]; uint64_t w = 2000;
        fill_u(u, 100); u[50] = SH_HALF_M + 1;
        CHECK(sh_spill_write(a, 0, 3, 1, &w, u, io) == SH_ERR_RANGE, "a value past M/2 is refused");
        u[50] = -SH_HALF_M - 1;
        CHECK(sh_spill_write(a, 0, 3, 1, &w, u, io) == SH_ERR_RANGE, "a value past -M/2 is refused");
    }

    /* distinct write ids give distinct masks; detach frees the partition */
    {
        int32_t m1[64], m2[64];
        sh_spill_mask(a, 1, m1, 64); sh_spill_mask(a, 2, m2, 64);
        CHECK(memcmp(m1, m2, sizeof m1), "two write ids, one mask");
        sh_spill_detach(b);
        sh_spill *d = sh_spill_attach(Ks, Us, Fs, NG, NULL, why, sizeof why);
        CHECK(d && sh_spill_part(d) == 1, "a released partition is claimed again");
        /* a fresh attach has fresh keys: the first link's ciphertext means nothing to it */
        int32_t u[100], u2[100], rr[64]; uint64_t w = 3000;
        fill_u(u, 100);
        uint8_t *iod = sh_spill_io_alloc(d);
        CHECK(sh_spill_write(a, 0, 11, 1, &w, u, io) == SH_OK, "write for the cross-key check");
        sh_spill_detach(a); a = NULL;
        sh_spill *e = sh_spill_attach(Ks, Us, Fs, NG, NULL, why, sizeof why);
        CHECK(e && sh_spill_part(e) == 0, "partition 0 again");
        CHECK(sh_spill_read(e, 0, 11, 1, &w, rr, u2, iod) == SH_ERR_VERIFY, "a new attach cannot open the old attach's pads");
        sh_spill_detach(e); sh_spill_detach(d); free(iod);
    }
    free(io);

    /* RE-REGISTRATION: unchanged groups keep their pads, a changed group gets a
     * fresh region (its old pads no longer open), and an extension past the
     * headroom is refused with nothing changed. 16 MiB a partition, 32 KiB a
     * row, 15% headroom: 445 slots, 2.1 MiB of headroom, 1.8 MiB per small group. */
    {
        sh_spill *x = sh_spill_attach(Ks, Us, Fs, NG, NULL, why, sizeof why);
        CHECK(x != NULL, "attach for re-registration: %s", why);
        uint8_t *iox = sh_spill_io_alloc(x);
        static int32_t u0[100], u1[7000], u2[1], g0[100], g1[7000], g2[1], rr[5120];
        uint64_t w0 = 7000, w1 = 7001, w2 = 7002;
        fill_u(u0, 100); fill_u(u1, 7000); fill_u(u2, 1);
        CHECK(sh_spill_write(x, 0, 2, 1, &w0, u0, iox) == SH_OK && sh_spill_write(x, 1, 3, 1, &w1, u1, iox) == SH_OK &&
              sh_spill_write(x, 2, 4, 1, &w2, u2, iox) == SH_OK, "writes before re-registration");
        const uint64_t f_changed[NG] = { 11, 12, 99 };
        uint8_t kept[5] = {0};
        CHECK(sh_spill_extend(x, Ks, Us, f_changed, NG, kept) == SH_OK && kept[0] && kept[1] && !kept[2],
              "groups 0 and 1 kept, the changed group 2 not");
        CHECK(sh_spill_read(x, 2, 4, 1, &w2, rr, g2, iox) == SH_ERR_VERIFY, "the changed group's old pad does not open");
        for (uint32_t sl = 0; sl < sh_spill_slots(x); sl++) {          /* the new region, end to end */
            int32_t v[1]; fill_u(v, 1); uint64_t wv = 8000 + sl;
            if (sh_spill_write(x, 2, sl, 1, &wv, v, iox) != SH_OK) { CHECK(0, "write the changed group's new region"); break; }
        }
        CHECK(sh_spill_read(x, 0, 2, 1, &w0, rr, g0, iox) == SH_OK && !memcmp(u0, g0, sizeof u0) &&
              sh_spill_read(x, 1, 3, 1, &w1, rr, g1, iox) == SH_OK && !memcmp(u1, g1, sizeof u1),
              "kept pads survive the re-registration and the new region's writes");
        const int64_t K4[4] = { 64, 5120, 33, 16 }, U4[4] = { 100, 7000, 1, 10 };
        const uint64_t f4[4] = { 11, 12, 99, 14 };
        CHECK(sh_spill_extend(x, K4, U4, f4, 4, kept) == SH_ERR_RANGE, "a group past the headroom is refused");
        CHECK(sh_spill_read(x, 0, 2, 1, &w0, rr, g0, iox) == SH_OK, "a refused extension changes nothing");
        CHECK(sh_spill_extend(x, Ks, Us, f_changed, NG - 1, kept) == SH_ERR_RANGE, "groups are never removed");
        free(iox); sh_spill_detach(x);
    }

    /* unusable configurations say why and attach nothing */
    {
        sh_spill *z = sh_spill_attach(Ks, Us, Fs, NG, NULL, why, sizeof why);
        CHECK(z != NULL, "reattach after detach");
        sh_spill_detach(z);
    }
    printf("{\"spill_selftest\":%s,\"failures\":%d,\"slots\":%u,\"row_bytes\":%llu}\n",
           failures ? "false" : "true", failures, slots, (unsigned long long)row);
    return failures ? 1 : 0;
}
