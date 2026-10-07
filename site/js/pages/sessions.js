/* ============================================================
   /sessions - every session that can act for the connected
   wallet: this browser, other devices, agents. For each: label,
   policy, budget vs spend, expiry, recent actions, and the owner
   controls (top up, extend, terminate). Plus revoke-all, the
   vault's free balance (withdraw), and the vault-held deployments
   (environment, promotion). Every control here is an OWNER
   operation: a readable typed-data signature, relayed gas-free.
   `#topup=<vault>:<sid>:<amount6>` (from `enclave session
   top-up-link`) opens straight into a top-up.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import { Enclave } from "../core/api.js";
import { connectWallet } from "../core/wallet.js";
import { $, esc, lsGet, on, showToast } from "../core/util.js";
import { sdk, sessionsConfig, ownerOp, fmtUsd, fmtLeft, endSession, relayRoot, versionLabel, vaultOf } from "../core/sessions.js";

let rendering = false;
// the ledger's Deployment tuple (stable since schema 2; contracts/EnclaveDeployments.sol)
const DEPLOYMENT = [["id", "bytes32"], ["owner", "address"], ["appRef", "string"], ["ports", "string"], ["configCid", "string"],
  ["gpuMilli", "uint16"], ["cpuMilli", "uint16"], ["appPort", "uint32"], ["isPublic", "bool"], ["active", "bool"], ["createdAt", "uint64"],
  ["rate", "uint256"], ["balance6", "uint256"], ["spent6", "uint256"], ["runner", "bytes32"], ["runnerOperator", "address"],
  ["leaseUntil", "uint64"]].map(([name, type]) => ({ name, type }));

function mount(){
  const body = $("#ssBody"); if (!body) return;
  render(body).catch((e) => { body.innerHTML = '<div class="ss-card"><p class="co-note">' + esc(e.message || String(e)) + "</p></div>"; });
}

async function render(body){
  if (rendering) return; rendering = true;
  try {
    const cfg = await sessionsConfig();
    if (!cfg){ body.innerHTML = '<div class="ss-card"><p class="co-note">Sessions are not available on this API endpoint yet.</p></div>'; return; }
    if (!Enclave.address){
      body.innerHTML = '<div class="ss-card"><p class="co-note">Connect your wallet to see the sessions that can act for it.</p>' +
        '<div class="ss-row"><button class="btn btn-primary" id="ssConnect" type="button">Connect wallet</button></div></div>';
      $("#ssConnect").addEventListener("click", async () => { try { await connectWallet(); mount(); } catch(e){ showToast(e.message); } });
      return;
    }
    body.innerHTML = '<div class="ss-card"><p class="co-note">Loading sessions…</p></div>';
    const S = await sdk();
    const relay = new S.RelayClient(relayRoot());
    const info = await relay.request("GET", "/owner/" + Enclave.address);
    const pc = S.chainClient(cfg.chainId, cfg.rpc || undefined);
    const states = await Promise.all(info.sessions.map((s) => S.readSession(pc, info.vault, s.sid).catch(() => null)));
    let free = 0n;
    if (info.deployed) { try { free = await pc.readContract({ address: info.vault, abi: S.sessionVaultAbi, functionName: "free" }); } catch(e){} }
    const mine = lsGet("enclave_wallet_session") || "";
    const now = Math.floor(Date.now() / 1000);
    const rows = info.sessions.map((s, i) => ({ ...s, st: states[i] }))
      .sort((a, b) => (Number(!!(b.st && b.st.live)) - Number(!!(a.st && a.st.live))) || (b.openedBlock || 0) - (a.openedBlock || 0));
    const live = rows.filter((r) => r.st && r.st.live);
    body.innerHTML =
      '<div class="ss-card"><h3>Your vault</h3><dl class="ss-facts"><dt>owner</dt><dd>' + esc(Enclave.address) + "</dd><dt>vault</dt><dd>" + esc(info.vault) +
        "</dd><dt>live sessions</dt><dd>" + live.length + "</dd><dt>free balance</dt><dd>" + esc(fmtUsd(free)) + "</dd></dl>" +
        '<p class="co-note">Free balance is yours, outside every session: refunds from cancelled deployments land here.</p>' +
        '<div class="ss-row">' + (free > 0n ? '<button class="btn" id="ssWithdraw" type="button">Withdraw ' + esc(fmtUsd(free)) + "</button>" : "") +
        (live.length ? '<button class="btn" id="ssRevoke" type="button">Revoke all sessions</button>' : "") + "</div></div>" +
      (rows.length ? rows.map((r) => card(r, S, now, mine)).join("") : '<div class="ss-card"><p class="co-note">No sessions yet. Sign in to start one, or run <code>enclave session new</code> for an agent.</p></div>') +
      (info.held.length ? heldCard(info.held) : "");
    wire(body, info, S, rows, free);
    const m = /^#topup=(0x[0-9a-fA-F]{40}):(0x[0-9a-fA-F]{64}):(\d+)$/.exec(location.hash);
    if (m && m[1].toLowerCase() === info.vault.toLowerCase()) { history.replaceState(null, "", "sessions"); topUp(m[2], Number(m[3]) / 1e6); }
  } finally { rendering = false; }
}

function actionNames(S, mask){
  const m = BigInt(mask || 0);
  return Object.entries(S.ACTIONS).filter(([, bit]) => ((m >> BigInt(bit)) & 1n) === 1n).map(([n]) => n);
}

function card(r, S, now, mine){
  const st = r.st;
  const state = !st ? "unknown" : st.live ? "live" : (st.state === 2 ? "ended" : Number(st.expiresAt) < now ? "expired" : "revoked");
  const envs = [st && (st.envs & 1) ? "staging" : null, st && (st.envs & 2) ? "prod" : null].filter(Boolean).join(" + ") || "none";
  const budget = st ? st.balance6 + st.spent6 : 0n;
  const pct = budget > 0n ? Number((st.spent6 * 100n) / budget) : 0;
  const ops = (r.ops || 0);
  return '<div class="ss-card" data-sid="' + esc(r.sid) + '"><h3>' + esc(r.label || "session") +
    '<span class="ss-pill' + (state === "live" ? " live" : "") + '">' + esc(state) + "</span>" +
    (r.sid === mine ? '<span class="ss-pill">this browser</span>' : "") + "</h3>" +
    '<dl class="ss-facts"><dt>can</dt><dd>' + esc(actionNames(S, st ? st.actions : r.actions).join(", ") || "-") +
    "</dd><dt>environments</dt><dd>" + esc(envs) +
    "</dd><dt>budget</dt><dd>" + (st ? esc(fmtUsd(st.balance6)) + " left of " + esc(fmtUsd(budget)) + " · " + esc(fmtUsd(st.spent6)) + " spent" : "-") +
    "</dd><dt>today</dt><dd>" + (st ? esc(fmtUsd(st.periodSpent6)) + " of " + esc(fmtUsd(st.perPeriod6)) + " limit" : "-") +
    "</dd><dt>" + (state === "live" ? "expires" : "expired") + "</dt><dd>" + (st ? esc(fmtLeft(Number(st.expiresAt) - now)) : "-") +
    "</dd><dt>actions</dt><dd>" + ops + ' <button class="wp-mini ss-log-btn" type="button">log</button></dd>' +
    "<dt>id</dt><dd>" + esc(r.sid) + "</dd></dl>" +
    (budget > 0n ? '<div class="ss-meter" aria-label="budget used"><span style="width:' + Math.min(100, pct) + '%"></span></div>' : "") +
    '<div class="ss-log" hidden></div>' +
    (state === "live" ? '<div class="ss-row"><button class="btn ss-topup" type="button">Top up</button>' +
      '<button class="btn ss-extend" type="button">Extend 7 days</button>' +
      '<button class="btn ss-term" type="button">' + (r.sid === mine ? "Sign out" : "Terminate") + "</button></div>" : "") +
    "</div>";
}

function heldCard(held){
  return '<div class="ss-card"><h3>Deployments your vault holds</h3>' +
    '<p class="co-note">Sessions may change a STAGING deployment\'s version. A PRODUCTION deployment runs only what you promote, and its secrets are released only for that.</p>' +
    held.map((h) => '<dl class="ss-facts" data-dep="' + esc(h.id) + '"><dt>deployment</dt><dd>' + esc(h.id) + "</dd><dt>environment</dt><dd>" +
      (h.env === 2 ? "production" : h.env === 1 ? "staging" : "not adopted") + "</dd><dt>promoted</dt><dd>" +
      (h.env === 2 ? (h.promoted && !/^0x0+$/.test(h.promoted) ? "yes" : 'no <button class="wp-mini ss-promote" type="button">promote current</button>') : "-") + "</dd></dl>").join("") + "</div>";
}

function wire(body, info, S, rows, free){
  const w = $("#ssWithdraw");
  if (w) w.addEventListener("click", () => run(w, () => ownerOp({ op: "withdraw", amount: free }), "Withdrawn to your wallet."));
  const rv = $("#ssRevoke");
  if (rv) rv.addEventListener("click", () => {
    if (!confirm("End EVERY session that can act for this wallet, and return all of their budgets? Agents and other devices lose access immediately.")) return;
    run(rv, () => ownerOp({ op: "revokeAll", withdraw: true }), "Every session ended; budgets returned.");
  });
  body.querySelectorAll(".ss-card[data-sid]").forEach((c) => {
    const sid = c.getAttribute("data-sid");
    const r = rows.find((x) => x.sid === sid);
    const mineNow = lsGet("enclave_wallet_session") === sid;
    const t = c.querySelector(".ss-term");
    if (t) t.addEventListener("click", () => run(t, () => mineNow ? endSession() : ownerOp({ op: "terminate", sessionId: sid }), "Session ended; its budget returned."));
    const e = c.querySelector(".ss-extend");
    if (e) e.addEventListener("click", () => run(e, () => ownerOp({ op: "extend", sessionId: sid,
      expiresAt: BigInt(Math.max(Number(r.st.expiresAt), Math.floor(Date.now() / 1000)) + 7 * 86400) }), "Extended by 7 days."));
    const u = c.querySelector(".ss-topup");
    if (u) u.addEventListener("click", () => topUp(sid, 10));
    const l = c.querySelector(".ss-log-btn");
    if (l) l.addEventListener("click", async () => {
      const box = c.querySelector(".ss-log");
      if (!box.hidden){ box.hidden = true; return; }
      try {
        const d = await new S.RelayClient(relayRoot()).request("GET", "/session/" + info.vault + "/" + sid);
        const names = Object.fromEntries(Object.entries(S.ACTIONS).map(([n, b]) => [b, n]));
        box.innerHTML = (d.ops || []).slice().reverse().map((o) => "<div>" + esc(names[o.action] || ("#" + o.action)) +
          (BigInt(o.amount6 || 0) > 0n ? " · " + esc(fmtUsd(BigInt(o.amount6))) : "") + " · fee " + esc(fmtUsd(BigInt(o.fee6 || 0))) +
          ' · <a href="https://basescan.org/tx/' + esc(o.tx) + '" target="_blank" rel="noopener">tx</a></div>').join("") || "<div>No actions yet.</div>";
        box.hidden = false;
      } catch(err){ showToast(err.message); }
    });
  });
  body.querySelectorAll("[data-dep] .ss-promote").forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest("[data-dep]").getAttribute("data-dep");
    run(b, async () => {
      const cfg = await sessionsConfig();
      const S2 = await sdk();
      const pc = S2.chainClient(cfg.chainId, cfg.rpc || undefined);
      const ledger = await pc.readContract({ address: cfg.book, abi: [{ type: "function", name: "addr", stateMutability: "view",
        inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }], functionName: "addr",
        args: ["0x" + Array.from(new TextEncoder().encode("deployments"), (x) => x.toString(16).padStart(2, "0")).join("").padEnd(64, "0")] });
      const d = await pc.readContract({ address: ledger, abi: [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }],
        outputs: [{ type: "tuple", components: DEPLOYMENT }] }], functionName: "get", args: [id] }).catch(() => null);
      if (!d) throw new Error("Could not read the deployment from the ledger.");
      const catalog = await pc.readContract({ address: cfg.book, abi: [{ type: "function", name: "addr", stateMutability: "view",
        inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }], functionName: "addr",
        args: ["0x" + Array.from(new TextEncoder().encode("appCatalog"), (x) => x.toString(16).padStart(2, "0")).join("").padEnd(64, "0")] });
      const { label, app, publisher } = await versionLabel(pc, catalog, d.appRef);
      // what a session last set is what this shows: name the publisher and the exposure, never just a slug
      const me = String(Enclave.address || "").toLowerCase(), pub = String(publisher).toLowerCase();
      const v = await vaultOf(Enclave.address).catch(() => null);
      const who = pub === me ? "you" : v && pub === String(v.vault).toLowerCase() ? "your vault" : publisher + " (NOT you)";
      if (!confirm("Promote " + app + " " + label + " to production?\n\nPublished by: " + who +
        "\nConfig: " + (d.configCid || "(none)") + "\nAccess: " + (d.isPublic ? "PUBLIC - anyone can open it" : "private") +
        "\n\nIts production secrets will be released to exactly this version and config.")) throw new Error("cancelled");
      return ownerOp({ op: "promote", deployment: id, app, publisher, appRef: d.appRef, configCid: d.configCid, versionLabel: label,
        isPublic: Boolean(d.isPublic) });
    }, "Promoted.");
  }));
}

async function topUp(sid, suggest){
  const { openTopUpModal, currentSession } = await import("../core/sessions.js");
  const c = await currentSession();
  if (c && c.session.handle.sid === sid){ if (await openTopUpModal(suggest)) mount(); return; }
  // another device's / an agent's session: the same one-signature wallet top-up, aimed at that session
  const amt = Number(prompt("Top up this session with how many USD (from your wallet)?", String(suggest)) || 0);
  if (!(amt > 0)) return;
  try {
    const cfg = await sessionsConfig();
    const S = await sdk();
    const relay = new S.RelayClient(relayRoot());
    const info = await relay.request("GET", "/owner/" + Enclave.address);
    const usdc = await S.usdcDomain(S.chainClient(cfg.chainId, cfg.rpc || undefined), cfg.usdc, cfg.chainId);
    await S.topUpFromWallet({ relay, owner: S.ownerFromProvider(Enclave.provider, Enclave.address), chainId: cfg.chainId,
      vault: info.vault, sessionId: sid, amount: BigInt(Math.round(amt * 1e6)), usdc });
    showToast("Topped up.");
    mount();
  } catch(e){ showToast(e.message || String(e)); }
}

async function run(btn, fn, ok){
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Check your wallet…";
  try { await fn(); showToast(ok); mount(); }
  catch(e){ if (e && e.message !== "cancelled") showToast(e.message || String(e)); btn.disabled = false; btn.textContent = label; }
}

on("enclave:wallet", () => { if ($("#ssBody")) mount(); });
on("enclave:session", () => { if ($("#ssBody")) mount(); });

export function boot(){ mount(); }
