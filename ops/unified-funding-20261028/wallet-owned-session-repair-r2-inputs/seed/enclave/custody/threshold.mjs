// Threshold layer: Shamir secret sharing over the secp256k1 scalar field, with Feldman commitments, and verifiable share
// redistribution to a new committee.
//
// WHAT THIS IS: textbook constructions composed over audited primitives. The group and field arithmetic is @noble/curves
// (secp256k1 points, modular inverse); randomness is @noble/hashes' CSPRNG. The code here is polynomial evaluation,
// Lagrange interpolation and the commitment checks: about a hundred lines, covered by test/custody-threshold.test.mjs.
// It has NOT had an external review. docs/security/secret-custody.md lists it as a review item before real value depends on it.
//
// - split(s, t, n): f(x) = s + a1 x + ... + a_{t-1} x^{t-1} mod q; share i is (i, f(i)) for i = 1..n; commitments C_k = a_k G.
// - verifyShare: y G == sum_k C_k x^k. A custodian checks its share before accepting a bundle; a recipient checks every share
//   a custodian returns before combining, so one lying custodian is detected and named, never silently mixed in.
// - combine: Lagrange at 0 over any t verified shares.
// - redistribution (Desmedt-Jajodia, verifiable form as in Wong-Wang-Wing): each of t old holders re-shares ITS share to the new
//   committee; new member j's share is sum_i lambda_i * sub_{i,j}. The new commitments are sum_i lambda_i C'_{i,k}, and their
//   constant term must equal the old C_0, which proves the redistributed secret is the same secret. Nobody ever holds s.
import { secp256k1 } from "@noble/curves/secp256k1";
import { mod, invert } from "@noble/curves/abstract/modular";
import { randomBytes, bytesToHex, hexToBytes } from "@noble/hashes/utils";

const Point = secp256k1.ProjectivePoint;
export const Q = secp256k1.CURVE.n;
export const MAX_MEMBERS = 32;

export const scalarToBytes = (s) => hexToBytes(s.toString(16).padStart(64, "0"));
export function bytesToScalar(b) {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error("threshold: a scalar is 32 bytes");
  const s = BigInt("0x" + bytesToHex(b));
  if (s >= Q) throw new Error("threshold: scalar out of range");
  return s;
}
// uniform in [1, q-1] by rejection (never biased by a modular reduction)
export function randomScalar() {
  for (;;) { const s = BigInt("0x" + bytesToHex(randomBytes(32))); if (s > 0n && s < Q) return s; }
}
const pointBytes = (p) => p.toRawBytes(true);
const pointOf = (b) => Point.fromHex(b);
const mulG = (s) => (s === 0n ? Point.ZERO : Point.BASE.multiply(s));

function checkParams(t, n) {
  if (!Number.isInteger(t) || !Number.isInteger(n) || t < 1 || n < t || n > MAX_MEMBERS)
    throw new Error(`threshold: need 1 <= t <= n <= ${MAX_MEMBERS} (got t=${t}, n=${n})`);
}
const evalPoly = (coeffs, x) => { let y = 0n; for (let k = coeffs.length - 1; k >= 0; k--) y = mod(y * x + coeffs[k], Q); return y; };

// -> { shares: [{ x, y }] (x = 1..n, y a bigint), commitments: [33-byte compressed points] (length t) }
export function split(secret, t, n, { _coeffs } = {}) {
  checkParams(t, n);
  if (typeof secret !== "bigint" || secret <= 0n || secret >= Q) throw new Error("threshold: the secret must be a scalar in [1, q-1]");
  const coeffs = [secret];
  for (let k = 1; k < t; k++) coeffs.push(_coeffs ? _coeffs[k - 1] : randomScalar());
  return { shares: Array.from({ length: n }, (_, i) => ({ x: i + 1, y: evalPoly(coeffs, BigInt(i + 1)) })),
           commitments: coeffs.map((c) => pointBytes(mulG(c))) };
}

// the public share point Y_x = sum_k C_k x^k, computed from the commitments alone
export function publicShare(x, commitments) {
  if (!Number.isInteger(x) || x < 1 || x > MAX_MEMBERS) throw new Error("threshold: bad share index");
  let acc = Point.ZERO, xp = 1n;
  for (const c of commitments) { acc = acc.add(pointOf(c).multiplyUnsafe(xp)); xp = mod(xp * BigInt(x), Q); }
  return acc;
}
export function verifyShare(x, y, commitments) {
  try { return typeof y === "bigint" && y > 0n && y < Q && mulG(y).equals(publicShare(x, commitments)); }
  catch { return false; }
}
// the secret's own public point (C_0): what a bundle commits to
export const secretPoint = (commitments) => pointOf(commitments[0]);

// Lagrange coefficient at 0 for index xi over the index set xs
export function lagrangeAt0(xi, xs) {
  let num = 1n, den = 1n;
  for (const xj of xs) {
    if (xj === xi) continue;
    num = mod(num * BigInt(xj), Q);
    den = mod(den * BigInt(xj - xi), Q);
  }
  return mod(num * invert(den, Q), Q);
}

// combine t (or more) shares; duplicates and out-of-range indices are refused, never silently dropped
export function combine(shares, t) {
  if (!Array.isArray(shares) || shares.length < t) throw new Error(`threshold: need ${t} shares, have ${shares?.length ?? 0}`);
  const use = shares.slice(0, t), xs = use.map((s) => s.x);
  if (new Set(xs).size !== xs.length) throw new Error("threshold: duplicate share index");
  let s = 0n;
  for (const { x, y } of use) s = mod(s + y * lagrangeAt0(x, xs), Q);
  if (s === 0n) throw new Error("threshold: combined to zero");
  return s;
}

// ---- redistribution (old committee -> new committee, same secret) ----
// Old holder at index xi re-shares its share y_i: a fresh polynomial g_i with g_i(0) = y_i, degree t'-1, over n' new members.
export const reshareFrom = (y, tNew, nNew) => split(y, tNew, nNew);
// New member at index xNew combines the sub-shares it received from the old holders `from` = [{ xOld, sub, subCommitments }]
// (exactly the old threshold of them). It checks each sub-share against its dealer's sub-commitments, each dealer's g_i(0)
// against the OLD public share Y_{xOld} (so a dealer cannot re-share a value other than its real share), and returns its new
// share plus the new committee's commitments, whose constant term is checked equal to the old C_0 (same secret).
export function receiveReshare({ xNew, from, oldCommitments, tOld }) {
  if (!Array.isArray(from) || from.length !== tOld) throw new Error(`threshold: redistribution needs exactly ${tOld} old holders`);
  const xs = from.map((f) => f.xOld);
  if (new Set(xs).size !== xs.length) throw new Error("threshold: duplicate old holder");
  let y = 0n, newC = null;
  for (const { xOld, sub, subCommitments } of from) {
    if (!verifyShare(xNew, sub, subCommitments)) throw new Error(`threshold: sub-share from old holder ${xOld} does not match its commitments`);
    if (!pointOf(subCommitments[0]).equals(publicShare(xOld, oldCommitments)))
      throw new Error(`threshold: old holder ${xOld} re-shared a value that is not its share`);
    const lam = lagrangeAt0(xOld, xs);
    y = mod(y + lam * sub, Q);
    const scaled = subCommitments.map((c) => pointOf(c).multiplyUnsafe(lam));
    newC = newC ? newC.map((p, k) => p.add(scaled[k])) : scaled;
    if (newC.length !== subCommitments.length) throw new Error("threshold: dealers disagree on the new threshold");
  }
  if (!newC[0].equals(secretPoint(oldCommitments))) throw new Error("threshold: redistribution changed the secret");
  return { x: xNew, y, commitments: newC.map(pointBytes) };
}
