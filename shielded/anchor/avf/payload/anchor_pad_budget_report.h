/* PADBUDGET record formatting, to STDERR only.
 *
 * WHY ITS OWN WRITER. engine.cpp's outf() writes stdout, the Android log and the
 * control socket, and never stderr; the closed engine.stderr captures contain no
 * outf-only line at all. The PADBUDGET parser and runner consume engine.stderr,
 * so a diagnostic emitted through outf would be absent from the authoritative
 * capture. These records therefore go to stderr and ONLY to stderr: not the
 * control channel, not the Android log, not stdout, so a logcat drop or a second
 * stream cannot corrupt or duplicate the capture. Existing outf behaviour is not
 * touched.
 *
 * SELF-CONTAINED ON PURPOSE. Plain C, no allocation, no engine type, no global
 * state. The opt-in environment value is checked on each call. A host fixture includes this same
 * header and passes a FILE* it can read back, so the fixture exercises THIS
 * source rather than a mirror of it.
 *
 * BOUNDED, AND NEVER TRUNCATED. Every line is assembled in one stack buffer of
 * ANCHOR_PAD_BUDGET_LINE_CAP bytes and written with a single fwrite, which gives
 * the parser per-line atomicity. A line that would not fit is REPLACED by a
 * short explicit overflow record; nothing is ever cut short and silently
 * emitted. A whole-snapshot buffer is deliberately not used: at the 512-group
 * cap it would be about 100 KB of intermediate storage, so the compromise is one
 * bounded fwrite per line and one fflush at the end of each snapshot.
 */
#ifndef ANCHOR_PAD_BUDGET_REPORT_H
#define ANCHOR_PAD_BUDGET_REPORT_H

#include "shielded-pad-budget.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ANCHOR_PAD_BUDGET_LINE_CAP   4094u   /* matched to the engine's own line bound */
#define ANCHOR_PAD_BUDGET_PER_LINE      8u
#define ANCHOR_PAD_BUDGET_ENTRY_MAX   384u   /* one group record, worst case incl. a hex name */
#define ANCHOR_PAD_BUDGET_IV_MAX       48u   /* one interval, worst case "N-N," at 2^64-1 */
#define ANCHOR_PAD_BUDGET_PREFIX_MAX   96u   /* "PADBUDGET vN phase=... card=N g[NNN] " */
#define ANCHOR_PAD_BUDGET_NAME_ENC   (2u * SH_PAD_BUDGET_NAME_MAX + 4u)

#if defined(__cplusplus) && __cplusplus >= 201103L
static_assert(ANCHOR_PAD_BUDGET_PREFIX_MAX + ANCHOR_PAD_BUDGET_PER_LINE * ANCHOR_PAD_BUDGET_ENTRY_MAX
              < ANCHOR_PAD_BUDGET_LINE_CAP, "pad-budget group line can overflow its buffer");
static_assert(ANCHOR_PAD_BUDGET_PREFIX_MAX + SH_PAD_BUDGET_MAX_INTERVALS_PER_LINE * ANCHOR_PAD_BUDGET_IV_MAX
              < ANCHOR_PAD_BUDGET_LINE_CAP, "pad-budget cover line can overflow its buffer");
#endif

static const char *anchor_pad_budget_status(int st) {
    switch (st) {
        case SH_PAD_BUDGET_OK:           return "ok";
        case SH_PAD_BUDGET_UNAVAILABLE:  return "unavailable";
        case SH_PAD_BUDGET_INCOMPLETE:   return "incomplete";
        case SH_PAD_BUDGET_INVALID:      return "invalid";
        case SH_PAD_BUDGET_NO_READER:    return "no_reader";
        case SH_PAD_BUDGET_BUSY:         return "busy";
        case SH_PAD_BUDGET_UNSTARTED:    return "unstarted";
        case SH_PAD_BUDGET_UNBOUND:      return "unbound";
        case SH_PAD_BUDGET_BIND_INVALID: return "bind_invalid";
        default:                         return "unknown";
    }
}

/* SHIELDED_PAD_BUDGET=1 and nothing else. Default OFF: any other value, an empty
 * value and an unset variable all disable it. Read on each call rather than
 * cached: this runs four times per run at a bench boundary, never on the decode
 * path, so a getenv costs nothing worth keeping process-wide state for, and no
 * test seam is needed to observe it. */
static int anchor_pad_budget_enabled(void) {
    const char *v = getenv("SHIELDED_PAD_BUDGET");
    return (v && v[0] == '1' && v[1] == 0) ? 1 : 0;
}

/* Verbatim only when the name is non-empty and every byte is [A-Za-z0-9._-];
 * otherwise "x:" followed by lowercase hex of the raw bytes, which also renders
 * an empty name as "x:". A delimiter, a control byte or a newline in a name can
 * therefore never fabricate a record. Returns 0 if `out` is too small. */
static int anchor_pad_budget_name(const char *raw, size_t raw_cap, char *out, size_t out_cap) {
    size_t n = 0;
    while (n < raw_cap && raw[n]) n++;
    int plain = n > 0;
    for (size_t i = 0; i < n && plain; i++) {
        const unsigned char c = (unsigned char)raw[i];
        plain = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                c == '.' || c == '_' || c == '-';
    }
    if (plain) {
        if (n + 1 > out_cap) return 0;
        memcpy(out, raw, n); out[n] = 0; return 1;
    }
    if (2 + 2 * n + 1 > out_cap) return 0;
    static const char hex[] = "0123456789abcdef";
    out[0] = 'x'; out[1] = ':';
    for (size_t i = 0; i < n; i++) {
        out[2 + 2 * i]     = hex[((unsigned char)raw[i]) >> 4];
        out[2 + 2 * i + 1] = hex[((unsigned char)raw[i]) & 15];
    }
    out[2 + 2 * n] = 0;
    return 1;
}

/* One bounded, format-checked line to `out`, written with a single fwrite and a
 * trailing newline. Returns 1 when the line was written whole, 0 when it did not
 * fit; the caller emits an explicit overflow record instead of a cut line. */
#if defined(__GNUC__)
__attribute__((format(printf, 2, 3)))
#endif
static int anchor_pad_budget_emit(FILE *out, const char *fmt, ...) {
    char line[ANCHOR_PAD_BUDGET_LINE_CAP + 2];
    va_list ap; va_start(ap, fmt);
    const int n = vsnprintf(line, ANCHOR_PAD_BUDGET_LINE_CAP, fmt, ap);
    va_end(ap);
    if (n < 0 || (unsigned)n >= ANCHOR_PAD_BUDGET_LINE_CAP) return 0;   /* never truncate */
    line[n] = '\n';
    return fwrite(line, 1, (size_t)n + 1, out) == (size_t)n + 1;
}

/* A record with no card behind it. `extra` is an optional, already-bounded run
 * of "k=v" fields appended verbatim after reason=, so a note that has numbers
 * keeps them: the parser's schema depends on the numbers, not on prose. Pass
 * NULL when there are none. */
static void anchor_pad_budget_note(FILE *out, const char *phase, const char *status,
                                   const char *reason, const char *extra) {
    if (!anchor_pad_budget_emit(out, "PADBUDGET v%u phase=%s status=%s reason=%s%s%s",
                                (unsigned)SH_PAD_BUDGET_VERSION, phase, status, reason,
                                (extra && *extra) ? " " : "", (extra && *extra) ? extra : ""))
        (void)anchor_pad_budget_emit(out, "PADBUDGET v%u status=overflow", (unsigned)SH_PAD_BUDGET_VERSION);
    fflush(out);
}

/* One card's record: the header line, the coverage line when coverage was read
 * at all, then the group lines. Absolute monotonic endpoints, not a span: where
 * the observation sits relative to the boundary cannot be recovered from a
 * duration. Caller flushes once at the end of the snapshot. */
static void anchor_pad_budget_report(FILE *out, const char *phase, int card, int cards, int rc,
                                     const sh_pad_budget *b, const sh_pad_interval *iv,
                                     const sh_pad_group_budget *gb) {
    if (!out || !b) return;
    if (!anchor_pad_budget_emit(out,
            "PADBUDGET v%u phase=%s card=%d/%d status=%s reader=%s dealt=%d threads=%d stop=%d "
            "integrity_failed=%d window=%llu win_lo=%llu win_hi=%llu files=%llu bound=%u "
            "bind_epoch=%s%llu intervals=%u/%u groups=%u/%u written=%u counters_valid=%d "
            "used=%llu missed=%llu waited=%llu timestamp_valid=%d mono_start_ns=%llu "
            "mono_end_ns=%llu bound_coverage=%d bound_table=%d link_observed=%d",
            (unsigned)b->version, phase, card, cards, anchor_pad_budget_status(rc),
            anchor_pad_budget_status(b->reader_status),
            b->dealt ? 1 : 0, b->threads_running ? 1 : 0, b->stop ? 1 : 0,
            b->pad_integrity_failed ? 1 : 0,
            (unsigned long long)b->pad_window, (unsigned long long)b->win_lo,
            (unsigned long long)b->win_hi, (unsigned long long)b->reader_files,
            b->reader_bound_groups, b->bind_epoch_known ? "" : "unknown:",
            (unsigned long long)b->bind_epoch, b->n_intervals, b->cap_intervals,
            b->n_groups, b->cap_groups, b->written_groups, b->counters_valid ? 1 : 0,
            (unsigned long long)b->link_pads_used, (unsigned long long)b->link_pads_missed,
            (unsigned long long)b->pads_waited, b->mono_valid ? 1 : 0,
            (unsigned long long)b->mono_start_ns, (unsigned long long)b->mono_end_ns,
            b->intervals_are_bound_coverage ? 1 : 0, b->reader_bound_table_present ? 1 : 0,
            b->link_observed ? 1 : 0))
        (void)anchor_pad_budget_emit(out, "PADBUDGET v%u phase=%s card=%d status=overflow",
                                     (unsigned)b->version, phase, card);

    if (iv && (b->reader_status == SH_PAD_BUDGET_OK ||
               b->reader_status == SH_PAD_BUDGET_UNBOUND ||
               b->reader_status == SH_PAD_BUDGET_BIND_INVALID)) {
        char cover[ANCHOR_PAD_BUDGET_PREFIX_MAX + SH_PAD_BUDGET_MAX_INTERVALS_PER_LINE * ANCHOR_PAD_BUDGET_IV_MAX];
        size_t at = 0; int ok = 1;
        for (uint32_t i = 0; i < b->n_intervals && i < SH_PAD_BUDGET_MAX_INTERVALS_PER_LINE; i++) {
            const int w = snprintf(cover + at, sizeof cover - at, "%s%llu-%llu", at ? "," : "",
                                   (unsigned long long)iv[i].lo, (unsigned long long)iv[i].hi);
            if (w < 0 || (size_t)w >= sizeof cover - at) { ok = 0; break; }
            at += (size_t)w;
        }
        if (!ok || b->n_intervals > SH_PAD_BUDGET_MAX_INTERVALS_PER_LINE)
            (void)anchor_pad_budget_emit(out, "PADBUDGET v%u phase=%s card=%d cover=overflow n=%u",
                                         (unsigned)b->version, phase, card, b->n_intervals);
        else if (!anchor_pad_budget_emit(out, "PADBUDGET v%u phase=%s card=%d cover=%s",
                                         (unsigned)b->version, phase, card, at ? cover : "none"))
            (void)anchor_pad_budget_emit(out, "PADBUDGET v%u phase=%s card=%d cover=overflow n=%u",
                                         (unsigned)b->version, phase, card, b->n_intervals);
    }

    /* id:name:K:u_len:depth:ready:generating:held:cursor:pads_used:pads_missed */
    if (!gb) return;
    for (uint32_t i = 0; i < b->written_groups; i += ANCHOR_PAD_BUDGET_PER_LINE) {
        char row[ANCHOR_PAD_BUDGET_PER_LINE * ANCHOR_PAD_BUDGET_ENTRY_MAX];
        size_t at = 0; int ok = 1;
        for (uint32_t j = i; j < b->written_groups && j < i + ANCHOR_PAD_BUDGET_PER_LINE; j++) {
            char nm[ANCHOR_PAD_BUDGET_NAME_ENC];
            if (!anchor_pad_budget_name(gb[j].name, sizeof gb[j].name, nm, sizeof nm)) { ok = 0; break; }
            const int w = snprintf(row + at, sizeof row - at,
                                   "%s%u:%s:%lld:%lld:%d:%d:%d:%d:%llu:%llu:%llu",
                                   at ? " " : "", gb[j].group, nm,
                                   (long long)gb[j].K, (long long)gb[j].u_len,
                                   gb[j].depth, gb[j].ready, gb[j].generating, gb[j].held,
                                   (unsigned long long)gb[j].cursor,
                                   (unsigned long long)gb[j].pads_used,
                                   (unsigned long long)gb[j].pads_missed);
            if (w < 0 || (size_t)w >= sizeof row - at) { ok = 0; break; }
            at += (size_t)w;
        }
        if (!ok || !anchor_pad_budget_emit(out, "PADBUDGET v%u phase=%s card=%d g[%u] %s",
                                           (unsigned)b->version, phase, card, i, row))
            (void)anchor_pad_budget_emit(out, "PADBUDGET v%u phase=%s card=%d g[%u] overflow",
                                         (unsigned)b->version, phase, card, i);
    }
}

#endif
