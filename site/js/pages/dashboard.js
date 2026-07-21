/* ============================================================
   Dashboard page - the signed-in view: <c-deployments> (the My
   Apps panel) with per-run live-deploy strips and a per-row
   Output panel (deploy narrative + app logs). The page module
   wires the EnclaveDeployments contract chips (the ledger every
   row lives on) and bounces signed-out visitors to Overview.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/deployments/deployments.js";
import "../../components/fleet-list/fleet-list.js";
import { $, lsGet, on } from "../core/util.js";
import { DEPLOYMENTS_ADDRESS } from "../core/config.js";
import { catExplorer } from "../core/chain.js";
import { Enclave } from "../core/api.js";
import { navigate } from "../boot.js";

/* Signed-out visitors have nothing here - bounce to Overview. "Signed out"
   means NO connected address and NO persisted session either: the wallet
   restore is ASYNC (provider discovery takes seconds), so a stored session
   holds the page while it settles; sign-out clears the store and the next
   wallet edge bounces. */
function gate(){
  if (!document.querySelector('section[data-view="dashboard"]')) return;   // another page's <main> is mounted
  if (Enclave.address || Enclave.accountAuthed()) return;
  let stored = null, acct = null;
  try { stored = JSON.parse(lsGet("enclave_session") || "null"); } catch(e){}
  try { acct = JSON.parse(lsGet("enclave_account") || "null"); } catch(e){}
  if ((!stored || !stored.address) && (!acct || !acct.token)) navigate("./");
}
on("enclave:wallet", gate);   // module-load-once: restore-settle and sign-out edges
on("enclave:account", (d) => {
  gate();
  // passkey/card sign-in: mount the credit card above the shared panel (the
  // deployment rows themselves live in <c-deployments>, which reads the
  // account-scoped join by itself - one dashboard for both kinds of customer)
  if (document.querySelector('section[data-view="dashboard"]')){
    if (d && d.authed) mountAccountBar();
    else { const b = $("#acctBal"); if (b) b.remove(); }
  }
});
// a vault op inside <c-deployments> (Top up) moved credit - refresh the card
on("enclave:credit", () => refreshAccountBal());

/* the account extras: a credit-balance card above the shared <c-deployments>
   panel. Nothing else is account-specific here anymore - the panel renders
   vault-owned rows with the same controls wallet rows get. */
function mountAccountBar(){
  const cd = document.querySelector("c-deployments"); if (!cd) return;
  if (!$("#acctBal")){
    const bal = document.createElement("div");
    bal.id = "acctBal"; bal.className = "acct-row";
    bal.innerHTML = '<div class="acct-app"><b>Credit</b></div><div class="acct-meta"><span id="acctBalV">…</span>' +
      '<a class="btn btn-sm" href="checkout">Add credit</a></div>';
    cd.parentNode.insertBefore(bal, cd);
  }
  refreshAccountBal();
}
async function refreshAccountBal(){
  const el = $("#acctBalV"); if (!el) return;
  try {
    const { getVault } = await import("../core/vault.js");
    const v = await getVault();
    el.textContent = v ? "$" + v.balanceUsd : "unavailable";
  } catch(e){ el.textContent = "unavailable"; }
}

/* the fleet capacity panel: the relay's /enclaves table, same sort as the
   deploy console; polled only while this page's <main> is mounted */
let _fleetPoll = null;
async function refreshFleet(){
  const fl = document.querySelector(".dash-fleet c-fleet-list"); if (!fl) return;
  try {
    const r = await fetch(Enclave.base.replace(/\/v1\/?$/, "") + "/enclaves", { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("no fleet view");
    const j = await r.json();
    fl.rows = (j.enclaves || []).slice().sort((a, b) =>
      ((b.availability && b.availability.gpu) === true) - ((a.availability && a.availability.gpu) === true)
      || String(a.endpoint || "").localeCompare(String(b.endpoint || "")));
  } catch(e){ fl.rows = []; }   // the component's empty state reads "no live enclaves"
}

export function boot() {
  refreshFleet();
  // the component's ↻ button: re-fetch on demand (named ref = idempotent re-boot)
  const fl = document.querySelector(".dash-fleet c-fleet-list");
  if (fl) fl.addEventListener("refresh", refreshFleet);
  if (!_fleetPoll) _fleetPoll = setInterval(() => {
    if (!document.querySelector('section[data-view="dashboard"]')) return;
    refreshFleet();
    if ($("#acctBal")) refreshAccountBal();
  }, 20000);
  // the ledger's provenance mark: one icon straight to the contract on
  // Basescan (Steven's call); full name + address in the tooltip
  const link = $("#depAddrLink");
  if (link){
    if (DEPLOYMENTS_ADDRESS && !/^0x0+$/i.test(DEPLOYMENTS_ADDRESS)){
      link.href = catExplorer() + "/address/" + DEPLOYMENTS_ADDRESS;
      link.title = "EnclaveDeployments · " + DEPLOYMENTS_ADDRESS;
    } else link.hidden = true;
  }
  if (Enclave.accountAuthed()) mountAccountBar();
  else { const b = $("#acctBal"); if (b) b.remove(); }
  gate();
}
