// The validated receipt source (network/receipt-source.mjs) over worker E's vendored adapters (network/tx-evidence/),
// offline. LABELLED FIXTURES ONLY: L1 = anvil (chain 1) + E's beacon fixture mirroring its tags; L2 = anvil (chain 8453)
// + E's optimism_syncStatus fixture (test/fixtures/tx-evidence/pair-stubs.mjs, vendored). Nothing here validates a real
// chain: every minted object carries trust 'test-fixture', and a production config (mainnet identities) is shown to
// refuse this fixture. Covered: byte-identical vendoring; config gating; binding a minted receipt to the intended
// transaction (signed bytes, or a transaction object re-encoded with its signature); sender / nonce / hash mismatches;
// copied, caller-made and foreign-source evidence; immutability of what was minted.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { createPublicClient, createWalletClient, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseReceiptSourceConfig, createReceiptSource, bindTransaction, describeInclusion, FIXTURE_ENV } from "../network/receipt-source.mjs";
import { acceptEvidence } from "../network/tx-evidence/forced-inclusion.mjs";
import { TRUST, mint } from "../network/tx-evidence/evidence-brand.mjs";
import { startBeaconFixture, startRollupFixture, jrpc } from "./fixtures/tx-evidence/pair-stubs.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const haveAnvil = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const T = { skip: !haveAnvil && "needs Foundry's anvil", timeout: 180000 };
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", OTHER = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const A = privateKeyToAccount(KEY), B = privateKeyToAccount(OTHER);
const GVR = "0x" + "7e".repeat(32), SINK = "0x" + "5a".repeat(20);
const ENV = { [FIXTURE_ENV]: "1" };
const procs = [], closers = [];
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function anvil(chainId, blockTime = null) {
  const port = await freePort();
  procs.push(spawn("anvil", ["--port", String(port), "--chain-id", String(chainId), ...(blockTime ? ["--block-time", String(blockTime)] : []), "--silent"], { stdio: "ignore" }));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { await jrpc(url, "eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  return url;
}
let L1, L2, beacon, rollup, cfg, src, pc, wc;
const chain = { id: 8453, name: "fixture", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [] } } };
test.before(async () => {
  if (!haveAnvil) return;
  // L1: STATIC (no interval mining, so its finalized tag cannot move between the adapter's paired reads), head placed hours
  // ahead so the lag checks hold; anvil's finalized tag is 64 blocks back. L2: a block every second (fresh unsafe head).
  [L1, L2] = [await anvil(1), await anvil(8453, 1)];
  await jrpc(L1, "evm_setNextBlockTimestamp", ["0x" + (Math.floor(Date.now() / 1000) + 3 * 3600).toString(16)]);
  await jrpc(L1, "anvil_mine", ["0x50"]);
  beacon = await startBeaconFixture({ el: L1, gvr: GVR }); rollup = await startRollupFixture({ l2: L2, l1: L1 });
  closers.push(beacon, rollup);
  cfg = { format: "enclave-receipt-source/v1", l1: { execution: { url: L1 }, consensus: { url: beacon.url } }, base: { execution: { url: L2 }, rollup: { url: rollup.url } },
    testFixture: { label: "TEST FIXTURE anvil L1/L2 + scripted beacon/rollup",
      l1Identity: { chainIdHex: "0x1", elGenesisHash: (await jrpc(L1, "eth_getBlockByNumber", ["0x0", false])).hash, clGenesisValidatorsRoot: GVR },
      l2Identity: { chainIdHex: "0x2105", genesisHash: (await jrpc(L2, "eth_getBlockByNumber", ["0x0", false])).hash } } };
  src = createReceiptSource(parseReceiptSourceConfig(cfg, { env: ENV }));
  pc = createPublicClient({ chain, transport: http(L2) }); wc = (acct) => createWalletClient({ account: acct, chain, transport: http(L2) });
});
test.after(() => { for (const c of closers) try { c.close(); } catch {} for (const p of procs) try { p.kill("SIGKILL"); } catch {} });

/** a real transaction on the L2 anvil: -> {hash, raw, nonce} (raw = the exact signed bytes) */
async function sendReal(acct, value = 1n) {
  const req = await wc(acct).prepareTransactionRequest({ to: SINK, value, type: "eip1559" });
  const raw = await acct.signTransaction(req);
  const hash = await pc.sendRawTransaction({ serializedTransaction: raw });
  await pc.waitForTransactionReceipt({ hash });
  return { hash, raw, nonce: req.nonce };
}
const included = async (q) => { for (let i = 0; i < 40; i++) { const v = await src.receipt(q); if (v.state === "included") return v; await new Promise((r) => setTimeout(r, 250)); } throw new Error("not included"); };

test("worker E's adapters are vendored byte for byte (PROVENANCE.json: sha256 and git blob of c08331e9)", () => {
  const p = JSON.parse(fs.readFileSync(path.join(REPO, "network/tx-evidence/PROVENANCE.json"), "utf8"));
  assert.equal(p.commit, "c08331e9397c33db0330e6c4a53c74c5d8f0d98b");
  assert.equal(Object.keys(p.files).length, 5);
  for (const [rel, f] of Object.entries(p.files)) {
    const b = fs.readFileSync(path.join(REPO, rel));
    assert.equal(createHash("sha256").update(b).digest("hex"), f.sha256, rel);
    assert.equal(createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex"), f.gitBlob, `${rel}: the git blob of E's commit`);
  }
});

test("config: exact keys and format; testFixture identities only inside a test harness; loopback only", T, () => {
  assert.throws(() => parseReceiptSourceConfig({ ...cfg, format: "x" }, { env: ENV }), /format must be/);
  assert.throws(() => parseReceiptSourceConfig({ ...cfg, extra: 1 }, { env: ENV }), /unknown key config.extra/);
  assert.throws(() => parseReceiptSourceConfig(cfg, { env: {} }), /refused outside a test harness/);
  assert.throws(() => parseReceiptSourceConfig({ ...cfg, testFixture: { ...cfg.testFixture, label: "prod" } }, { env: ENV }), /must start with TEST/);
  const { testFixture, ...prod } = cfg;
  assert.throws(() => createReceiptSource(parseReceiptSourceConfig({ ...prod, base: { ...prod.base, execution: { url: "https://mainnet.base.org" } } })), (e) => e.code === "not-local");
  assert.equal(src.trust, TRUST.TEST_FIXTURE); assert.deepEqual([...src.acceptTrust], [TRUST.TEST_FIXTURE]);
  const production = createReceiptSource(parseReceiptSourceConfig(prod));
  assert.equal(production.trust, TRUST.LOCAL_VALIDATED_PAIR, "a config without testFixture expects local full-node validation");
});

test("a production config refuses the labelled fixture: the readiness checks name exactly why (identity, peers), nothing is minted", T, async () => {
  const { testFixture, ...prod } = cfg;
  const production = createReceiptSource(parseReceiptSourceConfig(prod));
  const r = await production.readiness();
  assert.equal(r.ok, false);
  const failed = [...r.l1.checks, ...r.base.checks].filter((c) => !c.ok).map((c) => c.name);
  for (const n of ["el.genesis", "el.peers", "cl.genesis", "l2.genesis"]) assert.ok(failed.includes(n), `${n} refuses the fixture under mainnet identities (${failed})`);
  const { hash, raw } = await sendReal(A);
  await assert.rejects(production.receipt({ hash, raw }), (e) => e.code === "l2-source-not-ready" && /l2\.genesis/.test(e.message));
});

test("a real transaction: the minted receipt is bound to its signed bytes (hash, recovered sender, nonce); status and level verbatim", T, async () => {
  const ready = await src.readiness();
  assert.equal(ready.ok, true, JSON.stringify([...ready.l1.checks, ...ready.base.checks].filter((c) => !c.ok)));
  const { hash, raw, nonce } = await sendReal(A);
  const v = await included({ hash, from: A.address, nonce, raw });
  assert.equal(v.status, "success"); assert.equal(v.trust, TRUST.TEST_FIXTURE); assert.equal(v.level, "unsafe");
  assert.equal(v.transaction.hash, hash.toLowerCase()); assert.equal(v.transaction.from, A.address.toLowerCase()); assert.equal(v.transaction.nonce, nonce);
  assert.match(describeInclusion(v), /^TEST FIXTURE - success in block \d+: receipt minted by the local Base node source \(verifiedBy 'base-derivation', trust 'test-fixture', level 'unsafe'\)/);
  // the evidence is E's minted object itself: accepted by E's rule, frozen, never a copy
  assert.equal(acceptEvidence(v.evidence, "l2-receipt", { acceptTrust: [TRUST.TEST_FIXTURE] }, "x"), "minted");
  assert.throws(() => { v.evidence.receipt.status = "reverted"; }, TypeError);
  assert.throws(() => acceptEvidence(structuredClone(v.evidence), "l2-receipt", { acceptTrust: [TRUST.TEST_FIXTURE] }, "copied"), (e) => e.code === "copied");
  assert.throws(() => acceptEvidence(JSON.parse(JSON.stringify(v.evidence, (_k, x) => (typeof x === "bigint" ? String(x) : x))), "l2-receipt", { acceptTrust: [TRUST.TEST_FIXTURE] }, "json"), (e) => e.code === "json");
  // a production consumer does not accept test-fixture evidence, minted or not
  assert.throws(() => acceptEvidence(v.evidence, "l2-receipt", {}, "prod"), (e) => e.code === "prod" && /trust 'test-fixture' is not accepted/.test(e.message));
  // the safe/finalized levels come only from the node's heads (here the rollup fixture moves them)
  rollup.state.safeNumber = v.blockNumber; rollup.state.finalizedNumber = v.blockNumber;
  try { assert.equal((await src.receipt({ hash, raw })).level, "finalized"); } finally { rollup.state.safeNumber = null; rollup.state.finalizedNumber = null; }
});

test("sender, nonce and hash mismatches: a receipt is never accepted for another sender, another nonce or other bytes", T, async () => {
  const a = await sendReal(A), b = await sendReal(B);
  await included({ hash: a.hash, raw: a.raw });
  await assert.rejects(src.receipt({ hash: a.hash, from: B.address, raw: a.raw }), (e) => e.code === "receipt-sender");
  await assert.rejects(src.receipt({ hash: a.hash, from: A.address, nonce: a.nonce + 1, raw: a.raw }), (e) => e.code === "receipt-nonce");
  await assert.rejects(src.receipt({ hash: a.hash, raw: b.raw }), (e) => e.code === "tx-identity", "bytes that hash to another transaction");
  await assert.rejects(src.receipt({ hash: a.hash }), (e) => e.code === "tx-unbound", "no bytes and no transport: inclusion alone is not identity");
  // a transaction object from an untrusted transport: bound only when its fields re-encode with its signature to the hash
  const honest = await pc.getTransaction({ hash: a.hash });
  const v = await src.receipt({ hash: a.hash, from: A.address, nonce: a.nonce, txLookup: async () => honest });
  assert.equal(v.state, "included"); assert.match(v.binding, /re-encoded with its own signature/);
  for (const [field, val] of [["value", honest.value + 1n], ["to", B.address], ["nonce", honest.nonce + 1], ["input", "0x01"]])
    await assert.rejects(src.receipt({ hash: a.hash, txLookup: async () => ({ ...honest, [field]: val }) }), (e) => e.code === "tx-identity", `altered ${field}`);
  await assert.rejects(bindTransaction({ hash: a.hash, txLookup: async () => ({ ...honest, type: "eip4844" }) }), (e) => e.code === "tx-type-unsupported");
  assert.equal(keccak256(a.raw), a.hash.toLowerCase());
});

test("foreign source: a Base node deriving from ANOTHER L1 is not ready; a node answering for another transaction is refused", T, async () => {
  const { hash, raw } = await sendReal(A);
  rollup.state.l1Override = { hash: "0x" + "ab".repeat(32), number: Number(BigInt(await jrpc(L1, "eth_blockNumber"))), parentHash: "0x" + "00".repeat(32), timestamp: Math.floor(Date.now() / 1000) };
  try { await assert.rejects(src.receipt({ hash, raw }), (e) => e.code === "l2-source-not-ready" && /another L1 source/.test(e.message)); }
  finally { rollup.state.l1Override = null; }
  // an L2 execution endpoint that answers with another transaction's receipt (E's adapter refuses it)
  const other = await sendReal(B);
  const lying = await (await import("./fixtures/tx-evidence/pair-stubs.mjs")).startExecutionStub(async (method, params) =>
    jrpc(L2, method, method === "eth_getTransactionReceipt" ? [other.hash] : params));
  closers.push(lying);
  const foreign = createReceiptSource(parseReceiptSourceConfig({ ...cfg, base: { ...cfg.base, execution: { url: lying.url } } }, { env: ENV }));
  await assert.rejects(foreign.receipt({ hash, raw }), (e) => e.code === "l2-receipt-mismatch");
  // caller-made "evidence" (minted by code in this process, the documented in-process limit) still must name THIS
  // transaction and its bound sender to count: a mint is not identity
  assert.throws(() => acceptEvidence(mint({ kind: "l1-receipt", trust: TRUST.TEST_FIXTURE }), "l2-receipt", { acceptTrust: [TRUST.TEST_FIXTURE] }, "kind"), (e) => e.code === "kind");
});
