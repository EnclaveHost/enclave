// windows/vbslike/review/record-to-route.test.mjs: the manager's /vms record, as the node client sees it, fed to the
// datapath's admission. Three owners meet here: the Windows manager (windows/vbslike/manager, enclave-d1) produces the
// record, the node client (windows/node/isolation-client.mjs, enclave-d1) reads it into a view, and the guest lane's
// datapath (windows/vbslike/datapath/datapath.mjs, enclave-5d) admits a route on that view's status, appId, image,
// runtimeId, transportKeySha256 and relay. Independent review test (enclave-99, 2026-09-24), written so enclave-53 can pin
// its EXACT result: today the manager writes transportKeySha256: null (nothing calls judgeRunning from the spawn path
// yet) and status stays "starting", so the route is refused; when that wiring lands the same case admits.
//   run: node --test windows/vbslike/review/record-to-route.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Manager, createServer } from "../manager/server.mjs";
import { HcsPartitionBackend } from "../manager/backend-hcs.mjs";
import { IsolationManagerClient, instanceServing } from "../../node/isolation-client.mjs";
import { admit, parsePreamble, PROTO } from "../datapath/datapath.mjs";
import { judgeRunning } from "../manager/ready.mjs";
import { runtimeId } from "../../../isolation/contract/runtime.mjs";
import { FakeDomain, launcherKey, sha256hex, RUNTIME } from "./fake-domain.mjs";

const ROOT = new URL("../../../", import.meta.url);
const VEC = JSON.parse(fs.readFileSync(new URL("isolation/contract/catalog/derive_vectors.json", ROOT), "utf8"));
const V1 = VEC.ok.find((v) => v.name === "v1"), component = Buffer.from(VEC.component_hex, "hex"), APPID = V1.mapping.appId;
// the deployment record pins the RuntimeID of the identity the domain states (RUNTIME): what a real record carries
const RECORD = { ...V1.record, runtimeId: Buffer.from(runtimeId(RUNTIME)).toString("hex") };
const INITRD = "44abb52b1486dd2aae344e021a0d8049dfb2015d137c22a6e336051c4db5a0cf", DEP = "0x" + "d5".repeat(32);

/** lab.rs, faithfully: numeric ids, one JSON answer per command in order, the ready line naming the initrd. */
function labLauncher({ keyB64 = Buffer.alloc(32, 7).toString("base64"), relayPort = null } = {}) {
  let next = 1; const live = new Map();
  const make = () => {
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    const answer = (o) => setTimeout(() => p.stdout.emit("data", JSON.stringify(o) + "\n"), 0);
    p.stdin = { write: (s) => { const [cmd, a1] = s.trim().split(/\s+/);
      if (cmd === "load") { const id = next++; live.set(id, a1); return answer({ loaded: { id, label: a1, vmId: `GUID-${id}`, appSha256: APPID, guestId: `g${id}`, guestPort: 40000 + id, tcpPort: relayPort ?? 19000 + id } }); }
      if (cmd === "destroy") { const id = /^\d+$/.test(a1) ? Number(a1) : null; if (id === null) return answer({ error: "invalid digit found in string" }); if (!live.delete(id)) return answer({ error: "no such partition" }); return answer({ destroyed: a1, guest: { exit: 0 } }); }
      return answer({ error: "unknown command" }); }, end: () => {} };
    queueMicrotask(() => p.stdout.emit("data", JSON.stringify({ ready: true, launcherKey: keyB64, boundary: "tier=T0-hv partition=hcs-child isolation=none host_excluded=no", initrdSha256: INITRD, kernelSha256: "7f".repeat(32) }) + "\n"));
    return p;
  };
  return { make, live };
}
async function rig({ domain = null, judgeReady = null, readyDeadlineMs = 4000 } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "r2r-"));
  for (const f of ["vbslike-host.exe", "wsl-kernel", "mon.cpio.gz"]) await fsp.writeFile(path.join(dir, f), "x");
  const L = labLauncher(domain ? { keyB64: domain.signer.keyB64, relayPort: domain.port } : {});
  const backend = new HcsPartitionBackend({ exe: path.join(dir, "vbslike-host.exe"), kernel: path.join(dir, "wsl-kernel"), initrd: path.join(dir, "mon.cpio.gz"), out: dir, spawnFn: L.make });
  // the manager is given the runtime IDENTITY the image states (as main.mjs does from guest/runtime.json) and derives
  // the RuntimeID it pins spawns to from it; the deployment record carries that RuntimeID
  const m = new Manager({ backend, fetchComponent: async () => component, runtime: RUNTIME, judgeReady, readyDeadlineMs });
  const srv = createServer(m); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const client = new IsolationManagerClient({ base: `http://127.0.0.1:${srv.address().port}` });
  return { m, L, client, close: async () => { srv.close(); await backend.close().catch(() => {}); await fsp.rm(dir, { recursive: true, force: true }); } };
}
/** The route a splice client would state for this view (isolation/m4/guestd/supervisor-splice.mjs routeFor, hv shape). */
const wantOf = (v) => ({ id: v.id, app: v.appId, image: v.image, runtime: v.runtimeId, key: v.transportKeySha256 });

test("the manager's record reaches the node client with every field the datapath admits on, and the id parses as a preamble token", async () => {
  const r = await rig();
  try {
    const { view } = await r.client.spawn(IsolationManagerClient.spawnBody({ image: `ipfs://${V1.record.cid}`, name: DEP, appPort: 8080, derive: RECORD, isPublic: true, hasSecrets: false }));
    assert.match(String(view.id), /^[A-Za-z0-9-]{1,64}$/);
    assert.equal(view.name, DEP); assert.equal(view.appId, APPID); assert.equal(view.runtimeId, RECORD.runtimeId);
    assert.equal(view.image, INITRD, "image = the launcher's initrdSha256 from its ready line, carried by the manager");
    assert.equal(view.relay && view.relay.port, 19001, "the launcher's relay port for this partition");
    assert.equal(view.hostExcluded, false); assert.equal(view.boundary && view.boundary.hostExcluded, false, "the boundary word rides along");
    assert.ok(["starting", "running"].includes(view.status), view.status);
    const w = { ...wantOf(view), key: view.transportKeySha256 || "00".repeat(32) };
    assert.equal(parsePreamble(`${PROTO} id=${w.id} app=${w.app} image=${w.image} runtime=${w.runtime} key=${w.key}`).id, view.id);
  } finally { await r.close(); }
});

test("ROUTE ADMISSION, the real join: the manager judges a real TLS domain through the real judgeRunning behind the spawn answer, writes status running with the verifying handshake's key, and the datapath admits exactly that record", async () => {
  const domain = await new FakeDomain({ appId: APPID, docAppId: APPID, readyAppId: APPID }).listen();   // signs with its own launcher key; the fake lab announces the same key
  const r = await rig({ domain, judgeReady: judgeRunning, readyDeadlineMs: 4000 });
  try {
    const first = await r.client.spawn(IsolationManagerClient.spawnBody({ image: `ipfs://${RECORD.cid}`, name: DEP, appPort: 8080, derive: RECORD, isPublic: true, hasSecrets: false }));
    assert.equal(first.view.status, "starting", "spawn answers at once; readiness is judged behind it");
    assert.equal(first.view.transportKeySha256, null, "no key before a verdict");
    const pending = r.m.judging.get(first.view.id); assert.ok(pending, "Manager.judging exposes the in-flight verdict");
    await pending;
    const view = await r.client.get(first.view.id);
    const rec = r.m.get(first.view.id);
    assert.equal(view.status, "running", `the verdict did not reach running: ${rec && rec.reason}`);
    assert.equal(view.transportKeySha256, sha256hex(domain.spki), "the key the document was verified on, the one the datapath admits routes on");
    assert.equal(view.verdict, "monitor-signed"); assert.equal(view.hostExcluded, false, "ready is not host-excluded");
    assert.equal(view.image, "44abb52b1486dd2aae344e021a0d8049dfb2015d137c22a6e336051c4db5a0cf");
    const [outcome, why] = admit(view, wantOf(view));
    assert.deepEqual([outcome, why], ["", ""], "a running record with the verifying handshake's key is admitted");
    assert.equal(admit(view, { ...wantOf(view), key: "ff".repeat(32) })[0], "refused:identity");
    assert.equal(admit(view, { ...wantOf(view), app: "ee".repeat(32) })[0], "refused:identity");
    assert.equal(admit({ ...view, status: "stopped" }, wantOf(view))[0], "refused:not-running");
  } finally { await r.close(); domain.close(); }
});

test("a domain stating ANOTHER runtime identity never reaches running: the readiness expectation is the identity, pinned, not a loose match", async () => {
  const domain = await new FakeDomain({ appId: APPID, docAppId: APPID, readyAppId: APPID, runtime: { ...RUNTIME, version: "47.0.0" } }).listen();
  const r = await rig({ domain, judgeReady: judgeRunning, readyDeadlineMs: 1500 });
  try {
    const first = await r.client.spawn(IsolationManagerClient.spawnBody({ image: `ipfs://${RECORD.cid}`, name: DEP, appPort: 8080, derive: RECORD, isPublic: true, hasSecrets: false }));
    await r.m.judging.get(first.view.id);
    const view = await r.client.get(first.view.id), rec = r.m.get(first.view.id);
    assert.equal(view.status, "failed", `${view.status}: ${rec && rec.reason}`);
    assert.match(String(rec && rec.reason), /runtime identity differs/, "refused on the identity, by name");
    // the owner records the key of any handshake that got as far as a session, even on a failed verdict (it names which
    // peer answered); that is acceptable ONLY because admission refuses on status first: the key must never make it routable
    assert.equal(admit(view, wantOf(view))[0], "refused:not-running", "a failed record is not admitted even with a matching key");
  } finally { await r.close(); domain.close(); }
});

test("the manager NEVER reaches running on a domain whose document is bound to another key, and writes no key for it", async () => {
  const domain = await new FakeDomain({ appId: APPID, docAppId: APPID, readyAppId: APPID, boundSpki: Buffer.alloc(91, 3) }).listen();
  const r = await rig({ domain, judgeReady: judgeRunning, readyDeadlineMs: 1500 });
  try {
    const first = await r.client.spawn(IsolationManagerClient.spawnBody({ image: `ipfs://${RECORD.cid}`, name: DEP, appPort: 8080, derive: RECORD, isPublic: true, hasSecrets: false }));
    await r.m.judging.get(first.view.id);
    const view = await r.client.get(first.view.id);
    assert.equal(view.status, "failed", `${view.status}: ${r.m.get(first.view.id) && r.m.get(first.view.id).reason}`);
    assert.notEqual(view.status, "running");
    assert.equal(admit(view, wantOf(view))[0], "refused:not-running");
  } finally { await r.close(); domain.close(); }
});
