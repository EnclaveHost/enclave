/* Folding a per-PIPE idle counter into a per-LINK total across reconnects.
 *
 * The pipe is closed and replaced on reconnect and its counters restart from
 * zero, so a link total cannot simply read the pipe. The first version folded
 * deltas with a "lower than last time means a new pipe" heuristic, which is
 * wrong whenever the fresh pipe's first sample is HIGHER than the stale
 * baseline: old 100ns/1, new pipe first sample 150ns/1, and the heuristic
 * credits 50ns/0 instead of 150ns/1. A value cannot tell you it came from a
 * different counter.
 *
 * So the baseline is reset EXPLICITLY when the pipe is replaced, and the fold
 * is a plain delta. The heuristic is kept only as a backstop for a decrease
 * that should now be impossible.
 */
#ifndef SHIELDED_IDLE_H
#define SHIELDED_IDLE_H
#include <stdint.h>

typedef struct {
    uint64_t total_ns, total_n;    /* the link's running totals, never reset */
    uint64_t last_ns, last_n;      /* last sample seen from the CURRENT pipe */
} sh_idle_acc;

/* Call when the pipe is closed or replaced: the next sample is from a counter
 * that starts at zero, so the baseline must too. Totals are retained. */
static inline void sh_idle_new_pipe(sh_idle_acc *a) { a->last_ns = 0; a->last_n = 0; }

static inline void sh_idle_fold(sh_idle_acc *a, uint64_t sampled_ns, uint64_t sampled_n) {
    a->total_ns += (sampled_ns >= a->last_ns) ? sampled_ns - a->last_ns : sampled_ns;
    a->total_n  += (sampled_n  >= a->last_n)  ? sampled_n  - a->last_n  : sampled_n;
    a->last_ns = sampled_ns; a->last_n = sampled_n;
}
#endif
