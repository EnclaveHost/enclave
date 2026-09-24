// The STATIC evidence-v3 and policy-type-2 fixtures (test/fixtures/pvm-v3/fixtures.json, made by make-fixtures.mjs over a
// synthetic CA; shielded/anchor/avf/INSTANCE-BINDING.md), replayed through BOTH verifiers -- relay/pvm-app-attest.mjs (node,
// the canonical module the verifier session imports) and web/pvm-verify.js (WebCrypto, the installed client's) -- which must
// reach the same outcome and the same final reason on every case, and the policy cases through the client's verifyPolicy.
// The verifier session pins this file and fixtures.json by commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyPvmAppEvidence as nodeVerify } from "../relay/pvm-app-attest.mjs";
import { verifyPvmAppEvidence as webVerify } from "../shielded/anchor/avf/web/pvm-verify.js";
import { verifyPolicy, selectDeployment, initialState } from "../shielded/anchor/avf/client/src/trust.js";

const F = JSON.parse(fs.readFileSync(new URL("./fixtures/pvm-v3/fixtures.json", import.meta.url)));

test("the fixtures are what they say: synthetic, pinned by root, with a fixed now", () => {
  assert.equal(F.type, "enclave-pvm-v3-fixtures/1");
  assert.match(F.note, /SYNTHETIC/);
  assert.ok(Number.isSafeInteger(F.now) && /^[0-9a-f]{64}$/.test(F.rootPin));
  assert.ok(F.evidence.length >= 16 && F.policy.length >= 7);
  assert.ok(!JSON.stringify(F).includes("PRIVATE KEY"), "no private key in the fixtures");
});

for (const c of F.evidence) {
  test(`evidence ${c.name}: ${c.what}`, async () => {
    const expect = { ...c.expect, ...F.pins, rootPins: [F.rootPin], now: F.now };
    const [n, w] = [nodeVerify(c.envelope, expect), await webVerify(c.envelope, expect)];
    assert.equal(n.ok, c.want.ok, `node: ${n.reasons.at(-1)}`);
    assert.equal(w.ok, c.want.ok, `web: ${w.reasons.at(-1)}`);
    assert.equal(n.reasons.at(-1), w.reasons.at(-1), "both verifiers give the same final reason");
    if (c.want.reason) assert.ok(n.reasons.at(-1).includes(c.want.reason), `"${n.reasons.at(-1)}" should say "${c.want.reason}"`);
    if (c.want.instanceId !== undefined) { assert.equal(n.instanceId, c.want.instanceId); assert.equal(w.instanceId, c.want.instanceId); }
    // (a): every check before the instance passed -- the refusal is the INSTANCE's, never the app's or the chain's
    if (c.want.passedAppKey) for (const r of [n, w]) {
      assert.ok(r.reasons.some((x) => x.includes("the instance key signed this challenge")), "the instance signature verified");
      assert.ok(r.reasons.some((x) => x.includes("app key") && x.includes("and instance")), "the app key statement verified");
      assert.ok(r.reasons.some((x) => x.includes("Bind3")), "the certificate's challenge verified");
    }
  });
}

for (const c of F.policy) {
  test(`policy ${c.name}: ${c.what}`, async () => {
    const r = await verifyPolicy(c.envelope, { state: initialState(F.policyAnchor), now: F.policyNow });
    assert.equal(r.ok, c.want.ok, r.reasons[0]);
    if (c.want.reason) assert.ok(r.reasons[0].includes(c.want.reason), `"${r.reasons[0]}" should say "${c.want.reason}"`);
    if (c.want.instances) for (const [d, inst] of Object.entries(c.want.instances)) assert.deepEqual(selectDeployment(r.policy, { deployment: d }).instances, inst);
  });
}
