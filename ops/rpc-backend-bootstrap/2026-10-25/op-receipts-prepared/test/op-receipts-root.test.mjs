// node --test test/op-receipts-root.test.mjs   (ANCHOR_DEPS_ROOT=<checkout with node_modules>; see deps.mjs)
// Independent known-root vectors (no network):
//  - REAL Base mainnet blocks 52965266..52965293 (28 headers, full receipts for 5 blocks = 1,824 receipts), captured
//    2026-10-23 from an untrusted RPC and previously verified by op-geth DeriveSha (rpc-receipt-witness, sha 921a72e6...);
//    here every header is re-authenticated by recomputed keccak(RLP) against its own hash and the parent chain.
//  - REAL Ethereum mainnet block 0x14e8d38 receipts (Helios upstream test data, 2af9b418).
//  - UPSTREAM-ASSERTED base v1.5.1 proof.rs vectors (Bedrock / Regolith quirk / Canyon / EIP-2930 fixed bloom).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256, toRlp } from "./deps.mjs";
import { headerHash } from "../vendor/anchor-bootstrap.mjs";
import { planCompleteScan, assembleCompleteLogs } from "../vendor/complete-logs.mjs";
import { verifyBlockReceipts, consensusReceiptsRoot, orderedTrieRoot, encodeConsensusReceipt, completeLogsEntry, BASE_MAINNET, ETHEREUM_MAINNET, ReceiptsError } from "../op-receipts-root.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => path.join(here, "fixtures", n);
const k = (b) => keccak_256(b);
const deps = { keccak: k, headerHash };
const code = (c) => (e) => e instanceof ReceiptsError && e.code === c;
const clone = (x) => JSON.parse(JSON.stringify(x));
const hexb = (h) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));

const BASE = JSON.parse(zlib.gunzipSync(fs.readFileSync(fx("base-mainnet-52965266-52965293.json.gz"))));
const HEADERS = BASE.headers, RECEIPTS = BASE.receipts;
const headerOf = (n) => HEADERS.find((h) => Number(BigInt(h.number)) === Number(n));
const baseBlock = (n) => ({ header: headerOf(n), expectedBlockHash: headerOf(n).hash, receipts: RECEIPTS[String(n)], chain: BASE_MAINNET });
const DEPOSIT_BLOCK = Object.keys(RECEIPTS).map(Number).find((n) => RECEIPTS[n].some((r) => r.type === "0x7e"));

test("empty trie root and upstream base proof.rs vectors (Bedrock, Regolith nonce-strip quirk, Canyon, EIP-2930)", () => {
  assert.equal(orderedTrieRoot([], k), "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421");
  const v = JSON.parse(fs.readFileSync(fx("base-proofrs-vectors.json"), "utf8"));
  const recs = v.receipts.map((r) => ({ type: r.type, status: r.status, cumulativeGasUsed: BigInt(r.cumulativeGasUsed),
    logs: r.logs.map((l) => ({ address: hexb(l.address), topics: l.topics.map(hexb), data: hexb(l.data) })),
    ...(r.depositNonce !== undefined ? { depositNonce: BigInt(r.depositNonce) } : {}) }));
  for (const c of v.cases) {
    const strip = c.timestamp >= v.regolithTimestamp && c.timestamp < v.canyonTimestamp;
    assert.equal(consensusReceiptsRoot(recs, k, { stripDepositNonce: strip }), c.root, c.name);
  }
  const reg = v.cases.find((c) => c.name === "regolith");
  assert.notEqual(consensusReceiptsRoot(recs, k, { stripDepositNonce: false }), reg.root, "the Regolith quirk must matter");
  const e = v.eip2930.receipt;
  const r2930 = { type: e.type, status: e.status, cumulativeGasUsed: BigInt(e.cumulativeGasUsed), bloom: hexb(e.bloom),
                  logs: e.logs.map((l) => ({ address: hexb(l.address), topics: [], data: hexb(l.data) })) };
  assert.equal(orderedTrieRoot([encodeConsensusReceipt(r2930, k)], k), v.eip2930.root);
});

test("REAL Ethereum mainnet block: 202 receipts reproduce the authenticated header's receiptsRoot", () => {
  const block = JSON.parse(fs.readFileSync(fx("helios-mainnet-block.json"), "utf8"));
  const receipts = JSON.parse(fs.readFileSync(fx("helios-mainnet-receipts.json"), "utf8"));
  const r = verifyBlockReceipts({ header: block, expectedBlockHash: block.hash, receipts, txHashes: block.transactions, chain: ETHEREUM_MAINNET }, deps);
  assert.equal(r.receiptsRoot, block.receiptsRoot.toLowerCase());
  assert.equal(r.txHashBinding, "verified-body");
});

test("REAL Base mainnet: 5 blocks, 1,824 receipts (types 0x0/0x1/0x2/0x4/0x7e) reproduce receiptsRoot; headers authenticated", () => {
  let n = 0;
  for (const num of Object.keys(RECEIPTS)) {
    const b = baseBlock(num);
    const r = verifyBlockReceipts({ ...b, txHashes: b.header.transactions }, deps);
    assert.equal(r.receiptsRoot, b.header.receiptsRoot.toLowerCase());
    n += b.receipts.length;
  }
  assert.equal(n, 1824);
  for (let i = 0; i < HEADERS.length; i++) {
    assert.equal(headerHash(HEADERS[i], k), HEADERS[i].hash.toLowerCase(), `header ${i} recomputes`);
    if (i) assert.equal(HEADERS[i].parentHash.toLowerCase(), HEADERS[i - 1].hash.toLowerCase(), `header ${i} links`);
  }
});

test("complete-logs integration: bloom plan over 28 real linked headers + verified receipt entries recover the real lease event", () => {
  const headers = HEADERS.map((h) => ({ number: Number(BigInt(h.number)), hash: headerHash(h, k), parentHash: h.parentHash.toLowerCase(),
                                        receiptsRoot: h.receiptsRoot.toLowerCase(), logsBloom: h.logsBloom.toLowerCase() }));
  const filter = { ledger: BASE.ledger, id: BASE.deploymentId, topic0s: ["0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0",
    "0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e", "0x0e334fd11ab7bea6d2bda89338c0f25674e099b70dd28aaaee262fbecba48882"] };
  const plan = planCompleteScan(headers, { number: headers.at(-1).number, blockHash: headers.at(-1).hash }, filter, k);
  // TEST STAND-IN ONLY: txHashes = the RPC header's transaction list, which is NOT authenticated here. Production must
  // pass hashes from a transactionsRoot-verified body; without any body the export is refused (next test).
  const entries = new Map(plan.candidates.map((c) => completeLogsEntry(verifyBlockReceipts({ ...baseBlock(c.number), txHashes: headerOf(c.number).transactions }, deps))));
  const logs = assembleCompleteLogs(plan, entries, filter);
  const ev = BASE.lastEvent;
  assert.ok(logs.some((l) => l.transactionHash === ev.transactionHash && l.logIndex === Number(BigInt(ev.logIndex)) && l.topics[0] === ev.topic0), "real Renewed event found");
  assert.equal(plan.candidates.length, Object.keys(RECEIPTS).length);
  // a candidate whose receipts are not verified -> incomplete (never empty history)
  const missing = new Map([...entries].slice(1));
  assert.throws(() => assembleCompleteLogs(plan, missing, filter), (e) => e.code === "incomplete");
});

const D = () => baseBlock(DEPOSIT_BLOCK);
const neg = [
  ["drop last receipt", (b) => { b.receipts.pop(); }, "gas_total"],
  ["drop middle receipt", (b) => { b.receipts.splice(3, 1); }, "order"],
  ["swap two receipts", (b) => { [b.receipts[2], b.receipts[3]] = [b.receipts[3], b.receipts[2]]; }, "order"],
  ["flip a status", (b) => { const r = b.receipts.find((x) => x.type === "0x2"); r.status = r.status === "0x1" ? "0x0" : "0x1"; }, "receipts_root_mismatch"],
  ["change a cumulativeGasUsed", (b) => { b.receipts[1].cumulativeGasUsed = "0x" + (BigInt(b.receipts[1].cumulativeGasUsed) + 1n).toString(16); }, "receipts_root_mismatch"],
  ["tamper log data (bloom kept)", (b) => { const l = b.receipts.find((x) => x.logs.length).logs[0]; l.data = l.data === "0x" ? "0x01" : "0x" + (l.data.slice(2, 4) === "00" ? "01" : "00") + l.data.slice(4); }, "receipts_root_mismatch"],
  // with no per-receipt RPC bloom, a tampered topic is caught by the header-bloom OR (only if it sets a NEW bit; Base blooms
  // are dense) or else by the receipts root: either refusal is correct, the root is the decisive check
  ["tamper log topic, RPC bloom absent", (b) => { const r = b.receipts.find((x) => x.logs.length && x.logs[0].topics.length); delete r.logsBloom; r.logs[0].topics[0] = "0x" + "11".repeat(32); }, ["bloom_mismatch", "receipts_root_mismatch"]],
  ["RPC logsBloom lies", (b) => { const r = b.receipts.find((x) => x.logs.length); r.logsBloom = "0x" + "00".repeat(256); }, "bloom_mismatch"],
  ["deposit without depositNonce", (b) => { delete b.receipts.find((x) => x.type === "0x7e").depositNonce; }, "deposit_fields"],
  ["deposit without version (post-Canyon)", (b) => { delete b.receipts.find((x) => x.type === "0x7e").depositReceiptVersion; }, "deposit_fields"],
  ["deposit version 2", (b) => { b.receipts.find((x) => x.type === "0x7e").depositReceiptVersion = "0x2"; }, "deposit_fields"],
  ["deposit fields on 0x2", (b) => { b.receipts.find((x) => x.type === "0x2").depositNonce = "0x1"; }, "deposit_fields"],
  ["blob type 0x3 on Base", (b) => { b.receipts.find((x) => x.type === "0x2").type = "0x3"; }, "unsupported_type"],
  ["EIP-8130 0x79 (everest inactive)", (b) => { b.receipts.find((x) => x.type === "0x2").type = "0x79"; }, "unsupported_type"],
  ["unknown type 0x7d", (b) => { b.receipts[1].type = "0x7d"; }, "unsupported_type"],
  ["pre-Byzantium root field", (b) => { b.receipts[1].root = "0x" + "00".repeat(32); }, "pre_byzantium"],
  ["removed log", (b) => { b.receipts.find((x) => x.logs.length).logs[0].removed = true; }, "removed_log"],
  ["logIndex gap", (b) => { const r = b.receipts.find((x) => x.logs.length); r.logs[0].logIndex = "0x" + (BigInt(r.logs[0].logIndex) + 1n).toString(16); }, "order"],
  ["non-canonical quantity", (b) => { b.receipts[0].cumulativeGasUsed = "0x0" + b.receipts[0].cumulativeGasUsed.slice(2); }, "bad_field"],
  ["receipt names another block", (b) => { b.receipts[0].blockHash = "0x" + "22".repeat(32); }, "wrong_block"],
  ["header receiptsRoot tampered", (b) => { b.header = { ...b.header, receiptsRoot: "0x" + "33".repeat(32) }; }, "header_hash"],
  ["header and hash both replaced (expected hash is authenticated)", (b) => { b.header = { ...b.header, gasUsed: "0x1", hash: undefined }; }, "header_hash"],
  ["wrong expected block hash", (b) => { b.expectedBlockHash = "0x" + "44".repeat(32); }, "header_hash"],
  ["tx binding mismatch", (b) => { b.txHashes = [...b.header.transactions]; b.txHashes[0] = "0x" + "55".repeat(32); }, "tx_binding"],
  ["missing receipts list", (b) => { b.receipts = undefined; }, "bad_input"],
];
for (const [name, mutate, c] of neg) {
  test(`refuses: ${name} -> ${c}`, () => {
    const b = clone(D());
    b.chain = BASE_MAINNET;
    mutate(b);
    assert.throws(() => verifyBlockReceipts(b, deps), (e) => e instanceof ReceiptsError && [c].flat().includes(e.code));
  });
}

test("Regolith-window deposit rule: nonce required, version forbidden (quirk path selected by timestamp)", () => {
  const chain = { ...BASE_MAINNET, regolith: 0, canyon: 4102444800 };          // pretend the block is pre-Canyon
  const b = clone(D());
  assert.throws(() => verifyBlockReceipts({ ...b, chain }, deps), code("deposit_fields"));   // real receipts carry version 1
});

test("trie boundary: a node whose RLP is EXACTLY 32 bytes is hashed, not inlined (expected root built with viem's independent toRlp)", () => {
  // keys rlp(0)=0x80 (nibbles 8,0) and rlp(1)=0x01 (nibbles 0,1): a root branch with two leaves; 29-byte values make each
  // leaf rlp([hp(1 nibble), value]) = 1 + 1 + 30 = exactly 32 bytes -> referenced by keccak (Yellow Paper c(J): inline only if < 32)
  const v0 = Uint8Array.from({ length: 29 }, (_, i) => i + 1), v1 = Uint8Array.from({ length: 29 }, (_, i) => 200 - i);
  const hx = (b) => "0x" + Buffer.from(b).toString("hex");
  const leaf0 = toRlp(["0x30", hx(v0)]), leaf1 = toRlp(["0x31", hx(v1)]);
  assert.equal((leaf0.length - 2) / 2, 32); assert.equal((leaf1.length - 2) / 2, 32);
  const slots = Array(17).fill("0x");
  slots[8] = hx(k(hexb(leaf0))); slots[0] = hx(k(hexb(leaf1)));
  assert.equal(orderedTrieRoot([v0, v1], k), hx(k(hexb(toRlp(slots)))));
});

test("export boundary: real receipts verified WITHOUT a verified body cannot become complete-logs entries", () => {
  for (const num of Object.keys(RECEIPTS)) {
    const v = verifyBlockReceipts(baseBlock(num), deps);                // receipt/log CONTENT is root-verified ...
    assert.equal(v.receiptsRoot, headerOf(num).receiptsRoot.toLowerCase());
    assert.match(v.txHashBinding, /^unauthenticated/);
    assert.throws(() => completeLogsEntry(v), code("tx_unbound"));    // ... but unproven tx hashes are never exported
  }
});

test("export boundary: only branded, frozen verifyBlockReceipts results are accepted", () => {
  const num = Object.keys(RECEIPTS)[0];
  const v = verifyBlockReceipts({ ...baseBlock(num), txHashes: headerOf(num).transactions }, deps);   // test stand-in hashes
  assert.equal(completeLogsEntry(v)[0], v.blockHash);
  assert.throws(() => completeLogsEntry({ ...v }), code("not_verified"));                              // spread copy
  assert.throws(() => completeLogsEntry({ blockHash: v.blockHash, receiptsRoot: v.receiptsRoot, logs: [], txHashBinding: "verified-body" }), code("not_verified"));
  assert.throws(() => completeLogsEntry(JSON.parse(JSON.stringify(v))), code("not_verified"));
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.logs) && Object.isFrozen(v.logs[0]) && Object.isFrozen(v.logs[0].topics));
  assert.throws(() => { v.logs.push({}); }, TypeError);
  assert.throws(() => { v.receiptsRoot = "0x" + "00".repeat(32); }, TypeError);
});

test("numeric safety: header number/timestamp above MAX_SAFE_INTEGER are refused, never rounded", () => {
  const b = clone(D());
  const stub = { keccak: k, headerHash: () => b.expectedBlockHash.toLowerCase() };       // reach the numeric guard (unit test only)
  const big = "0x" + (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(16);
  assert.throws(() => verifyBlockReceipts({ ...b, header: { ...b.header, hash: undefined, number: big } }, stub), code("unsafe_integer"));
  assert.throws(() => verifyBlockReceipts({ ...b, header: { ...b.header, hash: undefined, timestamp: big } }, stub), code("unsafe_integer"));
  assert.throws(() => verifyBlockReceipts({ ...b, header: { ...b.header, hash: undefined, number: "0x1" + "0".repeat(16) } }, stub), code("bad_field"));   // > uint64
});

test("resource bounds: maxReceipts / maxLogs refuse before any per-receipt work", () => {
  const b = D();
  assert.throws(() => verifyBlockReceipts({ ...b, maxReceipts: 10 }, deps), code("resource_bound"));
  assert.throws(() => verifyBlockReceipts({ ...b, maxLogs: 1 }, deps), code("resource_bound"));
  assert.ok(verifyBlockReceipts({ ...b, maxReceipts: b.receipts.length, maxLogs: b.receipts.reduce((a, r) => a + r.logs.length, 0) }, deps));
});
