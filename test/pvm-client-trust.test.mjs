// shielded/anchor/avf/client/src/trust.js: what the installed pVM client accepts from carriers it does not trust
// (client/DESIGN.md, agreed with the Enclave verifier session). Policies and update manifests are signed over their exact
// bytes, under the keys anchored at install; every attack below must be refused with nothing adopted.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import * as T from "../shielded/anchor/avf/client/src/trust.js";
import { verifyPvmAppEvidence } from "../shielded/anchor/avf/web/pvm-verify.js";

const raw = (kp) => kp.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");
const fp = (hex) => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
const key = () => { const k = generateKeyPairSync("ed25519"); return { k, pub: raw(k), fp: fp(raw(k)) }; };
const b64 = (s) => Buffer.from(s).toString("base64");
const sig = (text, domain, k) => edSign(null, Buffer.concat([Buffer.from(domain), Buffer.from(text)]), k.k.privateKey).toString("hex");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const NOW = Date.parse("2026-09-24T12:00:00Z");
const PIXEL_RID = createHash("sha256").update('{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}').digest("hex");
const policyBody = (k, over = {}) => ({ type: "enclave-pvm-client-policy", key: k.pub, serial: 5, notBefore: iso(NOW - 3600e3), notAfter: iso(NOW + 86400e3),
  codeHashes: ["6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990"], authorityHashes: ["cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f"], // gitleaks:allow -- public: sha512 of the TEST signing certificate
  runtimeIds: [PIXEL_RID], appIds: ["1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339"],
  googleRootPins: ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"],
  formats: ["enclave-pvm-app-evidence/v2"], sealedModes: ["chunked", "whole"], sealedWindow: { seconds: 600, maxRequests: 256 },
  minClientVersion: "0.1.0", nextPolicyKey: null, ...over });
const signPolicy = (body, k, text = JSON.stringify(body)) => ({ policy: b64(text), sig: sig(text, T.POLICY_DOMAIN, k) });

test("policy: the anchored key's signed policy is accepted; every substitution, rollback and malformation is refused", async () => {
  const P = key(), R = key(), X = key();
  const state = T.initialState({ policyKeyFp: P.fp, serialFloor: 5, releaseKeyFp: R.fp });
  const good = signPolicy(policyBody(P), P);
  const ok = await T.verifyPolicy(good, { state, now: NOW });
  assert.equal(ok.ok, true, ok.reasons.join()); assert.equal(ok.state.serial, 5); assert.deepEqual(ok.pins.allowedRuntimeIds, [PIXEL_RID]);
  const refused = async (env, re, st = state, now = NOW) => { const r = await T.verifyPolicy(env, { state: st, now }); assert.equal(r.ok, false, `accepted: ${re}`); assert.match(r.reasons[0], re); assert.equal(r.pins, null); assert.deepEqual(r.state, st, "nothing adopted"); };
  // who signed: an unanchored key, the anchored key's body signed by another key, a relay's policy adding an evil build
  await refused(signPolicy(policyBody(X), X), /anchor does not name/);
  await refused(signPolicy(policyBody(P), X), /does not verify/);
  await refused(signPolicy(policyBody(X, { codeHashes: ["ee".repeat(32)] }), X), /anchor does not name/);
  const otherAnchor = T.initialState({ policyKeyFp: X.fp, serialFloor: 1, releaseKeyFp: R.fp });   // the right key's policy, given to a client anchored elsewhere
  await refused(good, /anchor does not name/, otherAnchor);
  // the exact bytes: a flipped byte, a re-encoding, padding, a duplicate key, non-canonical base64
  const text = JSON.stringify(policyBody(P));
  await refused({ policy: b64(text.replace('"serial":5', '"serial":6')), sig: good.sig }, /does not verify/);
  await refused(signPolicy(null, P, text.replace(",", ", ")), /strict JSON/);
  await refused(signPolicy(null, P, text.replace('"serial":5', '"serial":5,"serial":9')), /strict JSON/);
  await refused({ policy: good.policy.replace(/=*$/, "") + "A", sig: good.sig }, /base64|UTF-8 JSON/);
  await refused({ policy: good.policy + "\n", sig: good.sig }, /base64/);
  await refused({ ...good, extra: 1 }, /exactly \{ policy, sig \}/);
  await refused({ policy: good.policy, sig: "00".repeat(64) }, /does not verify/);
  // the shape and every list: extra, missing, empty (never "all"), widened roots, unknown formats and modes
  await refused(signPolicy(policyBody(P, { note: "x" }), P), /fields must be exactly/);
  const { sealedWindow: _w, ...noWindow } = policyBody(P);
  await refused(signPolicy(noWindow, P), /fields must be exactly/);
  for (const k of ["codeHashes", "authorityHashes", "runtimeIds", "appIds"]) await refused(signPolicy(policyBody(P, { [k]: [] }), P), /non-empty/);
  await refused(signPolicy(policyBody(P, { googleRootPins: [] }), P), /only narrow/);
  await refused(signPolicy(policyBody(P, { googleRootPins: ["ab".repeat(32)] }), P), /only narrow/);
  await refused(signPolicy(policyBody(P, { formats: ["enclave-pvm-app-evidence/v4"] }), P), /formats/);
  await refused(signPolicy(policyBody(P, { sealedModes: ["plaintext"] }), P), /modes/);
  await refused(signPolicy(policyBody(P, { sealedWindow: { seconds: 600 } }), P), /sealedWindow/);
  // time: expired, not yet valid (the client's clock; no stale fallback)
  await refused(good, /expired/, state, NOW + 2 * 86400e3);
  await refused(good, /not valid before/, state, NOW - 7200e3);
  // serial: below the install floor (a fresh install fed an old policy), a rollback after a newer one, equivocation
  await refused(signPolicy(policyBody(P, { serial: 4 }), P), /rollback/);
  const newer = await T.verifyPolicy(signPolicy(policyBody(P, { serial: 7 }), P), { state, now: NOW });
  assert.equal(newer.ok, true);
  await refused(good, /rollback/, newer.state);
  await refused(signPolicy(policyBody(P, { serial: 7, appIds: ["ab".repeat(32)] }), P), /equivocation/, newer.state);
  assert.equal((await T.verifyPolicy(signPolicy(policyBody(P, { serial: 7 }), P), { state: newer.state, now: NOW })).ok, true, "the same policy again is fine");
  // a minimum version above this client disables it
  await refused(signPolicy(policyBody(P, { minClientVersion: "9.0.0" }), P), /disabled until updated/);
});

test("policy key rotation happens only by a signed nextPolicyKey", async () => {
  const A = key(), B = key(), C = key(), R = key();
  const s0 = T.initialState({ policyKeyFp: A.fp, serialFloor: 1, releaseKeyFp: R.fp });
  assert.equal((await T.verifyPolicy(signPolicy(policyBody(B, { serial: 2 }), B), { state: s0, now: NOW })).ok, false, "B before A named it");
  const r1 = await T.verifyPolicy(signPolicy(policyBody(A, { serial: 2, nextPolicyKey: B.pub }), A), { state: s0, now: NOW });
  assert.equal(r1.ok, true); assert.equal(r1.state.nextPolicyFp, B.fp);
  const r2 = await T.verifyPolicy(signPolicy(policyBody(B, { serial: 3 }), B), { state: r1.state, now: NOW });
  assert.equal(r2.ok, true, r2.reasons.join()); assert.equal(r2.state.policyFp, B.fp); assert.equal(r2.state.nextPolicyFp, null);
  assert.match((await T.verifyPolicy(signPolicy(policyBody(A, { serial: 4 }), A), { state: r2.state, now: NOW })).reasons[0], /anchor does not name/, "the old key is retired");
  assert.match((await T.verifyPolicy(signPolicy(policyBody(C, { serial: 4 }), C), { state: r2.state, now: NOW })).reasons[0], /anchor does not name/);
  assert.throws(() => T.initialState({ policyKeyFp: A.fp, serialFloor: 1, releaseKeyFp: A.fp }), /distinct/);
  assert.throws(() => T.initialState({ policyKeyFp: A.fp, serialFloor: 0, releaseKeyFp: R.fp }), /floor/);
});

test("a policy that narrows the roots to one the device does not chain to: accepted as a policy, the device's evidence refused", async () => {
  const P = key(), R = key();
  const state = T.initialState({ policyKeyFp: P.fp, serialFloor: 1, releaseKeyFp: R.fp });
  const env = JSON.parse(fs.readFileSync(new URL("../shielded/anchor/avf/results/pvm-cpu-browser-channel/l1-evidence.json", import.meta.url)));
  const at = Date.parse("2026-09-24T07:26:36Z");
  const pol = (roots) => signPolicy(policyBody(P, { serial: 1, notBefore: iso(at - 3600e3), notAfter: iso(at + 3600e3), googleRootPins: roots }), P);
  const wide = await T.verifyPolicy(pol(["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"]), { state, now: at });
  assert.equal(wide.ok, true);
  const v1 = await verifyPvmAppEvidence(env, { nonce: env.nonce, appId: env.app, ...wide.pins, now: at });
  assert.equal(v1.ok, true, v1.reasons.join(" | "));
  const narrow = await T.verifyPolicy(pol(["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc"]), { state: wide.state, now: at });
  assert.equal(narrow.ok, false, "same serial, other content");   // a narrowing is a new policy: it needs a new serial
  const narrow2 = await T.verifyPolicy(signPolicy(policyBody(P, { serial: 2, notBefore: iso(at - 3600e3), notAfter: iso(at + 3600e3), googleRootPins: ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc"] }), P), { state: wide.state, now: at });
  assert.equal(narrow2.ok, true);
  const v2 = await verifyPvmAppEvidence(env, { nonce: env.nonce, appId: env.app, ...narrow2.pins, now: at });
  assert.equal(v2.ok, false); assert.match(v2.reasons.at(-1), /not a pinned Google attestation root/, "refused at verify time, never widened back");
});

// ---- updates: both keys, the exact bytes, the version inside the artifact ----
const artifact = (version, extra = "") => new TextEncoder().encode(`${T.VERSION_MARKER}${version} (LAB) */\nexport const x = 1;${extra}\n`);
const manifestBody = (R, P, bytes, over = {}) => ({ type: "enclave-pvm-client-update", artifact: "pvm-client.mjs", version: "0.2.0",
  artifactSha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, sourceCommit: "ab".repeat(20), notAfter: iso(NOW + 86400e3),
  releaseKey: R.pub, policyKey: P.pub, nextReleaseKey: null, ...over });
const signUpdate = (body, R, P, text = JSON.stringify(body)) => ({ manifest: b64(text), releaseSig: sig(text, T.UPDATE_DOMAIN, R), policySig: sig(text, T.UPDATE_COUNTERSIGN_DOMAIN, P) });

test("update: a release-signed, policy-countersigned manifest and its exact bytes install; every malicious delivery is refused", async () => {
  const P = key(), R = key(), X = key();
  const state = T.initialState({ policyKeyFp: P.fp, serialFloor: 1, releaseKeyFp: R.fp });
  const bytes = artifact("0.2.0");
  const env = signUpdate(manifestBody(R, P, bytes), R, P);
  const ok = await T.verifyUpdate(env, bytes, { state, now: NOW, currentVersion: "0.1.0", artifact: "pvm-client.mjs" });
  assert.equal(ok.ok, true, ok.reasons.join()); assert.equal(ok.manifest.version, "0.2.0");
  const refused = async (e, b, re, opts = {}) => { const r = await T.verifyUpdate(e, b, { state, now: NOW, currentVersion: "0.1.0", artifact: "pvm-client.mjs", ...opts }); assert.equal(r.ok, false, `accepted: ${re}`); assert.match(r.reasons[0], re); assert.deepEqual(r.state, opts.state || state); };
  // the bytes: tampered, truncated, another artifact's
  await refused(env, artifact("0.2.0", "evil()"), /is \d+ bytes|not the signed artifact/);
  const t = bytes.slice(); t[t.length - 2] ^= 1;
  await refused(env, t, /not the signed artifact/);
  await refused(env, bytes.subarray(0, bytes.length - 1), /bytes; the signed manifest says/);
  // the keys: one key alone cannot ship code; an attacker's release key; an attacker's countersign
  await refused({ ...env, policySig: sig(JSON.stringify(manifestBody(R, P, bytes)), T.UPDATE_COUNTERSIGN_DOMAIN, X) }, bytes, /countersignature does not verify/);
  await refused(signUpdate(manifestBody(X, P, bytes), X, P), bytes, /release key this client's anchor does not name/);
  await refused(signUpdate(manifestBody(R, X, bytes), R, X), bytes, /policy key this client's anchor does not name/);
  await refused({ ...env, releaseSig: sig(JSON.stringify(manifestBody(R, P, bytes)), T.UPDATE_COUNTERSIGN_DOMAIN, R) }, bytes, /release signature does not verify/); // a signature from the wrong domain
  // versions: a downgrade, a replay of the running version, the right bytes under the wrong version
  const old = artifact("0.0.9");
  await refused(signUpdate(manifestBody(R, P, old, { version: "0.0.9" }), R, P), old, /downgrade or a replay/);
  await refused(env, bytes, /downgrade or a replay/, { currentVersion: "0.2.0" });
  const renamed = artifact("0.1.5");
  await refused(signUpdate(manifestBody(R, P, renamed, { version: "0.2.0" }), R, P), renamed, /own version line is not 0\.2\.0/);
  // time, artifact name, shape, exact bytes
  await refused(env, bytes, /expired/, { now: NOW + 2 * 86400e3 });
  await refused(signUpdate(manifestBody(R, P, bytes, { artifact: "pvm-client-ext.zip" }), R, P), bytes, /is for "pvm-client-ext.zip"/);
  await refused(signUpdate({ ...manifestBody(R, P, bytes), note: 1 }, R, P), bytes, /fields must be exactly/);
  const mtext = JSON.stringify(manifestBody(R, P, bytes));
  await refused({ ...env, manifest: b64(mtext.replace('"0.2.0"', '"9.9.9"')) }, bytes, /does not verify/);
  // release key rotation only by a signed nextReleaseKey
  const R2 = key();
  const rot = await T.verifyUpdate(signUpdate(manifestBody(R, P, bytes, { nextReleaseKey: R2.pub }), R, P), bytes, { state, now: NOW, currentVersion: "0.1.0" });
  assert.equal(rot.ok, true); assert.equal(rot.state.nextReleaseFp, R2.fp);
  const b3 = artifact("0.3.0");
  assert.equal((await T.verifyUpdate(signUpdate(manifestBody(R2, P, b3, { version: "0.3.0" }), R2, P), b3, { state, now: NOW, currentVersion: "0.2.0" })).ok, false, "R2 before R named it");
  assert.equal((await T.verifyUpdate(signUpdate(manifestBody(R2, P, b3, { version: "0.3.0" }), R2, P), b3, { state: rot.state, now: NOW, currentVersion: "0.2.0" })).ok, true);
});
