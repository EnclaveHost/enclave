// js/core/quorum.js: agreeing fixed-block reads for the independent dashboard. One RPC can delay a decision but must
// not decide it: a lying, stale, wrong-chain or forked endpoint is outvoted or the read fails - it never silently wins.
//   run: node --test test/site-independent-quorum.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createQuorumReader, QuorumError } from "../site/js/core/quorum.js";

const NOW = 1_800_000_000;
const hash = (n, fork = "") => "0x" + (fork + n.toString(16)).padStart(64, fork ? "f" : "0");
/* An honest chain at `head`, with per-endpoint tampering. */
function endpoints(spec){
  const calls = [];
  const rpc = async (url, method, params) => {
    calls.push([url, method]);
    const e = spec[url] || {};
    if (e.down) throw new Error("connection refused");
    if (method === "eth_chainId") return e.chainId || "0x2105";
    const head = e.head ?? 100;
    if (method === "eth_blockNumber") return "0x" + head.toString(16);
    if (method === "eth_getBlockByNumber"){
      const n = Number(params[0]);
      if (n > head) return null;
      return { number: params[0], hash: hash(n, e.fork || ""), timestamp: "0x" + (NOW - (e.lag || 0) - (100 - n) * 2).toString(16) };
    }
    if (method === "eth_call"){
      if (e.revert){ const err = new Error("execution reverted"); err.revert = true; throw err; }
      return e.result || "0x" + "00".repeat(31) + "2a";
    }
    if (method === "eth_getCode") return e.code || "0x6080";
    if (method === "eth_getStorageAt"){
      assert.equal(params[2].blockHash, hash(98), "storage must use the agreed block hash");
      return e.storage ?? "0x" + "00".repeat(31) + "01";
    }
    if (method === "eth_getLogs"){
      if (e.logsDown) throw new Error("range too large");
      const log = (n, i, t3) => ({ address: e.logAddress || params[0].address, blockNumber: "0x" + n.toString(16), blockHash: hash(n), logIndex: "0x" + i.toString(16),
        topics: ["0x" + "01".repeat(32), "0x" + "02".repeat(32), "0x" + "03".repeat(32), "0x" + t3.padStart(64, "0")], data: "0x", removed: e.removed || false });
      const out = [log(90, 1, "aa"), log(90, 0, "bb")];
      if (e.dropLog) out.pop();
      if (e.lateLog) out.push(log(99, 0, "cc"));
      return e.reverse ? out.reverse() : out;
    }
    throw new Error("unexpected " + method);
  };
  return { rpc, calls };
}
const R = (spec, opts = {}) => {
  const { rpc, calls } = endpoints(spec);
  const urls = opts.urls || ["a", "b", "c"];
  return { r: createQuorumReader({ rpcs: urls, quorum: opts.quorum || 2, confirmations: 2, maxBlockAgeSeconds: 600, chainId: 8453, rpc, now: () => NOW }), calls };
};

test("agreement on one block, then on one result at that block's hash", async () => {
  const { r, calls } = R({});
  const s = await r.snapshot();
  assert.equal(s.number, 98);
  assert.equal(s.hash, hash(98));
  assert.equal(await r.call(s, "0xc0", "0x01"), "0x" + "00".repeat(31) + "2a");
  // calls name the agreed block by hash (EIP-1898), never "latest"
  assert.ok(calls.filter(([, m]) => m === "eth_call").length >= 2);
});

test("one lying endpoint is outvoted; two disagreeing endpoints of two fail closed", async () => {
  const lie = "0x" + "ff".repeat(32);
  const { r } = R({ c: { result: lie } });
  const s = await r.snapshot();
  assert.equal(await r.call(s, "0xc0", "0x01"), "0x" + "00".repeat(31) + "2a");
  const two = R({ b: { result: lie } }, { urls: ["a", "b"] }).r;
  const s2 = await two.snapshot();
  await assert.rejects(two.call(s2, "0xc0", "0x01"), (e) => e instanceof QuorumError && /disagree/.test(e.message));
});

test("unreachable, wrong-chain and forked endpoints cannot stand in for agreement", async () => {
  await assert.rejects(R({ a: { down: true }, b: { down: true } }).r.snapshot(), /only 1 of 3/);
  await assert.rejects(R({ a: { chainId: "0x1" }, b: { chainId: "0x1" } }).r.snapshot(), /only 1 of 3/);
  // two endpoints on a fork, one honest: no 2-agreement on the honest hash, but the fork pair agrees with itself -
  // RPC agreement is the stated trust model; here the honest one is outvoted, which the test records explicitly
  const forked = await R({ b: { fork: "f" }, c: { fork: "f" } }).r.snapshot();
  assert.equal(forked.hash, hash(98, "f"));
  await assert.rejects(R({ b: { fork: "e" }, c: { fork: "f" } }).r.snapshot(), /disagree on block/);
});

test("the target is the quorum-th highest head, so one endpoint racing ahead cannot pick an unconfirmed block", async () => {
  const { r } = R({ a: { head: 500 } });
  const s = await r.snapshot();
  assert.equal(s.number, 98, "two endpoints are at 100: 100 - 2 confirmations");
  assert.deepEqual(s.rpcs.sort(), ["a", "b", "c"]);
});

test("stale and future blocks are refused; a later snapshot never moves backwards", async () => {
  await assert.rejects(R({ a: { lag: 4000 }, b: { lag: 4000 }, c: { lag: 4000 } }).r.snapshot(), /old/);
  await assert.rejects(R({ a: { lag: -500 }, b: { lag: -500 }, c: { lag: -500 } }).r.snapshot(), /future/);
  const spec = {};
  const { r } = R(spec);
  await r.snapshot();
  for (const k of ["a", "b", "c"]) spec[k] = { head: 50 };
  await assert.rejects(r.snapshot(), /behind a block/);
});

test("an agreed revert is reported as a revert, not as data", async () => {
  const { r } = R({ a: { revert: true }, b: { revert: true }, c: { revert: true } });
  const s = await r.snapshot();
  await assert.rejects(r.call(s, "0xc0", "0x01"), (e) => e.revert === true);
  assert.equal(await r.code(s, "0xc0"), "0x6080");
});

test("configuration needs at least two origins and a quorum of two", () => {
  assert.throws(() => createQuorumReader({ rpcs: ["a"], quorum: 1, chainId: 8453 }), /two RPC/);
  assert.throws(() => createQuorumReader({ rpcs: ["a", "b"], quorum: 3, chainId: 8453 }), /quorum/);
});

test("delegation storage requires complete agreeing words, not a malformed or lone answer", async () => {
  const slot = "0x" + "ab".repeat(32), one = "0x" + "00".repeat(31) + "01";
  const {r} = R({a:{down:true}});
  assert.equal(await r.storageAt(await r.snapshot(), "0xc0", slot), one);
  for (const storage of ["0x", "0x01", "0x" + "ff".repeat(32)]){
    const q = R({b:{storage},c:{down:true}}).r;
    await assert.rejects(q.storageAt(await q.snapshot(), "0xc0", slot), /disagree on storage/);
  }
  await assert.rejects(r.storageAt(null,"0xc0",slot),/needs a snapshot/);
});

test("event logs need the identical set from a quorum; dropped, removed, foreign or out-of-range logs never win", async () => {
  const q = { address: "0xc0", topics: [], fromBlock: 80, toBlock: 98 };
  const { r } = R({ c: { dropLog: true } });
  const s = await r.snapshot();
  const got = await r.logs(s, q);
  assert.deepEqual(got.map((l) => l.logIndex), [0, 1], "ordered by block and index; the endpoint that dropped a log is outvoted");
  assert.equal(got[0].topics[3], "0x" + "bb".padStart(64, "0"));
  assert.deepEqual(await R({ b: { reverse: true } }).r.logs(s, q).then((l) => l.length), 2, "order of the answer does not matter");
  for (const bad of [{ dropLog: true }, { removed: true }, { logAddress: "0xdd" }, { lateLog: true }, { logsDown: true }]){
    const { r: r2 } = R({ b: bad, c: { down: true } });
    const s2 = await r2.snapshot();
    await assert.rejects(r2.logs(s2, { ...q, toBlock: 95 }), QuorumError, JSON.stringify(bad));
  }
  await assert.rejects(r.logs(s, { ...q, toBlock: 99 }), /invalid log range/, "never past the agreed block");
});
