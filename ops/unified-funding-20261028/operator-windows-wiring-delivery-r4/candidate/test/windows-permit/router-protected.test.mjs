// permit r1 acceptance (AUTHORED, NOT RUN). The composite router's protected/control routes: strict parsing, no blanket
// passthrough, exact bytes + guestd-control/1 headers across the real io.mjs hop, response MAC verified END TO END by the
// real client through the router, and refusal before side effects when the composite inventory is unknown. The request
// stub in the second test is TEST and records calls only. A full stage THROUGH the router needs a native-manager double
// satisfying CompositeManager.snapshot (pools/CPU/desktop pins); that positive case is WINDOWS-ACCEPTANCE-PERMIT.md W7.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { routePath, CompositeManager, LaunchJournal } from "../../control/windows/vbslike/router/control.mjs";
import { makeRequest, controlServer } from "../../control/windows/vbslike/router/io.mjs";
import { GuestdControl } from "../../control/isolation/m4/guestd/control-client.mjs";
import { rig, tmp } from "./helpers/world.mjs";

const PP = "pp" + "ab".repeat(16);
const pins = { deployment: "0x" + "d0".repeat(32), catalogApp: "0x" + "d1".repeat(32), runtimeId: "d2".repeat(32), profileSha256: "d3".repeat(32),
  igvmSha256: "d4".repeat(32), controllerSha256: "d5".repeat(32), catalogVersion: 1, cid: "bafyTEST" };
function journalIn(t) { const f = path.join(tmp(t), "router.journal"); LaunchJournal.initialize(f); return new LaunchJournal(f); }

test("route parsing is exact for protected and control routes", () => {
  assert.equal(routePath("/control/hello").control, true);
  assert.equal(routePath("/protected/vms").stage, true);
  assert.deepEqual(routePath(`/protected/vms/${PP}/permit`).protectedOp, "permit");
  for (const bad of ["/protected/vms?x=1", `/protected/vms/${PP}/permit/`, `/protected/vms/%70${PP.slice(1)}/permit`, "/control/hello?a"])
    assert.throws(() => routePath(bad), (e) => e.status === 400 || e.status === 404, bad);
  assert.throws(() => routePath("/protected/vms/hv1234/permit"), (e) => e.status === 404);
  assert.throws(() => routePath("/vms/pp12"), (e) => e.status === 400, "short pp ids are not legacy ids");
  assert.equal(routePath(`/vms/${PP}`).role, "legacy");
});

test("composite handle: unauthenticated protected routes never reach a manager; authenticated ones are forwarded byte-exact", async (t) => {
  const calls = [];
  const request = async (...a) => { calls.push(a); return { status: 200, raw: Buffer.from("{}"), body: {}, headers: { "x-guestd-response-mac": "m" } }; };
  const c = new CompositeManager({ request, journal: journalIn(t), nativePins: pins, availableMemoryMiB: async () => 1 << 20 });
  assert.equal((await c.handle("POST", `/protected/vms/${PP}/permit`, Buffer.from("{}"), {})).status, 401);
  assert.equal(calls.length, 0);
  const auth = { "x-guestd-session": "s", "x-guestd-seq": "1", "x-guestd-mac": "a".repeat(64) }, raw = Buffer.from('{"envelope":1,  "x":2}');
  const r = await c.handle("POST", `/protected/vms/${PP}/permit`, raw, auth);
  assert.equal(r.headers["x-guestd-response-mac"], "m");
  assert.deepEqual(calls[0].slice(0, 3), ["legacy", "POST", `/protected/vms/${PP}/permit`]);
  assert.ok(calls[0][3].equals(raw), "body bytes are not re-serialized");
  await assert.rejects(c.handle("GET", "/vms/hv1234", undefined, auth), (e) => e.status === 404, "no blanket authenticated passthrough");
  await assert.rejects(c.handle("POST", "/vms", { id: PP, name: "0x" + "e6".repeat(32), derive: { catalog: { app: "a", version: 1 } } }, {}), (e) => e.status === 400);
});

test("guestd-control/1 survives the real router hop; the router refuses a stage before side effects when inventory is unknown", async (t) => {
  const w = await rig(t);
  const port = Number(new URL(w.base).port);
  const journal = journalIn(t);
  const c = new CompositeManager({ request: makeRequest({ legacyPort: port, nativePort: port }), journal, nativePins: pins, availableMemoryMiB: async () => 1 << 20 });
  const srv = controlServer(c); await new Promise((r) => srv.listen(0, "127.0.0.1", r)); t.after(() => srv.close());
  const viaRouter = new GuestdControl(`http://127.0.0.1:${srv.address().port}`, w.pairing);
  const h = await viaRouter.request("GET", "/health");
  assert.equal(h.status, 200); assert.equal(h.body.permitEnforcement.available, true, "response MAC verified through the router");
  const miss = await viaRouter.request("POST", `/protected/vms/${PP}/hold`, undefined, { idempotent: false });
  assert.equal(miss.status, 404, "a signed refusal for an unknown instance");
  await assert.rejects(viaRouter.request("POST", "/protected/vms", w.stageBody(), { idempotent: false }), /MAC|refused|unknown/);
  assert.equal(journal.pending(), false, "no launch latch without a known composite inventory");
  assert.equal(w.journal.instances().length, 0, "nothing reached the manager");
});
