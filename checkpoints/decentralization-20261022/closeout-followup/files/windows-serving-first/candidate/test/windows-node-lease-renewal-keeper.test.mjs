// RENEWALS ON THEIR OWN CLOCK (windows/node/host.mjs renewDue), end to end on one box: the REAL Host and the REAL chain.mjs
// (its leaseSend: release-journal holds, the operator's one serialized send queue, the "this host's ETH is never used
// instead" wrapper) on a fake Base RPC, with app-funded leases configured and the shipped lease-gas runtime replaced ONLY by a
// scripted sender (test/helpers/windows-lease-scripted-fixture.mjs) that applies the reserve's own rules: a live lease, inside
// the owner's 300-s renew window. 2026-10-22 minipc adapter: the pass took ~7 min, the sponsored window's lead is 285 s, so
// the lease had ONE attempt; it met a transient lease-gas quorum failure and the next pass found the lease expired.
// Time moves with `skew`; the keeper's 30-s timer is driven explicitly (renewDue). Every operator transaction is counted
// (the fake RPC would MINE one): an app-funded renewal must never fall back to this host's ETH.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { registerHooks } from "node:module";
import { toFunctionSelector } from "viem";
import { fakeBaseRpc, DEPLOYMENTS, CATALOG } from "./helpers/fake-base-rpc.mjs";

const chainUrl = new URL("../windows/node/chain.mjs", import.meta.url).href;
const fixtureUrl = new URL("./helpers/windows-lease-scripted-fixture.mjs", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(chainUrl) && specifier === "./lease-gas-runtime.bundle.mjs") return { url: fixtureUrl, shortCircuit: true };
  return next(specifier, context);
} });
process.env.NODE_OPERATOR_KEY = "0x" + "7f".repeat(32);
delete process.env.ENCLAVE_NETWORK_WALLET_HOLD;
const rpc = await fakeBaseRpc();
// every operator-paid renew this process would attempt: its simulation (eth_call renew(bytes32)) or any raw transaction
const RENEW_SELECTOR = toFunctionSelector("renew(bytes32)"), operatorAttempts = [];
const proxy = http.createServer(async (q, s) => {
  const chunks = []; for await (const c of q) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  for (const m of [].concat(JSON.parse(body))) {
    const data = String(m.params?.[0]?.data || m.params?.[0]?.input || "");
    if (m.method === "eth_sendRawTransaction" || ((m.method === "eth_call" || m.method === "eth_estimateGas") && data.startsWith(RENEW_SELECTOR))) operatorAttempts.push(m.method);
  }
  const r = await fetch(process.env.FAKE_BASE_RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
  s.writeHead(r.status, { "content-type": "application/json" }); s.end(await r.text());
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
process.env.FAKE_BASE_RPC = process.env.BASE_RPCS; process.env.BASE_RPCS = `http://127.0.0.1:${proxy.address().port}`;
const chain = await import(chainUrl);
chain.addresses.deployments = DEPLOYMENTS; chain.addresses.appCatalog = CATALOG; chain.loadOperator();
const { Host } = await import("../windows/node/host.mjs");
const { openReleaseJournal } = await import("../windows/node/lease-gas-runtime.bundle.mjs");

const QUORUM = "lease-gas RPC quorum cannot read the configured chain";
const A = "0x" + "ab".repeat(32), B = "0x" + "ef".repeat(32), ref = "catalog://0x" + "cd".repeat(32) + "/1", ref2 = "catalog://0x" + "cd".repeat(32) + "/2";
const endpoint = "https://api.enclave.host/t/renewal-keeper-test", runner = chain.enclaveIdOf(endpoint).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
const dirs = [];

// the manager of this box (Hyper-V faked): a running domain per deployment
const mgr = { vms: [], removed: [] };
const srv = http.createServer((q, s) => { const send = (c, b) => { s.writeHead(c, { "content-type": "application/json" }); s.end(JSON.stringify(b)); };
  const m = q.url.match(/^\/vms(?:\/([^/?]+))?$/); if (!m) return send(404, { error: "no" });
  const vid = m[1] && decodeURIComponent(m[1]);
  if (q.method === "GET" && !vid) return send(200, { vms: mgr.vms });
  if (q.method === "GET") { const v = mgr.vms.find((x) => x.id === vid); return v ? send(200, v) : send(404, { error: "gone" }); }
  if (q.method === "DELETE") { const i = mgr.vms.findIndex((x) => x.id === vid); if (i < 0) return send(404, { error: "gone" }); mgr.removed.push(vid); mgr.vms.splice(i, 1); return send(200, { removed: vid }); }
  send(405, {}); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const MANAGER = `http://127.0.0.1:${srv.address().port}`;
after(() => { Date.now = realNow; hooks.deregister(); rpc.close(); srv.close(); proxy.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// THE SCRIPTED SENDER: the chain's truth (S.until) and the reserve's rules; reads (the fake RPC's rows) may lag it (S.lag)
const S = {};
const reset = () => Object.assign(S, { lead: 285_000, down: false, refuse: null, fail: null, renewMs: 0, leadGate: null, lag: false, until: {},
  calls: [], inflight: 0, maxInflight: 0, leadCalls: 0, suspended: null, ensureGate: null, adopt: true });
const rowOf = (id) => rpc.rows.current.find((r) => r.id.toLowerCase() === id.toLowerCase());
const setRow = (id, over) => { rpc.rows.current = rpc.rows.current.map((r) => r.id.toLowerCase() === id.toLowerCase() ? { ...r, ...over } : r); };
globalThis.scriptedLeaseSender = {
  async renewLeadMs(id, fallbackMs) { S.leadCalls++; if (S.leadGate) await S.leadGate; if (S.down) throw new Error(QUORUM); return Math.min(fallbackMs, S.lead); },
  async renew(id) {
    const key = id.toLowerCase(), c = { fn: "renew", id: key, start: Date.now(), realStart: realNow() };
    S.calls.push(c); S.inflight++; S.maxInflight = Math.max(S.maxInflight, S.inflight);
    try {
      if (S.renewMs) await sleep(S.renewMs);
      if (S.down) throw new Error(QUORUM);
      if (S.fail) { const f = S.fail; S.fail = null; throw new Error(f); }
      if (S.refuse) throw new Error(`renew ${id} refused: ${S.refuse}`);
      const left = S.until[key] * 1000 - Date.now();
      if (left <= 0) throw new Error(`renew ${id} refused: the lease expired (claim it instead)`);
      if (left > 300_000) throw new Error(`renew ${id} refused: not yet inside the app's renew window`);
      S.until[key] = Math.floor(Date.now() / 1000) + 1800; c.ok = true;
      if (!S.lag) setRow(key, { leaseUntil: BigInt(S.until[key]) });
      return { hash: "0x" + "11".repeat(32), receipt: { status: "success" } };
    } finally { S.inflight--; c.realEnd = realNow(); }
  },
  async claim(id) { S.calls.push({ fn: "claim", id: id.toLowerCase() }); throw new Error("scripted: no claim is expected here"); },
  async release(id) { S.calls.push({ fn: "release", id: id.toLowerCase(), realStart: realNow() }); return { hash: "0x" + "22".repeat(32), receipt: { status: "success" } }; },
  async resolveSigned() { return { state: "pending" }; },
};
const renews = (id = A) => S.calls.filter((c) => c.fn === "renew" && c.id === id.toLowerCase());
const operatorTx = () => rpc.chainTx.sent.length + operatorAttempts.length;

const ALLOW = () => ({ refusal: null, validUntil: Date.now() + 80_000 });
const REFUSE = () => ({ refusal: "banned by the host owner wallet policy", validUntil: Date.now() + 80_000 });
const UNKNOWN = () => { throw new Error("chain quorum unavailable"); };
const quiet = (h) => { for (const n of ["followBook", "enforceOff", "ensureRegistered", "ensurePriced", "scanLedger", "retireForeignRecovered"]) h[n] = async () => {}; };
const row = (id, left) => ({ id, owner: chain.operatorAddress(), appRef: ref, ports: "", configCid: "", gpuMilli: 0, cpuMilli: 100, appPort: 8000, isPublic: true,
  active: true, createdAt: 1n, rate: 0n, balance6: 1000000n, spent6: 0n, runner, runnerOperator: chain.operatorAddress(), leaseUntil: BigInt(Math.floor(Date.now() / 1000) + left) });

/** A FRESH node process with its wallet channel on (as on minipc), serving `ids` (running domains), each lease `left` s away. */
async function box({ answer = ALLOW, ids = [A], left = 400, before } = {}) {
  skew = 0; reset(); rpc.chainTx.mine = true; rpc.chainTx.sent = []; operatorAttempts.length = 0; rpc.row.current = null;
  rpc.rows.current = ids.map((id) => row(id, left)); for (const id of ids) S.until[id.toLowerCase()] = Number(rowOf(id).leaseUntil);
  mgr.vms = ids.map((id, i) => ({ id: "hv" + String(i + 1).repeat(32), name: id, status: "running", appId: "a".repeat(64) })); mgr.removed = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renewal-keeper-")); dirs.push(dir);
  before?.(dir);
  const agentDir = path.join(dir, "agent"); fs.mkdirSync(path.join(agentDir, "state"), { recursive: true });
  const logs = [];
  const box = { answer };
  const platformPolicy = { enabled: false, start() {}, stop() {}, check: async () => {}, newWorkRefusal: () => null, serviceRefusal: () => S.suspended, status: () => ({}) };
  const h = new Host({ dir, endpoint, name: "test", appsEnabled: true, vcpus: 8, ramGb: 16, cpuPricePerSec6: 0, isolationManager: MANAGER, platformPolicy,
    walletAdmission: { file: path.join(agentDir, "wallet-admission.json"), statusFile: path.join(agentDir, "state", "status.json") }, log: (m) => logs.push(String(m)),
    hostAdmission: { hostId: runner, refusal: async (q) => (await box.answer(q)).refusal, decision: async (q) => box.answer(q) } });
  h.chainReady = true; h.registered = { cpuPricePerSec6: "0" }; await h.refreshOwners(); quiet(h);
  await h.walletChannelStart();
  ids.forEach((id, i) => { h.tracked.add(id); h.records.set(id, { id, status: "running", appRef: ref, envelope: "", isolation: { instance: mgr.vms[i].id, appId: "a".repeat(64) } }); });
  h.ensureApp = async (id, d) => {
    if (S.ensureGate) await S.ensureGate;
    const rec = h.records.get(id);
    h.records.set(id, { ...rec, status: "running", appRef: S.adopt ? d.appRef : rec.appRef });
    return h.records.get(id);
  };
  return Object.assign(box, { h, logs, dir, pass: () => h.tick(), ready: (id = A) => h.leaseReadiness().deployments.find((r) => r.id === id)?.status });
}
const NONE = { renewed: [], failed: [], skipped: [] };
/** the keeper's 30-s timer, `sec` later (the frozen installed host has no keeper: there it does nothing) */
const keep = async (b, sec = 30) => { skew += sec * 1000; return (await b.h.renewDue?.()) || NONE; };
const leftOf = (id = A) => S.until[id.toLowerCase()] - Date.now() / 1000;
const gate = () => { let open; const p = new Promise((r) => (open = r)); return { p, open }; };

test("the outage: a pass's renew meets a lease-gas quorum failure; the keeper renews inside the window after the RPCs recover", { timeout: 30_000 }, async () => {
  const b = await box({ left: 400 });
  await b.pass();                                       // 400 s left: not yet due (the window's lead is 285 s)
  assert.equal(renews().length, 0);
  skew += 287_000; S.down = true;                       // 113 s left, as live at 21:37:50
  await b.pass();
  assert.equal(renews().length, 1, "the pass tried once");
  assert.ok(b.logs.some((l) => l.includes(`renew failed: app-funded renew not sent: ${QUORUM}; this host's ETH is never used instead`)), b.logs.join("\n"));
  assert.equal(b.ready(), "not-ready", "a failed renewal is not readiness");
  skew += 20_000; S.down = false;                       // the public RPCs answer again
  await keep(b);                                        // +50 s after the failure: still inside its 60-s retry pause
  assert.equal(renews().length, 1, "no retry before RENEW_RETRY_MS");
  const r = await keep(b);                              // +80 s: retried
  assert.deepEqual(r.renewed, [A], JSON.stringify(r));
  assert.equal(renews().length, 2); assert.ok(renews()[1].ok);
  assert.ok(leftOf() > 1700, "the lease was extended before it expired");
  skew += 420_000 - 80_000;                             // the next pass, 7 minutes after the failed one
  await b.pass();
  assert.equal(b.h.records.get(A).status, "running", JSON.stringify(b.h.records.get(A)));
  assert.ok(!b.logs.some((l) => /lease expired/.test(l)), "never retired for an expired lease");
  assert.equal(b.ready(), "ready");
  assert.equal(operatorTx(), 0, "never this host's ETH");
  assert.equal(S.calls.filter((c) => c.fn !== "renew").length, 0, "no claim, no release");
});

test("a 7-minute pass that never reaches the window: renewed once inside it, never again on a lagging read", { timeout: 30_000 }, async () => {
  const b = await box({ left: 400 });
  await b.pass();
  S.lag = true;                                         // reads keep answering the OLD lease for a while after the renew
  let renewedAt = null;
  for (let t = 30; t <= 390; t += 30) {
    const before = renews().length; await keep(b);
    if (renews().length > before && renewedAt === null) renewedAt = 400 - t;
    if (t === 240) { S.lag = false; setRow(A, { leaseUntil: BigInt(S.until[A.toLowerCase()]) }); }
  }
  assert.equal(renews().length, 1, `exactly one renewal (${JSON.stringify(renews())})`);
  assert.ok(renewedAt <= 285 && renewedAt > 250, `inside the window, at its first keeper round (${renewedAt} s left)`);
  assert.ok(S.leadCalls <= 3, `the window's lead read once per lease per 5 min, not per round (${S.leadCalls})`);
  skew += 30_000; await b.pass();
  assert.equal(b.ready(), "ready"); assert.equal(b.h.records.get(A).status, "running");
  assert.equal(renews().length, 1); assert.equal(operatorTx(), 0);
});

test("the pass and the keeper on one due lease: ONE renewal, never two sends in flight (either order)", { timeout: 30_000 }, async () => {
  for (const keeperFirst of [true, false]) {
    const b = await box({ left: 400 });
    await b.pass();
    skew += 200_000; S.renewMs = 300;                    // 200 s left: due for both
    await (keeperFirst ? Promise.all([b.h.renewDue(), b.pass()]) : Promise.all([b.pass(), b.h.renewDue()]));
    assert.equal(renews().length, 1, `keeperFirst=${keeperFirst}: ${JSON.stringify(renews())}`);
    assert.equal(S.maxInflight, 1);
    assert.equal(b.ready(), "ready", `keeperFirst=${keeperFirst}`);
    await keep(b); await b.pass();
    assert.equal(renews().length, 1, "and not again");
    assert.ok(!b.logs.some((l) => /renew failed|withdrawn/.test(l)), b.logs.join("\n"));
  }
});

test("REVIEW 1: an owner's version edit not yet served is never renewed by the keeper (paused reconcile, failed adoption, failed edit)", { timeout: 30_000 }, async () => {
  // (a) the pass is paused in its serving reconciliation while the ledger already names v2; then it does not adopt v2
  let b = await box({ left: 400 });
  await b.pass();
  setRow(A, { appRef: ref2 });
  const g = gate(); S.ensureGate = g.p; S.adopt = false;
  const p = b.pass();
  await sleep(100);                                     // the pass waits inside ensureApp
  skew += 200_000;                                      // 200 s left: due
  await b.h.renewDue();
  assert.equal(renews().length, 0, "renewed while the pass reconciles a version it does not serve yet");
  g.open(); await p; S.ensureGate = null;
  for (let i = 0; i < 2; i++) await keep(b, 10);
  assert.equal(renews().length, 0, "renewed on a row whose version this box does not serve");
  // (b) control: once the pass SERVES v2, the keeper renews it
  b = await box({ left: 400 });
  await b.pass();
  setRow(A, { appRef: ref2 });
  await b.pass();                                       // adopts v2 (ensureApp records it), 400 s left
  assert.equal(b.h.records.get(A).appRef, ref2);
  const r = await keep(b, 200);
  assert.deepEqual(r.renewed, [A], JSON.stringify(r));
  // (c) a caught edit failure in this pass publishes nothing: only the pass renews it
  b = await box({ left: 400 });
  b.h.envelopeVerdict = () => { throw new Error("edit failed"); };
  await b.pass();
  assert.ok(b.logs.some((l) => /config edit .*edit failed/.test(l)), b.logs.join("\n"));
  for (let i = 0; i < 4; i++) await keep(b, 50);
  assert.equal(renews().length, 0, "renewed after a caught edit failure");
});

test("READINESS: a ready row also means reconciled and keeper-eligible for exactly this served lease and identity", { timeout: 30_000 }, async () => {
  // control: an ordinary pass is ready, and the keeper renews it between passes
  let b = await box({ left: 400 });
  await b.pass();
  assert.equal(b.ready(), "ready");
  // a caught envelope-edit failure: not ready (nor keeper-eligible); once the edit applies, ready again
  b = await box({ left: 400 });
  const verdict = b.h.envelopeVerdict.bind(b.h);
  b.h.envelopeVerdict = () => { throw new Error("edit failed"); };
  await b.pass();
  assert.equal(b.ready(), "not-ready", "ready after a caught edit failure");
  b.h.envelopeVerdict = verdict;
  await b.pass();
  assert.equal(b.ready(), "ready");
  // a caught resize failure: not ready
  b = await box({ left: 400 });
  b.h.records.set(A, { ...b.h.records.get(A), servedCpuShare: 0.05, servedGpuShare: 0 });   // the owner resized it
  b.h.capacity = () => { throw new Error("capacity unreadable"); };
  await b.pass();
  assert.ok(b.logs.some((l) => /resize .*capacity unreadable/.test(l)), b.logs.join("\n"));
  assert.equal(b.ready(), "not-ready", "ready after a caught resize failure");
  // an identity this box does not serve (the ledger names v2, the running domain is v1): not ready; once served, ready
  b = await box({ left: 400 });
  await b.pass();
  setRow(A, { appRef: ref2 }); S.adopt = false;
  await b.pass();
  assert.equal(b.ready(), "not-ready", "ready while serving another version than the ledger names");
  S.adopt = true;
  await b.pass();
  assert.equal(b.h.records.get(A).appRef, ref2);
  assert.equal(b.ready(), "ready");
  assert.equal(renews().length, 0, "none of this was due");
});

test("REVIEW 2: a hold, stop, ban or suspension arriving during the deferred lead read or while queued voids the renewal", { timeout: 30_000 }, async () => {
  const lateLead = async (arrive) => {
    const b = await box({ left: 700 });
    await b.pass();                                     // 700 s left: the lead is read (and cached for 5 minutes)
    skew += 500_000;                                    // 200 s left: the cache is stale, the keeper reads the lead again
    const g = gate(); S.leadGate = g.p;
    const k = b.h.renewDue();
    await sleep(100);
    assert.equal(S.leadCalls, 2, "the keeper waits in its lead read");
    await arrive(b);
    S.leadGate = null; g.open();
    const r = await k;
    return { b, r };
  };
  // the platform suspends this host
  let { b, r } = await lateLead(async () => { S.suspended = "suspended by the platform administrator"; });
  assert.equal(renews().length, 0, JSON.stringify(r)); assert.deepEqual(r.renewed, []);
  // a pass meets an UNKNOWN host wallet policy and holds it
  ({ b, r } = await lateLead(async (b) => { b.answer = UNKNOWN; await b.pass(); }));
  assert.equal(renews().length, 0, JSON.stringify(r));
  // a pass meets a wallet BAN and gives it up: its release waits for the keeper's attempt in flight, then goes
  ({ b, r } = await lateLead(async (b) => { b.answer = REFUSE; b.giving = b.pass(); await sleep(150);
    assert.equal(S.calls.filter((c) => c.fn === "release").length, 0, "released while a renewal of it was in flight"); }));
  await b.giving;
  assert.equal(renews().length, 0, JSON.stringify(r));
  assert.equal(S.calls.filter((c) => c.fn === "release").length, 1, "given back once, after the keeper's attempt");
  // the owner stops it on the ledger and a pass stops it here
  ({ b, r } = await lateLead(async (b) => { setRow(A, { active: false }); await b.pass(); }));
  assert.equal(renews().length, 0, JSON.stringify(r));
  assert.equal(b.h.records.get(A).status, "stopped");
  // THE PASS's own permit: a wallet refusal (the grant refresher) arrives while its renewal waits in the deferred lead read
  b = await box({ left: 700 });
  await b.pass();
  skew += 500_000;
  let g = gate(); S.leadGate = g.p;
  const p = b.pass();
  await sleep(150);
  assert.equal(S.leadCalls, 2, "the pass waits in its lead read");
  b.answer = REFUSE; skew += 45_000;                    // the published allow is now inside the refresher's lead
  const rr = await b.h.walletRefresh();
  assert.deepEqual(rr.refused, [A], JSON.stringify(rr));
  S.leadGate = null; g.open(); await p;
  assert.equal(renews().length, 0, "the pass renewed on a permit a refusal had voided");
  assert.ok(b.logs.some((l) => /renewal withdrawn before its send: a hold, stop or wallet withdrawal/.test(l)), b.logs.join("\n"));
  assert.equal(b.ready(), "not-ready");
  // QUEUED at the send: another deployment's renewal holds the operator's queue; the suspension arrives meanwhile
  b = await box({ left: 400, ids: [A, B] });
  await b.pass();
  skew += 200_000; S.renewMs = 400;
  const other = chain.renewDeployment(B);               // occupies chain.mjs's one send queue
  await sleep(50);
  const k = b.h.renewDue();                             // A's (and B's) keeper attempts queue behind it
  await sleep(100);
  S.suspended = "suspended by the platform administrator";
  await other; r = await k;
  assert.equal(renews(A).length, 0, `A was sent after its permit was void (${JSON.stringify(S.calls)})`);
  assert.equal(operatorTx(), 0);
});

test("REVIEW 3: a renewal that hangs and then times out is never overlapped; it is retried after its pause, once", { timeout: 30_000 }, async () => {
  const b = await box({ left: 400 });
  await b.pass();
  skew += 150_000;                                      // 250 s left
  S.renewMs = 1500; S.fail = "no relay landed the renew: timeout";
  const k1 = b.h.renewDue();
  await sleep(200);
  const k2 = await keep(b);                             // the next round: it is in flight
  assert.deepEqual(k2.renewed, []); assert.equal(renews().length, 1);
  const t = b.pass();                                   // the pass joins the one in flight rather than sending again
  const r1 = await k1; await t;
  assert.deepEqual(r1.failed, [A]);
  assert.equal(renews().length, 1, "no attempt overlapped the hanging one");
  assert.equal(b.ready(), "not-ready", "the joined attempt failed");
  S.renewMs = 0;
  await keep(b); assert.equal(renews().length, 1, "inside its 60-s pause");
  await keep(b, 40);
  assert.equal(renews().length, 2); assert.ok(renews()[1].ok);
  assert.ok(renews()[1].realStart >= renews()[0].realEnd, "the retry started only after the first settled");
  assert.equal(S.maxInflight, 1); assert.equal(operatorTx(), 0);
});

test("never renewed by the keeper: suspension, wallet ban or unknown, transfer, stop, private, another runner, a wallet hold, a pending release", { timeout: 60_000 }, async () => {
  const variants = {
    suspended: () => { S.suspended = "suspended by the platform administrator"; },
    "wallet ban": (b) => { b.answer = REFUSE; },
    "wallet unknown": (b) => { b.answer = UNKNOWN; },
    transfer: () => setRow(A, { owner: "0x" + "99".repeat(20) }),
    "stopped on the ledger": () => setRow(A, { active: false }),
    "made private": () => setRow(A, { isPublic: false }),
    "a new version not served yet": () => setRow(A, { appRef: ref2 }),
    "a new config not applied yet": () => setRow(A, { configCid: '{"waf":{}}' }),
    "another runner": () => setRow(A, { runner: "0x" + "77".repeat(32) }),
    "wallet held": (b) => b.h.records.set(A, { ...b.h.records.get(A), walletHeld: true }),
  };
  for (const [name, apply] of Object.entries(variants)) {
    const b = await box({ left: 400 });
    await b.pass();
    apply(b);
    for (let i = 0; i < 6; i++) await keep(b);
    assert.equal(renews().length, 0, `${name}: ${JSON.stringify(renews())}`);
    assert.equal(operatorTx(), 0, name);
  }
  // a sponsored release of it that may still land (the shipped journal): held for every lease operation
  const b = await box({ left: 400 });
  await b.pass();
  const j = path.join(b.dir, "pending-release.json"), journal = openReleaseJournal(j);
  journal.begin(A);
  journal.signed(A, { payee: "0x" + "33".repeat(20), nonce: 1n, deadline: 9999999999n, kind: "release", lease: { enclaveId: runner, maxChargeWei: 1n }, fromBlock: 1n,
    operator: chain.operatorAddress(), chainId: 8453, reserve: "0x" + "44".repeat(20), executor: "0x" + "55".repeat(20), ledger: DEPLOYMENTS });
  chain.setLeaseJournal(j);
  for (let i = 0; i < 6; i++) await keep(b);
  assert.equal(renews().length, 0, "renewed with a sponsored release pending");
});

test("an expired lease: the keeper never renews or claims it; the pass retires it; quorum failures retry boundedly, never the operator's ETH", { timeout: 30_000 }, async () => {
  const b = await box({ left: 400 });
  await b.pass();
  S.down = true;                                        // the lease-gas quorum never answers again in this window
  for (let t = 30; t <= 480; t += 30) await keep(b);
  const tries = renews().length;
  assert.ok(tries >= 3 && tries <= 6, `bounded retries inside a 285-s window (${tries})`);
  assert.ok(renews().every((c) => c.start < S.until[A.toLowerCase()] * 1000), "no attempt after the lease expired");
  S.down = false;                                       // the RPCs answer again, after the lease expired
  for (let i = 0; i < 3; i++) await keep(b);
  assert.equal(renews().length, tries, "nothing for an expired lease");
  await b.pass();
  assert.equal(b.h.records.get(A).status, "stopped");
  assert.match(b.h.records.get(A).reason, /the lease expired; a new claim must pass the current funding and hosting policy/);
  assert.equal(S.calls.filter((c) => c.fn !== "renew").length, 0, "no claim and no release");
  assert.equal(operatorTx(), 0, "never this host's ETH");
  assert.ok(b.logs.filter((l) => /renew failed/.test(l)).every((l) => l.includes(QUORUM)), b.logs.join("\n"));
});

test("the window's lead is read once per lease per 5 minutes, not on every pass", { timeout: 30_000 }, async () => {
  const b = await box({ left: 840 });
  for (let t = 0; t <= 540; t += 30) { await b.pass(); skew += 30_000; }   // a fast pass, every 30 s, from 14 min left
  assert.ok(S.leadCalls <= 2, `${S.leadCalls} verified-authority lead reads (the installed host: one per pass)`);
  assert.equal(renews().length, 0, "not yet due");
});

test("a new process renews nothing before its own pass has served the row", { timeout: 30_000 }, async () => {
  const b = await box({ left: 250 });
  for (let i = 0; i < 3; i++) await keep(b, 10);
  assert.equal(renews().length, 0);
  await b.pass();                                       // its own pass renews (due)
  assert.equal(renews().length, 1); assert.equal(b.ready(), "ready");
});

// SERVING FIRST (windows-serving-first): the pass reconciles what this box already serves BEFORE its queued-claim sweep
// (scanLedger: a claim's gate, send and launch), so a slow sweep cannot delay an existing app's authorization, readiness or
// keeper eligibility. The sweep is replaced by a gated one; everything else is the real pass.
const until = async (what, cond, ms = 5000) => { const end = realNow() + ms; while (!cond()) { if (realNow() > end) throw new Error(`timed out: ${what}`); await sleep(5); } };
const slowSweep = (b, also = async () => {}) => {
  const g = gate(), st = { started: false, done: false };
  b.h.scanLedger = async () => { st.started = true; await g.p; await also(); st.done = true; };
  return Object.assign(st, { open: g.open });
};

test("SERVING FIRST: a slow queued-claim sweep cannot delay an existing served app's readiness or its keeper renewal", { timeout: 30_000 }, async () => {
  const b = await box({ left: 400 });
  const sw = slowSweep(b);
  const pass = b.pass();
  await until("the sweep started", () => sw.started);
  assert.equal(b.h.leaseReadiness().inFlight, true, "the pass is still running (blocked in the sweep)");
  assert.equal(b.ready(), "ready", "the existing app reads ready while the claim sweep is still blocked");
  const r = await keep(b, 150);                        // inside the 285-s window now, the sweep still blocked
  assert.deepEqual(r.renewed, [A], `keeper renewed during the blocked sweep: ${JSON.stringify(r)}`);
  assert.equal(renews().length, 1); assert.equal(operatorTx(), 0, "never this host's ETH");
  sw.open(); await pass;
  assert.ok(sw.done); assert.equal(b.ready(), "ready");
});

test("SERVING FIRST: what the sweep resumes is reconciled in the same pass; a tracked re-claim waits until after the sweep", { timeout: 30_000 }, async () => {
  const C = "0x" + "c3".repeat(32);
  const b = await box({ ids: [A, B, C], left: 400 });
  setRow(B, { runner: "0x" + "00".repeat(32) });      // B: tracked, but this box no longer holds it (unclaimed): a re-claim
  b.h.tracked.delete(C);                               // C: a live lease of this box it no longer tracks; the sweep resumes it
  const order = [];
  b.h.consider = async (id) => { order.push({ id, afterSweep: sw.done }); return { accepted: false }; };
  const sw = slowSweep(b, async () => { b.h.tracked.add(C); });
  const pass = b.pass();
  await until("the sweep started", () => sw.started);
  assert.equal(b.ready(A), "ready", "A ready before the sweep finished");
  assert.deepEqual(order, [], "no re-claim before the sweep (it would delay the apps after it)");
  sw.open(); await pass;
  assert.deepEqual(order, [{ id: B, afterSweep: true }], "the deferred re-claim ran once, after the sweep, on a fresh row");
  assert.equal(b.ready(C), "ready", "the lease the sweep resumed was reconciled in the same pass");
  assert.notEqual(b.ready(B), "ready");
});

test("SERVING FIRST: a wallet refusal or unknown, a transfer and a suspension still block while the sweep is slow", { timeout: 60_000 }, async () => {
  const variants = {
    "wallet ban": (b) => { b.answer = REFUSE; },
    "wallet unknown": (b) => { b.answer = UNKNOWN; },
    "transfer to an owner this box does not serve": () => setRow(A, { owner: "0x" + "99".repeat(20) }),
    suspended: () => { S.suspended = "suspended by the platform administrator"; },
  };
  for (const [name, apply] of Object.entries(variants)) {
    const b = await box({ left: 400 });
    apply(b);
    const sw = slowSweep(b);
    const pass = b.pass();
    await until(`${name}: the sweep started`, () => sw.started);
    assert.notEqual(b.ready(), "ready", `${name}: ready while refused`);
    await keep(b, 150);
    assert.equal(renews().length, 0, `${name}: renewed while refused: ${JSON.stringify(renews())}`);
    sw.open(); await pass;
    assert.notEqual(b.ready(), "ready", name);
    for (let i = 0; i < 3; i++) await keep(b);
    assert.equal(renews().length, 0, name); assert.equal(operatorTx(), 0, name);
  }
});
