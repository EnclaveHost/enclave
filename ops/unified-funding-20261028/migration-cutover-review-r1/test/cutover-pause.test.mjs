// migration-cutover-prep-r1 tests. UNREVIEWED, NOT RUN by their author. Bounded OFFLINE tests of ONLY the cutover pause
// added by generator/generate_cutover.py (run it with --link-viem first). Everything the qualified production-grant-terms-r1
// tests already cover (codec, split, candidate literals, gas grants) is NOT repeated. Scripted chain / relays, a public
// TEST key, test addresses; the ids are the provisional recovery ids from CANDIDATE-TERMS.json used as plain data.
// Run (root):  node --test migration-cutover-prep-r1/test/cutover-pause.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { privateKeyToAccount } from "../../../source/node_modules/viem/_esm/accounts/index.js";
import { encodeAbiParameters, encodeEventTopics } from "../../../source/node_modules/viem/_esm/index.js";
import * as S from "../../../source/sdk/sessions/dist/browser.mjs";
import * as CM from "../candidate/sdk/funding/migration.mjs";
import * as CC from "../candidate/sdk/funding/funding-codec.mjs";
import { VAULT_EVENTS, USDC_EVENTS } from "../candidate/sdk/funding/chain-proof.mjs";
import { MemoryV2Store } from "../candidate/sdk/funding/v2-store.mjs";
import { canon, hashOf, jsonable } from "../candidate/sdk/funding/util.mjs";
import * as PM from "../../production-grant-terms-r1/candidate/sdk/funding/migration.mjs";

const HERE = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");          // migration-cutover-prep-r1
const BASE = path.resolve(HERE, "..", "production-grant-terms-r1");
const TERMS = JSON.parse(fs.readFileSync(path.join(BASE, "CANDIDATE-TERMS.json"), "utf8"));

// ---- fixtures (TEST ONLY) -------------------------------------------------------------------------------------------
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80").address;  // public anvil #0
const A = (b) => `0x${b.repeat(20)}`;
const H = (b) => `0x${b.repeat(32)}`;
const FACTORY = A("11"), IMPL = A("22"), ADAPTER = A("33"), LFACTORY = A("44"), LVAULT = A("55"), USDC = A("66"), RELAYER = A("77");
const ZERO = `0x${"0".repeat(64)}`;
const NOW = 1793202897n;
const LEG_EXP = 1793765924n;
const OLD_SID = H("0d");
const TX = H("7e");
const TBLOCK = H("b7");
const PP = TERMS.provisionalPartition;
const NUC = [...PP.nucbox.appIds].sort(), METAL = [...PP.metal.appIds].sort();
const ALL = [...NUC, ...METAL].sort();
const DEPS = [...PP.nucbox.deploymentIds, ...PP.metal.deploymentIds];
const scope = { appIds: ALL, byApp: {}, block: 1n, blockHash: H("b2"), timestamp: NOW,
  deployments: new Map(DEPS.map((d, i) => [d, { holder: LVAULT, env: 2, appId: ALL[i], active: true }])) };
const SPLIT = { legacy6: "24000000", gas: [{ name: "nucbox", budget6: "4800000", opsPerPeriod: "16", appIds: NUC },
  { name: "metal", budget6: "1200000", opsPerPeriod: "4", appIds: METAL }] };
const cfg = CC.fundingConfig({ chainId: 8453, factory: FACTORY, implementation: IMPL, vault: CC.predictVault(FACTORY, IMPL, OWNER),
  owner: OWNER, gasAdapter: ADAPTER, legacyFactory: LFACTORY, legacyVault: LVAULT, adapterMaxEthOut: 10n ** 17n, adapterFeeTiers: [100, 500, 3000] });
const pins = { usdc: USDC, legacyFactory: LFACTORY, factory: FACTORY, implementation: IMPL };
// Pre-cutover staging: chain-verified cfg, intake truthfully absent (the running relay has no /funding route).
const runtimeOff = Object.freeze({ cfg, pins, intake: null, intakeWhy: "funding_disabled: pre-cutover relay exposes no funding route", relayer: null,
  block: { number: 40n } });
const intakeOn = Object.freeze({ openEnabled: true, ownerEnabled: true, feeTiers: [100, 500, 3000], relayer: RELAYER });
const runtimeOn = (block = 100n, intake = intakeOn) => Object.freeze({ cfg, pins, intake, intakeWhy: null, relayer: intake?.relayer ?? null, block: { number: block } });
const CUTOVER = { pauseAfter: "terminate", activationPlanSha256: H("a5"), rollbackPlanSha256: H("5b") };
const OLD_ACTIONS = ["deploy.create", "deploy.fund", "api.status"];
const old = { label: "TEST original", preset: "browser", sessionKey: H("aa"), actions: OLD_ACTIONS, apps: ["*"],
  environments: ["staging", "prod"], budget: 30_000_000n, spendPerPeriod: 100_000_000n, periodSeconds: 86_400, opsPerPeriod: 1000,
  maxFeePerOp: 250_000n, maxAppFeePerHour: 0n, maxRatePerHour: 5_000_000n, expiresAt: LEG_EXP, measurement: ZERO, grantNonce: H("a1"),
  signBefore: NOW };
const evidence = { grant: old, sid: OLD_SID, owner: OWNER, factory: LFACTORY, vault: LVAULT, state: { balance6: 30_000_000n },
  observed: { block: 1, hash: H("b1"), timestamp: Number(NOW) } };
const OLD_STATE = Object.freeze({ live: true, state: 1, keyHash: H("aa"), measurement: ZERO, actions: CM.actionsMaskV1(S, OLD_ACTIONS),
  expiresAt: LEG_EXP, envs: 3, anyApp: true, balance6: 30_000_000n, spent6: 0n, perPeriod6: 100_000_000n, maxFee6: 250_000n,
  maxAppFeeHour6: 0n, maxRateHour6: 5_000_000n, period: 86_400, opsPerPeriod: 1000, periodSpent6: 0n, apps: Object.freeze([]) });
const log = (address, topics, data, i) => ({ address, topics, data, logIndex: `0x${i}`, removed: false });
const terminateReceipt = Object.freeze({ transactionHash: TX, blockNumber: "0x20", blockHash: TBLOCK, status: "0x1", logs: [
  log(LVAULT, encodeEventTopics({ abi: VAULT_EVENTS, eventName: "SessionEnded", args: { sid: OLD_SID } }),
    encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }], [1, 30_000_000n, 0n]), 0),
  log(USDC, encodeEventTopics({ abi: USDC_EVENTS, eventName: "Transfer", args: { from: LVAULT, to: OWNER } }),
    encodeAbiParameters([{ type: "uint256" }], [30_000_000n]), 1)] });
const codeOfAsync = async (fn) => { try { await fn(); } catch (e) { return e.code ?? `uncoded:${e.message}`; } return "NO_THROW"; };
const codeOf = (fn) => { try { fn(); } catch (e) { return e.code ?? `uncoded:${e.message}`; } return "NO_THROW"; };

function harness() {
  const gasStore = new MemoryV2Store();
  const calls = [];
  const chain = { lost: false,
    pin: async () => ({ tag: "0x28", number: 40n, hash: H("c1"), timestamp: NOW, recheck: async () => {} }),
    sessionOf: async (_v, sid) => (String(sid).toLowerCase() === OLD_SID ? OLD_STATE : { state: 0 }),
    owner: async () => OWNER, free: async () => 0n, vaultFor: async () => LVAULT,
    usdcBalance: async () => 30_000_000n, authorizationUsed: async () => false,
    receipt: async (h) => (chain.lost || String(h).toLowerCase() !== TX ? null : terminateReceipt),
    finality: async () => ({ final: true }), getLogs: async () => [] };
  const legacyStore = { load: async (id) => (String(id).toLowerCase() === OLD_SID ? { id: OLD_SID, keyHash: H("aa"), grant: old } : null),
    save: async () => { calls.push("legacyStore.save"); } };
  const ctx = (runtime, now = NOW + 10n) => ({ S, chain, gasStore, legacyStore, runtime, now, rng: globalThis.crypto,
    legacyRelay: { request: async (m, p) => { calls.push(`legacy ${m} ${p}`); return p === "/owner" ? { txHash: TX } : {}; } },
    relay: async (m, p) => { calls.push(`relay ${m} ${p}`); return {}; },
    setActive: async () => { calls.push("setActive"); } });
  return { gasStore, calls, chain, ctx };
}
const build = (h, cutover = CUTOVER, runtime = runtimeOff) => CM.buildMigrationPlan({ S, evidence, runtime, scope, split: SPLIT,
  now: NOW, rng: globalThis.crypto, subtle: globalThis.crypto.subtle, gasStore: h.gasStore, relayBase: "http://127.0.0.1:9",
  gasExpiresAt: LEG_EXP, ...(cutover ? { cutover } : {}) });
const bundle = (plan, steps = plan.terms.order) => Object.fromEntries(steps.map((k) => [k, { digest: plan.steps[k].review.digest, body: { test: k } }]));
const activationFor = (plan, over = {}) => ({ schema: CM.CUTOVER_ACTIVATION_SCHEMA, planId: plan.id, termsHash: plan.termsHash,
  terminateTxHash: TX, terminateBlockHash: TBLOCK, activationPlanSha256: CUTOVER.activationPlanSha256, relayer: RELAYER,
  legacyRelayerReconciledThroughNonce: "89", rootReviewed: true, reviewedBy: "root-test", ...over });
async function paused() {
  const h = harness();
  const plan = await build(h);
  const r = await CM.runMigration(h.ctx(runtimeOff), plan.id, bundle(plan));
  return { h, plan, r };
}

// =====================================================================================================================
test("only the cutover code differs from the qualified candidate; the other seven modules are byte-identical", () => {
  const added = Object.keys(CM).filter((k) => !(k in PM)).sort();
  assert.deepEqual(added, ["CUTOVER_ACTIVATION_SCHEMA", "CUTOVER_CLAIM", "cutoverHeld", "cutoverTerms", "resumeCutover"]);
  assert.deepEqual(Object.keys(PM).filter((k) => !(k in CM)), []);
  for (const k of Object.keys(PM)) {
    if (typeof PM[k] !== "function") { assert.equal(canon(jsonable(CM[k])), canon(jsonable(PM[k])), k); continue; }
    const same = CM[k].toString() === PM[k].toString();
    assert.equal(same, !["buildMigrationPlan", "runMigration"].includes(k), `${k} changed=${!same}`);
  }
  for (const f of ["browser-entry.mjs", "chain-proof.mjs", "funding-client.mjs", "funding-codec.mjs", "gas-execution.mjs", "util.mjs", "v2-store.mjs"]) {
    assert.ok(fs.readFileSync(path.join(HERE, "candidate", "sdk", "funding", f)).equals(fs.readFileSync(path.join(BASE, "candidate", "sdk", "funding", f))), f);
  }
});

test("prepare: a reviewed cutover plan builds with intake absent (recorded, not faked); without cutover intake-off still refuses", async () => {
  const h = harness();
  const plan = await build(h);
  assert.deepEqual(jsonable(plan.terms.cutover), { ...CUTOVER, claim: CM.CUTOVER_CLAIM });
  assert.equal(plan.termsHash, hashOf(plan.terms), "the pause is inside termsHash");
  assert.equal(plan.stagedIntake, null);
  assert.match(plan.stagedIntakeWhy, /pre-cutover/);
  assert.deepEqual(plan.terms.order, ["terminate", "legacyOpen", "gasOpen:nucbox", "gasOpen:metal"]);
  assert.equal(plan.cutover, undefined, "no pause marker before a proven terminate");
  assert.equal(CM.cutoverHeld(plan), true, "fail closed: held until a resume record exists");
  assert.equal(await codeOfAsync(() => build(harness(), null)), "intake_off");
  const plain = await build(harness(), null, runtimeOn());
  assert.ok(!("cutover" in plain.terms) && !("stagedIntake" in plain), "non-cutover plans keep the qualified shape");
  assert.equal(CM.cutoverHeld(plain), false);
});

test("cutoverTerms refuses anything but the exact reviewed shape", () => {
  const r = (c) => codeOf(() => CM.cutoverTerms(c));
  assert.equal(r(CUTOVER), "NO_THROW");
  assert.equal(r({ ...CUTOVER, pauseAfter: "legacyOpen" }), "cutover_shape");
  assert.equal(r({ pauseAfter: "terminate", activationPlanSha256: H("a5") }), "cutover_shape", "rollback plan required");
  assert.equal(r({ ...CUTOVER, extra: 1 }), "cutover_shape");
  assert.equal(r({ ...CUTOVER, rollbackPlanSha256: CUTOVER.activationPlanSha256 }), "cutover_shape");
  assert.notEqual(r({ ...CUTOVER, activationPlanSha256: ZERO }), "NO_THROW");
  assert.notEqual(r(null), "NO_THROW");
});

test("terminate is never sent without the FULL plan signed (replacement and every gas part)", async () => {
  const h = harness();
  const plan = await build(h);
  for (const steps of [["terminate"], ["terminate", "legacyOpen"], ["terminate", "legacyOpen", "gasOpen:nucbox"]]) {
    const code = await codeOfAsync(() => CM.runMigration(h.ctx(runtimeOff), plan.id, bundle(plan, steps)));
    assert.equal(code, steps.length === 1 ? "replacement_unsigned" : "cutover_plan_unsigned", steps.join());
  }
  const wrong = { ...bundle(plan), "gasOpen:metal": { digest: H("ee"), body: {} } };
  assert.equal(await codeOfAsync(() => CM.runMigration(h.ctx(runtimeOff), plan.id, wrong)), "cutover_plan_unsigned");
  assert.deepEqual(h.calls, [], "nothing was sent");
  assert.equal((await h.gasStore.getJournal(plan.id)).steps.terminate.status, "planned");
});

test("run sends ONLY the termination, proves the exact refund and durably pauses before legacyOpen", async () => {
  const { h, plan, r } = await paused();
  assert.deepEqual(h.calls, ["legacy POST /owner"], "one legitimate owner termination; no /open, no /funding/open, no adoption");
  assert.equal(r.paused, true);
  assert.equal(r.stage, "legacyOpen");
  assert.deepEqual(r.steps, { terminate: "proven", legacyOpen: "planned", "gasOpen:nucbox": "planned", "gasOpen:metal": "planned" });
  const j = await h.gasStore.getJournal(plan.id);
  assert.deepEqual(j.cutover, { paused: true, after: "terminate", at: Number(NOW + 10n), terminate: { txHash: TX, block: 32, blockHash: TBLOCK } });
  assert.equal(j.steps.terminate.txHash, TX);
  assert.equal(CM.cutoverHeld(j), true);
});

test("reload / reconcile / re-sign / rearm keep the pause; nothing after terminate is sent", async () => {
  const { h, plan } = await paused();
  const before = canon(jsonable((await h.gasStore.getJournal(plan.id)).cutover));
  const fresh = h.ctx(runtimeOn(), NOW + 2000n);                            // a reloaded page, even with intake already live
  const rec = await CM.reconcileMigration(fresh, plan.id);
  assert.equal(rec.steps.legacyOpen, "planned");
  let j = await h.gasStore.getJournal(plan.id);
  assert.equal(canon(jsonable(j.cutover)), before);
  const again = await CM.runMigration(fresh, plan.id, bundle(j));          // re-signed bundle for the remaining steps
  assert.equal(again.paused, true);
  await CM.rearmStep(fresh, plan.id, "legacyOpen");
  j = await h.gasStore.getJournal(plan.id);
  assert.notEqual(j.steps.legacyOpen.review.digest, plan.steps.legacyOpen.review.digest);
  assert.equal(CM.cutoverHeld(j), true);
  assert.equal((await CM.runMigration(fresh, plan.id, bundle(j))).paused, true);
  assert.equal(canon(jsonable(j.cutover)), before);
  assert.deepEqual(h.calls, ["legacy POST /owner"]);
});

test("resume needs reviewed activation evidence AND a live post-termination runtime; it never sends", async () => {
  const { h, plan } = await paused();
  const ok = activationFor(plan);
  const r = (rt, a) => codeOfAsync(() => CM.resumeCutover(h.ctx(rt), plan.id, a));
  assert.equal(await r(runtimeOn(), undefined), "activation_shape");
  assert.equal(await r(runtimeOn(), { ...ok, rootReviewed: false }), "activation_required");
  assert.equal(await r(runtimeOn(), activationFor(plan, { termsHash: H("01") })), "activation_not_plan");
  assert.equal(await r(runtimeOn(), activationFor(plan, { terminateTxHash: H("02") })), "activation_not_plan");
  assert.equal(await r(runtimeOn(), activationFor(plan, { activationPlanSha256: CUTOVER.rollbackPlanSha256 })), "activation_not_plan");
  assert.equal(await r(runtimeOff, ok), "intake_off", "intake absent is never resumable");
  assert.equal(await r(runtimeOn(100n, { ...intakeOn, openEnabled: false }), ok), "intake_off");
  assert.equal(await r(runtimeOn(100n, { ...intakeOn, relayer: A("78") }), ok), "activation_relayer_mismatch");
  assert.equal(await r(runtimeOn(32n), ok), "runtime_stale", "runtime verified at/before the terminate block");
  h.chain.lost = true;                                                       // reorg: the termination left the chain
  assert.equal(await r(runtimeOn(), ok), "prior_proof_lost");
  assert.equal(CM.cutoverHeld(await h.gasStore.getJournal(plan.id)), true, "still paused, proof kept");
  h.chain.lost = false;
  const j = await CM.resumeCutover(h.ctx(runtimeOn()), plan.id, ok);
  assert.equal(CM.cutoverHeld(j), false);
  assert.equal(j.cutover.paused, true, "the pause record is kept for audit");
  assert.equal(j.cutover.resumed.terminateTxHash, TX);
  assert.equal(await r(runtimeOn(), ok), "cutover_not_paused");
  const next = await CM.runMigration(h.ctx(runtimeOn()), plan.id, undefined);
  assert.deepEqual([next.stage, next.needsSignature], ["legacyOpen", true], "no auto send: the owner signs and clicks");
  assert.deepEqual(h.calls, ["legacy POST /owner"]);
});
