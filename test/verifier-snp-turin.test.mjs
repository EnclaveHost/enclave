// The domain format on AUTHENTIC Turin evidence: the isolation M4a document (report v5, ABI/2) and its VCEK.
// Proves: the Turin TCB layout (FMC) and 8-byte hardware id, a v5 report with MIT vectors, the ABI/2
// binding as caller-supplied bytes, the app-naming half, no silent ABI downgrade, and Turin TCB floors.
//   run: node --test test/verifier-snp-turin.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { verifyEvidence, memoryCollateral } from "../verifier/index.mjs";

const F = new URL("./fixtures/verifier/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url);
const saved = JSON.parse(fs.readFileSync(new URL("turin-m4a/doc.json", F), "utf8"));
const doc = saved.doc ?? saved;
const report = Buffer.from(doc.report, "base64");
const spki = Buffer.from(doc.transportKey, "base64"), nonce = Buffer.from(doc.nonce, "hex"), appId = Buffer.from(doc.appSha256, "hex");
const MEAS = report.subarray(0x90, 0xc0).toString("hex"), NOW = "2026-09-24T05:00:00Z";
const chains = { Turin: fs.readFileSync(new URL("Turin-cert_chain.pem", A), "utf8"), Genoa: fs.readFileSync(new URL("Genoa-cert_chain.pem", A), "utf8") };
const vcek = fs.readFileSync(new URL("turin-m4a/vcek-kds-amd.der", F)), crl = fs.readFileSync(new URL("amd/Turin-crl.der", F));
const col = (over = {}) => memoryCollateral({ chains, vceks: { Turin: vcek }, crls: { Turin: crl }, ...over });
// The ABI/2 binding, as a TEST VECTOR: sha256("enclave-bind-v2\n" || SPKI || nonce || RuntimeID) with RuntimeID =
// sha256(canonical JSON of the identity) (isolation/contract/RUNTIME.md). Production code imports the contract's
// runtime.mjs; test/verifier-abi2-contract.test.mjs checks this vector against it when the contract is present.
const canon = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
const rid = createHash("sha256").update(canon(doc.runtime)).digest();
const bind2 = createHash("sha256").update(Buffer.concat([Buffer.from("enclave-bind-v2\n"), spki, nonce, rid])).digest();
const TURIN_FLOOR = { Turin: { fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 } };
const run = (d = doc, { policy = {}, context = {}, collateral = col() } = {}) =>
  verifyEvidence(d, { policy: { snp: { allowedMeasurements: [MEAS], minTcb: TURIN_FLOOR, ...policy } }, context: { transportKeySpki: spki, nonce, expectedBinding: bind2, expectedAppId: appId, now: NOW, ...context }, collateral });
const rejectedAt = (v, check, re) => { assert.equal(v.status, "rejected", v.reasons.join("\n")); assert.equal(v.checks[check], false, v.reasons.at(-1)); if (re) assert.match(v.reasons.at(-1), re); };

test("the M4a document verifies: Turin layout, v5 report, ABI/2 binding, app id, TCB floor on reported and committed", async () => {
  const v = await run();
  assert.equal(v.status, "verified", v.reasons.join("\n")); assert.equal(v.admissionSafe, true); assert.deepEqual(v.omissions, []);
  assert.equal(v.claims.product, "Turin"); assert.equal(v.claims.reportVersion, 5); assert.equal(v.checks["report version"], true);
  assert.deepEqual(v.claims.tcb.reported, { fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 });
  assert.equal(v.claims.abi, "enclave-domain-abi/2"); assert.equal(v.claims.appId, doc.appSha256); assert.equal(v.claims.freshness, "verifier nonce");
  assert.equal(v.checks["tcb policy"], true); assert.equal(v.checks.crl, true);
  assert.equal(v.claims.chipId.slice(0, 16), "fa11afcf54ae9c53");
});
test("ABI/2: another runtime identity, nonce, key or app changes the binding and is refused", async () => {
  const other = { ...doc.runtime, version: "48.0.2" };
  const rid2 = createHash("sha256").update(canon(other)).digest();
  const b2 = createHash("sha256").update(Buffer.concat([Buffer.from("enclave-bind-v2\n"), spki, nonce, rid2])).digest();
  rejectedAt(await run(doc, { context: { expectedBinding: b2 } }), "binding", /ABI\/2/);
  const n2 = Buffer.from(nonce); n2[0] ^= 1;
  rejectedAt(await run(doc, { context: { expectedBinding: createHash("sha256").update(Buffer.concat([Buffer.from("enclave-bind-v2\n"), spki, n2, rid])).digest() } }), "binding", /ABI\/2/);
  const app2 = Buffer.from(appId); app2[0] ^= 1;
  rejectedAt(await run(doc, { context: { expectedAppId: app2 } }), "app id", /names app/);
  rejectedAt(await run(doc, { context: { expectedAppId: undefined } }), "app id", /needs the expected app id/);
});
test("no silent downgrade: a document that states ABI/2 is not judged under ABI/1, and vice versa", async () => {
  rejectedAt(await run(doc, { context: { expectedBinding: undefined } }), "binding", /no silent downgrade/);
  const abi1 = { ...doc }; delete abi1.abi; delete abi1.runtime; delete abi1.runtimeSelfTest;
  rejectedAt(await run(abi1), "binding", /no silent downgrade/);
  // an ABI/1 reading of the same bytes fails on the binding itself, because report_data holds Bind2, not sha256(spki||nonce)
  rejectedAt(await run(abi1, { context: { expectedBinding: undefined } }), "binding", /ABI\/1/);
  rejectedAt(await run(abi1, { context: { expectedBinding: undefined, nonce: undefined } }), "binding", /needs a nonce/);
});
test("Turin TCB floors: the FMC field is judged; a floor above the part is refused", async () => {
  rejectedAt(await run(doc, { policy: { minTcb: { Turin: { fmc: 2, bootloader: 3, tee: 2, snp: 5, microcode: 117 } } } }), "tcb policy", /fmc 1 < 2/);
  rejectedAt(await run(doc, { policy: { minTcb: { Genoa: { bootloader: 0, tee: 0, snp: 0, microcode: 0 } } } }), "tcb policy", /no floor for Turin/);
  const unjudged = await run(doc, { policy: { minTcb: undefined } });
  assert.equal(unjudged.status, "limited"); assert.equal(unjudged.checks["tcb policy"], null); assert.deepEqual(unjudged.omissions, ["tcb-floor-unjudged"]);
});
test("root and VCEK: Genoa's chain does not verify a Turin report; a Genoa VCEK is not this report's key", async () => {
  rejectedAt(await run(doc, { collateral: col({ chains: { Turin: chains.Genoa } }) }), "chain", /pinned/);
  rejectedAt(await run(doc, { collateral: col({ vceks: { Turin: fs.readFileSync(new URL("genoa-tinfoil/vcek-kds-amd.der", F)) } }) }), "chain", /SEV-Turin|issuer|signed/);
});
test("replay: the same report presented against a fresh nonce is refused", async () => {
  const fresh = Buffer.alloc(32, 7);
  rejectedAt(await run(doc, { context: { nonce: fresh, expectedBinding: createHash("sha256").update(Buffer.concat([Buffer.from("enclave-bind-v2\n"), spki, fresh, rid])).digest() } }), "binding", /ABI\/2/);
});
test("a byte flipped anywhere in the signed region or the signature is refused", async () => {
  for (const off of [0x00 + 4, 0x50 + 40, 0xc0, 0x1f8, 0x2a0 + 10]) {
    const r = Buffer.from(report); r[off] ^= 1;
    const v = await run({ ...doc, report: r.toString("base64") });
    assert.equal(v.status, "rejected", `offset 0x${off.toString(16)}: ${v.reasons.at(-1)}`);
  }
});
