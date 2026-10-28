/* ============================================================
   UNREVIEWED SOURCE (unified-funding client-repair-r2).
   /funding: owner controls, resumable budget migration and
   successor gas.fund, on the SAME origin as /sessions so the
   legacy non-extractable IndexedDB key ("enclave-sessions") is
   used in place, never exported.

   Nothing signs or submits on load or connect: every wallet
   prompt, session-key signature and relay submission is behind a
   click. Owner controls render FIRST and independently: they need
   only the parsed pins (no network) or a stored gas record, never
   the relay config, intake, catalog or recovery scope.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import { Enclave, WALLET_SESSION_KEY } from "../core/api.js";
import { connectWallet } from "../core/wallet.js";
import { $, esc, lsGet, lsSet, emit, on, showToast } from "../core/util.js";
import { sdk, sessionsConfig, relayRoot, accountFromSession } from "../core/sessions.js";
import { APP_CATALOG_RPCS, FUNDING_RUNTIME, FUNDING_MIGRATION_APPROVAL, FUNDING_RECOVERY_DEPLOYMENTS } from "../core/config.js";

let F = null;
const fundingLib = async () => (F ??= await import("/vendor/funding.js"));
const now = () => BigInt(Math.floor(Date.now() / 1000));
const lower = (a) => String(a || "").toLowerCase();
const show = (v) => esc(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
const errText = (e) => `<code>${esc(e?.code || "error")}</code> ${esc(e?.message || String(e))}`;
const STEPS = ["terminate", "legacyOpen", "gasOpen"];

// in memory only: signatures never reach storage
const M = { ctx: null, signed: null, quote: null, busy: false };

async function guard(fn, after){
  if (M.busy) return;
  M.busy = true;
  try { const out = await fn(); if (out !== undefined) showToast("Done"); if (after) await after(); }
  catch(e){ showToast((e.code ? e.code + ": " : "") + e.message); }
  finally { M.busy = false; }
}

async function mount(){
  const b = $("#fdBody");
  if (!b) return;
  if (!Enclave.address){
    b.innerHTML = `<p>Connect the owner wallet. Nothing is signed by connecting.</p><button class="btn" id="fdConnect">Connect wallet</button>`;
    $("#fdConnect").addEventListener("click", async () => { try { await connectWallet(); mount(); } catch(e){ showToast(e.message); } });
    return;
  }
  b.innerHTML = `<section id="fdControls"><h3>Owner controls</h3><p>Loading…</p></section>
    <section id="fdMigration"><h3>Migration</h3><p>Loading…</p></section>
    <section id="fdGas"><h3>Gas fund</h3><p>Loading…</p></section>`;
  await renderControls();          // never waits for, or depends on, the sections below
  await renderMain();
}

// ---- owner controls: pins (offline) + stored records only ---------------------------------------------------------
async function renderControls(){
  const box = $("#fdControls");
  let f, target = null, why = null, relay = null, relayWhy = null, recs = [], store = null;
  try { f = await fundingLib(); }
  catch(e){ box.innerHTML = `<h3>Owner controls</h3><p>Could not load the funding client: ${errText(e)}</p>`; return; }
  try { target = f.controlsTarget(f.parseRuntimePins(FUNDING_RUNTIME), Enclave.address); } catch(e){ why = e; }
  try { relay = f.relayClient(relayRoot()); } catch(e){ relayWhy = e; }
  try { store = new f.IndexedDbV2Store(); recs = (await store.listKeys()).filter((r) => lower(r.owner) === lower(Enclave.address)); }
  catch(e){ why = why || e; }
  const live = recs.filter((r) => r.sid && (r.status === "open" || r.status === "submitted"));
  const dis = relay && store ? "" : "disabled";
  box.innerHTML = `<h3>Owner controls (work with intake off)</h3>
    ${target ? `<p>Successor vault <code>${esc(target.vault)}</code></p>` : `<p>No successor pins: ${errText(why)}</p>`}
    ${relay ? "" : `<p>Relay unavailable: ${errText(relayWhy)}</p>`}
    ${live.map((r) => `<div><code>${esc(r.sid)}</code>
      <button class="btn" data-end="${esc(r.id)}" ${dis}>End (session key)</button>
      ${target ? `<button class="btn" data-term="${esc(r.sid)}" ${dis}>Terminate (wallet)</button>` : ""}</div>`).join("")}
    ${target ? `<label>Withdraw USDC6 <input id="fdWAmt" value=""></label> <button class="btn" id="fdWd" ${dis}>Withdraw (wallet)</button>` : ""}`;
  box.querySelectorAll("[data-end]").forEach((el) => el.addEventListener("click", () => guard(async () => {
    const rec = await store.loadKey(el.dataset.end);
    return f.endGasSession({ record: rec, relay, store, now: now() });
  })));
  box.querySelectorAll("[data-term]").forEach((el) => el.addEventListener("click", () => guard(() =>
    f.ownerControl({ target, provider: Enclave.provider, relay, store, op: "terminate", sessionId: el.dataset.term, now: now() }))));
  if (target) $("#fdWd").addEventListener("click", () => guard(() =>
    f.ownerControl({ target, provider: Enclave.provider, relay, store, op: "withdraw", amount: $("#fdWAmt").value.trim(), now: now() })));
}

// ---- migration + gas fund: full verified context ------------------------------------------------------------------
async function context(){
  const f = await fundingLib();
  const S = await sdk();
  const cfg = await sessionsConfig();
  if (!cfg) throw new Error("Sessions are not available on this API endpoint.");
  const rpc = f.jsonRpc(cfg.rpc || APP_CATALOG_RPCS[0]);
  const relay = f.relayClient(relayRoot());
  const runtime = await f.verifyRuntime({ pins: FUNDING_RUNTIME, rpc, relay, owner: Enclave.address, now: now() });
  let scope = null, scopeWhy = null;
  try {
    scope = await f.freshRecoveryScope({ rpc, book: cfg.book, owner: Enclave.address, legacyVault: runtime.cfg.legacyVault,
      deploymentIds: FUNDING_RECOVERY_DEPLOYMENTS, now: now() });
  } catch(e){ scopeWhy = e; }
  return { f, S, cfg, rpc, relay, runtime, scope, scopeWhy, legacyRelay: new S.RelayClient(relayRoot()),
    chain: f.legacyChain(rpc, S), legacyStore: new S.IndexedDbStore(), gasStore: new f.IndexedDbV2Store() };
}

/** The active pointer moves only away from the session being replaced (or from none): never over another choice. */
async function setActive(newSid, oldSid){
  const cur = lower(lsGet(WALLET_SESSION_KEY));
  if (cur === lower(newSid) || (cur && cur !== lower(oldSid))) return;
  lsSet(WALLET_SESSION_KEY, newSid);
  emit("enclave:session", { active: true });
  await accountFromSession().catch((e) => showToast("Replacement session is open; account login failed: " + e.message));
}

const stepCtx = (c) => ({ S: c.S, chain: c.chain, legacyRelay: c.legacyRelay, relay: c.relay, runtime: c.runtime,
  legacyStore: c.legacyStore, gasStore: c.gasStore, setActive, now: now() });

async function renderMain(){
  const mig = $("#fdMigration"), gas = $("#fdGas");
  try {
    M.ctx = await context();
    await renderMigration(M.ctx, mig);
  } catch(e){
    mig.innerHTML = `<h3>Migration</h3><p>Unavailable: ${errText(e)}</p>`;
    gas.innerHTML = `<h3>Gas fund</h3><p>Unavailable.</p>`;
    return;
  }
  try { await renderGas(M.ctx, gas); } catch(e){ gas.innerHTML = `<h3>Gas fund</h3><p>Unavailable: ${errText(e)}</p>`; }
}

async function renderMigration(c, mig){
  const plans = (await c.gasStore.listJournal()).filter((e) => e.kind === "migration" && e.v === 2);
  const plan = plans[plans.length - 1] || null;
  const appr = FUNDING_MIGRATION_APPROVAL;
  const approved = !!plan && appr?.rootReviewed === true && appr.termsHash === plan.termsHash;
  const firstOpen = plan ? STEPS.find((k) => plan.steps[k].status !== "proven") : null;
  // the next signable run: from the first unproven step, while steps are still planned (terminate implies legacyOpen)
  const next = [];
  if (plan) for (const k of STEPS.slice(STEPS.indexOf(firstOpen))) { if (!firstOpen || plan.steps[k].status !== "planned") break; next.push(k); }
  mig.innerHTML = `<h3>Migration (old legacy → legacy + gas)</h3>
    <p>Not atomic. The API stops when the old session is terminated and resumes once the replacement is proven on chain.</p>
    <p>Intake: ${c.runtime.intake ? "on" : `off (${esc(c.runtime.intakeWhy || "")})`} · Scope: ${c.scope ? esc(c.scope.appIds.length + " apps") : errText(c.scopeWhy)}</p>
    ${plan ? `<pre>${show({ termsHash: plan.termsHash, approved, steps: Object.fromEntries(Object.entries(plan.steps).map(([k, s]) => [k, { status: s.status, attempt: s.attempt, txHash: s.txHash ?? null, digest: s.review.digest }])) })}</pre>` : ""}
    ${!plan ? `<label>Legacy USDC6 <input id="fdLegacy" value="29000000"></label> <label>Gas USDC6 <input id="fdGas6" value="1000000"></label>
      <button class="btn" id="fdPlan" ${c.scope ? "" : "disabled"}>Check &amp; build plan (no wallet)</button>` : ""}
    ${plan ? `<button class="btn" id="fdSign" ${approved && next.length ? "" : "disabled"}>Sign next: ${esc(next.join(", ") || "none")}</button>
      <button class="btn" id="fdRun" ${M.signed ? "" : "disabled"}>Submit signed steps</button>
      <button class="btn" id="fdRec">Reconcile (chain, read only)</button>
      ${STEPS.filter((k) => plan.steps[k].status === "void" || plan.steps[k].status === "planned")
        .map((k) => `<button class="btn" data-rearm="${k}">Re-arm ${k}</button>`).join("")}` : ""}
    <pre id="fdOut"></pre>`;
  const out = (v) => { $("#fdOut").innerHTML = show(v); };
  const rerender = () => renderMain();
  if (!plan && c.scope) $("#fdPlan").addEventListener("click", () => guard(async () => {
    const evidence = await c.f.loadLegacyEvidence({ S: c.S, legacyStore: c.legacyStore, sid: lsGet(WALLET_SESSION_KEY),
      owner: Enclave.address, chain: c.chain, legacyConfig: c.cfg, runtime: c.runtime, now: now() });
    out(await c.f.buildMigrationPlan({ S: c.S, evidence, runtime: c.runtime, scope: c.scope, gasStore: c.gasStore,
      relayBase: relayRoot(), now: now(), split: { legacy6: $("#fdLegacy").value.trim(), gas6: $("#fdGas6").value.trim() } }));
  }, rerender));
  if (!plan) return;
  $("#fdSign").addEventListener("click", () => guard(async () => {
    M.signed = await c.f.signSteps({ S: c.S, plan: await c.gasStore.getJournal(plan.id), steps: next, approval: appr,
      provider: Enclave.provider, rpc: c.rpc, runtime: c.runtime, now: now() });
    return true;
  }, rerender));
  $("#fdRun").addEventListener("click", () => guard(async () => {
    const signed = M.signed;
    M.signed = null;                              // single use, even if a step fails
    const r = await c.f.runMigration(stepCtx(c), plan.id, signed);
    out(r);
    return r;
  }, rerender));
  $("#fdRec").addEventListener("click", () => guard(async () => { const r = await c.f.reconcileMigration(stepCtx(c), plan.id); out(r); return r; }, rerender));
  mig.querySelectorAll("[data-rearm]").forEach((el) => el.addEventListener("click", () => guard(async () => {
    M.signed = null;
    return c.f.rearmStep(stepCtx(c), plan.id, el.dataset.rearm);
  }, rerender)));
}

async function renderGas(c, box){
  const recs = (await c.gasStore.listKeys()).filter((r) => lower(r.owner) === lower(Enclave.address));
  const open = recs.find((r) => r.status === "open");
  if (!open || !c.scope || !c.runtime.intake){
    box.innerHTML = `<h3>Gas fund</h3><p>${!open ? "No open gas session in this browser." : !c.scope ? "Recovery scope unavailable: " + errText(c.scopeWhy) : "Intake is off."}</p>`;
    return;
  }
  box.innerHTML = `<h3>Gas fund</h3>
    <select id="fdDep">${[...c.scope.deployments.keys()].map((d) => `<option>${esc(d)}</option>`).join("")}</select>
    <label>ETH out (wei) <input id="fdEth" value="20000000000000"></label>
    <select id="fdTier">${c.runtime.intake.feeTiers.map((t) => `<option>${t}</option>`).join("")}</select>
    <button class="btn" id="fdQuote">Quote</button> <button class="btn" id="fdFund" disabled>Sign &amp; fund (session key)</button>
    <pre id="fdQuoteOut"></pre>`;
  $("#fdQuote").addEventListener("click", () => guard(async () => {
    M.quote = await c.f.quoteGasFund({ runtime: c.runtime, record: open, relay: c.relay, scope: c.scope, deployment: $("#fdDep").value,
      ethOut: $("#fdEth").value.trim(), feeTier: $("#fdTier").value, now: now(), journalEntries: await c.gasStore.listJournal() });
    $("#fdQuoteOut").innerHTML = show({ deployment: M.quote.deployment, holder: M.quote.holder, totals: M.quote.totals,
      digest: M.quote.call.digest, deadline: M.quote.call.execute.deadline });
    $("#fdFund").disabled = false;
  }));
  $("#fdFund").addEventListener("click", () => guard(async () => {
    const q = M.quote;
    M.quote = null;
    $("#fdFund").disabled = true;
    if (!q) throw new Error("quote first");
    const r = await c.f.confirmGasFund({ runtime: c.runtime, store: c.gasStore, record: open, review: q, relay: c.relay, rpc: c.rpc, now: now() });
    $("#fdQuoteOut").innerHTML = show(r);
    return r;
  }));
}

on("enclave:wallet", () => { if ($("#fdBody")) mount(); });
export function boot(){ mount(); }
