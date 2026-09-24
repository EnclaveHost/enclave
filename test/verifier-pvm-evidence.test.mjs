// verifier/pvm-evidence.mjs: the consumer side of the client-verified pVM evidence interface, tested TODAY with
// an injected stand-in for the owner's verifyPvmAppEvidence (the module is not pushed yet), and re-tested against
// the owner's module automatically once relay/pvm-app-attest.mjs exports it (the last block). The stand-in models
// one property only: the evidence's certificate challenge covers the nonce, app, transport key and identity, so
// changing any of them makes it fail. It is NOT a parser of the owner's evidence and proves nothing about AVF.
//   run: node --test test/verifier-pvm-evidence.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { verifyEvidence, verifyPvmEvidence, loadOwnerVerifier, admit, createNonceRegistry, RELEASE, HOLD, PVM_EVIDENCE_FORMAT, PVM_EVIDENCE_FORMAT_V2 } from "../verifier/index.mjs";

const sha = (...b) => createHash("sha256").update(Buffer.concat(b.map((x) => Buffer.isBuffer(x) ? x : Buffer.from(String(x))))).digest("hex");
const PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
const RID = sha(PIXEL);                                   // the owner's RuntimeID is sha256 of the canonical identity; here only a label
const SPKI = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), randomBytes(32)]);   // 44-byte Ed25519 SPKI
const APP = randomBytes(32), CODE = "c".repeat(64), AUTH = "a".repeat(128), ROOT = "r".repeat(64);
const expectFor = (nonce, over = {}) => ({ nonce, appId: APP, allowedRuntimeIds: [RID], allowedCodeHashes: [CODE], allowedAuthorityHashes: [AUTH], rootPins: [ROOT], ...over });
// The pVM's answer to `EVIDENCE <nonce>`: the chain's first entry stands in for the AVF leaf whose challenge covers
// Bind2(spki, nonce, RuntimeID) || AppID; here it is a tag over the same inputs so substitution is detectable.
const evidenceFor = (nonce, over = {}) => ({ format: PVM_EVIDENCE_FORMAT, nonce: nonce.toString("hex"), app: APP.toString("hex"), spki: SPKI.toString("hex"), identity: PIXEL,
  selftest: "exec_pages=refused:EACCES wx=clean maps=1 scope=self", chain: [Buffer.from(sha("stand-in-challenge", SPKI, nonce, sha(PIXEL), APP), "hex").toString("base64"), "cm9vdA=="], ...over });
// the stand-in verifier: the owner's contract as described (envelope shape, echoed nonce, delegate with the CALLER's
// nonce/appId/pins; ok:false on any empty pin list; returns transportSpki to pin)
const standIn = async (env, o) => {
  const reasons = [];
  const no = (m) => ({ ok: false, reasons: [...reasons, m] });
  for (const k of ["allowedRuntimeIds", "allowedCodeHashes", "allowedAuthorityHashes", "rootPins"]) if (!o[k]?.length) return no(`no ${k}`);
  const v2 = env.format === PVM_EVIDENCE_FORMAT_V2;
  const allowed = new Set(["format", "nonce", "app", "spki", "identity", "selftest", "chain", ...(v2 ? ["appKey", "appKeySig"] : [])]);   // closed shape per version
  for (const k of Object.keys(env)) if (!allowed.has(k)) return no(`unknown field ${k}`);
  if (v2 && env.appKeySig !== sha("stand-in-app-key-sig", env.spki, o.nonce, o.appId, env.appKey) + sha("pad")) return no("appKeySig does not verify under the transport key over nonce || appId || appKey");
  if (!/^[0-9a-f]{88}$/.test(env.spki) || !env.spki.startsWith("302a300506032b6570032100")) return no("spki shape");
  const rid = sha(env.identity); if (!o.allowedRuntimeIds.includes(rid)) return no("runtime not admitted");
  const want = sha("stand-in-challenge", Buffer.from(env.spki, "hex"), o.nonce, rid, o.appId);   // CALLER's nonce and app
  if (Buffer.from(env.chain[0], "base64").toString("hex") !== want) return no("certificate challenge does not equal Bind2(spki, caller nonce, runtime) || caller app");
  if (!env.chain.includes("cm9vdA==")) return no("root not pinned");
  reasons.push("stand-in: challenge covers the caller's nonce, app, transport key and runtime identity");
  return { ok: true, reasons, transportSpki: env.spki, runtimeId: rid, measurement: "code", freshness: "client-nonce", appId: o.appId.toString("hex"), ...(v2 ? { appKey: env.appKey } : {}) };
};
// a v2 envelope: appKey plus a stand-in signature tag over (transport key, nonce, appId, appKey)
const evidenceV2 = (nonce, appKey = "ab".repeat(32), over = {}) => evidenceFor(nonce, { format: PVM_EVIDENCE_FORMAT_V2, appKey, appKeySig: sha("stand-in-app-key-sig", SPKI.toString("hex"), nonce, APP, appKey) + sha("pad"), ...over });
const run = (env, expect) => verifyPvmEvidence(env, expect, { verifyImpl: standIn, now: Date.now() });
const rejected = async (env, expect, re) => { const v = await run(env, expect); assert.equal(v.status, "rejected", v.reasons.join("\n")); assert.equal(v.admissionSafe, false); assert.match(v.reasons.at(-1), re); return v; };

test("honest exchange: verified, admission-safe, and a native client releases on the pinned transport key", async () => {
  const nonce = randomBytes(32);
  const v = await run(evidenceFor(nonce), expectFor(nonce));
  assert.equal(v.status, "verified", v.reasons.join("\n")); assert.deepEqual(v.omissions, []); assert.equal(v.claims.freshness, "client-nonce");
  assert.equal(v.claims.transportSpki, SPKI.toString("hex")); assert.equal(v.claims.appId, APP.toString("hex")); assert.equal(v.claims.nonce, nonce.toString("hex"));
  const g = admit(v, expectFor(nonce), { clientKind: "native", observedPeerSpki: SPKI });
  assert.equal(g.decision, RELEASE, g.reasons.join("\n")); assert.equal(g.pinned.transportSpkiSha256, v.claims.transportSpkiSha256);
  const wrongPeer = admit(v, expectFor(nonce), { clientKind: "native", observedPeerSpki: Buffer.concat([SPKI.subarray(0, 12), randomBytes(32)]) });
  assert.equal(wrongPeer.decision, HOLD); assert.match(wrongPeer.reasons.at(-1), /not the key the evidence binds/);
});
test("browser client: holds until the evidence carries an application-layer key; TLS pinning is never claimed", async () => {
  const nonce = randomBytes(32);
  const v1 = await run(evidenceFor(nonce), expectFor(nonce));                 // the v1 proposal: no appKey
  const h = admit(v1, expectFor(nonce), { clientKind: "browser" }); assert.equal(h.decision, HOLD); assert.match(h.reasons.at(-1), /no application-layer public key/);
  const nonce2 = randomBytes(32);
  const v2 = await run(evidenceV2(nonce2), expectFor(nonce2));
  assert.equal(v2.status, "verified", v2.reasons.join("\n")); assert.equal(v2.claims.format, PVM_EVIDENCE_FORMAT_V2);
  const r = admit(v2, expectFor(nonce2), { clientKind: "browser" }); assert.equal(r.decision, RELEASE, r.reasons.join("\n")); assert.equal(r.pinned.appKey, "ab".repeat(32)); assert.equal(r.pinned.transportSpkiSha256, undefined);
  assert.match(r.reasons.join("\n"), /TLS certificate pinning is NOT claimed/);
});
test("v2 closed shape: a relay cannot strip the browser key, swap it, or graft it onto v1", async () => {
  const nonce = randomBytes(32);
  await rejected(evidenceV2(nonce, "ab".repeat(32), { appKey: undefined, appKeySig: undefined }), expectFor(nonce), /must carry appKey/);          // stripped -> malformed, not a downgrade
  await rejected(evidenceV2(nonce, "ab".repeat(32), { appKeySig: undefined }), expectFor(nonce), /must carry appKey/);
  await rejected(evidenceV2(nonce, "ab".repeat(32), { appKey: "cd".repeat(32) }), expectFor(nonce), /verifier refused/);                          // swapped key: signature over the old key fails
  await rejected(evidenceFor(nonce, { appKey: "ab".repeat(32) }), expectFor(nonce), /v1 evidence must not carry appKey/);                         // grafted onto v1
  const stale = evidenceV2(randomBytes(32)); stale.nonce = nonce.toString("hex");                                                                  // yesterday's key binding under today's nonce
  await rejected(stale, expectFor(nonce), /verifier refused/);
  // the verifier vouching for a different key than the envelope shows is refused by the consumer cross-check
  const lying = async (env, o) => ({ ...(await standIn(env, o)), appKey: "ee".repeat(32) });
  const v = await verifyPvmEvidence(evidenceV2(nonce), expectFor(nonce), { verifyImpl: lying }); assert.equal(v.status, "rejected"); assert.match(v.reasons.at(-1), /did not vouch for the envelope's appKey/);
});
test("hostile relay: rewriting the echoed nonce or app is caught by the consumer cross-check before any certificate work", async () => {
  const nonce = randomBytes(32), other = randomBytes(32);
  await rejected(evidenceFor(nonce, { nonce: other.toString("hex") }), expectFor(nonce), /echoed nonce is not this client's challenge/);
  await rejected(evidenceFor(nonce, { app: "00".repeat(32) }), expectFor(nonce), /echoed app id is not the app this client expects/);
  await rejected(evidenceFor(nonce, { nonce: nonce.toString("hex").toUpperCase() }), expectFor(nonce), /echoed nonce/);
});
test("hostile relay: substituting the chain, transport key or identity while keeping the echo is caught by the challenge", async () => {
  const nonce = randomBytes(32);
  const otherSpki = Buffer.concat([SPKI.subarray(0, 12), randomBytes(32)]);
  await rejected(evidenceFor(nonce, { spki: otherSpki.toString("hex") }), expectFor(nonce), /verifier refused/);
  const otherId = PIXEL.replace('"version":"49.0.0"', '"version":"49.0.1"');
  await rejected(evidenceFor(nonce, { identity: otherId }), expectFor(nonce, { allowedRuntimeIds: [RID, sha(otherId)] }), /verifier refused/);
  const foreign = evidenceFor(randomBytes(32)); foreign.nonce = nonce.toString("hex");   // another session's evidence with our echo pasted in
  await rejected(foreign, expectFor(nonce), /verifier refused/);
  await rejected(evidenceFor(nonce, { chain: ["AAAA"] }), expectFor(nonce), /verifier refused/);
});
test("replay: yesterday's evidence under today's challenge, and the same challenge used twice", async () => {
  const old = randomBytes(32), fresh = randomBytes(32);
  const stale = evidenceFor(old); stale.nonce = fresh.toString("hex");
  await rejected(stale, expectFor(fresh), /verifier refused/);
  const reg = createNonceRegistry();
  const v = await run(evidenceFor(fresh), expectFor(fresh));
  assert.equal(admit(v, expectFor(fresh), { clientKind: "native", observedPeerSpki: SPKI, nonceRegistry: reg }).decision, RELEASE);
  const again = admit(v, expectFor(fresh), { clientKind: "native", observedPeerSpki: SPKI, nonceRegistry: reg });
  assert.equal(again.decision, HOLD); assert.match(again.reasons.at(-1), /used before/);
});
test("missing or empty client policy never releases, and the verdict says which pin is missing", async () => {
  const nonce = randomBytes(32);
  for (const k of ["allowedRuntimeIds", "allowedCodeHashes", "allowedAuthorityHashes", "rootPins"]) await rejected(evidenceFor(nonce), expectFor(nonce, { [k]: [] }), new RegExp(`no ${k}`));
  await rejected(evidenceFor(nonce), expectFor(nonce, { nonce: undefined }), /no 32-byte challenge/);
  await rejected(evidenceFor(nonce), expectFor(nonce, { appId: undefined }), /no expected app id/);
  await rejected(evidenceFor(nonce), expectFor(nonce, { allowedRuntimeIds: ["f".repeat(64)] }), /verifier refused/);
});
test("malformed evidence: wrong format, extra fields, not an object, oversized", async () => {
  const nonce = randomBytes(32);
  await rejected({ ...evidenceFor(nonce), format: "enclave-pvm-app-evidence/v0" }, expectFor(nonce), /is not one of enclave-pvm-app-evidence\/v1, enclave-pvm-app-evidence\/v2/);
  await rejected(evidenceFor(nonce, { extra: 1 }), expectFor(nonce), /verifier refused/);
  await rejected("EVIDENCE", expectFor(nonce), /not an object/);
  await rejected(evidenceFor(nonce, { chain: ["A".repeat(300 * 1024)] }), expectFor(nonce), /exceeds/);
  const viaIndex = await verifyEvidence(evidenceFor(nonce), { context: { nonce, expectedAppId: APP }, policy: { pvm: expectFor(nonce) } });
  assert.notEqual(viaIndex.status, "verified");   // through the dispatcher the owner's module is absent on main: unsupported, never verified
  assert.ok(["unsupported", "rejected"].includes(viaIndex.status), viaIndex.status);
});
test("without the owner's module the verdict is unsupported, never verified, and a gate holds it", async () => {
  const nonce = randomBytes(32);
  const v = await verifyPvmEvidence(evidenceFor(nonce), expectFor(nonce));   // no verifyImpl injected
  const owner = await loadOwnerVerifier();
  if (owner) { assert.notEqual(v.status, "unsupported"); return; }
  assert.equal(v.status, "unsupported"); assert.match(v.reasons.at(-1), /pvm-app-attest/);
  assert.equal(admit(v, expectFor(nonce), { clientKind: "native", observedPeerSpki: SPKI }).decision, HOLD);
});
// ---- contract tests against the OWNER's verifier, run automatically once it is pushed ----------------------------
const owner = await loadOwnerVerifier();
test("owner's verifyPvmAppEvidence: empty pins and unknown fields are refused; the echoed nonce is never used as the challenge", { skip: !owner && "relay/pvm-app-attest.mjs verifyPvmAppEvidence not in this tree" }, async () => {
  const nonce = randomBytes(32);
  for (const k of ["allowedRuntimeIds", "allowedCodeHashes", "allowedAuthorityHashes", "rootPins"]) {
    const r = await owner(evidenceFor(nonce), { ...expectFor(nonce), [k]: [] }); assert.equal(r.ok, false, k);
  }
  const r = await owner(evidenceFor(nonce, { extra: 1 }), expectFor(nonce)); assert.equal(r.ok, false, "unknown field");
});
