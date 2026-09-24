// The site's opt-in shadow verification (site/js/core/verify-shadow.js) and its delivery through the same-origin vendor rule
// (scripts/build-vendor.mjs -> site/vendor/enclave-verifier.js). Proves: the vendored file IS the reproducible artifact
// (its sha256 is verifier/web/dist/MANIFEST.json's) and loads with the exports the glue uses; the glue is OFF by default and
// on only by the URL flag or the storage flag; disabled it imports nothing; enabled it builds the shadow from the primary's
// document (the release measurement from the Sigstore step, the primary's verdict and reported measurement) with the host's
// origin and the collateral mirror, returns a record that never reads as acceptance, and never throws (an import failure
// becomes a not-run record); and, end to end with the REAL vendored module against a local origin standing in for the enclave
// host and the KDS mirror, the record is the verifier's verdict on the Genoa fixtures with the comparison recorded.
//   run: node --test test/site-verifier-shadow.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shadowEnabled, runShadow, SHADOW_FLAG, SHADOW_QUERY, SHADOW_VERIFIER_URL, SHADOW_COLLATERAL_BASE, SHADOW_MIN_TCB } from "../site/js/core/verify-shadow.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED = path.join(REPO, "site", "vendor", "enclave-verifier.js");
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "verifier", "web", "dist", "MANIFEST.json"), "utf8"));
const F = new URL("./fixtures/verifier/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url);
const read = (u) => fs.readFileSync(u), text = (u) => fs.readFileSync(u, "utf8");
const rad = JSON.parse(text(new URL("genoa-tinfoil/rad.json", F))), report = gunzipSync(Buffer.from(rad.body, "base64"));
const certPem = text(new URL("genoa-tinfoil/tls-cert.pem", F)), MEAS = report.subarray(0x90, 0xc0).toString("hex"), HOST = "inference.tinfoil.sh";
const CHIP = report.subarray(0x1a0, 0x1e0).toString("hex");
const quiet = { info() {}, warn() {} };

test("the vendored verifier is the reproducible artifact: its sha256 is the manifest's, and it exports what the glue uses", async () => {
  const bytes = fs.readFileSync(VENDORED);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.artifact.sha256, "site/vendor/enclave-verifier.js == verifier/web/dist (run scripts/build-vendor.mjs)");
  assert.equal(bytes.length, manifest.artifact.bytes);
  const mod = await import(pathToFileURL(VENDORED).href);
  for (const name of ["createShadow", "verifyEvidenceWeb", "memoryCollateral", "httpCollateral"]) assert.equal(typeof mod[name], "function", name);
  assert.equal(typeof mod.WEB_CRYPTO, "object"); assert.equal(typeof mod.WEB_CRYPTO.checkChain, "function");
  assert.ok(!/from\s*["']node:/.test(bytes.toString("utf8")), "no node: import in the vendored file");
});

test("OFF by default; on by ?verifier-shadow=1 or the storage flag; storage that throws means off", () => {
  assert.equal(shadowEnabled({ search: "", storage: null }), false);
  assert.equal(shadowEnabled({ search: "?x=1", storage: { getItem: () => null } }), false);
  assert.equal(shadowEnabled({ search: `?${SHADOW_QUERY}=1`, storage: null }), true);
  assert.equal(shadowEnabled({ search: `?${SHADOW_QUERY}=0`, storage: { getItem: () => null } }), false);
  assert.equal(shadowEnabled({ search: "", storage: { getItem: (k) => (k === SHADOW_FLAG ? "1" : null) } }), true);
  assert.equal(shadowEnabled({ search: "", storage: { getItem: () => { throw new Error("blocked"); } } }), false);
  assert.equal(shadowEnabled({}), false, "no location, no storage: off");
});

test("disabled, nothing is imported and null is returned; enabled, the shadow is built from the primary's document and the record never reads as acceptance; an import failure never throws", async () => {
  let imported = 0;
  assert.equal(await runShadow({ host: HOST, doc: { securityVerified: true }, enabled: false, importer: async () => { imported++; return {}; }, log: quiet }), null);
  assert.equal(imported, 0);
  const calls = [];
  const fakeModule = { createShadow: (opts) => { calls.push({ create: opts }); return { run: async (a) => { calls.push({ run: a }); return { shadow: true, acceptance: false, transportBindingClaimed: false, ran: true, verdict: { status: "verified", reasons: [] }, comparison: { outcome: "agree" } }; } }; } };
  const doc = { securityVerified: true, codeMeasurement: { type: "sev-snp-guest", registers: ["ab".repeat(48)] }, enclaveMeasurement: { measurement: { type: "sev-snp-guest", registers: ["cd".repeat(48)] } } };
  const frozen = JSON.stringify(doc);
  const r = await runShadow({ host: HOST, doc, enabled: true, importer: async (u) => { assert.equal(u, SHADOW_VERIFIER_URL); return fakeModule; }, log: quiet });
  assert.equal(JSON.stringify(doc), frozen, "the primary's document is untouched");
  assert.equal(calls[0].create.origin, `https://${HOST}`); assert.equal(calls[0].create.collateralBase, SHADOW_COLLATERAL_BASE); assert.equal(calls[0].create.enabled, true); assert.equal(calls[0].create.roots, undefined, "the verifier's own pins, not a site-supplied root");
  assert.deepEqual(calls[1].run.expected, { allowedMeasurements: ["ab".repeat(48)], minTcb: SHADOW_MIN_TCB }, "the allowed measurement is the primary's PROVENANCE-derived one, never the enclave's reported one");
  assert.deepEqual(calls[1].run.primary, { ok: true, measurement: "cd".repeat(48) });
  assert.equal(r.acceptance, false); assert.equal(r.transportBindingClaimed, false); assert.match(r.expectedFrom, /Sigstore step/);
  assert.ok(!("ok" in r) && !("release" in r), "no field reads as a release");
  // a primary that failed, and a primary with no code measurement: the shadow still runs, allowing nothing
  const r2 = await runShadow({ host: HOST, doc: null, enabled: true, importer: async () => fakeModule, log: quiet });
  assert.deepEqual(calls.at(-1).run.expected.allowedMeasurements, []); assert.deepEqual(calls.at(-1).run.primary, { ok: false }); assert.match(r2.expectedFrom, /^none/);
  // an import that fails: a not-run record, no throw, nothing else
  const r3 = await runShadow({ host: HOST, doc, enabled: true, importer: async () => { throw new Error("blocked by CSP"); }, log: quiet });
  assert.equal(r3.ran, false); assert.equal(r3.acceptance, false); assert.match(r3.reasonNotRun, /blocked by CSP/);
  const r4 = await runShadow({ host: "not a host!", doc, enabled: true, importer: async () => fakeModule, log: quiet });
  assert.equal(r4.ran, false); assert.match(r4.reasonNotRun, /no host/);
});

test("end to end with the REAL vendored module: a local origin stands in for the enclave host and the KDS mirror; the record is the verifier's verdict on the Genoa fixtures, the comparison recorded, and only the five paths are fetched", async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const p = req.url.split("?")[0]; seen.push((req.headers["x-shadow-logical-host"] || req.headers.host) + p);
    if (p === "/.well-known/tinfoil-attestation") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(rad)); }
    if (p === "/.well-known/tinfoil-certificate") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ certificate: certPem })); }
    if (p === "/vcek/v1/Genoa/cert_chain") return res.end(text(new URL("Genoa-cert_chain.pem", A)));
    if (p === `/vcek/v1/Genoa/${CHIP}`) return res.end(read(new URL("genoa-tinfoil/vcek-kds-amd.der", F)));
    if (p === "/vcek/v1/Genoa/crl") return res.end(read(new URL("amd/Genoa-crl.der", F)));
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  // the transport stand-in: the logical URLs (https://<host>/…, the KDS mirror) are what the glue and the record name; only
  // the wire goes to the local origin, with the logical host carried in a custom header (fetch drops a caller-set Host) so
  // the log shows what was asked for
  const fetchImpl = (url, init) => { const u = new URL(url); return fetch(base + u.pathname + u.search, { ...init, headers: { ...(init && init.headers), "x-shadow-logical-host": u.host } }); };
  try {
    const doc = { securityVerified: true, codeMeasurement: { type: "sev-snp-guest", registers: [MEAS] }, enclaveMeasurement: { measurement: { type: "sev-snp-guest", registers: [MEAS] } } };
    const r = await runShadow({ host: HOST, doc, enabled: true, importer: () => import(pathToFileURL(VENDORED).href), fetchImpl, now: () => new Date("2026-09-24T05:00:00Z"), log: quiet });
    assert.equal(r.ran, true, JSON.stringify(r)); assert.equal(r.acceptance, false); assert.equal(r.transportBindingClaimed, false);
    assert.equal(r.verdict.status, "verified", r.verdict.reasons.join("\n")); assert.deepEqual(r.comparison, { outcome: "agree", oursVerified: true, primaryOk: true, sameMeasurement: true });
    assert.equal(r.rootsSource, "pinned: relay/snp-verify.mjs AMD_ARK_SHA256");
    assert.equal(r.sources.document.url, `https://${HOST}/.well-known/tinfoil-attestation`); assert.ok(r.sources.collateral.crl.source.startsWith(SHADOW_COLLATERAL_BASE + "/vcek/v1/Genoa/"));
    assert.deepEqual(seen.map((s) => s.split("?")[0]).sort(), [`${HOST}/.well-known/tinfoil-attestation`, `${HOST}/.well-known/tinfoil-certificate`, `kds-proxy.tinfoil.sh/vcek/v1/Genoa/${CHIP}`, "kds-proxy.tinfoil.sh/vcek/v1/Genoa/cert_chain", "kds-proxy.tinfoil.sh/vcek/v1/Genoa/crl"].sort());
    // a primary that accepts a measurement the release did not attest: the shadow refuses and the disagreement is recorded, nothing more
    const other = await runShadow({ host: HOST, doc: { ...doc, codeMeasurement: { type: "sev-snp-guest", registers: ["00".repeat(48)] } }, enabled: true, importer: () => import(pathToFileURL(VENDORED).href), fetchImpl, now: () => new Date("2026-09-24T05:00:00Z"), log: quiet });
    assert.equal(other.verdict.status, "rejected"); assert.equal(other.verdict.checks.measurement, false); assert.equal(other.comparison.outcome, "disagree"); assert.equal(other.acceptance, false);
  } finally { srv.close(); }
});
