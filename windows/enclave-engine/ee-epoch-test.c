/* ee-epoch-test.c -- tests for ee-epoch.h, the SAME source ee-host.exe compiles.
 *   workstation: cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined ee-epoch-test.c && ./a.out
 *   box (MSVC):  cl /nologo /W4 /WX ee-epoch-test.c && ee-epoch-test.exe   (adds the real rand_s path)
 * Prints one "ok"/"not ok" line per check; the exit code is the number of failures. */
#define _CRT_RAND_S
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ee-epoch.h"

static int fails, n;
static void check(int cond, const char *what) { n++; if (!cond) fails++; printf("%s %d - %s\n", cond ? "ok" : "not ok", n, what); }

/* ---- fake RNGs --------------------------------------------------------------------------------- */
static const unsigned int *seq; static int seq_len, seq_pos, fail_at;
static int rng_seq(unsigned int *out) {
    if (seq_pos == fail_at) { seq_pos++; return -1; }
    *out = seq_pos < seq_len ? seq[seq_pos] : 0; seq_pos++; return 0;
}
static void use_seq(const unsigned int *s, int len, int fail) { seq = s; seq_len = len; seq_pos = 0; fail_at = fail; }

static const char E1[] = "0123456789abcdef0123456789abcdef";
static const char E2[] = "fedcba9876543210fedcba9876543210";

static int parse(const char *s, const char *cur, int want_rest, unsigned int *id, const char **rest) {
    return ee_app_ref_parse(s, cur, want_rest, id, rest);
}
static void refuse(const char *args, int want_rest, int expect, const char *what) {
    unsigned int id = 12345; const char *rest = NULL;
    const int r = parse(args, E1, want_rest, &id, &rest);
    char msg[256]; snprintf(msg, sizeof msg, "%s -> %d (want %d)", what, r, expect);
    check(r == expect && id == 12345, msg);
}

int main(void) {
    char e[EE_EPOCH_HEX + 1]; unsigned int id = 0; const char *rest = NULL;

    /* ---- generator ---- */
    {   /* bytes are laid out little-endian per 32-bit draw, encoded lowercase, losslessly */
        static const unsigned int w[4] = { 0x03020100u, 0x07060504u, 0xdeadbeefu, 0x00000001u };
        use_seq(w, 4, -1);
        check(ee_epoch_mint(e, rng_seq) == 0 && strcmp(e, "0001020304050607efbeadde01000000") == 0,
              "mint encodes 128 bits as 32 lowercase hex digits, byte for byte (leading zeros kept)");
        check(seq_pos == 4, "mint draws exactly 4 x 32 bits");
    }
    {   static const unsigned int w[4] = { 0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu };
        use_seq(w, 4, -1);
        check(ee_epoch_mint(e, rng_seq) == 0 && strcmp(e, "ffffffffffffffffffffffffffffffff") == 0,
              "the all-ones epoch encodes exactly (a value no JS Number can hold)");
    }
    for (int f = 0; f < 4; f++) {
        static const unsigned int w[4] = { 1, 2, 3, 4 };
        char msg[96]; use_seq(w, 4, f); strcpy(e, "junk");
        snprintf(msg, sizeof msg, "an RNG failure on draw %d fails closed with an empty epoch", f + 1);
        check(ee_epoch_mint(e, rng_seq) == -1 && e[0] == 0, msg);
    }
    {   static const unsigned int w[4] = { 0, 0, 0, 0 };
        use_seq(w, 4, -1); strcpy(e, "junk");
        check(ee_epoch_mint(e, rng_seq) == -1 && e[0] == 0, "an all-zero draw fails closed (there is no zero epoch)");
    }
    {   static const unsigned int w[4] = { 0, 0, 0, 0x80000000u };
        use_seq(w, 4, -1);
        check(ee_epoch_mint(e, rng_seq) == 0 && strcmp(e, "00000000000000000000000000000080") == 0,
              "a single set bit is a valid epoch");
    }
    check(ee_epoch_mint(e, NULL) == -1 && e[0] == 0, "no RNG at all fails closed");
    {   static const unsigned int w[4] = { 0x11111111u, 0x22222222u, 0x33333333u, 0x44444444u };
        use_seq(w, 4, -1); ee_epoch_mint(e, rng_seq);
        check(parse(strcat(strcpy((char[64]){0}, e), " 1"), e, 0, &id, NULL) == EE_REF_OK && id == 1,
              "a minted epoch round-trips through the parser unchanged");
    }
#ifdef _WIN32
    {   char a[EE_EPOCH_HEX + 1], b[EE_EPOCH_HEX + 1]; int hexok = 1;
        const int ra = ee_epoch_mint(a, ee_epoch_rng_os), rb = ee_epoch_mint(b, ee_epoch_rng_os);
        for (int i = 0; i < EE_EPOCH_HEX; i++) hexok &= (a[i] >= '0' && a[i] <= '9') || (a[i] >= 'a' && a[i] <= 'f');
        check(ra == 0 && rb == 0 && strlen(a) == EE_EPOCH_HEX && a[EE_EPOCH_HEX] == 0 && hexok, "rand_s (the production RNG) mints a 32-hex epoch");
        check(strcmp(a, b) != 0, "two rand_s mints differ");
    }
#endif

    /* ---- parser: accepted ---- */
    id = 0; check(parse("0123456789abcdef0123456789abcdef 1", E1, 0, &id, NULL) == EE_REF_OK && id == 1, "<epoch> <id>");
    id = 0; check(parse("0123456789abcdef0123456789abcdef 4294967295", E1, 0, &id, NULL) == EE_REF_OK && id == 4294967295u, "id at UINT32_MAX");
    id = 0; rest = NULL;
    check(parse("0123456789abcdef0123456789abcdef 7 0c0d", E1, 1, &id, &rest) == EE_REF_OK && id == 7 && rest && !strcmp(rest, "0c0d"), "<epoch> <id> <rest>");

    /* ---- parser: epoch identity ---- */
    refuse("fedcba9876543210fedcba9876543210 1", 0, EE_REF_STALE, "another process's epoch is stale");
    refuse("0123456789abcdef0123456789abcdee 1", 0, EE_REF_STALE, "one differing digit is stale");
    id = 0; check(parse("0123456789abcdef0123456789abcdef 1", "", 0, &id, NULL) == EE_REF_NO_EPOCH, "a process with no epoch refuses a well-formed command");
    check(parse("0123456789abcdef0123456789abcdef 1", NULL, 0, &id, NULL) == EE_REF_NO_EPOCH, "a NULL current epoch refuses too");
    /* The limit, pinned: identity is ALL the parser checks. If a new process drew the old one's epoch,
     * a queued command from the old process would be accepted for the new one's app of that id - the
     * original cross-tenant bug. Only the epoch's size and randomness prevent that. */
    id = 0; check(parse("fedcba9876543210fedcba9876543210 1", E2, 0, &id, NULL) == EE_REF_OK && id == 1,
                  "FORCED SAME EPOCH: an old process's command is accepted by a new one that drew its epoch (why 128 CSPRNG bits)");

    /* ---- parser: malformed (and nothing is reported as an id) ---- */
    refuse("", 0, EE_REF_MALFORMED, "empty");
    refuse("1", 0, EE_REF_MALFORMED, "old grammar: <id>");
    refuse("3 1", 0, EE_REF_MALFORMED, "old grammar: 32-bit <epoch> <id>");
    refuse("4294967295 1 abcd", 1, EE_REF_MALFORMED, "old grammar: 32-bit <epoch> <id> <hex>");
    refuse("0123456789abcdef0123456789abcde 1", 0, EE_REF_MALFORMED, "31 hex digits");
    refuse("0123456789abcdef0123456789abcdef0 1", 0, EE_REF_MALFORMED, "33 hex digits");
    refuse("0123456789ABCDEF0123456789abcdef 1", 0, EE_REF_MALFORMED, "uppercase hex");
    refuse("0123456789abcdeg0123456789abcdef 1", 0, EE_REF_MALFORMED, "a non-hex digit");
    refuse("00000000000000000000000000000000 1", 0, EE_REF_MALFORMED, "the all-zero epoch");
    refuse("0x23456789abcdef0123456789abcdef 1", 0, EE_REF_MALFORMED, "a 0x prefix");
    refuse("0123456789abcdef0123456789abcdef", 0, EE_REF_MALFORMED, "epoch with no id");
    refuse("0123456789abcdef0123456789abcdef ", 0, EE_REF_MALFORMED, "epoch, space, no id");
    refuse("0123456789abcdef0123456789abcdef  1", 0, EE_REF_MALFORMED, "two spaces");
    refuse("0123456789abcdef0123456789abcdef\t1", 0, EE_REF_MALFORMED, "a tab separator");
    refuse("0123456789abcdef0123456789abcdef 0", 0, EE_REF_MALFORMED, "id 0");
    refuse("0123456789abcdef0123456789abcdef 01", 0, EE_REF_MALFORMED, "a leading zero in the id");
    refuse("0123456789abcdef0123456789abcdef +1", 0, EE_REF_MALFORMED, "a signed id (+)");
    refuse("0123456789abcdef0123456789abcdef -1", 0, EE_REF_MALFORMED, "a signed id (-)");
    refuse("0123456789abcdef0123456789abcdef 4294967296", 0, EE_REF_MALFORMED, "id UINT32_MAX + 1");
    refuse("0123456789abcdef0123456789abcdef 99999999999", 0, EE_REF_MALFORMED, "an 11-digit id");
    refuse("0123456789abcdef0123456789abcdef 1x", 0, EE_REF_MALFORMED, "trailing garbage after the id");
    refuse("0123456789abcdef0123456789abcdef 1 ", 0, EE_REF_MALFORMED, "a trailing space where no rest is expected");
    refuse("0123456789abcdef0123456789abcdef 1 0c", 0, EE_REF_MALFORMED, "a rest where none is expected");
    refuse("0123456789abcdef0123456789abcdef 1", 1, EE_REF_MALFORMED, "no rest where one is required");
    refuse("0123456789abcdef0123456789abcdef 1 ", 1, EE_REF_MALFORMED, "an empty rest");
    refuse("0123456789abcdef0123456789abcdef 1  0c", 1, EE_REF_MALFORMED, "two spaces before the rest");
    /* malformed is decided before identity: a malformed line with a stale epoch is malformed */
    refuse("fedcba9876543210fedcba9876543210 01", 0, EE_REF_MALFORMED, "malformed beats stale");
    check(parse(NULL, E1, 0, &id, NULL) == EE_REF_MALFORMED, "NULL input");

    printf("# %d checks, %d failed\n", n, fails);
    return fails;
}
