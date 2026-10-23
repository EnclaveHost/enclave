/* ============================================================
   /grant#<request> - the owner's side of `enclave session new`.
   A CLI (or any client) made a session key and a policy; this
   page shows the policy in plain language, the check code the
   CLI printed, and has the owner sign the EIP-712 grant (plus a
   USDC authorization when the session asks for a budget). The
   request lives in the URL fragment, so it never reaches a server.

   Phishing note: the label is the requester's own text - shown,
   never trusted. What the wallet displays is what counts; the
   page says so.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import { Enclave, INDEPENDENT_MODE } from "../core/api.js";
import { connectWallet } from "../core/wallet.js";
import { $, esc, showToast, copyText } from "../core/util.js";
import { sdk, sessionsConfig, fmtUsd, relayRoot, sessionReadClient } from "../core/sessions.js";
import { parseTypedGrant, checkTypedGrant } from "../core/grant-check.js";

function mount(){
  const body = $("#grBody"); if (!body) return;
  render(body).catch((e) => { body.innerHTML = '<div class="ss-card"><p class="co-note">' + esc(e.message || String(e)) + "</p></div>"; });
}

async function render(body){
  if (INDEPENDENT_MODE) return renderIndependent(body);
  const raw = location.hash.replace(/^#/, "");
  if (!raw){ body.innerHTML = '<div class="ss-card"><p class="co-note">No session request here. Run <code>enclave session new</code> and open the link it prints.</p></div>'; return; }
  const S = await sdk();
  let r;
  try { r = S.decodeGrantRequest(raw); } catch(e){ throw new Error("This link is not a valid session request (" + e.message + ")."); }
  const g = r.grant;
  // the key in the link must be the key the grant names - a swapped key is a tampered link
  const kh = S.keyHashOf(BigInt(r.x), BigInt(r.y));
  if (kh.toLowerCase() !== String(g.sessionKey).toLowerCase())
    throw new Error("This request is inconsistent (its key does not match the grant). Do not approve it; run the command again.");
  const cfg = await sessionsConfig();
  if (!cfg) throw new Error("Sessions are not available on this site's API endpoint yet.");
  if (Number(r.chainId) !== Number(cfg.chainId)) throw new Error("This request is for chain " + r.chainId + ", not " + cfg.chainId + ".");
  const now = Math.floor(Date.now() / 1000);
  if (Number(g.signBefore) < now) throw new Error("This request expired. Run the command again for a fresh link.");
  const { lines, warnings } = S.describeGrant(g, now);
  const code = S.checkCode(kh);
  body.innerHTML =
    '<div class="ss-card"><h3>' + esc(g.label || "Unnamed session") + ' <span class="ss-pill">' + esc(g.preset) + '</span></h3>' +
      '<p class="co-note">The name above is the requester\'s own text.</p>' +
      '<ul class="ss-lines">' + lines.map((l) => "<li>" + esc(l) + "</li>").join("") + "</ul>" +
      warnings.map((w) => '<div class="ss-warn">' + esc(w) + "</div>").join("") +
    "</div>" +
    '<div class="ss-card"><h3>Check code</h3>' +
      '<p class="co-note">The command that made this request printed the same code. Your wallet will show it as the first 8 characters of <b>sessionKey</b>:</p>' +
      '<p><span class="ss-code">' + esc(code) + '</span></p>' +
      '<dl class="ss-facts"><dt>sessionKey</dt><dd>' + esc(g.sessionKey) + "</dd>" +
      (g.budget > 0n ? "<dt>budget</dt><dd>" + esc(fmtUsd(g.budget)) + " (" + esc(String(g.budget)) + " in USDC units)</dd>" : "") +
      "<dt>expires</dt><dd>" + esc(new Date(Number(g.expiresAt) * 1000).toISOString()) + " (" + esc(String(g.expiresAt)) + ")</dd>" +
      (r.owner ? "<dt>for wallet</dt><dd>" + esc(r.owner) + "</dd>" : "") + "</dl>" +
    "</div>" +
    '<div class="ss-card" id="grAct"></div>';
  actions(r, cfg, S);
}

function actions(r, cfg, S){
  const box = $("#grAct");
  const g = r.grant;
  if (!Enclave.address){
    box.innerHTML = '<p class="co-note">Connect the wallet that should own this session.</p><div class="ss-row"><button class="btn btn-primary" id="grConnect" type="button">Connect wallet</button></div>';
    $("#grConnect").addEventListener("click", async () => { try { await connectWallet(); actions(r, cfg, S); } catch(e){ showToast(e.message); } });
    return;
  }
  if (r.owner && r.owner.toLowerCase() !== Enclave.address.toLowerCase()){
    box.innerHTML = '<p class="co-note">This request is for wallet <code>' + esc(r.owner) + '</code>, but you are connected as <code>' + esc(Enclave.address) + "</code>. Switch wallets to approve it.</p>";
    return;
  }
  box.innerHTML =
    '<p class="co-note">Approving signs ' + (g.budget > 0n ? "two messages: the session, then the USDC budget it escrows" : "one message") +
    '. Nothing is sent from your wallet' + (g.budget > 0n ? " except the budget, which comes back when the session ends" : "") + ', and you need no ETH.</p>' +
    '<div class="ss-row"><button class="btn btn-primary" id="grGo" type="button">Approve with wallet</button>' +
    '<button class="btn" id="grNo" type="button">Deny</button></div><p class="co-note" id="grMsg" role="status"></p>';
  $("#grNo").addEventListener("click", () => { history.replaceState(null, "", "grant"); box.innerHTML = '<p class="co-note">Denied. Nothing was signed.</p>'; });
  $("#grGo").addEventListener("click", async () => {
    const btn = $("#grGo"); btn.disabled = true; btn.textContent = "Check your wallet…";
    const msg = $("#grMsg");
    try {
      const relay = new S.RelayClient(relayRoot());
      const info = await relay.request("GET", "/owner/" + Enclave.address);
      const usdc = g.budget > 0n ? await S.usdcDomain(S.chainClient(cfg.chainId, cfg.rpc || undefined), cfg.usdc, cfg.chainId) : undefined;
      const out = await S.openSession({ relay, owner: S.ownerFromProvider(Enclave.provider, Enclave.address),
        chainId: cfg.chainId, vault: info.vault, grant: g, usdc });
      history.replaceState(null, "", "grant");
      box.innerHTML = '<h3>Session approved</h3><p class="co-note">The requester picks it up automatically - you can close this page. ' +
        'See it, or end it at any time, on <a href="sessions">Sessions</a>.</p>' +
        '<dl class="ss-facts"><dt>session</dt><dd>' + esc(out.sid) + "</dd><dt>vault</dt><dd>" + esc(out.vault) + "</dd><dt>tx</dt><dd>" + esc(out.txHash) + "</dd></dl>";
    } catch(e){
      const m = (e && (e.message || e.shortMessage)) || String(e);
      msg.textContent = (e && e.code === 4001) || /reject|denied|cancel/i.test(m) ? "Signature rejected." : m;
      btn.disabled = false; btn.textContent = "Approve with wallet";
    }
  });
}

/* ============================================================
   Independent mode: the owner's half of `enclave --independent session new --owner <wallet>` (or a request link), with
   no relay. The CLI holds the session key and prints the exact EIP-712 SessionGrant for the owner's vault on the pinned
   factory. This page accepts that typed data (or a request link), rebuilds it with the SDK and refuses anything that is
   not exactly that grant for THIS wallet's vault - read at a block the profile's RPCs agree on - on this chain, unexpired.
   Then the owner either
   - approves and opens it: the wallet signs the grant (and a USDC authorization for a budget) and submits the factory's
     openFor itself (one transaction; the CLI's `session open <pending-id>` then records the live session), or
   - signs only: the signature goes back to `enclave --independent session open <pending-id> --owner-signature 0x…`,
     which verifies it and submits.
   ============================================================ */
async function renderIndependent(body){
  const cfg = await sessionsConfig();
  if (!cfg) throw new Error("Wallet sessions are off: the network profile pins no session factory.");
  const S = await sdk();
  const raw = location.hash.replace(/^#/, "");
  if (raw){
    let r;
    try { r = S.decodeGrantRequest(raw); } catch(e){ throw new Error("This link is not a valid session request (" + e.message + ")."); }
    if (S.keyHashOf(BigInt(r.x), BigInt(r.y)).toLowerCase() !== String(r.grant.sessionKey).toLowerCase())
      throw new Error("This request is inconsistent (its key does not match the grant). Do not approve it; run the command again.");
    if (Number(r.chainId) !== Number(cfg.chainId)) throw new Error("This request is for chain " + r.chainId + ", not " + cfg.chainId + ".");
    return independentCard(body, { grant: r.grant, owner: r.owner || null, cfg, S, source: "link" });
  }
  body.innerHTML = '<div class="ss-card"><h3>Approve a session request</h3>'
    + '<p class="co-note">Paste the SessionGrant typed data that <code>enclave --independent session new --owner &lt;your wallet&gt;</code> printed. '
    + 'It is checked against your wallet’s vault on the network profile’s pinned session factory before anything is signed.</p>'
    + '<textarea id="grPaste" class="gr-paste" rows="10" spellcheck="false" aria-label="SessionGrant typed data"></textarea>'
    + '<div class="ss-row"><button class="btn btn-primary" id="grCheck" type="button">Check this request</button></div>'
    + '<p class="co-note" id="grPasteMsg" role="status"></p></div><div id="grCard"></div>';
  $("#grCheck").addEventListener("click", async () => {
    const msg = $("#grPasteMsg"); msg.textContent = "";
    try {
      const td = parseTypedGrant($("#grPaste").value, S, cfg);
      await independentCard($("#grCard"), { grant: td.grant, typed: td.typed, owner: null, cfg, S, source: "typed" });
    } catch(e){ msg.textContent = e.message || String(e); $("#grCard").innerHTML = ""; }
  });
}

async function independentCard(box, { grant: g, typed, owner, cfg, S, source }){
  const now = Math.floor(Date.now() / 1000);
  if (Number(g.signBefore) < now) throw new Error("This request expired. Run the command again for a fresh one.");
  // who approves: the verified passkey account identity (the wallet then only pays gas), or the connected wallet
  const acting = await import("../core/sessions.js").then((m) => m.grantOwner());
  if (!acting && !Enclave.address){
    box.innerHTML = '<div class="ss-card"><p class="co-note">Connect the wallet that should own this session.</p><div class="ss-row"><button class="btn btn-primary" id="grConnect" type="button">Connect wallet</button></div></div>';
    $("#grConnect").addEventListener("click", async () => { try { await connectWallet(); await independentCard(box, { grant: g, typed, owner, cfg, S, source }); } catch(e){ showToast(e.message); } });
    return;
  }
  const ownerAddr = acting ? acting.owner : Enclave.address;
  if (owner && owner.toLowerCase() !== ownerAddr.toLowerCase())
    throw new Error("This request is for account " + owner + ", but you are acting as " + ownerAddr + ". Switch accounts to approve it.");
  // the vault this grant must be for: the pinned factory's vault for THIS owner, at an agreed block
  const { agreedVaultFor } = await import("../core/independent-chain.js");
  const vault = String(await agreedVaultFor(cfg.factory, ownerAddr)).toLowerCase();
  // a pasted request must be exactly the SDK's grant for this wallet's vault; a link carries the grant itself
  const expected = typed ? checkTypedGrant(typed, g, { S, chainId: cfg.chainId, vault }) : S.grantTypedData(cfg.chainId, vault, g);
  const { lines, warnings } = S.describeGrant(g, now);
  const sid = S.sessionIdOf(vault, g.sessionKey, g.grantNonce);
  // the owner may be a contract account (a Safe, a passkey smart account): the contracts judge its signature (owner-signature.js)
  const OS = await import("../core/owner-signature.js");
  const kind = await OS.ownerAccountKind(ownerAddr).catch(() => null);
  // which audited account this owner is (pinned Safe passkey account, Coinbase Smart Wallet, EOA, ...) and what that means
  // for recovery - read only, at one agreed block (account-providers.js)
  const acct = kind && kind.kind !== "eoa" ? await import("../core/account-providers.js").then((AP) => AP.identifyAccount(ownerAddr)).catch(() => null) : null;
  box.innerHTML =
    '<div class="ss-card"><h3>' + esc(g.label || "Unnamed session") + ' <span class="ss-pill">' + esc(g.preset) + '</span></h3>'
    + '<p class="co-note">The name above is the requester\'s own text.</p>'
    + '<ul class="ss-lines">' + lines.map((l) => "<li>" + esc(l) + "</li>").join("") + "</ul>"
    + warnings.map((w) => '<div class="ss-warn">' + esc(w) + "</div>").join("") + "</div>"
    + '<div class="ss-card"><h3>Check code</h3><p class="co-note">You are on <b class="gr-origin">' + esc(location.origin) + '</b>. Approve only a request your own command just printed, with a link to this origin and this code; '
    + 'anyone can send you a link. The command printed the same code; a wallet shows it as the first 8 characters of <b>sessionKey</b>:</p>'
    + '<p><span class="ss-code gr-code">' + esc(S.checkCode(g.sessionKey)) + '</span></p>'
    + '<dl class="ss-facts"><dt>vault</dt><dd class="gr-vault">' + esc(vault) + '</dd><dt>factory</dt><dd>' + esc(cfg.factory) + '</dd><dt>session</dt><dd class="gr-sid">' + esc(sid) + '</dd>'
    + (g.budget > 0n ? "<dt>budget</dt><dd>" + esc(fmtUsd(g.budget)) + "</dd>" : "")
    + (kind ? '<dt>owner</dt><dd class="gr-kind">' + esc(OS.describeOwnerKind(kind)) + "</dd>" : "")
    + (acct ? '<dt>account</dt><dd class="gr-acct">' + esc(acct.provider + (acct.version ? " " + acct.version : "") + (acct.recognized ? "" : " (unrecognized)")
        + (acct.owners && acct.owners.length ? " · " + acct.owners.length + " owner(s), " + acct.owners.filter((o) => o.kind === "passkey").length + " passkey(s)" + (acct.threshold ? ", threshold " + acct.threshold : "") : ""))
        + (acct.warnings || []).map((w) => '<div class="ss-warn gr-acct-warn">' + esc(w) + "</div>").join("") + "</dd>" : "")
    + "<dt>expires</dt><dd>" + esc(new Date(Number(g.expiresAt) * 1000).toISOString()) + "</dd></dl></div>"
    + '<div class="ss-card"><p class="co-note">Approve and open: your wallet signs ' + (g.budget > 0n ? "the grant and the USDC budget" : "the grant")
    + ' and submits the pinned factory’s openFor (one transaction; you pay its gas). Sign only: your wallet signs the grant and you hand the signature back to the command'
    + (g.budget > 0n ? " (not possible with a budget, which needs a second signature)" : "") + '.</p>'
    + '<div class="ss-row"><button class="btn btn-primary" id="grOpen" type="button">Approve and open</button>'
    + (g.budget > 0n ? '' : '<button class="btn" id="grSign" type="button">Sign only</button>')
    + '<button class="btn" id="grNo" type="button">Deny</button></div><p class="co-note" id="grMsg" role="status"></p><div id="grOut"></div></div>';
  const msg = $("#grMsg"), outEl = $("#grOut");
  const ownerSigner = acting ? acting.signer : S.ownerFromProvider(Enclave.provider, Enclave.address);
  const busy = (on) => ["#grOpen", "#grSign", "#grNo"].forEach((sel) => { const b = $(sel); if (b) b.disabled = on; });
  const failed = (e) => { const m = (e && (e.message || e.shortMessage)) || String(e); msg.textContent = (e && e.code === 4001) || /reject|denied|cancel/i.test(m) ? "Signature rejected. Nothing was sent." : m; busy(false); };
  $("#grNo").addEventListener("click", () => { history.replaceState(null, "", "grant"); box.innerHTML = '<div class="ss-card"><p class="co-note">Denied. Nothing was signed.</p></div>'; });
  const sign = $("#grSign");
  if (sign) sign.addEventListener("click", async () => {
    busy(true); msg.textContent = "Check your wallet…";
    try {
      const sig = await ownerSigner.signTypedData(expected);
      // the very openFor the command will submit, simulated at an agreed block: the vault's own ECDSA/ERC-1271 check
      // decides whether this signature is handed over at all
      msg.textContent = "Checking the signature with the session vault…";
      const pc = await sessionReadClient(cfg);
      const prep = await S.prepareSessionOpen({ publicClient: pc, factory: cfg.factory, chainId: cfg.chainId, grant: g,
        owner: { address: ownerAddr, signTypedData: async () => sig } });
      if (String(prep.vault).toLowerCase() !== vault) throw new Error("The chain endpoints disagree about your session vault; nothing was handed over.");
      await OS.verifyOwnerSubmission({ prep, owner: ownerAddr, signatures: [sig] });
      msg.textContent = "Signed, and the session vault accepts it. Nothing was sent from this page.";
      // a request from `login` and one from `session new --owner` take the signature back the same way: the command checks
      // it against the pinned factory itself, and a gas key of its own submits it
      const cmd = (source === "link" ? "enclave --independent … login --owner-signature " + sig + " --owner " + ownerAddr
        : "enclave --independent … session open <pending-id> --owner-signature " + sig);
      outEl.innerHTML = '<p class="co-note">Give this to the command that made the request:</p><pre class="gr-sig">' + esc(cmd) + '</pre><button class="btn btn-sm" id="grCopy" type="button">Copy</button>';
      $("#grCopy").addEventListener("click", (e) => copyText(sig, e.currentTarget));
    } catch(e){ failed(e); }
  });
  $("#grOpen").addEventListener("click", async () => {
    busy(true); msg.textContent = "Check your wallet…";
    try {
      const pc = await sessionReadClient(cfg);
      const usdc = g.budget > 0n ? await S.usdcDomain(pc, cfg.usdc, cfg.chainId) : undefined;
      if (!Enclave.address && !(acting && acting.ownGas))
        throw new Error("Connect a wallet to pay the gas of the open (it only pays; the session belongs to " + ownerAddr + "), let your passkey account pay its own gas (Passkey account → Gas), or use Sign only.");
      const rec = OS.recordingSigner(ownerSigner);
      const prep = await S.prepareSessionOpen({ publicClient: pc, factory: cfg.factory, owner: rec.signer, chainId: cfg.chainId, grant: g, usdc });
      if (String(prep.vault).toLowerCase() !== vault) throw new Error("The chain endpoints disagree about your session vault; nothing was submitted.");
      msg.textContent = "Checking the signatures with the session vault…";
      await OS.verifyOwnerSubmission({ prep, owner: ownerAddr, signatures: rec.signatures });
      let hash;
      if (acting) hash = await acting.submit(prep);   // the connected wallet (gas only) or the account itself through its bundler
      else {
        const { sendTx } = await import("../core/wallet.js");
        const { waitReceipt } = await import("../core/chain.js");
        hash = await sendTx(prep.to, prep.data, "0x0");
        msg.textContent = "Submitted " + hash + " · waiting for confirmation…";
        await waitReceipt(hash);
      }
      history.replaceState(null, "", "grant");
      msg.textContent = "";
      box.innerHTML = '<div class="ss-card"><h3>Session approved and open</h3><p class="co-note">The command that made the request records it with '
        + '<code>enclave --independent … session open &lt;pending-id&gt;</code> (it finds the session already live; nothing more is signed).</p>'
        + '<dl class="ss-facts"><dt>session</dt><dd class="gr-sid">' + esc(prep.sid) + '</dd><dt>vault</dt><dd>' + esc(prep.vault) + '</dd><dt>tx</dt><dd>' + esc(hash) + '</dd></dl></div>';
    } catch(e){ failed(e); }
  });
}

// a second request link opened in the same tab changes only the fragment (no page load): render THAT request, never keep
// showing the previous one under the new link
let _hashWired = false;
export function boot(){
  if (!_hashWired){ _hashWired = true; window.addEventListener("hashchange", () => { if ($("#grBody")) mount(); }); }
  mount();
}
