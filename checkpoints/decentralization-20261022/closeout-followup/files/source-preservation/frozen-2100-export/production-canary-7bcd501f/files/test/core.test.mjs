// Pure tests: canonical hashing, the output guard, markers, the journal chain and the bounded transaction executor.
// No network, no chain, no keys: the transaction client is a fake.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonical, hashOf } from "../driver/canonical.mjs";
import { createGuard, encodingsOf } from "../driver/guard.mjs";
import { createMarkerSet, loadMarkerSet, commitmentOf } from "../driver/markers.mjs";
import { verifyJournal, makeEntry, appendEntry, readJournal, readyToRun, GENESIS } from "../driver/journal.mjs";
import { checkTxAgainstStep, executeTx, simulateRefusal, GLOBAL_GAS_CAP } from "../driver/tx.mjs";

const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canary-core-"))); fs.chmodSync(d, 0o700); return d; };

test("canonical: key order independent, bigints tagged, undefined and bytes refused", () => {
  assert.equal(canonical({ b: 1, a: [2n, { d: 1, c: 2 }] }), canonical({ a: [2n, { c: 2, d: 1 }], b: 1 }));
  assert.equal(canonical({ x: 5n }), '{"x":"n:5"}');
  assert.throws(() => canonical({ x: undefined }), /undefined/);
  assert.throws(() => canonical({ x: Buffer.from("a") }), /hex/);
  assert.throws(() => canonical({ x: 1.5 }), /safe integers/);
  assert.notEqual(hashOf("a", { x: 1 }), hashOf("b", { x: 1 }));
});

test("guard: refuses forbidden field names and every encoding of a registered secret", () => {
  const g = createGuard();
  const secret = "CANARY_20261023T000000Z_c1_" + "ab".repeat(32);
  g.register(secret);
  for (const enc of encodingsOf(secret)) assert.throws(() => g.check({ note: `xx${enc}yy` }), /registered secret/, enc);
  assert.throws(() => g.check(`log: ${Buffer.from(secret).toString("base64").replace(/=+$/, "")}`), /registered secret/);
  assert.throws(() => g.check({ a: { privateKey: "0x1" } }), /forbidden field/);
  assert.throws(() => g.check({ a: [{ plaintext: "x" }] }), /forbidden field/);
  assert.throws(() => g.check({ report: "AAAA" }), /forbidden field/);
  assert.doesNotThrow(() => g.check({ commitment: "ff".repeat(32), txHash: "0x" + "12".repeat(32) }));
  const key = "0x" + "5a".repeat(32);
  g.register(key);
  assert.throws(() => g.check({ x: "5A".repeat(32) }), /registered secret/);
  assert.throws(() => g.register("short"), /16 characters/);
});

test("markers: O_EXCL 0600 file in a 0700 dir, commitments only, never reused", () => {
  const dir = tmp();
  try {
    let n = 0;
    const rng = (k) => Buffer.alloc(k, ++n);
    const m = createMarkerSet({ dir, run: "20261023T000000Z", set: "c1-rev1", names: ["CANARY_A", "CANARY_B"], rng });
    assert.equal(fs.statSync(m.file).mode & 0o777, 0o600);
    assert.notEqual(m.values.CANARY_A, m.values.CANARY_B);
    assert.equal(m.commitments.CANARY_A, commitmentOf({ run: "20261023T000000Z", set: "c1-rev1", name: "CANARY_A", value: m.values.CANARY_A }));
    assert.ok(!JSON.stringify(m.commitments).includes(m.values.CANARY_A));
    assert.throws(() => createMarkerSet({ dir, run: "20261023T000000Z", set: "c1-rev1", names: ["CANARY_A"] }), /EEXIST/);
    assert.deepEqual(loadMarkerSet({ dir, set: "c1-rev1" }).commitments, m.commitments);
    fs.chmodSync(dir, 0o755);
    assert.throws(() => createMarkerSet({ dir, run: "20261023T000000Z", set: "c1-rev2", names: ["CANARY_A"] }), /0700/);
    fs.chmodSync(dir, 0o700);
    assert.throws(() => createMarkerSet({ dir, run: "20261023T000000Z", set: "c1-rev2", names: ["lower"] }), /CANARY_/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

const fakePlan = (obs = {}, ids = {}) => ({
  pinsHash: "p".repeat(64),
  steps: [
    { id: "A", stepHash: "a".repeat(64), kind: "operator", after: [], status: "ready", learns: "C1", resolves: ["deploy.C1"] },
    { id: "B", stepHash: ids.C1 ? "b" + ids.C1.slice(3, 66) : "b".repeat(64), kind: "mutation", after: ["A"], status: ids.C1 ? "ready" : "blocked", blockedBy: ["no C1"] },
    { id: "C", stepHash: "c".repeat(64), kind: "hardware", after: ["B"], status: "blocked", blockedBy: ["second guest needs root review"] },
  ],
});
const C1 = "0x" + "c1".repeat(32);

test("journal: hash chain, learned ids, one record per step, order and blocked steps enforced", () => {
  const dir = tmp(), file = path.join(dir, "journal.jsonl"), g = createGuard();
  try {
    let j = readJournal(file, fakePlan);
    assert.equal(j.head, GENESIS);
    assert.match(readyToRun(j.plan, j.done, "B").reason, /blocked/);
    appendEntry(file, makeEntry({ plan: j.plan, head: j.head, seq: 0, step: j.plan.steps[0], outcome: "pass",
      evidence: { deploymentId: C1, resolves: { "deploy.C1": { ok: true }, "read.vault": { ok: true } } } }), g);
    j = readJournal(file, fakePlan);
    assert.equal(j.ids.C1, C1);
    assert.deepEqual(Object.keys(j.observations), ["deploy.C1"]);           // a step resolves only what it declares
    assert.equal(readyToRun(j.plan, j.done, "A").ok, false);
    assert.equal(readyToRun(j.plan, j.done, "B").ok, true);
    assert.match(readyToRun(j.plan, j.done, "C").reason, /blocked: second guest/);
    appendEntry(file, makeEntry({ plan: j.plan, head: j.head, seq: 1, step: j.plan.steps[1], outcome: "pass", evidence: { txHash: "0x01" } }), g);
    j = readJournal(file, fakePlan);
    assert.equal(j.entries.length, 2);
    const lines = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, lines.replace('"txHash":"0x01"', '"txHash":"0x02"'));
    assert.throws(() => readJournal(file, fakePlan), /hash mismatch/);
    // an entry for B written against ANOTHER C1 id no longer matches the plan learned from A
    const other = (obs, ids) => fakePlan(obs, { C1: "0x" + "d1".repeat(32) });
    fs.writeFileSync(file, lines);
    assert.throws(() => readJournal(file, (o, i) => (Object.keys(i).length ? other(o, i) : fakePlan(o, i))), /step hash/);
    const dup = makeEntry({ plan: j.plan, head: j.head, seq: 2, step: j.plan.steps[0], outcome: "pass", evidence: {} });
    assert.throws(() => verifyJournal([...j.entries, dup], fakePlan), /recorded twice/);
    assert.throws(() => verifyJournal(j.entries, () => ({ ...fakePlan(), pinsHash: "q".repeat(64) })), /other pins/);
    const secretEntry = makeEntry({ plan: j.plan, head: j.head, seq: 2, step: j.plan.steps[2], outcome: "pass", evidence: { privateKey: "x" } });
    assert.throws(() => appendEntry(file, secretEntry, g), /forbidden field/);
    fs.appendFileSync(file, '{"seq":');
    assert.throws(() => readJournal(file, fakePlan), /partial/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

const PROT = "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e";
const VAULT = "0xe48699b8401564aace7a814ae4569b67a3f7eef5", OWNER = "0x" + "11".repeat(20), SEL = "0x12345678";
const DATA = SEL + C1.slice(2) + "00".repeat(32);
const dataSha = createHash("sha256").update(Buffer.from(DATA.slice(2), "hex")).digest("hex");
const mstep = { id: "M1", stepHash: "m".repeat(64), mutation: { chainId: 8453, target: VAULT, from: OWNER, fn: "update", ids: [C1], gasCap: "400000", maxFeePerGasWei: "20000000", maxCostWei: "8000000000000" } };
const prepared = { stepId: "M1", stepHash: mstep.stepHash, calldataSha256: dataSha, preparedHash: "h".repeat(64), selector: SEL, expectNonce: 7 };
const tx = { chainId: 8453, to: VAULT, from: OWNER, data: DATA, value: 0n };

function fakeClient({ revert = false, estimate = 200000n, price = 5_000_000n, balance = 10n ** 15n, nonce = 7, receipt = { status: "success", blockNumber: 9n, gasUsed: 150000n, effectiveGasPrice: 5_000_000n }, hang = false } = {}) {
  const calls = [];
  return { calls,
    getBalance: async () => balance,
    call: async (a) => { calls.push(["call", a]); if (revert) throw Object.assign(new Error("execution reverted: NotOwner()"), { shortMessage: "reverted: NotOwner", errorName: "NotOwner" }); },
    estimateGas: async () => { calls.push(["estimate"]); return estimate; },
    getGasPrice: async () => price,
    getTransactionCount: async () => nonce,
    sendTransaction: async (t) => { calls.push(["send", t]); return "0x" + "ee".repeat(32); },
    waitForReceipt: async () => { if (hang) throw new Error("timeout"); return receipt; } };
}
const sends = (c) => c.calls.filter((x) => x[0] === "send").length;

test("tx: every pin is enforced before anything is sent", () => {
  assert.equal(checkTxAgainstStep(tx, mstep, prepared, SEL).gasCap, 400000n);
  const bad = [
    [{ ...tx, to: "0x" + "22".repeat(20) }, /target/], [{ ...tx, from: "0x" + "33".repeat(20) }, /sender/],
    [{ ...tx, chainId: 1 }, /8453/], [{ ...tx, value: 1n }, /value/], [{ ...tx, data: "0xdeadbeef" + DATA.slice(10) }, /selector/],
    [{ ...tx, data: SEL + PROT.slice(2) + "00".repeat(32) }, /names deployment/], [{ ...tx, data: DATA.slice(0, -2) + "01" }, /calldata differs/],
    [{ ...tx, data: DATA + "0" }, /ABI words/],
  ];
  for (const [t, re] of bad) assert.throws(() => checkTxAgainstStep(t, mstep, prepared, SEL), re);
  const m = (x) => ({ ...mstep, mutation: { ...mstep.mutation, ...x } });
  assert.throws(() => checkTxAgainstStep(tx, m({ gasCap: String(GLOBAL_GAS_CAP + 1n) }), prepared, SEL), /gas cap/);
  assert.throws(() => checkTxAgainstStep(tx, m({ maxCostWei: "1" }), prepared, SEL), /cost cap/);
  assert.throws(() => checkTxAgainstStep(tx, m({ maxFeePerGasWei: "200000000", maxCostWei: "80000000000000" }), prepared, SEL), /fee ceiling/);
  assert.throws(() => checkTxAgainstStep(tx, mstep, { ...prepared, stepHash: "x" }, SEL), /prepared record/);
  assert.throws(() => checkTxAgainstStep(tx, { id: "R", stepHash: "r" }, prepared, SEL), /not a mutation/);
});

test("tx: confirmation, balance, simulation, gas, fee and nonce gates; gas = cap; no retry on an unknown receipt", async () => {
  const run = (c, extra = {}) => executeTx({ step: mstep, prepared, selector: SEL, tx, confirm: prepared.preparedHash, client: c, ...extra });
  await assert.rejects(executeTx({ step: mstep, prepared, selector: SEL, tx, confirm: mstep.stepHash, client: fakeClient() }), /prepared hash/);
  for (const [opts, by] of [[{ balance: 1n }, /balance/], [{ revert: true }, /simulation/], [{ estimate: 500000n }, /gas cap/], [{ price: 11_000_000n }, /fee ceiling/], [{ nonce: 8 }, /nonce moved/]]) {
    const c = fakeClient(opts);
    const r = await run(c);
    assert.equal(r.outcome, "fail"); assert.match(r.evidence.refusedBy, by); assert.equal(sends(c), 0);
  }
  let c = fakeClient();
  let r = await run(c);
  assert.equal(r.outcome, "pass");
  const sent = c.calls.find((x) => x[0] === "send")[1];
  assert.equal(sent.gas, 400000n); assert.equal(sent.maxFeePerGas, 20_000_000n); assert.equal(sent.value, 0n); assert.equal(sent.nonce, 7);
  c = fakeClient({ hang: true });
  r = await run(c);
  assert.equal(r.outcome, "aborted"); assert.match(r.evidence.receipt, /UNKNOWN/); assert.equal(sends(c), 1);
  assert.equal((await run(fakeClient({ receipt: { status: "reverted", blockNumber: 9n, gasUsed: 400000n } }))).outcome, "fail");
});

test("simulateRefusal: pass only on the expected revert; a succeeding call fails the step", async () => {
  assert.equal((await simulateRefusal({ client: fakeClient({ revert: true }), from: OWNER, to: VAULT, data: DATA, expectRevert: "NotOwner" })).outcome, "pass");
  assert.equal((await simulateRefusal({ client: fakeClient({ revert: true }), from: OWNER, to: VAULT, data: DATA, expectRevert: "StaleRevision" })).outcome, "fail");
  const r = await simulateRefusal({ client: fakeClient(), from: OWNER, to: VAULT, data: DATA, expectRevert: "NotOwner" });
  assert.equal(r.outcome, "fail"); assert.equal(r.evidence.reverted, false);
});
