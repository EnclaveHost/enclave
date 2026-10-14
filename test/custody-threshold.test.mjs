import test from "node:test";
import assert from "node:assert/strict";
import * as th from "../custody/threshold.mjs";

const subsets = (arr, k) => k === 0 ? [[]] : arr.flatMap((x, i) => subsets(arr.slice(i + 1), k - 1).map((s) => [x, ...s]));

test("every t-subset of a 3-of-5 split recovers the secret; every share verifies against the commitments", () => {
  const s = th.randomScalar();
  const { shares, commitments } = th.split(s, 3, 5);
  assert.equal(commitments.length, 3);
  for (const sh of shares) assert.ok(th.verifyShare(sh.x, sh.y, commitments));
  for (const sub of subsets(shares, 3)) assert.equal(th.combine(sub, 3), s);
});

test("t-1 shares do not determine the secret: any value is consistent with them", () => {
  // information-theoretic hiding, checked concretely: for 2 shares of a 3-of-5 split and ANY candidate secret there is a
  // degree-2 polynomial through (0, candidate) and both shares
  const s = th.randomScalar();
  const { shares } = th.split(s, 3, 5);
  const [a, b] = shares;
  const cand = th.randomScalar();
  // Lagrange through (0,cand), (a.x,a.y), (b.x,b.y) evaluated at 0 gives cand back: consistent; so 2 shares say nothing
  const pts = [{ x: 0, y: cand }, a, b];
  const at = (X) => pts.reduce((acc, p, i) => {
    let num = 1n, den = 1n;
    pts.forEach((q, j) => { if (j !== i) { num = (num * BigInt(X - q.x)) % th.Q; den = (den * BigInt(p.x - q.x)) % th.Q; } });
    num = ((num % th.Q) + th.Q) % th.Q; den = ((den % th.Q) + th.Q) % th.Q;
    let inv = 1n, base = den, e = th.Q - 2n;
    while (e > 0n) { if (e & 1n) inv = (inv * base) % th.Q; base = (base * base) % th.Q; e >>= 1n; }
    return (acc + p.y * num % th.Q * inv) % th.Q;
  }, 0n);
  assert.equal(at(a.x), a.y);
  assert.equal(at(b.x), b.y);
});

test("a tampered share fails verification, and combining with it gives a wrong secret", () => {
  const s = th.randomScalar();
  const { shares, commitments } = th.split(s, 3, 5);
  const bad = { x: shares[1].x, y: (shares[1].y + 1n) % th.Q };
  assert.equal(th.verifyShare(bad.x, bad.y, commitments), false);
  assert.notEqual(th.combine([shares[0], bad, shares[2]], 3), s);
  assert.equal(th.verifyShare(shares[0].x, shares[0].y, th.split(th.randomScalar(), 3, 5).commitments), false);
});

test("combine refuses too few shares and duplicate indices", () => {
  const { shares } = th.split(th.randomScalar(), 3, 5);
  assert.throws(() => th.combine(shares.slice(0, 2), 3), /need 3 shares/);
  assert.throws(() => th.combine([shares[0], shares[0], shares[1]], 3), /duplicate/);
  assert.throws(() => th.split(1n, 4, 3), /t <= n/);
  assert.throws(() => th.split(0n, 2, 3), /secret/);
});

test("redistribution 3-of-5 -> 2-of-4 keeps the secret and C_0 without anyone combining it", () => {
  const s = th.randomScalar();
  const old = th.split(s, 3, 5);
  const dealers = [old.shares[0], old.shares[2], old.shares[4]];
  const deals = dealers.map((d) => ({ xOld: d.x, ...th.reshareFrom(d.y, 2, 4) }));
  const fresh = [1, 2, 3, 4].map((xNew) => th.receiveReshare({ xNew, oldCommitments: old.commitments, tOld: 3,
    from: deals.map((d) => ({ xOld: d.xOld, sub: d.shares[xNew - 1].y, subCommitments: d.commitments })) }));
  // every new member derived the same new commitments
  for (const f of fresh) assert.deepEqual(f.commitments, fresh[0].commitments);
  assert.deepEqual(fresh[0].commitments[0], old.commitments[0]);
  for (const f of fresh) assert.ok(th.verifyShare(f.x, f.y, f.commitments));
  for (const sub of subsets(fresh, 2)) assert.equal(th.combine(sub, 2), s);
});

test("redistribution refuses a dealer that re-shares something other than its share", () => {
  const s = th.randomScalar();
  const old = th.split(s, 2, 3);
  const honest = { xOld: 1, ...th.reshareFrom(old.shares[0].y, 2, 3) };
  const liar = { xOld: 2, ...th.reshareFrom(th.randomScalar(), 2, 3) };
  assert.throws(() => th.receiveReshare({ xNew: 1, oldCommitments: old.commitments, tOld: 2,
    from: [honest, liar].map((d) => ({ xOld: d.xOld, sub: d.shares[0].y, subCommitments: d.commitments })) }), /not its share/);
  // and a dealer whose sub-share does not match its own sub-commitments
  const tampered = [honest, { xOld: 2, ...th.reshareFrom(old.shares[1].y, 2, 3) }].map((d) => ({ xOld: d.xOld, sub: d.shares[0].y, subCommitments: d.commitments }));
  tampered[1].sub = (tampered[1].sub + 1n) % th.Q;
  assert.throws(() => th.receiveReshare({ xNew: 1, oldCommitments: old.commitments, tOld: 2, from: tampered }), /does not match/);
});
