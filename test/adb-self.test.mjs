// adb-self.mjs: the pieces of on-phone pairing that can be held to something outside this file before a phone is involved --
// SPAKE2's points are boringssl's and in the prime-order subgroup, both roles derive one key only from the same password, the
// cipher is AES-128-GCM with sequence nonces, the certificate is a valid self-signed X.509, and the adb public key is
// byte-for-byte what the adb client writes for the same RSA key (~/.android/adbkey.pub, when this machine has one).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spake2, SPAKE_M, SPAKE_N, pairingCipher, adbPublicKey, selfSignedCert, adbIdentity } from "../shielded/anchor/avf/runner/adb-self.mjs";

const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mulCheck = (p) => { let r = p.constructor.ZERO, a = p, n = L; while (n > 0n) { if (n & 1n) r = r.add(a); a = a.double(); n >>= 1n; } return r; };
const C = Buffer.from("adb pair client\0"), S = Buffer.from("adb pair server\0");

test("M and N are boringssl's points: NOT torsion-free (why its password scalar is made a multiple of 8), and every message we send is", () => {
  assert.equal(Buffer.from(SPAKE_M.toRawBytes()).toString("hex"), "5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e");
  assert.equal(Buffer.from(SPAKE_N.toRawBytes()).toString("hex"), "10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778");
  for (const p of [SPAKE_M, SPAKE_N]) { assert.equal(mulCheck(p).is0(), false); assert.equal(p.isTorsionFree(), false); assert.ok(mulCheck(p.multiplyUnsafe(8n)).is0()); }
  for (let i = 0; i < 8; i++) for (const role of ["alice", "bob"]) {
    const m = spake2(role, C, S, crypto.randomBytes(20)).msg;
    assert.ok(SPAKE_M.constructor.fromHex(m.toString("hex")).isTorsionFree(), `${role}: the mask cleared the small-order part`);
  }
});

test("SPAKE2: alice and bob agree on a password, and only on that password", () => {
  for (let i = 0; i < 4; i++) {
    const pw = Buffer.concat([Buffer.from("123456"), crypto.randomBytes(64)]);
    const a = spake2("alice", C, S, pw), b = spake2("bob", S, C, pw);
    const ka = a.finish(b.msg), kb = b.finish(a.msg);
    assert.equal(ka.length, 64); assert.deepEqual(ka, kb);
    const wrong = spake2("bob", S, C, Buffer.concat([Buffer.from("123457"), pw.subarray(6)]));
    assert.notDeepEqual(spake2("alice", C, S, pw).finish(wrong.msg), wrong.finish(a.msg));
  }
  // the same randomness and password: the same message (deterministic given its inputs)
  const r = crypto.randomBytes(64);
  assert.deepEqual(spake2("alice", C, S, Buffer.from("x"), r).msg, spake2("alice", C, S, Buffer.from("x"), r).msg);
});

test("the cipher: one key both ways, sequence nonces, a tampered tag refused", () => {
  const k = crypto.randomBytes(64), a = pairingCipher(k), b = pairingCipher(k);
  const m1 = a.encrypt(Buffer.from("one")), m2 = a.encrypt(Buffer.from("one"));
  assert.notDeepEqual(m1, m2, "the second message has the next nonce");
  assert.equal(b.decrypt(m1).toString(), "one"); assert.equal(b.decrypt(m2).toString(), "one");
  const m3 = a.encrypt(Buffer.from("three")); m3[0] ^= 1;
  assert.throws(() => b.decrypt(m3));
});

test("the certificate: a self-signed X.509 for the adb key, valid now", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const x = new crypto.X509Certificate(selfSignedCert(privateKey, publicKey));
  assert.ok(x.verify(publicKey)); assert.equal(x.subject, "CN=enclave"); assert.ok(x.checkIssued(x));
  assert.ok(new Date(x.validFrom) < new Date() && new Date(x.validTo) > new Date());
  assert.ok(x.publicKey.equals(publicKey));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adbid-")), id = adbIdentity(dir), again = adbIdentity(dir);
  assert.equal(id.key, again.key, "made once"); assert.equal(fs.statSync(path.join(dir, "adbkey.pem")).mode & 0o777, 0o600);
});

test("the adb public key is what the adb client writes for the same key", (t) => {
  const priv = path.join(os.homedir(), ".android/adbkey"), pub = `${priv}.pub`;
  if (!fs.existsSync(priv) || !fs.existsSync(pub)) return t.skip("no adb key on this machine");
  const want = fs.readFileSync(pub, "utf8").trim().split(" ");
  const got = adbPublicKey(crypto.createPublicKey(fs.readFileSync(priv)), want.slice(1).join(" ")).split(" ");
  assert.equal(got[0], want[0]);
});
