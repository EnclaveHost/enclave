// A lease the node holds but is not serving is NOT renewed (coordinator enclave-87): d1's live node renewed test 1 at
// 01:15:58Z while it refused to provision it, and after a host reboot a RECOVERED, held domain was renewed every tick
// (enclave-5d's G1) - billing the tenant for time nobody was served. Held on the plan (planHeld) or held rather than
// serving (isolationHeld without a running record): not renewed, said once, and at lapse retired locally (the held
// domain by its id) with nothing released on chain. A running deployment, and one merely provisioning, still renew.
// Through the real tick, against the fake ledger (Base) and a real manager (Hyper-V faked).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc, DEPLOYMENTS, enclaveIdOf } from "./helpers/fake-base-rpc.mjs";
import { DEP, ISOLATED, FakeHost, bootManager, recoveredOnManager, closeManagers } from "./helpers/hv-fake-manager.mjs";
import { servedOwner } from "./helpers/owners.mjs";

const rpc = await fakeBaseRpc();
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
const { Host } = await import("../windows/node/host.mjs");
after(() => { closeManagers(); rpc.close(); });

const ENDPOINT = "https://api.enclave.host/t/test";
const ME = enclaveIdOf(ENDPOINT);
const OWNER = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
const ledgerRow = (leaseSec) => ({ id: DEP, owner: OWNER, ports: "", configCid: ISOLATED,
  appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  gpuMilli: 0, cpuMilli: 100, appPort: 8080, isPublic: true, active: true, createdAt: 1n, rate: 1n, balance6: 0n, spent6: 0n,
  runner: ME, runnerOperator: "0x" + "00".repeat(20), leaseUntil: BigInt(Math.floor(Date.now() / 1000) + leaseSec) });

// one tick over DEP with record `rec`; the lease ends in `leaseSec` (inside the 15-min renewal window, or past)
async function tickWith(rec, leaseSec, { port, keepEnsure = true } = {}) {
  if (!port) ({ port } = await bootManager(new FakeHost(), 0));
  const logs = [];
  const h = servedOwner(new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-norenew-")), endpoint: ENDPOINT, name: "test",
    appsEnabled: true, cpuPricePerSec6: 12, log: (s) => logs.push(String(s)), engineRetired: true,
    isolationManager: `http://127.0.0.1:${port}` }), OWNER);
  h.chainReady = true; h.registered = { endpoint: ENDPOINT, cpuPricePerSec6: 12n };
  h.ensureRegistered = async () => {}; h.ensurePriced = async () => {};
  if (keepEnsure) h.ensureApp = async () => h.records.get(DEP);          // the plan/outcome does not change this tick
  h.tracked.add(DEP);
  h.records.set(DEP, { id: DEP, owner: OWNER, ...rec });
  rpc.row.current = ledgerRow(leaseSec);
  await h.tick();
  return { h, logs, renewed: logs.filter((l) => /^renewed 0x|renew failed/.test(l)).length, rec: h.records.get(DEP) };
}

test("planHeld (the node refuses to provision it) inside the renewal window: NOT renewed, and said once", async () => {
  const r = await tickWith({ status: "provisioning", planHeld: true, reason: "isolation: hasSecrets: whether the deployment has staged secrets is not known here" }, 600);
  assert.equal(r.renewed, 0, r.logs.join(" / "));
  assert.equal(r.logs.filter((l) => /NOT renewed: this box is not serving it/.test(l)).length, 1);
  await r.h.tick();
  assert.equal(r.logs.filter((l) => /NOT renewed/.test(l)).length, 1, "said again every tick");
});

test("planHeld whose lease LAPSED: stopped locally, untracked, nothing released", async () => {
  const r = await tickWith({ status: "provisioning", planHeld: true, reason: "isolation: hasSecrets: unknown" }, -60);
  assert.equal(r.rec.status, "stopped", JSON.stringify(r.rec));
  assert.match(r.rec.reason, /lease lapsed while this box was not serving it/);
  assert.equal(r.h.tracked.has(DEP), false);
  assert.equal(r.renewed, 0);
});

test("a RECOVERED, held domain (G1) inside the window: NOT renewed; once lapsed it is retired by its id and confirmed gone", async () => {
  const { host, m2, instanceId } = await recoveredOnManager();
  const held = { status: "provisioning", isolationHeld: instanceId, reason: "recovered from Hyper-V: held" };
  const a = await tickWith(held, 600, { port: m2.port });
  assert.equal(a.renewed, 0, a.logs.join(" / "));
  assert.equal(host.running().length, 1, "a live lease's held domain was retired early");
  const b = await tickWith(held, -60, { port: m2.port });
  assert.equal(b.rec.status, "stopped", JSON.stringify(b.rec));
  assert.equal(host.running().length, 0, "the held domain still runs after its lease lapsed");
  assert.equal(b.h.tracked.has(DEP), false);
});

test("controls: a RUNNING partition and one merely provisioning (no hold) ARE renewed inside the window", async () => {
  const running = await tickWith({ status: "running", isolation: { instance: "hv1", appId: "1".repeat(64) } }, 600);
  assert.ok(running.renewed >= 1, running.logs.join(" / "));
  const starting = await tickWith({ status: "provisioning", reason: "isolation: starting" }, 600);
  assert.ok(starting.renewed >= 1, starting.logs.join(" / "));
});

test("a REBOOT-RECOVERY hold (#rebootHold: the fresh partition did not come up, no VM left to name): NOT renewed; lapsed: stopped", async () => {
  const held = { status: "held", rebootHeld: "isolation: reboot recovery: the fresh partition did not come up: ...; held", reason: "reboot held" };
  const a = await tickWith(held, 600);
  assert.equal(a.renewed, 0, a.logs.join(" / "));
  assert.equal(a.logs.filter((l) => /NOT renewed: this box is not serving it/.test(l)).length, 1);
  const b = await tickWith(held, -60);
  assert.equal(b.rec.status, "stopped", JSON.stringify(b.rec));
  assert.equal(b.rec.rebootHeld ?? null, null, "cleared once stopped");
  assert.equal(b.h.tracked.has(DEP), false);
});
