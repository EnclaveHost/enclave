// The opt-in same-origin shadow adapter (verifier/web/shadow.mjs) against a local origin serving the Genoa fixtures at the
// well-known paths and AMD's collateral at KDS-shaped paths. Proves: disabled means no fetch at all; enabled, it fetches
// exactly the five paths it is told and nothing else; the record never carries acceptance and states that the transport
// binding is not claimed; the comparison with a primary is recorded in every outcome; and every failure mode (an origin
// that hangs, an oversized answer, a missing or refused collateral piece, a wrong or missing root pin, a malformed document)
// ends in a refusal, never a wait and never green.
//   run: node --test test/verifier-web-shadow.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { createShadow, compare, WELL_KNOWN } from "../verifier/web/shadow.mjs";
import { verifyEvidence, memoryCollateral, spkiOfCert } from "../verifier/index.mjs";
import { AMD_ARK_SHA256 } from "../relay/snp-verify.mjs";

const F = new URL("./fixtures/verifier/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url);
const read = (u) => fs.readFileSync(u), text = (u) => fs.readFileSync(u, "utf8");
const rad = JSON.parse(text(new URL("genoa-tinfoil/rad.json", F))), report = gunzipSync(Buffer.from(rad.body, "base64"));
const certPem = text(new URL("genoa-tinfoil/tls-cert.pem", F)), MEAS = report.subarray(0x90, 0xc0).toString("hex"), HOST = "inference.tinfoil.sh";
const chain = text(new URL("Genoa-cert_chain.pem", A)), vcek = read(new URL("genoa-tinfoil/vcek-kds-amd.der", F)), crl = read(new URL("amd/Genoa-crl.der", F));
const CHIP = report.subarray(0x1a0, 0x1e0).toString("hex"), FLOOR = { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } };
const NOW = () => new Date("2026-09-24T05:00:00Z");

// the origin: a request log, and per-path overrides (status, body, hang, big) a case can set
function origin() {
  const seen = [], over = {};
  const srv = http.createServer((req, res) => {
    const p = req.url.split("?")[0]; seen.push(req.url);
    const o = over[p]; if (o && o.hang) return; if (o && o.status) { res.writeHead(o.status); return res.end(); }
    if (o && o.big) { res.writeHead(200); return res.end(Buffer.alloc(o.big, 0x20)); }
    if (p === WELL_KNOWN.document) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(o && o.doc ? o.doc : rad)); }
    if (p === WELL_KNOWN.certificate) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ certificate: certPem })); }
    if (p === "/vcek/v1/Genoa/cert_chain") return res.end(chain);
    if (p === `/vcek/v1/Genoa/${CHIP}`) return res.end(vcek);
    if (p === "/vcek/v1/Genoa/crl") return res.end(crl);
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ base: `http://127.0.0.1:${srv.address().port}`, seen, over, close: () => srv.close() })));
}
const shadow = (o, extra = {}) => createShadow({ enabled: true, origin: o.base, collateralBase: o.base, now: NOW, timeoutMs: 1500, ...extra });
const EXPECT = { allowedMeasurements: [MEAS], minTcb: FLOOR };
const noAcceptance = (r) => { assert.equal(r.shadow, true); assert.equal(r.acceptance, false); assert.equal(r.transportBindingClaimed, false); assert.ok(!("ok" in r) && !("release" in r) && !("admit" in r), "no field reads as a release"); };

test("disabled (the default): run() fetches nothing and says so; enabling needs explicit origins and a Map of roots or none", async () => {
  const o = await origin();
  try {
    const off = createShadow({ origin: o.base, collateralBase: o.base });
    const r = await off.run({ host: HOST, expected: EXPECT });
    noAcceptance(r); assert.equal(r.enabled, false); assert.equal(r.ran, false); assert.match(r.reasonNotRun, /disabled/); assert.deepEqual(o.seen, [], "nothing was fetched");
    for (const bad of [{ enabled: true }, { enabled: true, origin: o.base }, { enabled: true, origin: "javascript:alert(1)", collateralBase: o.base }, { enabled: true, origin: o.base + "/path", collateralBase: o.base }, { enabled: true, origin: o.base, collateralBase: "ftp://x" }, { enabled: true, origin: o.base, collateralBase: o.base, roots: { Genoa: "00" } }])
      assert.throws(() => createShadow(bad), /origin|collateralBase|roots/, JSON.stringify(bad));
    assert.equal((await shadow(o).run({ expected: EXPECT })).ran, false, "no host: not run");
  } finally { o.close(); }
});

test("enabled: exactly the five paths are fetched, the verdict is the Node build's on the same fixtures, the roots and every source are recorded, and the comparison is recorded for every primary outcome", async () => {
  const o = await origin();
  try {
    const r = await shadow(o).run({ host: HOST, expected: EXPECT, primary: { ok: true, measurement: MEAS.toUpperCase() } });
    noAcceptance(r); assert.equal(r.ran, true); assert.equal(r.verdict.status, "verified", r.verdict.reasons.join("\n")); assert.equal(r.rootsSource, "pinned: relay/snp-verify.mjs AMD_ARK_SHA256");
    assert.deepEqual(r.comparison, { outcome: "agree", oursVerified: true, primaryOk: true, sameMeasurement: true });
    assert.deepEqual(o.seen.map((u) => u.split("?")[0]).sort(), [WELL_KNOWN.certificate, WELL_KNOWN.document, "/vcek/v1/Genoa/cert_chain", `/vcek/v1/Genoa/${CHIP}`, "/vcek/v1/Genoa/crl"].sort(), "the five paths, nothing else");
    assert.ok(o.seen.some((u) => u.startsWith(`/vcek/v1/Genoa/${CHIP}?blSPL=10&teeSPL=0&snpSPL=23&ucodeSPL=84`)), "the VCEK asked for is this report's chip and TCB");
    assert.equal(r.sources.document.url, o.base + WELL_KNOWN.document); assert.equal(r.sources.certificate.url, o.base + WELL_KNOWN.certificate); assert.equal(r.sources.roots, r.rootsSource);
    for (const k of ["vcek", "chain", "crl"]) { assert.equal(r.sources.collateral[k].source.startsWith(o.base + "/vcek/v1/Genoa/"), true, k); assert.equal(r.sources.collateral[k].cached, false); }
    assert.equal(r.verdict.claims.arkFingerprint, AMD_ARK_SHA256.get("Genoa"));
    // the same inputs through the Node build, offline: the same verdict (collateral provenance aside)
    const { spki } = spkiOfCert(certPem);
    const n = await verifyEvidence(rad, { policy: { snp: EXPECT }, context: { transportKeySpki: spki, certPem, host: HOST, now: NOW().toISOString() }, collateral: memoryCollateral({ chains: { Genoa: chain }, vceks: { Genoa: vcek }, crls: { Genoa: crl } }) });
    const strip = (v) => ({ ...v, claims: { ...v.claims, collateral: null, vcekSource: null } });   // provenance differs by construction (http vs memory), nothing else may
    assert.deepEqual(strip(r.verdict), strip(n));
    // the other primaries
    assert.equal((await shadow(o).run({ host: HOST, expected: EXPECT })).comparison.outcome, "primary-missing");
    assert.equal((await shadow(o).run({ host: HOST, expected: EXPECT, primary: { ok: false } })).comparison.outcome, "disagree");
    const wrong = await shadow(o).run({ host: HOST, expected: { ...EXPECT, allowedMeasurements: ["00".repeat(48)] }, primary: { ok: true, measurement: MEAS } });
    assert.equal(wrong.verdict.status, "rejected"); assert.deepEqual(wrong.comparison, { outcome: "disagree", oursVerified: false, primaryOk: true, sameMeasurement: true });
    assert.equal((await shadow(o).run({ host: HOST, expected: { ...EXPECT, allowedMeasurements: ["00".repeat(48)] }, primary: { ok: false } })).comparison.outcome, "agree-refuse");
    const limited = await shadow(o).run({ host: HOST, expected: { allowedMeasurements: [MEAS] }, primary: { ok: true } });
    assert.equal(limited.verdict.status, "limited"); assert.equal(limited.comparison.outcome, "disagree", "limited is not green: a primary that accepts disagrees with it");
  } finally { o.close(); }
});

test("fail closed: a hanging origin, an oversized answer, a refused or missing collateral piece, a bad certificate answer and a malformed document each end in a refusal with the reason, never a wait", async () => {
  const o = await origin();
  try {
    o.over[WELL_KNOWN.document] = { hang: true };
    let t0 = Date.now(), r = await shadow(o).run({ host: HOST, expected: EXPECT }); assert.ok(Date.now() - t0 < 5000, "bounded");
    assert.equal(r.ran, true); assert.equal(r.verdict.status, "rejected"); assert.match(r.verdict.reasons[0], /document: .*timed out after 1500 ms/); assert.equal(r.verdict.checks.document, false); noAcceptance(r);
    o.over[WELL_KNOWN.document] = { big: 300 * 1024 };
    r = await shadow(o).run({ host: HOST, expected: EXPECT }); assert.match(r.verdict.reasons[0], /document: .*exceeds 262144 bytes/);
    o.over[WELL_KNOWN.document] = { doc: { format: "nope", body: rad.body } };
    r = await shadow(o).run({ host: HOST, expected: EXPECT, primary: { ok: true } }); assert.equal(r.verdict.status, "unsupported"); assert.equal(r.comparison.outcome, "disagree");
    o.over[WELL_KNOWN.document] = { doc: { format: rad.format, body: "AAAA" } };
    r = await shadow(o).run({ host: HOST, expected: EXPECT }); assert.equal(r.verdict.status, "rejected"); assert.match(r.verdict.reasons[0], /must be gzip/);
    delete o.over[WELL_KNOWN.document];
    o.over[WELL_KNOWN.certificate] = { status: 503 };
    r = await shadow(o).run({ host: HOST, expected: EXPECT }); assert.match(r.verdict.reasons[0], /certificate: .*HTTP 503/); assert.equal(r.verdict.checks.certificate, false);
    delete o.over[WELL_KNOWN.certificate];
    o.over["/vcek/v1/Genoa/crl"] = { status: 429 };
    r = await shadow(o).run({ host: HOST, expected: EXPECT }); assert.equal(r.verdict.status, "rejected"); assert.equal(r.verdict.checks.crl, false); assert.match(r.verdict.reasons.at(-1), /required by policy but none was supplied/); assert.match(r.sources.collateral.crl.error, /HTTP 429/);
    const staleOk = await shadow(o).run({ host: HOST, expected: { ...EXPECT, crl: "stale-ok" } }); assert.equal(staleOk.verdict.status, "limited"); assert.deepEqual(staleOk.verdict.omissions, ["crl-revocation-unchecked"]);
    delete o.over["/vcek/v1/Genoa/crl"];
    o.over[`/vcek/v1/Genoa/${CHIP}`] = { status: 404 };
    r = await shadow(o).run({ host: HOST, expected: EXPECT }); assert.equal(r.verdict.checks.vcek, false); assert.match(r.verdict.reasons.at(-1), /VCEK unavailable: .*HTTP 404/);
    delete o.over[`/vcek/v1/Genoa/${CHIP}`];
    o.over["/vcek/v1/Genoa/cert_chain"] = { hang: true };
    t0 = Date.now(); r = await shadow(o).run({ host: HOST, expected: EXPECT }); assert.ok(Date.now() - t0 < 5000); assert.equal(r.verdict.checks.chain, false); assert.match(r.verdict.reasons.at(-1), /AMD chain unavailable: .*timed out/);
    o.over["/vcek/v1/Genoa/cert_chain"] = { big: 300 * 1024 };
    r = await shadow(o).run({ host: HOST, expected: EXPECT }); assert.match(r.verdict.reasons.at(-1), /AMD chain unavailable: .*exceeds 262144 bytes/);
    delete o.over["/vcek/v1/Genoa/cert_chain"];
    // the wrong host: the served certificate does not name it
    r = await shadow(o).run({ host: "other.tinfoil.sh", expected: EXPECT }); assert.equal(r.verdict.checks["certificate binding"], false);
  } finally { o.close(); }
});

test("explicit roots: a caller's Map with the wrong Genoa pin refuses at the chain and the record says the roots were the caller's; a Map without the product refuses too", async () => {
  const o = await origin();
  try {
    const wrong = await shadow(o, { roots: new Map([["Genoa", "00".repeat(32)]]) }).run({ host: HOST, expected: EXPECT, primary: { ok: true } });
    assert.equal(wrong.rootsSource, "caller"); assert.equal(wrong.verdict.status, "rejected"); assert.equal(wrong.verdict.checks.chain, false); assert.match(wrong.verdict.reasons.at(-1), /not AMD's pinned Genoa root/); assert.equal(wrong.comparison.outcome, "disagree");
    const none = await shadow(o, { roots: new Map([["Milan", AMD_ARK_SHA256.get("Milan")]]) }).run({ host: HOST, expected: EXPECT });
    assert.match(none.verdict.reasons.at(-1), /no pinned AMD root for product line "Genoa" \(fail closed\)/);
    const right = await shadow(o, { roots: new Map(AMD_ARK_SHA256) }).run({ host: HOST, expected: EXPECT });
    assert.equal(right.verdict.status, "verified"); assert.equal(right.rootsSource, "caller");
    assert.deepEqual(compare({ status: "verified", claims: { measurement: "ab" } }, { ok: true, measurement: "AB" }), { outcome: "agree", oursVerified: true, primaryOk: true, sameMeasurement: true });
    assert.deepEqual(compare({ status: "rejected", claims: null }, { ok: false }), { outcome: "agree-refuse", oursVerified: false, primaryOk: false, sameMeasurement: null });
  } finally { o.close(); }
});
