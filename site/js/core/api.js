/* ============================================================
   Live client (Enclave) - the exact client the pages use; mirrors
   the published HTTP API. Base URL persists across pages via
   localStorage (the Deploy page exposes the field).
   ============================================================ */
import { DEFAULT_API_BASE } from "./config.js";
import { lsGet, lsSet, emit } from "./util.js";
import { adoptServerSpec, adoptFleetPrice } from "./pricing.js";

/* ---- typed error carrying HTTP status ---- */
export class EnclaveError extends Error {
  constructor(message, status, body){ super(message); this.name = "EnclaveError"; this.status = status; this.body = body; }
}

export const Enclave = {
  /* The endpoint every call goes to. It persists in localStorage because the
     Deploy page exposes the field (point the site at your own relay, or at
     localhost). That persistence is also why a SESSION IS BOUND TO THE BASE
     THAT ISSUED IT, below: a stored base survives reloads, so anything that
     once managed to write localStorage for this origin would otherwise keep
     receiving the user's bearer token forever — long after the way in was
     closed. A token is scoped to its issuer anyway (each enclave signs with
     its own in-enclave key; the relay with its own), so refusing to send it
     elsewhere costs nothing and is simply the truth about what it means. */
  base: (lsGet("enclave_api_base") || DEFAULT_API_BASE).replace(/\/+$/, ""),
  token: null, tokenBase: null, address: null, chainId: null, provider: null, walletRdns: null,
  /* relay ACCOUNT session (passkey or SIWE; account.js owns the lifecycle).
     A separate trust domain from `token` (the enclave-minted session for
     deployment-private reads): account tokens gate billing/orders only, and
     the two are never interchangeable. */
  accountToken: null, accountTokenBase: null, accountId: null, accountMethod: null,
  setBase(u){ this.base = String(u || "").trim().replace(/\/+$/, "") || DEFAULT_API_BASE; lsSet("enclave_api_base", this.base); },
  /* Is `tok`, minted against `mintedAt`, allowed to travel to the current
     base? Sessions minted before this binding existed carry no base and are
     honored only at the default endpoint. */
  _sendable(mintedAt){ return (mintedAt || DEFAULT_API_BASE).replace(/\/+$/, "") === this.base; },
  authed(){ return !!this.token; },
  /* Sessions are PER-ENCLAVE. Every enclave signs its own tokens with its own
     in-enclave key and honors no other kid (supervisor verifySessionToken), so
     one signed-in state can't cover a fleet: `token` is the sticky box's
     session (fleet-wide calls), `enclaveTokens` holds one per named box for
     calls the relay routes to a specific enclave. Nothing is interchangeable —
     presenting the wrong one reads as "Missing or invalid session". */
  enclaveTokens: {},
  /* A session also names ONE WALLET (its JWT `sub`), and that binding is the
     dangerous one to drop: after an account switch in the wallet, a cached
     token still VERIFIES on its box — so presenting it doesn't fail as
     unauthorized, it succeeds as the PREVIOUS account, and every owner gate
     then answers 404 "No such deployment." for records the connected account
     owns (found 2026-08-20: /authorize skipped the sign-in because a stale
     session existed for the box, minted an app token as the old wallet, and
     the enclave refused the owner's own private app). A token whose sub can't
     be read is treated as wallet-agnostic — the guard rejects only a PROVEN
     mismatch, so opaque legacy tokens keep working. */
  _tokenSub(tok){
    try {
      let s = String(tok).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      s += "=".repeat((4 - s.length % 4) % 4);
      const p = JSON.parse(atob(s));
      return typeof p.sub === "string" ? p.sub.toLowerCase() : null;
    } catch(e){ return null; }
  },
  _forWallet(tok){
    const sub = this._tokenSub(tok);
    return !sub || !this.address || sub === String(this.address).toLowerCase();
  },
  sessionFor(name){
    const s = this.enclaveTokens[String(name || "").toLowerCase()] || null;
    // another wallet's session reads as signed-out, NOT as an error: the
    // caller then runs SIWE with the connected wallet and overwrites it
    return s && s.token && !this._forWallet(s.token) ? null : s;
  },
  authedFor(name){ const s = this.sessionFor(name); return !!(s && s.token && this._sendable(s.base)); },
  setSessionFor(name, token){
    const k = String(name || "").toLowerCase();
    if (!k) return;
    if (token) this.enclaveTokens[k] = { token, base: this.base };
    else delete this.enclaveTokens[k];
  },
  accountAuthed(){ return !!this.accountToken; },
  clearAccountSession(){
    this.accountToken = null; this.accountTokenBase = null; this.accountId = null; this.accountMethod = null;
    lsSet("enclave_account", "");
    emit("enclave:account", { authed: false });
  },
  async _req(method, path, opts){
    opts = opts || {};
    let url = this.base + path;
    if (opts.query){
      const qs = Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
      if (qs) url += "?" + qs;
    }
    const headers = { "Accept": "application/json" };
    const hasBody = opts.body !== undefined;
    if (hasBody) headers["Content-Type"] = "application/json";
    // A session travels ONLY to the endpoint that minted it (see `base`).
    const wrongBase = (what) => new EnclaveError(
      `This ${what} was issued by a different endpoint than the one now configured (${this.base}), so it was not sent. `
      + "Point the endpoint back, or sign in again against this one.", 401);
    if (opts.auth){
      // A session is minted by ONE enclave and honored by only that enclave
      // (each signs with its own ES256 key and verifies its own kid alone), so
      // a call the relay routes to a specific box needs THAT box's session.
      // `opts.enclave` names it; without one we're on the sticky box's session,
      // which is right for fleet-wide calls and wrong for per-deployment ones.
      // Either way it must belong to the CONNECTED wallet (_forWallet): the
      // previous account's token verifies fine and acts as that account.
      const tok = opts.enclave ? this.sessionFor(opts.enclave)
                : this._forWallet(this.token) ? { token: this.token, base: this.tokenBase } : null;
      if (!tok || !tok.token) throw new EnclaveError(opts.enclave
        ? `Not signed in to ${opts.enclave}. Sessions are per-enclave — sign in again to act on a deployment hosted there.`
        : "Not signed in. Connect your wallet first.", 401);
      if (!this._sendable(tok.base)) throw wrongBase("session");
      headers["Authorization"] = "Bearer " + tok.token;
    }
    if (opts.accountAuth){
      if (!this.accountToken) throw new EnclaveError("Sign in first.", 401);
      if (!this._sendable(this.accountTokenBase)) throw wrongBase("account session");
      headers["Authorization"] = "Bearer " + this.accountToken;
    }
    if (opts.accountAuthOptional && this.accountToken && this._sendable(this.accountTokenBase))
      headers["Authorization"] = "Bearer " + this.accountToken;
    let res;
    try {
      res = await fetch(url, { method, headers, mode: "cors", body: hasBody ? JSON.stringify(opts.body) : undefined });
    } catch(e){
      throw new EnclaveError("Could not reach " + url + ". Check the endpoint is live and returns CORS headers.", 0);
    }
    const text = await res.text();
    let data = null;
    if (text){ try { data = JSON.parse(text); } catch(e){ data = text; } }
    if (!res.ok){
      // an account token the relay no longer honors is dead weight - drop the
      // stored session so the UI flips back to signed-out instead of erroring
      // on every poll
      if (res.status === 401 && opts.accountAuth) this.clearAccountSession();
      // A per-enclave session the ENCLAVE rejects is dead weight: it was minted
      // by some other box (its kid is the only one it honours), so keeping it
      // means every retry fails identically until localStorage is cleared by
      // hand. Drop it so the next attempt re-mints against the right enclave.
      if (res.status === 401 && opts.enclave) this.setSessionFor(opts.enclave, null);
      const msg = (data && data.message) ? data.message
        : (typeof data === "string" && data) ? data
        : ("HTTP " + res.status + " " + res.statusText);
      throw new EnclaveError(msg, res.status, data);
    }
    return data;
  },
  /* Auth (public) */
  getNonce(address, enclave){ return this._req("GET", "/auth/nonce", { query: { address, enclave: enclave || undefined } }); },
  login(message, signature, enclave){ return this._req("POST", "/auth/login", { query: { enclave: enclave || undefined }, body: { message, signature } }); },
  /* Account */
  getAccount(){ return this._req("GET", "/account", { auth: true }); },
  topup(id, enclave){ return this._req("POST", "/deployments/" + encodeURIComponent(id) + "/topup", { auth: true, enclave }); },
  /* Pricing (public) */
  getPricing(){ return this._req("GET", "/pricing"); },
  getAvailability(){
    // served at the ROOT origin, not under /v1 (the spec's own servers note) -
    // calling BASE/v1/availability 404s and spams the console
    const url = (this.base || "").replace(/\/v1\/?$/, "") + "/availability";
    return fetch(url, { headers: { "Accept": "application/json" } }).then(r => {
      if (!r.ok) throw new EnclaveError("availability: HTTP " + r.status, r.status);
      return r.json();
    }).then(a => {
      // every availability read feeds the share math the REAL fleet hardware -
      // the minimum-dial floors must divide by what the runners divide by
      // (pricing.js explains why the fallback constants can't be trusted) -
      // and the REAL price, which is each enclave's own now, not a platform
      // constant: quotes track the cheapest live one
      adoptServerSpec(a);
      adoptFleetPrice(a);
      return a;
    });
  },
  // The relay's PER-ENCLAVE fleet table (root origin, like /availability; only
  // the relay serves it - pointed at a single enclave this 404s). Sizing that
  // names one box - the deploy console's target, a deployment's lease holder -
  // reads its hardware from here, never from the aggregate.
  getEnclaves(){
    const url = (this.base || "").replace(/\/v1\/?$/, "") + "/enclaves";
    return fetch(url, { headers: { "Accept": "application/json" } }).then(r => {
      if (!r.ok) throw new EnclaveError("enclaves: HTTP " + r.status, r.status);
      return r.json();
    }).then(j => (j && j.enclaves) || []);
  },
  // The relays a deployment may choose between ({"network":{"relay":"…"}} in
  // its options envelope) plus the choices already made, as label -> address.
  // Relay-only, like /enclaves. The roster is what is ANSWERING right now: a
  // relay that stops responding leaves it, and the apps that chose it fall back
  // to the fleet default until it returns (slower, never down - that asymmetry
  // is the whole reason the roster isn't remembered). `services.sni` is the one
  // that matters for the app zone: a relay without it carries other traffic and
  // cannot front an app subdomain.
  getRelays(){
    const url = (this.base || "").replace(/\/v1\/?$/, "") + "/v1/relays";
    return fetch(url, { headers: { "Accept": "application/json" } }).then(r => {
      if (!r.ok) throw new EnclaveError("relays: HTTP " + r.status, r.status);
      return r.json();
    }).then(j => (j && j.relays) || []);
  },
  // What a RELAY saw of one deployment's traffic: a connection log, both
  // directions, with per-connection byte counts. Served by the relay's own
  // agent over the fleet tunnel (the hub answers for it at /t/<name>), because
  // a relay terminates no TLS and so has no HTTPS surface of its own.
  //
  // Connections, NOT requests, and callers must say so: a relay peeks SNI
  // without terminating TLS, so it never sees an HTTP request at all. One
  // connection carries many (h2 multiplexes), so counting these as requests
  // would undercount by a factor nothing here can know. Bandwidth is the
  // honest measure and comes free off the socket.
  // label -> { relay, a }: which relay actually carries each deployment right
  // now, INCLUDING the ones that made no choice (the fleet default resolves
  // here, not in the envelope). Asking a deployment's envelope alone would
  // miss every app that never picked one, which is most of them.
  getRelayLabels(){
    const url = (this.base || "").replace(/\/v1\/?$/, "") + "/v1/relays";
    return fetch(url, { headers: { "Accept": "application/json" } }).then(r => {
      if (!r.ok) throw new EnclaveError("relays: HTTP " + r.status, r.status);
      return r.json();
    }).then(j => (j && j.labels) || {});
  },
  getRelayTraffic(relay, dep, sinceMs){
    const root = (this.base || "").replace(/\/v1\/?$/, "");
    const q = "?dep=" + encodeURIComponent(dep) + (sinceMs ? "&since=" + encodeURIComponent(sinceMs) : "");
    const url = root + "/t/" + encodeURIComponent(relay) + "/v1/traffic" + q;
    return fetch(url, { headers: { "Accept": "application/json" } }).then(r => {
      if (!r.ok) throw new EnclaveError("traffic: HTTP " + r.status, r.status);
      return r.json();
    }).then(j => (j && Array.isArray(j.rows)) ? j : { rows: [], relay });
  },
  /* Deployments. List/get are PUBLIC ledger reads: a session token gives the
     enclaves' live view (status/network), but a connected wallet alone is
     enough - the relay scopes by ?owner= (on-chain records are public data;
     SIWE stays for what's actually private: logs, attestation, private apps). */
  createDeployment(body){ return this._req("POST", "/deployments", { auth: true, body }); },
  listDeployments(query){
    // a sticky session minted for another account would scope the fan-out AND
    // the ledger merge to THAT wallet - fall back to the public ?owner= read
    if (this.token && this._forWallet(this.token)) return this._req("GET", "/deployments", { auth: true, query });
    if (!this.address) throw new EnclaveError("Connect your wallet first.", 401);
    return this._req("GET", "/deployments", { query: { ...(query || {}), owner: this.address } });
  },
  getDeployment(id){
    const path = "/deployments/" + encodeURIComponent(id);
    if (this.token && this._forWallet(this.token)) return this._req("GET", path, { auth: true });
    return this._req("GET", path, { query: this.address ? { owner: this.address } : {} });
  },
  /* Trade this box's session for an app-origin one, so a PRIVATE deployment can
     be opened in a browser: a top-level navigation carries no Authorization
     header, so the enclave takes the same owner proof as a cookie instead. The
     token comes back audience-bound to this one deployment and opens no
     control-plane route, which is what makes it safe to hand to a page on the
     tenant's own origin. `enclave` names the box hosting it - sessions are
     per-box, and only the host can mint for its own deployments. */
  appToken(id, enclave){ return this._req("POST", "/deployments/" + encodeURIComponent(id) + "/app-token", { auth: true, enclave }); },
  /* `evacuate` = the owner is MOVING off this box: the enclave hands the lease
     back AND stands down from re-claiming it for a short window. Without it the
     source re-claims its own release within seconds (it still has the app
     staged) and the move never happens. */
  terminateDeployment(id, enclave, evacuate){ return this._req("DELETE", "/deployments/" + encodeURIComponent(id), { auth: true, enclave, query: evacuate ? { evacuate: 1 } : undefined }); },
  /* Nudge the fleet to claim funded work. `enclave` (a box NAME) makes the
     relay send the hint to THAT box only, giving it first crack — the steer
     behind both the deploy target pick and a move. An unknown name falls back
     to the full fan-out, so a hint can never strand a funded deployment. */
  claimHint(id, enclave){ return this._req("POST", "/claim-hint", { body: enclave ? { id, enclave } : { id } }); },
  restartDeployment(id, enclave){ return this._req("POST", "/deployments/" + encodeURIComponent(id) + "/restart", { auth: true, enclave }); },
  logs(id, query, enclave){ return this._req("GET", "/deployments/" + encodeURIComponent(id) + "/logs", { auth: true, query, enclave }); },
  attestation(id, enclave){ return this._req("GET", "/deployments/" + encodeURIComponent(id) + "/attestation", { auth: true, enclave }); },
  /* System (public) */
  health(){ return this._req("GET", "/health"); },
  version(){ return this._req("GET", "/version"); },
  /* Relay account (passkeys + SIWE; relay/auth.js). Bearer here is the
     ACCOUNT token, never the enclave session. */
  accountRegisterOptions(){ return this._req("POST", "/account/passkey/register/options", { body: {}, accountAuthOptional: true }); },
  accountRegisterVerify(challengeId, credential, label){ return this._req("POST", "/account/passkey/register/verify", { body: { challengeId, credential, label }, accountAuthOptional: true }); },
  accountLoginOptions(){ return this._req("POST", "/account/passkey/login/options", { body: {} }); },
  accountLoginVerify(challengeId, credential){ return this._req("POST", "/account/passkey/login/verify", { body: { challengeId, credential } }); },
  accountSiweNonce(address){ return this._req("GET", "/account/siwe/nonce", { query: { address } }); },
  accountSiweVerify(message, signature){ return this._req("POST", "/account/siwe/verify", { body: { message, signature } }); },
  accountLinkSiwe(message, signature){ return this._req("POST", "/account/link/siwe", { body: { message, signature }, accountAuth: true }); },
  accountMe(){ return this._req("GET", "/account/me", { accountAuth: true }); },
  /* Sign in with Enclave (relay sso.js): mint an audience-bound EST1 token
     naming the signed-in ACCOUNT - the passkey (or wallet) IS the identity,
     so nothing beyond the session travels. */
  ssoToken(aud, ttl){ return this._req("POST", "/sso/token", { body: { aud, ...(ttl ? { ttl } : {}) }, accountAuth: true }); },
  ssoSigner(){ return this._req("GET", "/sso/signer"); },
  /* Custom domains (public): hostname -> deployment id for every verified row */
  domainsMap(){ return this._req("GET", "/domains/map"); },
  // device flow: a passkey-less browser signs in via a phone (QR -> /link)
  accountDeviceStart(){ return this._req("POST", "/account/device/start", { body: {} }); },
  accountDeviceInfo(code){ return this._req("GET", "/account/device/info", { query: { code } }); },
  accountDeviceApprove(code, approve){ return this._req("POST", "/account/device/approve", { body: { code, approve }, accountAuth: true }); },
  accountDeviceClaim(code, secret){ return this._req("POST", "/account/device/claim", { body: { code, secret } }); },
  /* Orders + checkout (relay/billing.js) */
  createOrder(body){ return this._req("POST", "/billing/orders", { body, accountAuth: true }); },
  listOrders(){ return this._req("GET", "/billing/orders", { accountAuth: true }); },
  getOrder(id){ return this._req("GET", "/billing/orders/" + encodeURIComponent(id), { accountAuth: true }); },
  orderCheckout(id){ return this._req("POST", "/billing/orders/" + encodeURIComponent(id) + "/checkout", { body: {}, accountAuth: true }); },
  orderUsdc(id){ return this._req("GET", "/billing/orders/" + encodeURIComponent(id) + "/usdc", { accountAuth: true }); },
  accountDeployments(){ return this._req("GET", "/billing/deployments", { accountAuth: true }); },
  // credit vault: dollars in, runtime out - the passkey signs every spend
  billingVault(){ return this._req("GET", "/billing/vault", { accountAuth: true }); },
  billingTopup(amountUsd){ return this._req("POST", "/billing/topup", { body: { amountUsd }, accountAuth: true }); },
  vaultPrepare(body){ return this._req("POST", "/billing/vault/prepare", { body, accountAuth: true }); },
  vaultExec(body){ return this._req("POST", "/billing/vault/exec", { body, accountAuth: true }); }
};
