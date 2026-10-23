// A passkey account paying its own gas: the user operation's network path through the ACTUAL transport code
// (account-transport.js sendAsAccount -> passkey-account.js bundlerRequest / sendUserOperation, over real HTTP) to the
// owner's own bundlers - here loopback stand-ins that answer scripted JSON-RPC (a TEST fixture: no ERC-4337 validation,
// no EntryPoint, no chain). The chain side is a scripted reader (as test/site-independent-account-transport.test.mjs),
// so "included" below is the fixture's event, not inclusion anywhere. Pins: only the bundlers the owner named are
// contacted, in the owner's order; a refusal moves to the next; every bundler refusing leaves nothing pending; an
// unreachable bundler is an unknown outcome; nothing else is contacted (every other origin is refused and recorded).
// The real EntryPoint v0.7 execution is test/site-independent-account-first.test.mjs (it forks Base: not run here).
//   run: node --test test/site-account-bundler-route.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as viem from "viem";
import { WebAuthnP256 } from "ox";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m });
globalThis.localStorage = mem(); globalThis.sessionStorage = mem(); globalThis.location = { hostname: "localhost" };
const nativeFetch = globalThis.fetch, forbidden = [];
globalThis.fetch = (url, opts) => {
  const u = new URL(typeof url === "string" ? url : url.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)){ forbidden.push(u.href); return Promise.reject(new TypeError("blocked: not this machine")); }
  return nativeFetch(url, opts);
};
const core = (m) => import(pathToFileURL(path.join(ROOT, "site/js/core", m)).href);
const PA = await core("passkey-account.js");
const AP = await core("account-providers.js");
const AT = await core("account-transport.js");
PA._useLibForTests({ ...viem, WebAuthnP256 });

const SAFE = "0x" + "5a".repeat(20), EP = AP.PROVIDERS["safe-passkey"].contracts.entryPoint.address;
const SH = AP.PROVIDERS["safe-passkey"].contracts.webauthnSharedSigner.address;
const pk = (rpId = "localhost") => ({ kind: "passkey", signer: SH, shared: true, x: "0x" + "aa".repeat(32), y: "0x" + "ab".repeat(32), verifiers: String(0x100n << 160n),
  credentialId: Buffer.from("credential-aa").toString("base64url"), rpId, label: "laptop" });
const UOHASH = "0x" + "4d".repeat(32);
const EVENT = viem.keccak256(viem.toHex("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")).toLowerCase();
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

// ---- loopback bundler stand-ins: "ok" accepts, "refuse" answers fees/estimates but refuses the operation ----
const events = [], bundlers = [];
// two loopback names, because the owner's bundlers must be on distinct hosts
async function bundler(mode, host = "127.0.0.1"){
  const b = { mode, calls: [], bodies: [] };
  b.srv = http.createServer(async (req, res) => {
    const body = await new Promise((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => ok(s)); });
    const q = JSON.parse(body); b.calls.push(q.method); b.bodies.push(q);
    const reply = (x) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, ...x })); };
    if (q.method === "eth_maxPriorityFeePerGas") return reply({ result: "0x64" });
    if (q.method === "eth_estimateUserOperationGas") return reply({ result: { verificationGasLimit: "0x30d40", callGasLimit: "0x186a0", preVerificationGas: "0xc350" } });
    if (q.method === "eth_sendUserOperation"){
      if (b.mode === "refuse") return reply({ error: { code: -32602, message: "AA21 didn't pay prefund (fixture refusal)" } });
      events.push(UOHASH); return reply({ result: UOHASH });
    }
    reply({ error: { code: -32601, message: "method not found" } });
  });
  const port = await freePort();
  await new Promise((ok) => b.srv.listen(port, "127.0.0.1", ok));
  b.url = `http://${host}:${port}/rpc`;
  bundlers.push(b);
  return b;
}
test.after(async () => { for (const b of bundlers){ b.srv.closeAllConnections?.(); await new Promise((ok) => b.srv.close(ok)); } globalThis.fetch = nativeFetch; });

// ---- the scripted chain (a test reader: no endpoint) ----
let nonce = 7n;
const reader = {
  snapshot: async () => ({ number: 100, hash: "0x" + "bb".repeat(32), timestamp: 1, baseFeePerGas: 1000n }),
  code: async () => "0x60", balance: async () => 10n ** 18n,
  call: async (snap, to, data, opts = {}) => {
    if (opts.from) return "0x";
    const sel = data.slice(0, 10);
    if (sel === viem.toFunctionSelector("balanceOf(address)")) return "0x" + word(0);
    if (sel === viem.toFunctionSelector("getNonce(address,uint192)")) return "0x" + word(nonce);
    return "0x";
  },
  logs: async (snap, { topics }) => events.filter((h) => topics[0] === EVENT && topics[1] === h)
    .map(() => ({ blockNumber: 101, data: "0x" + word(nonce) + word(1) + word(123) + word(456), transactionHash: "0x" + "77".repeat(32) })),
};
const testPA = {
  ...PA,                                                     // bundlerRequest and sendUserOperation are the real ones
  prepareUserOperation: async (p, a) => ({ userOp: { sender: SAFE, nonce, initCode: "0x", callData: "0x", accountGasLimits: "0x" + "00".repeat(32), preVerificationGas: 0n,
    gasFees: "0x" + "00".repeat(32), paymasterAndData: "0x", signature: "0x" }, operationHash: "0x" + "0e".repeat(32), validAfter: 0, validUntil: 0, gas: a.gas, initCode: a.initCode }),
  userOperationHash: async () => UOHASH,
};
AT._setForTests({ PA: testPA, reader, sleep: async () => {}, now: () => 0 });
const profile = (urls) => ({ v: 1, provider: "safe-passkey", chainId: 8453, safe: SAFE, saltNonce: "1", threshold: 1,
  transport: { provider: "safe-passkey", entryPoint: EP, bundlers: urls }, owners: [pk()] });
const send = (p) => { AT.setGasChoice(p, "account"); return AT.sendAsAccount(p, { to: "0x" + "22".repeat(20), data: "0xabcd", what: "a test call" },
  { approve: async () => "0x" + "51".repeat(80), timeoutMs: 1000 }); };

test("the owner's bundlers, in order: a refusal moves to the next; the outcome is the (fixture) EntryPoint event; nothing else is contacted", async () => {
  events.length = 0;
  const a = await bundler("refuse"), b = await bundler("ok", "localhost");
  const r = await send(profile([a.url, b.url]));
  assert.equal(r.userOpHash, UOHASH);
  assert.deepEqual(a.calls, ["eth_maxPriorityFeePerGas", "eth_estimateUserOperationGas", "eth_sendUserOperation"], "fees and the estimate from the first that answers");
  assert.deepEqual(b.calls, ["eth_sendUserOperation"], "the same signed operation, only after the refusal");
  assert.deepEqual(a.bodies.at(-1).params, b.bodies[0].params, "byte-identical operation to both");
  assert.equal(b.bodies[0].params[1], EP, "EntryPoint v0.7 of the provider");
  assert.equal(AT.pendingOf(SAFE), null);
  assert.deepEqual(forbidden, []);
});

test("every bundler refusing: refused, nothing pending, each asked once; an unreachable bundler first: outcome unknown, kept pending, not resent", async () => {
  events.length = 0;
  const a = await bundler("refuse"), b = await bundler("refuse", "localhost");
  await assert.rejects(send(profile([a.url, b.url])), (e) => e.code === "refused" && /Nothing is pending/.test(e.message) && /fixture refusal/.test(e.message));
  assert.equal(AT.pendingOf(SAFE), null);
  assert.equal(a.calls.filter((m) => m === "eth_sendUserOperation").length + b.calls.filter((m) => m === "eth_sendUserOperation").length, 2);

  const dead = `http://127.0.0.1:${await freePort()}/rpc`, c = await bundler("refuse", "localhost");
  await assert.rejects(send(profile([dead, c.url])), (e) => e.code === "unknown" && e.outcomeUnknown);
  assert.equal(AT.pendingOf(SAFE).userOpHash, UOHASH, "kept pending");
  await assert.rejects(send(profile([dead, c.url])), (e) => e.code === "pending", "the next operation is blocked, nothing is resent");
  assert.equal(c.calls.filter((m) => m === "eth_sendUserOperation").length, 1);
  AT.discardPending(profile([c.url]));
  assert.deepEqual(forbidden, []);
});

test("no transport, no account route: no default bundler exists, and the wallet route is the only choice", () => {
  localStorage.m.clear();
  const p = { ...profile([]), transport: null };
  assert.equal(AT.gasChoice(p), "wallet");
  assert.throws(() => AT.setGasChoice(p, "account"), /name your own bundler first/);
  assert.throws(() => AP.validateAccountTransport({ provider: "safe-passkey", entryPoint: EP, bundlers: ["https://bundler.enclave.host/rpc"] }), /Enclave-operated/);
  assert.throws(() => AP.validateAccountTransport({ provider: "safe-passkey", entryPoint: EP, bundlers: ["http://bundler.example/rpc"] }), /plain https/);
  assert.throws(() => AP.validateAccountTransport({ provider: "safe-passkey", entryPoint: "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", bundlers: ["https://b.example"] }), /uses EntryPoint/);
});

test("capabilities name what Enclave runs when the owner chose it, instead of claiming independence", () => {
  const caps = (over) => PA.accountCapabilities({ ...profile(["https://b.example/rpc"]), ...over }).join("\n");
  assert.match(caps({}), /No Enclave account, relay, RP, bundler or paymaster is involved/);
  const rp = caps({ owners: [pk("enclave.host")] });
  assert.match(rp, /Enclave runs part of this account's path \(RP enclave\.host\)/); assert.doesNotMatch(rp, /No Enclave account, relay, RP/);
  const both = caps({ owners: [pk("dash.enclave.host")], transport: { provider: "safe-passkey", entryPoint: EP, bundlers: ["https://b.example/rpc", "https://bundler.enclave.host/rpc"],
    paymaster: { kind: "verifying", address: "0x" + "99".repeat(20), url: "https://pm.enclave.host/" } } });
  assert.match(both, /RP dash\.enclave\.host, bundler bundler\.enclave\.host, paymaster service pm\.enclave\.host/);
});
