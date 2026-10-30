// Custody v2 (docs/security/secret-custody-v2.md): ONE committee key, held by host custodians inside their TEEs.
// The reference for every v2 byte. The Go guest half (isolation/m2/custody/v2*.go) and EnclaveSecretVaultV2.sol implement
// the same formats; test/custody-v2-vectors.test.mjs pins all of them to test/fixtures/custody-v2-vectors.json.
//
// Group: secp256k1 (@noble/curves), points 33-byte compressed, scalars 32-byte big-endian. Hashes: domain line, then
// FIXED-WIDTH fields (u64/u32 big-endian, 20-byte addresses, 32-byte ids/keys, 33-byte points), as in v1.
//
//   hashToScalar(dom, ...) = int(SHA-512(dom ‖ ...)) mod q
//   label     = SHA-256(LABEL ‖ u64 chainId ‖ vault ‖ id ‖ u64 secretRev ‖ committeeId)
//   bundle    = R = r·G (33) ‖ proof (c 32 ‖ z 32) ‖ nonce (12) ‖ AES-256-GCM(K, nonce, aad = label, JSON {"v":2,"env",...})
//               S = r·Y, K = HKDF-SHA256(ikm = S (33), salt = label, info = KEY_INFO, 32)
//               proof: Schnorr PoK of r bound to label: A = k·G, c = H(POK ‖ label ‖ R ‖ A), z = k + c·r
//   partial   = for each share index k a member holds: D_k = x_k·R, with a DLEQ proof (log_G Y_k = log_R D_k)
//               c = H(DLEQ ‖ binding ‖ u32 k ‖ Y_k ‖ R ‖ D_k ‖ A1 ‖ A2), z = u + c·x_k   (A1 = u·G, A2 = u·R)
//               record = u32 k ‖ D_k (33) ‖ c (32) ‖ z (32) = 101 bytes; a member's answer = HPKE(recipientKey,
//               PARTIAL_INFO, aad = SHA-256(PARTIAL ‖ binding ‖ memberEncKey ‖ u32 records), records...)
//   combine   = S = Σ_{k∈T} λ_k(T)·D_k over exactly t verified indices T
//   binding   = SHA-256(RELEASE ‖ u64 chainId ‖ vault ‖ id ‖ u64 policyRev ‖ u64 secretRev ‖ committeeId ‖ u32 epoch
//                       ‖ challengeRoot ‖ runtimeId (32) ‖ SHA-256(transport SPKI) ‖ recipientKey (32))  -> report_data[0:32]
//   operator  = "enclave-custody-release-v2:<chainId>:<vault>:<id>:<endpoint>:<binding hex>:<expiry>" (personal_sign)
//   handover  = each dealer index k deals g_k (degree tNew-1, g_k(0) = x_k), commitments G_k,j = g_k,j·G; new index k'
//               gets g_k(k') sealed to its machine; x'_k' = Σ_{k∈D} λ_k(D)·g_k(k'); C'_j = Σ λ_k(D)·G_k,j; C'_0 == Y.
//
// THE SEATS (§6.1-6.2). All Enclave-owned machines are ONE seat holding the same share(s); every other machine is its own
// seat. n = seats. n >= 3: weight 1 each, t = ceil(2n/3). n < 3: an Enclave seat is required; t = (other seats) + 1, the
// Enclave seat holds t shares, the others 1. Indices: the Enclave seat first (1..wE), then the others in member order.
//
// WHAT THIS IS: textbook constructions (threshold ElGamal with a TDH2-style label proof, Chaum-Pedersen DLEQ, Shamir +
// Feldman, Desmedt-Jajodia redistribution) over audited primitives. It has NOT had an external review.
import { secp256k1 } from "@noble/curves/secp256k1";
import { mod, invert } from "@noble/curves/abstract/modular";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { hkdf } from "@noble/hashes/hkdf";
import { gcm } from "@noble/ciphers/aes";
import { randomBytes, concatBytes, utf8ToBytes, bytesToHex, hexToBytes } from "@noble/hashes/utils";
import * as hpke from "../hpke.mjs";
import { u64, u32, fixed, id32, context, checkEnv } from "../protocol.mjs";

const Point = secp256k1.ProjectivePoint;
export const Q = secp256k1.CURVE.n;
export const MAX_SEATS = 64;          // a committee's seats (and so share indices) are bounded: on-chain loops, deal sizes
export const MAX_MACHINES = 96;       // seats + Enclave replicas
export const PARTIAL_RECORD_BYTES = 101;
export const DOMAIN = {
  LABEL: "enclave-custody-v2 label\n",
  POK: "enclave-custody-v2 pok\n",
  DLEQ: "enclave-custody-v2 dleq\n",
  PARTIAL: "enclave-custody-v2 partial\n",
  CHALLENGES: "enclave-custody-v2 challenges\n",
  RELEASE: "enclave-custody-release-v2\n",
  DEAL: "enclave-custody-v2 deal\n",
};
export const KEY_INFO = utf8ToBytes("enclave-custody-v2 key");
export const PARTIAL_INFO = utf8ToBytes("enclave-custody-v2 partial-release");
export const DEAL_INFO = utf8ToBytes("enclave-custody-v2 handover-deal");
const d = (s) => utf8ToBytes(s);
const hex = (b) => bytesToHex(b);

// ---- scalars and points ----
export const scalarToBytes = (s) => hexToBytes(s.toString(16).padStart(64, "0"));
export function bytesToScalar(b, what = "scalar") {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error(`${what}: 32 bytes`);
  const s = BigInt("0x" + bytesToHex(b));
  if (s >= Q) throw new Error(`${what}: out of range`);
  return s;
}
export function randomScalar() { for (;;) { const s = BigInt("0x" + bytesToHex(randomBytes(32))); if (s > 0n && s < Q) return s; } }
export const hashToScalar = (...parts) => mod(BigInt("0x" + bytesToHex(sha512(concatBytes(...parts)))), Q);
export const pointBytes = (p) => p.toRawBytes(true);
// a point from 33 bytes; never the identity (fromHex refuses it), always on the curve
export function pointOf(b, what = "point") {
  const bytes = fixed(b, 33, what);
  try { return Point.fromHex(bytes); } catch { throw new Error(`${what}: not a curve point`); }
}
const mulG = (s) => Point.BASE.multiply(s);
const mul = (p, s) => (s === 0n ? Point.ZERO : p.multiply(s));
const evalPoly = (coeffs, x) => { let y = 0n; for (let i = coeffs.length - 1; i >= 0; i--) y = mod(y * x + coeffs[i], Q); return y; };
// Y_k = Σ_j C_j·k^j from the commitments alone
export function publicShare(k, commitments) {
  if (!Number.isInteger(k) || k < 1 || k > MAX_SEATS * 2) throw new Error("bad share index");
  let acc = Point.ZERO, kp = 1n;
  for (const c of commitments) { acc = acc.add(mul(pointOf(c, "commitment"), kp)); kp = mod(kp * BigInt(k), Q); }
  return acc;
}
// λ_k(T) at 0 over the index set T
export function lagrangeAt0(k, set) {
  let num = 1n, den = 1n;
  for (const m of set) { if (m === k) continue; num = mod(num * BigInt(m), Q); den = mod(den * BigInt(m - k), Q); }
  return mod(num * invert(den, Q), Q);
}

// ---- seats (§6.1-6.2) ----
// machines: [{ identity, encKey, endpoint, chipId, registryId, measurement, enclave }] in member order.
// -> { n, t, W, enclave: { weight, indices, machines } | null, seats: [{ enclave, weight, indices, machines }] ,
//      indicesOf(machineIndex) -> [k...] }
export function seatLayout(machines) {
  if (!Array.isArray(machines) || machines.length === 0 || machines.length > MAX_MACHINES) throw new Error("seats: 1..96 machines");
  const ents = machines.map((m, i) => ({ i, enclave: !!m.enclave }));
  const enc = ents.filter((e) => e.enclave), others = ents.filter((e) => !e.enclave);
  const n = others.length + (enc.length ? 1 : 0);
  if (n > MAX_SEATS) throw new Error(`seats: at most ${MAX_SEATS}`);
  let t, wE;
  if (n >= 3) { t = Math.ceil((2 * n) / 3); wE = 1; }
  else { if (!enc.length) throw new Error("seats: fewer than 3 seats needs the Enclave seat"); t = others.length + 1; wE = t; }
  const seats = [];
  let next = 1;
  if (enc.length) { seats.push({ enclave: true, weight: wE, indices: Array.from({ length: wE }, (_, j) => next + j), machines: enc.map((e) => e.i) }); next += wE; }
  for (const o of others) { seats.push({ enclave: false, weight: 1, indices: [next], machines: [o.i] }); next += 1; }
  const byMachine = new Map();
  for (const s of seats) for (const mi of s.machines) byMachine.set(mi, s.indices);
  return { n, t, W: next - 1, seats, enclave: seats.find((s) => s.enclave) || null, indicesOf: (mi) => byMachine.get(mi) || [] };
}

// ---- genesis: the Enclave seat creates x (t = 1, one share index) ----
export function genesis({ _x } = {}) {
  const x = _x ?? randomScalar();
  const Y = pointBytes(mulG(x));
  return { shares: [{ k: 1, x }], commitments: [Y], Y };
}

// ---- the bundle (owner side) ----
export function labelOf({ chainId, vault, id, secretRev, committeeId }) {
  return sha256(concatBytes(d(DOMAIN.LABEL), context({ chainId, vault }), id32(id), u64(secretRev), fixed(committeeId, 32, "committeeId")));
}
const keyOf = (S, label) => hkdf(sha256, pointBytes(S), label, KEY_INFO, 32);
export function encryptBundle({ Y, label, env, configSha256: cfg, _r, _k, _nonce }) {
  checkEnv(env);
  if (!/^[0-9a-f]{64}$/.test(String(cfg))) throw new Error("a bundle commits the config it may be substituted into (configSha256)");
  const L = fixed(label, 32, "label");
  const r = _r ?? randomScalar(), k = _k ?? randomScalar();
  const R = mulG(r), A = mulG(k);
  const c = hashToScalar(d(DOMAIN.POK), L, pointBytes(R), pointBytes(A));
  const z = mod(k + c * r, Q);
  const S = mul(pointOf(Y, "committee key"), r);
  const nonce = _nonce || randomBytes(12);
  const ct = gcm(keyOf(S, L), nonce, L).encrypt(utf8ToBytes(JSON.stringify({ v: 2, env, configSha256: cfg })));
  return concatBytes(pointBytes(R), scalarToBytes(c), scalarToBytes(z), nonce, ct);
}
// -> { R (33 bytes), Rp (Point), c, z, sealed (nonce ‖ ct) }; shape only
export function parseBundle(b) {
  if (!(b instanceof Uint8Array) || b.length < 33 + 64 + 12 + 16) throw new Error("bundle too short");
  const R = b.subarray(0, 33);
  return { R, Rp: pointOf(R, "bundle R"), c: bytesToScalar(b.subarray(33, 65), "proof c"), z: bytesToScalar(b.subarray(65, 97), "proof z"), sealed: b.subarray(97) };
}
// the label proof: a member decrypts R only for the deployment whose label the proof names (TDH2's role, §4.2)
export function verifyLabelProof(bundle, label) {
  const p = parseBundle(bundle);
  const A = mulG(p.z).subtract(mul(p.Rp, p.c));
  if (A.equals(Point.ZERO)) return false;
  return hashToScalar(d(DOMAIN.POK), fixed(label, 32, "label"), pointBytes(p.Rp), pointBytes(A)) === p.c;
}
// -> { env, configSha256 }
export function decryptBundle({ S, label, bundle }) {
  const p = parseBundle(bundle);
  const L = fixed(label, 32, "label");
  const pt = gcm(keyOf(S, L), p.sealed.subarray(0, 12), L).decrypt(p.sealed.subarray(12));
  const o = JSON.parse(new TextDecoder().decode(pt));
  if (!o || o.v !== 2) throw new Error("unknown bundle version");
  if (!/^[0-9a-f]{64}$/.test(String(o.configSha256))) throw new Error("the bundle commits no config");
  checkEnv(o.env);
  return { env: o.env, configSha256: o.configSha256 };
}

// ---- release ----
export function challengeRoot(challenges) {
  if (!Array.isArray(challenges) || challenges.length === 0 || challenges.length > MAX_MACHINES) throw new Error("challenges: 1..96 entries");
  const rows = challenges.map((c) => ({ k: fixed(c.encKey, 32, "challenge encKey"), n: fixed(c.nonce, 32, "challenge nonce") }))
    .sort((a, b) => (hex(a.k) < hex(b.k) ? -1 : 1));
  for (let i = 1; i < rows.length; i++) if (hex(rows[i].k) === hex(rows[i - 1].k)) throw new Error("challenges: duplicate custodian");
  return sha256(concatBytes(d(DOMAIN.CHALLENGES), u32(rows.length), ...rows.flatMap((r) => [r.k, r.n])));
}
export function releaseBinding({ chainId, vault, id, policyRev, secretRev, committeeId, epoch, challenges, runtimeId, transportSpki, recipientKey }) {
  if (!(transportSpki instanceof Uint8Array) || transportSpki.length < 32) throw new Error("transportSpki must be a DER SPKI");
  return sha256(concatBytes(d(DOMAIN.RELEASE), context({ chainId, vault }), id32(id), u64(policyRev), u64(secretRev), fixed(committeeId, 32, "committeeId"),
                            u32(epoch), challengeRoot(challenges), fixed(runtimeId, 32, "runtimeId"), sha256(transportSpki), fixed(recipientKey, 32, "recipientKey")));
}
export const operatorMessage = ({ chainId, vault, id, endpoint, binding, expiry }) =>
  `enclave-custody-release-v2:${chainId}:${String(vault).toLowerCase()}:${id}:${endpoint}:${hex(fixed(binding, 32, "binding"))}:${expiry}`;

// one partial for share index k; deterministic when _u is given (vectors)
export function partial({ k, x, R, binding, commitments, _u }) {
  const Rp = pointOf(R, "bundle R");
  const D = mul(Rp, x), Yk = publicShare(k, commitments);
  const u = _u ?? randomScalar();
  const A1 = mulG(u), A2 = mul(Rp, u);
  const c = hashToScalar(d(DOMAIN.DLEQ), fixed(binding, 32, "binding"), u32(k), pointBytes(Yk), pointBytes(Rp), pointBytes(D), pointBytes(A1), pointBytes(A2));
  const z = mod(u + c * x, Q);
  return concatBytes(u32(k), pointBytes(D), scalarToBytes(c), scalarToBytes(z));
}
// -> { k, D (Point) } or throws: the DLEQ proof against Y_k from the commitments
export function verifyPartial({ record, R, binding, commitments }) {
  const rec = fixed(record, PARTIAL_RECORD_BYTES, "partial");
  const k = new DataView(rec.buffer, rec.byteOffset).getUint32(0);
  const D = pointOf(rec.subarray(4, 37), "partial D");
  const c = bytesToScalar(rec.subarray(37, 69), "partial c"), z = bytesToScalar(rec.subarray(69, 101), "partial z");
  const Rp = pointOf(R, "bundle R"), Yk = publicShare(k, commitments);
  const A1 = mulG(z).subtract(mul(Yk, c)), A2 = mul(Rp, z).subtract(mul(D, c));
  const c2 = hashToScalar(d(DOMAIN.DLEQ), fixed(binding, 32, "binding"), u32(k), pointBytes(Yk), pointBytes(Rp), pointBytes(D), pointBytes(A1), pointBytes(A2));
  if (c2 !== c) throw new Error(`partial for index ${k}: the proof does not verify`);
  return { k, D };
}
export const partialAad = ({ binding, encKey, count }) => sha256(concatBytes(d(DOMAIN.PARTIAL), fixed(binding, 32, "binding"), fixed(encKey, 32, "encKey"), u32(count)));
export const sealPartials = ({ recipientKey, binding, encKey, records }) =>
  hpke.seal(fixed(recipientKey, 32, "recipientKey"), PARTIAL_INFO, partialAad({ binding, encKey, count: records.length }), concatBytes(...records));
export function openPartials({ recipientPrivate, binding, encKey, count, sealed }) {
  const pt = hpke.open(recipientPrivate, PARTIAL_INFO, partialAad({ binding, encKey, count }), sealed);
  if (pt.length !== count * PARTIAL_RECORD_BYTES) throw new Error("partials: wrong length");
  return Array.from({ length: count }, (_, i) => pt.subarray(i * PARTIAL_RECORD_BYTES, (i + 1) * PARTIAL_RECORD_BYTES));
}
// S from exactly t verified partials with distinct indices
export function combine(verified, t) {
  const ks = verified.map((v) => v.k);
  if (verified.length !== t || new Set(ks).size !== t) throw new Error(`combine: exactly ${t} distinct share indices`);
  let S = Point.ZERO;
  for (const v of verified) S = S.add(mul(v.D, lagrangeAt0(v.k, ks)));
  if (S.equals(Point.ZERO)) throw new Error("combine: identity");
  return S;
}

// ---- handover (§4.4) ----
// a dealer holding index k deals x_k to the new indices: -> { commitments (tNew x 33), sub: Map(k' -> scalar) }
export function deal({ x, tNew, newIndices, _coeffs }) {
  if (!Number.isInteger(tNew) || tNew < 1 || tNew > MAX_SEATS * 2) throw new Error("deal: bad tNew");
  const coeffs = [x];
  for (let j = 1; j < tNew; j++) coeffs.push(_coeffs ? _coeffs[j - 1] : randomScalar());
  const sub = new Map(newIndices.map((kk) => [kk, evalPoly(coeffs, BigInt(kk))]));
  return { commitments: coeffs.map((c) => pointBytes(mulG(c))), sub };
}
export const commitmentsHash = (cs) => sha256(concatBytes(...cs.map((c) => fixed(c, 33, "commitment"))));
export const dealAad = ({ chainId, vault, committeeId, fromEpoch, toEpoch, dealerIndex, encKey, dealCommitments }) =>
  sha256(concatBytes(d(DOMAIN.DEAL), context({ chainId, vault }), fixed(committeeId, 32, "committeeId"), u32(fromEpoch), u32(toEpoch), u32(dealerIndex),
                     fixed(encKey, 32, "encKey"), commitmentsHash(dealCommitments)));
// the sub-shares for ONE new machine (all its new indices), sealed to its encKey: plaintext = (u32 k' ‖ scalar 32)*
export function sealDeal({ encKey, aadFields, entries }) {
  return hpke.seal(fixed(encKey, 32, "encKey"), DEAL_INFO, dealAad({ ...aadFields, encKey }), concatBytes(...entries.map(([kk, y]) => concatBytes(u32(kk), scalarToBytes(y)))));
}
export function openDeal({ encPrivate, encKey, aadFields, sealed }) {
  const pt = hpke.open(encPrivate, DEAL_INFO, dealAad({ ...aadFields, encKey }), sealed);
  if (pt.length % 36) throw new Error("deal: bad length");
  const out = new Map();
  for (let i = 0; i < pt.length; i += 36) out.set(new DataView(pt.buffer, pt.byteOffset + i).getUint32(0), bytesToScalar(pt.subarray(i + 4, i + 36), "sub-share"));
  return out;
}
// a dealer's commitments must start at that dealer's OLD public share: it re-shares x_k, nothing else
export function checkDealCommitments({ dealerIndex, dealCommitments, oldCommitments }) {
  if (!pointOf(dealCommitments[0], "deal C0").equals(publicShare(dealerIndex, oldCommitments))) throw new Error(`deal from index ${dealerIndex}: does not re-share its own share`);
}
export function verifySubShare({ newIndex, y, dealCommitments }) {
  if (!mulG(y).equals(publicShare(newIndex, dealCommitments))) throw new Error(`sub-share for index ${newIndex}: does not match the dealer's commitments`);
}
// new member: deals = [{ dealerIndex, dealCommitments, sub (Map) }] from EXACTLY the dealer set D (|D| = tOld)
// -> { shares: [{ k', x' }], commitments (tNew x 33) }
export function receiveHandover({ deals, oldCommitments, tOld, tNew, myIndices }) {
  const D = deals.map((x) => x.dealerIndex);
  if (deals.length !== tOld || new Set(D).size !== tOld) throw new Error(`handover: exactly ${tOld} distinct dealers`);
  const lam = new Map(D.map((k) => [k, lagrangeAt0(k, D)]));
  for (const dl of deals) {
    if (dl.dealCommitments.length !== tNew) throw new Error("handover: a deal has the wrong degree");
    checkDealCommitments({ dealerIndex: dl.dealerIndex, dealCommitments: dl.dealCommitments, oldCommitments });
    for (const kk of myIndices) {
      const y = dl.sub.get(kk);
      if (y === undefined) throw new Error(`handover: dealer ${dl.dealerIndex} sent no sub-share for index ${kk}`);
      verifySubShare({ newIndex: kk, y, dealCommitments: dl.dealCommitments });
    }
  }
  const shares = myIndices.map((kk) => ({ k: kk, x: deals.reduce((acc, dl) => mod(acc + lam.get(dl.dealerIndex) * dl.sub.get(kk), Q), 0n) }));
  const commitments = [];
  for (let j = 0; j < tNew; j++) {
    let C = Point.ZERO;
    for (const dl of deals) C = C.add(mul(pointOf(dl.dealCommitments[j], "deal commitment"), lam.get(dl.dealerIndex)));
    commitments.push(pointBytes(C));
  }
  if (hex(commitments[0]) !== hex(fixed(oldCommitments[0], 33, "old C0"))) throw new Error("handover: the new key is not the old key");
  for (const s of shares) if (!mulG(s.x).equals(publicShare(s.k, commitments))) throw new Error("handover: a new share does not match the new commitments");
  return { shares, commitments };
}
