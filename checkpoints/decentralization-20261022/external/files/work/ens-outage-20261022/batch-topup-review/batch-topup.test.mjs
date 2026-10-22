// Offline: no RPC, no wallet. FAKE_MC3 is a test-only stand-in, NOT a claim about the real Multicall3 code hash.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { buildProposal, verifyProposal, parseManifest, checkEvidence, RESERVE, MULTICALL3, RESERVE_CODEHASH, LEDGER_CODEHASH,
  EMPTY_CODEHASH, AMOUNT_WEI, EVIDENCE_FORMAT, PROPOSAL_FORMAT } from "./batch-topup.mjs";
import { collectEvidence } from "./collect-evidence.mjs";

const req = createRequire(new URL("../../enclave/package.json", import.meta.url));
const { encodeFunctionData, decodeFunctionData, keccak256 } = await import(req.resolve("viem"));
const FAKE_MC3 = "0x" + "ab".repeat(32);
const NOW = 1_792_645_000_000;
const MANIFEST = JSON.parse(fs.readFileSync(new URL("./proposed-manifest.json", import.meta.url), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const MC3_ABI = [{ type: "function", name: "aggregate3Value", stateMutability: "payable",
  inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" },
    { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }], outputs: [] }];

function read(rpc, manifest = MANIFEST, patch = (r) => r) {
  return patch({ rpc, chainId: 8453, blockNumber: "52927799", blockHash: "0x" + "11".repeat(32), timestamp: String(NOW / 1000 - 30),
    multicall3CodeHash: FAKE_MC3, reserveCodeHash: RESERVE_CODEHASH, ledgerCodeHash: LEDGER_CODEHASH, reservePaused: false,
    rows: manifest.rows.map((r) => ({ id: r.id, ledgerId: r.id, owner: r.currentOwner, active: true, enabled: true, blocked: false, balanceWei: "5345982196547" })) });
}
const evidence = (reads) => ({ format: EVIDENCE_FORMAT, chainId: 8453, collectedAt: new Date(NOW).toISOString(), reads });
const good = () => evidence([read("https://mainnet.base.org"), read("https://base-rpc.polkachu.com"), read("https://base-rpc.publicnode.com")]);
const build = (o = {}) => buildProposal({ manifest: MANIFEST, evidence: good(), expectedMulticall3CodeHash: FAKE_MC3,
  expectTotalWei: "10000000000000000", now: NOW, ...o });

test("proposal: one aggregate3Value of 10 deposit(id) calls, exact 0.01 ETH, all-or-nothing, no wallet fields", () => {
  const p = build();
  assert.equal(p.format, PROPOSAL_FORMAT);
  assert.equal(p.to, MULTICALL3);
  assert.equal(p.value, "10000000000000000");
  assert.ok(p.data.startsWith("0x174dea71"));
  for (const k of ["from", "nonce", "gas", "maxFeePerGas", "authorizationList"]) assert.ok(!(k in p), k);
  const { args } = decodeFunctionData({ abi: MC3_ABI, data: p.data });
  assert.equal(args[0].length, 10);
  args[0].forEach((c, i) => {
    assert.equal(c.target.toLowerCase(), RESERVE.toLowerCase());
    assert.equal(c.allowFailure, false);
    assert.equal(c.value, AMOUNT_WEI);
    assert.equal(c.callData, "0xb214faa5" + MANIFEST.rows[i].id.slice(2));
  });
  assert.deepEqual(verifyProposal(p), { calls: 10, totalWei: "10000000000000000" });
  assert.equal(p.rows.find((r) => r.id.startsWith("0x59f1273d")).creditedOwner, "0xB794C4DD0e1C5E6B72281799F282BfdE7654345D");
});

test("manifest refusals: adapter excluded, duplicate, amount other than 0.001 ETH, unknown field, >10 rows", () => {
  const m = (f) => { const x = clone(MANIFEST); f(x); return x; };
  assert.throws(() => parseManifest(m((x) => { x.rows[0].id = "0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33"; })), /excluded/);
  assert.throws(() => parseManifest(m((x) => { x.rows[1].id = x.rows[0].id; })), /duplicate/);
  assert.throws(() => parseManifest(m((x) => { x.rows[0].amountWei = "2000000000000000"; })), /exactly/);
  assert.throws(() => parseManifest(m((x) => { x.rows[0].approve = true; })), /unknown field/);
  assert.throws(() => parseManifest(m((x) => { x.rows.push({ ...x.rows[0], id: "0x" + "22".repeat(32) }); })), /1\.\.10/);
});

test("evidence refusals: owner, enabled, blocked, paused, inactive, unknown id", () => {
  const ev = (patch) => evidence([read("https://a.example", MANIFEST, patch), read("https://b.example", MANIFEST, patch)]);
  const chk = (patch) => checkEvidence(ev(patch), parseManifest(MANIFEST), { expectedMulticall3CodeHash: FAKE_MC3, now: NOW });
  const row = (k, v) => (r) => { r.rows[7][k] = v; return r; };   // row 7 = the DNS deployment
  assert.throws(() => chk(row("owner", "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61")), /current owner/);
  assert.throws(() => chk(row("enabled", false)), /not enabled/);
  assert.throws(() => chk(row("blocked", true)), /blocked/);
  assert.throws(() => chk(row("blocked", undefined)), /blocked/);
  assert.throws(() => chk(row("active", false)), /not active/);
  assert.throws(() => chk(row("ledgerId", "0x" + "00".repeat(32))), /does not know/);
  assert.throws(() => chk((r) => ({ ...r, reservePaused: true })), /paused/);
  assert.throws(() => chk((r) => { delete r.reservePaused; return r; }), /paused/);
  assert.throws(() => chk((r) => ({ ...r, reserveCodeHash: "0x" + "cd".repeat(32) })), /reserve code/);
  assert.throws(() => chk((r) => ({ ...r, ledgerCodeHash: "0x" + "cd".repeat(32) })), /ledger code/);
});

test("evidence refusals: quorum, agreement, freshness, Multicall3 hash supplied and matching", () => {
  const rows = parseManifest(MANIFEST);
  const chk = (ev, o = {}) => checkEvidence(ev, rows, { expectedMulticall3CodeHash: FAKE_MC3, now: NOW, ...o });
  assert.throws(() => chk(evidence([read("https://a.example")])), /at least two/);
  assert.throws(() => chk(evidence([read("https://a.example/x"), read("https://a.example/y")])), /distinct RPC hosts/);
  assert.throws(() => chk(evidence([read("https://a.example"), { rpc: "https://b.example", error: "429" }])), /distinct RPC hosts/);
  assert.throws(() => chk(evidence([read("https://a.example"), read("https://b.example", MANIFEST, (r) => { r.rows[0].balanceWei = "1"; return r; })])), /disagree/);
  assert.throws(() => chk(good(), { now: NOW + 700_000 }), /old/);
  assert.throws(() => chk(good(), { expectedMulticall3CodeHash: undefined }), /supplied by root/);
  assert.throws(() => chk(good(), { expectedMulticall3CodeHash: EMPTY_CODEHASH }), /empty-code/);
  assert.throws(() => chk(good(), { expectedMulticall3CodeHash: "0x" + "ac".repeat(32) }), /Multicall3 code/);
  const eAll = evidence([read("https://a.example", MANIFEST, (r) => ({ ...r, multicall3CodeHash: EMPTY_CODEHASH })),
                         read("https://b.example", MANIFEST, (r) => ({ ...r, multicall3CodeHash: EMPTY_CODEHASH }))]);
  assert.throws(() => chk(eAll), /Multicall3 code/);
  assert.ok(chk(evidence([read("https://a.example"), read("https://b.example"), { rpc: "https://c.example", error: "timeout" }])));
});

test("total bound must be stated exactly", () => {
  assert.throws(() => build({ expectTotalWei: undefined }), /exact total/);
  assert.throws(() => build({ expectTotalWei: "9000000000000000" }), /exact total/);
  assert.throws(() => build({ expectTotalWei: "10000000000000001" }), /exact total/);
});

test("verifyProposal rejects tampered bytes: allowFailure true, other target, withdraw call, value drift, wallet fields", () => {
  const p = build();
  const { args } = decodeFunctionData({ abi: MC3_ABI, data: p.data });
  const reenc = (calls) => { const data = encodeFunctionData({ abi: MC3_ABI, functionName: "aggregate3Value", args: [calls] });
    return { ...p, data, dataSha256: createHash("sha256").update(data).digest("hex") }; };
  const calls = args[0].map((c) => ({ ...c }));
  assert.throws(() => verifyProposal(reenc(calls.map((c, i) => (i === 3 ? { ...c, allowFailure: true } : c)))), /all-or-nothing/);
  assert.throws(() => verifyProposal(reenc(calls.map((c, i) => (i === 0 ? { ...c, target: "0x0000000000000000000000000000000000000001" } : c)))), /production reserve/);
  const withdraw = encodeFunctionData({ abi: [{ type: "function", name: "withdraw", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }], outputs: [] }],
    functionName: "withdraw", args: [MANIFEST.rows[0].id, 1n, "0x0000000000000000000000000000000000000001"] });
  assert.throws(() => verifyProposal(reenc(calls.map((c, i) => (i === 0 ? { ...c, callData: withdraw } : c)))), /deposit\(bytes32\)/);
  assert.throws(() => verifyProposal({ ...p, value: "10000000000000001" }), /sum/);
  assert.throws(() => verifyProposal({ ...p, data: p.data.slice(0, -2) + (p.data.endsWith("ff") ? "00" : "ff") }), /digest/);
  assert.throws(() => verifyProposal({ ...p, from: "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61" }), /never carries from/);
  assert.throws(() => verifyProposal({ ...p, nonce: 1 }), /never carries nonce/);
});

test("collectEvidence (fake clients) reads the CURRENT owner's reserve and feeds checkEvidence", async () => {
  const VAULT = "0xB794C4DD0e1C5E6B72281799F282BfdE7654345D";
  const reads = [];
  const fake = (head, { ownerOverride } = {}) => ({
    getChainId: async () => 8453, getBlockNumber: async () => head,
    getBlock: async ({ blockNumber }) => ({ hash: "0x" + "11".repeat(32), timestamp: BigInt(NOW / 1000 - 20), number: blockNumber }),
    getCode: async ({ address }) => (address === MULTICALL3 ? "0x6080aa" : "0x6080bb"),
    readContract: async ({ functionName, args, blockNumber }) => {
      reads.push({ functionName, args, blockNumber });
      if (functionName === "paused") return false;
      if (functionName === "blockedDeployment") return false;
      if (functionName === "get") {
        const row = MANIFEST.rows.find((r) => r.id === args[0]);
        return { id: args[0], owner: ownerOverride && row.id.startsWith("0x59f1273d") ? ownerOverride : row.currentOwner, active: true };
      }
      if (functionName === "reserveOf") return { enabled: true, balanceWei: args[1] === VAULT ? 34391774424856n : 5345982196547n };
      throw new Error("unexpected read " + functionName);
    } });
  const ev = await collectEvidence({ manifest: MANIFEST, now: () => new Date(NOW),
    clients: [{ url: "https://a.example", client: fake(100n) }, { url: "https://b.example", client: fake(101n) },
              { url: "https://c.example", client: { getChainId: async () => 1 } }] });
  assert.equal(ev.reads[2].error, "chain mismatch");
  assert.ok(reads.every((r) => r.blockNumber === 98n), "every read pinned to min head - 2");
  assert.ok(reads.some((r) => r.functionName === "reserveOf" && r.args[1] === VAULT), "the DNS row is read under its vault owner");
  const mcHash = keccak256("0x6080aa");
  // the real hashes cannot match fake code: substitute only the pinned reserve/ledger hashes to exercise the remaining checks
  for (const r of ev.reads) if (!r.error) { r.reserveCodeHash = RESERVE_CODEHASH; r.ledgerCodeHash = LEDGER_CODEHASH; }
  assert.ok(checkEvidence(ev, parseManifest(MANIFEST), { expectedMulticall3CodeHash: mcHash, now: NOW }));
  const moved = await collectEvidence({ manifest: MANIFEST, now: () => new Date(NOW),
    clients: [{ url: "https://a.example", client: fake(100n, { ownerOverride: "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61" }) },
              { url: "https://b.example", client: fake(100n, { ownerOverride: "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61" }) }] });
  for (const r of moved.reads) { r.reserveCodeHash = RESERVE_CODEHASH; r.ledgerCodeHash = LEDGER_CODEHASH; }
  assert.throws(() => checkEvidence(moved, parseManifest(MANIFEST), { expectedMulticall3CodeHash: mcHash, now: NOW }), /current owner/);
});

