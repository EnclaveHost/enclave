// The lease proof key's REPLAYABLE vectors (test/fixtures/pvm-proof-key/fixtures.json, made from the Pixel 10 device run by
// make-fixtures.mjs; PROOF-KEY.md): every statement case and every checkpoint case must give exactly its recorded outcome --
// the claims on success, the EXACT reason on a refusal -- through the canonical verifiers (relay/pvm-app-attest.mjs
// verifyPvmProofKey, relay/pvm-checkpoint.mjs verifyPvmCheckpoint). The verifier session pins this file and the fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyPvmProofKey, proofKeyMessage, INSTANCE_TYPES, SIG_ALGS } from "../relay/pvm-app-attest.mjs";
import { verifyPvmCheckpoint } from "../relay/pvm-checkpoint.mjs";

const F = JSON.parse(fs.readFileSync(new URL("./fixtures/pvm-proof-key/fixtures.json", import.meta.url), "utf8"));

test("the fixtures are the device's: a real v3 envelope, a local lease, no private key", () => {
  assert.equal(F.type, "enclave-pvm-proof-key-fixtures/1");
  assert.equal(F.statements[0].statement.evidence.format, "enclave-pvm-app-evidence/v3");
  assert.ok(F.statements.length >= 26 && F.checkpoints.length >= 7);
  assert.ok(!JSON.stringify(F).includes("PRIVATE KEY"));
  // the agreed message is 271 bytes (the verifier session's check of the header)
  const c = F.statements[0].want.claims, e = F.statements[0].expect;
  const m = proofKeyMessage({ nonce: e.nonce, appId: c.appId, instanceType: INSTANCE_TYPES["pvm-instance-id"], instanceValue: c.instanceId, sigAlg: SIG_ALGS.ed25519,
                              proofKey: c.proofKey, chainId: c.chainId, proofOfTime: c.proofOfTime, registry: c.registry, deployment: c.deployment, enclaveId: c.enclaveId, operator: c.operator });
  assert.equal(m.length, 271);
});
for (const c of F.statements) {
  test(`statement ${c.name}: ${c.what}`, () => {
    const v = verifyPvmProofKey(c.statement, c.expect);
    assert.equal(v.ok, c.want.ok, v.reasons.at(-1));
    if (c.want.ok) {   // the recorded claims (pinned by the verifier session) predate codeHash: it must be the build the fixture pins
      const { codeHash, ...rest } = v.claims;
      assert.deepEqual(rest, c.want.claims);
      assert.ok(c.expect.allowedCodeHashes.includes(codeHash) && /^[0-9a-f]{64}$/.test(codeHash), `codeHash ${codeHash} is a pinned build`);
      if (c.expect.allowedCodeHashes.length === 1) assert.equal(codeHash, c.expect.allowedCodeHashes[0]);
    }
    else assert.equal(v.reasons.at(-1), c.want.reason, "the exact reason");
  });
}
for (const c of F.checkpoints) {
  test(`checkpoint ${c.name}: ${c.what}`, async () => {
    const r = await verifyPvmCheckpoint(c.checkpoint, { pins: c.pins, proofKey: c.proofKey });
    assert.equal(r.ok, c.want.ok, r.reasons[0]);
    if (c.want.ok) assert.equal(r.checkpoint.digest, c.want.digest);
    else assert.equal(r.reasons[0], c.want.reason, "the exact reason");
  });
}
