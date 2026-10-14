// AUTHENTIC Genoa evidence: a genuine PSP-signed report from a public Genoa host, its VCEK from AMD, the Genoa chain and
// AMD's CRL (test/helpers/genoa-capture.mjs says how the report is presented). Then every input is mutated on its own.
// A passing suite proves: the verifier walks a genuine PSP signature to AMD's pinned Genoa root offline and refuses each
// single-field forgery for the reason that field carries.
//   run: node --test test/verifier-snp-genoa.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { X509Certificate } from "node:crypto";
import { verifyEvidence, memoryCollateral, checkCrl, checkChain } from "../verifier/index.mjs";
import { report, MEAS, BINDING, APP_ID, spki, doc as rad, docWith, context, chains, vcekAmd, vcekProxy, crl, FLOOR } from "./helpers/genoa-capture.mjs";

const F = new URL("./fixtures/verifier/", import.meta.url);
const read = (u) => fs.readFileSync(u);
const NOW = "2026-09-24T05:00:00Z";
const col = (over = {}) => memoryCollateral({ chains, vceks: { Genoa: vcekAmd }, crls: { Genoa: crl }, ...over });
const run = (doc = rad, { policy = {}, context: ctx = {}, collateral = col() } = {}) =>
  verifyEvidence(doc, { policy: { snp: { allowedMeasurements: [MEAS], minTcb: FLOOR, ...policy } }, context: context({ now: NOW, ...ctx }), collateral });
const rejectedAt = (v, check, re) => { assert.equal(v.status, "rejected", v.reasons.join("\n")); assert.equal(v.checks[check], false, `expected the ${check} check to fail: ${v.reasons.at(-1)}`); if (re) assert.match(v.reasons.at(-1), re); };

test("the authentic report verifies end to end, and the verdict states what it rests on", async () => {
  const v = await run();
  assert.equal(v.status, "verified", v.reasons.join("\n")); assert.equal(v.admissionSafe, true); assert.deepEqual(v.omissions, []);
  for (const k of ["report shape", "report version", "product line", "guest policy", "vmpl", "chain", "crl", "signature", "vcek identity", "tcb policy", "measurement", "binding", "app id"]) assert.equal(v.checks[k], true, k);
  assert.equal(v.claims.product, "Genoa"); assert.equal(v.claims.reportVersion, 3); assert.equal(v.claims.vmpl, 0);
  assert.equal(v.claims.tcb.reported.snp, 23); assert.equal(v.claims.appId, APP_ID.toString("hex"));
});
test("the same key fetched through a third-party KDS proxy verifies identically: collateral source is irrelevant", async () => {
  const v = await run(rad, { collateral: col({ vceks: { Genoa: vcekProxy } }) });
  assert.equal(v.status, "verified", v.reasons.join("\n"));
  assert.notEqual(vcekAmd.equals(vcekProxy), true, "the two certificates differ in bytes");
  assert.equal(new X509Certificate(vcekAmd).publicKey.export({ type: "spki", format: "der" }).toString("hex"), new X509Certificate(vcekProxy).publicKey.export({ type: "spki", format: "der" }).toString("hex"));
});
test("without a TCB floor the run is LIMITED, never verified: the TCB is reported, not judged", async () => {
  const v = await run(rad, { policy: { minTcb: undefined } });
  assert.equal(v.status, "limited", v.reasons.join("\n")); assert.equal(v.admissionSafe, false);
  assert.deepEqual(v.omissions, ["tcb-floor-unjudged"]); assert.equal(v.checks["tcb policy"], null);
  assert.deepEqual(v.claims.tcb.reported, { bootloader: 10, tee: 0, snp: 23, microcode: 84 });
});
test("with a TCB floor the reported and committed TCB are judged", async () => {
  const ok = await run(rad);
  assert.equal(ok.status, "verified", ok.reasons.join("\n")); assert.equal(ok.checks["tcb policy"], true);
  rejectedAt(await run(rad, { policy: { minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 24, microcode: 84 } } } }), "tcb policy", /below policy/);
  rejectedAt(await run(rad, { policy: { minTcb: { Genoa: { bootloader: 10 } } } }), "tcb policy", /malformed/);
  rejectedAt(await run(rad, { policy: { minFirmware: { major: 1, minor: 56, build: 0 } } }), "firmware", /below policy/);
  assert.equal((await run(rad, { policy: { minFirmware: { major: 1, minor: 55, build: 40 } } })).status, "verified");
});

// ---- one field at a time ------------------------------------------------------------------------
test("signature: one flipped byte in r, in s, or in the signed region", async () => {
  for (const off of [0x2a0, 0x2a0 + 0x48, 0x91]) {
    const r = Buffer.from(report); r[off] ^= 1;
    const v = await run(docWith(r));
    assert.equal(v.status, "rejected", `offset 0x${off.toString(16)}`);
    assert.ok(v.checks.signature === false || v.checks.measurement === false, v.reasons.at(-1));
  }
});
test("signature: r or s out of the P-384 group order is refused before the curve is asked", async () => {
  const r = Buffer.from(report); r.fill(0xff, 0x2a0, 0x2a0 + 48);
  rejectedAt(await run(docWith(r)), "signature", /out of range/);
});
test("root: the chain of another product line, however genuine, is not this report's root", async () => {
  rejectedAt(await run(rad, { collateral: col({ chains: { Genoa: chains.Milan } }) }), "chain", /pinned|ARK|Milan|Genoa/);
  // a self-consistent chain whose ARK is not the pin: swap in Turin's chain under the Genoa name
  rejectedAt(await run(rad, { collateral: col({ chains: { Genoa: chains.Turin } }) }), "chain", /pinned/);
  // no pin at all for the product -> fail closed
  rejectedAt(await run(rad, { policy: { roots: new Map() } }), "chain", /no pinned AMD root/);
});
test("VCEK: a certificate for another chip / TCB does not verify this report", async () => {
  const turinVcek = read(new URL("turin-m4a/vcek-kds-amd.der", F));
  rejectedAt(await run(rad, { collateral: col({ vceks: { Genoa: turinVcek } }) }), "chain", /issuer|SEV-Genoa|signed/);
  const noVcek = await run(rad, { collateral: memoryCollateral({ chains, crls: { Genoa: crl } }) });
  rejectedAt(noVcek, "vcek", /no VCEK/);
});
test("TCB: a report whose reported TCB was edited no longer matches its VCEK (and its signature)", async () => {
  const r = Buffer.from(report); r[0x180] = 0x09;   // bootloader 10 -> 9
  const v = await run(docWith(r));
  assert.equal(v.status, "rejected"); assert.ok(v.checks.signature === false || v.checks["vcek identity"] === false, v.reasons.at(-1));
});
test("identity: the measurement must be one the policy allows, and the policy must name one", async () => {
  rejectedAt(await run(rad, { policy: { allowedMeasurements: ["ab".repeat(48)] } }), "measurement", /not an allowed measurement/);
  rejectedAt(await run(rad, { policy: { allowedMeasurements: [] } }), "measurement", /fail closed/);
  const r = Buffer.from(report); r[0x90] ^= 1;
  assert.equal((await run(docWith(r))).status, "rejected");
});
test("report_data: another binding, another app, no key, or an edited report_data is refused", async () => {
  const other = Buffer.from(BINDING); other[0] ^= 1;
  rejectedAt(await run(rad, { context: { expectedBinding: other } }), "binding", /does not equal the ABI\/2 .* binding/);
  const app = Buffer.from(APP_ID); app[0] ^= 1;
  rejectedAt(await run(rad, { context: { expectedAppId: app } }), "app id", /expected/);
  rejectedAt(await run(rad, { context: { transportKeySpki: undefined } }), "binding", /never skipped/);
  rejectedAt(await run({ ...rad, abi: "enclave-domain-abi/1" }), "binding", /no silent downgrade/);
  const r = Buffer.from(report); r[0x50] ^= 1;
  assert.equal((await run(docWith(r))).status, "rejected");
});
test("policy bits and VMPL: DEBUG, MIGRATE_MA, an unexpected VMPL, a required SMT-off", async () => {
  const dbg = Buffer.from(report); dbg[0x0a] |= 0x08;   // bit 19
  rejectedAt(await run(docWith(dbg)), "guest policy", /DEBUG/);
  const mig = Buffer.from(report); mig[0x0a] |= 0x04;   // bit 18
  rejectedAt(await run(docWith(mig)), "guest policy", /MIGRATE_MA/);
  rejectedAt(await run(rad, { policy: { expectedVmpl: 1 } }), "vmpl", /VMPL0/);
  rejectedAt(await run(rad, { policy: { guestPolicy: { smt: false } } }), "guest policy", /smt/);
  rejectedAt(await run(rad, { policy: { product: "Turin" } }), "product line", /CPUID names Genoa/);
  rejectedAt(await run(rad, { policy: { allowedProducts: ["Turin"] } }), "product line", /not an allowed/);
});
test("shape: truncated, padded, zeroed, old version, non-VCEK signer, non-zero reserved bytes", async () => {
  for (const [name, r] of [["truncated", report.subarray(0, 0x4a0 - 1)], ["padded", Buffer.concat([report, Buffer.alloc(1)])], ["zero", Buffer.alloc(0x4a0)]]) {
    const v = await run(docWith(Buffer.from(r))); rejectedAt(v, "report shape", undefined); assert.ok(v.reasons.at(-1), name);
  }
  const v1 = Buffer.from(report); v1.writeUInt32LE(1, 0); rejectedAt(await run(docWith(v1)), "report shape", /version 1/);
  const vlek = Buffer.from(report); vlek.writeUInt32LE(1 << 2, 0x48); rejectedAt(await run(docWith(vlek)), "report shape", /VLEK|key type/);
  const rsv = Buffer.from(report); rsv[0x4c] = 1; rejectedAt(await run(docWith(rsv)), "report shape", /reserved/);
  const sigTail = Buffer.from(report); sigTail[0x4a0 - 1] = 1; rejectedAt(await run(docWith(sigTail)), "report shape", /signature tail/);
});
test("collateral freshness: the CRL policy is applied to nextUpdate, and a foreign or tampered CRL is refused", async () => {
  const late = "2026-12-01T00:00:00Z";   // past the CRL's nextUpdate (2026-10-04) but inside the certificates' windows
  rejectedAt(await run(rad, { context: { now: late } }), "crl", /stale/);
  const staleOk = await run(rad, { context: { now: late }, policy: { crl: "stale-ok", crlMaxStaleDays: 90 } });
  assert.equal(staleOk.status, "limited", staleOk.reasons.join("\n")); assert.deepEqual(staleOk.omissions, ["crl-stale-accepted"]); assert.equal(staleOk.admissionSafe, false);
  rejectedAt(await run(rad, { context: { now: late }, policy: { crl: "stale-ok", crlMaxStaleDays: 10 } }), "crl", /stale/);
  const none = await run(rad, { policy: { crl: "none" } });
  assert.equal(none.status, "limited"); assert.equal(none.checks.crl, null); assert.deepEqual(none.omissions, ["crl-revocation-unchecked"]);
  const staleNone = await run(rad, { policy: { crl: "stale-ok" }, collateral: col({ crls: {} }) });
  assert.equal(staleNone.status, "limited"); assert.deepEqual(staleNone.omissions, ["crl-revocation-unchecked"]);
  rejectedAt(await run(rad, { collateral: col({ crls: {} }) }), "crl", /required by policy but none/);
  rejectedAt(await run(rad, { collateral: col({ crls: { Genoa: read(new URL("amd/Turin-crl.der", F)) } }) }), "crl", /issuer is not the pinned ARK/);
  const bad = Buffer.from(crl); bad[bad.length - 1] ^= 1;
  rejectedAt(await run(rad, { collateral: col({ crls: { Genoa: bad } }) }), "crl", /signature/);
});
test("revocation: the Genoa CRL really revokes serial 020001, and an ASK with that serial is refused", () => {
  const ch = checkChain({ vcekDer: vcekAmd, chainPem: chains.Genoa, product: "Genoa", now: new Date(NOW) });
  assert.equal(ch.ok, true);
  const revoked = checkCrl({ crlDer: crl, ark: ch.ark, ask: { serialNumber: "020001" }, now: new Date(NOW) });
  assert.equal(revoked.ok, false); assert.match(revoked.reasons[0], /REVOKED since 2022-10-31/);
  assert.equal(checkCrl({ crlDer: crl, ark: ch.ark, ask: ch.ask, now: new Date(NOW) }).ok, true);
});
test("certificate windows: a clock before the AMD certificates' validity rejects", async () => {
  rejectedAt(await run(rad, { context: { now: "2020-01-01T00:00:00Z" }, policy: { crl: "none" } }), "chain", /not valid at/);
});
