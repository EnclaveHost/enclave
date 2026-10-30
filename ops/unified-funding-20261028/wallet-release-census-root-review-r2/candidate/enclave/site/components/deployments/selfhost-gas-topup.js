/* ============================================================
   Self-hosted Top up: a deployment whose ledger rate is 0 at one
   pinned block cannot take runtime funding (the ledger reverts
   FundRateTooLow), so its Top up spends this browser's OPEN gas
   grant on network gas instead: a fixed 200000000000000 wei ETH
   purchase (pool fee tier 100) through the qualified funding SDK.
   Staged candidate only; not installed in production.

   - Opening only reads: verifyRuntime, freshRecoveryScope, the
     grant record, a read-only reconcile of this grant's unresolved
     payments (once), then a quote. Nothing is signed or sent until
     "Pay from session" is clicked, and that click pays the exact
     quote that is on screen once (state.js memory: single use, same
     context / inputs / digest, > QUOTE_MARGIN_S before deadline).
   - The person's maximum (USDC, gas part) is a gate, never a debit:
     a quote whose gas maximum is above it cannot be paid. The grant's
     own per-payment caps bound the input; nothing widens a grant.
   - Every effect goes through flows.js guards (owner, chain,
     provider, and this panel being open); closing the panel or a
     wallet / chain change stops everything after it.
   - No new grant, signature prompt, deposit, migration, end,
     terminate, journal clear, claim hint or restart is ever made.

   Every dependency is injected (SDK namespace loader, state/flows
   loader, sessions config, relay root, wallet getter, timers, clock)
   so this module has no static imports and no Enclave singleton.
   ============================================================ */

export const FUNDING_SDK_URL = "/vendor/funding.funding-cutover-r1.69242be6e8d8d5d3.js";
// funding-quote-ux-release-r1/config.json funding.FUNDING_RUNTIME, verbatim (verifyRuntime re-proves it on chain).
export const FUNDING_RUNTIME_PINS = deepFreeze({
  schema: "enclave-funding-browser-runtime-r1",
  chainId: 8453,
  factory: "0x83616b7fA62F8a43cfc634a25c0aCFb0CCAB76e8",
  implementation: "0x9a869B2BA0D6FB4F297Eb140406478f0aed55F96",
  gasAdapter: "0xE5198b7BA033612C45c720d204C469D9ECe77D9e",
  legacyFactory: "0x1F5c887c0cDF491b16AB6c449abAfDF9B2ec9C9C",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  feeTiers: [100, 500, 3000],
  codehashes: {
    factory: "0xcea778eb9622f6423e8a2159c83ae5b696e81e5f22e87e8c285516e663b87e0f",
    implementation: "0x94c41042068ffe6b08f43b6cb9546b4b725c81a60010a201fc0c428382cb3a95",
    gasAdapter: "0xe3cb6aeac87a81b82653f71327fb517a30b23285907ea47a4049cec5a432cf10",
  },
  source: {
    kind: "deployed-receipts",
    deployTxs: [
      "0x91da584b22366f81b1174d8b73571bd6a34ba54f721b8476b2e25fcf420ce6b6",
      "0xa394688c44c411a5129fd94fe590957214431fee1c95f54959ce5073c0407160",
      "0xc9ab30f239ceffac08344577b6238a4c16e65fcf36a59dde6c714abc098efc29",
      "0x9c0328c93b8c28c6c78a5bf94a9b7482aa5eca7034469a78634ff88ae60dbaad",
    ],
    reviewedBy: "root: four deployed receipts verified; public live funding runtime pins verified 2026-10-29T01:57:05Z",
  },
});
export const GAS_ETH_OUT = "200000000000000";      // the approved fixed gas purchase (wei)
export const GAS_FEE_TIER = "100";
export const DEFAULT_BUDGET = "0.60";               // USDC, gas part; clamped to the grant's maxGasUsdcPerOp
export const QUOTE_DEBOUNCE_MS = 600;
const CHAIN = 8453;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-f]{40}$/;

function deepFreeze(o) { Object.values(o).forEach((v) => { if (v && typeof v === "object") deepFreeze(v); }); return Object.freeze(o); }
const lower = (a) => String(a ?? "").toLowerCase();
const plainEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const errText = (e) => `${e?.code ? `${e.code}: ` : ""}${e?.message ?? String(e)}`;

// A non-literal specifier keeps the vendor file a runtime import (the bundler leaves it alone).
const defaultLoadSdk = () => { const url = FUNDING_SDK_URL; return import(/* @vite-ignore */ url); };
const defaultLoadFunding = async () => {
  const [state, flows] = await Promise.all([import("../../js/funding/state.js"), import("../../js/funding/flows.js")]);
  return { state, flows };
};

/** The API's per-second rate as a number; 0 stays 0, only an absent value is NaN (never `|| fallback`). */
export const apiRatePerSecond = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

/** Which Top up a row gets. Non-bytes32 ids keep the legacy panel untouched; ledger rows are routed by the
 *  pinned-block snapshot (depSnapshot) only: "runtime" (rate > 0), "gas" (rate 0, wallet / session-vault row),
 *  "unsupported" (rate 0 on a credit-vault row: credit is never converted into gas), "missing", "unknown". */
export function topupRoute(id, snap, via) {
  if (!BYTES32.test(lower(id))) return "legacy";
  if (snap === null) return "missing";
  const rate = snap && typeof snap === "object" && /^(0x[0-9a-f]+|[0-9]+)$/i.test(String(snap.rate)) ? Number(snap.rate) : NaN;
  if (!Number.isFinite(rate) || rate < 0 || (!Number.isSafeInteger(Number(snap.blockTimestamp)) || Number(snap.blockTimestamp) <= 0 || !Number.isSafeInteger(Number(snap.blockNumber)) || Number(snap.blockNumber) <= 0)) return "unknown";
  if (rate > 0) return "runtime";
  return via ? "unsupported" : "gas";
}

/** "0.60" -> 600000n; null unless a plain decimal with at most 6 places. */
export function parseBudget6(text) {
  const m = /^(0|[1-9][0-9]{0,5})(?:\.([0-9]{1,6}))?$/.exec(String(text ?? "").trim());
  return m ? BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0")) : null;
}
const budgetText = (v6) => { const s = (BigInt(v6) % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, ""); return `${BigInt(v6) / 1_000_000n}.${s.length < 2 ? s.padEnd(2, "0") : s}`; };

const GRANT_TEXT = {
  matching_grant_not_open: "No open gas grant in this browser names this deployment's app, so there is nothing to pay from.",
  matching_grant_ambiguous: "More than one open gas grant in this browser names this app; the Top up will not choose between them.",
  deployment_out_of_scope: "This deployment is not in the freshly checked scope of your gas grants.",
  scope_holder_foreign: "This deployment is held by another account (for example a credit vault), not by this wallet or its session vault. Gas top up is not supported for it here; account credit is never converted into network gas.",
  scope_app_unresolvable: "This deployment runs no catalog app, so no gas grant can name it.",
  scope_not_adopted: "This deployment is in your session vault but not adopted, so no gas grant can pay for it.",
  scope_missing: "This deployment is not on the ledger.",
};
const NO_GRANT = new Set(Object.keys(GRANT_TEXT));

/** The controller: no DOM. `view(state)` receives every state; the DOM binding below is one such view. */
export function createSelfHostedGasTopup(o) {
  const { id, snapshot, live, sessionsConfig, relayRoot, rpcFallback, view } = o;
  const dep = lower(id);
  const pins = o.pins ?? FUNDING_RUNTIME_PINS;
  const loadSdk = o.loadSdk ?? defaultLoadSdk;
  const loadFunding = o.loadFunding ?? defaultLoadFunding;
  const nowS = o.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const T = o.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t), every: (fn, ms) => setInterval(fn, ms), stop: (t) => clearInterval(t) };
  const isOpen = o.isOpen ?? (() => true);
  const onDone = o.onDone ?? (() => {});

  let f = null, ST = null, FL = null, store = null, memory = null;
  let base = null;            // { owner, ctx } of the first verified context; every later one must have the same key
  let grant = null;           // { id, label, cap6, feeCap6 } of the selected open record
  let bound = null;           // the held quote's binding: { digest, budget6, inputs, fc, scope }
  let budget = o.budget ?? DEFAULT_BUDGET, userBudget = o.budget !== undefined;
  let closed = false, dead = false, paying = false;
  let seq = 0, debounce = null, ticker = null, busy = Promise.resolve();
  let state = null;

  const open = () => !closed && !dead && isOpen();
  // flows.js guard snapshot; a closed panel is epoch NaN, so a guard taken or checked after close is never alive
  const read = () => { const l = live() || {}; return { epoch: open() ? 1 : NaN, owner: l.owner || "", chainId: l.chainId, provider: l.provider }; };
  const sameOwner = () => !!base && lower(live()?.owner) === base.ctx.owner && Number(live()?.chainId) === CHAIN && live()?.provider === base.provider;
  const usd = (v) => ST.formatUsd6(v);
  const emit = (s) => {
    if (closed || dead) return;
    state = Object.freeze({ phase: "checking", text: "", payEnabled: false, canRefresh: false, canCheck: false, inputEnabled: false, ...s,
      budget, cap: grant ? budgetText(grant.cap6) : null });
    view(state);
  };
  const stopTick = () => { if (ticker !== null) { T.stop(ticker); ticker = null; } };
  const stopDebounce = () => { if (debounce !== null) { T.clear(debounce); debounce = null; } };
  const drop = () => { stopTick(); memory?.dropQuote(); bound = null; };
  const changed = () => {
    drop(); stopDebounce();
    emit({ phase: "changed", text: "The wallet, network or this panel changed. Close and reopen Top up; nothing more is signed or sent from this panel." });
    dead = true;
    memory?.clear();
  };
  const run = (fn) => (busy = busy.then(fn, fn));       // one async step at a time, in order

  async function freshContext(owner, g) {
    const cfg = await sessionsConfig().catch(() => null);
    if (!cfg || !cfg.book) throw Object.assign(new Error("sessions are not available on this API endpoint"), { code: "sessions_unavailable" });
    const relayBase = String(relayRoot());
    const rpc = f.jsonRpc(cfg.rpc || rpcFallback);
    const relay = f.relayClient(relayBase);
    const runtime = await f.verifyRuntime({ pins, rpc, relay, owner, now: nowS() });
    g.check("checking the gas grant");
    const ctx = ST.contextOf({ owner, chainId: CHAIN, vault: runtime.cfg.vault, legacyVault: runtime.cfg.legacyVault, relay: relayBase });
    if (base && ctx.key !== base.ctx.key) throw new ST.StateError("context_mismatch", "the fresh check names another wallet, network, vault or relay; nothing was quoted");
    return { cfg, rpc, relay, relayBase, runtime, ctx };
  }

  /** Fresh context + scope, the grant, (optionally) one read-only reconcile, then a read-only quote. */
  async function evaluate(reconcile) {
    const my = ++seq;
    drop();
    const g = FL.createGuard(read);
    if (!g.alive() || (base && !sameOwner())) return changed();
    const owner = base ? base.owner : lower(read().owner);
    const current = () => my === seq && g.alive();
    emit({ phase: "checking", text: "Checking the ledger, your gas grant and the relay. Nothing is signed or paid." });
    try {
      const fc = await freshContext(owner, g);
      if (!current()) return g.alive() ? undefined : changed();
      if (!base) { base = { owner, ctx: fc.ctx, provider: g.at.provider }; memory = ST.createMemory(); memory.bind(fc.ctx); }
      const holder = lower(snapshot.owner);
      if (holder !== owner && holder !== lower(fc.runtime.cfg.legacyVault)) {
        return emit({ phase: "unsupported", text: GRANT_TEXT.scope_holder_foreign + " Nothing was signed or paid." });
      }
      if (!fc.runtime.intake) {
        return emit({ phase: "unavailable", canRefresh: true,
          text: `New gas funding is paused (${fc.runtime.intakeWhy || "intake off"}). Nothing was signed or paid.` });
      }
      if (!fc.runtime.intake.feeTiers.map(Number).includes(Number(GAS_FEE_TIER))) {
        return emit({ phase: "unavailable", text: `The relay does not offer pool fee tier ${GAS_FEE_TIER}. Nothing was signed or paid.` });
      }
      const records = ST.selectOwnRecords(await store.listKeys(), fc.ctx).filter((r) => r.status === "open");
      const scope = await f.freshRecoveryScope({ rpc: fc.rpc, book: fc.cfg.book, owner, legacyVault: fc.runtime.cfg.legacyVault,
        deploymentIds: [dep], now: nowS() });
      if (!current()) return g.alive() ? undefined : changed();
      const record = f.selectGasRecord(records, scope, dep);
      const gt = record.grant || {};
      if (gt.expiresAt !== undefined && BigInt(gt.expiresAt) <= nowS()) {
        return emit({ phase: "no_grant", text: `Your gas grant "${record.label || record.id}" has expired. Nothing was signed or paid.` });
      }
      if (BigInt(GAS_ETH_OUT) > BigInt(gt.maxEthPerOp)) {
        return emit({ phase: "no_grant", text: `Your gas grant allows at most ${gt.maxEthPerOp} wei per payment; this Top up buys ${GAS_ETH_OUT} wei. Grant limits are never raised. Nothing was signed or paid.` });
      }
      grant = { id: record.id, label: record.label || "Gas grant", cap6: BigInt(gt.maxGasUsdcPerOp), feeCap6: BigInt(gt.maxFeePerOp) };
      if (!userBudget) { const d6 = parseBudget6(DEFAULT_BUDGET); budget = budgetText(d6 > grant.cap6 ? grant.cap6 : d6); }
      let blockers = f.executionBlockers(await store.listJournal(), record);
      if (blockers.length && reconcile) {
        emit({ phase: "checking", text: "An earlier gas payment of this grant is not resolved; checking it on chain (read-only, never resent)." });
        for (const b of blockers) {
          try { await f.reconcileGasExecution({ runtime: fc.runtime, store: FL.guardGasStore(store, g), rpc: fc.rpc,
            relay: FL.guardRelayFn(fc.relay, g), relayBase: fc.relayBase, id: b.id }); } catch { /* stays reserved; shown below */ }
          if (!current()) return g.alive() ? undefined : changed();
        }
        blockers = f.executionBlockers(await store.listJournal(), record);
      }
      if (!current()) return g.alive() ? undefined : changed();
      if (blockers.length) {
        return emit({ phase: "blocked", canCheck: true, executions: blockers.map((b) => ({ id: b.id, status: b.status })),
          text: `An earlier gas payment of this grant is ${blockers.map((b) => b.status).join(", ")} and is never resent. A new payment waits until a status check resolves it.` });
      }
      return await quote(fc, scope, g, my);
    } catch (e) {
      if (!g.alive()) return changed();
      if (my !== seq) return;
      if (NO_GRANT.has(e?.code)) return emit({ phase: e.code === "scope_holder_foreign" ? "unsupported" : "no_grant", text: `${GRANT_TEXT[e.code]} Nothing was signed or paid.` });
      if (e?.code === "unreconciled_execute") return emit({ phase: "blocked", canCheck: true, text: "An earlier gas payment of this grant is not resolved and is never resent. Check its status first." });
      return emit({ phase: "unavailable", canRefresh: true, inputEnabled: !!grant,
        text: `The gas top up could not be checked (${errText(e)}). Nothing was signed or paid.` });
    }
  }

  async function quote(fc, scope, g, my) {
    const b6 = parseBudget6(budget);
    if (b6 === null || b6 === 0n || b6 > grant.cap6) return invalidBudget();
    const inputs = ST.quoteInputsOf({ deployment: dep, ethOut: GAS_ETH_OUT, feeTier: GAS_FEE_TIER });
    emit({ phase: "quoting", inputEnabled: true, text: "Getting a read-only quote. Nothing is signed or paid." });
    const q = await FL.quoteFlow({ g, memory, ctx: fc.ctx, inputs, store, scope, core: f,
      quoteArgs: { runtime: fc.runtime, relay: FL.guardRelayFn(fc.relay, g) }, now: nowS });
    if (my !== seq || parseBudget6(budget) !== b6) { memory.dropQuote(); return; }    // superseded by a newer input
    bound = { digest: q.digest, recordId: q.recordId, budget6: b6, inputs, fc, scope };
    if (my !== seq || !g.alive() || !bound) { drop(); return; }
    show();
    if (bound) ticker = T.every(() => { if (!open() || !sameOwner()) return changed(); show(true); }, 1000);
  }

  function invalidBudget() {
    drop();
    return emit({ phase: "invalid_budget", inputEnabled: true,
      text: `Enter a maximum for gas between $0.000001 and ${usd(grant.cap6)} (your grant's per-payment gas cap). Nothing is quoted or paid.` });
  }

  /** Render the held quote; once it no longer fits (expired, inputs, context) it is dropped and only a refresh is offered. */
  function show(fromTick) {
    const b = bound;
    const q = b && memory.peekQuote(b.fc.ctx, b.inputs, nowS());
    if (!q || q.digest !== b.digest) {
      drop();
      return emit({ phase: "expired", canRefresh: true, inputEnabled: true,
        text: `This quote expired (it must be used at least ${ST.QUOTE_MARGIN_S}s before its deadline). Nothing was signed or sent. Refresh the quote to pay.` });
    }
    const qv = ST.quoteView(q.review, nowS());
    const t = q.review.totals;
    const over = t.maxUsdcIn6 > b.budget6;
    const usable = Math.max(0, qv.secondsLeft - Number(ST.QUOTE_MARGIN_S));
    const detail = {
      ethOut: GAS_ETH_OUT, feeTier: GAS_FEE_TIER, grant: grant.label, digest: q.digest,
      gasMax: usd(t.maxUsdcIn6), fee: usd(t.fee6), total: usd(t.totalMaximum6), balance: usd(t.balance6),
      balanceAfter: usd(t.balance6 - t.totalMaximum6), budget: usd(b.budget6), cap: usd(grant.cap6), feeCap: usd(grant.feeCap6), usable,
    };
    if (!fromTick || state?.phase !== (over ? "over_budget" : "ready") || state?.quote?.usable !== usable) {
      emit({ phase: over ? "over_budget" : "ready", quote: Object.freeze(detail), canRefresh: true, inputEnabled: true,
        payEnabled: !over && !paying && usable > 0 && parseBudget6(budget) === b.budget6,
        text: over
          ? `This quote needs up to ${detail.gasMax} for gas, above your maximum ${detail.budget}. Raise the maximum (up to ${detail.cap}) or refresh later. Nothing was signed or paid.`
          : `Pays at most ${detail.total} from "${detail.grant}": gas at most ${detail.gasMax} + relay fee ${detail.fee}. The actual debit (real swap cost + fee) is shown after payment and never exceeds that. Usable for ${usable}s.` });
    }
  }

  /** Pays the quote whose digest was on screen at the click, once; anything else re-renders and pays nothing. */
  async function pay(shownDigest) {
    if (paying || !open() || !bound || !memory) return;
    const g = FL.createGuard(read);
    if (!g.alive() || !sameOwner()) return changed();
    const b = bound;
    const b6 = parseBudget6(budget);
    const q = memory.peekQuote(b.fc.ctx, b.inputs, nowS());
    if (!shownDigest || shownDigest !== b.digest || b6 === null || b6 !== b.budget6 || !q || q.digest !== b.digest
      || q.review.totals.maxUsdcIn6 > b6) return show();
    paying = true;
    stopTick(); stopDebounce(); seq += 1;                 // nothing in flight may replace this payment's outcome
    bound = null;
    const shown = state?.quote;
    emit({ phase: "paying", quote: shown, text: `Paying this exact quote once (at most ${shown?.total ?? ""}). Do not close this panel.` });
    try {
      // fundFlow takes the held quote once (same context, record, inputs, digest, margin) and confirmGasFund signs it with
      // this browser's non-extractable gas key through the guarded store / relay; dispatchGuard runs right before send.
      if (o.getSnapshot) {
        const currentSnapshot = await o.getSnapshot();
        g.check("checking the current deployment rate");
        if (topupRoute(dep, currentSnapshot, false) !== "gas") throw new Error("The deployment rate changed. Reopen Top up before paying.");
      }
      const r = await FL.fundFlow({ g, memory, ctx: b.fc.ctx, inputs: b.inputs, shownDigest: b.digest, store, scope: b.scope, core: f,
        fundArgs: { runtime: b.fc.runtime, relay: b.fc.relay, rpc: b.fc.rpc, relayBase: b.fc.relayBase,
          dispatchGuard: () => g.check("sending the payment") }, now: nowS });
      const debit = r.settlement?.actual?.totalDebit6;
      if (r.pending) emit({ phase: "pending", canCheck: true, quote: shown, text: "Sent; not on chain yet. It is never resent. Check its status (read-only) before another payment." });
      else if (r.status === "settled") emit({ phase: "paid", canRefresh: true, quote: shown, refreshLabel: "New quote",
        text: `Paid ${usd(debit)} from your gas grant (at most ${shown?.total ?? ""} was allowed); final on chain. It bought network gas for this deployment; it does not change its runtime.` });
      else emit({ phase: "observed", canCheck: true, quote: shown,
        text: `Paid ${usd(debit)} (on chain, not final yet). A status check must prove finality before another payment.` });
      try { onDone(r); } catch { /* the caller's hook; never a payment */ }
      return r;
    } catch (e) {
      if (!g.alive()) return changed();
      emit({ phase: "error", canCheck: true, canRefresh: true, inputEnabled: true,
        text: `The payment did not complete (${errText(e)}). It is never resent; check its status before trying again.` });
    } finally {
      paying = false;
      memory?.dropQuote();
    }
  }

  function setBudget(text) {
    if (paying || !open()) return;
    budget = String(text ?? "");
    userBudget = true;
    seq += 1;                                              // an in-flight quote for the old maximum is discarded
    drop(); stopDebounce();
    if (!grant) return;
    const b6 = parseBudget6(budget);
    if (b6 === null || b6 === 0n || b6 > grant.cap6) return invalidBudget();
    emit({ phase: "quoting", inputEnabled: true, text: "Maximum changed; the previous quote was dropped. Refreshing the quote (read-only)." });
    debounce = T.set(() => { debounce = null; run(() => evaluate(false)); }, QUOTE_DEBOUNCE_MS);
  }

  return {
    start: () => run(async () => {
      if (!open()) return;
      const l = live() || {};
      if (!ADDR.test(lower(l.owner))) return emit({ phase: "unavailable", text: "Connect the owner wallet to pay from its gas grant. Nothing was signed or paid." });
      if (Number(l.chainId) !== CHAIN) return emit({ phase: "unavailable", text: "Switch your wallet to Base to pay from its gas grant. Nothing was signed or paid." });
      if (topupRoute(dep, snapshot, false) !== "gas") return emit({ phase: "unavailable", text: "This deployment is not confirmed zero-rate on chain; reopen Top up to check its current rate." });
      emit({ phase: "checking", text: "Loading the funding client. Nothing is signed or paid." });
      try {
        f = await loadSdk();
        ({ state: ST, flows: FL } = await loadFunding());
        store = o.store ?? new f.IndexedDbV2Store();
      } catch (e) { return emit({ phase: "unavailable", text: `The funding client could not load (${errText(e)}). Nothing was signed or paid.` }); }
      return evaluate(true);
    }),
    pay: () => { const d = state?.phase === "ready" ? state.quote?.digest : null; return run(() => pay(d)); },
    refresh: () => (paying || !open() || !f ? busy : run(() => evaluate(false))),
    check: () => (paying || !open() || !f ? busy : run(() => evaluate(true))),
    setBudget,
    close() { closed = true; drop(); stopDebounce(); memory?.clear(); },
    idle: () => busy,
    get state() { return state; },
  };
}

/** The DOM binding used by <c-deployments> `_fund`: fills `box` (the row's .enc-fund) and returns { close }. */
export function mountSelfHostedGasTopup(opts) {
  const { box, id } = opts;
  const esc = opts.esc ?? plainEsc;
  const paint = opts.paint ?? ((el, cls, txt) => { const s = document.createElement("span"); s.className = "ln " + cls; s.textContent = txt; el.appendChild(s); });
  box.hidden = false;
  box.innerHTML = '<div class="ap-attbar">top up · ' + esc(id) + '</div>'
    + '<div class="enc-fund-body">'
    +   '<p class="ef-gas-intro">Self-hosted runtime is free: the ledger charges this deployment no runtime right now (rate 0, re-read each time this opens). '
    +   'USDC from your gas grant buys ETH for on-chain transactions. Gas funding does not promise a fixed number of runtime hours.</p>'
    +   '<label for="efGasMax">Maximum for gas (USDC)</label>'
    +   '<input class="ef-gas-max" id="efGasMax" type="text" value="' + esc(DEFAULT_BUDGET) + '" inputmode="decimal" disabled />'
    +   '<button class="btn btn-sm btn-primary ef-go" type="button" disabled>Pay from session</button>'
    +   '<button class="btn btn-sm ef-gas-refresh" type="button" hidden>Refresh quote</button>'
    +   '<button class="btn btn-sm ef-gas-check" type="button" hidden>Check status (read-only)</button>'
    + '</div>'
    + '<details class="ef-gas-details" hidden><summary>quote details</summary><div class="ef-gas-detail"></div></details>'
    + '<div class="term enc-fund-status" role="status" aria-live="polite"></div>';
  const max = box.querySelector(".ef-gas-max"), go = box.querySelector(".ef-go");
  const again = box.querySelector(".ef-gas-refresh"), check = box.querySelector(".ef-gas-check");
  const details = box.querySelector(".ef-gas-details"), detail = box.querySelector(".ef-gas-detail");
  const st = box.querySelector(".enc-fund-status");
  const WARN = new Set(["unavailable", "unsupported", "no_grant", "blocked", "error", "changed", "expired", "over_budget", "invalid_budget"]);
  const view = (s) => {
    if (!box.isConnected) return;
    if (document.activeElement !== max) max.value = s.budget;
    max.disabled = !s.inputEnabled;
    if (s.cap) max.title = "at most $" + s.cap + " (your grant's per-payment gas cap)";
    go.disabled = !s.payEnabled;
    again.hidden = !s.canRefresh; again.textContent = s.refreshLabel || "Refresh quote";
    check.hidden = !s.canCheck;
    const q = s.quote;
    details.hidden = !q;
    if (q) detail.innerHTML = '<div>Fixed gas purchase: <code>' + esc(q.ethOut) + '</code> wei (0.0002 ETH) · pool fee tier ' + esc(q.feeTier) + '</div>'
      + '<div>Gas at most ' + esc(q.gasMax) + ' (your maximum ' + esc(q.budget) + ', grant cap ' + esc(q.cap) + ') · relay fee ' + esc(q.fee) + ' (grant cap ' + esc(q.feeCap) + ')</div>'
      + '<div>Total debit at most ' + esc(q.total) + ' from "' + esc(q.grant) + '" · grant balance ' + esc(q.balance) + ' → at least ' + esc(q.balanceAfter) + '</div>'
      + '<div>Call <code>' + esc(q.digest.slice(0, 18)) + '…</code></div>';
    st.innerHTML = "";
    paint(st, WARN.has(s.phase) ? "warn" : s.phase === "paid" ? "ok" : "info", s.text);
  };
  const c = createSelfHostedGasTopup({ ...opts, view, isOpen: () => box.isConnected && !box.hidden && (!opts.isCurrent || opts.isCurrent()) });
  max.addEventListener("input", () => c.setBudget(max.value));
  go.addEventListener("click", () => { go.disabled = true; c.pay(); });
  again.addEventListener("click", () => c.refresh());
  check.addEventListener("click", () => c.check());
  c.start();
  return { close: () => c.close(), controller: c };
}
