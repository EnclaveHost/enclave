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
  SECRETS_RELEASE_MEASUREMENTS: "77".repeat(48), SECRETS_RELEASE_RUNTIME_IDS: RID.toString("hex"),
  SECRETS_RELEASE_BURST: "1000",      // the suite asks far more often than a real guest may
  SECRETS_RELEASE_MIN_TCB: JSON.stringify({ Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }), SECRETS_RELEASE_VMPL: "0" });
const { initSecrets, handleSecrets, applyPut } = await import("../relay/secrets.js");
const R = await import("../relay/secrets-release.mjs");
await initSecrets();

const OP = privateKeyToAccount(generatePrivateKey()), STRANGER = privateKeyToAccount(generatePrivateKey());
const A = "0x" + "a1".repeat(32), B = "0x" + "b2".repeat(32);            // two deployments of the SAME app
const APP = sha(Buffer.from("the app both deployments run"));
const EP = "https://api.enclave.host/t/metal-iso0", EP_ID = "0x" + "e0".repeat(32);
const synthCol = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
const FLOOR = { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } };
let rows = [], ineligible = false, chips = [S.chip.toString("hex")];
const envelopes = { [A]: JSON.stringify({ isolation: { require: "snp-guest-per-app" }, config: { endpoint: "$IMAGE_ENDPOINT", n: 1 } }),
                    [B]: JSON.stringify({ isolation: { require: "snp-guest-per-app" }, configCid: "bafkreisyntheticcid" }) };
const leaseRow = (id, over = {}) => ({ id, owner: STRANGER.address, runner: EP_ID, configCid: envelopes[id],
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
  appIdFor: async (id) => (id === A || id === B ? APP : null),
  resolveConfigCid: async (cid) => (cid === "bafkreisyntheticcid" ? { resolved: true, key: "${JOT_API_KEY}" } : null),
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
  const t = await ticketFor(A);
  assert.equal(t.code, 200, JSON.stringify(t.body));
  const g = guest({ id: A, ticket: t.body.ticket });
  const r = await release(A, t.body.ticket, g);
  assert.equal(r.code, 200, JSON.stringify(r.body));
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
  await refused("a measurement outside the allowlist", async (tk) => { process.env.SECRETS_RELEASE_MEASUREMENTS = "66".repeat(48); return { g: guest({ id: A, ticket: tk }) }; }, E);
  process.env.SECRETS_RELEASE_MEASUREMENTS = "77".repeat(48);
  await refused("a report from another VMPL than the pinned one", async (tk) => { process.env.SECRETS_RELEASE_VMPL = "1"; return { g: guest({ id: A, ticket: tk }) }; }, E);
  process.env.SECRETS_RELEASE_VMPL = "0";
  await refused("a DEBUG-enabled guest policy", (tk) => ({ g: guest({ id: A, ticket: tk, debug: true }) }), E);
  await refused("a release document that states a nonce", (tk) => { const g = guest({ id: A, ticket: tk }); g.evidence.nonce = "00".repeat(32); return { g }; }, { code: 422, error: "bad_evidence", why: /must not state a nonce/ });
  await refused("a low-order seal key", (tk) => ({ g: guest({ id: A, ticket: tk, sealPriv: null, binding: ({ transport, t }) => R.releaseBinding({ id: A, transportSpki: transport, ticket: t, runtimeId: RID, sealKey: Buffer.alloc(32) }) }), over: { sealKey: Buffer.alloc(32).toString("base64") } }), { code: 422, error: "bad_seal_key" });
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
  for (const [k, v] of [["SECRETS_ATTESTED_RELEASE", ""], ["SECRETS_RELEASE_MEASUREMENTS", ""], ["SECRETS_RELEASE_RUNTIME_IDS", "zz"],
                        ["SECRETS_RELEASE_MIN_TCB", ""], ["SECRETS_RELEASE_MIN_TCB", "{}"], ["SECRETS_RELEASE_VMPL", ""], ["SECRETS_RELEASE_VMPL", "4"]]) {
    process.env[k] = v;
    const r = await ticketFor(A);
    assert.equal(r.code, 503, `${k}=${v}`); assert.equal(r.body.error, "release_unconfigured"); assert.match(r.body.message, new RegExp(k));
    Object.assign(process.env, saved);
  }
  for (const p of ["verifyGuestEvidence", "appIdFor", "runtimeIdOf", "leaseHolderChipIds"]) {
    const keep = ctx[p]; delete ctx[p];
    const r = await ticketFor(A);
    assert.equal(r.code, 503, p); assert.equal(r.body.error, "release_unconfigured");
    ctx[p] = keep;
  }
  const t = await ticketFor(A);
  R._internals.tickets.get(t.body.ticket).exp = Math.floor(Date.now() / 1000) - 1;
  const r = await release(A, t.body.ticket, guest({ id: A, ticket: t.body.ticket }));
  assert.equal(r.code, 403); assert.equal(r.body.error, "bad_ticket");
  // a deployment whose configCid does not resolve gets nothing rather than a partial answer
  rows = [leaseRow(B, { configCid: JSON.stringify({ configCid: "bafkreiunknown" }) })];
  const tb = await ticketFor(B), rb = await release(B, tb.body.ticket, guest({ id: B, ticket: tb.body.ticket }));
  assert.equal(rb.code, 503); assert.equal(rb.body.error, "config_unresolvable"); assert.equal(rb.body.sealed, undefined);
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
