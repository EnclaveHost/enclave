// site/vendor/custody-v2.js (scripts/build-custody-v2-vendor.mjs): the committed bundle is exactly a fresh build of
// custody/v2/browser.mjs, carries no Node built-in, is built from exactly the reviewed sources (the owner-read files at the
// hashes frozen in work/claude-owner-secrets-result.md), and computes the same answers as the Node modules it re-exports.
//   run: node --test --test-concurrency=1 test/custody-v2-vendor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { buildCustodyV2Vendor, OUT, MANIFEST, SOURCES } from "../scripts/build-custody-v2-vendor.mjs";
import * as v2 from "../custody/v2/protocol.mjs";
import { policyRulesOf, planSecretsEdit } from "../custody/v2/owner-secrets.mjs";
import { canonicalRules } from "../custody/rules.mjs";
import { canonicalShieldRules, SHIELD_RULES_FORMAT, SHIELD_TIER_ACK } from "../custody/v2/shield-rules.mjs";
import { updateTypedDataV2 } from "../custody/v2/owner.mjs";
import { configTextFromEnvelope } from "../custody/protocol.mjs";

// the owner-read sources as frozen for review (work/claude-owner-secrets-result.md)
const FROZEN = { "custody/v2/owner-secrets.mjs": "b47e835be86d66095a02e4f34e555c7fa6434cc7829056419d0f3f37ae147f01",
  "custody/v2/protocol.mjs": "d30852c2b227760f95a900b2240355c507173e81f221b38219e34a3f8def38e4",
  "custody/v2/chain.mjs": "9f2ed5caa4a79fc27e4ad4583abc7d5fd62cc60296bc89aa0560594cdf6d6b99",
  "custody/rules.mjs": "f35635aa4103f8075e3fcccc0be95b6c50f2d66240e95041509feeb17c7d694d",
  "custody/v2/shield-rules.mjs": "d3f857d1a75243c1262cb62b3fc44325246a7bcc35ec44ba388599f0c4c14ef9" };

test("the committed bundle and manifest are exactly a fresh build; no Node built-in; only the allowlisted sources", async () => {
  const { js, manifest } = await buildCustodyV2Vendor();
  assert.ok(Buffer.compare(fs.readFileSync(OUT), js) === 0, "site/vendor/custody-v2.js equals a fresh build (run scripts/build-custody-v2-vendor.mjs)");
  assert.equal(fs.readFileSync(MANIFEST, "utf8"), JSON.stringify(manifest, null, 2) + "\n", "the committed manifest equals the fresh one");
  const src = js.toString("utf8");
  assert.doesNotMatch(src, /\bfrom\s*["']node:|import\(\s*["']node:|require\(\s*["']node:/, "no node: import survives");
  assert.deepEqual(Object.keys(manifest.sources).sort(), [...SOURCES].sort(), "every allowlisted source, and nothing else");
  for (const [p, h] of Object.entries(FROZEN)) assert.equal(manifest.sources[p].sha256, h, `${p} is the frozen owner-read source`);
});

test("the bundle computes what the Node modules compute: rules opt-in by format, the owner-read typed data and binding, edits, the config commitment", async () => {
  const B = await import(pathToFileURL(OUT).href);
  const snp = { v: 1, appId: "a7".repeat(32), images: [{ platform: "sev-snp", measurement: "77".repeat(48), runtimeId: "cd".repeat(32) }],
                minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 };
  const shield = { format: SHIELD_RULES_FORMAT, acceptTier: SHIELD_TIER_ACK, appId: "a8".repeat(32), images: [{ measurement: "6a".repeat(32), runtimeId: "cd".repeat(32) }], platforms: "attested" };
  for (const bytes of [canonicalRules(snp), canonicalRules({ ...snp, ownerRead: true }), canonicalRules({ ...snp, ownerRead: false }),
                       canonicalShieldRules(shield), canonicalShieldRules({ ...shield, ownerRead: true })]) {
    const a = B.policyRulesOf(bytes), b = policyRulesOf(bytes);
    assert.deepEqual({ kind: a.kind, ownerRead: a.ownerRead }, { kind: b.kind, ownerRead: b.ownerRead });
    assert.equal(JSON.stringify(a.rules), JSON.stringify(b.rules));
  }
  assert.deepEqual(B.canonicalRules({ ...snp, ownerRead: true }), canonicalRules({ ...snp, ownerRead: true }));
  assert.throws(() => B.policyRulesOf(new TextEncoder().encode(JSON.stringify({ ...snp, ownerRead: "yes" }))), /ownerRead/);
  const f = { chainId: 8453, vault: "0x" + "56".repeat(20), id: "0x" + "e7".repeat(32), policyRev: 3n, secretRev: 2n, committeeId: "0x" + "cc".repeat(32), epoch: 1,
              challenges: [{ encKey: new Uint8Array(32).fill(1), nonce: new Uint8Array(32).fill(2) }], recipientKey: new Uint8Array(32).fill(3), expiry: 1234 };
  assert.deepEqual(B.ownerReadTypedData(f), v2.ownerReadTypedData(f));
  assert.deepEqual(B.ownerReadBinding(f), v2.ownerReadBinding(f));
  assert.equal(B.OWNER_READ_PURPOSE, v2.OWNER_READ_PURPOSE);
  const u = { expectPolicyRev: 3n, setPolicy: false, committeeId: "0x" + "00".repeat(32), paused: false, rules: "0x", setBundle: false, bundle: "0x", clear: true };
  assert.deepEqual(B.updateTypedDataV2({ chainId: 8453, vault: f.vault, id: f.id, update: u, deadline: 99n }), updateTypedDataV2({ chainId: 8453, vault: f.vault, id: f.id, update: u, deadline: 99n }));
  assert.deepEqual(B.planSecretsEdit({ op: "set", current: { A: "1" }, pairs: { B: "2" } }), planSecretsEdit({ op: "set", current: { A: "1" }, pairs: { B: "2" } }));
  const env1 = JSON.stringify({ config: { greeting: "hi", n: 2 } });
  assert.equal(B.configTextFromEnvelope(env1), configTextFromEnvelope(env1));
  assert.equal(B.configSha256(B.configTextFromEnvelope(env1)), (await import("../custody/protocol.mjs")).configSha256(configTextFromEnvelope(env1)));
  assert.throws(() => B.configTextFromEnvelope(""), /comes from its catalog version/, "a catalog config is named explicitly, as in the CLI");
});
