// The owner-move hand-off decision (cli/move-release-confirm.mjs, r2): the REAL module, the REAL ManagementError
// (network/management-client.mjs), and a fake boundary for the source host's answer and the owner's ledger reads, shaped
// exactly as moveSnapshot(id, null) returns them (QuorumChain.snapshot: blockNumber is a bigint; d from the deployment
// tuple: runner bytes32, leaseUntil uint64 -> bigint, balance6 uint256 -> bigint). No network, no chain, a fake clock.
// Absence is a repeated OBSERVATION on increasing blocks, not reorg protection; the host's released:true is the host's
// claim, never a verified receipt; malformed reads and arbitrary errors fail closed.
import test from "node:test";
import assert from "node:assert/strict";
import { confirmSourceLeaseCleared, validateMoveSnapshot, MOVE_RELEASE } from "../cli/move-release-confirm.mjs";
import { ManagementError } from "../network/management-client.mjs";

const SRC = "0x" + "a1".repeat(32), OTHER = "0x" + "b2".repeat(32), ZERO = "0x" + "00".repeat(32);
const T0 = 1_800_000_000;
/** A valid moveSnapshot(id, null) result: held is derived from runner and leaseUntil exactly as moveSnapshot does. */
function snap(block, runner, held, over = {}) {
  const blockTime = T0 + Number(block);
  const leaseUntil = held ? BigInt(blockTime + 600) : runner === ZERO ? 0n : BigInt(blockTime - 1);
  return { d: { runner, leaseUntil, balance6: 5_000_000n, active: true }, rate: null, cap: 0n, host: null, schema: null,
           block: BigInt(block), blockTime, runner, held, ...over };
}
const DOWN = Symbol("quorum down");
const UNCONFIRMED = () => new ManagementError("the release may have run; its outcome is unknown (HTTP 503 release_unconfirmed)",
  { status: 503, code: "release_unconfirmed", sent: true, outcomeUnknown: true });
const LOST = () => new ManagementError("the release may have run; its outcome is unknown (the answer was cut off)", { sent: true, outcomeUnknown: true });
const BLOCKED = () => new ManagementError("management release refused (HTTP 409)", { status: 409, code: "release_blocked", sent: true, outcomeUnknown: false });

async function run({ answer, reads, ...opts }) {
  let t = 1_000_000, i = 0;
  const calls = { release: 0, snapshot: 0, sleeps: 0 };
  const out = await confirmSourceLeaseCleared({
    source: SRC,
    release: async () => { calls.release++; if (answer instanceof Error) throw answer; return answer; },
    snapshot: async () => { calls.snapshot++; const r = reads[Math.min(i++, reads.length - 1)]; if (r === DOWN) throw new Error("no 2 RPCs agreed"); return r; },
    sleep: async (ms) => { calls.sleeps++; t += ms; },
    now: () => t,
    ...opts,
  });
  return { out, calls };
}

test("the real moveSnapshot shape (bigint block, bigint tuple fields) validates; a number block is normalized", () => {
  const v = validateMoveSnapshot(snap(100, ZERO, false));
  assert.equal(v.block, 100n); assert.equal(v.runner, ZERO); assert.equal(v.held, false);
  assert.equal(validateMoveSnapshot({ ...snap(7, SRC, true), block: 7 }).block, 7n);
});

test("malformed or inconsistent snapshots fail closed: never an absence, never cleared", async () => {
  const s = snap(100, ZERO, false), h = snap(100, SRC, true);
  const bad = {
    "null": null, "not an object": "x",
    "runner missing": { ...s, runner: undefined }, "runner short": { ...s, runner: "0x00" }, "runner uppercase": { ...s, runner: SRC.toUpperCase().replace("0X", "0x") },
    "held missing": { ...s, held: undefined }, "held as string": { ...s, held: "false" }, "held null": { ...s, held: null },
    "block missing": { ...s, block: undefined }, "block negative": { ...s, block: -1n }, "block float": { ...s, block: 1.5 }, "block string": { ...s, block: "100" },
    "blockTime missing": { ...s, blockTime: undefined },
    "d missing": { ...s, d: undefined }, "d.runner differs": { ...s, d: { ...s.d, runner: OTHER } },
    "leaseUntil as number": { ...s, d: { ...s.d, leaseUntil: 0 } }, "balance6 missing": { ...s, d: { ...s.d, balance6: undefined } },
    "held=false but lease live (stale/inconsistent)": { ...h, held: false },
    "held=true on a zero runner": { ...s, held: true },
  };
  for (const [name, r] of Object.entries(bad)) {
    assert.equal(validateMoveSnapshot(r), null, name);
    const { out, calls } = await run({ answer: UNCONFIRMED(), reads: [r] });
    assert.equal(out.outcome, "quorum-unavailable", name); assert.ok(out.malformed > 0, name); assert.equal(calls.release, 1, name);
  }
});

test("a malformed read between two valid absences neither confirms nor resets", async () => {
  const { out } = await run({ answer: UNCONFIRMED(), reads: [snap(100, ZERO, false), { ...snap(101, ZERO, false), held: undefined }, snap(102, ZERO, false)] });
  assert.equal(out.outcome, "cleared"); assert.deepEqual([out.firstBlock, out.block], [100n, 102n]); assert.equal(out.malformed, 1);
});

test("the host's released:true is reported as the host's claim; cleared still needs the owner's two observations", async () => {
  const { out, calls } = await run({ answer: { json: { id: "x", released: true, txHash: "0xabc" } },
    reads: [snap(100, ZERO, false), snap(101, ZERO, false)] });
  assert.equal(out.outcome, "cleared"); assert.equal(out.how, "runner-cleared");
  assert.equal(out.sourceReport, "released"); assert.equal(out.sourceReportedReleased, true); assert.equal(out.answer.txHash, "0xabc");
  assert.equal("receiptVerified" in out, false, "nothing claims a locally verified receipt");
  assert.equal(calls.release, 1);
});

test("a 2xx without released:true is not a host release claim", async () => {
  const { out } = await run({ answer: { json: { id: "x" } }, reads: [snap(1, ZERO, false), snap(2, ZERO, false)] });
  assert.equal(out.sourceReportedReleased, false); assert.equal(out.sourceReport, "unknown");
});

test("deep receipt after restart/outage: 503 release_unconfirmed + observed absence -> cleared, no host release claim", async () => {
  const { out, calls } = await run({ answer: UNCONFIRMED(), reads: [snap(5000, ZERO, false), snap(5001, ZERO, false)] });
  assert.equal(out.outcome, "cleared"); assert.equal(out.sourceReportedReleased, false); assert.equal(out.sourceReport, "unknown");
  assert.equal(out.answer.code, "release_unconfirmed"); assert.equal(calls.release, 1);
});

test("release_unconfirmed whose transaction lands late is followed for the full 90 s window", async () => {
  const held = Array.from({ length: 20 }, (_, k) => snap(200 + k, SRC, true));
  const { out } = await run({ answer: UNCONFIRMED(), reads: [...held, snap(220, ZERO, false), snap(221, ZERO, false)] });
  assert.equal(out.outcome, "cleared"); assert.equal(out.firstBlock, 220n); assert.ok(MOVE_RELEASE.answerWaitMs >= 90_000);
});

test("changed generation: another runner holds the lease -> cleared as taken", async () => {
  const { out } = await run({ answer: UNCONFIRMED(), reads: [snap(300, OTHER, true), snap(301, OTHER, true)] });
  assert.equal(out.outcome, "cleared"); assert.equal(out.how, "taken"); assert.equal(out.runner, OTHER);
});

test("the source's lease that ran out (same runner, not held) -> cleared as lapsed", async () => {
  const { out } = await run({ answer: LOST(), reads: [snap(400, SRC, false), snap(401, SRC, false)] });
  assert.equal(out.outcome, "cleared"); assert.equal(out.how, "lapsed");
});

test("a later observation of the source's lease resets the count (observation only, not reorg protection)", async () => {
  const { out } = await run({ answer: UNCONFIRMED(), reads: [snap(500, ZERO, false), snap(501, SRC, true), snap(502, ZERO, false), snap(503, ZERO, false)] });
  assert.equal(out.outcome, "cleared"); assert.deepEqual([out.firstBlock, out.block], [502n, 503n]);
});

test("absence observed once, then the source's lease until the deadline -> clear-unconfirmed (unknown)", async () => {
  const { out } = await run({ answer: UNCONFIRMED(), reads: [snap(600, ZERO, false), snap(601, SRC, true)] });
  assert.equal(out.outcome, "clear-unconfirmed"); assert.equal(out.heldAgainAt, 601n);
});

test("reads at the same or a lower block (QuorumChain never goes below lastBlock) neither confirm nor reset", async () => {
  const { out } = await run({ answer: UNCONFIRMED(), reads: [snap(700, ZERO, false), snap(700, ZERO, false), snap(699, ZERO, false), snap(701, ZERO, false)] });
  assert.equal(out.outcome, "cleared"); assert.deepEqual([out.firstBlock, out.block], [700n, 701n]);
});

test("quorum outage for the whole window -> quorum-unavailable, bounded polling, ONE release", async () => {
  const { out, calls } = await run({ answer: UNCONFIRMED(), reads: [DOWN] });
  assert.equal(out.outcome, "quorum-unavailable"); assert.equal(out.reads, 0); assert.ok(out.failures > 0); assert.equal(calls.release, 1);
  assert.ok(calls.sleeps <= Math.ceil(MOVE_RELEASE.answerWaitMs / MOVE_RELEASE.pollMs) + 1);
});

test("outage then recovery inside the window -> cleared once two increasing blocks are observed", async () => {
  const { out } = await run({ answer: LOST(), reads: [DOWN, DOWN, snap(800, ZERO, false), DOWN, snap(801, ZERO, false)] });
  assert.equal(out.outcome, "cleared"); assert.equal(out.failures, 3);
});

test("the source holds the lease on every valid read -> still-held", async () => {
  const { out } = await run({ answer: UNCONFIRMED(), reads: [snap(900, SRC, true)] });
  assert.equal(out.outcome, "still-held"); assert.equal(out.block, 900n);
});

test("a definite ManagementError refusal + a valid read of the source's lease -> refused, one read, no sleep", async () => {
  const { out, calls } = await run({ answer: BLOCKED(), reads: [snap(1000, SRC, true)] });
  assert.equal(out.outcome, "refused"); assert.equal(out.block, 1000n); assert.equal(calls.snapshot, 1); assert.equal(calls.sleeps, 0);
});

test("a definite refusal with every read down -> quorum-unavailable, never 'refused/still held' on zero reads", async () => {
  const { out } = await run({ answer: BLOCKED(), reads: [DOWN] });
  assert.equal(out.outcome, "quorum-unavailable"); assert.equal(out.sourceReport, "refused"); assert.equal(out.reads, 0);
});

test("a definite refusal with only malformed reads -> quorum-unavailable", async () => {
  const { out } = await run({ answer: BLOCKED(), reads: [{ ...snap(1, SRC, true), held: undefined }] });
  assert.equal(out.outcome, "quorum-unavailable");
});

test("an ordinary Error, or a ManagementError without an explicit outcomeUnknown:false, is outcome-unknown, not definite", async () => {
  for (const e of [new Error("socket hang up"), Object.assign(new Error("x"), { code: "release_blocked" }),
                   new ManagementError("x", { code: "release_blocked" }) /* default false: real boundary */]) {
    const definiteExpected = e instanceof ManagementError;
    const { out, calls } = await run({ answer: e, reads: [snap(1100, SRC, true)] });
    if (definiteExpected) { assert.equal(out.outcome, "refused"); continue; }
    assert.equal(out.sourceReport, "unknown"); assert.equal(out.outcome, "still-held"); assert.ok(calls.sleeps > 0, "keeps observing");
  }
  const forged = Object.assign(new Error("y"), { name: "ManagementError" });       // no outcomeUnknown field at all
  const { out } = await run({ answer: forged, reads: [snap(1200, SRC, true)] });
  assert.equal(out.sourceReport, "unknown"); assert.equal(out.outcome, "still-held");
  const { out: o2 } = await run({ answer: "a thrown string", reads: [snap(1300, SRC, true)] });
  assert.equal(o2.sourceReport, "unknown");
});

test("the boundary is required and the release is never sent twice in any outcome", async () => {
  await assert.rejects(confirmSourceLeaseCleared({}), TypeError);
  await assert.rejects(confirmSourceLeaseCleared({ release: async () => {}, snapshot: async () => {}, sleep: async () => {}, now: () => 0, source: "0x12" }), TypeError);
  for (const [answer, reads] of [[UNCONFIRMED(), [DOWN]], [LOST(), [snap(1, SRC, true)]], [BLOCKED(), [snap(1, ZERO, false), snap(2, ZERO, false)]],
                                 [BLOCKED(), [DOWN]], [{ json: { released: true } }, [snap(1, ZERO, false), snap(2, ZERO, false)]]]) {
    const { calls } = await run({ answer, reads });
    assert.equal(calls.release, 1);
  }
});
