#!/usr/bin/env node
// Writes test/fixtures/custody-v2-vectors.json (and the Go copy in isolation/m2/custody/testdata/): deterministic v2
// values the JS reference (custody/v2/protocol.mjs) and the Go guest (isolation/m2/custody/v2*.go) must both reproduce.
//   node scripts/custody-v2-vectors.mjs [--check]
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as v2 from "../custody/v2/protocol.mjs";
import * as hpke from "../custody/hpke.mjs";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const OUT = [path.join(ROOT, "test/fixtures/custody-v2-vectors.json"), path.join(ROOT, "isolation/m2/custody/testdata/v2-vectors.json")];
const h = (b) => bytesToHex(b);
const sc = (n) => (BigInt(n) % v2.Q);
const G = (s) => secp256k1.ProjectivePoint.BASE.multiply(s);

export function build() {
  const chainId = 8453, vault = "0x08074300f75e78212ae10ebd14984f78e17811a6";
  const id = "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e";
  const committeeId = "0x" + "c0".repeat(32);
  // four machines: two Enclave replicas + two other hosts -> 3 seats, t = 2, indices E=1, N1=2, N2=3
  const machines = [{ enclave: true }, { enclave: true }, { enclave: false }, { enclave: false }];
  const lay = v2.seatLayout(machines);
  const coeffs = [sc("0x" + "5a".repeat(32)), sc("0x" + "17".repeat(32))];
  const shareOf = (k) => (coeffs[0] + coeffs[1] * BigInt(k)) % v2.Q;
  const commitments = coeffs.map((c) => v2.pointBytes(G(c)));
  const Y = commitments[0];
  const label = v2.labelOf({ chainId, vault, id, secretRev: 3, committeeId });
  const env = { API_KEY: "vector-value", DB_URL: "postgres://u:p@db:5432/x" };
  const configSha256 = "7d".repeat(32);
  const bundle = v2.encryptBundle({ Y, label, env, configSha256, _r: sc("0x" + "a1".repeat(32)), _k: sc("0x" + "b2".repeat(32)), _nonce: hexToBytes("00112233445566778899aabb") });
  const R = v2.parseBundle(bundle).R;
  const challenges = [{ encKey: hexToBytes("e1".repeat(32)), nonce: hexToBytes("11".repeat(32)) }, { encKey: hexToBytes("e3".repeat(32)), nonce: hexToBytes("33".repeat(32)) }];
  const transportSpki = hexToBytes("30".repeat(44));
  const recipient = hpke.deriveKeyPair(hexToBytes("72".repeat(32)));
  const binding = v2.releaseBinding({ chainId, vault, id, policyRev: 2, secretRev: 3, committeeId, epoch: 5, challenges, runtimeId: hexToBytes("9b".repeat(32)), transportSpki, recipientKey: recipient.publicKey });
  const records = [1, 3].map((k) => v2.partial({ k, x: shareOf(k), R, binding, commitments, _u: sc("0x" + (k === 1 ? "c1" : "c3").repeat(32)) }));
  const memberEncKey = hexToBytes("e3".repeat(32));
  const sealed = hpke.seal(recipient.publicKey, v2.PARTIAL_INFO, v2.partialAad({ binding, encKey: memberEncKey, count: 1 }), records[1], { _ikmE: hexToBytes("44".repeat(32)) });
  const S = v2.combine(records.map((record) => v2.verifyPartial({ record, R, binding, commitments })), lay.t);
  const back = v2.decryptBundle({ S, label, bundle });
  return {
    note: "custody v2 vectors (scripts/custody-v2-vectors.mjs); every hex is lowercase, no 0x unless an address/id",
    chainId, vault, id, committeeId, secretRev: 3, policyRev: 2, epoch: 5,
    seats: { machines: machines.map((m) => m.enclave), n: lay.n, t: lay.t, W: lay.W, indices: machines.map((_, i) => lay.indicesOf(i)) },
    commitments: commitments.map(h), Y: h(Y),
    label: h(label), configSha256, env, bundle: h(bundle),
    challenges: challenges.map((c) => ({ encKey: h(c.encKey), nonce: h(c.nonce) })), challengeRoot: h(v2.challengeRoot(challenges)),
    runtimeId: "9b".repeat(32), transportSpki: h(transportSpki), recipientPrivate: h(recipient.privateKey), recipientKey: h(recipient.publicKey),
    binding: h(binding),
    partials: records.map(h), partialIndices: [1, 3],
    sealedPartial: { memberEncKey: h(memberEncKey), count: 1, sealed: h(sealed), record: h(records[1]) },
    S: h(v2.pointBytes(S)), decrypted: back,
    seatCases: [[true], [true, true, true], [true, false], [false, true, false], [true, true, false, false, false, false]].map((ms) => {
      const l = v2.seatLayout(ms.map((e) => ({ enclave: e }))); return { machines: ms, n: l.n, t: l.t, W: l.W, indices: ms.map((_, i) => l.indicesOf(i)) };
    }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = JSON.stringify(build(), null, 1) + "\n";
  if (process.argv.includes("--check")) {
    for (const f of OUT) if (fs.readFileSync(f, "utf8") !== text) { console.error(`${f} is stale: run node scripts/custody-v2-vectors.mjs`); process.exit(1); }
    console.log("vectors current");
  } else { for (const f of OUT) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); } console.log("wrote", OUT.join(", ")); }
}
