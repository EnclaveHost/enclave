/* bundlemagic.h -- which wire contract a lane bundle declares, as a function that can be TESTED.
 *
 * Three contracts exist and they are not interchangeable:
 *   ETPUB001  one int16 row per logical row, ONE graph input
 *   ETPUB002  two int8 digit rows stacked, ONE graph input, the VM recombines
 *   ETPUB003  two int8 digit rows as TWO graph inputs, the accelerator recombines
 *
 * A payload handed the wrong one does not fail: it feeds the accelerator a differently-shaped operand
 * and decodes plausible text from the answer. That is the modular-lane lesson, and it is why this is
 * checked at all.
 *
 * It lives in a header because the check used to be an inline memcmp in the open path, and the test that
 * claimed to cover it only regex-scanned the source: an audit disabled the rejection with
 * `if (false && ...)` and every assertion still passed. A test that cannot fail is not a test, so the
 * decision is a function now and tpu/test/bundle-marker-test.py calls it for real.
 */
#ifndef ANCHOR_BUNDLEMAGIC_H
#define ANCHOR_BUNDLEMAGIC_H
#include <string.h>

typedef enum {
    BUNDLE_PLAIN = 0,        /* ETPUB001 */
    BUNDLE_DIGIT_SPLIT = 1,  /* ETPUB002 */
    BUNDLE_REJECT = 2        /* anything this payload does not implement, including ETPUB003 */
} bundle_kind;

/* `first8` must point at 8 readable bytes. */
static inline bundle_kind bundle_classify(const void *first8) {
    if (!memcmp(first8, "ETPUB002", 8)) return BUNDLE_DIGIT_SPLIT;
    if (!memcmp(first8, "ETPUB001", 8)) return BUNDLE_PLAIN;
    return BUNDLE_REJECT;   /* ETPUB003 lands here: nothing implements the two-input contract yet */
}
#endif
