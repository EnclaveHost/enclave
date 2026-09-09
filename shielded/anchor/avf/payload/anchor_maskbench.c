#define _GNU_SOURCE
#include "anchor_maskbench.h"
#include "shielded-pads.h"
#include "shielded-field.h"
#include "third_party/tweetnacl.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MB_GROUPS 3
#define MB_INDICES 4
static const int64_t mb_widths[MB_GROUPS] = { 5120, 34816, 248320 };
/* the public pattern: balanced values in (-M/2, M/2], different per element, index and group */
static int32_t mb_value(uint64_t j, uint64_t index, uint32_t group) {
    const uint64_t v = (j * 7919u + index * 104729u + (uint64_t)group * 15485863u) % (uint64_t)SH_M_MOD;
    return (int32_t)((int64_t)v - SH_HALF_M);
}
static void mb_status(anchor_maskbench_line_fn line, const char *why) { char m[256]; snprintf(m, sizeof m, "CELL_IMPORT %s", why); line(m); }   /* failures only; the outer MASKBENCH status line is the payload's */

int anchor_maskbench_import(const char *store, anchor_maskbench_clock_fn clock_us, anchor_maskbench_line_fn line) {
    if (!store || !*store || !clock_us || !line) return 2;
    static const uint8_t seed_id[16] = { 'M','A','S','K','B','E','N','C','H','-','P','U','B','L','I','C' };
    static const uint8_t model_digest[32] = { 0x4d,0x41,0x53,0x4b,0x42,0x45,0x4e,0x43,0x48,0x2d,0x50,0x55,0x42,0x4c,0x49,0x43,0x2d,0x4d,0x4f,0x44,0x45,0x4c,0x2d,0x44,0x49,0x47,0x45,0x53,0x54,0x2d,0x30,0x31 };
    static const uint8_t sk[32] = { 0x70,0x75,0x62,0x6c,0x69,0x63,0x2d,0x6d,0x61,0x73,0x6b,0x62,0x65,0x6e,0x63,0x68,0x2d,0x63,0x6f,0x6e,0x73,0x75,0x6d,0x65,0x72,0x2d,0x6b,0x65,0x79,0x2d,0x30,0x31 };
    uint8_t pk[32]; crypto_scalarmult_base(pk, sk);                 /* deterministic public keypair: nothing here is secret */
    char dir[640]; if (snprintf(dir, sizeof dir, "%s/.maskbench-XXXXXX", store) >= (int)sizeof dir) { mb_status(line, "FAIL store path too long"); return 2; }
    if (!mkdtemp(dir)) { char m[300]; snprintf(m, sizeof m, "FAIL mkdtemp under the store: %s", strerror(errno)); mb_status(line, m); return 2; }
    char path[720]; snprintf(path, sizeof path, "%s/4d41534b42454e43482d5055424c4943-0-%d.pads", dir, MB_INDICES);   /* seed_id hex - index0 - count */
    sh_pads_group groups[MB_GROUPS]; memset(groups, 0, sizeof groups);
    for (uint32_t g = 0; g < MB_GROUPS; g++) { groups[g].group = g; groups[g].K = 5120; groups[g].u_len = (uint64_t)mb_widths[g]; snprintf(groups[g].name, sizeof groups[g].name, "maskbench.g%u.weight", g); }
    int32_t *u = (int32_t *)malloc((size_t)mb_widths[MB_GROUPS - 1] * sizeof *u), *got = (int32_t *)malloc((size_t)mb_widths[MB_GROUPS - 1] * sizeof *got);
    int rc = 2, err = 0; sh_pads_reader *r = NULL;
    const int64_t global_start = clock_us();
    line("CELL_IMPORT begin: warm encrypted-store file; pread + authenticated open + unpack; no pad Freivalds");
    if (global_start < 0) { mb_status(line, "FAIL clock"); goto out; }
    if (!u || !got) { mb_status(line, "FAIL out of memory"); goto out; }
    {   /* mint: every cell of the public pattern */
        sh_pads_writer *w = sh_pads_writer_open(path, model_digest, seed_id, groups, MB_GROUPS, 0, MB_INDICES, pk, &err);
        if (!w) { char m[200]; snprintf(m, sizeof m, "FAIL writer open (%d)", err); mb_status(line, m); goto out; }
        for (uint64_t index = 0; index < MB_INDICES; index++) for (uint32_t g = 0; g < MB_GROUPS; g++) {
            for (uint64_t j = 0; j < (uint64_t)mb_widths[g]; j++) u[j] = mb_value(j, index, g);
            const int crc = sh_pads_writer_cell(w, index, g, u);
            if (crc != 0) { char m[200]; snprintf(m, sizeof m, "FAIL writer cell %llu/%u (%d)", (unsigned long long)index, g, crc); mb_status(line, m); (void)sh_pads_writer_close(w); goto out; }
        }
        const int close_rc = sh_pads_writer_close(w);            /* always frees the writer; links the final file on success */
        if (close_rc != 0) { char m[200]; snprintf(m, sizeof m, "FAIL writer close (%d)", close_rc); mb_status(line, m); goto out; }
    }
    r = sh_pads_reader_open(dir, seed_id, sk, &err);
    if (!r) { char m[200]; snprintf(m, sizeof m, "FAIL reader open (%d)", err); mb_status(line, m); goto out; }
    { const int brc = sh_pads_reader_bind(r, groups, MB_GROUPS); if (brc != 0) { char m[200]; snprintf(m, sizeof m, "FAIL reader bind (%d)", brc); mb_status(line, m); goto out; } }
    /* untimed: every element of every cell must equal the pattern, so the timed loop can never be measuring a failure path */
    for (uint64_t index = 0; index < MB_INDICES; index++) for (uint32_t g = 0; g < MB_GROUPS; g++) {
        const int rrc = sh_pads_reader_cell(r, g, index, got);
        if (rrc != 0) { char m[200]; snprintf(m, sizeof m, "FAIL verify read %llu/%u (%d)", (unsigned long long)index, g, rrc); mb_status(line, m); goto out; }
        for (uint64_t j = 0; j < (uint64_t)mb_widths[g]; j++) if (got[j] != mb_value(j, index, g)) { char m[200]; snprintf(m, sizeof m, "FAIL verify mismatch at %llu/%u element %llu", (unsigned long long)index, g, (unsigned long long)j); mb_status(line, m); goto out; }
    }
    if (clock_us() - global_start > 10000000) { mb_status(line, "FAIL over the 10 s bound before timing"); goto out; }
    for (uint32_t g = 0; g < MB_GROUPS; g++) {   /* timed: warm-file import of this group's cells, ~1.5 s, whole bound 10 s */
        const int64_t width = mb_widths[g]; const int64_t start = clock_us(); int64_t now = start; uint64_t calls = 0, checksum = 0;
        if (start < global_start || start - global_start > 10000000) { mb_status(line, "FAIL clock before a case"); goto out; }
        do {
            const int rrc = sh_pads_reader_cell(r, g, calls % MB_INDICES, got);
            if (rrc != 0) { char m[200]; snprintf(m, sizeof m, "FAIL timed read case %u (%d)", g, rrc); mb_status(line, m); goto out; }
            checksum += (uint32_t)got[calls % (uint64_t)width]; calls++;
            now = clock_us();
            if (now < start || now - global_start > 10000000) { mb_status(line, "FAIL over the 10 s bound during timing"); goto out; }
        } while (calls < (1u << 19) && now - start < 1500000);   /* the call cap only bounds a stalled clock; a case must still span >= 1 s to count */
        if (now <= start || now - start < 1000000) { mb_status(line, "FAIL case shorter than 1 s (clock or call cap)"); goto out; }
        char m[384];
        snprintf(m, sizeof m, "CELL_IMPORT case=%u width=%lld calls=%llu elements=%llu bytes=%llu elapsed_us=%lld checksum=%llu",
                 g, (long long)width, (unsigned long long)calls, (unsigned long long)(calls * (uint64_t)width), (unsigned long long)(calls * (SH_PADS_CELL_TAG + 3ull * (uint64_t)width)), (long long)(now - start), (unsigned long long)checksum);
        line(m);
    }
    rc = 0;
out:
    if (r) sh_pads_reader_close(r);                                  /* reader closed BEFORE the file goes */
    if (unlink(path) != 0 && errno != ENOENT && rc == 0) { char m[200]; snprintf(m, sizeof m, "FAIL unlink: %s", strerror(errno)); mb_status(line, m); rc = 2; }   /* the exact path only; a close that failed after publication still leaves it */
    if (rmdir(dir) != 0 && rc == 0) { char m[200]; snprintf(m, sizeof m, "FAIL rmdir: %s", strerror(errno)); mb_status(line, m); rc = 2; }
    if (rc == 0) line("CELL_IMPORT end: complete; three cases; temporary shipment removed");
    free(u); free(got);
    return rc;
}
