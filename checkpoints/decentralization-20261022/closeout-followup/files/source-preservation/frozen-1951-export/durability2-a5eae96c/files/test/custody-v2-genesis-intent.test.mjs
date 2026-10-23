// Custody v2 genesis retry and restart safety: the REAL member engine (custody/v2/member.mjs) through the REAL sealed-state
// writer (custody/v2/sealed-state.mjs) against a host disk the test can fail, and an in-memory vault whose createCommittee
// does what EnclaveSecretVaultV2.createCommittee does to the committee id (keccak of chain, vault, salt and Y; refused when
// it exists). Each case restarts the machine from what is durable and drives it the way daemon.mjs does: tick() on the
// committee it serves (member.committees()[0]). Real share crypto, real signatures.
//   run: node --test test/custody-v2-genesis-intent.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as hpke from "../custody/hpke.mjs";
import * as D from "../custody/v2/digests.mjs";
import { createMember } from "../custody/v2/member.mjs";
import { createCustodianV2 } from "../custody/v2/custodian.mjs";
import { createSealedStateWriter } from "../custody/v2/sealed-state.mjs";

const hex = (n, len = 32) => "0x" + n.toString(16).padStart(len * 2, "0");
const sha = (s) => "0x" + createHash("sha256").update(s).digest("hex");
const lc = (s) => String(s).toLowerCase();
const bytes = (h) => Buffer.from(String(h).slice(2), "hex");
const CHAIN = 8453, VAULT = hex(70, 20), ENCLAVE = hex(999, 20);
const enclaveEntry = { active: true, owner: ENCLAVE, operator: hex(5, 20), payoutWallet: ENCLAVE };
const daemonRunsGenesis = (s) => !(s.member && Object.keys(s.member.epochs || {}).length);   // daemon.mjs step 4's guard

// the vault's committee store; down = no RPC can agree (every read throws, as the quorum reader does)
function vaultSim() {
  const committees = new Map(); let down = false;
  const unavailable = () => Object.assign(new Error("only 0 RPCs agree on the chain state"), { code: "chain_unavailable" });
  const chain = {
    readRegistryEntry: async () => { if (down) throw unavailable(); return { entry: enclaveEntry }; },
    readCommittee: async ({ committeeId }) => { if (down) throw unavailable(); return { committee: committees.get(lc(committeeId)) || null, pending: null }; },
    // a served committee's coordinator reads one authorization snapshot; null here ends the tick at "committee_changed"
    readAuthorization: async () => { if (down) throw unavailable(); return { committee: null }; },
    readRelease: async () => { if (down) throw unavailable(); throw new Error("not used"); },
  };
  const create = ([salt, m, Y]) => {
    const cid = lc(D.committeeIdOf({ chainId: CHAIN, vault: VAULT, salt, Y: bytes(Y) }));
    if (committees.has(cid)) throw new Error("execution reverted: BadCommittee()");
    committees.set(cid, { committeeId: cid, Y: bytes(Y), epoch: 1, t: 1, W: 1, activatedAt: 1, machines: [{ ...m, enclave: true }], commitments: bytes(Y) });
  };
  return { chain, committees, create, setDown: (v) => { down = v; } };
}
// the host's PUT /state: fails the next write matching failIf; durable = the last stored blob
function hostDisk(blob = null) {
  const d = { blob, failIf: null, put: async (b) => { if (d.failIf && d.failIf(JSON.parse(b))) { d.failIf = null; throw new Error("host /state: 500"); } d.blob = b; },
              durable: () => (d.blob === null ? null : JSON.parse(d.blob)) };
  return d;
}
function newMachine(tag) {
  const id = privateKeyToAccount(generatePrivateKey()), kp = hpke.generateKeyPair();
  return { id, kp, machine: { identity: id.address.toLowerCase(), encKey: "0x" + Buffer.from(kp.publicKey).toString("hex"), endpoint: `https://${tag}.example`,
                              chipId: sha(`chip-${tag}`), registryId: sha(`reg-${tag}`), measurement: sha("custodian") } };
}
// one custodian process over a host disk: the daemon's wiring of state, writer, member and the host's /submit.
// outcome: the next createCommittee "fail-before" (no chain write) or "lost-receipt" (written, then the answer is lost)
function boot(who, disk, sim, calls) {
  const state = disk.durable() || {};
  const writer = createSealedStateWriter({ seal: (s) => JSON.stringify(s), put: disk.put, state, log: () => {} });
  const p = { outcome: null };
  const submit = async (fn, args) => {
    calls.push({ fn, args: JSON.parse(JSON.stringify(args)), durable: disk.durable() });
    const o = p.outcome; p.outcome = null;
    if (o === "fail-before") throw new Error("rpc: connection reset");
    if (fn === "createCommittee") sim.create(args);
    if (o === "lost-receipt") throw new Error("rpc: receipt timeout");
    return "0xtx";
  };
  const member = createMember({ chainId: CHAIN, vault: VAULT, identity: who.id, encPrivateKey: who.kp.privateKey, machine: who.machine, enclaveOwner: ENCLAVE,
    chain: sim.chain, store: writer.memberStore, submit, log: () => {},
    fetchJson: async () => { throw new Error("no peer"); }, attestSelf: async () => { throw new Error("not used"); }, verifyPeerQuote: async () => ({ ok: false }) });
  p.member = member; p.state = state;
  p.serve = () => member.tick(member.committees()[0]);          // the daemon's engine loop step
  return p;
}
// a machine already bound to its Enclave host (the binding itself is covered by the barrier and e2e suites)
const BOUND = () => JSON.stringify({ member: { epochs: {}, pending: {}, hostSig: "0x" + "11".repeat(65), candidates: {} } });
const creates = (calls) => calls.filter((c) => c.fn === "createCommittee");
const shareKeys = (s) => Object.keys(s?.member?.epochs || {});

test("I1 a failed share write sends nothing and leaves no intent: the restarted daemon runs a fresh genesis", async () => {
  const sim = vaultSim(), disk = hostDisk(BOUND()), calls = [], who = newMachine("i1");
  const p = boot(who, disk, sim, calls);
  disk.failIf = (s) => shareKeys(s).length > 0;
  await assert.rejects(p.member.genesis({ salt: hex(1), codeSet: [who.machine.measurement] }), /state not persisted/);
  assert.equal(calls.length, 0, "nothing was sent");
  assert.equal(p.member._state().genesis, undefined, "no intent in memory");
  assert.equal(disk.durable().member.genesis, undefined, "no intent on disk");
  assert.deepEqual(shareKeys(disk.durable()), []);
  assert.ok(daemonRunsGenesis(disk.durable()), "the restarted daemon runs genesis afresh (nothing of the failed one exists anywhere)");
});

test("I2 createCommittee lands but its answer is lost: the restarted machine confirms it from the chain without a second genesis", async () => {
  const sim = vaultSim(), disk = hostDisk(BOUND()), calls = [], who = newMachine("i2");
  const p = boot(who, disk, sim, calls);
  p.outcome = "lost-receipt";
  await assert.rejects(p.member.genesis({ salt: hex(2), codeSet: [who.machine.measurement] }));
  assert.equal(sim.committees.size, 1, "the chain holds the committee");
  const [cid] = [...sim.committees.keys()];
  assert.deepEqual(shareKeys(creates(calls)[0].durable), [`${cid}:1`], "the share was durable at the submission");
  const share = JSON.stringify(disk.durable().member.epochs[`${cid}:1`]);
  // restart
  assert.ok(!daemonRunsGenesis(disk.durable()), "the restarted daemon does not run a new genesis");
  const q = boot(who, disk, sim, calls);
  assert.equal(q.member.committees()[0], cid);
  const r = await q.serve();
  assert.equal(r.state, "committee_changed", `the committee is served: ${JSON.stringify(r)}`);
  assert.equal(creates(calls).length, 1, "no second createCommittee");
  assert.equal(disk.durable().member.genesis?.confirmed, true, "the intent is confirmed durably");
  assert.equal(JSON.stringify(disk.durable().member.epochs[`${cid}:1`]), share, "the same share");
});

test("I3 createCommittee fails before any chain write: the restarted machine re-sends the SAME intent for the SAME share", async () => {
  const sim = vaultSim(), disk = hostDisk(BOUND()), calls = [], who = newMachine("i3");
  const p = boot(who, disk, sim, calls);
  p.outcome = "fail-before";
  await assert.rejects(p.member.genesis({ salt: hex(3), codeSet: [who.machine.measurement] }));
  assert.equal(sim.committees.size, 0);
  const [key] = shareKeys(disk.durable()), cid = key.split(":")[0], share = JSON.stringify(disk.durable().member.epochs[key]);
  const q = boot(who, disk, sim, calls);
  const r = await q.serve();
  assert.equal(r.state, "genesis_submitted", `the restarted machine must re-send its genesis: ${JSON.stringify(r)}`);
  assert.equal(creates(calls).length, 2);
  assert.deepEqual(creates(calls)[1].args, creates(calls)[0].args, "the same transaction: salt, machine, Y, code set, signatures");
  assert.ok(sim.committees.has(cid), "the intended committee now exists");
  assert.equal(JSON.stringify(disk.durable().member.epochs[key]), share, "the same durable share");
  assert.deepEqual(shareKeys(disk.durable()), [key], "no second secret");
  assert.equal((await q.serve()).state, "committee_changed", "then it is confirmed and served");
  assert.equal(creates(calls).length, 2, "one chain write in total");
  assert.equal(disk.durable().member.genesis.confirmed, true);
});

test("I4 a genesis retry in the same process re-sends the durable intent, never a new committee", async () => {
  const sim = vaultSim(), disk = hostDisk(BOUND()), calls = [], who = newMachine("i4");
  const p = boot(who, disk, sim, calls);
  p.outcome = "fail-before";
  const g1 = p.member.genesis({ salt: hex(4), codeSet: [who.machine.measurement] }); g1.catch(() => {});
  await assert.rejects(g1);
  const g2 = await p.member.genesis({ salt: hex(5), codeSet: [who.machine.measurement] });
  assert.deepEqual(creates(calls)[1].args, creates(calls)[0].args, "the retry sent the same transaction");
  assert.equal(shareKeys(disk.durable()).length, 1, "one share only");
  assert.equal(g2.committeeId, shareKeys(disk.durable())[0].split(":")[0]);
  assert.equal(sim.committees.size, 1);
});

test("I5 chain unavailable: no submission, no new secret or committee, no release; the intent waits", async () => {
  const sim = vaultSim(), disk = hostDisk(BOUND()), calls = [], who = newMachine("i5");
  const p = boot(who, disk, sim, calls);
  p.outcome = "fail-before";
  await assert.rejects(p.member.genesis({ salt: hex(6), codeSet: [who.machine.measurement] }));
  const before = disk.blob, [key] = shareKeys(disk.durable()), cid = key.split(":")[0];
  sim.setDown(true);
  const q = boot(who, disk, sim, calls);
  await assert.rejects(q.serve(), /only 0 RPCs agree/, "an unreadable chain is never read as 'absent'");
  await assert.rejects(q.member.genesis({ salt: hex(7), codeSet: [who.machine.measurement] }), /only 0 RPCs agree/);
  assert.equal(creates(calls).length, 1, "only the original (failed) submission");
  assert.equal(disk.blob, before, "nothing changed on disk");
  assert.equal(sim.committees.size, 0);
  const custodian = createCustodianV2({ chainId: CHAIN, vault: VAULT, encPrivateKey: who.kp.privateKey, shares: q.member.shares, chain: sim.chain, verifiers: {}, log: () => {} });
  const c = custodian.challenge();
  await assert.rejects(custodian.release({ v: 2, id: hex(9), endpoint: "https://app.example", committeeId: cid, epoch: 1, policyRev: "1", secretRev: "1",
    recipientKey: "ab".repeat(32), challenges: [{ encKey: c.encKey, nonce: c.nonce }], operator: { sig: "0x", expiry: 0 }, evidence: {} }), /could not be confirmed/, "no release");
  sim.setDown(false);
  assert.equal((await q.serve()).state, "genesis_submitted", "when the chain answers, the same intent goes out");
  assert.deepEqual(creates(calls)[1].args, creates(calls)[0].args);
});

test("I6 the intended committee id exists with another machine: a conflict, nothing re-sent, the share kept", async () => {
  const sim = vaultSim(), disk = hostDisk(BOUND()), calls = [], who = newMachine("i6"), other = newMachine("i6-other");
  const p = boot(who, disk, sim, calls);
  p.outcome = "fail-before";
  await assert.rejects(p.member.genesis({ salt: hex(8), codeSet: [who.machine.measurement] }));
  const [key] = shareKeys(disk.durable()), cid = key.split(":")[0];
  const sent = creates(calls)[0].args;
  sim.create([sent[0], other.machine, sent[2]]);                     // someone else used this salt and key first
  const q = boot(who, disk, sim, calls);
  const r = await q.serve();
  assert.equal(r.state, "genesis_conflict", JSON.stringify(r));
  assert.match(r.reason, /another machine/);
  assert.equal(creates(calls).length, 1);
  assert.deepEqual(shareKeys(disk.durable()), [key], "the share is kept");
  assert.equal(sim.committees.get(cid).machines[0].identity, other.machine.identity);
});

test("I7 legacy state without an intent: a live committee is served as before; an orphan is reported, never re-created or deleted", async () => {
  const sim = vaultSim(), calls = [], who = newMachine("i7");
  // a committee created by an image without intents (as the live one was): the share on disk, no genesis record
  const cid = lc(D.committeeIdOf({ chainId: CHAIN, vault: VAULT, salt: hex(10), Y: Buffer.from("02" + "33".repeat(32), "hex") }));
  sim.committees.set(cid, { committeeId: cid, Y: Buffer.alloc(33), epoch: 1, t: 1, W: 1, activatedAt: 1, machines: [{ ...who.machine, enclave: true }], commitments: Buffer.alloc(33) });
  const legacy = (k) => JSON.stringify({ member: { epochs: { [`${k}:1`]: [{ k: 1, x: "44".repeat(32) }] }, pending: {}, hostSig: "0x" + "11".repeat(65), candidates: {} } });
  const disk = hostDisk(legacy(cid));
  const q = boot(who, disk, sim, calls);
  assert.equal((await q.serve()).state, "committee_changed", "the legacy committee is served");
  assert.equal(q.member._state().genesis, undefined, "no intent invented");
  assert.equal(creates(calls).length, 0);
  // an orphan: a share for a committee that never reached the chain, with no intent (its salt and signature are lost)
  const orphan = sha("orphan"), disk2 = hostDisk(legacy(orphan));
  const o = boot(who, disk2, sim, calls);
  const r = await o.serve();
  assert.equal(r.state, "no_committee");
  assert.match(r.reason, /LEGACY ORPHAN/, "an explicit diagnostic");
  assert.equal(creates(calls).length, 0, "nothing is re-sent");
  assert.deepEqual(shareKeys(disk2.durable()), [`${orphan}:1`], "the share is never deleted");
  sim.setDown(true);
  await assert.rejects(o.serve(), /only 0 RPCs agree/, "with the chain unreadable it is not even called an orphan");
});
