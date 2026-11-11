// Automatic lease-gas refill from the owner's USDC (docs/unified-funding.md, "Required settlement paths": USDC -> lease
// gas). A daemon (cli/gas-refill.mjs) holds ONE gas session whose grant the owner signed for exactly these apps; each
// pass it reads every app's EnclaveLeaseGasReserve balance and, when one has less than `lowDays` of renewals left, buys
// it ETH with the session's USDC through the existing gas.fund route (gas-execution.mjs quoteGasFund + confirmGasFund:
// relay quote, codec re-derivation, session-key signature, vault execute, canonical settlement proof).
//
// Limits, in the order they bind:
//   - the vault enforces the signed grant: apps, budget, spend and ops per period, per-op gas/fee/price caps, expiry;
//   - quoteGasFund refuses a quote above those caps or the session's balance (it never raises a cap);
//   - this module pays at most ONE refill per pass, never while any execution of the session is unresolved, and
//     reconciles unresolved ones read-only first (an unknown outcome is never resent: gas-execution.mjs rule 4).
// Nothing here signs as the owner. Opening the session (the grant + USDC deposit) is the owner's wallet action.
import { buildGrantV2, MAX_GRANT_APPS, parseHex32, parseUint, ZERO_HASH } from "../funding/funding-codec.mjs";
import { fail, lower } from "../funding/util.mjs";
import * as X from "../funding/gas-execution.mjs";

/** Hard ceilings for a refill grant: a config can choose lower terms, never higher ones. */
export const REFILL_LIMITS = Object.freeze({
  budget6: 30_000_000n,              // 30 USDC deposited into the session at open (migration.mjs MAX_COMBINED6)
  spendPerPeriod6: 5_000_000n,       // 5 USDC per period
  opsPerPeriod: 24n,
  maxGasUsdcPerOp: 2_000_000n,       // 2 USDC swap input per refill
  maxFeePerOp: 200_000n,             // 0.20 USDC relay fee per refill
  maxUsdcPerEth6: 10_000_000_000n,   // never pay more than 10,000 USDC per ETH
  maxEthPerOp: 1_000_000_000_000_000n,
  days: 366,
});

/** Default terms: at most 0.0002 ETH per refill (~3 days of one app's renewals at 0.006 gwei), 3 USDC/day across the apps. */
export const REFILL_DEFAULTS = Object.freeze({
  budget6: 10_000_000n, spendPerPeriod6: 3_000_000n, periodSeconds: 86_400n, opsPerPeriod: 12n,
  maxGasUsdcPerOp: 1_000_000n, maxFeePerOp: 100_000n, maxUsdcPerEth6: 5_000_000_000n, maxEthPerOp: 200_000_000_000_000n,
  days: 90,
});

export const REFILL_PRESET = "gas-refill";

/** Grant terms = defaults overlaid by `terms`, each checked against REFILL_LIMITS. Pure. */
export function refillTerms(terms = {}) {
  const t = { ...REFILL_DEFAULTS };
  for (const [k, v] of Object.entries(terms)) {
    if (!(k in REFILL_DEFAULTS)) fail("refill_term_unknown", `unknown refill term ${k}`);
    t[k] = k === "days" ? Number(v) : BigInt(v);
  }
  for (const k of Object.keys(REFILL_LIMITS)) {
    const v = t[k], max = REFILL_LIMITS[k];
    if (k === "days" ? !(Number.isInteger(v) && v >= 1 && v <= max) : !(v > 0n && v <= max)) {
      fail("refill_term_range", `${k} must be 1..${max}, got ${v}`);
    }
  }
  if (t.spendPerPeriod6 > t.budget6) fail("refill_term_range", "spendPerPeriod6 may not exceed the budget");
  if (t.maxGasUsdcPerOp + t.maxFeePerOp > t.spendPerPeriod6) fail("refill_term_range", "one refill (gas + fee) must fit in a period's spend");
  if (t.periodSeconds < 3_600n) fail("refill_term_range", "periodSeconds must be at least an hour");
  return Object.freeze(t);
}

/** The owner's grant for a refill session over `appIds` (catalog app ids). Typed data + digest only; signing is the wallet's. */
export function buildRefillGrant(cfg, { now, sessionKey, appIds, grantNonce, signBefore, label = "Automatic gas refill", terms }) {
  const t = refillTerms(terms);
  if (!Array.isArray(appIds) || appIds.length === 0 || appIds.length > MAX_GRANT_APPS) fail("gas_scope_apps", `1..${MAX_GRANT_APPS} app ids required`);
  const apps = [...new Set(appIds.map((a, k) => parseHex32(lower(a), `appIds[${k}]`, { nonZero: true })))].sort();
  if (apps.length !== appIds.length) fail("gas_scope_apps", "app ids must be distinct");
  if (t.maxEthPerOp > cfg.adapterMaxEthOut) fail("refill_term_range", `maxEthPerOp exceeds the adapter's maxEthOut ${cfg.adapterMaxEthOut}`);
  const n = parseUint(now, 64, "now");
  const grant = {
    label: String(label), preset: REFILL_PRESET, sessionKey, actions: ["gas.fund"], apps, environments: ["staging", "prod"],
    budget: t.budget6, spendPerPeriod: t.spendPerPeriod6, periodSeconds: t.periodSeconds, opsPerPeriod: t.opsPerPeriod,
    maxFeePerOp: t.maxFeePerOp, maxAppFeePerHour: 0n, maxRatePerHour: 0n,
    maxGasUsdcPerOp: t.maxGasUsdcPerOp, maxUsdcPerEth6: t.maxUsdcPerEth6, maxEthPerOp: t.maxEthPerOp,
    expiresAt: n + BigInt(t.days) * 86_400n, measurement: ZERO_HASH, grantNonce, signBefore,
  };
  const built = buildGrantV2(cfg, { domainVersion: "2", now: n, grant });
  if (built.actionsMask !== 1n << 10n || !built.gasFundGranted) fail("gas_grant_shape", "a refill grant is exactly gas.fund");
  return built;
}

/**
 * Does this reserve need ETH now, and how much? Pure.
 *   balanceWei   the reserve's balance for the deployment's owner of record
 *   renewWei     one sponsored renew at the current gas price (lease-executor-client quote)
 *   claimWei     one sponsored claim (a lapsed lease is re-claimed first)
 *   leaseSec     the ledger's lease length: a rate-0 lease renews about once per leaseSec
 *   lowDays      refill when fewer days than this are left;  targetDays  refill up to this many
 *   maxEthPerOp  the grant's per-op cap (one refill never buys more)
 */
export function refillNeed({ balanceWei, renewWei, claimWei, leaseSec, lowDays = 2, targetDays = 7, maxEthPerOp, leaseLive = true }) {
  const bal = BigInt(balanceWei), renew = BigInt(renewWei), claim = BigInt(claimWei), lease = BigInt(leaseSec), cap = BigInt(maxEthPerOp);
  if (renew <= 0n || lease <= 0n || cap <= 0n || !(lowDays > 0) || !(targetDays > lowDays)) fail("refill_need_inputs", "bad refill inputs");
  const perDay = (86_400n * renew + lease - 1n) / lease;
  const start = leaseLive ? 0n : claim;                          // a lapsed lease needs its claim paid before any renew
  const days = (d) => start + (perDay * BigInt(Math.round(d * 1000))) / 1000n;
  const low = days(lowDays), target = days(targetDays);
  const runwayDays = bal <= start ? 0 : Number(((bal - start) * 1000n) / perDay) / 1000;
  if (bal >= low) return Object.freeze({ due: false, perDayWei: perDay, runwayDays, ethOut: 0n });
  const want = target - bal;
  return Object.freeze({ due: true, perDayWei: perDay, runwayDays, ethOut: want < cap ? want : cap });
}

/**
 * One refill pass. Deps (all injected, so tests drive it without a relay or chain):
 *   runtime, store, record, relay, relayBase, rpc, subtle   as gas-execution.mjs takes them
 *   scopeOf()            -> freshRecoveryScope(...) for the configured deployments (re-read every pass)
 *   reserveOf(id)        -> { balanceWei, renewWei, claimWei, leaseSec, leaseLive }
 *   policy               { lowDays, targetDays, feeTier }
 *   now()                -> bigint seconds
 *   api                  { reconcile, quote, confirm } (defaults: gas-execution.mjs)
 * Returns { action: "blocked" | "idle" | "paid" | "pending" | "refused", ... } describing what happened. It throws only
 * for a fault before any payment was dispatched.
 */
export async function refillOnce({ runtime, store, record, relay, relayBase, rpc, subtle, scopeOf, reserveOf, policy = {}, now,
  api = { reconcile: X.reconcileGasExecution, quote: X.quoteGasFund, confirm: X.confirmGasFund }, log = () => {} }) {
  const lowDays = policy.lowDays ?? 2, targetDays = policy.targetDays ?? 7, feeTier = policy.feeTier ?? 100;
  if (!record || record.status !== "open") return { action: "blocked", why: "the refill session is not open (the owner opens it)" };
  if (BigInt(record.grant.expiresAt) <= now()) return { action: "blocked", why: "the refill grant expired; the owner opens a new one" };

  // 1. Anything unresolved is reconciled read-only; still unresolved -> no new spend this pass.
  let blockers = X.executionBlockers(await store.listJournal(), record);
  for (const b of blockers) {
    try {
      const r = await api.reconcile({ runtime, store, rpc, relay, relayBase, id: b.id });
      log(`reconcile ${b.id}: ${r.verdict ?? r.status}`);
    } catch (e) { log(`reconcile ${b.id} failed: ${e.code ?? ""} ${e.message}`); }
  }
  blockers = X.executionBlockers(await store.listJournal(), record);
  if (blockers.length) return { action: "blocked", why: "an earlier refill is unresolved; it is never resent", ids: blockers.map((b) => b.id) };

  // 2. Fresh scope and reserves; the lowest runway is refilled first, one per pass.
  const scope = await scopeOf();
  const apps = new Set(record.grant.apps.map(lower));
  const cap = BigInt(record.grant.maxEthPerOp);
  const rows = [];
  for (const [id, d] of scope.deployments) {
    if (!apps.has(lower(d.appId))) { rows.push({ id, skipped: "app not in the refill grant" }); continue; }
    if (d.active === false) { rows.push({ id, skipped: "deployment inactive" }); continue; }
    const r = await reserveOf(id);
    rows.push({ id, ...refillNeed({ ...r, lowDays, targetDays, maxEthPerOp: cap }), balanceWei: BigInt(r.balanceWei) });
  }
  const due = rows.filter((r) => r.due).sort((a, b) => a.runwayDays - b.runwayDays);
  if (!due.length) return { action: "idle", rows };
  const pick = due[0];

  // 3. Quote, then pay exactly that quote once.
  let q;
  try {
    q = await api.quote({ runtime, record, relay, scope, deployment: pick.id, ethOut: pick.ethOut, feeTier, now: now(),
      journalEntries: await store.listJournal() });
  } catch (e) { return { action: "refused", stage: "quote", id: pick.id, code: e.code ?? null, why: e.message, rows }; }
  log(`refill ${pick.id.slice(0, 10)}: ${pick.ethOut} wei for at most ${q.totals.totalMaximum6} USDC6 (runway ${pick.runwayDays} d)`);
  try {
    const r = await api.confirm({ runtime, store, record, review: q, relay, relayBase, rpc, now: now(), subtle });
    if (r.pending) return { action: "pending", id: pick.id, txHash: r.txHash ?? null, rows };
    return { action: "paid", id: pick.id, txHash: r.txHash, actual: r.settlement?.actual ?? null, rows };
  } catch (e) {
    // gas-execution journals the outcome itself (refused / unknown); an unknown one blocks the next pass until reconciled.
    return { action: "refused", stage: "execute", id: pick.id, code: e.code ?? null, why: e.message, rows };
  }
}
