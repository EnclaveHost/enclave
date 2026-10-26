// The owner-move hand-off decision (cli/move-release-confirm.mjs), the REAL module over a fake boundary: the source
// host's management answer (as management-client.mjs throws it: ManagementError {code, outcomeUnknown}) and the owner's
// ledger reads (moveSnapshot: {runner, held, block, d}). No network, no chain, a fake clock. Covers the deep-receipt
// restart/outage case (the host answers 503 release_unconfirmed because its canonical verifier cannot verify a receipt
// older than its window): the move continues ONLY on the current ledger's absence of the source's lease, confirmed on two
// increasing blocks, and is never labelled a verified release.
import test from "node:test";
import assert from "node:assert/strict";
import { confirmSourceLeaseCleared, MOVE_RELEASE } from "../cli/move-release-confirm.mjs";

const SRC = "0x" + "a1".repeat(32), OTHER = "0x" + "b2".repeat(32), ZERO = "0x" + "00".repeat(32);
const D = { balance6: 5_000_000n };
const snap = (block, runner, held) => ({ block, runner, held, d: D });
const DOWN = Symbol("quorum down");
class ManagementError extends Error {
  constructor(message, { status = null, code = null, outcomeUnknown = false } = {}) { super(message); Object.assign(this, { status, code, outcomeUnknown }); }
}
const UNCONFIRMED = () => new ManagementError("the release may have run; its outcome is unknown (HTTP 503 release_unconfirmed)",
  { status: 503, code: "release_unconfirmed", outcomeUnknown: true });
const LOST = () => new ManagementError("the release may have run; its outcome is unknown (the answer was cut off)", { outcomeUnknown: true });
const BLOCKED = () => new ManagementError("management release refused (HTTP 409)", { status: 409, code: "release_blocked", outcomeUnknown: false });

/** One move: `answer` is the host's answer (an object resolves, an Error throws); `reads` are the ledger reads in order
 *  (DOWN throws; the last one repeats). Returns the decision plus the exact calls made at the boundary. */
async function run({ answer, reads, ...opts }) {
  let t = 1_000_000, i = 0;
  const calls = { release: 0, snapshot: 0, sleeps: 0 };
  const out = await confirmSourceLeaseCleared({
    source: SRC,
    release: async () => { calls.release++; if (answer instanceof Error) throw answer; return answer; },
    snapshot: async () => { calls.snapshot++; const r = reads[Math.min(i++, reads.length - 1)]; if (r === DOWN) throw new Error("quorum unreachable"); return r; },
    sleep: async (ms) => { calls.sleeps++; t += ms; },
    now: () => t,
    ...opts,
  });
  return { out, calls };
}

test("a host-verified release confirmed on two blocks: cleared, released, receipt verified, ONE release", async () => {
  const { out, calls } = await run({ answer: { json: { id: "x", released: true, txHash: "0xabc" } },
    reads: [snap(100, ZERO, false), snap(101, ZERO, false)] });
  assert.equal(out.outcome, "cleared"); assert.equal(out.how, "released"); assert.equal(out.receiptVerified, true);
  assert.deepEqual([out.firstBlock, out.block], [100, 101]); assert.equal(out.answer.txHash, "0xabc");
  assert.equal(calls.release, 1);
});

test("deep receipt after restart/outage: 503 release_unconfirmed + current absence -> cleared, receipt NOT verified", async () => {
  const { out, calls } = await run({ answer: UNCONFIRMED(), reads: [snap(5000, ZERO, false), snap(5001, ZERO, false)] });
  assert.equal(out.outcome, "cleared"); assert.equal(out.how, "released");
  assert.equal(out.receiptVerified, false, "a release the host could not verify is never labelled verified");
  assert.equal(out.answer.kind, "unknown"); assert.equal(out.answer.code, "release_unconfirmed");
  assert.equal(calls.release, 1);
});

test("release_unconfirmed whose transaction lands late is still followed for the full 90 s answer window", async () => {
  const held = Array.from({ length: 20 }, (_, k) => snap(200 + k, SRC, true));   // 20 reads x 3 s = 60 s still held
  const { out, calls } = await run({ answer: UNCONFIRMED(), reads: [...held, snap(220, ZERO, false), snap(221, ZERO, false)] });
  assert.equal(out.outcome, "cleared"); assert.equal(out.firstBlock, 220);
  assert.ok(MOVE_RELEASE.answerWaitMs >= 90_000); assert.equal(calls.release, 1);
});

test("changed generation: another runner holds the lease -> cleared as taken, receipt not verified", async () => {
  const { out } = await run({ answer: UNCONFIRMED(), reads: [snap(300, OTHER, true), snap(301, OTHER, true)] });
  assert.equal(out.outcome, "cleared"); assert.equal(out.how, "taken"); assert.equal(out.runner, OTHER); assert.equal(out.receiptVerified, false);
});

test("the source's own lease that ran out (same runner id, not held) -> cleared as lapsed", async () => {
  const { out } = await run({ answer: LOST(), reads: [snap(400, SRC, false), snap(401, SRC, false)] });
  assert.equal(out.outcome, "cleared"); assert.equal(out.how, "lapsed");
});

test("reorg: absence then the source's lease again resets the count; a later two-block absence clears from there", async () => {
  const { out } = await run({ answer: UNCONFIRMED(),
    reads: [snap(500, ZERO, false), snap(501, SRC, true), snap(502, ZERO, false), snap(503, ZERO, false)] });
  assert.equal(out.outcome, "cleared"); assert.equal(out.firstBlock, 502); assert.equal(out.block, 503);
});

test("reorg that persists: absence seen once, then held until the deadline -> clear-unconfirmed (unknown), not cleared", async () => {
  const { out, calls } = await run({ answer: UNCONFIRMED(), reads: [snap(600, ZERO, false), snap(601, SRC, true)] });
  assert.equal(out.outcome, "clear-unconfirmed"); assert.equal(out.heldAgainAt, 601); assert.equal(calls.release, 1);
});

test("a lagging read at the same or a lower block neither confirms nor resets", async () => {
  const { out } = await run({ answer: UNCONFIRMED(),
    reads: [snap(700, ZERO, false), snap(700, ZERO, false), snap(699, ZERO, false), snap(701, ZERO, false)] });
  assert.equal(out.outcome, "cleared"); assert.deepEqual([out.firstBlock, out.block], [700, 701]);
});

test("quorum outage for the whole window -> quorum-unavailable (unknown, never 'still held'), bounded, ONE release", async () => {
  const { out, calls } = await run({ answer: UNCONFIRMED(), reads: [DOWN] });
  assert.equal(out.outcome, "quorum-unavailable"); assert.equal(out.reads, 0); assert.ok(out.failures > 0);
  assert.equal(calls.release, 1);
  assert.ok(calls.sleeps <= Math.ceil(MOVE_RELEASE.answerWaitMs / MOVE_RELEASE.pollMs) + 1, "the poll is bounded by the answer window");
});

test("outage then recovery inside the window: cleared once two increasing blocks agree", async () => {
  const { out } = await run({ answer: LOST(), reads: [DOWN, DOWN, snap(800, ZERO, false), DOWN, snap(801, ZERO, false)] });
  assert.equal(out.outcome, "cleared"); assert.equal(out.failures, 3);
});

test("the source keeps its lease for the whole window -> still-held", async () => {
  const { out, calls } = await run({ answer: UNCONFIRMED(), reads: [snap(900, SRC, true)] });
  assert.equal(out.outcome, "still-held"); assert.equal(out.block, 900); assert.equal(calls.release, 1);
});

test("a definite refusal before any effect reads the ledger once and stops: refused, no sleep, no second send", async () => {
  const { out, calls } = await run({ answer: BLOCKED(), reads: [snap(1000, SRC, true)] });
  assert.equal(out.outcome, "refused"); assert.equal(calls.snapshot, 1); assert.equal(calls.sleeps, 0); assert.equal(calls.release, 1);
});

test("a malformed snapshot (no integer block) is a failed read, not an absence", async () => {
  const { out } = await run({ answer: UNCONFIRMED(), reads: [{ runner: ZERO, held: false, block: "x" }] });
  assert.equal(out.outcome, "quorum-unavailable");
});

test("the boundary is required and the release is never sent twice in any outcome", async () => {
  await assert.rejects(confirmSourceLeaseCleared({}), TypeError);
  for (const [answer, reads] of [[UNCONFIRMED(), [DOWN]], [LOST(), [snap(1, SRC, true)]], [BLOCKED(), [snap(1, ZERO, false), snap(2, ZERO, false)]],
                                 [{ json: { released: true } }, [snap(1, ZERO, false), snap(2, ZERO, false)]]]) {
    const { calls } = await run({ answer, reads });
    assert.equal(calls.release, 1);
  }
});
