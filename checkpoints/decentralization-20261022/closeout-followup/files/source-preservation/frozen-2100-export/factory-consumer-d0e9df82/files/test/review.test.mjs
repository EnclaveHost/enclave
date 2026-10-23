// lib/review.mjs: the ownership-effect classifier (against the vault's beneficialOwnerOf/_apply/_claim rules) and the
// bounded, resumable log cursor (range halving, rate-limit stop, budget stop, resume, uncovered ranges). No network.
import test from "node:test";
import assert from "node:assert/strict";
import { effectOf, discoverLogs, uncovered, budgetedRpc, BudgetExhausted, EVENTS, classify } from "../lib/review.mjs";

const SV = "0x" + "aa".repeat(20), EOA = "0x" + "bb".repeat(20), X = "0x" + "cc".repeat(20);
const P = (owner, rev = 1) => ({ owner, policyRev: String(rev) });

test("effectOf follows the vault rules", () => {
  assert.equal(effectOf({ before: EOA, after: EOA, policy: P(EOA) }), "unchanged", "EOA-owned deployments are untouched");
  assert.equal(effectOf({ before: SV, after: EOA, policy: P(SV) }), "STRANDED", "a policy pinned to the SessionVault: _apply reverts NotOwner after activation");
  assert.equal(effectOf({ before: SV, after: EOA, policy: P(EOA) }), "restored", "pinned to the vault's owner: updatable again");
  assert.equal(effectOf({ before: SV, after: EOA, policy: P(X) }), "claimant_changes");
  assert.equal(effectOf({ before: SV, after: EOA, policy: P(ZERO_(), 0) }), "no_policy_first_writer_changes");
  assert.equal(effectOf({ before: EOA, after: EOA, policy: P(ZERO_(), 0) }), "unchanged");
});
function ZERO_() { return "0x" + "00".repeat(20); }

function fakeLogs({ maxSpan = 10_000n, rateAfter = Infinity, events = [] }) {
  let calls = 0;
  return async (url, body) => {
    calls++;
    if (calls > rateAfter) return { error: { message: "Due to the high consumption or frequency of RPC requests, you have exceeded the rate limit" } };
    const f = body.params[0], from = BigInt(f.fromBlock), to = BigInt(f.toBlock);
    if (to - from + 1n > maxSpan) return { error: { message: `block range is too large, max ${maxSpan}` } };
    return { result: events.filter((e) => BigInt(e.blockNumber) >= from && BigInt(e.blockNumber) <= to) };
  };
}
const ADDR = "0x" + "11".repeat(20);
const ev = (n, id) => ({ address: ADDR, topics: [EVENTS.PolicyUpdated, id, "0x" + "00".repeat(32)], blockNumber: "0x" + n.toString(16), transactionHash: "0x" + "ee".repeat(32), logIndex: "0x0" });

test("the cursor halves on range refusals, stops on rate limits and budget, resumes, and reports uncovered ranges", async () => {
  const events = [ev(1500, "0x" + "01".repeat(32)), ev(35_000, "0x" + "02".repeat(32)), ev(90_000, "0x" + "03".repeat(32))];
  const cursor = { next: "1000", to: "100000", span: "40000", covered: [], events: [], stops: [] };
  const run = (b) => discoverLogs({ rpc: b.rpc, url: "https://logs.test", addresses: [ADDR], topics: [EVENTS.PolicyUpdated, EVENTS.PolicyClaimed], cursor });
  // attempt 1, budget 4: one range refusal (span 40000 -> 20000), three answered ranges, then the budget stop
  let b = budgetedRpc({ max: 4, transport: fakeLogs({ maxSpan: 20_000n, events }), check: (u) => u });
  assert.equal(await run(b), "budget");
  assert.equal(cursor.span, "20000");
  assert.deepEqual(cursor.covered, [["1000", "60999"]]);
  assert.deepEqual(uncovered(cursor, "1000"), [["61000", "100000"]], "nothing past the answered ranges is claimed");
  assert.equal(cursor.events.length, 2);
  // attempt 2: rate limited after one answered range -> stops at once, no retry
  b = budgetedRpc({ max: 20, transport: fakeLogs({ maxSpan: 20_000n, rateAfter: 1, events }), check: (u) => u });
  assert.equal(await run(b), "rate_limited");
  assert.equal(b.used(), 2, "one answer, one refusal, stop");
  assert.deepEqual(uncovered(cursor, "1000"), [["81000", "100000"]]);
  assert.equal(cursor.stops.at(-1).reason, "rate_limited");
  // a later attempt resumes from the cursor and completes
  b = budgetedRpc({ max: 20, transport: fakeLogs({ maxSpan: 20_000n, events }), check: (u) => u });
  assert.equal(await run(b), "complete");
  assert.deepEqual(uncovered(cursor, "1000"), []);
  assert.deepEqual(cursor.events.map((x) => x.block), ["1500", "35000", "90000"]);
});

test("a provider's stated block limit is adopted exactly", async () => {
  const cursor = { next: "0", to: "20000", span: "100000", covered: [], events: [], stops: [] };
  const transport = async (url, body) => { const f = body.params[0]; return BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n > 5000n
    ? { error: { message: "eth_getLogs is limited to 5000 block range. Please check the parameter requirements" } } : { result: [] }; };
  const b = budgetedRpc({ max: 10, transport, check: (u) => u });
  assert.equal(await discoverLogs({ rpc: b.rpc, url: "https://logs.test", addresses: [ADDR], topics: [EVENTS.PolicyUpdated], cursor }), "complete");
  assert.equal(cursor.span, "5000"); assert.equal(b.used(), 6, "one refusal, then 4 full 5000-block ranges + 1 tail");
});

test("a provider answer outside the filter is an error, not an event", async () => {
  const bad = { address: "0x" + "99".repeat(20), topics: [EVENTS.PolicyUpdated, "0x" + "01".repeat(32)], blockNumber: "0x10", transactionHash: "0x", logIndex: "0x0" };
  const cursor = { next: "0", to: "100", span: "1000", covered: [], events: [], stops: [] };
  const b = budgetedRpc({ max: 5, transport: async () => ({ result: [bad] }), check: (u) => u });
  assert.equal(await discoverLogs({ rpc: b.rpc, url: "https://logs.test", addresses: [ADDR], topics: [EVENTS.PolicyUpdated], cursor }), "error");
  assert.deepEqual(cursor.covered, []);
});

test("the budgeted reader refuses writes and counts every request", async () => {
  const b = budgetedRpc({ max: 1, transport: async () => ({ result: "0x1" }), check: (u) => u });
  await assert.rejects(b.rpc("https://x.test", "eth_sendRawTransaction", ["0x"]), /read-only/);
  assert.equal(await b.rpc("https://x.test", "eth_chainId", []), "0x1");
  await assert.rejects(b.rpc("https://x.test", "eth_chainId", []), BudgetExhausted);
  assert.equal(classify(new Error("request limit reached")).kind, "rate");
  assert.equal(classify(new Error("query returned more than 10000 results")).kind, "range");
});
