/* ============================================================
   Funding page UI state (pure: no DOM, no network, no storage).
   UNREVIEWED SOURCE (client-site-integration-r1).

   Everything the /funding page decides about WHICH plan, record,
   signature bundle or quote it may show or use lives here, so it
   can be tested offline:
     - every plan / record is scoped to the exact connected owner,
       chain, successor vault, legacy vault and relay;
     - signatures and quotes are held in memory only, bound to that
       context and to the exact plan digests / quote digest, and are
       dropped on any context change (wallet switch, remount);
     - the operator's proposal is an explicit FINITE split; the
       approval is matched field by field (no rootReviewed bypass);
     - the legacy scope is LABELLED from the stored grant exactly:
       [] is "no apps", only ["*"] is the wildcard.
   ============================================================ */

export const PROPOSAL_SCHEMA = "enclave-funding-migration-proposal-r1";
export const APPROVAL_SCHEMA = "enclave-funding-migration-approval-r1";
export const MAX_TOTAL6 = 30_000_000n;
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

/** Only this context's migration plans (never "the last journal entry" across owners). */
export function selectPlans(entries, ctx, oldSid) {
  return (entries || []).filter((e) => e && e.kind === "migration" && e.v === 3 && e.terms
    && lower(e.terms.owner) === ctx.owner && Number(e.terms.chainId) === ctx.chainId
    && lower(e.terms.legacy?.vault) === ctx.legacyVault && lower(e.terms.gas?.vault) === ctx.vault
    && (oldSid === undefined || lower(e.terms.legacy?.oldSid) === lower(oldSid)))
    .sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0));
}
/** Only this context's gas key records (other owners' records are never shown, used, changed or deleted). */
export function selectOwnRecords(records, ctx) {
  return (records || []).filter((r) => r && lower(r.owner) === ctx.owner && Number(r.chainId) === ctx.chainId
    && lower(r.vault) === ctx.vault && normRelay(r.relay) === ctx.relay);
}

// ---- operator proposal (explicit finite split + recovery deployments) ---------------------------------------------------

/** null -> null (nothing proposed). Otherwise an exact, FINITE proposal for THIS owner, or a coded refusal. Totals against
 *  the original session's actual balance are checked again by the runtime (parseSplit) when a plan is built. */
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
  return Object.freeze({ oldSid: p.oldSid, legacy6, parts: Object.freeze(parts), gas6, total6: legacy6 + gas6,
    deploymentIds: Object.freeze([...p.deploymentIds]) });
}
/** The split object the runtime's parseSplit expects (no defaults added). */
export const splitOf = (np) => ({ legacy6: np.legacy6,
  gas: np.parts.map((x) => ({ name: x.name, budget6: x.budget6, opsPerPeriod: x.opsPerPeriod, appIds: [...x.appIds] })) });
/** The proposal's apps must be EXACTLY the freshly read recovery scope's apps (no app uncovered, none extra). */
export function scopeCoverage(np, scopeAppIds) {
  const named = new Set(np.parts.flatMap((x) => x.appIds));
  const scope = new Set((scopeAppIds || []).map(lower));
  return { uncovered: [...scope].filter((a) => !named.has(a)), extra: [...named].filter((a) => !scope.has(a)),
    ok: [...scope].every((a) => named.has(a)) && [...named].every((a) => scope.has(a)) };
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

/** The steps the owner may sign NEXT: consecutive planned steps from the first unproven one; terminate only with its
 *  replacement. Empty while anything earlier is unresolved. */
export function nextSignable(plan, nowSec) {
  const order = plan?.terms?.order || [];
  const first = order.findIndex((k) => plan.steps[k]?.status !== "proven");
  if (first < 0) return [];
  const out = [];
  for (const k of order.slice(first)) {
    const v = stepView(plan.steps[k], nowSec);
    if (plan.steps[k].status !== "planned" || !v.actions.includes("sign")) break;
    out.push(k);
  }
  if (out[0] === "terminate" && !out.includes("legacyOpen")) return [];
  return out;
}

/** What the page should offer after a (re)load, derived from the journal alone. */
export function planPhase(plan, nowSec, hasSignatures = false) {
  const order = plan?.terms?.order || [];
  const k = order.find((s) => plan.steps[s]?.status !== "proven" || plan.steps[s]?.recheck);
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
    secondsLeft: left > 0n ? Number(left) : 0, expired: left <= 15n,
    text: [`gas at most ${formatUsd6(t.maxUsdcIn6)}`, `relay fee ${formatUsd6(t.fee6)}`, `total at most ${formatUsd6(t.totalMaximum6)}`,
      `grant balance ${formatUsd6(t.balance6)} -> at least ${formatUsd6(t.balance6 - t.totalMaximum6)}`] };
}

// ---- in-memory signatures and quotes: bound, single-use, dropped on any context change --------------------------------

export function createMemory() {
  let ctxKey = null;
  let signed = null;
  let quote = null;
  const api = {
    bind(ctx) { if (ctxKey !== ctx.key) { signed = null; quote = null; } ctxKey = ctx.key; },
    clear() { ctxKey = null; signed = null; quote = null; },
    holdSigned(ctx, plan, steps, bundle) {
      if (ctxKey !== ctx.key) fail("stale", "context changed");
      signed = { ctxKey, planId: plan.id, termsHash: plan.termsHash,
        digests: Object.fromEntries(steps.map((k) => [k, plan.steps[k].review.digest])), bundle };
    },
    /** The bundle only for the SAME context, plan, terms and the SAME digest of every signed step (still planned). */
    signedFor(ctx, plan) {
      if (!signed || ctxKey !== ctx.key || signed.ctxKey !== ctx.key || !plan) return null;
      if (signed.planId !== plan.id || signed.termsHash !== plan.termsHash) return null;
      for (const [k, d] of Object.entries(signed.digests)) if (plan.steps[k]?.review?.digest !== d) return null;
      return signed.bundle;
    },
    dropSigned() { signed = null; },
    holdQuote(ctx, record, deployment, review) {
      if (ctxKey !== ctx.key) fail("stale", "context changed");
      quote = { ctxKey, recordId: record.id, sid: lower(record.sid), deployment: lower(deployment), digest: review.call.digest,
        deadline: BigInt(review.call.execute.deadline), review };
    },
    /** Single use: returns the quote once, for the same context/record/deployment and >15 s before its deadline. */
    takeQuote(ctx, record, deployment, nowSec) {
      const q = quote;
      quote = null;
      if (!q || ctxKey !== ctx.key || q.ctxKey !== ctx.key || q.recordId !== record.id || q.sid !== lower(record.sid)
        || q.deployment !== lower(deployment)) return null;
      if (BigInt(nowSec) + 15n >= q.deadline) return null;
      return q.review;
    },
    get hasSigned() { return signed !== null; },
    get hasQuote() { return quote !== null; },
  };
  return api;
}
