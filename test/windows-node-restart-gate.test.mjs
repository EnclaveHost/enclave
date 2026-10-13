// POST /v1/deployments/<id>/restart re-runs a deployment THIS box serves; it never claims one (enclave-b4's N1).
// The route used to read ANY id from the ledger and call ensureApp(force) with no claim policy, no owner check and no
// lease check, and on the isolation backend ensureApp gates only on the tenant's own opt-in - so a stranger's opted-in
// deployment would have been spawned as a partition on this box. host.restart refuses unless this box holds the live
// lease and, in owner-only scope, the deployment is the box owner's. Each test fails if its guard is removed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fakeBaseRpc, DEPLOYMENTS } from "./helpers/fake-base-rpc.mjs";
import { servedOwner } from "./helpers/owners.mjs";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Base is faked before host.mjs loads, so nothing here can reach a public RPC
const rpc = await fakeBaseRpc();
(await import("../windows/node/chain.mjs")).addresses.deployments = DEPLOYMENTS;
const { Host } = await import("../windows/node/host.mjs");
after(() => rpc.close());

const OWNER = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
const STRANGER = "0x1111111111111111111111111111111111111111";
const OTHER_ENCLAVE = "0x" + "77".repeat(32);
const ISOLATED = JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } });
const ID = "0x" + "a1".repeat(32);

// the NucBox shape: engine retired, the isolation backend configured, owner-only (appsInTee is false)
// the box serves OWNER (its operator here: servedOwner); the owner rule itself is test/windows-node-owner-set.test.mjs
const hvBox = (cfg = {}, owner = OWNER) => servedOwner(new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-restart-")),
  endpoint: "https://api.enclave.host/t/test", name: "test", appsEnabled: true, cpuPricePerSec6: 12, log: () => {},
  engineRetired: true, isolationManager: "http://127.0.0.1:1", ...cfg }), owner);
const dep = (h, { owner = OWNER, runner = h.enclaveId, leaseSec = 3600 } = {}) => ({
  appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4", createdAt: 1, active: true,
  runner, leaseUntil: Math.floor(Date.now() / 1000) + leaseSec, cpuMilli: 100, gpuMilli: 0, isPublic: true, owner,
  configCid: ISOLATED });
// ensureApp replaced by a recorder: what matters is whether the gate lets the call through, and with what
const spy = (h) => { const calls = []; h.ensureApp = async (id, d, opts) => { calls.push({ id, opts }); return { status: "running" }; }; return calls; };

test("the NucBox node is owner-only whatever CLAIM_SCOPE says (the gate's owner check always applies there)", () => {
  assert.equal(hvBox({ claimScope: "market" }).scope(), "owner-only");
});

test("a STRANGER's opted-in deployment is refused, and ensureApp is never reached", async () => {
  const h = hvBox();
  const calls = spy(h);
  // not this box's lease at all: another enclave runs it, or nobody does
  for (const runner of [OTHER_ENCLAVE, "0x" + "00".repeat(32)]) {
    const r = await h.restart(ID, dep(h, { owner: STRANGER, runner }));
    assert.equal(r.refused, true, JSON.stringify(r));
    assert.match(r.reason, /does not hold a live lease/);
  }
  // even a stranger's deployment whose lease this box holds is refused in owner-only scope
  const r = await h.restart(ID, dep(h, { owner: STRANGER }));
  assert.equal(r.refused, true);
  assert.match(r.reason, /owner-only scope and restarts only its operator's and its delegated owners'/);
  assert.equal(calls.length, 0, "ensureApp ran for a refused restart");
  // and no record was made, so HEAD /x/<id> keeps answering 404 for it
  assert.equal(h.records.has(ID), false);
});

test("the owner's own deployment, on a live lease this box holds, is restarted (ensureApp with force)", async () => {
  const h = hvBox();
  const calls = spy(h);
  const d = dep(h);
  assert.equal(h.restartRefusal(ID, d), null);
  const r = await h.restart(ID.toUpperCase().replace("0X", "0x"), d);
  assert.equal(r.status, "running");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, ID);
  assert.equal(calls[0].opts.force, true);
});

test("the owner's deployment with NO live lease on this box is refused: no lease here, or an ended one", async () => {
  const h = hvBox();
  const calls = spy(h);
  for (const d of [dep(h, { runner: OTHER_ENCLAVE }), dep(h, { runner: "0x" + "00".repeat(32) }), dep(h, { leaseSec: -60 })]) {
    const r = await h.restart(ID, d);
    assert.equal(r.refused, true, JSON.stringify(d));
    assert.match(r.reason, /does not hold a live lease/);
  }
  assert.equal(calls.length, 0);
});

test("an EMPTY owner set refuses everything; a stopped deployment, a malformed id or no record is refused", async () => {
  const h = servedOwner(hvBox(), "");
  h.owners.operator = null;                          // no operator key, no delegation: nobody is served
  assert.equal(h.ownerSet().size, 0);
  assert.match(h.restartRefusal(ID, dep(h)), /restarts only its operator's/);
  const s = hvBox();
  assert.match(s.restartRefusal(ID, { ...dep(s), active: false }), /not active/);
  const k = hvBox();
  assert.match(k.restartRefusal("0x1234", dep(k)), /bytes32/);
  assert.match(k.restartRefusal(ID, null), /no such deployment/);
});

// ---- WHO may ask (enclave-5d's review of N1): the owner's session on THIS box, before anything else ----------------
const { initSessionKey, mint, addressFor } = await import("../windows/node/session.mjs");
const sessionBox = () => {
  const h = hvBox();
  const key = initSessionKey({ dir: h.cfg.dir });
  h.cfg.sessionVerify = (headers, id) => addressFor(key, headers, id);
  const bearer = (addr) => ({ authorization: `Bearer ${mint(key, { subject: addr, ttlSec: 600 })}` });
  return { h, bearer };
};

test("restartRequest: no session is 401, before the ledger is read and before ensureApp", async () => {
  const { h } = sessionBox();
  const calls = spy(h);
  let reads = 0;
  const r = await h.restartRequest(ID, {}, { read: async () => { reads++; return dep(h); } });
  assert.equal(r.status, 401, JSON.stringify(r));
  assert.equal(reads, 0);
  assert.equal(calls.length, 0);
  // and with no verifier at all it fails closed the same way
  const k = hvBox();
  const n = await k.restartRequest(ID, { authorization: "Bearer x" }, { read: async () => dep(k) });
  assert.equal(n.status, 401);
});

test("restartRequest: a valid session for ANOTHER address is 404 (as on Linux), and nothing restarts", async () => {
  const { h, bearer } = sessionBox();
  const calls = spy(h);
  const r = await h.restartRequest(ID, bearer(STRANGER), { read: async () => dep(h) });
  assert.equal(r.status, 404, JSON.stringify(r));
  assert.equal(calls.length, 0);
});

test("restartRequest: the owner's session on this box's live lease restarts with force; no lease here stays 409", async () => {
  const { h, bearer } = sessionBox();
  const calls = spy(h);
  const ok = await h.restartRequest(ID, bearer(OWNER), { read: async () => dep(h) });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.force, true);
  const no = await h.restartRequest(ID, bearer(OWNER), { read: async () => dep(h, { runner: OTHER_ENCLAVE }) });
  assert.equal(no.status, 409);
  assert.equal(no.body.error, "refused");
  assert.match(no.body.reason, /does not hold a live lease/);
  assert.equal(calls.length, 1);
});

test("the agent's own route answers 401 without the owner's session (it is wired to restartRequest)", { timeout: 60_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const net = await import("node:net");
  const { once } = await import("node:events");
  const srv = net.createServer(); srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  const port = srv.address().port; srv.close();
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-restart-agent-"));
  const agent = path.join(path.dirname(new URL(import.meta.url).pathname), "../windows/node/agent.mjs");
  // BASE_RPCS is the fake RPC (fakeBaseRpc set it above), so the agent's chain reads never leave this machine
  const child = spawn(process.execPath, [agent], { env: { ...process.env, NODE_DIR: nodeDir, NODE_NAME: "restart-test",
    RELAY_URL: "none", APPS: "1", LOCAL_HTTP_PORT: String(port), TPMATTEST_EXE: path.join(nodeDir, "no-tpm-tool"),
    ENCLAVE_ENGINE: "", OWNER_WALLET: OWNER }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      await new Promise((r) => setTimeout(r, 200));
      up = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.ok).catch(() => false);
    }
    assert.ok(up, `the agent did not come up: ${out}`);
    const url = `http://127.0.0.1:${port}/v1/deployments/${ID}/restart`;
    const none = await fetch(url, { method: "POST" });
    assert.equal(none.status, 401, await none.text());
    const forged = await fetch(url, { method: "POST", headers: { authorization: "Bearer not-a-token" } });
    assert.equal(forged.status, 401);
  } finally { child.kill(); fs.rmSync(nodeDir, { recursive: true, force: true }); }
});
