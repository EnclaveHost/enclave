// node:test of the FULL actual prepare() (production-activation-prep-r1, unchanged) over the actual pinned inputs, the
// actual staged parsers / loader, and a scripted TEST observation (test/fixture.mjs). No network, no key, no env.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { K, checksum, lower } from "../../production-activation-prep-r1/lib/bindings.mjs";
import { prepare } from "../../production-activation-prep-r1/prepare-activation.mjs";
import { POLICY } from "../generate-preparation-inputs.mjs";
import { NOW, setup, synthCode } from "./fixture.mjs";

const run = (f) => prepare({ pinsPath: f.pinsPath, out: f.out, now: NOW });
async function refuses(t, opts, code, { needsChain = false } = {}) {
  const f = await setup(opts);
  if (needsChain && f.bundleWhy) return t.skip(f.bundleWhy);
  await assert.rejects(run(f), (e) => { assert.equal(e.code, code, e.message); return true; });
  assert.equal(fs.existsSync(f.out), false, "a refusal writes nothing");
}
const both = (fn) => (o) => o.providers.forEach(fn);
const firstCodeKey = (p) => Object.keys(p.reads).find((k) => k.startsWith("code|"));   // FundingSessionVaultLib, read first
const json = (dir, n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
const RELAYER = "0xf4b78d91911e1c064a02e4d28c69e2de6056be57";                        // production-session-config-2128.json

test("FULL prepare() happy path: actual inputs, actual parsers + loader, TEST observation", async (t) => {
  const f = await setup();
  if (f.bundleWhy) return t.skip(f.bundleWhy);
  const p = await run(f);
  assert.equal(p.status, "PREPARED_NOT_APPROVED");
  assert.deepEqual(Object.keys(p.outputs).sort(), ["fee-policy.json", "intake-manifest.json", "owner-controls.json"]);
  assert.deepEqual(p.feeChangesFromReviewedObservation, []);
  assert.match(p.facts.feeConfigHash, /^0x[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(f.out, "PREPARED.json")));
  const S = f.ctx.receipts.byName, R = f.ctx.reviewedFee;
  const owner = json(f.out, "owner-controls.json");
  assert.equal(owner.maxBlockAgeSec, POLICY.maxBlockAgeSec);
  assert.equal(owner.addresses.factory, checksum(S.FundingSessionVaultFactory.address));
  assert.equal(owner.codehashes.factory, S.FundingSessionVaultFactory.runtimeCodehash);
  assert.equal(owner.codehashes.fundingGasLib, S.FundingGasLib.runtimeCodehash);
  assert.equal(owner.codehashes.fundingSessionVaultLib, S.FundingSessionVaultLib.runtimeCodehash);
  assert.equal(owner.codehashes.implementation, f.decisions.expected.implementationCodehash);
  const intake = json(f.out, "intake-manifest.json");
  assert.equal(intake.notAfter, NOW + 86_400);
  assert.deepEqual(intake.feeTiers, [100, 500, 3000]);
  assert.equal(intake.maxSlippageBps, 100);
  assert.equal(intake.deadlineSec, 300);
  assert.equal(intake.maxBlockAgeSec, 180);
  assert.equal(lower(intake.addresses.quoter), lower(POLICY.quoter));
  assert.equal(intake.addresses.adapter, checksum(S.LeaseGasDexAdapter.address));
  assert.equal(intake.codehashes.adapter, S.LeaseGasDexAdapter.runtimeCodehash);
  const fee = json(f.out, "fee-policy.json");
  assert.deepEqual(fee.tx, { gasLimit: 1_000_000, maxFeePerGas: "20000000", maxPriorityFeePerGas: "2000000", maxSignedBytes: 720, maxAttempts: 3, replacementBumpBps: 2500 });
  assert.deepEqual(fee.pricing, { marginBps: 2000, maxFee6: "80000" });
  assert.equal(fee.notAfter, NOW + 86_400);
  assert.equal(fee.maxBlockAgeSec, 180);
  assert.equal(fee.sequencer.graceSec, 3600);
  for (const k of ["proxyCodehash", "implementation", "implementationCodehash"]) assert.equal(lower(fee.oracle[k]), lower(R.oracle[k]));
  for (const k of ["proxyCodehash", "aggregator", "aggregatorCodehash"]) assert.equal(lower(fee.feed[k]), lower(R.feed[k]));
  for (const k of ["proxyCodehash", "aggregator", "aggregatorCodehash"]) assert.equal(lower(fee.sequencer[k]), lower(R.sequencer[k]));
  assert.equal(p.facts.relayer.balanceWei, "200000000000000");
  assert.equal(p.observation.block.number, "53300000");       // the TEST block, never a claimed live one
});

// ---- refusals that need no pinned runtime code (decisions, pins, observation, before the chain walk) -----------------
test("the generated DRAFT (reviewedBy null) is refused", (t) => refuses(t, { decisions: (d) => { d.reviewedBy = null; } }, "decision_missing"));
test("development relayer refused", (t) => refuses(t, { decisions: (d) => { d.relayer = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; } }, "default_credentials"));
test("implementation other than the deployment observation refused", (t) =>
  refuses(t, { decisions: (d) => { d.expected.implementationCodehash = `0x${"00".repeat(32)}`; } }, "inconsistent_hashes"));
test("observation edited after pinning refused", async () => {
  const f = await setup();
  fs.appendFileSync(f.observationPath, " ");
  await assert.rejects(run(f), (e) => e.code === "pin_drift");
  assert.equal(fs.existsSync(f.out), false);
});
test("existing --out refused", async () => {
  const f = await setup();
  fs.mkdirSync(f.out);
  await assert.rejects(run(f), (e) => e.code === "out_exists");
});
test("stale observation refused (age > 900s)", (t) => refuses(t, { observation: (o) => { o.capturedAt = NOW - 901; } }, "observation_stale"));
test("pinned block more than 300s older than the capture refused", (t) =>
  refuses(t, { observation: both((p) => { p.block.timestamp = String(NOW - 5 - 301); }) }, "observation_stale"));
test("single provider refused", (t) => refuses(t, { observation: (o) => { o.providers.length = 1; } }, "providers"));
for (const [k, v] of [["number", "53300001"], ["hash", `0x${"ab".repeat(32)}`], ["timestamp", String(NOW - 21)], ["baseFeePerGas", "5000001"]]) {
  test(`providers disagreeing on block ${k} refused`, (t) => refuses(t, { observation: (o) => { o.providers[1].block[k] = v; } }, "provider_disagreement"));
}
for (const v of ["0x6ae2f4ec", "-20", "1793299980.0", "1.79e9", " 1793299980", ""]) {
  test(`non-strict unsigned block timestamp ${JSON.stringify(v)} refused`, (t) =>
    refuses(t, { observation: both((p) => { p.block.timestamp = v; }) }, v === "" ? "provider_disagreement" : "observation"));
}
test("providers disagreeing on a read refused", (t) =>
  refuses(t, { observation: (o) => { o.providers[1].reads[firstCodeKey(o.providers[1])] = synthCode("0x01"); } }, "provider_disagreement"));
test("synthetic code at a confirmed receipt address refused", (t) =>
  refuses(t, { observation: both((p) => { p.reads[firstCodeKey(p)] = synthCode("0x02"); }) }, "codehash_mismatch"));

// ---- refusals inside / after the full chain walk (need the real pinned runtime code) ----------------------------------
const chain = { needsChain: true };
test("relayer balance below 1e14 wei refused", (t) =>
  refuses(t, { observation: both((p) => { p.reads[K.balance(RELAYER)] = "99999999999999"; }) }, "relayer_balance", chain));
test("relayer pending nonce refused", (t) =>
  refuses(t, { observation: both((p) => { p.reads[K.nonce(RELAYER, "pending")] = "43"; }) }, "pending_nonce_observed", chain));
test("relayer with code refused", (t) => refuses(t, { observation: both((p) => { p.reads[K.code(RELAYER)] = "0x6000"; }) }, "relayer_not_eoa", chain));
test("base fee + tip above maxFeePerGas refused", (t) => refuses(t, { observation: both((p) => { p.block.baseFeePerGas = "18000001"; }) }, "fee_cap_below_base", chain));
test("measured execute whose queue gas exceeds the 1M cap refused", (t) =>
  refuses(t, { decisions: (d) => { d.queue.measuredExecuteGasUsed = "784001"; } }, "gas_cap_below_measured", chain));
test("tx.maxAttempts above the host queue refused", (t) => refuses(t, { decisions: (d) => { d.queue.maxAttempts = 2; } }, "attempts", chain));
test("unlisted sequencer grace weakening refused", (t) =>
  refuses(t, { decisions: (d) => { d.feePolicy.sequencer.graceSec = 0; } }, "unapproved_substitution", chain));
test("unlisted maxFee6 raise refused", (t) => refuses(t, { decisions: (d) => { d.feePolicy.pricing.maxFee6 = "100000"; } }, "unapproved_substitution", chain));
test("quoter.factory() not the adapter's DEX factory refused", (t) =>
  refuses(t, { observation: both((p) => { p.reads[K.call(POLICY.quoter, "factory")] = `0x${"11".repeat(20)}`; }) }, "identity_mismatch", chain));
test("oracle implementation code drift since the reviewed fee observation refused", (t) =>
  refuses(t, { observation: both((p) => { p.reads[K.code("0x4f1db3c6abd250ba86e0928471a8f7db3afd88f1")] = synthCode("0x03"); }) }, "fee_identity_drift", chain));

// Root review: sequencer identity must remain pinned just like price feed and oracle.
test("sequencer proxy code drift refused", async t => {
  const f = await setup();
  const a = f.ctx.reviewedFee.sequencer.address;
  return refuses(t, { observation: both(p => { p.reads[K.code(a)] = synthCode("0x04"); }) }, "fee_identity_drift", chain);
});
test("sequencer aggregator code drift refused", async t => {
  const f = await setup();
  const a = f.ctx.reviewedFee.sequencer.aggregator;
  return refuses(t, { observation: both(p => { p.reads[K.code(a)] = synthCode("0x05"); }) }, "fee_identity_drift", chain);
});
