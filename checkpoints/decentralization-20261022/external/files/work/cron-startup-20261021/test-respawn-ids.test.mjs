// cron-startup-20261021: the PER-DEPLOYMENT respawn list (ENCLAVE_ISOLATION_RESPAWN_IDS / _DELAY_MS) on the fixtures of
// enclave test/windows-node-respawn.test.mjs (copied verbatim above the tests; absolute imports). Original header:
// Respawn of an isolated domain that ENDED (host.mjs, cfg.isolationRespawn): a lease policy that is OFF by default, so
// today's give-up stays the default until Steven decides (enclave-d1 puts it to him). Pinned both ways, through the REAL
// manager, the real client, the real lifecycle and host.mjs. Only Hyper-V (test/helpers/hv-fake-manager.mjs) and Base
// (test/helpers/fake-base-rpc.mjs) are faked. A domain "ends" as G4 measured on type 1: its VM goes Off, and the
// manager's liveness sweep fails it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fakeBaseRpc, DEPLOYMENTS } from "/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/test/helpers/fake-base-rpc.mjs";
import { servedOwner } from "/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/test/helpers/owners.mjs";
import { REC, DEP, ISOLATED, PLANNED, FakeHost, bootManager, closeManagers } from "/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/test/helpers/hv-fake-manager.mjs";

const rpc = await fakeBaseRpc();                     // before host.mjs loads: nothing here reaches a public RPC
const chain = await import("/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
const { Host, RESPAWN_BUDGET } = await import("/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/windows/node/host.mjs");
const servers = [];
after(() => { closeManagers(); rpc.close(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } });

const dep = () => ({ appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  leaseUntil: Math.floor(Date.now() / 1000) + 3600, cpuMilli: 100, gpuMilli: 0, isPublic: true,
  owner: "0x29479bf04ed889d46a7afb7f292b9bb26e12647c", configCid: ISOLATED });
function box(port, cfg = {}) {
  const h = new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-respawn-")), endpoint: "https://api.enclave.host/t/test", name: "test",
    appsEnabled: true, cpuPricePerSec6: 12, log: () => {}, isolationManager: `http://127.0.0.1:${port}`, isolationRuntimeId: REC.runtimeId, ...cfg });
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});        // known: no staged secrets
  return servedOwner(h, "0x29479bf04ed889d46a7afb7f292b9bb26e12647c");
}
// a serving domain, then its VM turned Off and the manager's liveness sweep run: the domain has ENDED
async function servingThenEnded(cfg) {
  const host = new FakeHost();
  const m = await bootManager(host);
  const h = box(m.port, cfg);
  const r1 = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r1.status, "running", r1.reason);
  return { host, m, h, end: async () => {
    const vm = host.running()[0]; vm.state = "Off";
    const s = await m.manager.sweepLiveness(); assert.equal(s.failed, 1, JSON.stringify(s));
    return vm.vmId;
  } };
}


test("IDS: the listed deployment that ended is retired and ONE fresh domain starts; its lease is kept", async () => {
  const { host, h, end } = await servingThenEnded({ isolationRespawnIds: [DEP.toLowerCase()], isolationRespawnDelayMs: 0 });
  const before = h.records.get(DEP).isolation.instance;
  const dead = await end();
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "running", r.reason);
  assert.notEqual(h.records.get(DEP).isolation.instance, before, "a NEW instance");
  assert.ok(![...host.vms.values()].some((v) => v.vmId === dead), "the ended VM is gone");
  assert.equal(host.running().length, 1, "exactly one VM");
  assert.equal(h.blocked.has(DEP), false, "the lease was not given up");
});
test("IDS: a deployment NOT on the list still gives its lease up (the default is unchanged for everyone else)", async () => {
  const { host, h, end } = await servingThenEnded({ isolationRespawnIds: ["0x" + "ab".repeat(32)] });
  await end();
  await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(h.blocked.has(DEP), true);
  assert.equal(host.running().length, 0);
});
test("IDS + DELAY 600000: the ended domain is HELD (lease kept, nothing new started) until the storage lease can lapse", async () => {
  const { host, h, end } = await servingThenEnded({ isolationRespawnIds: [DEP.toLowerCase()], isolationRespawnDelayMs: 600000 });
  await end();
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "provisioning", r.reason);
  assert.match(r.reason, /automatic restart after .*storage lease/);
  assert.equal(h.blocked.has(DEP), false, "the lease was not given up");
  assert.equal(host.running().length, 0, "nothing new before the delay");
});
