// Real-browser test: headless Chromium (playwright-core from the local enclave checkout) opens the real page served by the
// real stage server on the fake two-provider Base. A fake MetaMask announces itself over EIP-6963 and records every
// request; eth_sendTransaction hands the exact transaction to the fake chain's mempool. Loopback only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FakeBase, providers, fixtureTrust, memoryJournal } from "./fake-base.mjs";
import { clientsFor } from "../rpc.mjs";
import { proposalCall } from "../stages.mjs";
import { stageApp } from "../stage-app.mjs";
import { assetsFor } from "../page.mjs";
import { PRODUCTION } from "../trust.mjs";

const PW = process.env.PLAYWRIGHT_CORE || "/home/steven/Projects/enclave/node_modules/playwright-core/index.mjs";
const CHROME = process.env.CHROME_BIN || "/home/steven/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell";
const available = fs.existsSync(PW) && fs.existsSync(CHROME);
const T = { timeout: 60000, skip: available ? false : `playwright-core or Chromium missing (${PW}, ${CHROME})` };
const until = async (cond, what, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await cond(); if (v) return v; if (Date.now() > end) throw Error("timeout waiting for " + what); await new Promise((r) => setTimeout(r, 50)); } };

// Single-process Chromium (the 512 MiB cap) cannot open a second context, so every test reuses ONE page; each test
// navigates it to its own server and swaps in its own chain and recorders.
let browser, page, cur;
test.before(async () => { if (!available) return; const { chromium } = await import(PW);
  browser = await chromium.launch({ executablePath: CHROME, headless: true,
    // one process: the whole run (node + Chromium) must stay under the 512 MiB test cap
    args: ["--single-process", "--no-zygote", "--disable-gpu", "--disable-dev-shm-usage", "--disable-extensions", "--disable-background-networking",
      "--disable-component-update", "--js-flags=--max-old-space-size=96"] });
  const ctx = await browser.newContext();
  await ctx.exposeBinding("__walletLog", (_s, m) => { cur.calls.push(m); });
  await ctx.exposeBinding("__walletSend", (_s, tx) => { cur.sent.push(tx); return cur.base.submit(tx); });
  await ctx.addInitScript(({ admin }) => {
    const provider = { isMetaMask: true, on() {}, async request({ method, params }) {
      await window.__walletLog(method);
      if (method === "eth_requestAccounts") { window.__connected = true; return [admin]; }
      if (method === "eth_accounts") return window.__connected ? [admin] : [];
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_sendTransaction") {
        if (window.__reject) throw Object.assign(new Error("MetaMask Tx Signature: User denied transaction signature."), { code: 4001 });
        if (window.__hang) return new Promise(() => {});
        return window.__walletSend(params[0]);
      }
      throw Object.assign(new Error("unsupported " + method), { code: 4200 });
    } };
    window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider",
      { detail: Object.freeze({ info: { uuid: "test", name: "MetaMask", icon: "data:,", rdns: "io.metamask" }, provider }) })));
  }, { admin: PRODUCTION.admin });
  page = await ctx.newPage();
  page.on("console", (m) => cur?.logs.push(m.type() + ": " + m.text())); page.on("pageerror", (e) => cur?.logs.push("pageerror: " + e.message));
});
test.after(async () => { await browser?.close(); });

async function world(t) {
  const base = new FakeBase(PRODUCTION), net = await providers(base), trust = fixtureTrust(net.urls);
  const w = { base, net, trust, clients: clientsFor(net.urls, { timeoutMs: trust.rpcTimeoutMs, allowLoopback: true }), journals: { fund: memoryJournal(), accept: memoryJournal() } };
  t.after(() => net.close());
  return w;
}
async function open(t, w, stage) {
  const app = stageApp({ stage, trust: w.trust, clients: w.clients, journals: w.journals, assets: assetsFor(stage) });
  await app.listen(); t.after(async () => { await page.goto("about:blank"); await app.close(); });
  cur = { calls: [], sent: [], logs: [], base: w.base };
  await page.goto(app.origin + "/");
  const status = () => page.textContent("#status");
  await until(async () => (await page.textContent("#wallet")) === "MetaMask detected." && !/Loading/.test(await status()), "page ready");
  return { app, page, ...cur, status, journal: w.journals[stage] };
}
// expected 4xx answers (NOT READY, pending) appear as "Failed to load resource"; CSP refusals and page errors may not appear at all
const problems = (logs) => logs.filter((l) => /^pageerror|Content Security Policy|Refused to/.test(l));
const disabled = (p, id) => p.page.$eval("#" + id, (e) => e.disabled);

test("fund: nothing is asked of MetaMask before clicks; Connect, Review sends exactly the journaled transaction; pending then confirmed", T, async (t) => {
  const w = await world(t), p = await open(t, w, "fund");
  const text = await p.page.textContent("main");
  assert.match(text, /not recurring app lease gas/); assert.match(text, /not decentralized custody/); assert.match(text, /0\.000005 ETH \(5000000000000 wei\)/);
  await new Promise((r) => setTimeout(r, 800));
  assert.deepEqual(p.calls, [], "no wallet request on load");
  assert.equal(await disabled(p, "sign"), true); assert.equal(await disabled(p, "connect"), false);
  await p.page.click("#connect");
  await until(async () => !(await disabled(p, "sign")), "review enabled");
  assert.deepEqual(p.calls, ["eth_requestAccounts"]); assert.match(await p.status(), /Administrator connected/);
  await p.page.click("#sign");
  await until(() => p.sent.length === 1, "eth_sendTransaction");
  assert.deepEqual(p.sent[0], p.journal.read().request.transaction, "MetaMask received exactly the server-prepared transaction");
  assert.deepEqual(p.calls, ["eth_requestAccounts", "eth_accounts", "eth_chainId", "eth_chainId", "eth_sendTransaction"]);
  await until(async () => /Not verified yet/.test(await p.status()), "pending status");
  assert.equal(p.journal.read().status, "submitted");
  w.base.mine(3);
  await until(async () => /^Confirmed: 0x[0-9a-f]{64}\. The operator was funded exactly once/.test(await p.status()), "confirmed", 20000);
  assert.equal(p.journal.read().status, "confirmed"); assert.equal(await disabled(p, "sign"), true);
  assert.deepEqual(problems(p.logs), []);
});

test("accept: NOT READY before the proposal (MetaMask never asked to send); a 4001 rejection resets; then exact acceptance confirmed", T, async (t) => {
  const w = await world(t);
  const p = await open(t, w, "accept");
  await p.page.click("#connect"); await until(async () => !(await disabled(p, "sign")), "review enabled");
  await p.page.click("#sign");
  await until(async () => /NOT READY/.test(await p.status()), "not-ready error");
  assert.equal(await p.page.$eval("#status", (e) => e.dataset.kind), "error");
  assert.equal(p.sent.length, 0); assert.ok(!p.calls.includes("eth_sendTransaction")); assert.equal(p.journal.read().status, "ready");
  await until(async () => !(await disabled(p, "sign")), "review re-enabled");
  w.base.edit((s) => { s.balance[PRODUCTION.operator] += 5_000_000_000_000n; });
  w.base.send({ ...proposalCall(w.trust), gas: 120000 }, 3);            // root's separate operator proposal
  await p.page.evaluate(() => { window.__reject = true; });
  await p.page.click("#sign");
  await until(async () => /You rejected the request in MetaMask; nothing was sent/.test(await p.status()), "rejection text");
  assert.equal(p.journal.read().status, "ready"); assert.equal(p.sent.length, 0);
  await p.page.evaluate(() => { window.__reject = false; });
  await until(async () => !(await disabled(p, "sign")), "review re-enabled after rejection");
  await p.page.click("#sign");
  await until(() => p.sent.length === 1, "eth_sendTransaction");
  assert.equal(p.sent[0].data, "0x0d85eb49" + PRODUCTION.hostId.slice(2)); assert.equal(p.sent[0].value, "0x0"); assert.equal(p.sent[0].to, PRODUCTION.ownership);
  w.base.mine(3);
  await until(async () => /^Confirmed: .*owns host metal0/.test(await p.status()), "confirmed", 20000);
  assert.equal(p.journal.read().verification.revision, "1");
  assert.deepEqual(problems(p.logs), []);
});

test("lost wallet response: after reload the open attempt cannot be re-sent; a wrong hash is refused; the real hash is checked to confirmation", T, async (t) => {
  const w = await world(t), p = await open(t, w, "fund");
  await p.page.evaluate(() => { window.__hang = true; });
  await p.page.click("#connect"); await until(async () => !(await disabled(p, "sign")), "review enabled");
  await p.page.click("#sign");
  await until(() => p.calls.includes("eth_sendTransaction"), "wallet asked");
  const request = p.journal.read().request;
  assert.equal(p.journal.read().status, "awaiting-wallet");
  const hash = w.base.submit(request.transaction);          // MetaMask did send it; the page never learned the hash
  await p.page.reload();
  await until(async () => /Do NOT send it again/.test(await p.status()), "open-attempt text");
  assert.equal(await p.page.$eval("#recover", (e) => e.hidden), false);
  await p.page.click("#connect"); await until(() => p.calls.filter((c) => c === "eth_requestAccounts").length === 2, "reconnected");
  assert.equal(await disabled(p, "sign"), true, "Review stays disabled while an attempt is open");
  await p.page.fill("#hash", "0x" + "12".repeat(32)); await p.page.click("#check");
  await until(async () => /neither provider returns this transaction/.test(await p.status()), "unknown hash refused");
  assert.equal(p.journal.read().hash, undefined);
  await p.page.fill("#hash", hash); await p.page.click("#check");
  await until(async () => /Not verified yet/.test(await p.status()), "pending");
  assert.equal(p.journal.read().hash, hash);
  w.base.mine(3);
  await until(async () => !(await disabled(p, "check")), "check enabled");
  await p.page.click("#check");
  await until(async () => /^Confirmed:/.test(await p.status()), "confirmed");
  assert.equal(p.sent.length, 0, "the page never re-sent anything");
  assert.equal(p.calls.filter((c) => c === "eth_sendTransaction").length, 1);
});
