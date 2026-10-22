// Offline tests of batch-plan.mjs with a fake RPC quorum shaped like QuorumChain (peers, snapshot, chainId) and fake viem
// clients. Code hashes come through the explicit codeHashOf test seam (no preimage of the production code hash exists here).
// The reviewed generator/verifier and the reviewed bridge are used unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url)), PKG = process.env.BATCH_PLAN_DIR || path.resolve(HERE, ".."), W = process.env.ENCLAVE_WORK || path.resolve(PKG, "..");
const req = createRequire(path.join(W, "enclave/package.json"));
const { encodeAbiParameters, encodeEventTopics, decodeFunctionData, encodeFunctionData } = await import(req.resolve("viem"));
const P = await import(path.join(PKG, "batch-plan.mjs"));
const { batchPlan, RESERVE, LEDGER, MULTICALL3, AMOUNT_WEI, Refusal, verifyProposal, PLAN_PREFIX } = P;
const BT = await import(path.join(W, "ens-outage-20261022/batch-topup-review/batch-topup.mjs"));
const { createBridge, HttpError } = await import(path.join(W, "ens-outage-20261022/deposit-ui/bridge.mjs"));

const OWNER = "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61";
const MC3_HASH = "0x" + "ab".repeat(32);
const HASHES = { mc3: MC3_HASH, reserve: BT.RESERVE_CODEHASH, ledger: BT.LEDGER_CODEHASH };
const manifest = JSON.parse(fs.readFileSync(path.join(PKG, "manifest.json"), "utf8"));
const TOTAL = "10000000000000000";
const NOW = 1_792_680_000_000;
const lc = (s) => String(s).toLowerCase();

/** A world all peers share unless a test gives one peer its own. */
function world() {
  const rows = new Map(manifest.rows.map((r, i) => [r.id, { id: r.id, owner: r.currentOwner, active: true, enabled: true, blocked: false, balance: 10n ** 12n,
    appRef: `catalog://0x${String(i + 1).padStart(64, "0")}/${i}` }]));
  return { rows, paused: false, codes: { [lc(MULTICALL3)]: "0xmc3", [lc(RESERVE)]: "0xreserve", [lc(LEDGER)]: "0xledger" }, senderBalance: 10n ** 17n, receipts: new Map() };
}
const codeHashOf = (code) => ({ "0xmc3": HASHES.mc3, "0xreserve": HASHES.reserve, "0xledger": HASHES.ledger })[code] ?? "0x" + "00".repeat(32);
function client(w) {
  return {
    getCode: async ({ address }) => w.codes[lc(address)],
    getBalance: async () => w.senderBalance,
    getBlock: async () => ({ hash: "0x" + "b1".repeat(32), timestamp: BigInt(Math.floor(NOW / 1000) - 30) }),
    getTransactionReceipt: async ({ hash }) => w.receipts.get(hash) ?? null,
    readContract: async ({ address, functionName, args }) => {
      if (lc(address) === lc(RESERVE) && functionName === "paused") return w.paused;
      if (lc(address) === lc(LEDGER) && functionName === "get") {
        const r = w.rows.get(args[0]);
        return r ? { id: r.id, owner: r.owner, active: r.active, appRef: r.appRef } : { id: "0x" + "00".repeat(32), owner: "0x" + "00".repeat(20), active: false, appRef: "" };
      }
      if (lc(address) === lc(RESERVE) && functionName === "reserveOf") { const r = w.rows.get(args[0]); return { enabled: !!r && r.enabled && lc(args[1]) === lc(r.owner), balanceWei: r ? r.balance : 0n }; }
      if (lc(address) === lc(RESERVE) && functionName === "blockedDeployment") return w.rows.get(args[0])?.blocked ?? false;
      if (functionName === "getApp") return { name: `App-${args[0].slice(-2)}` };
      if (functionName === "getVersion") return { version: `1.0.${args[1]}` };
      throw new Error(`unexpected read ${functionName}`);
    },
  };
}
/** Shaped like QuorumChain: peers [{origin, client}], snapshot(fn) agreeing on >= quorum identical answers at one block. */
function chainOf(worlds, { quorum = 2, ageSec = 30 } = {}) {
  const peers = worlds.map((w, i) => ({ origin: `https://rpc${i}.example`, client: w ? client(w) : null }));
  return { chainId: 8453, peers, async snapshot(fn) {
    const B = 52950000n, H = "0x" + "b1".repeat(32), groups = new Map();
    for (const p of peers) {
      if (!p.client) continue;
      try { const v = await fn(p.client, B); const k = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)); groups.set(k, [...(groups.get(k) || []), v]); } catch {}
    }
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    if (!best || best.length < quorum) throw new Error("no quorum");
    return { value: best[0], blockNumber: B, blockHash: H, timestamp: NOW - ageSec * 1000, agreeing: best.length, peers: peers.length };
  } };
}
const plan = (opts = {}) => batchPlan({ manifest, from: OWNER, multicall3CodeHash: MC3_HASH, expectTotalWei: TOTAL, now: () => NOW, codeHashOf, ...opts });
const check = (p, chain) => p.steps[0].check(chain);

test("ready: one aggregate3Value to Multicall3, 10 deposit(bytes32) calls, allowFailure false, 0.01 ETH, current catalog labels", async () => {
  const w = world(), v = await check(plan(), chainOf([w, w, w]));
  assert.equal(v.state, "ready", v.reason);
  assert.equal(lc(v.tx.to), lc(MULTICALL3)); assert.equal(v.tx.value, 10n ** 16n);
  const calls = decodeFunctionData({ abi: [{ type: "function", name: "aggregate3Value", stateMutability: "payable", inputs: [{ name: "calls", type: "tuple[]",
    components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }], outputs: [] }], data: v.tx.data }).args[0];
  assert.equal(calls.length, 10);
  assert.ok(calls.every((c, i) => lc(c.target) === lc(RESERVE) && c.allowFailure === false && c.value === AMOUNT_WEI && lc(c.callData) === lc("0xb214faa5" + manifest.rows[i].id.slice(2))));
  assert.equal(v.facts.hosts.length, 3);
  assert.match(v.facts.rows[0].label, /^App-\w\w 1\.0\.0 \(catalog 0x000000 v0\)$/);
  assert.ok(!plan().steps[0].effects(v.facts).some((t) => /renew/i.test(t)), "no renewal-count labels");
});

test("plan refuses wrong amount, the adapter, a duplicate id and a wrong stated total before any read", () => {
  const m = structuredClone(manifest); m.rows[0].amountWei = "2000000000000000";
  assert.throws(() => batchPlan({ manifest: m, from: OWNER, multicall3CodeHash: MC3_HASH, expectTotalWei: TOTAL }), Refusal);
  const a = structuredClone(manifest); a.rows[0].id = "0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33";
  assert.throws(() => batchPlan({ manifest: a, from: OWNER, multicall3CodeHash: MC3_HASH, expectTotalWei: TOTAL }), /excluded/);
  const d = structuredClone(manifest); d.rows[1].id = d.rows[0].id;
  assert.throws(() => batchPlan({ manifest: d, from: OWNER, multicall3CodeHash: MC3_HASH, expectTotalWei: TOTAL }), /duplicate/);
  assert.throws(() => batchPlan({ manifest, from: OWNER, multicall3CodeHash: MC3_HASH, expectTotalWei: "20000000000000000" }), /exact total/);
});

test("fresh reads block: owner changed, unknown id, inactive, paused, blocked, disabled, Multicall3 code, stale block, low balance", async () => {
  const cases = [
    ["owner changed", (w) => { w.rows.get(manifest.rows[2].id).owner = "0x" + "12".repeat(20); }, /current owner/],
    ["unknown id", (w) => { w.rows.delete(manifest.rows[3].id); }, /does not know/],
    ["inactive", (w) => { w.rows.get(manifest.rows[4].id).active = false; }, /not active/],
    ["paused", (w) => { w.paused = true; }, /paused/],
    ["blocked", (w) => { w.rows.get(manifest.rows[5].id).blocked = true; }, /blocked/],
    ["disabled", (w) => { w.rows.get(manifest.rows[6].id).enabled = false; }, /not enabled/],
    ["multicall3 code", (w) => { w.codes[lc(MULTICALL3)] = "0xother"; }, /Multicall3 code/],
    ["low balance", (w) => { w.senderBalance = 10n ** 16n; }, /balance does not cover/],
  ];
  for (const [name, mutate, re] of cases) {
    const w = world(); mutate(w);
    const v = await check(plan(), chainOf([w, w, w]));
    assert.equal(v.state, "blocked", name); assert.match(v.reason, re, name);
  }
  const w = world(), stale = await check(plan(), chainOf([w, w, w], { ageSec: 900 }));
  assert.equal(stale.state, "blocked"); assert.match(stale.reason, /s old/);
});

test("quorum: one disagreeing peer is outvoted (2 hosts evidence); without two agreeing peers nothing is decided", async () => {
  const w = world(), odd = world(); odd.rows.get(manifest.rows[0].id).owner = "0x" + "34".repeat(20);
  const v = await check(plan(), chainOf([w, w, odd]));
  assert.equal(v.state, "ready"); assert.equal(v.facts.hosts.length, 2);
  await assert.rejects(check(plan(), chainOf([w, odd, null])), /no quorum/);
});

test("atomic decode: tampered allowFailure, value, target or a double payment is refused by the reviewed verifier", async () => {
  const w = world(), v = await check(plan(), chainOf([w, w, w]));
  const crypto = await import("node:crypto");
  const proposal = (data, value) => ({ format: BT.PROPOSAL_FORMAT, chainId: 8453, to: MULTICALL3, value, data, dataSha256: crypto.createHash("sha256").update(data).digest("hex"),
    rows: manifest.rows.map((r) => ({ id: r.id, amountWei: r.amountWei })) });
  assert.doesNotThrow(() => verifyProposal(proposal(v.tx.data, TOTAL)));
  const abi = [{ type: "function", name: "aggregate3Value", stateMutability: "payable", inputs: [{ name: "calls", type: "tuple[]",
    components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }], outputs: [] }];
  const calls = decodeFunctionData({ abi, data: v.tx.data }).args[0];
  const enc = (cs) => encodeFunctionData({ abi, functionName: "aggregate3Value", args: [cs] });
  assert.throws(() => verifyProposal(proposal(enc(calls.map((c, i) => (i === 3 ? { ...c, allowFailure: true } : c))), TOTAL)), /allows failure/);
  assert.throws(() => verifyProposal(proposal(enc(calls.map((c, i) => (i === 0 ? { ...c, value: c.value * 2n } : c))), "11000000000000000")), /reviewed amount/);
  assert.throws(() => verifyProposal(proposal(enc(calls.map((c, i) => (i === 1 ? { ...c, target: MULTICALL3 } : c))), TOTAL)), /not the production reserve/);
  assert.throws(() => verifyProposal(proposal(v.tx.data, "9000000000000000")), /value differs/);
  assert.throws(() => verifyProposal({ ...proposal(enc(calls.map((c, i) => (i === 1 ? calls[0] : c))), TOTAL) }), /differs from row|paid twice/);
});

// receipts for the duplicate / done rules
const depositedLog = (id, owner, from = MULTICALL3, amount = AMOUNT_WEI) => ({ address: RESERVE,
  topics: encodeEventTopics({ abi: [{ type: "event", name: "Deposited", inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "owner", type: "address", indexed: true },
    { name: "from", type: "address", indexed: true }, { name: "amountWei", type: "uint256", indexed: false }] }], eventName: "Deposited", args: { id, owner, from } }),
  data: encodeAbiParameters([{ type: "uint256" }], [amount]) });
const HASH = "0x" + "cd".repeat(32);
const receipt = (logs, extra = {}) => ({ status: "success", from: OWNER, to: MULTICALL3, blockNumber: 52950010n, logs, ...extra });
const goodLogs = () => manifest.rows.map((r) => depositedLog(r.id, r.currentOwner));

test("done only with a quorum-read receipt proving exactly the 10 planned deposits; anything else is blocked, never ready again", async () => {
  const p0 = plan(), confirmed = [{ id: "tx-abcdef12-00000001", from: OWNER, chainId: 8453, state: "confirmed", hash: HASH, bridge: { plan: p0.id, step: "batch-deposit" } }];
  const p = plan({ intents: () => confirmed });
  const run = async (logs, extra) => { const w = world(); w.receipts.set(HASH, receipt(logs, extra)); return check(p, chainOf([w, w, w])); };
  const ok = await run(goodLogs());
  assert.equal(ok.state, "done", ok.reason); assert.equal(ok.facts.receipt.deposits, 10);
  for (const [name, logs, extra, re] of [
    ["one missing", goodLogs().slice(1), {}, /missing/],
    ["wrong owner", [depositedLog(manifest.rows[0].id, "0x" + "56".repeat(20)), ...goodLogs().slice(1)], {}, /credited to/],
    ["wrong amount", [depositedLog(manifest.rows[0].id, manifest.rows[0].currentOwner, MULTICALL3, 2n * AMOUNT_WEI), ...goodLogs().slice(1)], {}, /payer or amount/],
    ["double", [...goodLogs(), depositedLog(manifest.rows[0].id, manifest.rows[0].currentOwner)], {}, /second deposit/],
    ["unplanned", [...goodLogs(), depositedLog("0x" + "77".repeat(32), OWNER)], {}, /unplanned/],
    ["reverted", goodLogs(), { status: "reverted" }, /status/],
    ["other sender", goodLogs(), { from: "0x" + "99".repeat(20) }, /sender or recipient/],
  ]) { const v = await run(logs, extra); assert.equal(v.state, "blocked", name); assert.match(v.reason, re, name); }
  // another batch plan's open or confirmed intent blocks this plan: never a second batch
  for (const state of ["handoff", "submitted", "confirmed", "mismatch"]) {
    const q = plan({ intents: () => [{ id: "tx-abcdef12-00000009", from: OWNER, chainId: 8453, state, hash: HASH, bridge: { plan: `${PLAN_PREFIX}-0000000000000000`, step: "batch-deposit" } }] });
    const w = world(), v = await check(q, chainOf([w, w, w]));
    assert.equal(v.state, "blocked", state); assert.match(v.reason, /never paid twice/);
  }
  // a rejected or abandoned other-plan intent (provably unsent) does not block
  const r = plan({ intents: () => [{ id: "tx-abcdef12-0000000a", from: OWNER, chainId: 8453, state: "rejected", bridge: { plan: `${PLAN_PREFIX}-0000000000000000` } }] });
  const w = world(); assert.equal((await check(r, chainOf([w, w, w]))).state, "ready");
});

test("through the reviewed bridge: a done plan offers no prepare, and prepare is refused (no signer, no wallet)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-journal-"));
  try {
    const p0 = plan(), w = world(); w.receipts.set(HASH, receipt(goodLogs()));
    const p = plan({ intents: () => [{ id: "tx-abcdef12-00000001", from: OWNER, chainId: 8453, state: "confirmed", hash: HASH, bridge: { plan: p0.id, step: "batch-deposit" } }] });
    const bridge = createBridge({ chain: chainOf([w, w, w]), plan: p, journalDir: dir });
    const s = await bridge.state({ fresh: true });
    assert.equal(s.steps[0].verdict.state, "done"); assert.equal(s.steps[0].canPrepare, false);
    await assert.rejects(bridge.prepare("batch-deposit"), (e) => e instanceof HttpError && e.status === 409);
    const fresh = createBridge({ chain: chainOf([w, w, w]), plan: plan(), journalDir: dir });
    const s2 = await fresh.state({ fresh: true });
    assert.equal(s2.steps[0].verdict.state, "ready"); assert.equal(s2.steps[0].canPrepare, true);
    assert.equal(s2.steps[0].verdict.tx, undefined, "the page state never carries transaction fields");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
