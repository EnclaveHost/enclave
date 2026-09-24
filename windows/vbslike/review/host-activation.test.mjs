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

async function fakeManager() {
  const log = []; const views = new Map();
  const srv = http.createServer(async (req, res) => {
    log.push(`${req.method} ${req.url}`);
    const send = (c, b) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/health") return send(200, { backend: "hyperv-partition-per-app", catalog: { derivations: ["enclave-catalog-bundle/1", "enclave-catalog-bundle/2"], runtimeId: RT }, canStart: true });
    if (req.method === "GET" && u.pathname === "/vms") return send(200, { vms: [...views.values()] });
    const m = /^\/vms\/([^/]+)$/.exec(u.pathname);
    if (m && req.method === "GET") { const v = views.get(decodeURIComponent(m[1])); if (!v) return send(404, { error: "not_found" }); v.status = "running"; v.transportKeySha256 = "ab".repeat(32); return send(200, v); }
    if (m && req.method === "DELETE") { views.delete(decodeURIComponent(m[1])); return send(200, { ok: true }); }
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
function host(mgr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-act-"));
  const logs = [];
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/review-box", name: "review-box", appsEnabled: true, ownerWallet: OWNER, log: (m) => logs.push(String(m)),
                       python: "false", gateway: "http://127.0.0.1:1", appZone: "app.enclave.host", isolationManager: mgr.base, isolationRuntimeId: RT, isolationDataAddr: "127.0.0.1:1" });
  return { h, logs, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("the claim policy does not refuse a deployment for carrying its isolation opt-in (the Linux tier's envelope form)", () => {
  const why = chain.claimPolicy(deployment(OPT_IN), { ownerAllow: OWNER, enclaveId: chain.enclaveIdOf("https://api.enclave.host/t/review-box"), appsEnabled: true, scope: "market" });
  assert.doesNotMatch(String(why || ""), /isolation/, `claimPolicy refused the opt-in envelope itself: ${why}`);
});

test("an OPTED-IN deployment reaches the manager before any artifact is fetched, world-checked or compiled here, and its spawn body is the plan's", async () => {
  const mgr = await fakeManager(); const H = host(mgr);
  try {
    const rec = await H.h.ensureApp(DEP, deployment(OPT_IN), { version: VERSION });
    const spawn = mgr.log.find((e) => e && e.spawn);
    assert.ok(spawn, `the manager was never asked; the node decided "${rec && rec.status}: ${rec && rec.reason}" on its own path first (log: ${H.logs.slice(-3).join(" | ")})`);
    assert.equal(spawn.spawn.name, DEP); assert.equal(spawn.spawn.derive.derivation, "enclave-catalog-bundle/2"); assert.equal(spawn.spawn.derive.http, 8000);
    assert.deepEqual(spawn.spawn.derive.policy, { cpuPercent: 100, memMiB: 256, vcpus: 1 }, "the version's on-chain memMb, not this node's floor");
    assert.ok(!H.logs.some((l) => /artifact|compil|bytecode/i.test(l)), "no artifact was fetched or compiled on this node for an isolated deployment");
    assert.ok(["running", "provisioning"].includes(rec.status), `${rec.status}: ${rec.reason}`);
    if (rec.status === "running") { assert.equal(rec.isolation && rec.isolation.instance, "hv0a1b2c3d"); const t = await H.h.appZoneTarget(DEP); assert.equal(t && t.isolation && t.isolation.expectName, "0ddbd824.app.enclave.host"); }
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
