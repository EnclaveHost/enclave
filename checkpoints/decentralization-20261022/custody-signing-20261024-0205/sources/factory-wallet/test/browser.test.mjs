// Real-browser test (adapted from custody-wallet-handoff-20261023@7b49cd99): headless Chromium (playwright-core from the
// local enclave checkout, single process for the 512 MiB cap) opens the real page served by the real server on the fake
// two-provider Base. A fake MetaMask announces itself over EIP-6963 and records every request; eth_sendTransaction hands
// the exact transaction to the fake chain's mempool. Loopback only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FakeBase, providers, fixtureTrust, memoryJournal } from "./fake-base.mjs";
import { clientsFor } from "../rpc.mjs";
import { activationApp } from "../stage-app.mjs";
import { assets } from "../page.mjs";
import { PRODUCTION } from "../trust.mjs";

const PW = process.env.PLAYWRIGHT_CORE || "/home/steven/Projects/enclave/node_modules/playwright-core/index.mjs";
const CHROME = process.env.CHROME_BIN || "/home/steven/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell";
const available = fs.existsSync(PW) && fs.existsSync(CHROME);
const T = { timeout: 60000, skip: available ? false : `playwright-core or Chromium missing (${PW}, ${CHROME})` };
const until = async (cond, what, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await cond(); if (v) return v; if (Date.now() > end) throw Error("timeout waiting for " + what); await new Promise((r) => setTimeout(r, 50)); } };

let browser, page, cur;
test.before(async () => { if (!available) return; const { chromium } = await import(PW);
  browser = await chromium.launch({ executablePath: CHROME, headless: true,
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

async function open(t, mutate) {
  const base = new FakeBase(PRODUCTION), net = await providers(base), trust = fixtureTrust(net.urls);
  t.after(() => net.close());
  mutate?.(base); base.mine(3);
  const journal = memoryJournal();
  const app = activationApp({ trust, clients: clientsFor(net.urls, { timeoutMs: trust.rpcTimeoutMs, allowLoopback: true }), journal, assets: assets() });
  await app.listen(); t.after(async () => { await page.goto("about:blank"); await app.close(); });
  cur = { calls: [], sent: [], logs: [], base };
  await page.goto(app.origin + "/");
  const status = () => page.textContent("#status");
  await until(async () => (await page.textContent("#wallet")) === "MetaMask detected." && !/Loading/.test(await status()), "page ready");
  return { app, base, journal, status, ...cur };
}
const problems = (logs) => logs.filter((l) => /^pageerror|Content Security Policy|Refused to/.test(l));
const disabled = (id) => page.$eval("#" + id, (e) => e.disabled);

test("nothing is asked of MetaMask before clicks; Review sends exactly the journaled book.set; pending then confirmed with readback", T, async (t) => {
  const p = await open(t);
  const text = await page.textContent("main");
  assert.match(text, /4 deployments held by the administrator's SessionVault/); assert.match(text, /No simple rollback/); assert.match(text, /secretVaultV2 entry is NOT part/);
  assert.match(text, /0 ETH \(0 wei\)/);
  await new Promise((r) => setTimeout(r, 800));
  assert.deepEqual(p.calls, [], "no wallet request on load");
  assert.equal(await disabled("sign"), true);
  await page.click("#connect");
  await until(async () => !(await disabled("sign")), "review enabled");
  await page.click("#sign");
  await until(() => p.sent.length === 1, "eth_sendTransaction", 30000);
  assert.deepEqual(p.sent[0], p.journal.read().request.transaction, "MetaMask received exactly the server-prepared transaction");
  assert.equal(p.sent[0].to, PRODUCTION.book); assert.equal(p.sent[0].value, "0x0");
  assert.deepEqual(p.calls, ["eth_requestAccounts", "eth_accounts", "eth_chainId", "eth_chainId", "eth_sendTransaction"]);
  await until(async () => /Not verified yet/.test(await p.status()), "pending status");
  p.base.mine(3);
  await until(async () => /^Confirmed: 0x[0-9a-f]{64}\. The original address book's sessionVaultFactory entry is the original SessionVault factory/.test(await p.status()), "confirmed", 25000);
  assert.equal(p.journal.read().status, "confirmed"); assert.equal(p.journal.read().verification.entry, PRODUCTION.factory);
  assert.deepEqual(problems(p.logs), []);
});

test("a policy pinned to the SessionVault (new stranding): REFUSED, MetaMask is never asked to send", T, async (t) => {
  const p = await open(t, (base) => base.edit((s) => { s.policies[PRODUCTION.vaults.v2][PRODUCTION.reviewedVaultHeld[0]] = { owner: PRODUCTION.sessionVault, policyRev: 1n }; }));
  await page.click("#connect"); await until(async () => !(await disabled("sign")), "review enabled");
  await page.click("#sign");
  await until(async () => /REFUSED: deployment .* would strand it/.test(await p.status()), "refusal", 30000);
  assert.equal(p.sent.length, 0); assert.ok(!p.calls.includes("eth_sendTransaction")); assert.equal(p.journal.read().status, "ready");
  assert.deepEqual(problems(p.logs), []);
});

test("4001 resets; a lost wallet response cannot be re-sent after reload; only the real hash confirms", T, async (t) => {
  const p = await open(t);
  await page.click("#connect"); await until(async () => !(await disabled("sign")), "review enabled");
  await page.evaluate(() => { window.__reject = true; });
  await page.click("#sign");
  await until(async () => /You rejected the request in MetaMask; nothing was sent/.test(await p.status()), "rejection text", 30000);
  assert.equal(p.journal.read().status, "ready"); assert.equal(p.sent.length, 0);
  await page.evaluate(() => { window.__reject = false; window.__hang = true; });
  await until(async () => !(await disabled("sign")), "review re-enabled");
  await page.click("#sign");
  await until(() => p.calls.filter((c) => c === "eth_sendTransaction").length === 2, "wallet asked again", 30000);
  const request = p.journal.read().request;
  assert.equal(p.journal.read().status, "awaiting-wallet");
  const hash = p.base.submit(request.transaction);          // MetaMask did send it; the page never learned the hash
  await page.reload();
  await until(async () => /Do NOT send it again/.test(await p.status()), "open-attempt text");
  await page.click("#connect"); await until(() => p.calls.filter((c) => c === "eth_requestAccounts").length === 2, "reconnected");
  assert.equal(await disabled("sign"), true, "Review stays disabled while an attempt is open");
  await page.fill("#hash", "0x" + "12".repeat(32)); await page.click("#check");
  await until(async () => /neither provider returns this transaction/.test(await p.status()), "unknown hash refused");
  await page.fill("#hash", hash); await page.click("#check");
  await until(async () => /Not verified yet/.test(await p.status()), "pending");
  p.base.mine(3);
  await until(async () => !(await disabled("check")), "check enabled");
  await page.click("#check");
  await until(async () => /^Confirmed:/.test(await p.status()), "confirmed", 25000);
  assert.equal(p.sent.length, 0, "the page never re-sent anything");
  assert.deepEqual(problems(p.logs), []);
});
