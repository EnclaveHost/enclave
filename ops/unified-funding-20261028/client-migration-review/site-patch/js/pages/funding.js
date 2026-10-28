/* ============================================================
   UNREVIEWED SOURCE (unified-funding client-migration-r1).
   /funding: budget migration + successor gas.fund, on the SAME
   origin as /sessions so the legacy non-extractable IndexedDB key
   ("enclave-sessions") is used in place, never exported.

   Nothing signs on load or connect. Every wallet prompt and every
   session-key signature is behind a click; migration signing also
   needs FUNDING_MIGRATION_APPROVAL.termsHash == the plan's hash.
   FUNDING_RUNTIME null (the default) -> the page refuses.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import { Enclave, WALLET_SESSION_KEY } from "../core/api.js";
import { connectWallet } from "../core/wallet.js";
import { $, esc, lsGet, lsSet, emit, on, showToast } from "../core/util.js";
import { sdk, sessionsConfig, relayRoot } from "../core/sessions.js";
import { APP_CATALOG_RPCS, FUNDING_RUNTIME, FUNDING_MIGRATION_APPROVAL, FUNDING_RECOVERY_DEPLOYMENTS } from "../core/config.js";

let F = null;
const fundingLib = async () => (F ??= await import("/vendor/funding.js"));
const now = () => BigInt(Math.floor(Date.now() / 1000));
const lower = (a) => String(a || "").toLowerCase();
const show = (v) => esc(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));

// in memory only: signatures never reach storage
const M = { ctx: null, plan: null, internal: null, signed: null, quote: null, busy: false };

async function context(){
  const f = await fundingLib();
  const S = await sdk();
  const cfg = await sessionsConfig();
  if (!cfg) throw new Error("Sessions are not available on this API endpoint.");
  const rpc = f.jsonRpc(cfg.rpc || APP_CATALOG_RPCS[0]);
  const relay = f.relayClient(relayRoot());
  const runtime = await f.verifyRuntime({ pins: FUNDING_RUNTIME, rpc, relay, owner: Enclave.address });  // refuses on null
  const legacyRelay = new S.RelayClient(relayRoot());
  const info = await legacyRelay.request("GET", "/owner/" + Enclave.address);
  // PREREQUISITE: the `held` entry shape of GET /owner/<owner> is confirmed by root before enabling
  const legacyHeld = new Map((info.held || []).map((h) => [lower(h.id || h.deployment), Number(h.env ?? h.environment ?? 0)]));
  const scope = await f.freshRecoveryScope({ rpc, book: cfg.book, owner: Enclave.address, legacyVault: runtime.cfg.legacyVault,
    deploymentIds: FUNDING_RECOVERY_DEPLOYMENTS, legacyHeld });
  return { f, S, cfg, rpc, relay, legacyRelay, runtime, scope, chain: f.legacyChain(rpc, S),
    legacyStore: new S.IndexedDbStore(), gasStore: new f.IndexedDbV2Store() };
}

function render(html){ const b = $("#fdBody"); if (b) b.innerHTML = html; }

async function mount(){
  if (!Enclave.address){
    render(`<p>Connect the owner wallet. Nothing is signed by connecting.</p><button class="btn" id="fdConnect">Connect wallet</button>`);
    $("#fdConnect").addEventListener("click", async () => { try { await connectWallet(); mount(); } catch(e){ showToast(e.message); } });
    return;
  }
  if (!FUNDING_RUNTIME){ render(`<p>Successor funding is not configured on this site (no deployed runtime). Nothing is offered.</p>`); return; }
  render(`<p>Reading chain and relay…</p>`);
  try { M.ctx = await context(); }
  catch(e){ render(`<p>Refused: <code>${esc(e.code || "error")}</code> ${esc(e.message)}</p>`); return; }
  const { runtime, scope, gasStore } = M.ctx;
  const gasRecs = (await gasStore.listKeys()).filter((r) => lower(r.owner) === lower(Enclave.address));
  const open = gasRecs.find((r) => r.status === "open");
  const plans = (await gasStore.listJournal()).filter((e) => e.kind === "migration");
  const appr = FUNDING_MIGRATION_APPROVAL;
  render(`
    <section><h3>Successor</h3><pre>${show({ vault: runtime.cfg.vault, intake: runtime.intake, intakeWhy: runtime.intakeWhy,
      appIds: scope.appIds, block: runtime.block.number })}</pre></section>
    <section><h3>Migration (old $30 legacy → legacy + gas)</h3>
      <p>Not atomic. The API stops at step 1 and resumes after step 2 is mined. Root-reviewed terms: <code>${esc(appr?.termsHash || "none")}</code></p>
      <label>Legacy USDC6 <input id="fdLegacy" value="29000000"></label> <label>Gas USDC6 <input id="fdGas" value="1000000"></label>
      <button class="btn" id="fdPlan">Check &amp; build plan (no wallet)</button>
      <button class="btn" id="fdSign" disabled>Sign (5 wallet prompts)</button>
      <button class="btn" id="fdRun" disabled>Submit steps</button>
      <button class="btn" id="fdRec" ${plans.length ? "" : "disabled"}>Reconcile (read only)</button>
      <pre id="fdPlanOut">${plans.length ? show(plans.map((p) => ({ id: p.id, steps: p.steps }))) : ""}</pre></section>
    <section><h3>Gas fund</h3>${open ? `
      <select id="fdDep">${[...scope.deployments.keys()].map((d) => `<option>${esc(d)}</option>`).join("")}</select>
      <label>ETH out (wei) <input id="fdEth" value="20000000000000"></label>
      <select id="fdTier">${(runtime.intake?.feeTiers || []).map((t) => `<option>${t}</option>`).join("")}</select>
      <button class="btn" id="fdQuote">Quote</button> <button class="btn" id="fdFund" disabled>Sign &amp; fund (session key)</button>
      <pre id="fdQuoteOut"></pre>` : `<p>No open gas session in this browser.</p>`}</section>
    <section><h3>Owner controls (work with intake off)</h3>
      ${open ? `<button class="btn" id="fdEnd">End gas session (session key)</button> <button class="btn" id="fdTerm">Terminate gas session (wallet)</button>` : ""}
      <label>Withdraw USDC6 <input id="fdWAmt" value=""></label> <button class="btn" id="fdWd">Withdraw from successor (wallet)</button></section>`);

  $("#fdPlan").addEventListener("click", () => guard(buildPlan));
  $("#fdSign").addEventListener("click", () => guard(signPlan));
  $("#fdRun").addEventListener("click", () => guard(runPlan));
  $("#fdRec").addEventListener("click", () => guard(() => reconcile(plans[plans.length - 1])));
  if (open){
    $("#fdQuote").addEventListener("click", () => guard(() => quote(open)));
    $("#fdFund").addEventListener("click", () => guard(() => fund(open)));
    $("#fdEnd").addEventListener("click", () => guard(() => M.ctx.f.endGasSession({ runtime, record: open, relay: M.ctx.relay, store: gasStore, now: now() })));
    $("#fdTerm").addEventListener("click", () => guard(() => M.ctx.f.ownerControl({ runtime, provider: Enclave.provider, relay: M.ctx.relay,
      store: gasStore, op: "terminate", sessionId: open.sid, now: now() })));
  }
  $("#fdWd").addEventListener("click", () => guard(() => M.ctx.f.ownerControl({ runtime, provider: Enclave.provider, relay: M.ctx.relay,
    store: gasStore, op: "withdraw", amount: $("#fdWAmt").value.trim(), now: now() })));
}

async function guard(fn){
  if (M.busy) return;
  M.busy = true;
  try { const out = await fn(); if (out !== undefined) showToast("Done"); }
  catch(e){ showToast((e.code ? e.code + ": " : "") + e.message); }
  finally { M.busy = false; }
}

async function buildPlan(){
  const { f, S, runtime, scope, chain, cfg, legacyStore, gasStore } = M.ctx;
  const evidence = await f.loadLegacyEvidence({ S, legacyStore, sid: lsGet(WALLET_SESSION_KEY), owner: Enclave.address, chain,
    legacyConfig: cfg, runtime });
  const out = await f.buildMigrationPlan({ S, evidence, runtime, scope, gasStore, relayBase: relayRoot(), now: now(),
    split: { legacy6: $("#fdLegacy").value.trim(), gas6: $("#fdGas").value.trim() } });
  Object.assign(M, { plan: out.plan, internal: out.internal, signed: null });
  $("#fdPlanOut").innerHTML = show(out.plan);
  const ok = FUNDING_MIGRATION_APPROVAL?.rootReviewed === true && FUNDING_MIGRATION_APPROVAL.termsHash === out.plan.termsHash;
  $("#fdSign").disabled = !ok;
  if (!ok) showToast("Plan built. Its termsHash is not the root-reviewed one; signing stays disabled.");
}

async function signPlan(){
  M.signed = await M.ctx.f.signMigration({ plan: M.plan, internal: M.internal, approval: FUNDING_MIGRATION_APPROVAL,
    provider: Enclave.provider, rpc: M.ctx.rpc, runtime: M.ctx.runtime, now: now() });
  $("#fdRun").disabled = false;
  return true;
}

async function runPlan(){
  if (!M.signed) throw new Error("sign first");
  const c = M.ctx;
  const out = await c.f.executeMigration({ S: c.S, plan: M.plan, internal: M.internal, signed: M.signed, legacyRelay: c.legacyRelay,
    relay: c.relay, chain: c.chain, rpc: c.rpc, runtime: c.runtime, legacyStore: c.legacyStore, gasStore: c.gasStore, now: now(),
    setActive: (sid) => { lsSet(WALLET_SESSION_KEY, sid); emit("enclave:session", { active: true }); } });
  M.signed = null;                                   // single use
  $("#fdPlanOut").innerHTML = show(out);
  return out;
}

async function reconcile(plan){
  const c = M.ctx;
  const out = await c.f.reconcileMigration({ plan, chain: c.chain, relay: c.relay, runtime: c.runtime, gasStore: c.gasStore });
  $("#fdPlanOut").innerHTML = show(out);
  return out;
}

async function quote(rec){
  const c = M.ctx;
  M.quote = await c.f.quoteGasFund({ runtime: c.runtime, record: rec, relay: c.relay, scope: c.scope, deployment: $("#fdDep").value,
    ethOut: $("#fdEth").value.trim(), feeTier: $("#fdTier").value, now: now(), journalEntries: await c.gasStore.listJournal() });
  $("#fdQuoteOut").innerHTML = show({ deployment: M.quote.deployment, holder: M.quote.holder, totals: M.quote.totals,
    digest: M.quote.call.digest, deadline: M.quote.call.execute.deadline });
  $("#fdFund").disabled = false;
}

async function fund(rec){
  const c = M.ctx;
  const q = M.quote;
  M.quote = null;
  $("#fdFund").disabled = true;
  if (!q) throw new Error("quote first");
  const out = await c.f.confirmGasFund({ runtime: c.runtime, store: c.gasStore, record: rec, review: q, relay: c.relay, rpc: c.rpc, now: now() });
  $("#fdQuoteOut").innerHTML = show(out);
  return out;
}

on("enclave:wallet", () => { if ($("#fdBody")) mount(); });
export function boot(){ mount(); }
