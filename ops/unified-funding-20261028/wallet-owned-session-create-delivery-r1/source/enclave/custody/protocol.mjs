// The custody wire and storage formats, in one place. Isomorphic (browser owner tooling, node custodians, the JS reference
// recipient); the Go guest half (isolation/m2/custody) implements the same bytes and test/custody-vectors.test.mjs pins both
// to test/fixtures/custody-vectors.json.
//
// Every hash below is SHA-256 over a domain line followed by FIXED-WIDTH fields (u64/u32 big-endian, 20-byte addresses,
// 32-byte ids and keys, 33-byte compressed points), so no two field sequences can produce the same input.
//
//   context      = u64 chainId ‖ vault(20)                                   names ONE vault on ONE chain
//   DEK          = HKDF-SHA256(ikm = s (32), salt = sha256(DEK ‖ context ‖ id ‖ u64 secretRev), info "dek", 32)
//                  s is the Shamir secret; the DEK never depends on the committee epoch, so a reshare keeps it
//   bundle       = nonce(12) ‖ AES-256-GCM(DEK, nonce, aad = sha256(BUNDLE ‖ context ‖ id ‖ u64 secretRev ‖ C0(33)),
//                                          JSON {"v":1,"env":{NAME:value},"configSha256":"<hex>"})
//   share at rest= HPKE(member encKey, info SHARE_AT_REST, aad = shareAad(...), y (32))        80 bytes
//   challenges   = sha256(CHALLENGES ‖ u8 count ‖ (encKey(32) ‖ nonce(32)) sorted by encKey)
//   binding      = sha256(RELEASE ‖ context ‖ id ‖ u64 policyRev ‖ u64 secretRev ‖ u32 epoch ‖ challenges ‖ runtimeId(32)
//                         ‖ sha256(transport SPKI) ‖ recipientKey(32))          -> report_data[0:32]
//   response     = HPKE(recipientKey, info SHARE_RELEASE, aad = sha256(RESPONSE ‖ binding ‖ encKey ‖ u8 index), y (32))
//   operator msg = "enclave-custody-release-v1:<chainId>:<vault>:<id>:<endpoint>:<binding hex>:<expiry>" (personal_sign)
import { sha256 } from "@noble/hashes/sha2";
import { hkdf } from "@noble/hashes/hkdf";
import { gcm } from "@noble/ciphers/aes";
import { randomBytes, concatBytes, utf8ToBytes, bytesToHex, hexToBytes } from "@noble/hashes/utils";
import * as hpke from "./hpke.mjs";
import * as th from "./threshold.mjs";

export const DOMAIN = {
  DEK: "enclave-custody-v1 dek\n",
  BUNDLE: "enclave-custody-v1 bundle\n",
  SHARE: "enclave-custody-v1 share\n",
  CHALLENGES: "enclave-custody-v1 challenges\n",
  RELEASE: "enclave-custody-release-v1\n",
  RESPONSE: "enclave-custody-v1 response\n",
  DEAL: "enclave-custody-v1 deal\n",
};
export const INFO = {
  SHARE_AT_REST: utf8ToBytes("enclave-custody-v1 share-at-rest"),
  SHARE_RELEASE: utf8ToBytes("enclave-custody-v1 share-release"),
  DEAL: utf8ToBytes("enclave-custody-v1 reshare-deal"),
};
export const SEALED_SHARE_BYTES = 80;
export const POINT_BYTES = 33;
export const OPERATOR_SIG_TTL_SEC = 600;
export const LIMITS = { maxKeys: 64, maxValueBytes: 4096, maxTotalBytes: 16384 };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const d = (s) => utf8ToBytes(s);
export const u64 = (n) => { const b = new Uint8Array(8); let x = BigInt(n); if (x < 0n || x >= 1n << 64n) throw new Error("u64 out of range"); for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
export const u32 = (n) => { if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("u32 out of range"); return new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); };
export const u8 = (n) => { if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error("u8 out of range"); return new Uint8Array([n]); };
export const hex = (b) => bytesToHex(b);
export function fixed(x, len, what) {
  const b = typeof x === "string" ? hexToBytes(x.replace(/^0x/, "")) : x;
  if (!(b instanceof Uint8Array) || b.length !== len) throw new Error(`${what} must be ${len} bytes`);
  return b;
}
export const id32 = (id) => { if (!/^0x[0-9a-f]{64}$/.test(String(id))) throw new Error("id must be a lowercase bytes32 deployment id"); return hexToBytes(id.slice(2)); };
const addr20 = (a) => { if (!/^0x[0-9a-fA-F]{40}$/.test(String(a))) throw new Error("vault must be an address"); return hexToBytes(a.slice(2).toLowerCase()); };
export const context = ({ chainId, vault }) => concatBytes(u64(chainId), addr20(vault));

// ---- env map (the same contract as the relay's checkEnvMap, relay/secrets.js) ----
export function checkEnv(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("env must be an object of NAME: value");
  const names = Object.keys(env);
  if (names.length > LIMITS.maxKeys) throw new Error(`too many secrets (max ${LIMITS.maxKeys})`);
  let total = 0;
  for (const k of names) {
    if (!NAME_RE.test(k)) throw new Error(`"${k}" is not an env-var name`);
    if (/^ENCLAVE_/i.test(k)) throw new Error(`"${k}": the ENCLAVE_ prefix is reserved for platform variables`);
    const v = env[k];
    if (typeof v !== "string") throw new Error(`"${k}" must be a string value`);
    const n = utf8ToBytes(v).length;
    if (n > LIMITS.maxValueBytes) throw new Error(`"${k}" is ${n} bytes (max ${LIMITS.maxValueBytes})`);
    if (/[\0\r\n]/.test(v)) throw new Error(`"${k}" contains a NUL or newline`);
    total += utf8ToBytes(k).length + n;
  }
  if (total > LIMITS.maxTotalBytes) throw new Error(`secrets total ${total} bytes (max ${LIMITS.maxTotalBytes})`);
}

// ---- the bundle ----
export function deriveDek(secret, { chainId, vault, id, secretRev }) {
  const salt = sha256(concatBytes(d(DOMAIN.DEK), context({ chainId, vault }), id32(id), u64(secretRev)));
  return hkdf(sha256, th.scalarToBytes(secret), salt, d("dek"), 32);
}
export const bundleAad = ({ chainId, vault, id, secretRev, c0 }) =>
  sha256(concatBytes(d(DOMAIN.BUNDLE), context({ chainId, vault }), id32(id), u64(secretRev), fixed(c0, POINT_BYTES, "C0")));
// configSha256: sha256 of the EXACT config text the app's values are substituted into (ENCLAVE_CONFIG before
// substitution; "" for none), committed by the OWNER inside the encrypted bundle. The guest refuses to put a value into any
// other config: the relay that delivers the config can then neither choose where a secret goes (a URL it controls) nor
// widen the egress allowlist derived from it (review H2). configTextOf gives the text the relay delivers for a config value.
export const configTextOf = (value) => (value === null || value === undefined || value === "" ? "" : JSON.stringify(typeof value === "string" ? JSON.parse(value) : value));
export const configSha256 = (text) => bytesToHex(sha256(utf8ToBytes(String(text))));
// the config text for the one source owner tooling can read off the chain itself: a config INLINE in the deployment's
// options envelope (the ledger's configCid field). A config at a CID, or the catalog version's own, is the relay's to
// resolve, so the owner names that text explicitly (CLI --config-file) rather than taking the relay's word for it.
export function configTextFromEnvelope(envelope) {
  let o = {};
  try { o = envelope ? JSON.parse(envelope) : {}; } catch { throw new Error("the deployment's options envelope is not JSON"); }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("the deployment's options envelope is not a JSON object");
  if ("configCid" in o) throw new Error("this deployment's config is at a CID: name the exact config JSON it holds (CLI: --config-file)");
  if ("config" in o) return configTextOf(o.config);
  throw new Error("this deployment's config comes from its catalog version: name that exact JSON (CLI: --config-file), or --no-config if it has none");
}
export function encryptBundle(dek, aad, env, { configSha256: cfg, _nonce } = {}) {
  checkEnv(env);
  if (!/^[0-9a-f]{64}$/.test(String(cfg))) throw new Error("a bundle commits the config it may be substituted into (configSha256)");
  const nonce = _nonce || randomBytes(12);
  return concatBytes(nonce, gcm(dek, nonce, aad).encrypt(utf8ToBytes(JSON.stringify({ v: 1, env, configSha256: cfg }))));
}
// -> { env, configSha256 }
export function decryptBundle(dek, aad, blob) {
  if (!(blob instanceof Uint8Array) || blob.length < 12 + 16) throw new Error("bundle too short");
  const pt = gcm(dek, blob.subarray(0, 12), aad).decrypt(blob.subarray(12));
  const o = JSON.parse(new TextDecoder().decode(pt));
  if (!o || o.v !== 1) throw new Error("unknown bundle version");
  if (!/^[0-9a-f]{64}$/.test(String(o.configSha256))) throw new Error("the bundle commits no config");
  checkEnv(o.env);
  return { env: o.env, configSha256: o.configSha256 };
}

// ---- shares ----
export const commitmentsHash = (commitments) => sha256(concatBytes(...commitments.map((c) => fixed(c, POINT_BYTES, "commitment"))));
export function splitCommitments(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length % POINT_BYTES) throw new Error("commitments must be a whole number of 33-byte points");
  const out = [];
  for (let i = 0; i < bytes.length; i += POINT_BYTES) out.push(bytes.subarray(i, i + POINT_BYTES));
  return out;
}
export const shareAad = ({ chainId, vault, id, secretRev, committeeId, epoch, index, commitments }) =>
  sha256(concatBytes(d(DOMAIN.SHARE), context({ chainId, vault }), id32(id), u64(secretRev), fixed(committeeId, 32, "committeeId"),
                     u32(epoch), u8(index), commitmentsHash(commitments)));
export const sealShareAtRest = (encKey, aadFields, y) => hpke.seal(fixed(encKey, 32, "encKey"), INFO.SHARE_AT_REST, shareAad(aadFields), th.scalarToBytes(y));
export function openShareAtRest(encPrivate, aadFields, sealed) {
  return th.bytesToScalar(hpke.open(encPrivate, INFO.SHARE_AT_REST, shareAad(aadFields), fixed(sealed, SEALED_SHARE_BYTES, "sealed share")));
}

// ---- release ----
// challenges: [{ encKey: 32 bytes, nonce: 32 bytes }], one per custodian asked; sorted here, duplicates refused
export function challengeRoot(challenges) {
  if (!Array.isArray(challenges) || challenges.length === 0 || challenges.length > th.MAX_MEMBERS) throw new Error("challenges: 1..32 entries");
  const rows = challenges.map((c) => ({ k: fixed(c.encKey, 32, "challenge encKey"), n: fixed(c.nonce, 32, "challenge nonce") }))
    .sort((a, b) => (hex(a.k) < hex(b.k) ? -1 : 1));
  for (let i = 1; i < rows.length; i++) if (hex(rows[i].k) === hex(rows[i - 1].k)) throw new Error("challenges: duplicate custodian");
  return sha256(concatBytes(d(DOMAIN.CHALLENGES), u8(rows.length), ...rows.flatMap((r) => [r.k, r.n])));
}
export function releaseBinding({ chainId, vault, id, policyRev, secretRev, epoch, challenges, runtimeId, transportSpki, recipientKey }) {
  if (!(transportSpki instanceof Uint8Array) || transportSpki.length < 32) throw new Error("transportSpki must be a DER SPKI");
  return sha256(concatBytes(d(DOMAIN.RELEASE), context({ chainId, vault }), id32(id), u64(policyRev), u64(secretRev), u32(epoch),
                            challengeRoot(challenges), fixed(runtimeId, 32, "runtimeId"), sha256(transportSpki), fixed(recipientKey, 32, "recipientKey")));
}
export const operatorMessage = ({ chainId, vault, id, endpoint, binding, expiry }) =>
  `enclave-custody-release-v1:${chainId}:${String(vault).toLowerCase()}:${id}:${endpoint}:${hex(fixed(binding, 32, "binding"))}:${expiry}`;
export const responseAad = ({ binding, encKey, index }) => sha256(concatBytes(d(DOMAIN.RESPONSE), fixed(binding, 32, "binding"), fixed(encKey, 32, "encKey"), u8(index)));
export const sealResponse = ({ recipientKey, binding, encKey, index, y }) =>
  hpke.seal(fixed(recipientKey, 32, "recipientKey"), INFO.SHARE_RELEASE, responseAad({ binding, encKey, index }), th.scalarToBytes(y));
export const openResponse = ({ recipientPrivate, binding, encKey, index, sealed }) =>
  th.bytesToScalar(hpke.open(recipientPrivate, INFO.SHARE_RELEASE, responseAad({ binding, encKey, index }), fixed(sealed, SEALED_SHARE_BYTES, "sealed response")));

// ---- reshare deals: subCommitments (tNew x 33) ‖ one 80-byte sealed sub-share per new member, in member order ----
export const dealAad = ({ chainId, vault, id, secretRev, committeeId, fromEpoch, toEpoch, dealer, member, subCommitments }) =>
  sha256(concatBytes(d(DOMAIN.DEAL), context({ chainId, vault }), id32(id), u64(secretRev), fixed(committeeId, 32, "committeeId"),
                     u32(fromEpoch), u32(toEpoch), u8(dealer), u8(member), commitmentsHash(subCommitments)));
