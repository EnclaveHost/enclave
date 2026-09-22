/* Targeted tests for the deferred-work readiness predicate.
 *
 * The real 27B graph never presents a positive case -- the backend's loop is
 * greedy in graph order, so anything ready has already been computed -- which
 * means every full run exercises the rejection path only. These cases are
 * built by hand so the POSITIVE path is exercised at least once, and so the
 * rejections are shown to fire for their own reasons rather than for whichever
 * test happened to run first.
 */
#include "shielded-overlap.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <map>
#include <set>
#include <vector>

struct World {
    std::map<const ggml_tensor *, int> idx;
    std::set<int> produced;
    std::set<const ggml_tensor *> in_flight;
};
static int w_index(const ggml_tensor *t, void *c) {
    World *w = (World *)c; auto f = w->idx.find(t); return f == w->idx.end() ? -1 : f->second;
}
static bool w_produced(int i, void *c) { return ((World *)c)->produced.count(i) != 0; }
static bool w_inflight(const ggml_tensor *t, void *c) { return ((World *)c)->in_flight.count(t) != 0; }

static ggml_tensor mk() { ggml_tensor t; memset(&t, 0, sizeof t); return t; }

int main() {
    int failures = 0;
    auto check = [&](const char *name, bool cond) {
        printf("  [%s] %s\n", cond ? "ok" : "FAIL", name);
        if (!cond) failures++;
    };

    ggml_tensor weight = mk();            /* not a node of this subgraph */
    ggml_tensor doneMM = mk();            /* a matmul already produced */
    ggml_tensor liveMM = mk();            /* the matmul in flight right now */
    ggml_tensor sibling = mk();           /* grouped with liveMM in the same exchange */
    ggml_tensor pending = mk();           /* a node of this subgraph, not yet produced */
    ggml_tensor self = mk();
    ggml_tensor viewOfLive = mk(); viewOfLive.view_src = &liveMM;
    ggml_tensor viewOfDone = mk(); viewOfDone.view_src = &doneMM;
    ggml_tensor reshapeChain = mk(); reshapeChain.view_src = &viewOfLive;   /* two hops to the live tensor */

    World w;
    w.idx[&doneMM] = 0; w.idx[&liveMM] = 1; w.idx[&sibling] = 2;
    w.idx[&pending] = 3; w.idx[&self] = 4;
    w.idx[&viewOfLive] = 5; w.idx[&viewOfDone] = 6; w.idx[&reshapeChain] = 7;
    w.produced.insert(0);                                   /* only doneMM is produced */
    w.in_flight.insert(&liveMM); w.in_flight.insert(&sibling);
    sh_ready_ops ops = { w_index, w_produced, w_inflight, &w };

    /* 1. POSITIVE: every read is complete and disjoint from the live exchange. */
    {
        const ggml_tensor *reads[] = { &doneMM, &weight, &self };
        sh_ready_result r = sh_island_ready(reads, 3, &self, &ops);
        check("positive: produced sources beside an unrelated exchange are ready", r.ready);
        check("positive: reports no in-flight dependency", !r.depends_on_in_flight);
        check("positive: reports no unproduced dependency", !r.depends_on_unproduced);
    }
    /* 2. The matmul of the CURRENT exchange. Both facts must be reported, not
     *    just whichever is tested first -- the bug this file exists for. */
    {
        const ggml_tensor *reads[] = { &liveMM };
        sh_ready_result r = sh_island_ready(reads, 1, &self, &ops);
        check("current exchange: rejected", !r.ready);
        check("current exchange: reported as in-flight", r.depends_on_in_flight);
        check("current exchange: ALSO reported as unproduced (independent facts)", r.depends_on_unproduced);
    }
    /* 3. A grouped sibling of the current exchange. */
    {
        const ggml_tensor *reads[] = { &sibling };
        sh_ready_result r = sh_island_ready(reads, 1, &self, &ops);
        check("grouped sibling: rejected as in-flight", !r.ready && r.depends_on_in_flight);
    }
    /* 4. A reshape alias of the in-flight matmul, one hop and two. */
    {
        const ggml_tensor *one[] = { &viewOfLive };
        const ggml_tensor *two[] = { &reshapeChain };
        check("reshape alias of in-flight: rejected", !sh_island_ready(one, 1, &self, &ops).ready);
        check("reshape alias, one hop: reported in-flight",
              sh_island_ready(one, 1, &self, &ops).depends_on_in_flight);
        check("reshape alias, two hops: still reported in-flight",
              sh_island_ready(two, 1, &self, &ops).depends_on_in_flight);
    }
    /* 5. A node of this subgraph that simply has not run yet. */
    {
        const ggml_tensor *reads[] = { &pending };
        sh_ready_result r = sh_island_ready(reads, 1, &self, &ops);
        check("not yet produced: rejected as unproduced, not as in-flight",
              !r.ready && r.depends_on_unproduced && !r.depends_on_in_flight);
    }
    /* 6. A tensor this subgraph does not own (weight, input, other backend):
     *    index_of returns -1 and it must not be treated as unproduced. */
    {
        const ggml_tensor *reads[] = { &weight };
        check("foreign tensor: ready (not a node here, so not pending here)",
              sh_island_ready(reads, 1, &self, &ops).ready);
    }
    /* 7. A rejected reply leaves the product unproduced: the same read that was
     *    ready after success must be rejected after a failure. */
    {
        const ggml_tensor *reads[] = { &viewOfDone };
        check("after success: a view of a produced matmul is ready",
              sh_island_ready(reads, 1, &self, &ops).ready);
        w.produced.erase(0);                                /* the reply was refused */
        sh_ready_result r = sh_island_ready(reads, 1, &self, &ops);
        check("after a rejected reply: the same view is no longer ready", !r.ready);
        check("after a rejected reply: reported as unproduced", r.depends_on_unproduced);
        w.produced.insert(0);
    }
    /* 8. Self-reference must not block. */
    {
        const ggml_tensor *reads[] = { &self, &doneMM };
        check("self among its own reads does not block it", sh_island_ready(reads, 2, &self, &ops).ready);
    }
    printf(failures ? "overlap-ready: %d FAILURES\n" : "overlap-ready: ok\n", failures);
    return failures != 0;
}
