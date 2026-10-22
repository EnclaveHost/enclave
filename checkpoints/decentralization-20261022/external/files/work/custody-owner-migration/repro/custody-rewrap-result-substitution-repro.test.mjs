// REPRODUCTION (root security review P1) against the PRE-FIX candidate custody/v2/rewrap.mjs (sha256 ae19d081…):
// the guest posts a bare public result to the UNTRUSTED host; the owner's checkResultAndSwitch checks only public fields
// (authorization digest, chain, vault, the destination label proof). A host replaces result.bundle with a fresh
// encryptBundle(public destination Y, the correct public label, ARBITRARY env), recomputes bundleHash/bundleBytes, and the
// owner's tooling builds a switch update carrying the ATTACKER'S bundle. This test PASSES while the bug exists.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { keccak256 } from "viem";
import * as v2 from "../custody/v2/protocol.mjs";
import { normalizeAuthorization, rewrapDigest, sealForDestination, checkResultAndSwitch, REWRAP_RUNTIME_ID } from "../custody/v2/rewrap.mjs";

test("PRE-FIX: a host-substituted bundle with attacker-chosen secrets passes the owner's check", () => {
  const CHAIN = 8453, VAULT = "0xe48699b8401564aace7a814ae4569b67a3f7eef5";
  const dst = v2.genesis(), dstY = "0x" + Buffer.from(dst.Y).toString("hex"), h = () => "0x" + randomBytes(32).toString("hex");
  const auth = { id: h(), sourcePolicyRev: "3", sourceSecretRev: "2", sourceCommitteeId: h(), sourceBundleHash: h(), destCommitteeId: h(), destKeyHash: keccak256(dstY),
    destCodeMeasurement: h(), destSecretRev: "3", leaseEndpoint: "https://app.host.test", rewrapMeasurement: h(), rewrapRuntimeId: "0x" + REWRAP_RUNTIME_ID, expiry: "1900000000" };
  const a = normalizeAuthorization(auth);
  const RULES = { v: 1, appId: "a7".repeat(32), images: [{ platform: "sev-snp", measurement: "77".repeat(48), runtimeId: "29".repeat(32) }], minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 };
  // the honest guest's result (what rewrap-guest.mjs posts to the host)
  const honest = sealForDestination({ chainId: CHAIN, vault: VAULT, a, destY: dst.Y, payload: { env: { API_KEY: "the-real-secret" }, configSha256: "c".repeat(64) } });
  const hb = "0x" + Buffer.from(honest.bundle).toString("hex");
  const result = { format: "enclave-custody-rewrap/1", chainId: CHAIN, vault: VAULT, authorizationDigest: rewrapDigest({ chainId: CHAIN, vault: VAULT, authorization: auth }),
    authorization: auth, checkedAtBlock: { number: "1", hash: h() }, destination: { committeeId: a.destCommitteeId, secretRev: "3", label: "0x" + Buffer.from(honest.label).toString("hex") },
    bundle: hb, bundleHash: keccak256(hb), bundleBytes: honest.bundle.length };
  // the HOST's substitution: only public inputs (destination Y from the chain, the public label)
  const label = v2.labelOf({ chainId: CHAIN, vault: VAULT, id: a.id, secretRev: a.destSecretRev, committeeId: a.destCommitteeId });
  const evil = v2.encryptBundle({ Y: dst.Y, label, env: { API_KEY: "attacker-chosen" }, configSha256: "d".repeat(64) });
  const eb = "0x" + Buffer.from(evil).toString("hex");
  const forged = { ...result, bundle: eb, bundleHash: keccak256(eb), bundleBytes: evil.length };
  const { switchUpdate } = checkResultAndSwitch({ chainId: CHAIN, vault: VAULT, authorization: auth, result: forged, originalRules: RULES });
  assert.equal(switchUpdate.bundle, eb, "VULNERABLE: the owner would sign a switch carrying the host's bundle");
  // and it opens (for the destination committee) to the attacker's data
  const opened = v2.decryptBundle({ S: v2.parseBundle(evil).Rp.multiply(dst.shares[0].x), label, bundle: evil });
  assert.deepEqual(opened.env, { API_KEY: "attacker-chosen" });
});
