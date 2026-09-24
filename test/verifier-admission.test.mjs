// verifier/admission.mjs: the consumer gate on AUTHENTIC verdicts (Genoa hosted, Turin domain) and on synthetic
// verdict shapes. Proves: only a "verified", admission-safe, omission-free verdict with every expectation
// supplied by the client and a single-use challenge can release; a native client's own peer key must be the
// bound key; a browser client releases only on an application-layer key and never claims TLS pinning.
//   run: node --test test/verifier-admission.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { verifyEvidence, memoryCollateral, spkiOfCert, admit, createNonceRegistry, RELEASE, HOLD } from "../verifier/index.mjs";
import { AMD_ARK_SHA256 } from "../relay/snp-verify.mjs";

const F = new URL("./fixtures/verifier/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url);
const NOW = "2026-09-24T05:00:00Z", ROOTS = Object.fromEntries(AMD_ARK_SHA256);
// ---- Genoa hosted (authentic)
const rad = JSON.parse(fs.readFileSync(new URL("genoa-tinfoil/rad.json", F), "utf8"));
const gReport = gunzipSync(Buffer.from(rad.body, "base64")), gMeas = gReport.subarray(0x90, 0xc0).toString("hex");
const certPem = fs.readFileSync(new URL("genoa-tinfoil/tls-cert.pem", F), "utf8"), gSpki = spkiOfCert(certPem).spki;
const gFloor = { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } };
const gCol = memoryCollateral({ chains: { Genoa: fs.readFileSync(new URL("Genoa-cert_chain.pem", A), "utf8") }, vceks: { Genoa: fs.readFileSync(new URL("genoa-tinfoil/vcek-kds-amd.der", F)) }, crls: { Genoa: fs.readFileSync(new URL("amd/Genoa-crl.der", F)) } });
const genoaVerdict = (policy = {}) => verifyEvidence(rad, { policy: { snp: { allowedMeasurements: [gMeas], minTcb: gFloor, ...policy } }, context: { transportKeySpki: gSpki, certPem, host: "inference.tinfoil.sh", now: NOW }, collateral: gCol });
const gExpect = { allowedMeasurements: [gMeas], minTcb: gFloor, roots: ROOTS };
// ---- Turin domain (authentic, ABI/2)
const saved = JSON.parse(fs.readFileSync(new URL("turin-m4a/doc.json", F), "utf8")); const d = saved.doc ?? saved;
const tReport = Buffer.from(d.report, "base64"), tMeas = tReport.subarray(0x90, 0xc0).toString("hex");
const tSpki = Buffer.from(d.transportKey, "base64"), tNonce = Buffer.from(d.nonce, "hex"), tApp = Buffer.from(d.appSha256, "hex");
const canon = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
const tBind = createHash("sha256").update(Buffer.concat([Buffer.from("enclave-bind-v2\n"), tSpki, tNonce, createHash("sha256").update(canon(d.runtime)).digest()])).digest();
const tFloor = { Turin: { fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 } };
const tCol = memoryCollateral({ chains: { Turin: fs.readFileSync(new URL("Turin-cert_chain.pem", A), "utf8") }, vceks: { Turin: fs.readFileSync(new URL("turin-m4a/vcek-kds-amd.der", F)) }, crls: { Turin: fs.readFileSync(new URL("amd/Turin-crl.der", F)) } });
const turinVerdict = () => verifyEvidence(d, { policy: { snp: { allowedMeasurements: [tMeas], minTcb: tFloor } }, context: { transportKeySpki: tSpki, nonce: tNonce, expectedBinding: tBind, expectedAppId: tApp, now: NOW }, collateral: tCol });
const tExpect = { nonce: tNonce, appId: tApp, allowedMeasurements: [tMeas], minTcb: tFloor, roots: ROOTS };
const held = (r, re) => { assert.equal(r.decision, HOLD, r.reasons.join("\n")); assert.equal(r.pinned, null); assert.match(r.reasons.at(-1), re); };

test("Genoa hosted, native client: releases only when the connection's peer key is the bound key", async () => {
  const v = await genoaVerdict();
  const ok = admit(v, gExpect, { clientKind: "native", observedPeerSpki: gSpki });
  assert.equal(ok.decision, RELEASE, ok.reasons.join("\n")); assert.equal(ok.pinned.transportSpkiSha256, v.claims.tlsSpkiSha256);
  const other = Buffer.from(gSpki); other[other.length - 1] ^= 1;
  held(admit(v, gExpect, { clientKind: "native", observedPeerSpki: other }), /not the key the evidence binds/);
  held(admit(v, gExpect, { clientKind: "native" }), /no observed peer key/);
});
test("Genoa hosted, browser client: releases on the HPKE key and says TLS pinning is not claimed", async () => {
  const v = await genoaVerdict();
  const ok = admit(v, gExpect, { clientKind: "browser" });
  assert.equal(ok.decision, RELEASE, ok.reasons.join("\n")); assert.equal(ok.pinned.appKey, v.claims.hpkePublicKey); assert.equal(ok.pinned.transportSpkiSha256, undefined);
  assert.match(ok.reasons.join("\n"), /TLS certificate pinning is NOT claimed/);
  const noKey = { ...v, claims: { ...v.claims, hpkePublicKey: undefined } };
  held(admit(noKey, gExpect, { clientKind: "browser" }), /binds no application-layer public key/);
});
test("a limited verdict never releases, whatever the client kind", async () => {
  const limited = await genoaVerdict({ minTcb: undefined });
  assert.equal(limited.status, "limited");
  held(admit(limited, gExpect, { clientKind: "native", observedPeerSpki: gSpki }), /verdict is "limited" \(omitted: tcb-floor-unjudged\)/);
  held(admit(limited, gExpect, { clientKind: "browser" }), /limited/);
  const noCrl = await genoaVerdict({ crl: "none" });
  held(admit(noCrl, gExpect, { clientKind: "browser" }), /crl-revocation-unchecked/);
});
test("client expectations are required and cross-checked, not taken from the verdict", async () => {
  const v = await genoaVerdict();
  held(admit(v, { ...gExpect, allowedMeasurements: [] }, { clientKind: "browser" }), /no allowed measurements/);
  held(admit(v, { ...gExpect, allowedMeasurements: ["ab".repeat(48)] }, { clientKind: "browser" }), /not one the client expects/);
  held(admit(v, { ...gExpect, minTcb: undefined }, { clientKind: "browser" }), /no minimum-TCB policy/);
  held(admit(v, { ...gExpect, roots: {} }, { clientKind: "browser" }), /no root pins/);
  held(admit(v, { ...gExpect, roots: { Genoa: "00".repeat(32) } }, { clientKind: "browser" }), /not the client's pin for Genoa/);
  held(admit(v, { ...gExpect, roots: { Milan: ROOTS.Milan } }, { clientKind: "browser" }), /not the client's pin for Genoa/);
});
test("Turin domain (ABI/2), native client: releases with the client's nonce and app id; each expectation holds on its own", async () => {
  const v = await turinVerdict(); assert.equal(v.status, "verified", v.reasons.join("\n"));
  const ok = admit(v, tExpect, { clientKind: "native", observedPeerSpki: tSpki });
  assert.equal(ok.decision, RELEASE, ok.reasons.join("\n")); assert.match(ok.reasons.join("\n"), /single-use challenge/);
  held(admit(v, { ...tExpect, nonce: undefined }, { clientKind: "native", observedPeerSpki: tSpki }), /no 32-byte challenge/);
  held(admit(v, { ...tExpect, appId: undefined }, { clientKind: "native", observedPeerSpki: tSpki }), /no expected app id/);
  const otherApp = Buffer.from(tApp); otherApp[0] ^= 1;
  held(admit(v, { ...tExpect, appId: otherApp }, { clientKind: "native", observedPeerSpki: tSpki }), /not the client's expected app/);
  held(admit(v, tExpect, { clientKind: "native", observedPeerSpki: gSpki }), /not the key the evidence binds/);
  // a domain document binds no application-layer key: a browser client cannot release on it
  held(admit(v, tExpect, { clientKind: "browser" }), /binds no application-layer public key/);
});
test("the challenge is single-use: the same nonce holds the second time, even with a fine verdict", async () => {
  const v = await turinVerdict(); const reg = createNonceRegistry();
  assert.equal(admit(v, tExpect, { clientKind: "native", observedPeerSpki: tSpki, nonceRegistry: reg }).decision, RELEASE);
  held(admit(v, tExpect, { clientKind: "native", observedPeerSpki: tSpki, nonceRegistry: reg }), /used before/);
  assert.equal(reg.size(), 1);
});
test("verdict shapes that must hold: unsupported, rejected, inconsistent, malformed", () => {
  const base = { status: "verified", admissionSafe: true, omissions: [], checks: { a: true }, claims: { technology: "amd-sev-snp", family: "hosted-tinfoil", measurement: gMeas, product: "Genoa", arkFingerprint: ROOTS.Genoa, freshness: "served certificate window", hpkePublicKey: "11".repeat(32), tlsSpkiSha256: "22".repeat(32) } };
  assert.equal(admit(base, gExpect, { clientKind: "browser" }).decision, RELEASE);
  held(admit({ ...base, status: "unsupported" }, gExpect, { clientKind: "browser" }), /"unsupported"/);
  held(admit({ ...base, status: "rejected" }, gExpect, { clientKind: "browser" }), /"rejected"/);
  held(admit({ ...base, admissionSafe: false }, gExpect, { clientKind: "browser" }), /not marked admission-safe/);
  held(admit({ ...base, omissions: ["x"] }, gExpect, { clientKind: "browser" }), /carries omissions/);
  held(admit({ ...base, checks: { a: true, b: null } }, gExpect, { clientKind: "browser" }), /not every check is true: b=null/);
  held(admit({ ...base, checks: {} }, gExpect, { clientKind: "browser" }), /no checks/);
  held(admit({ ...base, claims: null }, gExpect, { clientKind: "browser" }), /no claims/);
  held(admit({ ...base, claims: { ...base.claims, freshness: "none (key possession only)" } }, { ...gExpect, nonce: randomBytes(32) }, { clientKind: "browser" }), /not the client's challenge/);
  held(admit({ ...base, claims: { ...base.claims, family: "metal", freshness: "served certificate window" } }, gExpect, { clientKind: "browser" }), /only the hosted format's rule/);
  held(admit({ ...base, claims: { ...base.claims, technology: "intel-tdx" } }, gExpect, { clientKind: "browser" }), /no admission rule for technology/);
  held(admit(null, gExpect), /malformed verdict/); held(admit("verified", gExpect), /malformed verdict/);
  held(admit(base, gExpect, { clientKind: "curl" }), /unknown client kind/);
});
