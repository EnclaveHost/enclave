#!/usr/bin/env node
// make-fixtures.mjs -- writes test/fixtures/pvm-v3/fixtures.json: STATIC fixtures for evidence v3 and policy type 2
// (shielded/anchor/avf/INSTANCE-BINDING.md), for this repo's verifiers and the verifier session's, which pins them. Run once
// (it needs openssl, for the synthetic CA of test/fixtures/avf-synthetic.mjs); the OUTPUT is what is committed and pinned:
// public certificates, envelopes and signed policies, a fixed `now`, fixed nonces and the expected outcome per case. No
// private key is written anywhere. Replayed by test/pvm-v3-fixtures.test.mjs (node and WebCrypto verifiers, equal outcomes).
//   node test/fixtures/pvm-v3/make-fixtures.mjs [out.json]
import fs from "node:fs";
import path from "node:path";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir, makeCa, issueLeaf, extension, AUTH } from "../avf-synthetic.mjs";
import { bind2, bind3, instanceIdOf, instanceSigMessage, appKeyMessage, appKeyMessageV3, PVM_APP_EVIDENCE_FORMAT_V2, PVM_APP_EVIDENCE_FORMAT_V3 } from "../../../relay/pvm-app-attest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(HERE, "fixtures.json");
const sha = (s) => createHash("sha256").update(s).digest();
const PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
const RID = sha(PIXEL), CODE = sha("pvm-v3 fixture build"), APP = sha("pvm-v3 fixture app").toString("hex"), OTHER_APP = sha("pvm-v3 fixture OTHER app").toString("hex");
const SELFTEST = "exec_pages=refused:EACCES wx=clean maps=1 scope=self";
const NONCE = (i) => sha(`pvm-v3 fixture nonce ${i}`);
const spkiOf = (k) => k.publicKey.export({ type: "spki", format: "der" });

const dir = tmpdir("pvm-v3-fix-"), ca = makeCa(dir);
const now = Date.now();
const vmKeys = () => ({ transport: generateKeyPairSync("ed25519"), appKey: generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex") });
const I1 = generateKeyPairSync("ed25519"), I2 = generateKeyPairSync("ed25519");   // two INSTANCES of the same app
const I1ID = instanceIdOf(spkiOf(I1)).toString("hex"), I2ID = instanceIdOf(spkiOf(I2)).toString("hex");

/** A v3 envelope as the VM makes it, with named deviations for the negative cases. */
function v3({ nonce, instance = I1, vm = vmKeys(), app = APP, challengeBind = "bind3", sigKey = null, instanceKeySpki = null, appKeyMsg = "v3" }) {
  const spki = spkiOf(vm.transport), ispki = instanceKeySpki || spkiOf(instance), iid = instanceIdOf(ispki);
  const bind = challengeBind === "bind2" ? bind2(spki, nonce, RID) : bind3(spki, nonce, RID, iid);
  const challenge = Buffer.concat([bind, Buffer.from(app, "hex")]);
  const leaf = issueLeaf(dir, { ext: extension({ challenge, code: CODE }) });
  return { format: PVM_APP_EVIDENCE_FORMAT_V3, nonce: nonce.toString("hex"), app, spki: spki.toString("hex"), instanceKey: ispki.toString("hex"),
           instanceSig: edSign(null, instanceSigMessage(challenge), (sigKey || instance).privateKey).toString("hex"),
           appKey: vm.appKey, appKeySig: edSign(null, appKeyMsg === "v2" ? appKeyMessage(nonce, app, vm.appKey) : appKeyMessageV3(nonce, app, iid, vm.appKey), vm.transport.privateKey).toString("hex"),
           identity: PIXEL, selftest: SELFTEST, chain: [leaf.leaf, ca.inter, ca.root].map((x) => x.toString("base64")) };
}
function v2({ nonce, vm = vmKeys() }) {
  const spki = spkiOf(vm.transport), challenge = Buffer.concat([bind2(spki, nonce, RID), Buffer.from(APP, "hex")]);
  const leaf = issueLeaf(dir, { ext: extension({ challenge, code: CODE }) });
  return { format: PVM_APP_EVIDENCE_FORMAT_V2, nonce: nonce.toString("hex"), app: APP, spki: spki.toString("hex"), appKey: vm.appKey,
           appKeySig: edSign(null, appKeyMessage(nonce, APP, vm.appKey), vm.transport.privateKey).toString("hex"),
           identity: PIXEL, selftest: SELFTEST, chain: [leaf.leaf, ca.inter, ca.root].map((x) => x.toString("base64")) };
}

const ev = [];
const add = (name, what, envelope, nonce, want, extra = {}) => ev.push({ name, what, envelope, expect: { nonce: nonce.toString("hex"), appId: extra.appId || APP, ...(extra.instanceIds ? { instanceIds: extra.instanceIds } : {}) }, want });
// accepted
add("v3-bound", "v3 from instance I1, the deployment bound to [I1]", v3({ nonce: NONCE(1) }), NONCE(1), { ok: true, instanceId: I1ID }, { instanceIds: [I1ID] });
add("v3-unbound", "v3 with no instance expectation: verifies, and reports the instance it names (bound to nothing)", v3({ nonce: NONCE(2) }), NONCE(2), { ok: true, instanceId: I1ID });
add("v3-restart", "I1 after a RESTART: the same instance key, a new transport key -- still bound", v3({ nonce: NONCE(3) }), NONCE(3), { ok: true, instanceId: I1ID }, { instanceIds: [I1ID] });
add("v2-unbound", "v2 with no instance expectation verifies exactly as before v3", v2({ nonce: NONCE(4) }), NONCE(4), { ok: true, instanceId: null });
// (a) the same app on another instance: refused at the INSTANCE check (every earlier check passes)
add("a-other-instance", "(a) a genuine instance I2 of the SAME app, the deployment bound to [I1]", v3({ nonce: NONCE(5), instance: I2 }), NONCE(5),
    { ok: false, reason: "not one bound to the selected deployment", passedAppKey: true }, { instanceIds: [I1ID] });
// (b) v2 where v3 is expected: a downgrade, by name, before any certificate
add("b-v2-downgrade", "(b) v2 evidence for a deployment bound to instances", v2({ nonce: NONCE(6) }), NONCE(6),
    { ok: false, reason: "refused as a downgrade" }, { instanceIds: [I1ID] });
// (c) v3 fields over the OLD challenge: the certificate binds no instance
add("c-bind2-challenge", "(c) a v3 envelope whose certificate was made over Bind2 (instanceSig consistent with that challenge)", v3({ nonce: NONCE(7), challengeBind: "bind2" }), NONCE(7),
    { ok: false, reason: "attestation:" }, { instanceIds: [I1ID] });
// (d) replay and forgery
const captured = v3({ nonce: NONCE(8) });
add("d-replay-other-nonce", "(d) a captured v3 envelope presented for another nonce", captured, NONCE(9), { ok: false, reason: "answers another nonce" }, { instanceIds: [I1ID] });
add("d-spliced-instance-sig", "(d) a fresh v3 envelope carrying the instanceSig captured from another exchange", { ...v3({ nonce: NONCE(10) }), instanceSig: captured.instanceSig }, NONCE(10),
    { ok: false, reason: "instanceSig is not the instance key's signature" }, { instanceIds: [I1ID] });
{ const vm = vmKeys();
  add("d-sig-by-transport", "(d) instanceSig made by the transport key", v3({ nonce: NONCE(11), vm, sigKey: vm.transport }), NONCE(11),
      { ok: false, reason: "instanceSig is not the instance key's signature" }, { instanceIds: [I1ID] });
  add("instance-key-is-spki", "instanceKey equal to the transport SPKI", v3({ nonce: NONCE(12), vm, instanceKeySpki: spkiOf(vm.transport), sigKey: vm.transport }), NONCE(12),
      { ok: false, reason: "instance key is its transport key" }); }
add("relabelled-v2", "a v3 envelope relabelled v2 (its v3 fields left in)", { ...v3({ nonce: NONCE(13) }), format: PVM_APP_EVIDENCE_FORMAT_V2 }, NONCE(13), { ok: false, reason: "the evidence fields must be exactly" });
add("appkey-v2-message", "v3 whose appKeySig signs the v2 message (no InstanceID)", v3({ nonce: NONCE(14), appKeyMsg: "v2" }), NONCE(14), { ok: false, reason: "appKey is not signed" });
add("extra-field", "v3 with an unknown extra field", { ...v3({ nonce: NONCE(15) }), instance: I1ID }, NONCE(15), { ok: false, reason: "the evidence fields must be exactly" });
add("other-app", "v3 for ANOTHER app, verified with the expected app (enrollment's rule: the entry's app)", v3({ nonce: NONCE(16), app: OTHER_APP }), NONCE(16), { ok: false, reason: "names another app" });
add("empty-instance-list", "an empty instanceIds expectation fails closed", v3({ nonce: NONCE(17) }), NONCE(17), { ok: false, reason: "not a non-empty list" }, { instanceIds: [] });

// ---- policy type 2 (client/src/trust.js verifyPolicy; the verifier session's verifier/pvm-policy.mjs) ----
const P = generateKeyPairSync("ed25519"), pub = P.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const D1 = "0x" + "d1".repeat(32), D2 = "0x" + "d2".repeat(32);
const I3 = sha("pvm-v3 fixture instance 3").toString("hex");
function policy(serial, over) {
  const t = JSON.stringify({ type: "enclave-pvm-client-policy/2", key: pub, serial, notBefore: iso(now - 3600e3), notAfter: iso(now + 30 * 86400e3), codeHashes: [CODE.toString("hex")],
    authorityHashes: [AUTH.toString("hex")], runtimeIds: [RID.toString("hex")], appIds: [APP], googleRootPins: ["6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"],
    formats: ["enclave-pvm-app-evidence/v3", "enclave-pvm-app-evidence/v2"], sealedModes: ["chunked", "whole"], sealedWindow: { seconds: 600, maxRequests: 256 },
    minClientVersion: "0.5.0", nextPolicyKey: null, deployments: [{ id: D1, app: APP, instances: [I1ID] }, { id: D2, app: APP }], ...over });
  return { policy: Buffer.from(t).toString("base64"), sig: edSign(null, Buffer.concat([Buffer.from("enclave-pvm-client-policy-v1\n"), Buffer.from(t)]), P.privateKey).toString("hex") };
}
const pol = [];
const padd = (name, what, envelope, want) => pol.push({ name, what, envelope, want });
padd("type2-bound", "type 2: D1 bound to [I1], D2 unbound", policy(1, {}), { ok: true, instances: { [D1]: [I1ID], [D2]: null } });
padd("type1-with-instances", "type 1 carrying instances: refused by name, never read as unbound", policy(1, { type: "enclave-pvm-client-policy" }), { ok: false, reason: "only a enclave-pvm-client-policy/2 policy may" });
padd("duplicate-instance", "one InstanceID bound to two deployments", policy(1, { deployments: [{ id: D1, app: APP, instances: [I1ID] }, { id: D2, app: APP, instances: [I3, I1ID] }] }), { ok: false, reason: "bound to two deployments" });
padd("instances-without-v3", "instances with formats that do not allow v3", policy(1, { formats: ["enclave-pvm-app-evidence/v2"] }), { ok: false, reason: "does not allow enclave-pvm-app-evidence/v3" });
padd("empty-instances", "an empty instances list", policy(1, { deployments: [{ id: D1, app: APP, instances: [] }] }), { ok: false, reason: "instances must be 1..8" });
padd("nine-instances", "nine instances (the cap is 8)", policy(1, { deployments: [{ id: D1, app: APP, instances: Array.from({ length: 9 }, (_, i) => sha(`i${i}`).toString("hex")) }] }), { ok: false, reason: "instances must be 1..8" });
padd("uppercase-instance", "an InstanceID not in lowercase hex", policy(1, { deployments: [{ id: D1, app: APP, instances: [I1ID.toUpperCase()] }] }), { ok: false, reason: "instances must be 1..8" });

const fixtures = {
  type: "enclave-pvm-v3-fixtures/1", generatedBy: "test/fixtures/pvm-v3/make-fixtures.mjs", spec: "shielded/anchor/avf/INSTANCE-BINDING.md",
  note: "SYNTHETIC: a test CA, not Google's; the device capture is separate. Verify with rootPins [rootPin] and now.",
  now, rootPin: ca.rootPin, pins: { allowedRuntimeIds: [RID.toString("hex")], allowedCodeHashes: [CODE.toString("hex")], allowedAuthorityHashes: [AUTH.toString("hex")] },
  instances: { I1: I1ID, I2: I2ID }, app: APP, evidence: ev,
  policyAnchor: { policyKeyFp: createHash("sha256").update(Buffer.from(pub, "hex")).digest("hex"), serialFloor: 1, releaseKeyFp: sha("pvm-v3 fixture release key").toString("hex") },
  policyNow: now, policy: pol,
};
fs.writeFileSync(OUT, JSON.stringify(fixtures, null, 1) + "\n");
fs.rmSync(dir, { recursive: true, force: true });
console.log(`wrote ${OUT}: ${ev.length} evidence cases, ${pol.length} policy cases`);
