// funding-quote-ux-r1: executable tests of the candidate /funding page (gas-fund quote UX).
// Run: node --experimental-vm-modules --test test/funding-page.test.mjs
// The page module, the REAL funding/state.js and funding/flows.js (read from the overlay, never modified) run in a vm
// context; the core (/vendor/funding.js), wallet, sessions, config and DOM are offline stubs. No network, no wallet.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (typeof vm.SourceTextModule !== "function") throw new Error("run with: node --experimental-vm-modules --test");

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, "funding.js");
const SRC = HERE;
const STATE = `${SRC}/funding/state.js`;
const FLOWS = `${SRC}/funding/flows.js`;

const OWNER = `0x${"a1".repeat(20)}`;
const OWNER_B = `0x${"b2".repeat(20)}`;
const VAULT = `0x${"c3".repeat(20)}`;
const LVAULT = `0x${"d4".repeat(20)}`;
const BOOK = `0x${"e5".repeat(20)}`;
const RELAY = "https://relay.test";
const APP = `0x${"11".repeat(32)}`;
const DEP1 = `0x${"21".repeat(32)}`;
const DEP2 = `0x${"22".repeat(32)}`;
const OLDSID = `0x${"33".repeat(32)}`;
const SID = `0x${"44".repeat(32)}`;
const T0 = 1_800_000_000;
const DRAFT_KEY = "enclave.funding.gasDraft.v1";
const CTX_KEY = `${OWNER}|8453|${VAULT}|${LVAULT}|${RELAY}`;
const DEFAULT_WEI = "20000000000000";
const PROPOSAL = { schema: "enclave-funding-migration-proposal-r1", chainId: 8453, owner: OWNER, oldSid: OLDSID, legacy6: "1000000",
  gas: [{ name: "recovery", budget6: "6000000", opsPerPeriod: "20", appIds: [APP] }], deploymentIds: [DEP1, DEP2] };

// ---- a minimal DOM: enough HTML parsing for this page (ids, data-*, value, selected, disabled, text) ------------------
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const VOID = new Set(["input", "br", "img", "hr", "meta"]);
const matcher = (sel) => {
  if (sel.startsWith("#")) return (el) => el.id === sel.slice(1);
  const m = /^\[([\w-]+)\]$/.exec(sel);
  if (m) return (el) => m[1] in el.attrs;
  throw new Error(`unsupported selector ${sel}`);
};
class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.id = attrs.id ?? "";
    this.dataset = {};
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    this.disabled = "disabled" in attrs;
    this.selected = "selected" in attrs;
    this._value = attrs.value;
    this.children = [];
    this.parent = null;
    this.root = false;
    this.listeners = {};
  }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n.root; }
  options() { return this.all().filter((x) => x.tagName === "OPTION"); }
  get value() {
    if (this.tagName !== "SELECT") return this._value ?? "";
    const o = this.options().find((x) => x.selected) ?? this.options()[0];
    return o ? (o.attrs.value ?? o.textContent.trim()) : "";
  }
  set value(v) {
    if (this.tagName !== "SELECT") { this._value = String(v); return; }
    for (const o of this.options()) o.selected = (o.attrs.value ?? o.textContent.trim()) === String(v);
  }
  set innerHTML(html) {
    for (const ch of this.children) if (typeof ch !== "string") ch.parent = null;
    this.children = [];
    parseInto(this, String(html));
  }
  get textContent() { return this.children.map((c) => (typeof c === "string" ? decode(c) : c.textContent)).join(""); }
  set textContent(t) { this.innerHTML = esc(t); }
  all() { const out = []; const walk = (n) => { for (const c of n.children) if (typeof c !== "string") { out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(sel) { return this.all().filter(matcher(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type) { return Promise.all((this.listeners[type] ?? []).map((fn) => fn({ type, target: this }))); }
}
function parseInto(root, html) {
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;
  const stack = [root];
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) top.children.push(m[4]);
    else if (m[2]) {
      const attrs = {};
      for (const a of m[3].matchAll(/([^\s=/]+)(?:="([^"]*)")?/g)) attrs[a[1].toLowerCase()] = a[2] === undefined ? "" : decode(a[2]);
      const el = new El(m[2].toLowerCase(), attrs);
      el.parent = top;
      top.children.push(el);
      if (!VOID.has(m[2].toLowerCase())) stack.push(el);
    } else if (m[1]) {
      const tag = m[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i -= 1) if (stack[i].tagName === tag) { stack.length = i; break; }
    }
  }
}

// ---- the offline world: core stub, stores, wallet ---------------------------------------------------------------------
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function makeWorld() {
  const w = {
    clock: { now: T0 * 1000 },
    enclave: { address: OWNER, chainId: 8453, provider: { request: async () => { throw new Error("no wallet prompt in these tests"); } } },
    intake: { feeTiers: [100, 500] },
    records: [{ id: "rec-1", owner: OWNER, chainId: 8453, vault: VAULT, relay: RELAY, status: "open", sid: SID,
      keyHash: `0x${"55".repeat(32)}`, grant: { apps: [APP] }, label: "Recovery gas" }],
    journal: [],
    calls: { verifyRuntime: 0, scope: 0 },
    quotes: [],
    funds: [],
    gate: null,
    failNext: null,
    nonce: 0,
  };
  class Store {
    async listKeys() { return w.records; }
    async listJournal() { return w.journal; }
    async getJournal() { return null; }
    async loadKey(id) { return w.records.find((r) => r.id === id) ?? null; }
    async putJournal() {}
    async saveKey() {}
    async casJournal() {}
  }
  w.S = { IndexedDbStore: class {}, RelayClient: class { constructor(base) { this.base = base; } } };
  w.core = {
    PRE_FUNDING_API: "pre",
    jsonRpc: (url) => ({ url }),
    relayClient: () => async () => { throw new Error("the relay is not used by the stubbed core"); },
    legacyChain: () => ({}),
    IndexedDbV2Store: Store,
    parseRuntimePins: (p) => p,
    controlsTarget: (pins, owner) => ({ owner, vault: VAULT }),
    listGasExecutions: () => [],
    async verifyRuntime() {
      w.calls.verifyRuntime += 1;
      return { cfg: { vault: VAULT, legacyVault: LVAULT }, intake: w.intake, intakeWhy: w.intake ? null : "operator paused intake" };
    },
    async freshRecoveryScope({ now, deploymentIds }) {
      w.calls.scope += 1;
      return { deployments: new Map(deploymentIds.map((d) => [d, { appId: APP, holder: OWNER, env: 2, active: true }])),
        appIds: [APP], timestamp: BigInt(now) };
    },
    selectGasRecord(records, scope, deployment) {
      const e = scope.deployments.get(deployment);
      if (!e) throw Object.assign(new Error("deployment not in scope"), { code: "deployment_out_of_scope" });
      const open = records.filter((r) => r.status === "open" && r.grant.apps.includes(e.appId));
      if (open.length !== 1) throw Object.assign(new Error("no single open grant"), { code: "matching_grant_not_open" });
      return open[0];
    },
    // Same staleness rule as the real core: a scope older than 120 s is refused (scope_stale).
    async quoteGasFund({ record, scope, deployment, ethOut, feeTier, now }) {
      w.quotes.push({ at: Number(now), scopeAt: Number(scope.timestamp), verifyRuntimeCalls: w.calls.verifyRuntime, deployment, ethOut: String(ethOut), feeTier });
      if (BigInt(now) > BigInt(scope.timestamp) + 120n) throw Object.assign(new Error("the recovery scope was read too long ago; re-read it before quoting"), { code: "scope_stale" });
      if (w.failNext) { const err = w.failNext; w.failNext = null; throw err; }
      if (w.gate) await w.gate.promise;
      w.nonce += 1;
      return { deployment, sid: record.sid,
        call: { digest: `0x${w.nonce.toString(16).padStart(64, "0")}`, intent: { ethOut: String(ethOut), fee: feeTier },
          execute: { deadline: BigInt(now) + 300n, nonce: BigInt(w.nonce), fee: 20000n } },
        totals: { maxUsdcIn6: 50000n, fee6: 20000n, totalMaximum6: 70000n, balance6: 6000000n } };
    },
    async confirmGasFund({ review, record, dispatchGuard }) {
      dispatchGuard();
      w.funds.push({ digest: review.call.digest, ethOut: review.call.intent.ethOut, recordId: record.id });
      return { pending: true };
    },
  };
  return w;
}

const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

/** A fresh page load (new module instance) over `storage` (the tab's sessionStorage) and `world`. */
async function boot({ storage = new Map(), world = makeWorld() } = {}) {
  const body = new El("body");
  body.root = true;
  body.innerHTML = "<main><div id=\"fdBody\"></div></main>";
  const timers = new Map();
  let tid = 0;
  const toasts = [];
  const handlers = {};
  const context = vm.createContext({
    __clock: world.clock,
    console,
    sessionStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => { storage.set(k, String(v)); }, removeItem: (k) => { storage.delete(k); } },
    setInterval: (fn, ms) => { tid += 1; timers.set(tid, { fn, ms }); return tid; },
    clearInterval: (id) => { timers.delete(id); },
  });
  vm.runInContext("Date.now = () => globalThis.__clock.now;", context);
  const synth = (id, exp) => {
    const m = new vm.SyntheticModule(Object.keys(exp), () => { for (const [k, v] of Object.entries(exp)) m.setExport(k, v); }, { context, identifier: id });
    return m;
  };
  const empty = synth("empty", {});
  const state = new vm.SourceTextModule(readFileSync(STATE, "utf8"), { context, identifier: pathToFileURL(STATE).href });
  const flows = new vm.SourceTextModule(readFileSync(FLOWS, "utf8"), { context, identifier: pathToFileURL(FLOWS).href });
  const mods = {
    "../../components/header/header.js": empty,
    "../../components/footer/footer.js": empty,
    "../../components/toast/toast.js": empty,
    "../core/api.js": synth("api", { Enclave: world.enclave, WALLET_SESSION_KEY: "wallet_session" }),
    "../core/wallet.js": synth("wallet", { connectWallet: async () => {} }),
    "../core/util.js": synth("util", { $: (s, r) => (r || body).querySelector(s), esc, lsGet: () => null, lsSet: () => {}, emit: () => {},
      on: (ev, fn) => { (handlers[ev] ??= []).push(fn); }, showToast: (msg) => { toasts.push(String(msg)); } }),
    "../core/sessions.js": synth("sessions", { sdk: async () => world.S, sessionsConfig: async () => ({ rpc: "https://rpc.test", book: BOOK }),
      relayRoot: () => RELAY, accountFromSession: async () => {} }),
    "../core/config.js": synth("config", { APP_CATALOG_RPCS: ["https://rpc.test"], FUNDING_RUNTIME: { pins: "test" }, FUNDING_MIGRATION_PROPOSAL: PROPOSAL,
      FUNDING_MIGRATION_APPROVAL: null, FUNDING_MIGRATION_CUTOVER: null, FUNDING_CUTOVER_ACTIVATION: null }),
    "../funding/state.js": state,
    "./state.js": state,
    "../funding/flows.js": flows,
  };
  const core = synth("/vendor/funding.js", world.core);
  await core.link(() => { throw new Error("the core stub has no imports"); });
  await core.evaluate();
  const page = new vm.SourceTextModule(readFileSync(PAGE, "utf8"), { context, identifier: pathToFileURL(PAGE).href,
    importModuleDynamically: async (spec) => { if (spec !== "/vendor/funding.js") throw new Error(`unexpected dynamic import ${spec}`); return core; } });
  await page.link(async (spec) => { const m = mods[spec]; if (!m) throw new Error(`unexpected import ${spec}`); return m; });
  await page.evaluate();
  page.namespace.boot();
  await flush();
  return {
    world, storage, timers, toasts, body,
    $: (s) => body.querySelector(s),
    tick: () => { for (const [, t] of [...timers]) t.fn(); },
    wallet: async () => { for (const fn of handlers["enclave:wallet"] ?? []) fn({}); await flush(); },
  };
}
const text = (h, sel) => h.$(sel).textContent.replace(/\s+/g, " ");
const click = (h, sel) => { const el = h.$(sel); assert.ok(el, `${sel} is rendered`); return el.fire("click"); };
async function type(h, sel, v) { const el = h.$(sel); el.value = v; await el.fire("input"); await el.fire("change"); }

// ---- tests ------------------------------------------------------------------------------------------------------------

test("Get quote after idle re-verifies the context and re-reads the finite scope (no scope_stale)", async () => {
  const h = await boot();
  assert.equal(h.$("#fdQuoteOut").dataset.state, "none");
  assert.match(text(h, "#fdQuoteOut"), /No quote yet\. Press Get quote to see the exact gas maximum/);
  assert.equal(h.$("#fdFund").disabled, true);
  const runtimeBefore = h.world.calls.verifyRuntime;
  const scopeBefore = h.world.calls.scope;
  h.world.clock.now += 600_000;                         // idle 10 minutes: the render-time scope is far past 120 s
  await click(h, "#fdQuote");
  assert.equal(h.world.quotes.length, 1);
  const q = h.world.quotes[0];
  assert.equal(q.scopeAt, q.at, "the quote used a scope read at the click");
  assert.ok(q.verifyRuntimeCalls > runtimeBefore, "the context was re-verified before quoting");
  assert.ok(h.world.calls.scope > scopeBefore);
  assert.equal(q.ethOut, DEFAULT_WEI);
  assert.equal(h.$("#fdQuoteOut").dataset.state, "ready");
  assert.equal(h.$("#fdQuoteOut").dataset.digest, `0x${"1".padStart(64, "0")}`);
  assert.equal(h.$("#fdFund").disabled, false);
  assert.ok(h.toasts.includes("Quote ready: review it, then fund."));
  assert.ok(!h.toasts.some((t) => t.startsWith("scope_stale")));
});

test("countdown ticks once a second, price stays fixed, expiry disables Fund with a fresh-quote instruction", async () => {
  const h = await boot();
  await click(h, "#fdQuote");
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].ms, 1000);
  assert.equal(h.$("#fdQuoteLeft").textContent, "usable for 285s more");
  const review = () => text(h, "#fdQuoteOut").replace(/usable for \d+s more/, "");
  const before = review();
  const digest = h.$("#fdQuoteOut").dataset.digest;
  h.world.clock.now += 1000;
  h.tick();
  assert.equal(h.$("#fdQuoteLeft").textContent, "usable for 284s more");
  assert.equal(review(), before, "amounts and call digest are unchanged by the countdown");
  assert.equal(h.$("#fdQuoteOut").dataset.digest, digest);
  assert.equal(h.$("#fdFund").disabled, false);
  h.world.clock.now += 284_000;                         // 15 s before the deadline: no longer usable
  h.tick();
  assert.equal(h.$("#fdQuoteOut").dataset.state, "expired");
  assert.equal(h.$("#fdQuoteOut").dataset.digest, "");
  assert.equal(h.$("#fdFund").disabled, true);
  assert.match(text(h, "#fdQuoteOut"), /This quote has expired .*Nothing was signed or sent\. Press Get quote for a fresh quote\./);
  assert.equal(h.timers.size, 0, "the countdown stops at expiry");
  h.tick();
  assert.equal(h.$("#fdQuoteOut").dataset.state, "expired", "no automatic re-quote");
  assert.equal(h.world.quotes.length, 1);
  await click(h, "#fdFund");                            // even a forced click cannot use the expired quote
  assert.equal(h.world.funds.length, 0);
  assert.ok(h.toasts.some((t) => t.startsWith("quote_stale")));
  await click(h, "#fdQuote");
  assert.equal(h.$("#fdQuoteOut").dataset.state, "ready");
  assert.equal(h.world.quotes.length, 2);
});

test("countdown timers are cleaned up on re-render, wallet events, input changes and detached DOM", async () => {
  const h = await boot();
  await click(h, "#fdQuote");
  assert.equal(h.timers.size, 1);
  await click(h, "#fdQuote");                           // re-render after a new quote: still exactly one timer
  assert.equal(h.timers.size, 1);
  await h.wallet();                                     // re-mount: the quote is dropped, no timer survives
  assert.equal(h.timers.size, 0);
  assert.equal(h.$("#fdQuoteOut").dataset.state, "none");
  await click(h, "#fdQuote");
  assert.equal(h.timers.size, 1);
  await type(h, "#fdEth", "30000000000000");            // input change drops the quote
  assert.equal(h.timers.size, 0);
  assert.equal(h.$("#fdFund").disabled, true);
  assert.match(text(h, "#fdQuoteOut"), /Choices changed; the previous quote was dropped\./);
  await click(h, "#fdQuote");
  assert.equal(h.timers.size, 1);
  h.body.innerHTML = "<main></main>";                   // the page's DOM is gone
  h.tick();
  assert.equal(h.timers.size, 0);
});

test("typed inputs survive re-render, failed quotes and reload for the exact context only; default unchanged otherwise", async () => {
  const storage = new Map();
  const h = await boot({ storage });
  assert.equal(h.$("#fdEth").value, DEFAULT_WEI);
  assert.equal(storage.size, 0, "nothing is persisted without explicit input");
  await type(h, "#fdEth", "123456789");
  await type(h, "#fdTier", "500");
  await type(h, "#fdDep", DEP2);
  await h.wallet();                                     // re-mount, same owner and chain
  assert.equal(h.$("#fdEth").value, "123456789");
  assert.equal(h.$("#fdTier").value, "500");
  assert.equal(h.$("#fdDep").value, DEP2);
  const saved = JSON.parse(storage.get(DRAFT_KEY));
  assert.deepEqual(Object.keys(saved).sort(), ["ctxKey", "deployment", "ethOut", "feeTier"], "plain inputs only");
  assert.deepEqual(saved, { ctxKey: CTX_KEY, deployment: DEP2, ethOut: "123456789", feeTier: "500" });

  const r = await boot({ storage });                    // reload: new page instance, same tab storage
  assert.equal(r.$("#fdEth").value, "123456789");
  assert.equal(r.$("#fdTier").value, "500");
  r.world.failNext = Object.assign(new Error("relay busy"), { code: "relay_unreachable" });
  await click(r, "#fdQuote");
  assert.equal(r.$("#fdEth").value, "123456789", "a failed quote does not reset the amount");
  assert.match(text(r, "#fdQuoteOut"), /The last quote attempt failed \(relay_unreachable: relay busy\)\. Nothing was signed or sent\. Press Get quote to try again\./);
  assert.equal(r.$("#fdFund").disabled, true);
  await click(r, "#fdQuote");
  assert.deepEqual({ ...r.world.quotes[1] }, { ...r.world.quotes[1], deployment: DEP2, ethOut: "123456789", feeTier: 500 });
  assert.equal(r.$("#fdQuoteOut").dataset.state, "ready");

  const other = new Map([[DRAFT_KEY, JSON.stringify({ ctxKey: `${OWNER_B}|8453|${VAULT}|${LVAULT}|${RELAY}`, deployment: DEP2, ethOut: "5", feeTier: "500" })]]);
  const o = await boot({ storage: other });
  assert.equal(o.$("#fdEth").value, DEFAULT_WEI, "another context's draft is never used");
  assert.equal(other.size, 0, "and it is dropped");
});

test("a wallet change drops the stored draft; switching back shows the default", async () => {
  const storage = new Map();
  const h = await boot({ storage });
  await type(h, "#fdEth", "777");
  assert.equal(storage.size, 1);
  h.world.enclave.address = OWNER_B;
  await h.wallet();
  assert.equal(storage.size, 0);
  assert.match(text(h, "#fdGas"), /Not available here\./);
  h.world.enclave.address = OWNER;
  await h.wallet();
  assert.equal(h.$("#fdEth").value, DEFAULT_WEI);
});

test("inputs changed while a quote is pending: the quote is discarded and cannot be funded", async () => {
  const h = await boot();
  h.world.gate = deferred();
  const pending = h.$("#fdQuote").fire("click");
  await flush();
  assert.equal(h.$("#fdQuoteOut").dataset.state, "pending");
  assert.equal(h.$("#fdFund").disabled, true);
  await type(h, "#fdEth", "999");
  h.world.gate.resolve();
  await pending;
  assert.equal(h.world.quotes[0].ethOut, DEFAULT_WEI, "the request used the inputs captured at the click");
  assert.equal(h.$("#fdEth").value, "999");
  assert.equal(h.$("#fdQuoteOut").dataset.state, "none");
  assert.equal(h.$("#fdQuoteOut").dataset.digest, "");
  assert.equal(h.$("#fdFund").disabled, true);
  assert.ok(h.toasts.some((t) => t.startsWith("quote_inputs_changed")));
  assert.ok(!h.toasts.includes("Quote ready: review it, then fund."));
  assert.equal(h.timers.size, 0);
  await click(h, "#fdFund");
  assert.equal(h.world.funds.length, 0);
});

test("a wallet change while a quote is pending: nothing is kept or rendered for the old context", async () => {
  const storage = new Map();
  const h = await boot({ storage });
  await type(h, "#fdEth", "4242");
  h.world.gate = deferred();
  const pending = h.$("#fdQuote").fire("click");
  await flush();
  h.world.enclave.address = OWNER_B;
  await h.wallet();
  h.world.gate.resolve();
  await pending;
  await flush();
  assert.ok(h.toasts.some((t) => t.startsWith("context_changed")));
  assert.ok(!h.toasts.includes("Quote ready: review it, then fund."));
  assert.match(text(h, "#fdGas"), /Not available here\./);
  assert.equal(h.$("#fdQuoteOut"), null);
  assert.equal(storage.size, 0);
  assert.equal(h.timers.size, 0);
  h.world.enclave.address = OWNER;
  await h.wallet();
  assert.equal(h.$("#fdQuoteOut").dataset.state, "none");
  assert.equal(h.$("#fdEth").value, DEFAULT_WEI);
  assert.equal(h.$("#fdFund").disabled, true);
});

test("Fund sends exactly the shown quote once, never re-quotes, then asks for a new quote", async () => {
  const h = await boot();
  await click(h, "#fdQuote");
  const shown = h.$("#fdQuoteOut").dataset.digest;
  const quotes = h.world.quotes.length;
  h.world.clock.now += 60_000;                          // the click-time scope is now older than 120 s; Fund does not re-quote
  h.tick();
  assert.equal(h.$("#fdQuoteLeft").textContent, "usable for 225s more");
  await click(h, "#fdFund");
  assert.deepEqual(h.world.funds, [{ digest: shown, ethOut: DEFAULT_WEI, recordId: "rec-1" }]);
  assert.equal(h.world.quotes.length, quotes);
  assert.ok(h.toasts.includes("Sent, not on chain yet: see Gas payments (it is never resent)"));
  assert.equal(h.$("#fdQuoteOut").dataset.state, "none");
  assert.match(text(h, "#fdQuoteOut"), /That quote was used once\. Press Get quote for another payment\./);
  assert.equal(h.$("#fdFund").disabled, true);
  await click(h, "#fdFund");
  assert.equal(h.world.funds.length, 1, "single use");
});

test("intake off: gas funding paused, owner controls unchanged, no quote UI or timer", async () => {
  const w = makeWorld();
  w.intake = null;
  const h = await boot({ world: w });
  assert.match(text(h, "#fdGas"), /New gas funding is paused \(operator paused intake\)\. Your controls above still work\./);
  assert.ok(h.$("#fdWd"));
  assert.ok(h.$("[data-term]"));
  assert.ok(h.$("[data-end]"));
  assert.equal(h.$("#fdQuote"), null);
  assert.equal(h.timers.size, 0);
});
