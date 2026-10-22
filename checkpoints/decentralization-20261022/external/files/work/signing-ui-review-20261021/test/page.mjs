// A browserless page for app.js: the elements index.html declares, localStorage, confirm, EIP-6963/window.ethereum, fetch to
// the REAL handoff server over loopback (relative paths, same Origin as a browser sends), and a mocked EIP-1193 provider whose
// eth_sendTransaction the test controls. Timers run fast (ms / 1000) so 5-s and 10-s loops stay bounded.
// Teardown is deterministic: stop() sets `closed` (no timer, fetch or provider call can start afterwards), aborts in-flight
// fetches, rejects the open wallet request as a disposed page would, clears timers, then awaits every clicked handler.
import fs from "node:fs";
import vm from "node:vm";
const IDS = ["wallet", "connect", "start", "current", "current-title", "current-detail", "status", "recovery", "recovery-text", "hash", "check", "release", "ops", "transaction", "owner", "plan", "progress"];
function element(id) {
  return { id, textContent: id === "status" ? "Loading…" : "", hidden: ["current", "recovery", "release"].includes(id), disabled: ["connect", "start"].includes(id), value: "", className: "",
    children: [], onclick: null, replaceChildren() { this.children = []; }, append(...c) { this.children.push(...c); } };
}
export function page({ src, origin, chainId, owner, storage = new Map(), confirmAnswer = true, skewMs = 0 }) {
  // the page clock (Date.now / new Date()) may run ahead to expire a prepared request; the server clock is untouched
  const PageDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(Date.now() + skewMs); } static now() { return Date.now() + skewMs; } };
  const els = Object.fromEntries(IDS.map((i) => [i, element(i)]));
  const calls = [], posts = [], confirms = [], inflight = new Set(), ac = new AbortController();
  let sendTx = null, closed = false;      // the test resolves/rejects sendTx
  const disposed = () => Object.assign(Error("page closed"), { code: -32603 });
  const provider = { isMetaMask: true, async request({ method, params }) {
    if (closed) throw disposed();
    calls.push(method);
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [owner];
    if (method === "eth_chainId") return chainId;
    if (method === "eth_sendTransaction") return new Promise((resolve, reject) => { sendTx = { tx: params[0], resolve, reject }; });
    throw Object.assign(Error("unexpected " + method), { code: 4200 });
  } };
  const timers = new Set();
  const ctx = {
    document: { getElementById: (i) => els[i], createElement: () => ({ textContent: "", className: "", children: [], append(...c) { this.children.push(...c); } }) },
    window: { addEventListener() {}, dispatchEvent() {}, ethereum: provider },
    Event: class { constructor(t) { this.type = t; } },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    confirm: (m) => { confirms.push(m); return typeof confirmAnswer === "function" ? confirmAnswer(m) : confirmAnswer; },
    fetch: async (p, init = {}) => { if (closed) throw disposed(); if (init.method === "POST") posts.push(p);
      return fetch(origin + p, { ...init, signal: ac.signal, headers: { ...(init.headers || {}), ...(init.method === "POST" ? { origin } : {}) } }); },
    setTimeout: (f, ms) => { if (closed) return 0; const t = setTimeout(() => { timers.delete(t); if (!closed) f(); }, Math.ceil((ms || 0) / 1000)); timers.add(t); return t; },
    setInterval: (f, ms) => { if (closed) return 0; const t = setInterval(() => { if (!closed) f(); }, Math.max(5, Math.ceil((ms || 0) / 1000))); timers.add(t); return t; },
    clearTimeout: (t) => { clearTimeout(t); timers.delete(t); },
    clearInterval: (t) => { clearInterval(t); timers.delete(t); },
    Date: PageDate, JSON, Object, Error, BigInt, Number, String, Promise, Math, console,
  };
  ctx.window.window = ctx.window; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(src, "utf8"), ctx, { filename: src });
  return { els, calls, posts, confirms, ctx, get sendTx() { return sendTx; }, storage,
    click(id) { if (closed) throw Error("click after stop"); const r = Promise.resolve(els[id].onclick()); inflight.add(r); r.finally(() => inflight.delete(r)).catch(() => {}); return r; },
    async stop() {
      if (closed) return; closed = true; ac.abort(); sendTx?.reject(disposed());
      for (const t of timers) { clearTimeout(t); clearInterval(t); } timers.clear();
      // every handler must settle on its own now that nothing can start; a hang is a FAILURE, never a pass
      let w; const limit = new Promise((_, rej) => { w = setTimeout(() => rej(Error("page handlers did not settle after stop")), 3000); });
      try { await Promise.race([Promise.allSettled([...inflight]), limit]); } finally { clearTimeout(w); }
      if (timers.size) throw Error("a timer was scheduled after stop");
    } };
}
export const until = async (cond, what, ms = 8000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw Error("timeout waiting for " + what); await new Promise((r) => setTimeout(r, 5)); } };
