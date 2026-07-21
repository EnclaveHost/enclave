/* ============================================================
   Checkout - "Add credit". One number, one button: pick a
   dollar amount, pay on a Stripe-hosted page, and the balance
   lands on your account. Deploying happens where deploying
   belongs (the Apps deploy console / dashboard) and draws on
   this balance with a passkey tap.

   Credit is closed-loop prepaid service credit: spendable only
   on Enclave runtime, non-transferable, never redeemable for
   cash, capped per account. Refunds are handled by a person
   (support@enclave.host).

   ?order=<id> resumes the post-Stripe status view (the webhook
   settles the top-up; c-order-status narrates it).
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import "../../components/order-status/order-status.js";
import { ACCOUNTS_ENABLED } from "../core/config.js";
import { Enclave } from "../core/api.js";
import { $, esc, on, showToast } from "../core/util.js";
import { openSignIn } from "../core/account.js";
import { getVault, addCredit } from "../core/vault.js";

const PRESETS = [10, 25, 50, 100];

export function boot(){
  const body = $("#coBody"); if (!body) return;
  const gate = $("#coGate");
  if (!ACCOUNTS_ENABLED){
    if (gate){ gate.hidden = false; gate.textContent = "Credit isn't available yet. Deploy and pay from your wallet on the Apps page instead."; }
    return;
  }

  const params = new URLSearchParams(location.search);
  const orderId = params.get("order");
  if (orderId) return mountStatus(body, orderId, params.get("cancelled") === "1");

  if (!Enclave.accountAuthed()){
    body.innerHTML = '<div class="co-note">' +
      '<p>Sign in to add credit to your account.</p>' +
      '<button class="btn" id="coSignin" type="button">Sign in to continue</button></div>';
    const b = $("#coSignin");
    if (b) b.addEventListener("click", async () => {
      try { await openSignIn(); }
      catch(e){ if (!/cancelled/i.test((e && e.message) || "")) showToast((e && e.message) || String(e)); }
    });
    on("enclave:account", (d) => { if (d.authed) boot(); });
    return;
  }
  renderForm(body);
}

async function renderForm(body){
  body.innerHTML =
    '<div class="co-form">' +
    '<div class="co-quote" id="coBal" role="status">Checking your balance…</div>' +
    '<div class="co-field"><label for="coAmt">Amount to add</label>' +
    '<div class="co-pay" id="coPresets">' +
      PRESETS.map((p) => '<button class="btn" data-amt="' + p + '" type="button">$' + p + '</button>').join("") +
    '</div>' +
    '<div class="co-shares"><span>$</span><input class="wp-input" id="coAmt" inputmode="decimal" value="25" aria-label="Dollar amount" /></div></div>' +
    '<div class="co-err" id="coErr" role="alert" hidden></div>' +
    '<div class="co-pay"><button class="btn btn-primary" id="coCard" type="button">Add credit by card</button></div>' +
    '<p class="co-note">Card payment happens on a Stripe-hosted page; your card details never touch Enclave. ' +
    'Credit is spendable on Enclave runtime only: it is not transferable, not redeemable for cash, and capped at ' +
    '<span id="coCap">$2,000</span> per account. Every spend needs your passkey. Refunds are handled by a person.</p>' +
    '</div>';

  const err = (m) => { const el = $("#coErr"); if (el){ el.hidden = !m; el.textContent = m || ""; } };
  const vault = await getVault();
  const bal = $("#coBal");
  if (bal) bal.textContent = vault ? "Your balance: $" + vault.balanceUsd : "Balance unavailable right now - adding credit still works.";
  if (vault && $("#coCap")) $("#coCap").textContent = "$" + Number(vault.capUsd).toLocaleString();

  const presets = $("#coPresets");
  if (presets) presets.addEventListener("click", (e) => {
    const b = e.target.closest("[data-amt]");
    if (b && $("#coAmt")) $("#coAmt").value = b.dataset.amt;
  });
  const card = $("#coCard");
  if (card) card.addEventListener("click", async () => {
    err("");
    const amt = parseFloat($("#coAmt")?.value);
    if (!(amt > 0)) { err("Enter a dollar amount."); return; }
    card.disabled = true;
    try { await addCredit(amt); }                 // navigates to Stripe on success
    catch(e){ err(e.message || String(e)); card.disabled = false; }
  });
}

function mountStatus(body, orderId, cancelled){
  body.innerHTML =
    (cancelled ? '<p class="co-note">Card checkout was cancelled. Nothing was charged.</p>' : "") +
    '<c-order-status order-id="' + esc(orderId) + '"></c-order-status>' +
    '<p class="co-note"><a href="checkout">← Add more credit</a> · <a href="dashboard">Your dashboard</a></p>';
}
