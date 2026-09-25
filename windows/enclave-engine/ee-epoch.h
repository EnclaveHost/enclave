/* ee-epoch.h -- the per-boot app epoch: which ee-host PROCESS an app id belongs to.
 *
 * App ids restart from 1 every time ee-host starts, so an id alone does not say which process
 * minted it. A command already queued in the node's funnel when ee-host restarts connects to the
 * NEW process after the node's own checks have run, so the only thing that can refuse it is this
 * process recognising the epoch as not its own. That makes the epoch an IDENTITY BINDING between an
 * app id and one ee-host incarnation. If two incarnations ever drew the same epoch, a queued
 * appclose/appstop from the old one would act on the new one's app of that number, which is the
 * original cross-tenant bug. So the epoch is 128 bits from the OS CSPRNG, and nothing else: if the
 * RNG fails there is no epoch and every app command is refused, never a time/pid fallback.
 *
 * It is NOT a secret and NOT authentication: ee-host logs it and appopen returns it to anyone who
 * can reach the loopback port, and it proves nothing about who is asking.
 *
 * Wire form: exactly EE_EPOCH_HEX lowercase hex digits, never all zero, carried as text end to
 * end (the node keeps it as a string; a 128-bit value does not survive a JS Number).
 *
 * Pure functions, so the same source is compiled into ee-host.exe and into ee-epoch-test.c
 * (gcc/clang on the workstation, MSVC on the box). */
#ifndef EE_EPOCH_H
#define EE_EPOCH_H
#include <stddef.h>
#include <string.h>

#define EE_EPOCH_BYTES 16
#define EE_EPOCH_HEX (2 * EE_EPOCH_BYTES)

typedef char ee_epoch_unsigned_int_is_32_bits[(sizeof(unsigned int) == 4) ? 1 : -1];

/* One 32-bit draw from a CSPRNG: 0 on success, anything else is a failure. */
typedef int (*ee_epoch_rng)(unsigned int *out);

#ifdef _WIN32
#ifndef _CRT_RAND_S
#error "define _CRT_RAND_S before the first #include <stdlib.h> so rand_s is declared"
#endif
/* rand_s is RtlGenRandom, the OS CSPRNG. */
static int ee_epoch_rng_os(unsigned int *out) { return rand_s(out) == 0 ? 0 : -1; }
#endif

/* Mint a fresh epoch into out[EE_EPOCH_HEX + 1]. Returns 0, or -1 with out = "" when a draw fails
 * or all 128 bits came back zero: fail closed. */
static int ee_epoch_mint(char out[EE_EPOCH_HEX + 1], ee_epoch_rng rng) {
    static const char hx[] = "0123456789abcdef";
    unsigned char b[EE_EPOCH_BYTES];
    unsigned int any = 0;
    int i;
    out[0] = 0;
    if (!rng) return -1;
    for (i = 0; i < EE_EPOCH_BYTES; i += 4) {
        unsigned int w = 0;
        if (rng(&w) != 0) return -1;
        b[i] = (unsigned char)w; b[i + 1] = (unsigned char)(w >> 8);
        b[i + 2] = (unsigned char)(w >> 16); b[i + 3] = (unsigned char)(w >> 24);
        any |= w;
    }
    if (!any) return -1;
    for (i = 0; i < EE_EPOCH_BYTES; i++) { out[2 * i] = hx[b[i] >> 4]; out[2 * i + 1] = hx[b[i] & 15]; }
    out[EE_EPOCH_HEX] = 0;
    return 0;
}

enum { EE_REF_OK = 0, EE_REF_MALFORMED = -1, EE_REF_STALE = -2, EE_REF_NO_EPOCH = -3 };

/* Parse the arguments of an id-scoped app command, "<epoch> <id>" (want_rest = 0) or
 * "<epoch> <id> <rest>" (want_rest = 1), strictly, then check the epoch against `current`.
 *   epoch: exactly EE_EPOCH_HEX lowercase hex digits followed by one space, not all zero;
 *   id:    1..10 decimal digits, no sign, no leading zero, 1..4294967295;
 *   rest:  after exactly one space, non-empty.
 * Returns EE_REF_OK with *id (and *rest), EE_REF_MALFORMED for anything else, EE_REF_NO_EPOCH if
 * this process has no epoch (it refuses everything), or EE_REF_STALE if the epoch is not this
 * process's. The epoch is compared only after the whole line has parsed. */
static int ee_app_ref_parse(const char *s, const char *current, int want_rest, unsigned int *id, const char **rest) {
    unsigned long long v = 0;
    int i, nz = 0, nd = 0;
    const char *p;
    if (!s) return EE_REF_MALFORMED;
    for (i = 0; i < EE_EPOCH_HEX; i++) {         /* stops at the terminator: it is not a hex digit */
        const char ch = s[i];
        if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return EE_REF_MALFORMED;
        nz |= ch != '0';
    }
    if (!nz || s[EE_EPOCH_HEX] != ' ') return EE_REF_MALFORMED;
    p = s + EE_EPOCH_HEX + 1;
    if (*p == '0') return EE_REF_MALFORMED;       /* no leading zero, and id 0 is never an app */
    while (*p >= '0' && *p <= '9') {
        if (++nd > 10) return EE_REF_MALFORMED;
        v = v * 10 + (unsigned long long)(*p - '0');
        p++;
    }
    if (nd == 0 || v > 0xFFFFFFFFull) return EE_REF_MALFORMED;
    if (want_rest) {
        if (p[0] != ' ' || p[1] == 0 || p[1] == ' ') return EE_REF_MALFORMED;
        if (rest) *rest = p + 1;
    } else if (*p != 0) return EE_REF_MALFORMED;
    if (!current || !current[0]) return EE_REF_NO_EPOCH;
    if (memcmp(s, current, EE_EPOCH_HEX) != 0) return EE_REF_STALE;
    if (id) *id = (unsigned int)v;
    return EE_REF_OK;
}
#endif
