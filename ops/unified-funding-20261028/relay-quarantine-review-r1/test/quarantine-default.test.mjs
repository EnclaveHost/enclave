// relay-quarantine-r1, DEFAULT mode (SESSIONS_WRITE_QUARANTINE unset). node --test gives every file its own process, so this
// file's module instance reads the flag unset; test/quarantine-on.test.mjs sets it before its own first import.
// NOT RUN by the author (source-only task).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TxQueue, WRITE_QUARANTINE, createSessionsService, quarantineGate, writeQuarantineFromEnv } from "../generated/relay/sessions.mjs";

const OWNER = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";
const RELAYER = "0x3333333333333333333333333333333333333333";
const FACTORY = "0x4444444444444444444444444444444444444444";
const H = (b) => "0x" + b.repeat(32);
const SID = H("ab");
const NOW = 1_900_000_000;
const GEN = (n) => readFileSync(new URL(`../generated/relay/${n}`, import.meta.url), "utf8");
const INPUT = (n) => readFileSync(new URL(`../../activation-r1/generated/relay/${n}`, import.meta.url), "utf8");
const err = (p) => p.then((v) => assert.fail(`expected an error, got ${String(v)}`), (e) => e);

test("default: the flag is off unless exactly \"1\"; any unrecognised value fails closed (ON); off, the gate is a no-op", () => {
  assert.equal(process.env.SESSIONS_WRITE_QUARANTINE ?? "", "", "run this file with SESSIONS_WRITE_QUARANTINE unset");
  assert.deepEqual({ ...WRITE_QUARANTINE }, { on: false, value: "off" });
  assert.ok(Object.isFrozen(WRITE_QUARANTINE));
  for (const v of [undefined, "", "0"]) assert.equal(writeQuarantineFromEnv({ SESSIONS_WRITE_QUARANTINE: v }).on, false, String(v));
  assert.equal(writeQuarantineFromEnv({}).on, false);
  assert.deepEqual({ ...writeQuarantineFromEnv({ SESSIONS_WRITE_QUARANTINE: "1" }) }, { on: true, value: "1" });
  for (const v of ["true", "yes", "01", " 1", "1 ", "2", "off", "false", "0 "])
    assert.deepEqual({ ...writeQuarantineFromEnv({ SESSIONS_WRITE_QUARANTINE: v }) }, { on: true, value: "invalid" }, JSON.stringify(v));
  for (const p of ["route", "simulate", "queue", "queue_inner", "attestor_queue", "wallet", "account"]) assert.equal(quarantineGate(p), undefined);
});

/** The legacy routes over scripted reads; the ONE queue's send is replaced by a spy that records and stops every send. */
function legacyService() {
  const rpc = [];
  const reads = { isVault: true, owner: OWNER, vaultFor: VAULT, epoch: 0n, seqOf: 0n,
    sessionOf: [{ state: 1, epoch: 0n, balance6: 5n, keyHash: H("00"), actions: 0n, envs: 0 }, true, []] };
  const pc = {
    async readContract({ functionName }) { rpc.push(functionName); if (functionName in reads) return reads[functionName]; throw new Error(`unscripted ${functionName}`); },
    async simulateContract({ functionName }) { rpc.push(`simulate:${functionName}`); return { result: undefined }; },
    async getBlock() { rpc.push("getBlock"); return { baseFeePerGas: 1n }; },
    async estimateMaxPriorityFeePerGas() { rpc.push("tip"); return 1n; },
  };
  const wc = { chain: { id: 8453 }, async sendTransaction() { throw new Error("the spy must stop every send before the wallet"); } };
  const store = { data: {}, saveSoon() {}, flush() {} };
  const journal = { data: { txs: [] }, saveSoon() {}, flush() {} };
  const svc = createSessionsService({ pc, wc, account: { address: RELAYER }, chainId: 8453, factory: FACTORY, store, journal,
    log: () => {}, alert: () => {}, now: () => NOW });
  assert.ok(svc.queue instanceof TxQueue);
  const reached = [];
  svc.queue.send = (item) => { reached.push(item.label); return Promise.reject(Object.assign(new Error("reached the one queue"), { code: "reached_queue" })); };
  return { svc, store, rpc, reached };
}

test("default wiring: every legacy write entry and the keeper reach the ONE TxQueue's send (where the quarantine gate sits)", async () => {
  const x = legacyService();
  const grant = { label: "l", preset: "p", sessionKey: H("01"), actions: [], apps: [], environments: [], budget: "0", spendPerPeriod: "0",
    periodSeconds: "0", opsPerPeriod: "0", maxFeePerOp: "0", maxAppFeePerHour: "0", expiresAt: "0", measurement: H("00"),
    grantNonce: H("02"), signBefore: "0" };
  const sk = { x: "1", y: "2", r: H("0e"), s: H("0f") };
  const entries = [
    ["/execute", { vault: VAULT, sid: SID, action: 1, nonce: "0", args: "0x", fee: "1000000000", deadline: String(NOW + 60), ...sk }, /^execute /],
    ["/open", { owner: OWNER, grant, ownerSig: "0x" }, /^open /],
    ["/owner", { owner: OWNER, vault: VAULT, op: "withdraw", sig: "0x", args: { amount: "1", opNonce: H("03"), signBefore: String(NOW + 60) } }, /^withdraw /],
    ["/owner", { owner: OWNER, vault: VAULT, op: "terminate", sig: "0x", args: { sessionId: SID, opNonce: H("04"), signBefore: String(NOW + 60) } }, /^terminate /],
    ["/end", { vault: VAULT, sid: SID, deadline: String(NOW + 60), ...sk }, /^end /],
  ];
  for (const [p, body, label] of entries) {
    const n = x.reached.length;
    const e = await err(x.svc.route("POST", p, body));
    assert.equal(e.code, "reached_queue", `${p}: ${e.message}`);
    assert.equal(x.reached.length, n + 1, p);
    assert.match(x.reached.at(-1), label);
  }
  x.store.data.sessions[SID] = { vault: VAULT, expiresAt: NOW - 10, ended: false };
  await x.svc.keeperOnce();
  assert.match(x.reached.at(-1) ?? "", /^close /, "the keeper's close goes through the same queue");
  assert.equal(x.reached.length, entries.length + 1);
  assert.equal(x.rpc.filter((r) => r.startsWith("simulate:")).length, entries.length + 1, "default: each was simulated first, as in the input");
});

test("default surface unchanged: /quarantine is still 404, /quote still answers, a real TxQueue still estimates, signs and journals", async () => {
  const x = legacyService();
  const e = await err(x.svc.route("GET", "/quarantine"));
  assert.equal(e.status, 404);
  assert.equal(e.code, "not_found");
  const q = await x.svc.route("POST", "/quote", { vault: VAULT, sid: SID, action: 1 });
  assert.equal(typeof q.fee, "bigint");
  assert.equal(x.reached.length, 0);
  // the input's queue path, untouched: estimate, nonce, journal record, broadcast, then (no receipt) 503 tx_pending
  const seen = [];
  const pc = {
    async estimateGas() { seen.push("estimateGas"); return 100_000n; },
    async getBlock() { seen.push("getBlock"); return { baseFeePerGas: 1n }; },
    async estimateMaxPriorityFeePerGas() { return 1n; },
    async getTransactionCount({ blockTag }) { seen.push(`nonce:${blockTag}`); return 7; },
    async getTransactionReceipt() { throw new Error("TransactionReceiptNotFoundError"); },
  };
  const sends = [];
  const wc = { chain: { id: 8453 }, async sendTransaction(r) { sends.push(r); return H("77"); } };
  const journal = { data: { txs: [] }, saveSoon() {}, flush() {} };
  let t = 0;
  const queue = new TxQueue({ pc, wc, account: { address: RELAYER }, journal, log: () => {}, maxAttempts: 1, receiptTimeoutMs: 1, pollMs: 1,
    sleep: async () => {}, clock: () => (t += 5) });
  const pending = await err(queue.send({ to: VAULT, data: "0x", label: "default" }));
  assert.equal(pending.code, "tx_pending");
  assert.deepEqual(seen.slice(0, 3), ["estimateGas", "getBlock", "nonce:pending"]);
  assert.equal(sends.length, 1);
  assert.equal(Number(sends[0].nonce), 7);
  assert.equal(journal.data.txs.length, 1);
  assert.equal(journal.data.txs[0].status, "stuck");
  assert.equal(queue.wc, wc, "default: the queue holds the wallet client it was given");
});

test("static: the gate is the FIRST statement of route, simulateAndSend, keeperOnce, TxQueue.send and TxQueue._send, and precedes the alternate attestor queue", () => {
  const S = GEN("sessions.mjs");
  const first = (anchor, want) => {
    const i = S.indexOf(anchor);
    assert.ok(i >= 0, `missing ${anchor.trim()}`);
    assert.equal(S.indexOf(anchor, i + 1), -1, `${anchor.trim()} must occur once`);
    const next = S.slice(i + anchor.length).split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("//"));
    assert.ok(next.startsWith(want), `${anchor.trim()} is followed by ${next}`);
  };
  first("  send(item) {\n", "try { quarantineGate(\"queue\"); }");
  first("  async _send({ to, data, label, envelope, intent }) {\n", "quarantineGate(\"queue_inner\");");
  first("  async function simulateAndSend({ to, abi, functionName, args, label, afterSimulate, envelope, intent }) {\n", "quarantineGate(\"simulate\");");
  first("  async function keeperOnce() {\n", "if (WRITE_QUARANTINE.on) { quarantineCounts.keeper++; return; }");
  first("  async function route(method, path, body, ctx) {\n", "if (WRITE_QUARANTINE.on && method !== \"GET\" && method !== \"HEAD\") quarantineGate(\"route\");");
  assert.match(S, /if \(q !== queue\) quarantineGate\("attestor_queue"\);\n    const rc = await q\.send\(/);
  // the only send call sites: the host's ONE queue (simulateAndSend) and the attestor's q (gated above when it is not that queue)
  assert.deepEqual([...S.matchAll(/(\w+)\.send\(/g)].map((m) => m[1]), ["queue", "q"]);
  // the only broadcast: inside _send, after its gate
  assert.equal(S.split("sendTransaction(").length - 1, 1);
  const gate = S.indexOf("quarantineGate(\"queue_inner\")"), bc = S.indexOf("this.wc.sendTransaction("), end = S.indexOf("  /** Poll the record's hashes");
  assert.ok(gate > 0 && gate < bc && bc < end, "sendTransaction sits in _send after the gate");
  assert.equal(S.split("new TxQueue(").length - 1, 1, "one queue");
  for (const t of ["eth_sendRawTransaction", "sendRawTransaction", "signTransaction", "eth_sign"]) assert.equal(S.includes(t), false, t);
});

test("static: the four other modules are byte copies, and none of them can send except through the host's simulateAndSend", () => {
  for (const n of ["funding-route.mjs", "funding-activation.mjs", "fee-policy.mjs", "funding-abi.mjs"]) {
    const g = GEN(n);
    assert.equal(g, INPUT(n), `${n} is unchanged`);
    for (const t of [".send(", "sendTransaction", "sendRawTransaction", "signTransaction", "eth_send", "eth_sign", "createWalletClient",
      "privateKeyToAccount", "new TxQueue"]) assert.equal(g.includes(t), false, `${n} names ${t}`);
  }
  assert.ok(GEN("funding-route.mjs").includes("await simulateAndSend({ ...req, intent: key"), "successor writes use the host callback");
  assert.equal(GEN("sessions.mjs").includes("simulateAndSend: Object.assign((req) => simulateAndSend(req)"), true,
    "the host hands the funding route its OWN simulateAndSend (gated)");
});
