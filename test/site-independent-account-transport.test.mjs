// site/js/core/account-transport.js without a chain: a passkey account paying its own gas through the owner's bundler. Pins
// the rules - the owner's explicit choice, no paymaster used unverified, the account must hold the gas before anything is
// signed, the exact call and the exact signed operation are simulated first, the outcome is the EntryPoint's own event, and an
// unknown outcome stays pending and blocks new operations (never resent). The real EntryPoint execution runs in
// test/site-independent-account-first.test.mjs.
//   run: node --test test/site-independent-account-transport.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as viem from "viem";
import { WebAuthnP256 } from "ox";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m });
globalThis.localStorage = mem(); globalThis.sessionStorage = mem(); globalThis.location = { hostname: "localhost" };
const core = (m) => import(pathToFileURL(path.join(ROOT, "site/js/core", m)).href);
const PA = await core("passkey-account.js");
const AP = await core("account-providers.js");
const AT = await core("account-transport.js");
PA._useLibForTests({ ...viem, WebAuthnP256 });

const SAFE = "0x" + "5a".repeat(20), EP = AP.PROVIDERS["safe-passkey"].contracts.entryPoint.address;
const SH = AP.PROVIDERS["safe-passkey"].contracts.webauthnSharedSigner.address;
const pk = { kind: "passkey", signer: SH, shared: true, x: "0x" + "aa".repeat(32), y: "0x" + "ab".repeat(32), verifiers: String(0x100n << 160n),
  credentialId: Buffer.from("credential-aa").toString("base64url"), rpId: "localhost", label: "laptop" };
const transport = { provider: "safe-passkey", entryPoint: EP, bundlers: ["http://127.0.0.1:9999/rpc"] };
const profile = (over = {}) => ({ v: 1, provider: "safe-passkey", chainId: 8453, safe: SAFE, saltNonce: "1", threshold: 1, transport, owners: [pk], ...over });
const OPHASH = "0x" + "0e".repeat(32), UOHASH = "0x" + "4d".repeat(32);
const EVENT = viem.keccak256(viem.toHex("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")).toLowerCase();
const word = (v) => BigInt(v).toString(16).padStart(64, "0");

let w, sent, approved, clock;
function world(){
  return { block: 100, pmDeposit: 0n, balance: 10n ** 18n, deposit: 0n, nonce: 7n, events: [], innerRevert: false, handleRevert: false, deliver: "ok", deployed: true };
}
const reader = {
  snapshot: async () => ({ number: w.block, hash: "0x" + "bb".repeat(32), timestamp: 1, baseFeePerGas: 1000n }),
  code: async () => (w.deployed ? "0x60" : "0x"),
  balance: async () => w.balance,
  call: async (snap, to, data, opts = {}) => {
    if (opts.from){ if (w.innerRevert){ const e = new Error("execution reverted"); e.revert = true; throw e; } return "0x"; }
    const sel = data.slice(0, 10);
    if (sel === viem.toFunctionSelector("balanceOf(address)")) return "0x" + word(w.deposit);
    if (sel === viem.toFunctionSelector("getNonce(address,uint192)")) return "0x" + word(w.nonce);
    if (w.handleRevert){ const e = new Error("execution reverted: FailedOp(0, AA24 signature error)"); e.revert = true; throw e; }
    return "0x";
  },
  logs: async (snap, { topics }) => w.events.filter((e) => topics[0] === EVENT && topics[1] === e.hash)
    .map((e) => ({ blockNumber: 101, data: "0x" + word(w.nonce) + word(e.success ? 1 : 0) + word(123) + word(456), transactionHash: "0x" + "77".repeat(32) })),
};
const stubPA = {
  ...PA,
  prepareUserOperation: async (p, a) => ({ userOp: { sender: SAFE, nonce: w.nonce, initCode: "0x", callData: "0x", accountGasLimits: "0x" + "00".repeat(32), preVerificationGas: 0n,
    gasFees: "0x" + "00".repeat(32), paymasterAndData: "0x", signature: "0x" }, operationHash: OPHASH, validAfter: 0, validUntil: 0, gas: a.gas, initCode: a.initCode }),
  prepareSafeCreation: async () => ({ safe: SAFE.toLowerCase(), initCode: { factory: "0x" + "fa".repeat(20), data: "0x1234" } }),
  bundlerRequest: async (url, method) => {
    if (method === "eth_maxPriorityFeePerGas") return "0x64";
    if (method === "eth_estimateUserOperationGas") return { verificationGasLimit: "0x30d40", callGasLimit: "0x186a0", preVerificationGas: "0xc350" };
    throw new Error("unexpected " + method);
  },
  userOperationHash: async () => UOHASH,
  sendUserOperation: async () => {
    sent++;
    if (w.deliver === "refused"){ const e = new Error("none of your bundlers accepted"); e.code = "transport"; e.delivered = false; throw e; }
    if (w.deliver === "unreachable"){ const e = new Error("none of your bundlers accepted"); e.code = "transport"; e.delivered = "unknown"; throw e; }
    if (w.deliver === "ok") w.events.push({ hash: UOHASH, success: true });
    if (w.deliver === "fails") w.events.push({ hash: UOHASH, success: false });
    return { userOpHash: UOHASH, bundler: transport.bundlers[0] };
  },
};
const approve = async (h) => { approved.push(h); return "0x" + "51".repeat(80); };
const send = (over = {}, p = profile()) => AT.sendAsAccount(p, { to: "0x" + "22".repeat(20), data: "0xabcd", what: "a test call", ...over }, { approve, timeoutMs: 3000 });

test.beforeEach(() => {
  localStorage.m.clear(); w = world(); sent = 0; approved = []; clock = 0;
  AT._setForTests({ PA: stubPA, reader, sleep: async (ms) => { clock += ms; }, now: () => clock });
});

test("the owner chooses who pays: no silent default with a transport", async () => {
  assert.equal(AT.gasChoice(profile()), null, "a transport alone is not a choice");
  assert.equal(AT.gasChoice(profile({ transport: null })), "wallet", "without a transport only the wallet can pay");
  await assert.rejects(send(), (e) => e.code === "choice");
  assert.throws(() => AT.setGasChoice(profile({ transport: null }), "account"), /name your own bundler first/);
  assert.equal(sent, 0); assert.deepEqual(approved, []);
});

test("an owner-chosen paymaster (ERC-7677): only that paymaster, its deposit must cover the gas, and its data is part of what the passkeys sign", async () => {
  const PM = "0x" + "99".repeat(20);
  const withPm = profile({ transport: { ...transport, paymaster: { kind: "verifying", address: PM, url: "http://127.0.0.1:9998/pm" } } });
  AT.setGasChoice(withPm, "account");
  let answerFor = PM, used = null;
  const pmPA = { ...stubPA,
    bundlerRequest: async (url, method, params) => {
      if (method === "pm_getPaymasterStubData") return { paymaster: answerFor, paymasterData: "0x", paymasterVerificationGasLimit: "0x186a0", paymasterPostOpGasLimit: "0x0", isFinal: false };
      if (method === "pm_getPaymasterData") return { paymaster: answerFor, paymasterData: "0xbeef" };
      return stubPA.bundlerRequest(url, method, params);
    },
    prepareUserOperation: async (p, a) => { if (a.gas.callGasLimit > 1n) used = a; return stubPA.prepareUserOperation(p, a); } };
  const pmReader = { ...reader, call: async (snap, to, data, opts) => (data.startsWith(viem.toFunctionSelector("balanceOf(address)")) ? "0x" + word(w.pmDeposit) : reader.call(snap, to, data, opts)) };
  AT._setForTests({ PA: pmPA, reader: pmReader, sleep: async (ms) => { clock += ms; }, now: () => clock });
  w.balance = 0n;                                                // the account holds nothing: the paymaster pays
  answerFor = "0x" + "98".repeat(20);
  await assert.rejects(send({}, withPm), (e) => e.code === "paymaster" && /answered for 0x9898.*not the paymaster you named/.test(e.message));
  answerFor = PM; w.pmDeposit = 1n;
  await assert.rejects(send({}, withPm), (e) => e.code === "prefund" && /paymaster's EntryPoint deposit/.test(e.message));
  assert.deepEqual(approved, [], "nothing signed while the paymaster cannot pay");
  w.pmDeposit = 10n ** 18n;
  await send({}, withPm);
  assert.equal(used.paymasterAndData.slice(0, 42), PM, "the named paymaster"); assert.ok(used.paymasterAndData.endsWith("beef"), "its FINAL data, signed over");
});

test("gas is not free: an account without enough ETH is refused before anything is signed, with the amount", async () => {
  AT.setGasChoice(profile(), "account");
  w.balance = 1n; w.deposit = 0n;
  await assert.rejects(send(), (e) => e.code === "prefund" && e.needWei > 0n && /needs up to [0-9.]+ ETH.*Send ETH to 0x5a5a/.test(e.message));
  assert.deepEqual(approved, []); assert.equal(sent, 0);
  w.deposit = 10n ** 18n;                                       // an EntryPoint deposit counts too
  assert.equal((await send()).txHash, "0x" + "77".repeat(32));
});

test("the call and the signed operation are simulated first; either refusal stops everything", async () => {
  AT.setGasChoice(profile(), "account");
  w.innerRevert = true;
  await assert.rejects(send(), (e) => e.code === "simulation" && /would fail from your account/.test(e.message));
  assert.deepEqual(approved, [], "nothing signed when the call itself would fail");
  w.innerRevert = false; w.handleRevert = true;
  await assert.rejects(send(), (e) => e.code === "simulation" && /EntryPoint refuses this operation.*AA24/.test(e.message));
  assert.equal(approved.length, 1); assert.equal(sent, 0, "a refused simulation is never sent");
  assert.equal(AT.pendingOf(SAFE), null);
});

test("the outcome is the EntryPoint's own event: success, and a failed call reported as included-and-failed", async () => {
  AT.setGasChoice(profile(), "account");
  const r = await send();
  assert.equal(r.userOpHash, UOHASH); assert.equal(r.actualGasCost, 123n); assert.deepEqual(approved, [OPHASH]);
  assert.equal(AT.pendingOf(SAFE), null, "settled operations are not pending");
  w.events = []; w.deliver = "fails";
  await assert.rejects(send(), (e) => e.code === "reverted" && /included in 0x7777.*the call failed; gas was paid/.test(e.message));
  assert.equal(AT.pendingOf(SAFE), null);
});

test("an unknown outcome stays pending, blocks new operations without signing, and is never resent", async () => {
  AT.setGasChoice(profile(), "account");
  w.deliver = "held";                                           // the bundler takes it, the chain shows nothing yet
  await assert.rejects(send(), (e) => e.code === "unknown" && e.outcomeUnknown && e.userOpHash === UOHASH && /not resent/.test(e.message));
  assert.equal(sent, 1); assert.equal(AT.pendingOf(SAFE).userOpHash, UOHASH);
  approved = [];
  await assert.rejects(send(), (e) => e.code === "pending" && /no outcome on chain yet: check it/.test(e.message));
  assert.deepEqual(approved, [], "nothing signed while an earlier outcome is unknown"); assert.equal(sent, 1, "never resent");
  assert.equal((await AT.checkPending(profile())).state, "pending");
  w.events.push({ hash: UOHASH, success: true });               // the bundler finally includes it
  const c = await AT.checkPending(profile());
  assert.equal(c.state, "included"); assert.equal(c.success, true); assert.equal(AT.pendingOf(SAFE), null);
});

test("delivery: every bundler refusing means nothing is pending; an unreachable bundler is an unknown outcome", async () => {
  AT.setGasChoice(profile(), "account");
  w.deliver = "refused";
  await assert.rejects(send(), (e) => e.code === "refused" && /Nothing is pending/.test(e.message));
  assert.equal(AT.pendingOf(SAFE), null);
  w.deliver = "unreachable";
  await assert.rejects(send(), (e) => e.code === "unknown" && e.outcomeUnknown);
  assert.equal(AT.pendingOf(SAFE).userOpHash, UOHASH);
  w.nonce = 8n;                                                 // the account's nonce moved on without this operation
  assert.equal((await AT.checkPending(profile())).state, "replaced");
  assert.equal(AT.pendingOf(SAFE), null);
});

test("creation: only with deploy, and only when the description creates exactly this address", async () => {
  AT.setGasChoice(profile(), "account");
  w.deployed = false;
  await assert.rejects(send(), (e) => e.code === "undeployed");
  assert.equal((await send({ to: SAFE, data: "0x", deploy: true })).txHash, "0x" + "77".repeat(32));
  w.events = [];
  const other = profile({ safe: "0x" + "5b".repeat(20) });
  AT.setGasChoice(other, "account");                            // the choice is per account
  await assert.rejects(send({ deploy: true }, other), (e) => e.code === "mismatch");
});

test("a bundler's call-gas estimate is never trusted alone: the account's own call, measured from the account, sets the floor", async () => {
  AT.setGasChoice(profile(), "account");
  let used = null;
  const seen = [];
  const measuring = { ...reader, estimateGas: async (snap, tx) => { seen.push(tx); return 500_000n; } };
  const prepare = stubPA.prepareUserOperation;
  AT._setForTests({ PA: { ...stubPA, prepareUserOperation: async (p, a) => { if (a.gas.callGasLimit > 1n) used = a.gas; return prepare(p, a); } }, reader: measuring,
    sleep: async (ms) => { clock += ms; }, now: () => clock });
  await send();
  assert.equal(seen[0].from, SAFE, "measured FROM the account"); assert.equal(seen[0].data, "0xabcd");
  assert.equal(used.callGasLimit, 650_000n + 80_000n, "the measured call (with margin and the 4337 overhead), above the bundler's 130k");
  // and a call the endpoints cannot even estimate (it would revert) is refused before signing
  approved = []; w.events = [];
  AT._setForTests({ PA: stubPA, reader: { ...reader, estimateGas: async () => { const e = new Error("execution reverted"); e.revert = true; throw e; } }, sleep: async () => {}, now: () => clock });
  await assert.rejects(send(), (e) => e.code === "estimate" && /could not measure this call from your account/.test(e.message));
  assert.deepEqual(approved, []);
});
