// activation-r1: the ACTUAL composed host (initSessions / createSessionsService -> funding route -> simulateAndSend -> the
// ONE TxQueue, all from generated/relay/, written by prepare.py) with the ACTUAL activation loader and the ACTUAL v2 fee
// policy (createGasFundQuotePolicy). Chain answers are SCRIPTED: relay-owner-r2's fake chain for the successor contracts
// (its vault accepts GOOD_SIG by script; no signature is verified anywhere here and nothing below claims one is) and
// fee-policy-r1's scripted EIP-1193 oracle/feed for the policy. No EVM, no network (initSessions is pointed at a closed
// loopback port), no real key. Only the queue's TIMING is shortened on the live service object. Run `python3 prepare.py` first.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionsService, initSessions } from "../generated/relay/sessions.mjs";
import { OWNER_MANIFEST_SCHEMA, OWNER_PIN_KEYS, encodeIntent } from "../generated/relay/funding-route.mjs";
import { QUOTE_POLICY_INTERFACE } from "../generated/relay/fee-policy.mjs";
import { fundingSessionVaultAbi } from "../generated/relay/funding-abi.mjs";
import { DEV_ACCOUNTS, MAX_CONFIG_BYTES, loadFundingActivation, readBoundedJsonFile } from "../generated/relay/funding-activation.mjs";
import { getAddress, toHex } from "../generated/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "../generated/node_modules/viem/_esm/accounts/index.js";
import { GOOD_SIG, T, eventLog, makeWorld, manifestOf } from "../../relay-owner-r2/test/fake-chain.mjs";
import * as FP from "../../fee-policy-r1/test/fixture.mjs";

const ZERO32 = "0x" + "0".repeat(64);
const TX_BLOCK = 1001n;
const FACTORY = "0x4444444444444444444444444444444444444444";
const h32 = (t) => "0x" + createHash("sha256").update(String(t)).digest("hex");
const err = (p) => p.then((v) => assert.fail(`expected an error, got ${JSON.stringify(v, (_k, y) => (typeof y === "bigint" ? `${y}n` : y))}`), (e) => e);

const DIR = realpathSync(mkdtempSync(join(tmpdir(), "activation-r1-")));
after(() => rmSync(DIR, { recursive: true, force: true }));
let files = 0;
const writeRaw = (data) => { const p = join(DIR, `f${++files}.json`); writeFileSync(p, data, { mode: 0o600 }); return p; };
const writeJson = (o) => writeRaw(JSON.stringify(o));

function ownerManifestOf(w, { addresses = {}, codehashes = {}, ...over } = {}) {
  const m = manifestOf(w);
  const pick = (o, x) => ({ ...Object.fromEntries(OWNER_PIN_KEYS.map((k) => [k, o[k]])), ...x });
  return { schema: OWNER_MANIFEST_SCHEMA, chainId: 8453, maxBlockAgeSec: 60, addresses: pick(m.addresses, addresses),
    codehashes: pick(m.codehashes, codehashes), ...over };
}
/** The operator's env: every piece explicit. A string value is written verbatim (malformed-file cases). */
function envFor(w, { owner = ownerManifestOf(w), manifest = manifestOf(w), fee = FP.cfg(), ownerOn = true, intake = true, relayer = w.relayer } = {}) {
  const file = (v) => (typeof v === "string" ? writeRaw(v) : writeJson(v));
  return { ...(ownerOn ? { SESSIONS_FUNDING_OWNER_CONTROLS: "1", SESSIONS_FUNDING_OWNER_MANIFEST: file(owner) } : {}),
    ...(intake ? { SESSIONS_FUNDING_INTAKE: "1", SESSIONS_FUNDING_FEE_POLICY: file(fee) } : {}),
    SESSIONS_FUNDING_MANIFEST: file(manifest), SESSIONS_FUNDING_RELAYER: relayer };
}
const hostOf = (w, s, clock, over = {}) => ({ netName: "base", chainId: 8453, relayer: w.relayer, request: (a) => s.request(a),
  now: () => clock.t, log: () => {}, ...over });

/** fee-policy-r1's scripted oracle/feed, its header served at the ROUTE's pinned block (the fake chain's latest). */
function feeChain(w) {
  const s = FP.chain();
  const inner = s.request;
  s.request = async (a) => {
    if (a.method !== "eth_getBlockByNumber") return inner(a);
    s.log.push(a);
    assert.deepEqual(a.params, [toHex(w.block), false], "the policy reads the route's pinned block");
    return { number: toHex(w.block), hash: FP.BH, timestamp: toHex(w.timestamp), baseFeePerGas: toHex(5_000_000n) };
  };
  return s;
}

/** relay-owner-r2's fake contracts for reads/simulation; scripted sends and receipts for the host queue. */
function chainOf(w) {
  const s = { sends: [], sent: [], receipts: new Map(), blocks: new Map(), pendingNonce: 7, afterSend: null, n: 0 };
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
      const h = h32(`tx:${++s.n}`);
      s.sent.push(h);
      s.pendingNonce = Math.max(s.pendingNonce, Number(req.nonce) + 1);
      s.afterSend?.(h, req);
      return h;
    },
  };
  return { s, pc, wc };
}

/** The SAME service constructor initSessions uses; `act` is what the loader returned (spread after `funding`, as there). */
function service({ w = makeWorld(), act = {}, store, journal, clock = { t: T }, c = chainOf(w) } = {}) {
  store ??= { data: {}, saveSoon() {}, flush() {} };
  journal ??= { data: { txs: [] }, saveSoon() {}, flush() {} };
  const svc = createSessionsService({ pc: c.pc, wc: c.wc, account: { address: w.relayer }, chainId: 8453, factory: FACTORY,
    store, journal, log: () => {}, alert: () => {}, now: () => clock.t, funding: manifestOf(w), ...act });
  const q = { now: T * 1000 };
  Object.assign(svc.queue, { receiptTimeoutMs: 10, pollMs: 5, maxAttempts: 3, clock: () => q.now, sleep: async (ms) => { q.now += ms; } });
  return { ...c, c, w, svc, store, journal, clock };
}

function vaultLog(x, name) {
  const ev = fundingSessionVaultAbi.find((i) => i.type === "event" && i.name === name);
  const val = (i) => (i.name === "sid" ? x.w.sid : i.name === "reason" ? 1 : i.type.endsWith("]") ? [] : i.type === "bool" ? false
    : i.type === "address" ? x.w.owner : i.type === "bytes32" ? ZERO32 : i.type === "string" ? "" : i.type === "bytes" ? "0x" : 0n);
  return eventLog(fundingSessionVaultAbi, x.w.vault, name, Object.fromEntries(ev.inputs.map((i) => [i.name, val(i)])));
}
function canonicalOn(x, logs) {
  x.s.afterSend = (hash) => {
    const blockHash = h32(`block:${hash}`);
    x.s.receipts.set(hash, { transactionHash: hash, blockHash, blockNumber: TX_BLOCK, status: "success", from: x.w.relayer, to: x.w.vault,
      gasUsed: 21_000n, logs: logs.map((l, i) => ({ ...l, blockHash, blockNumber: TX_BLOCK, transactionHash: hash, logIndex: i, transactionIndex: 0, removed: false })) });
    x.s.blocks.set(String(TX_BLOCK), { number: TX_BLOCK, hash: blockHash, transactions: [hash] });
  };
}
const ownerOp = (x, op, n, args, logs = []) => {
  canonicalOn(x, logs);
  return x.svc.route("POST", "/funding/owner", { owner: x.w.owner, vault: x.w.vault, op,
    args: { ...args, opNonce: "0x" + n.repeat(32), signBefore: String(x.clock.t + 600) }, sig: GOOD_SIG });
};
const terminate = (x, n) => ownerOp(x, "terminate", n, { sessionId: x.w.sid }, [vaultLog(x, "SessionEnded")]);
const quoteBody = (w) => ({ vault: w.vault, sid: w.sid, deployment: w.deployment, ethOut: (10n ** 15n).toString(), feeTier: 500 });
const execBody = (w, over = {}) => ({ vault: w.vault, sid: w.sid, nonce: "0", action: 10, fee: "1000", deadline: String(T + 60),
  args: encodeIntent({ payer: w.vault, deployment: w.deployment, expectedOwner: w.vault, ethOut: 10n ** 15n, maxUsdcIn6: 3_100_000n, fee: 500, deadline: BigInt(T + 100) }),
  x: "11", y: "12", r: "0x" + "0e".repeat(32), s: "0x" + "0f".repeat(32), ...over });
const INTAKE_ROUTES = [["GET", "/funding/config"], ["POST", "/funding/quote"], ["POST", "/funding/execute"], ["POST", "/funding/open"]];

test("default OFF: no flag enables nothing (an intake manifest alone stays inert); every /funding/* is 503; original routes answer", async () => {
  const w = makeWorld();
  const s = feeChain(w);
  const h = hostOf(w, s, { t: T });
  assert.deepEqual(loadFundingActivation({}, h).options, {});
  const onlyFiles = { SESSIONS_FUNDING_MANIFEST: writeJson(manifestOf(w)), SESSIONS_FUNDING_FEE_POLICY: writeJson(FP.cfg()),
    SESSIONS_FUNDING_OWNER_MANIFEST: writeJson(ownerManifestOf(w)), SESSIONS_FUNDING_RELAYER: w.relayer };
  const r = loadFundingActivation(onlyFiles, h);
  assert.deepEqual(r.options, {}, "files without their flag enable nothing");
  assert.equal(r.status.intake.on, false);
  assert.equal(r.status.ownerControls.on, false);
  assert.equal(s.log.length, 0, "an OFF loader reads nothing from the chain");
  const x = service({ w, act: r.options });
  for (const [m, p] of [...INTAKE_ROUTES, ["POST", "/funding/owner"], ["POST", "/funding/end"], ["GET", `/funding/owner/${w.owner}`]]) {
    const e = await err(x.svc.route(m, p, {}));
    assert.equal(e.status, 503, `${m} ${p}`);
    assert.equal(e.code, "funding_disabled", `${m} ${p}`);
  }
  const cfg = await x.svc.route("GET", "/config");
  assert.equal(cfg.factory, getAddress(FACTORY));
  assert.equal(cfg.relayer, w.relayer);
  assert.equal(x.s.sends.length, 0);
});

test("owner controls ON, intake OFF (the rollback state): withdraw, revokeAll, terminate, sign-out and views work; intake stays 503", async () => {
  const w = makeWorld();
  const clock = { t: T };
  const r = loadFundingActivation(envFor(w, { intake: false }), hostOf(w, feeChain(w), clock));
  assert.equal(r.status.ownerControls.on, true, r.status.ownerControls.why);
  assert.equal(r.status.intake.on, false);
  assert.equal(r.options.fundingQuotePolicy, undefined);
  const x = service({ w, act: r.options, clock });
  for (const [m, p] of INTAKE_ROUTES) {
    const e = await err(x.svc.route(m, p, {}));
    assert.equal(e.code, "funding_disabled", `${m} ${p}`);
    assert.match(e.message, /quote policy/);
  }
  assert.equal((await ownerOp(x, "withdraw", "21", { amount: "1" })).op, "withdraw");
  assert.equal((await ownerOp(x, "revokeAll", "22", { withdraw: false }, [vaultLog(x, "RevokedAll")])).op, "revokeAll");
  assert.equal((await terminate(x, "23")).op, "terminate");
  canonicalOn(x, [vaultLog(x, "SessionEnded")]);
  const end = await x.svc.route("POST", "/funding/end", { vault: x.w.vault, sid: x.w.sid, deadline: String(T + 60), x: "11", y: "12",
    r: "0x" + "0e".repeat(32), s: "0x" + "0f".repeat(32) });
  assert.equal(typeof end.txHash, "string");
  assert.equal(x.s.sends.length, 4, "each control is one send of the ONE queue");
  assert.deepEqual(x.s.sends.map((q) => Number(q.nonce)), [7, 8, 9, 10]);
  assert.equal(x.journal.data.txs.length, 4);
  assert.ok(x.store.data.revoked[x.w.sid]);
  const view = await x.svc.route("GET", `/funding/session/${w.vault}/${w.sid}`);
  assert.equal(view.vault, w.vault);
  assert.equal((await x.svc.route("GET", `/funding/owner/${w.owner}`)).vault, w.vault);
});

test("intake ON via the loader: the actual v2 fee policy prices /funding/quote over the host's request; accept is bound to that quote", async () => {
  const w = makeWorld();
  const clock = { t: T };
  const s = feeChain(w);
  const r = loadFundingActivation(envFor(w), hostOf(w, s, clock));
  assert.equal(r.status.intake.on, true, r.status.intake.why);
  const P = r.options.fundingQuotePolicy;
  assert.equal(P.interface, QUOTE_POLICY_INTERFACE);
  assert.deepEqual(r.options.funding, manifestOf(w), "the intake manifest is the bounded read of SESSIONS_FUNDING_MANIFEST");
  const x = service({ w, act: r.options, clock });
  w.session.maxFee6 = 1_000_000n;           // the scripted grant's cap; the policy's computed fee is not asserted to a constant
  const out = await x.svc.route("POST", "/funding/quote", quoteBody(w));
  assert.equal(typeof out.fee, "bigint");
  assert.equal(out.fee, out.feePolicy.fee6);
  assert.equal(out.feePolicy.configHash, P.configHash);
  assert.equal(out.feePolicy.block, w.block, "priced at the route's pinned block");
  assert.equal(out.feePolicy.blockHash, FP.BH);
  assert.ok(s.log.some((e) => e.method === "eth_chainId"));
  assert.ok(s.log.some((e) => e.method === "eth_call"), "the oracle and feed were read through the host request");
  const e = await err(x.svc.route("POST", "/funding/execute", execBody(w, { fee: String(out.fee + 1n) })));
  assert.equal(e.status, 503);
  assert.equal(e.code, "quote_policy_failed");
  assert.match(e.message, /no_matching_quote/);
  assert.deepEqual(x.journal.data.intents, {}, "nothing reserved");
  assert.equal(x.s.sends.length, 0, "nothing sent");
});

test("rollback by restart: intake ON then OFF over the SAME store, journal and queue nonce keeps successor owner controls", async () => {
  const w = makeWorld();
  const clock = { t: T };
  const s = feeChain(w);
  const store = { data: {}, saveSoon() {}, flush() {} };
  const journal = { data: { txs: [] }, saveSoon() {}, flush() {} };
  const c = chainOf(w);
  const on = service({ w, c, store, journal, clock, act: loadFundingActivation(envFor(w), hostOf(w, s, clock)).options });
  w.session.maxFee6 = 1_000_000n;
  assert.equal(typeof (await on.svc.route("POST", "/funding/quote", quoteBody(w))).fee, "bigint", "intake was really on");
  assert.equal((await ownerOp(on, "withdraw", "31", { amount: "1" })).op, "withdraw");
  const r = loadFundingActivation(envFor(w, { intake: false }), hostOf(w, s, clock));
  assert.equal(r.status.intake.on, false);
  const off = service({ w, c, store, journal, clock, act: r.options });
  assert.equal((await err(off.svc.route("POST", "/funding/quote", quoteBody(w)))).code, "funding_disabled");
  assert.equal((await terminate(off, "32")).op, "terminate");
  assert.deepEqual(c.s.sends.map((q) => Number(q.nonce)), [7, 8]);
  assert.equal(journal.data.txs.length, 2, "one journal across the switch");
});

test("expired intake manifest: intake answers manifest_stale; owner terminate is still sent", async () => {
  const w = makeWorld();
  const clock = { t: T };
  const x = service({ w, clock, act: loadFundingActivation(envFor(w), hostOf(w, feeChain(w), clock)).options });
  clock.t = T + 4000;                              // manifestOf notAfter is T + 3600
  w.timestamp = BigInt(clock.t - 2);
  const e = await err(x.svc.route("POST", "/funding/quote", quoteBody(w)));
  assert.equal(e.status, 503);
  assert.equal(e.code, "manifest_stale");
  assert.equal((await terminate(x, "41")).op, "terminate");
  assert.equal(x.s.sends.length, 1);
});

test("expired fee-policy config: the actual policy refuses config_expired; owner terminate is still sent", async () => {
  const w = makeWorld();
  const clock = { t: T };
  const r = loadFundingActivation(envFor(w, { fee: FP.cfg((c) => { c.notAfter = T + 100; }) }), hostOf(w, feeChain(w), clock));
  assert.equal(r.status.intake.on, true, r.status.intake.why);
  const x = service({ w, clock, act: r.options });
  w.session.maxFee6 = 1_000_000n;
  clock.t = T + 200;
  w.timestamp = BigInt(clock.t - 2);
  const e = await err(x.svc.route("POST", "/funding/quote", quoteBody(w)));
  assert.equal(e.code, "quote_policy_failed");
  assert.match(e.message, /config_expired/);
  assert.equal((await terminate(x, "51")).op, "terminate");
  assert.equal(x.s.sends.length, 1);
});

test("malformed or mismatched new config never throws, never enables intake, and never removes owner controls or original routes", async () => {
  const w = makeWorld();
  const clock = { t: T };
  const s = feeChain(w);
  const m = manifestOf(w);
  const cases = [
    ["fee config is not JSON", { fee: "{ not json" }, {}, true, /config_json/],
    ["fee config has an unknown field", { fee: { ...FP.cfg(), fallbackEthUsd: 3000 } }, {}, true, /fee_policy.*unknown field/],
    ["fee config is for another chain", { fee: FP.cfg((c) => { c.chainId = 1; }) }, {}, true, /chain_mismatch/],
    ["fee config already expired", { fee: FP.cfg((c) => { c.notAfter = T - 1; }) }, {}, true, /fee_policy_expired/],
    ["intake manifest pins other successor code", { manifest: { ...m, codehashes: { ...m.codehashes, implementation: "0x" + "12".repeat(32) } } }, {}, true, /pin_mismatch/],
    ["intake manifest for another chain", { manifest: { ...m, chainId: 1 } }, {}, true, /intake_manifest/],
    ["intake flag is not exactly 1", {}, { env: { SESSIONS_FUNDING_INTAKE: "true" } }, true, /flag_value/],
    ["intake without owner controls", { ownerOn: false }, {}, false, /owner_controls_off/],
    ["owner manifest has an unknown field", { owner: { ...ownerManifestOf(w), notAfter: T + 1 } }, {}, false, /owner_controls_off/],
    ["relayer env names another account", { relayer: "0x" + "77".repeat(20) }, {}, false, /owner_controls_off/],
    ["local network posing as 8453", {}, { host: { netName: "local" } }, false, /owner_controls_off/],
    ["host on Base Sepolia", {}, { host: { chainId: 84532 } }, false, /owner_controls_off/],
    ["development relayer key", { relayer: DEV_ACCOUNTS[0] }, { host: { relayer: DEV_ACCOUNTS[0] } }, false, /owner_controls_off/],
  ];
  let survivor = null;
  for (const [name, files_, { env = {}, host = {} }, ownerOn, why] of cases) {
    const r = loadFundingActivation({ ...envFor(w, files_), ...env }, hostOf(w, s, clock, host));
    assert.equal(r.options.fundingQuotePolicy, undefined, name);
    assert.equal(r.status.intake.on, false, name);
    assert.match(r.status.intake.why, why, name);
    assert.equal(Boolean(r.options.fundingOwnerControls), ownerOn, `${name}: owner controls ${r.status.ownerControls.why}`);
    if (!ownerOn && /posing|Sepolia|development|another account/.test(name)) {
      assert.match(r.status.ownerControls.why, /network_mismatch|chain_mismatch|default_credentials|account_mismatch/, name);
    }
    if (name === "fee config is not JSON") survivor = r.options;
  }
  const x = service({ w, clock, act: survivor });
  assert.equal((await x.svc.route("GET", "/config")).factory, getAddress(FACTORY), "original routes answer");
  assert.equal((await err(x.svc.route("POST", "/funding/quote", quoteBody(w)))).code, "funding_disabled");
  assert.equal((await terminate(x, "61")).op, "terminate", "owner controls survive a malformed fee config");
});

test("owner pins are re-proven per request: provisional addresses without code, or other code, send nothing; the route refuses mismatched intake", async () => {
  const w = makeWorld();
  const clock = { t: T };
  const good = loadFundingActivation(envFor(w), hostOf(w, feeChain(w), clock)).options;
  const provisional = service({ w, clock,
    act: { fundingOwnerControls: ownerManifestOf(w, { addresses: { factory: "0x00000000000000000000000000000000000d0d0d" } }) } });
  const e1 = await err(terminate(provisional, "71"));
  assert.equal(e1.status, 503);
  assert.equal(e1.code, "missing_code");
  const other = service({ w, clock, act: { ...good, fundingOwnerControls: ownerManifestOf(w, { codehashes: { implementation: "0x" + "34".repeat(32) } }) } });
  const e2 = await err(other.svc.route("POST", "/funding/quote", quoteBody(w)));
  assert.equal(e2.code, "funding_disabled");
  assert.match(e2.message, /pin different successor code/);
  const e3 = await err(terminate(other, "72"));
  assert.equal(e3.code, "codehash_mismatch");
  for (const x of [provisional, other]) {
    assert.equal(x.s.sends.length, 0);
    assert.deepEqual(x.journal.data.intents, {});
  }
});

test("bounded config reader: only a regular, small, UTF-8 JSON object at a real absolute path is read", () => {
  const code = (p) => { try { readBoundedJsonFile(p, "X"); return "read"; } catch (e) { return e.code; } };
  const good = writeRaw('{"a":1}');
  assert.deepEqual(readBoundedJsonFile(good, "X"), { a: 1 });
  assert.equal(code(writeRaw(`{"a":"${"x".repeat(MAX_CONFIG_BYTES - 8)}"}`)), "read", "exactly the bound is accepted");
  assert.equal(code(writeRaw(`{"a":"${"x".repeat(MAX_CONFIG_BYTES - 7)}"}`)), "config_oversize");
  const link = join(DIR, "link.json");
  symlinkSync(good, link);
  assert.equal(code(link), "config_symlink");
  mkdirSync(join(DIR, "real"));
  writeFileSync(join(DIR, "real", "c.json"), "{}", { mode: 0o600 });
  symlinkSync(join(DIR, "real"), join(DIR, "dirlink"));
  assert.equal(code(join(DIR, "dirlink", "c.json")), "config_symlink", "a symlinked directory component is refused");
  assert.equal(code(join(DIR, "real", "c.json")), "read");
  assert.equal(code("good.json"), "config_path");
  assert.equal(code(`${DIR}/real/../real/c.json`), "config_path");
  assert.equal(code(`${DIR}//real/c.json`), "config_path");
  assert.equal(code(`${DIR}/real/`), "config_path");
  assert.equal(code(""), "config_missing");
  assert.equal(code(join(DIR, "real")), "config_not_regular");
  assert.equal(code("/dev/null"), "config_not_regular");
  assert.equal(code(join(DIR, "missing.json")), "config_unreadable");
  const ww = writeRaw("{}");
  chmodSync(ww, 0o666);
  assert.equal(code(ww), "config_writable");
  assert.equal(code(writeRaw(Buffer.from([0x7b, 0xff, 0x7d]))), "config_encoding");
  for (const bad of ["[1]", "null", "1", "{", ""]) assert.equal(code(writeRaw(bad)), "config_json", JSON.stringify(bad));
});

test("actual initSessions: flags unset wire nothing new; a malformed fee config keeps owner controls and the original routes", async () => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("SESSIONS_")) delete process.env[k];
  const key = `0x${randomBytes(32).toString("hex")}`;              // a throwaway key; it never signs anything here
  const relayer = privateKeyToAccount(key).address;
  class MemStore { constructor(_p, init) { this.data = structuredClone(init); } saveSoon() {} flush() {} }
  const w = makeWorld();
  try {
    // a closed loopback port: the balance probe fails locally, nothing leaves the host
    Object.assign(process.env, { SESSIONS_RELAYER_KEY: key, SESSIONS_NETWORK: "base", SESSIONS_RPC: "http://127.0.0.1:9", SESSIONS_FACTORY: FACTORY });
    const off = await initSessions({ dataDir: DIR, JsonStore: MemStore });
    assert.ok(off);
    assert.equal((await off.route("GET", "/config")).relayer, relayer);
    assert.equal((await err(off.route("GET", `/funding/owner/${w.owner}`))).code, "funding_disabled");
    Object.assign(process.env, { SESSIONS_FUNDING_OWNER_CONTROLS: "1", SESSIONS_FUNDING_OWNER_MANIFEST: writeJson(ownerManifestOf(w)),
      SESSIONS_FUNDING_RELAYER: relayer, SESSIONS_FUNDING_INTAKE: "1", SESSIONS_FUNDING_MANIFEST: writeJson(manifestOf(w)),
      SESSIONS_FUNDING_FEE_POLICY: writeRaw("{ not json") });
    const on = await initSessions({ dataDir: DIR, JsonStore: MemStore });
    assert.ok(on);
    assert.equal((await on.route("GET", "/config")).factory, getAddress(FACTORY));
    assert.equal((await on.route("GET", `/funding/owner/${w.owner}`)).vault, w.vault, "owner controls are on (read-only view)");
    const e = await err(on.route("POST", "/funding/quote", quoteBody(w)));
    assert.equal(e.code, "funding_disabled");
    assert.match(e.message, /quote policy/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
