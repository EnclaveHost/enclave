import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('refill cost priority preserves urgency, full batches, and reserved slots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-priority-'));
  const source = fileURLToPath(new URL('../wasm/ggml-shielded/', import.meta.url));
  try {
    writeFileSync(join(dir, 'test.c'), `
#define _GNU_SOURCE
#include "shielded-tee.c"
#include <assert.h>
#include <limits.h>

static void choose_b(sh_link *l, int B, int expected, int want_deficit) {
    sh_group before[3]; memcpy(before, l->groups, sizeof before);
    int deficit = -1;
    sh_group *g = pick_refill_group(l, B, &deficit);
    assert(g == (expected < 0 ? NULL : &l->groups[expected]));
    assert(deficit == want_deficit);
    assert(memcmp(before, l->groups, sizeof before) == 0);
}
static void choose(sh_link *l, int expected, int want_deficit) { choose_b(l, 4, expected, want_deficit); }
int main(void) {
    sh_group groups[3] = {
        {.K=5120, .u_len=34816, .depth=16, .count=8},
        {.K=5120, .u_len=248320, .depth=16, .count=12},
        {.K=5120, .u_len=5120, .depth=16, .count=16},
    };
    /* refill_unit 16 is the production default (SHIELDED_REFILL_UNIT); with
     * the batch B=4 <= the unit this is exactly the original policy. */
    sh_link l = {.groups=groups, .n_groups=3, .refill_unit=16};
    choose(&l, 0, 8);                  /* existing largest-deficit policy */
    l.refill_cost_priority = 1;
    choose(&l, 1, 4);                  /* prepare the expensive full batch earlier */
    groups[0].count=3; choose(&l, 0, 13);  /* urgent small group still wins */
    groups[2].count=1; choose(&l, 2, 15);  /* least ready urgent group wins */
    groups[2].generating=3; choose(&l, 0, 13); /* count already-reserved pads */
    groups[0].count=8; groups[2].count=13;
    groups[1].count=15; choose(&l, 0, 8);  /* never refill one nonurgent head row */
    groups[1].count=12; groups[1].held=1; choose(&l, 0, 8); /* held slot prevents full batch */
    groups[1].held=0; choose(&l, 1, 4);
    groups[0].count=0; groups[0].held=16;
    groups[1].count=0; groups[1].generating=16;
    choose(&l, -1, 0);                 /* nothing may overwrite held/reserved pads */
    groups[1].generating=15; choose(&l, -1, 0); /* no partial nonurgent batch */
    groups[1].generating=2; groups[1].held=13;
    choose(&l, 1, 1);                  /* partial batch is allowed when truly urgent */
    groups[0]=(sh_group){.K=INT64_MAX,.u_len=INT64_MAX,.depth=16,.count=12};
    groups[1]=(sh_group){.K=5120,.u_len=248320,.depth=16,.count=4};
    choose(&l, 0, 4);                  /* priority multiplication cannot wrap */

    /* Batch 64 over 64-deep pools (SHIELDED_REFILL_BATCH=64), unit 16: a group
     * is LOW only below the unit, and a nonurgent group is topped up once a
     * whole unit is missing, never for the one pad each token spends. */
    l.refill_cost_priority = 0;
    groups[0]=(sh_group){.K=5120,.u_len=34816,.depth=64,.count=63};
    groups[1]=(sh_group){.K=5120,.u_len=248320,.depth=64,.count=63};
    groups[2]=(sh_group){.K=5120,.u_len=5120,.depth=64,.count=63};
    choose_b(&l, 64, -1, 0);           /* one pad missing everywhere: no single-pad mint */
    groups[1].count=48; choose_b(&l, 64, 1, 16);   /* a whole unit missing: topped up */
    groups[2].count=40; choose_b(&l, 64, 2, 24);   /* largest deficit among the topped-up */
    groups[0].count=15; choose_b(&l, 64, 0, 49);   /* below the unit: urgent, wins */
    groups[0].count=8; groups[0].generating=8; groups[2].count=15;
    choose_b(&l, 64, 2, 49);           /* reserved pads count toward the unit: 8+8 is not urgent */
    l.refill_unit = 64;                /* unit = B: the original rule, every group short of B is low */
    choose_b(&l, 64, 2, 49);           /* least ready+reserved (15) wins */
    groups[2].count=40; choose_b(&l, 64, 0, 48);
    return 0;
}
`);
    execFileSync('cc', ['-O2', '-ffunction-sections', '-fdata-sections', '-I', source,
      join(dir, 'test.c'), '-Wl,--gc-sections', '-lpthread', '-lm', '-o', join(dir, 'test')],
      { timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(execFileSync(join(dir, 'test'), { timeout: 10_000, encoding: 'utf8' }), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
