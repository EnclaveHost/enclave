#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static int fail_at, alloc_count;
static void *test_malloc(size_t n) { return ++alloc_count == fail_at ? NULL : malloc(n); }
static void *test_calloc(size_t n, size_t size) { return ++alloc_count == fail_at ? NULL : calloc(n, size); }
#define malloc test_malloc
#define calloc test_calloc
#include "../../wasm/ggml-shielded/shielded-mint-balance.h"
#undef malloc
#undef calloc

static uint64_t check(const uint64_t *costs, unsigned n, unsigned lanes, sh_mint_assignment *plan) {
    assert(sh_mint_balance(costs, n, lanes, plan) == SH_MINT_BALANCE_OK);
    assert(plan->groups == n && plan->threads == lanes && plan->offsets[0] == 0 && plan->offsets[lanes] == n);
    unsigned seen[SH_MINT_BALANCE_GROUPS] = {0}; uint64_t max = 0;
    for (unsigned lane = 0; lane < lanes; lane++) {
        assert(plan->offsets[lane] < plan->offsets[lane + 1]);
        uint64_t load = 0, previous = UINT64_MAX;
        for (unsigned i = plan->offsets[lane]; i < plan->offsets[lane + 1]; i++) {
            const unsigned g = plan->order[i]; assert(g < n && !seen[g]++);
            assert(costs[g] <= previous); previous = costs[g]; load += costs[g];
        }
        assert(load == plan->loads[lane]); if (load > max) max = load;
    }
    for (unsigned g = 0; g < n; g++) assert(seen[g] == 1);
    return max;
}
static uint32_t rng = 12345;
static uint32_t random32(void) { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }
int main(void) {
    uint64_t costs[SH_MINT_BALANCE_GROUPS]; sh_mint_assignment plan, other, sentinel;
    for (unsigned i = 0; i < SH_MINT_BALANCE_GROUPS; i++) costs[i] = 1;
    assert(check(costs, 1024, 64, &plan) == 16);
    assert(check(costs, 1, 1, &plan) == 1);
    costs[32] = 64;
    const uint64_t balanced = check(costs, 33, 4, &plan);
    uint64_t stripe[4] = {0}; for (unsigned i = 0; i < 33; i++) stripe[i % 4] += costs[i];
    assert(balanced == 64 && stripe[0] == 72);
    for (unsigned repeat = 0; repeat < 2000; repeat++) {
        const unsigned n = 1 + random32() % 1024, lanes = 1 + random32() % (n < 64 ? n : 64);
        for (unsigned i = 0; i < n; i++) costs[i] = 1 + random32() % 1000000;
        check(costs, n, lanes, &plan); check(costs, n, lanes, &other);
        assert(!memcmp(&plan, &other, sizeof plan));
        for (unsigned i = 0; i < n; i++) costs[i] *= 7;
        check(costs, n, lanes, &other);
        assert(!memcmp(plan.order, other.order, sizeof plan.order));
        assert(!memcmp(plan.offsets, other.offsets, sizeof plan.offsets));
        for (unsigned i = 0; i < lanes; i++) assert(other.loads[i] == plan.loads[i] * 7);
    }
    memset(&sentinel, 0xa5, sizeof sentinel); plan = sentinel;
    costs[0] = UINT64_MAX; costs[1] = 1;
    assert(sh_mint_balance(costs, 2, 2, &plan) == SH_MINT_BALANCE_RANGE && !memcmp(&plan, &sentinel, sizeof plan));
    assert(check(costs, 1, 1, &other) == UINT64_MAX);
    costs[0] = 0;
    assert(sh_mint_balance(costs, 1, 1, &plan) == SH_MINT_BALANCE_RANGE && !memcmp(&plan, &sentinel, sizeof plan));
    costs[0] = 1;
    assert(sh_mint_balance(NULL, 1, 1, &plan) == SH_MINT_BALANCE_RANGE);
    assert(sh_mint_balance(costs, 0, 1, &plan) == SH_MINT_BALANCE_RANGE);
    assert(sh_mint_balance(costs, 1025, 1, &plan) == SH_MINT_BALANCE_RANGE);
    assert(sh_mint_balance(costs, 2, 0, &plan) == SH_MINT_BALANCE_RANGE);
    assert(sh_mint_balance(costs, 2, 3, &plan) == SH_MINT_BALANCE_RANGE);
    assert(sh_mint_balance(costs, 65, 65, &plan) == SH_MINT_BALANCE_RANGE);
    assert(sh_mint_balance(costs, 1, 1, NULL) == SH_MINT_BALANCE_RANGE);
    assert(!memcmp(&plan, &sentinel, sizeof plan));
    for (fail_at = 1; fail_at <= 3; fail_at++) {
        alloc_count = 0;
        assert(sh_mint_balance(costs, 2, 2, &plan) == SH_MINT_BALANCE_NOMEM);
        assert(!memcmp(&plan, &sentinel, sizeof plan));
    }
    fail_at = 0;
    // Exact aliasing: input is copied before the complete plan is committed.
    other = sentinel; other.loads[0] = 1; other.loads[1] = 2;
    assert(sh_mint_balance(other.loads, 2, 2, &other) == SH_MINT_BALANCE_OK);
    assert(other.order[0] == 1 && other.order[1] == 0);
    assert(other.offsets[0] == 0 && other.offsets[1] == 1 && other.offsets[2] == 2);
    assert(other.loads[0] == 2 && other.loads[1] == 1);
}
