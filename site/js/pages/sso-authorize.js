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

   A SIGNED-IN visitor passes through with no interaction at all:
   the operator's explicit decision (2026-08-17). Deployments are
   this platform's trust unit, so an app learning a signed-in
   visitor's address is accepted, not gated on a click. Interaction
   remains only where something genuinely forks: signing in at all,
   linking a first wallet, choosing among several.
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

/* Failure UX: the person came FROM an app, so every failure card leads back
   to it. `back` is only ever an origin DERIVED from the aud (the canonical
   subdomain) or the already-VALIDATED return target - never the raw
   redirect_uri parameter, which on the validation-failure path is exactly
   the thing that could not be trusted. */
function fatal(body, msg, back){
  const links = back
    ? '<a class="btn btn-primary" href="' + esc(back) + '">Back to ' + esc(new URL(back).host) + '</a> ' +
      '<a class="btn" href=".">enclave.host</a>'
    : '<a class="btn" href=".">Go to enclave.host</a>';
  body.innerHTML = card('<p class="co-note">' + esc(msg) + '</p>' + links);
}

/* Return origins this aud may receive a token at: the canonical subdomain,
   plus every custom domain VERIFIED for exactly this deployment. The map
   being unreachable only narrows the set - the subdomain still works. */
async function allowedOrigins(aud){
  const set = new Set(["https://" + aud.slice(2, 10).toLowerCase() + "." + APP_DOMAIN]);
  try {
    const m = await Enclave.domainsMap();
    for (const [host, dep] of Object.entries((m && m.domains) || {}))
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

  // display=popup: the app opened this page in a small window whose frame IS
  // the chrome - drop the site's own, the card carries the whole story
  if (q.get("display") === "popup"){
    for (const t of ["c-header", "c-footer"]){
      const el = document.querySelector(t);
      if (el) el.style.display = "none";
    }
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(aud))
    return fatal(body, "This sign-in link names no app. Open the app itself and use its sign-in button.");
  // id-derived, so it is a safe "back" destination even when redirect_uri is not
  const canonical = "https://" + aud.slice(2, 10).toLowerCase() + "." + APP_DOMAIN;

  body.innerHTML = card('<p class="co-note">Checking the app…</p>');
  const allowed = await allowedOrigins(aud);
  let target = "";   // validated origin + the caller's own path/query; fragment dropped
  try {
    const u = new URL(redirect);
    if (u.protocol === "https:" && allowed.has(u.origin)) target = u.origin + u.pathname + u.search;
  } catch(e){}
  if (!target)
    return fatal(body, "This link wants to send your sign-in somewhere that does not belong to that app, so nothing was signed. Open the app itself and use its sign-in button.", canonical);
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
      if (!me.wallets || !me.wallets.length) return fatal(body, "The wallet did not link. Try again.", target);
    }

    // No consent interstitial - the operator's explicit call (2026-08-17):
    // every return origin is one of this platform's own deployments, and the
    // platform accepts its apps learning a signed-in visitor's address
    // without a click. The only interactive step left on this path is the one
    // that genuinely forks: which identity, when the account holds several.
    let address = me.wallets[0];
    if (me.wallets.length > 1){
      body.innerHTML = card(
        '<p class="co-note">Continue to <b>' + esc(appHost) + '</b> as</p>' +
        '<p class="co-note"><select id="ssoAddr">' +
        me.wallets.map((w) => '<option value="' + esc(w) + '">' + esc(short(w)) + '</option>').join("") +
        '</select></p>' +
        '<button class="btn btn-primary" id="ssoApprove" type="button">Continue</button>');
      await new Promise((r) => $("#ssoApprove").addEventListener("click", r, { once: true }));
      address = $("#ssoAddr").value;
    }

    body.innerHTML = card('<p class="co-note">Signing you in to ' + esc(appHost) + '…</p>');
    const out = await Enclave.ssoToken(aud, address, ttl);
    if (!out || !out.token) return fatal(body, "The relay did not return a token. Try again.", target);

    // FRAGMENT handoff: reaches no server log and no Referer
    body.innerHTML = card('<p class="co-note">Returning to ' + esc(appHost) + '…</p>');
    location.replace(target + "#sso=" + encodeURIComponent(out.token) +
      (state ? "&state=" + encodeURIComponent(state) : ""));
  } catch(e){
    if (/rejected|cancelled|cancel/i.test((e && e.message) || "")) return fatal(body, "Cancelled. Nothing was signed.", target);
    showToast((e && e.message) || String(e));
    fatal(body, (e && e.message) || String(e), target);
  }
}

mount();
