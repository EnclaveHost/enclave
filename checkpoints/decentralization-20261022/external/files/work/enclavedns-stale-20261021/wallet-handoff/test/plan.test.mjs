// The PRODUCTION plan, rebuilt from the pins: byte-equal to the independently produced unsigned transactions
// (release-0.1.5-r2/unsigned-txs.json from gen-unsigned.mjs, which the writer simulated on two RPCs and reviewer 9d decoded in
// REVIEW-R2), the frozen artifact the reviewed one, and the plan text deterministic.   run: node --test test/plan.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { decodeFunctionData } from "../../../enclave/node_modules/viem/_esm/index.js";
import { DNS, releasePlan, CATALOG_ABI, LEDGER_ABI, VAULT_ABI } from "../trust.mjs";
import { buildHandoffPlan } from "../handoff-plan.mjs";

const sha = (x) => createHash("sha256").update(x).digest("hex");
const plan = releasePlan(DNS);
const U = JSON.parse(fs.readFileSync(new URL("../../release-0.1.5-r2/unsigned-txs.json", import.meta.url), "utf8"));
const M = JSON.parse(fs.readFileSync(new URL("../../release-0.1.5-r2/MANIFEST.json", import.meta.url), "utf8"));

test("the publish calldata is exactly the reviewed unsigned publishVersion (same appId, index 5, fee 0, v4 config verbatim)", () => {
  assert.equal(plan.appId, DNS.app.appId);
  assert.equal(plan.publishData, U.publish.tx.data);
  assert.equal(DNS.catalog.toLowerCase(), U.publish.tx.to.toLowerCase()); assert.equal(DNS.admin.toLowerCase(), U.publish.tx.from.toLowerCase()); assert.equal(U.publish.tx.value, "0");
  const { args } = decodeFunctionData({ abi: CATALOG_ABI, data: plan.publishData });
  assert.deepEqual([args[0], args[1], args[3], args[4]], ["enclavedns", "EnclaveDNS", "0.1.5", DNS.expectedCid]);
  assert.deepEqual([...args[5]], [0, 0, 256, 16]); assert.equal(args[6], "http:8000"); assert.equal(args[8], 0n);
  assert.equal(sha(args[7]), "2f409c560bdefbaa4011fa95650d9406251d1f8072bfc6e986c7937411dc407a", "config is version 0.1.4's, byte for byte");
  assert.equal(U.publish.expectIndex, "5");
});

test("the upgrade is vault.ownerCall(ledger, setAppRef(existing deployment, catalog://<appId>/5)): byte-equal to the reviewed unsigned upgrade", () => {
  assert.equal(plan.upgradeData, U.upgrade.tx.data);
  assert.equal(DNS.vault.address, U.upgrade.tx.to.toLowerCase()); assert.equal(DNS.admin.toLowerCase(), U.upgrade.tx.from.toLowerCase());
  const o = decodeFunctionData({ abi: VAULT_ABI, data: plan.upgradeData });
  assert.equal(o.functionName, "ownerCall"); assert.equal(o.args[0].toLowerCase(), DNS.ledger.toLowerCase());
  const { functionName, args } = decodeFunctionData({ abi: LEDGER_ABI, data: o.args[1] });
  assert.equal(functionName, "setAppRef"); assert.equal(args[0], DNS.deployment.id); assert.equal(args[1], `catalog://${DNS.app.appId}/5`);
  // the rollback (not part of this handoff) differs only in the version index
  assert.equal(U.rollback.appRef, `catalog://${DNS.app.appId}/4`);
});

test("the frozen artifact is the reviewed release (MANIFEST e3780187, 2,588,705 bytes, CID bafybeic3peeq…)", () => {
  const b = fs.readFileSync(DNS.wasm.path);
  assert.equal(sha(b), M.artifact.sha256); assert.equal(b.length, M.artifact.bytes); assert.equal(DNS.expectedCid, M.artifact.cidv1);
});

test("every step sends 0 ETH from the owner, to the catalog or the vault only; three steps; the plan text is deterministic", () => {
  for (const s of plan.steps.filter((x) => x.kind === "transaction")) { assert.equal(s.value, "0x0"); assert.equal(s.from, DNS.admin.toLowerCase()); assert.ok([DNS.catalog.toLowerCase(), DNS.vault.address].includes(s.to)); }
  assert.deepEqual(plan.steps.map((s) => s.step), ["upload", "publish", "upgrade"]);
  assert.equal(buildHandoffPlan(DNS).sha256, buildHandoffPlan(DNS).sha256);
});
