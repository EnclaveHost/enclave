// boot-funding.mjs against a stub two-RPC chain (no network), decided by the REAL python gate (common.boot_funding_problems),
// with a commit's own bootRegistrationAction read from H's git objects: H's 0c565d3c (the first GPU-price-pending commit; the
// final commit root approves may differ, its hashes come from build.json) and 9f6d37bd as the counterexample. FEES: priced by RUNNING
// a sender through the real viem 2.53.1 (H's node_modules) over an INERT transport (no signer; any send method throws): 7dd3acd0's
// plain writeContract (the SDK failure scenario behind the 23:15 rollback, SUSPECTED not confirmed live: eth_fillTransaction x 1.2 =
// 13.2 mwei when the node fills 2 x base + tip) vs the explicit-fee sender fixture.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { collect, reviewedDecision, approvedSender, priceViaSender, sameBlock, CANONICAL_BLOCK, H_REPO, PINS, ROW, ORACLE, REG } from "../boot-funding.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), A = path.resolve(HERE, "..");
const viem = await import(pathToFileURL(path.join(H_REPO, "node_modules/viem/_esm/index.js")).href);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const hashesOf = (c) => { const src = execFileSync("git", ["-C", H_REPO, "show", `${c}:supervisor.js`], { maxBuffer: 64 << 20 });
  return [sha256(src), sha256(Buffer.from(src.toString("utf8").match(/function bootRegistrationAction\(row, want\) \{[\s\S]*?\n\}/)[0]))]; };
const COMMIT = "0c565d3ca04323440f2903c4023a59e50b223b3f", OLD9F = "9f6d37bd858ad44be1171b6415353910214c2fa5";
const [SUP, DEC] = hashesOf(COMMIT);
const { decide, supervisorSha256, bootDecisionSha256 } = reviewedDecision(COMMIT, H_REPO, SUP, DEC);
const CODE = { registry: "0x6080604052", executor: "0x6080604053" };
const accounts = await import(pathToFileURL(path.join(H_REPO, "node_modules/viem/_esm/accounts/index.js")).href);
const { base } = await import(pathToFileURL(path.join(H_REPO, "node_modules/viem/_esm/chains/index.js")).href);
const SENDER_RE = /function sendOperatorTx\(address, abi, functionName, args\) \{[\s\S]*?\n\}/;
const fx = fs.readFileSync(path.join(HERE, "fixtures/sender-explicit.js"), "utf8").match(SENDER_RE)[0];
const EXPLICIT = { text: fx, senderSha256: sha256(Buffer.from(fx)) };            // H's PROPOSED sender (fixture, not a commit)
const OLD7DD = "7dd3acd061af765cdcd9ba21b9744f2f2c6bdf5b";
const old7 = execFileSync("git", ["-C", H_REPO, "show", `${OLD7DD}:supervisor.js`], { maxBuffer: 64 << 20 }).toString("utf8").match(SENDER_RE)[0];
const PLAIN = approvedSender(OLD7DD, H_REPO, sha256(Buffer.from(old7)));          // the 7dd image's own sender (plain writeContract)
const SENT = [];                                                                  // every send-type request any stub saw (must stay empty)

// one Base chain as two RPCs see it; over(url, method, params) may answer differently for one of them
function chain({ row = {}, nonce = 23759n, pending = {}, balance = 376132087579n, gas = {}, fill = "node", over = () => undefined } = {}) {
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
      case "eth_fillTransaction": {   // a geth-family node fills maxFee = 2 x base + tip (11 mwei) whatever the request says
        if (fill !== "node") { const e = new Error("the method eth_fillTransaction does not exist"); e.code = -32601; throw e; }
        const q = params[0], fn = viem.decodeFunctionData({ abi: REG, data: q.data ?? q.input }).functionName;
        const g = BigInt((gas[url] && gas[url][fn]) ?? (fn === "setProofKey" ? 38772 : 50354));
        return { raw: "0x", tx: { type: "0x2", chainId: "0x2105", nonce: "0x" + (pending[url] ?? nonce).toString(16), from: q.from, to: q.to, input: q.data ?? q.input,
          value: "0x0", gas: "0x" + g.toString(16), maxFeePerGas: "0x" + (2n * 5000000n + 1000000n).toString(16), maxPriorityFeePerGas: "0xf4240", accessList: [] } };
      }
      case "eth_sendRawTransaction": case "eth_sendTransaction": SENT.push(method); throw new Error("BROADCAST ATTEMPTED");
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
const run = (opts, d = decide, sender = EXPLICIT) => collect({ call: chain(opts), rpcs: RPCS, viem, accounts, chain: base, decide: d, sender, commit: COMMIT, supervisorSha256, bootDecisionSha256 });
// the python gate, with the stub's registry/executor code hashes in place of production's
function gate(facts, now = Math.floor(Date.now() / 1000), senderSha256 = EXPLICIT.senderSha256) {
  const P = { registryCodeHash: viem.keccak256(CODE.registry), executorCodeHash: viem.keccak256(CODE.executor) };
  const py = `import sys, json; sys.path.insert(0, ${JSON.stringify(A)}); import common as C
f = json.load(sys.stdin); P = {**C.FUNDING, **json.loads(sys.argv[1])}
NEW = {'commit': ${JSON.stringify(COMMIT)}, 'supervisorSha256': ${JSON.stringify(SUP)}, 'bootDecisionSha256': ${JSON.stringify(DEC)}, 'senderSha256': ${JSON.stringify(senderSha256)}}
print(json.dumps(C.boot_funding_problems(f, ${now}, NEW, P)))`;
  const r = spawnSync("python3", ["-c", py, JSON.stringify(P)], { input: JSON.stringify(facts), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("the pinned delegation is root's: keccak(0xef0100 || executor) = the delegation code hash of ROOT-FUNDING-REVIEW", () => {
  assert.equal(viem.keccak256("0xef0100" + PINS.executor.slice(2)), "0xe2f1317f7b76520f746c22fe4898b7ad32d7a6947a4c11a766fdcdd55bf88bbe");
});

test("the decision is the approved commit's bootRegistrationAction, file AND function hash-checked; anything else is refused", () => {
  const row = { operator: PINS.operator, active: true, endpoint: "e", repo: "r", measurement: "0x00", cpuPricePerSec6: 1n, gpuPricePerSec6: 2n, proofKey: "0x1" };
  const want = { operator: PINS.operator, endpoint: "e", repo: "r", measurement: "0x00", cpuPricePerSec6: 1n, gpuPricePerSec6: 2n, proofKey: "0x2" };
  assert.deepEqual(decide(row, want), { action: "setProofKey", reason: "only the proof key differs" });
  assert.deepEqual(decide(row, { ...want, gpuPricePerSec6: null }), { action: "setProofKey", reason: "only the proof key differs" }, "pending: not compared");
  assert.throws(() => reviewedDecision("a6b1378cdf430217025987d90c040d0e25a9993d", H_REPO, SUP, DEC), /not the approved bytes/);
  assert.throws(() => reviewedDecision(COMMIT, H_REPO, SUP, "0".repeat(64)), /not the approved decision/);
  assert.throws(() => reviewedDecision(COMMIT, H_REPO, SUP, undefined), /hashes are required/);
  assert.throws(() => reviewedDecision("HEAD", H_REPO, SUP, DEC), /40 hex/);
});

test("9f6d37bd's decision (the 22:13Z counterexample) registers while the GPU price is pending: the gate refuses it", async () => {
  const [s9, d9] = hashesOf(OLD9F); const old = reviewedDecision(OLD9F, H_REPO, s9, d9).decide;
  const f = await run({}, old);
  assert.deepEqual(f.actions.pending, { action: "register", reason: "the registered fields differ" });
  assert.deepEqual(f.actions.discovered, { action: "setProofKey", reason: "only the proof key differs" });
  assert.match(gate(f).join("; "), /not setProofKey both while the GPU price is pending/);
});

test("root's actual state (exact fields, old key, nonce = pending, 376e9 wei): setProofKey for 0xff..ff fits with headroom; the gate passes", async () => {
  const f = await run();
  const SET = { action: "setProofKey", reason: "only the proof key differs" };
  assert.deepEqual(f.actions, { pending: SET, discovered: SET });
  assert.equal(f.desiredPending.gpuPricePerSec6, null); assert.equal(f.desired.gpuPricePerSec6, "1667");
  assert.deepEqual(f.source, { commit: COMMIT, supervisorSha256: SUP, bootDecisionSha256: DEC, senderSha256: EXPLICIT.senderSha256 });
  assert.equal(f.testProofKey, "0x" + "ff".repeat(20));
  for (const x of f.setProofKey.perRpc) {   // the explicit sender's own fees survive viem's fill path unchanged
    assert.deepEqual([x.senderGas, x.senderMaxFeePerGas, x.senderMaxPriorityFeePerGas], ["38772", "7000000", "1000000"]);
    assert.deepEqual([x.gas, x.maxFeePerGas, x.maxPriorityFeePerGas], ["38772", "7000000", "1000000"]);
  }
  assert.equal(f.setProofKey.worstCaseWei, String(38772n * 7000000n + 529241039n));
  assert.equal(f.operator.code, "0xef0100" + PINS.executor.slice(2));
  assert.deepEqual(gate(f), []);
});

test("refused by the gate: a changed field (full register), a deactivated row, an operator tx in flight, a short balance, a re-delegation", async () => {
  assert.match(gate(await run({ row: { cpuPricePerSec6: 835n } })).join("; "), /not setProofKey.*|full register/);
  assert.match(gate(await run({ row: { active: false } })).join("; "), /active row/);
  const g0 = await run({ row: { gpuPricePerSec6: 0n } });                      // a row already at 0: discovered 1667 would re-register
  assert.equal(g0.actions.pending.action, "setProofKey"); assert.equal(g0.actions.discovered.action, "register");
  assert.match(gate(g0).join("; "), /full register|not setProofKey/);
  assert.match(gate(await run({ pending: { [RPCS[1]]: 23760n } })).join("; "), /in flight/);
  assert.match(gate(await run({ balance: 300000000000n })).join("; "), /headroom/);
  assert.match(gate(await run({ balance: 200000000000n })).join("; "), /exceeds the balance/);
  const redelegated = await run({ over: (u, m, p) => (m === "eth_getCode" && p[0].toLowerCase() === PINS.operator ? "0xef0100" + "22".repeat(20) : undefined) });
  assert.match(gate(redelegated).join("; "), /delegation/);
  const big = await run({ gas: { [RPCS[1]]: { setProofKey: 40000 } } });
  assert.equal(big.setProofKey.perRpc[1].gas, "40000"); assert.equal(big.setProofKey.worstCaseWei, String(40000n * 7000000n + 529241039n), "the larger per-RPC worst case counts");
  assert.deepEqual(gate(big), [], "40000 x 7 mwei + L1 still leaves 25% headroom");
});

test("RPC disagreement or a non-Base RPC refuses before any decision", async () => {
  await assert.rejects(run({ over: (u, m) => (u === RPCS[1] && m === "eth_getBalance" ? "0x1" : undefined) }), /disagree on balance/);
  await assert.rejects(run({ over: (u, m) => (u === RPCS[0] && m === "eth_chainId" ? "0x1" : undefined) }), /not Base/);
  await assert.rejects(collect({ call: chain(), rpcs: [RPCS[0], RPCS[0]], viem, accounts, chain: base, decide, sender: EXPLICIT, commit: COMMIT, supervisorSha256, bootDecisionSha256 }), /two distinct/);
});

test("SDK FAILURE SCENARIO (suspected 23:15 cause): where the node fills, the 7dd plain writeContract is re-priced to 13.2 mwei; the gate refuses it", async () => {
  const f = await run({}, decide, PLAIN);
  for (const x of f.setProofKey.perRpc) {
    assert.deepEqual([x.senderGas, x.senderMaxFeePerGas], [null, null], "the plain sender states nothing");
    assert.equal(x.maxFeePerGas, String((2n * 5000000n + 1000000n) * 12n / 10n), "node fill 11 mwei x viem's 1.2 = 13.2 mwei");
  }
  const p = gate(f, undefined, PLAIN.senderSha256).join("; ");
  assert.match(p, /did not state explicit gas and fees/); assert.match(p, /exceeds the balance/, "38772 x 13.2 mwei + L1 > 376e9");
  // only where eth_fillTransaction FAILS does viem fall back to estimateFeesPerGas (7 mwei): the one path the old kit modelled
  const u = await run({ fill: "unsupported" }, decide, PLAIN);
  assert.ok(u.setProofKey.perRpc.every((x) => x.maxFeePerGas === "7000000"));
  assert.match(gate(u, undefined, PLAIN.senderSha256).join("; "), /did not state explicit/, "even then the plain sender is refused: its price depends on the node");
});

test("inert: no signer and no broadcast - a sender that tries to sign or send fails closed", async () => {
  await run(); await run({}, decide, PLAIN);
  assert.deepEqual(SENT, [], "no send method reached any RPC");
  const signs = { text: EXPLICIT.text.replace("return wallet.writeContract(", "await account.signTransaction({}); return wallet.writeContract("), senderSha256: "x" };
  await assert.rejects(run({}, decide, signs), /no signing/);
  assert.throws(() => approvedSender(OLD7DD, H_REPO, "0".repeat(64)), /not the approved sender/);
  assert.throws(() => approvedSender(OLD7DD, H_REPO, undefined), /sender hash is required/);
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
