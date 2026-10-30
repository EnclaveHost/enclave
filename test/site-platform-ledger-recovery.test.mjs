// site/js/core/platform-addresses.js when the administrator replaces the ledger through the address book: calldata for a
// replaced contract is refused, except the owner's recovery on a replaced LEDGER (refund(id), setActive(id,false)) - in the
// tab that saw the change and in a fresh tab that only has the profile's original pin, or the profile's ledger history and
// the book's own AddressSet events after it. Plus who may push each replaced-ledger refund (by the record's owner ON THAT
// ledger) and one holding per ledger. Scripted JSON-RPC, no browser.
//   run: node --test test/site-platform-ledger-recovery.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeFunctionData, parseAbi, keccak256, toBytes, stringToHex } from "viem";

const addr = (n) => "0x" + n.toString(16).padStart(40, "0");
const ROOT = addr(0xb00c), REGISTRY = addr(1), OLD = addr(2), CATALOG = addr(3), NEW = addr(4), CATALOG2 = addr(5), USDC = addr(6);
const HIST0 = addr(9), HIST1 = addr(10), THROUGH = 100;   // HIST0: replaced before the profile was generated
const profile = { format: "enclave-browser-profile", version: 1, chainId: 8453, addressBook: ROOT,
  ledgerHistory: { through: String(THROUGH), ledgers: [HIST0] },
  rpcs: ["https://a.example", "https://b.example"], quorum: 2, confirmations: 0, maxBlockAgeSeconds: 600,
  contractPins: { version: 1, chainId: 8453, contracts: { registry: REGISTRY, deployments: OLD, appCatalog: CATALOG,
    proofOfTime: OLD, enclavePay: addr(0), verificationFees: addr(0), sessionVaultFactory: addr(7), secretVaultV2: addr(0) } }, usdc: USDC };
const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
const text = JSON.stringify(profile);
globalThis.localStorage = mem(new Map([["enclave_independent_profile", text]]));
globalThis.sessionStorage = mem(new Map([["enclave_independent_ack", text]]));
globalThis.location = { hostname: "localhost", origin: "https://dash.example" };

const NOW = Math.floor(Date.now() / 1000);
const chain = { block: 100, book: { registry: REGISTRY, deployments: OLD, appCatalog: CATALOG }, logs: [], lie: null, asked: [] };
const SET_TOPIC = keccak256(toBytes("AddressSet(bytes32,address)")), KEY_DEPLOYMENTS = stringToHex("deployments", { size: 32 });
const setLog = (block, value, over = {}) => ({ address: ROOT, blockNumber: "0x" + block.toString(16), blockHash: "0x" + block.toString(16).padStart(64, "0"),
  logIndex: "0x0", transactionHash: "0x" + "77".repeat(32), topics: [SET_TOPIC, KEY_DEPLOYMENTS], data: "0x" + value.slice(2).padStart(64, "0"), ...over });
const key = (s) => "0x" + Buffer.from(s).toString("hex").padEnd(64, "0");
globalThis.fetch = async (url, init) => {
  const { id, method, params } = JSON.parse(init.body);
  const result = (() => {
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_blockNumber") return "0x" + chain.block.toString(16);
    if (method === "eth_getBlockByNumber") return { number: params[0], hash: "0x" + Number(params[0]).toString(16).padStart(64, "0"), timestamp: "0x" + NOW.toString(16) };
    if (method === "eth_getCode") return "0x6080";
    if (method === "eth_getLogs"){
      const q = params[0], from = Number(q.fromBlock), to = Number(q.toBlock);
      chain.asked.push({ url, from, to, address: q.address, topics: q.topics });
      const logs = url.startsWith("https://b.") && chain.lie ? chain.lie : chain.logs;
      return logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
    }
    if (method === "eth_call" && params[0].data === "0x8da5cb5b") return "0x" + "0".repeat(24) + "0b2d".padStart(40, "0");
    if (method === "eth_call" && params[0].data === "0x10c4e8b0"){
      const entries = Object.entries(chain.book);
      return encodeAbiParameters([{ type: "bytes32[]" }, { type: "address[]" }], [entries.map(([k]) => key(k)), entries.map(([, v]) => v)]);
    }
    throw new Error("unexpected " + method);
  })();
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
};

const LEDGER = parseAbi(["function refund(bytes32)", "function setActive(bytes32,bool)", "function fund(bytes32,uint256)", "function withdrawEarned()"]);
const ERC20 = parseAbi(["function approve(address,uint256)"]);
const ID = "0x" + "ab".repeat(32);
const refund = encodeFunctionData({ abi: LEDGER, functionName: "refund", args: [ID] });
const suspend = encodeFunctionData({ abi: LEDGER, functionName: "setActive", args: [ID, false] });
const resume = encodeFunctionData({ abi: LEDGER, functionName: "setActive", args: [ID, true] });
const fund = encodeFunctionData({ abi: LEDGER, functionName: "fund", args: [ID, 1n] });
const approveOld = encodeFunctionData({ abi: ERC20, functionName: "approve", args: [OLD, 1n] });
const step = (book) => { Object.assign(chain.book, book); chain.block += 1; };
const RETIRED = /retired platform contract/;

test("recovery calldata is recognized exactly", async () => {
  const { isLedgerRecoveryCall } = await import("../site/js/core/platform-addresses.js");
  assert.equal(isLedgerRecoveryCall(refund), true);
  assert.equal(isLedgerRecoveryCall(suspend), true);
  for (const data of [resume, fund, refund + "00", refund + "00".repeat(32), refund.slice(0, -2), "0x", "", null,
    encodeFunctionData({ abi: LEDGER, functionName: "withdrawEarned" })])
    assert.equal(isLedgerRecoveryCall(data), false, String(data));
});

test("a replaced ledger is recovery-only in the tab that followed the change; other replaced targets stay refused", async () => {
  const P = await import("../site/js/core/platform-addresses.js");
  assert.equal(P.platformBookEnabled, true);
  await P.assertPlatformTransactionCurrent(OLD, fund);                 // the book still selects the pinned ledger
  step({ deployments: NEW, appCatalog: CATALOG2 });
  await assert.rejects(P.assertPlatformTransactionCurrent(OLD, refund), /addresses changed/, "the change itself is reviewed first");
  assert.deepEqual(P.retiredLedgers().sort(), [OLD, HIST0].sort());
  await P.assertPlatformTransactionCurrent(OLD, refund);
  await P.assertPlatformTransactionCurrent(OLD, suspend);
  for (const [to, data] of [[OLD, fund], [OLD, resume], [OLD, refund + "00".repeat(32)], [USDC, approveOld], [CATALOG, refund]])
    await assert.rejects(P.assertPlatformTransactionCurrent(to, data), RETIRED, to + " " + data.slice(0, 10));
  await P.assertPlatformTransactionCurrent(NEW, fund);
  // the administrator selects the original ledger again: it is an active binding, not a retired one
  step({ deployments: OLD });
  await assert.rejects(P.assertPlatformTransactionCurrent(OLD, fund), /addresses changed/);
  await P.assertPlatformTransactionCurrent(OLD, fund);
  assert.deepEqual(P.retiredLedgers().sort(), [NEW, HIST0].sort(), "the briefly selected ledger is the replaced one now");
  await assert.rejects(P.assertPlatformTransactionCurrent(NEW, fund), RETIRED);
  await P.assertPlatformTransactionCurrent(NEW, refund);
  step({ deployments: NEW });
  await assert.rejects(P.assertPlatformTransactionCurrent(NEW, fund), /addresses changed/);
});

test("a fresh tab derives the replaced ledger from the profile's original pin (no retained cache)", async () => {
  // a new module instance: no state from the tab above; the bound addresses come from the book again
  const P = await import("../site/js/core/platform-addresses.js?fresh-tab");
  step({});
  await P.resolvePlatformAddresses();
  assert.deepEqual(P.retiredLedgers().sort(), [OLD, HIST0].sort());
  await P.assertPlatformTransactionCurrent(OLD, refund);
  await assert.rejects(P.assertPlatformTransactionCurrent(OLD, fund), RETIRED);
  await assert.rejects(P.assertPlatformTransactionCurrent(USDC, approveOld), RETIRED);
  // a ledger replaced before the profile was generated: known from the profile's history alone, recovery-only
  await P.assertPlatformTransactionCurrent(HIST0, refund);
  await P.assertPlatformTransactionCurrent(HIST0, suspend);
  for (const data of [fund, resume]) await assert.rejects(P.assertPlatformTransactionCurrent(HIST0, data), RETIRED);
});

test("the profile's ledgerHistory: only with a book, block number, distinct nonzero addresses, at most 32", async () => {
  const { validateProfile } = await import("../site/js/core/independent.js");
  const ok = validateProfile(profile);
  assert.deepEqual(ok.ledgerHistory, { through: THROUGH, ledgers: [HIST0] });
  assert.equal(validateProfile({ ...profile, ledgerHistory: undefined }).ledgerHistory, null);
  for (const bad of [{ through: "x", ledgers: [] }, { through: 5, ledgers: [] }, { through: "5" }, { through: "5", ledgers: [addr(0)] },
    { through: "5", ledgers: [HIST0, HIST0.toUpperCase().replace("0X", "0x")] }, { through: "5", ledgers: Array.from({ length: 33 }, (_, i) => addr(100 + i)) },
    { through: "5", ledgers: [], extra: 1 }])
    assert.throws(() => validateProfile({ ...profile, ledgerHistory: bad }), /ledgerHistory/, JSON.stringify(bad).slice(0, 80));
  assert.throws(() => validateProfile({ ...profile, addressBook: undefined }), /ledgerHistory needs an addressBook/);
});

test("after the profile's block: the book's own AddressSet(deployments) events, agreed by the quorum, bounded per call", async () => {
  const P = await import("../site/js/core/platform-addresses.js?history-scan");
  chain.logs = [setLog(THROUGH + 3, HIST1), setLog(THROUGH + 5, NEW), setLog(THROUGH + 6, addr(0))];
  chain.block = Math.max(chain.block, THROUGH + 8);
  await P.resolvePlatformAddresses();
  const snap = await P.platformBookReader().snapshot();
  chain.asked = [];
  const status = await P.scanLedgerHistory(snap);
  assert.deepEqual(status, { complete: true, through: snap.number, head: snap.number });
  assert.ok(chain.asked.length >= 2 && chain.asked.every((q) => q.address.toLowerCase() === ROOT && q.from > THROUGH
    && JSON.stringify(q.topics) === JSON.stringify([SET_TOPIC, KEY_DEPLOYMENTS])), "only the book's deployments history after `through`");
  assert.deepEqual(P.retiredLedgers().sort(), [OLD, HIST0, HIST1].sort(), "the current ledger is never a replaced one; zero is skipped");
  await P.assertPlatformTransactionCurrent(HIST1, refund);
  await assert.rejects(P.assertPlatformTransactionCurrent(HIST1, fund), RETIRED);
  // nothing new: no further requests
  chain.asked = [];
  assert.equal((await P.scanLedgerHistory(snap)).complete, true);
  assert.equal(chain.asked.length, 0);
});

test("a disagreeing or malformed history adds nothing; a long gap is scanned in bounded steps and labeled until done", async () => {
  const lying = await import("../site/js/core/platform-addresses.js?history-lie");
  chain.logs = [setLog(THROUGH + 3, HIST1)];
  chain.lie = [setLog(THROUGH + 3, HIST1), setLog(THROUGH + 4, addr(66))];    // one RPC invents a ledger
  await lying.resolvePlatformAddresses();
  const snap = await lying.platformBookReader().snapshot();
  await assert.rejects(lying.scanLedgerHistory(snap), /disagree on event logs/);
  assert.ok(!lying.retiredLedgers().includes(addr(66)), "an invented ledger is never listed, so never offered for recovery");
  chain.lie = null;
  const malformed = await import("../site/js/core/platform-addresses.js?history-malformed");
  chain.logs = [setLog(THROUGH + 3, HIST1, { topics: [SET_TOPIC, stringToHex("appCatalog", { size: 32 })] })];
  await malformed.resolvePlatformAddresses();
  await assert.rejects(malformed.scanLedgerHistory(await malformed.platformBookReader().snapshot()), /malformed AddressSet/);
  assert.ok(!malformed.retiredLedgers().includes(HIST1));
  // a gap longer than one call's bound
  const slow = await import("../site/js/core/platform-addresses.js?history-bounded");
  chain.logs = [setLog(THROUGH + slow.HISTORY_SPAN * slow.HISTORY_CHUNKS_PER_CALL + 10, HIST1)];
  chain.block = THROUGH + slow.HISTORY_SPAN * slow.HISTORY_CHUNKS_PER_CALL + 50;
  await slow.resolvePlatformAddresses();
  const s2 = await slow.platformBookReader().snapshot();
  const first = await slow.scanLedgerHistory(s2);
  assert.equal(first.complete, false);
  assert.equal(first.through, THROUGH + slow.HISTORY_SPAN * slow.HISTORY_CHUNKS_PER_CALL);
  assert.match(first.reason, /checked through block/);
  assert.ok(!slow.retiredLedgers().includes(HIST1), "not seen yet, and not claimed");
  assert.deepEqual(await slow.scanLedgerHistory(s2), { complete: true, through: s2.number, head: s2.number });
  assert.ok(slow.retiredLedgers().includes(HIST1));
});

test("who may push a replaced-ledger refund follows the record's owner ON THAT LEDGER and the ledger's retirement", async () => {
  const { recoveryRoute } = await import("../site/js/core/ledger-recovery.js");
  const W = addr(0xa1), V = addr(0xa2), S = addr(0xa3), SV = addr(0xa4), E = addr(0xa5);
  const wallet = { identity: "wallet", acting: W }, account = { identity: "account", acting: S };
  for (const [h, who, want] of [
    [{ owner: W, ledgerRetired: false }, wallet, "wallet"],
    [{ owner: V, ledgerRetired: false }, wallet, ""],            // the wallet's session vault: only the vault could
    [{ owner: V, ledgerRetired: true }, wallet, "wallet"],       // retired: anyone pushes; it pays the vault
    [{ owner: S, ledgerRetired: false }, account, "account"],    // the Safe's own record: the account's own path
    [{ owner: SV, ledgerRetired: false }, account, ""],
    [{ owner: SV, ledgerRetired: true }, account, "account"],
    [{ owner: E, ledgerRetired: false }, account, ""],           // never through an unrelated gas-paying wallet
    [{ owner: W, ledgerRetired: true }, { identity: "wallet", acting: null }, ""]])
    assert.equal(recoveryRoute(h, who), want, JSON.stringify([h, who]));
});

test("every replaced-ledger record stays its own holding, with its owner there: carried-over and left-behind records", async () => {
  const { withReplacedHoldings } = await import("../site/js/core/independent-chain.js");
  const { recoveryRoute } = await import("../site/js/core/ledger-recovery.js");
  const W = addr(0xa1), V = addr(0xa2), X = "0x" + "11".repeat(32), Y = "0x" + "22".repeat(32);
  const L0 = addr(0xc0), L1 = addr(0xc1), snap = { number: 120, timestamp: NOW };
  const old = (id, owner) => ({ id, owner, runner: "0x" + "00".repeat(32), leaseUntil: 0n, active: true, balance6: 5n, spent6: 0n, rate: 1n,
    appRef: "catalog://x/0", gpuMilli: 0, cpuMilli: 100, createdAt: 1n, isPublic: true });
  // X was carried over and is now held by the WALLET; on L0 its owner was the vault, on L1 the wallet
  const rows = [{ id: X, owner: W }];
  const records = [{ ledger: L0, ledgerRetired: false, row: old(X, V), refundable6: 300n, rev: 16, snap },
    { ledger: L1, ledgerRetired: false, row: old(X, W), refundable6: 700n, rev: 16, snap },
    { ledger: L1, ledgerRetired: false, row: old(X, W), refundable6: 700n, rev: 16, snap },        // a repeat adds nothing
    { ledger: L0, ledgerRetired: true, row: old(Y, W), refundable6: 0n, rev: 16, snap },
    { ledger: L1, ledgerRetired: false, row: old(Y, V), refundable6: 9n, rev: 16, snap }];
  withReplacedHoldings(rows, records);
  assert.equal(rows.length, 2, "one row per record");
  const x = rows.find((r) => r.id === X), y = rows.find((r) => r.id === Y);
  assert.equal(x.owner, W, "the current row keeps its current owner");
  assert.deepEqual(x.replacedHoldings.map((h) => [h.ledger, h.owner, h.refundable6]), [[L0, V, "300"], [L1, W, "700"]], "both balances, each with its owner there");
  assert.deepEqual(x.replacedHoldings.map((h) => recoveryRoute(h, { identity: "wallet", acting: W })), ["", "wallet"],
    "the vault's balance on L0 is not offered to the wallet that holds the record NOW");
  assert.equal(y.retiredLedger, L0, "left behind: a read-only row");
  assert.deepEqual(y.replacedHoldings.map((h) => [h.ledger, h.owner, h.ledgerRetired, h.refundable6]), [[L0, W, true, "0"], [L1, V, false, "9"]]);
  // ownership the other way round: the wallet's balance on L0 although its vault holds the record now
  const z = [{ id: X, owner: V }];
  withReplacedHoldings(z, [{ ledger: L0, ledgerRetired: false, row: old(X, W), refundable6: 4n, rev: 16, snap }]);
  assert.equal(recoveryRoute(z[0].replacedHoldings[0], { identity: "wallet", acting: W }), "wallet");
});
