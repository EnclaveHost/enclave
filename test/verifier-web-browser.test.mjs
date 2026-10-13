// The browser build in a REAL browser: verifier/web/index.mjs bundled by verifier/web/build.mjs (esbuild, the pinned
// version), served same-origin to Chrome for Testing 151 over the DevTools protocol, run on a fixed pack of cases built from
// the SAME fixtures the Node suites use (Genoa hosted, Turin ABI/2, the synthetic chain), and its verdicts compared, whole,
// with the Node build's. What this proves that the differential (test/verifier-web-differential.test.mjs, Node's WebCrypto)
// cannot: the bundle loads with no Node module on its path, Chrome's WebCrypto and DecompressionStream give the same answers,
// and the Buffer stand-in carries the shared code. Strict integration REQUIRES the browser (no skip).
//   run: node --test test/verifier-web-browser.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { DIST, ARTIFACT, MANIFEST } from "../verifier/web/build.mjs";
import { verifyEvidence, memoryCollateral, spkiOfCert } from "../verifier/index.mjs";
import { createShadow, WELL_KNOWN } from "../verifier/web/shadow.mjs";
import { synthChain, synthReport } from "./helpers/snp-synth.mjs";

const CFT = process.env.CHROME_FOR_TESTING || path.join(os.homedir(), ".cache/ms-playwright/chromium-1232/chrome-linux64/chrome");
const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
if (STRICT && !fs.existsSync(CFT)) throw new Error("strict integration: Chrome for Testing is missing");
const skip = !fs.existsSync(CFT) && "Chrome for Testing absent";
const norm = (v) => JSON.parse(JSON.stringify(v, (k, val) => (typeof val === "string" ? val.replace(/(unparseable: ).*$/, "$1<reader>").replace(/(unreadable or over the cap \().*\)$/, "$1<decoder>)") : val)));

const F = new URL("./fixtures/verifier/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url);
const read = (u) => fs.readFileSync(u), text = (u) => fs.readFileSync(u, "utf8"), b64 = (b) => Buffer.from(b).toString("base64"), hex = (b) => Buffer.from(b).toString("hex");
const sha = (...b) => createHash("sha256").update(Buffer.concat(b)).digest();
const NOW = "2026-09-24T05:00:00Z";
const chains = { Genoa: text(new URL("Genoa-cert_chain.pem", A)), Milan: text(new URL("Milan-cert_chain.pem", A)), Turin: text(new URL("Turin-cert_chain.pem", A)) };
const rad = JSON.parse(text(new URL("genoa-tinfoil/rad.json", F))), report = gunzipSync(Buffer.from(rad.body, "base64"));
const certPem = text(new URL("genoa-tinfoil/tls-cert.pem", F)), { spki } = spkiOfCert(certPem), MEAS = hex(report.subarray(0x90, 0xc0));
const FLOOR = { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } };
const gCol = { chains, vceks: { Genoa: b64(read(new URL("genoa-tinfoil/vcek-kds-amd.der", F))) }, crls: { Genoa: b64(read(new URL("amd/Genoa-crl.der", F))) } };
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

// The pack: every field JSON-serialisable; bytes as base64 (keys, blobs) or hex (nonces, bindings, ids); pins as an object
const PACK = [
  { name: "genoa verified", doc: rad, policy: { allowedMeasurements: [MEAS], minTcb: FLOOR }, context: { transportKeySpki: b64(spki), certPem, host: "inference.tinfoil.sh", now: NOW }, collateral: gCol },
  { name: "genoa flipped r", doc: { format: rad.format, body: gzipSync(flippedR).toString("base64") }, policy: { allowedMeasurements: [MEAS], minTcb: FLOOR }, context: { transportKeySpki: b64(spki), certPem, host: "inference.tinfoil.sh", now: NOW }, collateral: gCol },
  { name: "genoa CRL stale, required", doc: rad, policy: { allowedMeasurements: [MEAS], minTcb: FLOOR }, context: { transportKeySpki: b64(spki), certPem, host: "inference.tinfoil.sh", now: "2026-12-01T00:00:00Z" }, collateral: gCol },
  { name: "genoa host mismatch", doc: rad, policy: { allowedMeasurements: [MEAS], minTcb: FLOOR }, context: { transportKeySpki: b64(spki), certPem, host: "other.tinfoil.sh", now: NOW }, collateral: gCol },
  { name: "genoa no TCB floor -> limited", doc: rad, policy: { allowedMeasurements: [MEAS] }, context: { transportKeySpki: b64(spki), certPem, host: "inference.tinfoil.sh", now: NOW }, collateral: gCol },
  { name: "genoa version 6 -> unsupported", doc: { format: rad.format, body: gzipSync(v6).toString("base64") }, policy: { allowedMeasurements: [MEAS], minTcb: FLOOR }, context: { transportKeySpki: b64(spki), certPem, host: "inference.tinfoil.sh", now: NOW }, collateral: gCol },
  { name: "turin verified", doc: tDoc, policy: { allowedMeasurements: [hex(tReport.subarray(0x90, 0xc0))], minTcb: T_FLOOR }, context: { transportKeySpki: b64(tSpki), nonce: hex(tNonce), expectedBinding: hex(bind2(tNonce)), expectedAppId: hex(tApp), now: NOW }, collateral: tCol },
  { name: "turin replay against a fresh nonce", doc: tDoc, policy: { allowedMeasurements: [hex(tReport.subarray(0x90, 0xc0))], minTcb: T_FLOOR }, context: { transportKeySpki: b64(tSpki), nonce: hex(freshNonce), expectedBinding: hex(bind2(freshNonce)), expectedAppId: hex(tApp), now: NOW }, collateral: tCol },
  { name: "synthetic metal with nonce -> verified", doc: sDoc, policy: { allowedMeasurements: ["77".repeat(48)], minTcb: FLOOR }, rootsPin: { Genoa: S.arkFp }, context: { transportKeySpki: b64(SP), nonce: hex(NONCE), now: SYNTH_NOW }, collateral: sCol() },
  { name: "synthetic ASK revoked", doc: sDoc, policy: { allowedMeasurements: ["77".repeat(48)], minTcb: FLOOR }, rootsPin: { Genoa: S.arkFp }, context: { transportKeySpki: b64(SP), nonce: hex(NONCE), now: SYNTH_NOW }, collateral: sCol(S.crlRevokingAsk) },
  { name: "synthetic under the real AMD pin", doc: sDoc, policy: { allowedMeasurements: ["77".repeat(48)], minTcb: FLOOR }, context: { transportKeySpki: b64(SP), nonce: hex(NONCE), now: SYNTH_NOW }, collateral: sCol() },
  { name: "unknown format", doc: { format: "nope", body: rad.body }, policy: {}, context: { transportKeySpki: b64(spki), now: NOW }, collateral: gCol },
];
const nodeOpts = (e) => ({
  policy: { snp: { ...e.policy, ...(e.rootsPin ? { roots: new Map(Object.entries(e.rootsPin)) } : {}) } },
  context: { ...e.context, transportKeySpki: Buffer.from(e.context.transportKeySpki, "base64"), ...(e.context.nonce ? { nonce: Buffer.from(e.context.nonce, "hex") } : {}), ...(e.context.expectedBinding ? { expectedBinding: Buffer.from(e.context.expectedBinding, "hex") } : {}), ...(e.context.expectedAppId ? { expectedAppId: Buffer.from(e.context.expectedAppId, "hex") } : {}) },
  collateral: memoryCollateral({ chains: e.collateral.chains, vceks: Object.fromEntries(Object.entries(e.collateral.vceks).map(([k, v]) => [k, Buffer.from(v, "base64")])), crls: Object.fromEntries(Object.entries(e.collateral.crls).map(([k, v]) => [k, Buffer.from(v, "base64")])) }),
});
// the page: the same materialisation, in the browser's own primitives
const PAGE = `<!doctype html><meta charset="utf-8"><title>verifier web harness</title><script type="module">
import { verifyEvidenceWeb, memoryCollateral, createShadow } from "./bundle.js";
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
// the shadow adapter in the page: same origin for the well-known paths and the collateral mirror; the fixed clock of the pack
window.runShadow = async (expected, primary, roots) => {
  const s = createShadow({ enabled: true, origin: location.origin, collateralBase: location.origin, now: () => new Date("${NOW}"), roots: roots ? new Map(Object.entries(roots)) : null });
  const off = createShadow({ origin: location.origin, collateralBase: location.origin });
  return { off: await off.run({ host: "inference.tinfoil.sh", expected }), on: await s.run({ host: "inference.tinfoil.sh", expected, primary }) };
};
window.ready = true;
</script>`;

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
  const CHIP = report.subarray(0x1a0, 0x1e0).toString("hex");
  const wellKnown = (p, res) => {   // the shadow adapter's five paths, from the same fixtures
    if (p === WELL_KNOWN.document) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(rad)); return true; }
    if (p === WELL_KNOWN.certificate) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ certificate: certPem })); return true; }
    if (p === "/vcek/v1/Genoa/cert_chain") { res.end(chains.Genoa); return true; }
    if (p === `/vcek/v1/Genoa/${CHIP}`) { res.end(read(new URL("genoa-tinfoil/vcek-kds-amd.der", F))); return true; }
    if (p === "/vcek/v1/Genoa/crl") { res.end(read(new URL("amd/Genoa-crl.der", F))); return true; }
    return false;
  };
  server = http.createServer((req, res) => { if (req.url === "/favicon.ico") { res.writeHead(204); return res.end(); } if (wellKnown(req.url.split("?")[0], res)) return; const f = path.join(tmp, path.basename(new URL(req.url, "http://x").pathname) || "index.html"); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res); });
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

test("the shadow adapter in the page: disabled fetches nothing; enabled fetches the five same-origin paths and returns the same record as the Node run against the same origin, never an acceptance", { skip }, async () => {
  const page = await browser.contexts()[0].newPage(); await page.goto(`http://127.0.0.1:${port}/index.html`); await page.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
  const expected = { allowedMeasurements: [MEAS], minTcb: FLOOR }, primary = { ok: true, measurement: MEAS };
  const cases = [["pinned roots, primary agrees", null, primary], ["a wrong caller pin", { Genoa: "00".repeat(32) }, primary]];
  for (const [name, roots, prim] of cases) {
    const r = await page.evaluate(([e, p, ro]) => window.runShadow(e, p, ro), [expected, prim, roots]);
    assert.equal(r.off.ran, false); assert.equal(r.off.acceptance, false);
    const n = await createShadow({ enabled: true, origin: `http://127.0.0.1:${port}`, collateralBase: `http://127.0.0.1:${port}`, now: () => new Date(NOW), roots: roots ? new Map(Object.entries(roots)) : null }).run({ host: "inference.tinfoil.sh", expected, primary: prim });
    const strip = (x) => JSON.parse(JSON.stringify({ ...x, tookMs: null }, (k, v) => (k === "fetchedAt" ? null : v)));
    assert.deepEqual(strip(r.on), strip(n), name);
    assert.equal(r.on.acceptance, false); assert.equal(r.on.transportBindingClaimed, false);
    assert.equal(r.on.verdict.status, roots ? "rejected" : "verified", r.on.verdict.reasons.join("\n")); assert.equal(r.on.comparison.outcome, roots ? "disagree" : "agree");
  }
  await page.close();
});
