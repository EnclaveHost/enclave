// A partition that stops BY ITSELF must not read as running (G4 on nucbox-k11, run 082856: a type-1 guest whose PID 1
// dies panics, asks for a reset, and Hyper-V turns the VM OFF; wmiserve does not exit, so only a survey sees it).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Manager, startManager } from "./server.mjs";
import { HyperVPartitionBackend } from "./backend.mjs";
import { notesFor, boundaryFor } from "./wmi-launcher.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(fs.readFileSync(path.join(HERE, "../../../isolation/contract/catalog/derive_vectors.json"), "utf8"));
const component = Buffer.from(v.component_hex, "hex");
const REC = v.ok[0].mapping.record;

function setup({ hangStart = false, hangStop = false } = {}) {
  const vms = new Map(); const stops = []; const reclaimed = [];
  let surveyFails = false, releaseStart = null, releaseStop = null;
  const launcher = {
    get boundary() { return boundaryFor("linux-direct"); },
    async preflight() { return { ok: true, checks: [] }; },
    async start(mapping, { instanceId, identity }) {
      if (hangStart) await new Promise((r) => { releaseStart = r; });
      const vmId = crypto.randomUUID();
      vms.set(vmId, { vmId, name: "enclave-app-" + instanceId, state: "Running", notes: notesFor({ ...identity, instanceId }) });
      const run = { stop: async () => { stops.push(vmId); return { closed: true }; }, exited: new Promise(() => {}) };
      return { instanceId, vmId, name: "enclave-app-" + instanceId, state: "Running", appReady: true, boundary: this.boundary,
               guest: { booted: true }, wmiserve: run };
    },
    async stop(h) { if (hangStop) await new Promise((r) => { releaseStop = r; }); vms.delete(h.vmId); return { removed: true }; },
    async survey() { if (surveyFails) throw new Error("Get-VM failed"); return { vms: [...vms.values()] }; },
  };
  const m = new Manager({ runtimeId: REC.runtimeId, fetchComponent: async () => component, backend: new HyperVPartitionBackend({ launcher }) });
  m.onReclaim = (id, why) => reclaimed.push([id, why]);
  return { m, vms, stops, reclaimed, setSurveyFails: (x) => { surveyFails = x; }, releaseStart: () => releaseStart && releaseStart(), releaseStop: () => releaseStop && releaseStop() };
}
const body = (name) => ({ derive: REC, name, isPublic: true, hasSecrets: false });

test("a VM that goes Off by itself fails its domain, stops its relay, reclaims its sessions, and is LEFT for the node", async () => {
  const t = setup(); await startManager(t.m);
  const r = await t.m.spawn(body("0x" + "a1".repeat(32)));
  assert.equal(t.m.get(r.id).status, "running");
  assert.deepEqual(await t.m.sweepLiveness(), { checked: 1, failed: 0 }, "a Running VM is left alone");
  const vm = [...t.vms.values()][0]; vm.state = "Off";
  assert.deepEqual(await t.m.sweepLiveness(), { checked: 1, failed: 1 });
  const g = t.m.get(r.id);
  assert.equal(g.status, "failed");
  assert.match(g.reason, /the partition is Off: it stopped by itself/);
  assert.deepEqual(t.stops, [vm.vmId], "its relay is stopped");
  assert.equal(t.reclaimed.length, 1);
  assert.equal(t.vms.has(vm.vmId), true, "the VM is NOT removed here: the node retires it through a stop");
  assert.deepEqual(await t.m.sweepLiveness(), { checked: 0, failed: 0 }, "a failed record is not failed twice");
});

test("a VM that is gone from a SUCCESSFUL survey fails its domain; a FAILED survey changes nothing", async () => {
  const t = setup(); await startManager(t.m);
  const r = await t.m.spawn(body("0x" + "a2".repeat(32)));
  t.vms.clear();
  t.setSurveyFails(true);
  const e = await t.m.sweepLiveness();
  assert.match(e.error, /Get-VM failed/);
  assert.equal(t.m.get(r.id).status, "running", "unknown is not gone");
  t.setSurveyFails(false);
  await t.m.sweepLiveness();
  assert.match(t.m.get(r.id).reason, /no longer on this host/);
});

test("a record mid-start (no handle yet) and a record being stopped are left alone", async () => {
  const t = setup({ hangStart: true }); await startManager(t.m);
  const p = t.m.spawn(body("0x" + "a3".repeat(32)));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await t.m.sweepLiveness(), { checked: 0, failed: 0 }, "a start in progress has no VM to judge");
  t.releaseStart(); const r = await p;
  const u = setup({ hangStop: true }); await startManager(u.m);
  const r2 = await u.m.spawn(body("0x" + "a4".repeat(32)));
  const rm = u.m.remove(r2.id);
  await new Promise((res) => setImmediate(res));
  [...u.vms.values()][0].state = "Off";
  assert.deepEqual(await u.m.sweepLiveness(), { checked: 0, failed: 0 }, "a stop under way owns the record");
  u.releaseStop(); await rm;
  assert.ok(r.id);
});

test("a RECOVERED domain whose VM is Off fails too, so the node retires it rather than holding it forever", async () => {
  const t = setup();
  const vmId = crypto.randomUUID();
  t.vms.set(vmId, { vmId, name: "enclave-app-rec", state: "Off", notes: notesFor({ id: "hv" + "c".repeat(32), name: "0x" + "b1".repeat(32), instanceId: "rec" }) });
  await startManager(t.m);
  const rec = t.m.get("hv" + "c".repeat(32));
  assert.equal(rec.recovered, true);
  await t.m.sweepLiveness();
  assert.equal(t.m.get("hv" + "c".repeat(32)).status, "failed");
});
