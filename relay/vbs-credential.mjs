// relay/vbs-credential.mjs — TPM2_MakeCredential, the verifier's half of the
// credential round trip that binds a quoting key to the TPM whose EK we checked
// (EVIDENCE.md check 3; TPM 2.0 Library Part 1 section 24 "Credential
// Protection", Part 3 TPM2_MakeCredential). The node's TPM runs the other half,
// TPM2_ActivateCredential(AIK, EK, credentialBlob, secret), which only succeeds
// if the object named `aikName` is loaded in the same TPM as the EK's private
// key. It returns our 32-byte credential; the hub compares.
//
//   seed      = 32 random bytes (the EK's nameAlg digest size)
//   secret    = RSA-OAEP-SHA256(EK public, seed, label "IDENTITY\0")        Part 1 B.10.3
//   symKey    = KDFa(SHA256, seed, "STORAGE",   contextU = name, -, 128)    Part 1 24.4
//   encIdentity = AES-128-CFB(symKey, iv = 0, TPM2B credential)             (size || value)
//   hmacKey   = KDFa(SHA256, seed, "INTEGRITY", -, -, 256)                  Part 1 24.5
//   integrity = HMAC-SHA256(hmacKey, encIdentity || name)
//   credentialBlob (TPM2B_ID_OBJECT contents) = TPM2B integrityHMAC || encIdentity
//   KDFa (Part 1 11.4.10): HMAC(key, [i]32be || label || 0x00 || contextU || contextV || [bits]32be), i = 1..
//
// The EK public may be given as the TPM's TPMT_PUBLIC bytes or as the EK
// certificate's RSA key (same key). activateCredential() is the software
// counterpart, for tests with a generated EK: the real one runs in the TPM.
import { createHash, createHmac, createCipheriv, createDecipheriv, publicEncrypt, privateDecrypt, randomBytes, createPublicKey, createPrivateKey,
         timingSafeEqual, X509Certificate, KeyObject, constants } from "node:crypto";
import fs from "node:fs";
import { parseTpmtPublic, rsaKeyFromModulus, TPM_ALG_SHA256, TPM_ALG_AES, TPM_ALG_CFB } from "./vbs-verify.mjs";

export const IDENTITY_LABEL = Buffer.from("IDENTITY\0", "latin1");    // 8 bytes + the terminating null, Part 1 B.10.3
const EMPTY = Buffer.alloc(0);
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u16be = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

export function kdfa(hash, key, label, contextU = EMPTY, contextV = EMPTY, bits) {
  if (!Number.isInteger(bits) || bits <= 0 || bits % 8) throw new Error("KDFa bits must be a positive multiple of 8");
  const lab = Buffer.concat([Buffer.from(String(label), "latin1"), Buffer.from([0])]);
  const out = [], size = createHash(hash).digest().length;
  for (let i = 1, have = 0; have < bits / 8; i++, have += size)
    out.push(createHmac(hash, key).update(u32be(i)).update(lab).update(contextU).update(contextV).update(u32be(bits)).digest());
  return Buffer.concat(out).subarray(0, bits / 8);
}

// The EK's public key + the template facts MakeCredential needs, from whichever
// form the node presented. A certificate or SPKI carries the key alone; the
// default EK template (nameAlg SHA-256, AES-128-CFB) is assumed for it, as it
// is what an EK certificate certifies (TCG EK Credential Profile, 2.1.5.1).
export function ekPublicFrom(input) {
  const out = { nameAlg: "sha256", symKeyBits: 128 };
  if (input instanceof KeyObject) { out.key = input; out.source = "key"; }
  else {
    const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
    if (b.length > 64 * 1024) throw new Error("EK public exceeds size limit");
    if (b[0] === 0x00 && b[1] === 0x01) {                            // TPMT_PUBLIC, TPM_ALG_RSA
      const p = parseTpmtPublic(b);
      if (p.nameAlg !== TPM_ALG_SHA256) throw new Error("EK nameAlg is not SHA-256");
      if (p.symmetric.alg !== TPM_ALG_AES || p.symmetric.mode !== TPM_ALG_CFB || p.symmetric.keyBits !== 128) throw new Error("EK symmetric is not AES-128-CFB");
      if ((p.attributes & 0x00030000) !== 0x00030000) throw new Error("EK attributes are not restricted|decrypt");
      out.key = rsaKeyFromModulus(p.modulus, p.exponent); out.source = "tpmt_public"; out.tpmtPublic = p;
    } else {
      const text = b.toString("latin1");
      try { out.key = new X509Certificate(b).publicKey; out.source = "x509"; }
      catch { out.key = createPublicKey(text.includes("-----BEGIN") ? text : { key: b, format: "der", type: "spki" }); out.source = "spki"; }
    }
  }
  if (out.key.asymmetricKeyType !== "rsa") throw new Error("EK is not an RSA key");
  return out;
}

export function makeCredential(ekPublic, aikName, credential, { seed = randomBytes(32) } = {}) {
  const ek = ekPublic && ekPublic.key ? ekPublic : ekPublicFrom(ekPublic);
  if (!Buffer.isBuffer(aikName) || aikName.length !== 34 || aikName[0] !== 0x00 || aikName[1] !== 0x0b) throw new Error("aikName must be 34 bytes: 0x000B || sha256");
  if (!Buffer.isBuffer(credential) || !credential.length || credential.length > 32) throw new Error("credential must be 1..32 bytes (TPM2B_DIGEST for a SHA-256 EK)");
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error("seed must be 32 bytes (the EK nameAlg digest size)");
  const secret = publicEncrypt({ key: ek.key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: ek.nameAlg, oaepLabel: IDENTITY_LABEL }, seed);
  const symKey = kdfa(ek.nameAlg, seed, "STORAGE", aikName, EMPTY, ek.symKeyBits);
  const cipher = createCipheriv(`aes-${ek.symKeyBits}-cfb`, symKey, Buffer.alloc(16, 0));
  const encIdentity = Buffer.concat([cipher.update(Buffer.concat([u16be(credential.length), credential])), cipher.final()]);
  const hmacKey = kdfa(ek.nameAlg, seed, "INTEGRITY", EMPTY, EMPTY, 256);
  const integrityHMAC = createHmac(ek.nameAlg, hmacKey).update(encIdentity).update(aikName).digest();
  return { credentialBlob: Buffer.concat([u16be(integrityHMAC.length), integrityHMAC, encIdentity]), secret, seed, encIdentity, integrityHMAC };
}

// Software TPM2_ActivateCredential, for tests that generated the EK themselves.
export function activateCredential(ekPrivate, aikName, credentialBlob, secret, { nameAlg = "sha256", symKeyBits = 128 } = {}) {
  const key = ekPrivate instanceof KeyObject ? ekPrivate : createPrivateKey(ekPrivate);
  const seed = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: nameAlg, oaepLabel: IDENTITY_LABEL }, secret);
  if (credentialBlob.length < 2) throw new Error("credentialBlob truncated");
  const hl = credentialBlob.readUInt16BE(0), integrity = credentialBlob.subarray(2, 2 + hl), encIdentity = credentialBlob.subarray(2 + hl);
  const hmacKey = kdfa(nameAlg, seed, "INTEGRITY", EMPTY, EMPTY, 256);
  const want = createHmac(nameAlg, hmacKey).update(encIdentity).update(aikName).digest();
  if (integrity.length !== want.length || !timingSafeEqual(integrity, want)) throw new Error("credential integrity HMAC mismatch (TPM_RC_INTEGRITY)");
  const symKey = kdfa(nameAlg, seed, "STORAGE", aikName, EMPTY, symKeyBits);
  const d = createDecipheriv(`aes-${symKeyBits}-cfb`, symKey, Buffer.alloc(16, 0));
  const plain = Buffer.concat([d.update(encIdentity), d.final()]);
  const n = plain.readUInt16BE(0);
  if (2 + n !== plain.length) throw new Error("credential TPM2B size mismatch");
  return plain.subarray(2);
}

// ---- CLI ---------------------------------------------------------------------------
//   node relay/vbs-credential.mjs make <ekpub.der | ek-cert.der | tpmt_public.bin> <aikName hex> [--credential hex] [--seed hex]
//   node relay/vbs-credential.mjs activate <ek-private.pem> <aikName hex> <credentialBlob hex> <secret hex>
// `make` prints JSON with hex fields; feed credentialBlob + secret to the TPM's
// ActivateCredential on the box and compare what comes back with `credential`.
if (process.argv[1] && /vbs-credential\.mjs$/.test(process.argv[1])) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
  if (cmd === "make" && rest[0] && rest[1]) {
    const ek = ekPublicFrom(fs.readFileSync(rest[0]));
    const aikName = Buffer.from(rest[1], "hex");
    const credential = arg("--credential") ? Buffer.from(arg("--credential"), "hex") : randomBytes(32);
    const r = makeCredential(ek, aikName, credential, arg("--seed") ? { seed: Buffer.from(arg("--seed"), "hex") } : {});
    console.log(JSON.stringify({ ekSource: ek.source, ekModulusBits: ek.key.asymmetricKeyDetails.modulusLength, aikName: aikName.toString("hex"), credential: credential.toString("hex"),
                                 seed: r.seed.toString("hex"), credentialBlob: r.credentialBlob.toString("hex"), secret: r.secret.toString("hex"),
                                 encIdentity: r.encIdentity.toString("hex"), integrityHMAC: r.integrityHMAC.toString("hex") }, null, 1));
  } else if (cmd === "activate" && rest.length >= 4) {
    const got = activateCredential(fs.readFileSync(rest[0], "utf8"), Buffer.from(rest[1], "hex"), Buffer.from(rest[2], "hex"), Buffer.from(rest[3], "hex"));
    console.log(JSON.stringify({ credential: got.toString("hex") }));
  } else { console.error("usage: vbs-credential.mjs make <ekpub|cert|tpmt_public> <aikName hex> [--credential hex] [--seed hex]\n       vbs-credential.mjs activate <ek-private.pem> <aikName hex> <credentialBlob hex> <secret hex>"); process.exit(2); }
}
