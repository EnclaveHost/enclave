#ifndef SHIELDED_DEALER_STREAM_H
#define SHIELDED_DEALER_STREAM_H

/* Private parent/child protocol for the opt-in CPU dealer. No network listener.
 * Six TAB-separated fields, exactly one LF-terminated record per shipment:
 *   sequence, seed_hex64, seed_id_hex32, pad_pk_hex64, index0, count
 * Sequence starts at1 and advances exactly once per accepted request. A failed
 * request terminates the process; the parent reconciles published files before
 * retrying in a new process. Output directory is fixed by the command line;
 * requests cannot supply paths, flags, asset identities or backend settings.
 */
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <climits>
#include <sys/stat.h>
#include <string>

static constexpr size_t SH_DEALER_STREAM_LINE_MAX = 256;
static constexpr uint64_t SH_DEALER_STREAM_MAX_COUNT = 4096;
static constexpr uint64_t SH_DEALER_STREAM_INDEX_LIMIT = UINT64_C(1) << 24;

static inline void sh_dealer_stream_wipe(void *p, size_t n) {
    volatile unsigned char *b = static_cast<volatile unsigned char *>(p);
    while (n--) *b++ = 0;
}

struct sh_dealer_stream_job {
    uint64_t sequence = 0, index0 = 0, count = 0;
    char seed[65] = {}, seed_id[33] = {}, pad_pk[65] = {};
    ~sh_dealer_stream_job() { sh_dealer_stream_wipe(seed, sizeof seed); }
};

// Trusted local assets must remain immutable. This detects replacement/editing;
// it is not content authentication, and does not defend against a hostile pager.
struct sh_dealer_stream_asset {
    std::string path;
    struct stat stamp = {};
    bool capture(const char *p) {
        struct stat st;
        if (!p || stat(p, &st) || !S_ISREG(st.st_mode) || st.st_size <= 0) return false;
        path = p; stamp = st; return true;
    }
    bool unchanged() const {
        struct stat st;
        return !path.empty() && !stat(path.c_str(), &st) && S_ISREG(st.st_mode) &&
            st.st_dev == stamp.st_dev && st.st_ino == stamp.st_ino && st.st_size == stamp.st_size &&
            st.st_mtim.tv_sec == stamp.st_mtim.tv_sec && st.st_mtim.tv_nsec == stamp.st_mtim.tv_nsec &&
            st.st_ctim.tv_sec == stamp.st_ctim.tv_sec && st.st_ctim.tv_nsec == stamp.st_ctim.tv_nsec;
    }
};

// 1=complete line,0=clean EOF,-1=I/O or malformed/truncated/oversized record.
// The fixed buffer never grows in response to input. Caller wipes it after use.
static inline int sh_dealer_stream_read(FILE *input, char line[SH_DEALER_STREAM_LINE_MAX], size_t *length) {
    if (!input || !line || !length) return -1;
    size_t n = 0;
    for (;;) {
        const int c = fgetc(input);
        if (c == EOF) return ferror(input) || n ? -1 : 0;
        if (c == '\n') { line[n] = 0; *length = n; return n ? 1 : -1; }
        if (n >= SH_DEALER_STREAM_LINE_MAX - 1 || (c < 32 && c != '\t') || c > 126) return -1;
        line[n++] = static_cast<char>(c);
    }
}

struct sh_dealer_stream_field { const char *p; size_t n; };
static inline bool sh_dealer_stream_decimal(sh_dealer_stream_field f, uint64_t *out) {
    if (!f.n || f.n > 20 || (f.n > 1 && f.p[0] == '0')) return false;
    uint64_t value = 0;
    for (size_t i = 0; i < f.n; i++) {
        if (f.p[i] < '0' || f.p[i] > '9') return false;
        const unsigned digit = static_cast<unsigned>(f.p[i] - '0');
        if (value > (UINT64_MAX - digit) / 10) return false;
        value = value * 10 + digit;
    }
    *out = value; return true;
}
static inline bool sh_dealer_stream_hex(sh_dealer_stream_field f, char *out, size_t digits) {
    if (f.n != digits) return false;
    for (size_t i = 0; i < digits; i++)
        if (!((f.p[i] >= '0' && f.p[i] <= '9') || (f.p[i] >= 'a' && f.p[i] <= 'f'))) return false;
    memcpy(out, f.p, digits); out[digits] = 0; return true;
}

// Refusal leaves the output unchanged. No parser diagnostic contains input.
static inline bool sh_dealer_stream_parse(const char *line, size_t length,
        uint64_t last_sequence, sh_dealer_stream_job *out) {
    if (!line || !out || !length || length >= SH_DEALER_STREAM_LINE_MAX || last_sequence == UINT64_MAX) return false;
    sh_dealer_stream_field fields[6] = {}; size_t field = 0, start = 0;
    for (size_t i = 0; i <= length; i++) {
        if (i < length && line[i] != '\t') {
            if (static_cast<unsigned char>(line[i]) < 32 || static_cast<unsigned char>(line[i]) > 126) return false;
            continue;
        }
        if (field == 6 || i == start) return false;
        fields[field++] = {line + start, i - start}; start = i + 1;
    }
    if (field != 6) return false;
    sh_dealer_stream_job parsed;
    if (!sh_dealer_stream_decimal(fields[0], &parsed.sequence) || parsed.sequence != last_sequence + 1 ||
        !sh_dealer_stream_hex(fields[1], parsed.seed, 64) || !sh_dealer_stream_hex(fields[2], parsed.seed_id, 32) ||
        !sh_dealer_stream_hex(fields[3], parsed.pad_pk, 64) || !sh_dealer_stream_decimal(fields[4], &parsed.index0) ||
        !sh_dealer_stream_decimal(fields[5], &parsed.count) || !parsed.count || parsed.count > SH_DEALER_STREAM_MAX_COUNT ||
        parsed.index0 >= SH_DEALER_STREAM_INDEX_LIMIT || parsed.count > SH_DEALER_STREAM_INDEX_LIMIT - parsed.index0)
        return false;
    *out = parsed;
    return true;
}

enum sh_dealer_stream_result { SH_DEALER_STREAM_OK, SH_DEALER_STREAM_ASSET_CHANGED, SH_DEALER_STREAM_MINT_FAILED };
using sh_dealer_stream_mint = sh_dealer_stream_result (*)(const sh_dealer_stream_job &, void *);

// The production dispatcher and the host fixture share this exact I/O loop.
// READY is emitted by the frontend only after successful model registration.
// A DONE is an acknowledgment of publication, not permission to consume pads.
static inline int sh_dealer_stream_run(FILE *input, FILE *output, sh_dealer_stream_mint mint, void *context) {
    if (!input || !output || !mint) return 2;
    uint64_t last_sequence = 0;
    for (;;) {
        char line[SH_DEALER_STREAM_LINE_MAX] = {};
        size_t length = 0;
        const int read_result = sh_dealer_stream_read(input, line, &length);
        sh_dealer_stream_job job;
        const bool parsed = read_result == 1 && sh_dealer_stream_parse(line, length, last_sequence, &job);
        sh_dealer_stream_wipe(line, sizeof line);
        if (read_result == 0) return 0;
        if (!parsed) {
            fprintf(output, "PADS-ERROR 0 protocol\n"); fflush(output);
            return 2;
        }
        const sh_dealer_stream_result result = mint(job, context);
        if (result != SH_DEALER_STREAM_OK) {
            fprintf(output, "PADS-ERROR %llu %s\n", (unsigned long long)job.sequence,
                result == SH_DEALER_STREAM_ASSET_CHANGED ? "asset-changed" : "mint-failed");
            fflush(output); return 1;
        }
        if (fprintf(output, "PADS-DONE %llu %s %llu %llu\n", (unsigned long long)job.sequence, job.seed_id,
                (unsigned long long)job.index0, (unsigned long long)job.count) < 0 || fflush(output)) return 1;
        last_sequence = job.sequence;
    }
}
#endif
