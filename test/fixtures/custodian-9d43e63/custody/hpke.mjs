// HPKE (RFC 9180), base mode, single-shot, for one suite only:
//   DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM   (kem 0x0020, kdf 0x0001, aead 0x0001)
//
// AES-128-GCM and not ChaCha20-Poly1305 because the guest half (isolation/m2/custody, Go) is standard-library only, and Go's
// standard library has AES-GCM but no ChaCha20-Poly1305. Every primitive here comes from the audited @noble libraries (x25519,
// HKDF, SHA-256, AES-GCM). This file is only the RFC's labelled key schedule around them, and test/custody-hpke.test.mjs
// checks it byte for byte against the RFC's own Appendix A.1 vectors (the Go side checks the same vectors). Isomorphic: no node: imports, so the browser (owner side) and node (custodian, guest) run the same code.
import { x25519 } from "@noble/curves/ed25519";
import { extract, expand } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { gcm } from "@noble/ciphers/aes";
import { randomBytes, concatBytes, utf8ToBytes } from "@noble/hashes/utils";

const KEM_ID = 0x0020, KDF_ID = 0x0001, AEAD_ID = 0x0001;
const NK = 16, NN = 12, NH = 32, NSECRET = 32;
const i2osp = (n, w) => { const b = new Uint8Array(w); for (let i = w - 1; i >= 0; i--) { b[i] = n & 0xff; n >>>= 8; } return b; };
const HPKE_V1 = utf8ToBytes("HPKE-v1");
const SUITE_KEM = concatBytes(utf8ToBytes("KEM"), i2osp(KEM_ID, 2));
const SUITE_HPKE = concatBytes(utf8ToBytes("HPKE"), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));
const EMPTY = new Uint8Array(0);

const labeledExtract = (suite, salt, label, ikm) => extract(sha256, concatBytes(HPKE_V1, suite, utf8ToBytes(label), ikm), salt);
const labeledExpand = (suite, prk, label, info, L) => expand(sha256, prk, concatBytes(i2osp(L, 2), HPKE_V1, suite, utf8ToBytes(label), info), L);

function dh(sk, pk) {
  const out = x25519.getSharedSecret(sk, pk);
  // RFC 9180 §7.1.4: an all-zero X25519 output (a low-order public key) MUST be rejected
  if (out.every((b) => b === 0)) throw new Error("hpke: all-zero X25519 shared secret (low-order public key)");
  return out;
}

// RFC 9180 §7.1.3 DeriveKeyPair: deterministic keys from 32+ bytes of input keying material
export function deriveKeyPair(ikm) {
  const prk = labeledExtract(SUITE_KEM, EMPTY, "dkp_prk", ikm);
  const sk = labeledExpand(SUITE_KEM, prk, "sk", EMPTY, 32);
  return { privateKey: sk, publicKey: x25519.getPublicKey(sk) };
}
export const generateKeyPair = () => deriveKeyPair(randomBytes(32));
export const publicKeyOf = (sk) => x25519.getPublicKey(sk);

function extractAndExpand(dhOut, kemContext) {
  const prk = labeledExtract(SUITE_KEM, EMPTY, "eae_prk", dhOut);
  return labeledExpand(SUITE_KEM, prk, "shared_secret", kemContext, NSECRET);
}

function keySchedule(sharedSecret, info) {
  const pskIdHash = labeledExtract(SUITE_HPKE, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(SUITE_HPKE, EMPTY, "info_hash", info);
  const ctx = concatBytes(new Uint8Array([0x00]), pskIdHash, infoHash);   // mode_base
  const secret = labeledExtract(SUITE_HPKE, sharedSecret, "secret", EMPTY);
  return { key: labeledExpand(SUITE_HPKE, secret, "key", ctx, NK), baseNonce: labeledExpand(SUITE_HPKE, secret, "base_nonce", ctx, NN),
           exporterSecret: labeledExpand(SUITE_HPKE, secret, "exp", ctx, NH) };
}

const nonceFor = (base, seq) => { const n = Uint8Array.from(base), s = i2osp(seq, NN); for (let i = 0; i < NN; i++) n[i] ^= s[i]; return n; };

// sender context; `_ikmE` is for the RFC test vectors only (a real seal always draws a fresh ephemeral key)
export function setupBaseS(pkR, info, { _ikmE } = {}) {
  const { privateKey: skE, publicKey: pkE } = _ikmE ? deriveKeyPair(_ikmE) : generateKeyPair();
  const shared = extractAndExpand(dh(skE, pkR), concatBytes(pkE, pkR));
  return { enc: pkE, ...keySchedule(shared, info), sharedSecret: shared };
}
export function setupBaseR(enc, skR, info) {
  const pkR = x25519.getPublicKey(skR);
  const shared = extractAndExpand(dh(skR, enc), concatBytes(enc, pkR));
  return { ...keySchedule(shared, info), sharedSecret: shared };
}
export const sealWith = (ctx, seq, aad, pt) => gcm(ctx.key, nonceFor(ctx.baseNonce, seq), aad).encrypt(pt);
export const openWith = (ctx, seq, aad, ct) => gcm(ctx.key, nonceFor(ctx.baseNonce, seq), aad).decrypt(ct);

// single-shot: the wire form is enc(32) ‖ ciphertext
export function seal(pkR, info, aad, pt, opts) {
  const ctx = setupBaseS(pkR, info, opts);
  return concatBytes(ctx.enc, sealWith(ctx, 0, aad, pt));
}
export function open(skR, info, aad, blob) {
  if (!(blob instanceof Uint8Array) || blob.length < 32 + 16) throw new Error("hpke: sealed blob too short");
  const ctx = setupBaseR(blob.subarray(0, 32), skR, info);
  return openWith(ctx, 0, aad, blob.subarray(32));
}
