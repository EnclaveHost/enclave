// Pool reconciliation (supervisor.js) — the records are the truth, the pools
// are a cache: reconcilePools() rebuilds gpuCards/cpuPool free values from
// what non-terminal records actually hold, reclaiming reservations leaked by
// a missed release. Driven through the POOL_SELFTEST seam, same contract as
// SWEEP_SELFTEST/REACH_SELFTEST.
//
// Why this exists (2026-07-18, kryptos): ~27 GB of the card sat reserved by
// dead work — two orphaned 9% slices on top of the two live tenants — and
// nothing ever put them back: /availability, the claim gauntlet and the
// deploy page all read the leaked number, silently shrinking sellable
// capacity until a restart happened to rebuild clean.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function reconcile(c) {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", POOL_SELFTEST: JSON.stringify(c),
           SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "",
           REGISTRY_ENABLED: "", CLAIM_ENABLED: "", ACME_EAB_KID: "", ACME_EAB_HMAC: "",
           APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

// a 9% H200 slice as normalizeGpuReq books it: ceil(0.09*140.4)=13 GB + 0.5 overhead
const hold9 = (cardId = 0) => ({ cardId, vramGb: 13, computeShare: 0.09, cpuShare: 0.03, _needV: 13.5 });

test("the kryptos leak: two dead slices reclaimed, live tenants kept, idempotent", async () => {
  // pools as observed live 2026-07-18: four 9% slices reserved, two records exist
  const r = await reconcile({
    cardVramGb: 140.4,
    cards: [{ vramFree: 86.4, computeFree: 0.64 }],
    cpuShareFree: 0.88,
    records: [
      { id: "live-a", status: "running", _gpu: hold9() },
      { id: "live-b", status: "running", _gpu: hold9() },
    ],
  });
  assert.ok(r.fixed.length > 0, "drift must be detected");
  assert.equal(r.cards[0].vramFree, 113.4);          // 140.4 - 2×13.5
  assert.equal(r.cards[0].computeFree, 0.82);        // 1 - 2×0.09
  assert.equal(r.cpuShareFree, 0.94);                // 1 - 2×0.03
  assert.deepEqual(r.fixedAgain, [], "second pass must be a no-op");
});

test("terminal records never hold: handle dropped, slice not counted", async () => {
  const r = await reconcile({
    cardVramGb: 140.4,
    cards: [{ vramFree: 113.4, computeFree: 0.82 }],
    cpuShareFree: 0.94,
    records: [
      { id: "live", status: "running", _gpu: hold9() },
      { id: "dead", status: "terminated", _gpu: hold9() },   // crash drift: terminal with a handle
    ],
  });
  assert.ok(r.dropped.includes("dead"), "terminal record's handle must be nulled");
  assert.equal(r.cards[0].vramFree, 126.9);          // only the live slice held: 140.4 - 13.5
  assert.equal(r.cards[0].computeFree, 0.91);
  assert.equal(r.cpuShareFree, 0.97);
});

test("clean pools: nothing to fix on either pass", async () => {
  const r = await reconcile({
    cardVramGb: 140.4,
    cards: [{ vramFree: 126.9, computeFree: 0.91 }],
    cpuShareFree: 0.97,
    records: [{ id: "live", status: "running", _gpu: hold9() }],
  });
  assert.deepEqual(r.fixed, []);
  assert.deepEqual(r.fixedAgain, []);
});

test("over-free drift (double release) is corrected DOWN, not just up", async () => {
  const r = await reconcile({
    cardVramGb: 140.4,
    cards: [{ vramFree: 140.4, computeFree: 1 }],     // pools claim empty…
    cpuShareFree: 1,
    records: [{ id: "live", status: "running", _gpu: hold9() }],   // …but a tenant holds a slice
  });
  assert.equal(r.cards[0].vramFree, 126.9);
  assert.equal(r.cards[0].computeFree, 0.91);
  assert.equal(r.cpuShareFree, 0.97);
});

test("cpu-only holds ({cpu,share}) reconcile the node pool", async () => {
  const r = await reconcile({
    cardVramGb: 140.4,
    cards: [],
    cpuShareFree: 0.2,                                // leaked: only 0.25 is really held
    records: [{ id: "cpu-app", status: "running", _gpu: { cpu: true, share: 0.25 } }],
  });
  assert.equal(r.cpuShareFree, 0.75);
});

test("over-reserved card clamps at 0 free instead of going negative", async () => {
  const r = await reconcile({
    cardVramGb: 20,
    cards: [{ vramFree: 20, computeFree: 1 }],
    cpuShareFree: 1,
    records: [
      { id: "a", status: "running", _gpu: { cardId: 0, vramGb: 12, computeShare: 0.6, cpuShare: 0, _needV: 12.5 } },
      { id: "b", status: "running", _gpu: { cardId: 0, vramGb: 12, computeShare: 0.6, cpuShare: 0, _needV: 12.5 } },
    ],
  });
  assert.equal(r.cards[0].vramFree, 0);
  assert.equal(r.cards[0].computeFree, 0);
});

test("legacy handle without _needV falls back to vramGb + overhead", async () => {
  const r = await reconcile({
    cardVramGb: 140.4,
    cards: [{ vramFree: 140.4, computeFree: 1 }],
    cpuShareFree: 1,
    records: [{ id: "old", status: "running", _gpu: { cardId: 0, vramGb: 13, computeShare: 0.09, cpuShare: 0.03 } }],
  });
  assert.equal(r.cards[0].vramFree, 126.9);           // 140.4 - (13 + default 0.5 CTX_OVERHEAD_GB)
});

// The shielded card's overhead accounting. CTX_OVERHEAD_GB is a per-WORKER CUDA
// context cost, and a shielded tenant opens no context at all -- it runs in the
// CVM with CUDA_VISIBLE_DEVICES="" while one worker process on the untrusted
// host serves the whole box. Charging it per tenant booked it twice and made an
// 85% lease advertise a completely full card.
test("a shielded card does not charge per-tenant CUDA context overhead", async () => {
  // metal0 as observed 2026-08-26: 6.5 GB budget, one 85% lease. normalizeGpuReq
  // books ceil(0.85*6.5)=6 GB; the old code added 0.5 GB on top (the whole
  // budget) and then charged the next tenant another 0.5 to look at it.
  const lease = { cardId: 0, vramGb: 6, computeShare: 0.85, cpuShare: 0.2, _needV: 6 };
  const shielded = await reconcile({
    cardVramGb: 6.5, shielded: true,
    cards: [{ vramFree: 0.5, computeFree: 0.15 }],
    cpuShareFree: 0.8,
    records: [{ id: "eyesoff", status: "running", _gpu: lease }],
  });
  assert.equal(shielded.cards[0].vramFree, 0.5);
  assert.equal(shielded.cards[0].computeFree, 0.15);
  assert.ok(shielded.maxFreeGpuShare > 0,
    "the unsold remainder of a shielded card must be sellable, not swallowed by a context reserve");
  assert.ok(Math.abs(shielded.maxFreeGpuShare - 0.077) < 0.002,
    `expected ~7.7% (0.5 GB of a 6.5 GB budget), got ${shielded.maxFreeGpuShare}`);

  // A passed-through card is unchanged: there the per-worker context is real,
  // and the same 0.5 GB leftover genuinely cannot host another worker.
  const passthrough = await reconcile({
    cardVramGb: 6.5,
    cards: [{ vramFree: 0.5, computeFree: 0.15 }],
    cpuShareFree: 0.8,
    records: [{ id: "eyesoff", status: "running", _gpu: { ...lease, _needV: 6.5 } }],
  });
  assert.equal(passthrough.maxFreeGpuShare, 0,
    "a real card must still reserve a context for the next worker");
});
