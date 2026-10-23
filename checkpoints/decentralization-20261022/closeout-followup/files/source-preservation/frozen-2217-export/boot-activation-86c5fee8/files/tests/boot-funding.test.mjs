// boot-funding.mjs against a stub two-RPC chain (no network), decided by the REAL python gate (common.boot_funding_problems),
// with the reviewed commit's own bootRegistrationAction read from H's git objects.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collect, reviewedDecision, sameBlock, CANONICAL_BLOCK, H_REPO, PINS, ROW, ORACLE, REG } from "../boot-funding.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), A = path.resolve(HERE, "..");
const viem = await import(pathToFileURL(path.join(H_REPO, "node_modules/viem/_esm/index.js")).href);
const COMMIT = "9f6d37bd858ad44be1171b6415353910214c2fa5";
const { decide, supervisorSha256 } = reviewedDecision(COMMIT);
const CODE = { registry: "0x6080604052", executor: "0x6080604053" };

// one Base chain as two RPCs see it; over(url, method, params) may answer differently for one of them
function chain({ row = {}, nonce = 23759n, pending = {}, balance = 376132087579n, gas = {}, over = () => undefined } = {}) {
  const r = { endpoint: PINS.endpoint, repo: PINS.repo, measurement: PINS.measurement, operator: "0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB",
    registeredAt: 1n, lastSeen: 2n, active: true, cpuPricePerSec6: 834n, gpuPricePerSec6: 1667n, proofKey: "0x8604ce59f394daf05b235122E5Dc054F5C2bB453",
    payoutWallet: "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61", ...row };
  const ts = Math.floor(Date.now() / 1000) - 10;
  return async (url, method, params) => {
    const o = over(url, method, params); if (o !== undefined) return o;
    switch (method) {
      case "eth_chainId": return "0x2105";
      case "eth_blockNumber": return "0x328b2ed";
      case "eth_getBlockByNumber": return { hash: "0x" + "78".repeat(32), parentHash: "0x" + "77".repeat(32), number: params[0] === "latest" ? "0x328b2ef" : params[0],
        timestamp: "0x" + ts.toString(16), baseFeePerGas: "0x4c4b40" };
      case "eth_getCode": {
        const a = params[0].toLowerCase();
        return a === PINS.registry ? CODE.registry : a === PINS.operator ? "0xef0100" + PINS.executor.slice(2) : a === PINS.executor ? CODE.executor : "0x";
      }
      case "eth_getTransactionCount": return "0x" + (params[1] === "pending" ? (pending[url] ?? nonce) : nonce).toString(16);
      case "eth_getBalance": return "0x" + balance.toString(16);
      case "eth_maxPriorityFeePerGas": return "0xf4240";
      case "eth_estimateGas": {
        const fn = viem.decodeFunctionData({ abi: REG, data: params[0].data }).functionName;
        return "0x" + BigInt((gas[url] && gas[url][fn]) ?? (fn === "setProofKey" ? 38772 : 50354)).toString(16);
      }
      case "eth_call": {
        const { to, data } = params[0];
        if (to === PINS.registry) return viem.encodeFunctionResult({ abi: ROW, functionName: "get", result: r });
        const fn = viem.decodeFunctionData({ abi: ORACLE, data }).functionName;
        const v = { isIsthmus: true, getL1FeeUpperBound: 529241039n, getOperatorFee: 0n }[fn];
        return viem.encodeFunctionResult({ abi: ORACLE, functionName: fn, result: v });
      }
    }
    throw new Error(`unstubbed ${method}`);
  };
}
const RPCS = ["https://a.example", "https://b.example"];
const run = (opts) => collect({ call: chain(opts), rpcs: RPCS, viem, decide, commit: COMMIT, supervisorSha256 });
// the python gate, with the stub's registry/executor code hashes in place of production's
function gate(facts, now = Math.floor(Date.now() / 1000)) {
  const P = { registryCodeHash: viem.keccak256(CODE.registry), executorCodeHash: viem.keccak256(CODE.executor) };
  const py = `import sys, json; sys.path.insert(0, ${JSON.stringify(A)}); import common as C
f = json.load(sys.stdin); P = {**C.FUNDING, **json.loads(sys.argv[1])}
print(json.dumps(C.boot_funding_problems(f, ${now}, C.REVIEWED['commit'], C.REVIEWED['supervisorSha256'], P)))`;
  const r = spawnSync("python3", ["-c", py, JSON.stringify(P)], { input: JSON.stringify(facts), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("the pinned delegation is root's: keccak(0xef0100 || executor) = the delegation code hash of ROOT-FUNDING-REVIEW", () => {
  assert.equal(viem.keccak256("0xef0100" + PINS.executor.slice(2)), "0xe2f1317f7b76520f746c22fe4898b7ad32d7a6947a4c11a766fdcdd55bf88bbe");
});

test("the decision is the reviewed commit's bootRegistrationAction; any other commit is refused", () => {
  assert.deepEqual(decide({ operator: PINS.operator, active: true, endpoint: "e", repo: "r", measurement: "0x00", cpuPricePerSec6: 1n, gpuPricePerSec6: 2n, proofKey: "0x1" },
    { operator: PINS.operator, endpoint: "e", repo: "r", measurement: "0x00", cpuPricePerSec6: 1n, gpuPricePerSec6: 2n, proofKey: "0x2" }),
    { action: "setProofKey", reason: "only the proof key differs" });
  assert.throws(() => reviewedDecision("a6b1378cdf430217025987d90c040d0e25a9993d"), /not the reviewed bytes/);
  assert.throws(() => reviewedDecision("HEAD"), /40 hex/);
});

test("root's actual state (exact fields, old key, nonce = pending, 376e9 wei): setProofKey for 0xff..ff fits with headroom; the gate passes", async () => {
  const f = await run();
  assert.deepEqual(f.action, { action: "setProofKey", reason: "only the proof key differs" });
  assert.equal(f.testProofKey, "0x" + "ff".repeat(20));
  assert.equal(f.setProofKey.maxFeePerGas, "7000000", "viem default: ceil(1.2 x 5 mwei) + 1 mwei");
  assert.equal(f.setProofKey.worstCaseWei, String(38772n * 7000000n + 529241039n));
  assert.equal(f.operator.code, "0xef0100" + PINS.executor.slice(2));
  assert.deepEqual(gate(f), []);
});

test("refused by the gate: a changed field (full register), a deactivated row, an operator tx in flight, a short balance, a re-delegation", async () => {
  assert.match(gate(await run({ row: { cpuPricePerSec6: 835n } })).join("; "), /not setProofKey.*|full register/);
  assert.match(gate(await run({ row: { active: false } })).join("; "), /active row/);
  assert.match(gate(await run({ pending: { [RPCS[1]]: 23760n } })).join("; "), /in flight/);
  assert.match(gate(await run({ balance: 300000000000n })).join("; "), /headroom/);
  assert.match(gate(await run({ balance: 200000000000n })).join("; "), /exceeds the balance/);
  const redelegated = await run({ over: (u, m, p) => (m === "eth_getCode" && p[0].toLowerCase() === PINS.operator ? "0xef0100" + "22".repeat(20) : undefined) });
  assert.match(gate(redelegated).join("; "), /delegation/);
  const big = await run({ gas: { [RPCS[1]]: { setProofKey: 40000 } } });
  assert.equal(big.setProofKey.gas, "40000", "the larger estimate counts");
  assert.deepEqual(gate(big), [], "40000 x 7 mwei + L1 still leaves 25% headroom");
});

test("RPC disagreement or a non-Base RPC refuses before any decision", async () => {
  await assert.rejects(run({ over: (u, m) => (u === RPCS[1] && m === "eth_getBalance" ? "0x1" : undefined) }), /disagree on balance/);
  await assert.rejects(run({ over: (u, m) => (u === RPCS[0] && m === "eth_chainId" ? "0x1" : undefined) }), /not Base/);
  await assert.rejects(collect({ call: chain(), rpcs: [RPCS[0], RPCS[0]], viem, decide, commit: COMMIT, supervisorSha256 }), /two distinct/);
});

test("block agreement is canonical (number/hash/parentHash/timestamp): provider field ORDER and metadata are ignored (root 22:07/22:08)", async () => {
  const T = "0x" + (Math.floor(Date.now() / 1000) - 10).toString(16);
  const blk = { number: "0x328bf13", hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), timestamp: "0x6a1b2c3d", baseFeePerGas: "0x4c4b40", size: "0x10" };
  const reordered = Object.fromEntries(Object.entries({ ...blk, totalDifficulty: "0x0" }).reverse());
  assert.ok(sameBlock(blk, reordered), "same canonical fields, other order + provider metadata");
  assert.ok(sameBlock(blk, { ...blk, hash: blk.hash.toUpperCase().replace("0X", "0x") }), "hex case");
  assert.deepEqual(CANONICAL_BLOCK, ["number", "hash", "parentHash", "timestamp"]);
  for (const k of ["number", "hash", "parentHash", "timestamp"]) assert.ok(!sameBlock(blk, { ...blk, [k]: "0x1" }), `${k} differs`);
  assert.ok(!sameBlock(blk, null) && !sameBlock(null, blk) && !sameBlock(blk, { ...blk, hash: undefined }));
  // end to end: RPC B answers the agreed block with reversed properties and an extra field -> accepted, the gate passes
  const flip = (u, m, p) => (u === RPCS[1] && m === "eth_getBlockByNumber" && p[0] !== "latest"
    ? Object.fromEntries(Object.entries({ hash: "0x" + "78".repeat(32), parentHash: "0x" + "77".repeat(32), number: p[0], timestamp: T, baseFeePerGas: "0x4c4b40", requestsHash: "0x00" }).reverse())
    : undefined);
  const same = (u, m, p) => (m === "eth_getBlockByNumber" && p[0] !== "latest"
    ? { hash: "0x" + "78".repeat(32), parentHash: "0x" + "77".repeat(32), number: p[0], timestamp: T, baseFeePerGas: "0x4c4b40" }
    : undefined);
  const f = await run({ over: (u, m, p) => flip(u, m, p) ?? same(u, m, p) });
  assert.deepEqual(gate(f), []);
  // a different hash (or a null block from a lagging backend) still refuses
  await assert.rejects(run({ over: (u, m, p) => (u === RPCS[1] && m === "eth_getBlockByNumber" && p[0] !== "latest" ? { ...same(u, m, p), hash: "0x" + "99".repeat(32) } : same(u, m, p)) }), /disagree on block/);
  await assert.rejects(run({ over: (u, m, p) => (u === RPCS[0] && m === "eth_getBlockByNumber" && p[0] !== "latest" ? null : same(u, m, p)) }), /disagree on block/);
  await assert.rejects(run({ over: (u, m, p) => (m === "eth_getBlockByNumber" && p[0] !== "latest" ? { ...same(u, m, p), number: "0x1" } : undefined) }), /asked for block/);
});
