/* ============================================================
   <c-admin-console> - the operator console behind admin.html.

   Replicates every governance transaction the terminal scripts
   perform (deploy-*.mjs, update-address-book.mjs, set-prices.mjs)
   plus the owner functions no script ever covered (payout/feed/
   lease setters, operator rotation, ownership handoffs), all
   signed by the connected wallet. Reads use the public RPC pool;
   a write is only ENABLED when the connected wallet matches that
   contract's owner/admin read live from the chain - and the chain
   enforces it regardless.

   Contract bytecode + selectors come from js/gen/contract-artifacts.js
   (generated from contracts/*.sol by scripts/build-contract-artifacts.mjs
   with the deploy scripts' exact solc settings), so a browser deploy
   produces the same code a terminal deploy would.
   ============================================================ */
import { EnclaveElement, register } from "../../js/lib/enclave-element.js";
import { Enclave } from "../../js/core/api.js";
import { connectWallet, ensureBaseChain, sendTx } from "../../js/core/wallet.js";
import { baseRpc, waitReceipt, encCall, hexBig, decodeStructArray, CAMPAIGN_SCHEMA, APP_SCHEMA, DEP_SEL } from "../../js/core/chain.js";
import { ADDRESS_BOOK_ADDRESS, USDC_BASE, DEFAULT_API_BASE } from "../../js/core/config.js";
import { esc, on, short, showToast } from "../../js/core/util.js";
import { CONTRACTS } from "../../js/gen/contract-artifacts.js";
import { MIG_KINDS, importState, sealTx, encCallX, escrowPlan, approveTx, refundSweepPlan } from "./migrate.js";
import { vaultImplCurrent, scanVaults, planVaultMigration, oldTreasury, balanceOf6 } from "./vaultmig.js";
import { REV12, probeRev12, sourceEscrowTotal6, deployTx, setProverTx, setProofRequiredFromTx,
         retireTx, bookSetManyTx, revOfLedger, revOfRegistry } from "./rollout.js";
import { metricsPanel, paintMetrics, paintHistory, loadMetrics, redrawPlots } from "./metrics.js";

const EXPLORER = "https://basescan.org";
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x" + "0".repeat(40);
const KEY_RE = /^[A-Za-z0-9_-]{1,31}$/;

/* the book panel's row order; other (custom) keys found on-chain follow */
const BOOK_KEYS = ["registry", "deployments", "appCatalog", "enclavePay", "featured", "reviews"];

const lc = (a) => (a || "").toLowerCase();
const isZero = (a) => !a || /^0x0{40}$/i.test(a);
const perHr = (p6) => "$" + (Number(p6) * 3600 / 1e6).toFixed(4) + "/hr";
const mono = (a) => `<span class="ac-addr" title="${esc(a)}">${esc(a)}</span>`;
const encKey = (k) => { let h = ""; for (const ch of k) h += ch.charCodeAt(0).toString(16).padStart(2, "0"); return "0x" + h.padEnd(64, "0"); };
const friendly = (e) => (e && (e.code === 4001 || /reject|denied|declin|cancell/i.test(e.message || ""))) ? "cancelled in the wallet" : (e.message || String(e));

const call = (to, data) => baseRpc("eth_call", [{ to, data }, "latest"]);
const rdAddr = async (to, sel) => { const r = await call(to, "0x" + sel); return "0x" + (r || "").replace(/^0x/, "").slice(-40).padStart(40, "0"); };
const rdUint = async (to, sel) => hexBig((await call(to, "0x" + sel)) || "0x0");
// Soft address read: a selector the DEPLOYED bytecode may not implement yet
// (e.g. pendingOwner on a contract still on its pre-two-step
// revision — which is every contract until it is redeployed) reverts. Treat
// that as "unset" (ZERO) instead of rejecting and blanking the whole console.
const rdAddrSoft = async (to, sel) => { try { return await rdAddr(to, sel); } catch { return ZERO; } };
// null = the getter isn't in the deployed contract (a pre-cap rev): the row
// paints as unsupported instead of the whole panel dying on one revert
const rdUintSoft = async (to, sel) => { try { const r = await call(to, "0x" + sel); return (!r || r === "0x") ? null : hexBig(r); } catch { return null; } };

/* decode all() -> { key: address } (skips zero/retired entries) */
function decodeBook(hex) {
  const b = (hex || "").replace(/^0x/, "");
  if (b.length < 128) return {};
  const word = (i) => b.slice(i * 64, i * 64 + 64);
  const num = (i) => parseInt(word(i).slice(48), 16);
  const kOff = num(0) / 32, vOff = num(1) / 32, n = num(kOff), out = {};
  for (let i = 0; i < n; i++) {
    const kw = word(kOff + 1 + i); let key = "";
    for (let j = 0; j < 64; j += 2) { const c = parseInt(kw.slice(j, j + 2), 16); if (!c) break; key += String.fromCharCode(c); }
    const a = "0x" + word(vOff + 1 + i).slice(24);
    if (key && !isZero(a)) out[key] = a;
  }
  return out;
}

class AdminConsole extends EnclaveElement {
  static templateUrl = new URL("./admin-console.html", import.meta.url);

  renderedCallback() {
    if (this._wired) return;
    this._wired = true;
    this._root = this.querySelector("#acRoot");
    on("enclave:wallet", () => this._evaluate());
    this._evaluate();
  }

  /* The page renders for ANY connected wallet (none connected = locked:
     there is nothing to sign with). It used to render only for the address
     book's owner, but a governance ROTATION made that a deadlock: the book is
     a one-step setOwner, so handing it over first locked the OLD wallet out
     of the console while it still owned every other contract - with no way
     to nominate them. Per-row gating stays: _gate() disables every button
     whose contract answers to a different owner (and shows who), pending
     handoffs surface an Accept only to the pending key, and the chain
     enforces the real owner check on every write regardless. Everything the
     page displays is public on-chain state. */
  async _evaluate() {
    const me = lc(Enclave.address);
    if (!me || !ADDRESS_BOOK_ADDRESS) return this._lock();
    this._unlock();
  }

  _lock() {
    this._unlocked = false;
    this._root.innerHTML = "";
    this._body = this._note = null;
  }

  _unlock() {
    if (this._unlocked) { this._paintSigner(); this._gate(); return; }
    this._unlocked = true;
    this._root.innerHTML = `
      <div class="sec-head">
        <span class="eyebrow">Operator console</span>
        <h2>Platform governance, signed by your wallet.</h2>
        <p>Every owner transaction the contract scripts run from a terminal - deploys, address-book updates, prices, payout and operator rotation - sent from this wallet instead of a pasted private key. Each contract's owner is checked live; the chain enforces it again on every write.</p>
      </div>
      <div class="ac-signer" id="acSigner"></div>
      <div class="ac-note" id="acNote">reading the platform contracts…</div>
      <div id="acBody" hidden></div>`;
    this._body = this.querySelector("#acBody");
    this._note = this.querySelector("#acNote");
    this._body.addEventListener("click", (e) => this._onClick(e));
    this._body.addEventListener("input", (e) => this._onInput(e));
    this._body.addEventListener("change", (e) => { if (e.target.id === "migKind") this._migPrefill(); });
    this.refresh();
  }

  async refresh() {
    if (!this._unlocked) return;
    this._paintSigner();
    try {
      const S = this.S = { book: { addr: ADDRESS_BOOK_ADDRESS, owner: null, entries: {} } };
      if (!S.book.addr) { this._note.textContent = "no ADDRESS_BOOK_ADDRESS is configured - deploy the book first (scripts/deploy-address-book.mjs)."; return; }
      const bookSel = CONTRACTS.EnclaveAddressBook.sel;
      const [allHex, bookOwner, bookPending] = await Promise.all([call(S.book.addr, "0x" + bookSel.all), rdAddr(S.book.addr, bookSel.owner), rdAddrSoft(S.book.addr, bookSel.pendingOwner)]);
      S.book.owner = bookOwner;
      S.book.pending = bookPending;
      S.book.entries = decodeBook(allHex);
      const E = S.book.entries;

      const dep = E.deployments, cat = E.appCatalog, pay = E.enclavePay, feat = E.featured, rev = E.reviews;
      const dSel = CONTRACTS.EnclaveDeployments.sel, pSel = CONTRACTS.EnclavePay.sel, fSel = CONTRACTS.EnclaveFeatured.sel,
            rSel = CONTRACTS.EnclaveReviews.sel;
      // the featured campaign list + the gateway's view counter (both soft:
      // a fresh deploy has no campaigns, the relay may not be updated yet)
      const readCampaigns = async () => {
        const n = Number(await rdUint(feat, fSel.campaignCount));
        const out = [];
        for (let s = 0; s < n; s += 100)
          out.push(...decodeStructArray(await call(feat, encCall(fSel.getCampaignsPage, [{ t: "uint", v: s }, { t: "uint", v: 100 }])), CAMPAIGN_SCHEMA));
        return out;
      };
      [S.dep, S.cat, S.pay, S.feat, S.rev, S.vlt] = await Promise.all([
        // gpu/cpu are the LEGACY platform list prices: gone from rev-8
        // ledgers (each enclave posts its own in the registry), so they read
        // soft and the panel says so instead of showing a stale number
        dep ? Promise.all([rdAddr(dep, dSel.owner), rdAddr(dep, dSel.payout), rdUintSoft(dep, dSel.pricePerSec6), rdUintSoft(dep, dSel.cpuPricePerSec6), rdUint(dep, dSel.leaseSec), rdAddr(dep, dSel.ethUsdFeed), rdAddrSoft(dep, dSel.pendingOwner), rdUintSoft(dep, dSel.maxGpuMilli), rdUintSoft(dep, dSel.maxFeePerSec6), rdUintSoft(dep, dSel.deploymentsSchema),
                           // rev >= 9 proof-of-time surface (soft: absent below 9)
                           rdAddrSoft(dep, dSel.prover), rdUintSoft(dep, dSel.proofRequiredFrom), rdAddrSoft(dep, dSel.registry), rdUintSoft(dep, dSel.runnerBps)])
              .then(([owner, payout, gpu, cpu, lease, feed, pending, maxGpu, maxFee, schema, prover, proofFrom, registry, runnerBps]) =>
                ({ addr: dep, owner, payout, gpu, cpu, lease, feed, pending, maxGpu, maxFee, schema: Number(schema ?? 2), prover, proofFrom, registry, runnerBps })) : null,
        cat ? Promise.all([rdAddr(cat, CONTRACTS.EnclaveAppCatalog.sel.owner), rdAddrSoft(cat, CONTRACTS.EnclaveAppCatalog.sel.pendingOwner), rdUintSoft(cat, CONTRACTS.EnclaveAppCatalog.sel.maxFeePerSec6), rdUintSoft(cat, CONTRACTS.EnclaveAppCatalog.sel.catalogSchema)])
              .then(([owner, pending, maxFee, schema]) => ({ addr: cat, owner, pending, maxFee, schema: Number(schema ?? 2) })) : null,
        pay ? Promise.all([rdAddr(pay, pSel.owner), rdAddr(pay, pSel.payout), rdAddr(pay, pSel.usdc), rdAddrSoft(pay, pSel.pendingOwner)])
              .then(([owner, payout, usdc, pending]) => ({ addr: pay, owner, payout, usdc, pending })) : null,
        feat ? Promise.all([rdAddr(feat, fSel.owner), rdAddr(feat, fSel.payout), rdUint(feat, fSel.maxBidPerView6), rdAddrSoft(feat, fSel.pendingOwner),
                            readCampaigns().catch(() => []),
                            fetch(DEFAULT_API_BASE + "/featured-views").then((r) => r.json()).then((j) => j.views || {}).catch(() => null)])
              .then(([owner, payout, maxBid, pending, campaigns, views]) => ({ addr: feat, owner, payout, maxBid, pending, campaigns, views })) : null,
        rev ? Promise.all([rdAddr(rev, rSel.owner), rdAddrSoft(rev, rSel.pendingOwner),
                           rdAddr(rev, rSel.ledger), rdAddr(rev, rSel.ledgerFallback), rdAddr(rev, rSel.book)])
              .then(([owner, pending, ledger, fallback, revBook]) => ({ addr: rev, owner, pending, ledger, fallback, revBook })) : null,
        // credit-vault skew probe: the factory's IMMUTABLE implementation must
        // allowlist the ledger's CURRENT create() selector, or every credit
        // deploy reverts "not create()" (the 2026-08-03 wedge). current: null
        // = the probe itself failed, which paints as "couldn't check", never
        // as healthy.
        E.vaultFactory ? vaultImplCurrent(E.vaultFactory)
              .then((r) => ({ addr: E.vaultFactory, ...r }))
              .catch(() => ({ addr: E.vaultFactory, impl: null, current: null })) : null,
      ]);
      this._note.hidden = true;
      this._paint();
    } catch (e) {
      this._note.hidden = false;
      this._note.textContent = "chain read failed: " + (e.message || e) + " - retry below.";
      this._body.hidden = false;
      this._body.innerHTML = `<button class="btn btn-sm" data-act="refresh">Retry</button>`;
    }
  }

  /* ---------- painting ---------- */

  _paintSigner() {
    const el = this.querySelector("#acSigner");
    const me = lc(Enclave.address);
    if (!el || !me) return;                        // locked (or mid-lock repaint): nothing to paint
    const chips = [];
    const chip = (label, ownerAddr) => {
      if (!ownerAddr) return;
      const ok = lc(ownerAddr) === me;
      chips.push(`<span class="ac-chip ${ok ? "ok" : "no"}" title="${esc(ownerAddr)}">${esc(label)} ${ok ? "✓" : "✗"}</span>`);
    };
    const S = this.S || {};
    chip("book", S.book && S.book.owner);
    chip("deployments", S.dep && S.dep.owner);
    chip("catalog", S.cat && S.cat.owner);
    chip("pay", S.pay && S.pay.owner);
    chip("featured", S.feat && S.feat.owner);
    chip("reviews", S.rev && S.rev.owner);
    el.innerHTML = `<span class="ac-who">signing as <b class="ac-addr">${esc(Enclave.address)}</b></span>${chips.join("")}
      <button class="btn btn-sm ac-refresh" data-refresh>↻ Refresh</button>`;
    const r = el.querySelector("[data-refresh]");
    if (r) r.addEventListener("click", () => this.refresh());
  }

  _row(label, current, act, opts = {}) {
    const id = act.replace(/[^a-z0-9]/gi, "");
    return `<div class="ac-row">
      <div class="ac-lbl" id="lbl-${id}">${label}${opts.hint ? `<span class="ac-hint">${opts.hint}</span>` : ""}</div>
      <div class="ac-cur">${current}</div>
      <input class="ac-in" id="in-${id}" data-for="${act}" aria-labelledby="lbl-${id}" type="text" placeholder="${esc(opts.placeholder || "0x…")}" spellcheck="false" autocomplete="off" />
      <span class="ac-live" id="live-${id}"></span>
      <button class="btn btn-sm ac-apply" data-act="${act}" data-owner="${esc(opts.owner || "")}">${esc(opts.verb || "Set")}</button>
    </div>`;
  }

  _paint() {
    const S = this.S;
    const me = lc(Enclave.address);   // connected wallet — used by the danger-zone Accept affordance
    const sec = (title, sub, inner) => `<section class="ac-panel">
      <h3>${title}</h3>${sub ? `<p class="ac-sub">${sub}</p>` : ""}${inner}
      <div class="ac-status" role="status" aria-live="polite" hidden></div>
    </section>`;
    const link = (a) => `<a href="${EXPLORER}/address/${esc(a)}" target="_blank" rel="noopener">${esc(short(a))}</a>`;
    const parts = [];

    /* -- what the platform is doing right now (filled asynchronously by
          _loadMetrics: whole-ledger read, event-log scan, fleet poll) -- */
    parts.push(metricsPanel());

    /* -- address book -- */
    {
      const E = S.book.entries;
      const keys = [...BOOK_KEYS, ...Object.keys(E).filter((k) => !BOOK_KEYS.includes(k))];
      const rows = keys.map((k) => this._row(
        `<code>${esc(k)}</code>`,
        E[k] ? mono(E[k]) : `<span class="dim">(unset)</span>`,
        "book-set:" + k, { owner: S.book.owner, verb: "Set" })).join("");
      const custom = `<div class="ac-row ac-row-new">
        <input class="ac-in ac-in-key" id="newBookKey" aria-label="New address-book key" type="text" placeholder="new key (ascii, ≤31)" spellcheck="false" />
        <span></span>
        <input class="ac-in" id="newBookVal" aria-label="Value" type="text" placeholder="0x…" spellcheck="false" />
        <span></span>
        <button class="btn btn-sm" data-act="book-set-new" data-owner="${esc(S.book.owner)}">Add key</button>
      </div>`;
      parts.push(sec(`Address book · ${link(S.book.addr)}`,
        `The platform's one on-chain root - enclaves, this site, the relays, and the CLI re-resolve every address from it within ≤5 min of a change. Owner ${mono(S.book.owner)}. Setting a key to the zero address retires it (readers keep their baked fallback).`,
        rows + custom));
    }

    /* -- deployments -- */
    if (S.dep) {
      const d = S.dep;
      const priced = d.gpu != null || d.cpu != null;   // rev <= 7: the platform still sets the price
      parts.push(sec(`EnclaveDeployments · ${link(d.addr)}`,
        priced
          ? `Prices are µUSDC per second for a FULL card / node; existing deployments keep the rate they were created at. Owner ${mono(d.owner)}.`
          : `This ledger (schema ${d.schema}) sets no prices: every enclave publishes its own per-machine rate in its EnclaveRegistry entry, `
            + `a deployment is charged its shares of whichever enclave claims it, and each deployment's own maxRate6 caps that. `
            + `Re-price the fleet by changing an enclave's SELL_CPU_PRICE6 / SELL_GPU_PRICE6 (it republishes on its next heartbeat). Owner ${mono(d.owner)}.`,
        (priced
          ? this._row("GPU price <code>setPrice</code>", `${d.gpu} <span class="dim">(≈ ${perHr(d.gpu)})</span>`, "dep-gpu", { owner: d.owner, placeholder: String(d.gpu), hint: "µUSDC/s" }) +
            this._row("CPU price <code>setCpuPrice</code>", `${d.cpu} <span class="dim">(≈ ${perHr(d.cpu)})</span>`, "dep-cpu", { owner: d.owner, placeholder: String(d.cpu), hint: "µUSDC/s" })
          : `<div class="ac-row"><div class="ac-lbl">Pricing</div><div class="ac-cur"><span class="dim">per enclave (registry entries), not per platform — nothing to set here</span></div><span></span><span></span><span></span></div>`) +
        (d.maxGpu == null
          ? `<div class="ac-row"><div class="ac-lbl">GPU share cap <code>setMaxGpuMilli</code></div><div class="ac-cur"><span class="dim">not in this contract rev — redeploy EnclaveDeployments to enable the cap</span></div><span></span><span></span><span></span></div>`
          : this._row("GPU share cap <code>setMaxGpuMilli</code>", `${d.maxGpu} <span class="dim">(${Number(d.maxGpu) / 10}% of a card max per NEW deployment; existing records untouched)</span>`, "dep-maxgpu", { owner: d.owner, placeholder: String(d.maxGpu), hint: "0…1000 milli" })) +
        (d.maxFee == null
          ? `<div class="ac-row"><div class="ac-lbl">Publisher fee cap <code>setMaxFee</code></div><div class="ac-cur"><span class="dim">not in this contract rev — redeploy EnclaveDeployments to enable publisher fees</span></div><span></span><span></span><span></span></div>`
          : this._row("Publisher fee cap <code>setMaxFee</code>", `${d.maxFee} <span class="dim">(≈ ${perHr(d.maxFee)} max per NEW deployment's fee snapshot; keep in lockstep with the catalog's cap)</span>`, "dep-maxfee", { owner: d.owner, placeholder: String(d.maxFee), hint: "µUSDC/s" })) +
        this._row("Lease <code>setLeaseSec</code>", `${d.lease}s`, "dep-lease", { owner: d.owner, placeholder: String(d.lease), hint: "60…86400 s" }) +
        this._row("ETH/USD feed <code>setEthUsdFeed</code>", isZero(d.feed) ? `<span class="dim">disabled (0x0)</span>` : mono(d.feed), "dep-feed", { owner: d.owner, hint: "0x0 disables ETH funding" }) +
        this._row("Payout <code>setPayout</code>", mono(d.payout), "dep-payout", { owner: d.owner })));
    } else parts.push(sec("EnclaveDeployments", `<span class="warn">not in the address book</span> - deploy one below, or set the <code>deployments</code> key.`, ""));

    /* -- proof of time (rev >= 9): the prover binding + the metering cutover --
       setProver is ONE-SHOT and permanent by design (a seller's proof of
       service must not be re-pointable at a contract swapped in later), so it
       gets the typed-confirmation treatment and refuses to paint a Bind button
       once a prover is set. */
    if (S.dep && S.dep.schema >= 9) {
      const d = S.dep;
      const bound = d.prover && !isZero(d.prover);
      const from = d.proofFrom == null ? null : Number(d.proofFrom);
      const live = from ? (Date.now() / 1000 >= from) : false;
      const bookProver = S.book.entries.proofOfTime;
      parts.push(sec(`Proof of time · ledger ${link(d.addr)}`,
        `Hosts are paid for service they PROVE, not lease time they hold. The bound EnclaveProofOfTime is the only contract that may advance a deployment's <code>provenUntil</code> watermark; `
        + `the ledger re-applies every clamp that touches money, so the worst a broken prover can do is degrade metering to held time. `
        + `The binding is <b>permanent</b> - a different prover needs a new ledger.`,
        `<div class="ac-row"><div class="ac-lbl">Registry it reads <span class="ac-hint">immutable; proof keys and prices come from here</span></div><div class="ac-cur">${mono(d.registry)}${
            bookProver === undefined && S.book.entries.registry && lc(S.book.entries.registry) !== lc(d.registry)
              ? ` <span class="warn">≠ the book's <code>registry</code> (${short(S.book.entries.registry)}) - this ledger will keep reading the one above, forever</span>` : ""
          }</div><span></span><span></span><span></span></div>`
        + (bound
          ? `<div class="ac-row"><div class="ac-lbl">Prover <code>setProver</code></div><div class="ac-cur">${mono(d.prover)} <span class="dim">bound and frozen ✓</span>${
              bookProver && lc(bookProver) !== lc(d.prover) ? ` <span class="warn">the book's <code>proofOfTime</code> is ${short(bookProver)} - enclaves will send checkpoints to a contract this ledger does not accept</span>` : ""
            }${!bookProver ? ` <span class="warn">not in the address book yet - running enclaves cannot find it; set the <code>proofOfTime</code> key above</span>` : ""}</div><span></span><span></span><span></span></div>`
          : this._row(`Prover <code>setProver</code> <span class="warn">ONE-SHOT</span>`, `<span class="warn">unbound</span> <span class="dim">- checkpoints are rejected; hosts earn on held time until the cutover, then nothing</span>`,
              "dep-prover", { owner: d.owner, placeholder: bookProver || "0x… (the EnclaveProofOfTime deploy)", verb: "Bind", hint: "permanent - cannot be changed or cleared" })
            + `<div class="ac-row"><div class="ac-lbl">Confirm</div><div class="ac-cur"><span class="dim">type BIND to enable the button's transaction</span></div><input class="ac-in" id="cf-dep-prover" placeholder="BIND" spellcheck="false" autocomplete="off" /><span></span><span></span></div>`)
        + (from === null
          ? `<div class="ac-row"><div class="ac-lbl">Cutover <code>setProofRequiredFrom</code></div><div class="ac-cur"><span class="dim">not in this contract rev</span></div><span></span><span></span><span></span></div>`
          : this._row("Cutover <code>setProofRequiredFrom</code>",
              from === 0
                ? `<span class="dim">0 - metering stays on HELD time; checkpoints are recorded but never gate pay</span>`
                : `${new Date(from * 1000).toLocaleString()} <span class="dim">(${live ? "LIVE - unproven time earns nothing" : "grace: held-time metering until then"})</span>`,
              "dep-prooffrom", { owner: d.owner, placeholder: String(from), hint: "unix seconds; 0 = never (two-way kill switch)" }))));
    }

    /* -- pay -- */
    if (S.pay) {
      parts.push(sec(`EnclavePay · ${link(S.pay.addr)}`,
        `The gasless-funding forwarder. USDC ${mono(S.pay.usdc)} (immutable). Owner ${mono(S.pay.owner)}.`,
        this._row("Payout <code>setPayout</code>", mono(S.pay.payout), "pay-payout", { owner: S.pay.owner })));
    }


    /* -- featured slot -- */
    if (S.feat) {
      const f = S.feat;
      const perK = (b) => "$" + (Number(b) * 1000 / 1e6).toFixed(2);
      const usd = (b) => "$" + (Number(b) / 1e6).toFixed(2);
      const rows = (f.campaigns || []).map((c) => {
        const views = f.views ? (f.views[c.appId] || 0) : null;
        const settledEst = c.bidPerView6 > 0 ? Math.floor(Number(c.spent6) / Number(c.bidPerView6)) : 0;
        const suggest = views == null ? "" : Math.max(0, views - settledEst);
        const id = "featsettle" + c.appId.slice(2, 10);
        return `<div class="ac-row">
          <div class="ac-lbl" id="lbl-${id}"><code title="${esc(c.appId)}">${esc(short(c.appId))}</code> by ${esc(short(c.advertiser))}
            <span class="ac-hint">${c.active ? "active" : "PAUSED"} · <button class="btn btn-sm" data-act="feat-active:${esc(c.appId)}:${c.active ? 0 : 1}" data-owner="${esc(f.owner)}">${c.active ? "pause" : "resume"}</button></span></div>
          <div class="ac-cur">${perK(c.bidPerView6)}/1k · bal ${usd(c.balance6)} · spent ${usd(c.spent6)}${views == null ? "" : ` · <b>${views}</b> lifetime views (≈${settledEst} settled)`}</div>
          <input class="ac-in" id="in-${id}" data-for="feat-settle:${esc(c.appId)}" aria-labelledby="lbl-${id}" type="text" placeholder="views to settle" value="${suggest}" spellcheck="false" autocomplete="off" />
          <span class="ac-live" id="live-${id}"></span>
          <button class="btn btn-sm ac-apply" data-act="feat-settle:${esc(c.appId)}" data-owner="${esc(f.owner)}">Settle</button>
        </div>`;
      }).join("");
      parts.push(sec(`EnclaveFeatured · ${link(f.addr)}`,
        `The store's featured slot: per-view campaigns escrow USDC; settle a metered view count to draw bid × views to the payout (capped at the escrow - the meter can only ever under-charge). Lifetime views come from the gateway (${esc(DEFAULT_API_BASE)}/featured-views); "≈ settled" assumes the bid hasn't changed. Owner ${mono(f.owner)}.`,
        this._row("Bid cap <code>setMaxBid</code>", `${f.maxBid} <span class="dim">(µUSDC per view · ${perK(f.maxBid)}/1k max)</span>`, "feat-maxbid", { owner: f.owner, placeholder: String(f.maxBid), hint: "µUSDC/view" }) +
        this._row("Payout <code>setPayout</code>", mono(f.payout), "feat-payout", { owner: f.owner }) +
        (rows || `<div class="ac-row"><div class="ac-lbl">Campaigns</div><div class="ac-cur"><span class="dim">none yet - publishers open them from the Apps page ("Promote your app")</span></div><span></span><span></span><span></span></div>`)));
    }

    /* -- reviews -- */
    if (S.rev) {
      const r = S.rev;
      // the receipt gate resolves its ledger THROUGH the book on every call,
      // so it can't drift; what's worth surfacing is WHICH source answered -
      // falling back means the book's `deployments` key is unset/zero
      const viaBook = !isZero(r.revBook) && S.dep && lc(r.ledger) === lc(S.dep.addr);
      parts.push(sec(`EnclaveReviews · ${link(r.addr)}`,
        `1-5 star ratings with comments. A review is only accepted from a wallet with a FUNDED deployment of that app - so ratings come from people who ran the app. Per-review moderation (hide / unhide) lives on the <a href="apps">Apps page</a> when you browse an app with the owner wallet; it isn't duplicated here. Hiding drops a review from the average and keeps its bytes on-chain. Owner ${mono(r.owner)}.`,
        `<div class="ac-row"><div class="ac-lbl">Receipt ledger <code>ledger()</code></div>
          <div class="ac-cur">${mono(r.ledger)} ${viaBook
            ? `<span class="dim">· follows the address book, no action needed</span>`
            : `<b class="ac-warn">· via the fallback (the book's <code>deployments</code> key is unset)</b>`}</div>
          <span></span><span></span><span></span></div>` +
        this._row("Ledger fallback <code>setLedgerFallback</code>",
          `${isZero(r.fallback) ? `<span class="dim">(unset)</span>` : mono(r.fallback)} <span class="dim">(used only when the book can't answer)</span>`,
          "rev-fallback", { owner: r.owner, placeholder: (S.dep && S.dep.addr) || "0x…" })));
    }

    /* -- catalog pointer -- */
    if (S.cat) {
      const feeRow = S.cat.maxFee == null
        ? `<div class="ac-row"><div class="ac-lbl">Publisher fee cap <code>setMaxFee</code></div><div class="ac-cur"><span class="dim">not in this contract rev — redeploy EnclaveAppCatalog to enable publisher fees</span></div><span></span><span></span><span></span></div>`
        : this._row("Publisher fee cap <code>setMaxFee</code>", `${S.cat.maxFee} <span class="dim">(≈ ${perHr(S.cat.maxFee)} max per NEW version at publish; released versions keep their fee)</span>`, "cat-maxfee", { owner: S.cat.owner, placeholder: String(S.cat.maxFee), hint: "µUSDC/s" });
      // Publisher recovery: bulk transferApp (rev >= 6). Takes an explicit
      // catalog ADDRESS because the recovery runs on a FRESH deploy before the
      // book points at it (migrate -> verify -> seal -> transfer -> point the
      // book) - between seal and transfer the compromised key still holds its
      // publisher rights on the new contract, so the safe order moves the apps
      // while nothing serves from it yet.
      const recovery = `
        <div class="ac-row"><div class="ac-lbl">Publisher recovery <code>transferApp</code><span class="ac-hint">rev ≥ 6 catalog${S.cat.schema >= 6 ? "" : " — the book's is rev " + S.cat.schema + ": deploy fresh, migrate, run this THERE, then point the book"}</span></div>
          <div class="ac-cur">Move EVERY app one wallet published to a new wallet in one batch - the compromised-publisher-key remedy. AppIds, versions, approvals and every deployment's <code>catalog://</code> reference stay put; the old key keeps no rights and never has to sign.</div>
          <span></span><span></span><span></span></div>
        <div class="ac-xfer-ctl">
          <input class="ac-in" id="xferCat" aria-label="Catalog contract address" value="${esc(S.cat.addr)}" placeholder="catalog 0x… (the rev-6 deploy)" spellcheck="false" autocomplete="off" />
          <input class="ac-in" id="xferFrom" aria-label="From publisher" placeholder="from publisher 0x… (Load apps suggests one)" spellcheck="false" autocomplete="off" />
          <input class="ac-in" id="xferTo" aria-label="To wallet" value="${esc(Enclave.address || "")}" placeholder="to wallet 0x…" spellcheck="false" autocomplete="off" />
        </div>
        <div class="ac-mig-actions">
          <button class="btn btn-sm" data-act="cat-xfer-load">Load apps</button>
          <input class="ac-in ac-in-key" id="xferConfirm" aria-label="Type TRANSFER to confirm" placeholder='type "TRANSFER"' spellcheck="false" autocomplete="off" />
          <button class="btn btn-primary btn-sm ac-danger-btn" data-act="cat-xfer-run" disabled>Transfer all</button>
        </div>
        <div class="ac-mig-log" id="xferLog" role="log" aria-label="Publisher recovery log" hidden></div>`;
      parts.push(sec(`EnclaveAppCatalog · ${link(S.cat.addr)}`,
        `Owner ${mono(S.cat.owner)}. Moderation (approve / reject / verify / delist) already lives on the <a href="apps">Apps page</a> when you browse it with the owner wallet - it isn't duplicated here.`,
        feeRow + recovery));
    }

    /* -- deploy cards -- */
    {
      // Every constructor argument this console can already answer from the
      // chain is filled in - hand-pasting a known address is just a chance to
      // paste the wrong one. Each entry falls back to a sibling contract's
      // value when the contract being replaced isn't deployed yet.
      const payoutAddr = (S.dep && S.dep.payout) || (S.pay && S.pay.payout) || (S.feat && S.feat.payout);
      const pre = {
        EnclavePay: { usdc: USDC_BASE, payout: (S.pay && S.pay.payout) || payoutAddr },
        EnclaveDeployments: { usdc: USDC_BASE, payout: payoutAddr, registry: S.book.entries.registry, ethUsdFeed: S.dep && S.dep.feed },
        EnclaveFeatured: { usdc: USDC_BASE, payout: (S.feat && S.feat.payout) || payoutAddr },
        EnclaveReviews: { book: S.book.addr, ledgerFallback: S.book.entries.deployments || (S.dep && S.dep.addr) },
        // host ratings take ONE ctor arg: the book (no fallback by design)
        EnclaveHostReviews: { book: S.book.addr },
        PaymentRouter: { usdc: USDC_BASE, treasury: payoutAddr },
        // origin0 prefills from THIS page's origin: the console is served from the
        // canonical site origin, so it already knows the value every future vault
        // gets pinned to. origin1 is the optional second slot (a www pair).
        // Keep each entry on ONE line - test/admin-console.test.mjs parses this
        // map by line to prove no constructor arg renders as an empty box.
        // recoveryAdmin defaults to the governance wallet: it may ONLY forward a
        // superseded vault's balance to that same customer's vault at the
        // current factory (never to us), which is what lets a future factory
        // migration move credit without a passkey tap from every customer
        EnclaveCreditVaultFactory: { usdc: USDC_BASE, book: S.book.addr, treasury: (S.vlt && S.vlt.treasury && !isZero(S.vlt.treasury)) ? S.vlt.treasury : payoutAddr, recoveryAdmin: S.book.owner, origin0: location.origin, origin1: "" },
        // proof of time binds to the LEDGER + REGISTRY pair it verifies against, both immutably
        EnclaveProofOfTime: { deployments: S.book.entries.deployments || (S.dep && S.dep.addr), registry: S.book.entries.registry },
      };
      const notes = {
        EnclaveAddressBook: `<span class="warn">redeploying the book replaces the ONE address baked into every component</span> - that path needs the config/site/CLI rebake + a release + a dashboard update. Use <code>scripts/deploy-address-book.mjs</code> instead unless you know exactly why.`,
        EnclaveRegistry: `EnclaveDeployments pins the registry it trusts at construction - after a registry redeploy, redeploy EnclaveDeployments too (pointed at the new registry), then update both book keys.`,
        EnclaveProofOfTime: `<span class="warn">the ledger's setProver binding is ONE-SHOT and permanent</span> - deploy this, then send <code>EnclaveDeployments.setProver</code> once, then publish the <code>proofOfTime</code> book key so running enclaves pick it up. A rev-9 ledger with no prover bound pays HELD time (rev-8 behaviour); past its <code>proofRequiredFrom</code> cutover with no prover, hosts prove nothing and earn nothing. See <code>scripts/deploy-proof-of-time.mjs</code>, which checks the whole pair before broadcasting.`,
        EnclaveDeployments: `deploys with the source-default prices - adjust in the panel above after pointing the book. Existing deployments live on in the OLD contract; users top up there until they redeploy.`,
        EnclaveReviews: `resolves the ledger it checks receipts against through the BOOK on every call, so a later EnclaveDeployments redeploy needs nothing here. <code>ledgerFallback</code> is only consulted when the book has no <code>deployments</code> key.`,
        EnclaveHostReviews: `ratings for the ENCLAVES that run apps (receipt = your funded deployment whose <code>runner</code> is that box). The BOOK is the only ledger source - resolved on every call, so a later EnclaveDeployments redeploy needs nothing here, and there is deliberately no fallback address to go stale (the live EnclaveReviews carries one three revisions out of date). Book key: <code>hostReviews</code>.`,
        PaymentRouter: `<span class="warn">IMMUTABLE - no owner, no setters</span>: <code>treasury</code> is burned in at deploy (prefilled from the current payout - change it deliberately). Rotating the treasury = deploying a new router and repointing the book key + the relay's <code>PAYMENT_ROUTER_ADDRESS</code>.`,
        EnclaveCreditVaultFactory: `deploys the vault IMPLEMENTATION in its constructor; customer vaults are CREATE2 clones keyed by passkey. <span class="warn">No owner anywhere</span> - vault funds move to the PLATFORM only on customer passkey signatures. <code>recoveryAdmin</code> is the single exception and cannot profit us: it may call <code>migrateToSuccessor</code>, which forwards a superseded vault's whole balance to <em>that same customer's</em> vault at the book's current factory (a derived destination, spendable only by their passkey) - so a future factory migration moves credit without asking every customer to tap. Zero declines that power permanently. Existing vaults keep their old factory forever; repointing <code>vaultFactory</code> only changes where NEW vaults come from.`,
      };
      const cards = Object.keys(CONTRACTS).map((name) => {
        const c = CONTRACTS[name];
        const p = pre[name] || {};
        const inputs = c.ctor.map((a) => `<label class="ac-ctor-l">${esc(a.name)} <span class="ac-hint">${esc(a.type)}</span>
          <input class="ac-in ac-ctor" data-ctor="${esc(a.name)}" data-ctor-type="${esc(a.type)}" type="text" value="${esc(p[a.name] || "")}" placeholder="${a.type === "string" ? esc(/^origin/.test(a.name) ? "https://enclave.host" : "") : "0x…"}" spellcheck="false" /></label>`).join("");
        return `<div class="ac-card" data-card="${esc(name)}">
          <h4>${esc(name)}<span class="ac-hint">${(c.bytecode.length / 2 - 1).toLocaleString()} bytes${c.bookKey ? ` · book key <code>${esc(c.bookKey)}</code>` : " · not a book entry"}</span></h4>
          ${notes[name] ? `<p class="ac-sub">${notes[name]}</p>` : ""}
          ${inputs || `<p class="ac-sub dim">no constructor arguments - the deployer becomes ${name === "EnclaveRegistry" ? "(no owner - open registration)" : "owner"}.</p>`}
          <button class="btn btn-primary btn-sm" data-act="deploy:${esc(name)}">Deploy ${esc(name)}</button>
          <div class="ac-deploy-out" hidden></div>
          <div class="ac-status" role="status" aria-live="polite" hidden></div>
        </div>`;
      }).join("");
      parts.push(`<section class="ac-panel"><h3>Deploy a contract</h3>
        <p class="ac-sub">Compiled from <code>contracts/*.sol</code> at site build time with the deploy scripts' exact solc settings; the deploy is a raw creation transaction from your wallet. After it confirms, point the address book at the new contract in one click - the whole platform follows within a poll. Then refresh the repo's baked fallbacks when convenient: paste the new address into <code>enclaves/gpu/tinfoil-config.yml</code> (catalog: <code>site/js/core/config.js</code>), run <code>scripts/sync-contract-addresses.sh</code>, commit.</p>
        <div class="ac-cards">${cards}</div><div class="ac-status" role="status" aria-live="polite" hidden></div></section>`);
    }

    /* -- credit-vault factory skew -- */
    if (S.vlt) {
      const saved = this._vltSaved();
      const wedged = S.vlt.current === false;
      // "current but a migration is mid-flight": the book already points at a
      // healthy factory, yet a previous run recorded an old factory whose
      // funded vaults may not all be re-minted/fronted - keep the flow up
      const resuming = S.vlt.current === true && saved.oldFactory && lc(saved.oldFactory) !== lc(S.vlt.addr);
      if (wedged || resuming) {
        parts.push(`<section class="ac-panel"><h3><span class="warn">Credit vaults - ${wedged ? "factory skew" : "migration in flight"}</span></h3>
          <p class="ac-sub">${wedged
            ? `The live factory's immutable implementation ${mono(S.vlt.impl || "?")} does <b>not</b> allowlist the ledger's current <code>create()</code> selector (<code>${esc(DEP_SEL.create)}</code>): every credit <code>deployAndFund</code> reverts <code>not create()</code>, and vault USDC only moves on customer passkey signatures - no admin path can touch it.`
            : `The book already points at a current factory, but the migration from ${mono(saved.oldFactory)} hasn't finished - re-scan and run to complete the delta.`}
          One flow, all from this wallet: deploy the current factory build (skipped if done), repoint the book key <code>vaultFactory</code> (skipped if done), re-mint every funded vault from its customer's <b>same passkey</b> - the P-256 pubkey is replayed from the old factory's <code>createVault</code> calldata, so custody never changes, only the address - and <b>front each old balance in USDC from the connected wallet</b> so every customer is whole immediately. The stranded originals repay the treasury as customers sign refunds; re-running after any interruption resumes as a delta from live chain state.</p>
          <div class="ac-mig-ctl"><input class="ac-in" id="vltOld" aria-label="Old (wedged) factory address" placeholder="old factory 0x…" value="${esc(wedged ? S.vlt.addr : saved.oldFactory || "")}" spellcheck="false" autocomplete="off" /></div>
          <div class="ac-mig-actions">
            <button class="btn btn-sm" data-act="vlt-scan">Scan old factory</button>
            <button class="btn btn-primary btn-sm ac-danger-btn" data-act="vlt-run" disabled>Migrate + front the credit</button>
          </div>
          <div class="ac-mig-log" id="vltLog" role="log" aria-label="Vault migration log" hidden></div>
        </section>`);
      } else {
        parts.push(`<section class="ac-panel"><h3>Credit vaults · ${link(S.vlt.addr)}</h3>
          <p class="ac-sub">${S.vlt.current === true
            ? `implementation ${mono(S.vlt.impl)} allowlists the ledger's current <code>create()</code> (<code>${esc(DEP_SEL.create)}</code>) - in sync. If a ledger revision ever reshapes <code>create()</code> again, this panel becomes the recovery flow.`
            : `<span class="warn">couldn't probe the factory's implementation</span> - a flaky RPC read, most likely. Refresh; if it persists, the factory address in the book may not be a vault factory at all.`}
          ${S.vlt.recovery === false
            ? ` This factory was built <span class="warn">without <code>migrateToSuccessor</code></span>: if it is ever superseded, every funded vault it minted needs its customer's passkey to move - deploy the current build to fix that (see the vault-factory card below).`
            : S.vlt.recovery === true ? ` Its vaults carry <code>migrateToSuccessor</code>, so a future migration moves credit on its own - no customer taps.` : ""}</p>
        </section>`);
      }

    }

    /* -- one-button paired-revision rollout (ledger rev 12 + registry schema 4) -- */
    if (S.dep && (Number(S.dep.schema || 0) < REV12.ledgerRev || this._r12Saved().retire)) {
      const saved = this._r12Saved();
      const onlyRetire = Number(S.dep.schema || 0) >= REV12.ledgerRev && saved.retire;
      const usd = (v6) => "$" + (Number(v6) / 1e6).toFixed(2);
      parts.push(`<section class="ac-panel"><h3>Roll out ${esc(REV12.title)} <span class="ac-hint">ledger rev ${REV12.ledgerRev} · registry schema ${REV12.registryRev}</span></h3>
        ${onlyRetire ? `<p class="ac-sub"><b>Rev ${REV12.ledgerRev} is live</b> - the book points at ${mono(S.dep.addr)}. One step remains: retiring the previous ledger ${mono(saved.retire)}, which is one-way and should wait until the fleet is demonstrably serving from the new one. Click below when you have checked a running deployment.</p><p class="ac-sub" hidden>` : `<p class="ac-sub">`}${esc(REV12.summary)} The live ledger ${mono(S.dep.addr)} is rev ${esc(String(S.dep.schema))}, so this needs the whole set: the ledger reads a field only a schema-${REV12.registryRev} registry carries, and <code>EnclaveProofOfTime</code> holds both as immutables. <b>One button does all of it</b> - deploy registry, ledger and prover (skipping any this flow already deployed), bind the prover, carry the proof cutover across, migrate every deployment record, re-seat the runner escrow, verify field-by-field, seal the imports, and point the book at all three in a single <code>setMany</code>. Re-click after any interruption: every step re-probes live chain state and resumes at the first thing that is not already true.</p>
        <p class="ac-sub"><b>It spends real USDC once.</b> Runner escrow is a balance the old ledger HOLDS and keeps, so it cannot be imported - every migrated record lands unbacked, and until it is re-seated from this wallet a seller serving it earns nothing and its owner's refund pays nothing. The first click prices that exactly and signs nothing; the second runs. The one destructive step, <b>retiring the old ledger</b>, is deliberately left out of the run: it is offered on a later click, once the fleet has actually followed the book (~10 min).</p>
        ${saved.ledger || saved.registry ? `<p class="ac-sub warn">A previous run left ${[saved.registry ? "registry " + short(saved.registry) : null, saved.ledger ? "ledger " + short(saved.ledger) : null, saved.prover ? "prover " + short(saved.prover) : null].filter(Boolean).join(", ")} deployed but not yet live. The run reuses them rather than paying to deploy again.</p>` : ""}
        <div class="ac-mig-actions">
          <button class="btn btn-primary btn-sm ac-danger-btn" data-act="r12-run">${onlyRetire ? `Retire the old ledger` : `Roll out rev ${REV12.ledgerRev}`}</button>
          <button class="btn btn-sm" data-act="r12-forget">Forget saved deploys</button>
        </div>
        <div class="ac-mig-log" id="r12Log" role="log" aria-label="Rollout log" hidden></div>
      </section>`);
    }

    /* -- migrate -- */
    {
      parts.push(`<section class="ac-panel"><h3>Migrate data</h3>
        <p class="ac-sub">Move a contract's ENTIRE state into a freshly deployed import-capable revision: read the source, replay everything through the target's owner-gated import functions - packed via <code>multicall</code>, so the whole migration is typically <b>one wallet confirmation</b> - verify the copy field-by-field, then permanently seal the imports. The plan is a delta: re-clicking Migrate resumes an interrupted run and picks up records created on the source since the last pass (do one last pass right before pointing the book, then seal). Targets deployed before 2026-07-07 have no import surface and are rejected.</p>
        <div class="ac-mig-ctl">
          <select class="ac-in ac-in-key" id="migKind" aria-label="Migration kind">${Object.entries(MIG_KINDS).map(([k, m]) => `<option value="${k}">${esc(m.label)}</option>`).join("")}</select>
          <input class="ac-in" id="migSource" aria-label="Source contract address" placeholder="source 0x…" spellcheck="false" autocomplete="off" />
          <input class="ac-in" id="migTarget" aria-label="Target contract address" placeholder="target 0x… (the new deploy)" spellcheck="false" autocomplete="off" />
        </div>
        <p class="ac-sub"><b>Refund sweep first</b> (deployments ledger only): before the snapshot, suspend and refund every record the CONNECTED wallet owns <em>on the source</em> - each refund pays this wallet back and zeroes the record, so it migrates empty: nothing for Back escrow to front, and nothing left pullable twice (a rev-10 source keeps a live <code>refund()</code> forever). Batched via <code>multicall</code>: typically one Suspend confirmation, a ~minute wait while the fleet releases, then one Refund confirmation - re-scan to collect lease tails that were still reserved. On a rev-10 source <code>refund()</code> is owner-gated, so third-party records are only counted; their owners collect there themselves. A rev-11 source can instead be <b>retired</b> (one-way, AFTER the fleet points at the successor): claims, renewals and funding close forever, <code>refund()</code> opens to any caller <em>still paying each record's own wallet</em>, and the sweep widens to every user's records - nobody's funds can be trapped by the redeploy.</p>
        <div class="ac-mig-actions">
          <button class="btn btn-sm" data-act="mig-swp-scan">Scan source</button>
          <button class="btn btn-sm" data-act="mig-swp-stop" disabled>Suspend mine</button>
          <button class="btn btn-sm" data-act="mig-swp-refund" disabled>Refund</button>
          <button class="btn btn-sm ac-danger-btn" data-act="mig-swp-retire">Retire source ledger</button>
        </div>
        <p class="ac-sub">Runner escrow is the one thing that cannot be imported: it is real USDC the SOURCE holds and keeps. Every migrated record therefore lands with <code>escrow6 = 0</code>, and until <b>Back escrow</b> re-seats it a seller serving that deployment earns nothing and its owner's refund pays nothing. Do it BEFORE sealing - while imports are open the backing is credited to each record's OWNER (it is re-seating money they already paid), and after sealing it is not, permanently. A completed refund sweep leaves nothing to back.</p>
        <label class="ac-ctor-l ac-mig-opt"><input type="checkbox" id="migGrantRates" checked /> Grant a runner rate to records that have none <span class="ac-hint">records predating the runner meter arrive at rate6 = 0: they can never pay a seller, can never be escrow-backed, and can never be refunded. Grants <code>runnerBps</code> of each one's rate minus its publisher fee, exactly what create() would have snapshotted.</span></label>
        <div class="ac-mig-actions">
          <button class="btn btn-sm" data-act="mig-read">Read source</button>
          <button class="btn btn-primary btn-sm" data-act="mig-run" disabled>Migrate</button>
          <button class="btn btn-sm" data-act="mig-escrow" disabled>Back escrow (USDC)</button>
          <button class="btn btn-sm" data-act="mig-verify" disabled>Verify</button>
          <button class="btn btn-sm ac-danger-btn" data-act="mig-seal" disabled>Seal target imports</button>
        </div>
        <div class="ac-mig-log" id="migLog" role="log" aria-label="Migration log" hidden></div>
        <div class="ac-status" role="status" aria-live="polite" hidden></div></section>`);
    }

    /* -- danger zone -- */
    {
      const bSel = CONTRACTS.EnclaveAddressBook.sel, cSel = CONTRACTS.EnclaveAppCatalog.sel;
      const dSel = CONTRACTS.EnclaveDeployments.sel, pSel = CONTRACTS.EnclavePay.sel;
      const rows = [
        S.book && { label: "Address book", fn: "setOwner", to: S.book.addr, cur: S.book.owner, pending: S.book.pending, sel: bSel.setOwner, accSel: bSel.acceptOwnership, act: "own-book" },
        S.dep && { label: "EnclaveDeployments", fn: "setOwner", to: S.dep.addr, cur: S.dep.owner, pending: S.dep.pending, sel: dSel.setOwner, accSel: dSel.acceptOwnership, act: "own-dep" },
        S.cat && { label: "EnclaveAppCatalog", fn: "transferOwnership", to: S.cat.addr, cur: S.cat.owner, pending: S.cat.pending, sel: cSel.transferOwnership, accSel: cSel.acceptOwnership, act: "own-cat" },
        S.pay && { label: "EnclavePay", fn: "setOwner", to: S.pay.addr, cur: S.pay.owner, pending: S.pay.pending, sel: pSel.setOwner, accSel: pSel.acceptOwnership, act: "own-pay" },
        S.feat && { label: "EnclaveFeatured", fn: "transferOwnership", to: S.feat.addr, cur: S.feat.owner, pending: S.feat.pending, sel: CONTRACTS.EnclaveFeatured.sel.transferOwnership, accSel: CONTRACTS.EnclaveFeatured.sel.acceptOwnership, act: "own-feat" },
        S.rev && { label: "EnclaveReviews", fn: "transferOwnership", to: S.rev.addr, cur: S.rev.owner, pending: S.rev.pending, sel: CONTRACTS.EnclaveReviews.sel.transferOwnership, accSel: CONTRACTS.EnclaveReviews.sel.acceptOwnership, act: "own-rev" },
      ].filter(Boolean);
      this._ownRows = Object.fromEntries(rows.map((r) => [r.act, r]));
      const inner = rows.map((r) => {
        const hasPending = r.pending && !isZero(r.pending);
        const mePending = hasPending && lc(r.pending) === me;
        const pendingHtml = hasPending
          ? `<div class="ac-pending">pending → ${mono(r.pending)} ${mePending
              ? `<button class="btn btn-sm ac-danger-btn" data-act="acc-${r.act}">Accept</button>`
              : `<span class="dim">(the new key completes it by calling accept)</span>`}</div>`
          : "";
        return `<div class="ac-row">
        <div class="ac-lbl">${esc(r.label)} <code>${esc(r.fn)}</code></div>
        <div class="ac-cur">${mono(r.cur)}</div>
        <input class="ac-in" id="in-${r.act}" aria-label="New owner address" type="text" placeholder="new owner 0x…" spellcheck="false" />
        <input class="ac-in ac-in-key" id="cf-${r.act}" aria-label="Type TRANSFER to confirm" type="text" placeholder='type "TRANSFER"' spellcheck="false" />
        <button class="btn btn-sm ac-danger-btn" data-act="${r.act}" data-owner="${esc(r.cur)}">Nominate</button>
        ${pendingHtml}
      </div>`;
      }).join("");
      parts.push(sec(`<span class="warn">Danger zone - ownership handoffs</span>`,
        `Every one of these is now TWO-STEP: "Nominate" only sets a pending owner — the new key takes control only after IT calls accept from its own wallet, so a typo can't hand the platform to a stranger (the wrong address simply can't accept). Until it accepts, nothing changes: re-nominate to correct, or nominate the zero address to cancel.`,
        inner));
    }

    this._body.innerHTML = parts.join("");
    this._body.hidden = false;
    this._paintSigner();
    this._migPrefill();
    this._vltPrefill();
    this._gate();
    this._loadMetrics();
  }

  /* ---------- the 24-hour operations panel ---------- */

  /* Two passes: the ledger + fleet reads paint immediately, the event-log scan
     fills the history charts when it lands (or says why it couldn't). Every
     paint is guarded by a sequence number, so a Refresh mid-scan can't have the
     old run overwrite the new one's charts. */
  async _loadMetrics() {
    const root = this._body.querySelector("#acMetrics");
    if (!root) return;
    const seq = this._mSeq = (this._mSeq || 0) + 1;
    if (!this.S.dep) {
      root.querySelector("#acKpis").innerHTML =
        `<div class="ac-kpi ac-kpi-wait">no <code>deployments</code> key in the address book - there is no ledger to measure.</div>`;
      return;
    }
    try {
      const d = await loadMetrics(
        { depAddr: this.S.dep.addr, apiBase: DEFAULT_API_BASE, leaseSec: Number(this.S.dep.lease) || 3600 },
        (partial) => { if (seq !== this._mSeq) return; paintMetrics(root, partial); this._observePlots(); });
      if (seq !== this._mSeq) return;
      paintHistory(root, d);
    } catch (e) {
      if (seq !== this._mSeq) return;
      root.querySelector("#acKpis").innerHTML =
        `<div class="ac-kpi ac-kpi-wait">the ledger read failed: ${esc(e.message || String(e))} - retry with ↻ Refresh.</div>`;
    }
  }

  /* Charts are drawn at the container's measured width, so a layout change has
     to redraw them. Only a WIDTH change does: heights follow the data, and
     reacting to those would have each redraw trigger the next one. */
  _observePlots() {
    if (this._ro || typeof ResizeObserver === "undefined") return;
    this._ro = new ResizeObserver(() => {
      const root = this._body && this._body.querySelector("#acMetrics");
      if (!root) return;
      const w = root.clientWidth;
      if (w === this._roW) return;
      this._roW = w;
      clearTimeout(this._roT);
      this._roT = setTimeout(() => redrawPlots(root), 120);
    });
    this._ro.observe(this._body);
  }

  /* Prefill the source from the book for the chosen kind and reset the flow.
     _paint() calls this on EVERY repaint, and a repaint follows any owner tx
     (_tx refreshes 1.2s later) - so resetting unconditionally threw away a
     migration's cached source read and re-disabled its buttons mid-flow, with
     the log wiped and no way back except starting over. A migration can span
     many minutes and several confirmations; it must survive a repaint. Reset
     only when the KIND actually changed (or on first paint), and otherwise
     restore what the flow had reached. */
  _migPrefill() {
    const kindSel = this._body && this._body.querySelector("#migKind");
    if (!kindSel) return;
    const m = MIG_KINDS[kindSel.value];
    const M = this._mig;
    const keep = M && M.kind === kindSel.value;
    this._body.querySelector("#migSource").value = keep && M.source
      ? M.source : (this.S.book.entries[m.bookKey] || "");
    if (keep && M.target) this._body.querySelector("#migTarget").value = M.target;
    if (!keep) this._mig = { kind: kindSel.value, data: null };
    const st = this._mig;
    for (const a of ["mig-run", "mig-escrow", "mig-verify", "mig-seal"]) {
      const b = this._body.querySelector(`[data-act="${a}"]`);
      if (!b) continue;
      // restore what the flow had unlocked: a source read unlocks run+verify,
      // a migrate pass unlocks the escrow step, and seal unlocks once verify
      // has RUN (clean or not - the warning lives at the seal, not the gate)
      b.disabled = !(keep && st.data && (a === "mig-run" || a === "mig-verify"
        || (a === "mig-escrow" && st.ranImport) || (a === "mig-seal" && st.verified)));
      if (a === "mig-seal") { delete b.dataset.armed; b.textContent = "Seal target imports"; }
    }
    // _paint() replaces the whole body, so the log element is new and empty -
    // replay the buffered lines rather than losing the audit trail of a
    // migration that may have already sent money
    const log = this._body.querySelector("#migLog");
    log.innerHTML = "";
    const lines = (keep && st.log) || [];
    for (const l of lines) {
      const d = document.createElement("div");
      d.className = l.cls; d.textContent = l.txt;
      log.appendChild(d);
    }
    log.hidden = !lines.length;
    log.scrollTop = log.scrollHeight;
  }

  _migLog(cls, txt) {
    // buffered so a repaint can replay it (see _migPrefill)
    if (this._mig) (this._mig.log = this._mig.log || []).push({ cls, txt });
    this._logTo("migLog", cls, txt);
  }

  /* Hand a stopped rollout over to the manual Migrate panel with both
     addresses already in place: a verify that disagrees is exactly when an
     operator needs the step-by-step tools, and re-typing a 42-character
     address at that moment is how the wrong contract gets sealed. */
  _migHandoff(source, target) {
    const src = this._body && this._body.querySelector("#migSource");
    const tgt = this._body && this._body.querySelector("#migTarget");
    if (!src || !tgt) return;
    this._mig = { kind: "deployments", data: null };
    const kindSel = this._body.querySelector("#migKind");
    if (kindSel) kindSel.value = "deployments";
    src.value = source; tgt.value = target;
    src.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ---------- paired-revision rollout (rollout.js plans, this drives) ------- */

  _r12Log(cls, txt) {
    const R = this._r12 || (this._r12 = {});
    (R.log = R.log || []).push({ cls, txt });
    this._logTo("r12Log", cls, txt);
  }
  /* Addresses deployed by a run that then stopped (a closed tab, a rejected
     signature, an RPC wobble). Without this the next click pays to deploy them
     all over again and orphans the first set. */
  _r12Saved() { try { return JSON.parse(localStorage.getItem(REV12.storeKey) || "{}"); } catch { return {}; } }
  _r12Save(o) {
    try { Object.keys(o).length ? localStorage.setItem(REV12.storeKey, JSON.stringify(o)) : localStorage.removeItem(REV12.storeKey); }
    catch {}
  }

  /* ---------- credit-vault factory migration (vaultmig.js drives) ---------- */

  _vltLog(cls, txt) {
    const V = this._vlt || (this._vlt = {});
    (V.log = V.log || []).push({ cls, txt });
    this._logTo("vltLog", cls, txt);
  }

  /* replay the buffered log + restore what a completed scan had unlocked -
     _paint() replaces the whole body, and this flow sends real money, so the
     audit trail must survive every repaint (the _migPrefill contract) */
  _vltPrefill() {
    const log = this._body && this._body.querySelector("#vltLog");
    if (!log) return;
    const V = this._vlt, lines = (V && V.log) || [];
    log.innerHTML = "";
    for (const l of lines) {
      const d = document.createElement("div");
      d.className = l.cls; d.textContent = l.txt;
      log.appendChild(d);
    }
    log.hidden = !lines.length;
    log.scrollTop = log.scrollHeight;
    const old = this._body.querySelector("#vltOld");
    if (old && V && V.oldFactory) old.value = V.oldFactory;
    const run = this._body.querySelector('[data-act="vlt-run"]');
    if (run && V && V.scan) run.disabled = false;
  }

  /* cross-session resume state: survives a browser restart between the
     factory deploy and the last fronting tx (chain state alone can't name
     the OLD factory once the book has been repointed) */
  _vltSaved() { try { return JSON.parse(localStorage.getItem("enclave_vaultmig") || "{}"); } catch { return {}; } }
  _vltSave(o) { try { Object.keys(o).length ? localStorage.setItem("enclave_vaultmig", JSON.stringify(o)) : localStorage.removeItem("enclave_vaultmig"); } catch {} }

  _logTo(id, cls, txt) {
    const log = this._body.querySelector("#" + id);
    log.hidden = false;
    const d = document.createElement("div");
    d.className = cls; d.textContent = txt;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  /* disable every gated button whose data-owner doesn't match the wallet */
  _gate() {
    if (!this._body) return;
    const me = lc(Enclave.address);
    for (const b of this._body.querySelectorAll("[data-act][data-owner]")) {
      const need = lc(b.dataset.owner);
      const ok = me && need && me === need;
      b.disabled = !ok;
      b.title = ok ? "" : (me ? `owner is ${b.dataset.owner}` : "connect the governance wallet first");
    }
  }

  /* ---------- interaction ---------- */

  _onInput(e) {
    const inp = e.target.closest(".ac-in[data-for]");
    if (!inp) return;
    const live = this._body.querySelector("#live-" + inp.dataset.for.replace(/[^a-z0-9]/gi, ""));
    if (!live) return;
    const act = inp.dataset.for, v = inp.value.trim();
    live.textContent = (act === "dep-gpu" || act === "dep-cpu" || act === "dep-maxfee" || act === "cat-maxfee") && /^\d+$/.test(v) ? "≈ " + perHr(BigInt(v)) : "";
  }

  async _onClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    const panelStatus = btn.closest(".ac-card, .ac-panel")?.querySelector(".ac-status");
    const S = this.S;
    const val = (id) => { const i = this._body.querySelector("#" + id); return i ? i.value.trim() : ""; };
    const inputFor = (a) => val("in-" + a.replace(/[^a-z0-9]/gi, ""));
    const need = (cond, msg) => { if (!cond) { this._status(panelStatus, "err", msg); return false; } return true; };

    try {
      if (act === "refresh") return void this.refresh();

      /* address book sets */
      if (act.startsWith("book-set:")) {
        const key = act.slice(9), v = inputFor(act);
        if (!need(ADDR_RE.test(v), "enter a 0x… address (40 hex); the zero address retires the key")) return;
        return void this._tx(S.book.addr, encCall(CONTRACTS.EnclaveAddressBook.sel.set, [{ t: "bytes32", v: encKey(key) }, { t: "addr", v }]),
          `set ${key} → ${short(v)}`, panelStatus, true);
      }
      if (act === "book-set-new") {
        const key = val("newBookKey"), v = val("newBookVal");
        if (!need(KEY_RE.test(key), "key must be 1–31 ascii chars (letters, digits, - _)")) return;
        if (!need(ADDR_RE.test(v), "enter a 0x… address (40 hex)")) return;
        return void this._tx(S.book.addr, encCall(CONTRACTS.EnclaveAddressBook.sel.set, [{ t: "bytes32", v: encKey(key) }, { t: "addr", v }]),
          `set ${key} → ${short(v)}`, panelStatus, true);
      }

      /* deployments params */
      const dSel = CONTRACTS.EnclaveDeployments.sel;
      if (act === "dep-gpu" || act === "dep-cpu") {
        const v = inputFor(act);
        if (!need(/^\d+$/.test(v) && BigInt(v) > 0n, "price is a positive integer in µUSDC per second (278 ≈ $1.00/hr)")) return;
        return void this._tx(S.dep.addr, encCall(act === "dep-gpu" ? dSel.setPrice : dSel.setCpuPrice, [{ t: "uint", v }]),
          `${act === "dep-gpu" ? "setPrice" : "setCpuPrice"}(${v}) ≈ ${perHr(BigInt(v))}`, panelStatus, true);
      }
      if (act === "dep-maxgpu") {
        const v = inputFor(act);
        if (!need(/^\d+$/.test(v) && +v <= 1000, "cap is 0…1000 milli of one card (1000 = whole card / uncapped, 0 pauses GPU creates)")) return;
        return void this._tx(S.dep.addr, encCall(dSel.setMaxGpuMilli, [{ t: "uint", v }]),
          `setMaxGpuMilli(${v}) — ${+v / 10}% of a card max per deployment`, panelStatus, true);
      }
      if (act === "dep-maxfee" || act === "cat-maxfee") {
        const v = inputFor(act);
        if (!need(/^\d+$/.test(v), "cap is a non-negative integer in µUSDC per second (1389 ≈ $5.00/hr; 0 disables fees on new " + (act === "dep-maxfee" ? "deployments" : "publishes") + ")")) return;
        const [to, sel] = act === "dep-maxfee"
          ? [S.dep.addr, dSel.setMaxFee]
          : [S.cat.addr, CONTRACTS.EnclaveAppCatalog.sel.setMaxFee];
        return void this._tx(to, encCall(sel, [{ t: "uint", v }]),
          `setMaxFee(${v}) ≈ ${perHr(BigInt(v))} publisher-fee cap`, panelStatus, true);
      }
      if (act === "dep-lease") {
        const v = inputFor(act);
        if (!need(/^\d+$/.test(v) && +v >= 60 && +v <= 86400, "lease must be 60…86400 seconds")) return;
        return void this._tx(S.dep.addr, encCall(dSel.setLeaseSec, [{ t: "uint", v }]), `setLeaseSec(${v})`, panelStatus, true);
      }
      /* The one-shot prover binding. Checked here as hard as it can be from a
         browser: the address must carry code, must point BACK at this ledger,
         and must read the same registry - a prover built against a different
         pair silently rejects every checkpoint the fleet ever signs, and there
         is no second attempt. */
      if (act === "dep-prover") {
        const v = inputFor(act);
        if (!need(ADDR_RE.test(v) && !isZero(v), "enter the deployed EnclaveProofOfTime address")) return;
        if (!need(val("cf-dep-prover") === "BIND", "type BIND to confirm - this binding is permanent")) return;
        const pSelPot = CONTRACTS.EnclaveProofOfTime.sel;
        const code = await baseRpc("eth_getCode", [v, "latest"]).catch(() => "0x");
        if (!need(code && code !== "0x", "no contract code at that address on Base")) return;
        const [itsLedger, itsRegistry] = await Promise.all([
          rdAddrSoft(v, pSelPot.deployments), rdAddrSoft(v, pSelPot.registry)]);
        if (!need(lc(itsLedger) === lc(S.dep.addr),
          `that prover is built against ledger ${short(itsLedger)}, not this one (${short(S.dep.addr)}) - it could never credit anything here`)) return;
        if (!need(lc(itsRegistry) === lc(S.dep.registry),
          `that prover reads registry ${short(itsRegistry)} but this ledger reads ${short(S.dep.registry)} - proof keys would be looked up in the wrong place`)) return;
        return void this._tx(S.dep.addr, encCall(dSel.setProver, [{ t: "addr", v }]),
          `setProver(${short(v)}) — permanent`, panelStatus, true);
      }
      if (act === "dep-prooffrom") {
        const v = inputFor(act);
        if (!need(/^\d+$/.test(v), "unix seconds, or 0 to keep metering on held time")) return;
        const n = Number(v);
        if (!need(n === 0 || n > 1_600_000_000, "that is not a plausible unix timestamp (seconds, not milliseconds)")) return;
        if (n !== 0 && !need(!isZero(S.dep.prover || ZERO),
          "bind a prover first - switching to proven-time metering with none bound stops every host's income at the cutover")) return;
        return void this._tx(S.dep.addr, encCall(dSel.setProofRequiredFrom, [{ t: "uint", v }]),
          n === 0 ? "setProofRequiredFrom(0) — metering stays on held time" : `setProofRequiredFrom(${v}) — ${new Date(n * 1000).toLocaleString()}`,
          panelStatus, true);
      }
      if (act === "dep-feed" || act === "dep-payout" || act === "pay-payout" || act === "feat-payout" || act === "rev-fallback") {
        const v = inputFor(act);
        if (!need(ADDR_RE.test(v), "enter a 0x… address (40 hex)")) return;
        // the reviews fallback accepts zero (that's how you retire it and pin
        // the contract to the book alone)
        if (act !== "dep-feed" && act !== "rev-fallback" && !need(!isZero(v), "the zero address is rejected by the contract")) return;
        const map = {
          "dep-feed":   [S.dep.addr, dSel.setEthUsdFeed, "setEthUsdFeed"],
          "dep-payout": [S.dep.addr, dSel.setPayout, "setPayout"],
          "pay-payout": [S.pay.addr, CONTRACTS.EnclavePay.sel.setPayout, "setPayout"],
          "feat-payout": [S.feat && S.feat.addr, CONTRACTS.EnclaveFeatured.sel.setPayout, "setPayout"],
          "rev-fallback": [S.rev && S.rev.addr, CONTRACTS.EnclaveReviews.sel.setLedgerFallback, "setLedgerFallback"],
        };
        const [to, sel, fn] = map[act];
        return void this._tx(to, encCall(sel, [{ t: "addr", v }]), `${fn}(${short(v)})`, panelStatus, true);
      }

      /* featured slot */
      const fSel = CONTRACTS.EnclaveFeatured.sel;
      if (act === "feat-maxbid") {
        const v = inputFor(act);
        if (!need(/^\d+$/.test(v) && BigInt(v) > 0n, "cap is a positive integer in µUSDC per view (10000 = $10.00 per 1k views)")) return;
        return void this._tx(S.feat.addr, encCall(fSel.setMaxBid, [{ t: "uint", v }]),
          `setMaxBid(${v}) — $${(Number(v) * 1000 / 1e6).toFixed(2)}/1k cap`, panelStatus, true);
      }
      if (act.startsWith("feat-settle:")) {
        const appId = act.slice(12), v = inputFor(act);
        if (!need(/^\d+$/.test(v) && BigInt(v) > 0n, "enter the number of metered views to settle (a positive integer)")) return;
        return void this._tx(S.feat.addr, encCall(fSel.settle, [{ t: "bytes32", v: appId }, { t: "uint", v }]),
          `settle(${short(appId)}, ${v} views)`, panelStatus, true);
      }
      if (act.startsWith("feat-active:")) {
        const [, appId, on2] = act.split(":");
        return void this._tx(S.feat.addr, encCall(fSel.setActive, [{ t: "bytes32", v: appId }, { t: "bool", v: on2 === "1" }]),
          `setActive(${short(appId)}, ${on2 === "1"})`, panelStatus, true);
      }

      /* ownership handoffs (step 1: nominate) */
      if (act.startsWith("own-")) {
        const r = this._ownRows[act];
        const v = val("in-" + act), cf = val("cf-" + act);
        if (!need(ADDR_RE.test(v) && !isZero(v), "enter the new owner address (0x…, non-zero)")) return;
        if (!need(cf === "TRANSFER", 'type TRANSFER (exactly) to confirm - this NOMINATES the new key (two-step); it takes control only after it accepts')) return;
        return void this._tx(r.to, encCall(r.sel, [{ t: "addr", v }]), `${r.label} ${r.fn} → ${short(v)} (nominate)`, panelStatus, true);
      }
      /* ownership handoffs (step 2: the pending key accepts) */
      if (act.startsWith("acc-")) {
        const r = this._ownRows[act.slice(4)];
        return void this._tx(r.to, encCall(r.accSel, []), `${r.label} accept ownership`, panelStatus, true);
      }

      /* deploys */
      if (act.startsWith("deploy:")) {
        const name = act.slice(7);
        const card = this._body.querySelector(`[data-card="${name}"]`);
        const c = CONTRACTS[name];
        const args = [];
        for (const inp of card.querySelectorAll(".ac-ctor")) {
          const v = inp.value.trim();
          const argName = inp.dataset.ctor;
          // args that are legitimately zero: an unset price feed, and
          // EnclaveReviews' ledgerFallback when the BOOK is the source (baking
          // in today's ledger there only ages badly - EnclaveHostReviews drops
          // the arg entirely for the same reason)
          const argType = inp.dataset.ctorType || "address";
          if (argType === "string") {
            // The vault factory's pinned signing origins. Getting one wrong is
            // not a cosmetic error: it is baked into the implementation forever,
            // and every vault the factory ever mints would reject every real
            // assertion. origin1 is the optional second slot, so "" is allowed.
            const optional = /1$/.test(argName);
            if (!need(v !== "" || optional, `constructor arg "${argName}" is required`)) return;
            if (v !== "") {
              if (!need(/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(v) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(v),
                        `constructor arg "${argName}" must be an ORIGIN like https://enclave.host - scheme and host only, no path or trailing slash`)) return;
              if (!need(new TextEncoder().encode(v).length <= 32,
                        `constructor arg "${argName}" is longer than the 32 bytes the contract stores`)) return;
            }
            args.push({ t: "str", v });
            continue;
          }
          // args that are legitimately zero: an unset price feed, the reviews
          // fallback when the BOOK is the source, and a vault factory minted
          // with NO recovery admin (the pure-immutable choice - every stranded
          // balance then needs its customer's passkey, forever)
          const zeroOk = (name === "EnclaveDeployments" && argName === "ethUsdFeed")
            || (/Reviews$/.test(name) && argName === "ledgerFallback")
            || (name === "EnclaveCreditVaultFactory" && argName === "recoveryAdmin");
          if (!need(ADDR_RE.test(v) && (zeroOk || !isZero(v)), `constructor arg "${argName}" needs a valid ${zeroOk ? "" : "non-zero "}address`)) return;
          args.push({ t: "addr", v });
        }
        const status = card.querySelector(".ac-status");
        const out = card.querySelector(".ac-deploy-out");
        btn.disabled = true;
        try {
          await this._connect();
          this._status(status, "p", "deploying - confirm the creation transaction in your wallet…");
          // encCall with an empty selector is exactly the ABI-encoded argument
          // tuple - static heads then dynamic bodies, which address-only
          // concatenation could not express once strings joined the list
          const data = c.bytecode + encCall("", args).slice(2);
          const hash = await sendTx(null, data);
          this._status(status, "p", "sent " + hash.slice(0, 14) + "… waiting for confirmation…");
          const rcpt = await waitReceipt(hash, 90);
          const addr = rcpt.contractAddress;
          if (!need(addr && ADDR_RE.test(addr), "confirmed, but the receipt carries no contract address - check the tx on basescan")) return;
          this._status(status, "ok", `deployed ✓`);
          out.hidden = false;
          out.innerHTML = `<div class="ac-deployed">${esc(name)} → ${mono(addr)} · <a href="${EXPLORER}/address/${esc(addr)}" target="_blank" rel="noopener">basescan</a></div>` +
            (c.bookKey
              ? `<button class="btn btn-primary btn-sm" data-act="book-point:${esc(c.bookKey)}:${esc(addr)}" data-owner="${esc(S.book.owner)}">Point the book: ${esc(c.bookKey)} → ${esc(short(addr))}</button>
                 <span class="ac-hint">one owner tx; enclaves, site, relays and CLI follow within ≤5 min</span>`
              : `<p class="ac-sub warn">this is a NEW address book - bake its address into the configs/site/CLI (scripts/deploy-address-book.mjs does this) and ship a release before anything reads it.</p>`);
          this._gate();
        } finally { btn.disabled = false; }
        return;
      }
      /* ---- one-button paired-revision rollout ------------------------------
         Ordered so that a stop anywhere leaves the fleet on the OLD set, which
         still works: nothing the run does is visible to a runner until the book
         flips, and the flip is one transaction covering all three keys. */
      if (act === "r12-forget") { this._r12Save({}); this._r12Log("p", "forgot the saved deploys - the next run starts from the book's current set"); return; }
      if (act === "r12-run") {
        const R = this._r12 || (this._r12 = {});
        const log = (cls, txt) => this._r12Log(cls, txt);
        const needR = (cond, msg) => { if (!cond) log("err", msg); return cond; };
        const usd = (v6) => "$" + (Number(v6) / 1e6).toFixed(2);
        const mig = MIG_KINDS.deployments;
        btn.disabled = true;
        try {
          const saved = this._r12Saved();
          log("p", "probing the live set…");
          const P = await probeRev12(S, saved);

          if (P.complete) {
            // Everything is live, so `P.source` is now the NEW ledger - the book
            // is what probeRev12 reads. The thing to retire is the ledger this
            // run REPLACED, recorded at the flip, and nothing else: retiring
            // P.source here would close the ledger the fleet is serving from.
            log("ok", `the book already points at rev ${REV12.ledgerRev}: registry ${P.registry.addr}, ledger ${P.ledger.addr}, prover ${P.prover.addr}`);
            const oldLedger = saved.retire;
            if (!oldLedger) {
              log("ok", "rollout complete. No earlier ledger is recorded here to retire - if one still needs it, use the Migrate panel's \"Retire source ledger\" with its address.");
              return;
            }
            if (!needR(lc(oldLedger) !== lc(P.ledger.addr), "refusing to retire the LIVE ledger - the recorded predecessor is the same address, which should never happen; clear it with Forget saved deploys")) return;
            // null = the read failed; only a definite 1 means retired. Guessing
            // here would either hide the last step or offer to redo it.
            const srcRetired = await rdUintSoft(oldLedger, CONTRACTS.EnclaveDeployments.sel.retired);
            if (!needR(srcRetired !== null, "could not read the old ledger's retired flag - retry in a moment")) return;
            if (srcRetired === 1n) { log("ok", `${oldLedger} is already retired - this rollout is finished.`); this._r12Save({}); this.refresh(); return; }
            const oldOwner = await rdAddrSoft(oldLedger, CONTRACTS.EnclaveDeployments.sel.owner);
            if (!needR(lc(Enclave.address) === lc(oldOwner), `retiring ${oldLedger} must come from its owner ${oldOwner}`)) return;
            if (!btn.dataset.armed) {
              btn.dataset.armed = "1"; btn.textContent = "Click again to RETIRE the old ledger";
              log("err", `last step: retire ${oldLedger}. One-way. Claims, renewals and funding close on it forever, and refund() opens to any caller (still paying each record's own owner, so nobody's money can be trapped). Only do this once the fleet is serving from the NEW ledger - check a running deployment first. Click again to retire.`);
              return;
            }
            delete btn.dataset.armed; btn.textContent = "Retire the old ledger";
            await this._connect();
            log("p", `retiring ${oldLedger} - confirm in your wallet…`);
            const rh = await sendTx(oldLedger, retireTx());
            await waitReceipt(rh, 90);
            log("ok", "retired ✓ - rollout complete. Run scripts/sync-contract-addresses.sh and ship a release so the CLI's baked defaults follow the book.");
            this._r12Save({});
            this.refresh();
            return;
          }

          /* ---- first click: price it, sign nothing ---- */
          if (!btn.dataset.armed) {
            const esc6 = await sourceEscrowTotal6(P.source.addr);
            const src = await mig.read(P.source.addr);
            log("p", `source ledger ${P.source.addr} · rev ${P.source.rev} · ${mig.counts(src)}`);
            log("p", `  usdc ${P.source.usdc} · payout ${P.source.payout} · feed ${isZero(P.source.feed) ? "(none)" : P.source.feed}`);
            log("p", "plan:");
            log("p", `  1. registry   ${P.registry.addr ? "reuse " + P.registry.addr : "DEPLOY (schema " + REV12.registryRev + ")"}`);
            log("p", `  2. ledger     ${P.ledger.addr ? "reuse " + P.ledger.addr : "DEPLOY (rev " + REV12.ledgerRev + ", same usdc/payout/feed)"}`);
            log("p", `  3. prover     ${P.prover.addr ? "reuse " + P.prover.addr : "DEPLOY + setProver"}`);
            log("p", `  4. cutover    carry proofRequiredFrom = ${String(P.source.proofFrom ?? 0)} across, unchanged`);
            log("p", `  5. migrate    ${src.length} record${src.length === 1 ? "" : "s"} (delta - skips anything already there)`);
            log("p", `  6. escrow     re-seat ~${usd(esc6.total6)} of USDC across ${esc6.records} record${esc6.records === 1 ? "" : "s"} FROM THIS WALLET`);
            log("p", "  7. verify, then seal the imports");
            log("p", "  8. book       setMany(registry, deployments, proofOfTime) - one transaction");
            log("p", "  (records THIS wallet owns can be refunded on the source first - Migrate panel, \"Refund sweep\" - which suspends those apps briefly and cuts the bill above by their share. Not done here: taking your own deployments down is not a side effect a rollout button should have.)");
            log("err", `this will spend about ${usd(esc6.total6)} of USDC plus gas. Click again to run it.`);
            btn.dataset.armed = "1"; btn.textContent = `Run it (${usd(esc6.total6)} + gas)`;
            R.src = src; R.srcOf = P.source.addr;
            return;
          }
          delete btn.dataset.armed; btn.textContent = `Roll out rev ${REV12.ledgerRev}`;

          /* ---- the run ---- */
          if (!needR(lc(Enclave.address) === lc(S.book.owner), `the book flip must come from its owner ${S.book.owner} - connect that wallet (everything already deployed is kept)`)) return;
          await this._connect();
          const keep = { ...saved };
          const remember = (k, v) => { keep[k] = v; this._r12Save(keep); };

          /* 1. registry */
          let registry = P.registry.addr;
          if (!registry) {
            log("p", `deploying EnclaveRegistry (schema ${REV12.registryRev}) - confirm in your wallet…`);
            const h = await sendTx(null, deployTx("EnclaveRegistry", []));
            log("p", `  sent ${h.slice(0, 14)}… waiting…`);
            registry = (await waitReceipt(h, 90)).contractAddress;
            if (!needR(registry && ADDR_RE.test(registry), "confirmed, but no contract address in the receipt - check basescan, then re-run")) return;
            // A stale site build would silently deploy the PREVIOUS revision and
            // the run would wire a set that cannot claim. Prove it, don't hope.
            const rv = await revOfRegistry(registry);
            if (!needR(rv >= REV12.registryRev, `the fresh deploy reports registrySchema ${rv}, not ${REV12.registryRev} - this site build predates the revision: rebuild (build-contract-artifacts.mjs), redeploy the site, re-run`)) return;
            remember("registry", registry);
            log("ok", `  registry ${registry} ✓`);
          } else log("p", `registry: reusing ${registry}`);

          /* 2. ledger - same usdc/payout/feed as the source, new registry */
          let ledger = P.ledger.addr;
          if (!ledger) {
            log("p", `deploying EnclaveDeployments (rev ${REV12.ledgerRev}) - confirm in your wallet…`);
            const h = await sendTx(null, deployTx("EnclaveDeployments", [
              { t: "addr", v: P.source.usdc }, { t: "addr", v: P.source.payout },
              { t: "addr", v: registry }, { t: "addr", v: P.source.feed || ZERO }]));
            log("p", `  sent ${h.slice(0, 14)}… waiting…`);
            ledger = (await waitReceipt(h, 90)).contractAddress;
            if (!needR(ledger && ADDR_RE.test(ledger), "confirmed, but no contract address in the receipt - check basescan, then re-run")) return;
            const lv = await revOfLedger(ledger);
            if (!needR(lv >= REV12.ledgerRev, `the fresh deploy reports deploymentsSchema ${lv}, not ${REV12.ledgerRev} - this site build predates the revision: rebuild, redeploy the site, re-run`)) return;
            remember("ledger", ledger);
            log("ok", `  ledger ${ledger} ✓ (bound to registry ${registry})`);
          } else log("p", `ledger: reusing ${ledger}`);

          /* 3. prover + binding. setProver is ONE-SHOT on the ledger, so a
                second run must not try to rebind a ledger that already has one. */
          let prover = P.prover.addr;
          if (!prover) {
            log("p", "deploying EnclaveProofOfTime - confirm in your wallet…");
            const h = await sendTx(null, deployTx("EnclaveProofOfTime", [{ t: "addr", v: ledger }, { t: "addr", v: registry }]));
            log("p", `  sent ${h.slice(0, 14)}… waiting…`);
            prover = (await waitReceipt(h, 90)).contractAddress;
            if (!needR(prover && ADDR_RE.test(prover), "confirmed, but no contract address in the receipt - check basescan, then re-run")) return;
            remember("prover", prover);
            log("ok", `  prover ${prover} ✓`);
          } else log("p", `prover: reusing ${prover}`);
          const bound = await rdAddrSoft(ledger, CONTRACTS.EnclaveDeployments.sel.prover);
          if (isZero(bound)) {
            log("p", "binding the prover to the ledger (one-shot, then frozen) - confirm in your wallet…");
            const h = await sendTx(ledger, setProverTx(prover));
            await waitReceipt(h, 90);
            log("ok", "  bound ✓");
          } else if (!needR(lc(bound) === lc(prover), `the ledger is already bound to a DIFFERENT prover (${bound}) and that binding is frozen - deploy a fresh ledger (Forget saved deploys, then re-run)`)) return;

          /* 4. carry the proof cutover across verbatim. A fresh ledger starts a
                new 14-day grace, which would silently put every host back on
                held-time metering; whatever policy the source is running is the
                policy that should survive a redeploy. */
          const wantFrom = P.source.proofFrom ?? 0n;
          const haveFrom = await rdUintSoft(ledger, CONTRACTS.EnclaveDeployments.sel.proofRequiredFrom);
          if (!needR(haveFrom !== null, "could not read the new ledger's proofRequiredFrom - retry in a moment")) return;
          if (haveFrom !== wantFrom) {
            log("p", `carrying proofRequiredFrom ${String(haveFrom)} → ${String(wantFrom)} - confirm in your wallet…`);
            const h = await sendTx(ledger, setProofRequiredFromTx(wantFrom));
            await waitReceipt(h, 90);
            log("ok", "  cutover carried ✓");
          }

          /* 5. migrate every record (delta) */
          const st = await importState(ledger, "EnclaveDeployments");
          if (!needR(st.capable, "the target ledger has no import surface")) return;
          const runImports = async (label) => {
            if (st.sealed) { log("p", `${label}: imports already sealed - skipping`); return true; }
            const src = (R.srcOf === P.source.addr && R.src) || await mig.read(P.source.addr);
            R.src = src; R.srcOf = P.source.addr;
            const after = await mig.read(ledger);
            const runnerBps = Number(await rdUintSoft(ledger, CONTRACTS.EnclaveDeployments.sel.runnerBps) ?? 0);
            const txs = mig.plan(src, after, { grantRates: true, runnerBps });
            if (!txs.length) { log("ok", `${label}: nothing left to import`); return false; }
            log("p", `${label}: ${txs.length} transaction${txs.length === 1 ? "" : "s"}`);
            for (let i = 0; i < txs.length; i++) {
              log("p", `  [${i + 1}/${txs.length}] ${txs[i].label} - confirm in your wallet…`);
              const h = await sendTx(ledger, txs[i].dataHex);
              await waitReceipt(h, 90);
              log("ok", `    ✓ ${txs[i].label}`);
            }
            return true;
          };
          /* 6. re-seat the runner escrow. MUST be before the seal: while imports
                are open the backing is credited to each record's OWNER as
                refundable money they already paid, and after sealing it is not,
                permanently. Idempotent, and re-run after any delta that lands
                new records - importing a record after the backing pass would
                otherwise seal it unbacked, which no later transaction can fix. */
          const backEscrow = async () => {
            if (st.sealed) return;
            log("p", "working out the escrow backing that is still missing…");
            const plan = await escrowPlan(ledger);
            for (const sk of plan.skipped) log("err", `  skipped ${sk.id.slice(0, 12)}… - ${sk.why}`);
            if (!plan.items.length) { log("ok", "  every record is already backed"); return; }
            log("p", `  ${plan.items.length} record${plan.items.length === 1 ? "" : "s"} need ${usd(plan.total6)} of USDC`);
            log("p", `  approving ${usd(plan.total6)} to the ledger - confirm in your wallet…`);
            const ah = await sendTx(USDC_BASE, approveTx(ledger, plan.total6));
            await waitReceipt(ah, 90);
            for (let i = 0; i < plan.txs.length; i++) {
              log("p", `  [${i + 1}/${plan.txs.length}] ${plan.txs[i].label} - confirm in your wallet…`);
              const h = await sendTx(ledger, plan.txs[i].dataHex);
              await waitReceipt(h, 90);
              log("ok", `    ✓ ${plan.txs[i].label}`);
            }
            log("ok", `  escrow re-seated with ${usd(plan.total6)} ✓`);
          };

          await runImports("migrate");
          await backEscrow();

          /* 7. one last delta (records created on the source while we worked),
                backed again if it found any, then verify and seal */
          if (await runImports("final pass")) await backEscrow();
          log("p", "verifying: re-reading the target and diffing field-by-field…");
          const runnerBps = Number(await rdUintSoft(ledger, CONTRACTS.EnclaveDeployments.sel.runnerBps) ?? 0);
          const v = await mig.verify(R.src, ledger, { grantRates: true, runnerBps });
          if (v.bad.length) {
            log("err", `${v.ok}/${v.total} records match; mismatched: ${v.bad.slice(0, 10).join(", ")}${v.bad.length > 10 ? " …" : ""}`);
            log("err", "STOPPING before the seal and the book flip - nothing is live yet, and the old ledger is still serving. Investigate with the Migrate panel (source and target are prefilled below), then re-run.");
            this._migHandoff(P.source.addr, ledger);
            return;
          }
          log("ok", `  all ${v.total} records match the source exactly`);
          if (!(await importState(ledger, "EnclaveDeployments")).sealed) {
            log("p", "sealing the target's imports (permanent) - confirm in your wallet…");
            const h = await sendTx(ledger, sealTx("EnclaveDeployments"));
            await waitReceipt(h, 90);
            log("ok", "  sealed ✓");
          }

          /* 8. the flip. All three keys in ONE transaction: a book that named a
                rev-12 ledger and a schema-3 registry, even for one block, is a
                pairing that reverts every claim. */
          const pairs = [["registry", registry], ["deployments", ledger], ["proofOfTime", prover]]
            .filter(([k, a]) => lc(S.book.entries[k] || "") !== lc(a));
          if (pairs.length) {
            log("p", `pointing the book at ${pairs.map(([k]) => k).join(", ")} - confirm in your wallet…`);
            const h = await sendTx(S.book.addr, bookSetManyTx(pairs));
            await waitReceipt(h, 90);
            log("ok", "  book repointed ✓");
          }
          // Keep exactly one crumb: the ledger this run replaced. It is what the
          // remaining (destructive) step operates on, and clearing it here would
          // put the retire out of the button's reach entirely.
          this._r12Save({ retire: P.source.addr });
          log("ok", `rev ${REV12.ledgerRev} is LIVE. Enclaves, relays and the site follow the book within ~5-10 min; the old ledger ${P.source.addr} keeps serving until they do.`);
          log("p", "then: check a running deployment, run scripts/sync-contract-addresses.sh and ship a release (the CLI's defaults are baked), and re-click this button to retire the old ledger.");
          this.refresh();
        } catch (err) {
          log("err", friendly(err) + " - nothing is stranded: re-click to resume from live chain state (deployed addresses are remembered).");
        } finally { btn.disabled = false; }
        return;
      }

      /* credit-vault factory migration (scan → one run that deploys/repoints/
         re-mints/fronts whatever live chain state still needs) */
      if (act === "vlt-scan" || act === "vlt-run") {
        const V = this._vlt || (this._vlt = {});
        const log = (cls, txt) => this._vltLog(cls, txt);
        const needV = (cond, msg) => { if (!cond) log("err", msg); return cond; };
        const usd = (v6) => "$" + (Number(v6) / 1e6).toFixed(2);
        const old = val("vltOld");
        if (!needV(ADDR_RE.test(old), "enter the OLD (wedged) factory address")) return;
        btn.disabled = true;
        try {
          if (act === "vlt-scan") {
            log("p", `scanning ${old} for vaults…`);
            const scan = await scanVaults(old, (t) => log("p", "  " + t));
            V.scan = scan; V.oldFactory = old;
            const funded = scan.vaults.filter((v) => v.balance6 > 0n);
            const lost = funded.filter((v) => v.keyLost);
            const total6 = funded.reduce((a, v) => a + v.balance6, 0n);
            for (const v of scan.vaults)
              log(v.keyLost && v.balance6 > 0n ? "err" : "p",
                `  ${v.vault} · ${usd(v.balance6)}${v.keyLost ? " · passkey NOT recoverable from its creation tx" : ""}`);
            log("ok", `${scan.vaults.length} vault${scan.vaults.length === 1 ? "" : "s"}, ${funded.length} funded, ${usd(total6)} to front`);
            if (lost.length) log("err", `${lost.length} funded vault${lost.length === 1 ? "" : "s"} excluded (no recoverable passkey) - those need a manual path`);
            this._vltSave({ ...this._vltSaved(), oldFactory: old });
            this._body.querySelector('[data-act="vlt-run"]').disabled = false;
            return;
          }
          /* vlt-run */
          if (!needV(V.scan && lc(V.oldFactory) === lc(old), "scan first (re-scan if you changed the address)")) return;
          // this MOVES USDC out of the connected wallet - arm-twice, like retire
          if (!btn.dataset.armed) {
            btn.dataset.armed = "1"; btn.textContent = "Click again to migrate + SEND the USDC";
            log("err", "the run deploys/repoints as needed, then SENDS real USDC from the connected wallet into the re-minted customer vaults (spendable credit - not recoverable by us). Click again to proceed.");
            return;
          }
          delete btn.dataset.armed; btn.textContent = "Migrate + front the credit";
          await this._connect();

          /* 1) a factory whose implementation passes the create() probe:
                the book's (already repointed), else one this flow deployed
                earlier (browser died before the repoint), else deploy fresh */
          const cur = S.book.entries.vaultFactory;
          let target = null;
          if (cur && lc(cur) !== lc(old)) { try { if ((await vaultImplCurrent(cur)).current) target = cur; } catch {} }
          const saved = this._vltSaved();
          if (!target && saved.newFactory) { try { if ((await vaultImplCurrent(saved.newFactory)).current) target = saved.newFactory; } catch {} }
          if (!target) {
            const treasury = (await oldTreasury(old)) || (S.dep && S.dep.payout);
            if (!needV(treasury && !isZero(treasury), "no treasury to carry over (old impl unreadable, ledger has no payout) - deploy from the card above, then re-run")) return;
            const origin0 = location.origin;
            if (!needV(/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin0) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin0),
              `this page's origin (${origin0}) can't be the vaults' pinned signing origin - deploy from the card above with the real one, then re-run`)) return;
            if (!needV(new TextEncoder().encode(origin0).length <= 32, `this page's origin (${origin0}) exceeds the 32 bytes the contract stores - deploy from the card above`)) return;
            log("p", `deploying EnclaveCreditVaultFactory (treasury ${treasury}, origin ${origin0}) - confirm in your wallet…`);
            const data = CONTRACTS.EnclaveCreditVaultFactory.bytecode + encCall("", [
              { t: "addr", v: USDC_BASE }, { t: "addr", v: S.book.addr }, { t: "addr", v: treasury },
              { t: "str", v: origin0 }, { t: "str", v: "" }]).slice(2);
            const hash = await sendTx(null, data);
            log("p", `  sent ${hash.slice(0, 14)}… waiting…`);
            const rcpt = await waitReceipt(hash, 90);
            target = rcpt.contractAddress;
            if (!needV(target && ADDR_RE.test(target), "confirmed, but no contract address in the receipt - check basescan, then re-run")) return;
            // the fresh deploy must pass the very probe that flagged the wedge
            if (!needV((await vaultImplCurrent(target)).current, "the FRESH deploy fails the create() probe - the checked-in artifact predates the ledger: rebuild (build-contract-artifacts.mjs), redeploy the site, re-run")) return;
            log("ok", `  factory ${target} ✓`);
            this._vltSave({ oldFactory: old, newFactory: target });
          } else log("p", `reusing current factory ${target}`);

          /* 2) repoint the book (owner tx; skipped when already there) */
          if (lc(cur || "") !== lc(target)) {
            if (!needV(lc(Enclave.address) === lc(S.book.owner), `the book repoint must come from its owner ${S.book.owner} - connect that wallet and re-run (everything already done is kept)`)) return;
            log("p", `book: vaultFactory → ${target} - confirm in your wallet…`);
            const h = await sendTx(S.book.addr, encCall(CONTRACTS.EnclaveAddressBook.sel.set,
              [{ t: "bytes32", v: encKey("vaultFactory") }, { t: "addr", v: target }]));
            log("p", `  sent ${h.slice(0, 14)}… waiting…`);
            await waitReceipt(h, 90);
            log("ok", "  repointed ✓ - the relay follows within its 10-min book cache");
          } else log("p", "book already points at the current factory");

          /* 3) re-mint + front, re-planned from live state (the delta) */
          log("p", "planning the per-vault delta…");
          const plan = await planVaultMigration(V.scan.vaults, target, Enclave.address);
          for (const s of plan.skipped) log("p", `  skip ${s.vault.slice(0, 10)}…: ${s.why}`);
          if (plan.self6 > 0n)
            log("ok", `  ${usd(plan.self6)} moves by migrateToSuccessor - those vaults forward their own credit, so no company USDC is fronted for them`);
          if (plan.steps.length) {
            const mine6 = await balanceOf6(Enclave.address);
            if (!needV(mine6 >= plan.front6, `fronting needs ${usd(plan.front6)} USDC but the connected wallet holds ${usd(mine6)} - top up and re-run (the plan resumes as a delta)`)) return;
            for (let i = 0; i < plan.steps.length; i++) {
              const st = plan.steps[i];
              log("p", `[${i + 1}/${plan.steps.length}] ${st.label} - confirm in your wallet…`);
              const h = await sendTx(st.to, st.data);
              log("p", `  sent ${h.slice(0, 14)}… waiting…`);
              await waitReceipt(h, 90);
              log("ok", `  ✓ ${st.label}`);
            }
          }
          const lost = V.scan.vaults.filter((v) => v.balance6 > 0n && v.keyLost);
          log("ok", `done - ${plan.steps.length} tx${plan.steps.length === 1 ? "" : "s"}, ${usd(plan.front6)} fronted ✓. Credit deploys resume within ~10 min. The old vaults still hold their USDC: each repays the treasury when its customer signs a refund. When convenient, refresh the baked fallbacks (sync-contract-addresses.sh + the relay's VAULT_FACTORY_ADDRESS env).`);
          if (lost.length) log("err", `${lost.length} funded vault${lost.length === 1 ? "" : "s"} still unmigrated (unrecoverable passkey) - the resume state stays until they're handled`);
          else { this._vltSave({}); V.scan = null; }
          setTimeout(() => this.refresh(), 1500);
        } catch (err) {
          log("err", friendly(err) + " - re-run to resume; the plan is re-derived from live chain state, so nothing is done twice.");
        } finally { btn.disabled = false; }
        return;
      }

      /* migration */
      if (act.startsWith("mig-")) {
        const M = this._mig, m = MIG_KINDS[M.kind];
        const src = val("migSource"), tgt = val("migTarget");
        const log = (cls, txt) => this._migLog(cls, txt);
        const enable = (a, on2) => { this._body.querySelector(`[data-act="${a}"]`).disabled = !on2; };
        // these guards used to write only to the panel status strip, well away
        // from the log the operator is watching - a click that did nothing
        // looked like a dead button
        const needMig = (cond, msg) => { if (!cond) log("err", msg); return cond; };
        /* Plan and verify MUST see the same options. A granted runner rate is a
           deliberate difference from the source, so a verify that doesn't know
           about the grant reports every granted record as a mismatch - and Seal
           only unlocks on a clean verify. runnerBps comes off the target so a
           grant matches what its own create() would have snapshotted. */
        const migOpts = async () => {
          const grantRates = !!this._body.querySelector("#migGrantRates")?.checked;
          if (m.contractName !== "EnclaveDeployments" || !grantRates) return { grantRates: false, runnerBps: 0 };
          const runnerBps = Number(await rdUintSoft(tgt, CONTRACTS.EnclaveDeployments.sel.runnerBps) ?? 0);
          return { grantRates, runnerBps };
        };

        /* -- refund sweep: source-side, no target and no mig-read needed -- */
        if (act === "mig-swp-scan" || act === "mig-swp-stop" || act === "mig-swp-refund" || act === "mig-swp-retire") {
          if (!needMig(m.contractName === "EnclaveDeployments", "the refund sweep applies to the deployments ledger - pick it in the kind selector")) return;
          if (!needMig(ADDR_RE.test(src), "enter the source contract address (the LIVE ledger)")) return;
          const usd = (v) => "$" + (Number(v) / 1e6).toFixed(2);
          btn.disabled = true;
          try {
            await this._connect();
            const wallet = Enclave.address;
            if (act === "mig-swp-retire") {
              // ONE-WAY end-of-life (rev 11): closes claim/renew/fund forever
              // and opens refund() to any caller (still paying each owner)
              const dSel = CONTRACTS.EnclaveDeployments.sel;
              let isRet = false, rev11 = true;
              try { isRet = hexBig((await call(src, "0x" + dSel.retired)) || "0x0") !== 0n; } catch { rev11 = false; }
              if (!needMig(rev11, "this ledger predates retirement (deploymentsSchema < 11) - only owners can refund its records")) return;
              if (isRet) { log("ok", "already retired - Scan: the sweep covers every owner's records"); return; }
              if (!btn.dataset.armed) {
                btn.dataset.armed = "1"; btn.textContent = "Click again to PERMANENTLY retire";
                log("err", "retiring is ONE-WAY: no more claims, renewals or funding on this ledger, ever - only refunds home. Do it AFTER the fleet points at the successor. Click again to proceed.");
                return;
              }
              delete btn.dataset.armed; btn.textContent = "Retire source ledger";
              log("p", "retire() - confirm in your wallet…");
              const hash = await sendTx(src, "0x" + dSel.retire);
              log("p", `  sent ${hash.slice(0, 14)}… waiting…`);
              await waitReceipt(hash, 90);
              log("ok", "retired ✓ - re-scan: the sweep now covers EVERY owner's records, each refund paying that record's own wallet");
              M.sweep = null;
              return;
            }
            if (act === "mig-swp-scan") {
              log("p", `scanning ${src} for records owned by ${wallet}…`);
              const plan = await refundSweepPlan(src, wallet);
              M.sweep = plan; M.sweepSource = src;
              if (plan.retired)
                log("ok", `ledger is RETIRED: sweeping EVERY owner's records - ${usd(plan.refundable6)} refundable right now across ${plan.refundOwners} owner wallet${plan.refundOwners === 1 ? "" : "s"} (each refund pays that record's own wallet)`
                  + (plan.reserved.length ? `; ${usd(plan.reserved6)} more frees as leases lapse (re-scan in ~30 min)` : ""));
              else
              log("ok", `${plan.mine} record${plan.mine === 1 ? "" : "s"} owned by this wallet - ${usd(plan.refundable6)} refundable right now`
                + (plan.reserved.length ? `; ${usd(plan.reserved6)} more still lease-reserved on ${plan.reserved.length} (frees when the hosts release - re-scan then)` : ""));
              if (plan.suspend.length)
                log("p", `${plan.suspend.length} record${plan.suspend.length === 1 ? "" : "s"} to suspend - the fleet tears down and releases within ~a minute of the batch landing`);
              if (plan.othersFunded)
                log("p", `note: ${plan.othersFunded} funded record${plan.othersFunded === 1 ? "" : "s"} belong to OTHER wallets - refund() is owner-gated, so their owners collect on this ledger themselves (it keeps refund() forever)`);
              if (!plan.suspend.length && !plan.refunds.length && !plan.reserved.length)
                log("ok", "nothing to sweep for this wallet - migrate away");
              enable("mig-swp-stop", plan.suspendTxs.length > 0);
              enable("mig-swp-refund", plan.refundTxs.length > 0);
              return;
            }
            if (!needMig(M.sweep && M.sweepSource === src, "scan first (re-scan if you changed the address)")) return;
            const txs = act === "mig-swp-stop" ? M.sweep.suspendTxs : M.sweep.refundTxs;
            if (!needMig(txs.length, "nothing in that batch - re-scan")) return;
            for (let i = 0; i < txs.length; i++) {
              log("p", `[${i + 1}/${txs.length}] ${txs[i].label} - confirm in your wallet…`);
              const hash = await sendTx(src, txs[i].dataHex);
              log("p", `  sent ${hash.slice(0, 14)}… waiting…`);
              await waitReceipt(hash, 90);
              log("ok", `  ✓ ${txs[i].label}`);
            }
            if (act === "mig-swp-stop") {
              log("ok", "suspended ✓ - the fleet releases the leases within ~a minute; re-scan, then Refund mine");
              enable("mig-swp-stop", false);
            } else {
              log("ok", (M.sweep.retired
                  ? `refunded ${usd(M.sweep.refundable6)} home across ${M.sweep.refundOwners} owner wallet${M.sweep.refundOwners === 1 ? "" : "s"} ✓`
                  : `refunded ${usd(M.sweep.refundable6)} to ${wallet} ✓`)
                + (M.sweep.reserved.length ? ` - ${usd(M.sweep.reserved6)} of lease tails frees at release; re-scan to collect it` : " - clean; snapshot and migrate"));
              enable("mig-swp-refund", false);
            }
            M.sweep = null;                    // a sent batch stales the plan: force a re-scan
          } catch (err) { log("err", friendly(err) + " - re-scan and retry; the sweep re-plans from live state (a runner settling mid-flight reverts the whole batch harmlessly)."); }
          finally { btn.disabled = false; }
          return;
        }

        if (act === "mig-read") {
          if (!need(ADDR_RE.test(src), "enter the source contract address")) return;
          btn.disabled = true;
          try {
            log("p", `reading ${m.label} from ${src}…`);
            M.data = await m.read(src);
            M.source = src;
            log("ok", `source holds ${m.counts(M.data)}`);
            enable("mig-run", true); enable("mig-verify", true);
          } catch (err) { log("err", "read failed: " + friendly(err)); }
          finally { btn.disabled = false; }
          return;
        }

        if (!needMig(M.data && M.source === src, "read the source first (re-read if you changed the address)")) return;
        if (!needMig(ADDR_RE.test(tgt), "enter the target contract address (the new deploy)")) return;
        if (!needMig(lc(tgt) !== lc(src), "source and target are the same contract")) return;
        M.target = tgt;

        if (act === "mig-run") {
          btn.disabled = true;
          try {
            const st = await importState(tgt, m.contractName);
            if (!need(st.capable, "target has no import surface - deploy a fresh " + m.contractName + " from the card above")) return;
            if (!need(!st.sealed, "target's imports are permanently sealed - deploy a fresh target")) return;
            log("p", "reading the target to plan the delta…");
            const after = await m.read(tgt);
            const opts = await migOpts();
            if (opts.grantRates && !opts.runnerBps)
              log("p", "  note: target reports runnerBps 0 - no rates can be granted");
            const txs = m.plan(M.data, after, opts);
            if (!txs.length) {
              log("ok", "nothing to import - target already holds everything. Back escrow next, then Verify and seal.");
              M.ranImport = true; enable("mig-escrow", true);
              return;
            }
            log("p", `${txs.length} import transaction${txs.length === 1 ? "" : "s"} to send`);
            await this._connect();
            for (let i = 0; i < txs.length; i++) {
              log("p", `[${i + 1}/${txs.length}] ${txs[i].label} - confirm in your wallet…`);
              const hash = await sendTx(tgt, txs[i].dataHex);
              log("p", `  sent ${hash.slice(0, 14)}… waiting…`);
              await waitReceipt(hash, 90);
              log("ok", `  ✓ ${txs[i].label}`);
            }
            log("ok", "migration pass complete - Back escrow next, then Verify (Migrate again later to pick up new source records).");
            M.ranImport = true; enable("mig-escrow", true);
          } catch (err) { log("err", friendly(err) + " - fix and click Migrate again; the delta plan resumes where it stopped."); }
          finally { btn.disabled = false; }
          return;
        }

        /* Re-seat the runner escrow the source keeps. Two transactions: one
           USDC approve for the exact total, then the batched fundEscrow calls.
           Idempotent and resumable - the plan is computed from what the target
           is missing right now, so a half-finished run just re-plans smaller. */
        if (act === "mig-escrow") {
          if (!need(m.contractName === "EnclaveDeployments", "escrow backing only applies to the deployments ledger")) return;
          btn.disabled = true;
          try {
            const st = await importState(tgt, m.contractName);
            if (st.capable && st.sealed)
              log("err", "NOTE: imports are already sealed - backing still works, but it will NOT be credited as the owners' refundable escrow. That attribution closed with the seal.");
            log("p", "reading the target to work out what backing is missing…");
            const { items, skipped, total6, txs } = await escrowPlan(tgt);
            for (const s of skipped) log("err", `  skipped ${s.id.slice(0, 12)}… - ${s.why}`);
            if (!items.length) { log("ok", "every record is fully backed - nothing to send. Verify next."); return; }
            const totalUsd = "$" + (Number(total6) / 1e6).toFixed(2);
            log("p", `${items.length} record${items.length === 1 ? "" : "s"} need backing, ${totalUsd} of USDC total`);
            await this._connect();
            log("p", `approving ${totalUsd} of USDC to the ledger - confirm in your wallet…`);
            const ah = await sendTx(USDC_BASE, approveTx(tgt, total6));
            log("p", `  sent ${ah.slice(0, 14)}… waiting…`);
            await waitReceipt(ah, 90);
            log("ok", "  ✓ approved");
            for (let i = 0; i < txs.length; i++) {
              log("p", `[${i + 1}/${txs.length}] ${txs[i].label} - confirm in your wallet…`);
              const hash = await sendTx(tgt, txs[i].dataHex);
              log("p", `  sent ${hash.slice(0, 14)}… waiting…`);
              await waitReceipt(hash, 90);
              log("ok", `  ✓ ${txs[i].label}`);
            }
            log("ok", `escrow backed with ${totalUsd} ✓ - sellers can now be paid and owners can now cancel for a refund. Verify next.`);
          } catch (err) { log("err", friendly(err) + " - click Back escrow again; it re-plans from what is still missing."); }
          finally { btn.disabled = false; }
          return;
        }

        if (act === "mig-verify") {
          btn.disabled = true;
          try {
            log("p", "verifying: re-reading the target and diffing field-by-field…");
            const r = await m.verify(M.data, tgt, await migOpts());
            M.verified = true;
            M.verifyClean = r.bad.length === 0;
            // Seal unlocks once verify has RUN, clean or not. Gating the BUTTON
            // on a clean result made the "click again to override" path
            // unreachable - a disabled button cannot be clicked - so a verify
            // that disagreed for any reason (including a bug in verify itself)
            // deadlocked the migration with no way forward in the UI. The
            // warning belongs at the seal, where it can be read and overridden.
            enable("mig-seal", true);
            if (r.bad.length) {
              log("err", `${r.ok}/${r.total} match; mismatched: ${r.bad.slice(0, 10).join(", ")}${r.bad.length > 10 ? " …" : ""}`);
              log("p", "Seal is unlocked but will warn: fix these first if they are real, or override deliberately.");
            } else {
              log("ok", `all ${r.total} records match the source exactly`);
            }
          } catch (err) { log("err", "verify failed: " + friendly(err)); }
          finally { btn.disabled = false; }
          return;
        }

        if (act === "mig-seal") {
          // Last chance to catch the one thing sealing makes permanent that
          // verify cannot see: escrow attribution. Refuse the FIRST click while
          // backing is still missing rather than warn after the fact.
          if (m.contractName === "EnclaveDeployments" && !btn.dataset.armed) {
            let plan;
            // a failed check is NOT a clean check: sealing is permanent, so an
            // RPC that cannot answer must stop the seal, not wave it through
            try { plan = await escrowPlan(tgt); }
            catch (err) { log("err", "cannot confirm escrow backing before sealing: " + friendly(err) + " - not sealing."); return; }
            const { items, skipped, total6 } = plan;
            // Only MISSING backing blocks. A skipped record is one fundEscrow
            // can never take (inactive, or no runner rate) - that state does not
            // change by waiting, so counting it as a blocker refused the first
            // click forever and made this check impossible to satisfy.
            if (skipped.length)
              log("p", `note: ${skipped.length} record${skipped.length === 1 ? "" : "s"} cannot be escrow-backed at all (listed above) - sealing does not change that.`);
            if (items.length) {
              log("err", `NOT sealing yet: ${items.length} record${items.length === 1 ? "" : "s"} still need $${(Number(total6) / 1e6).toFixed(2)} of escrow backing. `
                + "Seal now and their owners can never be refunded. Run Back escrow first, or click Seal again to override.");
              btn.dataset.armed = "1"; btn.textContent = "Seal anyway (escrow unbacked)";
              return;
            }
          }
          if (!M.verifyClean && !btn.dataset.armed) {
            log("err", "NOT sealing yet: the last verify reported mismatches. Re-run Verify, or click Seal again to override.");
            btn.dataset.armed = "1"; btn.textContent = "Seal anyway (verify not clean)";
            return;
          }
          if (!btn.dataset.armed) { btn.dataset.armed = "1"; btn.textContent = "Click again to PERMANENTLY seal"; return; }
          delete btn.dataset.armed; btn.textContent = "Seal target imports";
          btn.disabled = true;
          try {
            await this._connect();
            log("p", "sealImports - confirm in your wallet…");
            const hash = await sendTx(tgt, sealTx(m.contractName));
            await waitReceipt(hash);
            log("ok", "imports permanently sealed ✓ - now point the book: " + m.bookKey + " → " + tgt + " (Address book panel above), and refresh the repo fallbacks when convenient.");
          } catch (err) { log("err", friendly(err)); btn.disabled = false; }
          return;
        }
      }

      /* publisher recovery: bulk transferApp on a rev-6 catalog */
      if (act === "cat-xfer-load") {
        const catAddr = val("xferCat");
        if (!need(ADDR_RE.test(catAddr), "enter the catalog contract address (prefilled from the book; paste the fresh rev-6 deploy during a recovery)")) return;
        const log = (cls, txt) => this._logTo("xferLog", cls, txt);
        const runBtn = this._body.querySelector('[data-act="cat-xfer-run"]');
        runBtn.disabled = true; this._xfer = null;
        btn.disabled = true;
        try {
          const sel = CONTRACTS.EnclaveAppCatalog.sel;
          const [schema, catOwner] = await Promise.all([rdUintSoft(catAddr, sel.catalogSchema), rdAddr(catAddr, sel.owner)]);
          const n = Number(await rdUint(catAddr, sel.appCount));
          const apps = [];
          for (let s = 0; s < n; s += 50)
            apps.push(...decodeStructArray(await call(catAddr, encCallX(sel.getAppsPage, [{ t: "uint", v: s }, { t: "uint", v: 50 }])), APP_SCHEMA));
          const byPub = {};
          for (const a of apps) (byPub[lc(a.publisher)] ||= []).push(a);
          log("ok", `catalog rev ${schema ?? "<4"} · ${apps.length} app${apps.length === 1 ? "" : "s"} from ${Object.keys(byPub).length} publisher${Object.keys(byPub).length === 1 ? "" : "s"}`);
          for (const [pub, list] of Object.entries(byPub).sort((x, y) => y[1].length - x[1].length))
            log("p", `  ${list[0].publisher} — ${list.length}: ${list.map((a) => a.slug).join(", ")}`);
          if (Number(schema ?? 0) < 6) return void log("err", "this catalog predates publisher transfers (rev < 6) — deploy a fresh EnclaveAppCatalog from the card above, Migrate data into it, run the transfer THERE, then point the book");
          if (lc(catOwner) !== lc(Enclave.address)) log("err", `owner is ${catOwner} — connect that wallet to transfer`);
          // suggest the biggest publisher that isn't the catalog owner (the
          // compromised-wallet shape); still just a prefill, change it freely
          const fromEl = this._body.querySelector("#xferFrom");
          if (fromEl && !fromEl.value.trim()) {
            const sug = Object.entries(byPub).filter(([p]) => p !== lc(catOwner)).sort((x, y) => y[1].length - x[1].length)[0];
            if (sug) { fromEl.value = sug[1][0].publisher; log("p", `from prefilled: ${sug[1][0].publisher} (${sug[1].length} apps) — make sure this IS the compromised wallet`); }
          }
          this._xfer = { catalog: catAddr, apps, owner: catOwner };
          runBtn.disabled = false;
        } catch (err) { log("err", "load failed: " + friendly(err)); }
        finally { btn.disabled = false; }
        return;
      }
      if (act === "cat-xfer-run") {
        const X = this._xfer;
        const from = val("xferFrom"), to = val("xferTo"), cf = val("xferConfirm");
        const log = (cls, txt) => this._logTo("xferLog", cls, txt);
        if (!need(X && lc(X.catalog) === lc(val("xferCat")), "load the apps first (re-load if you changed the catalog address)")) return;
        if (!need(ADDR_RE.test(from), "enter the compromised publisher's address in `from`")) return;
        if (!need(ADDR_RE.test(to) && !isZero(to), "enter the destination wallet in `to` (0x…, non-zero)")) return;
        if (!need(lc(from) !== lc(to), "from and to are the same wallet")) return;
        if (!need(cf === "TRANSFER", 'type TRANSFER (exactly) to confirm — this moves EVERY app the from-wallet published')) return;
        const todo = X.apps.filter((a) => lc(a.publisher) === lc(from));
        if (!need(todo.length, "the from-wallet publishes no apps in this catalog (already moved?) — re-Load to see the current state")) return;
        const taken = new Set(X.apps.filter((a) => lc(a.publisher) === lc(to)).map((a) => a.slug));
        const clash = todo.filter((a) => taken.has(a.slug));
        if (!need(!clash.length, `the to-wallet already publishes ${clash.map((a) => a.slug).join(", ")} — the contract refuses a duplicate slug per wallet; pick another destination`)) return;
        btn.disabled = true;
        try {
          await this._connect();
          const sel = CONTRACTS.EnclaveAppCatalog.sel;
          const calls = todo.map((a) => encCall(sel.transferApp, [{ t: "bytes32", v: a.appId }, { t: "addr", v: to }]));
          // ~70k gas per transfer: 60 per multicall stays far under the ~9M
          // budget that keeps public RPCs broadcasting (see migrate.js)
          const chunks = []; for (let i = 0; i < calls.length; i += 60) chunks.push(calls.slice(i, i + 60));
          log("p", `${todo.length} app${todo.length === 1 ? "" : "s"} → ${to} in ${chunks.length} transaction${chunks.length === 1 ? "" : "s"}: ${todo.map((a) => a.slug).join(", ")}`);
          for (let i = 0; i < chunks.length; i++) {
            log("p", `[${i + 1}/${chunks.length}] transferApp × ${chunks[i].length} — confirm in your wallet…`);
            const hash = await sendTx(X.catalog, chunks[i].length === 1 ? chunks[i][0] : encCallX(sel.multicall, [{ t: "bytes[]", v: chunks[i] }]));
            log("p", `  sent ${hash.slice(0, 14)}… waiting…`);
            await waitReceipt(hash, 90);
            log("ok", `  ✓ confirmed`);
          }
          log("ok", `done — ${todo.length} app${todo.length === 1 ? "" : "s"} now publish as ${to}. Re-Load to verify, then if this catalog isn't in the book yet, point it (Address book panel).`);
          showToast(`transferred ${todo.length} app${todo.length === 1 ? "" : "s"} ✓`);
          this._xfer = null;   // state is stale now: require a fresh Load before another run
        } catch (err) {
          log("err", friendly(err) + " — apps already moved stay moved; re-Load and Transfer again to finish the rest");
        }
        return;
      }

      if (act.startsWith("book-point:")) {
        const [, key, addr] = act.split(":");
        return void this._tx(S.book.addr, encCall(CONTRACTS.EnclaveAddressBook.sel.set, [{ t: "bytes32", v: encKey(key) }, { t: "addr", v: addr }]),
          `book: ${key} → ${short(addr)}`, panelStatus, true);
      }
    } catch (err) {
      this._status(panelStatus, "err", friendly(err));
    }
  }

  async _connect() {
    if (!Enclave.provider) await connectWallet();
    await ensureBaseChain();
  }

  async _tx(to, data, label, statusEl, refreshAfter) {
    try {
      await this._connect();
      this._status(statusEl, "p", label + " - confirm in your wallet…");
      const hash = await sendTx(to, data);
      this._status(statusEl, "p", label + " · " + hash.slice(0, 14) + "… waiting for confirmation…");
      await waitReceipt(hash);
      this._status(statusEl, "ok", label + " - confirmed ✓");
      showToast(label + " ✓");
      if (refreshAfter) setTimeout(() => this.refresh(), 1200);
    } catch (e) {
      this._status(statusEl, "err", label + " - " + friendly(e));
    }
  }

  _status(el, cls, txt) {
    if (!el) { showToast(txt); return; }
    el.hidden = false;
    el.className = "ac-status " + cls;
    el.textContent = txt;
  }
}
register("c-admin-console", AdminConsole);
