// OFFLINE tests (relay-owner-r2): scripted synthetic transport only. No signature is verified anywhere here; "forged"
// means the fake vault was SCRIPTED to revert BadSignature. These prove relay control flow, not contract behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, keccak256 } from "viem";
import { createFundingRoute, encodeIntent, GRANT_COMPONENTS, OWNER_OPS, REVOKE_INFLIGHT_SEC, strictEvent } from "../funding-route.mjs";
import { fundingSessionVaultAbi } from "../generated/funding-abi.mjs";
import { BAD_R, BAD_SIG, GOOD_SIG, GRANT_NONCE, SESSION_KEY, T, eventLog, gasLogs, hostRate, hostSend, makeWorld, manifestOf, memStore, mined }
  from "./fake-chain.mjs";

const ZERO = `0x${"00".repeat(32)}`;
const OP_NONCE = `0x${"0a".repeat(32)}`;
const FRESH_SID = `0x${"77".repeat(32)}`;
const policy = { fee: () => 1000n, accept: () => true };

function setup(opts = {}) {
  const w = makeWorld();
  const store = memStore();
  const clock = { t: T };
  const trace = [];
  const box = { next: () => { throw new Error("no receipt scripted"); } };
  const send = hostSend(w, (x) => box.next(x), trace);
  const rate = hostRate(opts.limit ?? 60);
  const fr = createFundingRoute({ manifest: manifestOf(w), quotePolicy: policy, ownerManagement: true, rateOwner: rate, pc: w.pc,
    relayer: w.relayer, store, now: () => clock.t, simulateAndSend: send, ...(opts.route ?? {}) });
  const call = (method, path, body, ctx) => fr.route(method, path, body, ctx);
  return { w, store, clock, trace, box, send, rate, fr, call };
}
const ended = (w, sid = w.sid) => eventLog(fundingSessionVaultAbi, w.vault, "SessionEnded", { sid, reason: 2, refund6: 5n, fee6: 0n });
const ownerBody = (w, op, args, sig = GOOD_SIG) => ({ owner: w.owner, vault: w.vault, op, args, ...(sig === undefined ? {} : { sig }) });
const terminateArgs = (w) => ({ sessionId: w.sid, opNonce: OP_NONCE, signBefore: T + 600 });
const revokeArgs = { withdraw: false, opNonce: OP_NONCE, signBefore: T + 600 };
const endBody = (w, r = `0x${"01".repeat(32)}`) => ({ vault: w.vault, sid: w.sid, deadline: T + 60, x: 1, y: 2, r, s: `0x${"02".repeat(32)}` });
const quoteBody = (w, sid = w.sid) => ({ vault: w.vault, sid, deployment: w.deployment, ethOut: 10n ** 15n, feeTier: 500 });
const ethCalls = (w) => w.calls.filter((c) => c.method === "eth_call");

// ---- enablement ------------------------------------------------------------------------------------------------------

test("owner/end/open are refused unless the host passes ownerManagement AND rateOwner; no body flag enables them", async () => {
  for (const route of [{ ownerManagement: false }, { rateOwner: null }]) {
    const { w, call, fr } = setup({ route });
    assert.equal(fr.ownerEnabled, false);
    await assert.rejects(call("POST", "/funding/owner", { ...ownerBody(w, "terminate", terminateArgs(w)), ownerManagement: true }), { status: 503 });
    await assert.rejects(call("POST", "/funding/end", endBody(w)), { status: 503 });
    await assert.rejects(call("POST", "/funding/open", {}), { status: 503 });
    assert.equal(ethCalls(w).length, 0);
  }
  const { w, call } = setup({ route: { quotePolicy: null } });
  await assert.rejects(call("POST", "/funding/owner", ownerBody(w, "terminate", terminateArgs(w))), { status: 503, code: "funding_disabled" });
});

test("every original owner op is served; ownerCall is direct-owner only", async () => {
  assert.deepEqual([...OWNER_OPS].sort(), ["adopt", "close", "extend", "promote", "release", "revokeAll", "setEnvironment", "terminate",
    "topUp", "topUpWithAuthorization", "withdraw"]);
  const { w, call } = setup();
  await assert.rejects(call("POST", "/funding/owner", ownerBody(w, "ownerCall", {})), { status: 400, code: "owner_direct_only" });
  await assert.rejects(call("POST", "/funding/owner", ownerBody(w, "migrate", {})), { status: 400 });
  await assert.rejects(call("POST", "/funding/owner", { ...ownerBody(w, "terminate", terminateArgs(w)), selector: "x" }), { status: 400 });
});

// ---- forged signatures: refused by the (scripted) contract BEFORE any off-chain mark ---------------------------------

test("forged terminate is refused before off-chain revocation, sends nothing and burns no quota", async () => {
  const { w, store, call, send, rate } = setup();
  await assert.rejects(call("POST", "/funding/owner", ownerBody(w, "terminate", terminateArgs(w), BAD_SIG)), { status: 409, code: "revert" });
  assert.equal(store.data.revoked[w.sid], undefined);
  assert.equal(send.sends.length, 0);
  assert.equal(rate.calls.some((c) => c.commit), false);
});

test("forged revokeAll and forged /funding/end never mark anything", async () => {
  const { w, store, call, send } = setup();
  await assert.rejects(call("POST", "/funding/owner", ownerBody(w, "revokeAll", revokeArgs, BAD_SIG)), { status: 409 });
  await assert.rejects(call("POST", "/funding/end", endBody(w, BAD_R)), { status: 409 });
  assert.deepEqual(store.data.revokedVaults, {});
  assert.deepEqual(store.data.revoked, {});
  assert.equal(send.sends.length, 0);
});

test("a body owner that is not the vault's owner is refused", async () => {
  const { w, call, send } = setup();
  const body = { ...ownerBody(w, "topUp", { sessionId: w.sid, amount: 1, opNonce: OP_NONCE, signBefore: T + 60 }), owner: w.relayer };
  await assert.rejects(call("POST", "/funding/owner", body), { status: 403, code: "not_owner" });
  assert.equal(send.sends.length, 0);
});

// ---- accepted terminate: mark before broadcast, canonical completion -------------------------------------------------

test("terminate marks the shared revocation in afterSimulate (before broadcast) and completes only on a canonical receipt", async () => {
  const { w, store, call, box, trace, send, rate } = setup();
  box.next = () => { assert.ok(store.data.revoked[w.sid], "revoked before broadcast"); return mined(w, [ended(w)]); };
  const out = await call("POST", "/funding/owner", ownerBody(w, "terminate", terminateArgs(w)));
  assert.equal(out.op, "terminate");
  assert.deepEqual(trace, ["simulated:terminate", "broadcast:terminate"]);
  assert.equal(send.sends.length, 1);
  assert.equal(rate.count(w.owner), 0, "terminate is quota-exempt");
  assert.deepEqual(store.data.fundingPending, {});
});

test("a failed send after acceptance keeps the revocation (never weakened)", async () => {
  const { w, store, call, box } = setup();
  box.next = () => new Error("queue failed");
  await assert.rejects(call("POST", "/funding/owner", ownerBody(w, "terminate", terminateArgs(w))));
  assert.ok(store.data.revoked[w.sid]);
  await assert.rejects(call("POST", "/funding/quote", quoteBody(w)), { status: 409, code: "not_live" });
});

// ---- canonical-receipt rules -----------------------------------------------------------------------------------------

for (const [name, opt] of [
  ["zero block hash (preconfirmation)", { blockHash: ZERO, canonical: false }],
  ["null block hash", { blockHash: null, canonical: false }],
  ["receipt unknown to the node", { canonical: false }],
  ["reorged: the node's receipt is in another block", { nodeBlockHash: `0x${"de".repeat(32)}` }],
]) {
  test(`${name}: 202 pending, no index, no second send, revocation kept`, async () => {
    const { w, store, call, box, send } = setup();
    box.next = () => mined(w, [ended(w)], opt);
    await assert.rejects(call("POST", "/funding/owner", ownerBody(w, "terminate", terminateArgs(w))), (e) => {
      assert.equal(e.status, 202); assert.equal(e.code, "pending_reconciliation"); return true;
    });
    assert.equal(send.sends.length, 1);
    assert.equal(Object.keys(store.data.fundingPending).length, 1);
    assert.ok(store.data.revoked[w.sid]);
    assert.deepEqual(store.data.fundingSessions, {});
  });
}

test("a block-number/hash mismatch at getBlock is not canonical; reconciliation later completes read-only", async () => {
  const { w, store, call, box, send } = setup();
  let rc;
  box.next = () => (rc = mined(w, [ended(w)]));
  w.blocks[(w.block + 1n).toString()] = undefined;
  const pend = () => { box.next = () => (rc = mined(w, [ended(w)])); };
  pend();
  // the node serves the receipt, but the block at that number has another hash
  const origNext = box.next;
  box.next = (x) => { const r = origNext(x); w.blocks[(w.block + 1n).toString()] = `0x${"99".repeat(32)}`; return r; };
  await assert.rejects(call("POST", "/funding/owner", ownerBody(w, "terminate", terminateArgs(w))), { status: 202 });
  assert.equal(store.data.fundingPending[rc.transactionHash].reason, "block_not_canonical");
  w.blocks[(w.block + 1n).toString()] = rc.blockHash;
  const out = await call("GET", `/funding/tx/${rc.transactionHash}`);
  assert.equal(out.txHash, rc.transactionHash);
  assert.deepEqual(store.data.fundingPending, {});
  assert.equal(send.sends.length, 1, "reconciliation never resubmits");
});

// ---- revokeAll: quota-exempt, pending semantics, fresh sessions not permanently blocked -------------------------------

test("revokeAll in flight refuses every session of the vault (quote AND execute before any chain read); completion admits only later epochs", async () => {
  const { w, store, call, box, rate, clock } = setup();
  box.next = () => mined(w, [eventLog(fundingSessionVaultAbi, w.vault, "RevokedAll", { epoch: 1n, withdrawn6: 0n })], { blockHash: ZERO, canonical: false });
  await assert.rejects(call("POST", "/funding/owner", ownerBody(w, "revokeAll", revokeArgs)), { status: 202 });
  assert.equal(rate.count(w.owner), 0, "revokeAll is quota-exempt");
  const r = store.data.revokedVaults[w.vault];
  assert.equal(r.block, null);
  assert.equal(r.successorEpoch, "0");
  // in flight: refused for ANY sid of this vault, before any eth_call
  w.calls.length = 0;
  await assert.rejects(call("POST", "/funding/quote", quoteBody(w, FRESH_SID)), { status: 409, code: "not_live" });
  const intent = { payer: w.vault, deployment: w.deployment, expectedOwner: w.vault, ethOut: 10n ** 15n, maxUsdcIn6: 4_000_000n, fee: 500, deadline: BigInt(T + 60) };
  await assert.rejects(call("POST", "/funding/execute", { vault: w.vault, sid: FRESH_SID, nonce: 0, action: 10, args: encodeIntent(intent),
    fee: 1000, deadline: T + 30, x: 1, y: 2, r: `0x${"01".repeat(32)}`, s: `0x${"02".repeat(32)}` }), { status: 409, code: "not_live" });
  assert.equal(w.calls.length, 0);
  // still not canonical after the in-flight window: same-epoch sessions stay refused (fail closed)
  clock.t = T + REVOKE_INFLIGHT_SEC + 1; w.timestamp = BigInt(clock.t - 2);
  await assert.rejects(call("POST", "/funding/quote", quoteBody(w, FRESH_SID)), { status: 409, code: "not_live" });
  // now the revokeAll is canonical: reconcile, the vault epoch is 1
  const txHash = Object.keys(store.data.fundingPending)[0];
  const rc = mined(w, [eventLog(fundingSessionVaultAbi, w.vault, "RevokedAll", { epoch: 1n, withdrawn6: 0n })]);
  w.receipts[txHash] = { ...w.receipts[rc.transactionHash], transactionHash: txHash,
    logs: w.receipts[rc.transactionHash].logs.map((l) => ({ ...l, transactionHash: txHash })) };
  await call("GET", `/funding/tx/${txHash}`);
  assert.equal(store.data.revokedVaults[w.vault].block, Number(w.block + 1n));
  w.epoch = 1n;
  // an old-epoch session stays refused; a fresh session opened after the revoke (epoch 1) is served
  await assert.rejects(call("POST", "/funding/quote", quoteBody(w, w.sid)), { status: 409, code: "not_live" });
  w.session = { ...w.session, epoch: 1n };
  const q = await call("POST", "/funding/quote", quoteBody(w, FRESH_SID));
  assert.equal(q.sid, FRESH_SID);
});

// ---- quota ----------------------------------------------------------------------------------------------------------

test("topUp is counted only after acceptance; an exhausted quota refuses before any chain read", async () => {
  const { w, call, box, rate } = setup({ limit: 1 });
  const args = { sessionId: w.sid, amount: 5, opNonce: OP_NONCE, signBefore: T + 60 };
  await assert.rejects(call("POST", "/funding/owner", ownerBody(w, "topUp", args, BAD_SIG)), { status: 409 });
  assert.equal(rate.count(w.owner), 0);
  box.next = () => mined(w, [eventLog(fundingSessionVaultAbi, w.vault, "ToppedUp", { sid: w.sid, amount6: 5n, fromWallet: true })]);
  await call("POST", "/funding/owner", ownerBody(w, "topUp", args));
  assert.equal(rate.count(w.owner), 1);
  w.calls.length = 0;
  await assert.rejects(call("POST", "/funding/owner", ownerBody(w, "topUp", args)), { status: 429 });
  assert.equal(w.calls.length, 0);
  // terminate is still served with the quota exhausted
  box.next = () => mined(w, [ended(w)]);
  await call("POST", "/funding/owner", ownerBody(w, "terminate", terminateArgs(w)));
});

test("an accepted op whose canonical receipt lacks its event is not reported as done", async () => {
  const { w, store, call, box } = setup();
  box.next = () => mined(w, []);
  await assert.rejects(call("POST", "/funding/owner", ownerBody(w, "extend", { sessionId: w.sid, expiresAt: T + 999, opNonce: OP_NONCE, signBefore: T + 60 })),
    { status: 502, code: "settlement_event" });
  assert.deepEqual(store.data.fundingPending, {});
});

// ---- /funding/end ---------------------------------------------------------------------------------------------------

test("/funding/end marks before broadcast and completes on a canonical SessionEnded", async () => {
  const { w, store, call, box, rate } = setup();
  box.next = () => { assert.ok(store.data.revoked[w.sid]); return mined(w, [ended(w)]); };
  const out = await call("POST", "/funding/end", endBody(w));
  assert.equal(out.refund6, 5n);
  assert.equal(rate.calls.length, 0, "the session's own sign-out is not an owner quota op");
});

// ---- quote guards (client-r1 preflight parity) ----------------------------------------------------------------------

test("quote refuses opsPerPeriod exhaustion and uint32 periodOps overflow, after period reset rules; and seq == uint64 max", async () => {
  const { w, call } = setup();
  w.session = { ...w.session, opsPerPeriod: 3, periodOps: 3 };
  await assert.rejects(call("POST", "/funding/quote", quoteBody(w)), { status: 409, code: "op_limit" });
  w.session = { ...w.session, periodStart: BigInt(T - 90_000) };            // the period has reset at block time
  await call("POST", "/funding/quote", quoteBody(w));
  w.session = { ...w.session, periodStart: BigInt(T - 100), opsPerPeriod: 0, periodOps: 2 ** 32 - 1 };   // "unlimited" still overflows
  await assert.rejects(call("POST", "/funding/quote", quoteBody(w)), { status: 409, code: "op_counter_exhausted" });
  w.session = { ...w.session, periodOps: 0 };
  w.seq = (1n << 64n) - 1n;
  await assert.rejects(call("POST", "/funding/quote", quoteBody(w)), { status: 409, code: "nonce_lane_exhausted" });
});

// ---- execute: canonical settlement and exact result encoding --------------------------------------------------------

async function quoted(s) {
  const q = await s.call("POST", "/funding/quote", quoteBody(s.w));
  const body = { vault: s.w.vault, sid: s.w.sid, nonce: q.nonce, action: 10, args: q.args, fee: q.fee, deadline: q.deadline,
    x: 1, y: 2, r: `0x${"01".repeat(32)}`, s: `0x${"02".repeat(32)}` };
  return { q, body };
}

test("execute: zero-hash preconfirmation is pending (no index, one send); a 96-byte result is refused", async () => {
  const s = setup();
  const { q, body } = await quoted(s);
  const logs = (extra) => gasLogs(s.w, { intent: q.intent, nonce: q.nonce, args: q.args, fee: q.fee, used: 3_000_000n, ...extra });
  s.box.next = () => mined(s.w, logs(), { blockHash: ZERO, canonical: false });
  await assert.rejects(s.call("POST", "/funding/execute", body), { status: 202 });
  assert.equal(s.send.sends.length, 1);
  assert.deepEqual(s.store.data.fundingOps, {});
  const used = 3_000_000n, back = q.intent.maxUsdcIn6 - used;
  s.box.next = () => mined(s.w, logs({ result: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [used, back, 0n]) }));
  await assert.rejects(s.call("POST", "/funding/execute", body), { status: 502, code: "settlement_result" });
  assert.deepEqual(s.store.data.fundingOps, {});
  s.box.next = () => mined(s.w, logs());
  const ok = await s.call("POST", "/funding/execute", body);
  assert.equal(ok.settlement.actual.usdcSpent6, used);
  assert.equal(s.store.data.fundingOps[s.w.sid].length, 1);
});

test("strictEvent refuses trailing data bytes and dirty words", () => {
  const w = makeWorld();
  const l = ended(w);
  assert.equal(strictEvent(fundingSessionVaultAbi, l).eventName, "SessionEnded");
  assert.throws(() => strictEvent(fundingSessionVaultAbi, { ...l, data: l.data + "00".repeat(32) }));
  const dirty = `${l.data.slice(0, 2)}ff${l.data.slice(4)}`;               // reason (uint8) word with high bits set
  assert.throws(() => strictEvent(fundingSessionVaultAbi, { ...l, data: dirty }));
});

// ---- open -----------------------------------------------------------------------------------------------------------

function grant(over = {}) {
  const g = {};
  for (const { name, type } of GRANT_COMPONENTS) {
    g[name] = type === "string" ? "" : type === "string[]" ? [] : type === "bytes32" ? `0x${"00".repeat(32)}` : 1;
  }
  return { ...g, sessionKey: SESSION_KEY, grantNonce: GRANT_NONCE, budget: 0, actions: ["gas.fund"], ...over };
}

test("open refuses api.* scopes, counts quota after acceptance, and indexes openedBlock only from a canonical receipt", async () => {
  const s = setup();
  await assert.rejects(s.call("POST", "/funding/open", { owner: s.w.owner, grant: grant({ actions: ["api.status"] }), ownerSig: GOOD_SIG }),
    { status: 400, code: "api_scopes_unsupported" });
  await assert.rejects(s.call("POST", "/funding/open", { owner: s.w.owner, grant: grant(), ownerSig: BAD_SIG }), { status: 409 });
  assert.equal(s.rate.count(s.w.owner), 0);
  const opened = eventLog(fundingSessionVaultAbi, s.w.vault, "SessionOpened", { sid: s.w.sid, keyHash: keccak256(SESSION_KEY),
    expiresAt: BigInt(T + 3600), actions: 1n << 10n, envs: 3, budget6: 0n, label: "" });
  s.box.next = () => mined(s.w, [opened]);
  const out = await s.call("POST", "/funding/open", { owner: s.w.owner, grant: grant(), ownerSig: GOOD_SIG });
  assert.equal(out.sid, s.w.sid);
  assert.equal(s.rate.count(s.w.owner), 1);
  assert.equal(s.store.data.fundingSessions[s.w.sid].openedBlock, Number(s.w.block + 1n));
  const view = await s.call("GET", `/funding/owner/${s.w.owner}`);
  assert.equal(view.sessions.length, 1);
});

// Root regressions: independent observation, not a test-only change to grant/receipt semantics.
test("root: unsigned close cannot consume the owner's authenticated-operation quota", async () => {
  const s = setup();
  s.box.next = () => mined(s.w, [ended(s.w)]);
  const body = ownerBody(s.w, "close", {sessionId: s.w.sid});
  delete body.sig;
  await s.call("POST", "/funding/owner", body);
  assert.equal(s.rate.count(s.w.owner), 0);
});
test("root: reconciliation cannot adopt a different transaction returned for the requested hash", async () => {
  const s = setup();
  let pending;
  s.box.next = () => (pending = mined(s.w, [], {blockHash: ZERO, canonical: false}));
  await assert.rejects(s.call("POST", "/funding/owner", ownerBody(s.w, "withdraw", {amount: 5, opNonce: OP_NONCE, signBefore: T+60})), {status: 202});
  const unrelated = mined(s.w, []);
  s.w.receipts[pending.transactionHash] = s.w.receipts[unrelated.transactionHash];
  await assert.rejects(s.call("GET", `/funding/tx/${pending.transactionHash}`), {status: 202, code: "pending_reconciliation"});
  assert.ok(s.store.data.fundingPending[pending.transactionHash]);
  assert.equal(s.send.sends.length, 1);
});

for (const [name, mutate] of [
  ["unknown receipt status", (r) => { r.status = "0x2"; }],
  ["missing log inclusion metadata", (r) => { delete r.logs[0].blockHash; delete r.logs[0].transactionHash; }],
  ["removed log", (r) => { r.logs[0].removed = true; }],
]) {
  test(`root: ${name} stays pending without indexing`, async () => {
    const s = setup(); let receipt;
    s.box.next = () => {
      receipt = mined(s.w, [ended(s.w)]);
      mutate(s.w.receipts[receipt.transactionHash]);
      return receipt;
    };
    await assert.rejects(s.call("POST", "/funding/owner", ownerBody(s.w, "terminate", terminateArgs(s.w))),
      {status: 202, code: "pending_reconciliation"});
    assert.ok(s.store.data.fundingPending[receipt.transactionHash]);
    assert.equal(s.send.sends.length, 1);
    assert.equal(s.store.data.fundingSessions[s.w.sid], undefined);
  });
}
