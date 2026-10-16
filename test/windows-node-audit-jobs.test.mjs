// windows/node/audit-jobs.mjs: a Windows host accepts the paid capacity-audit jobs created for it (offerJobRate, signed by
// its operator key on the box) through availability/host-acceptor.mjs, sent by the node's serialized sender; off unless
// the operator lists the audit workloads.
import test from "node:test";
import assert from "node:assert/strict";
import { createAuditJobs, auditAppRefsOf } from "../windows/node/audit-jobs.mjs";

const HOST = "0x" + "a1".repeat(32), OTHER = "0x" + "b2".repeat(32);
const APP = "catalog://0x962622b0284b438f58ad480b824d4fbf7fa9ce3dc84e2af97b65bd15392a5e6f/0";
const FEES = "0x" + "fe".repeat(20), LEDGER = "0x" + "dd".repeat(20);
const NOW = 1_900_000_000_000;
const id = (n) => "0x" + String(n).padStart(2, "0").repeat(32);

function world({ jobs, rows, rateFor = {} }) {
  const reads = [], sent = [];
  const publicClient = {
    async readContract({ address, functionName, args }) {
      reads.push(`${functionName}:${String(args[0]).slice(0, 6)}`);
      if (functionName === "jobs") { const j = jobs[args[0]]; if (!j) throw new Error("no job"); return j; }
      if (functionName === "get") return { appRef: rows.find((r) => r.id === args[0]).appRef, cpuMilli: 19n };
      if (functionName === "rateFor") return rateFor[args[0]] ?? 0n;
      throw new Error("unexpected " + functionName + " at " + address);
    },
    async waitForTransactionReceipt() { return { status: "success" }; },
  };
  const send = async (address, abi, fn, args) => { sent.push({ address, fn, args }); return "0xhash" + sent.length; };
  const logs = [];
  return { publicClient, send, reads, sent, logs, log: (m) => logs.push(m) };
}
// (source, wallet, hostId, epoch, expires, rate6, amount6, funded, stopAfter)
const job = (host, { rate = 22n, expiresSec = BigInt(NOW / 1000 + 600), funded = false } = {}) =>
  ["0x" + "11".repeat(20), "0x" + "22".repeat(20), host, 1n, expiresSec, rate, 0n, funded, 0n];
const row = (n, extra = {}) => ({ id: id(n), active: true, appRef: APP, runner: "0x" + "00".repeat(32), leaseUntil: 0n, ...extra });

test("off unless the operator lists audit workloads: nothing is read or sent", async () => {
  const w = world({ jobs: { [id(1)]: job(HOST) }, rows: [row(1)] });
  const a = createAuditJobs({ appRefs: auditAppRefsOf(""), enclaveId: HOST, ledger: LEDGER, fees: FEES, publicClient: w.publicClient, send: w.send, now: () => NOW });
  assert.equal(a.enabled, false);
  assert.equal((await a.pass([row(1)])).size, 0);
  assert.deepEqual(w.reads, []); assert.deepEqual(w.sent, []);
  assert.deepEqual(auditAppRefsOf(` ${APP.toUpperCase()}, nonsense, catalog://0x12/1`), [APP], "only well-formed refs, lower-cased");
});

test("a job created for this host is accepted once, at its own rate and expiry, through the serialized sender", async () => {
  const rows = [row(1), row(2), row(3, { appRef: "catalog://0x" + "77".repeat(32) + "/0" })];
  const w = world({ jobs: { [id(1)]: job(HOST), [id(2)]: job(OTHER) }, rows });
  const a = createAuditJobs({ appRefs: [APP], enclaveId: HOST, ledger: LEDGER, fees: FEES, publicClient: w.publicClient, send: w.send, log: w.log, now: () => NOW });
  const mine = await a.pass(rows);
  assert.deepEqual([...mine], [id(1)], "only this host's job joins the pool");
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].fn, "offerJobRate");
  assert.equal(w.sent[0].address, LEDGER);
  assert.deepEqual(w.sent[0].args, [id(1), HOST, 22n, BigInt(NOW / 1000 + 600)]);
  assert.ok(!w.reads.some((r) => r.endsWith(id(3).slice(0, 6))), "a workload not on the list is never read");
  const before = w.reads.length;
  await a.pass(rows);
  assert.equal(w.sent.length, 1, "accepted once");
  assert.equal(w.reads.filter((r) => r === `jobs:${id(2).slice(0, 6)}`).length, 1, "another host's job is read once, ever");
  assert.ok(w.reads.length - before <= 1, "the second pass reads only this host's job");
});

test("an expired, funded or below-floor job is not accepted; a refusal is logged once", async () => {
  const rows = [row(1), row(2), row(3)];
  const w = world({ jobs: { [id(1)]: job(HOST, { expiresSec: BigInt(NOW / 1000 - 1) }), [id(2)]: job(HOST, { funded: true }), [id(3)]: job(HOST, { rate: 10n }) }, rows });
  const a = createAuditJobs({ appRefs: [APP], minRatePerShareMilli6: 1n, enclaveId: HOST, ledger: LEDGER, fees: FEES, publicClient: w.publicClient,
    send: w.send, log: w.log, now: () => NOW });
  const mine = await a.pass(rows);
  assert.equal(mine.size, 3, "they are still this host's jobs");
  assert.deepEqual(w.sent, [], "nothing signed: expired, funded, and 10/s < 1 x 19 milli");
  await a.pass(rows);
  const floor = w.logs.filter((m) => /not accepted: acceptor: below this host's floor/.test(m));
  assert.equal(floor.length, 1, w.logs.join("\n"));
});

test("a row somebody else holds a live lease on is not a job waiting for this host", async () => {
  const rows = [row(1, { runner: OTHER, leaseUntil: BigInt(NOW / 1000 + 300) })];
  const w = world({ jobs: { [id(1)]: job(HOST) }, rows });
  const a = createAuditJobs({ appRefs: [APP], enclaveId: HOST, ledger: LEDGER, fees: FEES, publicClient: w.publicClient, send: w.send, now: () => NOW });
  assert.equal((await a.pass(rows)).size, 0);
  assert.deepEqual(w.reads, []);
});
