// UNREVIEWED, NOT RUN. Bounded OFFLINE tests of the explicit gas-grant PARTITION (candidate terms only, not approved):
// legacy 29 + gas 0.9 (eight NucBox apps) + gas 0.1 (one image app) = 30 over the nine HISTORICAL app ids. Scripted
// wallet/relays/chain from test/fixtures.mjs; nothing here qualifies a wallet, IndexedDB, the browser, the deployed
// contracts or current prices/quotes.
// Run (root, after review): node --test test/partition.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { lower } from "../lib/util.mjs";
import { selectGasRecord } from "../lib/funding-client.mjs";
import { buildMigrationPlan, loadLegacyEvidence, parseSplit, reconcileMigration, runMigration } from "../lib/migration.mjs";
import {
  HIST, IMAGE_APP, LFACTORY, NOW, NUC_APPS, OWNER, S, SPLIT_CANDIDATE, code, planned, runtime, scope9, scriptedProvider, setup,
  sign, statuses,
} from "./fixtures.mjs";

const FULL = ["terminate", "legacyOpen", "gasOpen:nucbox", "gasOpen:image"];
const part = (name, budget6, opsPerPeriod, appIds) => ({ name, budget6, opsPerPeriod, appIds });
const split = (legacy6, ...gas) => ({ legacy6, gas });
const NUC = (b = 900_000n, ops = 18n, apps = NUC_APPS) => part("nucbox", b, ops, apps);
const IMG = (b = 100_000n, ops = 2n, apps = [IMAGE_APP]) => part("image", b, ops, apps);
const OTHER_APP = `0x${"ee".repeat(32)}`;

test("split: candidate 29 + 0.9 + 0.1 = 30 is accepted; totals, budgets and ops are never enlarged", () => {
  const ok = parseSplit(SPLIT_CANDIDATE, scope9, 30_000_000n);
  assert.deepEqual(ok.parts.map((p) => [p.step, p.budget6, p.appIds.length]), [["gasOpen:nucbox", 900_000n, 8], ["gasOpen:image", 100_000n, 1]]);
  assert.throws(() => parseSplit(split(29_000_000n, NUC(), IMG(200_000n)), scope9, 30_000_000n), code("split_total"));
  assert.throws(() => parseSplit(split(28_900_000n, NUC(), IMG(200_000n)), scope9, 30_000_000n), code("gas_budget_not_candidate"));
  assert.throws(() => parseSplit(split(29_000_000n, NUC(900_000n, 19n), IMG()), scope9, 30_000_000n), code("gas_part_ops"));
  assert.throws(() => parseSplit(split(29_000_000n, NUC(1_000_000n), IMG(0n)), scope9, 30_000_000n), code("split_zero"));
  assert.throws(() => parseSplit(SPLIT_CANDIDATE, scope9, 31_000_000n), code("split_total"));
  assert.throws(() => parseSplit({ legacy6: 29_000_000n, gas6: 1_000_000n }, scope9, 30_000_000n), code("gas_partition_required"));
  assert.throws(() => parseSplit({ ...SPLIT_CANDIDATE, gas6: 1_000_000n }, scope9, 30_000_000n), code("split_shape"));
});

test("split: overlap, uncovered, excess, >8 apps per part and wildcard are refused", () => {
  const nuc7 = NUC_APPS.slice(0, 7);
  assert.throws(() => parseSplit(split(29_000_000n, NUC(), IMG(100_000n, 2n, [IMAGE_APP, NUC_APPS[0]])), scope9, 30_000_000n), code("gas_scope_overlap"));
  assert.throws(() => parseSplit(split(29_000_000n, NUC(900_000n, 18n, nuc7), IMG()), scope9, 30_000_000n), code("gas_scope_uncovered"));
  assert.throws(() => parseSplit(split(29_000_000n, NUC(), IMG(100_000n, 2n, [IMAGE_APP, OTHER_APP])), scope9, 30_000_000n), code("gas_scope_excess"));
  assert.throws(() => parseSplit(split(29_000_000n, NUC(1_000_000n, 20n, [...NUC_APPS, IMAGE_APP])), scope9, 30_000_000n), code("gas_part_apps"));
  assert.throws(() => parseSplit(split(29_000_000n, NUC(), IMG(100_000n, 2n, ["*"])), scope9, 30_000_000n));
  assert.throws(() => parseSplit(split(29_000_000n, NUC(), part("nucbox", 100_000n, 2n, [IMAGE_APP])), scope9, 30_000_000n), code("split_shape"));
});

test("plan: one fresh key per part, exact finite scopes, legacy first; 7 owner prompts (terminate + 3 grant/deposit pairs)", async () => {
  const t = await setup();
  const plan = await planned(t, { split: SPLIT_CANDIDATE, scope: scope9 });
  assert.deepEqual(plan.terms.order, FULL);
  const keys = [plan.terms.legacy.keyHash, plan.steps["gasOpen:nucbox"].review.keyHash, plan.steps["gasOpen:image"].review.keyHash];
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(plan.steps["gasOpen:nucbox"].review.grant.apps, NUC_APPS);
  assert.deepEqual(plan.steps["gasOpen:image"].review.grant.apps, [IMAGE_APP]);
  assert.equal(plan.steps["gasOpen:nucbox"].review.grant.budget, "900000");
  assert.equal(plan.steps["gasOpen:image"].review.grant.budget, "100000");
  assert.equal(plan.steps["gasOpen:image"].review.grant.spendPerPeriod, "100000");
  assert.equal(plan.terms.split.gas6, "1000000");
  assert.equal(plan.steps.legacyOpen.review.grant.sessionKey, lower(t.oldRec.keyHash));
  const provider = scriptedProvider();
  await sign(t, FULL, NOW, provider);
  assert.deepEqual(provider.prompts, ["Terminate", "SessionGrant", "ReceiveWithAuthorization",
    "SessionGrant", "ReceiveWithAuthorization", "SessionGrant", "ReceiveWithAuthorization"]);
  await assert.rejects(sign(t, ["terminate", "legacyOpen", "gasOpen:image"]), code("sign_steps"));     // no gaps
});

test("run: legacy first, then each part in reviewed order; budgets sum to the refund exactly; selection is by app scope", async () => {
  const t = await setup();
  await planned(t, { split: SPLIT_CANDIDATE, scope: scope9 });
  // only the first three steps signed: the image part is not opened, and its apps must NOT fall back to the NucBox grant
  const r1 = await runMigration(t.ctx(), t.planId, await sign(t, FULL.slice(0, 3)));
  assert.equal(r1.needsSignature, true);
  assert.equal(r1.stage, "gasOpen:image");
  const recs = await t.gasStore.listKeys();
  const nucDep = HIST.find((r) => r[2] === "nucbox")[0];
  const imgDep = HIST.find((r) => r[2] === "metal0")[0];
  assert.deepEqual(selectGasRecord(recs, scope9, nucDep).grant.apps, NUC_APPS);
  assert.throws(() => selectGasRecord(recs, scope9, imgDep), code("matching_grant_not_open"));
  assert.equal((await runMigration(t.ctx(), t.planId, await sign(t, ["gasOpen:image"]))).done, true);
  assert.deepEqual(t.calls, ["POST /owner", "POST /open", "POST /funding/open", "POST /funding/open"]);
  assert.deepEqual(t.gasOpens, ["gasOpen:nucbox", "gasOpen:image"]);
  assert.equal(t.W.wallet, 0n);                                    // +30 -29 -0.9 -0.1
  assert.equal(t.W.auth.size, 3);
  const after = await t.gasStore.listKeys();
  assert.deepEqual(selectGasRecord(after, scope9, imgDep).grant.apps, [IMAGE_APP]);
  assert.deepEqual(selectGasRecord(after, scope9, nucDep).grant.apps, NUC_APPS);
  assert.throws(() => selectGasRecord(after, scope9, `0x${"42".repeat(32)}`), code("deployment_out_of_scope"));
});

test("multi-part resume: a pending first part is proven by reconcile after reload, then only the second part is signed and sent", async () => {
  const t = await setup();
  await planned(t, { split: SPLIT_CANDIDATE, scope: scope9 });
  t.mode["/funding/open"] = "pending";
  const r1 = await runMigration(t.ctx(), t.planId, await sign(t, FULL));
  assert.equal(r1.pending, true);
  assert.equal(r1.stage, "gasOpen:nucbox");
  const ctx2 = t.ctx();                                            // reload: signatures gone
  assert.equal((await runMigration(ctx2, t.planId, undefined)).needsReconcile, true);
  assert.equal((await reconcileMigration(ctx2, t.planId)).report.at(-1).next, "wait_canonical");
  t.W.hidden.clear();
  t.mode["/funding/open"] = "ok";
  const rec = await reconcileMigration(ctx2, t.planId);
  assert.deepEqual(rec.steps, { terminate: "proven", legacyOpen: "proven", "gasOpen:nucbox": "proven", "gasOpen:image": "planned" });
  await assert.rejects(sign(t, ["gasOpen:nucbox", "gasOpen:image"]), code("sign_steps"));
  assert.equal((await runMigration(ctx2, t.planId, await sign(t, ["gasOpen:image"]))).done, true);
  assert.deepEqual(t.gasOpens, ["gasOpen:nucbox", "gasOpen:image"]);   // nucbox never resent
  assert.equal(t.W.wallet, 0n);
});

test("multi-part lost reply: discovered from the part's own event; the next part waits for that proof; no duplicate budget", async () => {
  const t = await setup();
  await planned(t, { split: SPLIT_CANDIDATE, scope: scope9 });
  t.mode["/funding/open"] = "drop";
  const signed = await sign(t, FULL);
  await assert.rejects(runMigration(t.ctx(), t.planId, signed));
  assert.equal((await statuses(t))["gasOpen:nucbox"], "admitted");
  assert.equal((await runMigration(t.ctx(), t.planId, signed)).needsReconcile, true);   // image not sent before nucbox is proven
  assert.deepEqual(t.gasOpens, ["gasOpen:nucbox"]);
  t.mode["/funding/open"] = "ok";
  assert.equal((await reconcileMigration(t.ctx(), t.planId)).steps["gasOpen:nucbox"], "proven");
  assert.equal((await runMigration(t.ctx(), t.planId, signed)).done, true);
  assert.deepEqual(t.gasOpens, ["gasOpen:nucbox", "gasOpen:image"]);
  assert.equal(t.W.wallet, 0n);
  assert.equal(t.W.auth.size, 3);
});

test("partition plan on a 9-app scope refuses the single-grant shape and an evidence mismatch before any key is made", async () => {
  const t = await setup();
  const evidence = await loadLegacyEvidence({ S, legacyStore: t.legacyStore, sid: t.oldSid, owner: OWNER, chain: t.W.chain,
    legacyConfig: { chainId: 8453, factory: LFACTORY }, runtime, now: NOW });
  const b = (sp) => buildMigrationPlan({ S, evidence, runtime, scope: scope9, gasStore: t.gasStore, relayBase: "https://relay.test", now: NOW, split: sp });
  await assert.rejects(b({ legacy6: 29_000_000n, gas6: 1_000_000n }), code("gas_partition_required"));
  await assert.rejects(b(split(29_000_000n, NUC(1_000_000n), IMG())), code("split_total"));
  assert.equal((await t.gasStore.listKeys()).length, 0);
});
