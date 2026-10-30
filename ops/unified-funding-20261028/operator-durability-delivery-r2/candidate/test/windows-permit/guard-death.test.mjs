// permit r1 acceptance (AUTHORED, NOT RUN). Process-death behaviour with REAL separate processes: the guard (guard-main.mjs,
// TEST backend/exclusion) and, for manager death, a real ProtectedManager composition in a child process that is SIGKILLed.
// No in-process callback stands in for the guard. Linux process semantics only: Windows service/pipe/Hyper-V behaviour is
// WINDOWS-ACCEPTANCE-PERMIT.md W3-W6, not shown here.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { notesFor } from "../../control/windows/vbslike/manager/wmi-launcher.mjs";
import { GuardClient } from "../../control/windows/vbslike/guard/guard-client.mjs";
import { rig, tmp, startGuard, waitFor, readInv, writeInv, selfIdentity } from "./helpers/world.mjs";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers/manager-child.mjs");
const legacyNeighbor = () => ({ vmId: crypto.randomUUID(), name: "enclave-legacy-neighbor", state: "Running",
  notes: notesFor({ id: "hv" + "1".repeat(32), name: "0x" + "99".repeat(32), instanceId: "legacy-neighbor", appId: null }) });

test("manager process death: the independent guard removes exactly the protected VM; the legacy neighbor is untouched", async (t) => {
  const dir = tmp(t), inv = path.join(dir, "inventory.json"), neighbor = legacyNeighbor();
  writeInv(inv, { vms: [neighbor] });
  const child = spawn(process.execPath, [CHILD, dir], { stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  const line = await waitFor(() => out.split("\n").find((l) => l.startsWith("{")), 20_000);
  const info = JSON.parse(line);
  t.after(() => { try { process.kill(info.guardPid, "SIGKILL"); } catch {} });
  assert.equal(info.serving, true, line);
  assert.ok(readInv(inv).vms.some((v) => v.vmId === info.vmId));
  child.kill("SIGKILL");
  await waitFor(() => !readInv(inv).vms.some((v) => v.vmId === info.vmId), 15_000);
  assert.ok(readInv(inv).vms.some((v) => v.vmId === neighbor.vmId), "legacy VM untouched");
});

test("guard death while serving: access is withdrawn at once, capability goes false, the manager removes compute itself", async (t) => {
  const w = await rig(t);
  const st = await w.stage(); const id = st.body.instanceId; await w.staged(id);
  assert.equal((await w.serve(id)).status, 200);
  const s = await w.splice(id); assert.match(s.got(), /^OK/);
  const vmId = w.journal.instance(id).vmId;
  w.g.proc.kill("SIGKILL");
  await waitFor(() => s.closed(), 3000);
  const c = w.enforcement.capability();
  assert.equal(c.available, false); assert.ok(c.reasons.some((r) => /guard unavailable/.test(r)));
  await waitFor(() => !w.vms().some((v) => v.vmId === vmId), 10_000);
  assert.equal((await w.stage()).status, 503, "no new protected admission without the guard");
});

test("guard restart over its own journal: no lifetime is continued, the armed VM is removed, the neighbor stays", async (t) => {
  const dir = tmp(t), inv = path.join(dir, "inventory.json"), neighbor = legacyNeighbor();
  const id = "pp" + crypto.randomBytes(16).toString("hex"), vmId = crypto.randomUUID();
  writeInv(inv, { vms: [neighbor, { vmId, name: "enclave-" + id.slice(0, 16), state: "Running", notes: notesFor({ id, name: "0x" + "e6".repeat(32), instanceId: id.slice(0, 16), appId: null }) }] });
  const journal = path.join(dir, "guard-fixed.log"), key = crypto.randomBytes(32);
  const g1 = await startGuard(t, dir, { inventory: inv, journal, key });
  const c = await GuardClient.connect({ path: g1.socket, key, identity: { ...selfIdentity(), epoch: crypto.randomBytes(16).toString("hex") } });
  await c.call("register", { instanceId: id, deployment: "0x" + "e6".repeat(32), appId: null, launchEpoch: crypto.randomBytes(16).toString("hex"), wallUntil: Date.now() + 600_000, remainingMs: 600_000 });
  await c.call("bindVm", { instanceId: id, vmId });
  await assert.rejects(c.call("renew", { instanceId: id, permitDigest: "0x" + "11".repeat(32), wallUntil: Date.now() + 600_000, remainingMs: 600_000 }).then(() =>
    c.call("renew", { instanceId: id, permitDigest: "0x" + "11".repeat(32), wallUntil: Date.now() + 700_000, remainingMs: 600_000 })), /same permit/);
  g1.proc.kill("SIGKILL"); await waitFor(() => g1.proc.exitCode !== null || g1.proc.signalCode !== null, 5000);
  assert.ok(readInv(inv).vms.some((v) => v.vmId === vmId), "the guard died before acting");
  const g2 = await startGuard(t, dir, { inventory: inv, journal, key });
  await waitFor(() => !readInv(inv).vms.some((v) => v.vmId === vmId), 10_000);
  assert.ok(readInv(inv).vms.some((v) => v.vmId === neighbor.vmId));
  assert.match(g2.log(), /"kind":"removed"/);
});

test("the guard refuses a manager whose pid + creation time do not match, and a bad key", async (t) => {
  const dir = tmp(t), inv = path.join(dir, "inventory.json"); writeInv(inv, { vms: [] });
  const g = await startGuard(t, dir, { inventory: inv });
  await assert.rejects(GuardClient.connect({ path: g.socket, key: g.key, identity: { pid: process.pid, created: "TEST-proc-starttime-0", epoch: "0".repeat(32) } }));
  await assert.rejects(GuardClient.connect({ path: g.socket, key: crypto.randomBytes(32), identity: { ...selfIdentity(), epoch: "0".repeat(32) } }));
  const ok = await GuardClient.connect({ path: g.socket, key: g.key, identity: { ...selfIdentity(), epoch: "1".repeat(32) } });
  const st = await ok.call("status"); assert.equal(st.ready, true); assert.equal(st.exclusion, "TEST-in-process");
  ok.close();
});
