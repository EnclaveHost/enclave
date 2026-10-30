/* ============================================================
   /funding: owner controls, migration review/recovery, gas fund.
   UNREVIEWED SOURCE (client-site-integration-r1).

   - Owner controls render FIRST and need only the successor pins
     (offline) and this browser's own gas records: never intake,
     the catalog, the recovery scope or the relay config.
   - A migration is offered only for the operator's explicit
     FUNDING_MIGRATION_PROPOSAL (finite split, finite app scopes,
     named recovery deployments). The original session's STORED
     grant must exist in this browser and match the chain.
   - Signatures are asked for only when FUNDING_MIGRATION_APPROVAL
     matches this exact plan (owner, chain, session, termsHash).
     Until then the page shows "waiting for review" and the
     termsHash to give the reviewer. Nothing is auto-approved.
   - Nothing signs, sends or retries on its own. Every wallet or
     session-key signature and every submission follows a click,
     and every click is bound to the wallet + context it was shown
     for (a wallet change re-mounts and drops all held signatures
     and quotes). Other owners' records are never shown or touched.
   All protocol checks live in the unchanged /vendor/funding.js.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import { Enclave, WALLET_SESSION_KEY } from "../core/api.js";
import { connectWallet } from "../core/wallet.js";
import { $, esc, lsGet, lsSet, emit, on, showToast } from "../core/util.js";
import { sdk, sessionsConfig, relayRoot, accountFromSession } from "../core/sessions.js";
import { APP_CATALOG_RPCS, FUNDING_RUNTIME, FUNDING_MIGRATION_PROPOSAL, FUNDING_MIGRATION_APPROVAL } from "../core/config.js";
import * as ST from "../funding/state.js";

const CHAIN = 8453;
let F = null;
const lib = async () => (F ??= await import("/vendor/funding.js"));
const nowS = () => BigInt(Math.floor(Date.now() / 1000));
const usd = ST.formatUsd6;
const memory = ST.createMemory();
let epoch = 0;
let busy = false;
const view = { ctx: null, c: null, plan: null };      // the context this render belongs to (never reused across owners)

const errText = (e) => `${esc(e?.code ? `${e.code}: ` : "")}${esc(e?.message ?? String(e))}`;
const ownerNow = () => ST.lower(Enclave.address || "");

/** Every action: same render epoch, same wallet, one at a time; then re-render this context (memory kept). */
function act(e, owner, fn) {
  return async () => {
    if (e !== epoch || ownerNow() !== owner) { showToast("The wallet or page changed; refreshing."); return mount(); }
    if (busy) return;
    busy = true;
    try { const out = await fn(); if (out !== undefined) showToast(typeof out === "string" ? out : "Done"); }
    catch (err) { showToast(`${err?.code ? `${err.code}: ` : ""}${err?.message ?? err}`); }
    finally { busy = false; if (e === epoch && ownerNow() === owner) await render(e, owner); }
  };
}

function mount() {
  epoch += 1;
  memory.clear();                                      // remount / wallet change: no held signature or quote survives
  view.ctx = null; view.c = null; view.plan = null;
  return render(epoch, ownerNow());
}

async function render(e, owner) {
  const b = $("#fdBody");
  if (!b) return;
  if (!owner) {
    b.innerHTML = `<p>Connect the owner wallet. Nothing is signed by connecting.</p><button class="btn" id="fdConnect">Connect wallet</button>`;
    $("#fdConnect").addEventListener("click", async () => { try { await connectWallet(); } catch (err) { showToast(err.message); } });
    return;
  }
  b.innerHTML = `<section id="fdControls"><h3>Your controls</h3><p>Loading…</p></section>
    <section id="fdMig"><h3>Funding migration</h3><p>Loading…</p></section>
    <section id="fdGas"><h3>Gas for your apps</h3><p>Loading…</p></section>`;
  await renderControls(e, owner);
  if (e !== epoch) return;
  await renderMigration(e, owner);
  if (e !== epoch) return;
  await renderGas(e, owner);
}

// =====================================================================================================================
// Owner controls (independent of intake / catalog / scope / relay config)
// =====================================================================================================================
async function renderControls(e, owner) {
  const box = $("#fdControls");
  let f, target = null, relay = null, store = null, recs = [];
  const why = {};
  try { f = await lib(); } catch (err) { box.innerHTML = `<h3>Your controls</h3><p>The funding client could not load: ${errText(err)}</p>`; return; }
  try { target = f.controlsTarget(f.parseRuntimePins(FUNDING_RUNTIME), owner); } catch (err) { why.pins = err; }
  try { relay = f.relayClient(relayRoot()); } catch (err) { why.relay = err; }
  try {
    store = new f.IndexedDbV2Store();
    if (target) recs = ST.selectOwnRecords(await store.listKeys(), ST.controlsContextOf({ owner, chainId: CHAIN, vault: target.vault, relay: relayRoot() }));
  } catch (err) { why.store = err; }
  if (e !== epoch) return;
  const live = recs.filter((r) => r.sid && (r.status === "open" || r.status === "submitted"));
  const av = ST.controlsAvailability({ pinsOk: !!target, relayOk: !!relay, storeOk: !!store, ownRecords: live.length });
  box.innerHTML = `<h3>Your controls (work even when new funding is paused)</h3>
    ${target ? `<p>Your gas vault: <code>${esc(target.vault)}</code></p>` : `<p>Gas funding is not set up on this site (${errText(why.pins)}).</p>`}
    ${av.reason && target ? `<p>Unavailable: ${esc(av.reason)}</p>` : ""}
    ${live.map((r) => `<div><strong>${esc(r.label || "Gas grant")}</strong> · ${esc((r.grant?.apps || []).length)} apps · <code>${esc(r.sid.slice(0, 12))}…</code>
      <button class="btn" data-end="${esc(r.id)}" ${av.end ? "" : "disabled"}>End (this browser's key)</button>
      <button class="btn" data-term="${esc(r.id)}" ${av.terminate ? "" : "disabled"}>Terminate (wallet)</button></div>`).join("")}
    ${target ? `<label>Withdraw unallocated USDC (micro-units) <input id="fdWAmt" inputmode="numeric" value=""></label>
      <button class="btn" id="fdWd" ${av.withdraw ? "" : "disabled"}>Withdraw (wallet)</button>` : ""}
    <p>Original sessions (the API session) are managed on the <a href="sessions">Sessions</a> page.</p>`;
  const byId = (id) => live.find((r) => r.id === id);
  box.querySelectorAll("[data-end]").forEach((el) => el.addEventListener("click", act(e, owner, async () => {
    const rec = byId(el.dataset.end);
    if (!rec) throw new Error("that record is not yours or no longer live");
    return f.endGasSession({ record: rec, relay, store, now: nowS() }).then(() => "Sign-out sent; check its status on chain");
  })));
  box.querySelectorAll("[data-term]").forEach((el) => el.addEventListener("click", act(e, owner, async () => {
    const rec = byId(el.dataset.term);
    if (!rec) throw new Error("that record is not yours or no longer live");
    return f.ownerControl({ target, provider: Enclave.provider, relay, store, op: "terminate", sessionId: rec.sid, now: nowS() }).then(() => "Terminate sent");
  })));
  if (target) $("#fdWd").addEventListener("click", act(e, owner, () =>
    f.ownerControl({ target, provider: Enclave.provider, relay, store, op: "withdraw", amount: $("#fdWAmt").value.trim(), now: nowS() }).then(() => "Withdraw sent")));
}

// =====================================================================================================================
// Context for migration + gas (verified runtime; failure here never affects the controls above)
// =====================================================================================================================
async function context(owner) {
  const f = await lib();
  const S = await sdk();
  const cfg = await sessionsConfig();
  if (!cfg) throw new Error("Sessions are not available on this API endpoint.");
  const rpc = f.jsonRpc(cfg.rpc || APP_CATALOG_RPCS[0]);
  const relay = f.relayClient(relayRoot());
  const runtime = await f.verifyRuntime({ pins: FUNDING_RUNTIME, rpc, relay, owner, now: nowS() });
  const ctx = ST.contextOf({ owner, chainId: CHAIN, vault: runtime.cfg.vault, legacyVault: runtime.cfg.legacyVault, relay: relayRoot() });
  return { f, S, cfg, rpc, relay, runtime, ctx, chain: f.legacyChain(rpc, S), legacyStore: new S.IndexedDbStore(), gasStore: new f.IndexedDbV2Store() };
}
async function setActive(newSid, oldSid) {
  const d = ST.activePointerDecision(lsGet(WALLET_SESSION_KEY), newSid, oldSid);
  if (d === "keep") { showToast("The replacement session is ready; your current session choice was kept."); return; }
  if (d === "noop") return;
  lsSet(WALLET_SESSION_KEY, newSid);
  emit("enclave:session", { active: true });
  await accountFromSession().catch((err) => showToast(`Replacement session open; account login failed: ${err.message}`));
}
const stepCtx = (c) => ({ S: c.S, chain: c.chain, legacyRelay: new c.S.RelayClient(relayRoot()), relay: c.relay, runtime: c.runtime,
  legacyStore: c.legacyStore, gasStore: c.gasStore, setActive, now: nowS() });

// =====================================================================================================================
// Migration review / recovery
// =====================================================================================================================
async function renderMigration(e, owner) {
  const box = $("#fdMig");
  if (!FUNDING_RUNTIME) { box.innerHTML = `<h3>Funding migration</h3><p>Not available: no deployed successor is configured for this site.</p>`; return; }
  let np;
  try { np = ST.validateProposal(FUNDING_MIGRATION_PROPOSAL, { owner, chainId: CHAIN }); }
  catch (err) { box.innerHTML = `<h3>Funding migration</h3><p>No migration is offered to this wallet (${errText(err)}).</p>`; return; }
  if (!np) { box.innerHTML = `<h3>Funding migration</h3><p>No migration has been proposed for this site.</p>`; return; }
  let c;
  try { c = await context(owner); } catch (err) { box.innerHTML = `<h3>Funding migration</h3><p>Unavailable right now: ${errText(err)}</p>`; return; }
  if (e !== epoch) return;
  view.c = c; view.ctx = c.ctx;
  memory.bind(c.ctx);
  const plans = ST.selectPlans(await c.gasStore.listJournal(), c.ctx, np.oldSid);
  if (plans.length > 1) { box.innerHTML = `<h3>Funding migration</h3><p>More than one plan exists for this session in this browser; resolve them before continuing.</p>`; return; }
  const plan = plans[0] ?? null;
  view.plan = plan;
  const money = ST.moneyRows({ original6: plan?.terms?.legacy?.oldBalance6, legacy6: np.legacy6, parts: np.parts });
  const appr = ST.approvalStatus(FUNDING_MIGRATION_APPROVAL, plan, c.ctx);
  const now = nowS();
  const phase = plan ? ST.planPhase(plan, now, !!memory.signedFor(c.ctx, plan)) : null;
  const next = plan ? ST.nextSignable(plan, now) : [];
  const signedReady = plan ? memory.signedFor(c.ctx, plan) : null;
  const legacyLabel = plan ? ST.legacyScopeLabel(plan.terms.legacy.grantTemplate.apps) : null;
  box.innerHTML = `<h3>Funding migration (proposed)</h3>
    <p>Your original session <code>${esc(np.oldSid.slice(0, 12))}…</code> would be ended (its budget comes back to your wallet), reopened
      with the <strong>same key and the same permissions</strong>, and the rest funds gas for the named apps only. It is not atomic: the API
      pauses between ending the original and opening its replacement.</p>
    <table><tbody>
      <tr><td>Held in the original session</td><td>${plan ? esc(usd(plan.terms.legacy.oldBalance6)) : "check below"}</td></tr>
      ${money.rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(usd(r.amount6))}</td></tr>`).join("")}
      <tr><td><strong>Total</strong></td><td><strong>${esc(usd(money.total6))}</strong> ${plan ? (money.ok ? "= the original, nothing added" : "DOES NOT match the original") : ""}</td></tr>
    </tbody></table>
    ${np.parts.map((x) => `<details><summary>Gas grant "${esc(x.name)}": ${x.appIds.length} apps, at most ${esc(String(x.opsPerPeriod))} operations per day</summary>
      <ul>${x.appIds.map((a) => `<li><code>${esc(a)}</code></li>`).join("")}</ul></details>`).join("")}
    ${legacyLabel ? `<p>Replacement session apps: <strong>${esc(legacyLabel.text)}</strong>, exactly as your original grant.</p>` : ""}
    <div id="fdPlanArea"></div>`;
  const area = $("#fdPlanArea");
  if (!plan) {
    area.innerHTML = `<p>Step 1: check your original session in this browser and prepare the exact plan for review (no wallet).</p>
      <button class="btn" id="fdPrepare">Check original &amp; prepare plan</button>`;
    $("#fdPrepare").addEventListener("click", act(e, owner, async () => {
      const scope = await c.f.freshRecoveryScope({ rpc: c.rpc, book: c.cfg.book, owner, legacyVault: c.runtime.cfg.legacyVault,
        deploymentIds: [...np.deploymentIds], now: nowS() });
      const cov = ST.scopeCoverage(np, scope.appIds);
      if (!cov.ok) throw new Error(`the proposal does not match the deployments' apps (uncovered ${cov.uncovered.length}, extra ${cov.extra.length})`);
      const evidence = await c.f.loadLegacyEvidence({ S: c.S, legacyStore: c.legacyStore, sid: np.oldSid, owner, chain: c.chain,
        legacyConfig: c.cfg, runtime: c.runtime, now: nowS() });
      await c.f.buildMigrationPlan({ S: c.S, evidence, runtime: c.runtime, scope, split: ST.splitOf(np), now: nowS(),
        gasStore: c.gasStore, relayBase: relayRoot() });
      return "Plan prepared. It now needs review before anything can be signed.";
    }));
    return;
  }
  const steps = plan.terms.order.map((k) => ({ k, v: ST.stepView(plan.steps[k], now) }));
  area.innerHTML = `
    <p>Plan fingerprint (termsHash): <code>${esc(plan.termsHash)}</code></p>
    <p><strong>${appr.ok ? "Approved for exactly this plan." : appr.reason === "waiting_for_review"
      ? "Waiting for review: nothing can be signed until this exact plan is approved."
      : `Not approved (${esc(appr.reason)}). Nothing can be signed.`}</strong></p>
    <ol>${steps.map(({ k, v }) => `<li data-tone="${esc(v.tone)}"><strong>${esc(ST.stepLabel(k))}</strong>: ${esc(v.label)}
      ${v.actions.includes("rearm") ? `<button class="btn" data-rearm="${esc(k)}">Prepare again</button>` : ""}</li>`).join("")}</ol>
    ${phase.phase === "done" ? "<p>Migration complete.</p>" : ""}
    ${phase.phase === "reconcile" ? `<p>Check what happened on chain before anything else. Nothing is resent automatically.</p>` : ""}
    <button class="btn" id="fdRec">Check status on chain</button>
    <button class="btn" id="fdSign" ${appr.ok && next.length && !signedReady ? "" : "disabled"}>Sign next ${next.length ? `(${next.length} step${next.length === 1 ? "" : "s"})` : ""}</button>
    <button class="btn" id="fdRun" ${signedReady ? "" : "disabled"}>Send signed steps</button>`;
  $("#fdRec").addEventListener("click", act(e, owner, async () => {
    const r = await c.f.reconcileMigration(stepCtx(c), plan.id);
    return `Status: ${Object.entries(r.steps).map(([k, s]) => `${k} ${s}`).join(", ")}`;
  }));
  $("#fdSign").addEventListener("click", act(e, owner, async () => {
    const fresh = await c.gasStore.getJournal(plan.id);
    const ok = ST.approvalStatus(FUNDING_MIGRATION_APPROVAL, fresh, c.ctx);
    if (!ok.ok) throw new Error(`not approved: ${ok.reason}`);
    const want = ST.nextSignable(fresh, nowS());
    if (want.join() !== next.join()) throw new Error("the plan changed; refresh and review it again");
    const bundle = await c.f.signSteps({ S: c.S, plan: fresh, steps: want, approval: ok.approval, provider: Enclave.provider,
      rpc: c.rpc, runtime: c.runtime, now: nowS() });
    if (e !== epoch || ownerNow() !== owner) throw new Error("the wallet changed while signing; nothing was kept");
    memory.holdSigned(c.ctx, fresh, want, bundle);
    return "Signed. Review, then send.";
  }));
  $("#fdRun").addEventListener("click", act(e, owner, async () => {
    const fresh = await c.gasStore.getJournal(plan.id);
    const bundle = memory.signedFor(c.ctx, fresh);
    if (!bundle) throw new Error("the held signatures do not match this exact plan anymore; sign again");
    memory.dropSigned();                                 // single use, even if a step fails
    const r = await c.f.runMigration(stepCtx(c), plan.id, bundle);
    return r.done ? "Migration complete" : r.pending ? "Sent; waiting for chain confirmation" : r.needsSignature ? "Next step needs signing" : "Check status on chain";
  }));
  area.querySelectorAll("[data-rearm]").forEach((el) => el.addEventListener("click", act(e, owner, async () => {
    memory.dropSigned();
    await c.f.rearmStep({ ...stepCtx(c), rng: undefined }, plan.id, el.dataset.rearm);
    return "Prepared again; it needs signing (the approval is unchanged because the terms are unchanged).";
  })));
}

// =====================================================================================================================
// Gas fund: the grant whose finite scope names the deployment's app; quote shown before the session-key signature
// =====================================================================================================================
async function renderGas(e, owner) {
  const box = $("#fdGas");
  const c = view.c;
  let np = null;
  try { np = ST.validateProposal(FUNDING_MIGRATION_PROPOSAL, { owner, chainId: CHAIN }); } catch { np = null; }
  if (!c || !np) { box.innerHTML = `<h3>Gas for your apps</h3><p>Not available here.</p>`; return; }
  if (!c.runtime.intake) { box.innerHTML = `<h3>Gas for your apps</h3><p>New gas funding is paused (${esc(c.runtime.intakeWhy || "intake off")}). Your controls above still work.</p>`; return; }
  const recs = ST.selectOwnRecords(await c.gasStore.listKeys(), c.ctx).filter((r) => r.status === "open");
  if (!recs.length) { box.innerHTML = `<h3>Gas for your apps</h3><p>No open gas grant in this browser.</p>`; return; }
  let scope;
  try { scope = await c.f.freshRecoveryScope({ rpc: c.rpc, book: c.cfg.book, owner, legacyVault: c.runtime.cfg.legacyVault,
    deploymentIds: [...np.deploymentIds], now: nowS() }); }
  catch (err) { box.innerHTML = `<h3>Gas for your apps</h3><p>The deployment list could not be read (${errText(err)}).</p>`; return; }
  if (e !== epoch) return;
  box.innerHTML = `<h3>Gas for your apps</h3>
    <select id="fdDep">${[...scope.deployments.entries()].map(([d, x]) => `<option value="${esc(d)}">${esc(d.slice(0, 12))}… (app ${esc(x.appId.slice(0, 10))}…)</option>`).join("")}</select>
    <label>ETH to buy (wei) <input id="fdEth" inputmode="numeric" value="20000000000000"></label>
    <select id="fdTier">${c.runtime.intake.feeTiers.map((t) => `<option>${t}</option>`).join("")}</select>
    <button class="btn" id="fdQuote">Get quote</button>
    <div id="fdQuoteOut"></div>
    <button class="btn" id="fdFund" disabled>Sign with this browser's gas key &amp; fund</button>`;
  let shown = null;
  $("#fdQuote").addEventListener("click", act(e, owner, async () => {
    const dep = $("#fdDep").value;
    const record = c.f.selectGasRecord(ST.selectOwnRecords(await c.gasStore.listKeys(), c.ctx), scope, dep);
    const review = await c.f.quoteGasFund({ runtime: c.runtime, record, relay: c.relay, scope, deployment: dep, ethOut: $("#fdEth").value.trim(),
      feeTier: $("#fdTier").value, now: nowS(), journalEntries: await c.gasStore.listJournal() });
    memory.holdQuote(c.ctx, record, dep, review);
    shown = { recordId: record.id, dep };
    const qv = ST.quoteView(review, nowS());
    $("#fdQuoteOut").innerHTML = `<p>Grant <strong>${esc(record.label || record.id)}</strong>: ${qv.text.map(esc).join(" · ")} · valid ${qv.secondsLeft}s</p>`;
    $("#fdFund").disabled = qv.expired;
  }));
  $("#fdFund").addEventListener("click", act(e, owner, async () => {
    $("#fdFund").disabled = true;
    if (!shown) throw new Error("get a quote first");
    const record = ST.selectOwnRecords(await c.gasStore.listKeys(), c.ctx).find((r) => r.id === shown.recordId);
    const review = record && memory.takeQuote(c.ctx, record, shown.dep, nowS());
    shown = null;
    if (!review) throw new Error("the quote expired or no longer matches; get a new one");
    const r = await c.f.confirmGasFund({ runtime: c.runtime, store: c.gasStore, record, review, relay: c.relay, rpc: c.rpc, now: nowS() });
    return r.pending ? "Sent; waiting for chain confirmation" : `Funded: ${usd(r.settlement.actual.totalDebit6)} used`;
  }));
}

on("enclave:wallet", () => { if ($("#fdBody")) mount(); });
export function boot() { mount(); }
