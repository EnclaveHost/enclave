// verifier/web/tpm-credential.mjs: TPM2_MakeCredential in the browser, byte-compatible with relay/vbs-credential.mjs (its
// header has the construction and the TPM 2.0 references). The page mints the credential itself, so the relay never
// learns it: only the TPM holding the EK's private key can recover it from the blob, and only for the key named aikName.
//
//   seed        = 32 random bytes                                           (this page's)
//   secret      = RSA-OAEP-SHA256(EK public, seed, label "IDENTITY\0")      WebCrypto
//   symKey      = KDFa(SHA256, seed, "STORAGE", aikName, -, 128)            @noble/hashes HMAC
//   encIdentity = AES-128-CFB(symKey, iv 0, u16be(len) || credential)       @noble/ciphers
//   integrity   = HMAC-SHA256(KDFa(SHA256, seed, "INTEGRITY", -, -, 256), encIdentity || aikName)
//   credentialBlob = u16be(32) || integrity || encIdentity
// The EK is the certificate's RSA key with the default EK template assumed (nameAlg SHA-256, AES-128-CFB), as
// vbs-credential.mjs ekPublicFrom assumes for a certificate. An ECC EK is refused there and here.
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { cfb } from "@noble/ciphers/aes";
import { concatBytes } from "./x509.mjs";

export const IDENTITY_LABEL = new Uint8Array([0x49, 0x44, 0x45, 0x4e, 0x54, 0x49, 0x54, 0x59, 0x00]);   // "IDENTITY\0", Part 1 B.10.3
const EMPTY = new Uint8Array(0);
const u32be = (n) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const u16be = (n) => new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
const latin1Bytes = (s) => Uint8Array.from(String(s), (c) => c.charCodeAt(0) & 0xff);

// KDFa (Part 1 11.4.10) with SHA-256: HMAC(key, [i]32be || label || 0x00 || contextU || contextV || [bits]32be), i = 1..
export function kdfaSha256(key, label, contextU = EMPTY, contextV = EMPTY, bits) {
  if (!Number.isInteger(bits) || bits <= 0 || bits % 8) throw new Error("KDFa bits must be a positive multiple of 8");
  const lab = concatBytes(latin1Bytes(label), new Uint8Array([0]));
  const out = [];
  for (let i = 1, have = 0; have < bits / 8; i++, have += 32) out.push(hmac(sha256, key, concatBytes(u32be(i), lab, contextU, contextV, u32be(bits))));
  return concatBytes(...out).subarray(0, bits / 8);
}

// makeCredentialWeb(ekSpki DER, aikName (34 bytes), credential (1..32 bytes), seed (32 bytes)) -> { credentialBlob, secret }
// ekSpki is the EK certificate's SubjectPublicKeyInfo (verifier/web/tpm-certs.mjs parseTpmCertificate(...).spki).
export async function makeCredentialWeb(ekSpki, aikName, credential, seed) {
  const s = globalThis.crypto && globalThis.crypto.subtle; if (!s) throw new Error("WebCrypto (crypto.subtle) is not available");
  if (!(aikName instanceof Uint8Array) || aikName.length !== 34 || aikName[0] !== 0x00 || aikName[1] !== 0x0b) throw new Error("aikName must be 34 bytes: 0x000B || sha256");
  if (!(credential instanceof Uint8Array) || !credential.length || credential.length > 32) throw new Error("credential must be 1..32 bytes (TPM2B_DIGEST for a SHA-256 EK)");
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error("seed must be 32 bytes (the EK nameAlg digest size)");
  let key;
  try { key = await s.importKey("spki", ekSpki, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]); }
  catch (e) { throw new Error(`EK is not a usable RSA key: ${e.message}`); }
  const secret = new Uint8Array(await s.encrypt({ name: "RSA-OAEP", label: IDENTITY_LABEL }, key, seed));
  const symKey = kdfaSha256(seed, "STORAGE", aikName, EMPTY, 128);
  const encIdentity = cfb(symKey, new Uint8Array(16)).encrypt(concatBytes(u16be(credential.length), credential));
  const integrityHMAC = hmac(sha256, kdfaSha256(seed, "INTEGRITY", EMPTY, EMPTY, 256), concatBytes(encIdentity, aikName));
  return { credentialBlob: concatBytes(u16be(integrityHMAC.length), integrityHMAC, encIdentity), secret, encIdentity, integrityHMAC };
}
