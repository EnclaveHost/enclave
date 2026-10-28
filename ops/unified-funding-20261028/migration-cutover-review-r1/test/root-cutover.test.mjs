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


test("root: wrong refund never marks the termination proven or admits a replacement", async () => {
  const h = harness(), plan = await build(h);
  h.chain.receipt = async () => ({ ...terminateReceipt, logs: [terminateReceipt.logs[0], {
    ...terminateReceipt.logs[1], data: encodeAbiParameters([{type:'uint256'}], [29_000_000n])
  }] });
  const code = await codeOfAsync(() => CM.runMigration(h.ctx(runtimeOff), plan.id, bundle(plan)));
  assert.notEqual(code, 'NO_THROW');
  const j = await h.gasStore.getJournal(plan.id);
  assert.equal(j.steps.terminate.status, 'submitted');
  assert.equal(j.cutover, undefined);
  assert.deepEqual(h.calls, ['legacy POST /owner']);
});
test("root: nonfinal termination cannot release a cutover pause", async () => {
  const h = harness(), plan = await build(h);
  h.chain.finality = async () => ({ final: false });
  const r = await CM.runMigration(h.ctx(runtimeOff), plan.id, bundle(plan));
  assert.equal(r.paused, true);
  assert.equal(await codeOfAsync(() => CM.resumeCutover(h.ctx(runtimeOn()), plan.id, activationFor(plan))), 'terminate_not_final');
  assert.equal(CM.cutoverHeld(await h.gasStore.getJournal(plan.id)), true);
  assert.deepEqual(h.calls, ['legacy POST /owner']);
});
test("root: a missing durable marker stays blocked even with apparently valid activation", async () => {
  const {h,plan} = await paused();
  await h.gasStore.casJournal(plan.id, cur => { delete cur.cutover; return cur; });
  assert.equal(await codeOfAsync(() => CM.resumeCutover(h.ctx(runtimeOn()), plan.id, activationFor(plan))), 'cutover_marker_missing');
  assert.equal((await CM.runMigration(h.ctx(runtimeOn()), plan.id, bundle(plan))).paused, true);
  assert.deepEqual(h.calls, ['legacy POST /owner']);
});
test("root: loss of termination proof after resume still blocks replacement submission", async () => {
  const {h,plan} = await paused();
  await CM.resumeCutover(h.ctx(runtimeOn()), plan.id, activationFor(plan));
  h.chain.lost = true;
  assert.equal(await codeOfAsync(() => CM.runMigration(h.ctx(runtimeOn()), plan.id, bundle(plan))), 'prior_proof_lost');
  const j = await h.gasStore.getJournal(plan.id);
  assert.equal(j.steps.legacyOpen.status, 'planned');
  assert.equal(j.steps.terminate.recheck.result, 'lost');
  assert.deepEqual(h.calls, ['legacy POST /owner']);
});
