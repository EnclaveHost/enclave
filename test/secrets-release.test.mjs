// Attested release of config + secrets to a per-app SNP guest (relay/secrets-release.mjs; contract v1.1). The REAL
// verifier (verifier/index.mjs verifyEvidence) judges SYNTHETIC reports signed by a synthetic AMD-shaped chain
// (test/helpers/snp-synth.mjs, trusted here through the policy's roots only). Every key is generated per run or a fixed
// test constant; nothing here is a real credential.
//   run: node --test test/secrets-release.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, diffieHellman, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { synthChain, synthReport } from "./helpers/snp-synth.mjs";
import { verifyEvidence, memoryCollateral } from "../verifier/index.mjs";

const sha = (...p) => createHash("sha256").update(Buffer.concat(p)).digest();
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "enclave-release-test-"));
const S = synthChain();
const RID = sha(Buffer.from("synthetic runtime identity"));   // what runtimeIdOf answers for RUNTIME below
const RUNTIME = { synthetic: "runtime" };
Object.assign(process.env, { SECRETS_KEY: "ab".repeat(32), AUTH_DATA_DIR: DIR, SECRETS_ATTESTED_RELEASE: "1",
  SECRETS_RELEASE_DEPLOYMENTS: "*",
  SECRETS_RELEASE_BURST: "1000",      // the suite asks far more often than a real guest may
  SECRETS_RELEASE_MIN_TCB: JSON.stringify({ Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }), SECRETS_RELEASE_VMPL: "0",
  SECRETS_RELEASE_SIGNING_KEY: "5a".repeat(32) });   // a synthetic release signing seed (v1.2)
const { initSecrets, handleSecrets, applyPut } = await import("../relay/secrets.js");
const R = await import("../relay/secrets-release.mjs");
await initSecrets();

const OP = privateKeyToAccount(generatePrivateKey()), STRANGER = privateKeyToAccount(generatePrivateKey());
const A = "0x" + "a1".repeat(32), B = "0x" + "b2".repeat(32);            // two deployments of the SAME app
const C = "0x" + "c3".repeat(32);                                          // a third, whose envelope names no config
const APP = sha(Buffer.from("the app both deployments run"));
const EP = "https://api.enclave.host/t/metal-iso0", EP_ID = "0x" + "e0".repeat(32);
const synthCol = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
const FLOOR = { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } };
let rows = [], ineligible = false, chips = [S.chip.toString("hex")];
const versions = {};   // the catalog version's config per deployment (versionConfigFor)
const envelopes = { [A]: JSON.stringify({ isolation: { require: "snp-guest-per-app" }, config: { endpoint: "$IMAGE_ENDPOINT", n: 1 } }),
                    [B]: JSON.stringify({ isolation: { require: "snp-guest-per-app" }, configCid: "bafkreisyntheticcid" }) };
const REF = "catalog://0x" + "5a".repeat(32) + "/3";                    // the catalog version all three run
// what the relay's measurement predictor answers for REF (relay/measurement-predict.mjs; its own suite covers it)
let predicted = { ok: true, appId: APP.toString("hex"), images: [{ release: "e1".repeat(32), runtimeId: RID.toString("hex"), measurement: "77".repeat(48) }] };
const predictedFor = [];   // the rows the predictor was asked about
// the confirmed ledger read (ctx.confirmRow: the record by id through agreeing RPCs); by default it agrees with `rows`
let confirm = { fail: null, over: {} };
const leaseRow = (id, over = {}) => ({ id, owner: STRANGER.address, runner: EP_ID, configCid: envelopes[id] ?? "", appRef: REF,
                                       leaseUntil: BigInt(Math.floor(Date.now() / 1000) + 1800), ...over });
const ctx = {
  json: (res, code, body) => { res.code = code; res.body = body; },
  readBody: async (req) => Buffer.from(JSON.stringify(req.body)),
  clientIp: () => "203.0.113.9",
  ledgerRows: async () => rows, ledgerExpire: () => {},
  endpointIdOf: async (ep) => (ep === EP ? EP_ID : "0x" + "ee".repeat(32)),
  operatorOfEndpoint: async (ep) => (ep === EP ? OP.address : null),
  hostEligibility: () => (ineligible ? { eligible: false, reason: "evidence regressed" } : { eligible: true, reason: null }),
  leaseHolderChipIds: async (ep) => (ep === EP ? chips : []),
  runtimeIdOf: async (r) => (JSON.stringify(r) === JSON.stringify(RUNTIME) ? RID : sha(Buffer.from(JSON.stringify(r)))),
  confirmRow: async (id) => {
    if (confirm.fail) throw new Error(confirm.fail);
    const r = rows.find((x) => x.id === id);
    if (!r) throw new Error("the ledger holds no such deployment");
    return { ...r, ...confirm.over };
  },
  expectedGuestFor: async (row) => { predictedFor.push(row && row.id); return row && row.appRef === REF ? predicted : { ok: false, code: "version_not_admitted", reason: "not the synthetic version" }; },
  resolveConfigCid: async (cid) => (cid === "bafkreisyntheticcid" ? { resolved: true, key: "${JOT_API_KEY}" }
                                     : cid === "bafkreiversioncid" ? '{"fromVersionCid":true}' : null),   // a value, or fetched TEXT
  versionConfigFor: async (id) => versions[id] ?? null,
  verifyGuestEvidence: (doc, { allowedMeasurements, minTcb, expectedVmpl, expectedBinding, expectedAppId, expectedHostData }) => verifyEvidence(doc, {
    policy: { snp: { roots: new Map([["Genoa", S.arkFp]]), allowedMeasurements, minTcb, expectedVmpl } },
    context: { transportKeySpki: Buffer.from(doc.transportKey, "base64"), expectedBinding, expectedAppId, expectedHostData, now: new Date().toISOString() },
    collateral: synthCol }),
};
const call = async (pathname, body) => { const res = {}; await handleSecrets({ method: "POST", body }, res, new URL("http://x" + pathname), ctx); return res; };
applyPut(A, JSON.stringify({ set: { IMAGE_ENDPOINT: "https://synthetic-a.example", JOT_API_KEY: "synthetic-a-key" } }));
applyPut(B, JSON.stringify({ set: { JOT_API_KEY: "synthetic-b-key" } }));

let _seq = 0;   // a distinct ts per ticket: one (id, endpoint, ts) signed twice IS a replay, by design
async function ticketFor(id, { account = OP, endpoint = EP } = {}) {
  const ts = Math.floor(Date.now() / 1000) - 250 + (_seq++ % 500);
  return call("/v1/secrets/release-ticket", { id, endpoint, ts, opSig: await account.signMessage({ message: `enclave-secrets-release-ticket:${id}:${endpoint}:${ts}` }) });
}
// the guest: a transport key, a fresh seal key, and a report over the release binding (or whatever a test overrides)
function guest({ id, ticket, hostData = id, appId = APP, binding, runtime = RUNTIME, rid = RID, sealPriv, signingKey = 0, debug = false }) {
  const transport = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" });
  const seal = generateKeyPairSync("x25519"), sealKey = R.rawPublicOf(sealPriv ? R.x25519PrivateKey(sealPriv) : seal.privateKey);
  const t = Buffer.from(ticket, "base64");
  const rd0 = binding ? binding({ transport, t, sealKey }) : R.releaseBinding({ id, transportSpki: transport, ticket: t, runtimeId: rid, sealKey });
  let report = synthReport(S, { reportData: Buffer.concat([rd0, appId]), hostData: R.idBytes(hostData) });
  if (signingKey || debug) {                           // re-sign a report that says another signing key (VLEK = 1) or allows DEBUG
    if (signingKey) report.writeUInt32LE((report.readUInt32LE(0x48) & ~0x1c) | (signingKey << 2), 0x48);
    if (debug) report.writeBigUInt64LE(report.readBigUInt64LE(0x08) | (1n << 19n), 0x08);
    const sig = cryptoSign("sha384", report.subarray(0, 0x2a0), { key: S.vcekKey, dsaEncoding: "ieee-p1363" });
    report.fill(0, 0x2a0, 0x2a0 + 0x90);
    Buffer.from(sig.subarray(0, 48)).reverse().copy(report, 0x2a0); Buffer.from(sig.subarray(48, 96)).reverse().copy(report, 0x2a0 + 0x48);
  }
  const evidence = { format: "sev-snp-guest-domain-v1", abi: "enclave-domain-abi/2", runtime, transportKey: transport.toString("base64"), report: report.toString("base64") };
  return { evidence, sealKey, sealPrivate: sealPriv ? R.x25519PrivateKey(sealPriv) : seal.privateKey };
}
const release = (id, ticket, g, over = {}) => call("/v1/secrets/release", { id, ticket, sealKey: g.sealKey.toString("base64"), evidence: g.evidence, ...over });
const opened = (id, ticket, g, res) => JSON.parse(R.openRelease({ id, ticket: Buffer.from(ticket, "base64"), sealPrivateKey: g.sealPrivate, sealed: Buffer.from(res.body.sealed, "base64") }).toString());

// ---- the primitives ----
test("vectors: the committed binding and sealed blob reproduce, and the RFC 7748 6.1 exchange holds through the key wrappers", () => {
  const v = JSON.parse(fs.readFileSync(new URL("./fixtures/secrets-release-vectors.json", import.meta.url)));
  const i = v.inputs, hx = (s) => Buffer.from(s, "hex");
  const sealKey = R.rawPublicOf(R.x25519PrivateKey(hx(i.sealPrivateHex)));
  assert.equal(sealKey.toString("hex"), v.outputs.sealKeyHex);
  assert.equal(R.releaseBinding({ id: i.id, transportSpki: hx(i.transportSpkiHex), ticket: hx(i.ticketHex), runtimeId: hx(i.runtimeIdHex), sealKey }).toString("hex"), v.outputs.bindingHex);
  assert.equal(R.sealRelease({ id: i.id, ticket: hx(i.ticketHex), sealKey, plaintext: i.plaintext, _ephPrivate: hx(i.ephPrivateHex), _iv: hx(i.ivHex) }).toString("hex"), v.outputs.sealedHex);
  assert.equal(R.openRelease({ id: i.id, ticket: hx(i.ticketHex), sealPrivateKey: hx(i.sealPrivateHex), sealed: hx(v.outputs.sealedHex) }).toString(), i.plaintext);
  // v1.2: the response signature (Ed25519 over the 32-byte digest, deterministic)
  const rk = R.signingKeyFromSeed(hx(i.responseSigningSeedHex)), rf = { id: i.id, ticket: hx(i.ticketHex), sealKey, sealed: hx(v.outputs.sealedHex) };
  assert.equal(R.ed25519RawPublic(rk).toString("hex"), v.outputs.responseSigningPublicHex);
  assert.equal(R.keyIdOf(R.ed25519RawPublic(rk)), v.outputs.responseKeyId);
  assert.equal(R.responseDigest(rf).toString("hex"), v.outputs.responseDigestHex);
  assert.equal(R.signResponse(rk, rf).toString("hex"), v.outputs.responseSigHex);
  assert.equal(R.verifyResponse({ publicKey: hx(v.outputs.responseSigningPublicHex), sig: hx(v.outputs.responseSigHex), ...rf }), true);
  const a = R.x25519PrivateKey(hx("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")), b = R.x25519PrivateKey(hx("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb"));
  assert.equal(R.rawPublicOf(b).toString("hex"), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
  assert.equal(diffieHellman({ privateKey: a, publicKey: R.x25519PublicKey(R.rawPublicOf(b)) }).toString("hex"), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
});

test("the seal opens ONLY under its own deployment, ticket and seal key; a tampered byte or a low-order seal key is refused", () => {
  const id = A, ticket = Buffer.alloc(32, 7), k = generateKeyPairSync("x25519"), sealKey = R.rawPublicOf(k.privateKey);
  const sealed = R.sealRelease({ id, ticket, sealKey, plaintext: "hello" });
  assert.equal(R.openRelease({ id, ticket, sealPrivateKey: k.privateKey, sealed }).toString(), "hello");
  assert.throws(() => R.openRelease({ id: B, ticket, sealPrivateKey: k.privateKey, sealed }));
  assert.throws(() => R.openRelease({ id, ticket: Buffer.alloc(32, 8), sealPrivateKey: k.privateKey, sealed }));
  assert.throws(() => R.openRelease({ id, ticket, sealPrivateKey: generateKeyPairSync("x25519").privateKey, sealed }));
  const bent = Buffer.from(sealed); bent[bent.length - 20] ^= 1;
  assert.throws(() => R.openRelease({ id, ticket, sealPrivateKey: k.privateKey, sealed: bent }));
  // low-order points: the all-zero key and the order-8 point with u = 1 both give an all-zero shared secret
  for (const lo of [Buffer.alloc(32), Buffer.concat([Buffer.from([1]), Buffer.alloc(31)])])
    assert.throws(() => R.sealRelease({ id, ticket, sealKey: lo, plaintext: "x" }), /all-zero X25519 shared secret/);
  // fresh ephemeral key and IV every time
  const again = R.sealRelease({ id, ticket, sealKey, plaintext: "hello" });
  assert.notDeepEqual(again.subarray(0, 44), sealed.subarray(0, 44));
});

test("the release binding: fixed layout, every field matters, and it can never equal Bind2 over the same inputs (no oracle)", () => {
  const spki = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" });
  const base = { id: A, transportSpki: spki, ticket: Buffer.alloc(32, 1), runtimeId: Buffer.alloc(32, 2), sealKey: Buffer.alloc(32, 3) };
  const b0 = R.releaseBinding(base);
  assert.deepEqual(b0, sha(Buffer.from("enclave-secrets-release-v1\n"), R.idBytes(A), sha(spki), base.ticket, base.runtimeId, base.sealKey));
  for (const [k, v] of [["id", B], ["ticket", Buffer.alloc(32, 9)], ["runtimeId", Buffer.alloc(32, 9)], ["sealKey", Buffer.alloc(32, 9)],
                        ["transportSpki", generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" })]])
    assert.notDeepEqual(R.releaseBinding({ ...base, [k]: v }), b0, `${k} is bound`);
  const bind2 = sha(Buffer.from("enclave-bind-v2\n"), spki, base.ticket, base.runtimeId);   // isolation/contract/runtime.mjs bind2
  assert.notDeepEqual(bind2, b0);
  assert.throws(() => R.releaseBinding({ ...base, ticket: Buffer.alloc(31) }), /32 bytes/);
  assert.throws(() => R.releaseBinding({ ...base, id: A.toUpperCase() }), /bytes32/);
});

// ---- the endpoints ----
test("the flow: a ticket for the eligible lease holder, then a verified guest gets its config and secrets, sealed to it", async () => {
  rows = [leaseRow(A), leaseRow(B)]; ineligible = false; chips = [S.chip.toString("hex")];
  predictedFor.length = 0;
  const t = await ticketFor(A);
  assert.equal(t.code, 200, JSON.stringify(t.body));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(predictedFor, [A], "the ticket warms the lease holder's prediction");
  const g = guest({ id: A, ticket: t.body.ticket });
  const r = await release(A, t.body.ticket, g);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const RELEASE_PUB = R.ed25519RawPublic(R.signingKeyFromSeed(Buffer.alloc(32, 0x5a)));
  assert.equal(r.body.keyId, R.keyIdOf(RELEASE_PUB));
  const fields = { id: A, ticket: Buffer.from(t.body.ticket, "base64"), sealKey: g.sealKey, sealed: Buffer.from(r.body.sealed, "base64") };
  assert.equal(R.verifyResponse({ publicKey: RELEASE_PUB, sig: Buffer.from(r.body.sig, "base64"), ...fields }), true, "v1.2: signed by the relay's release key");
  const bentSealed = Buffer.from(fields.sealed); bentSealed[50] ^= 1;
  assert.equal(R.verifyResponse({ publicKey: RELEASE_PUB, sig: Buffer.from(r.body.sig, "base64"), ...fields, sealed: bentSealed }), false, "a forged blob fails the signature");
  assert.equal(R.verifyResponse({ publicKey: R.ed25519RawPublic(R.signingKeyFromSeed(Buffer.alloc(32, 1))), sig: Buffer.from(r.body.sig, "base64"), ...fields }), false, "another key does not verify it");
  assert.equal(R.verifyResponse({ publicKey: RELEASE_PUB, sig: Buffer.from(r.body.sig, "base64"), ...fields, id: B }), false, "bound to the deployment");
  const p = opened(A, t.body.ticket, g, r);
  assert.equal(p.id, A);
  assert.deepEqual(p.config, { endpoint: "$IMAGE_ENDPOINT", n: 1 }, "the ledger envelope's inline config, placeholders untouched (substitution is the guest's)");
  assert.deepEqual(p.secrets, { IMAGE_ENDPOINT: "https://synthetic-a.example", JOT_API_KEY: "synthetic-a-key" });
  assert.equal(p.envelopeSha256, sha(Buffer.from(envelopes[A])).toString("hex"));
  // a deployment whose envelope names a configCid gets it resolved by the relay
  const tb = await ticketFor(B), gb = guest({ id: B, ticket: tb.body.ticket });
  const rb = await release(B, tb.body.ticket, gb);
  assert.equal(rb.code, 200, JSON.stringify(rb.body));
  assert.deepEqual(opened(B, tb.body.ticket, gb, rb).config, { resolved: true, key: "${JOT_API_KEY}" });
});

test("tickets: only the endpoint's operator, only the eligible live lease holder with an attested chip, never twice", async () => {
  rows = [leaseRow(A)]; ineligible = false; chips = [S.chip.toString("hex")];
  const ts = Math.floor(Date.now() / 1000) + 290;   // outside ticketFor's ts range
  let r = await call("/v1/secrets/release-ticket", { id: A, endpoint: EP, ts });
  assert.equal(r.code, 403); assert.equal(r.body.error, "operator_sig");
  r = await ticketFor(A, { account: STRANGER });
  assert.equal(r.code, 403); assert.equal(r.body.error, "operator_sig");
  const opSig = await OP.signMessage({ message: `enclave-secrets-release-ticket:${A}:${EP}:${ts}` });
  assert.equal((await call("/v1/secrets/release-ticket", { id: A, endpoint: EP, ts, opSig })).code, 200);
  r = await call("/v1/secrets/release-ticket", { id: A, endpoint: EP, ts, opSig });
  assert.equal(r.code, 409, "the same signature twice"); assert.equal(r.body.error, "replay");
  rows = [leaseRow(A, { runner: "0x" + "99".repeat(32) })];
  r = await ticketFor(A); assert.equal(r.code, 403); assert.equal(r.body.error, "not_lease_holder");
  rows = [leaseRow(A, { leaseUntil: 1n })];
  r = await ticketFor(A); assert.equal(r.code, 403); assert.equal(r.body.error, "not_lease_holder");
  rows = [leaseRow(A)]; ineligible = true;
  r = await ticketFor(A); assert.equal(r.code, 403); assert.equal(r.body.error, "host_ineligible");
  ineligible = false; chips = [];
  r = await ticketFor(A); assert.equal(r.code, 403); assert.equal(r.body.error, "no_attested_chip");
  chips = ["00".repeat(64)];
  r = await ticketFor(A); assert.equal(r.code, 403, "a zero (masked) CHIP_ID is no attested chip"); assert.equal(r.body.error, "no_attested_chip");
  chips = [S.chip.toString("hex")];
});

test("release refusals: each releases NOTHING and consumes the ticket", async () => {
  rows = [leaseRow(A), leaseRow(B)]; ineligible = false; chips = [S.chip.toString("hex")];
  const refused = async (label, setup, want) => {
    const t = await ticketFor(A);
    assert.equal(t.code, 200, `${label}: ticket ${JSON.stringify(t.body)}`);
    const { g, over = {}, id = A } = await setup(t.body.ticket);
    const r = await release(id, t.body.ticket, g, over);
    assert.equal(r.code, want.code, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, want.error, label);
    assert.equal(r.body.sealed, undefined, `${label}: nothing released`);
    if (want.why) assert.match(r.body.message, want.why, label);
    // the ticket is gone: presenting it again, even with perfect evidence, is refused
    const again = await release(A, t.body.ticket, guest({ id: A, ticket: t.body.ticket }));
    assert.equal(again.code, 403, `${label}: the ticket was consumed`); assert.equal(again.body.error, "bad_ticket");
  };
  const E = { code: 403, error: "evidence_refused" };
  // d1's confused deputy: A's ticket in B's honest guest (same app, same chip): HOST_DATA names B
  await refused("A's ticket in B's guest", (tk) => ({ g: guest({ id: A, ticket: tk, hostData: B }) }), { ...E });
  // the oracle: a report whose [0:32] is Bind2 over the ticket (what the public attestation endpoint signs)
  await refused("Bind2 over the ticket", (tk) => ({ g: guest({ id: A, ticket: tk, binding: ({ transport, t }) => sha(Buffer.from("enclave-bind-v2\n"), transport, t, RID) }) }), E);
  await refused("another app", (tk) => ({ g: guest({ id: A, ticket: tk, appId: sha(Buffer.from("some other app")) }) }), E);
  await refused("a runtime outside the admitted set", (tk) => ({ g: guest({ id: A, ticket: tk, runtime: { other: 1 }, rid: sha(Buffer.from('{"other":1}')) }) }), { code: 403, error: "runtime_not_admitted" });
  await refused("a report not over THIS seal key", (tk) => ({ g: guest({ id: A, ticket: tk }), over: { sealKey: R.rawPublicOf(generateKeyPairSync("x25519").privateKey).toString("base64") } }), E);
  await refused("a VLEK-signed report", (tk) => ({ g: guest({ id: A, ticket: tk, signingKey: 1 }) }), E);
  await refused("the lease moved after the ticket", async (tk) => { rows = [leaseRow(A, { runner: "0x" + "99".repeat(32) }), leaseRow(B)]; return { g: guest({ id: A, ticket: tk }) }; }, { code: 403, error: "not_lease_holder" });
  rows = [leaseRow(A), leaseRow(B)];
  await refused("the holder turned ineligible", async (tk) => { ineligible = true; return { g: guest({ id: A, ticket: tk }) }; }, { code: 403, error: "host_ineligible" });
  ineligible = false;
  await refused("a ticket for A presented for B", (tk) => ({ g: guest({ id: B, ticket: tk }), id: B }), { code: 403, error: "bad_ticket" });
  const keepPrediction = predicted;
  await refused("a measurement other than the predicted one", async (tk) => { predicted = { ...keepPrediction, images: [{ ...keepPrediction.images[0], measurement: "66".repeat(48) }] }; return { g: guest({ id: A, ticket: tk }) }; }, E);
  // the runtime and the measurement are ONE pair: the guest's runtime is admitted only with ITS release's measurement
  await refused("a predicted measurement under another release's runtime", async (tk) => { predicted = { ...keepPrediction, images: [
    { release: "e2".repeat(32), runtimeId: sha(Buffer.from("another runtime")).toString("hex"), measurement: "77".repeat(48) },
    { release: "e1".repeat(32), runtimeId: RID.toString("hex"), measurement: "66".repeat(48) }] }; return { g: guest({ id: A, ticket: tk }) }; }, E);
  await refused("a deployment on another catalog version than the prediction's", async (tk) => { rows = [leaseRow(A, { appRef: "catalog://0x" + "5a".repeat(32) + "/4" }), leaseRow(B)]; return { g: guest({ id: A, ticket: tk }) }; }, { code: 403, error: "version_not_admitted" });
  rows = [leaseRow(A), leaseRow(B)];
  // a version that cannot have a prediction is a final answer: the ticket is consumed like any refusal
  for (const code of ["version_not_admitted", "underivable", "not_catalog"])
    await refused(`a prediction refused (${code})`, async (tk) => { predicted = { ok: false, code, reason: "synthetic" }; return { g: guest({ id: A, ticket: tk }) }; }, { code: 403, error: code });
  predicted = keepPrediction;
  await refused("a report from another VMPL than the pinned one", async (tk) => { process.env.SECRETS_RELEASE_VMPL = "1"; return { g: guest({ id: A, ticket: tk }) }; }, E);
  process.env.SECRETS_RELEASE_VMPL = "0";
  await refused("a DEBUG-enabled guest policy", (tk) => ({ g: guest({ id: A, ticket: tk, debug: true }) }), E);
  await refused("a release document that states a nonce", (tk) => { const g = guest({ id: A, ticket: tk }); g.evidence.nonce = "00".repeat(32); return { g }; }, { code: 422, error: "bad_evidence", why: /must not state a nonce/ });
  await refused("a low-order seal key", (tk) => ({ g: guest({ id: A, ticket: tk, sealPriv: null, binding: ({ transport, t }) => R.releaseBinding({ id: A, transportSpki: transport, ticket: t, runtimeId: RID, sealKey: Buffer.alloc(32) }) }), over: { sealKey: Buffer.alloc(32).toString("base64") } }), { code: 422, error: "bad_seal_key" });
});

test("a prediction the relay cannot make YET keeps the ticket (enclave-d1): 503, then the same ticket releases once it can", async () => {
  rows = [leaseRow(A)]; ineligible = false; chips = [S.chip.toString("hex")];
  const keep = predicted;
  try {
    for (const [code, answer] of [["warming", { ok: false, code: "warming", reason: "synthetic" }], ["busy", { ok: false, code: "busy", reason: "synthetic" }],
      ["prediction_unavailable", { ok: false, code: "prediction_unavailable", reason: "synthetic" }], ["component_unavailable", { ok: false, code: "component_unavailable", reason: "synthetic" }],
      ["catalog_unreachable", { ok: false, code: "catalog_unreachable", reason: "synthetic" }], ["prediction_unavailable", { ok: true, appId: APP.toString("hex"), images: [] }]]) {
      const t = await ticketFor(A), g = guest({ id: A, ticket: t.body.ticket });
      predicted = answer;
      const r = await release(A, t.body.ticket, g);
      assert.equal(r.code, 503, code); assert.equal(r.body.error, code); assert.equal(r.body.sealed, undefined);
      assert.ok(R._internals.tickets.has(t.body.ticket), `${code}: the ticket is kept`);
      predicted = keep;
      const again = await release(A, t.body.ticket, g);
      assert.equal(again.code, 200, `${code}: the retry releases: ${JSON.stringify(again.body)}`);
      assert.equal(R._internals.tickets.has(t.body.ticket), false, `${code}: now consumed`);
    }
    // a 403-class prediction burns it; so does a lease that moved, even while the prediction is unavailable
    const t = await ticketFor(A);
    rows = [leaseRow(A, { runner: "0x" + "99".repeat(32) })]; predicted = { ok: false, code: "busy", reason: "synthetic" };
    const r = await release(A, t.body.ticket, guest({ id: A, ticket: t.body.ticket }));
    assert.equal(r.code, 403); assert.equal(r.body.error, "not_lease_holder"); assert.equal(R._internals.tickets.has(t.body.ticket), false);
  } finally { predicted = keep; rows = [leaseRow(A)]; }
  // the prediction is asked for a PRIVATE deployment as such (a pending version is then allowed, as the supervisor runs it)
  const seen = [];
  const real = ctx.expectedGuestFor;
  ctx.expectedGuestFor = async (row, o) => { seen.push({ id: row.id, ...o }); return predicted; };
  try {
    rows = [leaseRow(A, { isPublic: false })];
    const t = await ticketFor(A);
    assert.equal((await release(A, t.body.ticket, guest({ id: A, ticket: t.body.ticket }))).code, 200);
    assert.ok(seen.some((s) => s.id === A && s.forPrivate === true && s.waitMs > 0), JSON.stringify(seen));
  } finally { ctx.expectedGuestFor = real; rows = [leaseRow(A)]; }
});

test("the confirmed ledger read decides: a disagreement keeps the ticket (503), a confirmed other runner refuses, the confirmed appRef is predicted", async () => {
  rows = [leaseRow(A)]; ineligible = false; chips = [S.chip.toString("hex")];
  try {
    confirm = { fail: "the RPCs disagree about the deployment's record", over: {} };
    const tr = await ticketFor(A);
    assert.equal(tr.code, 503); assert.equal(tr.body.error, "ledger_unconfirmed");
    confirm = { fail: null, over: {} };
    const t = await ticketFor(A), g = guest({ id: A, ticket: t.body.ticket });
    confirm = { fail: "one RPC timed out", over: {} };
    const r = await release(A, t.body.ticket, g);
    assert.equal(r.code, 503); assert.equal(r.body.error, "ledger_unconfirmed"); assert.ok(R._internals.tickets.has(t.body.ticket), "kept");
    confirm = { fail: null, over: {} };
    assert.equal((await release(A, t.body.ticket, g)).code, 200, "the retry releases");
    // the cached row says the endpoint holds the lease; the confirmed read says another runner
    const t2 = await ticketFor(A);
    confirm = { fail: null, over: { runner: "0x" + "99".repeat(32) } };
    const r2 = await release(A, t2.body.ticket, guest({ id: A, ticket: t2.body.ticket }));
    assert.equal(r2.code, 403); assert.equal(r2.body.error, "not_lease_holder"); assert.match(r2.body.message, /confirmed/);
    // the cached row names REF, the confirmed record another version: the prediction is for the CONFIRMED one
    confirm = { fail: null, over: {} };
    const t3 = await ticketFor(A);
    confirm = { fail: null, over: { appRef: "catalog://0x" + "5a".repeat(32) + "/9" } };
    const r3 = await release(A, t3.body.ticket, guest({ id: A, ticket: t3.body.ticket }));
    assert.equal(r3.code, 403); assert.equal(r3.body.error, "version_not_admitted");
  } finally { confirm = { fail: null, over: {} }; rows = [leaseRow(A)]; }
});

test("a chip mismatch is caught at release: a ticket issued for chip X refuses a report from chip Y", async () => {
  rows = [leaseRow(A)]; ineligible = false; chips = ["ab".repeat(64)];      // the holder attested with another chip
  const t = await ticketFor(A);
  assert.equal(t.code, 200);
  const r = await release(A, t.body.ticket, guest({ id: A, ticket: t.body.ticket }));
  assert.equal(r.code, 403); assert.equal(r.body.error, "evidence_refused");
  assert.match(r.body.message, /not from a chip the lease holder attested with/); assert.equal(r.body.sealed, undefined);
  chips = [S.chip.toString("hex")];
});

test("fail closed: OFF, a missing policy or a missing provider answers 503 and issues nothing; an expired ticket is refused", async () => {
  rows = [leaseRow(A)];
  const saved = { ...process.env };
  for (const [k, v] of [["SECRETS_ATTESTED_RELEASE", ""], ["SECRETS_RELEASE_DEPLOYMENTS", ""], ["SECRETS_RELEASE_DEPLOYMENTS", "0x12,all"],
                        ["SECRETS_RELEASE_MIN_TCB", ""], ["SECRETS_RELEASE_MIN_TCB", "{}"], ["SECRETS_RELEASE_VMPL", ""], ["SECRETS_RELEASE_VMPL", "4"],
                        ["SECRETS_RELEASE_SIGNING_KEY", ""], ["SECRETS_RELEASE_SIGNING_KEY", "zz"],
                        ["SECRETS_RELEASE_SIGNING_KEY", "ab".repeat(32)]]) {   // equal to this suite's SECRETS_KEY: no separate key
    process.env[k] = v;
    const r = await ticketFor(A);
    assert.equal(r.code, 503, `${k}=${v}`); assert.equal(r.body.error, "release_unconfigured"); assert.match(r.body.message, new RegExp(k));
    Object.assign(process.env, saved);
  }
  for (const p of ["verifyGuestEvidence", "expectedGuestFor", "runtimeIdOf", "leaseHolderChipIds", "versionConfigFor", "confirmRow"]) {
    const keep = ctx[p]; delete ctx[p];
    const r = await ticketFor(A);
    assert.equal(r.code, 503, p); assert.equal(r.body.error, "release_unconfigured");
    ctx[p] = keep;
  }
  // a predictor that names its own missing configuration is missing configuration
  ctx.predictorProblems = () => ["SECRETS_RELEASE_PREDICT_COMMIT"];
  { const r = await ticketFor(A); assert.equal(r.code, 503); assert.match(r.body.message, /SECRETS_RELEASE_PREDICT_COMMIT/); }
  delete ctx.predictorProblems;
  // a staged rollout: a deployment outside SECRETS_RELEASE_DEPLOYMENTS gets neither a ticket nor a release
  process.env.SECRETS_RELEASE_DEPLOYMENTS = B;
  { const r = await ticketFor(A); assert.equal(r.code, 403); assert.equal(r.body.error, "release_not_enabled"); }
  process.env.SECRETS_RELEASE_DEPLOYMENTS = "*";
  const t = await ticketFor(A);
  R._internals.tickets.get(t.body.ticket).exp = Math.floor(Date.now() / 1000) - 1;
  const r = await release(A, t.body.ticket, guest({ id: A, ticket: t.body.ticket }));
  assert.equal(r.code, 403); assert.equal(r.body.error, "bad_ticket");
  // a deployment whose configCid does not resolve gets nothing rather than a partial answer
  rows = [leaseRow(B, { configCid: JSON.stringify({ configCid: "bafkreiunknown" }) })];
  const tb = await ticketFor(B), gb = guest({ id: B, ticket: tb.body.ticket }), rb = await release(B, tb.body.ticket, gb);
  assert.equal(rb.code, 503); assert.equal(rb.body.error, "config_unresolvable"); assert.equal(rb.body.sealed, undefined);
  // the relay's own 503: the ticket is KEPT (config is resolved before it is consumed), and the retry releases once it resolves
  assert.ok(R._internals.tickets.has(tb.body.ticket), "config_unresolvable keeps the ticket");
  rows = [leaseRow(B, { configCid: JSON.stringify({ configCid: "bafkreisyntheticcid" }) })];
  const rb2 = await release(B, tb.body.ticket, gb);
  assert.equal(rb2.code, 200, JSON.stringify(rb2.body)); assert.equal(R._internals.tickets.has(tb.body.ticket), false);
  // a malformed envelope is final: 422, and the ticket is burned
  const tc = await ticketFor(B);
  rows = [leaseRow(B, { configCid: "not json" })];
  const rc = await release(B, tc.body.ticket, guest({ id: B, ticket: tc.body.ticket }));
  assert.equal(rc.code, 422); assert.equal(rc.body.error, "bad_envelope"); assert.equal(R._internals.tickets.has(tc.body.ticket), false);
});

test("the relay's OWN checks hold even when the verifier says verified: VCEK signer, binding, app, HOST_DATA, chip", async () => {
  rows = [leaseRow(A), leaseRow(B)]; ineligible = false; chips = [S.chip.toString("hex")];
  const real = ctx.verifyGuestEvidence;
  ctx.verifyGuestEvidence = async () => ({ status: "verified", reasons: [], claims: {} });   // a verifier that checks nothing
  try {
    const cases = [
      ["a VLEK-signed report", (tk) => guest({ id: A, ticket: tk, signingKey: 1 }), /not VCEK-signed/],
      ["Bind2 over the ticket", (tk) => guest({ id: A, ticket: tk, binding: ({ transport, t }) => sha(Buffer.from("enclave-bind-v2\n"), transport, t, RID) }), /not this release's binding/],
      ["another app", (tk) => guest({ id: A, ticket: tk, appId: sha(Buffer.from("x")) }), /not this deployment's app/],
      ["another deployment's HOST_DATA", (tk) => guest({ id: A, ticket: tk, hostData: B }), /HOST_DATA is not this deployment/],
      ["a DEBUG-enabled guest policy", (tk) => guest({ id: A, ticket: tk, debug: true }), /allows DEBUG/],
    ];
    // the measurement is re-read from the report: a verifier that passed another image does not release
    { const keep = predicted; predicted = { ...keep, images: [{ ...keep.images[0], measurement: "66".repeat(48) }] };
      const t = await ticketFor(A), r = await release(A, t.body.ticket, guest({ id: A, ticket: t.body.ticket }));
      predicted = keep;
      assert.equal(r.code, 403); assert.match(r.body.message, /not the one predicted/); assert.equal(r.body.sealed, undefined); }
    for (const [label, mk, why] of cases) {
      const t = await ticketFor(A);
      const r = await release(A, t.body.ticket, mk(t.body.ticket));
      assert.equal(r.code, 403, label); assert.equal(r.body.error, "evidence_refused", label); assert.match(r.body.message, why, label);
      assert.equal(r.body.sealed, undefined, `${label}: nothing released`);
    }
    // a report from another VMPL than the pinned one
    process.env.SECRETS_RELEASE_VMPL = "2";
    const tv = await ticketFor(A), rv = await release(A, tv.body.ticket, guest({ id: A, ticket: tv.body.ticket }));
    process.env.SECRETS_RELEASE_VMPL = "0";
    assert.equal(rv.code, 403); assert.match(rv.body.message, /states VMPL 0, not the pinned 2/); assert.equal(rv.body.sealed, undefined);
    // a zero (masked) CHIP_ID in the report: refused even though the stub verifier passed it
    const t = await ticketFor(A), g = guest({ id: A, ticket: t.body.ticket });
    const rep = Buffer.from(g.evidence.report, "base64"); rep.fill(0, 0x1a0, 0x1e0); g.evidence.report = rep.toString("base64");
    const r = await release(A, t.body.ticket, g);
    assert.equal(r.code, 403); assert.match(r.body.message, /CHIP_ID is zero/); assert.equal(r.body.sealed, undefined);
  } finally { ctx.verifyGuestEvidence = real; }
});

test("provenSnpChip: a CHIP_ID counts only from a VCEK-verified, VCEK-signed report with a non-zero chip", async () => {
  const { provenSnpChip } = await import("../relay/snp-verify.mjs");
  const rep = synthReport(S, { reportData: Buffer.alloc(64) });
  assert.equal(provenSnpChip(rep, { ok: true, vcekVerified: true }), S.chip.toString("hex"));
  assert.equal(provenSnpChip(rep, { ok: true, vcekVerified: false }), null, "measurement-only: the signature was never checked against the chip");
  assert.equal(provenSnpChip(rep, { ok: false, vcekVerified: true }), null);
  const vlek = Buffer.from(rep); vlek.writeUInt32LE(1 << 2, 0x48);
  assert.equal(provenSnpChip(vlek, { ok: true, vcekVerified: true }), null, "VLEK-signed: the CHIP_ID does not name the signer's chip");
  const masked = Buffer.from(rep); masked.fill(0, 0x1a0, 0x1e0);
  assert.equal(provenSnpChip(masked, { ok: true, vcekVerified: true }), null, "a masked (zero) CHIP_ID");
});

test("the guest's own vectors (enclave-5d, isolation/app-config-m1 0e9a6f08): this side reproduces its binding and opens its seal", () => {
  const v = JSON.parse(fs.readFileSync(new URL("./fixtures/secrets-release-guest-vectors.json", import.meta.url)));
  const i = v.inputs, hx = (x) => Buffer.from(x, "hex");
  const sealKey = R.rawPublicOf(R.x25519PrivateKey(hx(i.sealPrivateHex)));
  assert.equal(sealKey.toString("hex"), v.outputs.sealKeyHex);
  assert.equal(R.rawPublicOf(R.x25519PrivateKey(hx(i.ephPrivateHex))).toString("hex"), v.outputs.ephPublicHex);
  assert.equal(R.releaseBinding({ id: i.id, transportSpki: hx(i.transportSpkiHex), ticket: hx(i.ticketHex), runtimeId: hx(i.runtimeIdHex), sealKey }).toString("hex"), v.outputs.bindingHex);
  assert.equal(R.openRelease({ id: i.id, ticket: hx(i.ticketHex), sealPrivateKey: hx(i.sealPrivateHex), sealed: hx(v.outputs.sealedHex) }).toString(), i.plaintext);
  assert.equal(R.sealRelease({ id: i.id, ticket: hx(i.ticketHex), sealKey, plaintext: i.plaintext, _ephPrivate: hx(i.ephPrivateHex), _iv: hx(i.ivHex) }).toString("hex"), v.outputs.sealedHex);
  assert.equal(typeof JSON.parse(i.plaintext).issuedAt, "string", "issuedAt is an ISO-8601 string");
});

test("snpChipsAfter: a chip set lives only across a same-key re-attach of a still-registered tunnel", async () => {
  const { snpChipsAfter } = await import("../relay/tunnel.js");
  const X = "11".repeat(64), Y = "22".repeat(64);
  assert.deepEqual(snpChipsAfter(undefined, { keyFp: "k1", snpChip: X }), [X], "a first attach");
  assert.deepEqual(snpChipsAfter({ keyFp: "k1", snpChips: [X] }, { keyFp: "k1", snpChip: Y }), [X, Y], "same key: the other socket's chip joins");
  assert.deepEqual(snpChipsAfter({ keyFp: "k1", snpChips: [X] }, { keyFp: "k1", snpChip: X }), [X], "no duplicates");
  assert.deepEqual(snpChipsAfter({ keyFp: "k1", snpChips: [X] }, { keyFp: "k2", snpChip: Y }), [Y], "a new key (a new boot) starts over");
  assert.deepEqual(snpChipsAfter({ keyFp: "k1", snpChips: [X] }, { keyFp: "k2" }), [], "a new key with no proven chip has none");
  assert.deepEqual(snpChipsAfter({ keyFp: "", snpChips: [X] }, { keyFp: "", snpChip: Y }), [Y], "no key fingerprint: never carried");
  assert.deepEqual(snpChipsAfter(undefined, { keyFp: "k1" }), [], "a measurement-only attach proves none");
});

test("config parity with the tier: the envelope decides when it names either, else the version; within a source a configCid wins over the inline field (the manager's rule); always a JSON value", async () => {
  ineligible = false; chips = [S.chip.toString("hex")];
  const releaseC = async (envelope, version) => {
    envelopes[C] = envelope; versions[C] = version; rows = [leaseRow(C)];
    const t = await ticketFor(C), g = guest({ id: C, ticket: t.body.ticket });
    const r = await release(C, t.body.ticket, g);
    return { r, config: r.code === 200 ? opened(C, t.body.ticket, g, r).config : undefined };
  };
  const cases = [
    ["the version's config text, parsed to a value", "", { config: '{"fromVersion":1}' }, { fromVersion: 1 }],
    ["the version's config as an object", JSON.stringify({ isolation: { require: "snp-guest-per-app" } }), { config: { v: [1, 2] } }, { v: [1, 2] }],
    ["the version's configCid, fetched as TEXT and parsed", "", { configCid: "bafkreiversioncid" }, { fromVersionCid: true }],
    ["the envelope's config wins over the version's", JSON.stringify({ config: { mine: true } }), { config: '{"fromVersion":1}' }, { mine: true }],
    ["the envelope's configCid wins over the version's", JSON.stringify({ configCid: "bafkreisyntheticcid" }), { config: '{"fromVersion":1}' }, { resolved: true, key: "${JOT_API_KEY}" }],
    ["a rev-7 large-config version: the inline field is the routing manifest, the configCid is the config", "", { config: '{"wasi":"p2"}', configCid: "bafkreiversioncid" }, { fromVersionCid: true }],
    ["an envelope naming both: its configCid wins, as in the manager (the inline field is the routing manifest)", JSON.stringify({ config: { volumes: [] }, configCid: "bafkreisyntheticcid" }), { config: '{"fromVersion":1}' }, { resolved: true, key: "${JOT_API_KEY}" }],
    ["an envelope naming only config overrides the version's configCid", JSON.stringify({ config: { mine: 2 } }), { configCid: "bafkreiversioncid" }, { mine: 2 }],
    ["no config anywhere: null", "", null, null],
    ["a version with an empty config: null", "", { config: "" }, null],
  ];
  for (const [label, env, ver, want] of cases) {
    const { r, config } = await releaseC(env, ver);
    assert.equal(r.code, 200, `${label}: ${JSON.stringify(r.body)}`); assert.deepEqual(config, want, label);
  }
  // a config that is a JSON STRING (the app would get one quoted string) or not JSON: refused, nothing released
  // envelope shapes the supervisor's parseDepOptions refuses are refused here too, by key PRESENCE (enclave-d1's A1)
  for (const [label, env] of [["an envelope config that is a string", JSON.stringify({ config: "text" })],
                              ["an empty configCid beside a manifest (would have released the manifest)", JSON.stringify({ configCid: "", config: { volumes: [] } })],
                              ["a null configCid", JSON.stringify({ configCid: null })],
                              ["a numeric configCid", JSON.stringify({ configCid: 123 })],
                              ["a config carrying _media", JSON.stringify({ config: { _media: { icon: "x" }, a: 1 } })],
                              ["an app key beside a configCid (the guest would never receive it)", JSON.stringify({ configCid: "bafkreisyntheticcid", config: { lab: 1 } })],
                              ["an array config", JSON.stringify({ config: [1] })]]) {
    const { r } = await releaseC(env, null);
    assert.equal(r.code, 422, `${label}: ${JSON.stringify(r.body)}`); assert.equal(r.body.error, "bad_envelope", label); assert.equal(r.body.sealed, undefined, label);
  }
  for (const [label, env, ver] of [["a version configCid that is not a bare CID", "", { configCid: "ipfs://x" }],
                                   ["a version config text that is a JSON string", "", { config: '"text"' }],
                                   ["a version config that is not JSON", "", { config: "not json" }],
                                   ["a version config that is a number", "", { config: "42" }]]) {
    const { r } = await releaseC(env, ver);
    assert.equal(r.code, 422, `${label}: ${JSON.stringify(r.body)}`); assert.equal(r.body.error, "bad_config", label); assert.equal(r.body.sealed, undefined, label);
  }
  // a version configCid that does not resolve: nothing rather than a partial answer
  const { r } = await releaseC("", { configCid: "bafkreinothere" });
  assert.equal(r.code, 503); assert.equal(r.body.error, "config_unresolvable");
});

test("release-status: public, listed only by SECRETS_RELEASE_DEPLOYMENTS; 503 (not listed) while off or unconfigured", async () => {
  const status = async (id) => { const res = {}; await handleSecrets({ method: "GET" }, res, new URL(`http://x/v1/secrets/release-status?id=${id}`), ctx); return res; };
  const saved = process.env.SECRETS_RELEASE_DEPLOYMENTS;
  try {
    process.env.SECRETS_RELEASE_DEPLOYMENTS = "*";
    assert.deepEqual((await status(A.toUpperCase().replace("0X", "0x"))).body, { id: A, listed: true });
    process.env.SECRETS_RELEASE_DEPLOYMENTS = `${B},${C}`;
    assert.deepEqual((await status(A)).body, { id: A, listed: false });
    assert.deepEqual((await status(C)).body, { id: C, listed: true });
    assert.equal((await status("0x1234")).code, 422);
    process.env.SECRETS_ATTESTED_RELEASE = "";
    const off = await status(C);
    assert.equal(off.code, 503); assert.equal(off.body.error, "release_off"); assert.equal(off.body.listed, undefined);
    process.env.SECRETS_ATTESTED_RELEASE = "1";
    ctx.predictorProblems = () => ["SECRETS_RELEASE_PREDICT_COMMIT"];
    const unc = await status(C);
    assert.equal(unc.code, 503); assert.doesNotMatch(JSON.stringify(unc.body), /PREDICT/, "a public answer does not name the relay's configuration");
    delete ctx.predictorProblems;
    // any other GET is still refused
    const res = {}; await handleSecrets({ method: "GET" }, res, new URL("http://x/v1/secrets/release?id=" + A), ctx);
    assert.equal(res.code, 405);
  } finally { process.env.SECRETS_RELEASE_DEPLOYMENTS = saved; process.env.SECRETS_ATTESTED_RELEASE = "1"; }
});

test("the signing seed from its own file (SECRETS_RELEASE_SIGNING_KEY_FILE): owner-only, one of the two variables, never another key", async () => {
  rows = [leaseRow(A)]; ineligible = false; chips = [S.chip.toString("hex")];
  const saved = { k: process.env.SECRETS_RELEASE_SIGNING_KEY, f: process.env.SECRETS_RELEASE_SIGNING_KEY_FILE };
  const f = path.join(DIR, "release-signing.seed");
  try {
    delete process.env.SECRETS_RELEASE_SIGNING_KEY;
    fs.writeFileSync(f, "7c".repeat(32) + "\n", { mode: 0o600 }); fs.chmodSync(f, 0o600);
    process.env.SECRETS_RELEASE_SIGNING_KEY_FILE = f;
    const t = await ticketFor(A), g = guest({ id: A, ticket: t.body.ticket }), r = await release(A, t.body.ticket, g);
    assert.equal(r.code, 200, JSON.stringify(r.body));
    const pub = R.ed25519RawPublic(R.signingKeyFromSeed(Buffer.alloc(32, 0x7c)));
    assert.equal(r.body.keyId, R.keyIdOf(pub), "signed with the file's key");
    const refusedWith = async (why) => { const x = await ticketFor(A); assert.equal(x.code, 503, why); assert.match(x.body.message, /SECRETS_RELEASE_SIGNING_KEY/, why); };
    fs.chmodSync(f, 0o644); await refusedWith("a group/world-readable seed file");
    fs.chmodSync(f, 0o600);
    process.env.SECRETS_RELEASE_SIGNING_KEY = "5a".repeat(32); await refusedWith("both variables set");
    delete process.env.SECRETS_RELEASE_SIGNING_KEY;
    fs.writeFileSync(f, "not hex\n"); await refusedWith("a malformed seed file");
    fs.writeFileSync(f, process.env.SECRETS_KEY + "\n"); await refusedWith("a seed file equal to SECRETS_KEY");
    process.env.SECRETS_RELEASE_SIGNING_KEY_FILE = path.join(DIR, "no-such-file"); await refusedWith("a missing seed file");
  } finally {
    if (saved.f === undefined) delete process.env.SECRETS_RELEASE_SIGNING_KEY_FILE; else process.env.SECRETS_RELEASE_SIGNING_KEY_FILE = saved.f;
    process.env.SECRETS_RELEASE_SIGNING_KEY = saved.k;
  }
});

test("the relay's VENDORED verifier (relay/vendor, verifyGuestDomainEvidence) judges a release document exactly as verifyEvidence", async () => {
  const bundle = await import("../relay/vendor/enclave-verifier-node.mjs");
  assert.equal(typeof bundle.verifyGuestDomainEvidence, "function", "the vendored bundle exports the guest-domain verifier");
  const ticket = Buffer.alloc(32, 0x3c).toString("base64"), t = Buffer.from(ticket, "base64");
  const judge = async (g, over = {}) => {
    const binding = R.releaseBinding({ id: A, transportSpki: Buffer.from(g.evidence.transportKey, "base64"), ticket: t, runtimeId: RID, sealKey: g.sealKey });
    const opts = { policy: { snp: { roots: new Map([["Genoa", S.arkFp]]), allowedMeasurements: ["77".repeat(48)], minTcb: FLOOR, expectedVmpl: 0 } },
                   context: { transportKeySpki: Buffer.from(g.evidence.transportKey, "base64"), expectedBinding: binding, expectedAppId: APP, expectedHostData: R.idBytes(A),
                              now: new Date().toISOString(), ...over }, collateral: synthCol };
    const [a, b] = [await verifyEvidence(g.evidence, opts), await bundle.verifyGuestDomainEvidence(g.evidence, opts)];
    return { a, b };
  };
  const cases = [
    ["the honest guest", guest({ id: A, ticket }), {}, "verified"],
    ["another deployment's HOST_DATA", guest({ id: A, ticket, hostData: B }), {}, "rejected"],
    ["another app", guest({ id: A, ticket, appId: sha(Buffer.from("x")) }), {}, "rejected"],
    ["Bind2 over the ticket", guest({ id: A, ticket, binding: ({ transport, t: tk }) => sha(Buffer.from("enclave-bind-v2\n"), transport, tk, RID) }), {}, "rejected"],
    ["DEBUG allowed", guest({ id: A, ticket, debug: true }), {}, "rejected"],
  ];
  for (const [label, g, over, want] of cases) {
    const { a, b } = await judge(g, over);
    assert.equal(a.status, want, `${label}: verifyEvidence ${a.status} ${a.reasons.at(-1)}`);
    assert.equal(b.status, a.status, `${label}: the vendored verdict ${b.status} (${b.reasons.at(-1)}) equals verifyEvidence's`);
    assert.deepEqual(b.checks, a.checks, `${label}: the same checks`);
  }
  // not a release document: unsupported, never green
  const other = await bundle.verifyGuestDomainEvidence({ format: "sev-snp-tinfoil-hosted-v1", report: "AAAA" }, {});
  assert.notEqual(other.status, "verified"); assert.equal(other.admissionSafe, false);
});

test("rate keys: a ticket request by client IP; a release by its ticket's ENDPOINT (many guests behind one host address); an unknown ticket by IP", async () => {
  rows = [leaseRow(A)]; ineligible = false; chips = [S.chip.toString("hex")];
  const keys = [], rate = (k) => { keys.push(k); return true; };
  const t = await ticketFor(A);
  const g = guest({ id: A, ticket: t.body.ticket });
  const res = {};
  await R.handleRelease("/v1/secrets/release", { id: A, ticket: t.body.ticket, sealKey: g.sealKey.toString("base64"), evidence: g.evidence }, {}, res, ctx,
                        { envOf: () => ({}), bad: (code, error) => { res.code = code; res.body = { error }; }, rate });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  await R.handleRelease("/v1/secrets/release", { id: A, ticket: Buffer.alloc(32, 9).toString("base64") }, {}, {}, ctx, { envOf: () => ({}), bad: () => {}, rate });
  await R.handleRelease("/v1/secrets/release-ticket", { id: A }, {}, {}, ctx, { envOf: () => ({}), bad: () => {}, rate });
  assert.deepEqual(keys, [`ep:${EP}`, "ip:203.0.113.9", "ip:203.0.113.9"]);
});
