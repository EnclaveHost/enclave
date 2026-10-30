// client-execution-recovery-r1 NATIVE execute-fault test. UNREVIEWED, NOT RUN by its author. Root runs it under the shared
// queue (one CPU, the existing memory guard) AFTER native/generate.py produced out/server.mjs and generated/
// HARNESS-INPUTS.json is filled:   node --test client-execution-recovery-r1/native/execute-fault.native.test.mjs
//
// Real: the derived fixture server (owned loopback Anvil 8453 with native P-256, the composed relay with ONE TxQueue,
// mock USDC + DEX, the public Anvil fixture signer), real HTTP, Node WebCrypto non-extractable P-256 session keys, the r4
// client for runtime/scope/open/quote, and the successor confirm / reconcile under test. Faults are the server's labelled
// one-shot execute reply faults (the execute itself is REALLY processed and mined). Store: r4 MemoryV2Store (Node has no
// IndexedDB; the browser path is NOT covered by this file). The child server is stopped with SIGTERM: it stops only the
// Anvil it spawned. No real wallet, no production URL, key or database.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";
import * as FC from "../../client-repair-r4/lib/funding-client.mjs";
import { MemoryV2Store } from "../../client-repair-r4/lib/v2-store.mjs";
import * as EX from "../lib/gas-execution.mjs";

const HERE = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const nowS = () => BigInt(Math.floor(Date.now() / 1000));
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
let child = null, origin = null;

async function startServer() {
  child = spawn(process.execPath, [path.join(HERE, "out", "server.mjs"), "0", "600"], { stdio: ["ignore", "pipe", "inherit"] });
  origin = await new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error("fixture server did not start in 180 s")), 180_000);
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const m = /TEST ONLY (http:\/\/127\.0\.0\.1:\d+)\//.exec(buf);
      if (m) { clearTimeout(timer); ok(m[1]); }
    });
    child.on("exit", (c) => { clearTimeout(timer); bad(new Error(`fixture server exited (${c}) before serving`)); });
  });
}
async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await done;
}
async function call(p, body) {
  const r = await fetch(origin + p, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body, big) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error ?? r.status}`);
  return j;
}
const status = () => call("/test/fixture/status");
const tick = () => call("/test/fixture/tick", {});

test("native: lost execute replies are UNKNOWN, then proven read-only from the real chain; nothing resent", { timeout: 300_000 }, async (t) => {
  t.after(stopServer);
  await startServer();
  const fx = await call("/test/fixture/config");
  const rpc = FC.jsonRpc(`${origin}/rpc`);
  const relay = FC.relayClient(origin);
  await tick();
  const runtime = await FC.verifyRuntime({ pins: fx.pins, rpc, relay, owner: fx.owner, now: nowS() });
  assert.ok(runtime.intake?.openEnabled, "fixture intake on");
  const store = new MemoryV2Store();
  const provider = { async request({ method, params }) {
    assert.equal(method, "eth_signTypedData_v4");
    return (await call("/test/owner-sign", { address: params[0], payload: params[1] })).sig;
  } };
  // one successor gas session over the 8 nucbox apps (0.8 TEST budget), opened through the real relay
  const t0 = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  const prep = await FC.prepareGasOpen({ runtime, store, relayBase: origin, appIds: fx.partition.nucbox, legacyExpiresAt: t0 + 604_800n,
    expiresAt: t0 + 604_800n, now: nowS(), label: "client-execution-recovery-r1 native", part: { budget6: 800_000n, opsPerPeriod: 16n } });
  const body = await FC.signGasOpen({ runtime, provider, rpc, review: prep.review, approval: { rootReviewed: true, digest: prep.review.digest }, now: nowS() });
  const opened = await FC.submitGasOpen({ runtime, store, relay, rpc, record: prep.record, review: prep.review, body, now: nowS() });
  assert.equal(opened.pending, false, "gas session open proven");
  const recId = prep.record.id;
  const deps = fx.deployments.filter((d) => fx.partition.nucbox.includes(d.app)).map((d) => d.id);
  const balance = async () => BigInt((await call(`/test/fixture/gas-session/${(await store.loadKey(recId)).sid}`)).balance6);

  async function attempt(fault, relayFn = relay) {
    await tick();
    const record = await store.loadKey(recId);
    const scope = await FC.freshRecoveryScope({ rpc, book: fx.book, owner: fx.owner, legacyVault: fx.legacyVault, deploymentIds: deps, now: nowS() });
    const review = await EX.quoteGasFund({ runtime, record, relay, scope, deployment: deps[0], ethOut: BigInt(fx.ethOut), feeTier: fx.feeTier,
      now: nowS(), journalEntries: await store.listJournal() });
    if (fault) await call("/test/fixture/execute-fault", { mode: fault });
    let err = null, out = null;
    try { out = await EX.confirmGasFund({ runtime, store, record, review, relay: relayFn, relayBase: origin, rpc, now: nowS() }); } catch (e) { err = e; }
    return { err, out, id: EX.execId(record.sid, review.call.execute.nonce), max: review.totals.totalMaximum6 };
  }
  async function settle(id) {
    for (let i = 0; i < 12; i++) {
      const r = await EX.reconcileGasExecution({ runtime, store, rpc, relay, relayBase: origin, id });
      if (r.status === "settled") return r;
      assert.ok(["observed", "unknown", "pending"].includes(r.status), `unexpected ${r.status} (${r.verdict})`);
      await tick();
    }
    throw new Error(`${id} did not settle within 12 bounded reconciles`);
  }

  for (const fault of ["body", "gateway502"]) {
    const s0 = await status();
    const b0 = await balance();
    const a = await attempt(fault);
    assert.ok(a.err, `${fault}: the client saw a failure`);
    assert.equal((await store.getJournal(a.id)).status, "unknown", `${fault}: UNKNOWN, never refused`);
    const s1 = await status();
    assert.equal((s1.hits["POST /v1/sessions/funding/execute"] ?? 0) - (s0.hits["POST /v1/sessions/funding/execute"] ?? 0), 1, `${fault}: one execute sent`);
    assert.deepEqual(s1.executeFaults.slice(-1), [fault]);
    const r = await settle(a.id);
    const s2 = await status();
    assert.equal(s2.hits["POST /v1/sessions/funding/execute"], s1.hits["POST /v1/sessions/funding/execute"], `${fault}: reconcile resent nothing`);
    assert.equal(s2.prompts.length, s1.prompts.length, `${fault}: no owner prompt`);
    const debit = BigInt(r.evidence.actual.totalDebit6);
    assert.ok(debit > 0n && debit <= a.max, `${fault}: debit within the signed maximum`);
    assert.equal(b0 - await balance(), debit, `${fault}: the session was debited exactly once`);
  }

  // a request that never reaches the relay: UNKNOWN, nothing on chain, reservation kept (run LAST: it blocks the session)
  const dead = FC.relayClient("http://127.0.0.1:1");
  const s0 = await status();
  const a = await attempt(null, dead);
  assert.equal((await store.getJournal(a.id)).status, "unknown");
  await tick();
  const r = await EX.reconcileGasExecution({ runtime, store, rpc, relay, relayBase: origin, id: a.id });
  assert.deepEqual([r.verdict, r.status], ["unresolved", "unknown"]);
  await assert.rejects(attempt(null), (e) => e?.code === "unreconciled_execute");
  assert.equal((await status()).hits["POST /v1/sessions/funding/execute"], s0.hits["POST /v1/sessions/funding/execute"], "nothing sent");
});
