/* Readiness for deferred trusted work, extracted so it can be tested.
 *
 * This predicate decides whether a node may be computed EARLY -- inside the
 * idle window of an exchange that is still in flight. It lived inline in the
 * backend loop, where it could not be exercised: the real graph never presents
 * a positive case, so every run passed without taking the branch and the rule
 * was never validated by anything except reading it.
 *
 * Two facts, computed INDEPENDENTLY and completely. An earlier version tested
 * them in one loop with an early break, so a read that was both in-flight and
 * unproduced (which every in-flight matmul is) only ever reported the first,
 * and "in-flight=0" was an artifact of the ordering rather than a finding.
 */
#ifndef SHIELDED_OVERLAP_H
#define SHIELDED_OVERLAP_H
#include <stdbool.h>
#include <stddef.h>
#include "ggml.h"

typedef struct {
    /* Index of a tensor among the nodes of THIS subgraph, or -1 if it is not
     * one (a weight, a graph input, or a node another backend owns). */
    int (*index_of)(const struct ggml_tensor *t, void *ctx);
    /* Has that node's output been written AND, when offloaded, verified? */
    bool (*is_produced)(int idx, void *ctx);
    /* Is this tensor a member of the exchange currently in flight? */
    bool (*is_in_flight)(const struct ggml_tensor *t, void *ctx);
    void *ctx;
} sh_ready_ops;

typedef struct {
    bool depends_on_in_flight;   /* a read aliases a member of the live exchange */
    bool depends_on_unproduced;  /* a read is a node of this subgraph not yet produced */
    bool ready;                  /* neither of the above */
} sh_ready_result;

/* Walks each read, and each read's view chain: a reshape of an in-flight
 * tensor is the in-flight tensor. `self` is excluded so a node that appears
 * among its own pattern's tensors does not block itself. */
static inline sh_ready_result sh_island_ready(const struct ggml_tensor *const *reads, size_t n_reads,
                                              const struct ggml_tensor *self, const sh_ready_ops *ops) {
    sh_ready_result r = { false, false, false };
    for (size_t i = 0; i < n_reads; i++) {
        const struct ggml_tensor *rt = reads[i];
        if (!rt || rt == self) continue;
        for (const struct ggml_tensor *v = rt; v; v = v->view_src) {
            /* In-flight is asked of every link in the chain: a reshape of a
             * live tensor IS the live tensor. */
            if (ops->is_in_flight && ops->is_in_flight(v, ops->ctx)) r.depends_on_in_flight = true;
            /* Producedness is asked only of the ROOT. A view computes nothing
             * -- the main loop skips it and never marks it produced -- so
             * asking whether the view ran rejects every read that goes through
             * one, forever. Asking the root asks whether the bytes exist,
             * which is the actual question. */
            if (v->view_src) continue;
            const int idx = ops->index_of ? ops->index_of(v, ops->ctx) : -1;
            if (idx >= 0 && ops->is_produced && !ops->is_produced(idx, ops->ctx)) r.depends_on_unproduced = true;
        }
    }
    r.ready = !r.depends_on_in_flight && !r.depends_on_unproduced;
    return r;
}
#endif
