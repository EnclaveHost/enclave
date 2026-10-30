/* ============================================================
   Wallet release: the "Move to wallet" control under each deployment
   the vault holds (/sessions). Rendering is a pure function of state
   (slotHtml) so it can be checked without a browser; wiring creates one
   controller per row, shows its blockers or journal state, and sends
   only on the owner's explicit second click (review -> sign).
   ============================================================ */
import { createReleaseController } from "./wallet-release-controller.js";
import { viemReader, PINS } from "./wallet-release-chain.js";
import { IdbJournal } from "./wallet-release-store.js";
import { createWalletCensus, censusReaders } from "./wallet-release-census.js";

/* Same-origin copy of evidence/deployments/ledger-creation-artifact.json plus its four reviewed constructor arguments
   ({ bytecode: { object, linkReferences }, constructorArgs }). Root places it at deployment; absent => explicit blocker. */
export const LEDGER_ARTIFACT_PATH = "../../wallet-release/ledger-creation-artifact.json";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** USDC 6dp, exact (no float). */
export const usdc6 = (v) => { const n = BigInt(v || 0), s = (n % 1000000n).toString().padStart(6, "0"); return (n / 1000000n).toString() + "." + s + " USDC"; };
const ENV = { 0: "not adopted", 1: "staging", 2: "production" };

const JOURNAL_TEXT = {
  intent: "A release was started but not sent. Nothing will be signed again for it; it resolves once its deadline passes on-chain.",
  signed: "A release was signed but not sent. Nothing will be signed again for it; it resolves once its deadline passes on-chain.",
  dispatching: "A release was prepared for dispatch; whether it reached the relay is unknown. Checking the chain only - it will never be signed or sent again automatically.",
  uncertain: "The relay did not confirm the release; it may still land. Checking the chain only - it will never be signed or sent again automatically.",
  submitted: "Submitted; waiting for the transaction to be included.",
  included: "Included in a block, not final yet: a reorganization could still undo it.",
  finalized: "Moved to your wallet: included, final, and its preserved state verified.",
  conflict: "The chain shows something other than this release. Blocked - nothing will be sent; this needs review.",
};

/** The initial slot under one held row (inside heldCard). */
export function releaseSlot(h){
  return '<div class="wr-release" data-wr-dep="' + esc(h.id) + '">' + slotHtml(h.id, "", { kind: "checking" }) + "</div>";
}

function facts(r){
  const row = (k, v) => "<dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd>";
  return '<dl class="ss-facts wr-facts">' +
    row("app id", r.deployment) + row("from (current vault)", r.vault) + row("to (your wallet, fixed)", r.destination) +
    row("balance kept", usdc6(r.balance6)) + row("spent so far", usdc6(r.spent6)) + row("rate / cap", r.rate + " / " + r.cap) +
    row("publisher fee", r.fee.rate6 === "0" ? "none" : r.fee.rate6 + " to " + r.fee.recipient) +
    row("version", r.appRef) + row("config", r.configCid || "(none)") + row("ports", r.ports) +
    row("access", r.isPublic ? "PUBLIC" : "private") + row("environment now", ENV[r.env] || "?") +
    row("sessions before", r.authorityBefore) + row("sessions after", r.authorityAfter) +
    row("you sign", r.signature) + row("session access", r.sessionAccess) + row("read at block", r.block.number + " (" + r.block.hash + ")") +
    "</dl>" + censusFacts(r.census);
}
/** What the census observed: specific narrowing, what is kept, and what it cannot prove. No blanket "safe" claim. */
function censusFacts(c){
  if (!c) return "";
  const list = (label, xs) => xs && xs.length ? '<p class="co-note">' + esc(label) + '</p><ul class="wr-census">' + xs.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "";
  const n = c.counts || {};
  return '<p class="co-note wr-census-head">Checked ' + esc(n.delegations) + " delegation records and " + esc(n.sessions) + " sessions (" + esc(n.liveSessions) +
    " live) in " + esc(n.vaults) + " vault(s), complete history to block " + esc(c.checkpoint && c.checkpoint.number) + ".</p>" +
    list("Loses access (narrowing):", c.narrowed) + list("Keeps access:", c.preserved) + list("Not proven by this check:", c.limits);
}

/** The whole slot for one state. Every interpolated value is escaped; there is no address input. */
export function slotHtml(id, wallet, st){
  const sid = "wr-st-" + esc(String(id).slice(2, 14));
  const status = (t) => '<p class="co-note wr-status" id="' + sid + '" role="status" aria-live="polite">' + esc(t) + "</p>";
  const dest = wallet ? '<p class="co-note wr-dest">Destination: <b>' + esc(wallet) + "</b> (the wallet that controls this vault; it cannot be changed)</p>" : "";
  const note = st.note ? '<p class="wp-err wr-note" role="alert">' + esc(st.note) + "</p>" : "";
  const blockers = (st.blockers || []).length ? '<ul class="wr-blockers" aria-label="Why it cannot move yet">' +
    st.blockers.map((b) => '<li data-code="' + esc(b.code) + '">' + esc(b.text) + "</li>").join("") + "</ul>" : "";
  const moveBtn = (enabled) => '<button class="btn wr-move" type="button" aria-describedby="' + sid + '"' + (enabled ? "" : ' disabled aria-disabled="true"') + ">Move to wallet</button>";
  const recheck = '<button class="btn wr-recheck" type="button">Check the chain again</button>';
  const head = '<h4 class="wr-h">Move to wallet</h4>' + dest;
  switch (st.kind){
    case "checking": return head + status("Checking the chain…") + '<div class="ss-row">' + moveBtn(false) + "</div>";
    case "eligible": return head + status("Eligible at block " + st.review.block.number + ". Review before signing.") + note + censusFacts(st.review.census) + '<div class="ss-row">' + moveBtn(true) + "</div>";
    case "review": return head + status("Review: this moves the record only. Nothing is stopped, refunded, deposited or re-priced.") + facts(st.review) +
      '<p class="co-note">Checked again after you sign and before it is sent. Not atomic: a change on-chain between that check and inclusion is detected afterwards, not prevented.</p>' +
      '<div class="ss-row"><button class="btn btn-primary wr-sign" type="button">Sign release with wallet</button><button class="btn wr-cancel" type="button">Cancel</button></div>';
    case "signing": return head + status("Check your wallet… (one Release signature, then one relay submission)") +
      '<div class="ss-row"><button class="btn btn-primary wr-sign" type="button" disabled aria-disabled="true" aria-busy="true">Check your wallet…</button></div>';
    case "journal": {
      const r = st.record || {};
      const out = st.outcome && st.outcome.reasons ? " " + st.outcome.reasons.join("; ") + "." : "";
      return head + status((JOURNAL_TEXT[r.state] || "Unknown journal state.") + out) + note +
        '<dl class="ss-facts wr-journal"><dt>state</dt><dd>' + esc(r.state) + "</dd><dt>nonce</dt><dd>" + esc(r.nonce) +
        "</dd><dt>deadline</dt><dd>" + esc(r.deadline) + "</dd>" + (r.txHash ? "<dt>tx</dt><dd>" + esc(r.txHash) + "</dd>" : "") +
        (r.block ? "<dt>block</dt><dd>" + esc(r.block) + "</dd>" : "") + "</dl>" +
        (r.state === "finalized" ? "" : '<div class="ss-row">' + recheck + "</div>");
    }
    case "blocked": return head + status("Cannot move to your wallet yet.") + blockers + note + '<div class="ss-row">' + moveBtn(false) + recheck + "</div>";
    default: return head + status(st.text || "Could not check this deployment.") + note + '<div class="ss-row">' + moveBtn(false) + recheck + "</div>";
  }
}

/** Wire every [data-wr-dep] slot under `body`. Returns dispose(): after it, nothing renders, signs or sends. */
export function startWalletRelease({ body, sdk, cfg, provider, address, vault, relayRoot, deps = {} }){
  const slots = Array.from(body.querySelectorAll("[data-wr-dep]"));
  let live = true;
  const ctrls = [];
  const dispose = () => {
    if (!live) return;
    live = false;
    ctrls.forEach((c) => c.dispose());
    if (provider && provider.removeListener){ provider.removeListener("accountsChanged", dispose); provider.removeListener("chainChanged", dispose); }
    if (typeof removeEventListener === "function") removeEventListener("pagehide", dispose);
  };
  const paint = (slot, html) => { if (live && slot.isConnected !== false) slot.innerHTML = html; };
  if (!provider || !address || !vault || Number(cfg && cfg.chainId) !== PINS.chainId){
    const why = !provider || !address ? "Connect the wallet that controls this vault." : "Unsupported deployment: only the reviewed Base legacy vault can move here.";
    slots.forEach((s) => paint(s, slotHtml(s.getAttribute("data-wr-dep"), address, { kind: "blocked", blockers: [{ code: "unsupported", text: why }] })));
    return dispose;
  }
  if (provider.on){ provider.on("accountsChanged", dispose); provider.on("chainChanged", dispose); }
  if (typeof addEventListener === "function") addEventListener("pagehide", dispose);
  const reader = deps.reader || viemReader(sdk.chainClient(cfg.chainId, cfg.rpc || undefined));
  const journal = deps.journal || new IdbJournal();
  const relay = deps.relay || new sdk.RelayClient(relayRoot);
  // one census for the page: rows share verified immutable history; every check still re-reads tails and current state
  let census = deps.census || null;      // if readers cannot be built, every row shows the controller's "census" blocker
  if (!census) try { census = createWalletCensus({ wallet: address, vault, sdk, readers: censusReaders(sdk, cfg.chainId),
    loadLedgerArtifact: () => fetch(new URL(LEDGER_ARTIFACT_PATH, import.meta.url), { cache: "no-store" }).then((r) => r.ok ? r.json() : null) }); } catch(e){ census = null; }
  const make = deps.makeController || createReleaseController;    // test fixture seam only; the page passes no deps
  for (const slot of slots){
    const id = slot.getAttribute("data-wr-dep");
    let c;
    try { c = make({ sdk, provider, relay, reader, journal, census, wallet: address, ownerAddress: address, vault, deployment: id }); }
    catch(e){ paint(slot, slotHtml(id, address, { kind: "blocked", blockers: [{ code: "identity", text: e.message }] })); continue; }
    ctrls.push(c);
    let seq = 0;
    const show = (st) => { paint(slot, slotHtml(id, address, st)); if (live) bind(st); };
    const refresh = async (note) => {
      const my = ++seq;
      show({ kind: "checking" });
      try {
        let st = await c.check();
        if (st.kind === "journal"){
          const r = await c.recover();
          st = r.record && r.record.state === "cancelled" ? await c.check() : { ...st, record: r.record || st.record, outcome: r.outcome };
        }
        if (my === seq) show({ ...st, note: note || (st.record && st.record.state === "cancelled" ? "Previous attempt was not sent: " + st.record.note : "") });
      } catch(e){ if (my === seq) show({ kind: "error", text: e.message || String(e), note }); }
    };
    const bind = (st) => {
      const mv = slot.querySelector(".wr-move");
      if (mv && st.kind === "eligible") mv.addEventListener("click", () => { seq++; show({ kind: "review", review: st.review }); });
      const cn = slot.querySelector(".wr-cancel");
      if (cn) cn.addEventListener("click", () => refresh());
      const rc = slot.querySelector(".wr-recheck");
      if (rc) rc.addEventListener("click", () => refresh());
      const sg = slot.querySelector(".wr-sign");
      if (sg && st.kind === "review") sg.addEventListener("click", async () => {
        if (c.busy || sg.disabled) return;
        sg.disabled = true; seq++;
        show({ kind: "signing", review: st.review });
        let note = "";
        try { await c.release(); }
        catch(e){ note = e.message || String(e); }
        if (live) refresh(note);
      }, { once: true });
    };
    refresh();
  }
  return dispose;
}
