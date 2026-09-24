// node --test windows/vbslike/datapath/node-bridge.test.mjs   (needs the repo's node_modules: ws, and supervisor.js)
import test from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, X509Certificate } from "node:crypto";
import { WebSocketServer, WebSocket, createWebSocketStream } from "ws";
import { appConfigOf, policyFor, httpPortOf, derivationOf, isolationPlan, isolatedTarget, createIsolationSplicer,
         dataPlaneFor, V1, V2, BACKEND } from "./node-bridge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.join(HERE, "..", "..", "..", "supervisor.js");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v);

// supervisor.js's own rules, through its ISOLATION_SELFTEST seam (the same seam test/isolation-claim-gate.test.mjs uses)
async function seam(c) {
  const { stdout } = await promisify(execFile)(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", ISOLATION_BACKEND: "hyperv-partition-per-app", ISOLATION_SELFTEST: JSON.stringify(c),
           INSTANCE_SELFTEST: "", POOL_SELFTEST: "", SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "",
           CFG_EDIT_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
           ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const RT = "ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8";
const MEDIA = JSON.stringify({ _media: { thumbnail: "bafkreifzvpy3jk67jklyi3war6zzlz62hmj3dd7nblpllxcckwf6eoijzq", thumbnailSvg: true } });
// Real catalog versions (Base mainnet catalog 0x18419CA2..., read 2026-09-24) and real deployments.
const HELLO = { appId: "0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed", index: 4,
                cid: "bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza", memMb: 128, ports: "", config: "", configCid: "" };
const HOOKBIN = { appId: "0xf7e65a8fdae1dd9f8c2a897f2f372cdb7f6150d1e20526fa06d10a682cc2e9e3", index: 4,
                  cid: "bafkreidocbixnql7lroykdtwx4r2fmi5n6sra4lj7b7vhscsfqn4gctlee", memMb: 256, ports: "http:8000",
                  config: MEDIA, configCid: "" };
const DEP_A = "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e";   // hello-world, deployment A
const DEP_H = "0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76";   // hookbin
const ledger = { cpuMilli: 100, gpuMilli: 0, isPublic: true, appPort: 8080 };
const BOTH = [V1, V2];
const MGR = { backend: BACKEND, catalog: { derivations: BOTH } };
const plan = (over = {}) => isolationPlan({ deploymentId: DEP_H, deployment: ledger, version: HOOKBIN, appConfig: HOOKBIN.config,
                                            hasSecrets: false, waf: {}, volumes: [], runtimeId: RT, require: BACKEND, manager: MGR,
                                            appConfigCid: "", ...over });

test("the rules agree with supervisor.js's, case for case", { timeout: 60_000 }, async () => {
  const configs = ["", null, MEDIA, JSON.stringify({ _media: {}, API_URL: "x" }), "not json", "[1,2]", JSON.stringify({})];
  const derives = [
    { catalogRef: `catalog://${HELLO.appId}/4`, wasmRef: `ipfs://${HELLO.cid}`, memMb: 128, runtimeId: RT, ports: "" },
    { catalogRef: `catalog://${HOOKBIN.appId}/4`, wasmRef: `ipfs://${HOOKBIN.cid}`, memMb: 256, runtimeId: RT, ports: "http:8000" },
    { catalogRef: `catalog://${HOOKBIN.appId}/4`, wasmRef: `ipfs://${HOOKBIN.cid}`, memMb: 64, runtimeId: RT, ports: ["http:8000"] },
    { catalogRef: `catalog://${HOOKBIN.appId}/4`, wasmRef: `ipfs://${HOOKBIN.cid}`, memMb: 300.5, runtimeId: RT, ports: "http:8000,tcp:9000" },
    { catalogRef: `catalog://${HOOKBIN.appId}/4`, wasmRef: `ipfs://${HOOKBIN.cid}`, memMb: 256, runtimeId: RT, ports: "tcp:22" },
    { catalogRef: `catalog://${HOOKBIN.appId}/4`, wasmRef: `ipfs://${HOOKBIN.cid}`, memMb: 256, runtimeId: RT, ports: "http:50000" },
  ];
  const s = await seam({ appConfig: configs, derive: derives });
  configs.forEach((c, i) => assert.equal(appConfigOf(c), s.appConfig[i], `appConfig case ${i}`));
  derives.forEach((d, i) => {
    let mine;
    try {
      const [, app, idx] = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d+)$/.exec(d.catalogRef);
      mine = derivationOf(app, idx, d.wasmRef.slice(7), policyFor(d.memMb), d.runtimeId, httpPortOf(d.ports));
    } catch (e) { mine = { error: e.message }; }
    assert.deepEqual(mine, s.derive[i], `derive case ${i}`);
  });
});

// The claim gate's VERDICTS, not only its helpers: for every input both take, the plan refuses exactly when
// supervisor.js's isolationClaimVerdict refuses. (The plan also refuses what it cannot verify - null waf, volumes,
// secrets - which the gate reads differently; those are compared only with known values here, and covered as
// "unknown" below.)
test("the plan refuses exactly when supervisor.js's claim gate refuses, input for input", { timeout: 60_000 }, async () => {
  const gateMgr = (m) => m && { backend: m.backend, supports: { gpu: false, secrets: false, egress: false, config: false, ports: false },
                                catalog: { derivations: m.catalog && m.catalog.derivations } };
  const cases = [
    {}, { require: "snp-guest-per-app" }, { require: "" }, { manager: { ...MGR, backend: "snp-guest-per-app" } },
    { deployment: { ...ledger, gpuMilli: 250 } }, { appConfig: JSON.stringify({ _media: {}, TOKEN: "x" }) }, { appConfig: MEDIA },
    { appConfigCid: "bafkreiaaaa" }, { hasSecrets: true }, { version: { ...HOOKBIN, ports: "http:8000,tcp:5432" } },
    { version: { ...HOOKBIN, ports: "tcp:22" } }, { version: { ...HELLO }, appConfig: "" }, { manager: { ...MGR, catalog: { derivations: [V1] } } },
    { volumes: ["llama-70b"] }, { deployment: { ...ledger, isPublic: false } }, { waf: { rateLimit: { perMin: 60 } } },
  ];
  const planned = cases.map((c) => plan(c));
  const gateIn = cases.map((c) => {
    const x = { deployment: ledger, version: HOOKBIN, appConfig: HOOKBIN.config, hasSecrets: false, waf: {}, volumes: [], require: BACKEND,
                manager: MGR, appConfigCid: "", ...c };
    const fw = String(x.version.ports || "").split(",").map((p) => p.trim()).filter(Boolean);
    return { require: x.require, manager: gateMgr(x.manager), gpuMilli: x.deployment.gpuMilli, config: appConfigOf(x.appConfig),
             appConfigCid: x.appConfigCid || x.version.configCid || "", hasSecrets: x.hasSecrets, firewall: fw, volumes: x.volumes,
             isPublic: x.deployment.isPublic, waf: x.waf };
  });
  const s = await seam({ verdicts: gateIn });
  cases.forEach((c, i) => assert.equal(planned[i].ok, s.verdicts[i] === null,
    `case ${JSON.stringify(c)}: plan ${planned[i].ok ? "ok" : planned[i].input} vs gate ${JSON.stringify(s.verdicts[i])}`));
});

test("real records: hello-world /1 and hookbin /2 reproduce the production derivation digests", () => {
  const h = plan();
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.equal(h.derivation, V2); assert.equal(h.httpPort, 8000);
  assert.equal(sha(canon(h.spawn.derive)), "1fb9360ddfd50a25d4740d989e5ae5fd6b6f967bf017606f39b220bb84d3303e", "hookbin's live record");
  assert.deepEqual({ ...h.spawn, derive: undefined }, { image: `ipfs://${HOOKBIN.cid}`, name: DEP_H, cpuShare: 0.1, gpuShare: 0,
    appPort: 8000, ports: [], config: "", configCid: "", egress: "", derive: undefined, isPublic: true, hasSecrets: false });
  const a = plan({ deploymentId: DEP_A, version: HELLO, appConfig: HELLO.config });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.derivation, V1);
  assert.equal(sha(canon(a.spawn.derive)), "bff33b951aade0a921edea4b0aca89712005d20cbb2c074c0f885d079e059d6c", "deployment A's live record");
  // the node's own floor (cpuFallback) never reaches the policy: another number would be another AppID
  assert.equal(plan({ version: { ...HOOKBIN, memMb: 256 } }).policy.memMiB, 256);
  // a manager that serves only /1 refuses /2 by name, and serves /1
  assert.deepEqual(pick(plan({ manager: { ...MGR, catalog: { derivations: [V1] } } })), { input: "manager.catalog.derivations", unknown: false });
  assert.equal(plan({ deploymentId: DEP_A, version: HELLO, appConfig: "", manager: { ...MGR, catalog: { derivations: [V1] } } }).ok, true);
});

const pick = (r) => ({ input: r.input, unknown: r.unknown });

test("every refusal names the input that decided, and UNKNOWN is never read as no", () => {
  const no = {
    "deployment.isPublic": { deployment: { ...ledger, isPublic: false } },
    "deployment.gpuMilli": { deployment: { ...ledger, gpuMilli: 250 } },
    hasSecrets: { hasSecrets: true },
    appConfig: { appConfig: JSON.stringify({ _media: {}, TOKEN: "x" }) },
    "version.configCid": { version: { ...HOOKBIN, configCid: "bafy..." } },
    waf: { waf: { rateLimit: { perMin: 60 } } },
    volumes: { volumes: ["llama-70b"] },
    "version.ports": { version: { ...HOOKBIN, ports: "http:8000,tcp:5432" } },
    "version.yanked": { version: { ...HOOKBIN, yanked: true } },
    require: { require: "snp-guest-per-app" },
    "manager.backend": { manager: { ...MGR, backend: "snp-guest-per-app" } },
    appConfigCid: { appConfigCid: "bafkreiaaaa" },
  };
  for (const [input, over] of Object.entries(no)) {
    const r = plan(over);
    assert.deepEqual(pick(r), { input, unknown: false }, `${input}: ${JSON.stringify(r)}`);
    assert.ok(r.why && r.why.length > 10, `${input} gives a reason`);
  }
  const unknown = {
    "deployment.isPublic": { deployment: { ...ledger, isPublic: undefined } },
    "deployment.gpuMilli": { deployment: { ...ledger, gpuMilli: undefined } },
    "deployment.cpuMilli": { deployment: { ...ledger, cpuMilli: undefined } },
    hasSecrets: { hasSecrets: null },
    appConfig: { appConfig: undefined },
    waf: { waf: null },
    volumes: { volumes: undefined },
    require: { require: undefined },
    manager: { manager: null },
    "manager.catalog.derivations": { manager: { backend: BACKEND } },
    appConfigCid: { appConfigCid: undefined },
    runtimeId: { runtimeId: "" },
    "version.memMb": { version: { ...HOOKBIN, memMb: undefined } },
    deployment: { deployment: null },
  };
  for (const [input, over] of Object.entries(unknown)) {
    const r = plan(over);
    assert.deepEqual(pick(r), { input, unknown: true }, `${input}: ${JSON.stringify(r)}`);
    assert.match(r.why, /not known here/);
  }
  assert.equal(plan({ hasSecrets: undefined }).input, "hasSecrets");
});

test("isolatedTarget names a route only for a running record with a whole identity", () => {
  const rec = { status: "running", isolation: { instance: "hv0a1b2c3d", appId: "d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24" } };
  assert.deepEqual(isolatedTarget(DEP_H, rec), { id: DEP_H, isolation: { instance: "hv0a1b2c3d", appId: rec.isolation.appId,
                                                                          expectName: "0ddbd824.app.enclave.host" } });
  assert.equal(isolatedTarget(DEP_H, { ...rec, status: "provisioning" }), null);
  assert.equal(isolatedTarget(DEP_H, { ...rec, isolation: { instance: "hv0a1b2c3d" } }), null, "no appId, no route");
  assert.equal(isolatedTarget(DEP_H, { status: "running" }), null, "not an isolated record");
  assert.equal(isolatedTarget("0x4e62", rec), null);
});

// ---- the join: a relay-shaped WebSocket client -> an app-zone-shaped WebSocket server -> the splicer -> the data
// plane -> a TLS server standing in for the domain's front. TLS must end at the stand-in, on ITS key.
async function stand() {
  // the "domain": a TLS server with its own key; nothing on the host path holds it
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
    "-subj", "/CN=enclave-domain", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore" });
  const key = fs.readFileSync(path.join(dir, "k.pem")), cert = fs.readFileSync(path.join(dir, "c.pem"));
  fs.rmSync(dir, { recursive: true, force: true });
  const spkiSha = sha(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }));
  const app = http.createServer((q, r) => r.end(`domain answers ${q.headers.host}`));
  const front = tls.createServer({ key, cert }, (s) => app.emit("connection", s));
  front.listen(0, "127.0.0.1"); await once(front, "listening");
  return { front, spkiSha, port: front.address().port };
}

test("the join: relay-shaped WebSocket -> splicer -> data plane -> the domain's own TLS, and each refusal", { timeout: 60_000 }, async (t) => {
  const d = await stand();
  const APP = "d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24";
  const IMG = "4610d5944cc2d67a6510ece964915b6a90b20ecc27a0169d514a2701c9fc9f85";
  const views = {
    hv0a1b2c3d: { id: "hv0a1b2c3d", name: DEP_H, status: "running", tier: "T0-hv", hostExcluded: false, verdict: "monitor-signed",
                  appId: APP, runtimeId: RT, image: IMG, transportKeySha256: d.spkiSha, relay: { host: "127.0.0.1", port: d.port } },
    hv99999999: { id: "hv99999999", name: DEP_A, status: "running", tier: "T0-hv", appId: APP, runtimeId: RT, image: IMG,
                  transportKeySha256: d.spkiSha, relay: { host: "127.0.0.1", port: d.port } },
  };
  const manager = { get: (id) => views[id] || null };
  const dp = dataPlaneFor(manager);
  dp.server.listen(0, "127.0.0.1"); await once(dp.server, "listening");
  // A STALE ROUTE, which is what the data plane's identity check exists for: the node read hv99999999's view (the key
  // it was verified with), and by admission time the instance was restarted with a new key. The splice carries
  // ciphertext only, so it can never see the domain's key itself; a client's own verification over this same TLS does.
  const stale = { ...views.hv99999999 };
  views.hv99999999 = { ...stale, transportKeySha256: "11".repeat(32) };
  const nodeView = (id) => (id === "hv99999999" ? stale : manager.get(id));
  const splicer = createIsolationSplicer({ client: { get: async (id) => nodeView(id) }, dataAddr: `127.0.0.1:${dp.server.address().port}` });
  const records = {
    [DEP_H]: { status: "running", isolation: { instance: "hv0a1b2c3d", appId: APP } },
    [DEP_A]: { status: "running", isolation: { instance: "hv99999999", appId: APP } },   // its route is stale (see above)
  };
  // the app zone: /x/<id>/https upgraded, unwrapped, handed to the splicer (what appzone.mjs onHead will do)
  const outcomes = [];
  const wss = new WebSocketServer({ noServer: true });
  const zone = http.createServer();
  zone.on("upgrade", (req, sock, head) => {
    const m = /^\/x\/(0x[0-9a-f]{64})\/https$/.exec(req.url);
    const target = m && isolatedTarget(m[1], records[m[1]]);
    wss.handleUpgrade(req, sock, head, async (ws) => {
      const stream = createWebSocketStream(ws);
      outcomes.push(await splicer.serve(stream, target, { close: () => ws.terminate() }));
    });
  });
  zone.listen(0, "127.0.0.1"); await once(zone, "listening");
  t.after(() => { zone.close(); dp.server.close(); d.front.close(); });
  // the relay: a client's TLS carried as binary WebSocket frames to /x/<id>/https (relay/relay.js's splice half)
  const via = (dep, servername) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${zone.address().port}/x/${dep}/https`);
    const up = createWebSocketStream(ws);
    up.on("error", () => {});
    const s = tls.connect({ socket: up, servername, rejectUnauthorized: false });
    s.once("secureConnect", () => {
      const key = sha(s.getPeerX509Certificate().publicKey.export({ type: "spki", format: "der" }));
      s.write(`GET / HTTP/1.1\r\nHost: ${servername}\r\nConnection: close\r\n\r\n`);
      let body = ""; s.on("data", (c) => { body += c; }); s.on("end", () => resolve({ key, body })); s.on("close", () => resolve({ key, body }));
    });
    s.once("error", (e) => resolve({ error: e.message }));
  });
  const ok = await via(DEP_H, "0ddbd824.app.enclave.host");
  assert.equal(ok.key, d.spkiSha, "TLS ended at the domain, on the domain's key");
  assert.match(ok.body, /domain answers 0ddbd824\.app\.enclave\.host/);
  const wrongName = await via(DEP_H, "4e62e60d.app.enclave.host");
  assert.ok(wrongName.error || !wrongName.body, "a ClientHello for another deployment's name is not served");
  const staleRoute = await via(DEP_A, "4e62e60d.app.enclave.host");
  assert.ok(staleRoute.error || !staleRoute.body, "a route whose key is no longer the instance's verified key is not admitted");
  const notOurs = await via("0x" + "ab".repeat(32), "abababab.app.enclave.host");
  assert.ok(notOurs.error || !notOurs.body, "a deployment with no isolated record is not routed");
  for (let i = 0; i < 50 && outcomes.length < 4; i++) await new Promise((r) => setTimeout(r, 20));
  const kinds = outcomes.map((o) => o.outcome === "spliced" ? "spliced" : o.kind).sort();
  assert.deepEqual(kinds, ["no-route", "refused", "spliced", "wrong-name"].sort(), JSON.stringify(outcomes));
});
