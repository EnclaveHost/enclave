// A custodian's durable key material, in one passphrase-encrypted file:
//   - the X25519 share key (every share this custodian holds is on chain, sealed to it), and
//   - the operator's secp256k1 key (sends its committee transactions: approveEpoch, postDeal, postReshare; holds gas only).
// The file IS the backup: copy it offline (two places); restoring is putting it back with its passphrase. Losing both the file
// and every copy loses this member's shares for good; the committee survives that while a threshold of members remain, by
// resharing to a replacement (docs/security/secret-custody.md, "recovery").
//
//   { v: 1, kdf: { name: "scrypt", N, r, p, salt }, cipher: "aes-256-gcm", nonce, ct, encKey, operator }
//   ct = AES-256-GCM(scrypt(passphrase), nonce, aad = "enclave-custodian-keyfile-v1" ‖ encKey ‖ operator, sharePriv(32) ‖ opPriv(32))
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import fs from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import * as hpke from "./hpke.mjs";

const AAD = Buffer.from("enclave-custodian-keyfile-v1");
const KDF = { name: "scrypt", N: 2 ** 17, r: 8, p: 1 };
const derive = (pass, k, salt) => scryptSync(Buffer.from(pass, "utf8"), salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: 256 * k.N * k.r });

export function generateKeys() {
  const share = hpke.generateKeyPair();
  const op = randomBytes(32);
  return { encPrivateKey: share.privateKey, operatorPrivateKey: "0x" + op.toString("hex") };
}

export function sealKeyFile({ encPrivateKey, operatorPrivateKey, passphrase, kdf = KDF }) {
  if (typeof passphrase !== "string" || passphrase.length < 12) throw new Error("keyfile: a passphrase of at least 12 characters is required");
  const encKey = Buffer.from(hpke.publicKeyOf(encPrivateKey));
  const operator = privateKeyToAccount(operatorPrivateKey).address.toLowerCase();
  const salt = randomBytes(16), nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derive(passphrase, kdf, salt), nonce);
  c.setAAD(Buffer.concat([AAD, encKey, Buffer.from(operator.slice(2), "hex")]));
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(encPrivateKey), Buffer.from(operatorPrivateKey.slice(2), "hex")])), c.final(), c.getAuthTag()]);
  return JSON.stringify({ v: 1, kdf: { ...kdf, salt: salt.toString("hex") }, cipher: "aes-256-gcm", nonce: nonce.toString("hex"), ct: ct.toString("base64"),
                          encKey: encKey.toString("hex"), operator }, null, 2) + "\n";
}

export function openKeyFile(text, passphrase) {
  const f = JSON.parse(text);
  if (f.v !== 1 || f.cipher !== "aes-256-gcm" || !f.kdf || f.kdf.name !== "scrypt") throw new Error("keyfile: unknown format");
  const raw = Buffer.from(f.ct, "base64");
  const d = createDecipheriv("aes-256-gcm", derive(passphrase, f.kdf, Buffer.from(f.kdf.salt, "hex")), Buffer.from(f.nonce, "hex"));
  d.setAAD(Buffer.concat([AAD, Buffer.from(f.encKey, "hex"), Buffer.from(f.operator.slice(2), "hex")]));
  d.setAuthTag(raw.subarray(raw.length - 16));
  let pt;
  try { pt = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]); }
  catch { throw new Error("keyfile: wrong passphrase or a corrupted file"); }
  const encPrivateKey = new Uint8Array(pt.subarray(0, 32)), operatorPrivateKey = "0x" + pt.subarray(32, 64).toString("hex");
  pt.fill(0);
  if (Buffer.from(hpke.publicKeyOf(encPrivateKey)).toString("hex") !== f.encKey || privateKeyToAccount(operatorPrivateKey).address.toLowerCase() !== f.operator)
    throw new Error("keyfile: the keys do not match the public keys the file states");
  return { encPrivateKey, operatorPrivateKey, encKey: f.encKey, operator: f.operator };
}

// write with no group/other bits, and refuse to READ a keyfile anyone else can read or write
export function writeKeyFile(path, text) { fs.writeFileSync(path, text, { mode: 0o600, flag: "wx" }); }
export function readKeyFile(path) {
  const st = fs.statSync(path);
  if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error(`${path}: must be a regular file with mode 0600 or stricter`);
  return fs.readFileSync(path, "utf8");
}
