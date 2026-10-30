/* ============================================================
   The passkey account panel (independent mode): create, deploy, sign
   in with, and recover an owner-controlled Safe whose owners are the
   owner's passkeys (each under its own RP) and recovery keys.
   Logic: passkey-account.js (building), owner-signature.js (the
   contracts' own check before submission), account-providers.js
   (pins, recognition, transport rules). Interface:
   work/passkey-aa-interface.txt.

   Every choice is the owner's and is shown: RP of each passkey,
   recovery keys, threshold, salt, the gas payer, and an optional
   ERC-4337 transport. A connected wallet is only ever a gas payer
   here (it owns nothing unless the owner adds it as a recovery key),
   and "copy calldata" lets anyone else pay instead. No Enclave account,
   relay, RP, bundler or paymaster exists on this path.
   ============================================================ */
import { esc, copyText, showToast } from "./util.js";
import { INDEPENDENT } from "./config.js";

const lower = (a) => String(a || "").toLowerCase();
const short = (a) => String(a).slice(0, 8) + "…" + String(a).slice(-6);
let draft = null;          // { passkeys: [...], keys: [...], threshold, salt } - this page only, until saved

async function mods(){
  const [PA, OS, AP] = await Promise.all([import("./passkey-account.js"), import("./owner-signature.js"), import("./account-providers.js")]);
  return { PA, OS, AP };
}
const line = (el, cls, t) => { const d = document.createElement("div"); d.className = "ln " + cls; d.textContent = t; el.appendChild(d); };

export async function mountAccountPanel(root){
  if (!root || INDEPENDENT.state !== "on") return;
  const { PA } = await mods();
  const profile = PA.loadAccountProfile(INDEPENDENT.profile.chainId);
  root.innerHTML = '<details class="acct-panel"' + (profile ? " open" : "") + '><summary><b>Passkey account</b> (a Safe your passkeys and recovery keys own; no Enclave account)</summary><div class="acct-body"></div></details>';
  const body = root.querySelector(".acct-body");
  if (profile) return renderProfile(body, profile, root);
  return renderDraft(body, root);
}

/* ---- creating an account ---- */
async function renderDraft(body, root){
  const { PA } = await mods();
  draft ||= { passkeys: [], keys: [], threshold: 1, salt: String(BigInt("0x" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join(""))) };
  const owners = () => [...draft.passkeys, ...draft.keys];
  body.innerHTML =
      '<p class="dim">Your account is a Safe smart account. Its owners are passkeys (each kept by your device under one website, its RP) and, if you want, recovery keys. You choose how many must approve. Nothing here is held by Enclave.</p>'
    + '<fieldset class="acct-keys"><legend>Passkeys</legend><div class="acct-list"></div>'
    + '<label>Name <input class="acct-label ac-in" maxlength="64" placeholder="e.g. laptop"></label> '
    + '<label>RP (the website this passkey belongs to) <input class="acct-rp ac-in" value="' + esc(location.hostname) + '"></label> '
    + '<button type="button" class="btn btn-sm acct-create">Create a passkey here</button> '
    + '<label class="acct-shared-l"><input type="checkbox" class="acct-shared"> account-first: this passkey is the account’s built-in signer, so the account can create itself with no wallet (one per account)</label>'
    + '<details><summary>Add a passkey made on another dashboard (another RP)</summary><textarea class="acct-import" rows="3" placeholder="paste the passkey description that dashboard exported"></textarea> <button type="button" class="btn btn-sm acct-import-go">Add</button></details></fieldset>'
    + '<fieldset><legend>Recovery keys (optional)</legend><div class="acct-rlist"></div><input class="acct-raddr ac-in" placeholder="0x… a wallet key, security-key wallet or another Safe"> <button type="button" class="btn btn-sm acct-radd">Add</button></fieldset>'
    + '<label>Approvals needed <select class="acct-threshold"></select></label> <label>Salt <input class="acct-salt ac-in" size="22"></label>'
    + '<ul class="acct-caps"></ul>'
    + '<button type="button" class="btn btn-sm btn-primary acct-compute">Compute my account address</button>'
    + '<div class="term acct-status" role="status" aria-live="polite"></div>';
  const st = body.querySelector(".acct-status");
  const paint = () => {
    body.querySelector(".acct-list").innerHTML = draft.passkeys.map((k, i) => '<div>' + esc(k.label) + ' · RP ' + esc(k.rpId) + ' · signer ' + esc(short(k.signer))
      + ' <button type="button" class="btn btn-sm acct-export" data-i="' + i + '">Copy description</button></div>').join("") || '<div class="dim">none yet</div>';
    body.querySelector(".acct-rlist").innerHTML = draft.keys.map((k) => '<div>' + esc(k.label) + ' · ' + esc(k.address) + '</div>').join("") || '<div class="dim">none</div>';
    const n = owners().length, sel = body.querySelector(".acct-threshold");
    draft.threshold = Math.min(Math.max(1, draft.threshold), Math.max(1, n));
    sel.innerHTML = Array.from({ length: Math.max(1, n) }, (_, i) => '<option value="' + (i + 1) + '"' + (i + 1 === draft.threshold ? " selected" : "") + '>' + (i + 1) + ' of ' + Math.max(1, n) + '</option>').join("");
    body.querySelector(".acct-salt").value = draft.salt;
    const caps = n ? PA.accountCapabilities({ v: 1, provider: "safe-passkey", chainId: INDEPENDENT.profile.chainId, safe: "0x" + "00".repeat(19) + "01", saltNonce: draft.salt,
      threshold: draft.threshold, transport: null, owners: owners() }) : ["Add at least one passkey."];
    body.querySelector(".acct-caps").innerHTML = caps.map((c) => "<li>" + esc(c) + "</li>").join("");
    body.querySelectorAll(".acct-export").forEach((b) => b.addEventListener("click", (e) => { const k = draft.passkeys[Number(b.dataset.i)];
      copyText(JSON.stringify({ x: k.x, y: k.y, credentialId: k.credentialId, rpId: k.rpId, label: k.label }), e.currentTarget); }));
  };
  const addPasskey = async (pk, label, shared = false) => {
    if (shared && draft.passkeys.some((k) => k.shared)) throw new Error("an account has one built-in (shared-signer) passkey; add this one as its own signer");
    if (draft.passkeys.some((k) => k.x === pk.x && k.y === pk.y)) throw new Error("that passkey is already an owner");
    const signer = shared ? PA.SHARED_SIGNER : (await PA.passkeySigner({ x: pk.x, y: pk.y })).signer;
    if (!shared && draft.passkeys.some((k) => k.signer === signer)) throw new Error("that passkey is already an owner");
    draft.passkeys.push({ kind: "passkey", signer, x: pk.x, y: pk.y, verifiers: String(PA.VERIFIERS_PRECOMPILE), credentialId: pk.credentialId, rpId: pk.rpId,
      label: String(label || "passkey").slice(0, 64), ...(shared ? { shared: true } : {}) });
    paint();
  };
  body.querySelector(".acct-create").addEventListener("click", async () => {
    const label = body.querySelector(".acct-label").value.trim(), rpId = body.querySelector(".acct-rp").value.trim().toLowerCase();
    try {
      line(st, "info", "[*] your device will ask you to create a passkey for " + rpId + "…");
      const pk = await PA.createPasskey({ rpId, rpName: rpId, userName: label || "Enclave account" });
      await addPasskey(pk, label || "passkey", body.querySelector(".acct-shared").checked);
      line(st, "ok", "[✓] passkey created under " + rpId + " (its private key stays on your device)");
    } catch (e){ line(st, "warn", "[x] " + (e.message || e)); }
  });
  body.querySelector(".acct-import-go").addEventListener("click", async () => {
    try {
      const j = JSON.parse(body.querySelector(".acct-import").value);
      if (!/^0x[0-9a-f]{64}$/.test(j.x || "") || !/^0x[0-9a-f]{64}$/.test(j.y || "") || !j.credentialId || !j.rpId) throw new Error("that is not a passkey description");
      await addPasskey(j, j.label);
      line(st, "ok", "[✓] added the passkey from " + j.rpId + ". You can use it only on a dashboard served from " + j.rpId + ".");
    } catch (e){ line(st, "warn", "[x] " + (e.message || e)); }
  });
  body.querySelector(".acct-radd").addEventListener("click", () => {
    const a = body.querySelector(".acct-raddr").value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return line(st, "warn", "[x] a recovery key is an address");
    if (draft.keys.some((k) => lower(k.address) === lower(a))) return;
    draft.keys.push({ kind: "key", address: lower(a), label: "recovery key " + (draft.keys.length + 1) }); paint();
  });
  body.querySelector(".acct-threshold").addEventListener("change", (e) => { draft.threshold = Number(e.target.value); paint(); });
  body.querySelector(".acct-salt").addEventListener("change", (e) => { draft.salt = e.target.value.trim(); });
  body.querySelector(".acct-compute").addEventListener("click", async () => {
    try {
      if (!draft.passkeys.length) throw new Error("add at least one passkey first");
      const base = { v: 1, provider: "safe-passkey", chainId: INDEPENDENT.profile.chainId, safe: "0x" + "00".repeat(19) + "01", saltNonce: draft.salt, threshold: draft.threshold, transport: null, owners: owners() };
      const pred = await PA.prepareSafeCreation(PA.creationOf(base));
      const profile = { ...base, safe: pred.safe };
      await PA.verifyAccountProfile(profile);
      line(st, "ok", "[✓] your account address: " + pred.safe + (pred.deployed ? " (already deployed)" : " (not deployed yet)"));
      const save = document.createElement("button"); save.type = "button"; save.className = "btn btn-sm btn-primary acct-save"; save.textContent = "Save as my account";
      st.appendChild(save);
      save.addEventListener("click", () => { PA.saveAccountProfile(profile); draft = null; mountAccountPanel(root); });
    } catch (e){ line(st, "warn", "[x] " + (e.message || e)); }
  });
  paint();
}

/* ---- a saved account ---- */
async function renderProfile(body, profile, root){
  const { PA, AP } = await mods();
  body.innerHTML = '<div class="acct-summary"><b>' + esc(profile.safe) + '</b></div><ul class="acct-caps">' + PA.accountCapabilities(profile).map((c) => "<li>" + esc(c) + "</li>").join("") + '</ul>'
    + '<div class="acct-actions"><button type="button" class="btn btn-sm acct-verify">Check on chain</button> <button type="button" class="btn btn-sm acct-deploy">Deploy</button> '
    + '<label>Budget (USDC) <input class="acct-budget ac-in" type="number" min="0" step="any" value="0" size="6"></label> <button type="button" class="btn btn-sm btn-primary acct-signin">Sign in (open a session)</button> '
    + '<button type="button" class="btn btn-sm acct-recover">Owners &amp; recovery</button> <button type="button" class="btn btn-sm acct-transport">Gas transport</button> '
    + '<button type="button" class="btn btn-sm danger acct-forget">Forget on this browser</button></div>'
    + '<div class="acct-identity"><button type="button" class="btn btn-sm btn-primary acct-use">Use this account as my dashboard identity</button> '
    + '<button type="button" class="btn btn-sm acct-wallet">Use my connected wallet</button> <span class="acct-id-state dim"></span></div>'
    + '<fieldset class="acct-approvers"><legend>Approve with</legend>' + profile.owners.map((o, i) => '<label><input type="checkbox" class="acct-approve" data-i="' + i + '"' + (i < profile.threshold && o.kind === "passkey" ? " checked" : "") + '> '
      + esc(o.label) + (o.kind === "passkey" ? " (passkey, RP " + esc(o.rpId) + ")" : " (key " + esc(short(o.address)) + ": your connected wallet signs if it is this key)") + '</label>').join(" ") + '</fieldset>'
    + '<fieldset class="acct-gas"><legend>Gas</legend><label><input type="radio" name="acctgas" class="acct-gas-wallet"> your connected wallet pays it (it owns nothing)</label> '
    + '<label><input type="radio" name="acctgas" class="acct-gas-account"' + (profile.transport ? "" : " disabled") + '> the account pays its own gas through your bundler'
    + (profile.transport ? " (" + esc(profile.transport.bundlers.map((b) => new URL(b).host).join(", ")) + ")" : " (name one in Gas transport first)") + '</label>'
    + ' <span class="acct-gas-bal dim"></span> <button type="button" class="btn btn-sm acct-pending" hidden>Check the pending operation</button></fieldset>'
    + '<div class="acct-extra"></div><div class="term acct-status" role="status" aria-live="polite"></div>';
  const st = body.querySelector(".acct-status"), extra = body.querySelector(".acct-extra");
  const AT = await import("./account-transport.js");
  // the owner's explicit choice of who pays gas; the account's own ETH and EntryPoint deposit, read at an agreed block
  const showGas = async () => {
    const mode = AT.gasChoice(profile);
    body.querySelector(".acct-gas-wallet").checked = mode === "wallet";
    body.querySelector(".acct-gas-account").checked = mode === "account";
    const pend = AT.pendingOf(profile.safe), pb = body.querySelector(".acct-pending");
    pb.hidden = !pend;
    if (mode === "account") AT.gasFunds(profile).then((f) => { body.querySelector(".acct-gas-bal").textContent = "the account holds " + AT.fmtEth(f.balance) + " ETH"
      + (f.deposit ? " + " + AT.fmtEth(f.deposit) + " ETH at the EntryPoint" : "") + " (block " + f.block + ")"; }).catch(() => {});
    else body.querySelector(".acct-gas-bal").textContent = "";
  };
  for (const [cls, mode] of [[".acct-gas-wallet", "wallet"], [".acct-gas-account", "account"]])
    body.querySelector(cls).addEventListener("change", () => { try { AT.setGasChoice(profile, mode); line(st, "ok", "[✓] gas: " + (mode === "account" ? "the account pays its own, through your bundler" : "your connected wallet pays it")); } catch (e){ line(st, "warn", "[x] " + e.message); } showGas(); });
  body.querySelector(".acct-pending").addEventListener("click", async () => {
    try {
      const r = await AT.checkPending(profile);
      line(st, r.state === "pending" ? "warn" : "ok", r.state === "pending" ? "[!] " + r.what + " (" + r.userOpHash + ") still has no outcome on chain at block " + r.block + ": nothing is resent"
        : r.state === "included" ? (r.success ? "[✓] " : "[x] ") + r.what + (r.success ? " succeeded in " : " was included and failed in ") + r.txHash
        : r.state === "replaced" ? "[!] the account's nonce moved past " + r.what + " without it: it can no longer execute" : "[✓] nothing pending");
    } catch (e){ line(st, "warn", "[x] " + (e.message || e)); }
    showGas();
  });
  showGas();
  document.addEventListener("enclave:account-pending", (e) => { if (body.isConnected && e.detail && e.detail.safe === lower(profile.safe)) showGas(); });
  // one call made BY the account through its own bundler; the chosen passkeys approve the operation (no wallet)
  const sendAsAccount = async (call, { deploy = false } = {}) => {
    const passkeys = chosen().filter((o) => o.kind === "passkey").map((o) => o.credentialId);
    const approve = PA.safeApprover({ profile, passkeys, keySigner: await keySigner().catch(() => null) });
    const r = await AT.sendAsAccount(profile, { to: call.to, value: call.value || 0n, data: call.data, operation: call.operation || 0, deploy, what: call.label },
      { approve, onPhase: (p, t) => line(st, "info", "[*] " + t) });
    const sponsor = r.paymaster && !/^0x0{40}$/.test(r.paymaster) ? r.paymaster : null;
    line(st, "ok", "[✓] " + call.label + " confirmed by the EntryPoint in " + r.txHash + " (gas " + AT.fmtEth(r.actualGasCost) + " ETH, paid by "
      + (sponsor ? "your paymaster " + short(sponsor) : "the account") + ")");
    showGas();
    return r;
  };
  const transportFail = (e) => { line(st, "warn", (e && e.outcomeUnknown ? "[!] outcome unknown: " : "[x] ") + (e.message || e)); showGas(); };
  const chosen = () => [...body.querySelectorAll(".acct-approve")].filter((c) => c.checked).map((c) => profile.owners[Number(c.dataset.i)]);
  const keySigner = async () => {
    const { Enclave } = await import("./api.js");
    const key = chosen().find((o) => o.kind === "key");
    if (!key) return null;
    if (lower(Enclave.address) !== lower(key.address)) throw new Error("your connected wallet is not the recovery key " + key.address);
    const { personalSignBytes } = await import("./wallet.js");
    const f = async (hash) => { const s = await personalSignBytes(hash); const v = parseInt(s.slice(-2), 16); return s.slice(0, -2) + (v < 27 ? v + 31 : v + 4).toString(16); };   // eth_sign form: v + 4
    f.address = key.address;
    return f;
  };
  // a prepared call, sent by a gas payer the owner picks
  const offer = (calls, title) => {
    extra.innerHTML = '<div><b>' + esc(title) + '</b></div>' + calls.map((c, i) => '<div class="acct-call">' + esc(c.label) + ' → ' + esc(short(c.to))
      + ' <button type="button" class="btn btn-sm acct-send" data-i="' + i + '">Send with my connected wallet (it only pays gas)</button>'
      + (AT.gasChoice(profile) === "account" ? ' <button type="button" class="btn btn-sm acct-send-own" data-i="' + i + '">Send from the account through my bundler (it pays its own gas)</button>' : '')
      + ' <button type="button" class="btn btn-sm acct-copy" data-i="' + i + '">Copy calldata for any submitter</button></div>').join("");
    extra.querySelectorAll(".acct-send-own").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try { await sendAsAccount(calls[b.dataset.i]); if (calls[b.dataset.i].after) await calls[b.dataset.i].after(); }
      catch (e){ transportFail(e); b.disabled = false; }
    }));
    extra.querySelectorAll(".acct-copy").forEach((b) => b.addEventListener("click", (e) => copyText(JSON.stringify({ to: calls[b.dataset.i].to, data: calls[b.dataset.i].data }), e.currentTarget)));
    extra.querySelectorAll(".acct-send").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const { sendTx } = await import("./wallet.js"), { waitReceipt } = await import("./chain.js");
        const h = await sendTx(calls[b.dataset.i].to, calls[b.dataset.i].data, "0x0");
        line(st, "dimln", "  ↳ sent " + h); await waitReceipt(h); line(st, "ok", "[✓] " + calls[b.dataset.i].label + " confirmed");
        if (calls[b.dataset.i].after) await calls[b.dataset.i].after();
      } catch (e){ line(st, "warn", "[x] " + (e.message || e)); b.disabled = false; }
    }));
  };
  body.querySelector(".acct-verify").addEventListener("click", async () => {
    try {
      const v = await PA.verifyAccountProfile(profile);
      line(st, "ok", "[✓] matches the chain at block " + v.block + (v.deployed ? "" : " (not deployed yet)"));
      if (v.deployed){ const id = await AP.identifyAccount(profile.safe); for (const w of id.warnings) line(st, "warn", "[!] " + w); }
    } catch (e){ line(st, "warn", "[x] " + (e.message || e)); }
  });
  body.querySelector(".acct-deploy").addEventListener("click", async () => {
    try {
      const signers = [];
      for (const o of profile.owners.filter((x) => x.kind === "passkey" && !x.shared)){
        const s = await PA.passkeySigner(o);
        if (!s.deployed) signers.push({ label: "create the signer for passkey " + o.label, ...s.deploy });
      }
      const pred = await PA.prepareSafeCreation(PA.creationOf(profile));
      if (pred.safe !== lower(profile.safe)) throw new Error("this profile no longer predicts its own address");
      if (pred.deployed && !signers.length) return line(st, "ok", "[✓] already deployed");
      // account-first: the account creates itself in its own first operation (its built-in passkey approves; it pays its own
      // gas), and creates its other passkeys' signers in the same operation
      if (!pred.deployed && AT.gasChoice(profile) === "account"){
        if (!profile.owners.some((o) => o.shared)) throw new Error("only an account whose first passkey is its built-in signer can create itself: send the creation with a gas payer instead");
        const { multiSendCallOnly } = AP.PROVIDERS["safe-passkey"].contracts;
        const call = !signers.length ? { to: profile.safe, data: "0x" }
          : signers.length === 1 ? { to: signers[0].to, data: signers[0].data }
          : { to: multiSendCallOnly.address, data: (await PA.lib()).encodeFunctionData({ abi: PA.ABI.multiSend, functionName: "multiSend",
              args: [await PA.multiSendPack(signers.map((x) => ({ operation: 0, to: x.to, value: 0n, data: x.data })))] }) };
        try { await sendAsAccount({ ...call, label: "creating your account" + (signers.length ? " and its other passkeys' signers" : "") }, { deploy: true }); }
        catch (e){ transportFail(e); }
        return;
      }
      const calls = [...signers];
      if (!pred.deployed) calls.push({ label: "create the account", ...pred.create });
      offer(calls, "Deploy (anyone may send these; none of them gives the sender any power over the account)");
    } catch (e){ line(st, "warn", "[x] " + (e.message || e)); }
  });
  body.querySelector(".acct-signin").addEventListener("click", async () => {
    try { await signIn(profile, Number(body.querySelector(".acct-budget").value || 0), chosen().filter((o) => o.kind === "passkey").map((o) => o.credentialId), await keySigner(), st, offer); showId(); }
    catch (e){ line(st, "warn", "[x] " + (e.message || e)); }
  });
  body.querySelector(".acct-recover").addEventListener("click", () => renderRecovery(extra, st, profile, chosen, keySigner, offer, root));
  body.querySelector(".acct-transport").addEventListener("click", () => renderTransport(extra, st, profile, root));
  body.querySelector(".acct-forget").addEventListener("click", async () => {
    if (!confirm("Forget this account on this browser? The account itself is unchanged; you can add it again with its description.")) return;
    const ID = await import("./identity.js");
    if (ID.currentIdentity().kind === "account" && ID.currentIdentity().safe === lower(profile.safe)) ID.useWalletIdentity();
    localStorage.removeItem(PA.PROFILE_PREFIX + profile.chainId); mountAccountPanel(root);
  });
  // the dashboard identity: only on this explicit click, only once the account verifies at an agreed block (identity.js)
  const idState = body.querySelector(".acct-id-state");
  const showId = async () => {
    const ID = await import("./identity.js"), i = ID.currentIdentity();
    const mine = i.kind === "account" && i.safe === lower(profile.safe);
    idState.textContent = !mine ? "The dashboard acts as your connected wallet." : i.state === "verified" ? "The dashboard acts as this account (verified at block " + i.block + ")."
      : i.state === "pending" ? "Checking this account on chain…" : "Refused: " + i.reason;
    body.querySelector(".acct-use").disabled = mine && i.state === "verified";
    body.querySelector(".acct-wallet").disabled = !(i.kind === "account");
  };
  body.querySelector(".acct-use").addEventListener("click", async () => {
    try {
      const ID = await import("./identity.js");
      const v = await ID.selectAccountIdentity(profile);
      line(st, "ok", "[✓] the dashboard now acts as your passkey account " + short(v.safe) + " (verified at block " + v.block + "). Your connected wallet only pays gas.");
    } catch (e){ line(st, "warn", "[x] not selected: " + (e.message || e)); }
    showId();
  });
  body.querySelector(".acct-wallet").addEventListener("click", async () => {
    (await import("./identity.js")).useWalletIdentity();
    line(st, "ok", "[✓] the dashboard acts as your connected wallet again");
    showId();
  });
  document.addEventListener("enclave:identity", () => { if (idState.isConnected) showId(); });
  showId();
}

/* Sign in = a session grant (and its USDC budget) signed by the account's owners as the Safe (ERC-1271), checked by the vault
   and USDC themselves through an agreed simulation, then submitted by the gas payer the owner picks. */
async function signIn(profile, budgetUsd, passkeyIds, keySigner, st, offer){
  const SS = await import("./sessions.js");
  line(st, "info", "[*] approve with your passkey(s): each asks on its own website (RP)…");
  const p = await SS.prepareAccountSession(profile, { budgetUsd, passkeyIds, keySigner, keyAddress: keySigner && keySigner.address });
  line(st, "ok", "[✓] the session vault" + (p.budget > 0n ? " and USDC" : "") + " accept the account's signature" + (p.budget > 0n ? "s" : ""));
  offer([{ label: "open the session", to: p.prep.to, data: p.prep.data, after: async () => {
    const open = await p.finish();
    line(st, "ok", "[✓] session " + short(open.id) + " is live in vault " + short(p.prep.vault) + ". It belongs to your passkey account.");
  } }], "Open the session (the calldata carries the account's signatures; the sender only pays gas)");
}

/* Owner management: add or remove an owner, change the threshold - approved by the account's own owners. */
function renderRecovery(extra, st, profile, chosen, keySigner, offer, root){
  extra.innerHTML = '<fieldset class="acct-recovery"><legend>Owners &amp; recovery</legend>'
    + '<label>Add an owner (address: a recovery key, or a passkey signer from "Copy description") <input class="acct-r-add ac-in"></label> '
    + '<label>Remove owner <select class="acct-r-remove"><option value="">-</option>' + profile.owners.map((o) => '<option value="' + esc(o.kind === "passkey" ? o.signer : o.address) + '">' + esc(o.label) + '</option>').join("") + '</select></label> '
    + '<label>New approvals needed <input class="acct-r-threshold ac-in" type="number" min="1" value="' + profile.threshold + '" size="3"></label> '
    + '<button type="button" class="btn btn-sm acct-r-go">Prepare</button><p class="dim">The change is approved by the owners ticked above (as many as the account needs today) and sent by any gas payer. Losing every owner cannot be undone.</p></fieldset>';
  extra.querySelector(".acct-r-go").addEventListener("click", async () => {
    const { PA } = await mods();
    try {
      const add = extra.querySelector(".acct-r-add").value.trim(), remove = extra.querySelector(".acct-r-remove").value, threshold = Number(extra.querySelector(".acct-r-threshold").value);
      const change = add ? { op: "add", owner: add, threshold } : remove ? { op: "remove", owner: remove, threshold } : { op: "threshold", threshold };
      const prepared = await PA.prepareOwnerChange(profile, change);
      const ks = await keySigner();
      const parts = await PA.passkeyParts(chosen().filter((o) => o.kind === "passkey"), prepared.safeTxHash);
      if (ks) parts.push({ signer: lower(chosen().find((o) => o.kind === "key").address), ecdsa: await ks(prepared.safeTxHash) });
      if (parts.length < profile.threshold) throw new Error("this account needs " + profile.threshold + " approvals; tick more owners");
      const exec = await PA.execOwnerChange(prepared, await PA.safeSignatures(parts));
      offer([{ label: change.op + " (Safe nonce " + prepared.nonce + ")", ...exec, after: async () => line(st, "info", "Update the saved account (Forget, then add it again with its new owners) once the change is confirmed.") }], "Owner change");
    } catch (e){ line(st, "warn", "[x] " + (e.message || e)); }
  });
}

/* The owner's own ERC-4337 transport: bundlers and an optional paymaster, validated; none is ever suggested by default. */
function renderTransport(extra, st, profile, root){
  extra.innerHTML = '<fieldset class="acct-tr"><legend>Gas transport (ERC-4337, optional)</legend>'
    + '<label>Bundler endpoints (one per line, https) <textarea class="acct-tr-b" rows="2">' + esc((profile.transport?.bundlers || []).join("\n")) + '</textarea></label>'
    + '<label>Paymaster (optional): kind <select class="acct-tr-k"><option value="">none (the account pays in ETH)</option><option value="erc20">pays gas in a token</option><option value="verifying">sponsor</option></select></label> '
    + '<input class="acct-tr-a ac-in" placeholder="paymaster address"> <input class="acct-tr-u ac-in" placeholder="paymaster https url">'
    + ' <button type="button" class="btn btn-sm acct-tr-save">Save</button><p class="dim">Fees and terms are the bundler’s and paymaster’s own. Without a transport, a gas payer you pick sends each step.</p></fieldset>';
  extra.querySelector(".acct-tr-save").addEventListener("click", async () => {
    const { PA, AP } = await mods();
    try {
      const bundlers = extra.querySelector(".acct-tr-b").value.split(/\s+/).filter(Boolean), kind = extra.querySelector(".acct-tr-k").value;
      const t = bundlers.length ? { provider: "safe-passkey", entryPoint: AP.PROVIDERS["safe-passkey"].entryPoint, bundlers,
        ...(kind ? { paymaster: { kind, address: extra.querySelector(".acct-tr-a").value.trim(), url: extra.querySelector(".acct-tr-u").value.trim() } } : {}) } : null;
      if (t) AP.validateAccountTransport(t);
      PA.saveAccountProfile({ ...profile, transport: t });
      showToast(t ? "transport saved" : "transport removed");
      mountAccountPanel(root);
    } catch (e){ line(st, "warn", "[x] " + (e.message || e)); }
  });
}

/* The dashboard's identity line: whom it acts for, and who pays. A payer is never presented as the owner. */
export async function mountIdentityBar(el){
  if (!el || INDEPENDENT.state !== "on") return;
  if (el._paintIdentity && el.querySelector(".id-bar")) return el._paintIdentity();          // mounted once; a re-boot only repaints
  const [ID, { Enclave }, AT] = await Promise.all([import("./identity.js"), import("./api.js"), import("./account-transport.js")]);
  const host = el;
  host.innerHTML = '<div class="id-bar term" role="status" aria-live="polite"></div>';
  el = host.querySelector(".id-bar");
  const paint = () => {
    if (!el.isConnected) return;
    const i = ID.currentIdentity(), payer = Enclave.address ? short(Enclave.address) : "no wallet connected";
    el.dataset.identity = i.kind === "account" ? i.state : "wallet";
    el.textContent = i.kind === "wallet"
      ? (Enclave.address ? "Acting as your wallet " + short(Enclave.address) + " · it owns and pays" : "Connect a wallet, or select your passkey account (Passkey account, above)")
      : i.state === "verified" ? "Acting as passkey account " + short(i.safe) + (i.profile && AT.gasChoice(i.profile) === "account"
        ? " · gas paid by the account itself, through your bundler" : " · gas paid by " + payer + " (the payer owns nothing here)")
      : i.state === "pending" ? "Checking passkey account " + short(i.safe) + " on chain… nothing is listed or sent until it verifies"
      : "Passkey account " + short(i.safe) + " refused: " + i.reason + ". Nothing is listed or sent in its name; use your wallet or fix the account.";
  };
  host._paintIdentity = paint;
  paint();
  document.addEventListener("enclave:identity", paint);
  document.addEventListener("enclave:wallet", paint);
  ID.ensureIdentity().then(paint, paint);
}
