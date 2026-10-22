// The PRODUCTION plan, rebuilt from the pins: byte-equal to the independently produced requests (worker 9d's simulated
// publishVersion data and the enclave CLI's own unsigned `config set`), the envelope change exactly one key, and the plan
// text deterministic.   run: node --test test/plan.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { decodeFunctionData } from "../../../enclave/node_modules/viem/_esm/index.js";
import { PUB, publisherPlan, CATALOG_ABI, LEDGER_ABI } from "../trust.mjs";
import { buildHandoffPlan } from "../handoff-plan.mjs";

const sha = (x) => createHash("sha256").update(x).digest("hex");
const shaHex = (h) => sha(Buffer.from(h.slice(2), "hex"));
const plan = publisherPlan(PUB);
const NINE_D = JSON.parse(fs.readFileSync(new URL("../../publisher/composed-release/release-prep.json", import.meta.url), "utf8"));
const WALLET = JSON.parse(fs.readFileSync(new URL("../../publisher/composed-release/wallet-prep.json", import.meta.url), "utf8"));

test("the publish calldata is exactly 9d's two-RPC-simulated publishVersion (same appId, index 6, fee 0, v5 config verbatim)", () => {
  assert.equal(plan.appId, PUB.app.appId);
  assert.equal(shaHex(plan.publishData), NINE_D.publishSimulation.dataSha256);
  const { args } = decodeFunctionData({ abi: CATALOG_ABI, data: plan.publishData });
  assert.deepEqual([args[0], args[1], args[2], args[3], args[4]], [NINE_D.catalog.app.slug, NINE_D.catalog.app.name, NINE_D.catalog.app.description, "1.0.6", NINE_D.artifact.cid]);
  assert.deepEqual([...args[5]], [0, 0, 128, 1]); assert.equal(args[6], "http:8000"); assert.equal(args[8], 0n);
  assert.equal(sha(args[7]), NINE_D.catalog.v5.configSha256, "config is version 1.0.5's, byte for byte");
  assert.equal(NINE_D.nextVersion.index, 6); assert.ok(!NINE_D.nextVersion.existingLabels.includes("1.0.6"));
  assert.equal(PUB.wasm.sha256, NINE_D.artifact.sha256); assert.equal(PUB.wasm.bytes, NINE_D.artifact.bytes); assert.equal(PUB.expectedCid, NINE_D.artifact.cid);
});

test("the config calldata is exactly the enclave CLI's own unsigned `config set` from the HOLD file", () => {
  const cli = WALLET.steps.configSet.unsigned;
  assert.equal(plan.configData, cli.data); assert.equal(PUB.ledger.toLowerCase(), cli.to.toLowerCase()); assert.equal(PUB.admin.toLowerCase(), cli.from.toLowerCase()); assert.equal(cli.value, "0x0");
});

test("the envelope change is ONLY config.ipni.announceAllBlocks false -> true; secrets refs, placement, isolation kept", () => {
  const a = JSON.parse(PUB.deployment.envelopeCurrent), b = JSON.parse(PUB.deployment.envelopeNew);
  assert.equal(a.config.ipni.announceAllBlocks, false); assert.equal(b.config.ipni.announceAllBlocks, true);
  b.config.ipni.announceAllBlocks = false;
  assert.deepEqual(b, a);
  assert.equal(PUB.deployment.envelopeNew.replace('"announceAllBlocks":true', '"announceAllBlocks":false'), PUB.deployment.envelopeCurrent, "byte-identical apart from that value");
  assert.equal(a.config.ipnsKey, "$IPNS_ED25519_SK"); assert.equal(a.config.api_key, "$API_KEY");
  assert.ok(a.placement.hostId && a.isolation, "placement and isolation present and unchanged");
  assert.equal(WALLET.steps.configShow.envelopeSha256, sha(PUB.deployment.envelopeCurrent), "the current envelope is the live one 9d read");
});

test("the upgrade is setAppRef(existing deployment, catalog://<appId>/6) and nothing else", () => {
  const { functionName, args } = decodeFunctionData({ abi: LEDGER_ABI, data: plan.upgradeData });
  assert.equal(functionName, "setAppRef"); assert.equal(args[0], PUB.deployment.id); assert.equal(args[1], `catalog://${PUB.app.appId}/6`);
});

test("every step sends 0 ETH from the owner, to the catalog or the ledger only; the plan text is deterministic", () => {
  for (const s of plan.steps.filter((x) => x.kind === "transaction")) { assert.equal(s.value, "0x0"); assert.equal(s.from, PUB.admin.toLowerCase()); assert.ok([PUB.catalog, PUB.ledger].map((a) => a.toLowerCase()).includes(s.to)); }
  assert.deepEqual(plan.steps.map((s) => s.step), ["upload", "publish", "upgrade", "config"]);
  assert.equal(buildHandoffPlan(PUB).sha256, buildHandoffPlan(PUB).sha256);
});
