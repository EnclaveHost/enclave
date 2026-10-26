/* extent-recovery-stage/r2 ext4-extent-overlap = r1 + one -Wformat fix (root 1644: the logical offset expression mixed blk64_t,
 * i.e. unsigned long long, into a PRIu64 argument; it is now cast to uint64_t). No other change.
 * extent-recovery-stage/r1 ext4-extent-overlap (PREPARED by Claude; NOT compiled or run by Claude).
 *
 * READ-ONLY report of which blocks of a list of CANDIDATE physical extents are marked ALLOCATED in an ext4 filesystem's CURRENT
 * block bitmap. It never writes: ext2fs_open() without EXT2_FLAG_RW (the unix io manager then opens the path O_RDONLY), no
 * ext2fs_write_*, no flush, ext2fs_close_free() only. It refuses a mounted filesystem and does not ignore checksum errors.
 *
 * Meaning (do not over-read): "allocated now" means the current bitmap marks the block in use. It does NOT prove the block's bytes
 * were overwritten (that needs reading and comparing the actual bytes), and "free now" does NOT prove the bytes are intact (a block
 * can have been reused and freed again: the deleted-bitmap transient-reuse question is a separate gate).
 *
 *   ext4-extent-overlap [--crosscheck] [--max-output-bytes N] DEVICE_OR_IMAGE  < extents.tsv
 * stdin: one extent per line, "index logical physical blocks unwritten(0|1)" (decimal; at most MAX_EXTENTS lines).
 * stdout: "#"-metadata lines, then "overlap <index> <logical> <physical> <count> <unwritten>" per allocated sub-range (printing
 *         stops once max-output-bytes (<= 16 MiB) would be exceeded; counting never stops), then ONE final "summary ..." line.
 * exit: 0 = complete, every extent valid; 3 = completed but some extents invalid (reported); 1 = refused/failed (no summary). */
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <ext2fs/ext2fs.h>

#define MAX_EXTENTS 1000000UL
#define MAX_LINE 256
#define MAX_EXTENT_BLOCKS 32768ULL                 /* ext4 extent length limit (initialized; unwritten is <= 32767) */
#define OUTPUT_CAP (16ULL << 20)
#define MAX_CROSSCHECK_BLOCKS (1ULL << 31)

static uint64_t out_bytes, out_cap = OUTPUT_CAP, printed, truncated;

static void emit(const char *line) {
    size_t n = strlen(line);
    if (truncated || out_bytes + n > out_cap) { truncated = 1; return; }
    fputs(line, stdout); out_bytes += n; printed++;
}

static int parse_u64(const char *s, uint64_t *v) {
    char *e; if (!*s || *s == '-' || *s == '+') return 0;
    errno = 0; unsigned long long x = strtoull(s, &e, 10);
    if (errno || *e) return 0;
    *v = (uint64_t)x; return 1;
}

int main(int argc, char **argv) {
    int crosscheck = 0, a = 1;
    while (a < argc && argv[a][0] == '-') {
        if (!strcmp(argv[a], "--crosscheck")) { crosscheck = 1; a++; }
        else if (!strcmp(argv[a], "--max-output-bytes") && a + 1 < argc) {
            uint64_t v; if (!parse_u64(argv[a + 1], &v) || v < 64 || v > OUTPUT_CAP) { fprintf(stderr, "REFUSED: --max-output-bytes 64..%llu\n", OUTPUT_CAP); return 1; }
            out_cap = v; a += 2;
        } else { fprintf(stderr, "REFUSED: unknown option %s\n", argv[a]); return 1; }
    }
    if (argc - a != 1) { fprintf(stderr, "usage: ext4-extent-overlap [--crosscheck] [--max-output-bytes N] DEVICE_OR_IMAGE < extents.tsv\n"); return 1; }
    const char *dev = argv[a];
    struct stat st;
    if (lstat(dev, &st) != 0 || !(S_ISBLK(st.st_mode) || S_ISREG(st.st_mode))) { fprintf(stderr, "REFUSED: %s is not a block device or regular file (no symlink)\n", dev); return 1; }

    int mflags = 0;
    errcode_t err = ext2fs_check_if_mounted(dev, &mflags);
    if (err) { fprintf(stderr, "REFUSED: cannot determine mount state: %s\n", error_message(err)); return 1; }
    if (mflags & EXT2_MF_MOUNTED) { fprintf(stderr, "REFUSED: %s is mounted (its bitmap may change underneath): use a read-only, unmounted view\n", dev); return 1; }

    ext2_filsys fs = NULL;
    /* READ-ONLY: no EXT2_FLAG_RW; 64-bit block numbers; checksum errors are NOT ignored */
    err = ext2fs_open(dev, EXT2_FLAG_64BITS, 0, 0, unix_io_manager, &fs);
    if (err) { fprintf(stderr, "REFUSED: ext2fs_open (read-only): %s\n", error_message(err)); return 1; }
    if (fs->flags & EXT2_FLAG_RW) { fprintf(stderr, "REFUSED: filesystem unexpectedly opened read-write\n"); ext2fs_close_free(&fs); return 1; }
    /* no false negatives: an unreplayed journal can hold allocations the on-disk bitmap does not show yet */
    if (ext2fs_has_feature_journal_needs_recovery(fs->super)) {
        fprintf(stderr, "REFUSED: the journal needs recovery: the on-disk block bitmap may miss journaled allocations (no replay here; use a recovered read-only copy)\n");
        ext2fs_close_free(&fs); return 1;
    }
    /* bigalloc: the bitmap is per cluster and the search returns cluster-aligned blocks; r1 supports cluster ratio 1 only */
    if (EXT2FS_CLUSTER_RATIO(fs) != 1) { fprintf(stderr, "REFUSED: bigalloc (cluster ratio %d) is not supported by r1\n", EXT2FS_CLUSTER_RATIO(fs)); ext2fs_close_free(&fs); return 1; }
    err = ext2fs_read_block_bitmap(fs);
    if (err) { fprintf(stderr, "REFUSED: read block bitmap: %s\n", error_message(err)); ext2fs_close_free(&fs); return 1; }

    const uint64_t blocks = ext2fs_blocks_count(fs->super), first = fs->super->s_first_data_block;
    const uint64_t bstart = ext2fs_get_block_bitmap_start2(fs->block_map), bend = ext2fs_get_block_bitmap_end2(fs->block_map);
    char line[MAX_LINE + 2], buf[512];
    snprintf(buf, sizeof buf, "# ext4-extent-overlap r1 read-only device=%s blockSize=%u blocksCount=%" PRIu64 " firstDataBlock=%" PRIu64
             " freeBlocks=%" PRIu64 " clusterRatio=%d bitmap=[%" PRIu64 ",%" PRIu64 "] state=0x%x errors=%u\n", dev, fs->blocksize, blocks, first,
             (uint64_t)ext2fs_free_blocks_count(fs->super), EXT2FS_CLUSTER_RATIO(fs), bstart, bend,
             (unsigned)fs->super->s_state, (unsigned)fs->super->s_error_count);
    emit(buf);

    uint64_t n = 0, invalid = 0, in_blocks = 0, ranges = 0, ov_blocks = 0, ov_unwritten = 0, ov_extents = 0, cc_blocks = 0, cc_mismatch = 0;
    while (fgets(line, sizeof line, stdin)) {
        size_t len = strlen(line);
        if (len == 0 || line[len - 1] != '\n') { fprintf(stderr, "REFUSED: input line %" PRIu64 " too long or unterminated\n", n + 1); ext2fs_close_free(&fs); return 1; }
        line[len - 1] = 0;
        if (++n > MAX_EXTENTS) { fprintf(stderr, "REFUSED: more than %lu extents\n", MAX_EXTENTS); ext2fs_close_free(&fs); return 1; }
        char *f[6]; int k = 0; char *save = NULL;
        for (char *t = strtok_r(line, " ", &save); t && k < 6; t = strtok_r(NULL, " ", &save)) f[k++] = t;
        uint64_t idx, lg, ph, cnt, uw;
        if (k != 5 || !parse_u64(f[0], &idx) || !parse_u64(f[1], &lg) || !parse_u64(f[2], &ph) || !parse_u64(f[3], &cnt) || !parse_u64(f[4], &uw) || uw > 1) {
            fprintf(stderr, "REFUSED: malformed input line %" PRIu64 "\n", n); ext2fs_close_free(&fs); return 1;
        }
        /* range validation against the filesystem: never pass an out-of-range block to the bitmap */
        if (cnt == 0 || cnt > MAX_EXTENT_BLOCKS || ph < first || ph < bstart || ph > blocks || cnt > blocks - ph || ph + cnt - 1 > bend) {
            invalid++;
            snprintf(buf, sizeof buf, "invalid %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n", idx, lg, ph, cnt, uw);
            emit(buf); continue;
        }
        in_blocks += cnt;
        const uint64_t end = ph + cnt - 1;
        uint64_t s = ph, here = 0;
        while (s <= end) {
            blk64_t set, zero;
            err = ext2fs_find_first_set_block_bitmap2(fs->block_map, s, end, &set);
            if (err == ENOENT) break;
            if (err) { fprintf(stderr, "REFUSED: bitmap search failed at %" PRIu64 ": %s\n", s, error_message(err)); ext2fs_close_free(&fs); return 1; }
            err = ext2fs_find_first_zero_block_bitmap2(fs->block_map, set, end, &zero);
            if (err == ENOENT) zero = end + 1;
            else if (err) { fprintf(stderr, "REFUSED: bitmap search failed at %" PRIu64 ": %s\n", (uint64_t)set, error_message(err)); ext2fs_close_free(&fs); return 1; }
            const uint64_t c = zero - set;
            ranges++; ov_blocks += c; here += c; if (uw) ov_unwritten += c;
            snprintf(buf, sizeof buf, "overlap %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n", idx, (uint64_t)(lg + ((uint64_t)set - ph)), (uint64_t)set, c, uw);   /* r2: blk64_t is unsigned long long */
            emit(buf);
            s = zero;
        }
        if (here) ov_extents++;
        if (crosscheck) {                           /* independent per-block test: the range search must not miss any block */
            if (cc_blocks + cnt > MAX_CROSSCHECK_BLOCKS) { fprintf(stderr, "REFUSED: crosscheck bound exceeded\n"); ext2fs_close_free(&fs); return 1; }
            uint64_t bits = 0;
            for (uint64_t b = ph; b <= end; b++) bits += !!ext2fs_test_block_bitmap2(fs->block_map, b);
            cc_blocks += cnt; if (bits != here) cc_mismatch++;
        }
    }
    if (ferror(stdin)) { fprintf(stderr, "REFUSED: input read error\n"); ext2fs_close_free(&fs); return 1; }
    ext2fs_close_free(&fs);
    printf("summary extents=%" PRIu64 " invalid=%" PRIu64 " inputBlocks=%" PRIu64 " overlapExtents=%" PRIu64 " overlapRanges=%" PRIu64
           " overlapBlocks=%" PRIu64 " overlapUnwrittenBlocks=%" PRIu64 " printedLines=%" PRIu64 " truncated=%" PRIu64
           " crosscheck=%d crosscheckBlocks=%" PRIu64 " crosscheckMismatches=%" PRIu64 "\n",
           n, invalid, in_blocks, ov_extents, ranges, ov_blocks, ov_unwritten, printed, truncated, crosscheck, cc_blocks, cc_mismatch);
    if (fflush(stdout) != 0 || ferror(stdout)) return 1;
    if (cc_mismatch) return 1;
    return invalid ? 3 : 0;
}
