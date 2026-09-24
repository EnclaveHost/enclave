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

const ROOT = new URL("../../../", import.meta.url);
const VEC = JSON.parse(fs.readFileSync(new URL("isolation/contract/catalog/derive_vectors.json", ROOT), "utf8"));
const V1 = VEC.ok.find((v) => v.name === "v1"), component = Buffer.from(VEC.component_hex, "hex"), APPID = V1.mapping.appId;
const INITRD = "44abb52b1486dd2aae344e021a0d8049dfb2015d137c22a6e336051c4db5a0cf", DEP = "0x" + "d5".repeat(32);

/** lab.rs, faithfully: numeric ids, one JSON answer per command in order, the ready line naming the initrd. */
function labLauncher() {
  let next = 1; const live = new Map();
  const make = () => {
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    const answer = (o) => setTimeout(() => p.stdout.emit("data", JSON.stringify(o) + "\n"), 0);
    p.stdin = { write: (s) => { const [cmd, a1] = s.trim().split(/\s+/);
      if (cmd === "load") { const id = next++; live.set(id, a1); return answer({ loaded: { id, label: a1, vmId: `GUID-${id}`, appSha256: APPID, guestId: `g${id}`, guestPort: 40000 + id, tcpPort: 19000 + id } }); }
      if (cmd === "destroy") { const id = /^\d+$/.test(a1) ? Number(a1) : null; if (id === null) return answer({ error: "invalid digit found in string" }); if (!live.delete(id)) return answer({ error: "no such partition" }); return answer({ destroyed: a1, guest: { exit: 0 } }); }
      return answer({ error: "unknown command" }); }, end: () => {} };
    queueMicrotask(() => p.stdout.emit("data", JSON.stringify({ ready: true, launcherKey: Buffer.alloc(32, 7).toString("base64"), boundary: "tier=T0-hv partition=hcs-child isolation=none host_excluded=no", initrdSha256: INITRD, kernelSha256: "7f".repeat(32) }) + "\n"));
    return p;
  };
  return { make, live };
}
async function rig() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "r2r-"));
  for (const f of ["vbslike-host.exe", "wsl-kernel", "mon.cpio.gz"]) await fsp.writeFile(path.join(dir, f), "x");
  const L = labLauncher();
  const backend = new HcsPartitionBackend({ exe: path.join(dir, "vbslike-host.exe"), kernel: path.join(dir, "wsl-kernel"), initrd: path.join(dir, "mon.cpio.gz"), out: dir, spawnFn: L.make });
  const m = new Manager({ backend, fetchComponent: async () => component, runtimeId: V1.record.runtimeId });
  const srv = createServer(m); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const client = new IsolationManagerClient({ base: `http://127.0.0.1:${srv.address().port}` });
  return { m, L, client, close: async () => { srv.close(); await backend.close().catch(() => {}); await fsp.rm(dir, { recursive: true, force: true }); } };
}
/** The route a splice client would state for this view (isolation/m4/guestd/supervisor-splice.mjs routeFor, hv shape). */
const wantOf = (v) => ({ id: v.id, app: v.appId, image: v.image, runtime: v.runtimeId, key: v.transportKeySha256 });

test("the manager's record reaches the node client with every field the datapath admits on, and the id parses as a preamble token", async () => {
  const r = await rig();
  try {
    const { view } = await r.client.spawn(IsolationManagerClient.spawnBody({ image: `ipfs://${V1.record.cid}`, name: DEP, appPort: 8080, derive: V1.record, isPublic: true, hasSecrets: false }));
    assert.match(String(view.id), /^[A-Za-z0-9-]{1,64}$/);
    assert.equal(view.name, DEP); assert.equal(view.appId, APPID); assert.equal(view.runtimeId, V1.record.runtimeId);
    assert.equal(view.image, INITRD, "image = the launcher's initrdSha256 from its ready line, carried by the manager");
    assert.deepEqual(view.relay, { host: "127.0.0.1", port: 19001 }, "the launcher's relay port for this partition");
    assert.equal(view.hostExcluded, false); assert.equal(view.boundary && view.boundary.hostExcluded, false, "the boundary word rides along");
    assert.ok(["starting", "running"].includes(view.status), view.status);
    const w = { ...wantOf(view), key: view.transportKeySha256 || "00".repeat(32) };
    assert.equal(parsePreamble(`${PROTO} id=${w.id} app=${w.app} image=${w.image} runtime=${w.runtime} key=${w.key}`).id, view.id);
  } finally { await r.close(); }
});

test("ROUTE ADMISSION: a record the datapath admits needs status running and the transportKeySha256 of the verifying handshake; today it is refused, and the refusal names why", async () => {
  const r = await rig();
  try {
    const { view } = await r.client.spawn(IsolationManagerClient.spawnBody({ image: `ipfs://${V1.record.cid}`, name: DEP, appPort: 8080, derive: V1.record, isPublic: true, hasSecrets: false }));
    const [outcome, why] = admit(view, wantOf(view));
    // EXPECTED TODAY (pinned by enclave-53 with this result): the spawn path does not call judgeRunning, so the record has
    // status "starting" and transportKeySha256 null, and the datapath refuses. When the wiring lands, this assertion flips.
    const wired = instanceServing(view) && typeof view.transportKeySha256 === "string" && /^[0-9a-f]{64}$/.test(view.transportKeySha256);
    if (!wired) {
      assert.notEqual(outcome, "", "an unverified record must never be admitted");
      assert.ok(outcome === "refused:not-running" || outcome === "refused:identity", `${outcome}: ${why}`);
      assert.fail(`NOT WIRED YET (expected until the spawn path calls judgeRunning): status=${view.status}, transportKeySha256=${JSON.stringify(view.transportKeySha256)} -> ${outcome}: ${why}`);
    }
    assert.deepEqual([outcome, why], ["", ""], "a running record with the verifying handshake's key is admitted");
    // and never on a different key, another app, or a stopped instance
    assert.equal(admit(view, { ...wantOf(view), key: "ff".repeat(32) })[0], "refused:identity");
    assert.equal(admit(view, { ...wantOf(view), app: "ee".repeat(32) })[0], "refused:identity");
    assert.equal(admit({ ...view, status: "stopped" }, wantOf(view))[0], "refused:not-running");
  } finally { await r.close(); }
});
