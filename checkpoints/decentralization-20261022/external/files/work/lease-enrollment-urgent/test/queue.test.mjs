// Focused enrollment-queue tests: plan pin/rebuild, queue order/restart/lost reply/duplicate/wrong plan/wrong hash/revert,
// and the chain checks (authority, duplicate pre-state, nonce, fees, exact receipt/events) against an in-memory model.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeFunctionData } from "../../enclave/node_modules/viem/_esm/index.js";
import { verifiedArtifacts } from "../../lease-gas-wallet-signing/artifacts.mjs";
import { PRODUCTION } from "../../lease-gas-wallet-signing/trust.mjs";
import { fileJournal } from "../handoff-server.mjs";
import { createQueueServer } from "../queue-server.mjs";
import { validatePlan, sha256, VAULT_ABI } from "../plan.mjs";
import { prepareOperation, verifyOperation, checkLanding, startCheck, releaseCheck } from "../chain.mjs";
import { ENROLLMENT } from "../trust.mjs";
import { createModel, TRUST } from "./model.mjs";

const ROOT = "/home/steven/Documents/Codex/2026-10-18/wo/outputs/app-lease-gas-review";
const abi = verifiedArtifacts({ trust: PRODUCTION }).EnclaveLeaseGasReserve.abi;
const files = () => ({ proposal: fs.readFileSync(`${ROOT}/complete-bootstrap-funding-proposal.json`), enrollment: fs.readFileSync(`${ROOT}/enrollment-bootstrap-proposal.json`),
  identities: fs.readFileSync(`${ROOT}/lease-relay-identities.json`) });
const PIN = sha256(files().proposal);
const plan = validatePlan({ trust: ENROLLMENT, reserveAbi: abi, approvedSha256: PIN, ...files() });
const ops = plan.operations;
const tamper = (fn) => { const f = files(), p = JSON.parse(f.proposal); fn(p); const proposal = Buffer.from(JSON.stringify(p)); return { ...f, proposal, approvedSha256: sha256(proposal) }; };
const H = (n) => "0x" + n.toString(16).padStart(64, "0");

// ---- plan ------------------------------------------------------------------------------------------------------------
test("the approved proposal rebuilds exactly: 25 operations, 0.0013 ETH, only reviewed recipients", () => {
  assert.equal(ops.length, 25); assert.equal(plan.totalWei, 1_300_000_000_000_000n);
  const kinds = ops.reduce((m, o) => ({ ...m, [o.kind]: (m[o.kind] || 0) + 1 }), {});
  assert.deepEqual(kinds, { deposit: 11, configure: 11, setClaimant: 1, transfer: 2 });
  assert.equal(new Set(ops.map((o) => o.opId)).size, 25);
  assert.deepEqual(new Set(ops.map((o) => o.to)), new Set([ENROLLMENT.reserve, ENROLLMENT.dnsVault, ...ENROLLMENT.relays.map((r) => r[1])]));
  for (const o of ops.filter((o) => o.to === ENROLLMENT.dnsVault)) {
    const d = decodeFunctionData({ abi: VAULT_ABI, data: o.data }); assert.equal(d.functionName, "ownerCall"); assert.equal(d.args[0].toLowerCase(), ENROLLMENT.reserve);
    assert.equal(decodeFunctionData({ abi, data: d.args[1] }).args[0], "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c");
  }
  for (const o of ops) assert.ok(o.title.length > 10 && o.appLabel);
});
test("no pin, a different pin, or a changed plan are refused", () => {
  assert.throws(() => validatePlan({ trust: ENROLLMENT, reserveAbi: abi, approvedSha256: null, ...files() }), /approved proposal sha256 pin is required/);
  assert.throws(() => validatePlan({ trust: ENROLLMENT, reserveAbi: abi, approvedSha256: "0".repeat(64), ...files() }), /not the approved proposal/);
  const bad = [(p) => { p.operations[0].value = "0x5af3107a4001"; }, (p) => { p.operations[23].to = "0x" + "12".repeat(20); }, (p) => { p.operations.push({ ...p.operations[24] }); },
    (p) => { p.operations[21].data = p.operations[21].data.replace(/1a01194c34fe3577c6d0a54feb78af6253e494e0/i, "1".repeat(40)); }, (p) => { [p.operations[0], p.operations[1]] = [p.operations[1], p.operations[0]]; },
    (p) => { p.operations[3].gas = "0x7a120"; }];
  for (const fn of bad) assert.throws(() => validatePlan({ trust: ENROLLMENT, reserveAbi: abi, ...tamper(fn) }), /differs|exactly 25|total/);
  const ids = JSON.parse(files().identities); ids.identities[0].address = ids.identities[1].address;
  assert.throws(() => validatePlan({ trust: ENROLLMENT, reserveAbi: abi, approvedSha256: PIN, ...files(), identities: Buffer.from(JSON.stringify(ids)) }), /relay identity metadata changed/);
});

// ---- queue transport -------------------------------------------------------------------------------------------------
const memJournal = (init = { status: "ready" }) => { let v = structuredClone(init); return { read: () => structuredClone(v), write: (x) => { v = structuredClone(x); }, get value() { return v; } }; };
const fakeRequest = (op, nonce = 7) => ({ opId: op.opId, transaction: { from: op.from, to: op.to, data: op.data, value: op.value, nonce: "0x" + nonce.toString(16), chainId: "0x2105" } });
async function queue(t, { journals = ops.map(() => memJournal()), session = memJournal({ status: "not started" }), prepare, verify, release, start } = {}) {
  const calls = { prepare: [], start: 0 };
  const app = createQueueServer({ operations: ops, planSha256: plan.planSha256, journals, session, setupHashes: ENROLLMENT.setupHashes,
    prepare: prepare || (async (op, ctx) => { calls.prepare.push([op.index, ctx]); return fakeRequest(op, 7 + op.index); }),
    verify: verify || (async (op, attempts, hash) => ({ outcome: "confirmed", transactionHash: hash, attempts: attempts.length })),
    release: release || (async (_op, nonce) => ({ nonce })), start: start || (async () => { calls.start++; return { ok: true }; }) });
  await app.listen(); t.after(() => app.close());
  const token = (await (await fetch(app.origin + "/queue")).json()).token;
  const post = async (url, data = {}, headers = {}) => { const r = await fetch(app.origin + url, { method: "POST", headers: { Origin: app.origin, "X-Signing-Token": token, "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) }); return { status: r.status, body: await r.json() }; };
  return { app, post, calls, journals, session };
}
test("nothing is prepared before the explicit start, and only in order", async (t) => {
  const { post, calls } = await queue(t);
  assert.equal((await post("/prepare", { index: 0 })).status, 409);
  assert.equal((await post("/start", {}, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/start")).status, 200); assert.equal((await post("/start")).status, 200); assert.equal(calls.start, 1);
  assert.equal((await post("/prepare", { index: 1 })).status, 409);
  const p = await post("/prepare", { index: 0 }); assert.equal(p.status, 200); assert.equal(p.body.transaction.to, ops[0].to);
  assert.equal((await post("/prepare", { index: 1 })).status, 409, "op 0 still has an open attempt");
  assert.equal((await post("/result", { index: 0, hash: H(1) })).status, 200);
  assert.equal((await post("/prepare", { index: 1 })).status, 200); assert.deepEqual(calls.prepare.map((c) => c[0]), [0, 1]);
  assert.equal(calls.prepare[1][1].laterValueWei, ops.slice(2).reduce((s, o) => s + BigInt(o.value), 0n));
});
test("full run: 25 confirmations, totals count down to zero", async (t) => {
  const { post, app } = await queue(t); await post("/start");
  for (let i = 0; i < 25; i++) { assert.equal((await post("/prepare", { index: i })).status, 200); assert.equal((await post("/result", { index: i, hash: H(100 + i) })).status, 200); }
  const v = app.view(); assert.equal(v.next, null); assert.equal(v.totals.remainingSignatures, 0); assert.equal(v.totals.remainingWei, "0"); assert.equal(v.totals.confirmedWei, "1300000000000000");
  assert.equal((await post("/prepare", { index: 24 })).status, 409);
});
test("restart: an awaiting-wallet journal blocks; release keeps the nonce; a crash while preparing returns to ready", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enrollment-queue-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const js = () => ops.map((_o, i) => fileJournal(path.join(dir, `op-${i}.json`))), sess = () => fileJournal(path.join(dir, "session.json"));
  { const { post } = await queue(t, { journals: js(), session: sess() }); await post("/start"); assert.equal((await post("/prepare", { index: 0 })).status, 200); }
  assert.equal(fs.statSync(path.join(dir, "op-0.json")).mode & 0o777, 0o600);
  const seen = [];
  const b = await queue(t, { journals: js(), session: sess(), prepare: async (op, ctx) => { seen.push(ctx.reservedNonce); return fakeRequest(op, 7); } });
  assert.equal(b.app.session.status, "started"); assert.equal(b.app.states[0].status, "awaiting-wallet");
  assert.equal((await b.post("/prepare", { index: 0 })).status, 409, "unknown outcome blocks a new request");
  assert.equal((await b.post("/rejected", { index: 0, code: -32603 })).status, 409);
  assert.equal((await b.post("/release", { index: 0 })).status, 200); assert.equal(b.app.states[0].reservedNonce, 7); assert.equal(b.app.states[0].attempts.length, 1);
  assert.equal((await b.post("/prepare", { index: 0 })).status, 200); assert.deepEqual(seen, [7]); assert.equal(b.app.states[0].attempts.length, 2);
  // a crash while preparing: nothing left the server
  fileJournal(path.join(dir, "op-0.json")).write({ ...b.app.states[0], status: "preparing" });
  const c = await queue(t, { journals: js(), session: sess() }); assert.equal(c.app.states[0].status, "ready"); assert.equal(c.app.states[0].reservedNonce, 7);
});
test("release is refused when the chain shows the nonce used; then only the hash can resolve it", async (t) => {
  const { post, app } = await queue(t, { release: async () => { throw Error("nonce 7 was used: enter that transaction's hash"); } });
  await post("/start"); await post("/prepare", { index: 0 });
  assert.equal((await post("/release", { index: 0 })).status, 400); assert.equal(app.states[0].status, "awaiting-wallet");
  assert.equal((await post("/result", { index: 0, hash: H(9) })).status, 200); assert.equal(app.states[0].status, "confirmed");
});
test("explicit rejection resets the attempt and clears its nonce; a released op still accepts its lost hash", async (t) => {
  const { post, app } = await queue(t); await post("/start"); await post("/prepare", { index: 0 });
  assert.equal((await post("/rejected", { index: 0, code: 4001 })).status, 200); assert.equal(app.states[0].reservedNonce, null); assert.equal(app.states[0].attempts.length, 0);
  await post("/prepare", { index: 0 }); await post("/release", { index: 0 });
  assert.equal(app.view().operations[0].recoverable, true);
  assert.equal((await post("/result", { index: 0, hash: H(5) })).status, 200); assert.equal(app.states[0].status, "confirmed");
});
test("lost verification reply keeps the hash: same hash retries, a different hash or a new request is refused", async (t) => {
  let fail = true;
  const { post, app } = await queue(t, { verify: async (_o, _a, hash) => { if (fail) throw Error("the transaction lacks two later blocks"); return { outcome: "confirmed", transactionHash: hash }; } });
  await post("/start"); await post("/prepare", { index: 0 });
  assert.equal((await post("/result", { index: 0, hash: H(1) })).status, 400); assert.equal(app.states[0].status, "submitted"); assert.equal(app.states[0].hash, H(1));
  assert.equal((await post("/result", { index: 0, hash: H(2) })).status, 409); assert.equal((await post("/prepare", { index: 0 })).status, 409);
  assert.equal((await post("/prepare", { index: 1 })).status, 409); assert.equal((await post("/rejected", { index: 0, code: 4001 })).status, 409);
  fail = false; assert.equal((await post("/result", { index: 0, hash: H(1).toUpperCase().replace("0X", "0x") })).status, 200); assert.equal(app.states[0].status, "confirmed");
});
test("setup-stage and other-operation hashes are refused before they are recorded", async (t) => {
  const { post, app } = await queue(t); await post("/start"); await post("/prepare", { index: 0 }); await post("/result", { index: 0, hash: H(1) });
  await post("/prepare", { index: 1 });
  for (const h of [...ENROLLMENT.setupHashes, H(1)]) { assert.equal((await post("/result", { index: 1, hash: h })).status, 409); assert.equal(app.states[1].hash, undefined); assert.equal(app.states[1].status, "awaiting-wallet"); }
});
test("a reverted operation halts the queue", async (t) => {
  const { post, app } = await queue(t, { verify: async (_o, _a, hash) => ({ outcome: "reverted", transactionHash: hash }) });
  await post("/start"); await post("/prepare", { index: 0 }); assert.equal((await post("/result", { index: 0, hash: H(1) })).status, 200);
  assert.equal(app.states[0].status, "reverted"); const r = await post("/prepare", { index: 0 }); assert.equal(r.status, 409); assert.match(r.body.error, /reverted/);
});
test("a journal of another plan refuses to load; persistence failure returns no transaction; a mismatching prepare is discarded", async (t) => {
  const js = ops.map(() => memJournal()); js[3] = memJournal({ status: "ready", opId: "f".repeat(64), planSha256: plan.planSha256, attempts: [] });
  assert.throws(() => createQueueServer({ operations: ops, planSha256: plan.planSha256, journals: js, session: memJournal(), prepare() {}, verify() {}, release() {}, start() {} }), /another plan/);
  const started = memJournal({ status: "started", planSha256: "e".repeat(64) });
  assert.throws(() => createQueueServer({ operations: ops, planSha256: plan.planSha256, journals: ops.map(() => memJournal()), session: started, prepare() {}, verify() {}, release() {}, start() {} }), /another plan/);
  const failing = ops.map(() => memJournal()); failing[0] = { read: () => ({ status: "ready" }), write: (x) => { if (x.status === "awaiting-wallet") throw Error("fsync failed"); } };
  const a = await queue(t, { journals: failing }); await a.post("/start"); const r = await a.post("/prepare", { index: 0 });
  assert.equal(r.status, 400); assert.equal(r.body.transaction, undefined);
  const b = await queue(t, { prepare: async (op) => ({ ...fakeRequest(op), transaction: { ...fakeRequest(op).transaction, to: "0x" + "12".repeat(20) } }) });
  await b.post("/start"); assert.equal((await b.post("/prepare", { index: 0 })).status, 400); assert.equal(b.app.states[0].status, "ready"); assert.equal(b.app.states[0].attempts.length, 0);
});

// ---- chain checks against the model ----------------------------------------------------------------------------------
const opOf = (kind, vault = false) => ops.find((o) => o.kind === kind && (o.ownerOfRecord === ENROLLMENT.dnsVault) === vault);
const prep = (m, op, extra = {}) => prepareOperation({ trust: TRUST, abi, op, planSha256: plan.planSha256, clients: m.clients(), ...extra });
test("prepare: exact transaction for each kind (direct, via vault, relay transfer); the start check passes", async () => {
  const m = createModel(abi);
  assert.equal((await startCheck({ trust: TRUST, abi, ops, clients: m.clients() })).operationsChecked, 25);
  for (const op of [opOf("deposit"), opOf("configure"), opOf("setClaimant", true), opOf("configure", true), opOf("deposit", true), ops[24]]) {
    const r = await prep(m, op), w = r.transaction;
    assert.deepEqual([w.from, w.to, w.data, w.value, w.nonce, w.chainId, w.type], [TRUST.admin, op.to, op.data, op.value, "0x7", "0x2105", "0x2"]);
    assert.ok(BigInt(w.gas) <= BigInt(op.gas)); assert.equal(w.maxFeePerGas, "0x" + (2n * 5_000_000n + 1_000_000n).toString(16));
    assert.equal(r.opId, op.opId); assert.equal(r.title, op.title);
  }
});
test("prepare refuses: 7702 admin, changed binding/authority, providers disagreeing, pending tx, moved nonce, fee cap, short balance", async () => {
  const cases = [[(s) => { s.adminCode = "0xef0100" + "11".repeat(20); }, /EIP-7702/], [(s) => { s.executor = "0x" + "22".repeat(20); }, /not bound to the verified executor/],
    [(s) => { s.paused = true; }, /paused/], [(s) => { s.owner = "0x" + "33".repeat(20); }, /owner/], [(s) => { s.pending = 8; }, /pending/],
    [(s) => { s.baseFee = 600_000_000n; }, /fee exceeds/], [(s) => { s.balance = 1_000n; }, /balance does not cover/],
    [(s) => { s.codes[TRUST.reserve] = "0x6009"; }, /runtime changed/]];
  for (const [mut, re] of cases) { const m = createModel(abi); mut(m.state); await assert.rejects(prep(m, opOf("deposit")), re); }
  const v = createModel(abi); v.state.vaultOwner = "0x" + "44".repeat(20); await assert.rejects(prep(v, opOf("configure", true)), /simulated call|vault's owner/);
  const d = createModel(abi); const cs = d.clients([null, (mth, _a, r) => (mth === "getBalance" ? r + 1n : r)]);
  await assert.rejects(prepareOperation({ trust: TRUST, abi, op: opOf("deposit"), planSha256: plan.planSha256, clients: cs }), /providers disagree/);
  const n = createModel(abi); await assert.rejects(prep(n, opOf("deposit"), { reservedNonce: 6 }), /nonce 6 was handed to the wallet/);
});
test("duplicate guard: an operation already done is never prepared again (restart without journal trust)", async () => {
  const m = createModel(abi);
  for (const op of [opOf("deposit"), opOf("configure"), opOf("setClaimant", true), ops[23]]) {
    const r = await prep(m, op); m.land(r);
    await assert.rejects(prep(m, op), /already/);
  }
  await assert.rejects(startCheck({ trust: TRUST, abi, ops, clients: m.clients() }), /already/);
});
test("verify: exact landing confirms; revert is reported; wrong tx, wrong events, shallow receipt and disagreement are refused", async () => {
  const m = createModel(abi), op = opOf("configure", true), r = await prep(m, op);
  const ok = m.land(r); await assert.rejects(verifyOperation({ trust: TRUST, abi, op, attempts: [r], hash: ok, clients: m.clients() }), /two later blocks/);
  m.state.head += 2n;
  const v = await verifyOperation({ trust: TRUST, abi, op, attempts: [r], hash: ok, clients: m.clients() }); assert.equal(v.outcome, "confirmed"); assert.equal(v.nonce, 7);
  await assert.rejects(verifyOperation({ trust: TRUST, abi, op: opOf("deposit"), attempts: [r], hash: ok, clients: m.clients() }), /another operation/);
  await assert.rejects(verifyOperation({ trust: TRUST, abi, op, attempts: [r], hash: ok, clients: m.clients([null, (mth, _a, x) => (mth === "getTransactionReceipt" ? { ...x, gasUsed: x.gasUsed + 1n } : x)]) }), /disagree/);
  const t2 = createModel(abi), dep = opOf("deposit"), rq = await prep(t2, dep), base = { transaction: (await t2.clients()[0].getTransaction({ hash: t2.land(rq) })), receipt: null };
  const rc = (await t2.clients()[0].getTransactionReceipt({ hash: base.transaction.hash }));
  assert.equal(checkLanding(TRUST, abi, dep, rq, { transaction: base.transaction, receipt: rc }), "success");
  const bad = [[{ input: dep.data.slice(0, -2) + "00" }, /calldata/], [{ to: TRUST.dnsVault }, /recipient/], [{ value: 1n }, /value/], [{ nonce: 8 }, /nonce/],
    [{ maxFeePerGas: BigInt(rq.transaction.maxFeePerGas) + 1n }, /fee cap/], [{ authorizationList: [{}] }, /authorization list/], [{ type: "legacy" }, /EIP-1559/]];
  for (const [over, re] of bad) assert.throws(() => checkLanding(TRUST, abi, dep, rq, { transaction: { ...base.transaction, ...over }, receipt: rc }), re);
  assert.throws(() => checkLanding(TRUST, abi, dep, rq, { transaction: base.transaction, receipt: { ...rc, logs: [...rc.logs, rc.logs[0]] } }), /exactly one event/);
  assert.throws(() => checkLanding(TRUST, abi, dep, rq, { transaction: base.transaction, receipt: { ...rc, logs: [{ ...rc.logs[0], address: TRUST.executor }] } }), /not from the reserve/);
  const other = ops.find((o) => o.kind === "deposit" && o.app !== dep.app);
  const t3 = createModel(abi), r3 = await prepareOperation({ trust: TRUST, abi, op: other, planSha256: plan.planSha256, clients: t3.clients() }), h3 = t3.land(r3);
  const wrongEvent = (await t3.clients()[0].getTransactionReceipt({ hash: h3 })).logs;
  assert.throws(() => checkLanding(TRUST, abi, dep, rq, { transaction: base.transaction, receipt: { ...rc, logs: wrongEvent } }), /another deployment/);
  const t4 = createModel(abi), r4 = await prep(t4, dep), h4 = t4.land(r4, { revert: true }); t4.state.head += 2n;
  assert.equal((await verifyOperation({ trust: TRUST, abi, op: dep, attempts: [r4], hash: h4, clients: t4.clients() })).outcome, "reverted");
  const t5 = createModel(abi), relay = ops[24], r5 = await prep(t5, relay), h5 = t5.land(r5); t5.state.head += 2n;
  assert.equal((await verifyOperation({ trust: TRUST, abi, op: relay, attempts: [r5], hash: h5, clients: t5.clients() })).outcome, "confirmed");
});
test("a stale wallet prompt landing after a release verifies against the earlier attempt; release needs the nonce unused", async () => {
  const m = createModel(abi), op = opOf("deposit"), first = await prep(m, op);
  assert.deepEqual(await releaseCheck({ trust: TRUST, clients: m.clients(), nonce: 7 }).then((x) => x.nonce), 7);
  m.state.tip = 900_000n; const second = await prep(m, op, { reservedNonce: 7 }); assert.notEqual(second.transaction.maxFeePerGas, first.transaction.maxFeePerGas);
  const h = m.land(first); m.state.head += 2n;
  await assert.rejects(releaseCheck({ trust: TRUST, clients: m.clients(), nonce: 7 }), /nonce 7 was used/);
  assert.equal((await verifyOperation({ trust: TRUST, abi, op, attempts: [first, second], hash: h, clients: m.clients() })).outcome, "confirmed");
  await assert.rejects(prep(m, op, { reservedNonce: 7 }), /already|nonce 7/);
});

// ---- activation gate -------------------------------------------------------------------------------------------------
test("serve.mjs refuses to start while root's gate is locked, and without the exact usage", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = (...a) => spawnSync(process.execPath, [new URL("../serve.mjs", import.meta.url).pathname, ...a], { encoding: "utf8", timeout: 20000 });
  assert.match(run("--approved-proposal", "sha256:" + PIN, "--serve").stderr, /approval gate is locked/);
  assert.match(run("--serve").stderr, /usage/); assert.match(run("--approved-proposal", PIN, "--serve").stderr, /usage/);
});
