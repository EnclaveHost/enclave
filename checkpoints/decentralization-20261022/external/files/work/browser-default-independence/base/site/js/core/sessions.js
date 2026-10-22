/* ============================================================
   Wallet sessions in the browser (docs/design/sessions.md §9).

   Sign-in = open a session: the wallet signs ONE readable EIP-712
   grant (two with a starting budget: the grant + the matching USDC
   authorization), a fresh NON-extractable P-256 key goes into
   IndexedDB, and from then on platform actions are signed by that
   key and submitted by the relay - no wallet prompt per action.
   The relay account token is derived from the session (one more
   request the session key signs, no wallet prompt) and dies with it.

   Everything here goes through the shared SDK (sdk/sessions,
   vendored as /vendor/sessions.js, loaded on first use).
   ============================================================ */
import { Enclave, EnclaveError, WALLET_SESSION_KEY, INDEPENDENT_MODE } from "./api.js";
import { APP_CATALOG_RPCS, USDC_BASE, SESSION_FACTORY_ADDRESS, INDEPENDENT, DEPLOYMENTS_ADDRESS } from "./config.js";
import { $, esc, lsGet, lsSet, lsDel, showToast, emit } from "./util.js";
import { decodeLedgerCall, walletRecordPlan, needsCap } from "./ledger-calls.js";
import * as ID from "./identity.js";

/* id (sid) of this browser's active session: one pointer per identity - the wallet's (unchanged), or a passkey
   account's (independent mode, js/core/identity.js), so a session never serves another owner after a switch */
const activeKey = () => { const i = ID.currentIdentity(); return i.kind === "account" ? ID.accountSessionKey(INDEPENDENT.profile.chainId, i.safe) : WALLET_SESSION_KEY; };
let _sdk = null, _cfg = null, _cur = null;
let _st = null;                               // { sid, at, st }: the last status read (statusOf)

export async function sdk(){
  if (!_sdk) _sdk = import("/vendor/sessions.js").catch((e) => { _sdk = null; throw new EnclaveError("Could not load the sessions client: " + (e.message || e), 0); });
  return _sdk;
}
/** Tests only (test/site-session-auth.test.mjs): stand in for the vendored SDK, which Node cannot import. */
export function _useSdkForTests(mod){ _sdk = Promise.resolve(mod); _cur = null; _st = null; }

/** relay sessions config (chain, factory, relayer); null when this relay has sessions off */
export async function sessionsConfig(){
  if (_cfg) return _cfg;
  // independent mode: the profile's pinned SessionVaultFactory, no relay. Grants are opened, used and ended by
  // transactions the connected wallet submits (it pays the gas); the vault enforces scope, budget and revocation.
  if (INDEPENDENT_MODE){
    if (INDEPENDENT.state !== "on" || !SESSION_FACTORY_ADDRESS) return null;
    return (_cfg = { independent: true, chainId: INDEPENDENT.profile.chainId, factory: SESSION_FACTORY_ADDRESS,
      usdc: USDC_BASE, rpc: INDEPENDENT.profile.rpcs[0] });
  }
  try {
    const S = await sdk();
    _cfg = await new S.RelayClient(relayRoot()).config();
    return _cfg;
  } catch(e){
    if (e && (e.code === "sessions_disabled" || /503|sessions_disabled/.test(String(e.message)))) return null;
    throw e;
  }
}
export const sessionsAvailable = () => sessionsConfig().then((c) => !!c, () => false);

const rpcFor = (cfg) => (cfg && cfg.rpc) || APP_CATALOG_RPCS[0];
/* Enclave.base is the API root WITH /v1 (api.js); the sessions client wants the origin */
export const relayRoot = () => String(Enclave.base || "").replace(/\/v1\/?$/, "");
const store = async () => new (await sdk()).IndexedDbStore();

/** The active session of this browser: { session, record, owner } or null. */
export async function currentSession(){
  const key = activeKey(), id = lsGet(key);
  if (!id) return null;
  // a passkey account's session serves only that account, and only once the account verifies on this page
  const acct = ID.currentIdentity().kind === "account" ? ID.actingOwner(null) : null;
  if (ID.currentIdentity().kind === "account" && !acct) return null;
  if (_cur && _cur.record.id === id) return _cur;
  const S = await sdk();
  const rec = await (await store()).load(id).catch(() => null);
  if (!rec || !rec.handle){ lsSet(key, ""); return null; }
  if (acct && lower(rec.handle.owner) !== acct) return null;
  const session = await S.sessionFromRecord(rec);
  _cur = { session, record: rec, owner: rec.handle.owner };
  return _cur;
}

/** The account panel's sign-in opened `id` for passkey account `safe`: it becomes that account's session. */
export function setAccountSession(safe, id){
  lsSet(ID.accountSessionKey(INDEPENDENT.profile.chainId, safe), id);
  _cur = null; _st = null; Enclave._ownerSession = null;
  emit("enclave:session", { active: true });
}
/** The selected identity changed: forget the cached session and status (the pointer itself is per identity). */
export function identityChanged(){ _cur = null; _st = null; Enclave._ownerSession = null; }
try { globalThis.document?.addEventListener("enclave:identity", identityChanged); } catch {}

/** Live numbers for the header/popover: balance, spent, expiry, live. */
export async function sessionStatus(){
  const c = await currentSession();
  if (!c) return null;
  try {
    const st = await statusOf(c, true);
    return { ...st, owner: c.owner, vault: c.session.handle.vault, sid: c.session.handle.sid, label: c.record.label };
  } catch(e){ return { error: e.message, owner: c.owner }; }
}

const lower = (a) => String(a || "").toLowerCase();
const nowSec = () => Math.floor(Date.now() / 1000);
/* The session's on-chain status, cached briefly: owner calls (a log poll every 5 s) must not each cost a chain
   read. Every read also refreshes api.js's synchronous view (Enclave.sessionMayServe). */
async function statusOf(c, fresh = false){
  if (!fresh && _st && _st.sid === c.record.id && Date.now() - _st.at < 30_000) return _st.st;
  const st = await c.session.status();
  _st = { sid: c.record.id, at: Date.now(), st };
  Enclave._ownerSession = { sid: c.record.id, owner: lower(c.owner), live: Boolean(st.live), expiresAt: Number(st.expiresAt) };
  return st;
}
/* this browser's session is over (ended elsewhere, expired): forget it and say so */
function dropActive(){
  lsSet(activeKey(), ""); _cur = null; _st = null; Enclave._ownerSession = null;
  emit("enclave:session", { active: false });
}

/** The Authorization header for one owner call a HOST serves (api.js _sessionReq): `EnclaveSession v1 …` over
 *  the exact method, URL and body, or null when this browser's session can't make it - none, another wallet's,
 *  over, missing `scope`, or a URL that isn't the configured API endpoint (`Enclave.base`) of the relay the
 *  session was opened against. Never prompts. */
export async function hostAuthorization(method, url, body, scope){
  if (INDEPENDENT_MODE) return null;            // host calls ride the API, which independent mode does not use
  if (!Enclave.address || !lsGet(activeKey())) return null;
  const base = String(Enclave.base || "").replace(/\/+$/, "");
  if (!base || !String(url).startsWith(base + "/")) return null;
  const c = await currentSession().catch(() => null);
  if (!c || lower(c.owner) !== lower(Enclave.address)) return null;
  const opened = String(c.record.relay || (c.session.handle && c.session.handle.relay) || "").replace(/\/+$/, "");
  if (opened && opened !== relayRoot().replace(/\/+$/, "")) return null;
  const st = await statusOf(c).catch(() => null);
  if (!st || !st.live || Number(st.expiresAt) <= nowSec()) return null;
  if (scope){
    const bit = (await sdk()).ACTIONS[scope];
    if (bit == null || ((BigInt(st.actions) >> BigInt(bit)) & 1n) !== 1n) return null;
  }
  return c.session.apiAuthorization(method, url, body === undefined ? "" : body);
}

/** After a host answered 401 to a session-signed call: is the session still live on the chain? (true = the host
 *  hasn't learned sessions yet.) A session that is over is forgotten here. Unreadable = assume live. */
export async function sessionStillLive(){
  const c = await currentSession().catch(() => null);
  if (!c) return false;
  let st;
  try { st = await statusOf(c, true); } catch(e){ return true; }
  if (st.live && Number(st.expiresAt) > nowSec()) return true;
  dropActive();
  return false;
}

function browserLabel(){
  const ua = navigator.userAgent || "";
  const b = /firefox/i.test(ua) ? "Firefox" : /edg/i.test(ua) ? "Edge" : /chrom/i.test(ua) ? "Chrome" : /safari/i.test(ua) ? "Safari" : "Browser";
  const o = /windows/i.test(ua) ? "Windows" : /android/i.test(ua) ? "Android" : /iphone|ipad/i.test(ua) ? "iOS" : /mac os/i.test(ua) ? "macOS" : /linux/i.test(ua) ? "Linux" : "";
  return ("Browser · " + b + (o ? " on " + o : "")).slice(0, 60);
}

/** Open a session for the connected wallet. budgetUsd may be 0 (the default). */
export async function startSession({ budgetUsd = 0, hours = 12 } = {}){
  // a passkey account that pays its own gas through its bundler needs no wallet; otherwise a wallet submits (and pays gas)
  if (INDEPENDENT_MODE && accountIdentity() && ID.identityProfile() && (await import("./account-transport.js")).gasChoice(ID.identityProfile()) === "account")
    return startAccountSession({ budgetUsd, hours });
  if (!Enclave.provider || !Enclave.address) throw new EnclaveError("Connect a wallet first (it pays the gas), or let your passkey account pay its own gas (Passkey account → Gas).", 0);
  if (INDEPENDENT_MODE && accountIdentity()) return startAccountSession({ budgetUsd, hours });
  if (INDEPENDENT_MODE) return startDirectSession({ budgetUsd, hours });
  const cfg = await sessionsConfig();
  if (!cfg) throw new EnclaveError("Sessions are not available on this API endpoint.", 503);
  const S = await sdk();
  const st = await store();
  const label = browserLabel();
  const { signer, record } = await S.newSessionKey(st, { relay: relayRoot(), chainId: cfg.chainId, label, extractable: false });
  const budget = BigInt(Math.round(Number(budgetUsd || 0) * 1e6));
  const grant = S.buildGrant({ sessionKey: signer.keyHash, label, preset: "browser",
    policy: { budget, expiresIn: Math.round(hours * 3600) }, signWithin: 900 });
  const relay = new S.RelayClient(relayRoot());
  const info = await relay.request("GET", "/owner/" + Enclave.address);
  const pc = S.chainClient(cfg.chainId, rpcFor(cfg));
  const usdc = budget > 0n ? await S.usdcDomain(pc, cfg.usdc || USDC_BASE, cfg.chainId) : undefined;
  const owner = S.ownerFromProvider(Enclave.provider, Enclave.address);
  try {
    await S.openSession({ relay, owner, chainId: cfg.chainId, vault: info.vault, grant, usdc });
  } catch(e){
    await st.remove(record.id).catch(() => {});
    throw signError(e, "open a session");
  }
  const rec = await S.completeSession(st, record, { vault: info.vault, owner: Enclave.address, grant, rpc: rpcFor(cfg) });
  lsSet(WALLET_SESSION_KEY, rec.id);
  _cur = null; _st = null; Enclave._ownerSession = null;
  await accountFromSession().catch(() => {});      // relay account token, derived from the session
  emit("enclave:session", { active: true });
  return currentSession();
}

/** Exchange the session for a relay account token (no wallet prompt). */
export async function accountFromSession(){
  if (INDEPENDENT_MODE) return null;
  const c = await currentSession();
  if (!c) return null;
  const url = relayRoot() + "/v1/account/session-login";
  const auth = await c.session.apiAuthorization("POST", url, "");
  const r = await fetch(url, { method: "POST", headers: { Authorization: auth } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new EnclaveError(j.message || ("session login failed (" + r.status + ")"), r.status);
  const { adoptAccountSession } = await import("./account.js");
  return adoptAccountSession(j);
}

/** Sign out: the session key ends its own session, the budget comes back, the account token dies with it. */
export async function endSession({ quiet = false } = {}){
  const c = await currentSession().catch(() => null);
  lsSet(activeKey(), "");
  _cur = null; _st = null; Enclave._ownerSession = null;
  if (!c) return null;
  let out = null;
  if (INDEPENDENT_MODE){
    // the session key signs its own end; the wallet submits it and the unspent budget returns to the owner
    try {
      const prep = await c.session.prepareTermination();
      const hash = await submitPrepared(prep);
      out = { txHash: hash, refund6: null };
    } catch(e){ if (!quiet) showToast("Could not end the session on-chain (" + (e.message || e) + ")."); }
    try { await (await store()).remove(c.record.id); } catch(e){}
    emit("enclave:session", { active: false });
    if (out && !quiet) showToast("Signed out. The session’s unspent budget returned to " + (ID.currentIdentity().kind === "account" ? "your passkey account." : "your wallet."));
    return out;
  }
  try { out = await c.session.terminate(); }
  catch(e){ if (!quiet) showToast("Could not end the session on-chain (" + (e.message || e) + "). Terminate it from Sessions with your wallet."); }
  try { await (await store()).remove(c.record.id); } catch(e){}
  if (Enclave.accountMethod === "session") Enclave.clearAccountSession();
  emit("enclave:session", { active: false });
  if (out && !quiet) showToast("Signed out. " + fmtUsd(out.refund6) + " returned to your wallet.");
  return out;
}

export async function topUpSession(amountUsd){
  if (INDEPENDENT_MODE) return independentTopUp(amountUsd);
  const c = await currentSession();
  if (!c) throw new EnclaveError("No active session.", 0);
  if (!Enclave.provider) throw new EnclaveError("Connect the wallet that owns this session to top it up.", 0);
  const cfg = await sessionsConfig();
  const S = await sdk();
  const usdc = await S.usdcDomain(S.chainClient(cfg.chainId, rpcFor(cfg)), cfg.usdc || USDC_BASE, cfg.chainId);
  const amount = BigInt(Math.round(Number(amountUsd) * 1e6));
  try {
    await S.topUpFromWallet({ relay: new S.RelayClient(relayRoot()), owner: S.ownerFromProvider(Enclave.provider, Enclave.address),
      chainId: cfg.chainId, vault: c.session.handle.vault, sessionId: c.session.handle.sid, amount, usdc });
  } catch(e){ throw signError(e, "top up"); }
  emit("enclave:session", { active: true });
}

/** An owner operation on this wallet's vault (gasless typed data): terminate, revokeAll, promote, ... */
export async function ownerOp(op){
  if (INDEPENDENT_MODE) return independentOwnerOp(op);
  if (!Enclave.provider) throw new EnclaveError("Connect your wallet first.", 0);
  const cfg = await sessionsConfig();
  const S = await sdk();
  const relay = new S.RelayClient(relayRoot());
  const info = await relay.request("GET", "/owner/" + Enclave.address);
  try {
    return await S.ownerOperation({ relay, owner: S.ownerFromProvider(Enclave.provider, Enclave.address),
      chainId: cfg.chainId, vault: info.vault, op });
  } catch(e){ throw signError(e, "sign that"); }
}

/** Run one session action. Budget/expiry problems become prompts, never silent failures. */
export async function sessionCall(action, args){
  const c = await currentSession();
  if (!c) throw new EnclaveError("Start a session first (Sign in → session).", 0);
  try {
    // independent mode: the session key signs a zero-fee intent and the connected wallet submits it
    const r = INDEPENDENT_MODE ? { txHash: await submitPrepared(await c.session.prepareCall(action, args)) } : await c.session.call(action, args);
    emit("enclave:session", { active: true });
    return r;
  } catch(e){
    if (e && (e.code === "budget" || e.code === "period")) {
      const need = e.detail && e.detail.need;
      const ok = await promptTopUp(need, e.code === "period");
      if (ok) return sessionCall(action, args);
    } else if (e && (e.code === "expired" || e.code === "not_live")) {
      dropActive();
      throw new EnclaveError("Your session " + (e.code === "expired" ? "expired" : "ended") + ". Sign in again to continue.", 401);
    }
    const err = new EnclaveError(friendly(e), 0);
    err.sessionCode = err.message === DELEGATION_TEXT ? "delegation" : e && e.code;
    throw err;
  }
}

// the vault's price refusals, by error: each says what actually unblocks it
const PRICE_TEXT = {
  LeaseUnsettled: "A host still holds this deployment's lease. Stop it, wait for the host to release it, then resize or re-price it.",
  FundRateTooLow: "This deployment's current lease is priced so a top-up wouldn't buy runtime. Wait for the lease to end (or stop and restart the app), then top up.",
  RateCapOutOfRange: "That price is outside what this session may pay or set.",
};

// the ledger's owner gate (Error("!owner")) on a record the WALLET holds: the owner hasn't let its vault act for it
const DELEGATION_TEXT = "Your sessions can't manage the apps your wallet owns: your wallet hasn't allowed it, or took it back. "
  + "Allow it on the Sessions page (one wallet transaction), or make this change with your wallet.";

function friendly(e){
  const m = (e && e.message) || String(e);
  if (!e || !e.code) return m;
  if (e.code === "delegation" || (e.code === "revert" && /!owner\b/.test(m))) return DELEGATION_TEXT;
  if (e.code === "price") return PRICE_TEXT[e.detail && e.detail.error] || PRICE_TEXT.RateCapOutOfRange;
  return ({ not_allowed: "This session isn't allowed to do that.", env: "That's a production change - it needs your wallet (promotion).",
    app: "That app isn't covered by this session.", fee: "The relay's fee is above this session's limit right now; try again shortly.",
    rate: "Too many actions in a short time; wait a moment.", relay: "The relay couldn't submit that: " + m })[e.code] || m;
}

function signError(e, what){
  const m = (e && (e.message || e.shortMessage)) || String(e);
  if ((e && e.code === 4001) || /reject|denied|declin|cancel/i.test(m)) return new EnclaveError("Signature rejected.", 0);
  return new EnclaveError("Could not " + what + ": " + m, 0);
}

export const fmtUsd = (v6) => { const n = Number(v6 || 0) / 1e6; return n !== 0 && n < 0.01 ? "$" + n.toFixed(4) : "$" + n.toFixed(2); };
export const fmtLeft = (sec) => sec <= 0 ? "expired" : sec >= 86400 ? Math.floor(sec / 86400) + "d " + Math.floor((sec % 86400) / 3600) + "h"
  : sec >= 3600 ? Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m" : Math.max(1, Math.floor(sec / 60)) + "m";

/* ---- modals (the site's shared #walletPick shell: wallet.js fundModal) ---- */

/** Render a modal and return once it is ON SCREEN: { result } settles with the
 *  outcome (true / false when dismissed). Callers wire their buttons after the await. */
async function overlay(html){
  const { fundModal } = await import("./wallet.js");
  let settle;
  const result = new Promise((r) => { settle = r; });
  const m = fundModal(html);   // fundModal draws the card; a second .wp-card here nested a box in a box
  if (!m){ settle(null); return { result }; }
  const { host, close } = m;
  let settled = false;
  // fundModal's own backdrop / Escape / .wp-cancel close the shell: that is a "no"
  const obs = new MutationObserver(() => { if (host.hidden && !settled){ settled = true; obs.disconnect(); settle(false); } });
  obs.observe(host, { attributes: true, attributeFilter: ["hidden"] });
  host._done = (v) => { if (settled) return; settled = true; obs.disconnect(); close(); settle(v); };
  return { result };
}
const hostEl = () => $("#walletPick");

/** The sign-in session chooser: starting budget (default $0) and duration. Resolves true when a session opened. */
export async function openSessionModal(){
  const acct = INDEPENDENT_MODE && accountIdentity();
  const { result } = await overlay(
    '<div class="wp-h">Start a session</div>' +
    '<div class="wp-note">' + (acct ? 'One passkey approval lets this browser deploy, fund and manage your account’s deployments without a prompt each time. '
      : 'One signature lets this browser deploy, fund and manage your deployments without a wallet prompt each time. ') +
    'It can never withdraw, promote to production or touch secrets, and it ends when you sign out or when it expires.</div>' +
    '<label class="wp-note" for="smBudget">Starting budget in USD (optional)</label>' +
    '<input id="smBudget" class="ac-in" inputmode="decimal" value="0" autocomplete="off" />' +
    '<label class="wp-note" for="smHours">Lasts</label>' +
    '<select id="smHours" class="ac-in"><option value="1">1 hour</option><option value="12" selected>12 hours</option>' +
    '<option value="168">7 days</option><option value="720">30 days</option></select>' +
    '<div class="wp-note">' + (acct ? 'Your passkey account approves the session (and the budget, from the account’s USDC). Your connected wallet only sends the transactions and pays gas. '
      : INDEPENDENT_MODE ? 'Your wallet signs the session (and the USDC, with a budget), then sends one transaction. Each later action is also sent by your wallet. ' : 'With a budget your wallet asks twice: once for the session, once for the USDC. ')
      + 'Unspent budget comes back ' + (acct ? 'to your account ' : '') + 'when the session ends.</div>' +
    '<button class="wp-item wp-go" id="smGo" type="button">' + (acct ? 'Approve with passkey' : 'Sign with wallet') + '</button>' +
    '<div class="wp-err" id="smErr" role="alert" hidden></div>' +
    '<button class="wp-cancel" type="button">Not now</button>');
  const go = $("#smGo");
  if (go) go.addEventListener("click", async () => {
    go.disabled = true; go.textContent = acct ? "Approve with your passkey…" : "Check your wallet…";
    try {
      const budgetUsd = Math.max(0, Number(($("#smBudget").value || "0").replace(/[^0-9.]/g, "")) || 0);
      await startSession({ budgetUsd, hours: Number($("#smHours").value) });
      hostEl()._done(true);
      showToast("Session started.");
    } catch(e){
      const er = $("#smErr"); if (er){ er.hidden = false; er.textContent = e.message || String(e); }
      go.disabled = false; go.textContent = acct ? "Approve with passkey" : "Sign with wallet";
    }
  });
  return result;
}

/** Budget ran out mid-action: offer a top-up (one wallet signature). Resolves true when topped up. */
export async function promptTopUp(need6, periodLimited){
  if (periodLimited){
    showToast("This session reached its spending limit for today. Start a new session for more, or try again tomorrow.");
    return false;
  }
  return openTopUpModal(Math.max(5, Math.ceil(Number(need6 || 0) / 1e6) + 1),
    need6 ? "That needs " + fmtUsd(need6) + " and this session doesn't hold enough. " : "");
}

/** Extend a live session: pick how much time to add (to its current end, or to now if that has passed), then one
 *  owner signature, relayed gas-free. Resolves true once extended. */
export async function openExtendModal(sessionId, expiresAt){
  const opts = [[1, "1 hour"], [12, "12 hours"], [24, "1 day"], [168, "7 days"], [720, "30 days"]];
  const base = () => Math.max(Number(expiresAt) || 0, nowSec());
  const { result } = await overlay(
    '<div class="wp-h">Extend this session</div>' +
    '<label class="wp-note" for="exHours">Add</label>' +
    '<select id="exHours" class="ac-in">' + opts.map(([h, l]) => '<option value="' + h + '"' + (h === 168 ? " selected" : "") + ">" + l + "</option>").join("") + "</select>" +
    '<div class="wp-note" id="exUntil"></div>' +
    '<div class="wp-note">' + (INDEPENDENT_MODE ? 'Your wallet sends one transaction to your session vault.' : 'One signature with your wallet, no gas.') + '</div>' +
    '<button class="wp-item wp-go" id="exGo" type="button">Extend</button>' +
    '<div class="wp-err" id="exErr" role="alert" hidden></div>' +
    '<button class="wp-cancel" type="button">Cancel</button>');
  const sel = $("#exHours"), until = $("#exUntil"), go = $("#exGo");
  const show = () => { if (until && sel) until.textContent = "Ends " + new Date((base() + Number(sel.value) * 3600) * 1000)
    .toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) + "."; };
  if (sel) sel.addEventListener("change", show);
  show();
  if (go) go.addEventListener("click", async () => {
    go.disabled = true; go.textContent = "Check your wallet…";
    try {
      await ownerOp({ op: "extend", sessionId, expiresAt: BigInt(base() + Number(sel.value) * 3600) });
      hostEl()._done(true);
      showToast("Extended by " + sel.options[sel.selectedIndex].text + ".");
    } catch(e){ const er = $("#exErr"); if (er){ er.hidden = false; er.textContent = e.message || String(e); } go.disabled = false; go.textContent = "Extend"; }
  });
  return result;
}

export async function openTopUpModal(suggestUsd = 10, why = ""){
  const { result } = await overlay(
    '<div class="wp-h">Top up this session</div>' +
    '<div class="wp-note">' + esc(why) + (INDEPENDENT_MODE && accountIdentity() ? 'Add USDC from your passkey account: one passkey approval, then your connected wallet sends one transaction (gas only).'
      : INDEPENDENT_MODE ? 'Add USDC from your wallet: one signature for the USDC, then your wallet sends one transaction.' : 'Add USDC from your wallet: one signature, no gas.') + '</div>' +
    '<label class="wp-note" for="tuAmt">Amount in USD</label>' +
    '<input id="tuAmt" class="ac-in" inputmode="decimal" value="' + esc(String(suggestUsd)) + '" autocomplete="off" />' +
    '<button class="wp-item wp-go" id="tuGo" type="button">Top up</button>' +
    '<div class="wp-err" id="tuErr" role="alert" hidden></div>' +
    '<button class="wp-cancel" type="button">Cancel</button>');
  const go = $("#tuGo");
  if (go) go.addEventListener("click", async () => {
    go.disabled = true; go.textContent = "Check your wallet…";
    try { await topUpSession(Number($("#tuAmt").value)); hostEl()._done(true); showToast("Session topped up."); }
    catch(e){ const er = $("#tuErr"); if (er){ er.hidden = false; er.textContent = e.message; } go.disabled = false; go.textContent = "Top up"; }
  });
  return result;
}

/* ---- the deployments panel: rows the vault holds, and their actions ---------------------------------
   A row the wallet's SessionVault holds is acted on by this browser's session: the ledger call the panel
   built is decoded and replayed as the matching session action; a PRODUCTION version/config change becomes
   the owner's Promote signature. A wallet-held row keeps its wallet transaction, byte for byte - unless the
   wallet has let its vault act for it on the ledger (below): then suspend/resume, resize, cancel and a lower
   price limit go through the session too, and everything else stays the wallet's. */

const _vaults = new Map();   // address -> { vault, deployed, held, at }
export async function vaultOf(address, fresh = false){
  if (INDEPENDENT_MODE){
    const vault = await independentVaultOf(address);
    return { vault, deployed: !!vault, held: [], at: Date.now() };
  }
  const k = String(address || "").toLowerCase();
  const c = _vaults.get(k);
  if (c && !fresh && Date.now() - c.at < 60_000) return c;
  const S = await sdk();
  const info = await new S.RelayClient(relayRoot()).request("GET", "/owner/" + address);
  const rec = { vault: info.vault, deployed: info.deployed, held: info.held || [], at: Date.now() };
  _vaults.set(k, rec);
  return rec;
}

/** Ledger rows held by the connected wallet's vault (empty when sessions are off or there is no vault yet). */
export async function vaultRows(){
  if (INDEPENDENT_MODE) return [];             // independent listing already includes the vault's rows (api.js)
  if (!Enclave.address || !(await sessionsConfig().catch(() => null))) return [];
  const v = await vaultOf(Enclave.address).catch(() => null);
  if (!v || !v.deployed) return [];
  const res = await Enclave._req("GET", "/deployments", { query: { owner: v.vault } });
  const list = Array.isArray(res) ? res : ((res && (res.deployments || res.items || res.data)) || []);
  return list.map((d) => ({ ...d, _sessionVault: v.vault }));
}

const BOOK_ABI = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];
const bookKey = (s) => "0x" + Array.from(new TextEncoder().encode(s), (x) => x.toString(16).padStart(2, "0")).join("").padEnd(64, "0");
/** An address-book entry ("deployments", "appCatalog"): what the vault resolves on every call. */
const bookAddr = (pc, book, name) => pc.readContract({ address: book, abi: BOOK_ABI, functionName: "addr", args: [bookKey(name)] });

async function ledgerOwner(id){
  const cfg = await sessionsConfig();
  const S = await sdk();
  const pc = S.chainClient(cfg.chainId, rpcFor(cfg));
  const ledger = await bookAddr(pc, cfg.book, "deployments");
  const catalog = await bookAddr(pc, cfg.book, "appCatalog");
  const D = [["id","bytes32"],["owner","address"],["appRef","string"],["ports","string"],["configCid","string"],["gpuMilli","uint16"],["cpuMilli","uint16"],
    ["appPort","uint32"],["isPublic","bool"],["active","bool"],["createdAt","uint64"],["rate","uint256"],["balance6","uint256"],["spent6","uint256"],
    ["runner","bytes32"],["runnerOperator","address"],["leaseUntil","uint64"]].map(([name, type]) => ({ name, type }));
  const row = await pc.readContract({ address: ledger, abi: [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [{ type: "tuple", components: D }] }], functionName: "get", args: [id] });
  return { row, pc, catalog, ledger, S };
}

/** The app slug, its publisher and the version label a Promote shows on the owner's device (the vault
 *  re-checks all three: slugs are unique only per publisher, so the publisher is what names the code). */
export async function versionLabel(pc, catalog, appRef){
  const m = /^catalog:\/\/(0x[0-9a-f]{64})\/(0|[1-9]\d*)$/.exec(appRef || "");
  if (!m) throw new EnclaveError("A production version must be a catalog record.", 0);
  const v = await pc.readContract({ address: catalog, abi: [{ type: "function", name: "getVersion", stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "uint256" }], outputs: [{ type: "tuple", components: [{ name: "cid", type: "string" }, { name: "version", type: "string" }] }] }],
    functionName: "getVersion", args: [m[1], BigInt(m[2])] });
  const a = await pc.readContract({ address: catalog, abi: [{ type: "function", name: "getApp", stateMutability: "view",
    inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [{ name: "appId", type: "bytes32" }, { name: "publisher", type: "address" },
      { name: "slug", type: "string" }] }] }], functionName: "getApp", args: [m[1]] });
  return { label: v.version, app: a.slug, publisher: a.publisher };
}

/* ---- records the WALLET holds: the owner's ledger delegation to its vault ------------------------------
   The ledger revision production deploys (rev 15d) lets an owner name delegates: setDelegate(vault, true),
   one wallet transaction, lets this wallet's vault act on every record the wallet holds - and the vault
   treats those as PRODUCTION (suspend/resume, resize, fund, lower the cap, cancel to the wallet; never the
   version or config, never a transfer). A ledger without setDelegate reads as unsupported. */

const DECLINED = "enclave_delegate_declined:";   // + ledger:owner - the owner said no; asked once per browser
const declinedKey = (ledger, owner) => DECLINED + String(ledger).toLowerCase() + ":" + String(owner).toLowerCase();

/** The book's ledger, this wallet's vault and whether the wallet has let the vault act for it there:
 *  { ledger, vault, owner, supported, granted }, or null when sessions are off or no wallet is connected. */
export async function walletDelegation(address = Enclave.address, fresh = false){
  const cfg = address ? await sessionsConfig() : null;
  if (!cfg) return null;
  const S = await sdk();
  const pc = S.chainClient(cfg.chainId, rpcFor(cfg));
  // independent mode: the profile's pinned ledger and the vault the pinned factory names at an agreed block (no address
  // book); the status is a display read - the host's gateway re-reads the delegation itself before it acts
  const ledger = INDEPENDENT_MODE ? DEPLOYMENTS_ADDRESS : await bookAddr(pc, cfg.book, "deployments");
  const v = await vaultOf(address, fresh);
  if (!v.vault) return { supported: false, granted: false, ledger, vault: null, owner: address, noVault: true };
  const st = await S.delegationStatus(pc, ledger, address, v.vault);
  return { ...st, ledger, vault: v.vault, owner: address };
}

/** One WALLET transaction to the ledger: let this wallet's vault act on the records the wallet holds
 *  (`allowed`), or take that back. Resolves once the chain reads the new state. */
export async function setWalletDelegation(allowed, { onSent } = {}){
  if (!Enclave.provider || !Enclave.address) throw new EnclaveError("Connect your wallet first.", 0);
  const d = await walletDelegation(Enclave.address, true);
  if (d && d.noVault) throw new EnclaveError("Start a wallet session first: its vault is what the ledger would let act for you.", 0);
  if (!d || !d.supported) throw new EnclaveError("This ledger can't let sessions manage the apps your wallet owns yet.", 0);
  const S = await sdk();
  const { sendTx } = await import("./wallet.js");
  const { waitReceipt } = await import("./chain.js");
  let hash;
  try { hash = await sendTx(d.ledger, S.setDelegateCall(d.vault, Boolean(allowed)).data); }
  catch(e){ throw signError(e, allowed ? "allow it" : "revoke it"); }
  if (onSent) onSent(hash);
  await waitReceipt(hash);
  // a revoke is also a "no" to the panel's offer; a grant clears an earlier one
  if (allowed) lsDel(declinedKey(d.ledger, d.owner)); else lsSet(declinedKey(d.ledger, d.owner), "1");
  // the relay (and its RPC) must see it before a session relies on it: wait until the chain reads it back
  const cfg = await sessionsConfig();
  const pc = S.chainClient(cfg.chainId, rpcFor(cfg));
  for (let i = 0; i < 20; i++){
    const st = await S.delegationStatus(pc, d.ledger, d.owner, d.vault).catch(() => null);
    if (st && st.granted === Boolean(allowed)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  emit("enclave:session", { active: true });
  return hash;
}

/** Ask once per browser: let sessions manage the apps this wallet owns? Resolves true once granted on-chain,
 *  false when the owner says no (remembered), null when no prompt could be shown. */
export async function askWalletDelegation(d){
  const { result } = await overlay(
    '<div class="wp-h">Apps your wallet owns</div>' +
    '<div class="wp-note"><b>Let your sessions manage the apps your wallet owns?</b> One wallet transaction. ' +
    'You can revoke it on the Sessions page.</div>' +
    '<div class="wp-note">Sessions could then suspend, resume, resize, cancel (refunds go to your wallet) and lower the price ' +
    'limit of those apps without a wallet prompt each time. They can never change the version or options an app runs, ' +
    'raise its price limit, or move it out of your wallet.</div>' +
    '<button class="wp-item wp-go" id="dgGo" type="button">Allow (one wallet transaction)</button>' +
    '<div class="wp-err" id="dgErr" role="alert" hidden></div>' +
    '<button class="wp-cancel" type="button">Not now - use my wallet for this</button>');
  const go = $("#dgGo");
  if (go) go.addEventListener("click", async () => {
    go.disabled = true; go.textContent = "Check your wallet…";
    try {
      await setWalletDelegation(true, { onSent: () => { go.textContent = "Waiting for the transaction…"; } });
      hostEl()._done(true);
      showToast("Your sessions can now manage the apps your wallet owns.");
    }
    catch(e){ const er = $("#dgErr"); if (er){ er.hidden = false; er.textContent = e.message || String(e); } go.disabled = false; go.textContent = "Allow (one wallet transaction)"; }
  });
  const ok = await result;
  if (ok === false) lsSet(declinedKey(d.ledger, d.owner), "1");
  return ok;
}

/** A ledger call on a record the connected wallet holds: through the session when the delegation allows it
 *  (asking for it once), else the unchanged wallet transaction. Any unreadable state means the wallet. */
async function walletRecordSend(call, pc, ledger, v, walletSend){
  const me = String(Enclave.address).toLowerCase();
  let plan, justGranted = false;
  try {
    const S = await sdk();
    const cap = needsCap(call) ? await pc.readContract({ address: ledger, abi: [{ type: "function", name: "capOf", stateMutability: "view",
      inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] }], functionName: "capOf", args: [call.id] }) : null;
    plan = walletRecordPlan(call, cap);
    if (!plan) return walletSend();
    // a live session of THIS wallet's vault that covers production, holds every action and can pay a relay fee
    const c = await currentSession();
    if (!c || String(c.owner).toLowerCase() !== me || String(c.session.handle.vault).toLowerCase() !== String(v.vault).toLowerCase()) return walletSend();
    const st = await c.session.status();
    const has = (a) => ((BigInt(st.actions) >> BigInt(S.ACTIONS[a])) & 1n) === 1n;
    if (!st.live || (Number(st.envs) & 2) === 0 || !plan.every((p) => has(p.action)) || S.spendable(st) === 0n) return walletSend();
    const d = await S.delegationStatus(pc, ledger, Enclave.address, v.vault);
    if (!d.supported) return walletSend();
    if (!d.granted){
      if (lsGet(declinedKey(ledger, me))) return walletSend();
      if ((await askWalletDelegation({ ledger, owner: me, vault: v.vault })) !== true) return walletSend();
      justGranted = true;
    }
  } catch(e){
    return walletSend();
  }
  let last = null;
  for (let i = 0; i < plan.length; i++){
    try { last = await sessionCall(plan[i].action, plan[i].args); }
    catch(e){
      // a node a block behind a grant made seconds ago may still refuse the first call: once more, a moment later
      if (i !== 0 || !justGranted || e.sessionCode !== "delegation") throw e;
      await new Promise((r) => setTimeout(r, 3000));
      last = await sessionCall(plan[i].action, plan[i].args);
    }
  }
  return last && last.txHash;
}

/** Send one ledger call: via the session for a vault-held row, or for a row the wallet holds once the wallet has
 *  let its vault act for it; else `walletSend()` (the unchanged wallet tx). */
export async function ledgerSend(data, walletSend){
  const call = decodeLedgerCall(data);
  if (INDEPENDENT_MODE) return independentLedgerSend(call, walletSend, data);
  if (!call.id || call.fn === "unknown" || !(await sessionsConfig().catch(() => null))) return walletSend();
  const { row, pc, catalog, ledger } = await ledgerOwner(call.id);
  const v = Enclave.address ? await vaultOf(Enclave.address).catch(() => null) : null;
  if (v && String(row.owner).toLowerCase() === String(Enclave.address).toLowerCase())
    return walletRecordSend(call, pc, ledger, v, walletSend);
  if (!v || String(row.owner).toLowerCase() !== String(v.vault).toLowerCase()) return walletSend();
  const held = (await vaultOf(Enclave.address, true)).held.find((h) => String(h.id).toLowerCase() === call.id.toLowerCase());
  const env = held ? held.env : 0;
  if (env === 0) throw new EnclaveError("This deployment is in your vault but not adopted yet. Adopt it on Sessions first.", 0);
  const calls = call.fn === "multicall" ? call.calls : [call];
  // production: version/config changes are ONE owner Promote signature covering both
  const ref = calls.find((c) => c.fn === "setAppRef"), cfgc = calls.find((c) => c.fn === "setConfig");
  let last = null;
  if (env === 2 && (ref || cfgc)){
    const appRef = ref ? ref.appRef : row.appRef, configCid = cfgc ? cfgc.configCid : row.configCid;
    const { label, app, publisher } = await versionLabel(pc, catalog, appRef);
    last = await ownerOp({ op: "promote", deployment: call.id, app, publisher, appRef, configCid, versionLabel: label,
      isPublic: Boolean(row.isPublic) });
  }
  for (const c of calls){
    if (env === 2 && (c.fn === "setAppRef" || c.fn === "setConfig")) continue;
    if (c.fn === "transferDeployment") throw new EnclaveError("Transfers out of your vault are an owner action: use Sessions → release.", 0);
    const action = { setActive: "deploy.setActive", setShares: "deploy.setShares", setMaxRate: "deploy.setMaxRate", refund: "deploy.refund",
      setAppRef: "deploy.setAppRef", setConfig: "deploy.setConfig" }[c.fn];
    if (!action) throw new EnclaveError("That change isn't available through a session.", 0);
    const { fn, ...args } = c;
    last = await sessionCall(action, args);
  }
  return last && last.txHash;
}

/* ============================================================
   Independent mode (js/core/independent.js): sessions on the profile's
   pinned SessionVaultFactory with no relay. The SDK prepares portable
   calldata (prepareSessionOpen / prepareCall / prepareTermination); the
   connected wallet submits it and pays the gas. The vault - not this page -
   enforces scope, budget, expiry and revocation. Hosted conveniences
   (gasless relaying, owner Promote/top-up operations, the relay account
   token) are not used.
   ============================================================ */
async function submitPrepared(prep){
  if (prep.chainId !== INDEPENDENT.profile.chainId) throw new EnclaveError("prepared call is for another chain", 0);
  // a passkey account identity whose owner chose to pay gas from the account itself: its own bundler, no wallet
  if (INDEPENDENT_MODE && accountIdentity() && (await accountGasMode()) === "account")
    return sendThroughAccount({ to: prep.to, value: BigInt(prep.value || 0n), data: prep.data, what: prep.fn || "the prepared call" });
  const { sendTx } = await import("./wallet.js");
  const { waitReceipt } = await import("./chain.js");
  const hash = await sendTx(prep.to, prep.data, "0x0");
  await waitReceipt(hash);
  return hash;
}

/* The wallet's vault on the pinned factory when it exists (read at an agreed block), else null. */
export async function independentVaultOf(address){
  if (!INDEPENDENT_MODE || INDEPENDENT.state !== "on" || !SESSION_FACTORY_ADDRESS || !address) return null;
  const IC = await import("./independent-chain.js");
  const vault = await IC.agreedVaultFor(SESSION_FACTORY_ADDRESS, address);
  if (!vault || /^0x0{40}$/.test(vault)) return null;
  const r = IC.reader(), snap = await r.snapshot();
  const code = await r.code(snap, vault);
  return code && code !== "0x" ? vault.toLowerCase() : null;
}

async function startDirectSession({ budgetUsd, hours }){
  if (ID.currentIdentity().kind === "account")
    throw new EnclaveError("Your dashboard identity is a passkey account: sign in from its panel (its passkeys approve the session), or switch to your wallet identity first.", 0);
  const cfg = await sessionsConfig();
  if (!cfg) throw new EnclaveError("Wallet sessions are off: the network profile pins no session factory.", 0);
  const S = await sdk(), st = await store(), label = browserLabel();
  const { signer, record } = await S.newSessionKey(st, { relay: "", chainId: cfg.chainId, label, extractable: false });
  const budget = BigInt(Math.round(Number(budgetUsd || 0) * 1e6));
  const grant = S.buildGrant({ sessionKey: signer.keyHash, label, preset: "browser",
    policy: { budget, expiresIn: Math.round(hours * 3600) }, signWithin: 900 });
  const pc = S.chainClient(cfg.chainId, cfg.rpc);
  // the vault this grant is for, read at a block the profile's RPCs agree on - before anything is submitted
  const { agreedVaultFor } = await import("./independent-chain.js");
  const agreed = String(await agreedVaultFor(cfg.factory, Enclave.address)).toLowerCase();
  let prepared;
  // the owner may be an EOA or a contract account (a Safe, a passkey smart account): its wallet's signatures are recorded
  // and the exact factory call is checked by the contracts themselves before anything is submitted (owner-signature.js)
  const OS = await import("./owner-signature.js");
  const rec0 = OS.recordingSigner(S.ownerFromProvider(Enclave.provider, Enclave.address));
  try {
    const usdc = budget > 0n ? await S.usdcDomain(pc, cfg.usdc, cfg.chainId) : undefined;
    prepared = await S.prepareSessionOpen({ publicClient: pc, factory: cfg.factory, owner: rec0.signer, chainId: cfg.chainId, grant, usdc });
  } catch(e){ await st.remove(record.id).catch(() => {}); throw signError(e, "open a session"); }
  if (String(prepared.vault).toLowerCase() !== agreed){
    await st.remove(record.id).catch(() => {});
    throw new EnclaveError("The chain endpoints disagree about your session vault; nothing was submitted.", 0);
  }
  try { await OS.verifyOwnerSubmission({ prep: prepared, owner: Enclave.address, signatures: rec0.signatures }); }
  catch(e){ await st.remove(record.id).catch(() => {}); throw new EnclaveError(e.message || String(e), 0); }
  try { await submitPrepared(prepared); }
  catch(e){ await st.remove(record.id).catch(() => {}); throw signError(e, "open a session"); }
  const rec = await S.completeSession(st, record, { vault: prepared.vault, owner: Enclave.address, grant, rpc: cfg.rpc });
  lsSet(WALLET_SESSION_KEY, rec.id);
  _cur = null; _st = null; Enclave._ownerSession = null;
  emit("enclave:session", { active: true });
  return currentSession();
}

/* Owner operations (extend, terminate, revoke all, withdraw, promote, adopt, environment, release): the wallet
   that owns the vault submits the vault call itself. SessionVault._ownerAuth authorizes msg.sender == owner in the
   block that executes it - nothing here asserts ownership on the vault's behalf. */
async function independentOwnerOp(op){
  if (ID.currentIdentity().kind === "account") return accountOwnerOp(op);
  if (!Enclave.provider || !Enclave.address) throw new EnclaveError("Connect the wallet that owns this vault.", 0);
  const cfg = await sessionsConfig();
  if (!cfg) throw new EnclaveError("Wallet sessions are off: the network profile pins no session factory.", 0);
  const vault = await independentVaultOf(Enclave.address);
  if (!vault) throw new EnclaveError("This wallet has no session vault on the pinned factory yet.", 0);
  const S = await sdk();
  let prep;
  try {
    prep = await S.prepareOwnerOperation({ publicClient: S.chainClient(cfg.chainId, cfg.rpc), chainId: cfg.chainId, vault, mode: "direct",
      expectOwner: Enclave.address, op });
  } catch(e){ throw signError(e, "prepare that"); }
  try { return { txHash: await submitPrepared(prep) }; }
  catch(e){ throw signError(e, "send that"); }
}

/* Budget from the wallet into the live session: one USDC authorization bound to this top-up (its nonce is the
   vault's TopUp digest), submitted by the wallet. The token domain is read at a block the profile's RPCs agree on. */
async function independentTopUp(amountUsd){
  const c = await currentSession();
  if (!c) throw new EnclaveError("No active session.", 0);
  if (ID.currentIdentity().kind === "account") return accountTopUp(c, amountUsd);
  if (!Enclave.provider || String(c.owner).toLowerCase() !== String(Enclave.address || "").toLowerCase())
    throw new EnclaveError("Connect the wallet that owns this session to top it up.", 0);
  const amount = BigInt(Math.round(Number(amountUsd) * 1e6));
  if (!(amount > 0n)) throw new EnclaveError("Enter an amount above zero.", 0);
  const cfg = await sessionsConfig(), S = await sdk();
  const { tokenDomain } = await import("./independent-chain.js");
  let prep;
  try {
    prep = await S.prepareTopUpFromWallet({ publicClient: S.chainClient(cfg.chainId, cfg.rpc), chainId: cfg.chainId,
      vault: c.session.handle.vault, sessionId: c.session.handle.sid, amount, usdc: await tokenDomain(cfg.usdc),
      owner: S.ownerFromProvider(Enclave.provider, Enclave.address) });
  } catch(e){ throw signError(e, "top up"); }
  const hash = await submitPrepared(prep);
  _st = null; emit("enclave:session", { active: true });
  return { txHash: hash };
}

/* A ledger call on a record the session's vault owns: through the session, except that a PRODUCTION record's
   version/config change is the owner's Promote (wallet-submitted, checked against the catalog's label). The record's
   owner and the vault's environment for it are read at a block the profile's RPCs agree on. Every other record keeps
   the plain wallet transaction. The vault refuses what the grant or the owner did not allow. */
async function independentLedgerSend(call, walletSend, data){
  const acct = ID.currentIdentity().kind === "account";
  // a passkey account identity: the connected wallet only pays gas, so a ledger call is never sent AS the wallet
  if (acct && !ID.actingOwner(null)) throw new EnclaveError(identityRefusal(), 0);
  if (!call.id || call.fn === "unknown"){
    if (acct) throw new EnclaveError("That ledger call is not one your passkey account can make from here; nothing was sent.", 0);
    return walletSend();
  }
  const c = await currentSession().catch(() => null);
  const IC = await import("./independent-chain.js");
  const { row } = await IC.deploymentAt(call.id);
  const owner = acct ? ID.actingOwner(null) : Enclave.address;
  if (acct && row && lower(row.owner) === owner) return safeLedgerSend(data);
  const vault = c ? String(c.session.handle.vault).toLowerCase() : await independentVaultOf(owner).catch(() => null);
  if (!row || !vault || String(row.owner).toLowerCase() !== vault){
    if (acct) throw new EnclaveError("This deployment is held neither by your passkey account nor by its session vault; nothing was sent.", 0);
    return walletSend();
  }
  const env = (await IC.agreedHeld(vault, call.id)).env;
  if (env === 0) throw new EnclaveError("This deployment is in your vault but not adopted yet. Adopt it first (an owner action).", 0);
  const calls = call.fn === "multicall" ? call.calls : [call];
  const ref = calls.find((x) => x.fn === "setAppRef"), cfgc = calls.find((x) => x.fn === "setConfig");
  let last = null;
  if (env === 2 && (ref || cfgc)){
    const appRef = ref ? ref.appRef : row.appRef, configCid = cfgc ? cfgc.configCid : row.configCid;
    const S = await sdk(), cfg = await sessionsConfig();
    const { APP_CATALOG_ADDRESS } = await import("./config.js");
    const { label, app, publisher } = await versionLabel(S.chainClient(cfg.chainId, cfg.rpc), APP_CATALOG_ADDRESS, appRef);
    last = await independentOwnerOp({ op: "promote", deployment: call.id, app, publisher, appRef, configCid, versionLabel: label,
      isPublic: Boolean(row.isPublic) });
  }
  for (const one of calls){
    if (env === 2 && (one.fn === "setAppRef" || one.fn === "setConfig")) continue;
    if (one.fn === "transferDeployment") throw new EnclaveError("Transfers out of your vault are an owner action: release it to your wallet first.", 0);
    if (!c) throw new EnclaveError(acct ? "Sign in with your passkey account (its panel) to act on deployments its vault holds." : "Start a session to act on deployments your vault holds.", 0);
    const action = { setActive: "deploy.setActive", setShares: "deploy.setShares", setMaxRate: "deploy.setMaxRate", refund: "deploy.refund",
      setAppRef: "deploy.setAppRef", setConfig: "deploy.setConfig" }[one.fn];
    if (!action) throw new EnclaveError("That change isn't available through a session.", 0);
    const { fn, ...args } = one;
    last = await sessionCall(action, args);
  }
  return last && last.txHash;
}

/* ---- a passkey account as the dashboard identity (js/core/identity.js) -----------------------------------------
   The account's own owners approve; the connected wallet only submits and pays gas. Every owner signature is checked
   by the contracts themselves in an agreed simulation before anything is sent. */
function identityRefusal(){
  const i = ID.currentIdentity();
  return i.state === "pending" ? "Your passkey account is still being checked on chain; nothing was sent."
    : "Your passkey account " + i.safe + " is not verified (" + (i.reason || "unknown") + "); nothing was sent. Fix it, or switch to your wallet identity.";
}

/* The verified account's approvals: its passkeys (as many as the threshold needs, each on its own RP), plus the connected
   wallet when it is one of the account's key owners and the passkeys alone are not enough. */
async function accountApprovals(){
  const profile = ID.identityProfile();
  if (!profile) throw new EnclaveError(identityRefusal(), 0);
  const PA = await import("./passkey-account.js");
  const passkeys = profile.owners.filter((o) => o.kind === "passkey").slice(0, profile.threshold).map((o) => o.credentialId);
  let keySigner = null, keyAddress = null;
  if (passkeys.length < profile.threshold){
    const key = profile.owners.find((o) => o.kind === "key" && lower(o.address) === lower(Enclave.address));
    if (!key) throw new EnclaveError("Your passkey account needs " + profile.threshold + " approvals; this browser holds " + passkeys.length
      + " of its passkeys and your connected wallet is not one of its keys. Nothing was sent.", 0);
    const { personalSignBytes } = await import("./wallet.js");
    keyAddress = key.address;
    keySigner = async (hash) => { const sg = await personalSignBytes(hash); const v = parseInt(sg.slice(-2), 16); return sg.slice(0, -2) + (v < 27 ? v + 31 : v + 4).toString(16); };   // eth_sign form: v + 4
  }
  return { profile, PA, opts: { profile, passkeys, keySigner, keyAddress } };
}

/* An owner operation on the account's vault in "signed" mode: the Safe signs (ERC-1271 through its passkeys), the vault
   checks it in an agreed simulation, then the connected wallet submits it. */
async function accountOwnerOp(op){
  const owner = ID.actingOwner(null);
  if (!owner) throw new EnclaveError(identityRefusal(), 0);
  const cfg = await sessionsConfig();
  if (!cfg) throw new EnclaveError("Wallet sessions are off: the network profile pins no session factory.", 0);
  const vault = await independentVaultOf(owner);
  if (!vault) throw new EnclaveError("Your passkey account has no session vault yet: sign in from its panel first.", 0);
  const { PA, opts } = await accountApprovals();
  const S = await sdk(), OS = await import("./owner-signature.js");
  const rec = OS.recordingSigner(PA.passkeySafeOwnerSigner(opts));
  let prep;
  try {
    prep = await S.prepareOwnerOperation({ publicClient: S.chainClient(cfg.chainId, cfg.rpc), chainId: cfg.chainId, vault, mode: "signed", owner: rec.signer, op });
  } catch(e){ throw signError(e, "prepare that"); }
  try { await OS.verifyOwnerSubmission({ prep, owner, signatures: rec.signatures }); }
  catch(e){ throw new EnclaveError(e.message || String(e), 0); }
  try { return { txHash: await submitPrepared(prep) }; }
  catch(e){ throw signError(e, "send that"); }
}

/* Budget from the account into its live session: one USDC authorization signed by the Safe (USDC v2.2 checks ERC-1271),
   simulated at an agreed block, then submitted by the connected wallet. */
async function accountTopUp(c, amountUsd){
  const owner = ID.actingOwner(null);
  if (!owner || lower(c.owner) !== owner) throw new EnclaveError(identityRefusal(), 0);
  const amount = BigInt(Math.round(Number(amountUsd) * 1e6));
  if (!(amount > 0n)) throw new EnclaveError("Enter an amount above zero.", 0);
  const cfg = await sessionsConfig(), S = await sdk(), OS = await import("./owner-signature.js");
  const { PA, opts } = await accountApprovals();
  const { tokenDomain } = await import("./independent-chain.js");
  const rec = OS.recordingSigner(PA.passkeySafeOwnerSigner(opts));
  let prep;
  try {
    prep = await S.prepareTopUpFromWallet({ publicClient: S.chainClient(cfg.chainId, cfg.rpc), chainId: cfg.chainId,
      vault: c.session.handle.vault, sessionId: c.session.handle.sid, amount, usdc: await tokenDomain(cfg.usdc), owner: rec.signer });
  } catch(e){ throw signError(e, "top up"); }
  try { await OS.verifyOwnerSubmission({ prep, owner, signatures: rec.signatures }); }
  catch(e){ throw new EnclaveError(e.message || String(e), 0); }
  const hash = await submitPrepared(prep);
  _st = null; emit("enclave:session", { active: true });
  return { txHash: hash };
}

/* A ledger call on a record the Safe ITSELF holds: the account's owners approve the Safe transaction (its safeTxHash, at
   the Safe's current nonce), the Safe's execTransaction is simulated at an agreed block (it checks the approvals and that the
   ledger accepts the call), then the connected wallet submits it. msg.sender at the ledger is the Safe, never the wallet. */
const safeLedgerSend = (data) => safeExecute({ to: DEPLOYMENTS_ADDRESS, data });

/* One call made BY the account's Safe (execTransaction): its owners approve the safeTxHash, the Safe's execTransaction is
   simulated at an agreed block (the approvals, and that the target accepts the call), then the connected wallet only
   submits it. `value` is the Safe's own ETH. */
export async function safeExecute({ to, data, value = 0n }){
  // the account paying its own gas makes the call itself in one user operation (one passkey approval of its hash)
  if ((await accountGasMode()) === "account") return sendThroughAccount({ to, value, data, what: "a call from your account" });
  const { profile, PA, opts } = await accountApprovals();
  const prepared = await PA.prepareSafeCall(profile, { to, data, value });
  const approve = PA.safeApprover(opts);
  const exec = await PA.execSafeCall(prepared, await approve(prepared.safeTxHash));
  await agreedSimulation(exec, "Your passkey account's Safe would refuse this: the approvals do not meet its threshold, or the call itself is refused.");
  return submitPrepared({ chainId: INDEPENDENT.profile.chainId, to: exec.to, data: exec.data });
}
async function agreedSimulation(call, refusal){
  const IC = await import("./independent-chain.js");
  const r = IC.reader(), snap = await r.snapshot();
  try { await r.call(snap, call.to, call.data); }
  catch(e){
    if (e && e.revert) throw new EnclaveError(refusal + " (checked at block " + snap.number + "). Nothing was sent.", 0);
    throw new EnclaveError("The chain endpoints did not agree, so this could not be checked (" + String(e.message || e).slice(0, 160) + "). Nothing was sent.", 0);
  }
}
const accountIdentity = () => ID.currentIdentity().kind === "account";

/* Open a session the account owns: a new non-extractable key, the grant (and the USDC budget authorization) signed BY the
   Safe through its passkeys, the exact factory call simulated at an agreed block. -> { prep, finish(): the open session }.
   The caller submits prep (the connected wallet, or anyone given the calldata) and then calls finish(). */
export async function prepareAccountSession(profile, { budgetUsd = 0, hours = 12, passkeyIds, keySigner = null, keyAddress = null } = {}){
  const cfg = await sessionsConfig();
  if (!cfg) throw new EnclaveError("Sessions are off: the network profile pins no session factory.", 0);
  const PA = await import("./passkey-account.js"), OS = await import("./owner-signature.js");
  const S = await sdk(), st = await store();
  const label = "Passkey account " + String(profile.safe).slice(0, 8) + "…" + String(profile.safe).slice(-6);
  const { signer, record } = await S.newSessionKey(st, { relay: "", chainId: cfg.chainId, label, extractable: false });
  const drop = () => st.remove(record.id).catch(() => {});
  const budget = BigInt(Math.round(Number(budgetUsd || 0) * 1e6));
  const grant = S.buildGrant({ sessionKey: signer.keyHash, label, preset: "browser", policy: { budget, expiresIn: Math.round(hours * 3600) }, signWithin: 900 });
  const pc = S.chainClient(cfg.chainId, cfg.rpc);
  const rec = OS.recordingSigner(PA.passkeySafeOwnerSigner({ profile, passkeys: passkeyIds, keySigner, keyAddress }));
  let prep;
  try {
    const usdc = budget > 0n ? await S.usdcDomain(pc, cfg.usdc, cfg.chainId) : undefined;
    prep = await S.prepareSessionOpen({ publicClient: pc, factory: cfg.factory, owner: rec.signer, chainId: cfg.chainId, grant, usdc });
  } catch(e){ await drop(); throw e; }
  const { agreedVaultFor } = await import("./independent-chain.js");
  if (lower(await agreedVaultFor(cfg.factory, profile.safe)) !== lower(prep.vault)){ await drop(); throw new EnclaveError("The chain endpoints disagree about the account's session vault; nothing was sent.", 0); }
  try { await OS.verifyOwnerSubmission({ prep, owner: profile.safe, signatures: rec.signatures }); }
  catch(e){ await drop(); throw new EnclaveError(e.message || String(e), 0); }
  return { prep, budget, cancel: drop, finish: async () => {
    const open = await S.completeSession(st, record, { vault: prep.vault, owner: lower(profile.safe), grant, rpc: cfg.rpc });
    setAccountSession(profile.safe, open.id);
    return open;
  } };
}
/* Who approves a request a CLI made (/grant, `enclave --independent … login`): under a verified passkey account identity,
   the ACCOUNT (its passkeys sign as the Safe; ERC-1271) with the connected wallet only submitting and paying gas;
   -> { owner, account: true, signer, submit(prep) -> tx hash }. Under the wallet identity -> null (the page's wallet path).
   A selected account that is not verified refuses: nothing falls back to the wallet. */
export async function grantOwner(){
  if (!accountIdentity()) return null;
  await ID.ensureIdentity();                    // a page load: the stored selection re-verifies before anything is signed
  const owner = ID.actingOwner(null);
  if (!owner) throw new EnclaveError(identityRefusal(), 0);
  const { profile, PA, opts } = await accountApprovals();
  const ownGas = (await import("./account-transport.js")).gasChoice(profile) === "account";
  return { owner, account: true, ownGas, signer: PA.passkeySafeOwnerSigner(opts), submit: (prep) => submitPrepared(prep) };
}
/* "Start a session" under a passkey account identity: its passkeys approve, the connected wallet submits and pays gas. */
async function startAccountSession({ budgetUsd, hours }){
  const { profile, opts } = await accountApprovals();
  const p = await prepareAccountSession(profile, { budgetUsd, hours, passkeyIds: opts.passkeys, keySigner: opts.keySigner, keyAddress: opts.keyAddress });
  try { await submitPrepared(p.prep); }
  catch(e){ await p.cancel(); throw signError(e, "open a session"); }
  await p.finish();
  return currentSession();
}

/* Funding a record under a passkey account identity - always the ACCOUNT's money, never the connected wallet's:
   - a record its session vault holds: the session's budget (deploy.fund; a short budget offers a top-up);
   - a record the Safe holds: the Safe's USDC through a ReceiveWithAuthorization the Safe signs (ERC-1271 through its
     passkeys; USDC v2.2 checks it), or the Safe's ETH through fundEth - both credited to the Safe, the record's owner.
   Anything else is refused. -> the transaction hash. */
export async function accountFund({ id, amount6, asset = "USDC", wei = 0n, log = () => {} }){
  const owner = ID.actingOwner(null);
  if (!owner) throw new EnclaveError(identityRefusal(), 0);
  const IC = await import("./independent-chain.js");
  const { row } = await IC.deploymentAt(id);
  if (!row) throw new EnclaveError("No such deployment on the pinned ledger.", 0);
  const held = lower(row.owner);
  if (held !== owner){
    const vault = await independentVaultOf(owner).catch(() => null);
    if (!vault || held !== vault) throw new EnclaveError("This deployment is held neither by your passkey account nor by its session vault; nothing was sent.", 0);
    if (asset === "ETH"){
      // the ledger's fundEth takes ETH from anyone: the account pays it from its own ETH (one approval); like every ETH
      // funding it buys runtime but is not refundable escrow
      log("info", "[*] approve with your passkey: the account sends " + (Number(wei) / 1e18).toFixed(6) + " ETH of its own to fundEth for the record its vault holds…");
      const { DEP_SEL, encBytes32 } = await import("./chain.js");
      return safeExecute({ to: DEPLOYMENTS_ADDRESS, data: "0x" + DEP_SEL.fundEth + encBytes32(id), value: BigInt(wei) });
    }
    log("info", "[*] funding $" + (Number(amount6) / 1e6).toFixed(2) + " from your account session's budget (your wallet pays gas only)…");
    return (await sessionCall("deploy.fund", { id, amount6: BigInt(amount6) })).txHash;
  }
  if (asset === "ETH"){
    log("info", "[*] approve with your passkey: the account sends " + (Number(wei) / 1e18).toFixed(6) + " ETH of its own to fundEth (your wallet pays gas only)…");
    const { DEP_SEL, encBytes32 } = await import("./chain.js");
    return safeExecute({ to: DEPLOYMENTS_ADDRESS, data: "0x" + DEP_SEL.fundEth + encBytes32(id), value: BigInt(wei) });
  }
  const { profile, PA, opts } = await accountApprovals();
  const L = await PA.lib();
  const usdc = await IC.tokenDomain(USDC_BASE);
  const nonce = "0x" + String(id).replace(/^0x/, "").slice(0, 32) + [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = (await (IC.reader()).snapshot()).timestamp;
  const validBefore = BigInt(now + 3600);
  const td = { domain: { name: usdc.name, version: usdc.version, chainId: usdc.chainId, verifyingContract: L.getAddress(USDC_BASE) },
    types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "ReceiveWithAuthorization",
    message: { from: L.getAddress(profile.safe), to: L.getAddress(DEPLOYMENTS_ADDRESS), value: BigInt(amount6), validAfter: 0n, validBefore, nonce } };
  log("info", "[*] approve with your passkey: a $" + (Number(amount6) / 1e6).toFixed(2) + " USDC authorization from your account (your wallet pays gas only)…");
  const sig = await PA.passkeySafeOwnerSigner(opts).signTypedData(td);
  const data = L.encodeFunctionData({ abi: [{ type: "function", name: "fundWithAuthorization", stateMutability: "nonpayable", inputs: ["bytes32", "address", "uint256", "uint256", "uint256", "bytes32", "bytes"].map((type) => ({ type })), outputs: [] }],
    functionName: "fundWithAuthorization", args: [id, L.getAddress(profile.safe), BigInt(amount6), 0n, validBefore, nonce, sig] });
  await agreedSimulation({ to: DEPLOYMENTS_ADDRESS, data }, "USDC or the ledger would refuse this funding from your account (its USDC balance, or the account's approval)");
  return submitPrepared({ chainId: INDEPENDENT.profile.chainId, to: DEPLOYMENTS_ADDRESS, data });
}

/* Records the Safe itself holds can be managed by its sessions (host management, session actions) once the Safe lets its
   vault act for it on the ledger (setDelegate) - one passkey-approved Safe transaction, never the wallet's. */
export async function setAccountDelegation(allowed){
  const owner = ID.actingOwner(null);
  if (!owner) throw new EnclaveError(identityRefusal(), 0);
  const vault = await independentVaultOf(owner);
  if (!vault) throw new EnclaveError("Sign in with your passkey account first: its session vault is what the ledger would let act for it.", 0);
  const S = await sdk();
  const hash = await safeExecute({ to: DEPLOYMENTS_ADDRESS, data: S.setDelegateCall(vault, Boolean(allowed)).data });
  emit("enclave:session", { active: true });
  return hash;
}

/* Who submits under a passkey account identity: "wallet" (the connected wallet pays gas) or "account" (the account pays its
   own gas through the owner's bundler). With a transport named and no choice made, nothing is sent until the owner chooses. */
async function accountGasMode(){
  const profile = ID.identityProfile();
  if (!profile) throw new EnclaveError(identityRefusal(), 0);
  const AT = await import("./account-transport.js");
  const m = AT.gasChoice(profile);
  if (!m) throw new EnclaveError("Choose who pays your passkey account's gas - your connected wallet, or the account itself through your bundler (Passkey account → Gas). Nothing was sent.", 0);
  return m;
}
/* One call made by the account through its own bundler (account-transport.js): the passkeys approve the operation hash. */
async function sendThroughAccount({ to, value = 0n, data, what }){
  const { profile, PA, opts } = await accountApprovals();
  const AT = await import("./account-transport.js");
  try { return (await AT.sendAsAccount(profile, { to, value, data, what }, { approve: PA.safeApprover(opts) })).txHash; }
  catch (e){
    const err = new EnclaveError(e.message || String(e), 0);
    err.code = e.code; err.outcomeUnknown = !!e.outcomeUnknown; err.userOpHash = e.userOpHash || null;
    throw err;
  }
}

/* The ACCOUNT's own upload signer (upload-auth.js erc1271-v2): its passkeys approve each upload as the Safe (ERC-1271),
   and the storage adapters ask its contract. No wallet is involved; refuses unless the account identity is verified. */
export async function accountUploadSigner(){
  const { PA, opts } = await accountApprovals();
  return PA.accountUploadSigner(opts);
}
