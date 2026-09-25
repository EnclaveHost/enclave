// #stopApp, reached the only way production reaches it: through tick() reading the deployment off the ledger. Base is a
// fake JSON-RPC (test/helpers/fake-base-rpc.mjs, the seam enclave-d1's reviewer found) and Hyper-V a FakeHost behind
// the REAL manager (test/helpers/hv-fake-manager.mjs). From enclave-d1's re-review of d626da4e (probes T1, T2, T4).
//
// The rule: a lease that ended (stopped on the ledger, or held by another enclave) stops the app, but an isolated
// domain that could not be confirmed gone keeps the deployment TRACKED, so the next tick retries the retire. It never
// renews a lease it is stopping, never loops faster than the tick, and forgets the deployment once the VM is gone.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc, DEPLOYMENTS, enclaveIdOf } from "./helpers/fake-base-rpc.mjs";
import { DEP, ISOLATED, recoveredOnManager, closeManagers } from "./helpers/hv-fake-manager.mjs";

const rpc = await fakeBaseRpc();                     // BEFORE chain.mjs loads: it reads BASE_RPCS once
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
const { Host } = await import("../windows/node/host.mjs");
after(() => { closeManagers(); rpc.close(); });

const ENDPOINT = "https://api.enclave.host/t/test";
const ME = enclaveIdOf(ENDPOINT);
const ledgerRow = (over) => ({ id: DEP, owner: "0x29479bf04ed889d46a7afb7f292b9bb26e12647c",
  appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4", ports: "", configCid: ISOLATED,
  gpuMilli: 0, cpuMilli: 100, appPort: 8080, isPublic: true, active: true, createdAt: 1n, rate: 1n, balance6: 0n, spent6: 0n,
  runner: ME, runnerOperator: "0x" + "00".repeat(20), leaseUntil: BigInt(Math.floor(Date.now() / 1000) + 3600), ...over });
function tickBox(port, logs) {
  const h = new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-stop-")), endpoint: ENDPOINT, name: "test", appsEnabled: true,
                       cpuPricePerSec6: 12, log: (s) => logs.push(s), isolationManager: `http://127.0.0.1:${port}` });
  h.chainReady = true; h.registered = { endpoint: ENDPOINT, cpuPricePerSec6: 12n };
  return h;
}
const snap = (h, host) => ({ status: h.records.get(DEP)?.status, tracked: h.tracked.has(DEP), vms: host.running().length, stops: host.stops });
const renews = (logs) => logs.filter((l) => /renew/i.test(l)).length;

test("stopped on the ledger, DELETE failing: held and tracked, one retire per tick; once it works: stopped, forgotten, no more DELETEs", async () => {
  const { host, m2, instanceId } = await recoveredOnManager();
  host.stopFails = true;
  const logs = []; const h = tickBox(m2.port, logs);
  h.tracked.add(DEP); h.records.set(DEP, { id: DEP, status: "running", isolation: { instance: instanceId } });
  rpc.row.current = ledgerRow({ active: false });
  const s0 = host.stops;
  await h.tick();
  const a = snap(h, host);
  assert.deepEqual({ status: a.status, tracked: a.tracked, vms: a.vms }, { status: "held", tracked: true, vms: 1 });
  await h.tick();
  assert.equal(host.stops - s0, 2, "one retire attempt per tick, no tighter loop");
  host.stopFails = false;
  await h.tick();
  const c = snap(h, host);
  assert.deepEqual({ status: c.status, tracked: c.tracked, vms: c.vms }, { status: "stopped", tracked: false, vms: 0 });
  await h.tick();
  assert.equal(host.stops, c.stops, "a forgotten deployment is not retired again");
  assert.equal(renews(logs), 0, "a lease the owner stopped is never renewed");
});

test("another enclave holds a live lease, DELETE failing: held and tracked each tick, never renewed", async () => {
  const { host, m2, instanceId } = await recoveredOnManager();
  host.stopFails = true;
  const logs = []; const h = tickBox(m2.port, logs);
  h.tracked.add(DEP); h.records.set(DEP, { id: DEP, status: "running", isolation: { instance: instanceId } });
  rpc.row.current = ledgerRow({ runner: "0x" + "ab".repeat(32) });
  await h.tick(); await h.tick();
  const s = snap(h, host);
  assert.deepEqual({ status: s.status, tracked: s.tracked, vms: s.vms }, { status: "held", tracked: true, vms: 1 });
  assert.equal(renews(logs), 0);
});

test("a RESTARTED node (no ids known) stopped on the ledger retires the VM BY NAME, then forgets the deployment (H7)", async () => {
  const { host, m2 } = await recoveredOnManager();
  const logs = []; const h = tickBox(m2.port, logs);
  h.tracked.add(DEP);                                  // tracked from the state file; no record, no ids
  rpc.row.current = ledgerRow({ active: false });
  await h.tick();
  const s = snap(h, host);
  assert.equal(s.vms, 0, "the VM still runs under a lease that has ended");
  assert.equal(s.status, "stopped"); assert.equal(s.tracked, false);
});
