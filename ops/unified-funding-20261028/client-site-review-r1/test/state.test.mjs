// UNREVIEWED, NOT RUN. Offline tests of the /funding page's pure UI state (authored/site/js/funding/state.js).
// They prove the state rules only: no DOM, no wallet, no relay, no chain, no IndexedDB, no production.
// Run (root, after review):  cd client-site-integration-r1 && node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import * as ST from "../authored/site/js/funding/state.js";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const VAULT = `0x${"11".repeat(20)}`, LVAULT = `0x${"22".repeat(20)}`, VAULT2 = `0x${"33".repeat(20)}`;
const RELAY = "https://api.enclave.host";
const SID = `0x${"5a".repeat(32)}`, SID2 = `0x${"5b".repeat(32)}`;
const H = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const APPS = Array.from({ length: 10 }, (_, i) => H(i + 1));
const NUC = APPS.slice(1, 9), METAL = [APPS[0], APPS[9]];
const code = (c) => (e) => e?.code === c;
const ctxA = ST.contextOf({ owner: OWNER, chainId: 8453, vault: VAULT, legacyVault: LVAULT, relay: RELAY });
const ctxB = ST.contextOf({ owner: OTHER, chainId: 8453, vault: VAULT, legacyVault: LVAULT, relay: RELAY });

const proposal = (over = {}) => ({ schema: ST.PROPOSAL_SCHEMA, chainId: 8453, owner: OWNER, oldSid: SID, legacy6: "29000000",
  gas: [{ name: "nucbox", budget6: "800000", opsPerPeriod: "16", appIds: NUC }, { name: "metal", budget6: "200000", opsPerPeriod: "4", appIds: METAL }],
  deploymentIds: APPS.map((_, i) => H(1000 + i)), ...over });
const step = (status, extra = {}, signBefore = "5000") => ({ status, attempt: 1, history: [],
  review: { digest: `0xd${status}${Math.random().toString(16).slice(2)}`, grant: { signBefore } }, ...extra });
const termStep = (status, extra = {}) => ({ status, attempt: 1, history: [], review: { digest: "0xdterm", message: { signBefore: "5000" } }, ...extra });
const plan = (steps, over = {}) => ({ id: `migration:${SID}`, kind: "migration", v: 3, at: 1, termsHash: "0xterms",
  terms: { owner: OWNER, chainId: 8453, order: ["terminate", "legacyOpen", "gasOpen:nucbox", "gasOpen:metal"],
    legacy: { vault: LVAULT, oldSid: SID, oldBalance6: "30000000", grantTemplate: { apps: ["*"] } }, gas: { vault: VAULT } },
  steps: { terminate: termStep("planned"), legacyOpen: step("planned"), "gasOpen:nucbox": step("planned"), "gasOpen:metal": step("planned"), ...steps },
  ...over });

test("formatUsd6 never rounds", () => {
  assert.equal(ST.formatUsd6(29_000_000n), "$29.00");
  assert.equal(ST.formatUsd6("800000"), "$0.80");
  assert.equal(ST.formatUsd6(73_480n), "$0.07348");
  assert.equal(ST.formatUsd6(1n), "$0.000001");
});

test("owner change: held signatures and quotes are bound to the exact context and dropped when it changes", () => {
  const m = ST.createMemory();
  const p = plan();
  m.bind(ctxA);
  m.holdSigned(ctxA, p, ["terminate", "legacyOpen"], { signed: true });
  assert.deepEqual(m.signedFor(ctxA, p), { signed: true });
  assert.equal(m.signedFor(ctxB, p), null, "another owner never sees the bundle");
  m.bind(ctxB);                                                      // wallet switch
  assert.equal(m.signedFor(ctxB, p), null);
  m.bind(ctxA);
  assert.equal(m.signedFor(ctxA, p), null, "switching back does not resurrect it");
  assert.equal(m.hasSigned, false);
  m.holdSigned(ctxA, p, ["terminate"], { x: 1 });
  m.clear();                                                         // remount
  assert.equal(m.signedFor(ctxA, p), null);
  assert.throws(() => m.holdSigned(ctxA, p, ["terminate"], {}), code("stale"), "nothing can be held for an unbound context");
});

test("stale plan: re-armed digest, other terms or another plan never get the held bundle", () => {
  const m = ST.createMemory();
  m.bind(ctxA);
  const p = plan();
  m.holdSigned(ctxA, p, ["terminate", "legacyOpen"], "B");
  assert.equal(m.signedFor(ctxA, { ...p, steps: { ...p.steps, legacyOpen: { ...p.steps.legacyOpen, review: { ...p.steps.legacyOpen.review, digest: "0xrearmed" } } } }), null);
  assert.equal(m.signedFor(ctxA, { ...p, termsHash: "0xother" }), null);
  assert.equal(m.signedFor(ctxA, { ...p, id: `migration:${SID2}` }), null);
  assert.equal(m.signedFor(ctxA, p), "B");
  m.dropSigned();
  assert.equal(m.signedFor(ctxA, p), null);
});

test("quotes: single use, same record/deployment/context, refused within 15 s of the deadline", () => {
  const m = ST.createMemory();
  m.bind(ctxA);
  const rec = { id: "gas-1", sid: SID2 };
  const review = { call: { digest: "0xq", execute: { deadline: 1000n } }, totals: {} };
  m.holdQuote(ctxA, rec, H(7), review);
  assert.equal(m.takeQuote(ctxA, rec, H(8), 900n), null, "another deployment");
  assert.equal(m.takeQuote(ctxA, rec, H(7), 900n), null, "the mismatch consumed it");
  m.holdQuote(ctxA, rec, H(7), review);
  assert.equal(m.takeQuote(ctxA, rec, H(7), 986n), null, "too close to the deadline");
  m.holdQuote(ctxA, rec, H(7), review);
  assert.equal(m.takeQuote(ctxA, { ...rec, id: "gas-2" }, H(7), 900n), null, "another record");
  m.holdQuote(ctxA, rec, H(7), review);
  m.bind(ctxB);
  assert.equal(m.takeQuote(ctxB, rec, H(7), 900n), null, "wallet switch drops it");
  m.bind(ctxA);
  m.holdQuote(ctxA, rec, H(7), review);
  assert.equal(m.takeQuote(ctxA, rec, H(7), 900n), review);
  assert.equal(m.takeQuote(ctxA, rec, H(7), 900n), null, "used once");
});

test("plans and records are scoped to the exact owner, chain, vaults and relay (never 'the last journal')", () => {
  const mine = plan();
  const entries = [
    { ...plan(), at: 5, terms: { ...mine.terms, owner: OTHER } },
    { ...plan(), at: 6, terms: { ...mine.terms, chainId: 84532 } },
    { ...plan(), at: 7, terms: { ...mine.terms, gas: { vault: VAULT2 } } },
    { ...plan(), at: 8, terms: { ...mine.terms, legacy: { ...mine.terms.legacy, oldSid: SID2 } } },
    { id: "gas-owner:x", kind: "gas-owner" },
    { ...mine, v: 2 },
    mine,
  ];
  assert.deepEqual(ST.selectPlans(entries, ctxA, SID), [mine]);
  assert.equal(ST.selectPlans(entries, ctxA).length, 2, "without a session filter: both of THIS owner's plans");
  assert.deepEqual(ST.selectPlans(entries, ctxB, SID), []);
  const recs = [{ id: "a", owner: OWNER, chainId: 8453, vault: VAULT, relay: `${RELAY}/` }, { id: "b", owner: OTHER, chainId: 8453, vault: VAULT, relay: RELAY },
    { id: "c", owner: OWNER, chainId: 8453, vault: VAULT2, relay: RELAY }, { id: "d", owner: OWNER, chainId: 8453, vault: VAULT, relay: "https://other.example" }];
  assert.deepEqual(ST.selectOwnRecords(recs, ctxA).map((r) => r.id), ["a"]);
});

test("proposal: explicit finite 8 + 2 split; wildcard, overlap, other owner, malformed refused", () => {
  const np = ST.validateProposal(proposal(), { owner: OWNER, chainId: 8453 });
  assert.equal(np.total6, 30_000_000n);
  assert.equal(np.gas6, 1_000_000n);
  assert.deepEqual(np.parts.map((x) => [x.name, x.appIds.length, x.budget6]), [["nucbox", 8, 800_000n], ["metal", 2, 200_000n]]);
  assert.deepEqual(ST.splitOf(np).gas[1].appIds, [...METAL].sort());
  assert.equal(ST.validateProposal(null, { owner: OWNER, chainId: 8453 }), null);
  const v = (over) => () => ST.validateProposal(proposal(over), { owner: OWNER, chainId: 8453 });
  assert.throws(v({ gas: [{ name: "all", budget6: "1000000", opsPerPeriod: "20", appIds: ["*"] }] }), code("scope_wildcard"));
  assert.throws(v({ gas: [{ name: "a", budget6: "500000", opsPerPeriod: "10", appIds: [APPS[0]] }, { name: "b", budget6: "500000", opsPerPeriod: "10", appIds: [APPS[0]] }] }), code("scope_overlap"));
  assert.throws(v({ gas: [{ name: "big", budget6: "1000000", opsPerPeriod: "20", appIds: APPS.slice(0, 9) }] }), code("scope"));
  assert.throws(v({ gas: [{ name: "up", budget6: "1000000", opsPerPeriod: "20", appIds: [`0x${"AB".repeat(32)}`] }] }), code("scope"));
  assert.throws(v({ owner: OTHER }), code("owner"));
  assert.throws(v({ chainId: 1 }), code("chain"));
  assert.throws(v({ legacy6: "29.5" }), code("amount"));
  assert.throws(v({ deploymentIds: [H(1), H(1)] }), code("shape"));
  assert.throws(v({ extra: 1 }), code("shape"));
  assert.throws(v({ schema: "x" }), code("schema"));
  assert.deepEqual(ST.scopeCoverage(np, APPS), { uncovered: [], extra: [], ok: true });
  assert.equal(ST.scopeCoverage(np, [...APPS, H(99)]).ok, false);
  assert.equal(ST.scopeCoverage(np, APPS.slice(1)).ok, false);
});

test("money: original -> legacy + gas parts must add up exactly and stay <= $30", () => {
  const np = ST.validateProposal(proposal(), { owner: OWNER, chainId: 8453 });
  const m = ST.moneyRows({ original6: "30000000", legacy6: np.legacy6, parts: np.parts });
  assert.equal(m.ok, true);
  assert.deepEqual(m.text, ["Replacement API session (same key): $29.00", 'Gas grant "nucbox" (8 apps): $0.80', 'Gas grant "metal" (2 apps): $0.20']);
  assert.equal(ST.moneyRows({ original6: "31000000", legacy6: np.legacy6, parts: np.parts }).ok, false, "does not add up");
  assert.equal(ST.moneyRows({ original6: null, legacy6: np.legacy6, parts: np.parts }).ok, false, "unknown original");
  assert.equal(ST.moneyRows({ original6: "40000000", legacy6: 39_000_000n, parts: np.parts }).ok, false, "over $30");
});

test("legacy scope label: [] is 'no apps', only ['*'] is the wildcard, nothing is widened", () => {
  assert.equal(ST.legacyScopeLabel([]).kind, "none");
  assert.equal(ST.legacyScopeLabel(["*"]).kind, "wildcard");
  assert.equal(ST.legacyScopeLabel(["*", APPS[0]]).kind, "invalid");
  assert.equal(ST.legacyScopeLabel(["NucBox"]).kind, "invalid");
  assert.equal(ST.legacyScopeLabel([APPS[0], APPS[1]]).kind, "finite");
  assert.equal(ST.legacyScopeLabel(undefined).kind, "invalid");
});

test("approval: matched field by field; nothing approved by default, by key generation or partially", () => {
  const p = plan();
  const ok = { schema: ST.APPROVAL_SCHEMA, rootReviewed: true, termsHash: "0xterms", owner: OWNER, chainId: 8453, oldSid: SID };
  assert.deepEqual(ST.approvalStatus(null, p, ctxA), { ok: false, reason: "waiting_for_review", termsHash: "0xterms" });
  assert.equal(ST.approvalStatus(ok, null, ctxA).reason, "no_plan");
  assert.equal(ST.approvalStatus({ ...ok, rootReviewed: "true" }, p, ctxA).reason, "approval_not_reviewed");
  assert.equal(ST.approvalStatus({ ...ok, termsHash: "0xother" }, p, ctxA).reason, "approval_other_terms");
  assert.equal(ST.approvalStatus({ ...ok, owner: OTHER }, p, ctxA).reason, "approval_other_owner");
  assert.equal(ST.approvalStatus(ok, p, ctxB).reason, "approval_other_owner", "a wallet switch invalidates it");
  assert.equal(ST.approvalStatus({ ...ok, chainId: 1 }, p, ctxA).reason, "approval_other_chain");
  assert.equal(ST.approvalStatus({ ...ok, oldSid: SID2 }, p, ctxA).reason, "approval_other_session");
  assert.equal(ST.approvalStatus({ ...ok, schema: "x" }, p, ctxA).reason, "approval_schema");
  assert.equal(ST.approvalStatus({ ...ok, bypass: true }, p, ctxA).reason, "approval_malformed");
  const good = ST.approvalStatus(ok, p, ctxA);
  assert.equal(good.ok, true);
  assert.deepEqual({ ...good.approval }, { rootReviewed: true, termsHash: "0xterms" });
});

test("steps: friendly states and only explicit actions; unknown outcomes are never 'send again'", () => {
  assert.deepEqual(ST.stepView(step("planned"), 100n).actions, ["sign"]);
  assert.deepEqual(ST.stepView(step("planned", {}, "50"), 100n).actions, ["rearm"], "planned but its window passed");
  assert.deepEqual(ST.stepView(step("admitted", { lastError: "relay_unreachable" }), 100n).actions, ["reconcile"]);
  assert.match(ST.stepView(step("admitted", { lastError: "relay_unreachable" }), 100n).label, /never resent automatically/);
  assert.deepEqual(ST.stepView(step("submitted", { txHash: H(5) }), 100n).actions, ["reconcile"]);
  assert.deepEqual(ST.stepView(step("proven"), 100n).actions, []);
  assert.deepEqual(ST.stepView(step("proven", { recheck: { result: "lost" } }), 100n).actions, ["reconcile"]);
  assert.deepEqual(ST.stepView(step("void"), 100n).actions, ["rearm"]);
  for (const s of ["admitted", "submitted", "proven", "void"]) assert.equal(ST.stepView(step(s), 100n).actions.includes("sign"), false, s);
});

test("reload state: the journal alone decides what is offered next (signatures never survive a reload)", () => {
  assert.deepEqual(ST.nextSignable(plan(), 100n), ["terminate", "legacyOpen", "gasOpen:nucbox", "gasOpen:metal"]);
  assert.equal(ST.planPhase(plan(), 100n).phase, "sign");
  assert.equal(ST.planPhase(plan(), 100n, true).phase, "submit");
  const interrupted = plan({ terminate: termStep("proven"), legacyOpen: step("proven"), "gasOpen:nucbox": step("admitted", { lastError: "relay_unreachable" }) });
  assert.deepEqual(ST.planPhase(interrupted, 100n), { phase: "reconcile", step: "gasOpen:nucbox" });
  assert.deepEqual(ST.nextSignable(interrupted, 100n), [], "nothing after an unresolved step is signable");
  const resumed = plan({ terminate: termStep("proven"), legacyOpen: step("proven"), "gasOpen:nucbox": step("proven") });
  assert.deepEqual(ST.nextSignable(resumed, 100n), ["gasOpen:metal"]);
  assert.equal(ST.planPhase(resumed, 100n).phase, "sign");
  const orphan = plan({ terminate: termStep("proven", { recheck: { result: "lost" } }), legacyOpen: step("proven"), "gasOpen:nucbox": step("proven"), "gasOpen:metal": step("proven") });
  assert.equal(ST.planPhase(orphan, 100n).phase, "reconcile", "a lost proof is not 'done'");
  const done = plan({ terminate: termStep("proven"), legacyOpen: step("proven"), "gasOpen:nucbox": step("proven"), "gasOpen:metal": step("proven") });
  assert.equal(ST.planPhase(done, 100n).phase, "done");
  assert.deepEqual(ST.nextSignable(plan({ legacyOpen: step("void") }), 100n), [], "the original is never signed without its replacement");
});

test("active legacy pointer: moves only away from the replaced session or from none", () => {
  assert.equal(ST.activePointerDecision("", SID2, SID), "set");
  assert.equal(ST.activePointerDecision(null, SID2, SID), "set");
  assert.equal(ST.activePointerDecision(SID.toUpperCase().replace("0X", "0x"), SID2, SID), "set");
  assert.equal(ST.activePointerDecision(SID2, SID2, SID), "noop");
  assert.equal(ST.activePointerDecision(H(77), SID2, SID), "keep", "another choice is never clobbered");
});

test("owner controls: available with intake off / no catalog; only need pins, relay base, own store", () => {
  assert.deepEqual(ST.controlsAvailability({ pinsOk: true, relayOk: true, storeOk: true, ownRecords: 2 }),
    { terminate: true, withdraw: true, end: true, reason: null });
  const noRec = ST.controlsAvailability({ pinsOk: true, relayOk: true, storeOk: true, ownRecords: 0 });
  assert.equal(noRec.withdraw, true);
  assert.equal(noRec.terminate || noRec.end, false);
  const noRuntime = ST.controlsAvailability({ pinsOk: false, relayOk: true, storeOk: true, ownRecords: 1 });
  assert.equal(noRuntime.terminate || noRuntime.withdraw, false, "FUNDING_RUNTIME null: no successor to control");
  assert.equal(noRuntime.end, true, "a stored gas record can still sign itself out");
  assert.equal(noRuntime.reason, "successor not configured");
  assert.equal(ST.controlsAvailability.length, 1, "takes no intake / catalog / scope input at all");
  const cc = ST.controlsContextOf({ owner: OWNER, chainId: 8453, vault: VAULT, relay: RELAY });
  assert.equal(cc.key.includes(LVAULT.toLowerCase()), false, "controls do not depend on the legacy vault");
});

test("quote view: fee, maximum, total, balance and time left are all shown before signing", () => {
  const review = { totals: { maxUsdcIn6: 48_480n, fee6: 25_000n, totalMaximum6: 73_480n, balance6: 200_000n }, call: { execute: { deadline: 1300n } } };
  const q = ST.quoteView(review, 1000n);
  assert.equal(q.secondsLeft, 300);
  assert.equal(q.expired, false);
  assert.equal(q.balanceAfterMax6, 126_520n);
  assert.deepEqual(q.text, ["gas at most $0.04848", "relay fee $0.025", "total at most $0.07348", "grant balance $0.20 -> at least $0.12652"]);
  assert.equal(ST.quoteView(review, 1290n).expired, true);
});
