// UNREVIEWED, NOT RUN. Offline tests of the /funding page's pure UI state (authored/site/js/funding/state.js).
// They prove the state rules only: no DOM, no wallet, no relay, no chain, no IndexedDB, no production.
import test from "node:test";
import assert from "node:assert/strict";
import * as ST from "../authored/site/js/funding/state.js";
import { OWNER, OTHER, VAULT, VAULT2, RELAY, SID, SID2, H, APPS, NUC, METAL, DEPS, code, ctxOf, ctxA, ctxB, proposal, np, step, termStep, plan, recordsFor } from "./fixtures.mjs";

test("formatUsd6 never rounds", () => {
  assert.equal(ST.formatUsd6(29_000_000n), "$29.00");
  assert.equal(ST.formatUsd6("800000"), "$0.80");
  assert.equal(ST.formatUsd6(73_480n), "$0.07348");
  assert.equal(ST.formatUsd6(1n), "$0.000001");
});

test("plans: owner, chain, vaults, session AND relay evidence from the referenced records; other owners' plans only for them", () => {
  const mine = plan();
  const recs = recordsFor(mine);
  assert.deepEqual(ST.selectPlans([mine], ctxA, SID, recs), [mine]);
  assert.deepEqual(ST.selectPlans([mine], ctxA, SID), [], "no records = no relay evidence = refused");
  assert.deepEqual(ST.selectPlans([mine], ctxA, SID, []), []);
  assert.equal(ST.planScope(mine, ctxA, [], SID).reason, "relay_evidence_missing");
  assert.deepEqual(ST.selectPlans([mine], ctxOf(OWNER, "https://two.invalid"), SID, recs), [], "same plan at another relay");
  assert.equal(ST.planScope(mine, ctxOf(OWNER, "https://two.invalid"), recs, SID).reason, "other_relay_or_owner");
  assert.deepEqual(ST.selectPlans([mine], ctxA, SID, recordsFor(mine, { relay: `${RELAY}/` })), [mine], "trailing slash is the same relay");
  const swapped = recs.map((r, i) => (i === 0 ? { ...r, keyHash: H(999) } : r));
  assert.equal(ST.planScope(mine, ctxA, swapped, SID).reason, "record_key_mismatch");
  assert.equal(ST.planScope({ ...mine, terms: { ...mine.terms, order: ["terminate", "legacyOpen"] } }, ctxA, recs, SID).reason, "relay_evidence_missing");
  // the r1 test expected an OTHER-owned plan to be hidden from OTHER; it belongs to OTHER and is offered only to OTHER:
  const theirs = plan({}, { at: 5 }, OTHER);
  const theirRecs = recordsFor(theirs);
  const all = [theirs, mine, { ...plan(), at: 6, terms: { ...mine.terms, chainId: 84532 } }, { ...plan(), at: 7, terms: { ...mine.terms, gas: { ...mine.terms.gas, vault: VAULT2 } } },
    { ...plan(), at: 8, terms: { ...mine.terms, legacy: { ...mine.terms.legacy, oldSid: SID2 } } }, { id: "gas-owner:x", kind: "gas-owner" }, { ...mine, v: 2 }];
  assert.deepEqual(ST.selectPlans(all, ctxA, SID, [...recs, ...theirRecs]), [mine]);
  assert.deepEqual(ST.selectPlans(all, ctxB, SID, [...recs, ...theirRecs]), [theirs]);
  assert.deepEqual(ST.selectPlans(all, ctxB, SID, recs), [], "OTHER's plan needs OTHER's own records");
  const rs = [{ id: "a", owner: OWNER, chainId: 8453, vault: VAULT, relay: `${RELAY}/` }, { id: "b", owner: OTHER, chainId: 8453, vault: VAULT, relay: RELAY },
    { id: "c", owner: OWNER, chainId: 8453, vault: VAULT2, relay: RELAY }, { id: "d", owner: OWNER, chainId: 8453, vault: VAULT, relay: "https://other.example" }];
  assert.deepEqual(ST.selectOwnRecords(rs, ctxA).map((r) => r.id), ["a"]);
});

test("proposal: finite 8 + 2 split, total <= $30; wildcard, overlap, other owner, malformed refused", () => {
  const p = np();
  assert.equal(p.total6, 30_000_000n);
  assert.deepEqual(p.parts.map((x) => [x.name, x.appIds.length, x.budget6]), [["nucbox", 8, 800_000n], ["metal", 2, 200_000n]]);
  assert.equal(ST.validateProposal(null, { owner: OWNER, chainId: 8453 }), null);
  const v = (over) => () => np(over);
  assert.throws(v({ legacy6: "29000001" }), code("amount"), "over $30 in total");
  assert.throws(v({ gas: [{ name: "all", budget6: "1000000", opsPerPeriod: "20", appIds: ["*"] }] }), code("scope_wildcard"));
  assert.throws(v({ gas: [{ name: "a", budget6: "500000", opsPerPeriod: "10", appIds: [APPS[0]] }, { name: "b", budget6: "500000", opsPerPeriod: "10", appIds: [APPS[0]] }] }), code("scope_overlap"));
  assert.throws(v({ gas: [{ name: "big", budget6: "1000000", opsPerPeriod: "20", appIds: APPS.slice(0, 9) }] }), code("scope"));
  assert.throws(v({ owner: OTHER }), code("owner"));
  assert.throws(v({ chainId: 1 }), code("chain"));
  assert.throws(v({ legacy6: "29.5" }), code("amount"));
  assert.throws(v({ extra: 1 }), code("shape"));
  assert.deepEqual(ST.scopeCoverage(p, APPS), { uncovered: [], extra: [], ok: true });
  assert.equal(ST.scopeCoverage(p, APPS.slice(1)).ok, false);
});

test("an existing plan is shown from its own terms; any proposal difference is reported", () => {
  const p = plan();
  const tv = ST.termsView(p);
  assert.equal(tv.legacy6, 29_000_000n);
  assert.deepEqual(tv.parts.map((x) => [x.name, x.budget6, x.opsPerPeriod, x.appIds.length]), [["nucbox", 800_000n, 16n, 8], ["metal", 200_000n, 4n, 2]]);
  assert.deepEqual(ST.proposalMatchesPlan(np(), p), { ok: true, diffs: [] });
  const swapBudgets = np({ legacy6: "28900000", gas: [{ name: "nucbox", budget6: "900000", opsPerPeriod: "16", appIds: NUC }, { name: "metal", budget6: "200000", opsPerPeriod: "4", appIds: METAL }] });
  assert.deepEqual(ST.proposalMatchesPlan(swapBudgets, p).diffs, ["legacy6", "parts[0].budget6"]);
  assert.deepEqual(ST.proposalMatchesPlan(np({ gas: [{ name: "nuc", budget6: "800000", opsPerPeriod: "16", appIds: NUC }, { name: "metal", budget6: "200000", opsPerPeriod: "4", appIds: METAL }] }), p).diffs, ["parts[0].name"]);
  assert.deepEqual(ST.proposalMatchesPlan(np({ gas: [{ name: "nucbox", budget6: "800000", opsPerPeriod: "15", appIds: NUC }, { name: "metal", budget6: "200000", opsPerPeriod: "4", appIds: METAL }] }), p).diffs, ["parts[0].opsPerPeriod"]);
  const moved = [...NUC.slice(1), METAL[0]];
  assert.deepEqual(ST.proposalMatchesPlan(np({ gas: [{ name: "nucbox", budget6: "800000", opsPerPeriod: "16", appIds: moved }, { name: "metal", budget6: "200000", opsPerPeriod: "4", appIds: [NUC[0], METAL[1]] }] }), p).diffs, ["parts[0].appIds", "parts[1].appIds"]);
  assert.deepEqual(ST.proposalMatchesPlan(np({ deploymentIds: DEPS.slice(1) }), p).diffs, ["deploymentIds"]);
  const m = ST.moneyRows({ original6: tv.original6, legacy6: tv.legacy6, parts: tv.parts });
  assert.equal(m.ok, true);
  assert.deepEqual(m.text, ["Replacement API session (same key): $29.00", 'Gas grant "nucbox" (8 apps): $0.80', 'Gas grant "metal" (2 apps): $0.20']);
  assert.equal(ST.moneyRows({ original6: "31000000", legacy6: tv.legacy6, parts: tv.parts }).ok, false);
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
  assert.equal(ST.approvalStatus({ ...ok, rootReviewed: "true" }, p, ctxA).reason, "approval_not_reviewed");
  assert.equal(ST.approvalStatus({ ...ok, termsHash: "0xother" }, p, ctxA).reason, "approval_other_terms");
  assert.equal(ST.approvalStatus(ok, p, ctxB).reason, "approval_other_owner");
  assert.equal(ST.approvalStatus({ ...ok, bypass: true }, p, ctxA).reason, "approval_malformed");
  assert.deepEqual({ ...ST.approvalStatus(ok, p, ctxA).approval }, { rootReviewed: true, termsHash: "0xterms" });
});

test("next signable: a lost earlier proof stops everything; unresolved steps stop later ones", () => {
  assert.deepEqual(ST.nextSignable(plan(), 100n), ["terminate", "legacyOpen", "gasOpen:nucbox", "gasOpen:metal"]);
  const lost = plan({ terminate: termStep("proven", { recheck: { result: "lost" } }), legacyOpen: step("proven") });
  assert.deepEqual(ST.nextSignable(lost, 100n), [], "gas steps are not offered while terminate's proof is lost");
  assert.equal(ST.planPhase(lost, 100n).phase, "reconcile");
  const lostLater = plan({ terminate: termStep("proven"), legacyOpen: step("proven", { recheck: { result: "moved" } }) });
  assert.deepEqual(ST.nextSignable(lostLater, 100n), []);
  const resumed = plan({ terminate: termStep("proven"), legacyOpen: step("proven"), "gasOpen:nucbox": { ...plan().steps["gasOpen:nucbox"], status: "proven" } });
  assert.deepEqual(ST.nextSignable(resumed, 100n), ["gasOpen:metal"]);
  const interrupted = plan({ terminate: termStep("proven"), legacyOpen: step("admitted", { lastError: "relay_unreachable" }) });
  assert.deepEqual(ST.nextSignable(interrupted, 100n), []);
  assert.deepEqual(ST.planPhase(interrupted, 100n), { phase: "reconcile", step: "legacyOpen" });
  assert.deepEqual(ST.nextSignable(plan({ legacyOpen: step("void") }), 100n), [], "the original is never signed without its replacement");
  for (const s of ["admitted", "submitted", "proven", "void"]) assert.equal(ST.stepView(step(s), 100n).actions.includes("sign"), false, s);
});

test("held signatures: same context/plan/terms/digests, planned only, behind still-proven steps; dropped on change", () => {
  const m = ST.createMemory();
  const p = plan();
  m.bind(ctxA);
  m.holdSigned(ctxA, p, ["terminate", "legacyOpen"], "B");
  assert.equal(m.signedFor(ctxA, p), "B");
  assert.equal(m.signedFor(ctxB, p), null, "another owner never sees the bundle");
  assert.equal(m.signedFor(ctxA, { ...p, termsHash: "0xother" }), null);
  assert.equal(m.signedFor(ctxA, plan({ legacyOpen: { ...p.steps.legacyOpen, review: { ...p.steps.legacyOpen.review, digest: "0xrearmed" } } })), null);
  assert.equal(m.signedFor(ctxA, { ...p, steps: { ...p.steps, terminate: { ...p.steps.terminate, status: "admitted" } } }), null, "admitted: never reused");
  const later = plan({ terminate: termStep("proven"), legacyOpen: step("proven") });
  m.holdSigned(ctxA, later, ["gasOpen:nucbox"], "G");
  assert.equal(m.signedFor(ctxA, later), "G");
  assert.equal(m.signedFor(ctxA, { ...later, steps: { ...later.steps, terminate: { ...later.steps.terminate, recheck: { result: "lost" } } } }), null, "lost earlier proof");
  assert.throws(() => m.holdSigned(ctxA, later, ["terminate"], "X"), code("stale"), "a proven step cannot be held");
  m.bind(ctxB);
  m.bind(ctxA);
  assert.equal(m.signedFor(ctxA, later), null, "a wallet switch and back does not resurrect it");
  m.clear();
  assert.throws(() => m.holdSigned(ctxA, p, ["terminate", "legacyOpen"], {}), code("stale"));
});

test("quotes: bound to context, record, deployment, amount, tier and digest; peek survives a render, take is single use", () => {
  const m = ST.createMemory();
  m.bind(ctxA);
  const rec = { id: "gas-nucbox", sid: SID2 };
  const A = ST.quoteInputsOf({ deployment: DEPS[1], ethOut: "20000000000000", feeTier: "500" });
  const B = ST.quoteInputsOf({ deployment: DEPS[2], ethOut: "20000000000000", feeTier: "500" });
  const review = { deployment: DEPS[1], sid: SID2, call: { digest: "0xQ", intent: { ethOut: 20_000_000_000_000n, fee: 500 }, execute: { deadline: 1000n } }, totals: {} };
  assert.equal(ST.quoteInputsOf({ deployment: DEPS[1], ethOut: "2e13", feeTier: "500" }), null, "not an exact request");
  assert.throws(() => m.holdQuote(ctxA, rec, B, review), code("quote_mismatch"), "a quote for A is never held as B");
  m.holdQuote(ctxA, rec, A, review);
  assert.equal(m.peekQuote(ctxA, A, 900n).digest, "0xq", "a re-render with the same inputs shows it");
  assert.equal(m.peekQuote(ctxA, A, 900n).digest, "0xq", "peeking does not consume it");
  assert.deepEqual(m.quoteInputs(ctxA), A, "the controls can be restored to exactly what was quoted");
  assert.equal(m.peekQuote(ctxA, B, 900n), null, "another selected deployment shows nothing");
  assert.equal(m.peekQuote(ctxA, { ...A, ethOut: "1" }, 900n), null, "another amount shows nothing");
  assert.equal(m.peekQuote(ctxA, A, 986n), null, "inside the 15 s margin");
  assert.equal(m.takeQuote(ctxA, rec, B, "0xq", 900n), null, "deployment B can never fund quote A");
  assert.equal(m.hasQuote, false, "and the attempt consumed it");
  m.holdQuote(ctxA, rec, A, review);
  assert.equal(m.takeQuote(ctxA, rec, A, "0xother", 900n), null, "the digest shown must be the one held");
  m.holdQuote(ctxA, rec, A, review);
  assert.equal(m.takeQuote(ctxA, { ...rec, id: "gas-metal" }, A, "0xq", 900n), null, "another record");
  m.holdQuote(ctxA, rec, A, review);
  m.bind(ctxB);
  assert.equal(m.peekQuote(ctxB, A, 900n), null, "wallet switch drops it");
  m.bind(ctxA);
  m.holdQuote(ctxA, rec, A, review);
  assert.equal(m.takeQuote(ctxA, rec, A, "0xQ", 900n), review);
  assert.equal(m.takeQuote(ctxA, rec, A, "0xQ", 900n), null, "used once");
});

test("active pointer, owner controls and quote view are unchanged", () => {
  assert.equal(ST.activePointerDecision("", SID2, SID), "set");
  assert.equal(ST.activePointerDecision(SID2, SID2, SID), "noop");
  assert.equal(ST.activePointerDecision(H(77), SID2, SID), "keep", "another choice is never clobbered");
  const noRuntime = ST.controlsAvailability({ pinsOk: false, relayOk: true, storeOk: true, ownRecords: 1 });
  assert.equal(noRuntime.terminate || noRuntime.withdraw, false);
  assert.equal(noRuntime.end, true);
  assert.equal(ST.controlsAvailability.length, 1, "takes no intake / catalog / scope input at all");
  const review = { totals: { maxUsdcIn6: 48_480n, fee6: 25_000n, totalMaximum6: 73_480n, balance6: 200_000n }, call: { execute: { deadline: 1300n } } };
  assert.deepEqual(ST.quoteView(review, 1000n).text, ["gas at most $0.04848", "relay fee $0.025", "total at most $0.07348", "grant balance $0.20 -> at least $0.12652"]);
  assert.equal(ST.quoteView(review, 1290n).expired, true);
});
