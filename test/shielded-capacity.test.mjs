// shieldedCapacity() (supervisor.js) reads the guest's verdict file and turns
// it into the `shielded` block every consumer sees (/availability, the relay,
// the site) and into the gpu pool's free figure. Driven through the
// SHIELDED_SELFTEST seam, same contract as POOL_SELFTEST.
//
// The property under test: vram_reserved_gb reaches the block as
// vramReservedGb, vram_free_gb (already net of reservations, see
// test/shielded-card-gb.test.mjs) is what the gpu pool advertises, and a
// verdict that fails any of its own claims yields no card at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function capacity(verdict) {
  const dir = mkdtempSync(path.join(tmpdir(), "shielded-verdict-"));
  const file = path.join(dir, "shielded-gpu.json");
  writeFileSync(file, JSON.stringify(verdict));
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", SHIELDED_SELFTEST: "1", SHIELDED_VERDICT: file,
           POOL_SELFTEST: "", SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "",
           REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "",
           APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const good = {
  name: "NVIDIA GeForce RTX 3070", vram_total_gb: 7.65, vram_budget_gb: 6.5,
  vram_free_gb: 0.97, vram_reserved_gb: 5.53, field_gmac_per_s: 800, card_tflops: 20.3, sm_count: 46,
  exact: true, verified: true, lie_rejected: true, denylist_refused: true,
  endpoint: "10.0.2.2:9500", at: "2026-08-27T00:00:00Z",
};

test("the block carries the reservation and the pool advertises the net free figure", async () => {
  const r = await capacity(good);
  assert.ok(r.shielded, "a verdict that passes every claim is a card");
  assert.equal(r.shielded.vramReservedGb, 5.53);
  assert.equal(r.shielded.vramFreeGb, 0.97);
  assert.equal(r.shielded.vramBudgetGb, 6.5);
  assert.equal(r.cardVramGb, 6.5, "the fleet sees a card the size of the budget");
  // 0.97 / 6.5 = 0.149 of the card is still sellable; the ledger (nothing placed
  // in this process) does not bind
  assert.equal(r.gpuShareFree, 0.149);
  assert.equal(r.vramFreeGb, 1);   // round1(0.149 * 6.5)
});

test("an older verdict without vram_reserved_gb reads as 0 reserved, not NaN", async () => {
  const { vram_reserved_gb, ...old } = good;
  const r = await capacity({ ...old, vram_free_gb: 0.43 });
  assert.equal(r.shielded.vramReservedGb, 0);
  assert.equal(r.shielded.vramFreeGb, 0.43);
  assert.equal(r.gpuShareFree, 0.066);
});

test("a fully reserved card advertises no free share", async () => {
  const r = await capacity({ ...good, vram_free_gb: 0, vram_reserved_gb: 6.5 });
  assert.equal(r.gpuShareFree, 0);
  assert.equal(r.shielded.vramReservedGb, 6.5);
});

test("compute_share: the dedicated slice IS the card — 100% available when empty", async () => {
  const r = await capacity({ ...good, vram_free_gb: 6.5, vram_reserved_gb: 0, compute_share: 0.5 });
  assert.equal(r.shielded.computeShare, 0.5);
  // an empty half-card box reads 10.2/10.2, never 10.2/20.3: the advertised
  // card is the slice, and a tenant's gpuShare is a fraction of it
  assert.equal(r.cardTflops, 10.2);      // round1(20.3 * 0.5)
  assert.equal(r.smTotal, 23);           // round(46 * 0.5)
  assert.equal(r.gpuShareFree, 1);
  assert.equal(r.vramFreeGb, 6.5);       // VRAM is NOT pro-rated: vramGb is its own budget
  // the PHYSICAL card stays visible, unscaled, in the shielded block
  assert.equal(r.shielded.cardTflops, 20.3);
  assert.equal(r.shielded.smCount, 46);
});

test("no compute_share = the whole card, exactly as before", async () => {
  const r = await capacity({ ...good, vram_free_gb: 6.5, vram_reserved_gb: 0 });
  assert.equal(r.shielded.computeShare, 1);
  assert.equal(r.cardTflops, 20.3);
  assert.equal(r.smTotal, 46);
  assert.equal(r.gpuShareFree, 1);
});

test("a verdict that fails one of its claims is no card, whatever it says about memory", async () => {
  const r = await capacity({ ...good, lie_rejected: false });
  assert.equal(r.shielded, null);
  assert.equal(r.cardVramGb, 0);
  assert.equal(r.gpuShareFree, 0);
});
