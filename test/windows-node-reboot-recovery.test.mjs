// RECOVERY AFTER A MANAGER OR HOST RESTART on the NucBox hv node (enclave-87's ruling (B) and its amendment from d1's
// live A8): a VM the restarted manager lists `recovered` can never serve again (its relay and its launcher's report key
// belonged to the previous manager). After a HOST restart it is Off (AutomaticStartAction Nothing); after a MANAGER-only
// restart it is still Running. Either way the node retires it through the manager (confirmed gone) and starts ONE fresh
// partition inside the same lease (a new key, nothing released, never a second VM, the recovered VM never served); any
// failure on that path holds the deployment until an operator's forced relaunch.
// Through host.mjs itself, the REAL manager (restarted like main.mjs boots it), the real node client and lifecycle; only
// Hyper-V (test/helpers/hv-fake-manager.mjs) and Base (fake-base-rpc) are faked.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";
import { servedOwner } from "./helpers/owners.mjs";
import { REC, DEP, ISOLATED, PLANNED, FakeHost, bootManager, restartManager, clientFor, closeManagers,
         judgeRunningPerVm } from "./helpers/hv-fake-manager.mjs";

const rpc = await fakeBaseRpc();                      // BEFORE host.mjs (and chain.mjs) loads
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
const { Host } = await import("../windows/node/host.mjs");
after(() => { closeManagers(); rpc.close(); });

const OWNER = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
const dep = () => ({ appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  leaseUntil: Math.floor(Date.now() / 1000) + 3600, cpuMilli: 100, gpuMilli: 0, isPublic: true, owner: OWNER, configCid: ISOLATED });
const box = (port, logs = []) => {
  const h = servedOwner(new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-reboot-")), endpoint: "https://api.enclave.host/t/test",
    name: "test", appsEnabled: true, cpuPricePerSec6: 12, log: (s) => logs.push(s), engineRetired: true,
    isolationManager: `http://127.0.0.1:${port}`, isolationRuntimeId: REC.runtimeId }), OWNER);
  h.secrets.set(DEP, {});                             // known: no secrets staged
  return h;
};
// a node that served DEP on a partition, and the host that runs it
async function served() {
  const host = new FakeHost();
  const m1 = await bootManager(host, 0, { judgeReady: judgeRunningPerVm });
  const h1 = box(m1.port);
  const r = await h1.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "running", r.reason);
  return { host, m1, inst: r.isolation.instance, key: r.isolation.transportKeySha256 };
}
// the manager restarted on the SAME port: a pooled keep-alive socket to the old process would make the next request a
// transport error (an honest "held: the manager could not be asked"), so the pool is let drop it first
const settle = () => new Promise((r) => setTimeout(r, 250));
async function restart(m1, host) { const m2 = await restartManager(m1, host); await settle(); return m2; }
// the node after it restarted too: it remembers nothing but that it tracks DEP
const restartedNode = (m, logs) => { const h = box(m.port, logs); h.records.set(DEP, { id: DEP, status: "provisioning" }); return h; };
const notGivenUp = (h, logs) => {
  assert.equal(h.blocked.has(DEP), false, "not blocked on this box");
  assert.ok(!logs.some((l) => /giving up|gave up|released/i.test(l)), `nothing released: ${logs.join(" / ")}`);
};

test("a HOST restart: the Off recovered VM is retired and ONE fresh partition serves, on a NEW key; nothing released", async () => {
  const { host, m1, inst, key } = await served();
  host.reboot();
  const m2 = await restart(m1, host);
  const seen = await clientFor(m2.port).get(inst);
  assert.equal(seen.recovered, true); assert.equal(seen.vmState, "Off", "the node's client carries the surveyed state");
  const logs = [], h = restartedNode(m2, logs), starts = host.starts;
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "running", `${r.reason} | ${logs.join(" / ")}`);
  assert.notEqual(r.isolation.instance, inst, "a fresh partition");
  assert.notEqual(r.isolation.transportKeySha256, key, "on a new key");
  assert.equal(host.starts, starts + 1, "exactly one start");
  assert.equal(host.vms.size, 1, "the Off VM is gone and only the fresh one exists");
  assert.equal(host.running().length, 1);
  assert.ok(logs.some((l) => /restart recovery: the recovered VM .* \(Off\) was retired; starting ONE fresh partition/.test(l)));
  notGivenUp(h, logs);
  assert.equal(h.records.get(DEP).rebootHeld ?? null, null);
});

test("a MANAGER-only restart (the VM still Running, never vouched for again): retired, and ONE fresh partition serves on a NEW key", async () => {
  const { host, m1, inst, key } = await served();
  const m2 = await restart(m1, host);
  assert.equal((await clientFor(m2.port).get(inst)).vmState, "Running");
  const logs = [], h = restartedNode(m2, logs), starts = host.starts;
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "running", `${r.reason} | ${logs.join(" / ")}`);
  assert.notEqual(r.isolation.instance, inst); assert.notEqual(r.isolation.transportKeySha256, key);
  assert.equal(host.starts, starts + 1); assert.equal(host.vms.size, 1, "the recovered VM is gone: never served, never kept");
  assert.ok(logs.some((l) => /restart recovery: the recovered VM .* \(Running\) was retired/.test(l)));
  notGivenUp(h, logs);
});

test("a recovered VM in any other state (Saved) is replaced the same way", async () => {
  const { host, m1, inst } = await served();
  for (const vm of host.vms.values()) vm.state = "Saved";
  const m2 = await restart(m1, host);
  const logs = [], h = restartedNode(m2, logs), starts = host.starts;
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "running", r.reason); assert.notEqual(r.isolation.instance, inst);
  assert.equal(host.starts, starts + 1); assert.equal(host.vms.size, 1);
});

test("the fresh partition FAILS: HELD (not retried by a routine pass, nothing released) until an operator's forced relaunch", async () => {
  const { host, m1, inst } = await served();
  host.reboot();
  const m2 = await restart(m1, host);
  const logs = [], h = restartedNode(m2, logs), starts = host.starts;
  host.startFails = true;
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "held", `${r.reason} | ${logs.join(" / ")}`);
  assert.match(r.rebootHeld, /reboot recovery: the fresh partition did not come up/);
  assert.equal(host.starts, starts + 1, "one attempt");
  assert.ok(![...host.vms.keys()].includes("enclave-app-" + inst), "the Off VM was retired");
  // routine passes: no second attempt
  for (let i = 0; i < 2; i++) assert.equal((await h.ensureApp(DEP, dep(), { version: PLANNED })).status, "held");
  assert.equal(host.starts, starts + 1, "no second attempt");
  notGivenUp(h, logs);
  // the operator's forced relaunch is what it waits for
  host.startFails = false;
  const f = await h.ensureApp(DEP, dep(), { force: true, version: PLANNED });
  assert.equal(f.status, "running", `${f.reason} | ${logs.join(" / ")}`);
  assert.equal(host.running().length, 1); assert.equal(f.rebootHeld ?? null, null);
});

test("the recovered VM's removal cannot be confirmed: HELD on it, no fresh partition (never a second VM), and not retried", async () => {
  const { host, m1, inst } = await served();
  host.reboot();
  const m2 = await restart(m1, host);
  host.stopFails = true;
  const logs = [], h = restartedNode(m2, logs), starts = host.starts;
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "held", r.reason); assert.match(r.rebootHeld, /could not be confirmed removed/);
  assert.equal(r.isolationHeld, inst, "the VM still out there stays named");
  assert.equal(host.starts, starts, "nothing started"); assert.equal(host.vms.size, 1);
  const stops = host.stops;
  await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(host.stops, stops, "the removal is not retried by a routine pass"); assert.equal(host.starts, starts);
  notGivenUp(h, logs);
});
