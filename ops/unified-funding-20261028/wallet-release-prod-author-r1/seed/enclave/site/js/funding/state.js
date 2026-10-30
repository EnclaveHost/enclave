// migration-cutover-site-r1: DERIVED (pinned) from source/site/js/funding/state.js; only the appended cutover block is new.
/* ============================================================
   Funding page UI state (pure: no DOM, no network, no storage).
   UNREVIEWED SOURCE (client-site-repair-r2; repairs r1).

   Everything the /funding page decides about WHICH plan, record,
   signature bundle or quote it may show or use lives here, so it
   can be tested offline:
     - a plan is offered only when its owner, chain and both vaults
       match AND every gas step references this browser's gas key
       record for the same owner, chain, vault and RELAY (the plan's
       terms carry no relay; the referenced records do);
     - signatures are held in memory only, bound to the context,
       plan, terms and per-step digests, and usable only while every
       held step is still planned behind still-proven earlier steps;
     - a quote is held in memory only, bound to the context, record,
       deployment, ETH amount, fee tier and its call digest; it is
       consumed once and dropped on any input or context change;
     - the operator's proposal is an explicit FINITE split <= $30;
       an existing plan is displayed from ITS OWN terms, and the
       proposal must equal them before anything is signed or sent;
     - the approval is matched field by field (no rootReviewed
       bypass); the legacy scope is LABELLED from the stored grant
       exactly: [] is "no apps", only ["*"] is the wildcard.
   ============================================================ */

export const PROPOSAL_SCHEMA = "enclave-funding-migration-proposal-r1";
export const APPROVAL_SCHEMA = "enclave-funding-migration-approval-r1";
export const MAX_TOTAL6 = 30_000_000n;
export const QUOTE_MARGIN_S = 15n;
const HEX32 = /^0x[0-9a-f]{64}$/;
const ZERO32 = `0x${"0".repeat(64)}`;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const PART = /^[a-z0-9-]{1,24}$/;
const DEC = /^(0|[1-9][0-9]{0,37})$/;

export class StateError extends Error {
  constructor(code, message) { super(message); this.name = "StateError"; this.code = code; }
}
const fail = (code, message) => { throw new StateError(code, message); };
export const lower = (a) => String(a ?? "").toLowerCase();
const exactKeys = (o, keys, what) => {
  if (!o || typeof o !== "object" || Array.isArray(o)) fail("shape", `${what} must be an object`);
  const got = Object.keys(o).sort().join();
  if (got !== [...keys].sort().join()) fail("shape", `${what} must have exactly: ${keys.join(", ")}`);
};
const dec = (v, what) => {
  const s = typeof v === "bigint" ? v.toString() : String(v);
  if (!DEC.test(s)) fail("amount", `${what} must be a whole number of USDC micro-units`);
  return BigInt(s);
};

/** 29000000 -> "$29.00"; 800000 -> "$0.80"; 73480 -> "$0.07348" (never rounds a displayed amount). */
export function formatUsd6(v) {
  let n = BigInt(v);
  const sign = n < 0n ? "-" : "";
  if (n < 0n) n = -n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0");
  let f = frac.replace(/0+$/, "");
  if (f.length < 2) f = frac.slice(0, 2);
  return `${sign}$${n / 1_000_000n}.${f}`;
}

// ---- context: the exact scope every plan, record, signature and quote belongs to --------------------------------------

const normRelay = (r) => String(r ?? "").replace(/\/+$/, "");
export function contextOf({ owner, chainId, vault, legacyVault, relay }) {
  if (!ADDR.test(String(owner))) fail("context", "no connected owner");
  const c = { owner: lower(owner), chainId: Number(chainId), vault: lower(vault), legacyVault: lower(legacyVault), relay: normRelay(relay) };
  if (!ADDR.test(c.vault) || !ADDR.test(c.legacyVault) || !Number.isInteger(c.chainId) || !c.relay) fail("context", "incomplete context");
  return Object.freeze({ ...c, key: `${c.owner}|${c.chainId}|${c.vault}|${c.legacyVault}|${c.relay}` });
}
/** Owner controls only need owner + chain + successor vault + relay (no legacy vault, no intake). */
export function controlsContextOf({ owner, chainId, vault, relay }) {
  if (!ADDR.test(String(owner))) fail("context", "no connected owner");
  return Object.freeze({ owner: lower(owner), chainId: Number(chainId), vault: lower(vault), relay: normRelay(relay),
    key: `${lower(owner)}|${Number(chainId)}|${lower(vault)}|${normRelay(relay)}` });
}

/** Only this context's gas key records (other owners' records are never shown, used, changed or deleted). */
export function selectOwnRecords(records, ctx) {
  return (records || []).filter((r) => r && lower(r.owner) === ctx.owner && Number(r.chainId) === ctx.chainId
    && lower(r.vault) === ctx.vault && normRelay(r.relay) === ctx.relay);
}

const isGasStep = (k) => k === "gasOpen" || (typeof k === "string" && k.startsWith("gasOpen:"));

/** Why a journal entry is (not) a plan of THIS context. ok only when the terms name this owner/chain/vaults (and session)
 *  AND every gas step references one of `records` that is this owner's, on this chain, vault and relay, with the step's
 *  key. The core's plan terms carry no relay, so the relay evidence is the referenced records (created by the same
 *  buildMigrationPlan call with this relay base). Missing evidence refuses; nothing is inferred. */
export function planScope(e, ctx, records, oldSid) {
  if (!e || e.kind !== "migration" || e.v !== 3 || !e.terms || !e.steps) return { ok: false, reason: "not_a_plan" };
  const t = e.terms;
  if (lower(t.owner) !== ctx.owner) return { ok: false, reason: "other_owner" };
  if (Number(t.chainId) !== ctx.chainId) return { ok: false, reason: "other_chain" };
  if (lower(t.legacy?.vault) !== ctx.legacyVault || lower(t.gas?.vault) !== ctx.vault) return { ok: false, reason: "other_vault" };
  if (oldSid !== undefined && lower(t.legacy?.oldSid) !== lower(oldSid)) return { ok: false, reason: "other_session" };
  if (!Array.isArray(records)) return { ok: false, reason: "relay_evidence_missing" };
  const order = Array.isArray(t.order) ? t.order : [];
  const gas = order.filter(isGasStep);
  if (order[0] !== "terminate" || order[1] !== "legacyOpen" || gas.length === 0 || gas.length !== order.length - 2) {
    return { ok: false, reason: "relay_evidence_missing" };
  }
  const own = selectOwnRecords(records, ctx);
  for (const k of gas) {
    const r = e.steps[k]?.review;
    const rec = r && own.find((x) => x.id === r.recordId);
    if (!rec) {
      const anywhere = r && records.find((x) => x && x.id === r.recordId);
      return { ok: false, reason: anywhere ? "other_relay_or_owner" : "relay_evidence_missing", step: k };
    }
    if (lower(rec.keyHash) !== lower(r.keyHash)) return { ok: false, reason: "record_key_mismatch", step: k };
  }
  return { ok: true, reason: "scoped" };
}
/** Only this context's migration plans (never "the last journal entry" across owners, chains, vaults or relays). */
export function selectPlans(entries, ctx, oldSid, records) {
  return (entries || []).filter((e) => planScope(e, ctx, records, oldSid).ok)
    .sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0));
}

// ---- operator proposal (explicit finite split + recovery deployments) ---------------------------------------------------

/** null -> null (nothing proposed). Otherwise an exact, FINITE proposal for THIS owner, total <= $30, or a coded refusal.
 *  Equality with the original session's actual balance is checked again by the core (parseSplit) when a plan is built. */
export function validateProposal(p, { owner, chainId }) {
  if (p === null || p === undefined) return null;
  exactKeys(p, ["schema", "chainId", "owner", "oldSid", "legacy6", "gas", "deploymentIds"], "proposal");
  if (p.schema !== PROPOSAL_SCHEMA) fail("schema", `proposal.schema must be ${PROPOSAL_SCHEMA}`);
  if (Number(p.chainId) !== Number(chainId)) fail("chain", "the proposal is for another chain");
  if (!ADDR.test(String(p.owner)) || lower(p.owner) !== lower(owner)) fail("owner", "the proposal is for another wallet");
  if (!HEX32.test(String(p.oldSid)) || p.oldSid === ZERO32) fail("sid", "proposal.oldSid must be a lower-case 0x + 64 hex session id");
  const legacy6 = dec(p.legacy6, "proposal.legacy6");
  if (legacy6 === 0n) fail("amount", "the replacement legacy budget must be positive");
  if (!Array.isArray(p.gas) || p.gas.length === 0) fail("shape", "proposal.gas must list at least one finite gas grant");
  const seen = new Set();
  const parts = p.gas.map((g, i) => {
    exactKeys(g, ["name", "budget6", "opsPerPeriod", "appIds"], `proposal.gas[${i}]`);
    if (!PART.test(String(g.name))) fail("shape", `proposal.gas[${i}].name must match ${PART}`);
    if (!Array.isArray(g.appIds) || g.appIds.length === 0 || g.appIds.length > 8) fail("scope", `gas grant "${g.name}" must name 1..8 apps`);
    for (const a of g.appIds) {
      if (a === "*") fail("scope_wildcard", `gas grant "${g.name}" may not be a wildcard`);
      if (!HEX32.test(String(a)) || a === ZERO32) fail("scope", `gas grant "${g.name}": ${a} is not a lower-case app id`);
      if (seen.has(a)) fail("scope_overlap", `app ${a} is named twice`);
      seen.add(a);
    }
    const budget6 = dec(g.budget6, `proposal.gas[${i}].budget6`);
    const opsPerPeriod = dec(g.opsPerPeriod, `proposal.gas[${i}].opsPerPeriod`);
    if (budget6 === 0n || opsPerPeriod === 0n) fail("amount", `gas grant "${g.name}" needs a positive budget and op count`);
    return Object.freeze({ name: g.name, budget6, opsPerPeriod, appIds: Object.freeze([...g.appIds].sort()) });
  });
  if (new Set(parts.map((x) => x.name)).size !== parts.length) fail("shape", "gas grant names must be distinct");
  if (!Array.isArray(p.deploymentIds) || p.deploymentIds.length === 0 || p.deploymentIds.length > 64) fail("shape", "proposal.deploymentIds must list 1..64 deployments");
  for (const d of p.deploymentIds) if (!HEX32.test(String(d)) || d === ZERO32) fail("shape", `deployment ${d} is not a lower-case id`);
  if (new Set(p.deploymentIds).size !== p.deploymentIds.length) fail("shape", "a deployment is listed twice");
  const gas6 = parts.reduce((s, x) => s + x.budget6, 0n);
  if (legacy6 + gas6 > MAX_TOTAL6) fail("amount", `the proposal moves ${formatUsd6(legacy6 + gas6)}; at most ${formatUsd6(MAX_TOTAL6)}`);
  return Object.freeze({ oldSid: p.oldSid, legacy6, parts: Object.freeze(parts), gas6, total6: legacy6 + gas6,
    deploymentIds: Object.freeze([...p.deploymentIds]) });
}
/** The split object the core's parseSplit expects (no defaults added). */
export const splitOf = (np) => ({ legacy6: np.legacy6,
  gas: np.parts.map((x) => ({ name: x.name, budget6: x.budget6, opsPerPeriod: x.opsPerPeriod, appIds: [...x.appIds] })) });
/** The proposal's apps must be EXACTLY the freshly read recovery scope's apps (no app uncovered, none extra). */
export function scopeCoverage(np, scopeAppIds) {
  const named = new Set(np.parts.flatMap((x) => x.appIds));
  const scope = new Set((scopeAppIds || []).map(lower));
  return { uncovered: [...scope].filter((a) => !named.has(a)), extra: [...named].filter((a) => !scope.has(a)),
    ok: [...scope].every((a) => named.has(a)) && [...named].every((a) => scope.has(a)) };
}

/** The AUTHORITATIVE terms of a journaled plan, for display (the core's own fields; decimal strings -> bigint). */
export function termsView(plan) {
  const t = plan.terms;
  return Object.freeze({
    original6: BigInt(t.legacy.oldBalance6), legacy6: BigInt(t.split.legacy6),
    parts: Object.freeze(t.gas.parts.map((x) => Object.freeze({ name: x.name, budget6: BigInt(x.budget6),
      opsPerPeriod: BigInt(x.opsPerPeriod), appIds: Object.freeze([...x.appIds].map(lower).sort()) }))),
    deploymentIds: Object.freeze([...t.gas.deployments].map(lower).sort()),
    legacyApps: t.legacy.grantTemplate?.apps,
  });
}
/** The configured proposal must equal the plan's reviewed terms exactly (split, names, order, budgets, ops, apps and
 *  deployments). Any difference: the plan's terms are shown and nothing is signed or sent. */
export function proposalMatchesPlan(np, plan) {
  if (!np || !plan) return { ok: false, diffs: ["missing"] };
  let tv;
  try { tv = termsView(plan); } catch { return { ok: false, diffs: ["plan_terms_unreadable"] }; }
  const diffs = [];
  if (lower(plan.terms.legacy.oldSid) !== lower(np.oldSid)) diffs.push("oldSid");
  if (tv.legacy6 !== np.legacy6) diffs.push("legacy6");
  if (tv.parts.length !== np.parts.length) diffs.push("parts");
  else {
    tv.parts.forEach((x, i) => {
      const y = np.parts[i];
      if (x.name !== y.name) diffs.push(`parts[${i}].name`);
      if (x.budget6 !== y.budget6) diffs.push(`parts[${i}].budget6`);
      if (x.opsPerPeriod !== y.opsPerPeriod) diffs.push(`parts[${i}].opsPerPeriod`);
      if (x.appIds.join() !== [...y.appIds].map(lower).sort().join()) diffs.push(`parts[${i}].appIds`);
    });
  }
  if (tv.deploymentIds.join() !== [...np.deploymentIds].map(lower).sort().join()) diffs.push("deploymentIds");
  return { ok: diffs.length === 0, diffs };
}

// ---- display ---------------------------------------------------------------------------------------------------------

/** Label of the ORIGINAL stored grant's scope, exactly as the vault interprets it. [] is never shown as a wildcard. */
export function legacyScopeLabel(apps) {
  if (!Array.isArray(apps)) return { kind: "invalid", text: "unreadable app scope" };
  if (apps.length === 0) return { kind: "none", text: "no apps (empty scope)" };
  if (apps.length === 1 && apps[0] === "*") return { kind: "wildcard", text: "all apps (explicit wildcard in the original grant)" };
  if (apps.includes("*")) return { kind: "invalid", text: "malformed scope (wildcard mixed with ids)" };
  if (apps.every((a) => HEX32.test(String(a))) && new Set(apps).size === apps.length) {
    return { kind: "finite", text: `${apps.length} named app${apps.length === 1 ? "" : "s"}` };
  }
  return { kind: "invalid", text: "scope this page cannot verify (names or non-canonical ids)" };
}

/** Where the money is: original -> replacement legacy + each finite gas grant. ok only if it adds up exactly and <= $30. */
export function moneyRows({ original6, legacy6, parts }) {
  const rows = [{ key: "legacy", label: "Replacement API session (same key)", amount6: BigInt(legacy6) },
    ...parts.map((x) => ({ key: x.name, label: `Gas grant "${x.name}" (${x.appIds.length} apps)`, amount6: BigInt(x.budget6) }))];
  const total6 = rows.reduce((s, r) => s + r.amount6, 0n);
  const orig = original6 === undefined || original6 === null ? null : BigInt(original6);
  return { rows, total6, original6: orig, ok: orig !== null && total6 === orig && orig <= MAX_TOTAL6,
    text: rows.map((r) => `${r.label}: ${formatUsd6(r.amount6)}`) };
}

/** Field-by-field approval check. Nothing is approved by default, by key generation, or by a partial match. */
export function approvalStatus(approval, plan, ctx) {
  if (!plan) return { ok: false, reason: "no_plan" };
  if (approval === null || approval === undefined) return { ok: false, reason: "waiting_for_review", termsHash: plan.termsHash };
  try { exactKeys(approval, ["schema", "rootReviewed", "termsHash", "owner", "chainId", "oldSid"], "approval"); }
  catch { return { ok: false, reason: "approval_malformed" }; }
  if (approval.schema !== APPROVAL_SCHEMA) return { ok: false, reason: "approval_schema" };
  if (approval.rootReviewed !== true) return { ok: false, reason: "approval_not_reviewed" };
  if (lower(approval.owner) !== ctx.owner) return { ok: false, reason: "approval_other_owner" };
  if (Number(approval.chainId) !== ctx.chainId) return { ok: false, reason: "approval_other_chain" };
  if (lower(approval.oldSid) !== lower(plan.terms?.legacy?.oldSid)) return { ok: false, reason: "approval_other_session" };
  if (approval.termsHash !== plan.termsHash) return { ok: false, reason: "approval_other_terms", termsHash: plan.termsHash };
  return { ok: true, reason: "approved", approval: Object.freeze({ rootReviewed: true, termsHash: plan.termsHash }) };
}

const STEP_LABEL = { terminate: "End the original session (its budget returns to your wallet)",
  legacyOpen: "Open the replacement API session (same key, same apps)" };
export const stepLabel = (k) => STEP_LABEL[k] ?? (k.startsWith("gasOpen:") ? `Open gas grant "${k.slice(8)}"` : k === "gasOpen" ? "Open the gas grant" : k);

/** Friendly status + the ONLY actions a person may take for one journaled step. Nothing is ever retried automatically. */
export function stepView(step, nowSec) {
  const s = step?.status;
  const windowEnd = step?.review ? BigInt(step.review.message?.signBefore ?? step.review.grant?.signBefore ?? 0) : 0n;
  const expired = BigInt(nowSec) >= windowEnd;
  if (s === "proven" && step.recheck) return { label: `Was confirmed, but the chain no longer shows it (${step.recheck.result}). Check again before anything else.`, tone: "warn", actions: ["reconcile"] };
  if (s === "proven") return { label: "Confirmed on chain", tone: "ok", actions: [] };
  if (s === "submitted") return { label: `Sent (${String(step.txHash).slice(0, 10)}…), waiting for chain confirmation`, tone: "wait", actions: ["reconcile"] };
  if (s === "admitted" && step.lastError) return { label: `Outcome unknown (${step.lastError}): it may have been sent. Check the chain; it is never resent automatically.`, tone: "warn", actions: ["reconcile"] };
  if (s === "admitted") return { label: "Being sent, or outcome unknown. Check the chain before anything else.", tone: "warn", actions: ["reconcile"] };
  if (s === "void") return { label: "Expired without effect (proven). It can be prepared again with a new signature window.", tone: "info", actions: ["rearm"] };
  if (s === "planned") return expired
    ? { label: "Not sent; its signing window has passed. Prepare it again.", tone: "info", actions: ["rearm"] }
    : { label: "Not sent yet", tone: "idle", actions: ["sign"] };
  return { label: `Unknown state ${String(s)}`, tone: "warn", actions: [] };
}

const stillProven = (st) => st?.status === "proven" && !st.recheck;

/** The steps the owner may sign NEXT: consecutive planned steps right after a run of STILL-proven steps (a proof the
 *  chain no longer shows - `recheck` - stops everything until reconciled); terminate only with its replacement. */
export function nextSignable(plan, nowSec) {
  const order = plan?.terms?.order || [];
  let first = 0;
  while (first < order.length && stillProven(plan.steps[order[first]])) first += 1;
  if (first >= order.length) return [];
  const out = [];
  for (const k of order.slice(first)) {
    const st = plan.steps[k];
    if (st?.status !== "planned" || !stepView(st, nowSec).actions.includes("sign")) break;
    out.push(k);
  }
  if (out[0] === "terminate" && !out.includes("legacyOpen")) return [];
  return out;
}

/** What the page should offer after a (re)load, derived from the journal alone. */
export function planPhase(plan, nowSec, hasSignatures = false) {
  const order = plan?.terms?.order || [];
  const k = order.find((s) => !stillProven(plan.steps[s]));
  if (!k) return { phase: "done" };
  const v = stepView(plan.steps[k], nowSec);
  if (v.actions.includes("reconcile")) return { phase: "reconcile", step: k };
  if (v.actions.includes("rearm")) return { phase: "rearm", step: k };
  return { phase: hasSignatures ? "submit" : "sign", step: k, steps: nextSignable(plan, nowSec) };
}

/** The active legacy session pointer moves only away from the replaced session (or from none). */
export function activePointerDecision(current, newSid, oldSid) {
  const cur = lower(current);
  if (cur === lower(newSid)) return "noop";
  if (!cur || cur === lower(oldSid)) return "set";
  return "keep";
}

/** Owner controls depend on: successor pins (offline), a relay base, and this browser's successor store. NOT on intake,
 *  the catalog, the recovery scope or the relay config. */
export function controlsAvailability({ pinsOk, relayOk, storeOk, ownRecords = 0 }) {
  return {
    terminate: pinsOk && relayOk && storeOk && ownRecords > 0,
    withdraw: pinsOk && relayOk && storeOk,
    end: relayOk && storeOk && ownRecords > 0,
    reason: !pinsOk ? "successor not configured" : !relayOk ? "relay address unavailable" : !storeOk ? "browser storage unavailable" : null,
  };
}

/** What the owner sees before a session-key signature: fee, maximum, total, balance and time left. */
export function quoteView(review, nowSec) {
  const t = review.totals;
  const deadline = BigInt(review.call.execute.deadline);
  const left = deadline - BigInt(nowSec);
  return { maxGas6: t.maxUsdcIn6, fee6: t.fee6, total6: t.totalMaximum6, balance6: t.balance6, balanceAfterMax6: t.balance6 - t.totalMaximum6,
    secondsLeft: left > 0n ? Number(left) : 0, expired: left <= QUOTE_MARGIN_S,
    text: [`gas at most ${formatUsd6(t.maxUsdcIn6)}`, `relay fee ${formatUsd6(t.fee6)}`, `total at most ${formatUsd6(t.totalMaximum6)}`,
      `grant balance ${formatUsd6(t.balance6)} -> at least ${formatUsd6(t.balance6 - t.totalMaximum6)}`] };
}

/** The exact quote request as the page's inputs state it, or null when the inputs are not an exact request. */
export function quoteInputsOf({ deployment, ethOut, feeTier }) {
  const d = lower(String(deployment ?? "").trim());
  const e = String(ethOut ?? "").trim();
  const t = String(feeTier ?? "").trim();
  if (!HEX32.test(d) || d === ZERO32 || !DEC.test(e) || e === "0" || !/^[1-9][0-9]{0,7}$/.test(t)) return null;
  return Object.freeze({ deployment: d, ethOut: e, feeTier: t });
}
const sameInputs = (a, b) => !!a && !!b && a.deployment === b.deployment && a.ethOut === b.ethOut && a.feeTier === b.feeTier;

// ---- in-memory signatures and quotes: bound, single-use, dropped on any context change --------------------------------

export function createMemory() {
  let ctxKey = null;
  let signed = null;
  let quote = null;
  const quoteFits = (q, ctx, inputs, nowSec) => !!q && ctxKey === ctx.key && q.ctxKey === ctx.key && sameInputs(q.inputs, inputs)
    && BigInt(nowSec) + QUOTE_MARGIN_S < q.deadline;
  const api = {
    bind(ctx) { if (ctxKey !== ctx.key) { signed = null; quote = null; } ctxKey = ctx.key; },
    clear() { ctxKey = null; signed = null; quote = null; },
    holdSigned(ctx, plan, steps, bundle) {
      if (ctxKey !== ctx.key) fail("stale", "context changed");
      for (const k of steps) if (plan.steps[k]?.status !== "planned") fail("stale", `${k} is not planned`);
      signed = { ctxKey, planId: plan.id, termsHash: plan.termsHash, steps: [...steps],
        digests: Object.fromEntries(steps.map((k) => [k, plan.steps[k].review.digest])), bundle };
    },
    /** The bundle only for the SAME context, plan, terms and the SAME digest of every signed step, while every signed
     *  step is still `planned` and every step before the first signed one is still proven (no lost proof). */
    signedFor(ctx, plan) {
      if (!signed || ctxKey !== ctx.key || signed.ctxKey !== ctx.key || !plan) return null;
      if (signed.planId !== plan.id || signed.termsHash !== plan.termsHash) return null;
      for (const [k, d] of Object.entries(signed.digests)) {
        const st = plan.steps?.[k];
        if (st?.review?.digest !== d || st.status !== "planned") return null;
      }
      const order = plan.terms?.order || [];
      const at = order.indexOf(signed.steps[0]);
      if (at < 0) return null;
      for (const k of order.slice(0, at)) if (!stillProven(plan.steps[k])) return null;
      return signed.bundle;
    },
    dropSigned() { signed = null; },
    /** Hold a quote for exactly these inputs; the review itself must state the same deployment, amount, tier and sid. */
    holdQuote(ctx, record, inputs, review) {
      if (ctxKey !== ctx.key) fail("stale", "context changed");
      if (!inputs || lower(review.deployment) !== inputs.deployment || BigInt(review.call.intent.ethOut) !== BigInt(inputs.ethOut)
        || Number(review.call.intent.fee) !== Number(inputs.feeTier) || lower(review.sid) !== lower(record.sid)) {
        fail("quote_mismatch", "the quote does not state the requested deployment, amount, tier or session");
      }
      quote = { ctxKey, recordId: record.id, sid: lower(record.sid), inputs, digest: lower(review.call.digest),
        deadline: BigInt(review.call.execute.deadline), review };
    },
    /** Non-consuming: the held quote to DISPLAY for these exact inputs (else null). Used by re-renders. */
    peekQuote(ctx, inputs, nowSec) {
      return quoteFits(quote, ctx, inputs, nowSec) ? { recordId: quote.recordId, digest: quote.digest, inputs: quote.inputs, review: quote.review } : null;
    },
    /** The inputs of the held quote for this context (to restore the controls after a re-render), else null. */
    quoteInputs(ctx) { return quote && quote.ctxKey === ctx.key && ctxKey === ctx.key ? quote.inputs : null; },
    dropQuote() { quote = null; },
    /** Single use: the quote once, for the same context, record, inputs and displayed digest, > margin before deadline. */
    takeQuote(ctx, record, inputs, digest, nowSec) {
      const q = quote;
      quote = null;
      if (!quoteFits(q, ctx, inputs, nowSec) || !record || q.recordId !== record.id || q.sid !== lower(record.sid)) return null;
      if (q.digest !== lower(digest)) return null;
      return q.review;
    },
    get hasSigned() { return signed !== null; },
    get hasQuote() { return quote !== null; },
  };
  return api;
}

// ---- migration-cutover-site-r1: explicit reviewed cutover mode (pause after the original session ends) ------------------
// The SDK decides (terms.cutover in termsHash, full-plan signatures before terminate, durable pause, resumeCutover);
// this only selects the mode, mirrors the journal for display and narrows what the page OFFERS to sign.

export const CUTOVER_CONFIG_SCHEMA = "enclave-funding-migration-cutover-r1";
/** null -> null (normal mode, unchanged). Otherwise the reviewed pause terms for THIS owner, chain and original session. */
export function validateCutover(c, { owner, chainId, oldSid }) {
  if (c === null || c === undefined) return null;
  exactKeys(c, ["schema", "chainId", "owner", "oldSid", "terms"], "cutover");
  if (c.schema !== CUTOVER_CONFIG_SCHEMA) fail("schema", `cutover.schema must be ${CUTOVER_CONFIG_SCHEMA}`);
  if (Number(c.chainId) !== Number(chainId)) fail("chain", "the cutover is for another chain");
  if (!ADDR.test(String(c.owner)) || lower(c.owner) !== lower(owner)) fail("owner", "the cutover is for another wallet");
  if (!HEX32.test(String(c.oldSid)) || lower(c.oldSid) !== lower(oldSid)) fail("sid", "the cutover is for another session");
  exactKeys(c.terms, ["pauseAfter", "activationPlanSha256", "rollbackPlanSha256"], "cutover.terms");
  if (c.terms.pauseAfter !== "terminate") fail("shape", "the only reviewed pause is right after the original ends");
  for (const k of ["activationPlanSha256", "rollbackPlanSha256"]) {
    if (!HEX32.test(String(c.terms[k])) || c.terms[k] === ZERO32) fail("shape", `cutover.terms.${k} must be a lower-case sha256`);
  }
  if (c.terms.activationPlanSha256 === c.terms.rollbackPlanSha256) fail("shape", "the activation and rollback plans must differ");
  return Object.freeze({ pauseAfter: "terminate", activationPlanSha256: c.terms.activationPlanSha256, rollbackPlanSha256: c.terms.rollbackPlanSha256 });
}

/** A journaled plan is used only in ITS OWN mode: never silently moved into or out of the reviewed pause. */
export function planMode(plan, cut) {
  const pc = plan?.terms?.cutover ?? null;
  if (!pc && !cut) return { mode: "normal", ok: true };
  if (pc && cut && pc.pauseAfter === cut.pauseAfter && pc.activationPlanSha256 === cut.activationPlanSha256
    && pc.rollbackPlanSha256 === cut.rollbackPlanSha256) return { mode: "cutover", ok: true };
  return { mode: pc ? "cutover" : "normal", ok: false, reason: pc ? (cut ? "cutover_terms_differ" : "cutover_not_configured") : "plan_without_pause" };
}

/** The pause as the journal records it (display only; the core's cutoverHeld decides admission). */
export function cutoverView(plan) {
  if (!plan?.terms?.cutover) return { kind: "none" };
  const t = plan.steps?.terminate;
  const c = plan.cutover;
  if (t?.status !== "proven") return { kind: "before" };
  if (c?.paused !== true || c.terminate?.txHash !== t.txHash) return { kind: "marker_missing" };
  if (c.resumed && c.resumed.terminateTxHash === t.txHash) return { kind: "resumed", txHash: t.txHash };
  return { kind: "paused", txHash: t.txHash, block: c.terminate.block };
}

/** Cutover mode: before the original ends ONLY the whole plan at once (terminate, replacement, every gas part); while
 *  paused, nothing; after the recorded activation, the normal rule. Never a bundle across an unknown/admitted step. */
export function cutoverSignable(plan, nowSec) {
  const v = cutoverView(plan);
  if (v.kind === "paused" || v.kind === "marker_missing") return [];
  const next = nextSignable(plan, nowSec);
  if (next[0] === "terminate" && next.length !== (plan.terms.order || []).length) return [];
  return next;
}
export const signableOf = (plan, nowSec, cut) => (cut ? cutoverSignable(plan, nowSec) : nextSignable(plan, nowSec));
