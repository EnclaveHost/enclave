// The boundary between the lab acceptance route and production app admission, on the Windows node. None of these may
// grant protected (market) app capacity or a verified isolation status:
//   - a host-signed statement (the manager's view, the launcher's report);
//   - a self-asserted hostExcluded flag;
//   - a TPM-only node identity (windows-hv-node/v1, relay tier "hv-node").
// The relay's side (an hv-node row is ineligible and non-TEE, whatever the node says) is enclave-99's, in
// test/relay-hvnode-consumer.test.mjs and test/tenant-compute-eligibility.test.mjs; this file covers the node.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";
import { REC, DEP, ISOLATED, PLANNED } from "./helpers/hv-fake-manager.mjs";
import { attestedCapacity } from "../windows/node/isolation-client.mjs";

const rpc = await fakeBaseRpc();                     // before host.mjs loads: nothing here reaches a public RPC
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
const { Host, isolationBoundaryRefusal } = await import("../windows/node/host.mjs");
const servers = [];
after(() => { rpc.close(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } });

const OWNER = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c", STRANGER = "0x" + "5a".repeat(20);
const box = (cfg = {}) => new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-capb-")), endpoint: "https://api.enclave.host/t/test",
  name: "test", appsEnabled: true, cpuPricePerSec6: 12, log: () => {}, ...cfg });

// ---- 1. the node's own contract gate: no configuration and no relay tier opens the market ----
test("no relay tier, and no app-runtime ABI, makes this node meet the isolation contract or leave owner-only scope", () => {
  for (const abi of [0, 1]) for (const tier of ["", "hv-node", "vbs-dev", "vbs", "T0-hv"]) {
    const h = box({ engineRetired: abi === 0, claimScope: "market", enclaveAppAbi: abi, isolationManager: "http://127.0.0.1:1" });
    h.relayTier = tier;
    assert.equal(h.meetsIsolationContract(), false, `abi=${abi} tier=${tier}`);
    assert.equal(h.scope(), "owner-only", `abi=${abi} tier=${tier}: market scope must stay closed`);
    assert.equal(h.availability().claimEnabled, false, `abi=${abi} tier=${tier}`);
  }
});

test("an isolation-only node (TPM-only identity, tier hv-node) advertises no app hosting and claims no stranger's deployment", () => {
  const h = box({ engineRetired: true, claimScope: "market", isolationManager: "http://127.0.0.1:1", ownerWallet: OWNER });
  h.relayTier = "hv-node";
  const a = h.availability();
  assert.equal(a.apps.inTee, false); assert.equal(a.apps.capacity, 0);
  const d = { createdAt: 1n, active: true, owner: STRANGER, isPublic: true, runner: "0x" + "00".repeat(32), leaseUntil: 0n,
              configCid: ISOLATED, gpuMilli: 0 };
  assert.match(chain.claimPolicy(d, { scope: h.scope(), ownerAllow: h.ownerAllow(), enclaveId: h.enclaveId,
                                      isolationBackend: h.isolationBackend }), /owner-only scope/);
  assert.equal(chain.claimPolicy({ ...d, owner: OWNER }, { scope: h.scope(), ownerAllow: h.ownerAllow(), enclaveId: h.enclaveId,
                                                         isolationBackend: h.isolationBackend }), null, "its OWNER's deployment is still claimable");
});

// ---- 2. a manager's self-asserted boundary: never verified capacity, never recorded, never routed ----
test("attestedCapacity: a manager's own hostExcluded/chain-verified claim is not a verification", () => {
  assert.equal(attestedCapacity({ status: "running", hostExcluded: true, verdict: "chain-verified", tier: "T2-snp" }), false);
});

test("isolationBoundaryRefusal: only T0-hv with the host NOT excluded is this backend's boundary", () => {
  for (const ok of [{ hostExcluded: false, tier: "t0-hv" }, { hostExcluded: false, tier: "T0-hv" }]) assert.equal(isolationBoundaryRefusal(ok), null);
  for (const bad of [{ hostExcluded: true, tier: "T0-hv" }, { hostExcluded: "false", tier: "T0-hv" }, { tier: "T0-hv" },
                     { hostExcluded: false, hostExcludedAsStated: "true", tier: "T0-hv" }, { hostExcluded: false, hostExcludedAsStated: 1, tier: "T0-hv" },
                     { hostExcluded: false, tier: ["T0-hv"] }, { hostExcluded: false, tier: { toString: () => "T0-hv" } },
                     { hostExcluded: false, tier: "T2-snp" }, { hostExcluded: false, tier: "T0" }, { hostExcluded: false, tier: null }, null])
    assert.ok(isolationBoundaryRefusal(bad), JSON.stringify(bad));
});

// a manager that lies: its /vms view says this deployment's domain runs with a boundary this backend cannot have
async function lyingManager(over, holder = {}) {
  const HV = "hv" + "3".repeat(32);
  const view = { id: HV, name: DEP, status: "running", appId: "708e640945d196df5829aa4ea490774c18ef6876a0d9239f574986ad18ae3782",
                 runtimeId: REC.runtimeId, image: "ab".repeat(32), transportKeySha256: "cd".repeat(32), tier: "t0-hv", hostExcluded: false,
                 verdict: "monitor-signed", boundary: { tier: "t0-hv", partition: "hyperv-vm", hostExcluded: false }, ...over };
  holder.view = view;                                  // a test may change what the manager says, between passes
  holder.deletes = 0; let gone = false;
  const s = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "DELETE" && req.url === `/vms/${HV}`) { holder.deletes++; gone = true; return send(200, { ok: true }); }
    if (gone && req.url.startsWith("/vms")) return req.url === "/vms" ? send(200, { vms: [] }) : send(404, { error: "not found" });
    if (req.url === "/health") return send(200, { backend: "hyperv-partition-per-app", catalog: { derivations: ["enclave-catalog-bundle/1"] },
                                                  boundary: { tier: "t0-hv", hostExcluded: false } });
    if (req.method === "GET" && req.url === "/vms") return send(200, { vms: [view] });
    if (req.method === "GET" && req.url === `/vms/${HV}`) return send(200, view);
    send(404, { error: "not found" });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r)); servers.push(s);
  return { port: s.address().port, HV };
}
const dep = () => ({ appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  leaseUntil: Math.floor(Date.now() / 1000) + 3600, cpuMilli: 100, gpuMilli: 0, isPublic: true, owner: OWNER, configCid: ISOLATED });

for (const [what, over, why] of [
  ["claims host exclusion, verified", { hostExcluded: true, verdict: "chain-verified" }, /hostExcluded=true/],
  ["claims a stronger tier", { tier: "T2-snp", verdict: "chain-verified" }, /tier "T2-snp"/],
]) {
  test(`a manager view that ${what} is HELD: not running, not routed, never recorded as more than T0-hv`, async () => {
    const { port, HV } = await lyingManager(over);
    const h = box({ isolationManager: `http://127.0.0.1:${port}`, isolationRuntimeId: REC.runtimeId });
    h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});
    const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
    assert.equal(r.status, "held", `${r.status}: ${r.reason}`); assert.match(r.reason, why);
    const rec = h.records.get(DEP);
    assert.equal(rec.boundaryHeld, true, "held as a standing fact, so the tick does not renew it");
    assert.equal(rec.isolation ?? null, null, "nothing is recorded as a serving isolated domain");
    assert.equal(rec.isolationHeld, HV, "the instance is held by id, so it can be retired");
    assert.equal(await h.appZoneTarget(DEP), null, "no route");
  });
}

test("the honest view (T0-hv, host not excluded) still serves, and its record says hostExcluded=false", async () => {
  const { port, HV } = await lyingManager({});
  const h = box({ isolationManager: `http://127.0.0.1:${port}`, isolationRuntimeId: REC.runtimeId });
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "running", r.reason);
  assert.equal(h.records.get(DEP).isolation.instance, HV); assert.equal(h.records.get(DEP).isolation.hostExcluded, false);
  assert.equal(h.records.get(DEP).isolation.tier, "T0-hv");
});

test("a manager whose view says hostExcluded:\"true\" (not a plain boolean) is held too, not silently read as false", async () => {
  const { port } = await lyingManager({ hostExcluded: "true" });
  const h = box({ isolationManager: `http://127.0.0.1:${port}`, isolationRuntimeId: REC.runtimeId });
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "held"); assert.match(r.reason, /hostExcluded="true"/);
});

test("RUNNING, then the same instance's view turns into a lie: held, and the serving block is CLEARED (no route)", async () => {
  const holder = {};
  const { port } = await lyingManager({}, holder);
  const h = box({ isolationManager: `http://127.0.0.1:${port}`, isolationRuntimeId: REC.runtimeId });
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});
  assert.equal((await h.ensureApp(DEP, dep(), { version: PLANNED })).status, "running");
  assert.ok(await h.appZoneTarget(DEP), "served on the honest pass");
  Object.assign(holder.view, { hostExcluded: true, verdict: "chain-verified", tier: "T2-snp" });
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "held");
  assert.equal(h.records.get(DEP).isolation ?? null, null, "a held record carries no serving block from the honest pass");
  assert.equal(await h.appZoneTarget(DEP), null);
});

// ---- the tick: a boundary-held lease is not renewed, but its END is honoured (enclave-99's re-review of 2a77f7c0) ----
const ENDPOINT = "https://api.enclave.host/t/test";
async function onTheTick(view, leaseUntilS) {
  const { enclaveIdOf, CATALOG } = await import("./helpers/fake-base-rpc.mjs");
  chain.addresses.appCatalog = CATALOG;               // the tick resolves the version itself
  rpc.catalog.current = { cid: REC.cid, version: "4", vramMb: 0, gpuGflops: 0, memMb: 512, cpuGflops: 0, createdAt: 1n, verified: true,
                          yanked: false, ports: "", approval: 0, config: "{}" };
  const holder = {};
  const { port } = await lyingManager(view, holder);
  const logs = [];
  const h = box({ isolationManager: `http://127.0.0.1:${port}`, isolationRuntimeId: REC.runtimeId, log: (x) => logs.push(x) });
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});
  const first = await h.ensureApp(DEP, dep(), { version: PLANNED });
  rpc.row.current = { id: DEP, owner: OWNER, appRef: dep().appRef, ports: "", configCid: ISOLATED, gpuMilli: 0, cpuMilli: 100, appPort: 8080,
    isPublic: true, active: true, createdAt: 1n, rate: 1n, balance6: 0n, spent6: 0n, runner: enclaveIdOf(ENDPOINT),
    runnerOperator: "0x" + "00".repeat(20), leaseUntil: BigInt(leaseUntilS) };
  h.chainReady = true; h.registered = { endpoint: ENDPOINT, cpuPricePerSec6: 12n }; h.tracked.add(DEP);
  return { h, holder, logs, first };
}
const nowS = () => Math.floor(Date.now() / 1000);
// a renewal's own log lines: "renewed <id>" on success, "<id> renew failed: ..." on failure (not the hold's "not renewed")
const RENEWAL = (l) => /^renewed |renew failed/.test(l);

test("the tick does NOT renew a boundary-held deployment inside its renewal window (and a served one IS renewed: the control)", async () => {
  const held = await onTheTick({ hostExcluded: true }, nowS() + 5 * 60);           // live, inside RENEW_LEAD_MS (15 min)
  assert.equal(held.first.status, "held");
  await held.h.tick();
  assert.deepEqual(held.logs.filter(RENEWAL), [], "no renewal attempted");
  assert.equal(held.h.records.get(DEP).status, "held"); assert.equal(held.holder.deletes, 0, "and nothing retired while the lease lives");
  const served = await onTheTick({}, nowS() + 5 * 60);                             // the control: the detector sees a renewal
  assert.equal(served.first.status, "running");
  await served.h.tick();
  assert.ok(served.logs.some((l) => /renew failed/.test(l)), `a served lease inside the window is renewed (it fails here, with no key): ${served.logs.join(" / ")}`);
});

test("a boundary-held deployment whose lease LAPSED is retired locally (one DELETE, the hold cleared), never renewed", async () => {
  const { h, holder, logs } = await onTheTick({ hostExcluded: true }, nowS() - 3600);
  await h.tick();
  const rec = h.records.get(DEP);
  assert.equal(holder.deletes, 1, "the held instance is retired by the manager");
  assert.equal(rec.status, "stopped", `${rec.status}: ${rec.reason}`); assert.equal(rec.isolationHeld ?? null, null);
  assert.equal(h.tracked.has(DEP), false); assert.deepEqual(logs.filter(RENEWAL), [], "no renewal attempted");
  assert.equal(h.blocked.has(DEP), false, "a local retirement, not a give-up (nothing is released on chain)");
});

test("a manager that turns honest on a LAPSED lease never gets that domain served, not even for one tick", async () => {
  const { h, holder } = await onTheTick({ hostExcluded: true }, nowS() - 3600);
  Object.assign(holder.view, { hostExcluded: false });                            // honest again, but the lease is over
  await h.tick();
  assert.notEqual(h.records.get(DEP).status, "running");
  assert.equal(await h.appZoneTarget(DEP), null, "no route on a lease that ended");
});

test("an honest manager clears the hold on a LIVE lease, and the domain serves again", async () => {
  const { h, holder } = await onTheTick({ hostExcluded: true }, nowS() + 3600);
  Object.assign(holder.view, { hostExcluded: false });
  await h.tick();
  assert.equal(h.records.get(DEP).status, "running"); assert.equal(h.records.get(DEP).boundaryHeld ?? null, null);
  assert.ok(await h.appZoneTarget(DEP));
});
