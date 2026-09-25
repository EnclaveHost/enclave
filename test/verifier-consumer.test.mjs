// verifier/consumer.mjs, the production consumers' entry (CLI --verifier, the enclave self-check's second result, the
// relay's re-verification), on authentic evidence: the Genoa capture from Tinfoil's own public host (bytes verify; the
// measurement is Tinfoil's image, never a release of ours), the v0.5.841 release bundles (verified provenance), AMD's
// collateral; plus a real TLS capture against a server minted for the run. Every refusal is exercised by name.
//   run: node --test test/verifier-consumer.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { releaseExpectationsFrom, releaseExpectations, verifyHostedCapture, captureHosted, compareVerdicts, referenceVerify, verifyHost, selfCheckHosted, dualAgreement, reportOf, RAD_PATH, TRUSTED_ROOT, FLAVOR_SUFFIXES } from "../verifier/consumer.mjs";
import { memoryCollateral } from "../verifier/collateral.mjs";
import { spkiOfCert } from "../verifier/tls-binding.mjs";
import http from "node:http";
import { mintLocalCa, serveTls } from "./helpers/local-tls.mjs";

const REPO = new URL("..", import.meta.url).pathname, F = path.join(REPO, "test", "fixtures", "verifier");
const rd = (...p) => fs.readFileSync(path.join(F, ...p));
const CHAIN = path.join(REPO, "test", "fixtures", "amd", "Genoa-cert_chain.pem");   // AMD KDS cert_chain, the same file every other suite uses
const NOW = "2026-09-24T05:00:00Z";      // inside the capture's certificate window and its CRL's validity
const genoa = () => { const rad = JSON.parse(rd("genoa-tinfoil", "rad.json").toString()); const certPem = rd("genoa-tinfoil", "tls-cert.pem").toString(); return { host: "inference.tinfoil.sh", rad, certPem, spki: spkiOfCert(certPem).spki, at: NOW }; };
const collateral = () => memoryCollateral({ chains: { Genoa: fs.readFileSync(CHAIN, "utf8") }, vceks: { Genoa: rd("genoa-tinfoil", "vcek-kds-amd.der") }, crls: { Genoa: rd("amd", "Genoa-crl.der") } });
const candidate = (tag) => { const j = JSON.parse(rd("release", `${tag}.attestation.json`).toString()); return { tag, digest: rd("release", `${tag}.tinfoil.hash`).toString().trim(), bundle: j.attestations ? j.attestations[0]?.bundle : j }; };
const ours = () => releaseExpectationsFrom([candidate("v0.5.841"), candidate("v0.5.841-cpu")]);
const haveRef = fs.existsSync(path.join(REPO, "node_modules", "@tinfoilsh", "verifier", "package.json"));
const mutateSignature = (rad) => { let body = Buffer.from(rad.body, "base64"); const gz = body[0] === 0x1f; if (gz) body = gunzipSync(body); body = Buffer.from(body); body[0x2a0 + 7] ^= 0x01; return { ...rad, body: (gz ? gzipSync(body) : body).toString("base64") }; };

test("release provenance: both v0.5.841 flavors verify against the pinned Sigstore root, and `allowed` carries exactly their measurements", async () => {
  const e = await ours();
  assert.equal(e.ok, true, e.reasons.join(" | ")); assert.deepEqual(e.allowed.map((a) => a.tag), ["v0.5.841", "v0.5.841-cpu"]);
  for (const a of e.allowed) assert.match(a.measurement, /^[0-9a-f]{96}$/);
  assert.deepEqual(e.allowed.map((a) => a.flavor), ["gpu", "cpu"]); assert.deepEqual(e.allowed[0].version, [0, 5, 841]);
  assert.equal(e.candidates.every((c) => c.provenance === "verified"), true); assert.match(e.reasons.join(" "), /2 release\(s\) with verified provenance/);
  assert.equal(TRUSTED_ROOT.certificateAuthorities?.length > 0, true, "the pinned root ships with the module"); assert.deepEqual([...FLAVOR_SUFFIXES], ["", "-cpu", "-gpu8"]);
});
test("release provenance refusals: a swapped digest, an unavailable bundle, a candidate error and a malformed digest each contribute no measurement; with none the expectations are NOT ok (fail closed)", async () => {
  const c = candidate("v0.5.841");
  const e = await releaseExpectationsFrom([{ ...c, digest: candidate("v0.5.841-cpu").digest }, { tag: "v0.5.841-gpu8", error: "HTTP 404" }, { tag: "x", digest: c.digest, bundle: null }, { tag: "y", digest: "zz", bundle: c.bundle }]);
  assert.equal(e.ok, false); assert.deepEqual(e.allowed, []);
  assert.deepEqual(e.candidates.map((x) => x.provenance), ["refused", "unavailable", "unavailable", "refused"]);
  assert.match(e.candidates[0].reasons.join(" "), /subject .* is not the release digest/); assert.match(e.reasons.join(" "), /fail closed/);
});
test("the Genoa capture under OUR releases' policy: every byte check passes and only the measurement is refused (Tinfoil's image is not a release of ours): rejected, never admission-safe", async () => {
  const e = await ours(), cap = genoa();
  const v = await verifyHostedCapture(cap, { allowed: e.allowed, collateral: collateral(), now: NOW });
  assert.equal(v.status, "rejected", v.reasons.join(" | ")); assert.deepEqual(v.failedChecks, ["measurement"]); assert.equal(v.admissionSafe, false);
  assert.equal(v.matched, null); assert.deepEqual(v.expected, ["v0.5.841", "v0.5.841-cpu"]); assert.equal(v.technology, "amd-sev-snp");
  assert.equal(v.measurement, reportOf(cap.rad).measurement); assert.equal(v.at, new Date(NOW).toISOString());
});
// The report's own TCB, stated back as the floor: the test's policy, so this shows the mechanism, not an acceptance.
const GENOA_FLOOR = { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } };
test("the same capture under a policy that names its own measurement and states a TCB floor VERIFIES with no omission: chain, CRL, TCB, report signature, the served certificate's key and this document's hash in its SANs; without a stated floor it is `limited` (tcb-floor-unjudged), never verified", async () => {
  const cap = genoa(), m = reportOf(cap.rad).measurement, allowed = [{ tag: "genoa-tinfoil-capture", measurement: m }];
  const v = await verifyHostedCapture(cap, { allowed, minTcb: GENOA_FLOOR, collateral: collateral(), now: NOW });
  assert.equal(v.status, "verified", v.reasons.join(" | ")); assert.equal(v.admissionSafe, true); assert.deepEqual(v.omissions, []); assert.deepEqual(v.failedChecks, []);
  assert.equal(v.matched, "genoa-tinfoil-capture"); assert.equal(v.claims.measurement, m); assert.equal(v.checks["tcb policy"], true);
  const l = await verifyHostedCapture(cap, { allowed, collateral: collateral(), now: NOW });
  assert.equal(l.status, "limited"); assert.deepEqual(l.omissions, ["tcb-floor-unjudged"]); assert.deepEqual(l.failedChecks, []); assert.equal(l.admissionSafe, false, "limited is not admission-safe");
  const below = await verifyHostedCapture(cap, { allowed, minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 24, microcode: 84 } }, collateral: collateral(), now: NOW });
  assert.equal(below.status, "rejected"); assert.deepEqual(below.failedChecks, ["tcb policy"], "a floor above the report's TCB refuses");
});
test("a mutated document (one byte of the report signature) is rejected on the signature, not on the measurement alone", async () => {
  const e = await ours(), cap = genoa();
  const v = await verifyHostedCapture({ ...cap, rad: mutateSignature(cap.rad) }, { allowed: e.allowed, collateral: collateral(), now: NOW });
  assert.equal(v.status, "rejected"); assert.notDeepEqual(v.failedChecks, ["measurement"]); assert.equal(v.admissionSafe, false);
  assert.match(v.reasons.join(" "), /signature|hatt|document/i);
});
// The verifier refuses at the first failed check, so a binding case must pass the measurement first: the capture's own
// measurement and TCB floor, stated by the test (never by a consumer).
const ownPolicy = (cap) => ({ allowed: [{ tag: "genoa-tinfoil-capture", measurement: reportOf(cap.rad).measurement }], minTcb: GENOA_FLOOR });
test("a swapped served certificate (another host's leaf, another key) is rejected on the binding, with the document itself still genuine", async () => {
  const cap = genoa();
  const other = fs.readFileSync(path.join(F, "linux-canary-2026-09-24", "served-cert.pem"), "utf8");
  const v = await verifyHostedCapture({ ...cap, certPem: other, spki: spkiOfCert(other).spki }, { ...ownPolicy(cap), collateral: collateral(), now: NOW });
  assert.equal(v.status, "rejected"); assert.equal(v.admissionSafe, false); assert.deepEqual(v.failedChecks, ["binding"]); assert.match(v.reasons.at(-1), /belongs to another key/);
  const e = await ours();
  const m = await verifyHostedCapture({ ...cap, certPem: other, spki: spkiOfCert(other).spki }, { allowed: e.allowed, collateral: collateral(), now: NOW });
  assert.deepEqual(m.failedChecks, ["measurement"], "under our releases' policy the measurement refuses first, and the verdict stops there");
  assert.equal(v.checks.chain, true); assert.equal(v.checks.signature, true, "the document itself is genuine; it is the served key that is wrong");
});
test("an unknown format and the TDX format are unsupported, never admission-safe; a capture without a certificate is rejected on the binding", async () => {
  const e = await ours(), cap = genoa();
  const u = await verifyHostedCapture({ ...cap, rad: { format: "https://example.invalid/predicate/other/v1", body: "AAAA" } }, { allowed: e.allowed, collateral: collateral(), now: NOW });
  assert.equal(u.status, "unsupported"); assert.equal(u.admissionSafe, false); assert.match(u.reasons[0], /^UNSUPPORTED/);
  const t = await verifyHostedCapture({ ...cap, rad: { format: "https://tinfoil.sh/predicate/tdx-guest/v1", body: cap.rad.body } }, { allowed: e.allowed, collateral: collateral(), now: NOW });
  assert.equal(t.status, "unsupported"); assert.equal(t.admissionSafe, false); assert.match(t.reasons.join(" "), /TDX/);
  const n = await verifyHostedCapture({ host: cap.host, rad: cap.rad }, { allowed: e.allowed, collateral: collateral(), now: NOW });
  assert.equal(n.status, "rejected"); assert.deepEqual(n.failedChecks, ["binding"]);
});
test("no verified provenance means no expected measurement: rejected with the reason, never verified", async () => {
  const v = await verifyHostedCapture(genoa(), { allowed: [], collateral: collateral(), now: NOW });
  assert.equal(v.status, "rejected"); assert.ok(v.failedChecks.includes("measurement"), v.failedChecks.join(",")); assert.match(v.reasons.join(" "), /no expected measurement/); assert.deepEqual(v.expected, []);
});
test("captureHosted over a real TLS connection: the certificate of THAT handshake, the document, WebPKI on by default, the byte cap and non-200 answers; the verdict on it is rejected on the binding", async () => {
  const ca = mintLocalCa(); const rad = genoa().rad;
  const srv = await serveTls(ca, (req, res) => {
    if (req.url === RAD_PATH) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(rad)); }
    else if (req.url === "/big") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ format: rad.format, body: "A".repeat(2 * 1024 * 1024) })); }
    else if (req.url === "/notjson") { res.writeHead(200); res.end("<html>"); }
    else if (req.url === "/shape") { res.writeHead(200); res.end(JSON.stringify({ format: 1 })); }
    else if (req.url === "/hang") { /* never answers: the caller's timeout is the only way out */ }
    else { res.writeHead(500); res.end("no"); }
  });
  try {
    const cap = await captureHosted({ host: "localhost", port: srv.port, tls: { ca: ca.caPem } });
    assert.equal(cap.certPem.replace(/\s+/g, ""), ca.leafPem.replace(/\s+/g, ""), "the certificate is the one the server presented on this handshake");
    assert.equal(cap.tls.authorized, true); assert.equal(cap.tls.servername, "localhost"); assert.equal(cap.rad.format, rad.format);
    assert.ok(cap.spki.equals(spkiOfCert(ca.leafPem).spki)); assert.match(cap.certificate.sans, /DNS:localhost/);
    const v = await verifyHostedCapture(cap, { ...ownPolicy(genoa()), collateral: collateral(), now: NOW });
    assert.equal(v.status, "rejected"); assert.equal(v.admissionSafe, false); assert.deepEqual(v.failedChecks, ["binding"], "the report names Tinfoil's key, not this server's"); assert.match(v.reasons.at(-1), /belongs to another key/);
    await assert.rejects(captureHosted({ host: "localhost", port: srv.port, path: "/err", tls: { ca: ca.caPem } }), /HTTP 500/);
    await assert.rejects(captureHosted({ host: "localhost", port: srv.port, path: "/big", tls: { ca: ca.caPem }, maxBytes: 1024 * 1024 }), /exceeds 1048576 bytes/);
    await assert.rejects(captureHosted({ host: "localhost", port: srv.port, path: "/notjson", tls: { ca: ca.caPem } }), /not JSON/);
    await assert.rejects(captureHosted({ host: "localhost", port: srv.port, path: "/shape", tls: { ca: ca.caPem } }), /not \{ format, body \}/);
    await assert.rejects(captureHosted({ host: "localhost", port: srv.port }), /self.signed|unable to verify|certificate|SELF_SIGNED/i, "without the test CA, Node's WebPKI validation refuses: nothing here turns it off");
    await assert.rejects(captureHosted({ host: "localhost", port: srv.port, path: "/hang", tls: { ca: ca.caPem }, timeoutMs: 300 }), /no response within 300 ms/);
  } finally { await srv.close(); ca.cleanup(); }
});
test("compareVerdicts: agree, agree-refuse on the measurement, agree-refuse on the bytes, disagree, reference-missing", () => {
  const allowed = [{ tag: "t", measurement: "aa".repeat(48) }];
  const ok = { status: "verified", checks: { measurement: true, signature: true }, claims: { measurement: "aa".repeat(48) } };
  const refOk = { installed: true, attestationOk: true, certificateOk: true, measurement: "aa".repeat(48) };
  assert.equal(compareVerdicts({ ours: ok, reference: refOk, allowed }).agreement, "agree");
  const mOnly = { status: "rejected", checks: { measurement: false, signature: true }, claims: { measurement: "bb".repeat(48) } };
  const refM = { ...refOk, measurement: "bb".repeat(48) };
  const r1 = compareVerdicts({ ours: mOnly, reference: refM, allowed }); assert.equal(r1.agreement, "agree-refuse"); assert.equal(r1.bytesAgree, true); assert.equal(r1.measurementInProvenance, false);
  const bytesBad = { status: "rejected", checks: { signature: false }, claims: null };
  const refBad = { installed: true, attestationOk: false, attestationError: "signature" };
  const r2 = compareVerdicts({ ours: bytesBad, reference: refBad, allowed }); assert.equal(r2.agreement, "agree-refuse"); assert.equal(r2.oursBytesOk, false);
  assert.equal(compareVerdicts({ ours: ok, reference: refBad, allowed }).agreement, "disagree");
  assert.equal(compareVerdicts({ ours: bytesBad, reference: refOk, allowed }).agreement, "disagree");
  const limited = { status: "limited", omissions: ["tcb-floor-unjudged"], checks: { measurement: true, signature: true }, claims: { measurement: "aa".repeat(48) } };
  const r3 = compareVerdicts({ ours: limited, reference: refOk, allowed }); assert.equal(r3.agreement, "agree-limited"); assert.deepEqual(r3.omissions, ["tcb-floor-unjudged"]); assert.equal(r3.bytesAgree, true);
  assert.equal(compareVerdicts({ ours: limited, reference: refM, allowed }).agreement, "disagree", "limited on a measurement the reference reports differently is a disagreement");
  assert.equal(compareVerdicts({ ours: ok, reference: { installed: false, error: "not installed" }, allowed }).agreement, "reference-missing");
  assert.equal(compareVerdicts({ ours: ok, reference: { skipped: true }, allowed }).agreement, "reference-missing");
});
test("the reference on the same bytes: @tinfoilsh/verifier accepts the Genoa bytes and certificate, and under our policy the whole comparison is agree-refuse; a loader that fails is installed:false", { skip: !haveRef && "@tinfoilsh/verifier not installed" }, async () => {
  const e = await ours(), cap = genoa();
  const ref = await referenceVerify(cap, { collateral: collateral() });
  assert.equal(ref.installed, true); assert.equal(ref.attestationOk, true, ref.attestationError); assert.equal(ref.certificateOk, true, ref.certificateError);
  assert.equal(ref.measurement, reportOf(cap.rad).measurement);
  const v = await verifyHostedCapture(cap, { allowed: e.allowed, collateral: collateral(), now: NOW });
  const c = compareVerdicts({ ours: v, reference: ref, allowed: e.allowed });
  assert.equal(c.agreement, "agree-refuse"); assert.equal(c.bytesAgree, true); assert.equal(c.sameMeasurement, true); assert.equal(c.measurementInProvenance, false);
  const missing = await referenceVerify(cap, { collateral: collateral(), load: async () => { throw new Error("not installed here"); } });
  assert.equal(missing.installed, false); assert.equal(compareVerdicts({ ours: v, reference: missing, allowed: e.allowed }).agreement, "reference-missing");
  const mutated = await referenceVerify({ ...cap, rad: mutateSignature(cap.rad) }, { collateral: collateral() });
  assert.equal(mutated.attestationOk, false, "the reference refuses the mutated bytes too");
});
test("verifyHost end to end: against the local server (reference off) the enclave verdict is rejected on the binding and the comparison reference-missing; an unreachable host is `unavailable`, never anything better; the expectations ride along", async () => {
  const ca = mintLocalCa(); const rad = genoa().rad; const e = await ours();
  const srv = await serveTls(ca, (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(rad)); });
  try {
    const own = { repo: e.repo, latestTag: null, ok: true, candidates: [], allowed: ownPolicy(genoa()).allowed };
    const r = await verifyHost({ host: "localhost", port: srv.port, tls: { ca: ca.caPem }, expectations: own, minTcb: GENOA_FLOOR, reference: false, collateral: collateral(), now: NOW });
    assert.equal(r.verifier, "enclave"); assert.equal(r.enclave.status, "rejected"); assert.deepEqual(r.enclave.failedChecks, ["binding"]);
    const u = await verifyHost({ host: "localhost", port: srv.port, tls: { ca: ca.caPem }, expectations: e, reference: false, collateral: collateral(), now: NOW });
    assert.deepEqual(u.enclave.failedChecks, ["measurement"]); assert.deepEqual(u.expectations.allowed.map((a) => a.tag), ["v0.5.841", "v0.5.841-cpu"]);
    assert.equal(r.comparison.agreement, "reference-missing"); assert.equal(r.reference.skipped, true);
    assert.equal(r.capture.product, "Genoa"); assert.equal(r.capture.measurement, reportOf(rad).measurement); assert.equal(r.capture.certificate.subject.includes("localhost"), true);
    assert.deepEqual(r.expectations.allowed.map((a) => a.tag), ["genoa-tinfoil-capture"]); assert.equal(r.expectations.ok, true);
  } finally { await srv.close(); }
  const down = await verifyHost({ host: "localhost", port: srv.port, tls: { ca: ca.caPem }, expectations: e, reference: false, now: NOW });
  assert.equal(down.enclave.status, "unavailable"); assert.equal(down.enclave.admissionSafe, false); assert.match(down.enclave.reasons[0], /^capture: /); assert.equal(down.capture, null);
  ca.cleanup();
});

// A release index with the three routes the consumers fetch (GitHub's API and download host, or the github-proxy): the
// latest tag, each flavor's tinfoil.hash, each digest's attestation bundle; the fixtures' bytes, verbatim.
async function fakeReleaseIndex({ latest = "v0.5.841", missing = [] } = {}) {
  const srv = http.createServer((req, res) => {
    const u = req.url || "";
    const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(body); };
    if (u === "/repos/EnclaveHost/enclave/releases/latest") return send(200, JSON.stringify({ tag_name: latest }));
    let m = /^\/EnclaveHost\/enclave\/releases\/download\/([^/]+)\/tinfoil\.hash$/.exec(u);
    if (m) { const f = path.join(F, "release", `${m[1]}.tinfoil.hash`); return fs.existsSync(f) && !missing.includes(m[1]) ? send(200, fs.readFileSync(f), "text/plain") : send(404, "Not Found", "text/plain"); }
    m = /^\/repos\/EnclaveHost\/enclave\/attestations\/sha256:([0-9a-f]{64})$/.exec(u);
    if (m) { for (const t of ["v0.5.841", "v0.5.841-cpu"]) if (fs.readFileSync(path.join(F, "release", `${t}.tinfoil.hash`), "utf8").trim() === m[1]) return send(200, fs.readFileSync(path.join(F, "release", `${t}.attestation.json`))); return send(404, "{}"); }
    return send(404, "{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => new Promise((r) => srv.close(() => r())) };
}
test("releaseExpectations live logic against a local release index: the latest tag, the three flavors probed, -gpu8 unavailable, both others verified; an index that names no tag is not ok with indexError", async () => {
  const idx = await fakeReleaseIndex();
  try {
    const e = await releaseExpectations({ apiBase: idx.base, downloadBase: idx.base });
    assert.equal(e.ok, true); assert.equal(e.latestTag, "v0.5.841"); assert.deepEqual(e.allowed.map((a) => a.tag), ["v0.5.841", "v0.5.841-cpu"]);
    assert.deepEqual(e.candidates.map((c) => c.provenance), ["verified", "verified", "unavailable"]); assert.match(e.candidates[2].why, /HTTP 404/);
    const t = await releaseExpectations({ apiBase: idx.base, downloadBase: idx.base, tags: ["v0.5.841-cpu"] });
    assert.deepEqual(t.allowed.map((a) => a.tag), ["v0.5.841-cpu"]); assert.equal(t.latestTag, null);
  } finally { await idx.close(); }
  const bad = await fakeReleaseIndex({ latest: "nightly" });
  try { const e = await releaseExpectations({ apiBase: bad.base, downloadBase: bad.base }); assert.equal(e.ok, false); assert.match(e.indexError, /not a vX\.Y\.Z tag/); assert.deepEqual(e.allowed, []); } finally { await bad.close(); }
  const gone = await releaseExpectations({ apiBase: "http://127.0.0.1:1", downloadBase: "http://127.0.0.1:1", timeoutMs: 2000 });
  assert.equal(gone.ok, false); assert.ok(gone.indexError, "an unreachable index is an error, not an empty policy");
});
test("selfCheckHosted, the enclave's own leg: a loopback capture with SNI for the public name, the public name judged, the release index consulted; the Genoa document under our releases is rejected on the measurement; no public name or a dead loopback is `unavailable`", async () => {
  const ca = mintLocalCa(); const rad = genoa().rad; const idx = await fakeReleaseIndex();
  const shim = await serveTls(ca, (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(rad)); });
  try {
    const r = await selfCheckHosted({ publicHost: "localhost", loopback: { host: "127.0.0.1", port: shim.port }, releaseIndex: { apiBase: idx.base }, collateral: collateral(), now: NOW });
    assert.equal(r.verifier, "enclave"); assert.equal(r.status, "rejected"); assert.deepEqual(r.failedChecks, ["measurement"]); assert.deepEqual(r.expected, ["v0.5.841", "v0.5.841-cpu"]);
    assert.equal(r.latestTag, "v0.5.841"); assert.equal(r.release, null); assert.equal(r.measurement, reportOf(rad).measurement); assert.equal(r.certificate.subject.includes("localhost"), true);
    assert.ok(r.reasons.length <= 4, "a brief tail, not the whole transcript");
    const own = await selfCheckHosted({ publicHost: "localhost", loopback: { host: "127.0.0.1", port: shim.port }, expectations: { repo: "EnclaveHost/enclave", ok: true, allowed: ownPolicy(genoa()).allowed, candidates: [] }, minTcb: GENOA_FLOOR, collateral: collateral(), now: NOW });
    assert.equal(own.status, "rejected"); assert.deepEqual(own.failedChecks, ["binding"], "the local shim's key is not the key the report binds: the loopback capture judges the served key, not the report alone");
    const none = await selfCheckHosted({ publicHost: "", loopback: { host: "127.0.0.1", port: shim.port } }); assert.equal(none.status, "unavailable");
  } finally { await shim.close(); await idx.close(); }
  const dead = await selfCheckHosted({ publicHost: "localhost", loopback: { host: "127.0.0.1", port: shim.port }, expectations: { repo: "EnclaveHost/enclave", ok: true, allowed: [], candidates: [] }, now: NOW });
  assert.equal(dead.status, "unavailable"); assert.match(dead.reasons[0], /capture over loopback/);
  ca.cleanup();
});

test("dualAgreement (the CLI's both mode, the self-check's two legs): agree, agree-limited, agree-refuse, differ, not-compared; a refusal never becomes a pass", () => {
  const m = "aa".repeat(48);
  assert.equal(dualAgreement({ reference: { available: true, pass: true, measurement: m }, own: { status: "verified", measurement: m } }), "agree");
  assert.equal(dualAgreement({ reference: { available: true, pass: true, measurement: m }, own: { status: "limited", measurement: m } }), "agree-limited");
  assert.equal(dualAgreement({ reference: { available: true, pass: false, measurement: m }, own: { status: "rejected", measurement: m } }), "agree-refuse");
  assert.equal(dualAgreement({ reference: { available: true, pass: true, measurement: m }, own: { status: "rejected", measurement: m } }), "differ");
  assert.equal(dualAgreement({ reference: { available: true, pass: false, measurement: m }, own: { status: "verified", measurement: m } }), "differ");
  assert.equal(dualAgreement({ reference: { available: true, pass: true, measurement: m }, own: { status: "verified", measurement: "bb".repeat(48) } }), "differ", "the same green on different measurements is not agreement");
  assert.equal(dualAgreement({ reference: { available: false }, own: { status: "verified", measurement: m } }), "not-compared");
  assert.equal(dualAgreement({ reference: { available: true, pass: true, measurement: m }, own: { status: "unavailable" } }), "not-compared");
  assert.equal(dualAgreement({ reference: null, own: null }), "not-compared");
});
