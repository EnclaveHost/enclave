// permit r1 acceptance (AUTHORED, NOT RUN). The installed baseline's three legacy tests with their EXACT assertions, run
// against the unchanged server.mjs Manager AND against ProtectedManager (default: no enforcement composed), plus managed
// refusal cases. TEST launch/readiness only: no Windows, partition, attestation or production channel.
import test from "node:test";
import assert from "node:assert/strict";
import { Manager, createServer } from "../../control/windows/vbslike/manager/server.mjs";
import { HyperVPartitionBackend } from "../../control/windows/vbslike/manager/backend.mjs";
import { ProtectedManager } from "../../control/windows/vbslike/manager/protected-manager.mjs";
import { vectors, rig } from "./helpers/world.mjs";

const { record, component } = vectors();
async function legacyRig(t, Klass) {
  let stops = 0; const backend = new HyperVPartitionBackend({ launch: async () => ({ appReady: true, stop: async () => { stops++; } }) });
  const manager = new Klass({ backend, runtimeId: record.runtimeId, fetchComponent: async () => component });
  const server = createServer(manager); await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) }); return { status: r.status, body: await r.json() }; };
  return { manager, request, stops: () => stops };
}
const spawn = { derive: record, name: "0x" + "e6".repeat(32), isPublic: true, hasSecrets: false };

for (const Klass of [Manager, ProtectedManager]) {
  test(`${Klass.name}: current manager reports readiness capabilities, never claims continuing lifecycle deadline enforcement`, async (t) => {
    const r = await legacyRig(t, Klass), h = await r.request("GET", "/health"); assert.equal(h.status, 200); assert.equal(h.body.backend, "hyperv-partition-per-app");
    assert.notEqual(h.body.supports?.lifecyclePermit, true); assert.notEqual(h.body.supports?.servingPermit, true); assert.notEqual(h.body.expiryEnforced, true);
    assert.notEqual(h.body.supports?.permitEnforcement, true);
  });
  test(`${Klass.name}: legacy start/read/explicit stop still works through exact-source HTTP without treating readiness as a permit`, async (t) => {
    const r = await legacyRig(t, Klass), created = await r.request("POST", "/vms", spawn); assert.equal(created.status, 201); assert.equal(created.body.status, "running"); assert.equal(created.body.appReady, true);
    assert.notEqual(created.body.expiryEnforced, true); const id = created.body.id;
    assert.equal((await r.request("GET", "/vms/" + id)).status, 200);
    assert.equal((await r.request("DELETE", "/vms/" + id)).status, 200); assert.equal(r.stops(), 1);
    assert.equal((await r.request("GET", "/vms/" + id)).status, 404);
  });
  test(`${Klass.name}: unimplemented deadline endpoint refuses; HTTP success on legacy VM is not an enforcement acknowledgment`, async (t) => {
    const r = await legacyRig(t, Klass), created = await r.request("POST", "/vms", spawn); assert.equal(created.status, 201);
    const answer = await r.request("POST", "/vms/" + created.body.id + "/permit", { TEST_ONLY: true, generation: 1, validUntil: Date.now() + 100, hostAuthority: "0x" + "11".repeat(32) });
    assert.equal(answer.status, 404); assert.equal(answer.body.error, "not_found");
    assert.equal((await r.request("GET", "/vms/" + created.body.id)).body.status, "running", "unsupported extension must not mutate legacy tenant");
    await r.request("DELETE", "/vms/" + created.body.id); assert.equal(r.stops(), 1);
  });
}

test("missing guard or missing authority reader: capability false with the exact reason, stage refused, legacy unaffected", async (t) => {
  const w = await rig(t, { withGuard: false });
  const h = await w.plain("GET", "/health");
  assert.equal(h.body.permitEnforcement.available, false); assert.equal(h.body.supports.permitEnforcement, false);
  assert.ok(h.body.permitEnforcement.reasons.some((x) => /guard/.test(x)));
  assert.equal((await w.stage()).status, 503);
  assert.equal(w.journal.instances().length, 0, "nothing staged, nothing started");
  w.enforcement.authority = null;
  assert.ok(w.enforcement.capability().reasons.some((x) => /authority reader/.test(x)));
  const legacy = await w.plain("POST", "/vms", w.spawnBody);
  assert.equal(legacy.status, 201); assert.equal(legacy.body.protected, undefined);
});
