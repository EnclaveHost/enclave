/* anchor-maskbench: the MASKBENCH comparator (payload/anchor_maskbench.c) against a shipment minted on the host by the
 * production writer (payload/anchor_maskbench_mint.c, host-only): copy under a temp store, verify, time, remove; a missing
 * asset fails without timing lines; nothing is left behind. */
#define _GNU_SOURCE
#include "anchor_maskbench.h"
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
int anchor_maskbench_mint(const char *path, char *why, size_t whycap);
static int checks = 0, failed = 0;
#define CHECK(c, what) do { const int _r = (c); checks++; if (!_r) { failed++; fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, what); } } while (0)
static int64_t clk(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (int64_t)t.tv_sec * 1000000 + t.tv_nsec / 1000; }
static char lines[64][400]; static int n_lines = 0;
static void line(const char *s) { if (n_lines < 64) snprintf(lines[n_lines++], sizeof lines[0], "%s", s); }
static int count_prefix(const char *p) { int n = 0; for (int i = 0; i < n_lines; i++) if (!strncmp(lines[i], p, strlen(p))) n++; return n; }
static int entries(const char *d) { DIR *x = opendir(d); if (!x) return -1; int n = 0; struct dirent *e; while ((e = readdir(x))) if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) n++; closedir(x); return n; }
int main(void) {
    const char *td = getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp"; char store[512], mint[512], asset[600]; snprintf(store, sizeof store, "%s/maskbench-store-XXXXXX", td); snprintf(mint, sizeof mint, "%s/maskbench-mint-XXXXXX", td);
    CHECK(mkdtemp(store) != NULL && mkdtemp(mint) != NULL, "temp dirs");
    snprintf(asset, sizeof asset, "%s/maskbench.pads", mint); char why[256];
    CHECK(anchor_maskbench_mint(asset, why, sizeof why) == 0, "host mint with the production writer");
    CHECK(anchor_maskbench_mint(asset, why, sizeof why) != 0 && strstr(why, "writer open"), "minting over an existing file is refused");
    const int64_t t0 = clk(); const int rc = anchor_maskbench_import(store, asset, clk, line); const int64_t ms = (clk() - t0) / 1000;
    CHECK(rc == 0, "comparator PASS rc");
    CHECK(count_prefix("CELL_IMPORT case=0 width=5120 ") == 1 && count_prefix("CELL_IMPORT case=1 width=34816 ") == 1 && count_prefix("CELL_IMPORT case=2 width=248320 ") == 1, "three CELL_IMPORT lines, one per width");
    for (int i = 0; i < n_lines; i++) if (!strncmp(lines[i], "CELL_IMPORT case=", 17)) { unsigned long long calls = 0, el = 0, by = 0; long long us = 0; int w = 0;
        const int ok = sscanf(lines[i], "CELL_IMPORT case=%*u width=%d calls=%llu elements=%llu bytes=%llu elapsed_us=%lld", &w, &calls, &el, &by, &us) == 5 && calls >= 1 && el == calls * (unsigned long long)w && by == calls * (16ull + 3ull * (unsigned long long)w) && us >= 1000000 && us <= 2000000;
        if (!ok) fprintf(stderr, "  line: %s\n", lines[i]);
        CHECK(ok, "CELL_IMPORT line arithmetic and 1-2 s window"); }
    CHECK(count_prefix("CELL_IMPORT begin: warm encrypted-store file") == 1 && count_prefix("CELL_IMPORT end: complete; three cases; temporary shipment removed") == 1, "begin and end lines of the contract");
    CHECK(count_prefix("CELL_IMPORT FAIL") == 0, "no failure line on the pass path");
    CHECK(entries(store) == 0, "nothing left in the store (file and directory removed)");
    CHECK(access(asset, R_OK) == 0, "the asset itself is untouched");
    CHECK(ms < 12000, "whole comparator under the 10 s bound plus copy");
    n_lines = 0; CHECK(anchor_maskbench_import(store, "/nonexistent-maskbench.pads", clk, line) != 0 && count_prefix("CELL_IMPORT case=") == 0 && count_prefix("CELL_IMPORT end") == 0 && count_prefix("CELL_IMPORT FAIL asset open") == 1 && entries(store) == 0, "missing asset: one FAIL line, no timing, store clean");
    n_lines = 0; CHECK(anchor_maskbench_import("/nonexistent-maskbench-store", asset, clk, line) != 0 && count_prefix("CELL_IMPORT case=") == 0 && count_prefix("CELL_IMPORT FAIL mkdtemp") == 1, "missing store: one FAIL line, no timing");
    { char junk[600]; snprintf(junk, sizeof junk, "%s/junk.pads", mint); FILE *f = fopen(junk, "wb"); fputs("not a shipment", f); fclose(f);
      n_lines = 0; const int jrc = anchor_maskbench_import(store, junk, clk, line);
      /* the production reader skips a file whose header does not verify (an empty bank is permitted), so the refusal
       * surfaces at bind or at the first verify read; either way: no timing line, one FAIL line, store clean */
      const int jok = jrc != 0 && count_prefix("CELL_IMPORT case=") == 0 && count_prefix("CELL_IMPORT end") == 0 && count_prefix("CELL_IMPORT FAIL") == 1 && (count_prefix("CELL_IMPORT FAIL reader") == 1 || count_prefix("CELL_IMPORT FAIL verify read") == 1) && entries(store) == 0;
      if (!jok) for (int i = 0; i < n_lines; i++) fprintf(stderr, "  junk line: %s\n", lines[i]);
      CHECK(jok, "junk asset: refused at bind or first read, no timing, store clean"); unlink(junk); }
    CHECK(anchor_maskbench_import(NULL, asset, clk, line) == 2 && anchor_maskbench_import(store, NULL, clk, line) == 2 && anchor_maskbench_import(store, asset, NULL, line) == 2 && anchor_maskbench_import(store, asset, clk, NULL) == 2, "null arguments refused");
    unlink(asset); rmdir(mint); rmdir(store);
    printf("{\"status\":\"%s\",\"executed_checks\":%d}\n", failed ? "FAIL" : "PASS", checks);
    return failed ? 1 : 0;
}
