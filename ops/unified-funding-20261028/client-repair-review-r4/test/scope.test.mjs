// UNREVIEWED, NOT RUN. client-repair-r4 legacy APP-SCOPE regressions (offline, scripted chain from test/fixtures.mjs).
// The semantics under test are the original vault's (source/contracts/SessionVault.sol, _open loop 624-632):
//   []    -> no-app scope (anyApp = false, no ids);   ["*"] -> wildcard (anyApp = true, no ids);
//   66-char hex -> that id literally;   anything else (names) -> appIdOf(book, name), which this client never assumes.
// The client must reproduce a scope EXACTLY; it may never widen [] to "*" or narrow "*" to [].
// Run (root, after review): node --test test/scope.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { appScopeOf, compareGrantToChain, loadLegacyEvidence, reconcileMigration, runMigration } from "../lib/migration.mjs";
import { LFACTORY, NOW, OWNER, S, code, planned, runtime, setup, sign, stateOf } from "./fixtures.mjs";

const ID1 = `0x${"a1".repeat(32)}`, ID2 = `0x${"b2".repeat(32)}`;
const mismatch = (field) => (e) => e?.code === "legacy_fields_mismatch" && e.detail?.diff?.includes(field);
const plain = (s) => ({ anyApp: s.anyApp, ids: [...s.ids] });

test("appScopeOf: [] is the no-app scope, exactly ['*'] is the wildcard, distinct canonical ids are literal", () => {
  assert.deepEqual(plain(appScopeOf([])), { anyApp: false, ids: [] });
  assert.deepEqual(plain(appScopeOf(["*"])), { anyApp: true, ids: [] });
  assert.deepEqual(plain(appScopeOf([ID2, ID1])), { anyApp: false, ids: [ID2, ID1] });      // grant order is kept
});

test("appScopeOf: duplicates, mixed wildcard, names, non-canonical hex and non-strings fail closed", () => {
  assert.throws(() => appScopeOf(["*", "*"]), code("legacy_apps_malformed"));
  assert.throws(() => appScopeOf(["*", ID1]), code("legacy_apps_malformed"));
  assert.throws(() => appScopeOf([ID1, "*"]), code("legacy_apps_malformed"));
  assert.throws(() => appScopeOf([ID1, ID1]), code("legacy_apps_malformed"));
  assert.throws(() => appScopeOf(["NucBox"]), code("legacy_apps_unverifiable"));             // resolved on chain via appIdOf: never assumed
  assert.throws(() => appScopeOf([`0x${"A1".repeat(32)}`]), code("legacy_apps_unverifiable")); // the vault accepts it, we do not prove it
  assert.throws(() => appScopeOf([ID1.slice(0, 64)]), code("legacy_apps_unverifiable"));
  assert.throws(() => appScopeOf([""]), code("legacy_apps_unverifiable"));
  assert.throws(() => appScopeOf([1]), code("legacy_apps_malformed"));
  assert.throws(() => appScopeOf("*"), code("legacy_apps_malformed"));
});

test("compareGrantToChain: [] never adopts a wildcard session; ['*'] never adopts a no-app session; ids are exact", async () => {
  const { oldGrant } = await setup();
  const g = (apps) => ({ ...oldGrant, apps });
  // [] <-> no-app chain: equal
  compareGrantToChain(S, g([]), stateOf(g([])), "t");
  // [] vs a wildcard chain session: refused (the empty scope is never widened)
  assert.throws(() => compareGrantToChain(S, g([]), stateOf(g([]), { anyApp: true }), "t"), mismatch("anyApp"));
  // ["*"] <-> wildcard chain: equal; vs a no-app chain session: refused (the wildcard is never narrowed)
  compareGrantToChain(S, g(["*"]), stateOf(g(["*"])), "t");
  assert.throws(() => compareGrantToChain(S, g(["*"]), stateOf(g(["*"]), { anyApp: false }), "t"), mismatch("anyApp"));
  assert.throws(() => compareGrantToChain(S, g(["*"]), stateOf(g(["*"]), { apps: [ID1] }), "t"), mismatch("apps"));
  // finite ids: exact list, exact order, no wildcard
  compareGrantToChain(S, g([ID1, ID2]), stateOf(g([ID1, ID2])), "t");
  assert.throws(() => compareGrantToChain(S, g([ID1, ID2]), stateOf(g([ID1, ID2]), { apps: [ID2, ID1] }), "t"), mismatch("apps"));
  assert.throws(() => compareGrantToChain(S, g([ID1, ID2]), stateOf(g([ID1, ID2]), { apps: [ID1] }), "t"), mismatch("apps"));
  assert.throws(() => compareGrantToChain(S, g([ID1]), stateOf(g([ID1]), { anyApp: true }), "t"), mismatch("anyApp"));
  assert.throws(() => compareGrantToChain(S, g([]), stateOf(g([]), { apps: [ID1] }), "t"), mismatch("apps"));
  // malformed scopes refuse before any comparison, whatever the chain says
  assert.throws(() => compareGrantToChain(S, g(["*", "*"]), stateOf(g(["*"])), "t"), code("legacy_apps_malformed"));
  assert.throws(() => compareGrantToChain(S, g(["NucBox"]), stateOf(g([])), "t"), code("legacy_apps_unverifiable"));
});

test("the other mirrored gates are unchanged under a correct scope (key, measurement, actions, envs, period, fees, maxRate)", async () => {
  const { oldGrant } = await setup();
  const st = stateOf(oldGrant);
  for (const [over, field] of [[{ keyHash: `0x${"cc".repeat(32)}` }, "keyHash"], [{ measurement: `0x${"dd".repeat(32)}` }, "measurement"],
    [{ actions: 1n }, "actions"], [{ envs: 1 }, "envs"], [{ expiresAt: 1n }, "expiresAt"], [{ perPeriod6: 1n }, "perPeriod6"],
    [{ maxFee6: 1n }, "maxFee6"], [{ maxAppFeeHour6: 1n }, "maxAppFeeHour6"], [{ maxRateHour6: 1n }, "maxRateHour6"],
    [{ period: 1 }, "period"], [{ opsPerPeriod: 1 }, "opsPerPeriod"]]) {
    assert.throws(() => compareGrantToChain(S, oldGrant, { ...st, ...over }, "t"), mismatch(field), field);
  }
});

test("evidence: an exact-empty original loads (the native failure) and refuses a chain that turned it into a wildcard", async () => {
  const t = await setup();                                          // apps = [] like the live record
  const ev = () => loadLegacyEvidence({ S, legacyStore: t.legacyStore, sid: t.oldSid, owner: OWNER, chain: t.W.chain,
    legacyConfig: { chainId: 8453, factory: LFACTORY }, runtime, now: NOW });
  assert.equal((await ev()).state.anyApp, false);
  t.W.sessions.set(t.oldSid, stateOf(t.oldGrant, { anyApp: true }));
  await assert.rejects(ev(), mismatch("anyApp"));
  const w = await setup({ apps: ["*"] });
  const evW = () => loadLegacyEvidence({ S, legacyStore: w.legacyStore, sid: w.oldSid, owner: OWNER, chain: w.W.chain,
    legacyConfig: { chainId: 8453, factory: LFACTORY }, runtime, now: NOW });
  assert.equal((await evW()).state.anyApp, true);
  w.W.sessions.set(w.oldSid, stateOf(w.oldGrant, { anyApp: false }));
  await assert.rejects(evW(), mismatch("anyApp"));
  const n = await setup({ apps: ["NucBox"] });
  await assert.rejects(loadLegacyEvidence({ S, legacyStore: n.legacyStore, sid: n.oldSid, owner: OWNER, chain: n.W.chain,
    legacyConfig: { chainId: 8453, factory: LFACTORY }, runtime, now: NOW }), code("legacy_apps_unverifiable"));
});

test("a wildcard original migrates with its wildcard; the replacement keeps exactly the same scope", async () => {
  const t = await setup({ apps: ["*"] });
  const plan = await planned(t);
  assert.deepEqual(plan.steps.legacyOpen.review.grant.apps, ["*"]);
  assert.equal((await runMigration(t.ctx(), t.planId, await sign(t, ["terminate", "legacyOpen", "gasOpen"]))).done, true);
  const sid = (await t.gasStore.getJournal(t.planId)).steps.legacyOpen.review.sid;
  assert.equal((await t.W.chain.sessionOf(null, sid)).anyApp, true);
  assert.deepEqual((await t.legacyStore.load(sid)).grant.apps, ["*"]);
});

test("a replacement whose chain scope differs (empty turned wildcard) is never proven or adopted", async () => {
  const t = await setup();
  await planned(t);
  t.mode["/open"] = "pending";
  const r = await runMigration(t.ctx(), t.planId, await sign(t, ["terminate", "legacyOpen"]));
  assert.equal(r.pending, true);
  const sid = (await t.gasStore.getJournal(t.planId)).steps.legacyOpen.review.sid;
  t.W.sessions.set(sid, { ...t.W.sessions.get(sid), anyApp: true });
  t.W.hidden.clear();
  await assert.rejects(reconcileMigration(t.ctx(), t.planId), mismatch("anyApp"));
  assert.equal((await t.gasStore.getJournal(t.planId)).steps.legacyOpen.status, "submitted");
  assert.deepEqual(t.active, []);
  assert.equal(await t.legacyStore.load(sid), null);
});
