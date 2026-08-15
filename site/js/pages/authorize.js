/* ============================================================
   /authorize - the wallet hand-off for a PRIVATE deployment.

   A browser's top-level navigation cannot carry an Authorization
   header, so a private app used to answer a bare 401 JSON blob at
   its own URL. The enclave now bounces a navigation here instead;
   this page proves the wallet and sends the user back holding an
   app-origin token.

   WHY THE ROUND TRIP EXISTS AT ALL - the signature must not be
   collected at the app origin. A tenant serves that origin, and
   the supervisor already treats it as hostile (it kills WebAuthn
   there, see tenantHeaders). A "connect your wallet" page living
   at <label>.app.enclave.host would both train users to sign on
   tenant-controlled origins and hand every tenant a same-origin
   template to imitate. Wallet code stays on enclave.host, which
   no tenant can serve; the app origin only ever receives an
   already-minted, audience-bound token.

   The return target is derived from the deployment id alone
   (appEndpoint), never from a URL parameter - otherwise a link
   like /authorize?d=<victim's id>#p=… could aim a freshly minted
   token at an attacker's origin. Only a same-origin PATH is
   carried across, and it is re-checked at the app origin too.
   One consequence, deliberately accepted: a private app reached
   through a custom domain lands back on its canonical subdomain.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import { Enclave } from "../core/api.js";
import { $, esc, showToast } from "../core/util.js";
import { connectWallet, authenticate } from "../core/wallet.js";
import { appEndpoint } from "../../components/deployments/deployments.js";

const card = (html) => '<div class="lk-card">' + html + '</div>';

/* appEndpoint can fall through to a SERVER-SUPPLIED network.endpoint, so the
   deployments component only ever links it after a scheme check. Both uses
   below are location.replace and one of them carries a freshly minted token,
   so they hold to the same rule: https: absolute origins only, nothing else. */
function appOrigin(dep){
  const s = String(appEndpoint(dep) || "");
  return /^https:\/\//i.test(s) ? s.replace(/\/+$/, "") : "";
}

/* The path the user originally asked for, carried in the fragment so it never
   reaches a server log. It is about to be appended to the app's origin, so it
   is validated by RESOLVING it against that origin and keeping it only if it
   stays there - not by pattern-matching for a leading slash, which the URL
   parser makes a lie: it folds backslashes into slashes, so "/\evil.com"
   satisfies /^\/(?!\/)/ and then resolves to https://evil.com/. */
function wantedPath(origin){
  let p = "/";
  try { p = new URLSearchParams(location.hash.slice(1)).get("p") || "/"; } catch(e){}
  try {
    const base = new URL(origin, location.href);
    const u = new URL(p, base);
    return u.origin === base.origin ? u.pathname + u.search : "/";
  } catch(e){ return "/"; }
}

/* A saved wallet is restored ASYNCHRONOUSLY by the header's wallet-button
   (restoreSession), which announces itself on `enclave:wallet`. This page is
   usually entered by redirect, so it can easily run first and conclude the user
   is signed out - offering "Connect wallet" to someone already connected. Give
   the restore a moment to land before deciding. */
function walletReady(ms){
  if (Enclave.address) return Promise.resolve();
  return new Promise((r) => {
    const done = () => { document.removeEventListener("enclave:wallet", done); clearTimeout(t); r(); };
    const t = setTimeout(done, ms);
    document.addEventListener("enclave:wallet", done);
  });
}

function fatal(body, msg){
  body.innerHTML = card('<p class="co-note">' + esc(msg) + '</p>' +
    '<a class="btn" href="dashboard">Go to your dashboard</a>');
}

async function mount(){
  const body = $("#azBody"); if (!body) return;
  const id = String(new URL(location.href).searchParams.get("d") || "").trim();
  if (!id) return fatal(body, "This link is missing a deployment. Open the app from your dashboard instead.");

  const go = (label, note) => {
    body.innerHTML = card('<p class="co-note">' + esc(note) + '</p>' +
      '<button class="btn btn-primary" id="azGo" type="button">' + esc(label) + '</button>');
    return new Promise((r) => $("#azGo").addEventListener("click", r, { once: true }));
  };

  try {
    // Connect first (no signature): the ledger read below is scoped by address,
    // and we need the row to learn WHICH box hosts this deployment before
    // asking for a signature - sessions are per-enclave.
    body.innerHTML = card('<p class="co-note">Checking your wallet…</p>');
    await walletReady(1500);
    if (!Enclave.address){
      await go("Connect wallet", "Connect the wallet that owns this app.");
      await connectWallet();
    }

    body.innerHTML = card('<p class="co-note">Looking up the app…</p>');
    let dep;
    try { dep = await Enclave.getDeployment(id); }
    catch(e){
      return fatal(body, e && e.status === 404
        ? "No such deployment, or this wallet does not own it. Switch wallets and try again."
        : ("Could not look up the app: " + ((e && e.message) || String(e))));
    }
    if (!dep) return fatal(body, "No such deployment.");
    const origin = appOrigin(dep);
    if (!origin) return fatal(body, "This app has no browser-reachable address yet.");
    if (dep.public){
      // Nothing to authorize - send them straight in rather than mint a token
      // the enclave would refuse (the mint endpoint 400s on a public row).
      location.replace(origin + wantedPath(origin));
      return;
    }
    if (String(dep.owner || "").toLowerCase() !== String(Enclave.address || "").toLowerCase())
      return fatal(body, "This app is private and belongs to another wallet. Switch wallets and try again.");

    const host = String(dep.enclave || "").trim();
    if (!host) return fatal(body, "This app is not running right now, so there is nothing to open yet.");

    if (!Enclave.authedFor(host))
      await go("Sign in", "Sign the sign-in message to open this app. It authorizes no transaction.");

    body.innerHTML = card('<p class="co-note">Signing you in…</p>');
    // One signature per box, cached and reused; _asHost's retry shape - a
    // cached session the box no longer honours 401s, so re-sign once.
    const mint = async () => {
      if (!Enclave.authedFor(host)) await authenticate({ enclave: host });
      return Enclave.appToken(id, host);
    };
    let out;
    try { out = await mint(); }
    catch(e){
      if (e && e.status === 401){ await authenticate({ enclave: host }); out = await Enclave.appToken(id, host); }
      else throw e;
    }
    if (!out || !out.token) return fatal(body, "The enclave did not return a token. Try again.");

    // Hand off in the FRAGMENT: it reaches no server log and no Referer.
    const url = origin + "/__enclave/session#t=" + encodeURIComponent(out.token) +
                "&p=" + encodeURIComponent(wantedPath(origin));
    body.innerHTML = card('<p class="co-note">Opening the app…</p>');
    location.replace(url);
  } catch(e){
    if (/rejected/i.test((e && e.message) || "")) return fatal(body, "Signature rejected. Nothing was opened.");
    showToast((e && e.message) || String(e));
    fatal(body, (e && e.message) || String(e));
  }
}

mount();
