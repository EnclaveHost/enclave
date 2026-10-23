// The dashboard's custody v2 owner flow (site/js/core/custody-v2.js) over the COMMITTED vendor bundle
// (site/vendor/custody-v2.js: real v2 encryption, rules, update encoding and reviewed-vault identity checks). The chain is
// a FIXTURE vault (test/helpers/custody-v2-fake-vault.mjs) that applies the contract's update rules to the exact calldata the
// page sends; a stored bundle is opened with the committee's secret as custodians would. These are fixture tests: they say
// nothing about the production vault, committee or relay. The real-browser run is test/custody-v2-dashboard-browser.test.mjs.
//   run: node --test test/custody-v2-dashboard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionData } from "viem";
import { FakeVault, VAULT, BOOK, GENESIS_COMMITTEE, committeeKey, committee, openBundle } from "./helpers/custody-v2-fake-vault.mjs";
import { UPDATE_V2_ABI } from "../custody/v2/owner.mjs";
import { configSha256, configTextFromEnvelope } from "../custody/protocol.mjs";
import { SOURCES, OUT, MANIFEST, buildCustodyV2Vendor } from "../scripts/build-custody-v2-vendor.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// config.js reads storage at import; the page's own fetches are recorded (none may carry a v2 value)
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.CustomEvent = class { constructor(t, o){ this.type = t; this.detail = (o || {}).detail; } };
globalThis.document = { dispatchEvent(){}, addEventListener(){} };
const fetched = [];
globalThis.fetch = async (url, init) => { fetched.push({ url: String(url), body: init && init.body ? String(init.body) : "" }); throw new Error("fixture: no network"); };

const C2 = await import(path.join(REPO, "site/js/core/custody-v2.js"));
const REAL = await import(path.join(REPO, "site/vendor/custody-v2.js"));

const OWNER = "0x" + "0a".repeat(20), OTHER = "0x" + "0b".repeat(20), SAFE = "0x" + "5a".repeat(20);
const ID = "0x" + "d1".repeat(32);
const RPCS = ["https://rpc-a.example", "https://rpc-b.example", "https://rpc-c.example"];
const ENV = { DATABASE_URL: "postgres://dash-user:dash-pass-7Hq@db.example/app", API_TOKEN: "tok_dashboard_" + "q".repeat(24) };
const ENVELOPE = JSON.stringify({ config: { region: "eu" } });
const PREDICTION = { appId: "ab".repeat(32), images: [{ releaseAdmitted: true, measurement: "cd".repeat(48), runtimeId: "ef".repeat(32) }] };

let readerOpts = null;
function rig({ vault = VAULT, book = BOOK, rpcs = RPCS, fake = new FakeVault(), committeeOpts = {} } = {}){
  const key = committeeKey();
  fake.committees.set(GENESIS_COMMITTEE, committee(GENESIS_COMMITTEE, key.Y, committeeOpts));
  fake.ledger.set(ID, { owner: OWNER, envelope: ENVELOPE });
  readerOpts = null;
  C2._setForTests({ lib: { ...REAL, createChainReaderV2: (o) => { readerOpts = o; return fake.reader; } },
                    config: { vault, book, chainId: 8453, rpcs, independent: { state: "off" } }, sleep: async () => {} });
  return { fake, key };
}
const plaintextIn = (s) => Object.values(ENV).some((v) => String(s).includes(v) || String(s).toLowerCase().includes(Buffer.from(v).toString("hex")));
async function rejects(p, code){ await assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; }); }

test("the committed site/vendor/custody-v2.js is exactly a fresh build of custody/v2/browser.mjs from the reviewed SOURCES", async () => {
  const { js, manifest } = await buildCustodyV2Vendor();
  assert.equal(Buffer.compare(fs.readFileSync(OUT), js), 0, "rebuild with: node scripts/build-custody-v2-vendor.mjs");
  assert.equal(fs.readFileSync(MANIFEST, "utf8"), JSON.stringify(manifest, null, 2) + "\n");
  for (const p of Object.keys(manifest.sources)) assert.ok(SOURCES.includes(p), p + " is not a reviewed source");
  assert.ok(!/from\s*["']node:/.test(js.toString("utf8")), "no node: import in a browser bundle");
});

test("vault states: unset (no default vault, nothing read), unreviewed, unreadable, mismatch and verified", async () => {
  // UNSET: the page never falls back to 0xE486 the way the CLI does - no reader is even created
  rig({ vault: "" });
  let s = await C2.vaultState();
  assert.equal(s.state, "unset"); assert.match(s.why, /names no secretVaultV2/);
  assert.equal(readerOpts, null);
  await rejects(C2.saveV2({ id: ID, env: ENV, signer: new FakeVault().wallet(OWNER) }), "vault_unset");
  assert.equal((await C2.statusV2(ID)).policy, null);
  // UNREVIEWED: an arbitrary address, and the reviewed non-production pinned variant
  rig({ vault: "0x" + "77".repeat(20) });
  assert.equal((await C2.vaultState()).state, "unreviewed");
  rig({ vault: "0x56b81b3970a8ac2c52f9874bd2758ede30758228" });
  s = await C2.vaultState(); assert.equal(s.state, "unreviewed"); assert.match(s.why, /non-production/);
  assert.equal(readerOpts, null, "no chain read for an unreviewed vault");
  // UNREADABLE: one RPC is no agreement; an RPC disagreement on the code
  rig({ rpcs: RPCS.slice(0, 1) });
  assert.equal((await C2.vaultState()).state, "unreadable");
  let f = new FakeVault(); f.failIdentity = new Error("rpc quorum: 1 of 3 agree");
  rig({ fake: f }); assert.equal((await C2.vaultState()).state, "unreadable");
  // MISMATCH: other code, another book, the book naming another vault at the agreed block
  f = new FakeVault({ identity: { codeHash: "0x" + "00".repeat(32), runtimeBytes: 19719, book: BOOK, enclaveOwner: "0x0b2d009c0c9af05b12100d77f3c815fea822ee61" } });
  rig({ fake: f }); s = await C2.vaultState(); assert.equal(s.state, "mismatch"); assert.match(s.why, /runtime differs/);
  rig({ book: "0x" + "99".repeat(20) }); assert.equal((await C2.vaultState()).state, "mismatch");
  rig({ fake: new FakeVault({ bookEntry: "0x" + "56".repeat(20) }) }); s = await C2.vaultState();
  assert.equal(s.state, "mismatch"); assert.match(s.why, /book names/);
  rig({ fake: new FakeVault({ bookEntry: "0x" + "00".repeat(20) }) }); assert.equal((await C2.vaultState()).state, "unset");
  // VERIFIED: the reader is the agreed book-kind reader over two-of-three RPCs
  const live = rig().fake; s = await C2.vaultState();
  assert.equal(s.state, "verified"); assert.equal(s.vault, VAULT);
  // the administrator's rollback of the book entry stops v2 at the next call (only the code identity is cached)
  live.bookEntry = "0x" + "00".repeat(20);
  assert.equal((await C2.vaultState()).state, "unset");
  live.bookEntry = VAULT;
  assert.equal(live.calls.filter((c) => c === "identity").length, 1, "the code identity was read once");
  s = await C2.vaultState();
  assert.equal(s.state, "verified");
  assert.deepEqual([readerOpts.vaultKind, readerOpts.book, readerOpts.minAgree, readerOpts.rpcs.length], ["book", BOOK, 2, 3]);
  assert.equal(fetched.length, 0);
});

test("committee status: seats counted as the vault counts them; SINGLE-SEAT only when n = 1, and no claim of independence", () => {
  const Y = committeeKey().Y;
  // the production shape: one Enclave machine, t = 1 of W = 1
  const one = C2.describeCommittee(committee(GENESIS_COMMITTEE, Y));
  assert.deepEqual([one.kind, one.n, one.t, one.W], ["single-seat-bootstrap", 1, 1, 1]);
  assert.match(one.label, /^SINGLE-SEAT BOOTSTRAP: n = 1 seat \(the Enclave seat\), t = 1 of W = 1 shares, on 1 machine - .* not decentralized custody$/);
  // three Enclave machines are ONE Enclave seat (replicas of the same shares), still single-seat
  const rep = C2.describeCommittee(committee(GENESIS_COMMITTEE, Y, { machines: 3, enclave: 3, t: 1 }));
  assert.deepEqual([rep.kind, rep.n, rep.machines], ["single-seat-bootstrap", 1, 3]);
  assert.match(rep.label, /on 3 machines holding the same shares/);
  // the Enclave seat plus three other seats: stated exactly, never called decentralized or independent
  const multi = C2.describeCommittee({ ...committee(GENESIS_COMMITTEE, Y, { machines: 4, enclave: 1 }), t: 3, W: 4 });
  assert.deepEqual([multi.kind, multi.n, multi.otherSeats], ["multi-seat", 4, 3]);
  assert.equal(multi.label, "n = 4 seats, t = 3 of W = 4 shares (1 Enclave seat on 1 machine + 3 other seats) - the vault does not show that the other seats are independent operators or separate failure domains");
  for (const d of [one, rep, multi]) assert.doesNotMatch(d.label.replace(/not decentralized custody/, ""), /decentrali|independent custod/i);
});

test("a first save: the page encrypts to the committee key, ONE owner update; the stored bundle opens to exactly the env", async () => {
  const { fake, key } = rig();
  const wallet = fake.wallet(OWNER);
  await rejects(C2.saveV2({ id: ID, env: ENV, signer: wallet }), "rules_not_admitted");
  assert.equal(wallet.sent.length, 0, "nothing is sent before the owner admits the rules");
  const plan = await C2.planFirstPolicy(ID, PREDICTION);
  assert.equal(plan.committee.kind, "single-seat-bootstrap");
  const steps = [];
  const r = await C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, signer: wallet, onStep: (m) => steps.push(m) });
  assert.equal(r.secretRev, 1n); assert.equal(r.policyRev, 1n);
  assert.equal(r.configSha256, configSha256(configTextFromEnvelope(ENVELOPE)));
  assert.equal(wallet.sent.length, 1);
  assert.equal(steps.filter((s) => s.needsOwnerSignature).length, 1, "exactly one step asks for the owner's signature");
  const { args } = decodeFunctionData({ abi: UPDATE_V2_ABI, data: wallet.sent[0].data });
  assert.equal(args[1].setPolicy, true); assert.equal(args[1].committeeId, GENESIS_COMMITTEE); assert.equal(args[1].setBundle, true);
  assert.equal(args[1].paused, false);
  const stored = fake.bundles.get(ID).data;
  const opened = openBundle({ x: key.x, id: ID, secretRev: 1n, committeeId: GENESIS_COMMITTEE, bundle: stored });
  assert.deepEqual(opened.env, ENV);
  assert.equal(opened.configSha256, r.configSha256);
  // the values exist only inside the ciphertext: not in the calldata, not in any request the page made
  assert.ok(!plaintextIn(wallet.sent[0].data), "no plaintext in the transaction");
  assert.ok(!fetched.some((x) => plaintextIn(x.url + x.body)), "no plaintext in any page request");
  assert.equal(fetched.length, 0, "the save path makes no relay or host request at all");
});

test("rotation: a new complete set replaces the bundle only (rules, committee and PAUSE untouched), at the next revision", async () => {
  const { fake, key } = rig();
  const wallet = fake.wallet(OWNER);
  const plan = await C2.planFirstPolicy(ID, PREDICTION);
  await C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, signer: wallet });
  await C2.setPausedV2({ id: ID, paused: true, signer: wallet });
  const NEXT = { API_TOKEN: "tok_rotated_" + "r".repeat(24) };
  const r = await C2.saveV2({ id: ID, env: NEXT, signer: wallet });
  assert.equal(r.secretRev, 2n);
  const { args } = decodeFunctionData({ abi: UPDATE_V2_ABI, data: wallet.sent.at(-1).data });
  assert.equal(args[1].setPolicy, false, "an existing policy is not rewritten by a save");
  assert.equal(args[1].expectPolicyRev, 2n);
  assert.equal(fake.policies.get(ID).paused, true, "a save never silently resumes a paused policy");
  assert.deepEqual(openBundle({ x: key.x, id: ID, secretRev: 2n, committeeId: GENESIS_COMMITTEE, bundle: fake.bundles.get(ID).data }).env, NEXT);
});

test("refusals send nothing: not the owner, a contract owner, a moved deployment, no committee, an empty set, a bad id", async () => {
  let { fake } = rig();
  const plan = await C2.planFirstPolicy(ID, PREDICTION);
  let w = fake.wallet(OTHER);
  await rejects(C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, signer: w }), "not_owner");
  assert.equal(w.sent.length, 0);
  // a SessionVault-held deployment: the vault's beneficialOwnerOf is the session vault's owner, who may sign
  fake.ledger.set(ID, { owner: "0x" + "c5".repeat(20), sessionOwner: OWNER, envelope: ENVELOPE });
  w = fake.wallet(OWNER);
  assert.equal((await C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, signer: w })).secretRev, 1n);
  // a SessionVault the vault does NOT unwrap (no factory in the book): named precisely, nothing sent
  ({ fake } = rig());
  fake.ledger.set(ID, { owner: SAFE, envelope: ENVELOPE }); fake.codes.set(SAFE, "0x6080"); fake.contractOwners.set(SAFE, OWNER);
  w = fake.wallet(OWNER);
  await rejects(C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, signer: w }), "session_vault_not_unwrapped");
  assert.equal(w.sent.length, 0);
  // a contract owner (Safe / passkey account): refused before anything is encrypted or sent
  ({ fake } = rig());
  fake.ledger.set(ID, { owner: SAFE, envelope: ENVELOPE }); fake.codes.set(SAFE, "0x6080");
  w = fake.wallet(SAFE);
  await rejects(C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, signer: w }), "contract_owner");
  assert.equal(w.sent.length, 0);
  // the ledger moved the deployment after the policy was made: only claimPolicy may follow
  ({ fake } = rig());
  w = fake.wallet(OWNER);
  await C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, signer: w });
  fake.ledger.set(ID, { owner: OTHER, envelope: ENVELOPE });
  await rejects(C2.saveV2({ id: ID, env: ENV, signer: fake.wallet(OTHER) }), "owner_moved");
  ({ fake } = rig()); fake.committees.clear();
  await rejects(C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, signer: fake.wallet(OWNER) }), "no_committee");
  await rejects(C2.saveV2({ id: ID, env: {}, admittedRules: plan.rules, signer: fake.wallet(OWNER) }), "empty_set");
  await rejects(C2.saveV2({ id: "0x1234", env: ENV, signer: fake.wallet(OWNER) }), "bad_id");
  await assert.rejects(C2.saveV2({ id: ID, env: { ENCLAVE_X: "1" }, admittedRules: plan.rules, signer: fake.wallet(OWNER) }));
});

test("the config binding is read off the chain only when inline; otherwise the owner names it (or none), never a guess", async () => {
  const { fake, key } = rig();
  fake.ledger.set(ID, { owner: OWNER, envelope: "" });            // the catalog version's config: not on the ledger
  const plan = await C2.planFirstPolicy(ID, PREDICTION);
  const w = fake.wallet(OWNER);
  const st = await C2.statusV2(ID);
  assert.equal(st.configSha256, null); assert.match(st.configNote, /catalog version/);
  await rejects(C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, signer: w }), "config_unbound");
  await rejects(C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, configOverride: { json: "{not json" }, signer: w }), "config_bad");
  assert.equal(w.sent.length, 0, "nothing sent without an explicit binding");
  const CFG = '{"db":"${DATABASE_URL}"}';
  const r = await C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, configOverride: { json: CFG }, signer: w });
  assert.equal(r.configSha256, configSha256(JSON.stringify(JSON.parse(CFG))));
  assert.equal(openBundle({ x: key.x, id: ID, secretRev: 1n, committeeId: GENESIS_COMMITTEE, bundle: fake.bundles.get(ID).data }).configSha256, r.configSha256);
  const r2 = await C2.saveV2({ id: ID, env: ENV, configOverride: { none: true }, signer: w });
  assert.equal(r2.configSha256, configSha256(""));
  // an inline envelope config always wins: a named override is not consulted
  fake.ledger.set(ID, { owner: OWNER, envelope: ENVELOPE });
  const r3 = await C2.saveV2({ id: ID, env: ENV, configOverride: { none: true }, signer: w });
  assert.equal(r3.configSha256, configSha256(configTextFromEnvelope(ENVELOPE)));
});

test("a stale revision reverts and nothing is claimed; a vault that does not show the written bundle is reported, not trusted", async () => {
  let { fake } = rig();
  const plan = await C2.planFirstPolicy(ID, PREDICTION);
  await C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, signer: fake.wallet(OWNER) });
  fake.raceBump = true;     // another update lands between the page's read and its transaction
  await assert.rejects(C2.saveV2({ id: ID, env: ENV, signer: fake.wallet(OWNER) }), /StaleRevision/);
  ({ fake } = rig());
  fake.tamper = (b) => { const c = b.slice(); c[c.length - 1] ^= 1; return c; };
  await rejects(C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, signer: fake.wallet(OWNER) }), "readback_mismatch");
});

test("pause and resume: one owner update each, same committee and rules, read back; a no-op sends nothing", async () => {
  const { fake } = rig();
  const w = fake.wallet(OWNER);
  await rejects(C2.setPausedV2({ id: ID, paused: true, signer: w }), "no_policy");
  const plan = await C2.planFirstPolicy(ID, PREDICTION);
  await C2.saveV2({ id: ID, env: ENV, admittedRules: plan.rules, signer: w });
  const p = await C2.setPausedV2({ id: ID, paused: true, signer: w });
  assert.equal(p.paused, true); assert.equal(p.policyRev, 2n);
  const { args } = decodeFunctionData({ abi: UPDATE_V2_ABI, data: w.sent.at(-1).data });
  assert.deepEqual([args[1].setPolicy, args[1].paused, args[1].committeeId, args[1].setBundle], [true, true, GENESIS_COMMITTEE, false]);
  const n = w.sent.length;
  assert.equal((await C2.setPausedV2({ id: ID, paused: true, signer: w })).unchanged, true);
  assert.equal(w.sent.length, n);
  assert.equal((await C2.setPausedV2({ id: ID, paused: false, signer: w })).paused, false);
  await rejects(C2.setPausedV2({ id: ID, paused: true, signer: fake.wallet(OTHER) }), "not_owner");
  const st = await C2.statusV2(ID);
  assert.equal(st.policy.paused, false); assert.equal(st.policy.policyRev, 3n); assert.equal(st.committee.kind, "single-seat-bootstrap");
});

test("migration: relay copy -> v2 (read back) -> the relay copy is KEPT and reported; its deletion is a separate gated step", async () => {
  const { fake, key } = rig();
  const plan = await C2.planFirstPolicy(ID, PREDICTION);
  const order = [];
  const relay = (custody) => ({
    read: async () => { order.push("relay-read"); return { env: ENV, rev: 7 }; },
    exists: async () => { order.push("exists"); return { id: ID, exists: true, ...(custody ? { custody: true } : {}) }; },
    clear: async () => { order.push("relay-clear"); return { rev: 8, names: [] }; } });
  // the relay copy cannot be deleted while v2 holds nothing
  await rejects(C2.clearRelayCopyV2({ id: ID, relay: relay(true) }), "no_v2_bundle");
  assert.ok(!order.includes("relay-clear"));
  const w = fake.wallet(OWNER);
  const r = await C2.migrateFromRelayV2({ id: ID, relay: relay(false), signer: { ...w, sendTx: async (to, d) => { order.push("vault-update"); return w.sendTx(to, d); } }, admittedRules: plan.rules });
  assert.deepEqual(order, ["relay-read", "vault-update", "exists"], "read, then store in v2, then only LOOK at the old copy");
  assert.deepEqual(r.migratedNames, Object.keys(ENV).sort());
  assert.equal(r.oldCopy.state, "present-relay-not-custody-aware");
  assert.deepEqual(openBundle({ x: key.x, id: ID, secretRev: 1n, committeeId: GENESIS_COMMITTEE, bundle: fake.bundles.get(ID).data }).env, ENV);
  // a relay that does not report custody keeps its copy: deleting it could leave the app with nothing
  await rejects(C2.clearRelayCopyV2({ id: ID, relay: relay(false) }), "relay_not_custody_aware");
  assert.ok(!order.includes("relay-clear"));
  // once the relay is custody-aware the owner's explicit step deletes it, and the answer never claims more than the relay said
  assert.equal((await C2.relayCopyState({ id: ID, relay: relay(true) })).state, "present");
  const c = await C2.clearRelayCopyV2({ id: ID, relay: relay(true) });
  assert.equal(c.state, "relay-reports-deleted"); assert.equal(order.at(-1), "relay-clear");
  assert.match(c.why, /Backups, logs or replicas .* are not verifiable from this page: rotate those credentials/);
  assert.doesNotMatch(c.why, /irreversib|permanent|all copies/i);
  // a deployment v2 already holds is never overwritten by the relay's (older) copy
  order.length = 0;
  await rejects(C2.migrateFromRelayV2({ id: ID, relay: relay(true), signer: w }), "v2_already_holds");
  assert.deepEqual(order, [], "not even the relay copy is read");
  // an unbound config is refused BEFORE the relay read (no owner signature spent on a save that cannot happen)
  const f3 = rig(); f3.fake.ledger.set(ID, { owner: OWNER, envelope: "" });
  order.length = 0;
  await rejects(C2.migrateFromRelayV2({ id: ID, relay: relay(false), signer: f3.fake.wallet(OWNER), admittedRules: plan.rules }), "config_unbound");
  assert.deepEqual(order, []);
  // nothing migrates from an empty relay
  const f2 = rig();
  await rejects(C2.migrateFromRelayV2({ id: ID, relay: { read: async () => ({ env: {}, rev: 0 }), exists: async () => ({}) }, signer: f2.fake.wallet(OWNER), admittedRules: plan.rules }), "nothing_to_migrate");
});
