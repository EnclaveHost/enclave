// A node started WITHOUT the retired VBS enclave engine (cfg.engineRetired; Steven, 2026-09-25) runs only isolated
// deployments. Anything else it already holds is HELD: refused and recorded, never started, never renewed and
// NEVER released on chain automatically (enclave-d1 F2). It never claims one either. Each test here fails if its
// guard is removed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";
import { servedOwner } from "./helpers/owners.mjs";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Base is faked before host.mjs loads, so a give-up's release read never reaches a public RPC
const rpc = await fakeBaseRpc();
(await import("../windows/node/chain.mjs")).addresses.deployments = DEPLOYMENTS;
const { Host } = await import("../windows/node/host.mjs");
after(() => rpc.close());

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-retired-"));
const box = (cfg = {}) => servedOwner(new Host({ dir, endpoint: "https://api.enclave.host/t/test", name: "test", appsEnabled: true,
                                     cpuPricePerSec6: 12, log: () => {}, ...cfg }), "0x29479bf04ed889d46a7afb7f292b9bb26e12647c");
const ISOLATED = JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } });
const dep = (configCid = "") => ({ appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
                                    leaseUntil: Math.floor(Date.now() / 1000) + 3600, cpuMilli: 100, gpuMilli: 0,
                                    isPublic: true, owner: "0x29479bf04ed889d46a7afb7f292b9bb26e12647c", configCid });
const MANAGER = { isolationManager: "http://127.0.0.1:1" };

test("the legacy behaviour is unchanged unless the engine is retired", () => {
  const h = box(MANAGER);
  assert.equal(h.heldReason(dep()), null);
  assert.equal(h.retiredEngineClaimRefusal(dep()), null);
});

test("retired engine: a deployment that does not require this box's isolation backend is held, and not claimed", () => {
  const h = box({ ...MANAGER, engineRetired: true });
  assert.match(h.heldReason(dep()), /held - not started, not renewed, not released/);
  assert.match(h.retiredEngineClaimRefusal(dep()), /claims only deployments that require hyperv-partition-per-app/);
});

test("retired engine: a deployment requiring this box's backend by name runs (is neither held nor refused)", () => {
  const h = box({ ...MANAGER, engineRetired: true });
  assert.equal(h.heldReason(dep(ISOLATED)), null);
  assert.equal(h.retiredEngineClaimRefusal(dep(ISOLATED)), null);
});

test("retired engine: another backend's name, an unreadable envelope, or no isolation manager is held", () => {
  const h = box({ ...MANAGER, engineRetired: true });
  assert.ok(h.heldReason(dep(JSON.stringify({ isolation: { require: "snp-vm" } }))));
  assert.ok(h.heldReason(dep("{not json")));
  const noManager = box({ engineRetired: true });
  assert.ok(noManager.heldReason(dep(ISOLATED)), "a node with no isolation manager can run nothing");
});

test("ensureApp on a retired-engine node HOLDS a legacy deployment BEFORE any gate that could release it", async () => {
  const h = box({ ...MANAGER, engineRetired: true });
  const id = "0x" + "4e".repeat(32);
  // a YANKED version: without the hold, ensureApp gives the lease back (#giveUp -> an on-chain release)
  const r = await h.ensureApp(id, dep(), { version: { yanked: true, cid: "bafy", version: 4 } });
  assert.equal(r.status, "held", JSON.stringify(r));
  assert.match(r.reason, /pending the operator's decision/);
  assert.equal(h.blocked.has(id), false, "not blocked: nothing was given up");
});

test("ensureApp on a legacy node still takes the old path (the yanked version is given up)", async () => {
  const h = box(MANAGER);
  const id = "0x" + "5e".repeat(32);
  const r = await h.ensureApp(id, dep(), { version: { yanked: true, cid: "bafy", version: 4 } });
  assert.notEqual(r.status, "held");
  assert.equal(h.blocked.has(id), true);
});
