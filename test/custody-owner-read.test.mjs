// Custody v2 OWNER READ (custody/v2/custodian.mjs ownerRead, http.mjs, chain.mjs readOwnerRead, protocol.mjs
// ownerReadBinding; custody/v2/owner-secrets.mjs, the shared client): against the REAL vault on anvil and REAL custodians
// behind the real router (test/helpers/owner-read-rig.mjs). Owners: an EOA and an ERC-1271 contract. Synthetic: no SEV-SNP
// hardware; the custodians run in-process.   run: node --test --test-concurrency=1 test/custody-owner-read.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as v2 from "../custody/v2/protocol.mjs";
import * as hpke from "../custody/hpke.mjs";
import { VAULT_V2_ABI } from "../custody/v2/chain.mjs";
import { UPDATE_V2_ABI, updateTypedDataV2 } from "../custody/v2/owner.mjs";
import { configSha256 } from "../custody/protocol.mjs";
import { canonicalRules, parseRules, validateRules, ownerReadAllowed } from "../custody/rules.mjs";
import { SHIELD_RULES_FORMAT, SHIELD_TIER_ACK, canonicalShieldRules, parseShieldRules } from "../custody/v2/shield-rules.mjs";
import { readOwnerSecrets, planSecretsEdit, ownerEditUpdate, policyRulesOf } from "../custody/v2/owner-secrets.mjs";
import { createCustodyRouter } from "../custody/v2/http.mjs";
import { directCustodyIngress } from "../custody/v2/ingress.mjs";
import { ownerReadWorld, haveAnvil, CHAIN } from "./helpers/owner-read-rig.mjs";
import http from "node:http";

const options = { skip: !haveAnvil && "needs Foundry's anvil", timeout: 240000 };
let W;
before(async () => { if (haveAnvil) W = await ownerReadWorld(); });
after(() => W?.stop());

const SNP = (over = {}) => ({ v: 1, appId: "a7".repeat(32), images: [{ platform: "sev-snp", measurement: "77".repeat(48), runtimeId: "cd".repeat(32) }],
                             minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0, ...over });
const SHIELD = (over = {}) => ({ format: SHIELD_RULES_FORMAT, acceptTier: SHIELD_TIER_ACK, appId: "a8".repeat(32), images: [{ measurement: "6a".repeat(32), runtimeId: "cd".repeat(32) }],
                                 platforms: "attested", ...over });
const ZERO32 = "0x" + "00".repeat(32);
const policyOf = async (id) => { const [owner, policyRev, secretRev, committeeId, paused, rules] = await W.pub.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "policyOf", args: [id] });
  const [, , data] = await W.pub.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "bundleOf", args: [id] });
  return { owner: owner.toLowerCase(), policyRev, secretRev, committeeId: committeeId.toLowerCase(), paused, rules, data }; };
const committeeOf = async (cid) => { const [Y, epoch, t] = await W.pub.readContract({ address: W.vault, abi: VAULT_V2_ABI, functionName: "committeeOf", args: [cid] }); return { Y: hexToBytes(Y), epoch: Number(epoch), t: Number(t) }; };
/** a policy with these rules and values, written by the owner (EOA) or, for a contract owner, by updateBySig + a payer */
async function writePolicy(id, { owner, rulesBytes, env = { API_KEY: "s3cret", DB: "postgres://x" }, cid = W.indCid, signer = null, payer = null, paused = false }) {
  const p = await policyOf(id), c = await committeeOf(cid), secretRev = p.secretRev + 1n;
  const bundle = v2.encryptBundle({ Y: c.Y, label: v2.labelOf({ chainId: CHAIN, vault: W.vault, id, secretRev, committeeId: cid }), env, configSha256: configSha256("") });
  const u = { expectPolicyRev: p.policyRev, setPolicy: true, committeeId: cid, paused, rules: bytesToHex(rulesBytes), setBundle: true, bundle: bytesToHex(bundle), clear: false };
  if (!signer) return W.send(owner, W.vault, UPDATE_V2_ABI, "update", [id, u]);
  const block = await W.pub.getBlock(), deadline = block.timestamp + 600n;
  const sig = await signer.signTypedData(updateTypedDataV2({ chainId: CHAIN, vault: W.vault, id, update: u, deadline }));
  return W.send(payer, W.vault, UPDATE_V2_ABI, "updateBySig", [id, u, deadline, sig]);
}
/** the agreed state the client reads with (the custody/v2 reader over the CLI's quorum) */
let Q = null;
const stateOf = async (id) => (Q ||= await W.quorum()).reader.readRelease({ id, endpoint: null });
/** a RAW owner-read request (no client-side mirrors), signed by `signer`, so the CUSTODIANS' refusals are what is tested */
async function rawRequest(id, signer, { cid = W.indCid, policyRev, secretRev, epoch, expirySec = 120, machines = W.custodians } = {}) {
  const p = await policyOf(id), c = await committeeOf(cid);
  const chs = [];
  for (const m of machines) { const r = await W.post(m.endpoint + "/v2/custody/owner-read/challenge", {}); chs.push({ encKey: hexToBytes("0x" + r.encKey), nonce: hexToBytes("0x" + r.nonce), m }); }
  const kp = hpke.generateKeyPair(), expiry = Math.floor(W.now() / 1000) + expirySec;
  const fields = { chainId: CHAIN, vault: W.vault, id, policyRev: policyRev ?? p.policyRev, secretRev: secretRev ?? p.secretRev, committeeId: cid, epoch: epoch ?? c.epoch,
                   challenges: chs.map((x) => ({ encKey: x.encKey, nonce: x.nonce })), recipientKey: kp.publicKey, expiry };
  const sig = await signer.signTypedData(v2.ownerReadTypedData(fields));
  const req = { v: 2, purpose: v2.OWNER_READ_PURPOSE, id, committeeId: cid, epoch: fields.epoch, policyRev: String(fields.policyRev), secretRev: String(fields.secretRev),
                recipientKey: bytesToHex(kp.publicKey).slice(2), expiry, sig, challenges: chs.map((x) => ({ encKey: bytesToHex(x.encKey).slice(2), nonce: bytesToHex(x.nonce).slice(2) })) };
  return { req, kp, fields, chs };
}
const refusedBy = async (endpoint, req, code) => assert.rejects(W.post(endpoint + "/v2/custody/owner-read", req), (e) => e.code === code || assert.fail(`expected ${code}, got ${e.message}`));
const ownerOf = (a) => ({ address: a.address, signTypedData: (t) => a.signTypedData(t) });

// ---- unit --------------------------------------------------------------------------------------------------------------
test("rules: ownerRead is an explicit opt-in; old SNP and Shield rule bytes parse and encode exactly as before; other keys still refused", () => {
  const oldSnp = canonicalRules(SNP()), oldShield = canonicalShieldRules(SHIELD());
  assert.equal(new TextDecoder().decode(oldSnp).includes("ownerRead"), false);
  assert.deepEqual(canonicalRules(parseRules(oldSnp)), oldSnp, "old SNP bytes round-trip unchanged");
  assert.deepEqual(canonicalShieldRules(parseShieldRules(oldShield)), oldShield);
  assert.equal(ownerReadAllowed(parseRules(oldSnp)), false, "missing means false");
  assert.equal(ownerReadAllowed(parseShieldRules(oldShield)), false);
  assert.equal(ownerReadAllowed(validateRules(SNP({ ownerRead: false }))), false);
  assert.equal(ownerReadAllowed(validateRules(SNP({ ownerRead: true }))), true);
  assert.equal(policyRulesOf(canonicalShieldRules(SHIELD({ ownerRead: true }))).ownerRead, true);
  for (const bad of [SNP({ ownerRead: "true" }), SNP({ ownerRead: 1 }), SNP({ owner: true })]) assert.throws(() => validateRules(bad));
  assert.throws(() => canonicalShieldRules(SHIELD({ ownerRead: "yes" })), /ownerRead/);
  assert.throws(() => canonicalShieldRules(SHIELD({ extra: 1 })), /unknown key/);
});

test("protocol: the owner-read binding is a different domain from a guest release binding, over the same fields", () => {
  const ch = [{ encKey: new Uint8Array(32).fill(1), nonce: new Uint8Array(32).fill(2) }];
  const f = { chainId: CHAIN, vault: "0x" + "56".repeat(20), id: "0x" + "e7".repeat(32), policyRev: 1n, secretRev: 1n, committeeId: "0x" + "cc".repeat(32), epoch: 1, challenges: ch,
              recipientKey: new Uint8Array(32).fill(3), expiry: 100 };
  const o = v2.ownerReadBinding(f), r = v2.releaseBinding({ ...f, runtimeId: new Uint8Array(32), transportSpki: new Uint8Array(40) });
  assert.notDeepEqual(o, r);
  assert.notDeepEqual(v2.ownerReadBinding({ ...f, expiry: 101 }), o, "the expiry is bound");
  assert.notDeepEqual(v2.ownerReadBinding({ ...f, recipientKey: new Uint8Array(32).fill(4) }), o, "the recipient is bound");
  assert.equal(v2.ownerReadTypedData(f).primaryType, "OwnerRead");
  assert.deepEqual(planSecretsEdit({ op: "set", current: { A: "1", B: "2" }, pairs: { B: "3", C: "4" } }), { A: "1", B: "3", C: "4" });
  assert.deepEqual(planSecretsEdit({ op: "rm", current: { A: "1", B: "2" }, keys: ["A"] }), { B: "2" });
  assert.throws(() => planSecretsEdit({ op: "rm", current: { A: "1" }, keys: ["Z"] }), /not stored: Z/);
  assert.deepEqual(planSecretsEdit({ op: "clear", current: { A: "1" } }), {});
});

// ---- against real custodians --------------------------------------------------------------------------------------------
test("an EOA owner reads exactly the stored values from the real custodians; a captured request and answers do not open without the ephemeral key; a replay is refused", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner);
  await writePolicy(id, { owner, rulesBytes: canonicalRules(SNP({ ownerRead: true })) });
  const st = await stateOf(id);
  const r = await readOwnerSecrets({ chainId: CHAIN, vault: W.vault, id, state: st, owner: ownerOf(owner), post: W.post, now: W.now });
  assert.deepEqual(r.env, { API_KEY: "s3cret", DB: "postgres://x" }); assert.deepEqual(r.names, ["API_KEY", "DB"]);
  assert.equal(r.configSha256, configSha256("")); assert.equal(r.answered >= 2, true);
  // an observer with the signed request and every sealed answer, but not the client's ephemeral private key
  const { req, kp, fields } = await rawRequest(id, owner);
  const ans = await W.post(W.custodians[0].endpoint + "/v2/custody/owner-read", req);
  const binding = v2.ownerReadBinding(fields);
  const other = hpke.generateKeyPair();
  assert.throws(() => v2.openPartials({ recipientPrivate: other.privateKey, binding, encKey: hexToBytes("0x" + ans.encKey), count: ans.count, sealed: Buffer.from(ans.sealed, "base64") }));
  assert.equal(v2.openPartials({ recipientPrivate: kp.privateKey, binding, encKey: hexToBytes("0x" + ans.encKey), count: ans.count, sealed: Buffer.from(ans.sealed, "base64") }).length, 1);
  // the same request again: this custodian's challenge is spent
  await refusedBy(W.custodians[0].endpoint, req, "bad_challenge");
  // the request with another recipient key (an attacker's): the owner never signed that
  await refusedBy(W.custodians[1].endpoint, { ...req, recipientKey: bytesToHex(other.publicKey).slice(2) }, "owner_sig");
});

test("ownerRead missing or false: every custodian refuses, whatever the client does; the same old rules bytes stay valid policy", options, async () => {
  for (const rulesBytes of [canonicalRules(SNP()), canonicalRules(SNP({ ownerRead: false })), canonicalShieldRules(SHIELD())]) {
    const owner = await W.acct(), id = await W.dep(owner);
    await writePolicy(id, { owner, rulesBytes });
    assert.deepEqual((await policyOf(id)).rules, bytesToHex(rulesBytes), "the vault holds the old bytes unchanged");
    const { req } = await rawRequest(id, owner);
    await refusedBy(W.custodians[0].endpoint, req, "owner_read_disabled");
    await assert.rejects(readOwnerSecrets({ chainId: CHAIN, vault: W.vault, id, state: await stateOf(id), owner: ownerOf(owner), post: W.post, now: W.now }), /do not allow an owner read/);
  }
  // Shield rules that opt in are read like SNP ones (the tier is the owner's, unchanged)
  const owner = await W.acct(), id = await W.dep(owner);
  await writePolicy(id, { owner, rulesBytes: canonicalShieldRules(SHIELD({ ownerRead: true })), env: { T: "shield" } });
  assert.deepEqual((await readOwnerSecrets({ chainId: CHAIN, vault: W.vault, id, state: await stateOf(id), owner: ownerOf(owner), post: W.post, now: W.now })).env, { T: "shield" });
});

test("an ERC-1271 contract owner reads with its signer's signature; another key's signature is refused", options, async () => {
  const signer = await W.acct(), payer = await W.acct(), stranger = await W.acct();
  const contract = await W.contractOwner(signer), id = await W.dep(contract);
  await writePolicy(id, { owner: null, signer, payer, rulesBytes: canonicalRules(SNP({ ownerRead: true })), env: { WALLET: "contract" } });
  assert.equal((await policyOf(id)).owner, contract, "the policy belongs to the contract");
  const r = await readOwnerSecrets({ chainId: CHAIN, vault: W.vault, id, state: await stateOf(id), owner: { address: contract, signTypedData: (t) => signer.signTypedData(t) }, post: W.post, now: W.now });
  assert.deepEqual(r.env, { WALLET: "contract" });
  const { req } = await rawRequest(id, stranger);
  await refusedBy(W.custodians[0].endpoint, req, "owner_sig");
});

test("refused by the custodians: stale revision, another or mixed committee, another epoch, expired challenge, bad expiry, wrong signer, guest fields, paused, transfer", options, async () => {
  const owner = await W.acct(), stranger = await W.acct(), id = await W.dep(owner), e0 = W.custodians[0].endpoint;
  await writePolicy(id, { owner, rulesBytes: canonicalRules(SNP({ ownerRead: true })) });
  const p = await policyOf(id);
  await refusedBy(e0, (await rawRequest(id, owner, { policyRev: p.policyRev - 1n })).req, "stale_revision");
  await refusedBy(e0, (await rawRequest(id, owner, { secretRev: p.secretRev + 1n })).req, "stale_revision");
  await refusedBy(e0, (await rawRequest(id, owner, { cid: W.encCid })).req, "wrong_committee");
  await refusedBy(e0, (await rawRequest(id, owner, { epoch: 2 })).req, "stale_epoch");
  await refusedBy(e0, (await rawRequest(id, stranger)).req, "owner_sig");
  await refusedBy(e0, (await rawRequest(id, owner, { expirySec: 400 })).req, "bad_expiry");
  // challenges from only some machines: one that did not challenge cannot be asked
  const partial = await rawRequest(id, owner, { machines: [W.custodians[0]] });
  await assert.rejects(W.post(W.custodians[1].endpoint + "/v2/custody/owner-read", partial.req), (e) => e.code === "not_challenged");
  // an expired challenge: the custodian's clock passes its 120 s nonce TTL
  const late = await rawRequest(id, owner);
  W.clock.skew = 125_000;
  try { await refusedBy(e0, late.req, "bad_challenge"); } finally { W.clock.skew = 0; }
  // a guest release's fields on an owner read
  const g = await rawRequest(id, owner);
  await assert.rejects(W.post(e0 + "/v2/custody/owner-read", { ...g.req, evidence: {} }), (e) => e.status === 422);
  // paused: the pause guarantee holds for the owner too
  const pz = await rawRequest(id, owner);
  const cur = await policyOf(id);
  await W.send(owner, W.vault, UPDATE_V2_ABI, "update", [id, { expectPolicyRev: cur.policyRev, setPolicy: true, committeeId: W.indCid, paused: true, rules: cur.rules, setBundle: false, bundle: "0x", clear: false }]);
  await refusedBy(e0, (await rawRequest(id, owner)).req, "paused");
  await refusedBy(W.custodians[1].endpoint, pz.req, "stale_revision");          // the request made before the pause is stale too
  await assert.rejects(readOwnerSecrets({ chainId: CHAIN, vault: W.vault, id, state: await stateOf(id), owner: ownerOf(owner), post: W.post, now: W.now }), /paused/);
  // transfer: the ledger gives the deployment to another wallet; neither may read until a claim (which destroys the bundle)
  const id2 = await W.dep(owner);
  await writePolicy(id2, { owner, rulesBytes: canonicalRules(SNP({ ownerRead: true })) });
  const before = await rawRequest(id2, owner);
  await W.setLedgerOwner(id2, stranger.address);
  await refusedBy(e0, before.req, "owner_mismatch");
  await refusedBy(e0, (await rawRequest(id2, stranger)).req, "owner_mismatch");
});

test("purpose separation: a guest release challenge never authorizes an owner read, an owner-read challenge never a release; a release naming a purpose is refused", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner), c0 = W.custodians[0];
  await writePolicy(id, { owner, rulesBytes: canonicalRules(SNP({ ownerRead: true })) });
  // an owner read SIGNED over a guest challenge from this custodian: only the custodian's purpose check refuses it
  const kp = hpke.generateKeyPair(), p = await policyOf(id), expiry = Math.floor(W.now() / 1000) + 60, g2 = await W.post(c0.endpoint + "/v2/custody/challenge", {});
  const fields = { chainId: CHAIN, vault: W.vault, id, policyRev: p.policyRev, secretRev: p.secretRev, committeeId: W.indCid, epoch: 1,
                   challenges: [{ encKey: hexToBytes("0x" + g2.encKey), nonce: hexToBytes("0x" + g2.nonce) }], recipientKey: kp.publicKey, expiry };
  const signed = { v: 2, purpose: v2.OWNER_READ_PURPOSE, id, committeeId: W.indCid, epoch: 1, policyRev: String(p.policyRev), secretRev: String(p.secretRev),
                   recipientKey: bytesToHex(kp.publicKey).slice(2), expiry, sig: await owner.signTypedData(v2.ownerReadTypedData(fields)), challenges: [{ encKey: g2.encKey, nonce: g2.nonce }] };
  await refusedBy(c0.endpoint, signed, "bad_challenge");
  // ...and a signed owner read whose challenge was swapped for a guest one afterwards: refused at the challenge, before the signature
  const g = await W.post(c0.endpoint + "/v2/custody/challenge", {});
  const { req } = await rawRequest(id, owner, { machines: [c0] });
  await refusedBy(c0.endpoint, { ...req, challenges: [{ encKey: g.encKey, nonce: g.nonce }] }, "bad_challenge");
  // a guest release carrying an OWNER-READ challenge (well formed up to the nonce): refused at the challenge
  const o = await W.post(c0.endpoint + "/v2/custody/owner-read/challenge", {});
  const release = { v: 2, id, endpoint: "https://box.example", committeeId: W.indCid, policyRev: String(p.policyRev), secretRev: String(p.secretRev), epoch: 1,
                    recipientKey: "11".repeat(32), challenges: [{ encKey: o.encKey, nonce: o.nonce }], operator: { sig: "0x", expiry: 1 }, evidence: { format: "x" } };
  await assert.rejects(W.post(c0.endpoint + "/v2/custody/release", release), (e) => e.code === "bad_challenge");
  await assert.rejects(W.post(c0.endpoint + "/v2/custody/release", { ...release, purpose: v2.OWNER_READ_PURPOSE }), (e) => e.status === 422 && /names no purpose/.test(e.message));
});

test("lost quorum fails closed; one custodian down still reads (t = 2 of 3)", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner);
  await writePolicy(id, { owner, rulesBytes: canonicalRules(SNP({ ownerRead: true })), env: { Q: "1" } });
  const st = await stateOf(id), read = () => readOwnerSecrets({ chainId: CHAIN, vault: W.vault, id, state: st, owner: ownerOf(owner), post: W.post, now: W.now });
  W.custodians[2].up = false;
  try {
    assert.deepEqual((await read()).env, { Q: "1" });
    W.custodians[1].up = false;
    await assert.rejects(read(), /insufficient custodians: 1 valid share\(s\) of the 2 needed/);
  } finally { for (const c of W.custodians) c.up = true; }
});

test("the edit update is guarded by the exact read revision: two editors never lose each other's change", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner);
  await writePolicy(id, { owner, rulesBytes: canonicalRules(SNP({ ownerRead: true })), env: { A: "1" } });
  const st = await stateOf(id);
  const read = () => readOwnerSecrets({ chainId: CHAIN, vault: W.vault, id, state: st, owner: ownerOf(owner), post: W.post, now: W.now });
  const ra = await read(), rb = await read();                                     // both editors read revision N
  const ea = ownerEditUpdate({ chainId: CHAIN, vault: W.vault, id, read: ra, committee: st.committee, env: planSecretsEdit({ op: "set", current: ra.env, pairs: { B: "2" } }), configSha256: ra.configSha256 });
  const eb = ownerEditUpdate({ chainId: CHAIN, vault: W.vault, id, read: rb, committee: st.committee, env: planSecretsEdit({ op: "set", current: rb.env, pairs: { C: "3" } }), configSha256: rb.configSha256 });
  await W.send(owner, W.vault, UPDATE_V2_ABI, "update", [id, ea.update]);
  await assert.rejects(W.send(owner, W.vault, UPDATE_V2_ABI, "update", [id, eb.update]), /revert|StaleRevision/i, "the second editor's write is refused");
  // the second editor re-reads (revision N+1, with A and B) and re-applies C: nothing is lost
  const rc = await readOwnerSecrets({ chainId: CHAIN, vault: W.vault, id, state: await stateOf(id), owner: ownerOf(owner), post: W.post, now: W.now });
  assert.deepEqual(rc.env, { A: "1", B: "2" });
  const ec = ownerEditUpdate({ chainId: CHAIN, vault: W.vault, id, read: rc, committee: st.committee, env: planSecretsEdit({ op: "set", current: rc.env, pairs: { C: "3" } }), configSha256: rc.configSha256 });
  await W.send(owner, W.vault, UPDATE_V2_ABI, "update", [id, ec.update]);
  assert.deepEqual((await readOwnerSecrets({ chainId: CHAIN, vault: W.vault, id, state: await stateOf(id), owner: ownerOf(owner), post: W.post, now: W.now })).env, { A: "1", B: "2", C: "3" });
});

test("HTTP: a custodian without owner read answers its routes 404; the ingress forwards both routes", options, async () => {
  const c = W.custodians[0].custodian, legacy = { ...c }; delete legacy.ownerRead; delete legacy.ownerChallenge;
  const srv = http.createServer(createCustodyRouter({ custodian: legacy, member: { info: () => ({}) }, runIndependent: async () => ({}), servedCommittee: () => W.indCid, chainId: CHAIN, vault: W.vault }));
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    for (const p of ["/v2/custody/owner-read/challenge", "/v2/custody/owner-read"]) {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: "POST", body: "{}" });
      assert.equal(r.status, 404);
    }
  } finally { srv.closeAllConnections(); srv.close(); }
  const caddy = directCustodyIngress({ endpoint: "https://custody.example", mgmtPort: 8787 });
  assert.match(caddy, /\/v2\/custody\/owner-read\/challenge \/v2\/custody\/owner-read/);
});

test("a lying custodian (a validly sealed but WRONG partial) is caught by the client's DLEQ check; the other two still read", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner);
  await writePolicy(id, { owner, rulesBytes: canonicalRules(SNP({ ownerRead: true })), env: { L: "honest" } });
  const st = await stateOf(id), liar = W.custodians[1];
  const commitments = [st.committee.commitments.subarray(0, 33), st.committee.commitments.subarray(33, 66)];
  const lyingPost = async (u, body) => {
    if (!u.startsWith(liar.endpoint + "/v2/custody/owner-read") || u.endsWith("/challenge")) return W.post(u, body);
    const real = await W.post(u, body);                                     // the honest answer is discarded
    const fields = { chainId: CHAIN, vault: W.vault, id, policyRev: BigInt(body.policyRev), secretRev: BigInt(body.secretRev), committeeId: body.committeeId, epoch: body.epoch,
                     challenges: body.challenges.map((c) => ({ encKey: hexToBytes("0x" + c.encKey), nonce: hexToBytes("0x" + c.nonce) })), recipientKey: hexToBytes("0x" + body.recipientKey), expiry: body.expiry };
    const binding = v2.ownerReadBinding(fields), R = v2.parseBundle(st.bundle.data).R;
    const record = v2.partial({ k: 2, x: W.f(2) + 1n, R, binding, commitments });   // a wrong share, with a proof for it
    return { ...real, count: 1, sealed: Buffer.from(v2.sealPartials({ recipientKey: hexToBytes("0x" + body.recipientKey), binding, encKey: hexToBytes("0x" + real.encKey), records: [record] })).toString("base64") };
  };
  const r = await readOwnerSecrets({ chainId: CHAIN, vault: W.vault, id, state: st, owner: ownerOf(owner), post: lyingPost, now: W.now });
  assert.deepEqual(r.env, { L: "honest" }); assert.equal(r.answered, 2, "the liar's share was not used");
});

/** an owner-read request to ONE custodian, in-process (the router's per-client limit is not what this test is about) */
async function directRequest(c, id, signer) {
  const p = await policyOf(id), com = await committeeOf(W.indCid), ch = c.ownerChallenge({ client: "budget-test" });
  const kp = hpke.generateKeyPair(), expiry = Math.floor(W.now() / 1000) + 120;
  const fields = { chainId: CHAIN, vault: W.vault, id, policyRev: p.policyRev, secretRev: p.secretRev, committeeId: W.indCid, epoch: com.epoch,
                   challenges: [{ encKey: hexToBytes("0x" + ch.encKey), nonce: hexToBytes("0x" + ch.nonce) }], recipientKey: kp.publicKey, expiry };
  const sig = await signer.signTypedData(v2.ownerReadTypedData(fields));
  return { v: 2, purpose: v2.OWNER_READ_PURPOSE, id, committeeId: W.indCid, epoch: com.epoch, policyRev: String(p.policyRev), secretRev: String(p.secretRev),
           recipientKey: bytesToHex(kp.publicKey).slice(2), expiry, sig, challenges: [{ encKey: ch.encKey, nonce: ch.nonce }] };
}

test("the owner-read budget (30 per deployment per 10 minutes) counts only reads the owner signed: a stranger cannot spend it", options, async () => {
  const owner = await W.acct(), stranger = await W.acct(), id = await W.dep(owner);
  await writePolicy(id, { owner, rulesBytes: canonicalRules(SNP({ ownerRead: true })), env: { R: "1" } });
  const c = W.custodians[2].custodian, outcome = async (p) => { try { await p; return "ok"; } catch (e) { return e.code; } };
  for (let i = 0; i < 31; i++) assert.equal(await outcome(c.ownerRead(await directRequest(c, id, stranger))), "owner_sig", `stranger request ${i + 1}`);
  for (let i = 0; i < 30; i++) assert.equal(await outcome(c.ownerRead(await directRequest(c, id, owner))), "ok", `owner read ${i + 1}: the stranger spent none of the budget`);
  assert.equal(await outcome(c.ownerRead(await directRequest(c, id, owner))), "rate_limited", "the owner's 31st read in the window");
  // concurrent reads cannot overshoot it either: 28 spent, then 4 at once -> exactly 2 more
  const other = await W.dep(owner);
  await writePolicy(other, { owner, rulesBytes: canonicalRules(SNP({ ownerRead: true })), env: { R: "2" } });
  for (let i = 0; i < 28; i++) assert.equal(await outcome(c.ownerRead(await directRequest(c, other, owner))), "ok");
  const reqs = []; for (let i = 0; i < 4; i++) reqs.push(await directRequest(c, other, owner));
  const got = await Promise.all(reqs.map((r) => outcome(c.ownerRead(r))));
  assert.deepEqual(got.sort(), ["ok", "ok", "rate_limited", "rate_limited"]);
});

test("high-water: after a chain rollback (an older state than a custodian already saw) the owner read is refused", options, async () => {
  const owner = await W.acct(), id = await W.dep(owner);
  await writePolicy(id, { owner, rulesBytes: canonicalRules(SNP({ ownerRead: true })), env: { H: "1" } });
  const snap = await W.pub.request({ method: "evm_snapshot", params: [] });
  await writePolicy(id, { owner, rulesBytes: canonicalRules(SNP({ ownerRead: true })), env: { H: "2" } });
  const { req } = await rawRequest(id, owner, { machines: [W.custodians[0]] });
  const ok = await W.post(W.custodians[0].endpoint + "/v2/custody/owner-read", req);             // custodian 0 saw revision N+1
  assert.equal(ok.count, 1);
  const head = await W.pub.getBlock();
  await W.pub.request({ method: "evm_revert", params: [snap] });                                // the chain now shows revision N
  for (let i = 0; i < 3; i++) await W.pub.request({ method: "evm_mine", params: [] });
  const old = await rawRequest(id, owner, { machines: [W.custodians[0]] });
  await assert.rejects(W.post(W.custodians[0].endpoint + "/v2/custody/owner-read", old.req), (e) => e.status === 503 && /rollback|older/i.test(e.message) || assert.fail(e.message));
  // a fork that is LONGER than the chain the custodian saw (so the reader's block high-water accepts it) but lacks the
  // latest update: only the custodian's per-deployment revision high-water refuses it
  await W.pub.request({ method: "evm_setNextBlockTimestamp", params: ["0x" + (head.timestamp + 1n).toString(16)] });
  await W.pub.request({ method: "anvil_mine", params: ["0x40", "0x0"] });
  const fork = await W.pub.getBlock();
  assert.ok(fork.number > head.number && fork.timestamp > head.timestamp, `the fork is ahead: ${fork.number}/${fork.timestamp} vs ${head.number}/${head.timestamp}`);
  const forked = await rawRequest(id, owner, { machines: [W.custodians[0]] });
  assert.equal(forked.fields.policyRev, (await policyOf(id)).policyRev, "the request matches the forked chain exactly");
  await assert.rejects(W.post(W.custodians[0].endpoint + "/v2/custody/owner-read", forked.req),
    (e) => e.code === "chain_rollback" && /already seen/.test(e.message) || assert.fail(`${e.code}: ${e.message}`));
});
