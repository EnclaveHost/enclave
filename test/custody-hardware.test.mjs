// HARDWARE-BACKED custody verification: a GENUINE AMD Genoa report (test/fixtures/verifier/genoa-2026-09, PSP-signed, its
// VCEK from AMD KDS) judged by the custodian's PRODUCTION SNP verifier: AMD's pinned ARK roots, no override. The report was
// not produced for a custody release, so the custody binding cannot match it; what this suite shows is that every hardware
// layer (signature, VCEK -> ASK -> pinned ARK, CRL, TCB, policy bits) runs genuinely and that the custody-specific checks are
// what refuse it, and that the production verifier refuses everything synthetic. A custody release on real hardware needs a
// guest image carrying the custody client (isolation/m2/custody); docs/security/secret-custody.md names that blocker.
import test from "node:test";
import assert from "node:assert/strict";
import { report, doc, docWith, chains, vcekAmd, crl, FLOOR, BINDING, APP_ID, MEAS, context } from "./helpers/genoa-capture.mjs";
import { memoryCollateral, verifyEvidence } from "../verifier/index.mjs";
import { snpVerifier, productionVerifiers, SNP_GUEST_FORMAT } from "../custody/verifiers.mjs";
import { synthChain, synthReport } from "./helpers/snp-synth.mjs";

const CAPTURED = new Date("2026-09-24T05:00:00Z");   // inside the fixture CRL's window; the CRL went stale 2026-10-04
const collateral = memoryCollateral({ chains, vceks: { Genoa: vcekAmd }, crls: { Genoa: crl } });
const prod = snpVerifier({ collateral, now: () => CAPTURED });   // production roots: no `roots` argument
const args = (over = {}) => ({ doc: { ...doc, transportKey: Buffer.alloc(91, 7).toString("base64") }, allowedMeasurements: [MEAS], minTcb: FLOOR, vmpl: report.readUInt32LE(0x30),
                               binding: BINDING, appId: APP_ID, hostData: Buffer.from(report.subarray(0xc0, 0xe0)), ...over });

test("hardware: the genuine report verifies under AMD's pinned roots when its own report_data is expected (the hardware layers are real)", async () => {
  const v = await verifyEvidence(doc, { policy: { snp: { allowedMeasurements: [MEAS], minTcb: FLOOR, expectedVmpl: report.readUInt32LE(0x30) } }, context: context(), collateral });
  assert.equal(v.status, "verified", (v.reasons || []).join("\n"));
});

test("hardware: the custody verifier refuses that same genuine report: it was launched with HOST_DATA zero (bound to no deployment)", async () => {
  assert.ok(report.subarray(0xc0, 0xe0).every((b) => b === 0));
  const r = await prod(args());
  assert.equal(r.ok, false);
  assert.match(r.reason, /HOST_DATA is all zero/);
});

test("hardware: the same genuine report is REFUSED for a custody release: its report_data is not a custody binding", async () => {
  const custodyBinding = Buffer.alloc(32, 0x5c);
  const r = await prod(args({ binding: custodyBinding }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /report_data\[0:32\] does not equal/);
});

test("hardware: another deployment's HOST_DATA, another AppID, an unadmitted measurement or a higher TCB floor are each refused", async () => {
  for (const [over, why] of [
    [{ hostData: Buffer.alloc(32, 0xd1) }, /HOST_DATA is all zero/],
    [{ appId: Buffer.alloc(32, 0xa9) }, /report_data\[32:64\] names app/],
    [{ allowedMeasurements: ["00".repeat(48)] }, /is not an allowed measurement/],
    [{ minTcb: { Genoa: { ...FLOOR.Genoa, snp: FLOOR.Genoa.snp + 1 } } }, /reported TCB below policy/],
  ]) {
    const r = await prod(args(over));
    assert.equal(r.ok, false, `expected a refusal for ${JSON.stringify(Object.keys(over))}`);
    assert.match(r.reason, why);
  }
});

test("hardware: one flipped bit in the genuine report breaks the PSP signature", async () => {
  const forged = Buffer.from(report); forged[0x90] ^= 1;
  const r = await prod(args({ doc: { ...docWith(forged), transportKey: Buffer.alloc(91, 7).toString("base64") }, allowedMeasurements: [forged.subarray(0x90, 0xc0).toString("hex")] }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /signature/i);
});

test("hardware: a stale CRL fails closed (revocation is checked, never assumed)", async () => {
  const today = snpVerifier({ collateral, now: () => new Date("2026-10-14T00:00:00Z") });
  const r = await today(args());
  assert.equal(r.ok, false);
  assert.match(r.reason, /CRL/);
});

test("production table: synthetic evidence is refused under AMD's roots, and only the SNP format is judged at all", async () => {
  const S = synthChain();
  const synthCol = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
  const table = productionVerifiers({ collateral: synthCol });
  assert.deepEqual(Object.keys(table), [SNP_GUEST_FORMAT]);
  const rep = synthReport(S, { reportData: Buffer.alloc(64, 1), hostData: Buffer.alloc(32, 2) });
  const r = await table[SNP_GUEST_FORMAT]({ doc: { format: SNP_GUEST_FORMAT, abi: "enclave-domain-abi/2", transportKey: Buffer.alloc(91, 7).toString("base64"), report: rep.toString("base64") },
    allowedMeasurements: ["77".repeat(48)], minTcb: FLOOR, vmpl: 0, binding: Buffer.alloc(32, 1), appId: Buffer.alloc(32, 1), hostData: Buffer.alloc(32, 2) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ARK|root|chain|pinned/i);
});
