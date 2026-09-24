// test/verifier-hyperv-domain-refused.test.mjs: a NucBox partition's attestation document ("hyperv-partition-domain/v1",
// tier T0-hv: a launcher in the root partition signs; the host is NOT excluded; no SEV-SNP, VMPL or TEE) must never be
// "verified" by this verifier. It is judged elsewhere (windows/vbslike/verify/judge-hv.mjs, verdict at best
// monitor-signed) and this harness says so: status unsupported, admissionSafe false, never a verified claim. Recorded
// 2026-09-24 while the NucBox VBS-like tier was being brought up, so that no shadow or admission path here can be
// handed such a document and call it attested.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { verifyEvidence } from "../verifier/index.mjs";
import { verifyEvidenceWeb } from "../verifier/web/index.mjs";

const RUNTIME = { name: "wasmtime", version: "48.0.1", execution: "jit", targetIsa: "x86_64", hostIsa: "x86_64", cpuFeatures: "host-detected", wx: "enforced", cache: "none" };
const APP = "9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45";
// the front's shape for a partition (isolation/m3/HV-GUEST.md at 63b2b276): a launcher-signed JSON in `report`
const doc = (nonce) => ({ tier: "T0-hv", format: "hyperv-partition-domain/v1", abi: "enclave-domain-abi/2", nonce: nonce.toString("hex"),
  transportKey: randomBytes(91).toString("base64"), appSha256: APP, runtime: RUNTIME, runtimeSelfTest: "exec_pages=allowed wx=clean maps=3 scope=all-processes",
  report: Buffer.from(JSON.stringify({ doc: { format: "hyperv-partition-domain/v1", tier: "T0-hv", platform: { hostExcluded: false }, launcher: { key: randomBytes(32).toString("base64") },
    domain: { label: "dep-1", appSha256: APP }, reportData: "00".repeat(64), boundary: "tier=T0-hv host_excluded=no" }, sig: randomBytes(64).toString("base64") })).toString("base64") });

test("a Hyper-V partition document is never verified here: unsupported, admissionSafe false, and the reason names the judge that does judge it", async () => {
  const nonce = randomBytes(32);
  const v = await verifyEvidence(doc(nonce), { policy: {}, context: { transportKeySpki: randomBytes(91), nonce, expectedAppId: Buffer.from(APP, "hex"), now: "2026-09-24T22:00:00Z" } });
  assert.notEqual(v.status, "verified"); assert.equal(v.admissionSafe, false);
  assert.equal(v.status, "unsupported", v.reasons.join("\n"));
  assert.match(v.reasons.join("\n"), /judge-hv|Hyper-V/i, "the reason points at the launcher-key judge, not at a hardware root");
  assert.doesNotMatch(JSON.stringify(v), /"status":"verified"|attested/i);
  const w = await verifyEvidenceWeb(doc(nonce), { policy: {}, context: { transportKeySpki: randomBytes(91), nonce, expectedAppId: Buffer.from(APP, "hex"), now: "2026-09-24T22:00:00Z" } });
  assert.equal(w.status, v.status, "the browser build agrees"); assert.equal(w.admissionSafe, false);
});
