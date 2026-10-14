// A domain this node saw serving that is gone from the manager is SAID when its replacement starts, with Hyper-V's own
// account of it (host.mjs #noteServing / #vanishedEvidence, windows/node/hyperv-events.mjs). On 2026-10-14 03:52Z RISC
// Box's partition was turned off and the line did not fire: it read rec.isolation, which an intermediate record (the
// respawn's cleanup retire) had already cleared. Through the REAL manager, client, lifecycle and host.mjs; only Hyper-V
// (test/helpers/hv-fake-manager.mjs), Base and the PowerShell event query are faked.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";
import { servedOwner } from "./helpers/owners.mjs";
import { REC, DEP, ISOLATED, PLANNED, FakeHost, bootManager, closeManagers } from "./helpers/hv-fake-manager.mjs";

const rpc = await fakeBaseRpc();                     // before host.mjs loads: nothing here reaches a public RPC
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
const { Host } = await import("../windows/node/host.mjs");
after(() => { closeManagers(); rpc.close(); });

const dep = () => ({ appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  leaseUntil: Math.floor(Date.now() / 1000) + 3600, cpuMilli: 100, gpuMilli: 0, isPublic: true,
  owner: "0x29479bf04ed889d46a7afb7f292b9bb26e12647c", configCid: ISOLATED });
const VANISHED = /isolation: the domain (\S+) recorded as serving is gone from the manager/;

async function serving(cfg = {}) {
  const host = new FakeHost();
  const m = await bootManager(host);
  const logs = [], scripts = [];
  // the Worker-Admin log as PowerShell would print it: the events naming THIS partition's VM, and one naming another
  const hyperVEventsRun = async (script) => {
    scripts.push(script);
    const vm = /-like '\*(enclave-app-[A-Za-z0-9]+)\*'/.exec(script)[1];
    return JSON.stringify([
      { time: "2026-10-14T03:52:30.1234567Z", id: 18502, message: `'${vm}-322c5206' was turned off. (Virtual machine ID 1B6A...)` },
      { time: "2026-10-14T03:52:29.0000000Z", id: 18515, message: `'${vm}-322c5206' was shut down for a reset\r\ninitiated by the guest.` },
      { time: "2026-10-14T03:52:28.0000000Z", id: 18502, message: "'enclave-app-someoneelse0000-11111111' was turned off." },
    ]);
  };
  const h = servedOwner(new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-vanished-")), endpoint: "https://api.enclave.host/t/test",
    name: "test", appsEnabled: true, cpuPricePerSec6: 12, log: (s) => logs.push(s), isolationManager: `http://127.0.0.1:${m.port}`,
    isolationRuntimeId: REC.runtimeId, hyperVEventsRun, ...cfg }), "0x29479bf04ed889d46a7afb7f292b9bb26e12647c");
  h.cfg.secretsSign = async () => "0x" + "11".repeat(65); h.secrets.set(DEP, {});        // known: no staged secrets
  const r1 = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r1.status, "running", r1.reason);
  return { host, m, h, logs, scripts, first: h.records.get(DEP).isolation.instance };
}

test("an intermediate record that clears rec.isolation no longer hides a domain that vanished", async () => {
  const { m, h, logs, scripts, first } = await serving();
  assert.ok(Number.isFinite(h.records.get(DEP).isolation.startedAt), "the serving record carries its start time");
  h.records.set(DEP, { ...h.records.get(DEP), isolation: null, status: "provisioning" });   // the intermediate clear
  await m.manager.remove(first);                                                           // removed outside this node
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "running", r.reason);
  assert.notEqual(h.records.get(DEP).isolation.instance, first);
  const line = logs.find((l) => VANISHED.test(l));
  assert.ok(line, logs.join("\n"));
  assert.equal(VANISHED.exec(line)[1], first);
  await h.vanishedEvidence;
  const after = logs.slice(logs.indexOf(line) + 1);
  assert.match(after.find((l) => l.includes("last known:")), /started 20\d\d-.*Z, last seen serving 20\d\d-.*Z \(up at least \d+m\)/);
  const hv = after.filter((l) => / hyper-v /.test(l));
  assert.equal(hv.length, 2, "only the events naming its VM");
  assert.match(hv[0], /hyper-v 2026-10-14T03:52:29\.000Z event 18515: '.*' was shut down for a reset initiated by the guest\.$/);
  assert.match(hv[1], /hyper-v 2026-10-14T03:52:30\.123Z event 18502: /);
  const prefix = "enclave-app-" + first.replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  assert.ok(scripts[0].includes(`'*${prefix}*'`), "the query names the partition's VM prefix");
  assert.ok(scripts[0].includes("Microsoft-Windows-Hyper-V-Worker-Admin"));
});

test("the respawn path (the 03:52Z incident): its cleanup retire of the ENDED domain does not hide the vanish", async () => {
  const { host, m, h, logs, first } = await serving({ isolationRespawn: true });
  host.running()[0].state = "Off";
  assert.equal((await m.manager.sweepLiveness()).failed, 1);
  const r = await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.equal(r.status, "running", r.reason);
  assert.ok(logs.some((l) => /isolated domain retired \(respawn after the domain ended\)/.test(l)), logs.join("\n"));
  const line = logs.find((l) => VANISHED.test(l));
  assert.ok(line, logs.join("\n")); assert.equal(VANISHED.exec(line)[1], first);
  await h.vanishedEvidence;
  assert.equal(logs.filter((l) => / hyper-v /.test(l)).length, 2);
});

test("a domain this node retired itself (a forced relaunch) is not reported as vanished", async () => {
  const { h, logs, first } = await serving();
  const r = await h.ensureApp(DEP, dep(), { force: true, version: PLANNED });
  assert.equal(r.status, "running", r.reason);
  assert.notEqual(h.records.get(DEP).isolation.instance, first, "a new instance replaced it");
  assert.ok(logs.some((l) => /isolated domain retired \(forced relaunch\)/.test(l)), logs.join("\n"));
  assert.equal(logs.some((l) => VANISHED.test(l)), false, logs.join("\n"));
  assert.equal(h.vanishedEvidence, null, "no Hyper-V query was made");
});

test("the same domain seen again is not a vanish; a failing event query adds nothing to the log", async () => {
  const { m, h, logs, first } = await serving({ hyperVEventsRun: async () => { throw new Error("powershell missing"); } });
  await h.ensureApp(DEP, dep(), { version: PLANNED });                 // adopted: the same instance
  assert.equal(h.records.get(DEP).isolation.instance, first);
  assert.equal(logs.some((l) => VANISHED.test(l)), false);
  await m.manager.remove(first);
  await h.ensureApp(DEP, dep(), { version: PLANNED });
  assert.ok(logs.some((l) => VANISHED.test(l)));
  await h.vanishedEvidence;
  assert.equal(logs.some((l) => / hyper-v/.test(l)), false, "nothing from a failed query");
});
