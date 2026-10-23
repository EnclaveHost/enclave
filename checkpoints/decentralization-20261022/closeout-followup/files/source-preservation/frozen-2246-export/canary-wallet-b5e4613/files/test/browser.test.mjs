// Real-browser test (adapted from custody-factory-wallet test/browser.test.mjs): headless Chromium (playwright-core from
// the local enclave checkout, single process for the 512 MiB cap) opens the real page served by the real server over
// anvil + the fake relay/gateway. A fake MetaMask announces itself over EIP-6963 and records every request:
// personal_sign signs with an EPHEMERAL test key (the upload signer of the fixture trust), eth_sendTransaction sends
// the exact transaction from the production administrator address by anvil impersonation. Hardware-wallet failures are
// simulated with the JSON-RPC internal error a disconnected Trezor surfaces through MetaMask (-32603). Loopback only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hexToString } from "viem";
import { startChain, startUploadServices, memoryJournal, fixtureTrust, ephemeralSigner, instantClock } from "./env.mjs";
import { canaryApp } from "../stage-app.mjs";
import { makePreparer } from "../publish-stage.mjs";
import { clientsFor } from "../rpc.mjs";
import { assets } from "../page.mjs";
import { PRODUCTION } from "../trust.mjs";
import { PRODUCTION as PUB } from "../vendor/publish.mjs";

const PW = process.env.PLAYWRIGHT_CORE || "/home/steven/Projects/enclave/node_modules/playwright-core/index.mjs";
const CHROME = process.env.CHROME_BIN || "/home/steven/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell";
const available = fs.existsSync(PW) && fs.existsSync(CHROME);
const T = { timeout: 90000, skip: available ? false : `playwright-core or Chromium missing (${PW}, ${CHROME})` };
const until = async (cond, what, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await cond(); if (v) return v; if (Date.now() > end) throw Error("timeout waiting for " + what); await new Promise((r) => setTimeout(r, 50)); } };

let browser, page, cur, chain, up, signer, snap;
test.before(async () => {
  if (!available) return;
  chain = await startChain(); up = await startUploadServices(); signer = ephemeralSigner(); snap = await chain.raw("evm_snapshot");
  const { chromium } = await import(PW);
  browser = await chromium.launch({ executablePath: CHROME, headless: true,
    args: ["--single-process", "--no-zygote", "--disable-gpu", "--disable-dev-shm-usage", "--disable-extensions", "--disable-background-networking",
      "--disable-component-update", "--js-flags=--max-old-space-size=96"] });
  const ctx = await browser.newContext();
  await ctx.exposeBinding("__walletLog", (_s, m) => { cur.calls.push(m); });
  await ctx.exposeBinding("__walletSign", async (_s, params) => { cur.signed.push(params); return signer.sign(hexToString(params[0])); });
  await ctx.exposeBinding("__walletSend", async (_s, tx) => { cur.sent.push(tx); return chain.sendAs(tx.from, { to: tx.to, data: tx.data, value: tx.value, nonce: tx.nonce, gas: tx.gas,
    maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, type: "0x2" }); });
  await ctx.addInitScript(({ admin }) => {
    const handlers = {};
    const provider = { isMetaMask: true, on(ev, f) { handlers[ev] = f; }, async request({ method, params }) {
      await window.__walletLog(method);
      if (method === "eth_requestAccounts") { window.__connected = true; return [admin]; }
      if (method === "eth_accounts") return window.__connected ? [admin] : [];
      if (method === "eth_chainId") return "0x2105";
      if (window.__trezorGone) throw Object.assign(new Error("Trezor: device disconnected"), { code: -32603 });
      if (method === "personal_sign") return window.__walletSign(params);
      if (method === "eth_sendTransaction") return window.__walletSend(params[0]);
      throw Object.assign(new Error("unsupported " + method), { code: 4200 });
    } };
    window.__disconnect = () => handlers.disconnect?.({ code: 4900 });
    window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider",
      { detail: Object.freeze({ info: { uuid: "test", name: "MetaMask", icon: "data:,", rdns: "io.metamask" }, provider }) })));
  }, { admin: PUB.publisher });
  page = await ctx.newPage();
  page.on("console", (m) => cur?.logs.push(m.type() + ": " + m.text())); page.on("pageerror", (e) => cur?.logs.push("pageerror: " + e.message));
});
test.after(async () => { await browser?.close(); await up?.close(); await chain?.close(); });

async function open(t, journals) {
  await chain.raw("anvil_dropAllTransactions"); await chain.raw("evm_revert", [snap]); snap = await chain.raw("evm_snapshot"); up.store.clear();
  up.mode.token = 200; up.mode.add = "ok"; up.mode.serve = "ok";
  const trust = fixtureTrust({ rpcs: chain.urls, uploadBase: up.base, admin: signer.address });
  journals ??= { upload: memoryJournal(), publish: memoryJournal() };
  const app = canaryApp({ trust, clients: clientsFor(trust.rpcs, { timeoutMs: trust.rpcTimeoutMs, allowLoopback: true }), journals, assets: assets(),
    preparer: makePreparer(trust, { clock: instantClock(), ledgerCodeHashOf: () => PUB.ledgerCodeHash }) });
  await app.listen(); t.after(async () => { await page.goto("about:blank"); await app.close(); });
  cur = { calls: [], sent: [], signed: [], logs: [] };
  await page.goto(app.origin + "/");
  const status = () => page.textContent("#status");
  await until(async () => (await page.textContent("#wallet")) === "MetaMask detected." && !/Loading/.test(await status()), "page ready");
  return { app, journals, status, ...cur };
}
const problems = (logs) => logs.filter((l) => /^pageerror|Content Security Policy|Refused to/.test(l));
const disabled = (id) => page.$eval("#" + id, (e) => e.disabled);

test("end to end: nothing before clicks; exact upload message; storage verified; then exactly the prepared publish; confirmed", T, async (t) => {
  const p = await open(t);
  const text = await page.textContent("main");
  assert.match(text, /NEW, free listing custody-canary-proof 0\.1\.0/); assert.match(text, /never stage real or user secrets/); assert.match(text, /101222 bytes · sha256 7ce32918/);
  await new Promise((r) => setTimeout(r, 800));
  assert.deepEqual(p.calls, [], "no wallet request on load");
  assert.equal(await disabled("authorize"), true); assert.equal(await disabled("sign"), true);
  await page.click("#connect");
  await until(async () => !(await disabled("authorize")), "authorize enabled");
  assert.equal(await disabled("sign"), true, "publish stays disabled before the upload is verified");
  await page.click("#authorize");
  await until(async () => /Uploaded, stored and verified/.test(await p.status()), "upload verified", 30000);
  assert.equal(p.signed.length, 1);
  assert.equal(hexToString(p.signed[0][0]), `enclave-upload:${PRODUCTION.component.sha256}:${p.journals.upload.read().expiry}`);
  assert.equal(p.signed[0][1].toLowerCase(), PUB.publisher);
  assert.equal(p.journals.upload.read().status, "stored-verified");
  await until(async () => !(await disabled("sign")), "publish enabled");
  await page.click("#sign");
  await until(() => p.sent.length === 1, "eth_sendTransaction", 30000);
  assert.deepEqual(p.sent[0], p.journals.publish.read().request.transaction, "MetaMask received exactly the server-prepared transaction");
  assert.deepEqual(p.calls, ["eth_requestAccounts", "eth_accounts", "personal_sign", "eth_accounts", "eth_chainId", "eth_chainId", "eth_sendTransaction"]);
  await until(async () => /Not verified yet/.test(await p.status()), "pending status");
  await chain.mine(3);
  await until(async () => /^Confirmed: 0x[0-9a-f]{64}\. The canary is listed and approved/.test(await p.status()), "confirmed", 30000);
  assert.equal(p.journals.publish.read().verification.approval, "approved");
  assert.deepEqual(problems(p.logs), []);
});

test("hardware-wallet failures: a disconnected Trezor never counts as success or as rejection; disconnect drops the session", T, async (t) => {
  const p = await open(t), adds = up.calls.add;
  await page.click("#connect"); await until(async () => !(await disabled("authorize")), "authorize enabled");
  await page.evaluate(() => { window.__trezorGone = true; });
  await page.click("#authorize");
  await until(async () => /Trezor: device disconnected.*nothing was uploaded/.test(await p.status()), "upload error text", 30000);
  assert.equal(p.journals.upload.read().status, "authorizing", "not reset: only an explicit 4001 resets");
  assert.equal(up.calls.add, adds); assert.equal(await disabled("authorize"), true, "no second authorization before this one expires");
  // the publish step with the component already stored: a wallet error leaves the attempt open, no success shown
  const q = await open(t, { upload: (() => { up.store.set(PRODUCTION.component.cid, fs.readFileSync(PRODUCTION.component.file)); return memoryJournal({ status: "stored-verified", cid: PRODUCTION.component.cid }); })(), publish: memoryJournal() });
  up.store.set(PRODUCTION.component.cid, fs.readFileSync(PRODUCTION.component.file));
  await page.evaluate(() => { window.__trezorGone = false; });
  await page.click("#connect"); await until(async () => !(await disabled("sign")), "publish enabled");
  await page.evaluate(() => { window.__trezorGone = true; });
  // eth_accounts/eth_chainId still answer; the send fails like a disconnected device
  await page.evaluate(() => { const orig = window.__walletSend; window.__walletSend = async () => { throw Object.assign(new Error("Trezor: device disconnected"), { code: -32603 }); }; void orig; });
  await page.click("#sign");
  await until(async () => /request stays open; do not send it again/.test(await q.status()), "open-attempt text", 30000);
  assert.equal(q.journals.publish.read().status, "awaiting-wallet"); assert.equal(q.sent.length, 0);
  assert.ok(!/Confirmed/.test(await q.status()));
  assert.equal(await disabled("sign"), true); assert.equal(await disabled("reconcile"), false, "the chain-based reconcile is offered");
  await page.evaluate(() => window.__disconnect());
  await until(async () => /MetaMask disconnected/.test(await page.textContent("#wallet")), "disconnect text");
  assert.equal(await disabled("connect"), false);
  assert.deepEqual(problems(q.logs), []);
});
