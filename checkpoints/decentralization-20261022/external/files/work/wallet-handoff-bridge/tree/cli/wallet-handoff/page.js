// The handoff page's script. It never builds a transaction: the CLI process that served it supplies the exact
// parameters of one journaled intent, once, after rechecking the chain. The page checks the wallet's account and
// chain, asks MetaMask (EIP-1193 eth_sendTransaction) exactly once per intent, and reports back either the hash or an
// explicit 4001 rejection. Everything else it shows comes from the CLI and is rendered as text.
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const tokenMatch = /(?:^#|&)token=([A-Za-z0-9_-]{20,})/.exec(location.hash);
  if (tokenMatch) { sessionStorage.setItem("handoff-token", tokenMatch[1]); history.replaceState(null, "", "/"); }
  const token = sessionStorage.getItem("handoff-token");
  let provider = null, state = null, busy = false, timer = null;
  const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  const short = (s) => String(s || "").split("\n")[0].slice(0, 240);
  const gwei = (h) => { const n = BigInt(h); const w = n / 1000000000n, f = (n % 1000000000n).toString().padStart(9, "0").replace(/0+$/, ""); return f ? `${w}.${f}` : `${w}`; };
  const eth = (wei) => { const n = BigInt(wei); const w = n / 10n ** 18n, f = (n % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, ""); return f ? `${w}.${f}` : `${w}`; };

  function say(text, bad = false) { const s = $("status"); s.textContent = text; s.className = bad ? "bad" : ""; }
  function alertBox(text) { const a = $("alert"); a.hidden = !text; a.textContent = text || ""; }
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else if (k.startsWith("data-")) n.setAttribute(k, v); else n[k] = v;
    for (const k of kids) if (k) n.append(k);
    return n;
  }
  async function api(path, body) {
    const r = await fetch(path, { method: body ? "POST" : "GET", cache: "no-store", credentials: "omit",
      headers: { "x-handoff-token": token || "", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok) throw Object.assign(new Error(j.error || `the CLI answered HTTP ${r.status}`), { status: r.status, claimed: !!j.claimed });
    return j;
  }

  // ---- MetaMask (EIP-6963 first, the injected provider as a fallback) ----
  function found(p) { if (provider) return; provider = p; $("wallet").textContent = "MetaMask detected (not connected)."; $("connect").disabled = false; walletCheck(); }
  window.addEventListener("eip6963:announceProvider", (e) => { if (e.detail?.info?.rdns === "io.metamask") found(e.detail.provider); });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  setTimeout(() => {
    if (provider) return;
    const p = window.ethereum?.providers?.find((x) => x.isMetaMask) || window.ethereum;
    if (p?.isMetaMask) found(p); else $("wallet").textContent = "MetaMask was not found. Open this page in the browser where MetaMask is installed and allowed on this site.";
  }, 600);

  /** -> { ok, why }: the wallet's selected account and chain are exactly the ones this release is for. Asks nothing new. */
  async function walletCheck() {
    if (!provider || !state) return { ok: false, why: "MetaMask is not available yet." };
    let accounts, chain;
    try { [accounts, chain] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]); }
    catch (e) { return { ok: false, why: `MetaMask did not answer (${short(e.message)}).` }; }
    const a = accounts?.[0];
    let why = null;
    if (!a) why = "Connect MetaMask first.";
    else if (!same(a, state.from)) why = `MetaMask's selected account is ${a}. Select ${state.from} in MetaMask.`;
    else if (!same(chain, state.chainHex)) why = `MetaMask is on chain ${parseInt(chain, 16)}. Switch MetaMask to Base (chain ${state.chainId}).`;
    $("wallet").textContent = why ? why : `Connected: ${a} on chain ${state.chainId}.`;
    $("wallet").className = why ? "bad" : "ok";
    $("connect").disabled = !!a && !why;
    return { ok: !why, why };
  }
  $("connect").onclick = async () => {
    $("connect").disabled = true;
    try { await provider.request({ method: "eth_requestAccounts" }); } catch (e) { say(e?.code === 4001 ? "You declined the connection in MetaMask." : `MetaMask: ${short(e?.message)}`, true); }
    await walletCheck(); render();
  };

  // ---- actions ----
  async function act(fn) {
    if (busy) return;
    busy = true; render();
    try { await fn(); } catch (e) { say(e.message, true); } finally { busy = false; await refresh(); }
  }
  const prepare = (step) => act(async () => { say("Rechecking the chain and preparing the exact transaction…"); await api("/api/prepare", { step }); say("Prepared. Review the exact transaction below, then send it to MetaMask."); });
  const discard = (intent) => act(async () => { await api("/api/discard", { intent }); say("The unsent request was discarded. Nothing was sent."); });
  const resolve = (intent) => act(async () => { say("Asking the RPC quorum…"); const v = await api("/api/resolve", { intent }); say(`Status: ${v.state}${v.hash ? ` (${v.hash})` : ""}.`); });
  const send = (intent) => act(async () => {
    const w = await walletCheck();
    if (!w.ok) throw new Error(w.why);
    say("Rechecking the chain at a fresh agreed block before asking MetaMask…");
    const claim = await api("/api/claim", { intent });      // the only time these parameters are released
    say("Review the transaction in MetaMask and approve or reject it there. It is asked once: do not reload this page while MetaMask is open.");
    let hash;
    try { hash = await provider.request({ method: "eth_sendTransaction", params: [claim.params] }); }
    catch (e) {
      if (e?.code === 4001) { await api("/api/rejected", { intent, ticket: claim.ticket, code: 4001 }); say("You rejected the request in MetaMask. Nothing was sent."); return; }
      say(`MetaMask did not answer clearly (${e?.code ?? "no code"}: ${short(e?.message)}). The request may still be open in MetaMask, or may have been sent: it is NOT sent again. `
        + "Decide it in MetaMask, then use “Check on chain”; if MetaMask shows a transaction hash, attach it from the CLI (run.mjs attach).", true);
      return;
    }
    say(`MetaMask returned ${hash}. The RPC quorum is verifying it…`);
    await api("/api/attach", { intent, ticket: claim.ticket, hash });
  });
  $("refresh").onclick = () => act(async () => { await refresh(true); });

  // ---- rendering ----
  function txView(v) {
    const p = v.params;
    const dl = el("dl", { class: "tx" });
    const row = (k, val, mono = true) => dl.append(el("dt", { text: k }), el("dd", { class: mono ? "mono" : "", text: val }));
    row("From", p.from); row("To (contract)", p.to); row("Value", `${eth(p.value)} ETH`, false); row("Network", `chain ${parseInt(p.chainId, 16)}`, false);
    row("Nonce", String(parseInt(p.nonce, 16)), false); row("Gas limit", String(BigInt(p.gas)), false);
    row("Max fee per gas", `${gwei(p.maxFeePerGas)} gwei`, false); row("Max priority fee", `${gwei(p.maxPriorityFeePerGas)} gwei`, false);
    row("Most it can cost", `${eth(v.maxNetworkFeeWei)} ETH network fee`, false);
    row("Data", `${v.calldataBytes} bytes, keccak256 ${v.calldataKeccak}`);
    return el("div", {}, dl, el("details", {}, el("summary", { text: "Exact parameters sent to MetaMask" }), el("pre", { text: JSON.stringify(p, null, 2) })));
  }
  function intentBlock(s) {
    const v = s.intent;
    if (!v) return null;
    const box = el("div");
    const line = (t, cls = "") => box.append(el("p", { class: cls, text: t }));
    const btns = el("div", { class: "actions" });
    const b = (label, onClick, primary = false) => btns.append(el("button", { type: "button", class: primary ? "primary" : "", text: label, disabled: busy, onclick: onClick }));
    if (v.state === "handoff" && !v.claimed) {
      line(`Prepared intent ${v.id} at nonce ${v.nonce}. Nothing has been sent or asked of MetaMask yet.`);
      box.append(txView(v));
      b("Review in MetaMask", () => send(v.id), true); b("Discard this unsent request", () => discard(v.id));
    } else if (v.state === "handoff") {
      line(`Intent ${v.id} was handed to MetaMask${v.walletRequestedAt ? ` at ${new Date(v.walletRequestedAt).toLocaleString()}` : ""}. Its outcome is not known here yet.`, "bad");
      line("Approve or reject it in MetaMask. It is never offered again automatically. If MetaMask's request is gone, “Check on chain” finds it by its nonce; "
        + "if MetaMask shows its hash: run.mjs attach " + v.id + " <hash>. Only after the chain shows the nonce unused may you abandon it from the CLI.");
      box.append(txView(v)); b("Check on chain", () => resolve(v.id));
    } else if (v.open) {
      line(`Intent ${v.id}: ${v.state}${v.hash ? `, transaction ${v.hash}` : ""}. ${v.verifying ? "The RPC quorum is verifying it…" : "Not confirmed yet."}`, v.verifying ? "" : "bad");
      if (v.lastError) line(v.lastError, "bad");
      box.append(txView(v)); b("Check on chain", () => resolve(v.id));
    } else if (v.state === "confirmed") line(`Confirmed: ${v.hash} in block ${v.minedBlock ?? "?"}, verified by the RPC quorum${v.adjusted?.length ? ` (MetaMask changed ${v.adjusted.join(", ")})` : ""}.`, "ok");
    else if (v.state === "mismatch") line(`THE WALLET SENT A DIFFERENT TRANSACTION (${v.hash}). It is mined; nothing that depends on it was done. ${v.note || ""}`, "bad");
    else line(`Intent ${v.id}: ${v.state}. ${v.note || ""}`, v.state === "rejected" ? "" : "bad");
    if (btns.childElementCount) box.append(btns);
    return box;
  }
  function render() {
    if (!state) return;
    $("title").textContent = `${state.plan.app} ${state.plan.version}: publish, then upgrade ${state.plan.label}`;
    $("network").textContent = `Base · chain ${state.chainId}`;
    $("account").textContent = state.from;
    const warn = [...state.blocking.map((x) => `Intent ${x.id} (${x.state}, nonce ${x.nonce}) for this account is unresolved and was not prepared here: settle it with the CLI first.`),
      ...state.unreadable.map((x) => `Journal file ${x.id}.json cannot be read (${x.why}): every send is blocked until it is reviewed.`)];
    alertBox(warn.join(" "));
    const root = $("steps"); root.replaceChildren();
    state.steps.forEach((s, i) => {
      const v = s.verdict;
      const verdict = v.state === "done" ? `Done on chain (agreed block ${v.block?.number ?? "?"}).` : v.state === "ready" ? `Ready (checked at agreed block ${v.block?.number}).`
        : v.state === "blocked" ? `Not available: ${v.reason}` : `Chain quorum unavailable: ${v.reason}`;
      const card = el("section", { class: "step" }, el("h2", { text: `Step ${i + 1}. ${s.title}` }), el("p", { class: `verdict ${v.state}`, text: verdict }),
        el("ul", { class: "effects" }, ...s.effects.map((t) => el("li", { text: t }))),
        el("p", {}, ...s.links.filter((l) => /^https?:\/\//.test(l.href)).flatMap((l, j) => [j ? " · " : "", el("a", { href: l.href, text: l.text, target: "_blank", rel: "noopener noreferrer" })])));
      const ib = intentBlock(s);
      if (ib) card.append(ib);
      if (s.canPrepare && !(s.intent && s.intent.open)) card.append(el("div", { class: "actions" }, el("button", { type: "button", class: "primary", text: "Prepare the exact transaction", disabled: busy, onclick: () => prepare(s.id) })));
      root.append(card);
    });
    $("refresh").disabled = busy;
  }
  async function refresh(fresh = false) {
    if (!token) { say("This page needs the link the CLI printed (it carries a one-time token after #).", true); return; }
    try { state = await api(`/api/state${fresh ? "?fresh=1" : ""}`); render(); await walletCheck(); }
    catch (e) { say(e.message, true); }
    clearTimeout(timer);
    const active = state?.steps.some((s) => s.intent?.open);
    timer = setTimeout(() => { if (!busy) refresh(); }, active ? 4000 : 15000);
  }
  refresh();
})();
