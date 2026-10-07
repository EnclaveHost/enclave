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
import { Enclave } from "../core/api.js";
import { connectWallet } from "../core/wallet.js";
import { $, esc, showToast } from "../core/util.js";
import { sdk, sessionsConfig, fmtUsd, relayRoot } from "../core/sessions.js";

function mount(){
  const body = $("#grBody"); if (!body) return;
  render(body).catch((e) => { body.innerHTML = '<div class="ss-card"><p class="co-note">' + esc(e.message || String(e)) + "</p></div>"; });
}

async function render(body){
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

export function boot(){ mount(); }
