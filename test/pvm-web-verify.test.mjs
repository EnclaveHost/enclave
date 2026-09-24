// shielded/anchor/avf/web/pvm-verify.js: the BROWSER's copy of verifyPvmAppEvidence, on WebCrypto alone. Parity with the
// node verifier (relay/pvm-app-attest.mjs) on every case below -- the same verdict, the same key to pin, the same app key,
// and a last reason of the same kind -- including the Pixel 10's real chain (results/pvm-cpu-client-verified) and the
// verifier session's adversarial cases (research/independent-verifier test/verifier-pvm-evidence.test.mjs: echo rewrite,
// chain/key/identity substitution, foreign evidence with our echo, stale binding under a fresh nonce, stripped/grafted/
// swapped appKey, missing pins, malformed envelopes), here over REAL synthetic chains instead of a stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { verifyPvmAppEvidence as nodeVerify, bind2, appKeyMessage, PVM_APP_EVIDENCE_FORMAT, PVM_APP_EVIDENCE_FORMAT_V2 } from "../relay/pvm-app-attest.mjs";
import { GOOGLE_ATTESTATION_ROOT_SHA256 } from "../relay/avf-verify.mjs";
import * as web from "../shielded/anchor/avf/web/pvm-verify.js";
import { haveOpenssl, tmpdir, makeCa, issueLeaf, extension, AUTH } from "./fixtures/avf-synthetic.mjs";

const PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
const PIXEL_RID = createHash("sha256").update(PIXEL).digest("hex");
const TUPLE = "exec_pages=refused:EACCES wx=clean maps=1 scope=self";
const hex = (b) => Buffer.from(b).toString("hex");

// both verifiers on one case: the same ok, key, app key and window; each last reason matches `why` when refused
async function both(env, expect, why) {
  const n = nodeVerify(env, expect), w = await web.verifyPvmAppEvidence(env, expect);
  const tag = `node: ${n.reasons.at(-1)} | web: ${w.reasons.at(-1)}`;
  assert.equal(w.ok, n.ok, `verdicts differ -- ${tag}`);
  for (const k of ["transportSpki", "runtimeId", "measurement", "appKey", "sealedWindowSeconds", "sealedMaxRequests", "freshness"]) assert.equal(w[k], n[k], `${k} differs -- ${tag}`);
  if (why) { assert.equal(n.ok, false, `expected a refusal (${why}) -- ${tag}`); assert.match(n.reasons.at(-1), why, tag); assert.match(w.reasons.at(-1), why, tag); }
  return n;
}

test("the web verifier pins the same Google roots as the relay", () => {
  assert.deepEqual([...web.GOOGLE_ATTESTATION_ROOT_SHA256].sort(), [...GOOGLE_ATTESTATION_ROOT_SHA256.values()].sort());
});

test("parity on the Pixel 10's real evidence (results/pvm-cpu-client-verified l1): accepted by both, refused by both when anything moves", async () => {
  const env = JSON.parse(fs.readFileSync(new URL("../shielded/anchor/avf/results/pvm-cpu-client-verified/l1-evidence.json", import.meta.url)));
  const expect = { nonce: env.nonce, appId: env.app, allowedRuntimeIds: [PIXEL_RID], allowedCodeHashes: ["e308895a8cc312c47824e974f256402d4d2aa678807de7b5adbab228deabe371"],
                   allowedAuthorityHashes: ["cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f"], // gitleaks:allow -- public: sha512 of the TEST signing certificate
                   now: Date.parse("2026-09-24T06:52:05Z") };
  const ok = await both(env, expect);
  assert.equal(ok.ok, true, ok.reasons.join(" | "));
  assert.equal(ok.transportSpki, env.spki);
  await both(env, { ...expect, now: Date.parse("2026-10-24T00:00:00Z") }, /expired/);
  await both(env, { ...expect, nonce: randomBytes(32) }, /another nonce/);
  await both({ ...env, nonce: hex(randomBytes(32)) }, { ...expect, nonce: undefined }, /nonce must be 32 bytes/);
  await both({ ...env, spki: "302a300506032b6570032100" + hex(randomBytes(32)) }, expect, /attestationChallenge/);
  await both(env, { ...expect, allowedCodeHashes: ["00".repeat(32)] }, /allowlisted codeHash/);
  await both(env, { ...expect, allowedAuthorityHashes: ["00".repeat(64)] }, /unpinned authority/);
  await both(env, { ...expect, rootPins: ["00".repeat(32)] }, /not a pinned Google attestation root/);
  // one flipped byte inside the leaf's signed body
  const leaf = Buffer.from(env.chain[0], "base64"); leaf[leaf.length - 120] ^= 1;
  const flipped = await both({ ...env, chain: [leaf.toString("base64"), ...env.chain.slice(1)] }, expect);
  assert.equal(flipped.ok, false);
});

test("parity on the Pixel 10's real v2 evidence (results/pvm-cpu-browser-channel l1): the app key the VM signed, and every way to move it", async () => {
  const env = JSON.parse(fs.readFileSync(new URL("../shielded/anchor/avf/results/pvm-cpu-browser-channel/l1-evidence.json", import.meta.url)));
  assert.equal(env.format, PVM_APP_EVIDENCE_FORMAT_V2);
  const expect = { nonce: env.nonce, appId: env.app, allowedRuntimeIds: [PIXEL_RID], allowedCodeHashes: ["6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990"],
                   allowedAuthorityHashes: ["cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f"], // gitleaks:allow -- public: sha512 of the TEST signing certificate
                   now: Date.parse("2026-09-24T07:26:36Z") };
  const ok = await both(env, expect);
  assert.equal(ok.ok, true, ok.reasons.join(" | "));
  assert.equal(ok.appKey, env.appKey, "the app key the VM made and signed (TweetNaCl Ed25519 in the payload)");
  const other = "11".repeat(32);
  await both({ ...env, appKey: other }, expect, /not signed by the attested transport key/);
  const { appKey: _k, appKeySig: _s, ...v1 } = env;
  const down = await both({ ...v1, format: PVM_APP_EVIDENCE_FORMAT }, expect);   // a downgrade verifies as v1 -- and carries no key to encrypt to
  assert.equal(down.ok, true); assert.equal(down.appKey, null);
  await both(v1, expect, /fields must be exactly/);
  await both({ ...env, nonce: hex(randomBytes(32)) }, { ...expect, nonce: undefined }, /nonce must be 32 bytes/);
  await both(env, { ...expect, nonce: randomBytes(32) }, /another nonce/);
  await both(env, { ...expect, now: Date.parse("2026-10-24T00:00:00Z") }, /expired/);
});

test("parity on synthetic v1/v2 evidence: genuine, and every substitution a relay could make", { skip: !haveOpenssl && "openssl not installed" }, async () => {
  const dir = tmpdir("pvm-web-");
  const ca = makeCa(dir);
  const CODE = createHash("sha256").update("pvm-cpu protected build").digest();
  const APP_ID = createHash("sha256").update("ggml-probe").digest("hex");
  const vm = generateKeyPairSync("ed25519"), relay = generateKeyPairSync("ed25519");
  const vmSpki = vm.publicKey.export({ type: "spki", format: "der" }), relaySpki = relay.publicKey.export({ type: "spki", format: "der" });
  const appKeyOf = () => generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).subarray(12);
  const vmAppKey = appKeyOf(), relayAppKey = appKeyOf();
  // the VM's answer to a nonce: a certificate over Bind2(spki, nonce, RID) || app; v2 adds the app key and its signature
  const answer = ({ nonce, spki = vmSpki, app = APP_ID, identity = PIXEL, code = CODE, v2 = false, appKey = vmAppKey, signer = vm.privateKey, sigNonce = nonce }) => {
    const challenge = Buffer.concat([bind2(spki, nonce, createHash("sha256").update(identity).digest()), Buffer.from(app, "hex")]);
    const leaf = issueLeaf(dir, { ext: extension({ challenge, code }) });
    const env = { format: v2 ? PVM_APP_EVIDENCE_FORMAT_V2 : PVM_APP_EVIDENCE_FORMAT, nonce: hex(nonce), app, spki: hex(spki), identity, selftest: TUPLE,
                  chain: [leaf.leaf, ca.inter, ca.root].map((d) => d.toString("base64")) };
    if (v2) { env.appKey = hex(appKey); env.appKeySig = hex(edSign(null, appKeyMessage(sigNonce, app, hex(appKey)), signer)); }
    return env;
  };
  const pins = (nonce, over = {}) => ({ nonce, appId: APP_ID, allowedRuntimeIds: [PIXEL_RID], allowedCodeHashes: [hex(CODE)],
                                        allowedAuthorityHashes: [hex(AUTH)], rootPins: [ca.rootPin], ...over });
  const n1 = randomBytes(32), n2 = randomBytes(32);
  const g1 = answer({ nonce: n1 }), g2 = answer({ nonce: n1, v2: true });
  const r1 = await both(g1, pins(n1)), r2 = await both(g2, pins(n1));
  assert.equal(r1.ok, true, r1.reasons.join(" | ")); assert.equal(r1.appKey, null);
  assert.equal(r2.ok, true, r2.reasons.join(" | ")); assert.equal(r2.appKey, hex(vmAppKey)); assert.equal(r2.transportSpki, hex(vmSpki));
  assert.equal(r2.sealedWindowSeconds, 600); assert.equal(r2.sealedMaxRequests, 256);

  // echo rewrite: the envelope's nonce/app are compared with the caller's, never used
  await both({ ...g2, nonce: hex(n2) }, pins(n1), /another nonce/);
  await both({ ...g2, app: "00".repeat(32) }, pins(n1), /another app/);
  await both({ ...g2, nonce: g2.nonce.toUpperCase() }, pins(n1), /64 lowercase hex/);
  // substitution with the echo kept: another transport key, another identity (both runtimes pinned), another session's evidence
  await both({ ...g2, spki: hex(relaySpki) }, pins(n1), /attestationChallenge/);
  const otherId = PIXEL.replace('"version":"49.0.0"', '"version":"49.0.1"');
  await both({ ...g2, identity: otherId }, pins(n1, { allowedRuntimeIds: [PIXEL_RID, createHash("sha256").update(otherId).digest("hex")] }), /attestationChallenge/);
  await both({ ...answer({ nonce: n2, v2: true }), nonce: hex(n1) }, pins(n1), /attestationChallenge/);
  await both({ ...g2, chain: ["AAAA"] }, pins(n1), /2\.\.8 certificates/);
  await both({ ...g2, chain: [g2.chain[0] + "AA", ...g2.chain.slice(1)] }, pins(n1), /canonical base64/);
  await both({ ...g2, chain: ["A".repeat(300 * 1024), ...g2.chain.slice(1)] }, pins(n1), /canonical base64/);
  // a relay's own everything: its own CA (a pinned root is the caller's), its own key under the pinned code hash
  const forged = answer({ nonce: n1, spki: relaySpki, v2: true, appKey: relayAppKey, signer: relay.privateKey });
  await both(forged, pins(n1, { rootPins: undefined }), /not a pinned Google attestation root/);
  await both(answer({ nonce: n1, spki: relaySpki, code: createHash("sha256").update("not our build").digest() }), pins(n1), /allowlisted codeHash/);
  // the app key: stripped, half-stripped, swapped, re-signed by the relay, grafted onto v1, a stale binding under a fresh nonce
  const { appKey: _k, appKeySig: _s, ...stripped } = g2;
  await both(stripped, pins(n1), /fields must be exactly/);
  const { appKeySig: _s2, ...halfStripped } = g2;
  await both(halfStripped, pins(n1), /fields must be exactly/);
  await both({ ...g2, appKey: hex(relayAppKey) }, pins(n1), /not signed by the attested transport key/);
  await both({ ...g2, appKey: hex(relayAppKey), appKeySig: hex(edSign(null, appKeyMessage(n1, APP_ID, hex(relayAppKey)), relay.privateKey)) }, pins(n1), /not signed by the attested transport key/);
  await both({ ...g1, appKey: g2.appKey }, pins(n1), /fields must be exactly/);
  await both({ ...g1, format: PVM_APP_EVIDENCE_FORMAT_V2 }, pins(n1), /fields must be exactly/);
  const fresh = answer({ nonce: n2, v2: true });
  await both({ ...fresh, appKey: g2.appKey, appKeySig: g2.appKeySig }, pins(n2), /not signed by the attested transport key/);
  await both(answer({ nonce: n2, v2: true, sigNonce: n1 }), pins(n2), /not signed by the attested transport key/);
  await both({ ...g2, appKey: g2.appKey.toUpperCase() }, pins(n1), /appKey is not 64 lowercase hex/);
  await both({ ...g2, appKeySig: g2.appKeySig.slice(2) }, pins(n1), /appKeySig is not 128 lowercase hex/);
  // runtime: restated, or another pinned; the certificate's own validity
  await both(answer({ nonce: n1, identity: PIXEL.replace("49.0.0", "48.0.1") }), pins(n1), /not an admitted runtime/);
  await both(g2, pins(n1, { allowedRuntimeIds: ["a".repeat(64)] }), /not an admitted runtime/);
  await both(g2, pins(n1, { now: Date.now() + 3 * 24 * 3600 * 1000 }), /expired/);
  // the caller's policy: every pin list, the nonce and the app are required
  for (const k of ["allowedRuntimeIds", "allowedCodeHashes", "allowedAuthorityHashes", "rootPins"]) await both(g2, pins(n1, { [k]: [] }), /fail closed/);
  await both(g2, pins(n1, { nonce: undefined }), /must be 32 bytes/);
  await both(g2, pins(n1, { appId: undefined }), /must be 32 bytes/);
  // malformed envelopes
  await both({ ...g1, format: "enclave-pvm-app-evidence/v0" }, pins(n1), /format is not/);
  await both({ ...g2, extra: 1 }, pins(n1), /fields must be exactly/);
  await both("EVIDENCE", pins(n1), /not an object/);
  await both([g2], pins(n1), /not an object/);
  await both({ ...g2, identity: " ".repeat(1025) }, pins(n1), /1024/);
  await both({ ...g2, spki: "00" }, pins(n1), /Ed25519 SPKI/);
});

test("a browser without X25519 or Ed25519 in SubtleCrypto is refused, with no fallback", async () => {
  const s = globalThis.crypto.subtle, orig = s.importKey;
  s.importKey = function (fmt, data, alg, ...rest) {
    if ((alg?.name || alg) === "X25519") return Promise.reject(Object.assign(new Error("unsupported"), { name: "NotSupportedError" }));
    return orig.call(this, fmt, data, alg, ...rest);
  };
  try {
    const fresh = await import(`../shielded/anchor/avf/web/pvm-verify.js?nocurves=${Date.now()}`);   // a module instance with no cached capability check
    const v = await fresh.verifyPvmAppEvidence({}, {});
    assert.equal(v.ok, false); assert.match(v.reasons.at(-1), /no X25519.*no fallback/);
  } finally { delete s.importKey; if (s.importKey !== orig) s.importKey = orig; }
});
