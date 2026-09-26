// The ledger scan's ONE claim per pass is spent only by a row that goes on to a claim transaction (enclave-d1's TEST2,
// live on nucbox-k11 from 04:27:40Z 2026-09-26). An owner's older row with NO isolation envelope passed the scan's
// claimPolicy, took the pass's one claim, and consider() then refused it on the retired-engine rule - every 30 s, so the
// owner's newer hyperv row was never reached. Now the scan and consider() ask ONE predicate (host.claimRefusal), a row
// consider() declines without a claim (refused, queued) leaves the slot for the next row, and a declined row is not
// asked again while nothing it was judged on changed (host.scanHold). Against the real scan and the real predicate over
// a fake Base ledger; consider() is the real one wherever it can run without a chain, and a recorder where a test is
// about the scan alone.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc, DEPLOYMENTS, CATALOG } from "./helpers/fake-base-rpc.mjs";
import { REC } from "./helpers/hv-fake-manager.mjs";

process.env.NODE_OPERATOR_KEY = "0x" + "7f".repeat(32);
const rpc = await fakeBaseRpc();
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
chain.addresses.appCatalog = CATALOG;
chain.loadOperator();
const { Host } = await import("../windows/node/host.mjs");
after(() => rpc.close());

const OPERATOR = chain.operatorAddress().toLowerCase();
const APPREF = `catalog://${REC.catalog.app}/${REC.catalog.version}`;
const ISOLATED = JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } });
rpc.catalog.current = { cid: REC.cid, version: "1.0.0", vramMb: 0, gpuGflops: 0, memMb: REC.policy.memMiB, cpuGflops: 0,
  createdAt: 1n, verified: true, yanked: false, ports: "", approval: 1, config: "{}" };
const id = (b) => "0x" + b.repeat(32);
const row = (rid, over = {}) => ({ id: rid, owner: OPERATOR, appRef: APPREF, ports: "", configCid: ISOLATED, gpuMilli: 0, cpuMilli: 100,
  appPort: 8080, isPublic: true, active: true, createdAt: 1n, rate: 1n, balance6: 10n ** 9n, spent6: 0n,
  runner: "0x" + "00".repeat(32), runnerOperator: "0x" + "00".repeat(20), leaseUntil: 0n, ...over });

// the NucBox: engine retired, the partition backend, owner-only; its operator (the key above) is the owner it serves,
// read as tick() reads it before every scan (refreshOwners)
async function nucbox(cfg = {}) {
  const logs = [];
  const h = new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-scanslot-")), endpoint: "https://api.enclave.host/t/test",
    name: "test", appsEnabled: true, cpuPricePerSec6: 12, vcpus: 8, ramGb: 16, log: (l) => logs.push(l), engineRetired: true,
    isolationManager: "http://127.0.0.1:1", ...cfg });
  h.registered = { cpuPricePerSec6: "12" };
  h.chainReady = true;
  h.logs = logs;
  await h.refreshOwners();
  return h;
}
// consider() as a recorder for the rows in `script` (id -> what it does), the real one for any other row
function scripted(h, script) {
  const asked = [], real = h.consider.bind(h);
  h.consider = async (rid, opts) => {
    asked.push(rid);
    const s = script[rid];
    if (!s) return real(rid, opts);
    if (s === "claim") { h.records.set(rid, { status: "running" }); return { accepted: true, status: "running", claimAttempted: true }; }
    if (s === "queued" || s === "refused") { h.records.set(rid, { status: s, reason: `scripted ${s}` }); return { accepted: false, reason: s }; }
    return { accepted: false, reason: s };   // a transient failure: no standing record
  };
  return asked;
}

test("d1's TEST2: an owner's older row with no isolation envelope is refused AT THE SCAN, and the newer hyperv row is taken in the FIRST pass", async () => {
  const OLD = id("ca"), NEW = id("95");
  rpc.rows.current = [row(OLD, { configCid: "", createdAt: 1n }), row(NEW, { createdAt: 2n })];
  const h = await nucbox();
  assert.equal(h.partitionsOnly(), true);
  const asked = scripted(h, { [NEW]: "claim" });
  await h.scanLedger();
  assert.deepEqual(asked, [NEW], `consider() was handed ${asked.map((x) => x.slice(0, 10))}`);
  const rec = h.records.get(OLD);
  assert.equal(rec?.status, "refused");
  assert.match(rec.reason, /runs only the isolated backend .* claims only deployments that require hyperv-partition-per-app/);
  // ONE predicate: consider() refuses the old row with the very words the scan recorded, and claims nothing
  h.consider = Host.prototype.consider.bind(h);
  const r = await h.consider(OLD);
  assert.equal(r.accepted, false);
  assert.equal(r.reason, rec.reason);
  assert.equal(r.claimAttempted, undefined);
});

test("a row consider() declines without a claim leaves the slot for the next row, and is not asked again until an input changes", async () => {
  const R1 = id("a1"), R2 = id("a2"), R3 = id("a3");
  rpc.rows.current = [row(R1, { createdAt: 1n }), row(R2, { createdAt: 2n }), row(R3, { createdAt: 3n })];
  const h = await nucbox();
  const asked = scripted(h, { [R1]: "queued", [R2]: "refused", [R3]: "claim" });
  await h.scanLedger();
  assert.deepEqual(asked, [R1, R2, R3], "one pass: the queued and the refused row spent no slot, so R3 was claimed");
  await h.scanLedger();
  assert.deepEqual(asked, [R1, R2, R3], "the next pass asked a declined row again with nothing changed");
  // a changed envelope (same requirement, other bytes), balance or owner set: asked again
  rpc.rows.current = [row(R1, { createdAt: 1n, configCid: JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } }, null, 1) }),
    row(R2, { createdAt: 2n, balance6: 10n ** 10n }), row(R3, { createdAt: 3n })];
  await h.scanLedger();
  assert.deepEqual(asked.slice(3), [R1, R2], "a changed envelope and a changed balance were not re-evaluated");
  // and what the key cannot see is asked again after the bound: queued sooner than refused
  h.scanHold.get(R1).at -= Host.SCAN_QUEUED_HOLD_MS + 1;
  h.scanHold.get(R2).at -= Host.SCAN_QUEUED_HOLD_MS + 1;
  await h.scanLedger();
  assert.deepEqual(asked.slice(5), [R1], "the queued row after its bound (and not the refused one before its own)");
  h.scanHold.get(R2).at -= Host.SCAN_HOLD_MS;
  await h.scanLedger();
  assert.deepEqual(asked.slice(6), [R2]);
});

test("a transient failure is not held: the row is asked again the next pass", async () => {
  const T = id("b1"), U = id("b2");
  rpc.rows.current = [row(T, { createdAt: 1n }), row(U, { createdAt: 2n })];
  const h = await nucbox();
  const asked = scripted(h, { [T]: "ledger read failed: fake", [U]: "claim" });
  await h.scanLedger();
  await h.scanLedger();
  assert.deepEqual(asked, [T, U, T]);
});

test("still ONE claim per pass: two rows that both go on to a claim transaction are taken one pass apart", async () => {
  const C1 = id("c1"), C2 = id("c2");
  rpc.rows.current = [row(C1, { createdAt: 1n }), row(C2, { createdAt: 2n })];
  const h = await nucbox();
  const asked = scripted(h, { [C1]: "claim", [C2]: "claim" });
  await h.scanLedger();
  assert.deepEqual(asked, [C1]);
  await h.scanLedger();
  assert.deepEqual(asked, [C1, C2]);
});

test("a claim transaction that FAILS still spends the slot (consider() says claimAttempted)", async () => {
  // the real consider() on a box with no partition backend (nothing to judge before the claim): the fake ledger answers
  // no transaction, so the claim fails - after it was attempted
  const F = id("d1"), G = id("d2");
  rpc.rows.current = [row(F, { createdAt: 1n, configCid: "" }), row(G, { createdAt: 2n, configCid: "" })];
  const h = await nucbox({ engineRetired: false, isolationManager: undefined });
  const asked = scripted(h, { [G]: "claim" });
  const r = await Host.prototype.consider.call(h, F);
  if (!(r.claimAttempted === true && /claim failed/.test(r.reason || ""))) {
    // this box's policy refused F before any claim: then there is nothing to test here, and saying so beats passing
    assert.fail(`the real consider() did not reach a claim on this fixture: ${JSON.stringify(r)}`);
  }
  h.records.delete(F);
  await h.scanLedger();
  assert.deepEqual(asked, [F], "the failed claim did not spend the pass's slot");
});
