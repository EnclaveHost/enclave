#ifndef SHIELDED_MINT_BALANCE_H
#define SHIELDED_MINT_BALANCE_H

/* CPU scheduling only. Original group identities and each group's index loop
 * stay unchanged. Largest estimated jobs first, assigned to the lightest lane.
 * Cost is an estimate; this planner alone establishes no throughput gain. */
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#define SH_MINT_BALANCE_GROUPS 1024u
#define SH_MINT_BALANCE_THREADS 64u
enum { SH_MINT_BALANCE_OK = 0, SH_MINT_BALANCE_RANGE = -1, SH_MINT_BALANCE_NOMEM = -2 };
typedef struct {
    uint32_t groups, threads;
    uint32_t order[SH_MINT_BALANCE_GROUPS];
    uint32_t offsets[SH_MINT_BALANCE_THREADS + 1];
    uint64_t loads[SH_MINT_BALANCE_THREADS];
} sh_mint_assignment;
typedef struct { uint64_t cost; uint32_t group; } sh_mint_cost;
static inline int sh_mint_cost_compare(const void *a, const void *b) {
    const sh_mint_cost *x = (const sh_mint_cost *)a, *y = (const sh_mint_cost *)b;
    if (x->cost != y->cost) return x->cost > y->cost ? -1 : 1;
    return x->group < y->group ? -1 : x->group > y->group ? 1 : 0;
}

// On any failure, output is unchanged. Total cost must fit uint64; no wrap can
// make a busy lane appear empty. Input/output aliasing is safe.
static inline int sh_mint_balance(const uint64_t *costs, uint32_t groups, uint32_t threads, sh_mint_assignment *out) {
    if (!costs || !out || !groups || groups > SH_MINT_BALANCE_GROUPS || !threads ||
            threads > SH_MINT_BALANCE_THREADS || threads > groups) return SH_MINT_BALANCE_RANGE;
    uint64_t total = 0;
    for (uint32_t i = 0; i < groups; i++) {
        if (!costs[i] || costs[i] > UINT64_MAX - total) return SH_MINT_BALANCE_RANGE;
        total += costs[i];
    }
    sh_mint_assignment *plan = (sh_mint_assignment *)calloc(1, sizeof *plan);
    sh_mint_cost *sorted = (sh_mint_cost *)malloc(groups * sizeof *sorted);
    uint32_t *owner = (uint32_t *)malloc(groups * sizeof *owner);
    if (!plan || !sorted || !owner) { free(plan); free(sorted); free(owner); return SH_MINT_BALANCE_NOMEM; }
    for (uint32_t i = 0; i < groups; i++) { sorted[i].cost = costs[i]; sorted[i].group = i; }
    qsort(sorted, groups, sizeof *sorted, sh_mint_cost_compare);
    plan->groups = groups; plan->threads = threads;
    for (uint32_t i = 0; i < groups; i++) {
        uint32_t lane = 0;
        for (uint32_t j = 1; j < threads; j++) if (plan->loads[j] < plan->loads[lane]) lane = j;
        owner[i] = lane;
        plan->loads[lane] += sorted[i].cost;
        plan->offsets[lane + 1]++;
    }
    for (uint32_t j = 1; j <= threads; j++) plan->offsets[j] += plan->offsets[j - 1];
    uint32_t cursor[SH_MINT_BALANCE_THREADS];
    memcpy(cursor, plan->offsets, threads * sizeof *cursor);
    for (uint32_t i = 0; i < groups; i++) plan->order[cursor[owner[i]]++] = sorted[i].group;
    memcpy(out, plan, sizeof *out);
    free(plan); free(sorted); free(owner); return SH_MINT_BALANCE_OK;
}
#endif
