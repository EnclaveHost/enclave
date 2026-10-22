/* ============================================================
   Network profile settings (independent mode).

   One panel, shown on the dashboard (full) and the store (summary):
   import a profile, check it against the chain before trusting it,
   confirm a saved profile for this tab, see what it pins, or stop
   using it. Wording stays plain; the profile format is documented in
   docs/network/independent-dashboard.md.
   ============================================================ */
import { INDEPENDENT, WC_TRANSPORT_KEY, ownerWalletConnect } from "./config.js";
import { parseProfile, saveProfile, clearProfile, confirmSavedProfile, profileFingerprint, chooseHostedService, confirmHostedService, returnToDefault } from "./independent.js";
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
    + '<dt>Network directories</dt><dd>' + (p.directories.length ? p.directories.map(esc).join(", ") : 'none listed') + '</dd>'
    + '<dt>Service index</dt><dd>' + (p.serviceIndex ? '<code>' + esc(p.serviceIndex.address) + '</code> (code pinned)' : 'none (no discovery)') + '</dd>'
    + (p.hostPolicyOrigins && p.hostPolicyOrigins.length ? '<dt>Host policy mirrors</dt><dd>' + p.hostPolicyOrigins.map(esc).join(", ") + '</dd>' : '')
    + '</dl>';
}

/* The import form: an owner-chosen profile, checked against the chain and the publisher's fingerprint before use. */
function importForm(root, reload, { open = false, label = "Use your own network profile" } = {}){
  const box = document.createElement("details");
  box.className = "ind-panel ind-import"; if (open) box.open = true;
  box.innerHTML = '<summary>' + esc(label) + '</summary>'
    + '<p class="dim">A network profile names the contracts, chain endpoints and storage you trust. With one, this dashboard reads and writes the chain directly and uploads to your storage adapters; it does not use Enclave’s API, upload service or address book. Only use a profile from a source you trust: it decides which contracts your wallet signs for.</p>'
    + '<textarea class="ind-text" rows="8" spellcheck="false" placeholder="Paste the profile JSON"></textarea>'
    + '<input type="file" class="ind-file" accept="application/json,.json">'
    + '<label class="dim" for="indExpect">The profile’s fingerprint, exactly as its publisher announced it</label>'
    + '<input id="indExpect" class="ind-expect ac-in" spellcheck="false" autocomplete="off" placeholder="sha256:…">'
    + '<div><button class="btn btn-sm ind-check" type="button">Check</button> <button class="btn btn-sm btn-primary ind-use" type="button" disabled>Use this profile</button></div>'
    + '<div class="term ind-out" role="status" aria-live="polite"></div>';
  root.append(box);
  const ta = box.querySelector(".ind-text"), out = box.querySelector(".ind-out"), use = box.querySelector(".ind-use");
  box.querySelector(".ind-file").addEventListener("change", async (e) => { const f = e.target.files && e.target.files[0]; if (f) ta.value = await f.text(); use.disabled = true; });
  ta.addEventListener("input", () => { use.disabled = true; });
  box.querySelector(".ind-expect").addEventListener("input", () => { use.disabled = true; });
  box.querySelector(".ind-check").addEventListener("click", async () => {
    use.disabled = true; out.innerHTML = "checking…";
    try {
      const p = parseProfile(ta.value);
      const lines = await checkProfile(p);
      const fp = await profileFingerprint(ta.value);
      const expect = normFp(box.querySelector(".ind-expect").value);
      const fpOk = expect.length === 64 && expect === fp;
      out.innerHTML = '<div>' + esc(p.name || "profile") + ' · fingerprint <code>sha256:' + fp + '</code></div>'
        + '<div class="' + (fpOk ? "ok" : "warn") + '">' + (fpOk ? "✓ matches the fingerprint you entered" : expect ? "✗ does NOT match the fingerprint you entered - do not use this profile" : "✗ enter the publisher’s fingerprint to use this profile") + '</div>'
        + summary(p) + lines.map((l) => '<div class="' + (l.ok ? "ok" : "warn") + '">' + (l.ok ? "✓ " : "✗ ") + esc(l.text) + '</div>').join("");
      use.disabled = !fpOk || !lines.every((l) => l.ok);
    } catch (e){ out.innerHTML = '<div class="warn">✗ ' + esc(e.message || String(e)) + '</div>'; }
  });
  use.addEventListener("click", () => { try { saveProfile(ta.value); reload(); } catch (e){ out.innerHTML = '<div class="warn">✗ ' + esc(e.message) + '</div>'; } });
  return box;
}

/* The owner's WalletConnect transport (js/core/config.js ownerWalletConnect): their project id and a relay they choose.
   Off until chosen; a relay carries the encrypted session and cannot sign or change what is signed. */
function walletTransport(root, reload){
  const div = document.createElement("details");
  div.className = "ind-wc";
  let cur = null; try { cur = JSON.parse(localStorage.getItem(WC_TRANSPORT_KEY) || "null"); } catch {}
  const active = ownerWalletConnect();
  div.innerHTML = '<summary>Wallet transport: ' + (active ? 'WalletConnect through <code>' + esc(active.relayUrl) + '</code> (your choice)' : 'injected wallets and your passkey account (WalletConnect off)') + '</summary>'
    + '<p class="dim">WalletConnect reaches wallets that are not browser extensions (a phone wallet, Trezor Suite). Its relay carries the end-to-end encrypted session between this page and your wallet: it cannot sign or change what you sign, but it sees that a session exists. Choose a relay you trust (Reown’s public relay, or one you run) and your own project id. No Enclave service is involved.</p>'
    + '<label class="dim">Project id <input class="ind-wc-id ac-in" spellcheck="false" autocomplete="off" placeholder="32 hex characters" value="' + esc(cur && cur.projectId || "") + '"></label> '
    + '<label class="dim">Relay <input class="ind-wc-relay ac-in" spellcheck="false" autocomplete="off" placeholder="wss://relay.example" value="' + esc(cur && cur.relayUrl || "") + '"></label> '
    + '<button class="btn btn-sm ind-wc-save" type="button">Use this transport</button> '
    + (cur ? '<button class="btn btn-sm ind-wc-off" type="button">Turn WalletConnect off</button>' : '')
    + ' <span class="ind-wc-out" role="status"></span>';
  root.append(div);
  div.querySelector(".ind-wc-save").addEventListener("click", () => {
    const v = { projectId: div.querySelector(".ind-wc-id").value.trim(), relayUrl: div.querySelector(".ind-wc-relay").value.trim() };
    const prev = localStorage.getItem(WC_TRANSPORT_KEY);
    localStorage.setItem(WC_TRANSPORT_KEY, JSON.stringify(v));
    if (!ownerWalletConnect()){ if (prev == null) localStorage.removeItem(WC_TRANSPORT_KEY); else localStorage.setItem(WC_TRANSPORT_KEY, prev);
      div.querySelector(".ind-wc-out").textContent = "✗ a project id is 32 hex characters and the relay a wss:// URL without credentials"; return; }
    reload();
  });
  const off = div.querySelector(".ind-wc-off");
  if (off) off.addEventListener("click", () => { localStorage.removeItem(WC_TRANSPORT_KEY); reload(); });
}

/* The explicit hosted choice: a button, a plain statement of what it means, and nothing automatic. */
function hostedChoice(root, reload){
  const div = document.createElement("div");
  div.className = "ind-hosted-choice";
  div.innerHTML = '<details><summary>Use Enclave’s hosted service instead (not independent)</summary>'
    + '<p class="dim">The hosted service is run by Enclave: card and credit payments, accounts made on Enclave’s relay, live logs through the relay, relay-held secrets and domains. It resolves contracts through Enclave’s address book and uses Enclave’s API, so it is not independent and Enclave can refuse it. It applies to this browser until you return; each new tab asks you to confirm it.</p>'
    + '<button class="btn btn-sm ind-hosted" type="button">Use the hosted service</button></details>';
  root.append(div);
  div.querySelector(".ind-hosted").addEventListener("click", () => { chooseHostedService(); reload(); });
}

/* Service-index discovery: what the index lists (untrusted), which operators' directories this page uses (the user's
   choice), and what cannot be reached from here. */
async function discoverySection(root, p){
  const sec = document.createElement("div");
  sec.className = "ind-discovery";
  sec.innerHTML = '<h4>Services discovered from the index</h4><div class="term ind-disc-out" role="status" aria-live="polite">reading the service index…</div>';
  root.append(sec);
  const out = sec.querySelector(".ind-disc-out");
  if (!p.serviceIndex){ out.innerHTML = '<div class="dim">This profile pins no service index, so nothing is discovered; only the profile’s own directories are used.</div>'; return; }
  const SD = await import("./service-discovery.js");
  const IC = await import("./independent-chain.js");
  const render = async (force) => {
    let d;
    try { d = await SD.discover({ profile: p, reader: IC.reader(), force }); }
    catch (e){ out.innerHTML = '<div class="warn">✗ the service index could not be read: ' + esc(e.message || String(e)) + ' (nothing is substituted for it)</div>'; return; }
    const choices = SD.loadChoices(p);
    const ops = SD.operatorsOf(d.candidates);
    const dirs = SD.pageDirectories(p, d, { choices });
    out.innerHTML = '<div class="dim">Index ' + esc(short(d.index)) + ' · read at block ' + esc(d.block) + ' (' + d.agreeing + ' chain endpoints agree) · '
      + Object.entries(d.windows).map(([k, w]) => esc(k) + " " + w.examined + "/" + w.total + (w.complete ? "" : " (partial)")).join(", ")
      + (d.expired ? ' · ' + d.expired + ' expired ad(s) ignored' : '') + (d.rejected.length ? ' · ' + d.rejected.length + ' malformed ad(s) refused' : '') + '</div>'
      + '<p class="dim">' + esc(d.notice) + '</p>'
      + (ops.length ? ops.map((o) => '<div class="ind-op" data-op="' + esc(o.operator) + '"><label><input type="checkbox" class="ind-op-use"' + (choices.directoryOperators.includes(o.operator) ? " checked" : "")
          + (o.kinds.directory ? "" : " disabled") + '> operator <code>' + esc(o.operator) + '</code></label> · ' + Object.keys(o.kinds).map(esc).join(", ")
          + '<ul>' + o.endpoints.map((e) => '<li>' + esc(e.kind) + ' ' + esc(e.url) + (e.reachable ? "" : ' <span class="warn">not reachable from this page: ' + esc(e.reason) + '</span>')
            + ' <span class="dim">until ' + esc(new Date(e.expiresAt * 1000).toISOString().slice(0, 10)) + '</span></li>').join("") + '</ul></div>').join("")
        : '<div class="dim">No current advertisements. The profile’s own directories are used.</div>')
      + '<div class="dim">This page uses ' + (dirs.length ? dirs.length + ' director' + (dirs.length === 1 ? 'y' : 'ies') + ' from ' + SD.participantsOf(dirs) + ' participant(s): '
          + dirs.map((x) => esc(x.origin) + (x.reachable ? (x.warning ? " (" + esc(x.warning) + ")" : "") : " (unreachable here)")).join(", ") : 'no directory') + '. One operator is one participant however many endpoints it lists.</div>'
      + '<button class="btn btn-sm ind-disc-again" type="button">Read again</button>';
    out.querySelectorAll(".ind-op-use").forEach((cb) => cb.addEventListener("change", () => {
      const set = new Set(SD.loadChoices(p).directoryOperators);
      const op = cb.closest(".ind-op").dataset.op;
      if (cb.checked) set.add(op); else set.delete(op);
      SD.saveChoices(p, { directoryOperators: [...set] }); render(false);
    }));
    out.querySelector(".ind-disc-again").addEventListener("click", () => render(true));
  };
  render(false);
}

export function mountIndependentPanel(root, { compact = false } = {}){
  if (!root) return;
  const st = INDEPENDENT;
  const reload = () => location.reload();
  root.id ||= "network-profile";
  const fpLine = (text) => profileFingerprint(text).then((fp) => {
    const el = root.querySelector(".ind-fp"); if (el) el.textContent = "fingerprint sha256:" + fp;
  }).catch(() => {});
  // the packaged default exists, and this tab confirmed the explicit hosted choice
  if (st.state === "off" && st.packaged && st.hosted && st.hosted.confirmed){
    root.innerHTML = '<div class="ind-panel ind-hosted-on" role="status"><b>Enclave’s hosted service</b> · your explicit choice for this browser, not independent. '
      + '<button class="btn btn-sm ind-return" type="button">Return to the independent default</button></div>';
    root.querySelector(".ind-return").addEventListener("click", () => { returnToDefault(); reload(); });
    return;
  }
  if (st.state === "off"){
    if (compact) return;
    root.innerHTML = "";
    importForm(root, reload, { label: "Use your own network profile" });
    return;
  }
  if (st.state === "invalid"){
    if (st.source === "default"){
      root.innerHTML = '<div class="ind-panel ind-bad" role="alert"><b>The default network profile built into this site cannot be used:</b> ' + esc(st.error)
        + '. Nothing is signed, and this page does not fall back to Enclave’s hosted service.</div>';
      if (!compact){ importForm(root, reload, { open: true }); hostedChoice(root, reload); }
      return;
    }
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
  if (st.source === "default"){
    const pk = st.packaged;
    root.innerHTML = '<div class="ind-panel ind-on ind-default" role="status"><b>Independent</b> · ' + esc(p.name || "default network profile")
      + ' · built into this site' + (pk.provisional ? ' · <b class="warn">PROVISIONAL test profile</b>' : '')
      + (compact ? '' : '<p class="dim">This dashboard reads and writes the chain through the reviewed default profile. Its contracts are checked against their reviewed code at a block the chain endpoints agree on before anything is decided or signed. It does not use Enclave’s API, upload service or address book, and it never switches to the hosted service by itself.</p>'
        + '<dl class="ind-dl"><dt>Profile</dt><dd><code class="ind-pdigest">' + esc(pk.profileDigest) + '</code></dd>'
        + '<dt>Reviewed authority</dt><dd><code class="ind-adigest">' + esc(pk.authorityDigest) + '</code> · review block ' + esc(st.authority.review.blockNumber) + '</dd>'
        + '<dt>Contracts</dt><dd class="ind-auth-line">checking…</dd></dl>'
        + summary(p) + (p.loopbackAliases ? '<p class="warn">Some chain endpoints are aliases of one local endpoint: they are not independent votes.</p>' : '')
        + '<button class="btn btn-sm ind-recheck" type="button">Check now</button> <div class="term ind-out" role="status" aria-live="polite"></div>')
      + '</div>';
    if (compact) return;
    const line = root.querySelector(".ind-auth-line");
    import("./default-authority.js").then((A) => {
      const show = () => { const s = A.authorityStatus(); line.textContent = A.authorityLine(s) || s.state; line.className = "ind-auth-line " + (s.state === "verified" ? (s.drift && s.drift.length ? "warn" : "ok") : s.state === "refused" || s.state === "unavailable" ? "warn" : ""); };
      show(); document.addEventListener("enclave:authority", show);
      root.querySelector(".ind-recheck").addEventListener("click", async () => {
        const IC = await import("./independent-chain.js");
        await A.ensureAuthority(IC.baseReader(), { force: true }); show();
      });
    });
    if (st.hosted && st.hosted.chosen && !st.hosted.confirmed){
      const n = document.createElement("div"); n.className = "ind-panel ind-hosted-pending";
      n.innerHTML = 'Earlier you chose Enclave’s hosted service on this browser. It is not used in this tab until you confirm. '
        + '<button class="btn btn-sm ind-hosted-confirm" type="button">Use the hosted service in this tab</button> <button class="btn btn-sm ind-return" type="button">Forget that choice</button>';
      root.append(n);
      n.querySelector(".ind-hosted-confirm").addEventListener("click", () => { confirmHostedService(); reload(); });
      n.querySelector(".ind-return").addEventListener("click", () => { returnToDefault(); reload(); });
    }
    discoverySection(root, p).catch(() => {});
    walletTransport(root, reload);
    importForm(root, reload, { label: "Use your own network profile instead" });
    hostedChoice(root, reload);
    return;
  }
  root.innerHTML = '<div class="ind-panel ind-on" role="status"><b>Independent mode</b>' + (p.name ? ' · ' + esc(p.name) : '')
    + (st.source === "built-in" ? ' · built into this site' : '') + ' · <span class="ind-fp dim"></span>'
    + (compact ? '' : '<p class="dim">This dashboard reads and writes the chain through your profile and uploads to your storage adapters. Enclave’s hosted features - card and credit payments, account sign-in, live logs and restarts, private environment variables, custom domains and host pinning - are not used here.</p>'
      + summary(p) + (p.loopbackAliases ? '<p class="warn">Some chain endpoints are aliases of one local endpoint: they are not independent votes.</p>' : '')
      + '<button class="btn btn-sm ind-recheck" type="button">Check now</button> '
      + (st.source === "saved" ? '<button class="btn btn-sm ind-clear" type="button">' + (st.packaged ? 'Return to the built-in default profile' : 'Stop using this profile') + '</button>' : '')
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
  if (!compact && p.serviceIndex) discoverySection(root, p).catch(() => {});
  if (!compact) walletTransport(root, reload);
}

/* A page that only Enclave's hosted service provides (card checkout, phone sign-in, Sign in with Enclave for apps), opened
   on an independent dashboard: say what it is and offer the explicit hosted choice. Nothing here calls the relay. */
export function mountHostedOnly(body, what){
  if (!body) return;
  body.innerHTML = '<div class="ind-panel ind-hosted-only" role="status"><b>' + esc(what) + ' is part of Enclave’s hosted service.</b> '
    + 'This dashboard runs independently and does not use Enclave’s API or relay, so this page cannot work here. '
    + 'To use it, choose the hosted service explicitly (it is not independent, and Enclave can refuse it).</div>';
  hostedChoice(body, () => location.reload());
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
