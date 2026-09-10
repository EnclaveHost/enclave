/* Formatter fixture: the PADBUDGET record writer, on the host, with no engine.
 *
 * It includes the CANDIDATE anchor_pad_budget_report.h, so it exercises the
 * actual helper, encoder and line writer rather than a mirror of them. The
 * backend metadata is stubbed: these structs are plain data, so no link, reader,
 * pad, lock or device is involved anywhere below.
 *
 * The reporter writes to a caller-supplied FILE*, which production sets to
 * stderr; here it is an open_memstream buffer so every byte can be read back and
 * checked. stdout is watched throughout and must stay empty, because a PADBUDGET
 * record on stdout, the control socket or the Android log would either be lost
 * from the authoritative engine.stderr capture or duplicated into it.
 *
 *   node --test test/shielded-pad-budget.test.mjs
 */
#define _GNU_SOURCE
#include "../../shielded/anchor/avf/payload/anchor_pad_budget_report.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int failures = 0;
/* The fixture's own progress goes to a DUP of the original stdout, while the
 * real stdout stream is redirected to a file. Anything the reporter wrote to
 * stdout would therefore land in that file, and the file is asserted empty at
 * the end. Without this split the check would be vacuous, because the fixture's
 * own prints would fill stdout themselves. */
static FILE *g_log;
static char  g_stdout_path[512];   /* argv[1] if given; see main */
static void expect(const char *what, int cond) {
    if (!cond) { failures++; fprintf(stderr, "FAIL %s\n", what); }
    else fprintf(g_log, "ok   %s\n", what);
}

/* ---- capture -------------------------------------------------------------- */
static FILE *cap_open(char **buf, size_t *len) {
    FILE *f = open_memstream(buf, len);
    assert(f);
    return f;
}
static char *cap_close(FILE *f, char **buf) { fflush(f); fclose(f); return *buf; }

static unsigned count_lines(const char *s) {
    unsigned n = 0;
    for (const char *p = s; *p; p++) if (*p == '\n') n++;
    return n;
}
/* Every line whole, newline-terminated, and within the bound. */
static int lines_well_formed(const char *s, size_t len, size_t *longest) {
    *longest = 0;
    if (len == 0) return 1;
    if (s[len - 1] != '\n') return 0;
    size_t start = 0;
    for (size_t i = 0; i < len; i++) {
        if (s[i] != '\n') continue;
        const size_t n = i - start;                    /* excluding the newline */
        if (n > *longest) *longest = n;
        if (n == 0 || n >= ANCHOR_PAD_BUDGET_LINE_CAP) return 0;
        if (strncmp(s + start, "PADBUDGET v", 11) != 0) return 0;
        start = i + 1;
    }
    return 1;
}
static unsigned count_occurrences(const char *hay, const char *needle) {
    unsigned n = 0;
    for (const char *p = strstr(hay, needle); p; p = strstr(p + 1, needle)) n++;
    return n;
}

/* ---- stub metadata -------------------------------------------------------- */
static sh_pad_budget stub_budget(uint32_t groups, uint32_t intervals) {
    sh_pad_budget b;
    memset(&b, 0, sizeof b);
    b.version = SH_PAD_BUDGET_VERSION;
    b.status = SH_PAD_BUDGET_OK; b.reader_status = SH_PAD_BUDGET_OK;
    b.card = 0;
    b.mono_start_ns = 1000; b.mono_end_ns = 2000; b.mono_valid = true;
    b.dealt = true; b.threads_running = true;
    b.pad_window = 64; b.win_lo = 64; b.win_hi = 192;
    b.counters_valid = true; b.link_pads_used = 6764; b.link_pads_missed = 0; b.pads_waited = 0;
    b.reader_files = 8; b.reader_bound_groups = groups; b.reader_bound_table_present = true;
    b.bind_epoch = 0; b.bind_epoch_known = false;
    b.n_intervals = intervals; b.cap_intervals = SH_PAD_BUDGET_MAX_INTERVALS_PER_LINE;
    b.n_groups = groups; b.cap_groups = 512; b.written_groups = groups;
    b.intervals_are_bound_coverage = true;
    b.link_observed = true;
    return b;
}
static void fill_groups(sh_pad_group_budget *g, uint32_t n, const char *name) {
    for (uint32_t i = 0; i < n; i++) {
        memset(&g[i], 0, sizeof g[i]);
        g[i].group = i;
        snprintf(g[i].name, sizeof g[i].name, "%s%u", name, i);
        g[i].K = 5120; g[i].u_len = 16384;
        g[i].depth = 64; g[i].ready = 40; g[i].generating = 3; g[i].held = 2;
        g[i].cursor = 128 + i; g[i].pads_used = 25; g[i].pads_missed = 0;
    }
}

int main(int argc, char **argv) {
    {   /* Scratch file for the stdout capture. argv[1] is the caller's directory, as
         * test/fixtures/shielded-pad-replay.c also takes it, so build and run products
         * stay inside the temporary directory the test removes. */
        const char *tmp = argc > 1 && argv[1][0] ? argv[1]
                        : (getenv("TMPDIR") && getenv("TMPDIR")[0] ? getenv("TMPDIR") : "/tmp");
        const int w = snprintf(g_stdout_path, sizeof g_stdout_path,
                               "%s/pad-budget-stdout-XXXXXX", tmp);
        assert(w > 0 && (size_t)w < sizeof g_stdout_path);
    }
    {   /* split the fixture's own output away from the real stdout stream */
        const int saved = dup(STDOUT_FILENO);
        assert(saved >= 0);
        g_log = fdopen(saved, "w");
        assert(g_log);
        setvbuf(g_log, NULL, _IOLBF, 0);
        const int fd = mkstemp(g_stdout_path);
        assert(fd >= 0);
        close(fd);
        assert(freopen(g_stdout_path, "w", stdout));
    }

    {
        char *b = NULL; size_t l = 0;
        FILE *f = cap_open(&b, &l);
        sh_pad_budget bd = stub_budget(2, 1);
        sh_pad_interval iv[1] = { { 64, 128 } };
        sh_pad_group_budget gb[2];
        fill_groups(gb, 2, "blk.0.attn_q.weight.");
        anchor_pad_budget_report(f, "trial1.before", 0, 1, SH_PAD_BUDGET_OK, &bd, iv, gb);
        cap_close(f, &b);
        size_t longest = 0;
        expect("well formed", lines_well_formed(b, l, &longest));
        expect("header, cover and one group line", count_lines(b) == 3);
        expect("absolute timestamps present", strstr(b, "mono_start_ns=1000") &&
                                              strstr(b, "mono_end_ns=2000") &&
                                              strstr(b, "timestamp_valid=1") != NULL);
        expect("no span field", strstr(b, "span_ns=") == NULL);
        expect("epoch is unknown", strstr(b, "bind_epoch=unknown:0") != NULL);
        expect("coverage is a union", strstr(b, "cover=64-128") != NULL);
        expect("group carries K and u_len", strstr(b, ":5120:16384:64:40:3:2:") != NULL);
        expect("bound table reported", strstr(b, "bound_table=1") != NULL);
        expect("link half reported as observed", strstr(b, "link_observed=1") != NULL);
        free(b);
    }

    /* Every status maps to its exact string, including an out-of-range value. */
    {
        static const struct { int st; const char *want; } cases[] = {
            { SH_PAD_BUDGET_OK, "ok" }, { SH_PAD_BUDGET_UNAVAILABLE, "unavailable" },
            { SH_PAD_BUDGET_INCOMPLETE, "incomplete" }, { SH_PAD_BUDGET_INVALID, "invalid" },
            { SH_PAD_BUDGET_NO_READER, "no_reader" }, { SH_PAD_BUDGET_BUSY, "busy" },
            { SH_PAD_BUDGET_UNSTARTED, "unstarted" }, { SH_PAD_BUDGET_UNBOUND, "unbound" },
            { SH_PAD_BUDGET_BIND_INVALID, "bind_invalid" }, { 4242, "unknown" },
        };
        int all = 1;
        for (size_t i = 0; i < sizeof cases / sizeof *cases; i++)
            if (strcmp(anchor_pad_budget_status(cases[i].st), cases[i].want)) all = 0;
        expect("every status has its exact name", all);
    }

    /* A busy record must carry no coverage line at all. */
    {
        char *b = NULL; size_t l = 0;
        FILE *f = cap_open(&b, &l);
        sh_pad_budget bd = stub_budget(0, 0);
        bd.status = bd.reader_status = SH_PAD_BUDGET_BUSY;
        bd.dealt = false; bd.threads_running = false; bd.written_groups = 0;
        bd.reader_bound_table_present = false; bd.intervals_are_bound_coverage = false;
        bd.link_observed = false;                    /* pool-busy shape: nothing was read */
        anchor_pad_budget_report(f, "trial1.after", 0, 1, SH_PAD_BUDGET_BUSY, &bd, NULL, NULL);
        cap_close(f, &b);
        expect("busy is one header line only", count_lines(b) == 1);
        expect("pool-busy record says the link was not observed",
               strstr(b, "link_observed=0") != NULL);
        expect("busy says busy twice", count_occurrences(b, "busy") == 2);
        expect("busy has no cover line", strstr(b, "cover=") == NULL);
        free(b);

        /* The other BUSY shape: the link WAS read, only the coverage was not.
         * A parser must be able to tell these apart from the record alone. */
        b = NULL; l = 0; f = cap_open(&b, &l);
        sh_pad_budget rb = stub_budget(2, 0);
        rb.status = SH_PAD_BUDGET_BUSY; rb.reader_status = SH_PAD_BUDGET_BUSY;
        rb.link_observed = true; rb.reader_files = 0; rb.reader_bound_groups = 0;
        rb.reader_bound_table_present = false; rb.intervals_are_bound_coverage = false;
        sh_pad_group_budget rgb[2];
        fill_groups(rgb, 2, "blk.1.attn_q.weight.");
        rb.written_groups = 2;
        anchor_pad_budget_report(f, "trial2.after", 0, 1, SH_PAD_BUDGET_BUSY, &rb, NULL, rgb);
        cap_close(f, &b);
        expect("reader-busy record says the link WAS observed",
               strstr(b, "link_observed=1") != NULL);
        expect("reader-busy record still carries its groups", count_lines(b) == 2);
        expect("reader-busy record claims no coverage",
               strstr(b, "bound_coverage=0") && strstr(b, "cover=") == NULL);
        free(b);
    }

    /* The real geometry: 262 groups over ceil(262/8) = 33 lines. */
    {
        char *b = NULL; size_t l = 0;
        FILE *f = cap_open(&b, &l);
        sh_pad_budget bd = stub_budget(262, 1);
        sh_pad_interval iv[1] = { { 0, 128 } };
        sh_pad_group_budget *gb = (sh_pad_group_budget *)calloc(262, sizeof *gb);
        assert(gb); fill_groups(gb, 262, "blk.10.ffn_down.weight.");
        anchor_pad_budget_report(f, "trial2.before", 0, 1, SH_PAD_BUDGET_OK, &bd, iv, gb);
        cap_close(f, &b);
        size_t longest = 0;
        expect("262 groups well formed", lines_well_formed(b, l, &longest));
        expect("262 groups over 33 lines", count_lines(b) == 1 + 1 + 33);
        expect("262 groups do not truncate", longest < ANCHOR_PAD_BUDGET_LINE_CAP);
        expect("no overflow record", strstr(b, "overflow") == NULL);
        free(gb); free(b);
    }

    /* The cap: 512 groups over 64 lines, still whole. */
    {
        char *b = NULL; size_t l = 0;
        FILE *f = cap_open(&b, &l);
        sh_pad_budget bd = stub_budget(512, 0);
        sh_pad_group_budget *gb = (sh_pad_group_budget *)calloc(512, sizeof *gb);
        assert(gb); fill_groups(gb, 512, "blk.99.attn_output.weight.");
        anchor_pad_budget_report(f, "trial2.after", 0, 1, SH_PAD_BUDGET_INCOMPLETE, &bd, NULL, gb);
        cap_close(f, &b);
        size_t longest = 0;
        expect("512 groups well formed", lines_well_formed(b, l, &longest));
        expect("512 groups over 64 lines", count_lines(b) == 1 + 64);
        expect("512 groups do not truncate", longest < ANCHOR_PAD_BUDGET_LINE_CAP);
        free(gb); free(b);
    }

    /* Names that could otherwise fabricate a record. */
    {
        char *b = NULL; size_t l = 0;
        FILE *f = cap_open(&b, &l);
        sh_pad_budget bd = stub_budget(5, 0);
        sh_pad_group_budget gb[5];
        fill_groups(gb, 5, "x");
        snprintf(gb[0].name, sizeof gb[0].name, "blk.0.attn_q.weight");   /* plain */
        snprintf(gb[1].name, sizeof gb[1].name, "has space");
        snprintf(gb[2].name, sizeof gb[2].name, "has:colon");
        snprintf(gb[3].name, sizeof gb[3].name, "has\nnewline");
        gb[4].name[0] = 0;                                                /* empty */
        anchor_pad_budget_report(f, "edge", 0, 1, SH_PAD_BUDGET_OK, &bd, NULL, gb);
        cap_close(f, &b);
        size_t longest = 0;
        expect("edge names well formed", lines_well_formed(b, l, &longest));
        expect("edge names are one line", count_lines(b) == 2);
        expect("plain name verbatim", strstr(b, "0:blk.0.attn_q.weight:") != NULL);
        expect("space name hex", strstr(b, "1:x:68617320737061636") != NULL);
        expect("colon name hex", strstr(b, "2:x:6861733a636f6c6f6e:") != NULL);
        expect("newline name hex", strstr(b, "3:x:6861730a6e65776c696e65:") != NULL);
        expect("empty name is x:", strstr(b, "4:x::") != NULL);
        expect("no raw newline escaped into the record", count_lines(b) == 2);
        free(b);
    }

    /* A 63-byte name that must go out as 126 hex characters, eight to a line. */
    {
        char *b = NULL; size_t l = 0;
        FILE *f = cap_open(&b, &l);
        sh_pad_budget bd = stub_budget(8, 0);
        sh_pad_group_budget gb[8];
        fill_groups(gb, 8, "y");
        for (int i = 0; i < 8; i++) { memset(gb[i].name, ' ', 63); gb[i].name[63] = 0; }
        anchor_pad_budget_report(f, "hexmax", 0, 1, SH_PAD_BUDGET_OK, &bd, NULL, gb);
        cap_close(f, &b);
        size_t longest = 0;
        expect("longest hex names well formed", lines_well_formed(b, l, &longest));
        expect("longest hex names still one group line", count_lines(b) == 2);
        expect("longest hex names do not truncate", longest < ANCHOR_PAD_BUDGET_LINE_CAP);
        expect("no overflow record for hex names", strstr(b, "overflow") == NULL);
        free(b);
    }

    /* 64 intervals at the top of the uint64 range: the worst cover line there is. */
    {
        char *b = NULL; size_t l = 0;
        FILE *f = cap_open(&b, &l);
        sh_pad_budget bd = stub_budget(0, SH_PAD_BUDGET_MAX_INTERVALS_PER_LINE);
        bd.written_groups = 0;
        sh_pad_interval iv[SH_PAD_BUDGET_MAX_INTERVALS_PER_LINE];
        for (unsigned i = 0; i < SH_PAD_BUDGET_MAX_INTERVALS_PER_LINE; i++) {
            iv[i].lo = UINT64_MAX - 1; iv[i].hi = UINT64_MAX;
        }
        anchor_pad_budget_report(f, "ivmax", 0, 1, SH_PAD_BUDGET_OK, &bd, iv, NULL);
        cap_close(f, &b);
        size_t longest = 0;
        expect("max intervals well formed", lines_well_formed(b, l, &longest));
        expect("max intervals are one cover line", count_lines(b) == 2);
        expect("max intervals do not truncate", longest < ANCHOR_PAD_BUDGET_LINE_CAP);
        expect("max intervals do not overflow", strstr(b, "cover=overflow") == NULL);
        expect("max interval value present", strstr(b, "18446744073709551614-18446744073709551615") != NULL);
        free(b);
    }

    /* A note line, and the default-off gate. */
    {
        char *b = NULL; size_t l = 0;
        FILE *f = cap_open(&b, &l);
        anchor_pad_budget_note(f, "trial1.before", "unavailable", "symbol_absent", NULL);
        cap_close(f, &b);
        expect("note is one line", count_lines(b) == 1);
        expect("note names its reason", strstr(b, "status=unavailable reason=symbol_absent") != NULL);
        free(b);

        b = NULL; l = 0; f = cap_open(&b, &l);
        anchor_pad_budget_note(f, "trial1.before", "incomplete", "card_cap", "cards=9 cap=8");
        cap_close(f, &b);
        expect("card_cap note keeps its numbers",
               strstr(b, "status=incomplete reason=card_cap cards=9 cap=8") != NULL);
        expect("card_cap note is one line", count_lines(b) == 1);
        free(b);

        static const char *off[] = { NULL, "", "0", "2", "1x", "true", "yes" };
        int all_off = 1;
        for (size_t i = 0; i < sizeof off / sizeof *off; i++) {
            if (off[i]) setenv("SHIELDED_PAD_BUDGET", off[i], 1); else unsetenv("SHIELDED_PAD_BUDGET");
            if (anchor_pad_budget_enabled()) all_off = 0;
        }
        expect("default off, and only the exact string enables it", all_off);
        setenv("SHIELDED_PAD_BUDGET", "1", 1);
        expect("exactly \"1\" enables it", anchor_pad_budget_enabled() == 1);
        unsetenv("SHIELDED_PAD_BUDGET");
        expect("unsetting disables it again in the same process",
               anchor_pad_budget_enabled() == 0);
    }

    /* Nothing above may have written to stdout: these records belong on stderr
     * only, so that neither a logcat drop nor a second stream can corrupt or
     * duplicate the authoritative engine.stderr capture. */
    {
        fflush(stdout);
        struct stat st;
        const int ok = stat(g_stdout_path, &st) == 0 && st.st_size == 0;
        if (!ok) {
            failures++;
            fprintf(stderr, "FAIL the reporter wrote %lld bytes to stdout\n",
                    (long long)(stat(g_stdout_path, &st) == 0 ? st.st_size : -1));
        } else fprintf(g_log, "ok   stdout stayed empty throughout\n");
        unlink(g_stdout_path);
    }

    if (failures) { fprintf(stderr, "\n%d FAILURE(S)\n", failures); return 1; }
    fprintf(g_log, "\npad_budget_report_fixture: all checks passed\n");
    fflush(g_log);
    return 0;
}
