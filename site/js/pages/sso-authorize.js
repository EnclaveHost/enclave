/* ============================================================
   /sso/authorize - Sign in with Enclave for TENANT apps (EST1).

   A tenant app (eyesoff.ai et al) sends a visitor here to reuse
   their enclave.host login. This page authenticates them with the
   relay ACCOUNT session (passkey or wallet SIWE - openSignIn), has
   the relay mint a short-lived, audience-bound EST1 token naming
   one of the account's LINKED wallet addresses (relay/sso.js), and
   returns them to the app with the token in the URL fragment. The
   app verifies it inside its own enclave against the published
   signer address; the contract is enclave-apps/eyesoff-ai/
   PLATFORM-sso.md.

   The same invariant as /authorize, for the same reason: the set
   of RETURN ORIGINS is derived from the deployment id alone - its
   canonical <label>.app.enclave.host subdomain plus any custom
   domain the platform has VERIFIED for exactly that deployment
   (/v1/domains/map) - and redirect_uri is honored only if its
   origin is in that set. Otherwise ?aud=<real app>&redirect_uri=
   <attacker> would aim a freshly minted token at an attacker's
   origin. Unlike /authorize the custom-domain origin is allowed
   through (an SSO user should land back on the address they came
   from), which is safe here precisely because the set is built
   from verified ownership rows, never from the parameter.

   `state` is opaque and echoed verbatim: the app refuses a token
   whose state echo does not match the one it stored when it
   started the flow, so a crafted link cannot sign a visitor into
   an account they never chose. Token travels in the FRAGMENT -
   no server log, no Referer.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import { Enclave } from "../core/api.js";
import { APP_DOMAIN } from "../core/config.js";
import { $, esc, showToast } from "../core/util.js";
import { openSignIn, restoreAccountSession } from "../core/account.js";
import { connectWallet, personalSign, buildSiwe, assertSiweLogin } from "../core/wallet.js";

const card = (html) => '<div class="lk-card">' + html + '</div>';
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

function fatal(body, msg){
  body.innerHTML = card('<p class="co-note">' + esc(msg) + '</p>' +
    '<a class="btn" href=".">Go to enclave.host</a>');
}

/* Return origins this aud may receive a token at: the canonical subdomain,
   plus every custom domain VERIFIED for exactly this deployment. The map
   being unreachable only narrows the set - the subdomain still works. */
async function allowedOrigins(aud){
  const set = new Set(["https://" + aud.slice(2, 10).toLowerCase() + "." + APP_DOMAIN]);
  try {
    const r = await fetch(Enclave.base + "/v1/domains/map", { mode: "cors" });
    const m = await r.json();
    for (const [host, dep] of Object.entries(m.domains || {}))
      if (String(dep).toLowerCase() === aud.toLowerCase())
        set.add("https://" + String(host).toLowerCase());
  } catch(e){ /* canonical subdomain remains */ }
  return set;
}

async function mount(){
  const body = $("#ssoBody"); if (!body) return;
  const q = new URL(location.href).searchParams;
  const aud = String(q.get("aud") || "").trim();
  const redirect = String(q.get("redirect_uri") || "").trim();
  const state = String(q.get("state") || "");
  const ttl = parseInt(q.get("ttl") || "", 10) || undefined;

  if (!/^0x[0-9a-fA-F]{64}$/.test(aud))
    return fatal(body, "This sign-in link names no app. Open the app itself and use its sign-in button.");

  body.innerHTML = card('<p class="co-note">Checking the app…</p>');
  const allowed = await allowedOrigins(aud);
  let target = "";   // validated origin + the caller's own path/query; fragment dropped
  try {
    const u = new URL(redirect);
    if (u.protocol === "https:" && allowed.has(u.origin)) target = u.origin + u.pathname + u.search;
  } catch(e){}
  if (!target)
    return fatal(body, "This link wants to send your sign-in somewhere that does not belong to that app, so nothing was signed. Open the app itself and use its sign-in button.");
  const appHost = new URL(target).host;

  const go = (label, note) => {
    body.innerHTML = card('<p class="co-note">' + esc(note) + '</p>' +
      '<button class="btn btn-primary" id="ssoGo" type="button">' + esc(label) + '</button>');
    return new Promise((r) => $("#ssoGo").addEventListener("click", r, { once: true }));
  };

  try {
    restoreAccountSession();
    if (!Enclave.accountAuthed()){
      await go("Sign in", "Sign in with your Enclave account - passkey or wallet - to continue to " + appHost + ".");
      body.innerHTML = card('<p class="co-note">Waiting for sign-in…</p>');
      await openSignIn();
    }

    body.innerHTML = card('<p class="co-note">Checking your account…</p>');
    let me = await Enclave.accountMe();
    if (!me.wallets || !me.wallets.length){
      // A passkey-only account has no wallet address yet, and the address is
      // the identity apps receive. Link one once; the passkey signs from then on.
      await go("Link a wallet", "Apps identify you by a wallet address, and this account has none linked yet. Connect a wallet and sign one message to link it - after this once, your passkey alone signs you in everywhere.");
      body.innerHTML = card('<p class="co-note">Linking your wallet…</p>');
      await connectWallet();
      const ch = await Enclave.accountSiweNonce(Enclave.address);
      const message = assertSiweLogin((ch && ch.message) ? ch.message : buildSiwe(ch), Enclave.address);
      const signature = await personalSign(message);
      await Enclave.accountLinkSiwe(message, signature);
      me = await Enclave.accountMe();
      if (!me.wallets || !me.wallets.length) return fatal(body, "The wallet did not link. Try again.");
    }

    // Consent: name the app origin and the address about to be asserted. One
    // account can hold several wallets; the choice is which identity the app
    // sees, so it is the user's, not the first row's.
    const pick = me.wallets.length > 1
      ? '<p class="co-note"><label for="ssoAddr">Sign in as </label><select id="ssoAddr">' +
        me.wallets.map((w) => '<option value="' + esc(w) + '">' + esc(short(w)) + '</option>').join("") +
        '</select></p>'
      : '<p class="co-note">Sign in as <code title="' + esc(me.wallets[0]) + '">' + esc(short(me.wallets[0])) + '</code>.</p>';
    body.innerHTML = card(
      '<p class="co-note">Sign in to <b>' + esc(appHost) + '</b> with your Enclave account?</p>' + pick +
      '<p class="co-note">The app receives a short-lived signed note naming that address and this app alone - not your passkey, not your wallet, and it can authorize no transaction.</p>' +
      '<button class="btn btn-primary" id="ssoApprove" type="button">Sign in to ' + esc(appHost) + '</button>');
    await new Promise((r) => $("#ssoApprove").addEventListener("click", r, { once: true }));
    const address = me.wallets.length > 1 ? $("#ssoAddr").value : me.wallets[0];

    body.innerHTML = card('<p class="co-note">Signing you in…</p>');
    const out = await Enclave.ssoToken(aud, address, ttl);
    if (!out || !out.token) return fatal(body, "The relay did not return a token. Try again.");

    // FRAGMENT handoff: reaches no server log and no Referer
    body.innerHTML = card('<p class="co-note">Returning to ' + esc(appHost) + '…</p>');
    location.replace(target + "#sso=" + encodeURIComponent(out.token) +
      (state ? "&state=" + encodeURIComponent(state) : ""));
  } catch(e){
    if (/rejected|cancelled|cancel/i.test((e && e.message) || "")) return fatal(body, "Cancelled. Nothing was signed.");
    showToast((e && e.message) || String(e));
    fatal(body, (e && e.message) || String(e));
  }
}

mount();
