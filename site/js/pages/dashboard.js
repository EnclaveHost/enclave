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
on("enclave:wallet", gate);    // module-load-once: restore-settle and sign-out edges
on("enclave:account", gate);   // passkey/card session edges gate the same way
// Nothing here is account-specific anymore: <c-deployments> renders vault-owned
// rows with the same controls wallet rows get, and the credit balance lives in
// the header popover (wallet.js) next to the wallet users' USDC balance.

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

/* ---- stranded-vault recovery (operator tool, link-only) ----------------------
   A vault left behind by a factory migration can only be emptied by its own
   passkey, which lives on a phone rather than on the machine holding the
   governance wallet. This renders ONLY when the page is opened with
   ?recover=<vault>&factory=<factory> - it is not discoverable, not advertised,
   and not part of the signed-in experience. The relay refuses any vault the
   signed-in account's passkey does not derive at that factory, so a wrong or
   hostile link cannot reach someone else's money; and the destination is the
   vault's own immutable treasury either way.

   Deliberately a one-off: when there are no stranded vaults left, the link
   stops resolving to anything and this can go. */
async function recoveryCard(){
  const q = new URLSearchParams(location.search);
  const vault = (q.get("recover") || "").trim(), factory = (q.get("factory") || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(vault) || !/^0x[0-9a-fA-F]{40}$/.test(factory)) return;
  const host = document.querySelector('section[data-view="dashboard"] .wrap');
  if (!host || document.getElementById("recCard")) return;
  const card = document.createElement("div");
  card.id = "recCard";
  card.className = "ac-panel";
  card.style.cssText = "margin:1rem 0;padding:1rem;border:1px solid var(--line);border-radius:8px";
  card.innerHTML = `<h2 style="margin:0 0 .5rem">Recover a stranded balance</h2>
    <p class="ac-sub" style="margin:0 0 .75rem">Vault <code>${vault.slice(0, 10)}…${vault.slice(-6)}</code> was left behind by a
    platform migration. Its balance can only be moved by the passkey that created it, and only to Enclave's treasury.
    <span id="recAmt">checking…</span></p>
    <button class="btn btn-primary btn-sm" id="recGo" disabled>Sign with your passkey</button>
    <div id="recOut" class="ac-sub" style="margin-top:.5rem"></div>`;
  host.prepend(card);
  const out = document.getElementById("recOut"), go = document.getElementById("recGo");
  const say = (t) => { out.textContent = t; };
  if (!Enclave.accountAuthed()) { say("Sign in first, then reload this link."); return; }
  // ask the relay what it would sign: quoting with no amount returns the whole
  // balance, and getting an answer at all is proof it accepted this vault as
  // this account's. Reading the token client-side would mean guessing which
  // USDC the vault was built with.
  const { vaultOp } = await import("../core/vault.js");
  let amountUsd = null;
  try {
    amountUsd = (await Enclave.vaultPrepare({ op: "refund", vault, factory })).amountUsd;
  } catch(e){ say(e && e.message || "This vault is not recoverable from this account."); return; }
  document.getElementById("recAmt").textContent = `It holds $${amountUsd}.`;
  go.disabled = false;
  go.addEventListener("click", async () => {
    go.disabled = true;
    say("Confirm with your passkey…");
    try {
      await vaultOp("refund", { amountUsd: Number(amountUsd), vault, factory });
      say(`Returned $${amountUsd}. Done - this link has nothing left to recover.`);
    } catch(e){ say(e && e.message || String(e)); go.disabled = false; }
  });
}

export function boot() {
  refreshFleet();
  recoveryCard().catch(() => {});
  // the component's ↻ button: re-fetch on demand (named ref = idempotent re-boot)
  const fl = document.querySelector(".dash-fleet c-fleet-list");
  if (fl) fl.addEventListener("refresh", refreshFleet);
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
