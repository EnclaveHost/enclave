// Cross-language custody vectors: every value the guest's Go half (isolation/m2/custody) must reproduce, generated here from
// the JS reference with fixed inputs and pinned in TWO identical copies: test/fixtures/custody-vectors.json (checked here) and
// isolation/m2/custody/testdata/vectors.json (checked by `go test` there). A change to either side's formats breaks both.
//   regenerate (only for a deliberate format change): CUSTODY_VECTORS_WRITE=1 node --test test/custody-vectors.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import * as P from "../custody/protocol.mjs";
import * as th from "../custody/threshold.mjs";
import * as hpke from "../custody/hpke.mjs";

const FIX = new URL("./fixtures/custody-vectors.json", import.meta.url);
const GO = new URL("../isolation/m2/custody/testdata/vectors.json", import.meta.url);
const fill = (b, n) => bytesToHex(new Uint8Array(n).fill(b));

function build() {
  const ctx = { chainId: 8453, vault: "0x5ec2e75a0175eb5ec2e75a0175eb5ec2e75a0175" };
  const id = "0x" + "d1".repeat(32);
  const policyRev = 7n, secretRev = 3n, epoch = 2;
  const members = [0, 1, 2, 3, 4].map((i) => hpke.deriveKeyPair(new Uint8Array(32).fill(0x40 + i)));
  const challenges = [4, 0, 2].map((i) => ({ encKey: members[i].publicKey, nonce: new Uint8Array(32).fill(0x90 + i) }));   // deliberately unsorted
  const runtimeId = new Uint8Array(32).fill(0x2a);
  const transportSpki = hexToBytes("3059301306072a8648ce3d020106082a8648ce3d03010703420004" + "11".repeat(64));
  const recipientIkm = new Uint8Array(32).fill(0x77);
  const recipient = hpke.deriveKeyPair(recipientIkm);
  const binding = P.releaseBinding({ ...ctx, id, policyRev, secretRev, epoch, challenges, runtimeId, transportSpki, recipientKey: recipient.publicKey });
  const secret = BigInt("0x" + "1b".repeat(32));   // a fill-byte test constant (below the group order), never a real key
  const { shares, commitments } = th.split(secret, 3, 5, { _coeffs: [0x1111n, 0x2222n] });
  const dek = P.deriveDek(secret, { ...ctx, id, secretRev });
  const aad = P.bundleAad({ ...ctx, id, secretRev, c0: commitments[0] });
  const env = { DATABASE_URL: "postgres://vector:vector@db.example/v", API_TOKEN: "vector-token" };
  const configText = P.configTextOf({ api_key: "$API_TOKEN", db: "${DATABASE_URL}" });
  const ciphertext = P.encryptBundle(dek, aad, env, { configSha256: P.configSha256(configText), _nonce: new Uint8Array(12).fill(0x0c) });
  const responses = [0, 2, 4].map((index) => ({ index, encKey: bytesToHex(members[index].publicKey), ikmE: fill(0xe0 + index, 32),
    sealed: bytesToHex(hpke.seal(recipient.publicKey, P.INFO.SHARE_RELEASE, P.responseAad({ binding, encKey: members[index].publicKey, index }),
                                 th.scalarToBytes(shares[index].y), { _ikmE: new Uint8Array(32).fill(0xe0 + index) })) }));
  // a LYING custodian (member 1): a well-formed response carrying a wrong scalar
  const bad = { index: 1, encKey: bytesToHex(members[1].publicKey), ikmE: fill(0xe1, 32),
    sealed: bytesToHex(hpke.seal(recipient.publicKey, P.INFO.SHARE_RELEASE, P.responseAad({ binding, encKey: members[1].publicKey, index: 1 }),
                                 th.scalarToBytes(shares[1].y + 1n), { _ikmE: new Uint8Array(32).fill(0xe1) })) };
  return {
    contract: "enclave-custody-v1 (custody/protocol.mjs; isolation/m2/custody)",
    chainId: ctx.chainId, vault: ctx.vault, id, policyRev: String(policyRev), secretRev: String(secretRev), epoch,
    members: members.map((m) => bytesToHex(m.publicKey)),
    challenges: challenges.map((c) => ({ encKey: bytesToHex(c.encKey), nonce: bytesToHex(c.nonce) })),
    challengeRoot: bytesToHex(P.challengeRoot(challenges)),
    runtimeId: bytesToHex(runtimeId), transportSpki: bytesToHex(transportSpki),
    // no key material in the fixture (the repo's secret scan refuses hex keys in key-named fields): the recipient key is
    // DeriveKeyPair over 32 bytes of ikmFill, and the binding below pins its public half
    recipient: { ikmFill: 0x77 },
    binding: bytesToHex(binding),
    operator: { endpoint: "https://api.enclave.host/t/host-a", expiry: 1800000000,
                message: P.operatorMessage({ ...ctx, id, endpoint: "https://api.enclave.host/t/host-a", binding, expiry: 1800000000 }) },
    threshold: 3, secretFill: 0x1b,   // the Shamir secret is 32 bytes of secretFill
    shares: shares.map((s) => ({ x: s.x, y: s.y.toString(16).padStart(64, "0") })),
    c0: bytesToHex(commitments[0]), dek: bytesToHex(dek), bundleAad: bytesToHex(aad), env, configText, configSha256: P.configSha256(configText),
    ciphertext: bytesToHex(ciphertext),
    responses, badResponse: bad,
  };
}

test("custody vectors: the JS reference reproduces the pinned fixture, and the Go copy is identical", () => {
  const v = build();
  const text = JSON.stringify(v, null, 2) + "\n";
  if (process.env.CUSTODY_VECTORS_WRITE === "1") { fs.writeFileSync(FIX, text); fs.writeFileSync(GO, text); }
  assert.equal(fs.readFileSync(FIX, "utf8"), text, "the JS reference no longer produces test/fixtures/custody-vectors.json");
  assert.equal(fs.readFileSync(GO, "utf8"), text, "the Go testdata copy differs from the JS fixture");
});

test("custody vectors: the responses open and combine to the bundle's env (JS side)", () => {
  const v = build();
  const sk = hpke.deriveKeyPair(new Uint8Array(32).fill(v.recipient.ikmFill)).privateKey, binding = hexToBytes(v.binding);
  const sh = v.responses.map((r) => ({ x: r.index + 1, y: P.openResponse({ recipientPrivate: sk, binding, encKey: hexToBytes(r.encKey), index: r.index, sealed: hexToBytes(r.sealed) }) }));
  const s = th.combine(sh, 3);
  assert.equal(s, BigInt("0x" + v.secretFill.toString(16).padStart(2, "0").repeat(32)));
  const b = P.decryptBundle(P.deriveDek(s, { chainId: v.chainId, vault: v.vault, id: v.id, secretRev: BigInt(v.secretRev) }), hexToBytes(v.bundleAad), hexToBytes(v.ciphertext));
  assert.deepEqual(b.env, v.env);
  assert.equal(b.configSha256, v.configSha256);
  assert.equal(P.configSha256(v.configText), v.configSha256);
});
