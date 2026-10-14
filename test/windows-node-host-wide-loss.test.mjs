// A host shutdown takes every partition away at once; that is not each app failing (2026-10-14 14:29Z: Windows Update
// restarted nucbox-k11-4 and the node gave all eight deployments up - released on chain and blocked - one by one as each
// partition was "no longer on this host"). Through the REAL manager, client, lifecycle and host.mjs; Hyper-V and Base faked.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";
import { servedOwner } from "./helpers/owners.mjs";
import { REC, DEP, ISOLATED, PLANNED, FakeHost, bootManager, closeManagers } from "./helpers/hv-fake-manager.mjs";

const rpc = await fakeBaseRpc();
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
const { Host } = await import("../windows/node/host.mjs");
after(() => { closeManagers(); rpc.close(); });

const OWNER = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c", DEP2 = "0x" + "e7".repeat(32);
const dep = () => ({ appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  leaseUntil: Math.floor(Date.now() / 1000) + 3600, cpuMilli: 100, gpuMilli: 0, isPublic: true, owner: OWNER, configCid: ISOLATED });

async function twoServing() {
  const host = new FakeHost(), m = await bootManager(host), logs = [];
  const h = servedOwner(new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-hostloss-")), endpoint: "https://api.enclave.host/t/test",
    name: "test", appsEnabled: true, cpuPricePerSec6: 12, log: (s) => logs.push(s), isolationManager: `http://127.0.0.1:${m.port}`,
    isolationRuntimeId: REC.runtimeId, hyperVEventsRun: async () => "[]" }), OWNER);
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65);
  for (const id of [DEP, DEP2]) { h.secrets.set(id, {}); assert.equal((await h.ensureApp(id, dep(), { version: PLANNED })).status, "running"); }
  return { host, m, h, logs };
}

test("every partition gone at once (a host shutdown): the lease is kept, nothing is given up, released or blocked", async () => {
  const { host, m, h, logs } = await twoServing();
  host.vms.clear();                                         // Windows shutting down: every VM gone
  await m.manager.sweepLiveness();                           // the manager's successful survey: each one "no longer on this host"
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "provisioning", r.reason);
  assert.match(r.reason, /host-wide loss/);
  assert.equal(h.blocked.has(DEP), false, "not blocked");
  assert.ok(!logs.some((l) => /giving up on|released .* back to the fleet/.test(l)), logs.join("\n"));
});

test("one partition gone while the others still run is still that app ending (unchanged)", async () => {
  const { host, m, h, logs } = await twoServing();
  const mine = h.records.get(DEP).isolation.instance;
  for (const [name, vm] of host.vms) if (name.includes(mine.slice(0, 14))) host.vms.delete(name);
  await m.manager.sweepLiveness();
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.doesNotMatch(String(r.reason), /host-wide loss/);
  assert.ok(logs.some((l) => /giving up on/.test(l)) || r.status === "failed", `${r.status}: ${r.reason}`);
});
