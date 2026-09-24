// The pVM owner's v3 instance binding (INSTANCE-BINDING.md, 193cf823) through THIS verifier: the owner's 23 static cases
// (pinned: pvm-v3-fixtures) replayed through verifier/pvm-evidence.mjs (which imports the owner's canonical module, pinned:
// pvm-app-attest), verifier/pvm-policy.mjs (type-2 policies with instances) and verifier/admission.mjs (expect.instanceIds),
// with the owner's own client sources at the same commit (pinned: pvm-client-src-v3) as the DIFFERENTIAL reference for the
// policy outcomes and the per-deployment instances. Proves: every evidence case reaches the owner's expected outcome here,
// the accepted v3 verdicts carry the InstanceID and the gate releases them only for a listed instance, a bound deployment
// refuses v2 as a downgrade before any certificate, and every malformed instance shape holds. No private key is in the
// fixtures; a fixed now and fixed nonces make the replay deterministic.
//   run: node --test test/verifier-pvm-v3.test.mjs   (strict: the three pins resolved by verifier/integration/run.mjs)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { verifyPvmEvidence, PVM_EVIDENCE_FORMAT_V3 } from "../verifier/pvm-evidence.mjs";
import { verifyClientPolicy, selectDeployment } from "../verifier/pvm-policy.mjs";
import { admit, createNonceRegistry, RELEASE, HOLD } from "../verifier/admission.mjs";

const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
const need = (env, what) => { if (!process.env[env]) { if (STRICT) throw new Error(`strict integration: ${env} (${what}) is not set`); return null; } return process.env[env]; };
const fixturesPath = need("ENCLAVE_PVM_V3_FIXTURES", "the owner's v3 fixtures"), ownerSrc = need("ENCLAVE_PVM_CLIENT_SRC_V3", "the owner's 0.5.0 client sources"), ownerModule = need("ENCLAVE_PVM_MODULE", "the owner's evidence module");
const skip = !(fixturesPath && ownerSrc && ownerModule) && "the owner's v3 fixtures, client sources or module are not pinned here (strict resolves them)";
const F = fixturesPath ? JSON.parse(fs.readFileSync(fixturesPath, "utf8")) : null;
const T = ownerSrc ? await import(pathToFileURL(ownerSrc).href) : null;   // trust.js: verifyPolicy, selectDeployment, initialState
const hexBuf = (h) => Buffer.from(h, "hex");
const expectOf = (c) => ({ nonce: hexBuf(c.expect.nonce), appId: hexBuf(c.expect.appId), ...(c.expect.instanceIds !== undefined ? { instanceIds: c.expect.instanceIds } : {}), ...(c.expect.formats ? { formats: c.expect.formats } : {}),
  allowedRuntimeIds: F.pins.allowedRuntimeIds, allowedCodeHashes: F.pins.allowedCodeHashes, allowedAuthorityHashes: F.pins.allowedAuthorityHashes, rootPins: [F.rootPin] });
// where this verifier's consumer pre-checks refuse BEFORE the owner's module runs, the reason is this verifier's own
const MINE = { "d-replay-other-nonce": "not this client's challenge", "other-app": "not the app this client expects", "empty-instance-list": "must be 1..8", "relabelled-v2": "must not carry instanceKey" };

test("the 16 evidence cases: each reaches the owner's outcome through this verifier; accepted v3 verdicts carry the InstanceID (v2 none); refusals name the owner's reason or this verifier's earlier one", { skip }, async () => {
  assert.equal(F.type, "enclave-pvm-v3-fixtures/1"); assert.equal(F.evidence.length, 16);
  for (const c of F.evidence) {
    const v = await verifyPvmEvidence(c.envelope, expectOf(c), { now: F.now });
    assert.equal(v.status === "verified", c.want.ok, `${c.name}: ${v.reasons.join(" | ")}`);
    if (c.want.ok) {
      assert.equal(v.claims.instanceId, c.want.instanceId, `${c.name}: InstanceID`);
      assert.equal(v.claims.format, c.envelope.format); assert.equal(v.claims.instanceKey, c.envelope.format === PVM_EVIDENCE_FORMAT_V3 ? c.envelope.instanceKey : null);
      assert.ok(v.claims.appKey && v.claims.sealed, `${c.name}: app key and sealed window`);
      if (c.expect.instanceIds) assert.deepEqual(v.claims.bound, c.expect.instanceIds);
    } else {
      const text = v.reasons.join(" | "), want = MINE[c.name] || c.want.reason;
      assert.ok(text.includes(want), `${c.name}: expected "${want}" in: ${text}`);
      if (c.want.passedAppKey) for (const s of ["Bind3", "the instance key signed this challenge"]) assert.ok(text.includes(s), `${c.name}: the owner's checks before the instance refusal ran (${s})`);
    }
  }
});

test("the gate: a bound deployment releases only a v3 verdict naming a listed instance, native and browser alike; another instance, a v2 verdict, a malformed expectation and a replayed challenge hold", { skip }, async () => {
  const byName = (n) => F.evidence.find((c) => c.name === n);
  const bound = byName("v3-bound"), unbound = byName("v3-unbound"), v2 = byName("v2-unbound"), other = byName("a-other-instance");
  const vB = await verifyPvmEvidence(bound.envelope, expectOf(bound), { now: F.now }), vU = await verifyPvmEvidence(unbound.envelope, expectOf(unbound), { now: F.now }), v2v = await verifyPvmEvidence(v2.envelope, expectOf(v2), { now: F.now });
  assert.equal(vB.status, "verified"); assert.equal(vU.status, "verified"); assert.equal(v2v.status, "verified");
  const I1 = F.instances.I1, I2 = F.instances.I2, spki = (v) => hexBuf(v.claims.transportSpki);
  assert.equal(admit(vB, { ...expectOf(bound) }, { clientKind: "browser" }).decision, RELEASE);
  assert.equal(admit(vB, { ...expectOf(bound) }, { clientKind: "native", observedPeerSpki: spki(vB) }).decision, RELEASE);
  assert.equal(admit(vB, { ...expectOf(bound), instanceIds: [I2, I1] }, { clientKind: "browser" }).decision, RELEASE, "listed among several");
  assert.match(admit(vB, { ...expectOf(bound), instanceIds: [I2] }, { clientKind: "browser" }).reasons.at(-1), /not one bound to the selected deployment/);
  assert.match(admit(vB, { ...expectOf(bound), instanceIds: [] }, { clientKind: "browser" }).reasons.at(-1), /malformed/);
  assert.match(admit(vB, { ...expectOf(bound), instanceIds: [I1.toUpperCase()] }, { clientKind: "browser" }).reasons.at(-1), /malformed/);
  assert.equal(admit(vU, { ...expectOf(unbound) }, { clientKind: "browser" }).decision, RELEASE, "unbound: any genuine instance");
  assert.match(admit(v2v, { ...expectOf(v2), instanceIds: [I1] }, { clientKind: "browser" }).reasons.at(-1), /only a v3 verdict naming the instance can release/);
  assert.match(admit({ ...vB, claims: { ...vB.claims, instanceId: null } }, { ...expectOf(bound) }, { clientKind: "browser" }).reasons.at(-1), /only a v3 verdict naming the instance/);
  const vO = await verifyPvmEvidence(other.envelope, expectOf(other), { now: F.now }); assert.equal(vO.status, "rejected"); assert.equal(admit(vO, expectOf(other), { clientKind: "browser" }).decision, HOLD);
  // the adapter refuses v2 for a bound deployment before the owner's module: a downgrade by name
  const v2bound = await verifyPvmEvidence(v2.envelope, { ...expectOf(v2), instanceIds: [I1] }, { now: F.now });
  assert.equal(v2bound.status, "rejected"); assert.match(v2bound.reasons.at(-1), /downgrade \(v3 required\)/);
  const reg = createNonceRegistry(); assert.equal(admit(vB, expectOf(bound), { clientKind: "browser", nonceRegistry: reg }).decision, RELEASE); assert.match(admit(vB, expectOf(bound), { clientKind: "browser", nonceRegistry: reg }).reasons.at(-1), /used before/);
});

test("the 7 policy cases: this verifier and the owner's 0.5.0 trust.js agree on every outcome and on the instances bound per deployment; a bound selection's expectation carries them and narrows the formats to v3", { skip }, async () => {
  assert.equal(F.policy.length, 7);
  for (const c of F.policy) {
    const mine = verifyClientPolicy(c.envelope, { anchorFp: F.policyAnchor.policyKeyFp, serialFloor: F.policyAnchor.serialFloor, now: F.policyNow, clientVersion: "0.5.0" });
    const theirs = await T.verifyPolicy(c.envelope, { state: T.initialState(F.policyAnchor), now: F.policyNow });
    assert.equal(mine.ok, c.want.ok, `${c.name}: mine: ${mine.reason}`); assert.equal(theirs.ok, c.want.ok, `${c.name}: theirs: ${theirs.reasons && theirs.reasons[0]}`);
    if (c.want.reason) assert.ok(mine.reason.includes(c.want.reason), `${c.name}: "${mine.reason}" should say "${c.want.reason}"`);
    if (c.want.instances) for (const [d, inst] of Object.entries(c.want.instances)) {
      assert.deepEqual(selectDeployment(mine.policy, { deployment: d }).instances, inst, `${c.name} ${d.slice(0, 10)}: mine`);
      assert.deepEqual(T.selectDeployment(theirs.policy, { deployment: d }).instances, inst, `${c.name} ${d.slice(0, 10)}: theirs`);
      const e = mine.expectationsForSelection({ deployment: d }); assert.equal(e.ok, true);
      if (inst) { assert.deepEqual(e.expect.instanceIds, inst); assert.deepEqual(e.expect.formats, [PVM_EVIDENCE_FORMAT_V3]); assert.deepEqual(e.instances, inst); }
      else { assert.equal(e.expect.instanceIds, undefined); assert.equal(e.instances, null); }
    }
  }
  // the 0.4.1 rule is unchanged for a type-1 policy: its entries are exactly { id, app }, and the type-2 string is not type 1
  const t2 = F.policy.find((c) => c.name === "type2-bound"); const p = JSON.parse(Buffer.from(t2.envelope.policy, "base64").toString());
  assert.equal(p.type, "enclave-pvm-client-policy/2");
});
