// permit r1 acceptance (AUTHORED, NOT RUN - root executes). Real installed-source manager HTTP through createProtectedServer,
// real guestd-control/1 client/server, real r18 gate + typed signatures, real splice data plane, guard as a real process.
// TEST doubles are labelled in helpers/world.mjs. Linux results prove portable logic only, never Windows/Hyper-V behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { GuestdControl } from "../../control/isolation/m4/guestd/control-client.mjs";
import { rig, permitRecord, envelope, digestOf, WITNESSES, waitFor, hostAuthority, DEPLOYMENT } from "./helpers/world.mjs";

const gone = (w, vmId) => !w.vms().some((v) => v.vmId === vmId);
async function served(t, opts) {
  const w = await rig(t, opts);
  const st = await w.stage(); assert.equal(st.status, 202, JSON.stringify(st.body));
  const id = st.body.instanceId; await w.staged(id);
  return { w, id };
}

test("capability is TEST-qualified and complete; legacy spawn can neither opt in nor imitate a protected id", async (t) => {
  const w = await rig(t);
  const h = await w.plain("GET", "/health");
  assert.equal(h.body.permitEnforcement.available, true, JSON.stringify(h.body.permitEnforcement));
  assert.equal(h.body.permitEnforcement.qualification, "TEST-ONLY-NOT-WINDOWS");
  for (const extra of [{ protected: true }, { expiryEnforced: true }, { proofVerified: true }, { validUntil: Date.now() + 1e6 }])
    assert.equal((await w.plain("POST", "/vms", { ...w.spawnBody, ...extra })).status, 400);
  assert.equal((await w.plain("POST", "/vms", { ...w.spawnBody, id: "pp" + "0".repeat(32) })).status, 400);
  assert.equal((await w.plain("POST", "/protected/vms", w.stageBody())).status, 401, "loopback origin is not authentication");
  assert.equal((await w.plain("POST", "/vms/x/permit", {})).status, 404, "the installed handler still has no permit route");
});

test("authorized opt-in: staged ownership before serving, then an owner-selected quorum serves under Enclave-witness refusal", async (t) => {
  const { w, id } = await served(t);
  const r = w.journal.instance(id);
  assert.equal(r.state, "staged"); assert.ok(r.vmId);
  const staged = await w.splice(id); assert.match(staged.got(), /^NO /, "no data while staged"); staged.c.destroy();
  assert.equal((await w.stage()).status, 409, "one protected instance per deployment");
  w.authority.s.state = "running"; w.authority.s.generation = r.generation;
  const rec = permitRecord({ generation: r.generation, sequence: 1, now: w.now });
  // Censorship resistance: the Enclave-operated witness (index 3) refuses; three independent owner-selected witnesses suffice.
  const ok = await w.permit(id, rec, { signers: WITNESSES.slice(0, 3) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  for (const [k, v] of Object.entries({ deployment: DEPLOYMENT, generation: r.generation, instanceId: id, vmId: r.vmId, permitDigest: digestOf(rec),
    hostAuthority: hostAuthority().digest, expiryEnforced: true, qualification: "TEST-ONLY-NOT-WINDOWS" })) assert.deepEqual(ok.body[k], v, k);
  assert.ok(ok.body.validUntil <= rec.validUntil * 1000 && ok.body.validUntil > Date.now());
  const s = await w.splice(id); assert.match(s.got(), /^OK\n/); s.c.write("ping"); await waitFor(() => s.got().includes("ping")); s.c.destroy();
});

test("forged/replayed/wrong-manager control requests are refused before side effects", async (t) => {
  const w = await rig(t);
  const stranger = new GuestdControl(w.base, crypto.randomBytes(32));
  await assert.rejects(stranger.request("POST", "/protected/vms", w.stageBody(), { idempotent: false }), /pairing key|refused|protocol/);
  await w.client.connect();
  const body = JSON.stringify(w.stageBody());
  const { headers } = w.client.sign("POST", "/protected/vms", body);
  const bad = await fetch(w.base + "/protected/vms", { method: "POST", headers: { ...headers, "x-guestd-mac": "0".repeat(64), "content-type": "application/json" }, body });
  assert.equal(bad.status, 401);
  const signed = w.client.sign("POST", "/protected/vms", body);
  const first = await fetch(w.base + "/protected/vms", { method: "POST", headers: { ...signed.headers, "content-type": "application/json" }, body });
  assert.equal(first.status, 202);
  const replay = await fetch(w.base + "/protected/vms", { method: "POST", headers: { ...signed.headers, "content-type": "application/json" }, body });
  assert.equal(replay.status, 401, "a recorded request is not accepted twice");
  assert.equal(w.journal.instances().length, 1, "exactly one staged instance");
  const q = await fetch(w.base + "/protected/vms?x=1", { method: "POST", headers: { ...w.client.sign("POST", "/protected/vms?x=1", body).headers, "content-type": "application/json" }, body });
  assert.equal(q.status, 404, "queries/aliases are refused even when MAC'd");
});

test("attachment must name exactly this instance: wrong GUID/epochs/app/runtime/image/generation/digest refuse", async (t) => {
  const { w, id } = await served(t);
  const r = w.journal.instance(id); w.authority.s.state = "running"; w.authority.s.generation = r.generation;
  const rec = permitRecord({ generation: r.generation, sequence: 1, now: w.now });
  for (const o of [{ vmId: crypto.randomUUID() }, { launchEpoch: "0".repeat(32) }, { managerEpoch: "1".repeat(32) }, { appId: "0".repeat(64) },
    { runtimeId: "0".repeat(64) }, { image: "0".repeat(64) }, { generation: r.generation + 1 }, { permitDigest: "0x" + "00".repeat(32) }, { instanceId: "pp" + "1".repeat(32) }]) {
    const a = await w.permit(id, rec, { overrides: o });
    assert.equal(a.status, 403, JSON.stringify(o));
  }
  const s = await w.splice(id); assert.match(s.got(), /^NO /); s.c.destroy();
  const wrongGen = await w.permit(id, permitRecord({ generation: r.generation + 1, sequence: 1, now: w.now }));
  assert.equal(wrongGen.status, 403);
});

test("signatures: below threshold and an unauthorized witness refuse; the staged instance is never served and stays owned", async (t) => {
  const { w, id } = await served(t);
  const r = w.journal.instance(id); w.authority.s.state = "running"; w.authority.s.generation = r.generation;
  const rec = permitRecord({ generation: r.generation, sequence: 1, now: w.now });
  assert.equal((await w.permit(id, rec, { signers: WITNESSES.slice(0, 2) })).status, 403, "below threshold");
  const { privateKeyToAccount } = await import("viem/accounts");
  const outsider = privateKeyToAccount("0x" + "77".repeat(32));
  assert.equal((await w.permit(id, rec, { signers: [WITNESSES[0], WITNESSES[1], outsider] })).status, 403, "unauthorized signer");
  const s = await w.splice(id); assert.match(s.got(), /^NO /); s.c.destroy();
  // r18 gate semantics: a refusal holds installed grants/resources; staged compute stays OWNED (deadline/close/Stop remove it)
  assert.equal(w.journal.instance(id).state, "staged");
  assert.equal((await w.plain("DELETE", `/vms/${id}`)).status, 200, "explicit Stop: confirmed absence before success");
  assert.ok(gone(w, r.vmId)); assert.equal(w.journal.instance(id).state, "removed");
});

test("Offline host authority withdraws a serving instance and refuses its renewal", async (t) => {
  const { w, id } = await served(t);
  assert.equal((await w.serve(id)).status, 200);
  const s = await w.splice(id); assert.match(s.got(), /^OK/);
  w.authority.s.online = false;
  const r = w.journal.instance(id);
  const renewal = await w.permit(id, permitRecord({ generation: r.generation, sequence: 2, now: w.now }));
  assert.equal(renewal.status, 403);
  await waitFor(() => s.closed(), 2000);
  await waitFor(() => gone(w, r.vmId), 8000);
});

test("the same envelope cannot extend; expiry closes existing streams, refuses new ones and removes exact compute", async (t) => {
  const { w, id } = await served(t);
  const r = w.journal.instance(id); w.authority.s.state = "running"; w.authority.s.generation = r.generation;
  const rec = permitRecord({ generation: r.generation, sequence: 1, now: w.now, lifeSec: 4 });
  const env = await envelope(rec), att = w.attachment(id, rec);
  const a = await w.client.request("POST", `/protected/vms/${id}/permit`, { envelope: env, attachment: att }, { idempotent: false });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const s = await w.splice(id); assert.match(s.got(), /^OK/);
  await new Promise((ok) => setTimeout(ok, 500));
  const b = await w.client.request("POST", `/protected/vms/${id}/permit`, { envelope: env, attachment: att }, { idempotent: false });
  if (b.status === 200) assert.ok(b.body.validUntil <= a.body.validUntil, "a replay never buys lifetime");
  await waitFor(() => s.closed(), 5000);
  const late = await w.splice(id); assert.ok(!/^OK/.test(late.got())); late.c.destroy();
  await waitFor(() => gone(w, r.vmId), 8000);
  await waitFor(() => w.journal.instance(id).state === "removed", 8000);
  assert.equal(w.journal.instance(id).confirmed.by, "survey");
});

test("a genuinely newer permit renews while allowed; an older sequence afterwards is refused and withdraws", async (t) => {
  const { w, id } = await served(t);
  assert.equal((await w.serve(id, { sequence: 1 })).status, 200);
  const r = w.journal.instance(id);
  assert.equal((await w.permit(id, permitRecord({ generation: r.generation, sequence: 2, now: w.now }))).status, 200);
  assert.equal(w.journal.read(DEPLOYMENT).sequence, 2);
  assert.equal((await w.permit(id, permitRecord({ generation: r.generation, sequence: 1, now: w.now }))).status, 403);
  await waitFor(() => gone(w, r.vmId), 8000);
});

test("wall-clock discontinuity (forward jump) closes the gate: no access, compute removed, capability off", async (t) => {
  let offset = 0;
  const { w, id } = await served(t, { now: () => Date.now() + offset });
  assert.equal((await w.serve(id)).status, 200);
  const vmId = w.journal.instance(id).vmId;
  offset = 10_000;
  const s = await w.splice(id); assert.ok(!/^OK/.test(s.got())); s.c.destroy();
  await waitFor(() => gone(w, vmId), 8000);
  assert.equal(w.enforcement.capability().available, false);
});

test("staging is bounded: no permit before the staging deadline means removal", async (t) => {
  const w = await rig(t);
  const st = await w.stage(1500); assert.equal(st.status, 202);
  const id = st.body.instanceId; await w.staged(id);
  const vmId = w.journal.instance(id).vmId;
  await waitFor(() => gone(w, vmId), 8000);
  await waitFor(() => w.journal.instance(id).state === "removed", 8000);
});

test("a launch that completes after its withdrawal is still removed (late startup completion)", async (t) => {
  let release; const gateStart = new Promise((r) => { release = r; });
  const w = await rig(t, { hooks: { start: () => gateStart } });
  const st = await w.stage(); assert.equal(st.status, 202);
  const id = st.body.instanceId;
  const held = await w.client.request("POST", `/protected/vms/${id}/hold`, undefined, { idempotent: false });
  assert.equal(held.status, 200);
  assert.equal(held.body.ingress, true);
  release();
  await waitFor(() => w.journal.instance(id).state === "removed", 10_000);
  assert.equal(w.vms().filter((v) => v.name.includes(id.slice(0, 16))).length, 0);
});

test("stop that hangs then fails: streams close at once, compute removal is retried and confirmed later", async (t) => {
  let hang = true;
  const { w, id } = await served(t, { hooks: { stop: async () => { if (hang) { hang = false; await new Promise((r) => setTimeout(r, 1500)); throw Error("TEST stop failure"); } } } });
  assert.equal((await w.serve(id)).status, 200);
  const s = await w.splice(id); assert.match(s.got(), /^OK/);
  const vmId = w.journal.instance(id).vmId;
  const t0 = Date.now();
  await w.client.request("POST", `/protected/vms/${id}/hold`, undefined, { idempotent: false });
  await waitFor(() => s.closed(), 1000);
  assert.ok(Date.now() - t0 < 1000, "access withdrawn before the hung stop returned");
  await waitFor(() => gone(w, vmId), 10_000);
  await waitFor(() => w.journal.instance(id).state === "removed", 10_000);
});

test("a verifier-delayed install that completes after a hold regains nothing", async (t) => {
  const { w, id } = await served(t);
  const r = w.journal.instance(id); w.authority.s.state = "running"; w.authority.s.generation = r.generation;
  let go; w.authority.s.delay = new Promise((x) => { go = x; });
  const rec = permitRecord({ generation: r.generation, sequence: 1, now: w.now });
  const pending = w.client.request("POST", `/protected/vms/${id}/permit`, { envelope: await envelope(rec), attachment: w.attachment(id, rec) }, { idempotent: false, timeoutMs: 300 }).catch((e) => e);
  assert.ok((await pending) instanceof Error, "the caller's request timed out (outcome unknown)");
  await w.client.request("POST", `/protected/vms/${id}/hold`, undefined, { idempotent: false });
  w.authority.s.delay = null; go();
  await waitFor(() => gone(w, r.vmId), 8000);
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(w.enforcement.serving.has(id), false, "the late install did not create a serving entry");
  const s = await w.splice(id); assert.ok(!/^OK/.test(s.got())); s.c.destroy();
});

test("restart: nothing protected is continued; recovery removes it and the floor survives the new owner", async (t) => {
  const { w, id } = await served(t);
  assert.equal((await w.serve(id)).status, 200);
  const vmId = w.journal.instance(id).vmId, seq = w.journal.read(DEPLOYMENT).sequence;
  w.g.proc.kill("SIGKILL"); w.guard.close(); w.log.release();    // the old owner and its guard are gone
  assert.throws(() => w.journal.read(DEPLOYMENT), /released/);
  const w2 = await rig(t, { dir: w.dir });
  assert.equal(w2.journal.read(DEPLOYMENT).sequence, seq, "floors are durable across owners");
  assert.equal(w2.manager.get(id)?.recovered ?? true, true, "a recovered protected VM is never adopted as serving");
  await w2.enforcement.recoverAtStartup();
  await waitFor(() => gone(w2, vmId), 10_000);
  assert.equal(w2.journal.instance(id).state, "removed");
});
