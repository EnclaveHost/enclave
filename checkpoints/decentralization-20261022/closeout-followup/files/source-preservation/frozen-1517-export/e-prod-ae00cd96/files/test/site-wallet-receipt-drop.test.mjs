// chain.js waitReceipt's "did the wallet drop it?" check, through the ACTUAL site modules (wallet.js sendTx ->
// profile-broadcast.js / the wallet -> chain.js waitReceipt) on Node: a confirmed profile whose two RPC origins are loopback
// proxies in front of a local anvil started with --no-mining (a TEST chain: nothing here says anything about Base mainnet
// inclusion), so a sent transaction stays pending until the test mines it at a chosen receipt poll.
//
// CONTROLLED CLOCK: only waitReceipt's 2-second pause between polls is shortened (setTimeout(_, 2000) -> 1 ms). The code
// path is unchanged and the classification still depends on the intended time: the wallet is consulted only once the
// receipt has been absent for DROP_AFTER (20) polls, i.e. ~40 s of real polling.
//
// Pins: (1) wallet route, a wallet whose RPC never had its transaction -> refused as dropped, exactly once asked;
// (2) wallet route, a wallet that has it pending -> keeps waiting, receipt through the profile; (3) profile route,
// accepted -> the wallet is never asked (its RPC never had the bytes; it answers null), the receipt comes through the
// profile after poll 20; (4) profile route, outcome unknown and the transaction exists nowhere -> the wallet is never asked,
// the wait ends with the ordinary timeout (not "dropped by your wallet"). In every case nothing is sent, signed or replaced
// while waiting. Anvil dev keys only; no real wallet, no public network (every other origin is refused and recorded).
//   run: node --test test/site-wallet-receipt-drop.test.mjs     (needs Foundry's anvil)
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keccak256 } from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !haveAnvil && "needs Foundry's anvil";
const OWNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";                                      // anvil #1 (unlocked in anvil)
const TO = "0x" + "be".repeat(20);
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const nativeFetch = globalThis.fetch, nativeSetTimeout = globalThis.setTimeout;
const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });

let anvil, anvilUrl, servers = [], W, C, PB, Enclave;
const modes = ["ok", "ok"], forbidden = [], walletCalls = [], originCalls = [];
let receiptPolls = 0, mineAtPoll = 0;
const anvilRpc = async (method, params = []) => {
  const r = await nativeFetch(anvilUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; } return j.result;
};

test.before(async () => {
  if (skip) return;
  const port = await freePort();
  anvilUrl = `http://127.0.0.1:${port}`;
  anvil = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--no-mining", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await anvilRpc("eth_chainId"); break; } catch { await new Promise((r) => nativeSetTimeout(r, 100)); } }
  await anvilRpc("evm_mine");                                   // one block after genesis
  // two origins: ok | lose-raw (drops the connection on eth_sendRawTransaction WITHOUT forwarding it: the page cannot know,
  // and the transaction exists nowhere). Receipt polls are counted; at poll `mineAtPoll` anvil mines first.
  const rpcs = [];
  for (const i of [0, 1]){
    const p = await freePort();
    const srv = http.createServer(async (req, res) => {
      const body = await new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });
      const q = JSON.parse(body); originCalls.push(q.method);
      if (q.method === "eth_sendRawTransaction" && modes[i] === "lose-raw") return req.socket.destroy();
      if (q.method === "eth_getTransactionReceipt" && ++receiptPolls === mineAtPoll) await anvilRpc("evm_mine");
      const r = await nativeFetch(anvilUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
      res.writeHead(200, { "content-type": "application/json" }); res.end(await r.text());
    });
    await new Promise((ok) => srv.listen(p, "127.0.0.1", ok));
    servers.push(srv);
    rpcs.push(i === 0 ? `http://127.0.0.1:${p}` : `http://localhost:${p}`);
  }
  const profile = { format: "enclave-browser-profile", version: 1, name: "loopback test network (anvil, no automine)", chainId: 8453, rpcs, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 86400,
    contractPins: { version: 1, chainId: 8453, contracts: { registry: "0x" + "11".repeat(20), deployments: "0x" + "22".repeat(20), appCatalog: "0x" + "33".repeat(20),
      proofOfTime: "0x" + "44".repeat(20), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20),
      sessionVaultFactory: "0x" + "00".repeat(20), secretVaultV2: "0x" + "00".repeat(20) } }, usdc: "0x" + "66".repeat(20) };
  const text = JSON.stringify(profile);
  globalThis.localStorage = mem(new Map([["enclave_independent_profile", text]]));
  globalThis.sessionStorage = mem(new Map([["enclave_independent_ack", text]]));
  globalThis.location = { hostname: "localhost", origin: "http://localhost" };
  globalThis.fetch = (url, opts) => {
    const u = new URL(typeof url === "string" ? url : url.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)){ forbidden.push(u.href); return Promise.reject(new TypeError("blocked: not this machine")); }
    return nativeFetch(url, opts);
  };
  // the controlled clock: waitReceipt's 2 s pause only
  globalThis.setTimeout = (fn, ms, ...a) => nativeSetTimeout(fn, ms === 2000 ? 1 : ms, ...a);
  const core = (m) => import(pathToFileURL(path.join(ROOT, "site/js/core", m)).href);
  [W, C, PB, { Enclave }] = await Promise.all([core("wallet.js"), core("chain.js"), core("profile-broadcast.js"), core("api.js")]);
  Enclave.address = OWNER;
});
test.after(async () => {
  globalThis.setTimeout = nativeSetTimeout;
  for (const s of servers) { s.closeAllConnections?.(); await new Promise((ok) => s.close(ok)); }
  anvil?.kill("SIGKILL");
  globalThis.fetch = nativeFetch;
});

/** An EIP-1193 wallet whose own RPC is anvil. `knows(hash)` is what ITS RPC says about a transaction hash. */
function wallet({ send, knows }){
  return { request: async ({ method, params }) => {
    walletCalls.push(method);
    if (method === "eth_signTransaction") return anvilRpc("eth_signTransaction", params);   // anvil signs for its dev account
    if (method === "eth_sendTransaction") return send(params[0]);
    if (method === "eth_getTransactionByHash") return knows(params[0]);
    if (method === "eth_chainId") return "0x2105";
    throw Object.assign(new Error("unexpected wallet method " + method), { code: 4200 });
  } };
}
// returns a hash and never relays it: its own RPC has never heard of it
const neverRelays = wallet({ send: async (tx) => keccak256(await anvilRpc("eth_signTransaction", [tx])), knows: async () => null });
// broadcasts through its RPC, which then holds the transaction pending
const relays = wallet({ send: (tx) => anvilRpc("eth_sendTransaction", [tx]), knows: (h) => anvilRpc("eth_getTransactionByHash", [h]) });
// signs only: its RPC never had the bytes the profile broadcast, so it answers null (it would be "dropped" if asked)
const signOnly = wallet({ send: () => { throw new Error("must not broadcast"); }, knows: async () => null });

const reset = (m0 = "ok", m1 = "ok", mine = 0) => { modes[0] = m0; modes[1] = m1; walletCalls.length = originCalls.length = 0; receiptPolls = 0; mineAtPoll = mine; };
const sends = () => originCalls.filter((m) => m === "eth_sendRawTransaction" || m === "eth_sendTransaction").length;
const pending = async () => Number(BigInt((await anvilRpc("txpool_status")).pending));
const nonce = async () => Number(BigInt(await anvilRpc("eth_getTransactionCount", [OWNER, "latest"])));

test("wallet route, normal drop behaviour preserved: after 20 absent polls the wallet's RPC is asked once; it never had the transaction -> refused as dropped", { skip, timeout: 60000 }, async () => {
  PB.setBroadcastRoute("wallet"); reset(); Enclave.provider = neverRelays;
  const hash = await W.sendTx(TO, "0x", "0x1");
  assert.deepEqual(walletCalls, ["eth_sendTransaction"]);
  await assert.rejects(C.waitReceipt(hash), /your wallet's RPC does not have this transaction 40s after signing it: it returned a hash but never relayed it/);
  assert.equal(receiptPolls, 21, "the wallet is consulted only after DROP_AFTER (20) absent polls");
  assert.deepEqual(walletCalls, ["eth_sendTransaction", "eth_getTransactionByHash"], "asked exactly once");
  assert.equal(await pending(), 0);
  assert.deepEqual(forbidden, []);
});

test("wallet route, the wallet has it pending: seen once, the wait continues, the receipt comes through the profile", { skip, timeout: 60000 }, async () => {
  reset("ok", "ok", 25); Enclave.provider = relays;
  const before = await nonce();
  const hash = await W.sendTx(TO, "0x", "0x1");
  const rec = await C.waitReceipt(hash);
  assert.equal(rec.status, "0x1");
  assert.equal(receiptPolls, 25, "the receipt arrived at the poll the test mined it");
  assert.deepEqual(walletCalls, ["eth_sendTransaction", "eth_getTransactionByHash"], "the wallet's RPC said it had it: asked once, not again");
  assert.equal(await nonce(), before + 1);
  assert.deepEqual(forbidden, []);
});

test("profile route, accepted: the wallet is never asked (it would answer null), the receipt comes through the profile after poll 20, nothing is resent", { skip, timeout: 60000 }, async () => {
  PB.setBroadcastRoute("profile"); reset("ok", "ok", 30); Enclave.provider = signOnly;
  const before = await nonce();
  const hash = await W.sendTx(TO, "0x", "0x1");
  assert.deepEqual(walletCalls, ["eth_signTransaction"]);
  const sentBefore = sends();
  assert.equal(sentBefore, 1, "one broadcast: the first origin accepted");
  assert.equal(await pending(), 1);
  const rec = await C.waitReceipt(hash);
  assert.equal(rec.status, "0x1"); assert.equal(rec.transactionHash.toLowerCase(), hash);
  assert.equal(receiptPolls, 30, "waited past DROP_AFTER (20) without consulting the wallet");
  assert.deepEqual(walletCalls, ["eth_signTransaction"], "no eth_getTransactionByHash to the wallet, no second signature");
  assert.equal(sends(), sentBefore, "nothing sent while waiting");
  assert.equal(await nonce(), before + 1, "one transaction, no replacement");
  assert.deepEqual(forbidden, []);
});

test("profile route, outcome unknown and the transaction exists nowhere: the wallet is never asked; the wait ends with the ordinary timeout, not 'dropped by your wallet'", { skip, timeout: 60000 }, async () => {
  reset("lose-raw", "lose-raw"); Enclave.provider = signOnly;
  const before = await nonce();
  let unknown;
  await assert.rejects(W.sendTx(TO, "0x", "0x1"), (e) => (unknown = e).code === "unknown" && e.outcomeUnknown);
  assert.equal(sends(), 2, "the same bytes to each origin, then nothing more");
  assert.equal(await pending(), 0, "neither origin forwarded it");
  await assert.rejects(C.waitReceipt(unknown.hash, 30), (e) => /timed out waiting for confirmation/.test(e.message) && !/your wallet's RPC/.test(e.message));
  assert.equal(receiptPolls, 30, "polled the profile the whole time");
  assert.deepEqual(walletCalls, ["eth_signTransaction"], "the wallet was never asked about bytes it never had");
  assert.equal(sends(), 2, "nothing sent while waiting");
  assert.equal(await nonce(), before);
  assert.deepEqual(forbidden, []);
});
