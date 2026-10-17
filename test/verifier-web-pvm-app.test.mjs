// verifier/web/pvm-app.mjs: ONE app's own protected VM on a phone host, verified in the browser, on AUTHENTIC evidence: the
// v4 document a Pixel 10 tenant app VM served at /.well-known/enclave-attestation over its own TLS port
// (test/fixtures/pvm-v4/probe-device.json). The sibling statement is signed here with a generated proof key (the phone's
// real key never leaves its VMs); every statement is also judged by the relay's own checkSibling (viem), for parity.
// Proves: a genuine VM passes all 14 checks, limited by what the relay states; pins on everything reach verified; the box's
// own VM needs no sibling statement; and each substitution is refused at the check that names it (another TLS key, nonce,
// app, release, signer, deployment, a missing statement, an attach key that changed), the app never asked if the phone fails.
//   run: node --test test/verifier-web-pvm-app.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { createHash } from "node:crypto";
import { verifyPvmAppEvidence } from "../relay/pvm-app-attest.mjs";
import { checkSibling, siblingDigest, SIBLING_FORMAT } from "../relay/pvm-market.mjs";
import { verifyPvmAppWith, PVM_APP_CHECK_ORDER, APP_RELAY_DERIVED, PROOF_KEY_RELAY_STATED, checkSiblingWeb } from "../verifier/web/pvm-app.mjs";
import { OPERATOR_STATED } from "../verifier/metal-box.mjs";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/pvm-v4/probe-device.json", import.meta.url), "utf8"));
const doc = fx.doc, NONCE = doc.nonce, NOW = new Date(fx.capturedAt), DEP = "0x" + "7f".repeat(32), NAME = "pixel10-pvm-cpu";
const hexToB64 = (h) => Buffer.from(h, "hex").toString("base64");
const sha = (h) => createHash("sha256").update(Buffer.from(h, "hex")).digest("hex");
const node = verifyPvmAppEvidence(doc, { nonce: NONCE, appId: fx.appSha256, requireTls: true, allowedRuntimeIds: [fx.runtimeId], allowedCodeHashes: [fx.codeHash],
                                         allowedAuthorityHashes: [fx.authorityHash], now: NOW.getTime() });
assert.ok(node.ok, node.reasons.join("\n"));
const INSTANCE = node.instanceId;
const PRIV = secp256k1.utils.randomPrivateKey(), PROOF = "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(PRIV, false).subarray(1)).subarray(12)).toString("hex");
const ATTACH = "302a300506032b6570032100" + "11".repeat(32);   // the box's own VM: not this app's VM
const sign = (fields, priv = PRIV) => { const s = secp256k1.sign(siblingDigest(fields), priv); return s.toCompactHex() + (27 + s.recovery).toString(16); };
const statement = (over = {}, priv = PRIV) => { const f = { nonce: NONCE, deployment: DEP, transportSpki: doc.spki, instanceId: INSTANCE, ...over };
  return { format: SIBLING_FORMAT, ...f, proofKey: PROOF, sig: sign(f, priv) }; };
const OP = { source: "test operator", codeHashes: [fx.codeHash], authorityHashes: [fx.authorityHash], runtimeIds: [fx.runtimeId] };
const json = (status, body) => new Response(JSON.stringify(body), { status });

function world({ app = (b) => b, host = null, nonce = NONCE } = {}) {
  const calls = [];
  const answer = () => ({ name: NAME, mode: "avf", deployment: DEP, nonce, fetchedAt: fx.capturedAt, origin: "https://7f7f7f7f.app.enclave.host/.well-known/enclave-attestation",
    document: structuredClone(doc), handshakeSpki: hexToB64(doc.tlsSpki), expected: { source: "relay", appSha256: fx.appSha256 }, attachTransportKey: hexToB64(ATTACH),
    sibling: statement(), proofKey: PROOF, registryId: "0x" + "c6".repeat(32), operatorAllowlist: OP });
  const deps = { now: () => NOW, randomBytes: () => Buffer.from(nonce, "hex"),
    verifyHost: async () => host || { status: "limited", omissions: [OPERATOR_STATED], reasons: [], facts: [["transport key", `sha256:${sha(ATTACH)}`]] },
    fetchImpl: async (url) => { calls.push(url); const r = app(answer()); return r instanceof Response ? r : json(200, r); } };
  return { calls, run: (opts = {}) => verifyPvmAppWith(deps, { name: NAME, deployment: DEP, ...opts }) };
}
const refusedAt = (v, key, re) => { assert.equal(v.status, "rejected", v.reasons.join("\n")); assert.equal(v.checks[key], false, `${key}: ${v.reasons.at(-1)}`); if (re) assert.match(v.reasons.at(-1), re); };
const relayAgrees = async (s, ok) => { const p = checkSibling(s, { nonce: NONCE, deployment: DEP, transportSpki: doc.spki, instanceId: INSTANCE, proofKey: PROOF });
  if (ok) await p; else await assert.rejects(p); };

test("pvm-app: the genuine app VM, a sibling of the phone's VM, passes every check; limited by the relay's app, lists and proof key", async () => {
  const w = world(); const v = await w.run();
  assert.equal(v.status, "limited", v.reasons.join("\n"));
  for (const k of PVM_APP_CHECK_ORDER) assert.equal(v.checks[k], true, `${k}: ${v.reasons.join("\n")}`);
  assert.deepEqual(v.omissions, [OPERATOR_STATED, APP_RELAY_DERIVED, PROOF_KEY_RELAY_STATED]);
  assert.equal(w.calls.length, 1, "one app request, no retry");
  assert.ok(v.facts.some(([k, x]) => k === "App TLS key sha256 (the key its certificate carries)" && x === fx.tlsSpkiSha256));
  await relayAgrees(statement(), true);
});

test("pvm-app: pins on the app, the lists and the proof key reach verified; the box's own VM needs no sibling statement", async () => {
  const pins = { appId: fx.appSha256, codeHashes: [fx.codeHash], authorityHashes: [fx.authorityHash], runtimeIds: [fx.runtimeId], proofKey: PROOF };
  const v = await world().run({ expected: pins });
  assert.equal(v.status, "verified", v.reasons.join("\n")); assert.deepEqual(v.omissions, []);
  const own = world({ app: (b) => ({ ...b, attachTransportKey: hexToB64(doc.spki), sibling: null, proofKey: null }),
                      host: { status: "limited", omissions: [], reasons: [], facts: [["transport key", `sha256:${sha(doc.spki)}`]] } });
  const o = await own.run(); assert.equal(o.status, "limited", o.reasons.join("\n")); assert.equal(o.checks.sameHost, true); assert.ok(!o.omissions.includes(PROOF_KEY_RELAY_STATED));
});

test("pvm-app: another signer, another deployment or VM in the statement, or no statement is refused at sameHost, by the relay too", async () => {
  const stranger = secp256k1.utils.randomPrivateKey();
  const cases = [
    [statement({}, stranger), /does not hold this box's registered proof key/],
    [statement({ deployment: "0x" + "ab".repeat(32) }), /not for this nonce, deployment and VM/],
    [statement({ instanceId: "cd".repeat(32) }), /not for this nonce, deployment and VM/],
    [{ ...statement(), sig: statement().sig.slice(0, 128) + "1d" }, /recovery id|does not hold/],
  ];
  for (const [s, re] of cases) { refusedAt(await world({ app: (b) => ({ ...b, sibling: s }) }).run(), "sameHost", re); await relayAgrees(s, false); }
  refusedAt(await world({ app: (b) => ({ ...b, sibling: null }) }).run(), "sameHost", /no sibling statement/);
  refusedAt(await world({ app: (b) => ({ ...b, proofKey: null }) }).run(), "sameHost", /no proof key/);
  assert.throws(() => checkSiblingWeb({ ...statement(), extra: 1 }, { nonce: NONCE, deployment: DEP, transportSpki: doc.spki, instanceId: INSTANCE, proofKey: PROOF }), /malformed/);
});

test("pvm-app: another TLS key, nonce, app or release, or an attach key that moved, is refused at the check that names it", async () => {
  const other = Buffer.from(doc.tlsSpki, "hex"); other[other.length - 1] ^= 1;
  refusedAt(await world({ app: (b) => ({ ...b, handshakeSpki: other.toString("base64") }) }).run(), "tlsHandshake", /public certificate/);
  refusedAt(await world({ nonce: "22".repeat(32) }).run(), "nonce");
  refusedAt(await world({ app: (b) => ({ ...b, nonce: "33".repeat(32) }) }).run(), "nonce", /another nonce/);
  refusedAt(await world({ app: (b) => ({ ...b, expected: { ...b.expected, appSha256: "ee".repeat(32) } }) }).run(), "app");
  refusedAt(await world({ app: (b) => ({ ...b, operatorAllowlist: { ...OP, codeHashes: ["00".repeat(32)] } }) }).run(), "release");
  refusedAt(await world({ app: (b) => ({ ...b, attachTransportKey: hexToB64("302a300506032b6570032100" + "22".repeat(32)) }) }).run(), "host", /re-attached/);
  const v3 = await world({ app: (b) => ({ ...b, document: { ...b.document, format: "enclave-pvm-app-evidence/v3" } }) }).run();
  refusedAt(v3, "document", /v4 required/);
});

test("pvm-app: nothing about the app is asked unless the phone verified; busy is an error, not a verdict, and never retried", async () => {
  const w = world({ host: { status: "rejected", reasons: ["the evidence answers another nonce"], facts: [] } });
  const v = await w.run(); refusedAt(v, "host"); assert.equal(w.calls.length, 0);
  const busy = world({ app: () => json(503, { error: "busy", retryAfter: 30 }) });
  const b = await busy.run(); assert.equal(b.status, "error"); assert.match(b.reasons.at(-1), /busy/); assert.equal(busy.calls.length, 1);
  assert.equal((await world().run({ deployment: "0x12" })).status, "error");
});
