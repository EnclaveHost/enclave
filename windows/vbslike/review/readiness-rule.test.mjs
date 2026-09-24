// windows/vbslike/review/readiness-rule.test.mjs: the agreed "running" rule for a NucBox partition, as an executable spec.
//
// Agreed 2026-09-24 between the Windows owner (enclave-d1) and the guest lane (enclave-5d), HV-GUEST.md and ready.go:
//   running  = the attestation document verified on THIS handshake's key with a fresh nonce (judge-hv: monitor-signed)
//              AND GET /.well-known/enclave-ready 200 on a session with the SAME key, within a deadline;
//   starting = the document verifies but the app's port does not accept yet (ready 503), before the deadline;
//   failed   = anything else, with the reason: another key, another app, an untrusted launcher key, the deadline.
// Never running on console bytes, never running on ready alone, never "attested" (T0-hv: the host is not excluded).
//
// A FAKE DOMAIN serves what the real front serves: a launcher-signed document per windows/vbslike/host/src/report.rs
// (Ed25519 over "vbslike-report-v1\n" || canonical(doc); reportData = Bind2(handshake key, nonce, RuntimeID) || AppID)
// and enclave-ready. The first test proves the fake is faithful by judging it with the ABI/2 judge-hv.mjs. The rest
// drive the manager's seam `windows/vbslike/manager/ready.mjs`: judgeRunning({ host, port, appId, launcherKey,
// expectRuntime, deadlineMs }) -> { status: "running"|"starting"|"failed", reason, checks }. Until the seam exists,
// each of those fails with "seam missing", which is the correct reading of the manager today. A running verdict also
// carries transportKeySha256 (sha256 of the handshake's SPKI): the datapath's enclave-splice/1 admits a route on it.
//   run: node --test windows/vbslike/review/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { pathToFileURL } from "node:url";
import { bind2, runtimeId } from "../../../isolation/contract/runtime.mjs";
import { judge, canonical, SIGN_DOMAIN, FORMAT, TIER } from "../verify/judge-hv.mjs";

const APP = "9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45";     // hello-world 1.0.4, the first app
const OTHER_APP = "d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24";
const RUNTIME = { name: "wasmtime", version: "48.0.1", execution: "jit", targetIsa: "x86_64", hostIsa: "x86_64", cpuFeatures: "host-detected", wx: "enforced", cache: "none" };
const SELFTEST = "exec_pages=allowed wx=clean maps=3 scope=all-processes";
const b64 = (b) => Buffer.from(b).toString("base64");
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");

/** An Ed25519 launcher key, as the Rust launcher mints one: the report carries the raw 32-byte public key in base64. */
function launcherKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { privateKey, keyB64: b64(raw) };
}
function testCert(dir) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=enclave-domain"], { stdio: "ignore" });
  const cert = fs.readFileSync(path.join(dir, "cert.pem")), key = fs.readFileSync(path.join(dir, "key.pem"));
  const spki = new (require("node:crypto").X509Certificate)(cert).publicKey.export({ type: "spki", format: "der" });
  return { cert, key, spki };
}
import { createRequire } from "node:module"; const require = createRequire(import.meta.url);

/**
 * The domain's front, faked: one TLS key, the document bound to `boundSpki` (its own key unless a test says
 * otherwise), signed by `signer`, and enclave-ready answering `ready`.
 */
class FakeDomain {
  constructor({ appId = APP, ready = { status: 200 }, boundSpki = null, signer = null, docAppId = null, readyAppId = null } = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-domain-"));
    const { cert, key, spki } = testCert(this.dir);
    this.spki = spki; this.appId = appId; this.ready = ready; this.boundSpki = boundSpki; this.signer = signer || launcherKey();
    this.docAppId = docAppId || appId; this.readyAppId = readyAppId || appId; this.hits = [];
    this.server = https.createServer({ cert, key }, (req, res) => this.handle(req, res));
  }
  async listen() { await new Promise((r) => this.server.listen(0, "127.0.0.1", r)); this.port = this.server.address().port; return this; }
  close() { this.server.close(); fs.rmSync(this.dir, { recursive: true, force: true }); }
  signedReport(nonceHex) {
    const rd = Buffer.concat([Buffer.from(bind2(this.boundSpki || this.spki, Buffer.from(nonceHex, "hex"), runtimeId(RUNTIME))), Buffer.from(this.docAppId, "hex")]);
    const doc = { format: FORMAT, tier: TIER,
      platform: { os: "windows", hypervisor: "hyper-v", partition: "hcs-child-partition", isolation: "none", hostExcluded: false },
      launcher: { key: this.signer.keyB64, startedMs: 1 }, partition: { vmId: "GUID-1", guestImageSha256: "44".repeat(32), kernelSha256: "7f".repeat(32), vcpus: 2, memMiB: 1024 },
      domain: { label: "dep-1", appSha256: this.docAppId }, reportData: rd.toString("hex"),
      boundary: "tier=T0-hv vmpl=n/a vmpl_floor=n/a vmpl0=n/a partition=hcs-child host_excluded=no", issuedMs: Date.now() };
    const sig = edSign(null, Buffer.concat([SIGN_DOMAIN, Buffer.from(canonical(doc))]), this.signer.privateKey);
    return { doc, sig: b64(sig) };
  }
  handle(req, res) {
    const u = new URL(req.url, "https://x"); this.hits.push(u.pathname);
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (u.pathname === "/.well-known/enclave-attestation") {
      const nonce = u.searchParams.get("nonce") || "";
      if (!/^[0-9a-f]{64}$/.test(nonce)) return json(400, { error: "nonce" });
      return json(200, { tier: TIER, format: FORMAT, report: b64(JSON.stringify(this.signedReport(nonce))), transportKey: b64(this.spki),
                         appSha256: this.docAppId, nonce, abi: "enclave-domain-abi/2", runtime: RUNTIME, runtimeSelfTest: SELFTEST });
    }
    if (u.pathname === "/.well-known/enclave-ready") {
      const r = typeof this.ready === "function" ? this.ready() : this.ready;
      return json(r.status, r.status === 200 ? { ready: true, appId: this.readyAppId, mode: "serve", port: 8080 } : { ready: false, why: "the app is not accepting connections on 127.0.0.1:8080 yet" });
    }
    if (u.pathname === "/.well-known/enclave-csr" || u.pathname === "/.well-known/enclave-cert") return json(404, { error: "a partition has no deployment name" });
    res.writeHead(200, { "content-type": "text/plain" }); res.end("Hello World!\n");
  }
}
/** One TLS session, as a client that pins by the handshake key; every request on it is answered by that key. */
function session(port) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port, servername: "domain.test", rejectUnauthorized: false });
    s.once("error", reject);
    s.once("secureConnect", () => {
      const spki = s.getPeerX509Certificate().publicKey.export({ type: "spki", format: "der" });
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); agent.createConnection = () => s;
      const req = (method, p, headers = {}) => new Promise((res, rej) => {
        const r = http.request({ agent, method, path: p, headers: { host: "domain.test", ...headers } }, (a) => { const c = []; a.on("data", (x) => c.push(x)); a.on("end", () => res({ status: a.statusCode, headers: a.headers, body: Buffer.concat(c).toString() })); });
        r.on("error", rej); r.end();
      });
      resolve({ spki, req, close: () => s.destroy() });
    });
  });
}
const SEAM = new URL("../manager/ready.mjs", import.meta.url);
async function seam() {
  if (!fs.existsSync(SEAM)) assert.fail("seam missing: windows/vbslike/manager/ready.mjs exporting judgeRunning({ host, port, appId, launcherKey, expectRuntime, deadlineMs }) -> { status, reason, checks }");
  const m = await import(pathToFileURL(SEAM.pathname).href);
  assert.equal(typeof m.judgeRunning, "function", "ready.mjs exports judgeRunning");
  return m.judgeRunning;
}
const run = async (d, over = {}) => (await seam())({ host: "127.0.0.1", port: d.port, appId: APP, launcherKey: d.signer.keyB64, expectRuntime: RUNTIME, deadlineMs: 3000, ...over });

test("the branch's judge-hv.mjs is the ABI/2 one (67762434 = ef1b2077): the ABI/1-only copy rejects every document from the current image", () => {
  const src = fs.readFileSync(new URL("../verify/judge-hv.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ checkRuntime \} from "\.\.\/\.\.\/\.\.\/isolation\/m2\/judge\.mjs"/, "the runtime half is the shared checkRuntime");
  assert.match(src, /expectRuntime/, "ABI/2: the caller pins the runtime identity");
});

test("the fake domain is faithful: judge-hv says monitor-signed on THIS handshake's key and a fresh nonce; ready 200 on the same session; refusals on another key, nonce, app or launcher key", async () => {
  const d = await new FakeDomain().listen();
  try {
    const s = await session(d.port);
    assert.ok(s.spki.equals(d.spki));
    const nonce = randomBytes(32);
    const a = await s.req("GET", `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`);
    const doc = JSON.parse(a.body);
    const v = judge({ doc, spki: s.spki, nonce, expectedAppSha256: APP, launcherKey: d.signer.keyB64, expectRuntime: RUNTIME });
    assert.equal(v.verdict, "monitor-signed", v.reasons.join("; "));
    assert.equal(v.checks["platform states host_excluded=false"], true);
    const r = await s.req("GET", "/.well-known/enclave-ready");
    assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).appId, APP);
    assert.equal(judge({ doc, spki: randomBytes(91), nonce, expectedAppSha256: APP, launcherKey: d.signer.keyB64, expectRuntime: RUNTIME }).verdict, "reject", "another key");
    assert.equal(judge({ doc, spki: s.spki, nonce: randomBytes(32), expectedAppSha256: APP, launcherKey: d.signer.keyB64, expectRuntime: RUNTIME }).verdict, "reject", "another nonce");
    assert.equal(judge({ doc, spki: s.spki, nonce, expectedAppSha256: OTHER_APP, launcherKey: d.signer.keyB64, expectRuntime: RUNTIME }).verdict, "reject", "another app");
    assert.notEqual(judge({ doc, spki: s.spki, nonce, expectedAppSha256: APP, launcherKey: launcherKey().keyB64, expectRuntime: RUNTIME }).verdict, "monitor-signed", "an untrusted launcher key");
    assert.equal(judge({ doc, spki: s.spki, nonce, expectedAppSha256: APP, launcherKey: d.signer.keyB64, expectRuntime: { ...RUNTIME, version: "47.0.0" } }).verdict, "reject", "another runtime identity (ABI/2)");
    s.close();
  } finally { d.close(); }
});

test("RUNNING: the document verified on this handshake's key with a fresh nonce AND ready 200 on the same key", async () => {
  const d = await new FakeDomain().listen();
  try {
    const v = await run(d);
    assert.equal(v.status, "running", v.reason);
    assert.equal(v.checks.document, true); assert.equal(v.checks.ready, true);
    assert.ok(d.hits.includes("/.well-known/enclave-attestation") && d.hits.includes("/.well-known/enclave-ready"), "both were asked");
    assert.doesNotMatch(JSON.stringify(v), /attested/i, "T0-hv is never attested");
    // the datapath (windows/vbslike/datapath/datapath.mjs, enclave-splice/1) admits a route only on `key=` the sha256 of
    // the TLS key the manager's VERIFYING handshake saw: a running verdict must carry it, or no route can ever be admitted
    assert.equal(v.transportKeySha256, sha256hex(d.spki), "transportKeySha256 = sha256(the SPKI this judgement's handshake saw)");
  } finally { d.close(); }
});

test("STARTING: the document verifies but the app's port does not accept yet (ready 503), before the deadline", async () => {
  const d = await new FakeDomain({ ready: { status: 503 } }).listen();
  try {
    const v = await run(d, { deadlineMs: 400 });
    assert.notEqual(v.status, "running", "ready 503 is not running");
    assert.ok(v.status === "starting" || (v.status === "failed" && /deadline|within/i.test(v.reason)), `${v.status}: ${v.reason}`);
  } finally { d.close(); }
});

test("NEVER RUNNING on ready alone: a document bound to ANOTHER key with ready 200 is failed at the document", async () => {
  const d = await new FakeDomain({ boundSpki: randomBytes(91) }).listen();
  try {
    const v = await run(d);
    assert.equal(v.status, "failed", `${v.status}: ${v.reason}`); assert.equal(v.checks.document, false);
  } finally { d.close(); }
});

test("NEVER RUNNING under an untrusted launcher key, for another app, or with a ready answer naming another app", async () => {
  const d = await new FakeDomain().listen();
  try {
    let v = await run(d, { launcherKey: launcherKey().keyB64 });
    assert.equal(v.status, "failed", `untrusted launcher key: ${v.status} ${v.reason}`);
    v = await run(d, { appId: OTHER_APP });
    assert.equal(v.status, "failed", `another app: ${v.status} ${v.reason}`);
  } finally { d.close(); }
  const e = await new FakeDomain({ readyAppId: OTHER_APP }).listen();
  try {
    const v = await run(e);
    assert.notEqual(v.status, "running", `ready names ${OTHER_APP.slice(0, 8)}, the document ${APP.slice(0, 8)}: ${v.status} ${v.reason}`);
  } finally { e.close(); }
});

test("a 200 that is not the readiness document is NOT ready: on an initrd without the route the APP answers the path (measured on the box: 200 \"Hello World!\\n\" for /.well-known/enclave-ready), and the app's own answer must never count", async () => {
  const d = await new FakeDomain({ ready: { status: 200 } }).listen();
  d.handle = ((orig) => function (req, res) {   // the front without the route: everything not attestation goes to the app
    const u = new URL(req.url, "https://x");
    if (u.pathname === "/.well-known/enclave-ready") { this.hits.push(u.pathname); res.writeHead(200, { "content-type": "text/plain" }); return res.end("Hello World!\n"); }
    return orig.call(this, req, res);
  })(d.handle);
  try {
    const v = await run(d, { deadlineMs: 400 });
    assert.notEqual(v.status, "running", `a plain 200 from the app was read as ready: ${v.status} ${v.reason}`);
  } finally { d.close(); }
});

test("the deadline bounds the whole judgement: a domain that never becomes ready is failed with the reason, not starting forever", async () => {
  const d = await new FakeDomain({ ready: { status: 503 } }).listen();
  try {
    const t0 = Date.now();
    const v = await run(d, { deadlineMs: 300 });
    assert.ok(Date.now() - t0 < 3000, "it returned near the deadline");
    assert.ok(v.status === "starting" || v.status === "failed"); assert.notEqual(v.status, "running");
    if (v.status === "failed") assert.match(String(v.reason), /ready|deadline|within/i);
  } finally { d.close(); }
});
