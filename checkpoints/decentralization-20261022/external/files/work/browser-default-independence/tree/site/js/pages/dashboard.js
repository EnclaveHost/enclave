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
import { DEPLOYMENTS_ADDRESS, INDEPENDENT } from "../core/config.js";
import { catExplorer } from "../core/chain.js";
import { Enclave, INDEPENDENT_MODE } from "../core/api.js";
import { mountIndependentPanel } from "../core/independent-ui.js";
import { refreshFleetInto } from "../core/fleet-read.js";
import { navigate } from "../boot.js";

/* Signed-out visitors have nothing here - bounce to Overview. "Signed out"
   means NO connected address and NO persisted session either: the wallet
   restore is ASYNC (provider discovery takes seconds), so a stored session
   holds the page while it settles; sign-out clears the store and the next
   wallet edge bounces. */
function gate(){
  if (!document.querySelector('section[data-view="dashboard"]')) return;   // another page's <main> is mounted
  if (Enclave.address || Enclave.accountAuthed()) return;
  // independent mode needs no wallet: a passkey account is created, selected and used from this page, and may pay its own gas
  if (INDEPENDENT_MODE) return;
  let stored = null, acct = null;
  try { stored = JSON.parse(lsGet("enclave_session") || "null"); } catch(e){}
  try { acct = JSON.parse(lsGet("enclave_account") || "null"); } catch(e){}
  if ((!stored || !stored.address) && (!acct || !acct.token)) navigate("./");
}
on("enclave:wallet", gate);    // module-load-once: restore-settle and sign-out edges
on("enclave:account", gate);   // passkey/card session edges gate the same way
// Nothing here is account-specific anymore: <c-deployments> renders vault-owned
// rows with the same controls wallet rows get, and the credit balance lives in
// the header popover (wallet.js) next to the wallet users' USDC balance.

/* the fleet capacity panel: the relay's /enclaves table (GPU boxes first);
   polled only while this page's <main> is mounted */
let _fleetPoll = null, _indFleetAt = 0;
async function refreshFleet(force){
  // independent mode: the pinned registry at an agreed block plus each host's own signed capacity (js/core/fleet-read.js),
  // read at most every two minutes (public chain endpoints), or on the panel's own refresh
  if (INDEPENDENT_MODE){ if (force !== true && Date.now() - _indFleetAt < 120000) return; _indFleetAt = Date.now(); }
  // a failed read shows the last good table marked stale, or an error state -
  // never the component's "no app hosts" empty state (js/core/fleet-read.js)
  await refreshFleetInto(document.querySelector(".dash-fleet c-fleet-list"), Enclave.base);
}

/* the network profile panel (independent mode settings), above the apps list */
function mountProfile(){
  const list = document.querySelector('section[data-view="dashboard"] c-deployments');
  if (!list) return;
  let el = document.querySelector(".ind-mount");
  if (!el){ el = document.createElement("div"); el.className = "ind-mount"; list.before(el); }
  mountIndependentPanel(el);
  if (INDEPENDENT_MODE){
    let ss = document.querySelector(".ind-sess-mount");
    if (!ss){ ss = document.createElement("div"); ss.className = "ind-sess-mount"; el.after(ss); }
    import("../core/independent-ui.js").then((m) => m.mountSessionControls(ss)).catch(() => {});
    // the owner's passkey account (a Safe their passkeys and recovery keys own): create, deploy, sign in, recover
    let acct = document.querySelector(".acct-mount");
    if (!acct){ acct = document.createElement("div"); acct.className = "acct-mount"; ss.after(acct); }
    import("../core/account-ui.js").then((m) => m.mountAccountPanel(acct)).catch(() => {});
    // whom the dashboard acts for (the wallet, or an explicitly selected passkey account) and who pays the gas
    let idb = document.querySelector(".id-bar-mount");
    if (!idb){ idb = document.createElement("div"); idb.className = "id-bar-mount"; list.before(idb); }
    import("../core/account-ui.js").then((m) => m.mountIdentityBar(idb)).catch(() => {});
  }

}

export function boot() {
  mountProfile();
  refreshFleet();
  // the component's ↻ button: re-fetch on demand (named ref = idempotent re-boot)
  const fl = document.querySelector(".dash-fleet c-fleet-list");
  if (fl) fl.addEventListener("refresh", () => refreshFleet(true));
  if (!_fleetPoll) _fleetPoll = setInterval(() => {
    if (!document.querySelector('section[data-view="dashboard"]')) return;
    refreshFleet();
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
  gate();
}
