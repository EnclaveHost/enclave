// shieldedCardGb (metal/guest/shielded.mjs): the card as the fleet should see it,
// from one HELLO reply. This is the formula gsup's 30-second refresh and the
// boot probe both write into the verdict file, and it is pure, so it is tested
// as arithmetic.
//
// Why it exists (2026-08-26/27, metal0): the worker held its whole 6.5 GiB
// budget from the driver at start-up, so with ONE tenant on an otherwise idle
// card every free figure -- cudaMemGetInfo, nvidia-smi, /availability -- read
// 0.43 GB of 6.5. The hold hid itself. Protocol 1.3 moves the hold to the
// tenant's HELLO and reports it, and the free figure becomes what can still be
// SOLD (budget - reserved) capped by what the untrusted host can still GIVE
// (the driver's figure, which is what a game on the same card eats into).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shieldedCardGb } from "../metal/guest/shielded.mjs";

const GB = 1 << 30;
const hello = (o) => ({ vram_total: 8 * GB, vram_budget: 6.5 * GB, ...o });

test("an idle card with no tenants is the whole budget, not the driver's leftover", () => {
  // a 1.3 worker holds nothing at start: driver free ~ the card, reserved 0
  const c = shieldedCardGb(hello({ vram_free: 7.6 * GB, vram_reserved: 0 }));
  assert.equal(c.vram_free_gb, 6.5);
  assert.equal(c.vram_reserved_gb, 0);
  assert.equal(c.vram_budget_gb, 6.5);
  assert.equal(c.vram_total_gb, 8);
});

test("one tenant's reservation comes off the budget, and only that", () => {
  // the metal0 case: an 85% share = 5.53 GB reserved; the driver shows the hold
  const c = shieldedCardGb(hello({ vram_free: 2.07 * GB, vram_reserved: 5.53 * GB }));
  assert.equal(c.vram_reserved_gb, 5.53);
  assert.equal(c.vram_free_gb, 0.97);      // 6.5 - 5.53, and the driver's 2.07 does not cap it lower
});

test("something else on the card caps what is advertised", () => {
  // a game takes 6.3 GB of the 8: the budget is untouched by tenants but the
  // host cannot give it, so the fleet must not be told it can
  const c = shieldedCardGb(hello({ vram_free: 1.2 * GB, vram_reserved: 0 }));
  assert.equal(c.vram_free_gb, 1.2);
});

test("reservations can never advertise below zero, and never above the budget", () => {
  assert.equal(shieldedCardGb(hello({ vram_free: 7 * GB, vram_reserved: 9 * GB })).vram_free_gb, 0);
  assert.equal(shieldedCardGb(hello({ vram_free: 30 * GB, vram_reserved: 0 })).vram_free_gb, 6.5);
});

test("a 1.2 worker (no vram_reserved) gets exactly the old figure: min(driver free, budget)", () => {
  const c = shieldedCardGb(hello({ vram_free: 0.43 * GB }));
  assert.equal(c.vram_free_gb, 0.43);
  assert.equal(c.vram_reserved_gb, 0);
  assert.equal(shieldedCardGb(hello({ vram_free: 7.9 * GB })).vram_free_gb, 6.5);
});

test("no budget (an older worker still): the driver's figure alone, and absent fields stay absent", () => {
  const c = shieldedCardGb({ vram_total: 8 * GB, vram_free: 3 * GB });
  assert.equal(c.vram_free_gb, 3);
  assert.equal(c.vram_budget_gb, null);
  assert.equal(c.vram_reserved_gb, 0);
  const none = shieldedCardGb({});
  assert.equal(none.vram_free_gb, null, "nothing is not zero: gsup must not overwrite a good figure with 0");
  assert.equal(none.vram_total_gb, null);
});
