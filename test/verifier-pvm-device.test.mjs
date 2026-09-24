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
import { verifyPvmEvidence, loadOwnerVerifier, admit, createNonceRegistry, RELEASE, HOLD } from "../verifier/index.mjs";

const owner = await loadOwnerVerifier();
let ownerMod = null; try { ownerMod = await import("../relay/pvm-app-attest.mjs"); } catch {}
const skip = !owner && "relay/pvm-app-attest.mjs verifyPvmAppEvidence not in this tree";
const F = new URL("./fixtures/verifier/pvm-evidence/", import.meta.url);
const l1 = JSON.parse(fs.readFileSync(new URL("l1-evidence.json", F), "utf8")), l2 = JSON.parse(fs.readFileSync(new URL("l2-evidence.json", F), "utf8"));
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
