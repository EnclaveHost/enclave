// custody/hpke.mjs against RFC 9180 Appendix A.1 (DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM), base mode.
// The vectors are copied verbatim from the RFC text (https://www.rfc-editor.org/rfc/rfc9180.txt, A.1.1 and A.1.1.1); the Go
// guest half (isolation/m2/custody) checks the same ones.
import test from "node:test";
import assert from "node:assert/strict";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import * as hpke from "../custody/hpke.mjs";

const V = {
  info: "4f6465206f6e2061204772656369616e2055726e",
  ikmE: "7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234",
  pkEm: "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431",
  skEm: "52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736",
  ikmR: "6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037",
  pkRm: "3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d",
  skRm: "4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8",
  shared: "fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc",
  key: "4531685d41d65f03dc48f6b8302c05b0",
  baseNonce: "56d890e5accaaf011cff4b7d",
  exporterSecret: "45ff1c2e220db587171952c0592d5f5ebe103f1561a2614e38f2ffd47e99e3f8",
  pt: "4265617574792069732074727574682c20747275746820626561757479",
  enc: [
    [0, "436f756e742d30", "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a"],
    [1, "436f756e742d31", "af2d7e9ac9ae7e270f46ba1f975be53c09f8d875bdc8535458c2494e8a6eab251c03d0c22a56b8ca42c2063b84"],
    [2, "436f756e742d32", "498dfcabd92e8acedc281e85af1cb4e3e31c7dc394a1ca20e173cb72516491588d96a19ad4a683518973dcc180"],
    [4, "436f756e742d34", "583bd32bc67a5994bb8ceaca813d369bca7b2a42408cddef5e22f880b631215a09fc0012bc69fccaa251c0246d"],
  ],
};
const h = hexToBytes;

test("RFC 9180 A.1.1: DeriveKeyPair reproduces both key pairs", () => {
  const e = hpke.deriveKeyPair(h(V.ikmE)), r = hpke.deriveKeyPair(h(V.ikmR));
  assert.equal(bytesToHex(e.privateKey), V.skEm);
  assert.equal(bytesToHex(e.publicKey), V.pkEm);
  assert.equal(bytesToHex(r.privateKey), V.skRm);
  assert.equal(bytesToHex(r.publicKey), V.pkRm);
});

test("RFC 9180 A.1.1: the key schedule matches on both sides", () => {
  const s = hpke.setupBaseS(h(V.pkRm), h(V.info), { _ikmE: h(V.ikmE) });
  assert.equal(bytesToHex(s.enc), V.pkEm);
  for (const ctx of [s, hpke.setupBaseR(s.enc, h(V.skRm), h(V.info))]) {
    assert.equal(bytesToHex(ctx.sharedSecret), V.shared);
    assert.equal(bytesToHex(ctx.key), V.key);
    assert.equal(bytesToHex(ctx.baseNonce), V.baseNonce);
    assert.equal(bytesToHex(ctx.exporterSecret), V.exporterSecret);
  }
});

test("RFC 9180 A.1.1.1: encryptions at sequence 0, 1, 2, 4", () => {
  const s = hpke.setupBaseS(h(V.pkRm), h(V.info), { _ikmE: h(V.ikmE) });
  const r = hpke.setupBaseR(s.enc, h(V.skRm), h(V.info));
  for (const [seq, aad, ct] of V.enc) {
    assert.equal(bytesToHex(hpke.sealWith(s, seq, h(aad), h(V.pt))), ct, `seq ${seq}`);
    assert.equal(bytesToHex(hpke.openWith(r, seq, h(aad), h(ct))), V.pt, `seq ${seq}`);
  }
});

test("single-shot seal/open round-trips and refuses a wrong info, aad, key or a low-order key", () => {
  const r = hpke.generateKeyPair();
  const info = new TextEncoder().encode("info"), aad = new TextEncoder().encode("aad"), pt = new TextEncoder().encode("secret");
  const blob = hpke.seal(r.publicKey, info, aad, pt);
  assert.deepEqual(hpke.open(r.privateKey, info, aad, blob), pt);
  assert.throws(() => hpke.open(r.privateKey, new TextEncoder().encode("other"), aad, blob));
  assert.throws(() => hpke.open(r.privateKey, info, new TextEncoder().encode("other"), blob));
  assert.throws(() => hpke.open(hpke.generateKeyPair().privateKey, info, aad, blob));
  assert.throws(() => hpke.seal(new Uint8Array(32), info, aad, pt));   // noble or our own zero check refuses it
});
