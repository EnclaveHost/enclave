// windows/node/isolation-lifecycle.test.mjs: the node's side of a per-app domain's lifecycle, as an executable spec.
//
// Written by the independent review lane (enclave-99, 2026-09-24) at the Windows owner's request, against the exported
// surface of windows/node/isolation-client.mjs (IsolationManagerClient, instanceAlive, instanceServing,
// attestedCapacity) and ONE seam the owner adds: windows/node/isolation-lifecycle.mjs exporting
//
//   reconcile({ client, deployment: { id, name, image, appPort, derive }, ledger, now = Date.now, deadlineMs, pollMs })
//     -> { action: "adopted" | "spawned" | "failed" | "held", instance, reason, leaseFree: boolean }
//
// where `ledger` is the node's lease ledger with `claim(deploymentId)` and `release(deploymentId, why)` (both counted here),
// and the manager is a fake speaking guestd's contract (201 with the record, 409 {error, id} on a live name, `status` in
// starting|running|failed|stopped, `name` = the deployment id). The cases are the ones the owner named as where they
// will get it wrong; each states the rule and fails today with "seam missing".
//
// THE ONE RULE UNDER ALL OF THEM: leaseFree is false whenever the outcome is UNKNOWN, not only when the domain is known to
// be live. A manager that answers ok to DELETE while the domain survives, a manager that times out, and a manager that
// hangs are all "unknown", and treating unknown as free is how one deployment gets run twice. "held" is the action for
// that state; it never releases and never respawns.
//   run: node --test windows/node/isolation-lifecycle.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { IsolationManagerClient, instanceAlive, instanceServing, attestedCapacity } from "./isolation-client.mjs";

const DEP = "0x" + "4e".repeat(32), APP = "9c".repeat(32), RT = "cc".repeat(32);
const DERIVE = { derivation: "enclave-catalog-bundle/1", catalog: { app: "0x" + "53".repeat(32), version: 4 }, cid: "bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza", policy: { cpuPercent: 100, memMiB: 128, vcpus: 1 }, runtimeId: RT };
const deployment = { id: DEP, name: DEP, image: "ipfs://" + DERIVE.cid, appPort: 8080, derive: DERIVE };

/** A manager speaking guestd's contract, with scripted instances and a log of every request. */
async function fakeManager({ instances = [], onSpawn = null, hang = false } = {}) {
  const log = [];
  const srv = http.createServer(async (req, res) => {
    log.push(`${req.method} ${req.url}`);
    if (hang) return;                                        // never answers: the client's timeout is the only exit
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/health") return send(200, { backend: "hyperv-partition-per-app", catalog: { derivations: ["enclave-catalog-bundle/1"] } });
    if (req.method === "GET" && u.pathname === "/vms") return send(200, { vms: instances });
    const m = /^\/vms\/([^/]+)$/.exec(u.pathname);
    if (m && req.method === "GET") { const v = instances.find((i) => i.id === decodeURIComponent(m[1])); return v ? send(200, v) : send(404, { error: "not_found" }); }
    if (m && req.method === "DELETE") { const i = instances.findIndex((x) => x.id === decodeURIComponent(m[1])); if (i < 0) return send(404, { error: "not_found" }); const [v] = instances.splice(i, 1); if (v.undying) instances.push(v); return send(200, { ok: true }); }
    if (req.method === "POST" && u.pathname === "/vms") {
      const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const live = instances.find((i) => i.name === body.name && (i.status === "running" || i.status === "starting"));
      if (live) return send(409, { error: "an instance for this name is live", id: live.id });
      const rec = onSpawn ? onSpawn(body) : { id: "hv" + Math.random().toString(16).slice(2, 10), name: body.name, status: "starting", appId: APP, runtimeId: RT, recordSha256: "ab".repeat(32) };
      instances.push(rec); return send(201, rec);
    }
    return send(404, { error: "not_found" });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, instances, log, close: () => srv.close() };
}
const ledger = () => { const l = { claims: [], releases: [], holds: new Set([DEP]) }; l.claim = async (id) => { l.claims.push(id); l.holds.add(id); }; l.release = async (id, why) => { l.releases.push({ id, why }); l.holds.delete(id); }; return l; };
const SEAM = new URL("./isolation-lifecycle.mjs", import.meta.url);
async function seam() {
  if (!fs.existsSync(SEAM)) assert.fail("seam missing: windows/node/isolation-lifecycle.mjs exporting reconcile({ client, deployment, ledger, now, deadlineMs, pollMs }) -> { action, instance, reason, leaseFree }");
  const m = await import(pathToFileURL(SEAM.pathname).href); assert.equal(typeof m.reconcile, "function"); return m.reconcile;
}
const run = async (mgr, over = {}) => (await seam())({ client: new IsolationManagerClient({ base: mgr.base, timeoutMs: over.timeoutMs || 2000 }), deployment, ledger: over.ledger || ledger(), deadlineMs: 1500, pollMs: 100, ...over });

test("attestedCapacity (exported today): a running T0-hv domain with hostExcluded false is never verified capacity, and a self-asserted hostExcluded:true under monitor-signed is not either", () => {
  const base = { id: "hv0a1b2c3d", name: DEP, status: "running", appId: APP, runtimeId: RT, tier: "T0-hv", verdict: "monitor-signed", boundary: { hostExcluded: false } };
  const view = (o) => new IsolationManagerClient({ base: "http://127.0.0.1:1" }).constructor.prototype.constructor && o;   // views come from the client; here the fields are given as the manager would
  assert.equal(attestedCapacity({ ...base, hostExcluded: false }), false);
  assert.equal(attestedCapacity({ ...base, hostExcluded: true, verdict: "monitor-signed" }), false, "a manager's word of host exclusion under a monitor-signed verdict is not chain-verified");
  assert.equal(attestedCapacity({ ...base, hostExcluded: true, verdict: "attested" }), false, "the word attested alone is not the chain-verified verdict");
  assert.equal(attestedCapacity({ ...base, hostExcluded: true, verdict: "chain-verified" }), true);
  assert.equal(instanceServing({ ...base, status: "starting" }), false); assert.equal(instanceAlive({ ...base, status: "starting" }), true); assert.equal(instanceAlive({ ...base, status: "failed" }), false);
  assert.equal(view(base), base);
});

test("the client's view of a real record carries hostExcluded only when the manager said true, and never invents a verdict", async () => {
  const mgr = await fakeManager({ instances: [{ id: "hv0a1b2c3d", name: DEP, status: "running", appId: APP, runtimeId: RT, tier: "T0-hv", boundary: { hostExcluded: false, tier: "t0-hv" } }] });
  try {
    const v = await new IsolationManagerClient({ base: mgr.base }).get("hv0a1b2c3d");
    assert.equal(v.hostExcluded, false); assert.equal(v.verdict, null); assert.equal(attestedCapacity(v), false);
    assert.equal(v.boundary.hostExcluded, false, "the backend's own word rides along verbatim");
  } finally { mgr.close(); }
});

test("NODE RESTART with a domain already live: adoption by NAME, no spawn, no lease action", async () => {
  const mgr = await fakeManager({ instances: [{ id: "hv0a1b2c3d", name: DEP, status: "running", appId: APP, runtimeId: RT, recordSha256: "ab".repeat(32) }] });
  const l = ledger();
  try {
    const r = await run(mgr, { ledger: l });
    assert.equal(r.action, "adopted", r.reason); assert.equal(r.instance && r.instance.id, "hv0a1b2c3d");
    assert.equal(mgr.log.filter((x) => x.startsWith("POST /vms")).length, 0, "no spawn into a live domain");
    assert.deepEqual([l.claims.length, l.releases.length], [0, 0], "no second lease action: the lease is already held");
    assert.equal(r.leaseFree, false);
  } finally { mgr.close(); }
});

test("STARTING that never becomes running before the deadline: the deployment fails cleanly, the domain is removed and the lease handed back, no second spawn", async () => {
  const mgr = await fakeManager({ onSpawn: (b) => ({ id: "hv11111111", name: b.name, status: "starting", appId: APP, runtimeId: RT, recordSha256: "ab".repeat(32) }) });
  const l = ledger();
  try {
    const r = await run(mgr, { ledger: l, deadlineMs: 600 });
    assert.equal(r.action, "failed", `${r.action}: ${r.reason}`); assert.match(String(r.reason), /deadline|running|ready/i);
    assert.equal(mgr.log.filter((x) => x.startsWith("POST /vms")).length, 1, "one spawn, never a second");
    assert.ok(mgr.log.some((x) => x.startsWith("DELETE /vms/hv11111111")), "the starting domain is removed, not left to sit");
    assert.equal(l.releases.length, 1, "the lease is handed back exactly once"); assert.equal(r.leaseFree, true);
  } finally { mgr.close(); }
});

test("MANAGER DOWN (connection refused): the node concludes nothing about the domain, does not respawn and does not release", async () => {
  const dead = await new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => res(port)); }); });
  const l = ledger();
  const r = await run({ base: `http://127.0.0.1:${dead}` }, { ledger: l });
  assert.equal(r.action, "held", `${r.action}: ${r.reason}`); assert.match(String(r.reason), /transport|refused|unreachable|manager/i);
  assert.deepEqual([l.claims.length, l.releases.length], [0, 0]); assert.equal(r.leaseFree, false);
});

test("MANAGER HANGING (accepts, never answers): the same hold, bounded by the client's timeout, not a dead domain", async () => {
  const mgr = await fakeManager({ hang: true });
  const l = ledger();
  try {
    const t0 = Date.now();
    const r = await run(mgr, { ledger: l, timeoutMs: 500, deadlineMs: 800 });
    assert.ok(Date.now() - t0 < 5000, "bounded");
    assert.equal(r.action, "held", `${r.action}: ${r.reason}`); assert.match(String(r.reason), /timeout|no answer|manager/i);
    assert.deepEqual([l.claims.length, l.releases.length], [0, 0]); assert.equal(r.leaseFree, false);
  } finally { mgr.close(); }
});

test("remove() answering ok while the domain is STILL LIVE (manager defect 5, seen from the node): the lease is not marked free on the manager's word alone", async () => {
  const mgr = await fakeManager({ instances: [{ id: "hv22222222", name: DEP, status: "running", appId: APP, runtimeId: RT, recordSha256: "ab".repeat(32), undying: true }] });
  const l = ledger();
  try {
    const m = await import(pathToFileURL(SEAM.pathname).href).catch(() => null);
    if (!m || typeof m.retire !== "function") assert.fail("seam missing: isolation-lifecycle.mjs also exports retire({ client, deployment, ledger, instanceId }) -> { removed, leaseFree, reason }");
    const r = await m.retire({ client: new IsolationManagerClient({ base: mgr.base }), deployment, ledger: l, instanceId: "hv22222222" });
    assert.ok(mgr.log.some((x) => x.startsWith("DELETE /vms/hv22222222")));
    assert.ok(mgr.log.filter((x) => x === "GET /vms/hv22222222").length >= 1, "the node re-reads the domain after DELETE rather than trusting ok");
    assert.equal(r.leaseFree, false, `the domain still answers running: ${r.reason}`); assert.equal(l.releases.length, 0);
  } finally { mgr.close(); }
});
