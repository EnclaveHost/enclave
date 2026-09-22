/* verify-rms-test.c -- the backend-deviation RMS, with a KNOWN NONZERO error.
 *
 * The bug this pins: `ver_n` counts TWO digit comparisons per sampled output (it is incremented by 2),
 * while the combined-output error is accumulated ONCE per sample. Reporting sqrt(ver_lsb_sq / ver_n)
 * therefore understated the RMS by exactly sqrt(2). It lived in a printf argument, so nothing could
 * reach it, and every run that produced it had all-zero errors -- and zero divided by anything is still
 * zero, so the measurements that existed could never have caught it.
 *
 * Hence: drive the shipped reporter with errors that are not zero.
 *
 *   cc -std=c11 -O1 -I payload tpu/test/verify-rms-test.c -lm -o /tmp/verify-rms-test && /tmp/verify-rms-test
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "ggml-tpu.h"

static int bad = 0;
static void ck(const char *what, double got, double want) {
    const int ok = fabs(got - want) < 1e-9;
    printf("%-52s got %.6f want %.6f  %s\n", what, got, want, ok ? "ok" : "FAIL");
    if (!ok) bad++;
}

int main(void) {
    /* Three sampled outputs whose combined-output errors are 2.5, 0.0 and 1.5 output LSB.
     * Each sample compared TWO digits, so a counter that tracks digits reads 6 where the paired
     * count is 3. rms over the PAIRED samples is sqrt((6.25 + 0 + 2.25)/3) = 1.683251. */
    const double e[3] = { 2.5, 0.0, 1.5 };
    double sq = 0.0;
    uint64_t paired = 0, digits = 0;
    for (int i = 0; i < 3; i++) { sq += e[i] * e[i]; paired++; digits += 2; }

    const double want = sqrt((6.25 + 0.0 + 2.25) / 3.0);
    ck("rms over paired samples (the correct divisor)", tpu_ver_lsb_rms(paired, sq), want);

    /* the old expression, kept here so the regression is visible rather than described */
    const double old = digits ? sqrt(sq / (double)digits) : 0.0;
    printf("%-52s got %.6f  (= want / sqrt(2) = %.6f)\n", "the divisor bug, for comparison", old, want / sqrt(2.0));
    if (fabs(old - want) < 1e-9) { printf("FAIL: the bug and the fix agree, so this test proves nothing\n"); bad++; }

    /* all-zero errors: the case every real run produced so far, where the bug is INVISIBLE */
    ck("all-zero errors report zero either way", tpu_ver_lsb_rms(3, 0.0), 0.0);
    if (fabs((6 ? sqrt(0.0 / 6.0) : 0.0) - 0.0) > 1e-9) bad++;
    printf("%-52s %s\n", "  (which is why zero-only runs could not catch it)", "noted");

    ck("no samples reports zero rather than dividing by zero", tpu_ver_lsb_rms(0, 0.0), 0.0);

    printf("\n%d failure(s)\n", bad);
    return bad ? 1 : 0;
}
