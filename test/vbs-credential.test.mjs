// relay/vbs-credential.mjs: TPM2_MakeCredential, checked against an
// independent decomposition (KDFa, AES-128-CFB, HMAC, OAEP label written out by
// hand from TPM 2.0 Part 1 sections 11.4.10, 24.4, 24.5 and B.10.3) and the
// software ActivateCredential round trip. The KAT fixture is what the TPM agent
// fills in from a real ActivateCredential on the Windows box.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHmac, createDecipheriv, generateKeyPairSync, privateDecrypt, constants, randomBytes } from "node:crypto";
import { makeCredential, activateCredential, kdfa, ekPublicFrom, IDENTITY_LABEL } from "../relay/vbs-credential.mjs";
import { tpmtPublicOf, nameOf } from "./fixtures/vbs-synthetic.mjs";

const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const OAEP = constants.RSA_PKCS1_OAEP_PADDING;

test("MakeCredential: every component recomputed independently; software ActivateCredential recovers the credential; tampers fail", () => {
  const ek = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const aikName = nameOf(tpmtPublicOf(generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey));
  const credential = randomBytes(32), seed = randomBytes(32);
  const r = makeCredential(ek.publicKey, aikName, credential, { seed });
  assert.equal(r.encIdentity.length, 34, "TPM2B credential (2 + 32) under CFB keeps its length");
  assert.equal(r.credentialBlob.length, 2 + 32 + 34); assert.equal(r.credentialBlob.readUInt16BE(0), 32);
  assert.ok(r.credentialBlob.subarray(2, 34).equals(r.integrityHMAC)); assert.ok(r.credentialBlob.subarray(34).equals(r.encIdentity));
  assert.equal(r.secret.length, 256, "TPM2B_ENCRYPTED_SECRET contents for RSA-2048");
  // the seed travels under OAEP-SHA256 with the label "IDENTITY" plus its null
  assert.equal(IDENTITY_LABEL.toString("latin1"), "IDENTITY\0"); assert.equal(IDENTITY_LABEL.length, 9);
  assert.ok(privateDecrypt({ key: ek.privateKey, padding: OAEP, oaepHash: "sha256", oaepLabel: IDENTITY_LABEL }, r.secret).equals(seed));
  assert.throws(() => privateDecrypt({ key: ek.privateKey, padding: OAEP, oaepHash: "sha256", oaepLabel: Buffer.from("IDENTITY") }, r.secret), "the label without its null must not decrypt");
  // KDFa by hand (single block: 128 and 256 bits fit one SHA-256 output)
  const symKey = createHmac("sha256", seed).update(u32be(1)).update(Buffer.from("STORAGE\0")).update(aikName).update(u32be(128)).digest().subarray(0, 16);
  const hmacKey = createHmac("sha256", seed).update(u32be(1)).update(Buffer.from("INTEGRITY\0")).update(u32be(256)).digest();
  assert.ok(kdfa("sha256", seed, "STORAGE", aikName, Buffer.alloc(0), 128).equals(symKey));
  assert.ok(kdfa("sha256", seed, "INTEGRITY", Buffer.alloc(0), Buffer.alloc(0), 256).equals(hmacKey));
  const d = createDecipheriv("aes-128-cfb", symKey, Buffer.alloc(16, 0));
  const plain = Buffer.concat([d.update(r.encIdentity), d.final()]);
  assert.equal(plain.readUInt16BE(0), 32); assert.ok(plain.subarray(2).equals(credential));
  assert.ok(createHmac("sha256", hmacKey).update(r.encIdentity).update(aikName).digest().equals(r.integrityHMAC), "HMAC over encIdentity || name");
  // counter mode past one block
  const k = kdfa("sha256", seed, "STORAGE", aikName, Buffer.alloc(0), 512);
  assert.equal(k.length, 64);
  assert.ok(k.subarray(0, 32).equals(createHmac("sha256", seed).update(u32be(1)).update(Buffer.from("STORAGE\0")).update(aikName).update(u32be(512)).digest()));
  assert.ok(k.subarray(32).equals(createHmac("sha256", seed).update(u32be(2)).update(Buffer.from("STORAGE\0")).update(aikName).update(u32be(512)).digest()));
  // the round trip, and what a TPM would refuse
  assert.ok(activateCredential(ek.privateKey, aikName, r.credentialBlob, r.secret).equals(credential));
  const blob = Buffer.from(r.credentialBlob); blob[40] ^= 1;
  assert.throws(() => activateCredential(ek.privateKey, aikName, blob, r.secret), /integrity/);
  const otherName = Buffer.from(aikName); otherName[5] ^= 1;
  assert.throws(() => activateCredential(ek.privateKey, otherName, r.credentialBlob, r.secret), /integrity/, "a different object name: the HMAC covers it");
  const ek2 = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => activateCredential(ek2.privateKey, aikName, r.credentialBlob, r.secret), "another EK cannot open the seed");
  // a fresh mint is a fresh seed: two blobs for the same inputs differ
  assert.ok(!makeCredential(ek.publicKey, aikName, credential).credentialBlob.equals(r.credentialBlob));
  // the same EK in every form the node might present gives the same blob for the same seed
  const spki = ek.publicKey.export({ type: "spki", format: "der" }), tpmt = tpmtPublicOf(ek.publicKey, { ek: true });
  for (const form of [spki, tpmt, ek.publicKey, ek.publicKey.export({ type: "spki", format: "pem" })])
    assert.ok(makeCredential(form, aikName, credential, { seed }).credentialBlob.equals(r.credentialBlob));
  assert.equal(ekPublicFrom(tpmt).source, "tpmt_public"); assert.equal(ekPublicFrom(spki).source, "spki"); assert.equal(ekPublicFrom(ek.publicKey).source, "key");
  assert.throws(() => ekPublicFrom(tpmtPublicOf(ek.publicKey)), /symmetric|restricted/, "the AIK template is not an EK");
  assert.throws(() => ekPublicFrom(generateKeyPairSync("ed25519").publicKey), /not an RSA key/);
  // input validation
  assert.throws(() => makeCredential(ek.publicKey, aikName.subarray(1), credential), /34 bytes/);
  assert.throws(() => makeCredential(ek.publicKey, Buffer.concat([Buffer.from([0, 4]), aikName.subarray(2)]), credential), /34 bytes/);
  assert.throws(() => makeCredential(ek.publicKey, aikName, Buffer.alloc(33)), /1\.\.32/);
  assert.throws(() => makeCredential(ek.publicKey, aikName, credential, { seed: Buffer.alloc(16) }), /seed/);
});

test("MakeCredential: the test box's EK certificate mints, and the KAT fixture holds (activated: filled in by the TPM agent)", () => {
  const kat = JSON.parse(fs.readFileSync(new URL("./fixtures/vbs/make-credential-kat.json", import.meta.url), "utf8"));
  const ek = ekPublicFrom(Buffer.from(kat.ekPublic, "hex"));
  assert.equal(ek.source, kat.ekPublicForm === "x509-der" ? "x509" : kat.ekPublicForm);
  assert.equal(ek.key.asymmetricKeyDetails.modulusLength, 2048);
  const aikName = Buffer.from(kat.aikName, "hex"), credential = Buffer.from(kat.credential, "hex"), seed = Buffer.from(kat.seed, "hex");
  const r = makeCredential(ek, aikName, credential, { seed });
  assert.equal(r.credentialBlob.toString("hex"), kat.credentialBlob, "deterministic given the seed");
  assert.equal(r.encIdentity.toString("hex"), kat.encIdentity);
  assert.equal(r.integrityHMAC.toString("hex"), kat.integrityHMAC);
  assert.equal(Buffer.from(kat.secret, "hex").length, 256, "OAEP is randomised: only the shape of the recorded secret is checked");
  if (kat.activated) assert.equal(String(kat.activated).toLowerCase(), kat.credential, "the TPM recovered what we minted");
  else console.log("  note: make-credential-kat.json has no `activated` yet: the hardware round trip is unverified until the TPM agent fills it in");
});
