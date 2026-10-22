/* ============================================================
   Network profile settings (independent mode).

   One panel, shown on the dashboard (full) and the store (summary):
   import a profile, check it against the chain before trusting it,
   confirm a saved profile for this tab, see what it pins, or stop
   using it. Wording stays plain; the profile format is documented in
   docs/network/independent-dashboard.md.
   ============================================================ */
import { INDEPENDENT } from "./config.js";
import { parseProfile, saveProfile, clearProfile, confirmSavedProfile, profileFingerprint } from "./independent.js";
import { createQuorumReader } from "./quorum.js";
import { keccak256Utf8 } from "./keccak.js";
import { esc } from "./util.js";

const sel = (sig) => "0x" + keccak256Utf8(sig).slice(2, 10);
const normFp = (v) => String(v || "").trim().toLowerCase().replace(/^sha256:/, "").replace(/[^0-9a-f]/g, "");
const short = (a) => String(a).slice(0, 8) + "…" + String(a).slice(-4);

/* Read-only checks before a profile is trusted: its RPCs agree on a recent
   block, every required contract has code there, and the ledger, registry
   and token answer. Returns lines of {ok, text}. */
export async function checkProfile(profile, { rpc } = {}){
  const r = createQuorumReader({ rpcs: [...profile.rpcs], quorum: profile.quorum, confirmations: profile.confirmations,
    maxBlockAgeSeconds: profile.maxBlockAgeSeconds, chainId: profile.chainId, ...(rpc ? { rpc } : {}) });
  const out = [];
  const snap = await r.snapshot();
  out.push({ ok: true, text: snap.rpcs.length + " of " + profile.rpcs.length + " chain endpoints agree on block " + snap.number });
  for (const [name, addr] of Object.entries(profile.contracts)){
    if (/^0x0{40}$/.test(addr)){ out.push({ ok: true, text: name + ": off in this profile" }); continue; }
    const code = await r.code(snap, addr);
    out.push({ ok: code && code !== "0x", text: name + " " + short(addr) + (code && code !== "0x" ? " has code" : " has NO code at this block") });
  }
  const tries = [["deployments", profile.contracts.deployments, "deploymentsSchema()", "ledger schema"],
                 ["registry", profile.contracts.registry, "registrySchema()", "registry schema"]];
  for (const [, addr, sig, label] of tries){
    try { out.push({ ok: true, text: label + " " + Number(BigInt(await r.call(snap, addr, sel(sig)))) }); }
    catch (e){ out.push({ ok: false, text: label + ": " + (e.revert ? "not supported" : e.message) }); }
  }
  const code = await r.code(snap, profile.usdc);
  out.push({ ok: code && code !== "0x", text: "payment token " + short(profile.usdc) + (code && code !== "0x" ? " has code" : " has NO code") });
  return out;
}

function summary(p){
  const pins = p.contracts;
  return '<dl class="ind-dl">'
    + '<dt>Deployments ledger</dt><dd><code>' + esc(pins.deployments) + '</code></dd>'
    + '<dt>App catalog</dt><dd><code>' + esc(pins.appCatalog) + '</code></dd>'
    + '<dt>Host registry</dt><dd><code>' + esc(pins.registry) + '</code></dd>'
    + '<dt>Session factory</dt><dd>' + (/^0x0{40}$/.test(pins.sessionVaultFactory) ? 'off' : '<code>' + esc(pins.sessionVaultFactory) + '</code>') + '</dd>'
    + '<dt>Payment token</dt><dd><code>' + esc(p.usdc) + '</code></dd>'
    + '<dt>Chain endpoints</dt><dd>' + p.rpcs.map((u) => esc(new URL(u).host)).join(", ") + ' · ' + p.quorum + ' must agree, ' + p.confirmations + ' confirmations</dd>'
    + '<dt>Storage</dt><dd>' + (p.storage ? p.storage.replicas.map((r) => esc(new URL(r.upload).host)).join(", ") + ' · ' + p.storage.minimumCopies + ' verified copies required' : 'none (uploads off)') + '</dd>'
    + '<dt>Network directories</dt><dd>' + (p.directories.length ? p.directories.map(esc).join(", ") : 'none (network settings off)') + '</dd>'
    + '</dl>';
}

export function mountIndependentPanel(root, { compact = false } = {}){
  if (!root) return;
  const st = INDEPENDENT;
  const reload = () => location.reload();
  const fpLine = (text) => profileFingerprint(text).then((fp) => {
    const el = root.querySelector(".ind-fp"); if (el) el.textContent = "fingerprint sha256:" + fp;
  }).catch(() => {});
  if (st.state === "off"){
    if (compact) return;
    root.innerHTML = '<details class="ind-panel"><summary>Use your own network profile</summary>'
      + '<p class="dim">A network profile names the contracts, chain endpoints and storage you trust. With one, this dashboard reads and writes the chain directly and uploads to your storage adapters; it does not use Enclave’s API, upload service or address book. Only use a profile from a source you trust: it decides which contracts your wallet signs for.</p>'
      + '<textarea class="ind-text" rows="8" spellcheck="false" placeholder="Paste the profile JSON"></textarea>'
      + '<input type="file" class="ind-file" accept="application/json,.json">'
      + '<label class="dim" for="indExpect">The profile’s fingerprint, exactly as its publisher announced it</label>'
      + '<input id="indExpect" class="ind-expect ac-in" spellcheck="false" autocomplete="off" placeholder="sha256:…">'
      + '<div><button class="btn btn-sm ind-check" type="button">Check</button> <button class="btn btn-sm btn-primary ind-use" type="button" disabled>Use this profile</button></div>'
      + '<div class="term ind-out" role="status" aria-live="polite"></div></details>';
    const ta = root.querySelector(".ind-text"), out = root.querySelector(".ind-out"), use = root.querySelector(".ind-use");
    root.querySelector(".ind-file").addEventListener("change", async (e) => { const f = e.target.files && e.target.files[0]; if (f) ta.value = await f.text(); use.disabled = true; });
    ta.addEventListener("input", () => { use.disabled = true; });
    root.querySelector(".ind-expect").addEventListener("input", () => { use.disabled = true; });
    root.querySelector(".ind-check").addEventListener("click", async () => {
      use.disabled = true; out.innerHTML = "checking…";
      try {
        const p = parseProfile(ta.value);
        const lines = await checkProfile(p);
        const fp = await profileFingerprint(ta.value);
        const expect = normFp(root.querySelector(".ind-expect").value);
        const fpOk = expect.length === 64 && expect === fp;
        out.innerHTML = '<div>' + esc(p.name || "profile") + ' · fingerprint <code>sha256:' + fp + '</code></div>'
          + '<div class="' + (fpOk ? "ok" : "warn") + '">' + (fpOk ? "✓ matches the fingerprint you entered" : expect ? "✗ does NOT match the fingerprint you entered - do not use this profile" : "✗ enter the publisher’s fingerprint to use this profile") + '</div>'
          + summary(p) + lines.map((l) => '<div class="' + (l.ok ? "ok" : "warn") + '">' + (l.ok ? "✓ " : "✗ ") + esc(l.text) + '</div>').join("");
        use.disabled = !fpOk || !lines.every((l) => l.ok);
      } catch (e){ out.innerHTML = '<div class="warn">✗ ' + esc(e.message || String(e)) + '</div>'; }
    });
    use.addEventListener("click", () => { try { saveProfile(ta.value); reload(); } catch (e){ out.innerHTML = '<div class="warn">✗ ' + esc(e.message) + '</div>'; } });
    return;
  }
  if (st.state === "invalid"){
    root.innerHTML = '<div class="ind-panel ind-bad" role="alert"><b>Your saved network profile cannot be used:</b> ' + esc(st.error)
      + '. Nothing is signed until it is fixed or removed - this page does not fall back to Enclave’s hosted service.'
      + ' <button class="btn btn-sm ind-clear" type="button">Remove profile</button></div>';
    root.querySelector(".ind-clear").addEventListener("click", () => { clearProfile(); reload(); });
    return;
  }
  const p = st.profile;
  if (st.state === "unconfirmed"){
    root.innerHTML = '<div class="ind-panel ind-pending" role="alert"><b>Confirm your network profile for this tab.</b> '
      + 'This browser has a saved profile' + (p.name ? ' (“' + esc(p.name) + '”)' : '') + '. Check that it is the one you chose before using it: it decides which contracts your wallet signs for. '
      + '<span class="ind-fp dim"></span>' + summary(p)
      + '<label class="dim" for="indConfirmFp">Type at least the first 16 characters of the fingerprint its publisher announced</label>'
      + '<input id="indConfirmFp" class="ind-confirm-fp ac-in" spellcheck="false" autocomplete="off" placeholder="sha256:…">'
      + '<button class="btn btn-sm btn-primary ind-confirm" type="button" disabled>Use this profile</button> '
      + '<button class="btn btn-sm ind-clear" type="button">Remove profile</button></div>';
    fpLine(st.text);
    const confirmBtn = root.querySelector(".ind-confirm");
    profileFingerprint(st.text).then((fp) => {
      root.querySelector(".ind-confirm-fp").addEventListener("input", (e) => {
        const typed = normFp(e.target.value);
        confirmBtn.disabled = !(typed.length >= 16 && fp.startsWith(typed));
      });
    });
    confirmBtn.addEventListener("click", () => { confirmSavedProfile(); reload(); });
    root.querySelector(".ind-clear").addEventListener("click", () => { clearProfile(); reload(); });
    return;
  }
  root.innerHTML = '<div class="ind-panel ind-on" role="status"><b>Independent mode</b>' + (p.name ? ' · ' + esc(p.name) : '')
    + (st.source === "built-in" ? ' · built into this site' : '') + ' · <span class="ind-fp dim"></span>'
    + (compact ? '' : '<p class="dim">This dashboard reads and writes the chain through your profile and uploads to your storage adapters. Enclave’s hosted features - card and credit payments, account sign-in, live logs and restarts, private environment variables, custom domains and host pinning - are not used here.</p>'
      + summary(p) + '<button class="btn btn-sm ind-recheck" type="button">Check now</button> '
      + (st.source === "saved" ? '<button class="btn btn-sm ind-clear" type="button">Stop using this profile</button>' : '')
      + '<div class="term ind-out" role="status" aria-live="polite"></div>')
    + '</div>';
  fpLine(st.text);
  const re = root.querySelector(".ind-recheck");
  if (re) re.addEventListener("click", async () => {
    const out = root.querySelector(".ind-out"); out.innerHTML = "checking…";
    try { out.innerHTML = (await checkProfile(p)).map((l) => '<div class="' + (l.ok ? "ok" : "warn") + '">' + (l.ok ? "✓ " : "✗ ") + esc(l.text) + '</div>').join(""); }
    catch (e){ out.innerHTML = '<div class="warn">✗ ' + esc(e.message || String(e)) + '</div>'; }
  });
  const cl = root.querySelector(".ind-clear");
  if (cl) cl.addEventListener("click", () => { clearProfile(); reload(); });
}

/* Wallet session controls for independent mode: every owner action is a transaction the wallet sends to its own
   session vault (SessionVault owner operations), nothing is relayed. */
export async function mountSessionControls(root){
  if (!root || INDEPENDENT.state !== "on") return;
  const S = await import("./sessions.js");
  const ID = await import("./identity.js");
  const cfg = await S.sessionsConfig().catch(() => null);
  if (!cfg){ root.innerHTML = '<p class="dim">Wallet sessions are off: the network profile pins no session factory.</p>'; return; }
  const paint = async () => {
    if (!root.isConnected) return;
    // whose session this is follows the dashboard identity (identity.js): the wallet's, or the passkey account's
    const idn = ID.currentIdentity(), acct = idn.kind === "account";
    const name = acct ? "Account session" : "Wallet session";
    if (acct && idn.state !== "verified"){
      root.innerHTML = '<div class="ind-sess"><b>' + name + ':</b> ' + (idn.state === "pending" ? "checking your passkey account…" : "unavailable while your passkey account is refused.") + '</div>';
      return;
    }
    const st = await S.sessionStatus().catch((e) => ({ error: e.message }));
    if (!st){
      root.innerHTML = '<div class="ind-sess"><b>' + name + ':</b> none. <button class="btn btn-sm ind-s-open" type="button">Start a session</button> '
        + '<button class="btn btn-sm ind-s-revoke" type="button">End all sessions</button></div>';
    } else if (st.error){
      root.innerHTML = '<div class="ind-sess warn"><b>' + name + ':</b> couldn’t read it (' + esc(st.error) + '). <button class="btn btn-sm ind-s-end" type="button">Forget it</button></div>';
    } else {
      const live = st.live && Number(st.expiresAt) * 1000 > Date.now();
      root.innerHTML = '<div class="ind-sess"><b>' + name + '</b> ' + (live ? 'live' : 'ended') + ' · ' + S.fmtUsd(st.balance6) + ' left · '
        + (live ? 'ends ' + esc(new Date(Number(st.expiresAt) * 1000).toLocaleString()) : '')
        + ' <button class="btn btn-sm ind-s-top" type="button"' + (live ? '' : ' disabled') + '>Add budget</button>'
        + ' <button class="btn btn-sm ind-s-ext" type="button"' + (live ? '' : ' disabled') + '>Extend</button>'
        + ' <button class="btn btn-sm ind-s-end" type="button">End session</button>'
        + ' <button class="btn btn-sm ind-s-revoke" type="button">End all sessions</button></div>';
    }
    const on = (cls, fn) => { const b = root.querySelector(cls); if (b) b.addEventListener("click", async () => { b.disabled = true;
      try { await fn(); } catch (e){ const { showToast } = await import("./util.js"); showToast(e.message || String(e)); } paint(); }); };
    on(".ind-s-open", () => S.openSessionModal());
    on(".ind-s-top", () => S.openTopUpModal(5));
    on(".ind-s-ext", () => S.openExtendModal(st.sid, st.expiresAt));
    on(".ind-s-end", () => S.endSession());
    on(".ind-s-revoke", async () => { if (confirm("End every session of " + (acct ? "your passkey account's" : "this wallet's") + " vault now? Their unspent budget stays in the vault.")) await S.ownerOp({ op: "revokeAll", withdraw: false }); });
  };
  if (!root._sessWired){
    root._sessWired = true;
    document.addEventListener("enclave:identity", () => paint());
    document.addEventListener("enclave:session", () => paint());
  }
  await paint();
}
