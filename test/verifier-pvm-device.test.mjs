// REAL device evidence (test/fixtures/verifier/pvm-evidence/SOURCE.md): two enclave-pvm-app-evidence/v1 envelopes a Pixel 10
// pVM answered to a client's nonce, judged through the consumer adapter by the pVM owner's own verifyPvmAppEvidence with
// pins the CLIENT holds (app id, APK code hash, APK signing authority, the runtime identity's id, Google's roots), then
// through the admission gate. Forgeries are built from the real envelopes: a foreign nonce, the other boot's key, the
// other boot's chain, a wrong app, a wrong runtime, an expired leaf, stripped and extra fields. Skips where the owner's
// module (relay/pvm-app-attest.mjs, branch pvm-cpu/portable-runtime) is not in the tree; it is never restated here.
//   run: node --test test/verifier-pvm-device.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { verifyPvmEvidence, loadOwnerModule, STRICT_INTEGRATION, admit, createNonceRegistry, RELEASE, HOLD } from "../verifier/index.mjs";

// the owner's module: ENCLAVE_PVM_MODULE (resolved from the pinned commit by verifier/integration/resolve.mjs) or the
// tree's relay/pvm-app-attest.mjs; absent -> these cases SKIP, unless ENCLAVE_STRICT_INTEGRATION=1, where loadOwnerModule throws
const ownerMod = await loadOwnerModule();
const owner = ownerMod ? ownerMod.verifyPvmAppEvidence : null;
const skip = !owner && !STRICT_INTEGRATION && "owner module absent (set ENCLAVE_PVM_MODULE via verifier/integration/resolve.mjs)";
const F = new URL("./fixtures/verifier/pvm-evidence/", import.meta.url);
const l1 = JSON.parse(fs.readFileSync(new URL("l1-evidence.json", F), "utf8")), l2 = JSON.parse(fs.readFileSync(new URL("l2-evidence.json", F), "utf8"));
const v2 = JSON.parse(fs.readFileSync(new URL("l1-v2-evidence.json", F), "utf8"));
const V2_FORMAT = "enclave-pvm-app-evidence/v2", V1_FORMAT = "enclave-pvm-app-evidence/v1", CODE_V2 = "6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990", NOW_V2 = Date.parse("2026-09-24T07:26:36Z");
const NOW = Date.parse("2026-09-24T06:52:00Z");
// the CLIENT's own pins (SOURCE.md): none of these is read from an envelope
const APP = Buffer.from("1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339", "hex");
const CODE = "e308895a8cc312c47824e974f256402d4d2aa678807de7b5adbab228deabe371";
const AUTH = "cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f";   // gitleaks:allow -- public, not a secret: sha512 of the TEST APK signing certificate (pins.py), present in every attestation chain
const ROOTS = ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"];
const IDENTITY = { name: "wasmtime", version: "49.0.0", execution: "interpreter", targetIsa: "pulley64", hostIsa: "aarch64", cpuFeatures: "baseline", wx: "enforced", cache: "none" };
const RID = ownerMod ? ownerMod.runtimeId(IDENTITY).toString("hex") : null;   // the client's expected runtime, from the identity it expects
const expectFor = (env, over = {}) => ({ nonce: Buffer.from(env.nonce, "hex"), appId: APP, allowedRuntimeIds: [RID], allowedCodeHashes: [CODE], allowedAuthorityHashes: [AUTH], rootPins: ROOTS, ...over });
const run = (env, expect = expectFor(env), now = NOW) => verifyPvmEvidence(env, expect, { now });
const refused = async (env, expect, re, now = NOW) => { const v = await run(env, expect, now); assert.equal(v.status, "rejected", v.reasons.join("\n")); assert.match(v.reasons.join("\n"), re); };

test("the client's expected runtime id is the known identity's RuntimeID", { skip }, () => {
  assert.equal(RID, "d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba");
});
test("both boots verify with the client's pins, and a native client releases only on that boot's transport key", { skip }, async () => {
  for (const [name, env] of [["l1", l1], ["l2", l2]]) {
    const v = await run(env);
    assert.equal(v.status, "verified", `${name}: ${v.reasons.join("\n")}`); assert.equal(v.admissionSafe, true); assert.deepEqual(v.omissions, []);
    assert.equal(v.claims.runtimeId, RID); assert.equal(v.claims.appId, APP.toString("hex")); assert.equal(v.claims.transportSpki, env.spki); assert.equal(v.claims.measurement, CODE);
    const g = admit(v, expectFor(env), { clientKind: "native", observedPeerSpki: Buffer.from(env.spki, "hex") });
    assert.equal(g.decision, RELEASE, `${name}: ${g.reasons.join("\n")}`);
    const other = name === "l1" ? l2 : l1;
    const wrongPeer = admit(v, expectFor(env), { clientKind: "native", observedPeerSpki: Buffer.from(other.spki, "hex") });
    assert.equal(wrongPeer.decision, HOLD); assert.match(wrongPeer.reasons.at(-1), /not the key the evidence binds/);
    // v1 carries no application-layer key: a browser client holds on real evidence too
    assert.equal(admit(v, expectFor(env), { clientKind: "browser" }).decision, HOLD);
  }
  assert.notEqual(l1.spki, l2.spki, "a new boot has a new transport key");
});
test("replay: launch 1's evidence against launch 2's nonce, and the same nonce twice", { skip }, async () => {
  await refused(l1, expectFor(l2), /echoed nonce is not this client's challenge/);
  const relabelled = { ...l1, nonce: l2.nonce };            // the relay pastes our nonce onto old evidence
  await refused(relabelled, expectFor(l2), /attestationChallenge does not match|challenge/);
  const reg = createNonceRegistry(); const v = await run(l1);
  assert.equal(admit(v, expectFor(l1), { clientKind: "native", observedPeerSpki: Buffer.from(l1.spki, "hex"), nonceRegistry: reg }).decision, RELEASE);
  assert.equal(admit(v, expectFor(l1), { clientKind: "native", observedPeerSpki: Buffer.from(l1.spki, "hex"), nonceRegistry: reg }).decision, HOLD);
});
test("hostile relay: the other boot's key or chain under this boot's echo, a fresh nonce over a genuine chain", { skip }, async () => {
  await refused({ ...l1, spki: l2.spki }, expectFor(l1), /attestationChallenge does not match|challenge/);           // swap-key
  await refused({ ...l1, chain: l2.chain }, expectFor(l1), /attestationChallenge does not match|challenge/);         // foreign chain
  const fresh = randomBytes(32);
  await refused({ ...l1, nonce: fresh.toString("hex") }, expectFor(l1, { nonce: fresh }), /attestationChallenge does not match|challenge/);
});
test("wrong app, wrong runtime, wrong code hash, wrong authority, wrong root pins: each refused on its own", { skip }, async () => {
  const otherApp = Buffer.from(APP); otherApp[0] ^= 1;
  await refused(l1, expectFor(l1, { appId: otherApp }), /echoed app id is not the app this client expects/);
  await refused({ ...l1, app: otherApp.toString("hex") }, expectFor(l1, { appId: otherApp }), /attestationChallenge does not match|challenge|names another app/);
  await refused(l1, expectFor(l1, { allowedRuntimeIds: ["a".repeat(64)] }), /not an admitted runtime/);
  await refused(l1, expectFor(l1, { allowedCodeHashes: ["0".repeat(64)] }), /code|component|unpinned/i);
  await refused(l1, expectFor(l1, { allowedAuthorityHashes: ["0".repeat(128)] }), /authority/i);
  await refused(l1, expectFor(l1, { rootPins: ["0".repeat(64)] }), /not a pinned Google attestation root/);
  for (const k of ["allowedRuntimeIds", "allowedCodeHashes", "allowedAuthorityHashes", "rootPins"]) await refused(l1, expectFor(l1, { [k]: [] }), new RegExp(`no ${k}`));
});
test("the RKP leaf is short-lived: a clock a month later, or before issuance, refuses", { skip }, async () => {
  await refused(l1, expectFor(l1), /expired/, Date.parse("2026-10-24T06:52:00Z"));
  await refused(l1, expectFor(l1), /not yet valid/, Date.parse("2026-09-01T00:00:00Z"));
});
test("malformed real envelopes: a stripped field, an extra field, a non-canonical chain entry, another format", { skip }, async () => {
  const { selftest, ...stripped } = l1; await refused(stripped, expectFor(l1), /fields must be exactly|verifier refused/);
  await refused({ ...l1, extra: 1 }, expectFor(l1), /fields must be exactly|verifier refused/);
  await refused({ ...l1, chain: [l1.chain[0] + "=", ...l1.chain.slice(1)] }, expectFor(l1), /canonical base64|verifier refused/);
  await refused({ ...l1, format: "enclave-pvm-app-evidence/v0" }, expectFor(l1), /is not one of/);
  await refused({ ...l1, identity: l1.identity.replace('"version":"49.0.0"', '"version":"49.0.1"') }, expectFor(l1), /not an admitted runtime|challenge/);
});

// ---- v2: the browser channel, on the real envelope ------------------------------------------------------------------
const expectV2 = (over = {}) => expectFor(v2, { allowedCodeHashes: [CODE_V2], ...over });
test("v2 real envelope: verifies; a browser client releases on the signed app key with the sealed window; a native client on the transport key", { skip }, async () => {
  const r = await run(v2, expectV2(), NOW_V2);
  assert.equal(r.status, "verified", r.reasons.join("\n")); assert.equal(r.claims.format, V2_FORMAT); assert.equal(r.claims.appKey, v2.appKey);
  assert.deepEqual(r.claims.sealed, { windowSeconds: 600, maxRequests: 256 }); assert.equal(r.claims.measurement, CODE_V2);
  const b = admit(r, expectV2(), { clientKind: "browser" });
  assert.equal(b.decision, RELEASE, b.reasons.join("\n")); assert.equal(b.pinned.appKey, v2.appKey); assert.deepEqual(b.pinned.sealed, { windowSeconds: 600, maxRequests: 256 }); assert.equal(b.pinned.transportSpkiSha256, undefined);
  assert.match(b.reasons.join("\n"), /TLS certificate pinning is NOT claimed/);
  const n = admit(r, expectV2(), { clientKind: "native", observedPeerSpki: Buffer.from(v2.spki, "hex") }); assert.equal(n.decision, RELEASE, n.reasons.join("\n"));
  assert.equal(admit(r, expectV2(), { clientKind: "native", observedPeerSpki: Buffer.from(l1.spki, "hex") }).decision, HOLD);
});
test("v2 downgrade: stripping both fields and relabelling v1 verifies as v1 with no app key; a browser client holds, and a client that requires v2 refuses it as a downgrade", { skip }, async () => {
  const { appKey, appKeySig, ...rest } = v2; const downgraded = { ...rest, format: V1_FORMAT };
  const d = await run(downgraded, expectV2(), NOW_V2);
  assert.equal(d.status, "verified", d.reasons.join("\n")); assert.equal(d.claims.appKey, null); assert.equal(d.claims.sealed, null);
  const b = admit(d, expectV2(), { clientKind: "browser" }); assert.equal(b.decision, HOLD); assert.match(b.reasons.at(-1), /no application-layer public key/);
  assert.equal(admit(d, expectV2(), { clientKind: "native", observedPeerSpki: Buffer.from(v2.spki, "hex") }).decision, RELEASE, "a native client may still pin the transport key on v1");
  await refused(downgraded, expectV2({ formats: [V2_FORMAT] }), /downgrade, refused/, NOW_V2);
  await refused(v2, expectV2({ formats: [V1_FORMAT] }), /downgrade, refused/, NOW_V2);
  await refused(v2, expectV2({ formats: ["enclave-pvm-app-evidence/v9"] }), /only known evidence formats/, NOW_V2);
});
test("v2 forgeries on the real envelope: swapped, half-stripped, grafted or re-signed app key, stale binding, foreign chain, expired leaf", { skip }, async () => {
  await refused({ ...v2, appKey: l1.spki.slice(-64) }, expectV2(), /not signed by the attested transport key|verifier refused/, NOW_V2);          // the relay's own key under the VM's signature
  await refused({ ...v2, appKeySig: undefined }, expectV2(), /must carry appKey|verifier refused/, NOW_V2);                      // half-stripped
  await refused({ ...v2, appKey: undefined }, expectV2(), /must carry appKey|verifier refused/, NOW_V2);
  await refused({ ...l1, appKey: v2.appKey, appKeySig: v2.appKeySig }, expectFor(l1), /v1 evidence must not carry appKey|verifier refused/);          // grafted onto v1
  await refused({ ...v2, format: V1_FORMAT }, expectV2(), /v1 evidence must not carry appKey|verifier refused/, NOW_V2);                        // v2 fields under a v1 label
  const stale = { ...v2, nonce: l1.nonce }; await refused(stale, expectV2({ nonce: Buffer.from(l1.nonce, "hex") }), /attestationChallenge does not match|challenge|verifier refused/, NOW_V2);   // yesterday's key binding under another nonce
  await refused({ ...v2, chain: l1.chain }, expectV2(), /attestationChallenge does not match|challenge|verifier refused/, NOW_V2);
  await refused({ ...v2, spki: l1.spki }, expectV2(), /attestationChallenge does not match|challenge|verifier refused/, NOW_V2);
  await refused(v2, expectV2(), /expired/, Date.parse("2026-10-24T07:26:36Z"));
  await refused(v2, expectV2({ allowedCodeHashes: [CODE] }), /code|component|unpinned/i, NOW_V2);   // the v1 build's hash does not admit the v2 build
});
test("the sealed window is reported only by the verifier, never taken from the envelope", { skip }, async () => {
  const r = await run({ ...v2, sealedWindowSeconds: 1 }, expectV2(), NOW_V2);   // an extra field: closed shape refuses it outright
  assert.equal(r.status, "rejected");
});
