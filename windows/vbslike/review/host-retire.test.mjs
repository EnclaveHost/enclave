// windows/vbslike/review/host-retire.test.mjs: when a lease is LOST, is the partition retired? The real Host's tick
// (windows/node/host.mjs at d1f4b745) is driven READ-ONLY against the live Base ledger for hookbin's real deployment,
// which another enclave (metal-iso0) holds: the tick's own rule stops the app ("another enclave holds the lease"), and
// for a record whose app is a partition that stop must reach the manager as a DELETE (isolation-lifecycle.mjs retire).
// The record is SET UP in the isolated state, not produced by activation, because activation is blocked at d1f4b745
// (defects 13 and 14; host-activation.test.mjs); this file pins the retire mechanism only, and says so. No operator key
// is loaded, so the tick can write nothing; an unreachable ledger FAILS this test with its reason rather than skipping.
//   run: node --test windows/vbslike/review/host-retire.test.mjs   (network: read-only Base RPC)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Host } from "../../node/host.mjs";
import * as chain from "../../node/chain.mjs";

const DEP = "0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76";     // hookbin, held live by metal-iso0
const APP = "d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24";
const RT = "ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8";

async function fakeManager() {
  const log = [];
  const view = { id: "hv0a1b2c3d", name: DEP, status: "running", appId: APP, runtimeId: RT, image: "46".repeat(32), tier: "T0-hv", hostExcluded: false, transportKeySha256: "ab".repeat(32), relay: { host: "127.0.0.1", port: 19001 } };
  let present = true;
  const srv = http.createServer((req, res) => {
    log.push(`${req.method} ${req.url}`);
    const send = (c, b) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    const u = new URL(req.url, "http://x"); const m = /^\/vms\/([^/]+)$/.exec(u.pathname);
    if (req.method === "GET" && u.pathname === "/health") return send(200, { backend: "hyperv-partition-per-app", catalog: { derivations: ["enclave-catalog-bundle/1", "enclave-catalog-bundle/2"], runtimeId: RT } });
    if (req.method === "GET" && u.pathname === "/vms") return send(200, { vms: present ? [view] : [] });
    if (m && req.method === "GET") return present && decodeURIComponent(m[1]) === view.id ? send(200, view) : send(404, { error: "not_found" });
    if (m && req.method === "DELETE") { if (!present) return send(404, { error: "not_found" }); present = false; return send(200, { ok: true }); }
    return send(404, { error: "not_found" });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, log, isPresent: () => present, close: () => srv.close() };
}

test("a lease held by another enclave: the tick stops the app, and for a partition that stop retires the domain through the manager", { timeout: 120_000 }, async () => {
  assert.equal(process.env.NODE_OPERATOR_KEY || "", "", "this test must hold no operator key: the tick may read the ledger and write nothing");
  const mgr = await fakeManager();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-retire-")); const logs = [];
  const h = new Host({ dir, endpoint: "https://api.enclave.host/t/review-box-never-registered", name: "review-box", appsEnabled: true, log: (m) => logs.push(String(m)),
                       python: "false", gateway: "http://127.0.0.1:1", appZone: "app.enclave.host", isolationManager: mgr.base, isolationRuntimeId: RT, isolationDataAddr: "127.0.0.1:1" });
  try {
    try { await chain.resolveAddresses(); } catch (e) { assert.fail(`the ledger could not be reached (read-only): ${e.message}`); }
    let d; try { d = await chain.readDeployment(DEP); } catch (e) { assert.fail(`readDeployment(hookbin) failed: ${e.message}`); }
    const runner = String(d.runner || "").toLowerCase();
    assert.ok(runner && !/^0x0+$/.test(runner) && runner !== h.enclaveId.toLowerCase(), `precondition: hookbin's lease is held by another enclave (runner ${runner.slice(0, 12)}…, until ${d.leaseUntil})`);
    assert.ok(Number(d.leaseUntil) * 1000 > Date.now(), "precondition: that lease is live");
    // the retire-path SETUP: this node believes it runs hookbin as a partition (what activation would have recorded)
    h.records.set(DEP, { id: DEP, status: "running", reason: null, appRef: `catalog://0x${"f7".repeat(32)}/4`, leaseUntil: Number(d.leaseUntil),
                         isolation: { backend: "hyperv-partition-per-app", instance: "hv0a1b2c3d", appId: APP, image: "46".repeat(32), tier: "T0-hv", hostExcluded: false, transportKeySha256: "ab".repeat(32) } });
    h.tracked.add(DEP);
    h.chainReady = true;                        // init()'s read-only half, without its timers or its operator key
    await h.tick();
    const rec = h.records.get(DEP);
    assert.equal(rec && rec.status, "stopped", `the tick did not stop the record: ${rec && rec.status} (${rec && rec.reason}); log: ${logs.slice(-3).join(" | ")}`);
    assert.match(String(rec.reason), /another enclave holds the lease/);
    // THE RULE UNDER TEST: a stopped partition is retired through the manager, and the record no longer names it
    assert.ok(mgr.log.some((l) => l === "DELETE /vms/hv0a1b2c3d"), `no DELETE reached the manager on lease loss: the partition outlives the lease (manager saw: ${mgr.log.join(", ") || "nothing"})`);
    assert.equal(mgr.isPresent(), false, "the domain is gone at the manager");
    assert.ok(!rec.isolation || rec.isolation.instance == null, "the record no longer names a live instance");
  } finally { mgr.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
