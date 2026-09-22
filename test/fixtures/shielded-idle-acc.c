/* The per-pipe -> per-link idle fold, across reconnects.
 *
 * The case that broke the first version: a fresh pipe whose first sample is
 * HIGHER than the stale baseline. No value can tell you it came from a
 * different counter, so the baseline has to be reset explicitly.
 */
#include "shielded-idle.h"
#include <stdio.h>
#include <string.h>

static int fails = 0;
static void chk(const char *what, int cond) {
    printf("  [%s] %s\n", cond ? "ok" : "FAIL", what);
    if (!cond) fails++;
}

int main(void) {
    sh_idle_acc a; memset(&a, 0, sizeof a);

    /* Ordinary monotonic samples from one pipe. */
    sh_idle_fold(&a, 100, 1);
    chk("first sample counts in full", a.total_ns == 100 && a.total_n == 1);
    sh_idle_fold(&a, 250, 2);
    chk("higher sample adds only the delta", a.total_ns == 250 && a.total_n == 2);
    sh_idle_fold(&a, 250, 2);
    chk("equal sample adds nothing", a.total_ns == 250 && a.total_n == 2);

    /* Reconnect, fresh pipe, first sample HIGHER than the stale baseline.
     * The old heuristic credited 300-250=50; the whole 300 belongs to it. */
    sh_idle_new_pipe(&a);
    sh_idle_fold(&a, 300, 3);
    chk("reconnect then a HIGHER first sample counts in full", a.total_ns == 550 && a.total_n == 5);

    /* Reconnect, fresh pipe, first sample LOWER than the stale baseline. */
    sh_idle_new_pipe(&a);
    sh_idle_fold(&a, 10, 1);
    chk("reconnect then a LOWER first sample counts in full", a.total_ns == 560 && a.total_n == 6);

    /* Reconnect, fresh pipe, first sample EQUAL to the stale baseline. */
    sh_idle_fold(&a, 10, 1);          /* settle the baseline at 10/1 */
    sh_idle_new_pipe(&a);
    sh_idle_fold(&a, 10, 1);
    chk("reconnect then an EQUAL first sample counts in full", a.total_ns == 570 && a.total_n == 7);

    /* Reconnect with no idle at all on the new pipe: nothing is added, and
     * nothing is lost from the totals. */
    sh_idle_new_pipe(&a);
    sh_idle_fold(&a, 0, 0);
    chk("zero-idle reconnect adds nothing and loses nothing", a.total_ns == 570 && a.total_n == 7);
    sh_idle_fold(&a, 40, 2);
    chk("and the next sample on that pipe counts in full", a.total_ns == 610 && a.total_n == 9);

    /* A decrease without a reset must not underflow: it should be treated as a
     * fresh counter rather than wrapping. */
    sh_idle_fold(&a, 5, 1);
    chk("an unannounced decrease does not underflow", a.total_ns == 615 && a.total_n == 10);

    printf(fails ? "idle-acc: %d FAILURES\n" : "idle-acc: ok\n", fails);
    return fails != 0;
}
