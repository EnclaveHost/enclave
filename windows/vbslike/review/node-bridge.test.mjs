// windows/vbslike/review/node-bridge.test.mjs: the guest lane's node bridge (windows/vbslike/datapath/node-bridge.mjs at
// e7ec6521) under the independent review's questions. Two parts:
//   1. isolationPlan against the supervisor's claim gate (supervisor.js isolationClaimVerdict), input by input. The
//      bridge's own "agrees with supervisor.js case for case" compares appConfigOf and derivationOf through the
//      self-test seam, not the gate's verdicts; the gate takes inputs the plan has no parameter for, and those cases
//      were absent until 5d's 2a43239a took them (require, manager, appConfigCid); the cases now state their rules.
//   2. the join, adversarially: a ClientHello split across frames, a route whose view is not running, a record whose
//      identity is partial.
//   run: node --test windows/vbslike/review/node-bridge.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import tls from "node:tls";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { WebSocketServer, WebSocket, createWebSocketStream } from "ws";
import { isolationPlan, isolatedTarget, createIsolationSplicer, dataPlaneFor, V1, V2 } from "../datapath/node-bridge.mjs";

const RT = "ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8";
const HOOKBIN = { appId: "0xf7e65a8fdae1dd9f8c2a897f2f372cdb7f6150d1e20526fa06d10a682cc2e9e3", index: 4, cid: "bafkreidocbixnql7lroykdtwx4r2fmi5n6sra4lj7b7vhscsfqn4gctlee", memMb: 256, ports: "http:8000", config: "", configCid: "" };
const DEP_H = "0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76";
const ledger = { cpuMilli: 100, gpuMilli: 0, isPublic: true, appPort: 8080 };
const MANAGER = { backend: "hyperv-partition-per-app", catalog: { derivations: [V1, V2], runtimeId: RT } };
// the plan's full input set since 5d's 2a43239a: the deployment's own requirement, the manager's /health object (backend
// checked, derivations read from it) and a deployment-level configCid, each unknown when absent
const plan = (over = {}) => isolationPlan({ deploymentId: DEP_H, deployment: ledger, version: HOOKBIN, appConfig: "", hasSecrets: false, waf: {}, volumes: [], runtimeId: RT,
                                            require: "hyperv-partition-per-app", manager: MANAGER, appConfigCid: "", ...over });
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("the plan accepts the real hookbin deployment and refuses each input the way the gate does", () => {
  const p = plan(); assert.equal(p.ok, true, JSON.stringify(p)); assert.equal(p.derivation, V2); assert.equal(p.spawn.name, DEP_H);
  for (const [name, over, input] of [
    ["gpu share", { deployment: { ...ledger, gpuMilli: 500 } }, "deployment.gpuMilli"],
    ["private", { deployment: { ...ledger, isPublic: false } }, "deployment.isPublic"],
    ["secrets", { hasSecrets: true }, "hasSecrets"], ["secrets unknown", { hasSecrets: null }, "hasSecrets"],
    ["config", { appConfig: JSON.stringify({ API_URL: "x" }) }, "appConfig"],
    ["waf", { waf: { rate: 1 } }, "waf"], ["waf unknown", { waf: undefined }, "waf"],
    ["volumes", { volumes: ["m"] }, "volumes"], ["two ports", { version: { ...HOOKBIN, ports: "http:8000,tcp:9000" } }, "version.ports"],
    ["manager cannot serve /2", { manager: { ...MANAGER, catalog: { derivations: [V1] } } }, "manager.catalog.derivations"], ["manager unasked", { manager: null }, "manager"],
  ]) { const r = plan(over); assert.equal(r.ok, false, name); assert.equal(r.input, input, name); }
});

test("GATE INPUT: the deployment's own isolation requirement (supervisor.js: `require !== backend` refuses): absent is unknown, another backend is refused, this backend passes", () => {
  const r = plan({ require: undefined }); assert.equal(r.ok, false, "with no stated requirement the plan must refuse (unknown is not no)"); assert.equal(r.input, "require"); assert.equal(r.unknown, true);
  const r2 = plan({ require: "snp-guest-per-app" }); assert.equal(r2.ok, false, "a deployment that requires another backend is refused, as the supervisor refuses it"); assert.equal(r2.input, "require");
  assert.equal(plan().ok, true, JSON.stringify(plan()));
});

test("GATE INPUT: the manager's backend name (supervisor.js: `manager.backend !== backend` refuses): another backend's manager is refused even when it lists the derivation; an absent manager is unknown", () => {
  const r = plan({ manager: { backend: "snp-guest-per-app", catalog: { derivations: [V1, V2] } } });
  assert.equal(r.ok, false, "another backend's manager, even one that serves the derivation, is refused"); assert.equal(r.input, "manager.backend");
  const u = plan({ manager: undefined }); assert.equal(u.ok, false); assert.equal(u.unknown, true);
});

test("GATE INPUT: the DEPLOYMENT's config override at a CID (supervisor.js: `appConfigCid` refuses): a CID is refused, absent is unknown, '' is known none", () => {
  const r = plan({ deployment: { ...ledger, configCid: "bafkreiaaaa" }, appConfigCid: "bafkreiaaaa" });
  assert.equal(r.ok, false, "a deployment carrying a config override by CID is not delivered into a partition"); assert.equal(r.input, "appConfigCid");
  const u = plan({ appConfigCid: undefined }); assert.equal(u.ok, false); assert.equal(u.unknown, true);
  assert.equal(plan({ appConfigCid: "" }).ok, true);
});

test("isolatedTarget names a route only for a running record with a whole identity: starting, a partial identity, or a bad id give null (the app zone then answers 503, not a guess)", () => {
  const rec = { status: "running", isolation: { instance: "hv0a1b2c3d", appId: "d2".repeat(32) } };
  assert.deepEqual(isolatedTarget(DEP_H, rec).isolation.expectName, "0ddbd824.app.enclave.host");
  assert.equal(isolatedTarget(DEP_H, { ...rec, status: "starting" }), null);
  assert.equal(isolatedTarget(DEP_H, { status: "running", isolation: { instance: "hv0a1b2c3d" } }), null, "no appId");
  assert.equal(isolatedTarget(DEP_H, { status: "running", isolation: { instance: "a b", appId: "d2".repeat(32) } }), null, "an id that is not one token");
  assert.equal(isolatedTarget("0xnot", rec), null);
});

/** the domain: a TLS server on its own key */
async function stand() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nbr-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=enclave-domain", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore" });
  const key = fs.readFileSync(path.join(dir, "k.pem")), cert = fs.readFileSync(path.join(dir, "c.pem")); fs.rmSync(dir, { recursive: true, force: true });
  const spkiSha = sha(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }));
  const app = http.createServer((q, r) => r.end(`domain answers ${q.headers.host}`));
  const front = tls.createServer({ key, cert }, (s) => app.emit("connection", s)); front.listen(0, "127.0.0.1"); await once(front, "listening");
  return { front, spkiSha, port: front.address().port };
}

test("the join, adversarially: a ClientHello split across WebSocket frames is served; a route whose view is starting is refused; a partial identity never reaches the data plane", { timeout: 60_000 }, async (t) => {
  const d = await stand();
  const APP = "d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24", IMG = "46".repeat(32);
  const views = { hv0a1b2c3d: { id: "hv0a1b2c3d", name: DEP_H, status: "running", tier: "T0-hv", hostExcluded: false, verdict: "monitor-signed", appId: APP, runtimeId: RT, image: IMG, transportKeySha256: d.spkiSha, relay: { host: "127.0.0.1", port: d.port } },
                  hv22222222: { id: "hv22222222", name: DEP_H, status: "starting", tier: "T0-hv", appId: APP, runtimeId: RT, image: IMG, transportKeySha256: null, relay: { host: "127.0.0.1", port: d.port } } };
  const manager = { get: (id) => views[id] || null };
  const dp = dataPlaneFor(manager); dp.server.listen(0, "127.0.0.1"); await once(dp.server, "listening");
  const splicer = createIsolationSplicer({ client: { get: async (id) => manager.get(id) }, dataAddr: `127.0.0.1:${dp.server.address().port}` });
  const records = { running: { status: "running", isolation: { instance: "hv0a1b2c3d", appId: APP } }, starting: { status: "running", isolation: { instance: "hv22222222", appId: APP } } };
  let which = "running", fragment = false; const outcomes = [];
  // the app zone hands the splicer the unwrapped stream; when `fragment` is set it hands a Duplex that re-emits the client's
  // bytes in 7-byte pieces (as a relay under load would frame them), writing back through the WebSocket unchanged
  const fragmented = (up) => {
    const d = new Duplex({ read() {}, write(c, e, cb) { up.write(c, cb); }, final(cb) { up.end(); cb(); } });
    up.on("data", (c) => { for (let i = 0; i < c.length; i += 7) d.push(c.subarray(i, i + 7)); }); up.on("end", () => d.push(null)); up.on("error", () => d.destroy());
    d.on("close", () => { try { up.destroy(); } catch {} }); return d;
  };
  const wss = new WebSocketServer({ noServer: true }); const zone = http.createServer();
  zone.on("upgrade", (req, sock, head) => { const target = isolatedTarget(DEP_H, records[which]); wss.handleUpgrade(req, sock, head, async (ws) => { const up = createWebSocketStream(ws); outcomes.push(await splicer.serve(fragment ? fragmented(up) : up, target, { close: () => ws.terminate() })); }); });
  zone.listen(0, "127.0.0.1"); await once(zone, "listening");
  t.after(() => { zone.close(); dp.server.close(); d.front.close(); });
  const via = (servername) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: "no answer within 8 s" }), 8000);
    const ws = new WebSocket(`ws://127.0.0.1:${zone.address().port}/x/${DEP_H}/https`);
    const up = createWebSocketStream(ws); up.on("error", () => {});
    const s = tls.connect({ socket: up, servername, rejectUnauthorized: false });
    const done = (v) => { clearTimeout(timer); resolve(v); };
    s.once("secureConnect", () => { const key = sha(s.getPeerX509Certificate().publicKey.export({ type: "spki", format: "der" })); s.write(`GET / HTTP/1.1\r\nHost: ${servername}\r\nConnection: close\r\n\r\n`); let body = ""; s.on("data", (c) => { body += c; }); s.on("end", () => done({ key, body })); s.on("close", () => done({ key, body })); });
    s.once("error", (e) => done({ error: e.message }));
  });
  const whole = await via("0ddbd824.app.enclave.host");
  assert.equal(whole.key, d.spkiSha, whole.error); assert.match(whole.body, /domain answers 0ddbd824/);
  fragment = true;
  const split = await via("0ddbd824.app.enclave.host");
  assert.equal(split.key, d.spkiSha, `a ClientHello arriving in 7-byte pieces: ${split.error || "no key"}`); assert.match(String(split.body), /domain answers 0ddbd824/);
  fragment = false; which = "starting";
  const starting = await via("0ddbd824.app.enclave.host");
  assert.ok(starting.error || !starting.body, "a view that is starting (no verified key yet) is not routed");
  for (let i = 0; i < 50 && outcomes.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(outcomes.map((o) => o.outcome), ["spliced", "spliced", "refused"], JSON.stringify(outcomes));
  assert.match(String(outcomes[2].why), /running|starting|identity|route/i, "the refusal names the route's state");
});
