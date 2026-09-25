// windows/vbslike/review/host-activation.test.mjs: can ONE deployment be activated as a partition on this node while the
// six existing apps stay on the in-enclave path? The Windows node's real Host (windows/node/host.mjs at d1f4b745) is
// driven with real hookbin metadata against a fake manager speaking guestd's contract and an artifact gateway that
// cannot answer, so the order of decisions is measured, not read:
//   - the claim policy must not refuse the deployment for carrying its isolation opt-in (the Linux tier's envelope form);
//   - an opted-in deployment must reach the manager BEFORE any artifact is fetched, world-checked or compiled here;
//   - a deployment without the opt-in must never reach the manager (canary-only activation).
// At d1f4b745: the envelope parser refuses the `isolation` key, `isolationRequired` is read but never set, and the isolation
// branch runs after the old path's artifact checks, so the first two fail by design (defects 13 and 14).
//   run: node --test windows/vbslike/review/host-activation.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Host } from "../../node/host.mjs";
import * as chain from "../../node/chain.mjs";

const DEP = "0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76";     // hookbin, the real deployment id
const APP = "0xf7e65a8fdae1dd9f8c2a897f2f372cdb7f6150d1e20526fa06d10a682cc2e9e3";
const OWNER = "0x29479Bf04ED889D46a7AfB7f292B9Bb26e12647C";
const RT = "ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8";
const OPT_IN = JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } });
// the catalog version as chain.resolveAppRef answers it for hookbin 0.1.4 (Base, catalog app APP index 4)
const VERSION = { appId: APP, index: 4, version: 4, cid: "bafkreidocbixnql7lroykdtwx4r2fmi5n6sra4lj7b7vhscsfqn4gctlee", memMb: 256, ports: "http:8000", config: "", configCid: "", yanked: false };
const deployment = (configCid) => ({ id: DEP, appRef: `catalog://${APP}/4`, owner: OWNER, active: true, createdAt: 1790000000, cpuMilli: 100, gpuMilli: 0, isPublic: true, appPort: 8000, configCid, leaseUntil: Math.floor(Date.now() / 1000) + 3600, runner: "0x" + "0".repeat(64) });

async function fakeManager({ running = [] } = {}) {
  const log = []; const views = new Map();
  // a partition ALREADY running under a deployment's name (what a node restart finds): the manager's own /vms shape
  for (const name of running) views.set("hvpre000001", { id: "hvpre000001", name, status: "running", appId: "d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24", runtimeId: RT, image: "46".repeat(32), tier: "T0-hv", hostExcluded: false, transportKeySha256: "cd".repeat(32) });
  const srv = http.createServer(async (req, res) => {
    log.push(`${req.method} ${req.url}`);
    const send = (c, b) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/health") return send(200, { backend: "hyperv-partition-per-app", catalog: { derivations: ["enclave-catalog-bundle/1", "enclave-catalog-bundle/2"], runtimeId: RT }, canStart: true });
    if (req.method === "GET" && u.pathname === "/vms") return send(200, { vms: [...views.values()] });
    const m = /^\/vms\/([^/]+)$/.exec(u.pathname);
    if (m && req.method === "GET") { const v = views.get(decodeURIComponent(m[1])); if (!v) return send(404, { error: "not_found" }); v.status = "running"; v.transportKeySha256 = "ab".repeat(32); return send(200, v); }
    if (m && req.method === "DELETE") { views.delete(decodeURIComponent(m[1])); return send(200, { ok: true }); }
    if (req.method === "POST" && u.pathname === "/v1/secrets/fetch") {
      // the relay's lease-holder fetch (relay/secrets.js): {id, endpoint, ts, sig, opSig} -> {id, env, rev}. This fake
      // does NOT verify the signature (the real route refuses a non-lease-holder); it records that the node asked with
      // the route's own fields, and answers "no secrets" in the shape the node requires.
      const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      log.push({ secretsFetch: { id: body.id, endpoint: body.endpoint, ts: body.ts, opSigOk: /^0x[0-9a-f]{130}$/i.test(String(body.opSig || "")) } });
      return send(200, { id: body.id, env: {}, rev: 0 });
    }
    if (req.method === "POST" && u.pathname === "/vms") {
      const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); log.push({ spawn: body });
      const v = { id: "hv0a1b2c3d", name: body.name, status: "starting", appId: body.derive && body.derive.catalog ? "d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24" : null, runtimeId: RT, image: "46".repeat(32), tier: "T0-hv", hostExcluded: false, relay: { host: "127.0.0.1", port: 19001 } };
      views.set(v.id, v); return send(201, v);
    }
    return send(404, { error: "not_found" });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, log, close: () => srv.close() };
}
// The node's secrets signer is the operator key's personal_sign (agent.mjs loads operator.key into cfg.secretsSign). This
// one checks the message the node signs is the relay's (secrets.mjs: enclave-secrets-fetch:<id>:<endpoint>:<ts>) and
// returns a 65-byte hex the node accepts; the fake relay above does not verify it.
const SIGNED = [];
const signer = async (message) => { SIGNED.push(message); return "0x" + "ab".repeat(65); };
function host(mgr, { secretsSign = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-act-"));
  const logs = [];
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/review-box", name: "review-box", appsEnabled: true, ownerWallet: OWNER, log: (m) => logs.push(String(m)),
                       python: "false", gateway: "http://127.0.0.1:1", appZone: "app.enclave.host", isolationManager: mgr.base, isolationRuntimeId: RT, isolationDataAddr: "127.0.0.1:1",
                       relayBase: mgr.base, secretsSign });
  return { h, logs, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// The policy's inputs are the Host's own (host.mjs passes isolationBackend from its manager config); calling it here with
// the same shape is the claim path minus the tick. A throw is a failure, not a refusal: the tick has no answer for it.
const POLICY = { ownerAllow: OWNER, enclaveId: chain.enclaveIdOf("https://api.enclave.host/t/review-box"), appsEnabled: true, scope: "market" };
test("the claim policy does not refuse a deployment for carrying its isolation opt-in (the Linux tier's envelope form) on a box that runs the backend", () => {
  const why = chain.claimPolicy(deployment(OPT_IN), { ...POLICY, isolationBackend: "hyperv-partition-per-app" });
  assert.doesNotMatch(String(why || ""), /isolation/, `claimPolicy refused the opt-in envelope itself: ${why}`);
});
test("the claim policy refuses the opt-in BY NAME on a box that runs no isolation backend, or another one; and a deployment without the opt-in is not refused for isolation", () => {
  const none = chain.claimPolicy(deployment(OPT_IN), POLICY);
  assert.match(String(none || ""), /requires isolation backend hyperv-partition-per-app, and this box runs no isolation backend/, `expected a refusal by name, got: ${none}`);
  const other = chain.claimPolicy(deployment(OPT_IN), { ...POLICY, isolationBackend: "some-other-backend" });
  assert.match(String(other || ""), /this box runs some-other-backend/, `expected a refusal naming the other backend, got: ${other}`);
  const plain = chain.claimPolicy(deployment(JSON.stringify({ config: "{}" })), { ...POLICY, isolationBackend: "hyperv-partition-per-app" });
  assert.doesNotMatch(String(plain || ""), /isolation/, `a deployment that never asked was refused for isolation: ${plain}`);
});

test("an OPTED-IN deployment reaches the manager before any artifact is fetched, world-checked or compiled here, and its spawn body is the plan's", async () => {
  const mgr = await fakeManager(); const H = host(mgr, { secretsSign: signer });
  try {
    const rec = await H.h.ensureApp(DEP, deployment(OPT_IN), { version: VERSION });
    const spawn = mgr.log.find((e) => e && e.spawn);
    assert.ok(spawn, `the manager was never asked; the node decided "${rec && rec.status}: ${rec && rec.reason}" on its own path first (log: ${H.logs.slice(-3).join(" | ")})`);
    // hasSecrets is the NODE's answer, from the relay's own route, before the plan is made: not a value the caller asserts
    const iFetch = mgr.log.findIndex((e) => e && e.secretsFetch), iSpawn = mgr.log.findIndex((e) => e && e.spawn);
    assert.ok(iFetch >= 0 && iFetch < iSpawn, `the node did not ask the relay for the deployment's secrets before planning (relay/manager saw: ${mgr.log.map((e) => typeof e === "string" ? e : Object.keys(e)[0]).join(", ")})`);
    const f = mgr.log[iFetch].secretsFetch;
    assert.equal(String(f.id).toLowerCase(), DEP); assert.equal(f.endpoint, "https://api.enclave.host/t/review-box"); assert.ok(f.opSigOk, "the fetch carried the operator's 65-byte signature");
    assert.match(SIGNED[SIGNED.length - 1] || "", new RegExp(`^enclave-secrets-fetch:${DEP}:https://api\\.enclave\\.host/t/review-box:\\d+$`), "the node signed the relay's fetch message, not another");
    assert.equal(spawn.spawn.name, DEP); assert.equal(spawn.spawn.derive.derivation, "enclave-catalog-bundle/2"); assert.equal(spawn.spawn.derive.http, 8000);
    assert.deepEqual(spawn.spawn.derive.policy, { cpuPercent: 100, memMiB: 256, vcpus: 1 }, "the version's on-chain memMb, not this node's floor");
    assert.ok(!H.logs.some((l) => /artifact|compil|bytecode/i.test(l)), "no artifact was fetched or compiled on this node for an isolated deployment");
    assert.ok(["running", "provisioning"].includes(rec.status), `${rec.status}: ${rec.reason}`);
    if (rec.status === "running") { assert.equal(rec.isolation && rec.isolation.instance, "hv0a1b2c3d"); const t = await H.h.appZoneTarget(DEP); assert.equal(t && t.isolation && t.isolation.expectName, "0ddbd824.app.enclave.host"); }
  } finally { mgr.close(); H.cleanup(); }
});

test("an OPTED-IN deployment on a node with NO secrets signer is HELD, never spawned: hasSecrets is unknown, and this tier refuses what it cannot verify", async () => {
  // agent.mjs sets cfg.secretsSign only when operator.key loads; a node without it cannot ask the relay, and #secretsState
  // answers null. The plan must hold (isolation-lifecycle: unknown keeps the lease), not spawn with hasSecrets guessed.
  // A harness that computes hasSecrets with its own signer and hands it to the plan skips exactly this decision.
  const mgr = await fakeManager(); const H = host(mgr);
  try {
    const rec = await H.h.ensureApp(DEP, deployment(OPT_IN), { version: VERSION });
    assert.ok(!mgr.log.some((e) => e && e.spawn), `the manager was asked to spawn with hasSecrets unknown: ${JSON.stringify(mgr.log.find((e) => e && e.spawn))}`);
    assert.ok(!mgr.log.some((e) => e && e.secretsFetch), "a node with no signer must not reach the relay's secrets route");
    assert.ok(rec && rec.status !== "running" && rec.status !== "failed", `held, not decided: got ${rec && rec.status}`);
    assert.match(String(rec && rec.reason || ""), /hasSecrets/, `the reason names the unknown input: ${rec && rec.reason}`);
  } finally { mgr.close(); H.cleanup(); }
});

test("a node RESTART adopts the partition already running under the deployment's name through the real ensureApp: no second spawn, the record names the live instance", async () => {
  const mgr = await fakeManager({ running: [DEP] }); const H = host(mgr, { secretsSign: signer });
  try {
    const rec = await H.h.ensureApp(DEP, deployment(OPT_IN), { version: VERSION });
    assert.ok(!mgr.log.some((e) => e && e.spawn), `a second partition was spawned for a deployment that already had one: ${JSON.stringify(mgr.log.find((e) => e && e.spawn))}`);
    assert.equal(rec && rec.status, "running", `${rec && rec.status}: ${rec && rec.reason} (log: ${H.logs.slice(-3).join(" | ")})`);
    assert.equal(rec.isolation && rec.isolation.instance, "hvpre000001", "the record names the instance the manager already had");
    assert.equal(rec.isolation && rec.isolation.transportKeySha256, "cd".repeat(32), "the record carries the LIVE instance's transport key, not a stale one");
  } finally { mgr.close(); H.cleanup(); }
});

test("a deployment WITHOUT the opt-in never reaches the manager: activation is per deployment, and the existing apps stay where they are", async () => {
  const mgr = await fakeManager(); const H = host(mgr);
  try {
    await H.h.ensureApp(DEP, deployment(""), { version: VERSION });
    assert.equal(mgr.log.some((e) => e && e.spawn), false, "the manager was asked for a deployment that never opted in");
    assert.equal(mgr.log.filter((e) => typeof e === "string" && e.startsWith("POST")).length, 0);
  } finally { mgr.close(); H.cleanup(); }
});
