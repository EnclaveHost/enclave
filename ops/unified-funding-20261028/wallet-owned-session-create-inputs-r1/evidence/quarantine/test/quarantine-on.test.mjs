// relay-quarantine-r1, QUARANTINE mode. The flag is set BEFORE the module is first loaded (the dynamic imports below), as
// the relay's own startup does. node --test gives this file its own process, so the default-mode files are unaffected.
// Fixtures: relay-owner-r2's fake chain and the activation-r1 owner-controls wiring (as in test/activation.test.mjs).
// NOT RUN by the author (source-only task).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOOD_SIG, T, makeWorld, manifestOf } from "../../relay-owner-r2/test/fake-chain.mjs";

process.env.SESSIONS_WRITE_QUARANTINE = "1";
const S = await import("../generated/relay/sessions.mjs");
const { OWNER_MANIFEST_SCHEMA, OWNER_PIN_KEYS } = await import("../generated/relay/funding-route.mjs");
const { loadFundingActivation } = await import("../generated/relay/funding-activation.mjs");
const { getAddress } = await import("../generated/node_modules/viem/_esm/index.js");
const { privateKeyToAccount } = await import("../generated/node_modules/viem/_esm/accounts/index.js");

const OWNER = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";
const RELAYER = "0x3333333333333333333333333333333333333333";
const FACTORY = "0x4444444444444444444444444444444444444444";
const H = (b) => "0x" + b.repeat(32);
const SID = H("ab");
const NOW = 1_900_000_000;
const MARKER = "BODY-MARKER-must-not-appear-in-status";
const err = (p) => p.then((v) => assert.fail(`expected a refusal, got ${String(v)}`), (e) => e);
const snap = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const refused = (e, what) => { assert.equal(e?.status, 503, `${what}: ${e?.message}`); assert.equal(e.code, "write_quarantine", what); };

const DIR = realpathSync(mkdtempSync(join(tmpdir(), "relay-quarantine-r1-")));
after(() => rmSync(DIR, { recursive: true, force: true }));
let files = 0;
const writeJson = (o) => { const p = join(DIR, `f${++files}.json`); writeFileSync(p, JSON.stringify(o), { mode: 0o600 }); return p; };

/** Records every CALL (property reads are not RPC); an unscripted call is recorded and rejected. */
function countingPc(inner = {}) {
  const calls = [];
  const pc = new Proxy(inner, { get(t, k) {
    const v = t[k];
    if (typeof k !== "string" || k === "then" || (v !== undefined && typeof v !== "function")) return v;
    return (...a) => { calls.push(k); return typeof v === "function" ? v.apply(t, a) : Promise.reject(new Error(`unscripted RPC ${k}`)); };
  } });
  return { pc, calls };
}

function bareService({ journalData = { txs: [] }, storeData = {} } = {}) {
  const { pc, calls } = countingPc();
  const wcCalls = [];
  const wc = { chain: { id: 8453 }, async sendTransaction() { wcCalls.push("sendTransaction"); return H("99"); } };
  const writes = { store: 0, journal: 0 };
  const store = { data: storeData, saveSoon() { writes.store++; }, flush() { writes.store++; } };
  const journal = { data: journalData, saveSoon() { writes.journal++; }, flush() { writes.journal++; } };
  const account = { address: RELAYER, async signTransaction() { wcCalls.push("signTransaction"); return "0x02"; } };
  const svc = S.createSessionsService({ pc, wc, account, chainId: 8453, factory: FACTORY, store, journal,
    log: () => {}, alert: () => {}, now: () => NOW });
  return { svc, calls, base: calls.length, wcCalls, writes, store, journal };
}

const BODY = { owner: OWNER, vault: VAULT, sid: SID, op: "terminate", sig: "0x", action: 1, fee: "1000000000", deadline: String(NOW + 60),
  args: { sessionId: SID, opNonce: H("05"), signBefore: String(NOW + 60), amount: "1", withdraw: true }, x: "1", y: "2", r: H("0e"), s: H("0f"),
  label: MARKER, evidence: { type: "sev-snp", report: "0x00" } };
const WRITES = [["POST", "/attest"], ["POST", "/quote"], ["POST", "/execute"], ["POST", "/open"], ["POST", "/owner"], ["POST", "/end"],
  ["POST", "/funding/quote"], ["POST", "/funding/execute"], ["POST", "/funding/open"], ["POST", "/funding/owner"], ["POST", "/funding/end"],
  ["POST", "/no-such-route"], ["PUT", "/owner"], ["DELETE", "/funding/owner"], ["PATCH", "/end"]];

test("quarantine: the flag was read once at load, is frozen, and cannot be lifted by env changes or assignment", async () => {
  assert.deepEqual({ ...S.WRITE_QUARANTINE }, { on: true, value: "1" });
  assert.ok(Object.isFrozen(S.WRITE_QUARANTINE));
  assert.throws(() => { S.WRITE_QUARANTINE.on = false; }, TypeError);
  assert.throws(() => { S.WRITE_QUARANTINE = { on: false }; }, TypeError);
  process.env.SESSIONS_WRITE_QUARANTINE = "0";
  try {
    assert.equal(S.WRITE_QUARANTINE.on, true);
    const x = bareService();
    refused(await err(x.svc.route("POST", "/owner", BODY)), "a service made after the env change");
  } finally { process.env.SESSIONS_WRITE_QUARANTINE = "1"; }
});

test("quarantine: EVERY write route (legacy, successor, attestor, quote, unknown, any non-GET method) is 503 before any RPC or state change", async () => {
  const storeData = { sessions: { [SID]: { vault: VAULT, keyHash: H("00"), expiresAt: NOW + 600 } }, vaults: { [VAULT]: OWNER } };
  const x = bareService({ storeData });
  const store0 = snap(x.store.data), journal0 = snap(x.journal.data);
  for (const [m, p] of WRITES) {
    refused(await err(x.svc.route(m, p, structuredClone(BODY))), `${m} ${p}`);
    assert.equal(x.calls.length, x.base, `${m} ${p}: no RPC (no read, simulation, estimate or nonce)`);
  }
  assert.equal(snap(x.store.data), store0, "no index, revocation, revokedVaults, quota or funding state changed");
  assert.equal(snap(x.journal.data), journal0, "no journal record or intent");
  assert.deepEqual(x.wcCalls, []);
  assert.deepEqual(x.writes, { store: 0, journal: 0 });
  // the same through the module's HTTP adapter (the path api-relay.js handleSessions uses)
  for (const p of ["/v1/sessions/owner", "/v1/sessions/funding/owner", "/v1/sessions/attest"]) {
    const res = {};
    await x.svc.handle({ method: "POST" }, res, new URL(`http://relay${p}`),
      { readBody: async () => Buffer.from(JSON.stringify(BODY)), json: (r, code, obj) => Object.assign(r, { code, obj }) });
    assert.equal(res.code, 503, p);
    assert.equal(res.obj.code, "write_quarantine", p);
  }
  assert.equal(x.calls.length, x.base);
  // reads are unchanged
  assert.equal((await x.svc.route("GET", "/config")).relayer, RELAYER);
  assert.equal((await x.svc.route("GET", `/by-key/${H("00")}`)).sessions[0].sid, SID);
  const st = await x.svc.route("GET", "/quarantine");
  assert.equal(st.writeQuarantine, true);
  assert.ok(st.refused.route >= WRITES.length + 3);
  assert.equal(snap(st).includes(MARKER), false, "the status carries no request data");
});

test("quarantine: the keeper admits nothing (no read, no mark, no send)", async () => {
  const x = bareService({ storeData: { sessions: { [SID]: { vault: VAULT, expiresAt: NOW - 10, ended: false } } } });
  const before = (await x.svc.route("GET", "/quarantine")).refused.keeper;
  await x.svc.keeperOnce();
  assert.equal(x.calls.length, x.base);
  assert.equal(x.store.data.sessions[SID].ended, false);
  assert.equal((await x.svc.route("GET", "/quarantine")).refused.keeper, before + 1);
});

test("quarantine: with an unresolved journal record and a reserved intent (pending preflight), every queue entry refuses before nonce, estimate or reconcile", async () => {
  const journalData = { txs: [{ label: "withdraw 0x222222", to: VAULT, nonce: 7, hashes: [H("aa")], status: "sent", at: 1 }],
    intents: { k1: { kind: "owner", meta: {}, status: "reserved", gen: 1, boot: "earlier", at: 1 } } };
  const x = bareService({ journalData });
  const j0 = snap(x.journal.data);
  refused(await err(x.svc.queue.send({ to: VAULT, data: "0x", label: "plain" })), "send");
  refused(await err(x.svc.queue.send({ to: VAULT, data: "0x", label: "intent", intent: "k1" })), "send with intent");
  refused(await err(x.svc.queue.send({ to: VAULT, data: "0x", label: "enveloped", envelope: {} })), "send with envelope");
  refused(await err(x.svc.queue._send({ to: VAULT, data: "0x", label: "inner" })), "_send directly");
  assert.equal(x.calls.length, x.base, "no getTransactionCount, estimateGas, getBlock or getTransactionReceipt");
  assert.equal(snap(x.journal.data), j0);
  assert.deepEqual(x.wcCalls, []);
  const st = await x.svc.route("GET", "/quarantine");
  assert.ok(st.refused.queue >= 3 && st.refused.queue_inner >= 1);
  assert.deepEqual(st.journal.atBoot, { records: 1, maxNonce: 7, unresolved: 1, intents: 1 });
  assert.deepEqual(st.journal.now, st.journal.atBoot);
  assert.equal(snap(st).includes(H("aa").slice(2)), false, "no hash in the status");
});

test("quarantine: the queue's wallet client and the relayer account keep their data; every method refuses; neither can be swapped back", () => {
  const calls = [];
  const wc = { chain: { id: 8453 },
    async sendTransaction() { calls.push("wc.sendTransaction"); return H("01"); },
    async signTransaction() { calls.push("wc.signTransaction"); return "0x02"; },
    async writeContract() { calls.push("wc.writeContract"); return H("03"); },
    async request() { calls.push("wc.request"); return null; } };
  const account = { address: RELAYER, type: "local",
    async signTransaction() { calls.push("account.signTransaction"); return "0x02"; },
    async signMessage() { calls.push("account.signMessage"); return "0x03"; } };
  const svc = S.createSessionsService({ pc: countingPc().pc, wc, account, chainId: 8453, factory: FACTORY,
    store: { data: {}, saveSoon() {}, flush() {} }, journal: { data: { txs: [] }, saveSoon() {}, flush() {} },
    log: () => {}, alert: () => {}, now: () => NOW });
  const solo = new S.TxQueue({ pc: {}, wc, account, journal: { data: { txs: [] }, flush() {}, saveSoon() {} } });
  for (const q of [svc.queue, solo]) {
    assert.equal(q.wc.chain.id, 8453);
    assert.equal(q.account.address, RELAYER);
    assert.equal(q.account.type, "local");
    for (const m of ["sendTransaction", "signTransaction", "writeContract", "request"])
      assert.throws(() => q.wc[m]({}), { code: "write_quarantine" }, `wc.${m}`);
    for (const m of ["signTransaction", "signMessage"]) assert.throws(() => q.account[m]({}), { code: "write_quarantine" }, `account.${m}`);
    assert.throws(() => { q.wc = wc; }, TypeError);
    assert.throws(() => { q.account = account; }, TypeError);
  }
  assert.equal(svc.account.address, RELAYER);
  assert.throws(() => svc.account.signTransaction({}), { code: "write_quarantine" });
  assert.deepEqual(calls, []);
});

test("quarantine: the relayer journal is sealed: flush / saveSoon (the store timer's and exit hook's path) never rewrite the file", async () => {
  // a file-backed store that writes on flush, like relay/store.js JsonStore (atomic write omitted)
  class FileStore {
    constructor(file, initial) { this.file = file; this.data = { ...initial, ...JSON.parse(readFileSync(file, "utf8")) }; }
    saveSoon() { this.flush(); }
    flush() { writeFileSync(this.file, JSON.stringify(this.data)); }
  }
  const file = join(DIR, "sessions-relayer.json");
  writeFileSync(file, JSON.stringify({ txs: [{ label: "old writer", to: VAULT, nonce: 9, hashes: [H("bb")], status: "sent", at: 1 }] }));
  const journal = new FileStore(file, { txs: [] });
  const svc = S.createSessionsService({ pc: countingPc().pc, wc: { chain: { id: 8453 } }, account: { address: RELAYER }, chainId: 8453,
    factory: FACTORY, store: { data: {}, saveSoon() {}, flush() {} }, journal, log: () => {}, alert: () => {}, now: () => NOW });
  const h0 = sha(readFileSync(file));
  refused(await err(svc.queue.send({ to: VAULT, data: "0x", label: "x" })), "send");
  journal.flush();      // what JsonStore's SIGTERM / SIGINT hook does to every store
  journal.saveSoon();
  assert.equal(sha(readFileSync(file)), h0, "the quarantined process left the journal file byte-identical");
  writeFileSync(file, JSON.stringify({ txs: [], reconciledByRoot: true }));   // the root reconciles the old writer meanwhile
  const h1 = sha(readFileSync(file));
  journal.flush();
  assert.equal(sha(readFileSync(file)), h1, "a later exit does not overwrite the root's reconciled journal");
  assert.throws(() => { journal.flush = FileStore.prototype.flush; }, TypeError);
  const st = await svc.route("GET", "/quarantine");
  assert.equal(st.journal.persisted, false);
  assert.ok(st.journal.writesSuppressed >= 3);
});

// ---- successor owner controls ON (the activation-r1 rollback state), quarantined ----------------------------------------
function ownerManifestOf(w) {
  const m = manifestOf(w);
  const pick = (o) => Object.fromEntries(OWNER_PIN_KEYS.map((k) => [k, o[k]]));
  return { schema: OWNER_MANIFEST_SCHEMA, chainId: 8453, maxBlockAgeSec: 60, addresses: pick(m.addresses), codehashes: pick(m.codehashes) };
}
function fundingWorld() {
  const w = makeWorld();
  const clock = { t: T };
  const env = { SESSIONS_FUNDING_OWNER_CONTROLS: "1", SESSIONS_FUNDING_OWNER_MANIFEST: writeJson(ownerManifestOf(w)),
    SESSIONS_FUNDING_MANIFEST: writeJson(manifestOf(w)), SESSIONS_FUNDING_RELAYER: w.relayer };
  const r = loadFundingActivation(env, { netName: "base", chainId: 8453, relayer: w.relayer, now: () => clock.t, log: () => {},
    request: async (a) => { throw new Error(`no fee-policy read expected with intake off (${a?.method})`); } });
  assert.equal(r.status.ownerControls.on, true, r.status.ownerControls.why);
  const sends = [];
  const { pc, calls } = countingPc({
    readContract: (a) => w.pc.readContract(a),
    simulateContract: (a) => w.pc.simulateContract({ ...a, account: a.account?.address ?? a.account }),
    getCode: (a) => w.pc.getCode(a),
    getChainId: () => w.pc.getChainId(),
    getBalance: async () => 10n ** 18n,
    getBlock: (a) => w.pc.getBlock(a),
  });
  const wc = { chain: { id: 8453 }, async sendTransaction(q) { sends.push(q); return H("cd"); } };
  const store = { data: {}, saveSoon() {}, flush() {} };
  const journal = { data: { txs: [] }, saveSoon() {}, flush() {} };
  const svc = S.createSessionsService({ pc, wc, account: { address: w.relayer }, chainId: 8453, factory: FACTORY, store, journal,
    log: () => {}, alert: () => {}, now: () => clock.t, funding: manifestOf(w), ...r.options });
  return { w, clock, svc, store, journal, sends, calls };
}

test("quarantine with successor owner controls ON: owner writes are 503 maintenance (no revocation, no intent, no send); owner views still answer", async () => {
  const x = fundingWorld();
  const base = x.calls.length;
  const store0 = snap(x.store.data), journal0 = snap(x.journal.data);
  for (const [op, args] of [["terminate", { sessionId: x.w.sid }], ["revokeAll", { withdraw: false }], ["withdraw", { amount: "1" }]]) {
    const e = await err(x.svc.route("POST", "/funding/owner", { owner: x.w.owner, vault: x.w.vault, op,
      args: { ...args, opNonce: H("23"), signBefore: String(x.clock.t + 600) }, sig: GOOD_SIG }));
    refused(e, `/funding/owner ${op}`);
    assert.match(e.message, /maintenance/);
  }
  refused(await err(x.svc.route("POST", "/funding/end", { vault: x.w.vault, sid: x.w.sid, deadline: String(T + 60), x: "11", y: "12",
    r: H("0e"), s: H("0f") })), "/funding/end");
  assert.equal(x.calls.length, base, "no pin read, simulation or nonce for a refused owner write");
  assert.equal(snap(x.store.data), store0);
  assert.equal(x.store.data.revoked?.[x.w.sid], undefined, "no off-chain revocation before the chain");
  assert.equal(snap(x.journal.data), journal0, "no intent reserved, no record journaled");
  assert.equal(x.sends.length, 0);
  // the owner-control READS stay on (pins re-proven per request, read-only)
  assert.equal((await x.svc.route("GET", `/funding/owner/${x.w.owner}`)).vault, x.w.vault);
  assert.equal((await x.svc.route("GET", `/funding/session/${x.w.vault}/${x.w.sid}`)).vault, x.w.vault);
  assert.equal(x.sends.length, 0);
  assert.equal(snap(x.journal.data), journal0);
});

test("quarantine via the ACTUAL initSessions: writes refused, real viem wallet and account disarmed, journal store sealed, status leaks no key", async () => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("SESSIONS_") && k !== "SESSIONS_WRITE_QUARANTINE") delete process.env[k];
  const key = `0x${randomBytes(32).toString("hex")}`;              // a throwaway key; it never signs anything here
  const relayer = privateKeyToAccount(key).address;
  const stores = new Map();
  class MemStore {
    constructor(p, init) { this.data = structuredClone(init); this.writes = 0; stores.set(p.split("/").pop(), this); }
    saveSoon() { this.writes++; }
    flush() { this.writes++; }
  }
  try {
    // a closed loopback port: the balance probe fails locally, nothing leaves the host
    Object.assign(process.env, { SESSIONS_RELAYER_KEY: key, SESSIONS_NETWORK: "base", SESSIONS_RPC: "http://127.0.0.1:9", SESSIONS_FACTORY: FACTORY });
    const svc = await S.initSessions({ dataDir: DIR, JsonStore: MemStore });
    assert.ok(svc);
    const cfg = await svc.route("GET", "/config");
    assert.equal(cfg.relayer, relayer);
    assert.equal(cfg.factory, getAddress(FACTORY));
    for (const [m, p] of WRITES) refused(await err(svc.route(m, p, structuredClone(BODY))), `${m} ${p}`);
    for (const m of ["sendTransaction", "signTransaction", "writeContract", "deployContract", "signMessage", "signTypedData", "request"])
      assert.throws(() => svc.queue.wc[m]({}), { code: "write_quarantine" }, `viem wallet client ${m}`);
    for (const a of [svc.queue.account, svc.account])
      for (const m of ["signTransaction", "signMessage", "signTypedData"]) assert.throws(() => a[m]({}), { code: "write_quarantine" }, `account ${m}`);
    assert.equal(svc.account.address, relayer);
    assert.equal(svc.queue.wc.chain.id, 8453);
    refused(await err(svc.queue.send({ to: VAULT, data: "0x", label: "x" })), "queue.send");
    await svc.keeperOnce();
    const j = stores.get("sessions-relayer.json");
    assert.ok(j, "the journal store was opened");
    j.flush(); j.saveSoon();
    assert.equal(j.writes, 0, "the journal store's own write path was never reached");
    assert.deepEqual(j.data.txs, []);
    const st = await svc.route("GET", "/quarantine");
    const text = snap(st);
    assert.equal(text.includes(key.slice(2)), false, "no key material");
    assert.equal(text.includes(MARKER), false, "no request data");
    assert.equal(st.journal.persisted, false);
    assert.deepEqual(st.journal.now, st.journal.atBoot);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
