// The browser build against the Node build, verdict for verdict, over the mutation matrix of the SNP suites (Genoa hosted,
// Turin domain ABI/2, the synthetic chain of the fail-closed suite) plus envelope-level cases. Both builds run the SAME
// verifier/snp.mjs; what differs is the crypto provider (node:crypto vs WebCrypto + verifier/web/x509.mjs), so a
// divergence here is a provider defect. Equality is on the whole verdict: status, admissionSafe, omissions, checks, claims
// and reasons, after one normalisation: text after "unparseable:" (the reader's own message) and inside the gunzip decoder's
// parentheses. No silent reduction: a check the Node build fails, the browser build fails on the same check with the same
// words, and a verdict the Node build gives green, the browser build gives green with the same claims.
//   run: node --test test/verifier-web-differential.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { synthChain, synthReport } from "./helpers/snp-synth.mjs";
import { verifyEvidence, memoryCollateral, spkiOfCert } from "../verifier/index.mjs";
import { verifyEvidenceWeb } from "../verifier/web/index.mjs";

const F = new URL("./fixtures/verifier/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url);
const read = (u) => fs.readFileSync(u), text = (u) => fs.readFileSync(u, "utf8");
const sha = (...b) => createHash("sha256").update(Buffer.concat(b)).digest();
const NOW = "2026-09-24T05:00:00Z";
const chains = { Genoa: text(new URL("Genoa-cert_chain.pem", A)), Milan: text(new URL("Milan-cert_chain.pem", A)), Turin: text(new URL("Turin-cert_chain.pem", A)) };
export const norm = (v) => JSON.parse(JSON.stringify(v, (k, val) => (typeof val === "string" ? val.replace(/(unparseable: ).*$/, "$1<reader>").replace(/(unreadable or over the cap \().*\)$/, "$1<decoder>)") : val)));

// ---- Genoa, hosted format (test/verifier-snp-genoa.test.mjs's inputs) ----
const rad = JSON.parse(text(new URL("genoa-tinfoil/rad.json", F))), report = gunzipSync(Buffer.from(rad.body, "base64"));
const certPem = text(new URL("genoa-tinfoil/tls-cert.pem", F)), { spki } = spkiOfCert(certPem), HOST = "inference.tinfoil.sh";
const MEAS = report.subarray(0x90, 0xc0).toString("hex"), FLOOR = { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } };
const vcekAmd = read(new URL("genoa-tinfoil/vcek-kds-amd.der", F)), vcekProxy = read(new URL("genoa-tinfoil/vcek-kds-proxy-tinfoil.der", F)), crlG = read(new URL("amd/Genoa-crl.der", F));
const turinVcek = read(new URL("turin-m4a/vcek-kds-amd.der", F)), crlT = read(new URL("amd/Turin-crl.der", F));
const gCol = (over = {}) => memoryCollateral({ chains, vceks: { Genoa: vcekAmd }, crls: { Genoa: crlG }, ...over });
const docWith = (r) => ({ format: rad.format, body: gzipSync(r).toString("base64") });
const mutated = (fn) => { const r = Buffer.from(report); fn(r); return docWith(r); };
const G = (doc = rad, { policy = {}, context = {}, collateral = gCol() } = {}) =>
  ({ doc, opts: { policy: { snp: { allowedMeasurements: [MEAS], minTcb: FLOOR, ...policy } }, context: { transportKeySpki: spki, certPem, host: HOST, now: NOW, ...context }, collateral } });
const otherKey = Buffer.from(spki); otherKey[otherKey.length - 1] ^= 1;

// ---- Turin, domain format ABI/2 (test/verifier-snp-turin.test.mjs's inputs) ----
const savedT = JSON.parse(text(new URL("turin-m4a/doc.json", F))), tDoc = savedT.doc ?? savedT, tReport = Buffer.from(tDoc.report, "base64");
const tSpki = Buffer.from(tDoc.transportKey, "base64"), tNonce = Buffer.from(tDoc.nonce, "hex"), tApp = Buffer.from(tDoc.appSha256, "hex");
const canon = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
const tRid = sha(Buffer.from(canon(tDoc.runtime))), bind2 = (n = tNonce, k = tSpki) => sha(Buffer.from("enclave-bind-v2\n"), k, n, tRid);
const T_MEAS = tReport.subarray(0x90, 0xc0).toString("hex"), T_FLOOR = { Turin: { fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 } };
const tCol = (over = {}) => memoryCollateral({ chains, vceks: { Turin: turinVcek }, crls: { Turin: crlT }, ...over });
const T = (doc = tDoc, { policy = {}, context = {}, collateral = tCol() } = {}) =>
  ({ doc, opts: { policy: { snp: { allowedMeasurements: [T_MEAS], minTcb: T_FLOOR, ...policy } }, context: { transportKeySpki: tSpki, nonce: tNonce, expectedBinding: bind2(), expectedAppId: tApp, now: NOW, ...context }, collateral } });
const tMutated = (fn) => { const r = Buffer.from(tReport); fn(r); return { ...tDoc, report: r.toString("base64") }; };

// ---- the synthetic chain (test/verifier-fail-closed.test.mjs's construction), with a revoking and a one-day CRL ----
const S = synthChain({ revokeAsk: true, extraCrlDays: [1], extraVceks: 1 });
const sCol = (over = {}) => memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer }, ...over });
const SP = randomBytes(91), NONCE = randomBytes(32), APP = randomBytes(32), SYNTH_NOW = new Date().toISOString();
const Sy = (doc, { policy = {}, context = {}, collateral = sCol() } = {}) =>
  ({ doc, opts: { policy: { snp: { roots: new Map([["Genoa", S.arkFp]]), allowedMeasurements: ["77".repeat(48)], minTcb: FLOOR, ...policy } }, context: { transportKeySpki: SP, now: SYNTH_NOW, ...context }, collateral } });
const metal = (rd, version) => ({ format: "sev-snp-guest-metal-v1", body: synthReport(S, { reportData: rd, version }).toString("base64") });
const domain = (rd) => ({ format: "sev-snp-guest-domain-v1", report: synthReport(S, { reportData: rd }).toString("base64") });

export const CASES = [
  // Genoa: the green path and its policy shades
  ["genoa verified", G()], ["genoa proxy-reissued VCEK", G(rad, { collateral: gCol({ vceks: { Genoa: vcekProxy } }) })],
  ["genoa no TCB floor -> limited", G(rad, { policy: { minTcb: undefined } })], ["genoa floor above the part", G(rad, { policy: { minTcb: { Genoa: { ...FLOOR.Genoa, microcode: 255 } } } })],
  ["genoa no certificate binding required -> limited", G(rad, { policy: { requireCertificateBinding: false }, context: { certPem: undefined } })],
  ["genoa no certificate but required", G(rad, { context: { certPem: undefined } })],
  // signature and identity
  ["genoa flipped r", G(mutated((r) => { r[0x2a0] ^= 1; }))], ["genoa flipped s", G(mutated((r) => { r[0x2a0 + 0x48] ^= 1; }))], ["genoa flipped signed region", G(mutated((r) => { r[0x91] ^= 1; }))],
  ["genoa r out of range", G(mutated((r) => r.fill(0xff, 0x2a0, 0x2a0 + 48)))], ["genoa edited reported TCB", G(mutated((r) => { r[0x180] ^= 1; }))],
  ["genoa Milan chain as Genoa's", G(rad, { collateral: gCol({ chains: { ...chains, Genoa: chains.Milan } }) })], ["genoa Turin VCEK as Genoa's", G(rad, { collateral: gCol({ vceks: { Genoa: turinVcek } }) })],
  ["genoa no VCEK", G(rad, { collateral: gCol({ vceks: {} }) })], ["genoa no chain", G(rad, { collateral: gCol({ chains: {} }) })],
  ["genoa measurement not allowed", G(rad, { policy: { allowedMeasurements: ["00".repeat(48)] } })], ["genoa policy names no measurement", G(rad, { policy: { allowedMeasurements: [] } })],
  ["genoa another transport key", G(rad, { context: { transportKeySpki: otherKey } })], ["genoa no transport key", G(rad, { context: { transportKeySpki: undefined } })],
  ["genoa DEBUG policy bit", G(mutated((r) => { r[0x0a] |= 0x08; }))], ["genoa VMPL1 expected", G(rad, { policy: { expectedVmpl: 1 } })], ["genoa SMT off required", G(rad, { policy: { guestPolicy: { smt: false } } })],
  // shape
  ["genoa truncated", G(docWith(report.subarray(0, 0x400)))], ["genoa padded", G(docWith(Buffer.concat([report, Buffer.alloc(1)])))], ["genoa version 1", G(mutated((r) => r.writeUInt32LE(1, 0)))],
  ["genoa VLEK signer", G(mutated((r) => { r[0x48] = 0x04; }))], ["genoa reserved byte", G(mutated((r) => { r[0x4c] = 1; }))],
  ["genoa version 6 -> unsupported", G(mutated((r) => r.writeUInt32LE(6, 0)))], ["genoa version 6 under research policy", G(mutated((r) => r.writeUInt32LE(6, 0)), { policy: { researchAllowUnjudgedReportVersions: true } })],
  // CRL policy and collateral
  ["genoa CRL stale, required", G(rad, { context: { now: "2026-12-01T00:00:00Z" } })], ["genoa CRL stale-ok 90 -> limited", G(rad, { context: { now: "2026-12-01T00:00:00Z" }, policy: { crl: "stale-ok", crlMaxStaleDays: 90 } })],
  ["genoa CRL stale-ok 10", G(rad, { context: { now: "2026-12-01T00:00:00Z" }, policy: { crl: "stale-ok", crlMaxStaleDays: 10 } })], ["genoa CRL none -> limited", G(rad, { policy: { crl: "none" } })],
  ["genoa CRL missing, stale-ok -> limited", G(rad, { policy: { crl: "stale-ok" }, collateral: gCol({ crls: {} }) })], ["genoa CRL missing, required", G(rad, { collateral: gCol({ crls: {} }) })],
  ["genoa foreign CRL", G(rad, { collateral: gCol({ crls: { Genoa: crlT } }) })], ["genoa tampered CRL", G(rad, { collateral: gCol({ crls: { Genoa: (() => { const b = Buffer.from(crlG); b[b.length - 1] ^= 1; return b; })() } }) })],
  ["genoa garbage CRL", G(rad, { collateral: gCol({ crls: { Genoa: Buffer.from("not a crl at all, just bytes") } }) })],
  ["genoa served certificate expired", G(rad, { context: { now: "2027-01-15T00:00:00Z" }, policy: { crl: "none" } })], ["genoa AMD certificates not yet valid", G(rad, { context: { now: "2020-01-01T00:00:00Z" }, policy: { crl: "none" } })],
  ["genoa host mismatch", G(rad, { context: { host: "other.tinfoil.sh" } })], ["genoa garbage served certificate", G(rad, { context: { certPem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n" } })],
  ["genoa garbage VCEK", G(rad, { collateral: gCol({ vceks: { Genoa: Buffer.alloc(300, 7) } }) })], ["genoa garbage chain", G(rad, { collateral: gCol({ chains: { Genoa: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n" } }) })],
  // envelope
  ["unknown format", G({ format: "nope", body: rad.body })], ["dev format", G({ format: "dev-unattested-metal-v1", body: rad.body })], ["TDX metal", G({ format: "tdx-guest-metal-v1", body: rad.body })],
  ["hosted body not gzip", G({ format: rad.format, body: report.toString("base64") })], ["metal body gzip", G({ format: "sev-snp-guest-metal-v1", body: rad.body })],
  ["missing body", G({ format: rad.format })], ["closed shape extra field", G({ ...rad, extra: 1 })], ["body under the other name", G({ format: rad.format, report: rad.body })],
  ["not strict base64", G({ format: rad.format, body: rad.body.slice(0, -1) + "!" })], ["gzip over the cap", G({ format: rad.format, body: gzipSync(Buffer.alloc(200 * 1024)).toString("base64") })],
  // oversized and over-wide documents, an over-long body, and collateral adapters that fail (throw) rather than answer
  ["document over 1 MiB", G({ format: "sev-snp-guest-metal-v1", body: report.toString("base64"), manifest: { pad: "x".repeat(1024 * 1024 + 64) } })],
  ["document with too many fields", G({ format: "sev-snp-guest-metal-v1", body: report.toString("base64"), ...Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, i])) })],
  ["body over the base64 cap", G({ format: "sev-snp-guest-metal-v1", body: Buffer.alloc(70 * 1024).toString("base64") })],
  ["all-zero report", G({ format: "sev-snp-guest-metal-v1", body: Buffer.alloc(0x4a0).toString("base64") })],
  ["chain adapter throws", G(rad, { collateral: { ...gCol(), chain: () => { throw new Error("mirror down"); } } })],
  ["VCEK adapter throws", G(rad, { collateral: { ...gCol(), vcek: () => { throw new Error("mirror down"); } } })],
  ["CRL adapter throws, required", G(rad, { collateral: { ...gCol(), crl: () => { throw new Error("mirror down"); } } })],
  ["CRL adapter throws, stale-ok -> limited", G(rad, { policy: { crl: "stale-ok" }, collateral: { ...gCol(), crl: () => { throw new Error("mirror down"); } } })],
  ["wrong Genoa pin", G(rad, { policy: { roots: new Map([["Genoa", "00".repeat(32)]]) } })], ["no pin for the product", G(rad, { policy: { roots: new Map([["Milan", "11".repeat(32)]]) } })],
  ["VCEK slot holds the ASK (an RSA key named SEV-Genoa)", G(rad, { collateral: gCol({ vceks: { Genoa: Buffer.from(chains.Genoa.split(/(?=-----BEGIN CERTIFICATE-----)/).filter((x) => x.includes("CERTIFICATE"))[0].replace(/-----[^-]+-----|\s/g, ""), "base64") } }) })],
  // Turin ABI/2
  ["turin verified", T()], ["turin wrong nonce", T(tDoc, { context: { nonce: sha(tNonce), expectedBinding: bind2(sha(tNonce)) } })], ["turin wrong app", T(tDoc, { context: { expectedAppId: sha(tApp) } })],
  ["turin ABI/2 judged under ABI/1 (no silent downgrade)", T(tDoc, { context: { expectedBinding: undefined } })], ["turin floor above the part", T(tDoc, { policy: { minTcb: { Turin: { ...T_FLOOR.Turin, microcode: 255 } } } })],
  ["turin Genoa chain", T(tDoc, { collateral: tCol({ chains: { ...chains, Turin: chains.Genoa } }) })], ["turin Genoa VCEK", T(tDoc, { collateral: tCol({ vceks: { Turin: vcekAmd } }) })],
  ["turin replay against a fresh nonce", (() => { const n = randomBytes(32); return T(tDoc, { context: { nonce: n, expectedBinding: bind2(n) } }); })()], ["turin flipped signed byte", T(tMutated((r) => { r[0x100] ^= 1; }))],
  ["turin no chain", T(tDoc, { collateral: tCol({ chains: {} }) })],
  ["turin another transport key (binding recomputed on it)", (() => { const k = Buffer.from(tSpki); k[k.length - 1] ^= 1; return T(tDoc, { context: { transportKeySpki: k, expectedBinding: bind2(tNonce, k) } }); })()],
  ["turin garbage auxblob falls through to the collateral", T(tDoc, { context: { auxblob: Buffer.alloc(48) } })],
  ["synthetic domain without an expected app id", Sy(domain(Buffer.concat([sha(SP, NONCE), APP])), { context: { nonce: NONCE } })],
  // synthetic chain: pins, bindings, versions, revocation, freshness
  ["synthetic under the real AMD pin", Sy(metal(Buffer.concat([sha(SP, NONCE), Buffer.alloc(32)])), { policy: { roots: undefined }, context: { nonce: NONCE } })],
  ["synthetic metal with nonce -> verified", Sy(metal(Buffer.concat([sha(SP, NONCE), Buffer.alloc(32)])), { context: { nonce: NONCE } })],
  ["synthetic metal key only -> limited", Sy(metal(Buffer.concat([sha(SP), Buffer.alloc(32)])))], ["synthetic metal replay", Sy(metal(Buffer.concat([sha(SP), Buffer.alloc(32)])), { context: { nonce: NONCE } })],
  ["synthetic metal dirty rd1", Sy(metal(Buffer.concat([sha(SP, NONCE), Buffer.alloc(32, 1)])), { context: { nonce: NONCE } })],
  ["synthetic domain ABI/1 -> verified", Sy(domain(Buffer.concat([sha(SP, NONCE), APP])), { context: { nonce: NONCE, expectedAppId: APP } })],
  ["synthetic domain wrong app", Sy(domain(Buffer.concat([sha(SP, NONCE), APP])), { context: { nonce: NONCE, expectedAppId: sha(APP) } })],
  ["synthetic domain ABI/1 judged as ABI/2", Sy(domain(Buffer.concat([sha(SP, NONCE), APP])), { context: { nonce: NONCE, expectedAppId: APP, expectedBinding: sha(SP, NONCE) } })],
  ["synthetic v6 -> unsupported", Sy(metal(Buffer.concat([sha(SP, NONCE), Buffer.alloc(32)]), 6), { context: { nonce: NONCE } })],
  ["synthetic v6 research -> limited", Sy(metal(Buffer.concat([sha(SP, NONCE), Buffer.alloc(32)]), 6), { context: { nonce: NONCE }, policy: { researchAllowUnjudgedReportVersions: true } })],
  // a sibling VCEK under the same ASK, for ANOTHER chip, signs a report that names this chip: the chain and the signature
  // pass, and only the VCEK's own extensions refuse it (the one way to reach the "vcek identity" check with a valid signature)
  ["synthetic sibling VCEK of another chip signs the report", Sy({ format: "sev-snp-guest-metal-v1", body: synthReport({ ...S, vcekKey: S.otherVceks[0].key }, { reportData: Buffer.concat([sha(SP, NONCE), Buffer.alloc(32)]) }).toString("base64") }, { context: { nonce: NONCE }, collateral: sCol({ vceks: { Genoa: S.otherVceks[0].der } }) })],
  ["synthetic ASK revoked", Sy(metal(Buffer.concat([sha(SP, NONCE), Buffer.alloc(32)])), { context: { nonce: NONCE }, collateral: sCol({ crls: { Genoa: S.crlRevokingAsk } }) })],
  ["synthetic one-day CRL three days on, required", Sy(metal(Buffer.concat([sha(SP, NONCE), Buffer.alloc(32)])), { context: { nonce: NONCE, now: new Date(Date.now() + 3 * 86400000).toISOString() }, collateral: sCol({ crls: { Genoa: S.crls[1] } }) })],
  ["synthetic one-day CRL three days on, stale-ok 7 -> limited", Sy(metal(Buffer.concat([sha(SP, NONCE), Buffer.alloc(32)])), { context: { nonce: NONCE, now: new Date(Date.now() + 3 * 86400000).toISOString() }, policy: { crl: "stale-ok", crlMaxStaleDays: 7 }, collateral: sCol({ crls: { Genoa: S.crls[1] } }) })],
];

test("every case: the browser build's verdict equals the Node build's (status, checks, omissions, claims, reasons)", async () => {
  const seen = { verified: 0, limited: 0, rejected: 0, unsupported: 0 }, failing = new Set();
  for (const [name, { doc, opts }] of CASES) {
    const n = await verifyEvidence(doc, opts), w = await verifyEvidenceWeb(doc, opts);
    assert.equal(w.status, n.status, `${name}: status (node: ${n.reasons.at(-1)} | web: ${w.reasons.at(-1)})`);
    assert.deepEqual(norm(w), norm(n), name);
    seen[n.status]++; for (const [k, v] of Object.entries(n.checks || {})) if (v === false) failing.add(k);
  }
  assert.ok(CASES.length >= 90, `${CASES.length} cases`);
  for (const [k, v] of Object.entries(seen)) assert.ok(v >= 2, `${k}: ${v} cases`);
  for (const k of ["chain", "crl", "signature", "vcek identity", "binding", "certificate binding", "app id", "measurement", "tcb policy", "guest policy", "vmpl", "report shape", "vcek"]) assert.ok(failing.has(k), `a case fails the ${k} check`);
});

test("anchors: the green and the refused outcomes are what the SNP suites assert, in both builds", async () => {
  for (const [name, want] of [["genoa verified", "verified"], ["turin verified", "verified"], ["synthetic metal with nonce -> verified", "verified"], ["synthetic domain ABI/1 -> verified", "verified"],
    ["genoa no TCB floor -> limited", "limited"], ["genoa CRL none -> limited", "limited"], ["synthetic ASK revoked", "rejected"], ["synthetic under the real AMD pin", "rejected"], ["genoa version 6 -> unsupported", "unsupported"], ["TDX metal", "unsupported"]]) {
    const { doc, opts } = CASES.find(([n]) => n === name)[1];
    const w = await verifyEvidenceWeb(doc, opts); assert.equal(w.status, want, `${name}: ${w.reasons.join(" | ")}`);
    if (want === "verified") { assert.equal(w.admissionSafe, true); assert.deepEqual(w.omissions, []); assert.ok(Object.values(w.checks).every((c) => c === true)); }
  }
});

test("the browser build never judges another technology: AVF, VBS, Hyper-V and the pVM evidence formats are unsupported, never green", async () => {
  for (const format of ["android-avf-pvm/v1", "android-avf-pvm/v2", "windows-vbs-enclave/v1", "hyperv-partition-domain/v1", "enclave-pvm-app-evidence/v1", "enclave-pvm-app-evidence/v2"]) {
    const raw = report.toString("base64");   // these formats carry a plain body; a gzip one would be refused at the envelope in both builds
    const doc = format.includes("hyperv") ? { format, report: raw } : { format, body: raw, padKey: "00".repeat(32) };
    const w = await verifyEvidenceWeb(doc, { policy: {}, context: { transportKeySpki: spki, nonce: NONCE } });
    assert.equal(w.status, "unsupported", format); assert.equal(w.admissionSafe, false); assert.match(w.reasons[0], /^UNSUPPORTED/);
  }
});
