// A restarted manager must not mistake "not in my memory" for "absent" (enclave-63's carry-over list,
// P1/P1b/P2/P3/P4). Hyper-V outlives this process: the fake below keeps its VMs across Manager instances,
// exactly as the real host does, and uses the launcher's REAL Notes encoding.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Manager, createServer, ID_RE } from "./server.mjs";
import { WmiHyperVLauncher, CMD, notesFor, parseNotes, OWNER_MARKER, MANAGER_NOTES_PREFIX } from "./wmi-launcher.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(fs.readFileSync(path.join(HERE, "../../../isolation/contract/catalog/derive_vectors.json"), "utf8"));
const component = Buffer.from(v.component_hex, "hex");
const REC = v.ok[0].mapping.record;
const DEP = "0x" + "e6".repeat(32);
const body = (over = {}) => ({ derive: REC, name: DEP, isPublic: true, hasSecrets: false, ...over });

/** Hyper-V, as far as the manager can see it: VMs keyed by Id, with names and Notes, outliving managers. */
function fakeHost({ failSurvey = false } = {}) {
  const vms = new Map();
  const backend = {
    backend: "hyperv-partition-per-app", supports: {}, canSurvey: true,
    boundary: { tier: "t0-hv", hostExcluded: false },
    async start(_mapping, { instanceId, identity }) {
      const vmId = crypto.randomUUID(), name = "enclave-app-" + instanceId;
      vms.set(vmId, { vmId, name, state: "Running", notes: identity ? notesFor({ ...identity, instanceId }) : OWNER_MARKER });
      return { name, vmId, state: "Running", guest: { booted: true, bytes: 1 }, appReady: false };
    },
    // BY ID only: a stop that arrives with a name alone is exactly what P2 forbids.
    async stop(handle) {
      if (!handle || !handle.vmId) throw new Error("this host acts by VM Id; a name is not an identity");
      vms.delete(handle.vmId); return { stopped: true, removed: true };
    },
    async survey() { if (failSurvey) throw new Error("WMI is unavailable"); return { vms: [...vms.values()] }; },
  };
  return { vms, backend };
}
const mk = (backend, over = {}) => new Manager({ runtimeId: REC.runtimeId, fetchComponent: async () => component, backend, ...over });

test("P1: a restarted manager recovers its VM from the Notes; it is listed, blocks a second spawn, and is removed by Id", async () => {
  const host = fakeHost();
  const m1 = mk(host.backend);
  await m1.recover();
  const first = await m1.spawn(body());
  assert.match(first.id, /^hv[0-9a-f]{32}$/);
  assert.equal(host.vms.size, 1);

  // The manager process restarts. The VM does not.
  const m2 = mk(host.backend);
  assert.notEqual(m2.epoch, m1.epoch, "a new process states a new epoch");
  await assert.rejects(m2.spawn(body()), (e) => e.status === 503, "before the survey it answers nothing about what exists");
  await assert.rejects(m2.remove(first.id), (e) => e.status === 503, "and never 'absent' for an id it merely does not remember");

  const inv = await m2.recover();
  assert.deepEqual([inv.state, inv.recovered, inv.unattributed], ["ready", 1, 0]);
  const got = m2.get(first.id);
  assert.ok(got, "the id survives the restart, because it is in the VM's Notes");
  assert.equal(got.name, DEP);
  assert.equal(got.recovered, true);
  assert.equal(got.status, "starting", "alive and NOT serving: never `failed` (the node reads that as ended, lease free) nor `running` (unverified)");
  assert.equal(got.appReady, false);
  assert.match(got.reason, /recovered after a manager restart.*will NOT become running under this manager/);

  const again = await m2.spawn(body()).then(() => null, (e) => e);
  assert.equal(again && again.status, 409, "reconcile's spawn must not start a SECOND VM for the same deployment");
  assert.equal(again.id, first.id, "the 409 names the recovered instance to adopt");
  assert.equal(host.vms.size, 1);

  assert.deepEqual(await m2.remove(first.id), { removed: true, absent: false });
  assert.equal(host.vms.size, 0, "removal acted on the VM itself, by its Id");
  assert.deepEqual(await m2.remove(first.id), { removed: false, absent: true }, "now 'absent' is true: surveyed AND removed");
});

test("P1b: after a restart, retire-by-name finds the deployment instead of reading 'no domain' and freeing the lease", async () => {
  const host = fakeHost();
  const m1 = mk(host.backend); await m1.recover();
  await m1.spawn(body());
  const m2 = mk(host.backend); await m2.recover();
  const byName = m2.list().filter((r) => r.name === DEP);
  assert.equal(byName.length, 1, "findByName would see it; the lifecycle then removes it rather than releasing a lease over a running VM");
});

test("an owned VM that names no deployment blocks EVERY spawn until it is removed", async () => {
  const host = fakeHost();
  host.vms.set("11111111-2222-3333-4444-555555555555", { vmId: "11111111-2222-3333-4444-555555555555", name: "enclave-app-old", state: "Running", notes: OWNER_MARKER });
  const m = mk(host.backend);
  const inv = await m.recover();
  assert.equal(inv.unattributed, 1);
  const orphan = m.list().find((r) => r.unattributed);
  assert.ok(orphan && orphan.id.startsWith("orphan-"));
  const e = await m.spawn(body()).then(() => null, (x) => x);
  assert.equal(e && e.status, 503, "never guessed at: it could be this deployment's VM");
  assert.match(e.message, /name no deployment/);
  assert.deepEqual(await m.remove(orphan.id), { removed: true, absent: false });
  assert.equal(host.vms.size, 0);
  const r = await m.spawn(body());
  assert.equal(r.status, "starting");
});

test("a survey that fails keeps the gate shut: over HTTP every /vms answer is 503, never 404", async () => {
  const host = fakeHost({ failSurvey: true });
  const m = mk(host.backend);
  const inv = await m.recover();
  assert.equal(inv.state, "failed");
  const srv = createServer(m);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    for (const [method, p] of [["GET", "/vms/hv" + "0".repeat(32)], ["DELETE", "/vms/hv" + "0".repeat(32)], ["GET", "/vms"]]) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { method });
      assert.equal(res.status, 503, `${method} ${p} must not answer 404 or an empty list while the inventory is unknown`);
      const j = await res.json();
      assert.equal(j.error, "inventory_unavailable");
      assert.equal(j.inventory.state, "failed");
    }
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(h.inventory.state, "failed"); assert.match(h.managerEpoch, /^[0-9a-f]{32}$/);
  } finally { srv.close(); }
});

test("P3: a stale readiness verdict touches only the record it was judged for, never a new one under the same id", async () => {
  const host = fakeHost();
  // One gate PER judgement, and the FIRST domain's verdict is a FAILURE: the harm P3 names is that a
  // stale failure reclaims (closes the data-plane sessions of) whatever NOW holds that id.
  const gates = [];
  const judgeReady = async () => { const g = {}; g.p = new Promise((r) => { g.release = r; }); gates.push(g); await g.p;
                                   return { status: "failed", reason: "the first domain failed", checks: {} }; };
  const b = { ...host.backend, async start(mapping, o) { const h = await host.backend.start(mapping, o); return { ...h, tcpPort: 40001, launcherVmId: h.vmId }; } };
  const m = mk(b, { judgeReady });
  const reclaims = [];
  m.onReclaim = (id, why) => reclaims.push(`${id}:${why}`);
  await m.recover();
  await m.spawn(body({ id: "hv-caller-a" }));
  const judgedFirst = m.judging.get("hv-caller-a");
  await m.remove("hv-caller-a");
  await m.spawn(body({ id: "hv-caller-a" }));            // a NEW record under the same caller-chosen id
  const second = m.domains.get("hv-caller-a");
  assert.equal(gates.length, 2, "each domain is judged separately");
  reclaims.length = 0;
  gates[0].release();                                    // ONLY the first domain's (stale) verdict arrives
  await judgedFirst;
  assert.deepEqual(reclaims, [], "the stale failure must not close the new domain's sessions");
  assert.equal(second.status, "starting", "nor fail the new domain");
  assert.equal(second.reason === "the first domain failed", false);
});

test("P4: minted ids are 128 bits and unique; a caller id outside the route validator's shape is refused", async () => {
  const host = fakeHost();
  const m = mk(host.backend); await m.recover();
  const ids = new Set();
  for (let i = 0; i < 20; i++) { const r = await m.spawn(body({ name: "0x" + i.toString(16).padStart(64, "0") })); ids.add(r.id); assert.match(r.id, /^hv[0-9a-f]{32}$/); }
  assert.equal(ids.size, 20);
  const e = await m.spawn(body({ name: "0x" + "ab".repeat(32), id: "bad id!" })).then(() => null, (x) => x);
  assert.equal(e && e.status, 400);
  assert.ok(ID_RE.test("hv" + "0".repeat(32)));
});

test("the launcher writes the identity into the Notes and reads it back; anything else is not an identity", () => {
  const id = { id: "hv" + "1".repeat(32), name: DEP, instanceId: "hv1111-deadbeef", appId: "ab".repeat(32) };
  const n = notesFor(id);
  assert.ok(n.startsWith(MANAGER_NOTES_PREFIX));
  assert.deepEqual(parseNotes(n), { owned: true, identity: { v: 1, ...id } });
  assert.deepEqual(parseNotes(OWNER_MARKER), { owned: true, identity: null }, "the bare marker: ours, unattributed");
  assert.deepEqual(parseNotes(MANAGER_NOTES_PREFIX + "!!not-base64-json"), { owned: true, identity: null });
  assert.deepEqual(parseNotes(MANAGER_NOTES_PREFIX + Buffer.from(JSON.stringify({ v: 1, id: "x" })).toString("base64url")),
                   { owned: true, identity: null }, "a partial identity is no identity");
  assert.deepEqual(parseNotes(OWNER_MARKER + "-imposter"), { owned: false, identity: null });
  assert.deepEqual(parseNotes("somebody else's VM"), { owned: false, identity: null });
  assert.throws(() => notesFor({ id: "", name: DEP, instanceId: "x" }));
});

test("P2: the launcher stops and removes by VM Id, checks ownership first, and never acts on a name", async () => {
  const s = CMD.removeById({ vmId: "11111111-2222-3333-4444-555555555555" });
  assert.match(s, /Get-VM -Id '11111111-2222-3333-4444-555555555555'/);
  assert.match(s, /not ours: the ownership marker is absent/);
  assert.match(s, /StartsWith\('enclave-vbslike-app-domain\/manager\|'\)/);
  assert.match(s, /-ne 'Off'/, "waits for Off before Remove-VM");
  assert.doesNotMatch(s, /-Name /);
  const scripts = [];
  const l = new WmiHyperVLauncher({ run: async (x) => { scripts.push(x); return { code: 0, stdout: JSON.stringify({ found: true, removed: true }), stderr: "" }; },
                                    imagePath: "C:\\img.bin", imageSha256: "0".repeat(64) });
  const r = await l.stop({ name: "enclave-app-x", vmId: "11111111-2222-3333-4444-555555555555" });
  assert.equal(r.removed, true);
  assert.equal(scripts.length, 1); assert.match(scripts[0], /Get-VM -Id/); assert.doesNotMatch(scripts[0], /Stop-VM -Name/);
  await assert.rejects(l.stop({ name: "x", vmId: "not-a-guid' ; Remove-VM *" }), /not a VM Id/, "an Id is validated before it reaches PowerShell");
  const stuck = new WmiHyperVLauncher({ run: async () => ({ code: 0, stdout: JSON.stringify({ found: true, removed: false, error: "InvalidState" }), stderr: "" }),
                                        imagePath: "C:\\img.bin", imageSha256: "0".repeat(64) });
  await assert.rejects(stuck.stop({ name: "x", vmId: "11111111-2222-3333-4444-555555555555" }), (e) => e.code === "stop_failed",
                       "a VM that is still there after removal is a failure, never 'stopped'");
});

test("the survey covers the prefix AND any VM carrying the manager's identity Notes, with its Id", () => {
  const s = CMD.survey({ prefix: "enclave-app-" });
  assert.match(s, /StartsWith\('enclave-app-'\)/);
  assert.match(s, /StartsWith\('enclave-vbslike-app-domain\/manager\|'\)/);
  assert.match(s, /vmId=\$_\.Id\.Guid/);
  // the type-1 definition writes the identity where the old New-VM create did
  assert.match(CMD.defineType1({ name: "n", memMiB: 256, vcpus: 1, notes: notesFor({ id: "hvx", name: DEP, instanceId: "i-1" }),
                                 firmware: "C:\\img.bin", firmwareSha256: "0".repeat(64), hypervModule: "C:\\hyperv.psm1",
                                 hypervModuleSha256: "1".repeat(64), guestStateMaster: "C:\\m.vmgs", guestStateRun: "C:\\n.vmgs",
                                 archiveDir: "C:\\a", pipe: "\\\\.\\pipe\\n-com1", boot: "linux-direct" }),
               /Set-VM -VM \$vm -Notes 'enclave-vbslike-app-domain\/manager\|/);
});

test("while an unattributed VM exists, an unknown id is UNKNOWN (503), never 'absent': the upgrade path", async () => {
  // A reviewer's finding: after an upgrade, a VM carrying only the bare legacy marker is recovered as unattributed.
  // If the manager then answered 404 for the id a node still holds, retire would read "confirmed gone" while that
  // VM - which may be exactly the one it means - is still running.
  const host = fakeHost();
  host.vms.set("11111111-2222-3333-4444-555555555555", { vmId: "11111111-2222-3333-4444-555555555555", name: "enclave-app-legacy", state: "Running", notes: OWNER_MARKER });
  const m = mk(host.backend);
  await m.recover();
  const heldByNode = "hv" + "a".repeat(32);            // the id a node recorded under the previous manager
  await assert.rejects(m.remove(heldByNode), (e) => e.status === 503 && /may be one of them/.test(e.message));
  assert.equal(host.vms.size, 1, "nothing was removed on a guess");
  const srv = createServer(m);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`http://127.0.0.1:${port}/vms/${heldByNode}`, { method });
      assert.equal(res.status, 503, `${method} of an unknown id must not answer 404 while an unattributed VM exists`);
      const j = await res.json();
      assert.deepEqual(j.unattributed, ["orphan-11111111-2222-3333-4444-555555555555"]);
    }
    // once the unattributed VM is removed, absence can be asserted again
    const orphan = m.list().find((r) => r.unattributed);
    assert.deepEqual(await m.remove(orphan.id), { removed: true, absent: false });
    assert.equal((await fetch(`http://127.0.0.1:${port}/vms/${heldByNode}`)).status, 404);
    assert.deepEqual(await m.remove(heldByNode), { removed: false, absent: true });
  } finally { srv.close(); }
});

test("an id THIS manager removed (confirmed gone by VM Id) is absent even while an orphan exists, so retires can confirm", async () => {
  // The reviewer's follow-up finding 1: with an orphan on the box, the node's post-DELETE re-read got 503 forever and
  // no retire could ever be confirmed. An id this process removed and saw gone is KNOWN absent.
  const host = fakeHost();
  const m1 = mk(host.backend); await m1.recover();
  const r = await m1.spawn(body());                     // one attributed VM...
  host.vms.set("11111111-2222-3333-4444-555555555555", { vmId: "11111111-2222-3333-4444-555555555555", name: "enclave-app-legacy", state: "Running", notes: OWNER_MARKER });
  const m = mk(host.backend); await m.recover();        // ...and, after a restart, one orphan beside it
  assert.equal(m.inventory.unattributed, 1);
  assert.deepEqual(await m.remove(r.id), { removed: true, absent: false });
  assert.deepEqual(await m.remove(r.id), { removed: false, absent: true }, "removed by this process: absent is known");
  const srv = createServer(m);
  await new Promise((x) => srv.listen(0, "127.0.0.1", x));
  const port = srv.address().port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/vms/${r.id}`)).status, 404, "the node's confirming re-read gets 404");
    assert.equal((await fetch(`http://127.0.0.1:${port}/vms/hv${"b".repeat(32)}`)).status, 503, "an id it never saw is still unknown");
  } finally { srv.close(); }
});
