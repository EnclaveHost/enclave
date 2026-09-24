// Fail-closed regressions (independent review, 2026-09-24): a report version whose security semantics are not
// implemented can never yield "verified"; every policy relaxation that skips a security check yields "limited",
// never "verified"; and the authentic v3/v5 paths still verify. A synthetic AMD-shaped chain (own ARK/ASK/VCEK,
// pinned by the test) lets the metal and domain ABI/1 binding branches run end to end offline; it is labelled
// synthetic and proves nothing about AMD, only about this verifier's branches.
//   run: node --test test/verifier-fail-closed.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, sign, randomBytes, X509Certificate } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { synthChain, synthReport } from "./helpers/snp-synth.mjs";
import { verifyEvidence, memoryCollateral, spkiOfCert, verdictStatus, parseReportStrict, JUDGED_MAX_REPORT_VERSION } from "../verifier/index.mjs";

const F = new URL("./fixtures/verifier/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url);
const rad = JSON.parse(fs.readFileSync(new URL("genoa-tinfoil/rad.json", F), "utf8"));
const report = gunzipSync(Buffer.from(rad.body, "base64"));
const certPem = fs.readFileSync(new URL("genoa-tinfoil/tls-cert.pem", F), "utf8"), { spki } = spkiOfCert(certPem);
const MEAS = report.subarray(0x90, 0xc0).toString("hex"), NOW = "2026-09-24T05:00:00Z";
const FLOOR = { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } };
const genoaCol = memoryCollateral({ chains: { Genoa: fs.readFileSync(new URL("Genoa-cert_chain.pem", A), "utf8") }, vceks: { Genoa: fs.readFileSync(new URL("genoa-tinfoil/vcek-kds-amd.der", F)) }, crls: { Genoa: fs.readFileSync(new URL("amd/Genoa-crl.der", F)) } });
const runGenoa = (doc, policy = {}) => verifyEvidence(doc, { policy: { snp: { allowedMeasurements: [MEAS], minTcb: FLOOR, ...policy } }, context: { transportKeySpki: spki, certPem, host: "inference.tinfoil.sh", now: NOW }, collateral: genoaCol });
const withVersion = (v) => { const r = Buffer.from(report); r.writeUInt32LE(v, 0); return { format: rad.format, body: gzipSync(r).toString("base64") }; };

test("the verdict status is derived, not asserted: any omission makes it limited", () => {
  assert.equal(verdictStatus([]), "verified");
  for (const o of [["report-version-unjudged"], ["tcb-floor-unjudged"], ["crl-revocation-unchecked"], ["crl-stale-accepted"], ["certificate-binding-unchecked"], ["freshness-unbound"], ["a", "b"]]) assert.equal(verdictStatus(o), "limited", o.join());
});
test("report version 6 (ABI 1.59, ETCB fields) is UNSUPPORTED by default, before any collateral or signature work", async () => {
  const v = await runGenoa(withVersion(6));
  assert.equal(v.status, "unsupported", v.reasons.join("\n")); assert.equal(v.admissionSafe, false);
  assert.equal(v.checks["report version"], null); assert.equal(v.checks.chain, undefined, "no chain work was done");
  assert.match(v.reasons.at(-1), /UNSUPPORTED: report version 6 .*ETCB.*versions 2\.\.5/);
  assert.ok(v.claims.unjudgedFields.currentEtcb.length === 64, "the unjudged bytes are shown, not judged");
  assert.equal(JUDGED_MAX_REPORT_VERSION, 5);
  const v7 = await runGenoa(withVersion(7));
  assert.equal(v7.status, "rejected"); assert.match(v7.reasons.at(-1), /newer than this parser/);
});
test("under the research policy a version-6 report can be limited or rejected, never verified", async () => {
  const v = await runGenoa(withVersion(6), { researchAllowUnjudgedReportVersions: true });
  assert.notEqual(v.status, "verified"); assert.equal(v.admissionSafe, false);
  assert.ok(v.omissions.includes("report-version-unjudged"), v.omissions.join());
  // this fixture's signature covers version=3, so the research run ends in a rejection at the signature; had every
  // check passed, verdictStatus(omissions) still holds "report-version-unjudged" and the ceiling is "limited"
  assert.equal(v.status, "rejected"); assert.equal(v.checks.signature, false);
});
test("the authentic v3 and v5 paths still verify, admission-safe, with nothing omitted", async () => {
  const g = await runGenoa(rad); assert.equal(g.status, "verified", g.reasons.join("\n")); assert.deepEqual(g.omissions, []);
  const saved = JSON.parse(fs.readFileSync(new URL("turin-m4a/doc.json", F), "utf8")); const d = saved.doc ?? saved;
  const tr = Buffer.from(d.report, "base64"); assert.equal(parseReportStrict(tr).version, 5);
  const canon = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
  const rid = createHash("sha256").update(canon(d.runtime)).digest(), sp = Buffer.from(d.transportKey, "base64"), nonce = Buffer.from(d.nonce, "hex");
  const t = await verifyEvidence(d, { policy: { snp: { allowedMeasurements: [tr.subarray(0x90, 0xc0).toString("hex")], minTcb: { Turin: { fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 } } } },
    context: { transportKeySpki: sp, nonce, expectedBinding: createHash("sha256").update(Buffer.concat([Buffer.from("enclave-bind-v2\n"), sp, nonce, rid])).digest(), expectedAppId: Buffer.from(d.appSha256, "hex"), now: NOW },
    collateral: memoryCollateral({ chains: { Turin: fs.readFileSync(new URL("Turin-cert_chain.pem", A), "utf8") }, vceks: { Turin: fs.readFileSync(new URL("turin-m4a/vcek-kds-amd.der", F)) }, crls: { Turin: fs.readFileSync(new URL("amd/Turin-crl.der", F)) } }) });
  assert.equal(t.status, "verified", t.reasons.join("\n")); assert.deepEqual(t.omissions, []); assert.equal(t.checks["report version"], true);
});
test("every policy relaxation is an omission and caps the verdict at limited (hosted format)", async () => {
  const cases = [[{ minTcb: undefined }, "tcb-floor-unjudged"], [{ crl: "none" }, "crl-revocation-unchecked"], [{ requireCertificateBinding: false, _noCert: true }, "certificate-binding-unchecked"]];
  for (const [policy, omission] of cases) {
    const { _noCert, ...pol } = policy;
    const v = await verifyEvidence(rad, { policy: { snp: { allowedMeasurements: [MEAS], minTcb: FLOOR, ...pol } }, context: { transportKeySpki: spki, certPem: _noCert ? undefined : certPem, host: "inference.tinfoil.sh", now: NOW }, collateral: genoaCol });
    assert.equal(v.status, "limited", `${omission}: ${v.reasons.join("\n")}`); assert.deepEqual(v.omissions, [omission]); assert.equal(v.admissionSafe, false);
  }
  const all = await verifyEvidence(rad, { policy: { snp: { allowedMeasurements: [MEAS], crl: "none", requireCertificateBinding: false } }, context: { transportKeySpki: spki, now: NOW }, collateral: genoaCol });
  assert.equal(all.status, "limited"); assert.deepEqual(all.omissions.sort(), ["certificate-binding-unchecked", "crl-revocation-unchecked", "tcb-floor-unjudged"]);
});

// ---- the SYNTHETIC AMD-shaped chain now lives in test/helpers/snp-synth.mjs (moved verbatim) ----------------------------
const S = synthChain();
const synthCol = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
const SP = randomBytes(91), NONCE = randomBytes(32), APP = randomBytes(32);
const sha = (...b) => createHash("sha256").update(Buffer.concat(b)).digest();
// the synthetic certificates start at their generation time, so these runs use the real clock, not the fixture clock
const SYNTH_NOW = new Date().toISOString();
const runSynth = (doc, { policy = {}, context = {} } = {}) => verifyEvidence(doc, { policy: { snp: { roots: new Map([["Genoa", S.arkFp]]), allowedMeasurements: ["77".repeat(48)], minTcb: FLOOR, ...policy } }, context: { transportKeySpki: SP, now: SYNTH_NOW, ...context }, collateral: synthCol });

test("synthetic chain: the real AMD pin refuses it, and pinning it is a test decision the verdict cannot hide", async () => {
  const doc = { format: "sev-snp-guest-metal-v1", body: synthReport(S, { reportData: Buffer.concat([sha(SP, NONCE), Buffer.alloc(32)]) }).toString("base64") };
  const real = await verifyEvidence(doc, { policy: { snp: { allowedMeasurements: ["77".repeat(48)], minTcb: FLOOR } }, context: { transportKeySpki: SP, nonce: NONCE, now: SYNTH_NOW }, collateral: synthCol });
  assert.equal(real.status, "rejected"); assert.match(real.reasons.at(-1), /not AMD's pinned Genoa root/);
});
test("metal format: with the verifier's nonce it is verified; without a nonce it is LIMITED (freshness-unbound)", async () => {
  const withNonce = { format: "sev-snp-guest-metal-v1", body: synthReport(S, { reportData: Buffer.concat([sha(SP, NONCE), Buffer.alloc(32)]) }).toString("base64") };
  const v = await runSynth(withNonce, { context: { nonce: NONCE } });
  assert.equal(v.status, "verified", v.reasons.join("\n")); assert.deepEqual(v.omissions, []); assert.equal(v.claims.freshness, "verifier nonce"); assert.equal(v.checks.crl, true);
  const keyOnly = { format: "sev-snp-guest-metal-v1", body: synthReport(S, { reportData: Buffer.concat([sha(SP), Buffer.alloc(32)]) }).toString("base64") };
  const l = await runSynth(keyOnly);
  assert.equal(l.status, "limited", l.reasons.join("\n")); assert.deepEqual(l.omissions, ["freshness-unbound"]); assert.equal(l.admissionSafe, false);
  const replay = await runSynth(keyOnly, { context: { nonce: NONCE } });
  assert.equal(replay.status, "rejected"); assert.match(replay.reasons.at(-1), /stale, replayed/);
  const dirty = { format: "sev-snp-guest-metal-v1", body: synthReport(S, { reportData: Buffer.concat([sha(SP, NONCE), Buffer.alloc(32, 1)]) }).toString("base64") };
  assert.match((await runSynth(dirty, { context: { nonce: NONCE } })).reasons.at(-1), /not zero for the metal format/);
});
test("domain format ABI/1: nonce binding and the app id; ABI/2 is not implied by ABI/1", async () => {
  const doc = { format: "sev-snp-guest-domain-v1", report: synthReport(S, { reportData: Buffer.concat([sha(SP, NONCE), APP]) }).toString("base64") };
  const v = await runSynth(doc, { context: { nonce: NONCE, expectedAppId: APP } });
  assert.equal(v.status, "verified", v.reasons.join("\n")); assert.equal(v.claims.abi, "enclave-domain-abi/1"); assert.equal(v.claims.appId, APP.toString("hex"));
  const other = Buffer.from(APP); other[0] ^= 1;
  assert.equal((await runSynth(doc, { context: { nonce: NONCE, expectedAppId: other } })).checks["app id"], false);
  assert.match((await runSynth(doc, { context: { nonce: NONCE, expectedAppId: APP, expectedBinding: sha(SP, NONCE) } })).reasons.at(-1), /no silent downgrade/);
});
test("synthetic v6 report: unsupported by default even with a valid signature and chain; limited at best under research policy", async () => {
  const doc = { format: "sev-snp-guest-metal-v1", body: synthReport(S, { reportData: Buffer.concat([sha(SP, NONCE), Buffer.alloc(32)]), version: 6 }).toString("base64") };
  const v = await runSynth(doc, { context: { nonce: NONCE } });
  assert.equal(v.status, "unsupported", v.reasons.join("\n")); assert.equal(v.checks.chain, undefined);
  const r = await runSynth(doc, { context: { nonce: NONCE }, policy: { researchAllowUnjudgedReportVersions: true } });
  assert.equal(r.status, "limited", r.reasons.join("\n"));   // signature, chain, CRL, binding all pass; the version omission caps it
  assert.deepEqual(r.omissions, ["report-version-unjudged"]); assert.equal(r.admissionSafe, false); assert.equal(r.checks["report version"], null);
  assert.equal(r.checks.signature, true, "the cryptography passed; the ceiling is the unjudged semantics, not a failure");
});
