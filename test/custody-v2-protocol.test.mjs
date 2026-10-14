// Custody v2 cryptography (custody/v2/protocol.mjs): seats, the label-bound bundle, DLEQ partials, combine, handover.
//   run: node --test test/custody-v2-protocol.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "@noble/hashes/utils";
import * as v2 from "../custody/v2/protocol.mjs";
import * as hpke from "../custody/hpke.mjs";

const CHAIN = 8453, VAULT = "0x" + "11".repeat(20), ID = "0x" + "22".repeat(32), CID = "0x" + "33".repeat(32);
const CFG = "ab".repeat(32);
const label = (over = {}) => v2.labelOf({ chainId: CHAIN, vault: VAULT, id: ID, secretRev: 1, committeeId: CID, ...over });
const m = (enclave, i) => ({ enclave, identity: "0x" + String(i).padStart(40, "0") });
const binding = () => randomBytes(32);

// a committee with the given machines, its shares dealt by a trusted dealer (tests only; production keys come from genesis
// and handover, never a dealer)
function committee(machines) {
  const lay = v2.seatLayout(machines);
  const coeffs = Array.from({ length: lay.t }, () => v2.randomScalar());
  const evalAt = (k) => coeffs.reduce((acc, c, j) => (acc + c * BigInt(k) ** BigInt(j)) % v2.Q, 0n);
  const shares = new Map();
  for (let k = 1; k <= lay.W; k++) shares.set(k, evalAt(k));
  const g = v2.genesis({ _x: coeffs[0] });
  const commitments = coeffs.map((c) => v2.pointBytes(v2.publicShare(1, [v2.pointBytes(secp(c))])));
  return { lay, shares, commitments, Y: g.Y };
}
import { secp256k1 } from "@noble/curves/secp256k1";
const secp = (s) => secp256k1.ProjectivePoint.BASE.multiply(s);

test("seats: Enclave machines are ONE seat; n>=3 is 2/3 with weight 1; below 3 the Enclave seat alone reaches t", () => {
  let l = v2.seatLayout([m(true, 1)]);
  assert.deepEqual([l.n, l.t, l.W], [1, 1, 1]);
  l = v2.seatLayout([m(true, 1), m(true, 2), m(true, 3)]);
  assert.deepEqual([l.n, l.t, l.W], [1, 1, 1], "three Enclave machines are still one seat");
  assert.deepEqual([l.indicesOf(0), l.indicesOf(1), l.indicesOf(2)], [[1], [1], [1]], "replicas hold the same index");
  l = v2.seatLayout([m(true, 1), m(false, 2)]);
  assert.deepEqual([l.n, l.t, l.W, l.indicesOf(0), l.indicesOf(1)], [2, 2, 3, [1, 2], [3]], "Enclave holds t shares, the other host 1");
  l = v2.seatLayout([m(false, 1), m(true, 2), m(false, 3)]);
  assert.deepEqual([l.n, l.t, l.indicesOf(1), l.indicesOf(0), l.indicesOf(2)], [3, 2, [1], [2], [3]], "at 3 seats every seat weighs 1");
  l = v2.seatLayout([m(true, 1), m(true, 2), ...[3, 4, 5, 6].map((i) => m(false, i))]);
  assert.deepEqual([l.n, l.t, l.W], [5, 4, 5]);
  assert.throws(() => v2.seatLayout([m(false, 1), m(false, 2)]), /Enclave seat/);
  assert.throws(() => v2.seatLayout([m(false, 1)]), /Enclave seat/);
});

test("Enclave machines can never reach t alone once there are 3 seats (any number of Enclave machines)", () => {
  for (let others = 2; others <= 20; others++) {
    const l = v2.seatLayout([m(true, 0), m(true, 1), m(true, 2), ...Array.from({ length: others }, (_, i) => m(false, 10 + i))]);
    assert.ok(l.enclave.weight < l.t, `${others} other seats: Enclave weight ${l.enclave.weight} < t ${l.t}`);
  }
});

test("bundle: encrypt to Y, label proof binds the deployment, any t partials decrypt, fewer cannot", () => {
  const c = committee([m(true, 1), m(false, 2), m(false, 3), m(false, 4)]);   // n = 4, t = 3
  assert.equal(c.lay.t, 3);
  const L = label();
  const bundle = v2.encryptBundle({ Y: c.Y, label: L, env: { API_KEY: "s3cret" }, configSha256: CFG });
  assert.ok(v2.verifyLabelProof(bundle, L));
  assert.ok(!v2.verifyLabelProof(bundle, label({ id: "0x" + "44".repeat(32) })), "the same R under another deployment fails");
  assert.ok(!v2.verifyLabelProof(bundle, label({ secretRev: 2 })));
  const R = v2.parseBundle(bundle).R, b = binding();
  const parts = [1, 2, 3, 4].map((k) => v2.verifyPartial({ record: v2.partial({ k, x: c.shares.get(k), R, binding: b, commitments: c.commitments }), R, binding: b, commitments: c.commitments }));
  for (const set of [[0, 1, 2], [1, 2, 3], [0, 2, 3], [0, 1, 3]]) {
    const S = v2.combine(set.map((i) => parts[i]), 3);
    assert.deepEqual(v2.decryptBundle({ S, label: L, bundle }), { env: { API_KEY: "s3cret" }, configSha256: CFG });
  }
  assert.throws(() => v2.combine(parts.slice(0, 2), 3), /exactly 3/);
  const wrongS = v2.combine([parts[0], parts[1], { k: 9, D: parts[2].D }], 3);
  assert.throws(() => v2.decryptBundle({ S: wrongS, label: L, bundle }));
  assert.throws(() => v2.decryptBundle({ S: v2.combine(parts.slice(0, 3), 3), label: label({ secretRev: 2 }), bundle }), "a key under another label fails");
});

test("partials: a lying member is caught by its DLEQ proof; a proof is bound to its binding and index", () => {
  const c = committee([m(true, 1), m(false, 2), m(false, 3)]);
  const bundle = v2.encryptBundle({ Y: c.Y, label: label(), env: { A: "1" }, configSha256: CFG });
  const R = v2.parseBundle(bundle).R, b = binding();
  const good = v2.partial({ k: 2, x: c.shares.get(2), R, binding: b, commitments: c.commitments });
  const lie = v2.partial({ k: 2, x: (c.shares.get(2) + 1n) % v2.Q, R, binding: b, commitments: c.commitments });
  assert.throws(() => v2.verifyPartial({ record: lie, R, binding: b, commitments: c.commitments }), /does not verify/);
  assert.throws(() => v2.verifyPartial({ record: good, R, binding: binding(), commitments: c.commitments }), /does not verify/, "replayed under another binding");
  const relabel = Uint8Array.from(good); relabel[3] = 3;
  assert.throws(() => v2.verifyPartial({ record: relabel, R, binding: b, commitments: c.commitments }), /does not verify/, "claimed for another index");
  assert.equal(v2.verifyPartial({ record: good, R, binding: b, commitments: c.commitments }).k, 2);
});

test("partials travel sealed to the guest's recipient key", () => {
  const c = committee([m(true, 1)]);
  const bundle = v2.encryptBundle({ Y: c.Y, label: label(), env: { A: "1" }, configSha256: CFG });
  const R = v2.parseBundle(bundle).R, b = binding();
  const rk = hpke.generateKeyPair(), encKey = randomBytes(32);
  const sealed = v2.sealPartials({ recipientKey: rk.publicKey, binding: b, encKey, records: [v2.partial({ k: 1, x: c.shares.get(1), R, binding: b, commitments: c.commitments })] });
  const recs = v2.openPartials({ recipientPrivate: rk.privateKey, binding: b, encKey, count: 1, sealed });
  const S = v2.combine([v2.verifyPartial({ record: recs[0], R, binding: b, commitments: c.commitments })], 1);
  assert.equal(v2.decryptBundle({ S, label: label(), bundle }).env.A, "1");
  assert.throws(() => v2.openPartials({ recipientPrivate: hpke.generateKeyPair().privateKey, binding: b, encKey, count: 1, sealed }), "another key cannot open it");
  assert.throws(() => v2.openPartials({ recipientPrivate: rk.privateKey, binding: binding(), encKey, count: 1, sealed }), "another binding cannot open it");
});

test("genesis -> handover to more seats -> handover again: the key never changes and old bundles stay readable", () => {
  // genesis: the Enclave seat alone
  const g = v2.genesis();
  let machines = [m(true, 1)], lay = v2.seatLayout(machines);
  let shares = new Map([[1, g.shares[0].x]]), commitments = g.commitments;
  const L = label();
  const bundle = v2.encryptBundle({ Y: g.Y, label: L, env: { K: "v" }, configSha256: CFG });

  const handover = (newMachines) => {
    const newLay = v2.seatLayout(newMachines);
    const dealerSet = [...shares.keys()].slice(0, lay.t);
    const newIdx = Array.from({ length: newLay.W }, (_, i) => i + 1);
    const deals = dealerSet.map((k) => ({ dealerIndex: k, ...v2.deal({ x: shares.get(k), tNew: newLay.t, newIndices: newIdx }) }));
    const next = new Map(); let nextC = null;
    for (let mi = 0; mi < newMachines.length; mi++) {
      const mine = newLay.indicesOf(mi);
      const r = v2.receiveHandover({ deals: deals.map((dl) => ({ dealerIndex: dl.dealerIndex, dealCommitments: dl.commitments, sub: dl.sub })), oldCommitments: commitments, tOld: lay.t, tNew: newLay.t, myIndices: mine });
      for (const s of r.shares) { if (next.has(s.k)) assert.equal(next.get(s.k), s.x, "Enclave replicas receive the SAME share"); next.set(s.k, s.x); }
      if (nextC) assert.deepEqual(r.commitments, nextC); nextC = r.commitments;
    }
    machines = newMachines; lay = newLay; shares = next; commitments = nextC;
  };
  const unlock = () => {
    const R = v2.parseBundle(bundle).R, b = binding();
    const T = [...shares.keys()].slice(-lay.t);   // any t indices
    const S = v2.combine(T.map((k) => v2.verifyPartial({ record: v2.partial({ k, x: shares.get(k), R, binding: b, commitments }), R, binding: b, commitments })), lay.t);
    return v2.decryptBundle({ S, label: L, bundle }).env.K;
  };
  assert.equal(unlock(), "v");
  handover([m(true, 1), m(false, 2)]);                       // 2 seats: Enclave holds 2 of t=2
  assert.deepEqual([lay.t, lay.W], [2, 3]); assert.equal(unlock(), "v");
  handover([m(true, 1), m(true, 9), m(false, 2), m(false, 3), m(false, 4)]);   // 4 seats, a second Enclave machine
  assert.deepEqual([lay.n, lay.t], [4, 3]); assert.equal(unlock(), "v");
  assert.equal(commitments[0].toString(), g.Y.toString(), "Y unchanged across both handovers");
});

test("handover: a dealer that re-shares anything but its own share, or a bad sub-share, is refused", () => {
  const c = committee([m(true, 1), m(false, 2), m(false, 3)]);   // t = 2
  const newIdx = [1, 2, 3];
  const honest = v2.deal({ x: c.shares.get(1), tNew: 2, newIndices: newIdx });
  const forged = v2.deal({ x: 12345n, tNew: 2, newIndices: newIdx });
  const other = v2.deal({ x: c.shares.get(2), tNew: 2, newIndices: newIdx });
  const asDeal = (k, dl) => ({ dealerIndex: k, dealCommitments: dl.commitments, sub: dl.sub });
  assert.throws(() => v2.receiveHandover({ deals: [asDeal(1, honest), asDeal(2, forged)], oldCommitments: c.commitments, tOld: 2, tNew: 2, myIndices: [1] }), /does not re-share its own share/);
  const badSub = { ...asDeal(2, other), sub: new Map([...other.sub].map(([k, y]) => [k, k === 1 ? (y + 1n) % v2.Q : y])) };
  assert.throws(() => v2.receiveHandover({ deals: [asDeal(1, honest), badSub], oldCommitments: c.commitments, tOld: 2, tNew: 2, myIndices: [1] }), /does not match the dealer/);
  assert.throws(() => v2.receiveHandover({ deals: [asDeal(1, honest)], oldCommitments: c.commitments, tOld: 2, tNew: 2, myIndices: [1] }), /exactly 2 distinct dealers/);
});

test("deals travel sealed to the new machine, bound to the handover and the dealer's commitments", () => {
  const kp = hpke.generateKeyPair();
  const dl = v2.deal({ x: 7n, tNew: 2, newIndices: [1, 2] });
  const aadFields = { chainId: CHAIN, vault: VAULT, committeeId: CID, fromEpoch: 1, toEpoch: 2, dealerIndex: 1, dealCommitments: dl.commitments };
  const sealed = v2.sealDeal({ encKey: kp.publicKey, aadFields, entries: [...dl.sub] });
  assert.deepEqual(v2.openDeal({ encPrivate: kp.privateKey, encKey: kp.publicKey, aadFields, sealed }), dl.sub);
  assert.throws(() => v2.openDeal({ encPrivate: kp.privateKey, encKey: kp.publicKey, aadFields: { ...aadFields, toEpoch: 3 }, sealed }));
});
