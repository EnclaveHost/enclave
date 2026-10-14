// The browser build in a REAL browser: verifier/web/index.mjs bundled by verifier/web/build.mjs (esbuild, the pinned
// version), served same-origin to Chrome for Testing 151 over the DevTools protocol, run on a fixed pack of cases built from
// the SAME fixtures the Node suites use (a genuine Genoa report, Turin ABI/2, the synthetic chain), and its verdicts compared,
// whole, with the Node build's; then the site's flow (verifyMetalBoxWeb) against a stand-in relay on the same origin. What
// this proves that the differential (test/verifier-web-differential.test.mjs, Node's WebCrypto) cannot: the bundle loads with
// no Node module on its path, Chrome's WebCrypto gives the same answers, and the Buffer stand-in carries the shared code.
// Strict integration REQUIRES the browser (no skip).
//   run: node --test test/verifier-web-browser.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { DIST, ARTIFACT, MANIFEST } from "../verifier/web/build.mjs";
import { verifyEvidence, memoryCollateral } from "../verifier/index.mjs";
import { report, MEAS, BINDING, APP_ID, spki, doc as rad, docWith, FLOOR } from "./helpers/genoa-capture.mjs";
import { synthChain, synthReport } from "./helpers/snp-synth.mjs";

const CFT = process.env.CHROME_FOR_TESTING || path.join(os.homedir(), ".cache/ms-playwright/chromium-1232/chrome-linux64/chrome");
const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
if (STRICT && !fs.existsSync(CFT)) throw new Error("strict integration: Chrome for Testing is missing");
const skip = !fs.existsSync(CFT) && "Chrome for Testing absent";
const norm = (v) => JSON.parse(JSON.stringify(v, (k, val) => (typeof val === "string" ? val.replace(/(unparseable: ).*$/, "$1<reader>") : val)));

const F = new URL("./fixtures/verifier/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url);
const read = (u) => fs.readFileSync(u), text = (u) => fs.readFileSync(u, "utf8"), b64 = (b) => Buffer.from(b).toString("base64"), hex = (b) => Buffer.from(b).toString("hex");
const sha = (...b) => createHash("sha256").update(Buffer.concat(b)).digest();
const NOW = "2026-09-24T05:00:00Z";
const chains = { Genoa: text(new URL("Genoa-cert_chain.pem", A)), Milan: text(new URL("Milan-cert_chain.pem", A)), Turin: text(new URL("Turin-cert_chain.pem", A)) };
const gCol = { chains, vceks: { Genoa: b64(read(new URL("genoa-Cloud Provider/vcek-kds-amd.der", F))) }, crls: { Genoa: b64(read(new URL("amd/Genoa-crl.der", F))) } };
const savedT = JSON.parse(text(new URL("turin-m4a/doc.json", F))), tDoc = savedT.doc ?? savedT, tReport = Buffer.from(tDoc.report, "base64");
const tSpki = Buffer.from(tDoc.transportKey, "base64"), tNonce = Buffer.from(tDoc.nonce, "hex"), tApp = Buffer.from(tDoc.appSha256, "hex");
const canon = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
const tRid = sha(Buffer.from(canon(tDoc.runtime))), bind2 = (n) => sha(Buffer.from("enclave-bind-v2\n"), tSpki, n, tRid);
const T_FLOOR = { Turin: { fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 } };
const tCol = { chains, vceks: { Turin: b64(read(new URL("turin-m4a/vcek-kds-amd.der", F))) }, crls: { Turin: b64(read(new URL("amd/Turin-crl.der", F))) } };
const S = synthChain({ revokeAsk: true });
const SP = randomBytes(91), NONCE = randomBytes(32), SYNTH_NOW = new Date().toISOString();
const sCol = (crl = S.crlDer) => ({ chains: { Genoa: S.chainPem }, vceks: { Genoa: b64(S.vcekDer) }, crls: { Genoa: b64(crl) } });
const sDoc = { format: "sev-snp-guest-metal-v1", body: synthReport(S, { reportData: Buffer.concat([sha(SP, NONCE), Buffer.alloc(32)]) }).toString("base64") };
const flippedR = Buffer.from(report); flippedR[0x2a0] ^= 1;
const v6 = Buffer.from(report); v6.writeUInt32LE(6, 0);
const freshNonce = randomBytes(32);
const gCtx = (over = {}) => ({ transportKeySpki: b64(spki), expectedBinding: hex(BINDING), expectedAppId: hex(APP_ID), now: NOW, ...over });

// The pack: every field JSON-serialisable; bytes as base64 (keys, blobs) or hex (nonces, bindings, ids); pins as an object
const PACK = [
  { name: "genoa verified", doc: rad, policy: { allowedMeasurements: [MEAS], minTcb: FLOOR }, context: gCtx(), collateral: gCol },
  { name: "genoa flipped r", doc: docWith(flippedR), policy: { allowedMeasurements: [MEAS], minTcb: FLOOR }, context: gCtx(), collateral: gCol },
  { name: "genoa CRL stale, required", doc: rad, policy: { allowedMeasurements: [MEAS], minTcb: FLOOR }, context: gCtx({ now: "2026-12-01T00:00:00Z" }), collateral: gCol },
  { name: "genoa another app", doc: rad, policy: { allowedMeasurements: [MEAS], minTcb: FLOOR }, context: gCtx({ expectedAppId: "00".repeat(32) }), collateral: gCol },
  { name: "genoa no TCB floor -> limited", doc: rad, policy: { allowedMeasurements: [MEAS] }, context: gCtx(), collateral: gCol },
  { name: "genoa version 6 -> unsupported", doc: docWith(v6), policy: { allowedMeasurements: [MEAS], minTcb: FLOOR }, context: gCtx(), collateral: gCol },
  { name: "turin verified", doc: tDoc, policy: { allowedMeasurements: [hex(tReport.subarray(0x90, 0xc0))], minTcb: T_FLOOR }, context: { transportKeySpki: b64(tSpki), nonce: hex(tNonce), expectedBinding: hex(bind2(tNonce)), expectedAppId: hex(tApp), now: NOW }, collateral: tCol },
  { name: "turin replay against a fresh nonce", doc: tDoc, policy: { allowedMeasurements: [hex(tReport.subarray(0x90, 0xc0))], minTcb: T_FLOOR }, context: { transportKeySpki: b64(tSpki), nonce: hex(freshNonce), expectedBinding: hex(bind2(freshNonce)), expectedAppId: hex(tApp), now: NOW }, collateral: tCol },
  { name: "synthetic metal with nonce -> verified", doc: sDoc, policy: { allowedMeasurements: ["77".repeat(48)], minTcb: FLOOR }, rootsPin: { Genoa: S.arkFp }, context: { transportKeySpki: b64(SP), nonce: hex(NONCE), now: SYNTH_NOW }, collateral: sCol() },
  { name: "synthetic ASK revoked", doc: sDoc, policy: { allowedMeasurements: ["77".repeat(48)], minTcb: FLOOR }, rootsPin: { Genoa: S.arkFp }, context: { transportKeySpki: b64(SP), nonce: hex(NONCE), now: SYNTH_NOW }, collateral: sCol(S.crlRevokingAsk) },
  { name: "synthetic under the real AMD pin", doc: sDoc, policy: { allowedMeasurements: ["77".repeat(48)], minTcb: FLOOR }, context: { transportKeySpki: b64(SP), nonce: hex(NONCE), now: SYNTH_NOW }, collateral: sCol() },
  { name: "unknown format", doc: { format: "nope", body: rad.report }, policy: {}, context: { transportKeySpki: b64(spki), now: NOW }, collateral: gCol },
];
const nodeOpts = (e) => ({
  policy: { snp: { ...e.policy, ...(e.rootsPin ? { roots: new Map(Object.entries(e.rootsPin)) } : {}) } },
  context: { ...e.context, transportKeySpki: Buffer.from(e.context.transportKeySpki, "base64"), ...(e.context.nonce ? { nonce: Buffer.from(e.context.nonce, "hex") } : {}), ...(e.context.expectedBinding ? { expectedBinding: Buffer.from(e.context.expectedBinding, "hex") } : {}), ...(e.context.expectedAppId ? { expectedAppId: Buffer.from(e.context.expectedAppId, "hex") } : {}) },
  collateral: memoryCollateral({ chains: e.collateral.chains, vceks: Object.fromEntries(Object.entries(e.collateral.vceks).map(([k, v]) => [k, Buffer.from(v, "base64")])), crls: Object.fromEntries(Object.entries(e.collateral.crls).map(([k, v]) => [k, Buffer.from(v, "base64")])) }),
});
// the page: the same materialisation, in the browser's own primitives
const PAGE = `<!doctype html><meta charset="utf-8"><title>verifier web harness</title><script type="module">
import { verifyEvidenceWeb, memoryCollateral, verifyMetalBoxWeb } from "./bundle.js";
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)), hex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
const mapB64 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, b64(v)]));
window.run = async () => {
  const pack = await (await fetch("./pack.json")).json(); const out = [];
  for (const e of pack) {
    const context = { ...e.context, transportKeySpki: b64(e.context.transportKeySpki) };
    for (const k of ["nonce", "expectedBinding", "expectedAppId"]) if (e.context[k]) context[k] = hex(e.context[k]);
    const policy = { snp: { ...e.policy, ...(e.rootsPin ? { roots: new Map(Object.entries(e.rootsPin)) } : {}) } };
    const collateral = memoryCollateral({ chains: e.collateral.chains, vceks: mapB64(e.collateral.vceks), crls: mapB64(e.collateral.crls) });
    let verdict; try { verdict = await verifyEvidenceWeb(e.doc, { policy, context, collateral }); } catch (err) { verdict = { thrown: String(err && err.stack || err) }; }
    out.push({ name: e.name, verdict });
  }
  return { userAgent: navigator.userAgent, hasBuffer: typeof Buffer, out };
};
// the site's flow in the page: the stand-in relay (this origin) answers the fresh attestation and the KDS mirror
window.runMetalBox = (name, expected) => verifyMetalBoxWeb({ apiBase: location.origin, name, expected });
window.ready = true;
</script>`;

// the stand-in relay for the site's flow: a metal document bound to the CALLER's nonce, signed by the synthetic chain's
// VCEK (so the AMD root pin refuses it), and the KDS mirror's three paths serving that chain
const relaySeen = [];
function standInRelay(req, res) {
  const u = new URL(req.url, "http://x");
  if (!u.pathname.startsWith("/v1/")) return false;
  relaySeen.push(u.pathname + u.search);
  const m = /^\/v1\/enclaves\/([A-Za-z0-9_-]+)\/attestation$/.exec(u.pathname);
  if (m) {
    const nonce = Buffer.from(u.searchParams.get("nonce") || "", "hex");
    const body = synthReport(S, { reportData: Buffer.concat([sha(SP, nonce), Buffer.alloc(32)]) }).toString("base64");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name: m[1], nonce: nonce.toString("hex"), document: { format: "sev-snp-guest-metal-v1", body, transportKey: b64(SP), name: m[1] }, operatorAllowlist: { source: "test", admittedAtAttach: "77".repeat(48), measurements: ["77".repeat(48)] } }));
    return true;
  }
  if (u.pathname === "/v1/amd-kds/vcek/v1/Genoa/cert_chain") { res.end(S.chainPem); return true; }
  if (u.pathname === "/v1/amd-kds/vcek/v1/Genoa/crl") { res.end(S.crlDer); return true; }
  if (u.pathname.startsWith("/v1/amd-kds/vcek/v1/Genoa/")) { res.end(S.vcekDer); return true; }
  res.writeHead(404); res.end(); return true;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "web-browser-"));
let server, port, chrome, browser;
test.after(async () => { try { await browser?.close(); } catch {} if (chrome) { try { process.kill(-chrome.pid, "SIGKILL"); } catch {} } server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("the COMMITTED artifact (verifier/web/dist, reproducible: test/verifier-web-package.test.mjs) is what the page loads: its hash is the manifest's, no Node module survives in it, within a size bound", { skip }, async (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, MANIFEST), "utf8")), src = fs.readFileSync(path.join(DIST, ARTIFACT));
  assert.equal(createHash("sha256").update(src).digest("hex"), manifest.artifact.sha256, "the artifact on disk is the manifest's");
  t.diagnostic(`artifact ${src.length} bytes, ${manifest.inputs.length} inputs, sha256 ${manifest.artifact.sha256.slice(0, 16)}`);
  assert.ok(src.length < 512 * 1024, `bundle ${src.length} bytes`);
  const text = src.toString("utf8");
  assert.ok(!/from\s*["']node:/.test(text) && !/require\(["']node:/.test(text), "no node: import survives in the bundle");
  fs.writeFileSync(path.join(tmp, "bundle.js"), src); fs.writeFileSync(path.join(tmp, "index.html"), PAGE); fs.writeFileSync(path.join(tmp, "pack.json"), JSON.stringify(PACK));
});

test("Chrome for Testing 151 runs the pack and every verdict equals the Node build's", { skip }, async (t) => {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };
  server = http.createServer((req, res) => { if (req.url === "/favicon.ico") { res.writeHead(204); return res.end(); } if (standInRelay(req, res)) return; const f = path.join(tmp, path.basename(new URL(req.url, "http://x").pathname) || "index.html"); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); port = server.address().port;
  const profile = path.join(tmp, "profile");
  chrome = spawn(CFT, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  const endpoint = await new Promise((resolve, reject) => { chrome.stderr.on("data", (c) => { log += c; const m = /DevTools listening on (ws:\S+)/.exec(log); if (m) resolve(m[1]); }); chrome.on("exit", () => reject(new Error(`chrome exited before listening: ${log.slice(-400)}`))); setTimeout(() => reject(new Error(`chrome did not start listening: ${log.slice(-400)}`)), 30000); });
  browser = await chromium.connectOverCDP(endpoint);
  const page = await browser.contexts()[0].newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
  const r = await page.evaluate(() => window.run());
  assert.match(r.userAgent, /Chrome\/151\./, "the verdicts came from the real browser");
  assert.equal(r.hasBuffer, "undefined", "no global Buffer on the page: the bundle carries its own");
  assert.deepEqual(errors, [], "no page errors");
  assert.equal(r.out.length, PACK.length);
  const seen = {};
  for (const e of PACK) {
    const got = r.out.find((o) => o.name === e.name); assert.ok(got && !got.verdict.thrown, `${e.name}: ${got && got.verdict.thrown}`);
    const want = await verifyEvidence(e.doc, nodeOpts(e));
    assert.equal(got.verdict.status, want.status, `${e.name}: status (node: ${want.reasons.at(-1)} | browser: ${got.verdict.reasons.at(-1)})`);
    assert.deepEqual(norm(got.verdict), norm(want), e.name);
    seen[want.status] = (seen[want.status] || 0) + 1;
  }
  t.diagnostic(`browser verdicts: ${JSON.stringify(seen)}`);
  for (const s of ["verified", "limited", "rejected", "unsupported"]) assert.ok(seen[s], `a ${s} verdict ran in the browser`);
});

test("the site's flow in the page: OUR nonce reaches the stand-in relay and the report binding, the KDS mirror is the collateral source, and a chain to a root that is not AMD's pin is REJECTED, never verified", { skip }, async () => {
  const page = await browser.contexts()[0].newPage(); await page.goto(`http://127.0.0.1:${port}/index.html`); await page.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
  relaySeen.length = 0;
  const r = await page.evaluate(([n]) => window.runMetalBox(n, null), ["box1"]);
  const asked = relaySeen.find((u) => u.startsWith("/v1/enclaves/box1/attestation?nonce="));
  assert.ok(asked, `the page asked the relay for a fresh document: ${relaySeen.join(", ")} / ${JSON.stringify(r).slice(0, 600)}`);
  assert.equal(new URL(asked, "http://x").searchParams.get("nonce"), r.nonce, "the nonce the relay saw is the one the verdict names");
  assert.ok(relaySeen.some((u) => u.startsWith("/v1/amd-kds/vcek/v1/Genoa/")), "collateral came through the KDS mirror path");
  assert.equal(r.status, "rejected", r.reasons.join("\n")); assert.equal(r.admissionSafe, false); assert.deepEqual(r.failedChecks, ["chain"]);
  assert.match(r.reasons.at(-1), /pinned/);
  assert.equal(r.transportKeySha256, hex(sha(SP)));
  const bad = await page.evaluate(([n]) => window.runMetalBox(n, null), ["../x"]);
  assert.equal(bad.status, "unavailable");
  await page.close();
});
