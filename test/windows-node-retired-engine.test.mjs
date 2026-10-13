// A node started WITHOUT the retired VBS enclave engine (cfg.engineRetired; Steven, 2026-09-25) runs only isolated
// deployments. Anything else it already holds is HELD: refused and recorded, never started, never renewed and
// NEVER released on chain automatically (enclave-d1 F2). It never claims one either. Each test here fails if its
// guard is removed.
//
// "Isolated" is chain.isolationForBackend (the production runtime nucbox-k11 ran from 2026-10-02, merged for the Windows
// host installer): a deployment that names THIS backend, or names no backend at all, runs in its own partition; one
// naming another backend, or needing a CPU or GPU TEE this box cannot give, is held and never claimed.
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

test("retired engine: a deployment naming no backend runs in a partition; one naming another backend or needing a TEE is held, and not claimed", () => {
  const h = box({ ...MANAGER, engineRetired: true });
  assert.equal(h.heldReason(dep()), null, "no isolation named: it runs here, in its own partition");
  assert.equal(h.retiredEngineClaimRefusal(dep()), null);
  for (const env of [{ isolation: { require: "snp-vm" } }, { isolation: { cpuTee: true } }, { isolation: { gpuTee: true } }]) {
    const d = dep(JSON.stringify(env));
    assert.match(h.heldReason(d), /held - not started, not renewed, not released/, JSON.stringify(env));
    assert.match(h.retiredEngineClaimRefusal(d), /claims only deployments compatible with hyperv-partition-per-app/, JSON.stringify(env));
  }
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

test("ensureApp on a retired-engine node HOLDS a deployment for another backend BEFORE any gate that could release it", async () => {
  const h = box({ ...MANAGER, engineRetired: true });
  const id = "0x" + "4e".repeat(32);
  // a YANKED version: without the hold, ensureApp gives the lease back (#giveUp -> an on-chain release)
  const r = await h.ensureApp(id, dep(JSON.stringify({ isolation: { require: "snp-vm" } })), { version: { yanked: true, cid: "bafy", version: 4 } });
  assert.equal(r.status, "held", JSON.stringify(r));
  assert.match(r.reason, /pending the operator's decision/);
  assert.equal(h.blocked.has(id), false, "not blocked: nothing was given up");
  // an isolated deployment's yanked version is given up only once its domain is KNOWN gone: an unreachable manager
  // holds it instead (#giveUp's fail-closed retire), and nothing is released
  const id2 = "0x" + "4d".repeat(32);
  const r2 = await h.ensureApp(id2, dep(), { version: { yanked: true, cid: "bafy", version: 4 } });
  assert.equal(r2.status, "held", JSON.stringify(r2));
  assert.match(r2.reason, /could not be confirmed gone/);
  assert.equal(h.blocked.has(id2), false);
});

test("ensureApp on a legacy node (no isolation manager) still takes the old path (the yanked version is given up)", async () => {
  const h = box({});
  const id = "0x" + "5e".repeat(32);
  const r = await h.ensureApp(id, dep(), { version: { yanked: true, cid: "bafy", version: 4 } });
  assert.notEqual(r.status, "held");
  assert.equal(h.blocked.has(id), true);
});
