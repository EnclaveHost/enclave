// successor-host-r1: the ACTUAL composed host (createSessionsService -> funding route -> simulateAndSend -> the ONE
// TxQueue with the fee envelope, all from generated/relay/, written by prepare.py) over SCRIPTED RPC answers. No EVM, no
// key, no signature is verified anywhere here: the vault is relay-owner-r2's scripted fake chain (BAD_R / BAD_SIG are
// scripted reverts) and TEST_POLICY below is a clearly fake quote policy (fixed fee), NOT the reviewed fee policy. The
// envelope itself is built by the actual fee-policy makeEnvelope and enforced by the actual queue. Only the queue's TIMING
// is shortened on the live service object; no check is replaced. Run `python3 prepare.py` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSessionsService } from "../generated/relay/sessions.mjs";
import { createFundingRoute, encodeIntent } from "../generated/relay/funding-route.mjs";
import { ENVELOPE_GUARD, QUOTE_POLICY_INTERFACE, makeEnvelope } from "../generated/relay/fee-policy.mjs";
import { fundingSessionVaultAbi } from "../generated/relay/funding-abi.mjs";
import { BAD_R, BAD_SIG, GOOD_SIG, HEAD_HASH, T, eventLog, gasLogs, makeWorld, manifestOf } from "../../relay-owner-candidate/test/fake-chain.mjs";

const h32 = (t) => "0x" + createHash("sha256").update(String(t)).digest("hex");
const ZERO32 = "0x" + "0".repeat(64);
const FEE = 1000n;
const TX_BLOCK = 1001n;

/** TEST ONLY: a fixed-fee v2 policy. The envelope is the actual fee-policy makeEnvelope over the route's exact calldata. */
const TEST_POLICY = Object.freeze({
  interface: QUOTE_POLICY_INTERFACE,
  async quote() { return { fee6: FEE, detail: { note: "TEST policy: fixed fee, not the reviewed fee policy" } }; },
  async fee() { return FEE; },
  async accept(ctx) { return ctx.fee6 === FEE; },
  async envelope(ctx) {
    return makeEnvelope({ chainId: 8453n, from: ctx.from.toLowerCase(), to: ctx.to.toLowerCase(), data: ctx.data, gasLimit: 200_000n,
      maxFeePerGasCap: 20_000_000n, maxPriorityFeePerGasCap: 2_000_000n, maxSignedBytes: 1000, maxAttempts: 3, replacementBumpBps: 2500n,
      notAfter: BigInt(ctx.deadline), fee6: ctx.fee6, costCeilingWei: 200_000n * 20_000_000n, estimateGas: 100_000n,
      configHash: "0x" + "c0".repeat(32), block: BigInt(ctx.block), blockHash: HEAD_HASH });
  },
});

/** The scripted chain: relay-owner-r2's fake contracts for reads/simulation, scripted queue answers for sends/receipts. */
function chainOf() {
  const w = makeWorld();
  const s = { sends: [], sent: [], receipts: new Map(), blocks: new Map(), pendingNonce: 7, script: [], afterSend: null, onSend: null, n: 0 };
  const pc = {
    readContract: (a) => w.pc.readContract(a),
    simulateContract: (a) => w.pc.simulateContract({ ...a, account: a.account?.address ?? a.account }),
    getCode: (a) => w.pc.getCode(a),
    getChainId: () => w.pc.getChainId(),
    getBalance: async () => 10n ** 18n,
    async getBlock(args = {}) {
      if (args.blockNumber != null) { const b = s.blocks.get(String(args.blockNumber)); if (b) return b; }
      return w.pc.getBlock(args);
    },
    async getTransactionReceipt({ hash }) {
      const r = s.receipts.get(String(hash).toLowerCase());
      if (!r) throw new Error(`TransactionReceiptNotFoundError: ${hash}`);
      return r;
    },
    async estimateGas() { return 100_000n; },
    async estimateMaxPriorityFeePerGas() { return 1_000_000n; },
    async getTransactionCount({ blockTag }) { assert.equal(blockTag, "pending"); return s.pendingNonce; },
  };
  const wc = {
    chain: { id: 8453 },
    async sendTransaction(req) {
      s.sends.push(req);
      s.onSend?.(req);
      const step = s.script.shift();
      if (step?.hang) return new Promise(() => {});            // a process that dies here never learns the hash
      if (step?.error) throw Object.assign(new Error(step.error), { shortMessage: step.error });
      const h = h32(`tx:${++s.n}`);
      s.sent.push(h);
      s.pendingNonce = Math.max(s.pendingNonce, Number(req.nonce) + 1);   // the node's pending pool now holds it
      s.afterSend?.(h, req);
      return h;
    },
  };
  return { w, s, pc, wc };
}

function service(c, { store = { data: {}, saveSoon() {}, flush() {} }, journal = { data: { txs: [] }, saveSoon() {}, flush() {} }, ownerOpsPerDay } = {}) {
  const t = { now: T * 1000 };
  const svc = createSessionsService({ pc: c.pc, wc: c.wc, account: { address: c.w.relayer }, chainId: 8453,
    factory: "0x4444444444444444444444444444444444444444", store, journal, log: () => {}, alert: () => {}, now: () => T,
    funding: manifestOf(c.w), fundingQuotePolicy: TEST_POLICY, ownerOpsPerDay });
  Object.assign(svc.queue, { receiptTimeoutMs: 10, pollMs: 5, maxAttempts: 3, clock: () => t.now, sleep: async (ms) => { t.now += ms; } });
  return { ...c, svc, store, journal };
}

const intentOf = (w) => ({ payer: w.vault, deployment: w.deployment, expectedOwner: w.vault, ethOut: 10n ** 15n, maxUsdcIn6: 3_100_000n,
  fee: 500, deadline: BigInt(T + 100) });
const execBody = (w, over = {}) => ({ vault: w.vault, sid: w.sid, nonce: "0", action: 10, args: encodeIntent(intentOf(w)), fee: FEE.toString(),
  deadline: String(T + 60), x: "11", y: "12", r: "0x" + "0e".repeat(32), s: "0x" + "0f".repeat(32), ...over });
const okLogs = (w) => gasLogs(w, { intent: intentOf(w), nonce: 0n, args: encodeIntent(intentOf(w)), fee: FEE, used: 3_000_000n });
function endedLog(x) {
  const ev = fundingSessionVaultAbi.find((i) => i.type === "event" && i.name === "SessionEnded");
  const args = Object.fromEntries(ev.inputs.map((i) => [i.name, i.name === "sid" ? x.w.sid : i.name === "reason" ? 1
    : i.type === "bool" ? false : i.type === "address" ? x.w.owner : i.type === "bytes32" ? ZERO32 : 0n]));
  return eventLog(fundingSessionVaultAbi, x.w.vault, "SessionEnded", args);
}

function receiptOf(x, hash, { status = "success", logs = [], blockHash = h32(`block:${hash}`) } = {}) {
  return { transactionHash: hash, blockHash, blockNumber: TX_BLOCK, status, from: x.w.relayer, to: x.w.vault, gasUsed: 21_000n,
    logs: logs.map((l, i) => ({ ...l, blockHash, blockNumber: TX_BLOCK, transactionHash: hash, logIndex: i, transactionIndex: 0, removed: false })) };
}
/** canonical as far as any node asked can tell: the receipt AND its header listing the transaction */
function canonical(x, hash, { status = "success", logs } = {}) {
  const r = receiptOf(x, hash, { status, logs: logs ?? (status === "success" ? okLogs(x.w) : []) });
  x.s.receipts.set(hash, r);
  x.s.blocks.set(String(TX_BLOCK), { number: TX_BLOCK, hash: r.blockHash, transactions: [hash] });
  return r;
}
/** a Base preconfirmation: a receipt with a zero block hash */
const preconfirmed = (x, hash) => x.s.receipts.set(hash, { ...receiptOf(x, hash), blockHash: ZERO32 });
const err = (p) => p.then((v) => assert.fail(`expected an error, got ${JSON.stringify(v, (_k, y) => (typeof y === "bigint" ? `${y}n` : y))}`), (e) => e);
const exec = (x, over) => x.svc.route("POST", "/funding/execute", execBody(x.w, over));

test("canonical success: reserved and journaled BEFORE the one broadcast, indexed once; an alternate signature is answered, never sent", async () => {
  const x = service(chainOf());
  x.s.onSend = () => {
    const rec = x.journal.data.txs.at(-1);
    assert.equal(typeof rec.intent, "string", "the record names its intent before the broadcast");
    assert.equal(x.journal.data.intents[rec.intent].status, "reserved");
    assert.equal(rec.envelope.digest.length, 66, "and the fee envelope is journaled with it");
  };
  x.s.afterSend = (h) => canonical(x, h);
  const out = await exec(x);
  assert.equal(out.txHash, x.s.sent[0]);
  assert.equal(out.settlement.actual.usdcSpent6, 3_000_000n);
  assert.equal(out.settlement.refund6, 100_000n);
  assert.equal(x.s.sends.length, 1);
  assert.equal(x.s.sends[0].gas, 200_000n, "gas is the envelope's");
  const rec = x.journal.data.txs.at(-1);
  assert.equal(rec.status, "mined");
  assert.equal(x.journal.data.intents[rec.intent].status, "done");
  const again = await exec(x, { s: "0x" + "1f".repeat(32) });
  assert.equal(again.already, true);
  assert.equal(again.txHash, x.s.sent[0]);
  assert.equal(x.s.sends.length, 1);
  assert.equal(x.store.data.fundingOps[x.w.sid].length, 1);
  assert.deepEqual(x.store.data.fundingPending, {});
});

test("an invalid signature reserves nothing and sends nothing", async () => {
  const x = service(chainOf());
  const e = await err(exec(x, { r: BAD_R }));
  assert.equal(e.status, 409);
  assert.equal(e.code, "revert");
  assert.deepEqual(x.journal.data.intents, {});
  assert.equal(x.s.sends.length, 0);
});

test("delayed preconfirmation: 202 with the exact hash; a retry after the provider's pending nonce advanced sends nothing; reconciled once", async () => {
  const x = service(chainOf());
  x.s.afterSend = (h) => preconfirmed(x, h);
  const e = await err(exec(x));
  assert.equal(e.status, 202);
  assert.equal(e.code, "pending_reconciliation");
  assert.deepEqual(e.extra.txHashes, x.s.sent);
  assert.equal(x.s.sends.length, 1, "a preconfirmation suppresses replacement");
  assert.equal(x.store.data.fundingPending[x.s.sent[0]].intent, e.extra.intent);
  assert.equal(x.store.data.fundingOps[x.w.sid], undefined, "nothing indexed while pending");
  assert.equal(x.s.pendingNonce, 8);
  const e2 = await err(exec(x));
  assert.equal(e2.code, "pending_reconciliation");
  assert.deepEqual(e2.extra.txHashes, x.s.sent);
  assert.equal(x.s.sends.length, 1, "no new EOA nonce for the same intent");
  canonical(x, x.s.sent[0]);
  const out = await x.svc.route("GET", `/funding/tx/${x.s.sent[0]}`);
  assert.equal(out.txHash, x.s.sent[0]);
  assert.deepEqual(x.store.data.fundingPending, {});
  const out2 = await exec(x);
  assert.equal(out2.already, true);
  assert.equal(x.s.sends.length, 1);
  assert.equal(x.store.data.fundingOps[x.w.sid].length, 1);
});

test("replacement hash finalization: every hash is recorded; the replacement that lands finalizes it, asked by the first hash", async () => {
  const x = service(chainOf());
  const e = await err(exec(x));
  assert.equal(e.code, "pending_reconciliation");
  assert.equal(x.s.sent.length, 3);
  assert.deepEqual(e.extra.txHashes, x.s.sent);
  for (const r of x.s.sends) { assert.equal(r.nonce, 7); assert.equal(r.data, x.s.sends[0].data); assert.equal(r.gas, 200_000n); }
  for (const h of x.s.sent) assert.equal(x.store.data.fundingPending[h].intent, e.extra.intent);
  canonical(x, x.s.sent[1]);
  const out = await x.svc.route("GET", `/funding/tx/${x.s.sent[0]}`);
  assert.equal(out.txHash, x.s.sent[1]);
  assert.deepEqual(x.store.data.fundingPending, {});
  assert.equal(x.store.data.fundingOps[x.w.sid].length, 1);
  assert.equal(x.store.data.fundingOps[x.w.sid][0].tx, x.s.sent[1]);
  assert.equal(x.s.sends.length, 3);
});

test("simultaneous duplicates and an alternate signature share one submission", async () => {
  const x = service(chainOf());
  x.s.afterSend = (h) => canonical(x, h);
  const rs = await Promise.allSettled([exec(x), exec(x, { s: "0x" + "2f".repeat(32) }), exec(x)]);
  assert.equal(x.s.sends.length, 1);
  assert.ok(rs.some((r) => r.status === "fulfilled" && r.value.txHash === x.s.sent[0]));
  for (const r of rs) if (r.status === "rejected") assert.ok(["intent_in_flight", "pending_reconciliation"].includes(r.reason.code), r.reason.code);
  assert.equal(x.store.data.fundingOps[x.w.sid].length, 1);
});

test("restart: the durable journal answers the retry; no second broadcast; completes once canonical", async () => {
  const c = chainOf();
  const store = { data: {}, saveSoon() {}, flush() {} };
  const journal = { data: { txs: [] }, saveSoon() {}, flush() {} };
  const a = service(c, { store, journal });
  c.s.afterSend = (h) => preconfirmed(a, h);
  assert.equal((await err(exec(a))).code, "pending_reconciliation");
  const b = service(c, { store, journal });
  assert.notEqual(b.svc.queue.boot, a.svc.queue.boot);
  const e = await err(exec(b));
  assert.equal(e.code, "pending_reconciliation");
  assert.deepEqual(e.extra.txHashes, c.s.sent);
  assert.equal(c.s.sends.length, 1);
  canonical(b, c.s.sent[0]);
  const out = await exec(b);
  assert.equal(out.txHash, c.s.sent[0]);
  assert.equal(store.data.fundingOps[c.w.sid].length, 1);
  assert.equal(c.s.sends.length, 1);
});

test("no-hash ambiguity stays fenced: 503 intent_unknown, never rebroadcast, also after a restart", async () => {
  const c = chainOf();
  c.s.script.push({ error: "socket hang up" });
  const journal = { data: { txs: [] }, saveSoon() {}, flush() {} };
  const store = { data: {}, saveSoon() {}, flush() {} };
  const a = service(c, { store, journal });
  const e = await err(exec(a));
  assert.equal(e.status, 503);
  assert.equal(e.code, "intent_unknown");
  assert.equal((await err(exec(a))).code, "intent_unknown");
  const b = service(c, { store, journal });
  assert.equal((await err(exec(b))).code, "intent_unknown");
  assert.equal(c.s.sends.length, 1);
});

test("crash after broadcast before the hash returned: the restarted relay fails closed (fenced), sends nothing", async () => {
  const c = chainOf();
  c.s.script.push({ hang: true });
  const journal = { data: { txs: [] }, saveSoon() {}, flush() {} };
  const store = { data: {}, saveSoon() {}, flush() {} };
  const a = service(c, { store, journal });
  exec(a).catch(() => {});
  for (let i = 0; i < 200 && c.s.sends.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(c.s.sends.length, 1);
  assert.equal(journal.data.txs.at(-1).status, "sending");
  const b = service(c, { store, journal });
  const e = await err(exec(b));
  assert.equal(e.code, "intent_unknown");
  assert.equal(c.s.sends.length, 1);
});

test("a pending error from an EARLIER transaction is never attached to this call", async () => {
  const x = service(chainOf());
  const other = h32("legacy:x");
  x.journal.data.txs.push({ label: "close 0xlegacy", to: x.w.vault, nonce: 7, hashes: [other], status: "stuck", at: 0 });
  const e = await err(exec(x));
  assert.equal(e.status, 503);
  assert.equal(e.code, "nonce_busy");
  assert.equal(e.extra.txHashes, undefined);
  assert.deepEqual(e.extra.blockingTxHashes, [other]);
  assert.equal(e.extra.sent, false);
  assert.deepEqual(x.journal.data.intents, {}, "released: nothing of this intent was broadcast");
  assert.deepEqual(x.store.data.fundingPending, {});
  assert.equal(x.s.sends.length, 0);
});

test("canonical revert: exactly that submission is cleared, named by its hash, not a simulation refusal", async () => {
  const x = service(chainOf());
  const otherHash = h32("other-pending");
  x.store.data.fundingPending[otherHash] = { kind: "execute", at: T, reason: "preconfirmed", meta: {}, intent: "0x" + "77".repeat(32) };
  x.s.afterSend = (h) => canonical(x, h, { status: "reverted" });
  const e = await err(exec(x));
  assert.equal(e.status, 409);
  assert.equal(e.code, "reverted");
  assert.equal(e.extra.txHash, x.s.sent[0]);
  assert.equal(e.extra.onChain, true);
  assert.ok(x.store.data.fundingPending[otherHash], "another submission's pending record is untouched");
  assert.equal(x.store.data.fundingPending[x.s.sent[0]], undefined);
  assert.equal(x.journal.data.intents[e.extra.intent].status, "reverted");
  assert.equal(x.journal.data.intents[e.extra.intent].hash, x.s.sent[0]);
  assert.equal(x.store.data.fundingOps[x.w.sid], undefined);
});

test("journal bound: unresolved intents are kept, a new one is refused before any send; owner controls keep bounded headroom", async () => {
  const x = service(chainOf());
  for (let i = 0; i < 436; i++) {
    x.journal.data.intents[h32(`open:${i}`)] = { kind: "execute", meta: {}, status: "reserved", gen: 1, boot: x.svc.queue.boot, at: 0 };
  }
  const e = await err(exec(x));
  assert.equal(e.status, 503);
  assert.equal(e.code, "journal_full");
  assert.equal(x.s.sends.length, 0);
  assert.equal(Object.keys(x.journal.data.intents).length, 436);
  assert.ok(Object.values(x.journal.data.intents).every((r) => r.status === "reserved"));
  assert.equal(x.svc.queue.reserveIntent(h32("terminate"), { kind: "owner", meta: {}, control: true }), null);
  assert.throws(() => x.svc.queue.reserveIntent(h32("withdraw"), { kind: "owner", meta: {} }), (r) => r.code === "journal_full");
});

test("owner ops: a forged signature consumes no quota; terminate is not locked behind an unrelated pending intent", async () => {
  const x = service(chainOf(), { ownerOpsPerDay: 1 });
  const op = (o, n, sig, args) => x.svc.route("POST", "/funding/owner", { owner: x.w.owner, vault: x.w.vault, op: o,
    args: { ...args, opNonce: "0x" + n.repeat(32), signBefore: String(T + 600) }, sig });
  const bad = await err(op("withdraw", "11", BAD_SIG, { amount: "1" }));
  assert.equal(bad.code, "revert");
  assert.deepEqual(x.journal.data.intents, {});
  x.s.afterSend = (h) => preconfirmed(x, h);
  assert.equal((await err(exec(x))).code, "pending_reconciliation");
  x.s.afterSend = (h) => canonical(x, h, { logs: [] });
  const ok = await op("withdraw", "12", GOOD_SIG, { amount: "1" });
  assert.equal(ok.op, "withdraw");
  assert.equal(x.s.sends.length, 2);
  assert.equal(x.s.sends[1].nonce, 8);
  assert.equal((await err(op("withdraw", "13", GOOD_SIG, { amount: "1" }))).code, "rate", "the quota counted the one accepted op");
  x.s.afterSend = (h) => canonical(x, h, { logs: [endedLog(x)] });
  const t = await op("terminate", "14", GOOD_SIG, { sessionId: x.w.sid });
  assert.equal(t.op, "terminate");
  assert.equal(x.s.sends.length, 3);
  assert.ok(x.store.data.revoked[x.w.sid]);
});

test("the HTTP adapter answers a pending successor send with 202 and its own hashes", async () => {
  const x = service(chainOf());
  x.s.afterSend = (h) => preconfirmed(x, h);
  let answered = null;
  const ctx = { json: (_res, code, obj) => { answered = { code, obj }; }, readBody: async () => Buffer.from(JSON.stringify(execBody(x.w))) };
  await x.svc.handle({ method: "POST" }, {}, new URL("http://relay.test/v1/sessions/funding/execute"), ctx);
  assert.equal(answered.code, 202);
  assert.equal(answered.obj.code, "pending_reconciliation");
  assert.deepEqual(answered.obj.txHashes, x.s.sent);
});

test("activation: the route stays off without the queue's intent journal; production bootstrap wires no policy", () => {
  const c = chainOf();
  const send = Object.assign(async () => { throw new Error("never"); }, { envelopeGuard: ENVELOPE_GUARD });
  const off = createFundingRoute({ manifest: manifestOf(c.w), quotePolicy: TEST_POLICY, ownerManagement: true, rateOwner: () => {},
    pc: c.pc, relayer: c.w.relayer, store: { data: {}, flush() {} }, simulateAndSend: send });
  assert.equal(off.enabled, false);
  assert.match(off.why, /intent journal/);
  const src = readFileSync(new URL("../generated/relay/sessions.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /fundingQuotePolicy\s*:/);
});

test('root: changed signed deadline at the same session nonce cannot create a second submission', async()=>{const x=service(chainOf());x.s.afterSend=h=>preconfirmed(x,h);await err(exec(x));const first=x.s.sends.length;await err(exec(x,{deadline:String(T+61)}));assert.equal(x.s.sends.length,first,'same session nonce must remain one unresolved submission despite altered signed terms');});
test('root: no-hash nonce-too-low response stays fenced across retry',async()=>{const x=service(chainOf());x.s.script.push({error:'nonce too low'});const e=await err(exec(x));assert.equal(e.code,'intent_unknown');const n=x.s.sends.length;await err(exec(x));assert.equal(x.s.sends.length,n);assert.equal(Object.keys(x.journal.data.intents).length,1);});
test('root: funding reservations retain 64 global journal slots for owner controls',()=>{const x=service(chainOf());for(let i=0;i<436;i++)x.journal.data.intents[h32('limit'+i)]={kind:'execute',meta:{},status:'reserved',gen:1,boot:x.svc.queue.boot,at:0};assert.throws(()=>x.svc.queue.reserveIntent(h32('next-fund'),{kind:'execute',meta:{}}),e=>e.code==='journal_full');assert.equal(x.svc.queue.reserveIntent(h32('control'),{kind:'owner',meta:{},control:true}),null);});

test('root: concurrent changed terms share one nonce reservation and report conflict',async()=>{const x=service(chainOf());x.s.afterSend=h=>preconfirmed(x,h);const results=await Promise.all([err(exec(x)),err(exec(x,{deadline:String(T+61)}))]);assert.equal(x.s.sends.length,1);assert.ok(results.some(e=>e.code==='intent_conflict'));});
