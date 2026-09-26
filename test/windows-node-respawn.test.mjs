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
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";
import { servedOwner } from "./helpers/owners.mjs";
import { REC, DEP, ISOLATED, PLANNED, FakeHost, bootManager, closeManagers } from "./helpers/hv-fake-manager.mjs";

const rpc = await fakeBaseRpc();                     // before host.mjs loads: nothing here reaches a public RPC
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
const { Host, RESPAWN_BUDGET } = await import("../windows/node/host.mjs");
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

test("OFF (the default): a domain that ended gives its lease up, exactly as before (released and blocked here)", async () => {
  const { host, h, end } = await servingThenEnded();
  const dead = await end();
  await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(h.blocked.has(DEP), true, "today's give-up stays the default");
  assert.ok(!host.vms.size || ![...host.vms.values()].some((v) => v.vmId === dead), "the ended VM was retired before the lease went");
  assert.equal(host.running().length, 0, "and nothing new was started");
});

test("ON: a domain that ended is retired, confirmed gone, and ONE fresh domain starts; nothing is released", async () => {
  const { host, h, end } = await servingThenEnded({ isolationRespawn: true });
  const before = h.records.get(DEP).isolation.instance;
  const dead = await end();
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "running", r.reason);
  assert.notEqual(h.records.get(DEP).isolation.instance, before, "a NEW instance");
  assert.ok(![...host.vms.values()].some((v) => v.vmId === dead), "the ended VM is gone");
  assert.equal(host.running().length, 1, "exactly one VM for the deployment");
  assert.equal(h.blocked.has(DEP), false, "the lease was not given up");
});

test(`ON: at most ${RESPAWN_BUDGET} respawns an hour; the next end gives the lease up with the reason`, async () => {
  const { host, h, end } = await servingThenEnded({ isolationRespawn: true });
  for (let i = 0; i < RESPAWN_BUDGET; i++) {
    await end();
    const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
    assert.equal(r.status, "running", `respawn ${i + 1}: ${r.reason}`);
  }
  await end();
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(h.blocked.has(DEP), true); assert.match(r.reason, new RegExp(`respawned ${RESPAWN_BUDGET} time\\(s\\) in the last hour`));
  assert.equal(host.running().length, 0);
});

test("ON: a domain whose retire cannot be confirmed is NOT respawned, and keeps its lease", async () => {
  const { host, h, end } = await servingThenEnded({ isolationRespawn: true });
  const dead = await end();
  host.stopFails = true;
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "provisioning"); assert.match(r.reason, /could not be confirmed gone/);
  assert.equal(h.blocked.has(DEP), false);
  assert.ok([...host.vms.values()].some((v) => v.vmId === dead), "the ended VM is still there, and");
  assert.equal(host.running().length, 0, "nothing new was started beside it");
});

test("ON: a REFUSAL (the manager answered no) is never respawned: the lease is given up", async () => {
  const s = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/health") return send(200, { backend: "hyperv-partition-per-app", catalog: { derivations: ["enclave-catalog-bundle/1"] }, boundary: { tier: "t0-hv", hostExcluded: false } });
    if (req.method === "GET" && req.url === "/vms") return send(200, { vms: [] });
    if (req.method === "POST" && req.url === "/vms") return send(400, { error: "the derive record is refused" });
    send(404, { error: "not found" });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r)); servers.push(s);
  const h = box(s.address().port, { isolationRespawn: true });
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(h.blocked.has(DEP), true, r.reason); assert.match(r.reason, /refused/);
});
