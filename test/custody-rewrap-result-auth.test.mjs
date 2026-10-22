// The rewrap RESULT reaches the owner through the UNTRUSTED host. Root security review P1 (reproduced against the pre-fix
// candidate: work/custody-owner-migration/repro/) showed a host could substitute an arbitrary bundle. The fix: the guest
// attests the exact result (custody/v2/rewrap.mjs attestResult: an SEV-SNP evidence document whose report_data[0:32] is
// resultBinding(result)), and the owner AUTHENTICATES it (verifyRewrapResult, required by checkResultAndSwitch) with the
// EXISTING verifier before any switch is built. Here: the existing verifier (custody/verifiers.mjs snpVerifier) over the
// SYNTHETIC AMD chain of the other custody tests (test roots injected; production uses productionVerifiers + AMD KDS),
// the guest's own evidence attester (rewrap-guest.mjs snpEvidenceAttester) over a synthetic report source.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { keccak256 } from "viem";
import * as v2 from "../custody/v2/protocol.mjs";
import { canonicalRules } from "../custody/rules.mjs";
import { snpVerifier, SNP_GUEST_FORMAT } from "../custody/verifiers.mjs";
import { memoryCollateral } from "../verifier/index.mjs";
import { synthChain } from "./helpers/snp-synth.mjs";
import { resign } from "./helpers/custody-rig.mjs";
import { syntheticReport } from "./helpers/rewrap-rig.mjs";
import { normalizeAuthorization, rewrapDigest, authorizationJson, sealForDestination, attestResult, resultBinding, verifyRewrapResult, checkResultAndSwitch,
  originalRulesOf, REWRAP_RUNTIME, REWRAP_RUNTIME_ID } from "../custody/v2/rewrap.mjs";
import { snpEvidenceAttester } from "../custody/v2/rewrap-guest.mjs";

const CHAIN = 8453, VAULT = "0xe48699b8401564aace7a814ae4569b67a3f7eef5";
const h = () => "0x" + randomBytes(32).toString("hex");
const sha = (b) => "0x" + createHash("sha256").update(b).digest("hex");
const REWRAP_MEAS = "5e".repeat(48), APP = "a7".repeat(32);
const FLOOR = { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } };
const ORIGINAL = { v: 1, appId: APP, images: [{ platform: "sev-snp", measurement: "77".repeat(48), runtimeId: "29".repeat(32) }], minTcb: FLOOR, vmpl: 0 };
const ADMITTED = { ...ORIGINAL, images: [...ORIGINAL.images, { platform: "sev-snp", measurement: REWRAP_MEAS, runtimeId: REWRAP_RUNTIME_ID }] };
const S = synthChain(), OTHER_AMD = synthChain();
const verifiers = Object.freeze({ [SNP_GUEST_FORMAT]: snpVerifier({ collateral: memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } }),
                                                                 roots: new Map([["Genoa", S.arkFp]]) }) });

function world() {
  const dst = v2.genesis();
  const auth = { id: h(), sourcePolicyRev: "3", sourceSecretRev: "2", sourceCommitteeId: h(), sourceBundleHash: h(), destCommitteeId: h(),
    destKeyHash: keccak256("0x" + Buffer.from(dst.Y).toString("hex")), destCodeMeasurement: h(), destSecretRev: "3", leaseEndpoint: "https://app.host.test",
    rewrapMeasurement: sha(Buffer.from(REWRAP_MEAS, "hex")), rewrapRuntimeId: "0x" + REWRAP_RUNTIME_ID, expiry: "1900000000" };
  return { dst, auth, a: normalizeAuthorization(auth) };
}
// what runRewrap builds and attests (the production functions), from a payload
async function guestResult(w, { env = { API_KEY: "the-real-secret-" + randomBytes(6).toString("hex") }, report } = {}) {
  const sealed = sealForDestination({ chainId: CHAIN, vault: VAULT, a: w.a, destY: w.dst.Y, payload: { env, configSha256: "c".repeat(64) } });
  const bundle = "0x" + Buffer.from(sealed.bundle).toString("hex");
  const pub = { format: "enclave-custody-rewrap/1", chainId: CHAIN, vault: VAULT, authorizationDigest: rewrapDigest({ chainId: CHAIN, vault: VAULT, authorization: w.a }),
    authorization: authorizationJson(w.a), checkedAtBlock: { number: "100", hash: h() },
    destination: { committeeId: w.a.destCommitteeId, secretRev: "3", label: "0x" + Buffer.from(sealed.label).toString("hex") },
    bundle, bundleHash: keccak256(bundle), bundleBytes: sealed.bundle.length };
  const attester = snpEvidenceAttester(report || syntheticReport(S, { measurement: REWRAP_MEAS, hostData: w.a.id.slice(2) }));
  return attestResult({ pub, attester, appId: Buffer.from(APP, "hex") });
}
const verify = (w, result, over = {}) => verifyRewrapResult({ chainId: CHAIN, vault: VAULT, authorization: w.auth, result, rules: ADMITTED, verifiers, ...over });
const code = async (p) => { try { await p; return "accepted"; } catch (e) { return e.code || e.message; } };
const swap = (r, bundleBytes) => { const b = "0x" + Buffer.from(bundleBytes).toString("hex"); return { ...r, bundle: b, bundleHash: keccak256(b), bundleBytes: bundleBytes.length }; };

test("an honest attested result verifies, and only then is a switch built", async () => {
  const w = world(), r = await guestResult(w);
  const v = await verify(w, r);
  assert.equal(v.synthetic, true, "this fixture's AMD chain is synthetic (production: productionVerifiers, no test roots)");
  assert.equal(v.measurement, REWRAP_MEAS);
  const { switchUpdate } = await checkResultAndSwitch({ chainId: CHAIN, vault: VAULT, authorization: w.auth, result: r, rules: ADMITTED, verifiers, originalRules: originalRulesOf(ADMITTED, w.auth) });
  assert.deepEqual([switchUpdate.expectPolicyRev, switchUpdate.committeeId, switchUpdate.bundle, switchUpdate.rules],
                   [3n, w.a.destCommitteeId, r.bundle, "0x" + Buffer.from(canonicalRules(ORIGINAL)).toString("hex")]);
});

test("ROOT P1 EXPLOIT, now refused: the host substitutes a bundle with attacker-chosen secrets under the public key and label", async () => {
  const w = world(), r = await guestResult(w);
  const label = v2.labelOf({ chainId: CHAIN, vault: VAULT, id: w.a.id, secretRev: w.a.destSecretRev, committeeId: w.a.destCommitteeId });
  const evil = v2.encryptBundle({ Y: w.dst.Y, label, env: { API_KEY: "attacker-chosen" }, configSha256: "d".repeat(64) });
  const forged = swap(r, evil);
  assert.equal(v2.verifyLabelProof(evil, label), true, "the forgery passes every public check the pre-fix owner made");
  assert.equal(await code(verify(w, forged)), "bad_attestation");
  assert.equal(await code(checkResultAndSwitch({ chainId: CHAIN, vault: VAULT, authorization: w.auth, result: forged, rules: ADMITTED, verifiers, originalRules: ORIGINAL })),
    "bad_attestation", "no switch is built");
});

test("cross-run, cross-authorization and field tampering are refused", async () => {
  const w = world(), r1 = await guestResult(w), r2 = await guestResult(w);
  assert.equal(await code(verify(w, { ...r2, attestation: r1.attestation })), "bad_attestation", "run 1's attestation on run 2's (honest) result");
  const other = world(), ro = await guestResult(other);
  assert.equal(await code(verify(w, ro)), "bad_result", "a genuine result for ANOTHER authorization");
  assert.equal(await code(verify(w, { ...ro, authorization: authorizationJson(w.a), authorizationDigest: r1.authorizationDigest })), "bad_result", "relabelled to this authorization: the destination differs");
  // same deployment and destination, but the owner's newer authorization (re-planned: another source revision) - a stale result
  const newer = { ...w, auth: { ...w.auth, sourcePolicyRev: "4" } };
  assert.equal(await code(verify(newer, r1)), "bad_result", "a result for a stale authorization");
  assert.equal(await code(verify(w, { ...r1, checkedAtBlock: { number: "101", hash: r1.checkedAtBlock.hash } })), "bad_attestation", "any public field is bound");
  assert.equal(await code(verify(w, { ...r1, destination: { ...r1.destination, secretRev: "9" } })), "bad_result");
  assert.equal(await code(verify(w, { ...r1, attestation: { ...r1.attestation, transportKey: Buffer.from(randomBytes(91)).toString("base64") } })), "bad_attestation", "the attested transport key is bound");
});

test("the report must be genuine and from the authorized image, launched for this deployment, in the rewrap runtime", async () => {
  const w = world();
  const cases = [
    ["wrong HOST_DATA", { report: syntheticReport(S, { measurement: REWRAP_MEAS, hostData: randomBytes(32).toString("hex") }) }],
    ["another measurement", { report: syntheticReport(S, { measurement: "6f".repeat(48), hostData: w.a.id.slice(2) }) }],
    ["signed by another (non-AMD) chain", { report: syntheticReport(OTHER_AMD, { measurement: REWRAP_MEAS, hostData: w.a.id.slice(2) }) }],
    ["a tampered report", { report: (rd) => { const x = syntheticReport(S, { measurement: REWRAP_MEAS, hostData: w.a.id.slice(2) })(rd); x[0x60] ^= 1; return x; } }],
    ["a debuggable guest", { report: (rd) => resign(S, syntheticReport(S, { measurement: REWRAP_MEAS, hostData: w.a.id.slice(2) })(rd), { debug: true }) }],
  ];
  for (const [what, over] of cases) assert.equal(await code(verify(w, await guestResult(w, over))), "bad_attestation", what);
  const r = await guestResult(w);
  assert.equal(await code(verify(w, { ...r, attestation: { ...r.attestation, runtime: { ...REWRAP_RUNTIME, version: "9.9.9" } } })), "bad_attestation", "another runtime");
  assert.equal(await code(verify(w, r, { rules: ORIGINAL })), "not_admitted", "the policy does not admit the image");
  assert.equal(await code(verify(w, r, { rules: { ...ADMITTED, appId: "b8".repeat(32) } })), "bad_attestation", "another appId");
  assert.equal(await code(verify(w, r, { verifiers: {} })), "no_verifier", "no verifier: never accepted");
  assert.equal(await code(verify(w, { ...r, attestation: undefined })), "bad_result", "an unattested result");
  assert.throws(() => originalRulesOf(ORIGINAL, w.auth), /exactly the authorized rewrap image/);
  assert.ok(resultBinding(r, Buffer.alloc(91)).length === 32);
});
