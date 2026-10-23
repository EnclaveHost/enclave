// Custody v2 durability barrier: a share (or any state another party acts on) is DURABLE on the host before the
// transaction that relies on it is submitted. Drives the REAL member engine (custody/v2/member.mjs) through the REAL
// sealed-state writer (custody/v2/sealed-state.mjs, the daemon's persist path) against a host disk whose writes this
// test holds, completes or fails, and records the order of writes and submissions. Real share crypto
// (custody/v2/protocol.mjs), real signatures; the chain and the host are in-memory fakes.
//   run: node --test test/custody-v2-persist-barrier.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as hpke from "../custody/hpke.mjs";
import * as v2 from "../custody/v2/protocol.mjs";
import { createMember } from "../custody/v2/member.mjs";
import { createSealedStateWriter } from "../custody/v2/sealed-state.mjs";

const hex = (n, len = 32) => "0x" + n.toString(16).padStart(len * 2, "0");
const sha = (s) => "0x" + createHash("sha256").update(s).digest("hex");
const hx = (b) => "0x" + Buffer.from(b).toString("hex");
const bytes = (h) => Buffer.from(String(h).slice(2), "hex");
const CHAIN = 8453, VAULT = hex(70, 20), ENCLAVE = hex(999, 20);
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function until(cond, what) { for (let i = 0; i < 2000; i++) { if (cond()) return; await new Promise((r) => setImmediate(r)); } throw new Error(`timed out waiting for ${what}`); }

// The host's PUT /state. "hold": each write waits until the test completes (or fails) it, oldest first; "auto": each write
// completes at once. durable() is the last COMPLETED blob, i.e. what a reopened custodian would find.
function hostDisk(events) {
  const queue = []; let durable = null, mode = "hold";
  const settleWrite = (w, ok) => { if (ok) { durable = w.blob; events.push("write-done"); w.res(); } else { events.push("write-failed"); w.rej(new Error("host /state: 500")); } };
  return {
    put(blob) { events.push("write-start"); return new Promise((res, rej) => { const w = { blob, res, rej }; if (mode === "auto") settleWrite(w, true); else queue.push(w); }); },
    async complete(ok = true) { settleWrite(queue.shift(), ok); await settle(); },
    pending: () => queue.length, durable: () => (durable === null ? null : JSON.parse(durable)), setMode: (m) => { mode = m; },
  };
}
function newMachine(tag, { enclave = true } = {}) {
  const id = privateKeyToAccount(generatePrivateKey()), kp = hpke.generateKeyPair();
  return { id, kp, machine: { identity: id.address.toLowerCase(), encKey: hx(kp.publicKey), endpoint: `https://${tag}.example`, chipId: sha(`chip-${tag}`),
                              registryId: sha(`reg-${tag}`), measurement: sha("custodian"), enclave } };
}
// the daemon's wiring: the member's store is the writer's memberStore over the daemon's state object
function rig({ who, state, disk, events, chain, failSubmit = () => false }) {
  const subs = [];
  const writer = createSealedStateWriter({ seal: (s) => JSON.stringify(s), put: (blob) => disk.put(blob), state, log: () => {} });
  const member = createMember({ chainId: CHAIN, vault: VAULT, identity: who.id, encPrivateKey: who.kp.privateKey, machine: who.machine, enclaveOwner: ENCLAVE,
    chain, store: writer.memberStore, log: () => {},
    // every submission records what the host had DURABLY at that moment: the property under test
    submit: async (fn) => { events.push(`submit:${fn}`); subs.push({ fn, durable: disk.durable() }); if (failSubmit(fn)) throw new Error(`submit ${fn}: rpc down`); return "0xtx"; },
    fetchJson: async () => { throw new Error("no peer in this test"); }, attestSelf: async () => { throw new Error("not used"); },
    verifyPeerQuote: async () => ({ ok: false, reason: "not used" }) });
  return { member, writer, subs };
}
const before = (events, a, b) => events.indexOf(a) >= 0 && events.indexOf(b) >= 0 && events.indexOf(a) < events.indexOf(b);

// ---------------------------------------------------------------- genesis
const enclaveEntry = { active: true, owner: ENCLAVE, operator: hex(5, 20), payoutWallet: ENCLAVE };
const genesisChain = { readRegistryEntry: async () => ({ entry: enclaveEntry }) };
const bound = () => ({ member: { epochs: {}, pending: {}, hostSig: "0x" + "11".repeat(65), candidates: {} } });

test("G1 genesis: no createCommittee while the share's write is pending; the share is durable first", async () => {
  const events = [], disk = hostDisk(events), state = bound(), who = newMachine("g1");
  const { member, subs } = rig({ who, state, disk, events, chain: genesisChain });
  const p = member.genesis({ salt: hex(3), codeSet: [who.machine.measurement] });
  await until(() => disk.pending() > 0, "the share write");
  await settle();
  assert.ok(!events.includes("submit:createCommittee"), `createCommittee was submitted while the share write was pending: ${events.join(" ")}`);
  await disk.complete(true);
  const g = await p;
  assert.ok(before(events, "write-done", "submit:createCommittee"), events.join(" "));
  assert.equal(subs[0].durable.member.epochs[`${g.committeeId}:1`].length, 1, "the share was durable when createCommittee was submitted");
  assert.equal(disk.durable().member.epochs[`${g.committeeId}:1`].length, 1, "the durable state holds the genesis share");
});

test("G2 genesis: a rejected write submits nothing, leaves no share in memory, and a later write cannot persist it", async () => {
  const events = [], disk = hostDisk(events), state = bound(), who = newMachine("g2");
  const { member, writer } = rig({ who, state, disk, events, chain: genesisChain });
  const p = member.genesis({ salt: hex(4), codeSet: [who.machine.measurement] }); p.catch(() => {});   // judged below
  await until(() => disk.pending() > 0, "the share write");
  await disk.complete(false);
  await assert.rejects(p, /persist/i, "genesis must fail when its share is not durable");
  assert.ok(!events.includes("submit:createCommittee"), events.join(" "));
  assert.deepEqual(member._state().epochs, {}, "no share left in memory");
  assert.deepEqual(state.member.epochs, {}, "the daemon's view (the same object) holds no share either");
  disk.setMode("auto");
  await writer.checkpoint.save({ block: "1" });              // any later write of the whole state
  assert.deepEqual(disk.durable().member.epochs, {}, "a later write does not persist the failed genesis share");
});

test("G3 genesis: a retry after a failed write goes through the barrier again", async () => {
  const events = [], disk = hostDisk(events), state = bound(), who = newMachine("g3");
  const { member } = rig({ who, state, disk, events, chain: genesisChain });
  const p1 = member.genesis({ salt: hex(5), codeSet: [who.machine.measurement] }); p1.catch(() => {});
  await until(() => disk.pending() > 0, "the first write");
  await disk.complete(false);
  await assert.rejects(p1);
  const p2 = member.genesis({ salt: hex(6), codeSet: [who.machine.measurement] });
  await until(() => disk.pending() > 0, "the retry's write");
  await settle();
  assert.ok(!events.includes("submit:createCommittee"), "the retry did not wait for its write");
  await disk.complete(true);
  await p2;
  assert.equal(events.filter((e) => e === "submit:createCommittee").length, 1);
  assert.ok(before(events, "write-done", "submit:createCommittee"), events.join(" "));
});

// ---------------------------------------------------------------- handover (this machine is a newcomer of epoch 2)
// Epoch 1: ONE Enclave machine A (t = 1). Proposed epoch 2: A and this machine B, both Enclave (one seat: t = 1, W = 1).
// A's deal is built with the real protocol and sealed to every next machine; B must persist its new share, then ack.
function handoverWorld({ expires = Math.floor(Date.now() / 1000) + 3600, wide = false } = {}) {
  // wide: epoch 2 = A (Enclave) + B + C, three seats, t = 2: a new deal is a new random polynomial, so new shares
  const A = newMachine("a"), B = newMachine("b", { enclave: !wide }), C = newMachine("c", { enclave: false });
  const gA = v2.genesis(), cid = sha("committee"), next = wide ? [A.machine, B.machine, C.machine] : [A.machine, B.machine];
  const committee = { epoch: 1, t: 1, W: 1, machines: [A.machine], commitments: Buffer.concat(gA.commitments.map((c) => Buffer.from(c))) };
  const lay = v2.seatLayout(next);
  const mkDeal = () => {
    const dl = v2.deal({ x: gA.shares[0].x, tNew: lay.t, newIndices: Array.from({ length: lay.W }, (_, i) => i + 1) });
    const aadFields = { chainId: CHAIN, vault: VAULT, committeeId: cid, fromEpoch: 1, toEpoch: 2, dealerIndex: 1, dealCommitments: dl.commitments };
    return { dealCommitments: Buffer.concat(dl.commitments.map((c) => Buffer.from(c))),
             sealed: next.map((m, mi) => Buffer.from(v2.sealDeal({ encKey: bytes(m.encKey), aadFields, entries: lay.indicesOf(mi).map((kk) => [kk, dl.sub.get(kk)]) }))) };
  };
  const world = { A, B, cid, deal: mkDeal(), pending: { toEpoch: 2, next, dealers: [1], expires, acks: 0 }, redeal() { this.deal = mkDeal(); } };
  world.chain = {
    readCommittee: async () => ({ committee, pending: world.pending }),
    readDeal: async () => world.deal,
  };
  return world;
}
const fresh = () => ({ member: { epochs: {}, pending: {}, hostSig: null, candidates: {} } });
const pendingOf = (st, w) => st?.pending?.[`${w.cid}:2`] || null;
const acks = (events) => events.filter((e) => e === "submit:ackHandover").length;
// at EVERY ackHandover submission the host's durable state already held this machine's pending share for the epoch
const ackedDurably = (subs, w) => subs.filter((x) => x.fn === "ackHandover").every((x) => pendingOf(x.durable?.member, w));

test("H1 handover: no ackHandover while the new share's write is pending", async () => {
  const events = [], disk = hostDisk(events), state = fresh(), w = handoverWorld();
  const { member, subs } = rig({ who: w.B, state, disk, events, chain: w.chain });
  const p = member.tick(w.cid); p.catch(() => {});
  // complete every write as it arrives EXCEPT the one that carries the new pending share
  for (;;) {
    await until(() => disk.pending() > 0 || events.includes("submit:ackHandover"), "a write");
    if (events.includes("submit:ackHandover")) break;
    const carries = !!pendingOf(state.member, w);
    if (carries) break;
    await disk.complete(true);
  }
  await settle();
  assert.equal(acks(events), 0, `ackHandover was submitted before the new share was durable: ${events.join(" ")}`);
  disk.setMode("auto");
  while (disk.pending()) await disk.complete(true);
  const r = await p;
  assert.equal(r.state, "acked");
  assert.equal(acks(events), 1);
  assert.ok(ackedDurably(subs, w), "the share was durable when the ack was submitted");
});

test("H2 handover: a rejected write sends no ack and leaves no share in memory; the next tick persists, then acks once", async () => {
  const events = [], disk = hostDisk(events), state = fresh(), w = handoverWorld();
  const { member, subs } = rig({ who: w.B, state, disk, events, chain: w.chain });
  const p = member.tick(w.cid); p.catch(() => {});
  for (;;) {                                                  // fail the write that carries the share
    await until(() => disk.pending() > 0 || events.includes("submit:ackHandover"), "a write");
    if (events.includes("submit:ackHandover")) break;
    if (pendingOf(state.member, w)) { await disk.complete(false); break; }
    await disk.complete(true);
  }
  await p.catch(() => {});
  assert.equal(acks(events), 0, `acked although the share's write failed: ${events.join(" ")}`);
  assert.equal(pendingOf(member._state(), w), null, "no undurable share left in memory");
  disk.setMode("auto");
  const r = await member.tick(w.cid);
  assert.equal(r.state, "acked");
  assert.equal(acks(events), 1);
  assert.ok(ackedDurably(subs, w), "the share was durable when the ack was submitted");
});

test("H3 handover: a crash while the write is pending loses no acked share; the reopened member persists, then acks", async () => {
  const events = [], disk = hostDisk(events), state = fresh(), w = handoverWorld();
  const { member, subs } = rig({ who: w.B, state, disk, events, chain: w.chain });
  const p = member.tick(w.cid); p.catch(() => {});
  for (;;) {
    await until(() => disk.pending() > 0 || events.includes("submit:ackHandover"), "a write");
    if (events.includes("submit:ackHandover") || pendingOf(state.member, w)) break;
    await disk.complete(true);
  }
  await settle();
  // crash: the process dies here; only what is durable survives
  assert.equal(acks(events), 0, `an ack left the machine before its share was durable: ${events.join(" ")}`);
  p.catch(() => {});
  const reopened = disk.durable() || fresh();
  assert.equal(pendingOf(reopened.member, w), null, "the pending write never completed: no share on disk");
  const events2 = [], disk2 = hostDisk(events2); disk2.setMode("auto");
  const { member: again, subs: subs2 } = rig({ who: w.B, state: reopened, disk: disk2, events: events2, chain: w.chain });
  assert.equal((await again.tick(w.cid)).state, "acked");
  assert.ok(ackedDurably(subs2, w), "only a durable share was acked");
});

test("H4 handover: an ack that fails after a durable write is re-sent from the SAME durable share (no stale skip)", async () => {
  const events = [], disk = hostDisk(events), state = fresh(), w = handoverWorld();
  disk.setMode("auto");
  let fail = true;
  const { member, subs } = rig({ who: w.B, state, disk, events, chain: w.chain, failSubmit: (fn) => fn === "ackHandover" && fail });
  await assert.rejects(member.tick(w.cid), /rpc down/);
  const share1 = JSON.stringify(pendingOf(disk.durable().member, w));
  assert.notEqual(share1, "null", "the share was durable before the (failed) ack");
  fail = false;
  assert.equal((await member.tick(w.cid)).state, "acked", "the next tick must re-send the ack");
  assert.equal(acks(events), 2);
  assert.equal(JSON.stringify(pendingOf(disk.durable().member, w)), share1, "the same durable share, not a new one");
  assert.equal((await member.tick(w.cid)).state, "handover", "once acked, the same proposal is not acked again");
  assert.equal(acks(events), 2);
  assert.ok(ackedDurably(subs, w));
});

test("H5 handover: a stale pending share from an earlier proposal is replaced (durably) before acking a new one", async () => {
  const w = handoverWorld({ expires: Math.floor(Date.now() / 1000) + 600, wide: true });
  const events0 = [], disk0 = hostDisk(events0), state0 = fresh();
  disk0.setMode("auto");
  const { member: m0 } = rig({ who: w.B, state: state0, disk: disk0, events: events0, chain: w.chain });
  assert.equal((await m0.tick(w.cid)).state, "acked");
  const stale = JSON.stringify(pendingOf(disk0.durable().member, w));
  // that proposal expires; a new proposal for the same epoch arrives with new deals
  w.pending = { ...w.pending, expires: Math.floor(Date.now() / 1000) + 3600 };
  w.redeal();
  const events = [], disk = hostDisk(events); disk.setMode("auto");
  const { member, subs } = rig({ who: w.B, state: disk0.durable(), disk, events, chain: w.chain });
  assert.equal((await member.tick(w.cid)).state, "acked", "the new proposal must be acked");
  const now = JSON.stringify(pendingOf(disk.durable().member, w));
  assert.notEqual(now, stale, "the share for the new deals replaced the stale one");
  const ack = subs.find((x) => x.fn === "ackHandover");
  assert.equal(JSON.stringify(pendingOf(ack.durable.member, w)), now, "the NEW share was durable when its ack was submitted");
});

// ---------------------------------------------------------------- the writer itself (the daemon's saveNow)
test("W1 serialized writes: a newer snapshot is never replaced by an older one, even when the older write fails", async () => {
  const events = [], disk = hostDisk(events), state = { member: { n: 1 } };
  const writer = createSealedStateWriter({ seal: (s) => JSON.stringify(s), put: (b) => disk.put(b), state });
  const w1 = writer.saveNow(); state.member = { n: 2 }; const w2 = writer.saveNow();
  await settle();
  assert.equal(disk.pending(), 1, "the second write waits for the first");
  await disk.complete(true); await w1;
  await until(() => disk.pending() > 0, "the second write"); await disk.complete(true); await w2;
  assert.equal(disk.durable().member.n, 2);
  const w3 = writer.saveNow(); state.member = { n: 3 }; const w4 = writer.saveNow();
  await until(() => disk.pending() > 0, "w3"); await disk.complete(false); await assert.rejects(w3);
  await until(() => disk.pending() > 0, "w4"); await disk.complete(true); await w4;
  assert.equal(disk.durable().member.n, 3, "a failed older write never blocks or overwrites the newer one");
});

test("W2 the member store returns its write: a failure reaches the caller", async () => {
  const events = [], disk = hostDisk(events), state = { member: null };
  const writer = createSealedStateWriter({ seal: (s) => JSON.stringify(s), put: (b) => disk.put(b), state, log: () => {} });
  const r = writer.memberStore.save({ epochs: {} }); if (r && r.catch) r.catch(() => {});
  assert.ok(r && typeof r.then === "function", "memberStore.save must return the write's promise");
  await until(() => disk.pending() > 0, "the write"); await disk.complete(false);
  await assert.rejects(r);
});
