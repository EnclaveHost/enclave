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
import { Enclave, EnclaveError } from "./api.js";
import { APP_CATALOG_RPCS, USDC_BASE } from "./config.js";
import { $, esc, lsGet, lsSet, showToast, emit } from "./util.js";
import { decodeLedgerCall } from "./ledger-calls.js";

const ACTIVE = "enclave_wallet_session";      // id (sid) of this browser's active session
let _sdk = null, _cfg = null, _cur = null;

export async function sdk(){
  if (!_sdk) _sdk = import("/vendor/sessions.js").catch((e) => { _sdk = null; throw new EnclaveError("Could not load the sessions client: " + (e.message || e), 0); });
  return _sdk;
}

/** relay sessions config (chain, factory, relayer); null when this relay has sessions off */
export async function sessionsConfig(){
  if (_cfg) return _cfg;
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
  const id = lsGet(ACTIVE);
  if (!id) return null;
  if (_cur && _cur.record.id === id) return _cur;
  const S = await sdk();
  const rec = await (await store()).load(id).catch(() => null);
  if (!rec || !rec.handle){ lsSet(ACTIVE, ""); return null; }
  const session = await S.sessionFromRecord(rec);
  _cur = { session, record: rec, owner: rec.handle.owner };
  return _cur;
}

/** Live numbers for the header/popover: balance, spent, expiry, live. */
export async function sessionStatus(){
  const c = await currentSession();
  if (!c) return null;
  try {
    const st = await c.session.status();
    return { ...st, owner: c.owner, vault: c.session.handle.vault, sid: c.session.handle.sid, label: c.record.label };
  } catch(e){ return { error: e.message, owner: c.owner }; }
}

function browserLabel(){
  const ua = navigator.userAgent || "";
  const b = /firefox/i.test(ua) ? "Firefox" : /edg/i.test(ua) ? "Edge" : /chrom/i.test(ua) ? "Chrome" : /safari/i.test(ua) ? "Safari" : "Browser";
  const o = /windows/i.test(ua) ? "Windows" : /android/i.test(ua) ? "Android" : /iphone|ipad/i.test(ua) ? "iOS" : /mac os/i.test(ua) ? "macOS" : /linux/i.test(ua) ? "Linux" : "";
  return ("Browser · " + b + (o ? " on " + o : "")).slice(0, 60);
}

/** Open a session for the connected wallet. budgetUsd may be 0 (the default). */
export async function startSession({ budgetUsd = 0, hours = 12 } = {}){
  if (!Enclave.provider || !Enclave.address) throw new EnclaveError("Connect a wallet first.", 0);
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
  lsSet(ACTIVE, rec.id);
  _cur = null;
  await accountFromSession().catch(() => {});      // relay account token, derived from the session
  emit("enclave:session", { active: true });
  return currentSession();
}

/** Exchange the session for a relay account token (no wallet prompt). */
export async function accountFromSession(){
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
  lsSet(ACTIVE, "");
  _cur = null;
  if (!c) return null;
  let out = null;
  try { out = await c.session.terminate(); }
  catch(e){ if (!quiet) showToast("Could not end the session on-chain (" + (e.message || e) + "). Terminate it from Sessions with your wallet."); }
  try { await (await store()).remove(c.record.id); } catch(e){}
  if (Enclave.accountMethod === "session") Enclave.clearAccountSession();
  emit("enclave:session", { active: false });
  if (out && !quiet) showToast("Signed out. " + fmtUsd(out.refund6) + " returned to your wallet.");
  return out;
}

export async function topUpSession(amountUsd){
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
    const r = await c.session.call(action, args);
    emit("enclave:session", { active: true });
    return r;
  } catch(e){
    if (e && (e.code === "budget" || e.code === "period")) {
      const need = e.detail && e.detail.need;
      const ok = await promptTopUp(need, e.code === "period");
      if (ok) return sessionCall(action, args);
    } else if (e && (e.code === "expired" || e.code === "not_live")) {
      lsSet(ACTIVE, ""); _cur = null; emit("enclave:session", { active: false });
      throw new EnclaveError("Your session " + (e.code === "expired" ? "expired" : "ended") + ". Sign in again to continue.", 401);
    }
    throw new EnclaveError(friendly(e), 0);
  }
}

// the vault's price refusals, by error: each says what actually unblocks it
const PRICE_TEXT = {
  LeaseUnsettled: "A host still holds this deployment's lease. Stop it, wait for the host to release it, then resize or re-price it.",
  FundRateTooLow: "This deployment's current lease is priced so a top-up wouldn't buy runtime. Wait for the lease to end (or stop and restart the app), then top up.",
  RateCapOutOfRange: "That price is outside what this session may pay or set.",
};

function friendly(e){
  const m = (e && e.message) || String(e);
  if (!e || !e.code) return m;
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
  const m = fundModal('<div class="wp-card">' + html + "</div>");
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
  const { result } = await overlay(
    '<div class="wp-h">Start a session</div>' +
    '<div class="wp-note">One signature lets this browser deploy, fund and manage your deployments without a wallet prompt each time. ' +
    'It can never withdraw, promote to production or touch secrets, and it ends when you sign out or when it expires.</div>' +
    '<label class="wp-note" for="smBudget">Starting budget in USD (optional)</label>' +
    '<input id="smBudget" class="ac-in" inputmode="decimal" value="0" autocomplete="off" />' +
    '<label class="wp-note" for="smHours">Lasts</label>' +
    '<select id="smHours" class="ac-in"><option value="1">1 hour</option><option value="12" selected>12 hours</option>' +
    '<option value="168">7 days</option><option value="720">30 days</option></select>' +
    '<div class="wp-note">With a budget your wallet asks twice: once for the session, once for the USDC. Unspent budget comes back when the session ends.</div>' +
    '<button class="wp-item wp-go" id="smGo" type="button">Sign with wallet</button>' +
    '<div class="wp-err" id="smErr" role="alert" hidden></div>' +
    '<button class="wp-cancel" type="button">Not now</button>');
  const go = $("#smGo");
  if (go) go.addEventListener("click", async () => {
    go.disabled = true; go.textContent = "Check your wallet…";
    try {
      const budgetUsd = Math.max(0, Number(($("#smBudget").value || "0").replace(/[^0-9.]/g, "")) || 0);
      await startSession({ budgetUsd, hours: Number($("#smHours").value) });
      hostEl()._done(true);
      showToast("Session started.");
    } catch(e){
      const er = $("#smErr"); if (er){ er.hidden = false; er.textContent = e.message || String(e); }
      go.disabled = false; go.textContent = "Sign with wallet";
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

export async function openTopUpModal(suggestUsd = 10, why = ""){
  const { result } = await overlay(
    '<div class="wp-h">Top up this session</div>' +
    '<div class="wp-note">' + esc(why) + 'Add USDC from your wallet: one signature, no gas.</div>' +
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
   A wallet-held row keeps its wallet transaction, byte for byte. A row the wallet's SessionVault holds is
   acted on by this browser's session: the ledger call the panel built is decoded and replayed as the
   matching session action; a PRODUCTION version/config change becomes the owner's Promote signature. */

const _vaults = new Map();   // address -> { vault, deployed, held, at }
export async function vaultOf(address, fresh = false){
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
  if (!Enclave.address || !(await sessionsConfig().catch(() => null))) return [];
  const v = await vaultOf(Enclave.address).catch(() => null);
  if (!v || !v.deployed) return [];
  const res = await Enclave._req("GET", "/deployments", { query: { owner: v.vault } });
  const list = Array.isArray(res) ? res : ((res && (res.deployments || res.items || res.data)) || []);
  return list.map((d) => ({ ...d, _sessionVault: v.vault }));
}

async function ledgerOwner(id){
  const cfg = await sessionsConfig();
  const S = await sdk();
  const pc = S.chainClient(cfg.chainId, rpcFor(cfg));
  const key = (s) => "0x" + Array.from(new TextEncoder().encode(s), (x) => x.toString(16).padStart(2, "0")).join("").padEnd(64, "0");
  const BOOK = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];
  const ledger = await pc.readContract({ address: cfg.book, abi: BOOK, functionName: "addr", args: [key("deployments")] });
  const catalog = await pc.readContract({ address: cfg.book, abi: BOOK, functionName: "addr", args: [key("appCatalog")] });
  const D = [["id","bytes32"],["owner","address"],["appRef","string"],["ports","string"],["configCid","string"],["gpuMilli","uint16"],["cpuMilli","uint16"],
    ["appPort","uint32"],["isPublic","bool"],["active","bool"],["createdAt","uint64"],["rate","uint256"],["balance6","uint256"],["spent6","uint256"],
    ["runner","bytes32"],["runnerOperator","address"],["leaseUntil","uint64"]].map(([name, type]) => ({ name, type }));
  const row = await pc.readContract({ address: ledger, abi: [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [{ type: "tuple", components: D }] }], functionName: "get", args: [id] });
  return { row, pc, catalog, S };
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

/** Send one ledger call: via the session for a vault-held row, else `walletSend()` (the unchanged wallet tx). */
export async function ledgerSend(data, walletSend){
  const call = decodeLedgerCall(data);
  if (!call.id || call.fn === "unknown" || !(await sessionsConfig().catch(() => null))) return walletSend();
  const { row, pc, catalog } = await ledgerOwner(call.id);
  const v = Enclave.address ? await vaultOf(Enclave.address).catch(() => null) : null;
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
