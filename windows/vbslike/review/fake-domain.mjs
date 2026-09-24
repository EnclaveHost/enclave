// windows/vbslike/review/fake-domain.mjs: a NucBox partition's front, faked faithfully for review tests.
// One TLS key; the attestation document is a launcher-signed report per windows/vbslike/host/src/report.rs (Ed25519 over
// "vbslike-report-v1\n" || canonical(doc); reportData = Bind2(handshake key, nonce, RuntimeID) || AppID; ABI/2 with the
// runtime identity and self-test), framed as the Go front frames it (chunked over 2 KB, Content-Length below); enclave-ready
// answers the readiness document. Shared by readiness-rule.test.mjs (the rule) and record-to-route.test.mjs (the join).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign, X509Certificate } from "node:crypto";
import { bind2, runtimeId } from "../../../isolation/contract/runtime.mjs";
import { canonical, SIGN_DOMAIN, FORMAT, TIER } from "../verify/judge-hv.mjs";

export const APP = "9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45";     // hello-world 1.0.4, the first app
export const OTHER_APP = "d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24";
export const RUNTIME = { name: "wasmtime", version: "48.0.1", execution: "jit", targetIsa: "x86_64", hostIsa: "x86_64", cpuFeatures: "host-detected", wx: "enforced", cache: "none" };
export const SELFTEST = "exec_pages=allowed wx=clean maps=3 scope=all-processes";
export const b64 = (b) => Buffer.from(b).toString("base64");
export const sha256hex = (b) => createHash("sha256").update(b).digest("hex");

/** An Ed25519 launcher key, as the Rust launcher mints one: the report carries the raw 32-byte public key in base64. */
export function launcherKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { privateKey, keyB64: b64(raw) };
}
export function testCert(dir) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=enclave-domain"], { stdio: "ignore" });
  const cert = fs.readFileSync(path.join(dir, "cert.pem")), key = fs.readFileSync(path.join(dir, "key.pem"));
  const spki = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
  return { cert, key, spki };
}

/**
 * The domain's front, faked: one TLS key, the document bound to `boundSpki` (its own key unless a test says
 * otherwise), signed by `signer`, and enclave-ready answering `ready`.
 */
export class FakeDomain {
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
    // framed as the real front (Go net/http) frames it: a body over Go's 2,048-byte buffer goes out chunked (the
    // attestation document is ~2.2 KB), a small body carries Content-Length (the readiness document)
    const json = (status, body) => { const b = Buffer.from(JSON.stringify(body)); const h = { "content-type": "application/json" }; if (b.length <= 2048) h["content-length"] = String(b.length); res.writeHead(status, h); res.end(b); };
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
export function session(port) {
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
