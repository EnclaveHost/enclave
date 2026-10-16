// windows/node/host.mjs proveAll: a Windows host proves its ISOLATED partitions, not only the retired engine's apps. Until
// 2026-10-16 it proved nothing on nucbox-k11-4 (every provenUntil sat at its claim time), so past the ledger's
// proofRequiredFrom its paid partition leases earned nothing and a fee-contract source (the capacity-audit canary) never
// accrued. All due checkpoints go in one batch; a partition not seen serving lately, or a free lease, is not proven.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_OPERATOR_KEY = "0x" + "7f".repeat(32);
process.env.NODE_PROOF_KEY = "0x" + "6e".repeat(32);
const chain = await import("../windows/node/chain.mjs");
chain.loadOperator(); chain.loadProofKey();
const { Host } = await import("../windows/node/host.mjs");
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const ENDPOINT = "https://api.enclave.host/t/test";
const id = (n) => "0x" + String(n).repeat(64).slice(0, 64);

function host(batches, results) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-prove-")); dirs.push(dir);
  const logs = [];
  const h = new Host({ dir, endpoint: ENDPOINT, name: "test", appsEnabled: true, cpuPricePerSec6: 12, engineRetired: true, log: (s) => logs.push(String(s)),
    checkpointBatch: async (items) => { batches.push(items); return results ? results(items) : [{ ids: items.map((i) => i.id), hash: "0xh" }]; } });
  h.chainReady = true; h.registered = { endpoint: ENDPOINT, cpuPricePerSec6: 12n };
  return { h, logs };
}
const leaseUntil = Math.floor(Date.now() / 1000) + 3600;
const serving = (extra = {}) => ({ status: "running", leaseUntil, rate6: "4", servingSeenAt: Date.now(), isolation: { instance: "hv-1", appId: "a".repeat(64) }, ...extra });

test("serving isolated partitions are proven, in ONE batch; stale, free and not-running ones are not", async () => {
  const batches = [];
  const { h } = host(batches);
  h.records.set(id(1), { id: id(1), ...serving() });
  h.records.set(id(2), { id: id(2), ...serving({ isolation: { instance: "hv-2", appId: "b".repeat(64) } }) });
  h.records.set(id(3), { id: id(3), ...serving({ servingSeenAt: Date.now() - 5 * 60_000 }) });   // not seen serving lately
  h.records.set(id(4), { id: id(4), ...serving({ rate6: "0" }) });                               // free lease: nothing to credit
  h.records.set(id(5), { id: id(5), ...serving({ status: "provisioning" }) });
  h.records.set(id(6), { id: id(6), ...serving({ isolation: null }) });                          // no partition at all
  await h.proveAll();
  assert.equal(batches.length, 1, "one batch");
  assert.deepEqual(batches[0].map((b) => b.id).sort(), [id(1), id(2)]);
  const now = Math.floor(Date.now() / 1000);
  for (const b of batches[0]) { assert.equal(b.enclaveId, h.enclaveId); assert.ok(Math.abs(b.upto - now) <= 2); }
  assert.ok(h.records.get(id(1)).provenAt > 0 && h.records.get(id(2)).provenAt > 0, "recorded as proven");
  assert.equal(h.records.get(id(3)).provenAt, undefined);
});

test("a proof never claims past the lease, and a failed transaction is said and leaves provenAt alone", async () => {
  const batches = [];
  const { h, logs } = host(batches, (items) => [{ ids: items.map((i) => i.id), error: new Error("execution reverted: nothing to prove") }]);
  const ending = Math.floor(Date.now() / 1000) - 30;
  h.records.set(id(7), { id: id(7), ...serving({ leaseUntil: ending }) });
  await h.proveAll();
  assert.equal(batches[0][0].upto, ending, "capped at leaseUntil");
  assert.equal(h.records.get(id(7)).provenAt, undefined);
  assert.ok(logs.some((l) => /checkpoint 0x77777777 failed: execution reverted: nothing to prove/.test(l)), logs.join("\n"));
});

test("nothing due: no batch, no transaction", async () => {
  const batches = [];
  const { h } = host(batches);
  h.records.set(id(8), { id: id(8), ...serving({ servingSeenAt: 0 }) });
  await h.proveAll();
  assert.equal(batches.length, 0);
});
