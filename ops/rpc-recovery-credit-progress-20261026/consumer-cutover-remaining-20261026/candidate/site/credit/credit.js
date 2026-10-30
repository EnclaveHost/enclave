/* ============================================================
   /credit/ - an existing credit vault, operated with no Enclave
   service (js/core/credit-vault-independent.js has the rules and the
   reasons). The page holds the owner's choices: chain endpoints, the
   vault profile (saved only on an explicit click), the payer, and the
   journal of a request whose outcome the chain has not decided yet.
   It prepares every operation itself from the owner's own form input,
   and signs only at the vault's pinned origin.
   ============================================================ */
import * as CV from "../js/core/credit-vault-independent.js";
import { createQuorumReader, jsonRpc } from "../js/core/quorum.js";
import * as GR from "../js/core/credit-vault-reserve.js";
import { resolveReadAuthority, creditEndpoints } from "../js/core/read-authority.js";

const $ = (id) => document.getElementById(id);
const note = (t, bad) => { const n = $("note"); n.textContent = t || ""; n.className = bad ? "bad" : t ? "ok" : ""; };
const RPC_KEY = "enclave_credit_vault_rpcs:v1";
const usd = (v6) => "$" + (Number(v6) / 1e6).toFixed(2);

/* ---- pins and endpoints ---- */
function readConfig(c){
  const known = ["_note", "origin", "rpId", "chainId", "usdc", "factories", "rpcs", "quorum", "confirmations", "maxBlockAgeSeconds", "leaseGasReserve"];
  if (!c || typeof c !== "object" || Object.keys(c).some((k) => !known.includes(k))) throw new Error("credit-config.json is malformed");
  const pins = CV.validatePins({ chainId: c.chainId, origin: c.origin, rpId: c.rpId, usdc: c.usdc, factories: c.factories });
  // the PROPOSED parallel lease-gas reserve: off unless a reviewed record is configured (production: null)
  const gasRecord = c.leaseGasReserve ? GR.validateReserveRecord(c.leaseGasReserve, pins) : null;
  return { pins, gasRecord, rpcs: c.rpcs || [], quorum: c.quorum || 2, confirmations: c.confirmations ?? 2, maxBlockAgeSeconds: c.maxBlockAgeSeconds || 600 };
}
let cfg, cfgError = null;
try { cfg = readConfig(await (await fetch(new URL("credit-config.json", import.meta.url), { cache: "no-store" })).json()); }
catch (e){ cfgError = String(e && e.message || e).startsWith("credit-config") ? e.message : "credit-config.json could not be loaded"; }
const L = await import("/vendor/credit-vault.js");
const pins = cfg && cfg.pins;
// the owner's saved endpoints first; else this release's read authority (scripts/build-site.mjs embeds the same reviewed
// file as the main site): legacy -> credit-config.json; own-rpc -> only its endpoints, same quorum; invalid/too few -> refused
const savedEndpoints = (() => { try { const s = JSON.parse(localStorage.getItem(RPC_KEY) || "null"); if (s && Array.isArray(s.rpcs)) return s; } catch {} return null; })();
let endpointsError = null;
let endpoints = (() => { try { return cfg ? { ...creditEndpoints({ authority: resolveReadAuthority({ legacy: [] }), saved: savedEndpoints, config: cfg }) } : null; }
  catch (e){ endpointsError = String(e && e.message || e); return cfg ? { rpcs: [], quorum: cfg.quorum } : null; } })();
let _reader = null;
function reader(){
  if (!_reader) _reader = CV.withTxReads(createQuorumReader({ rpcs: endpoints.rpcs, quorum: endpoints.quorum, confirmations: cfg.confirmations,
    maxBlockAgeSeconds: cfg.maxBlockAgeSeconds, chainId: pins.chainId }), jsonRpc());
  return _reader;
}
const atOrigin = () => cfg && location.origin === pins.origin;

/* ---- state ---- */
let profile = null, prepared = null, intent = null, request = null, payer = null, newKey = null;
const journal = () => CV.storageJournal(localStorage, pins.chainId);
const fail = (e) => note(e && e.name === "NotAllowedError" ? "The passkey prompt was cancelled." : String(e && e.message || e), true);
const guard = (fn) => async (...a) => { try { note(""); await fn(...a); } catch (e){ fail(e); } };

if (cfg && endpointsError) note(endpointsError, true);   // reads refuse (no endpoint); the owner may still save their own
if (!cfg){ note(cfgError, true); document.querySelectorAll("button, input, select, textarea").forEach((b) => { b.disabled = true; }); }
else {
  $("origin-pin").textContent = pins.origin;
  if (!atOrigin()){ const n = $("origin-note"); n.hidden = false; n.textContent = `This copy of the page runs at ${location.origin}. Reading works, but signing works only at ${pins.origin}: the vault refuses a passkey signature made anywhere else.`; }
  $("rpcs").value = endpoints.rpcs.join("\n"); $("quorum").value = String(endpoints.quorum);
}

$("save-rpcs").addEventListener("click", guard(async () => {
  const rpcs = $("rpcs").value.split(/\s+/).filter(Boolean), quorum = Number($("quorum").value);
  createQuorumReader({ rpcs, quorum, chainId: pins.chainId });       // validates the shape
  endpoints = { rpcs, quorum }; _reader = null; localStorage.setItem(RPC_KEY, JSON.stringify(endpoints));
  note(`Using ${rpcs.length} endpoints, ${quorum} must agree.`);
}));

/* ---- find the vault ---- */
function showVaults(d, credentialId){
  const ul = $("vaults"); ul.replaceChildren();
  d.vaults.forEach((v) => {
    const li = document.createElement("li");
    li.textContent = v.error ? `${v.label}: ${v.error}` : `${v.vault} - ${v.label}${v.current ? " (current)" : ""}: ${v.deployed ? `credit ${usd(v.balance6)}, ${v.keyCount} key(s), this passkey ${v.keyActive ? "active" : "not active"}` : `not minted yet, credit ${usd(v.balance6 || 0)}`} `;
    if (!v.error && credentialId){
      const b = document.createElement("button"); b.textContent = "Use this vault"; b.dataset.vault = v.vault;
      b.addEventListener("click", guard(async () => { setProfile(CV.makeProfile({ ...v, key: d.key }, { credentialId }, pins)); }));
      li.append(b);
    }
    ul.append(li);
  });
  note(`Read at block ${d.block}, agreed by ${endpoints.quorum} or more endpoints.`);
}
async function findFor(key, credentialId){
  const addr = $("vault-address").value.trim();
  if (addr){
    const row = await CV.checkVaultForKey(L, addr, key, { reader: reader(), pins });
    return setProfile(CV.makeProfile(row, { credentialId }, pins));
  }
  showVaults(await CV.discoverVaults(L, key, { reader: reader(), pins }), credentialId);
}
const rand32 = () => L.bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
$("find-passkey").addEventListener("click", guard(async () => {
  if (!atOrigin()) throw new Error(`Passkeys for your vault work only at ${pins.origin}.`);
  const a = await L.WebAuthnP256.sign({ challenge: rand32(), rpId: pins.rpId, userVerification: "required" });
  const b = await L.WebAuthnP256.sign({ challenge: rand32(), credentialId: a.id, rpId: pins.rpId, userVerification: "required" });
  const as = (x) => ({ authenticatorData: x.metadata.authenticatorData, clientDataJSON: x.metadata.clientDataJSON, r: x.signature.r, s: x.signature.s });
  await findFor(await CV.recoverPasskeyKey(L, as(a), as(b)), a.id);
}));
$("profile-file").addEventListener("change", guard(async () => {
  const f = $("profile-file").files && $("profile-file").files[0]; if (!f) return;
  if (f.size > 1 << 20) throw new Error("that file is too large");
  const j = JSON.parse(await f.text());
  if (j.kind === CV.PROFILE_KIND) return setProfile(CV.validateProfile(j, pins));
  const keys = CV.passkeysFromMigrationFile(j);
  if (!keys.length) throw new Error("that migration file holds no passkey");
  await findFor(keys[0], keys[0].credentialId);
}));
$("load-saved").addEventListener("click", guard(async () => {
  const p = JSON.parse(localStorage.getItem(CV.PROFILE_PREFIX + pins.chainId) || "null");
  if (!p) throw new Error("no vault profile is saved in this browser");
  setProfile(CV.validateProfile(p, pins));
}));

/* ---- the vault ---- */
async function setProfile(p){
  profile = p; prepared = request = null;
  $("vault-panel").hidden = false; $("review-panel").hidden = true; $("send-panel").hidden = true;
  await refresh(); await showPending();
}
async function refresh(){
  const st = await CV.vaultState(L, profile, { reader: reader(), pins });
  $("vault-info").textContent = st.deployed
    ? `vault ${profile.vault} · credit ${usd(st.balance6)} · nonce ${st.nonce} · ${st.keyCount} key(s) · this passkey ${st.keyActive ? "active" : "NOT active"} · ledger ${st.ledger} (rev ${st.rev}, from the platform address book) · block ${st.snap.number}`
    : `vault ${profile.vault} is not minted yet (anyone can mint it; credit already sent to it is safe)`;
}
$("refresh").addEventListener("click", guard(refresh));
$("save-profile").addEventListener("click", guard(async () => { localStorage.setItem(CV.PROFILE_PREFIX + pins.chainId, JSON.stringify(profile)); note("Saved in this browser."); }));
$("download-profile").addEventListener("click", () => download("enclave-credit-vault.json", profile));
function download(name, obj){
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---- an operation, from the owner's own input ---- */
const showOp = () => document.querySelectorAll("fieldset[data-op]").forEach((f) => { f.hidden = f.dataset.op !== $("op").value; });
$("op").addEventListener("change", showOp); showOp();
const val = (id) => $(id).value.trim();
const opt = (id) => (val(id) === "" ? undefined : val(id));
function readIntent(){
  const op = $("op").value;
  if (op === "deploy") return { op, params: { spec: { appRef: val("deploy-appref"), cpuMilli: Number(val("deploy-cpu")), gpuMilli: Number(val("deploy-gpu") || 0), appPort: Number(val("deploy-port") || 8080),
    ports: val("deploy-ports"), configCid: val("deploy-config"), isPublic: $("deploy-public").checked, ...(opt("deploy-maxrate") ? { maxRate6: val("deploy-maxrate") } : {}) }, fundUsd: val("deploy-fund") } };
  if (op === "fund") return { op, params: { id: val("fund-id"), amountUsd: val("fund-amount") } };
  if (op === "control"){
    const action = $("control-action").value, p = { id: val("control-id"), action };
    if (action === "version") p.ref = val("control-ref");
    if (action === "resize"){ p.cpuMilli = Number(val("control-cpu")); p.gpuMilli = Number(val("control-gpu") || 0); if (opt("control-ref")) p.ref = val("control-ref"); }
    if (action === "options") p.envelope = $("control-envelope").value;
    if (action === "maxrate") p.maxRate6 = val("control-maxrate");
    return { op, params: p };
  }
  if (op === "refund") return { op, params: { amountUsd: val("refund-amount"), acknowledgeTreasury: $("refund-ack").checked } };
  if (op === "addKey"){ if (!newKey) throw new Error("create the new passkey first"); return { op, params: { x: newKey.x, y: newKey.y } }; }
  return { op, params: { keyHash: val("removekey-hash") } };
}
$("addkey-create").addEventListener("click", guard(async () => {
  if (!atOrigin()) throw new Error(`A vault passkey must be made at ${pins.origin}.`);
  const c = await L.WebAuthnP256.createCredential({ name: "Enclave credit vault", rp: { id: pins.rpId, name: "Enclave" } });
  newKey = { credentialId: c.id, x: "0x" + c.publicKey.x.toString(16).padStart(64, "0"), y: "0x" + c.publicKey.y.toString(16).padStart(64, "0") };
  $("addkey-new").textContent = "new passkey " + CV.keyHash(L, newKey.x, newKey.y);
}));
// a new review or signature always starts clean: a request from an earlier operation is never left on screen to send
function clearRequest(){ prepared = request = null; $("review-panel").hidden = true; $("send-panel").hidden = true; $("request").value = ""; }
$("op").addEventListener("change", clearRequest);
$("review").addEventListener("click", guard(async () => {
  clearRequest();
  intent = readIntent();
  prepared = await CV.prepareVaultOp(L, profile, intent.op, intent.params, { reader: reader(), pins, journal: journal() });
  $("summary").replaceChildren(...[...prepared.summary, ...prepared.limits, `Nonce ${prepared.nonce}; valid until ${new Date(Number(prepared.deadline) * 1000).toLocaleTimeString()} (chain time).`]
    .map((t) => Object.assign(document.createElement("li"), { textContent: t })));
  $("review-panel").hidden = false; $("send-panel").hidden = true;
}));
$("sign").addEventListener("click", guard(async () => {
  $("send-panel").hidden = true; $("request").value = ""; request = null;
  if (!prepared) throw new Error("review the operation first");
  // what the form says NOW: an edit after Review is refused (review again), never signed under the old numbers
  request = await CV.signPrepared(L, prepared, profile, { pins, intent: readIntent() });
  $("request").value = JSON.stringify(request, null, 2);
  $("send-panel").hidden = false;
  note("Signed. Choose who pays the gas and send it, or give the request to another sender.");
}));
$("download-request").addEventListener("click", () => download(`enclave-credit-${request.op}-${request.nonce}.json`, request));

/* ---- sending: an explicit payer, a held outcome ---- */
$("payer-wallet").addEventListener("click", guard(async () => {
  if (!window.ethereum) throw new Error("no browser wallet found: download the request and send it with the CLI, or use a relay");
  [payer] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const id = Number(BigInt(await window.ethereum.request({ method: "eth_chainId" })));
  if (id !== pins.chainId) throw new Error(`your wallet is on chain ${id}; switch it to chain ${pins.chainId}`);
  $("payer").textContent = "gas paid by " + payer;
}));
function transport(){
  const relay = val("relay-url");
  if (relay) return CV.relayTransport(relay);
  if (payer) return CV.walletTransport(window.ethereum, payer);
  throw new Error("choose who pays the gas: your wallet or a relay");
}
async function sendIt(req){
  const t = transport();
  const r = await CV.submitRequest(L, req, t, { journal: journal(), reader: t.payer ? reader() : null, pins });
  note(r.status === "broadcast" ? "Sent. Waiting for the chain…" : r.status === "not-sent" ? "Not sent: " + r.reason : "The outcome is not known yet (" + r.reason + "). It is held until the chain decides.", r.status === "not-sent");
  await pollPending();
}
$("send").addEventListener("click", guard(() => sendIt(request)));
$("rebroadcast").addEventListener("click", guard(async () => {
  const e = await journal().get(profile.vault);
  if (!e) throw new Error("nothing is pending");
  await sendIt(e.request);                    // the SAME bytes: one nonce, so it executes at most once
}));
async function showPending(){
  const e = profile && await journal().get(profile.vault);
  $("pending").textContent = e ? `${e.request.op} (nonce ${e.request.nonce}) sent via ${e.via}: ${e.status}. Held until it executes or its deadline (${new Date(Number(e.request.deadline) * 1000).toLocaleTimeString()}) passes.` : "Nothing is pending.";
  return e;
}
async function reconcileOnce(){
  const e = await journal().get(profile.vault);
  if (!e) return null;
  const r = await CV.reconcile(L, e, { reader: reader(), journal: journal() });
  if (r.status !== "pending"){
    note(r.status === "executed" ? `Done: ${e.request.op} executed${r.txHash ? " in " + r.txHash : ""}.` : r.status === "expired" ? "That request expired without executing. Nothing moved; you can prepare it again."
      : "Another operation used that nonce first, so this request can never execute. Nothing moved because of it.", r.status !== "executed");
    if (r.status === "executed" && e.request.op === "addKey" && newKey){ $("addkey-new").textContent = "added. Save a profile for the new passkey from 'Find your vault' with the vault address."; }
    await refresh();
  }
  await showPending();
  return r;
}
async function pollPending(){
  for (let i = 0; i < 200; i++){
    const r = await reconcileOnce().catch((e) => { fail(e); return { status: "pending" }; });
    if (!r || r.status !== "pending") return;
    await new Promise((ok) => setTimeout(ok, 3000));
  }
}
$("reconcile").addEventListener("click", guard(reconcileOnce));

/* ---- app lease gas ---- */
if (cfg){
  if (!cfg.gasRecord) $("gas-state").textContent = CV.reserveRefusal(true) + " This page offers no deposit.";
  else { $("gas-state").textContent = `Lease gas through the reserve ${cfg.gasRecord.reserve} (a separate reserve that accepts your passkey's signature; reviewed record configured on this page).`; $("gas-panel").hidden = false; }
}
const gasJournal = () => GR.reserveStorageJournal(localStorage, pins.chainId);
const gasPolicy = () => ({ enabled: $("gas-enabled").checked, claimPolicy: $("gas-claim-policy").value, sponsorRelease: $("gas-release").checked,
  maxClaimsPerEpoch: Number(val("gas-max-claims")), maxPerOpWei: val("gas-max-op"), epochCapWei: val("gas-epoch-cap"), epochSec: Number(val("gas-epoch-sec")),
  renewWindow: Number(val("gas-renew-window")), minExtension: Number(val("gas-min-ext")), claimCooldown: Number(val("gas-cooldown")), maxGasPrice: val("gas-max-price") });
const gasIntent = (action) => {
  const id = val("gas-id");
  if (action === "configure") return { action, params: { id, policy: gasPolicy() } };
  if (action === "claimant") return { action, params: { id, operator: val("gas-operator"), allowed: $("gas-allow").checked } };
  return { action, params: { id, amountWei: val("gas-withdraw-wei"), to: val("gas-withdraw-to") } };
};
async function gasShow(){
  const st = await GR.reserveState(L, profile, cfg.gasRecord, val("gas-id"), { reader: reader(), pins });
  const r = st.reserve;
  $("gas-info").textContent = `${st.ownedByVault ? "owned by this vault" : "owned by " + st.owner} · reserve ${r.balanceWei} wei · ${r.enabled ? "ENABLED" : "not enabled"}`
    + ` · signature nonce ${st.sigNonce} · block ${st.snap.number}${st.originBound ? "" : " · OLDER vault build: signatures refused"}`;
}
$("gas-status").addEventListener("click", guard(gasShow));
$("gas-deposit").addEventListener("click", guard(async () => {
  if (!payer) throw new Error("connect the wallet that pays the deposit (Who pays the gas)");
  const d = await GR.prepareReserveDeposit(L, profile, cfg.gasRecord, { id: val("gas-id"), amountWei: val("gas-deposit-wei") }, { reader: reader(), pins });
  const hash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: payer, to: d.to, data: d.data, value: "0x" + d.value.toString(16) }] });
  note(`Deposit sent (${hash}). It is not resent automatically: check the reserve before paying again.`);
}));
for (const action of ["configure", "claimant", "withdraw"]) $("gas-" + action).addEventListener("click", guard(async () => {
  const intent = gasIntent(action);
  const prep = await GR.prepareReserveAction(L, profile, cfg.gasRecord, action, intent.params, { reader: reader(), pins, journal: gasJournal() });
  $("gas-summary").replaceChildren(...[...prep.summary, ...prep.limits].map((t) => Object.assign(document.createElement("li"), { textContent: t })));
  const req = await GR.signReserveAction(L, prep, profile, { pins, intent: gasIntent(action) });
  const t = transport();
  const r = await GR.submitReserveRequest(L, req, t, { journal: gasJournal(), reader: t.payer ? reader() : null, pins, record: cfg.gasRecord });
  note(r.status === "broadcast" ? "Sent. Waiting for the chain…" : r.status === "not-sent" ? "Not sent: " + r.reason : "The outcome is not known yet; it is held until the chain decides.", r.status === "not-sent");
  for (let i = 0; i < 200; i++){
    const e = await gasJournal().get(profile.vault); if (!e) break;
    const out = await GR.reconcileReserve(L, e, { reader: reader(), journal: gasJournal() });
    if (out.status !== "pending"){ note(out.status === "executed" ? `Done: reserve ${action} executed${out.txHash ? " in " + out.txHash : ""}.` : `That reserve request ${out.status === "expired" ? "expired" : "was superseded"}; nothing moved because of it.`, out.status !== "executed"); break; }
    await new Promise((ok) => setTimeout(ok, 3000));
  }
  await gasShow();
}));
