// The connected wallet's broadcast route in independent mode, through the ACTUAL site modules (wallet.js sendTx ->
// profile-broadcast.js -> chain.js waitReceipt, the real quorum reader) on Node: a confirmed profile whose two RPC origins
// are loopback proxies in front of a local anvil (chain id 8453, a TEST chain: acceptance here says nothing about Base
// mainnet inclusion). The "wallets" are in-test EIP-1193 objects whose own RPC is anvil itself, which signs for its
// unlocked dev account #1 (eth_signTransaction) - a signing-only wallet - or one that offers no eth_signTransaction (as
// MetaMask: EIP-1193 4200), one that alters what it signs, one that signs with another key. Every page fetch is recorded;
// any origin that is not this machine is refused and recorded. Generated anvil keys only; no real wallet, no public network.
//   run: node --test test/site-wallet-profile-broadcast.test.mjs     (needs Foundry's anvil)
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { parseTransaction, serializeTransaction, keccak256, recoverTransactionAddress } from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !haveAnvil && "needs Foundry's anvil";
const OWNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";                                      // anvil #1 (unlocked in anvil)
const OTHER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";            // anvil #2
const TO = "0x" + "be".repeat(20);
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const nativeFetch = globalThis.fetch;
const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });

let anvil, anvilUrl, servers = [], W, C, PB, Enclave;
const modes = ["ok", "ok"], seen = [[], []], forbidden = [], walletCalls = [], rawBodies = [];
const anvilRpc = async (method, params = []) => {
  const r = await nativeFetch(anvilUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; } return j.result;
};

test.before(async () => {
  if (skip) return;
  const port = await freePort();
  anvilUrl = `http://127.0.0.1:${port}`;
  anvil = spawn("anvil", ["--port", String(port), "--chain-id", "8453", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await anvilRpc("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  // two JSON-RPC origins in front of the chain; per origin: ok | refuse-raw (a JSON-RPC refusal of eth_sendRawTransaction) |
  // drop-raw (forwards the raw transaction, then drops the connection: the page cannot know)
  const rpcs = [];
  for (const i of [0, 1]){
    const p = await freePort();
    const srv = http.createServer(async (req, res) => {
      const body = await new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });
      const q = JSON.parse(body); seen[i].push(q.method);
      if (q.method === "eth_sendRawTransaction") rawBodies.push(q.params[0]);
      if (q.method === "eth_sendRawTransaction" && modes[i] === "refuse-raw"){
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, error: { code: -32003, message: "transaction rejected by this test origin" } }));
      }
      const r = await nativeFetch(anvilUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
      const text = await r.text();
      if (q.method === "eth_sendRawTransaction" && modes[i] === "drop-raw") return req.socket.destroy();
      res.writeHead(200, { "content-type": "application/json" }); res.end(text);
    });
    await new Promise((ok) => srv.listen(p, "127.0.0.1", ok));
    servers.push(srv);
    rpcs.push(i === 0 ? `http://127.0.0.1:${p}` : `http://localhost:${p}`);
  }
  const profile = { format: "enclave-browser-profile", version: 1, name: "loopback test network (anvil)", chainId: 8453, rpcs, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 86400,
    contractPins: { version: 1, chainId: 8453, contracts: { registry: "0x" + "11".repeat(20), deployments: "0x" + "22".repeat(20), appCatalog: "0x" + "33".repeat(20),
      proofOfTime: "0x" + "44".repeat(20), enclavePay: "0x" + "00".repeat(20), verificationFees: "0x" + "00".repeat(20),
      sessionVaultFactory: "0x" + "00".repeat(20), secretVaultV2: "0x" + "00".repeat(20) } }, usdc: "0x" + "66".repeat(20) };
  const text = JSON.stringify(profile);
  globalThis.localStorage = mem(new Map([["enclave_independent_profile", text]]));
  globalThis.sessionStorage = mem(new Map([["enclave_independent_ack", text]]));
  globalThis.location = { hostname: "localhost", origin: "http://localhost" };
  // the page's network: this machine only
  globalThis.fetch = (url, opts) => {
    const u = new URL(typeof url === "string" ? url : url.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)){ forbidden.push(u.href); return Promise.reject(new TypeError("blocked: not this machine")); }
    return nativeFetch(url, opts);
  };
  const core = (m) => import(pathToFileURL(path.join(ROOT, "site/js/core", m)).href);
  [W, C, PB, { Enclave }] = await Promise.all([core("wallet.js"), core("chain.js"), core("profile-broadcast.js"), core("api.js")]);
  Enclave.address = OWNER;
});
test.after(async () => {
  for (const s of servers) { s.closeAllConnections?.(); await new Promise((ok) => s.close(ok)); }
  anvil?.kill("SIGKILL");
  globalThis.fetch = nativeFetch;
});

/** An EIP-1193 wallet whose own RPC is anvil: `sign(request)` decides what eth_signTransaction returns. */
function wallet(sign){
  return { request: async ({ method, params }) => {
    walletCalls.push(method);
    if (method === "eth_signTransaction") return sign(params[0]);
    if (method === "eth_sendTransaction") return anvilRpc("eth_sendTransaction", params);
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_accounts") return [OWNER];
    throw Object.assign(new Error("unexpected wallet method " + method), { code: 4200 });
  } };
}
const signOnly = wallet((req) => anvilRpc("eth_signTransaction", [req]));                     // anvil signs for its dev account
const noSignOnly = wallet(() => { throw Object.assign(new Error("The method \"eth_signTransaction\" does not exist / is not available."), { code: 4200 }); });
const tx = (req) => ({ type: "eip1559", chainId: 8453, nonce: Number(BigInt(req.nonce)), to: req.to, value: BigInt(req.value), data: req.data, gas: BigInt(req.gas),
  maxFeePerGas: BigInt(req.maxFeePerGas), maxPriorityFeePerGas: BigInt(req.maxPriorityFeePerGas) });
const otherKey = wallet((req) => privateKeyToAccount(OTHER_KEY).signTransaction(tx(req)));      // exact fields, another signer
const altered = wallet(async (req) => {                                                        // the owner's key, a larger value
  const raw = await anvilRpc("eth_signTransaction", [{ ...req, value: "0x2" }]);
  return raw;
});
const raws = () => seen.flat().filter((m) => m === "eth_sendRawTransaction").length;
const nonce = async () => Number(BigInt(await anvilRpc("eth_getTransactionCount", [OWNER, "latest"])));
const reset = (m0 = "ok", m1 = "ok") => { modes[0] = m0; modes[1] = m1; seen[0].length = seen[1].length = 0; walletCalls.length = 0; rawBodies.length = 0; };

test("the default route is unchanged: the wallet broadcasts through its own RPC (eth_sendTransaction)", { skip, timeout: 60000 }, async () => {
  reset(); Enclave.provider = signOnly;
  assert.equal(PB.broadcastRoute(), "wallet", "nothing chosen: the wallet route");
  const hash = await W.sendTx(TO, "0x", "0x1");
  assert.deepEqual(walletCalls, ["eth_sendTransaction"]);
  assert.equal(raws(), 0, "the profile broadcast nothing");
  assert.equal((await C.waitReceipt(hash)).status, "0x1");
  assert.deepEqual(forbidden, []);
});

test("chosen profile route: the wallet only signs; a refusing origin, then the next origin broadcasts; the receipt comes through the profile", { skip, timeout: 60000 }, async () => {
  reset("refuse-raw", "ok"); Enclave.provider = signOnly;
  PB.setBroadcastRoute("profile");
  assert.equal(PB.broadcastRoute(), "profile");
  const before = await nonce();
  const hash = await W.sendTx(TO, "0x", "0x1");
  assert.deepEqual(walletCalls, ["eth_signTransaction"], "the wallet was asked to sign, and for nothing else");
  assert.equal(seen[0].filter((m) => m === "eth_sendRawTransaction").length, 1, "the first origin was asked, and refused");
  assert.equal(seen[1].filter((m) => m === "eth_sendRawTransaction").length, 1, "then the second, which accepted");
  const rec = await C.waitReceipt(hash);
  assert.equal(rec.status, "0x1");
  assert.equal(rec.from.toLowerCase(), OWNER);
  assert.equal(await nonce(), before + 1);
  // both origins were handed the same bytes: the wallet's signature, from the owner, hashing to what sendTx returned
  assert.equal(rawBodies.length, 2); assert.equal(rawBodies[0], rawBodies[1]);
  assert.equal(keccak256(rawBodies[0]), hash);
  assert.equal((await recoverTransactionAddress({ serializedTransaction: rawBodies[0] })).toLowerCase(), OWNER);
  const p = parseTransaction(rawBodies[0]);
  assert.deepEqual([p.chainId, p.to.toLowerCase(), p.value, p.type], [8453, TO, 1n, "eip1559"]);
  assert.deepEqual(forbidden, []);
});

test("a wallet that cannot sign without broadcasting is refused by name: nothing is signed, broadcast, or handed to its own RPC", { skip, timeout: 60000 }, async () => {
  reset(); Enclave.provider = noSignOnly;
  const before = await nonce();
  await assert.rejects(W.sendTx(TO, "0x", "0x1"), (e) => e.code === "unsupported" && /does not sign a transaction without broadcasting/.test(e.message) && /my wallet broadcasts/.test(e.message));
  assert.deepEqual(walletCalls, ["eth_signTransaction"], "no fallback to eth_sendTransaction");
  assert.equal(raws(), 0);
  assert.equal(await nonce(), before);
  assert.deepEqual(forbidden, []);
});

test("a signed transaction that is not exactly the request, or not from the connected address, is never broadcast", { skip, timeout: 60000 }, async () => {
  for (const [w, re, code] of [[altered, /signed a different transaction \(value changed\)/, "changed"], [otherKey, /is not from/, "signer"]]){
    reset(); Enclave.provider = w;
    const before = await nonce();
    await assert.rejects(W.sendTx(TO, "0x", "0x1"), (e) => e.code === code && re.test(e.message));
    assert.equal(raws(), 0, code + ": nothing reached any origin");
    assert.equal(await nonce(), before);
  }
  assert.deepEqual(forbidden, []);
});

test("every origin refusing: refused, sent nowhere else, the wallet never asked to broadcast; an origin that drops the reply: outcome unknown, and it did land", { skip, timeout: 90000 }, async () => {
  reset("refuse-raw", "refuse-raw"); Enclave.provider = signOnly;
  const before = await nonce();
  await assert.rejects(W.sendTx(TO, "0x", "0x1"), (e) => e.code === "refused" && /every endpoint of the network profile refused/.test(e.message) && /transaction rejected by this test origin/.test(e.message));
  assert.deepEqual(walletCalls, ["eth_signTransaction"]);
  assert.equal(raws(), 2);
  assert.equal(await nonce(), before, "not included");

  reset("drop-raw", "refuse-raw");
  let unknown;
  await assert.rejects(W.sendTx(TO, "0x", "0x1"), (e) => (unknown = e).code === "unknown" && e.outcomeUnknown && /outcome is unknown/.test(e.message));
  assert.deepEqual(walletCalls, ["eth_signTransaction"], "one signature: the retry is not a new transaction");
  // no answer from the first origin: the SAME signed bytes went to the next one (idempotent propagation), then nothing more
  assert.deepEqual([seen[0].filter((m) => m === "eth_sendRawTransaction").length, seen[1].filter((m) => m === "eth_sendRawTransaction").length], [1, 1]);
  assert.equal(rawBodies.length, 2); assert.equal(rawBodies[0], rawBodies[1], "identical bytes to both origins");
  assert.equal(keccak256(rawBodies[0]), unknown.hash);
  assert.match(unknown.message, /same signed bytes were offered to each of them and nothing more is sent/);
  assert.equal((await C.waitReceipt(unknown.hash)).status, "0x1", "the dropped reply hid an accepted transaction: 'unknown' was the truthful answer");
  assert.equal(raws(), 2, "waiting for the receipt sent nothing more");
  assert.equal(await nonce(), before + 1);
  assert.deepEqual(forbidden, []);
});

test("the strict decoder agrees with viem on real signed transactions and refuses malformed input", { skip, timeout: 30000 }, async () => {
  const acct = privateKeyToAccount(OTHER_KEY);
  for (const t of [{ to: TO, value: 0n, data: "0x" }, { to: TO, value: 10n ** 18n, data: "0x" + "ab".repeat(300), nonce: 300 }, { to: null, value: 0n, data: "0x6000" }]){
    const raw = await acct.signTransaction({ type: "eip1559", chainId: 8453, nonce: t.nonce ?? 0, gas: 21000n, maxFeePerGas: 3n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 6n, ...t, to: t.to ?? undefined });
    const d = PB.decodeSigned(raw), v = parseTransaction(raw);
    assert.equal(d.hash, keccak256(raw));
    assert.deepEqual([d.chainId, d.nonce, d.gas, d.value, d.to, d.data], [8453n, BigInt(v.nonce), v.gas, v.value ?? 0n, v.to ? v.to.toLowerCase() : null, v.data ?? "0x"]);
    assert.equal(d.signingHash, keccak256(serializeTransaction({ ...v, r: undefined, s: undefined, v: undefined, yParity: undefined })));
  }
  for (const raw of ["0x01c0", "0x02c0", "0x02" + "c3808080", "0x02f8" + "00", "0x02e1" + "82002a".padEnd(64, "8")])
    assert.throws(() => PB.decodeSigned(raw), (e) => e.code === "malformed");
});
