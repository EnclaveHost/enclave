// UNREVIEWED, NOT RUN. Bounded OFFLINE tests: scripted EIP-1193 provider (well-known TEST key), scripted relays, a
// scripted chain whose receipts/blocks/logs carry full canonical metadata and go through the REAL canonicalReceipt,
// Node's WebCrypto (not a browser) and in-memory stores (not IndexedDB). They check codec wiring, refusals, ordering,
// journal recovery and record preservation. They prove NOTHING about a real wallet, browser UI, IndexedDB, the deployed
// contracts, the live relays or production. Addresses below are test fixtures, never deployment values.
// Run (root, after review): node --test test/offline.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../../../source/sdk/sessions/dist/browser.mjs";
import {
  encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, hexToBytes, keccak256, parseAbi, toHex,
} from "../../../source/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "../../../source/node_modules/viem/_esm/accounts/index.js";
import { buildGasFundCall, fundingConfig, keyHashOf, predictVault } from "../../client-r1/funding-codec.mjs";
import { jsonable, lower, sameAddr } from "../lib/util.mjs";
import { LEGACY_DB, IndexedDbV2Store, MemoryV2Store, newGasKey, newGasRecord, signerFor, validateGasRecord } from "../lib/v2-store.mjs";
import {
  buildGasGrant, controlsTarget, depositTypedData, endGasSession, grantBody, ownerControl, parseRuntimePins, quoteGasFund,
} from "../lib/funding-client.mjs";
import { USDC_EVENTS, VAULT_EVENTS, canonicalReceipt, receiptFinality } from "../lib/chain-proof.mjs";
import {
  ORDER, REPLACED_FIELDS, V1_GRANT_FIELDS, actionsMaskV1, buildMigrationPlan, loadLegacyEvidence, rearmStep,
  reconcileMigration, runMigration, signSteps,
} from "../lib/migration.mjs";

// ---- fixtures (TEST ONLY) -------------------------------------------------------------------------------------------
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";   // public anvil key #0
const acct = privateKeyToAccount(TEST_KEY);
const OWNER = acct.address;
const A = (b) => `0x${b.repeat(20)}`;
const FACTORY = A("11"), IMPL = A("22"), ADAPTER = A("33"), LFACTORY = A("44"), LVAULT = A("55"), USDC = A("66"), RELAYER = A("77");
const ZERO = `0x${"0".repeat(64)}`;
const NOW = 1793202897n;                         // block timestamp of session-live-20261028-r2.json
const LEG_EXP = 1793765924n;                     // live old expiresAt
const LIVE_ACTIONS_MASK = 43215860598959184859848575143834562855167n;   // live old `actions` from the same snapshot
const DEP = `0x${"d1".repeat(32)}`;
const APPS = [`0x${"a1".repeat(32)}`, `0x${"b2".repeat(32)}`];
const TX = (b) => `0x${b.repeat(32)}`;

const cfg = fundingConfig({ chainId: 8453, factory: FACTORY, implementation: IMPL, vault: predictVault(FACTORY, IMPL, OWNER),
  owner: OWNER, gasAdapter: ADAPTER, legacyFactory: LFACTORY, legacyVault: LVAULT, adapterMaxEthOut: 10n ** 17n,
  adapterFeeTiers: [500, 3000] });
const runtime = Object.freeze({ cfg, pins: { usdc: USDC, legacyFactory: LFACTORY },
  intake: { openEnabled: true, ownerEnabled: true, feeTiers: [500, 3000], relayer: RELAYER }, intakeWhy: null, relayer: RELAYER });
const scope = { appIds: APPS, block: 1n,
  deployments: new Map([[DEP, { holder: cfg.legacyVault, env: 2, appId: APPS[0], active: true }]]) };
const PINS = { schema: "enclave-funding-browser-runtime-r1", chainId: 8453, factory: FACTORY, implementation: IMPL, gasAdapter: ADAPTER,
  legacyFactory: LFACTORY, usdc: USDC, feeTiers: [500, 3000], codehashes: { factory: TX("c1"), implementation: TX("c2"), gasAdapter: TX("c3") },
  source: { kind: "deployed-receipts", deployTxs: [TX("d9")], reviewedBy: "test-fixture" } };

const OLD_ACTIONS = ["deploy.create", "deploy.fund", "deploy.setAppRef", "deploy.setConfig", "deploy.setShares",
  "deploy.setMaxRate", "deploy.setActive", "deploy.refund", "api.status", "api.logs", "api.restart", "api.upload",
  "api.appAccess", "api.placement", "api.account"];

const rawPoint = (x, y) => new Uint8Array([4, ...hexToBytes(toHex(x, { size: 32 })), ...hexToBytes(toHex(y, { size: 32 }))]);
const code = (c) => (e) => e?.code === c;

// scripted EIP-1193 provider: signs whatever typed data it is handed with the TEST key, counting prompts
function scriptedProvider() {
  const p = { prompts: [], async request({ method, params }) {
    assert.equal(method, "eth_signTypedData_v4");
    const td = JSON.parse(params[1]);
    p.prompts.push(td.primaryType);
    const { EIP712Domain, ...types } = td.types;
    const msg = { ...td.message };
    for (const f of types[td.primaryType]) if (f.type.startsWith("uint")) msg[f.name] = BigInt(msg[f.name]);
    return acct.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: msg });
  } };
  return p;
}

// ---- scripted chain: every mined tx gets a block, a receipt and logs with full canonical metadata ----------------------
const ERC = parseAbi(["function name() view returns (string)", "function version() view returns (string)"]);
const U8 = { type: "uint8" }, U64 = { type: "uint64" }, U256 = { type: "uint256" }, STR = { type: "string" };
const ev = (address, abi, eventName, args, types, values) => ({ address: lower(address),
  topics: encodeEventTopics({ abi, eventName, args }), data: types.length ? encodeAbiParameters(types, values) : "0x" });
const ended = (vault, sid, reason, refund) => ev(vault, VAULT_EVENTS, "SessionEnded", { sid }, [U8, U256, U256], [reason, refund, 0n]);
const opened = (vault, sid, keyHash, expiresAt, actions, envs, budget, label) => ev(vault, VAULT_EVENTS, "SessionOpened",
  { sid, keyHash }, [U64, U256, U8, U256, STR], [BigInt(expiresAt), BigInt(actions), envs, BigInt(budget), label]);
const transfer = (from, to, value) => ev(USDC, USDC_EVENTS, "Transfer", { from, to }, [U256], [BigInt(value)]);
const authUsed = (authorizer, nonce) => ev(USDC, USDC_EVENTS, "AuthorizationUsed", { authorizer, nonce }, [], []);
const DEAD = Object.freeze({ live: false, state: 0, balance6: 0n, spent6: 0n, apps: [] });

function world() {
  const W = { head: 1000n, txs: new Map(), receipts: new Map(), logs: [], hidden: new Set(), sessions: new Map(), auth: new Set(), wallet: 0n, n: 0 };
  W.bhash = (n) => keccak256(toHex(BigInt(n), { size: 32 }));
  W.block = (n) => ({ number: toHex(n), hash: W.bhash(n), timestamp: toHex(NOW), transactions: W.txs.get(n) ?? [] });
  W.mine = (specs) => {
    const n = ++W.head;
    const txHash = keccak256(toHex(BigInt(++W.n) + 77n, { size: 32 }));
    const logs = specs.map((s, i) => ({ ...s, transactionHash: txHash, blockHash: W.bhash(n), blockNumber: toHex(n),
      transactionIndex: "0x0", logIndex: toHex(i), removed: false }));
    W.txs.set(n, [txHash]);
    W.receipts.set(txHash, { transactionHash: txHash, transactionIndex: "0x0", blockHash: W.bhash(n), blockNumber: toHex(n), status: "0x1", logs });
    W.logs.push(...logs);
    return txHash;
  };
  W.rpc = async (method, params) => {
    if (method === "eth_getTransactionReceipt") return W.hidden.has(params[0]) ? null : (W.receipts.get(params[0]) ?? null);
    if (method === "eth_getBlockByNumber") {
      const n = params[0] === "latest" || params[0] === "finalized" ? W.head : BigInt(params[0]);
      return n <= W.head ? W.block(n) : null;
    }
    if (method === "eth_call") {
      const fn = params[0].data === encodeFunctionData({ abi: ERC, functionName: "name" }) ? "name" : "version";
      return encodeFunctionResult({ abi: ERC, functionName: fn, result: fn === "name" ? "USD Coin" : "2" });
    }
    throw new Error(`unscripted ${method}`);
  };
  W.chain = {
    pin: async () => ({ number: W.head, tag: toHex(W.head), hash: W.bhash(W.head), timestamp: NOW, recheck: async () => {} }),
    sessionOf: async (_v, sid) => W.sessions.get(lower(sid)) ?? DEAD,
    owner: async () => OWNER, free: async () => 0n, vaultFor: async () => LVAULT,
    usdcBalance: async () => W.wallet, authorizationUsed: async (_u, _w, n) => W.auth.has(lower(n)),
    receipt: (h) => canonicalReceipt(W.rpc, h), finality: (rc) => receiptFinality(W.rpc, rc),
    getLogs: async ({ address, topics, fromBlock }) => W.logs.filter((l) => !W.hidden.has(l.transactionHash) && sameAddr(l.address, address)
      && topics.every((tp, i) => tp == null || l.topics[i] === tp) && BigInt(l.blockNumber) >= BigInt(fromBlock)),
  };
  return W;
}

const stateOf = (g, over = {}) => ({ live: true, state: 1, keyHash: lower(g.sessionKey), measurement: lower(g.measurement),
  actions: actionsMaskV1(S, g.actions), expiresAt: BigInt(g.expiresAt), envs: 3, anyApp: true, balance6: BigInt(g.budget),
  spent6: 0n, perPeriod6: BigInt(g.spendPerPeriod), maxFee6: BigInt(g.maxFeePerOp), maxAppFeeHour6: BigInt(g.maxAppFeePerHour),
  maxRateHour6: BigInt(g.maxRatePerHour), period: Number(g.periodSeconds), opsPerPeriod: Number(g.opsPerPeriod),
  periodSpent6: 0n, apps: [], ...over });

async function setup() {
  const legacyStore = new S.MemoryStore();
  const { record } = await S.newSessionKey(legacyStore, { relay: "https://relay.test", chainId: 8453, label: "Browser · test", extractable: false });
  const oldGrant = { label: "Browser · test", preset: "browser", sessionKey: record.keyHash, actions: OLD_ACTIONS, apps: [],
    environments: ["staging", "prod"], budget: 30_000_000n, spendPerPeriod: 100_000_000n, periodSeconds: 86400, opsPerPeriod: 1000,
    maxFeePerOp: 250_000n, maxAppFeePerHour: 0n, maxRatePerHour: 5_000_000n, expiresAt: LEG_EXP, measurement: ZERO,
    grantNonce: `0x${"01".repeat(32)}`, signBefore: NOW - 600n };
  const oldRec = await S.completeSession(legacyStore, record, { vault: LVAULT, owner: OWNER, grant: oldGrant });
  const oldSid = lower(oldRec.id);
  const W = world();
  W.sessions.set(oldSid, stateOf(oldGrant));
  const gasStore = new MemoryV2Store();
  const t = { legacyStore, oldGrant, oldRec, oldSid, W, gasStore, mode: {}, calls: [], active: [], minted: {} };
  t.legacyRelay = { async request(method, path, body) {
    t.calls.push(`${method} ${path}`);
    const mode = t.mode[path] ?? "ok";
    if (mode === "refuse") throw Object.assign(new Error("simulation refused"), { code: "relay" });
    let tx, extra = {};
    if (path === "/owner") {
      const sid = lower(body.args.sessionId);
      const old = W.sessions.get(sid);
      W.sessions.set(sid, { ...old, live: false, state: 2, balance6: 0n });
      W.wallet += old.balance6;
      tx = W.mine([ended(LVAULT, sid, mode === "badReason" ? 2 : 1, old.balance6), transfer(LVAULT, OWNER, old.balance6)]);
    } else if (path === "/open") {
      const g = body.grant;
      const sid = lower(S.sessionIdOf(LVAULT, g.sessionKey, g.grantNonce));
      const digest = lower(S.grantDigest(8453, LVAULT, g));
      W.sessions.set(sid, stateOf(g));
      W.auth.add(digest);
      W.wallet -= g.budget;
      tx = W.mine([opened(LVAULT, sid, g.sessionKey, g.expiresAt, actionsMaskV1(S, g.actions), 3, g.budget, g.label),
        authUsed(OWNER, digest), transfer(OWNER, LVAULT, g.budget)]);
      extra = { sid, vault: LVAULT };
    } else throw new Error(`unscripted legacy ${path}`);
    t.minted[path] = tx;
    if (mode === "pending") W.hidden.add(tx);
    if (mode === "drop") throw Object.assign(new Error("relay unreachable: connection reset"), { code: "relay" });
    return { txHash: mode === "wrongHash" ? t.minted["/owner"] : tx, ...extra };
  } };
  t.relay = async (method, path, body) => {
    t.calls.push(`${method} ${path}`);
    if (path === "/funding/open") {
      const r = (await gasStore.getJournal(t.planId)).steps.gasOpen.review;
      assert.equal(body.grant.grantNonce, r.grant.grantNonce);
      W.auth.add(r.digest);
      W.wallet -= BigInt(r.grant.budget);
      const tx = W.mine([opened(cfg.vault, r.sid, r.keyHash, r.grant.expiresAt, 1n << 10n, 3, r.grant.budget, r.grant.label),
        authUsed(OWNER, r.digest), transfer(OWNER, cfg.vault, r.grant.budget)]);
      return { txHash: tx, sid: r.sid };
    }
    throw Object.assign(new Error("unscripted"), { code: "relay" });
  };
  t.ctx = (over = {}) => ({ S, chain: W.chain, legacyRelay: t.legacyRelay, relay: t.relay, runtime, legacyStore, gasStore, now: NOW,
    setActive: async (sid, from) => { t.active.push([sid, from]); }, ...over });
  return t;
}

async function planned(t, now = NOW) {
  const evidence = await loadLegacyEvidence({ S, legacyStore: t.legacyStore, sid: t.oldSid, owner: OWNER, chain: t.W.chain,
    legacyConfig: { chainId: 8453, factory: LFACTORY }, runtime, now });
  const plan = await buildMigrationPlan({ S, evidence, runtime, scope, gasStore: t.gasStore, relayBase: "https://relay.test",
    now, split: { legacy6: 29_000_000n, gas6: 1_000_000n } });
  t.planId = plan.id;
  return plan;
}
const sign = async (t, steps, now = NOW, provider = scriptedProvider()) => {
  const plan = await t.gasStore.getJournal(t.planId);
  return signSteps({ S, plan, steps, approval: { rootReviewed: true, termsHash: plan.termsHash }, provider, rpc: t.W.rpc, runtime, now });
};
const statuses = async (t) => Object.fromEntries(Object.entries((await t.gasStore.getJournal(t.planId)).steps).map(([k, s]) => [k, s.status]));

// =====================================================================================================================

test("Node WebCrypto (NOT a browser): fresh gas key non-extractable; keyHash = codec = v1 SDK; P-256 over digest bytes", async () => {
  const k = await newGasKey(crypto.subtle);
  assert.equal(k.privateKey.extractable, false);
  assert.equal(k.keyHash, keyHashOf(k.x, k.y));
  assert.equal((await S.signerFromKeys(k.privateKey, k.x, k.y)).keyHash, k.keyHash);
  await assert.rejects(crypto.subtle.exportKey("pkcs8", k.privateKey));
  const digest = keccak256("0x01");
  const { r, s } = await signerFor(k.privateKey, k.x, k.y, crypto.subtle).signDigest(digest);
  const pub = await crypto.subtle.importKey("raw", rawPoint(k.x, k.y), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, hexToBytes(`${r}${s.slice(2)}`), hexToBytes(digest)));
  const rec = newGasRecord({ key: k, chainId: 8453, relay: "https://relay.test", owner: OWNER, vault: cfg.vault, factory: FACTORY,
    implementation: IMPL, label: "Gas recovery", now: NOW });
  assert.equal(rec.domainVersion, "2");
  assert.equal("handle" in rec, false);
  validateGasRecord(rec);
  assert.throws(() => validateGasRecord({ ...rec, handle: {} }), { code: "record_shape" });
  assert.throws(() => new IndexedDbV2Store(LEGACY_DB, {}), { code: "store_collision" });
});

test("gas grant: exact domain 2, action 10 only, staging+prod, 1 USDC, candidate caps; refusals", async () => {
  const k = await newGasKey(crypto.subtle);
  const args = { now: NOW, sessionKey: k.keyHash, appIds: APPS, expiresAt: LEG_EXP, legacyExpiresAt: LEG_EXP,
    grantNonce: `0x${"0c".repeat(32)}`, signBefore: NOW + 900n, label: "Gas recovery" };
  const b = buildGasGrant(cfg, args);
  assert.deepEqual({ ...b.typedData.domain }, { name: "Enclave Sessions", version: "2", chainId: 8453, verifyingContract: cfg.vault });
  assert.equal(b.actionsMask, 1n << 10n);
  assert.equal(b.envsMask, 3);
  const m = b.typedData.message;
  assert.deepEqual([...m.actions], ["gas.fund"]);
  assert.deepEqual([...m.environments], ["staging", "prod"]);
  const want = { budget: 1_000_000n, spendPerPeriod: 1_000_000n, opsPerPeriod: 20n, maxFeePerOp: 50_000n, maxAppFeePerHour: 0n,
    maxRatePerHour: 0n, maxGasUsdcPerOp: 100_000n, maxEthPerOp: 20_000_000_000_000n, maxUsdcPerEth6: 2_500_000_000n };
  for (const [f, v] of Object.entries(want)) assert.equal(BigInt(m[f]), v, f);
  assert.throws(() => buildGasGrant(cfg, { ...args, budget: 2_000_000n }), { code: "gas_budget_not_candidate" });
  assert.throws(() => buildGasGrant(cfg, { ...args, expiresAt: LEG_EXP + 1n }), { code: "gas_expiry_after_legacy" });
  const nine = Array.from({ length: 9 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`);
  assert.throws(() => buildGasGrant(cfg, { ...args, appIds: nine }), { code: "gas_scope_apps" });
  const dep = depositTypedData({ name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
    { from: OWNER, to: cfg.vault, value: m.budget, nonce: b.digest, validBefore: m.signBefore });
  assert.equal(dep.message.value, 1_000_000n);
  assert.equal(dep.message.nonce, b.digest);
  assert.equal(dep.message.to, cfg.vault);
});

test("gas.fund quote: fee / price / budget caps are enforced, never raised; unreconciled execute blocks", async () => {
  const k = await newGasKey(crypto.subtle);
  const b = buildGasGrant(cfg, { now: NOW, sessionKey: k.keyHash, appIds: APPS, expiresAt: LEG_EXP, legacyExpiresAt: LEG_EXP,
    grantNonce: `0x${"0d".repeat(32)}`, signBefore: NOW + 900n, label: "Gas recovery" });
  const record = { status: "open", sid: b.sessionId, keyHash: k.keyHash, grant: grantBody(b) };
  const quoteFor = (maxUsdcIn6, fee) => {
    const deadline = NOW + 300n;
    const nonce = 1n << 64n;
    const intent = { payer: cfg.vault, deployment: DEP, expectedOwner: cfg.legacyVault, ethOut: 20_000_000_000_000n, maxUsdcIn6, fee: 500, deadline };
    const c = buildGasFundCall(cfg, { domainVersion: "2", now: NOW, sessionId: b.sessionId, nonce, action: 10, intent, fee, deadline });
    return { vault: cfg.vault, sid: b.sessionId, action: 10, chainId: 8453, nonce: nonce.toString(), intent: jsonable(intent),
      fee: fee.toString(), deadline: deadline.toString(), args: c.args, argsHash: c.argsHash,
      maximum: { totalMaximum6: (maxUsdcIn6 + fee).toString() } };
  };
  const relayWith = (q, balance6 = "1000000") => async (method) => (method === "GET"
    ? { state: { live: true, keyHash: k.keyHash, balance6 } } : q);
  const run = (q, extra = {}) => quoteGasFund({ runtime, record, relay: relayWith(q, extra.balance6), scope, deployment: DEP,
    ethOut: 20_000_000_000_000n, feeTier: 500, now: NOW, journalEntries: extra.journal ?? [] });
  const ok = await run(quoteFor(50_000n, 50_000n));
  assert.equal(ok.totals.totalMaximum6, 100_000n);
  assert.equal(ok.call.typedData.domain.version, "2");
  assert.equal(BigInt(ok.call.typedData.message.action), 10n);
  await assert.rejects(run(quoteFor(50_000n, 50_001n)), { code: "fee_exceeds_grant" });
  await assert.rejects(run(quoteFor(50_001n, 50_000n)), { code: "price_cap" });
  await assert.rejects(run(quoteFor(50_000n, 50_000n), { balance6: "99999" }), { code: "quote_exceeds_budget" });
  await assert.rejects(run(quoteFor(50_000n, 50_000n), { journal: [{ kind: "gas-execute", sid: b.sessionId, status: "unknown", id: "x" }] }),
    { code: "unreconciled_execute" });
});

test("legacy evidence: live mask; missing record, wrong key hash, expired/ended old, spent, maxRate mismatch all STOP", async () => {
  assert.equal(actionsMaskV1(S, OLD_ACTIONS), LIVE_ACTIONS_MASK);
  const t = await setup();
  const ev2 = (over = {}) => loadLegacyEvidence({ S, legacyStore: t.legacyStore, sid: t.oldSid, owner: OWNER, chain: t.W.chain,
    legacyConfig: { chainId: 8453, factory: LFACTORY }, runtime, now: NOW, ...over });
  assert.equal((await ev2()).state.balance6, 30_000_000n);
  await assert.rejects(ev2({ legacyStore: new S.MemoryStore() }), code("legacy_record_missing"));
  const bad = new S.MemoryStore();
  await bad.save({ ...t.oldRec, keyHash: TX("99") });
  await assert.rejects(ev2({ legacyStore: bad }), code("key_hash_mismatch"));
  t.W.sessions.set(t.oldSid, stateOf(t.oldGrant, { live: false }));                       // expired / ended
  await assert.rejects(ev2(), code("legacy_not_live"));
  t.W.sessions.set(t.oldSid, stateOf(t.oldGrant, { spent6: 1n }));
  await assert.rejects(ev2(), code("legacy_state_changed"));
  t.W.sessions.set(t.oldSid, stateOf(t.oldGrant, { maxRateHour6: 1n }));
  await assert.rejects(ev2(), (e) => e.code === "legacy_fields_mismatch" && e.detail.diff.includes("maxRateHour6"));
  t.W.sessions.set(t.oldSid, stateOf(t.oldGrant));
  const e = await ev2();
  await assert.rejects(buildMigrationPlan({ S, evidence: e, runtime, scope, gasStore: t.gasStore, relayBase: "https://relay.test",
    now: LEG_EXP - 100n, split: { legacy6: 29_000_000n, gas6: 1_000_000n } }), code("legacy_expiring"));
});

test("plan: explicit split; replacement changes only budget/grantNonce/signBefore; journal holds the exact unsigned review", async () => {
  const t = await setup();
  const evidence = await loadLegacyEvidence({ S, legacyStore: t.legacyStore, sid: t.oldSid, owner: OWNER, chain: t.W.chain,
    legacyConfig: { chainId: 8453, factory: LFACTORY }, runtime, now: NOW });
  const b = (split) => buildMigrationPlan({ S, evidence, runtime, scope, gasStore: t.gasStore, relayBase: "https://relay.test", now: NOW, split });
  await assert.rejects(b(undefined), code("split_required"));
  await assert.rejects(b({ legacy6: 29_000_000n, gas6: 2_000_000n }), code("split_total"));
  await assert.rejects(b({ legacy6: 30_000_000n, gas6: 0n }), code("split_zero"));
  assert.equal((await t.gasStore.listKeys()).length, 0);
  const plan = await planned(t);
  const g = plan.steps.legacyOpen.review.grant;
  for (const f of V1_GRANT_FIELDS) {
    if (!REPLACED_FIELDS.includes(f)) assert.deepEqual(g[f], jsonable({ v: t.oldGrant[f] }).v, f);
  }
  assert.equal(g.budget, "29000000");
  assert.equal(g.maxRatePerHour, "5000000");
  assert.notEqual(g.grantNonce, t.oldGrant.grantNonce);
  assert.equal(g.sessionKey, lower(t.oldRec.keyHash));                         // SAME legacy key
  assert.notEqual(plan.steps.gasOpen.review.keyHash, lower(t.oldRec.keyHash)); // fresh gas key
  assert.equal(plan.terms.split.total6, "30000000");
  assert.equal(plan.terms.legacy.oldSid, t.oldSid);
  assert.deepEqual(plan.terms.gas.appIds, APPS);
  assert.equal("observed" in plan.terms, false);                               // observed blocks are evidence, not terms
});

test("sign: nothing without the root termsHash; original only with its replacement; 5 prompts in order", async () => {
  const t = await setup();
  const plan = await planned(t);
  const provider = scriptedProvider();
  const s = (approval, steps = ORDER) => signSteps({ S, plan, steps, approval, provider, rpc: t.W.rpc, runtime, now: NOW });
  await assert.rejects(s(null), code("approval_required"));
  await assert.rejects(s({ rootReviewed: true, termsHash: ZERO }), code("approval_required"));
  await assert.rejects(s({ rootReviewed: true, termsHash: plan.termsHash }, ["terminate"]), code("sign_steps"));
  await assert.rejects(s({ rootReviewed: true, termsHash: plan.termsHash }, ["legacyOpen"]), code("sign_steps"));
  assert.equal(provider.prompts.length, 0);
  await s({ rootReviewed: true, termsHash: plan.termsHash });
  assert.deepEqual(provider.prompts, ["Terminate", "SessionGrant", "ReceiveWithAuthorization", "SessionGrant", "ReceiveWithAuthorization"]);
});

test("run (scripted): every step proven from canonical receipts; old record kept; pointer once; no resend; no signature journaled", async () => {
  const t = await setup();
  await planned(t);
  const signed = await sign(t, ORDER);
  const out = await runMigration(t.ctx(), t.planId, signed);
  assert.equal(out.done, true);
  assert.deepEqual(t.calls, ["POST /owner", "POST /open", "POST /funding/open"]);
  assert.equal(t.W.wallet, 0n);                                    // +30 refund -29 -1: no duplicate budget
  const plan = await t.gasStore.getJournal(t.planId);
  for (const k of ORDER) { assert.equal(plan.steps[k].status, "proven"); assert.equal(plan.steps[k].proof.final, true); }
  const newSid = plan.steps.legacyOpen.review.sid;
  assert.deepEqual(t.active, [[newSid, t.oldSid]]);
  const old = await t.legacyStore.load(t.oldRec.id);
  assert.equal(old.grant.budget, 30_000_000n);
  const rep = await t.legacyStore.load(newSid);
  assert.equal(rep.privateKey, t.oldRec.privateKey);
  assert.equal(rep.grant.budget, 29_000_000n);
  assert.equal((await t.gasStore.loadKey(plan.steps.gasOpen.review.recordId)).status, "open");
  const all = JSON.stringify(await t.gasStore.listJournal());
  for (const sig of [signed.terminate.body.sig, signed.legacyOpen.body.ownerSig, signed.legacyOpen.body.deposit.sig, signed.gasOpen.body.ownerSig]) {
    assert.equal(all.includes(sig.slice(2)), false);
  }
  assert.equal((await runMigration(t.ctx(), t.planId, signed)).done, true);
  assert.equal(t.calls.length, 3);
});

test("pending receipt + reload: never resent; reconcile proves it, adopts record + pointer, then the NEXT step continues", async () => {
  const t = await setup();
  await planned(t);
  t.mode["/open"] = "pending";
  const r1 = await runMigration(t.ctx(), t.planId, await sign(t, ["terminate", "legacyOpen"]));
  assert.equal(r1.pending, true);
  assert.deepEqual(await statuses(t), { terminate: "proven", legacyOpen: "submitted", gasOpen: "planned" });
  // "reload": in-memory signatures are gone; a new context reads only the journal
  const ctx2 = t.ctx();
  assert.equal((await runMigration(ctx2, t.planId, undefined)).needsReconcile, true);
  assert.equal((await reconcileMigration(ctx2, t.planId)).report.at(-1).next, "wait_canonical");
  assert.deepEqual(t.active, []);
  t.W.hidden.clear();                                              // the receipt becomes canonical
  const rec = await reconcileMigration(ctx2, t.planId);
  assert.deepEqual(rec.steps, { terminate: "proven", legacyOpen: "proven", gasOpen: "planned" });
  const newSid = (await t.gasStore.getJournal(t.planId)).steps.legacyOpen.review.sid;
  assert.ok(await t.legacyStore.load(newSid));
  assert.deepEqual(t.active.at(-1), [newSid, t.oldSid]);
  await assert.rejects(sign(t, ["terminate", "legacyOpen"]), code("sign_steps"));     // proven steps are never re-signed
  const done = await runMigration(ctx2, t.planId, await sign(t, ["gasOpen"]));
  assert.equal(done.done, true);
  assert.equal(t.calls.filter((c) => c === "POST /open").length, 1);
  assert.equal(t.W.wallet, 0n);
});

test("reply lost after mining: step stays admitted, reconcile discovers the step's own event and adopts the replacement", async () => {
  const t = await setup();
  await planned(t);
  t.mode["/open"] = "drop";
  await assert.rejects(runMigration(t.ctx(), t.planId, await sign(t, ["terminate", "legacyOpen"])));
  const j = await t.gasStore.getJournal(t.planId);
  assert.equal(j.steps.legacyOpen.status, "admitted");
  assert.equal(j.steps.legacyOpen.txHash, undefined);
  const r = await reconcileMigration(t.ctx(), t.planId);
  assert.equal(r.steps.legacyOpen, "proven");
  assert.equal((await t.gasStore.getJournal(t.planId)).steps.legacyOpen.txHash, t.minted["/open"]);
  assert.ok(await t.legacyStore.load(j.steps.legacyOpen.review.sid));
});

test("refused before sending: void only after the window closes and the chain shows no effect; re-arm + re-sign, no duplicate budget", async () => {
  const t = await setup();
  await planned(t);
  t.mode["/open"] = "refuse";
  await assert.rejects(runMigration(t.ctx(), t.planId, await sign(t, ["terminate", "legacyOpen"])));
  assert.equal((await reconcileMigration(t.ctx(), t.planId)).report.at(-1).next, "wait_window");
  const j = await t.gasStore.getJournal(t.planId);
  const later = BigInt(j.steps.legacyOpen.review.grant.signBefore) + 1n;
  assert.equal((await reconcileMigration(t.ctx({ now: later }), t.planId)).steps.legacyOpen, "void");
  assert.equal((await runMigration(t.ctx({ now: later }), t.planId, undefined)).needsReconcile, true);   // void is never sent
  const re = await rearmStep(t.ctx({ now: later }), t.planId, "legacyOpen");
  assert.equal(re.steps.legacyOpen.attempt, 2);
  assert.notEqual(re.steps.legacyOpen.review.digest, j.steps.legacyOpen.review.digest);
  t.mode["/open"] = "ok";
  const r2 = await runMigration(t.ctx({ now: later }), t.planId, await sign(t, ["legacyOpen"], later));
  assert.equal(r2.needsSignature, true);                           // gas window also passed: re-arm before signing
  assert.equal(r2.stage, "gasOpen");
  await rearmStep(t.ctx({ now: later }), t.planId, "gasOpen");
  assert.equal((await runMigration(t.ctx({ now: later }), t.planId, await sign(t, ["gasOpen"], later))).done, true);
  assert.equal(t.W.wallet, 0n);
  assert.equal(t.W.auth.size, 2);                                  // exactly one replacement + one gas authorization used
});

test("two tabs: compare-and-set admission lets exactly one submit the original's termination", async () => {
  const t = await setup();
  await planned(t);
  const signed = await sign(t, ["terminate", "legacyOpen"]);
  const res = await Promise.allSettled([runMigration(t.ctx(), t.planId, signed), runMigration(t.ctx(), t.planId, signed)]);
  assert.equal(res.filter((r) => r.status === "rejected").length, 1);
  assert.ok(["step_not_planned", "legacy_state_changed"].includes(res.find((r) => r.status === "rejected").reason.code));
  assert.equal(t.calls.filter((c) => c === "POST /owner").length, 1);
  assert.equal(t.calls.filter((c) => c === "POST /open").length, 1);
});

test("termination is proven only by the exact refund event: wrong reason, wrong hash and expiry are never 'done'", async () => {
  const a = await setup();
  await planned(a);
  a.mode["/owner"] = "badReason";
  await assert.rejects(runMigration(a.ctx(), a.planId, await sign(a, ["terminate", "legacyOpen"])), code("terminate_reason"));
  assert.equal((await a.gasStore.getJournal(a.planId)).steps.terminate.status, "submitted");
  await assert.rejects(reconcileMigration(a.ctx(), a.planId), code("terminate_reason"));

  const b = await setup();
  await planned(b);
  b.mode["/open"] = "wrongHash";                                   // relay names the terminate tx as the open
  await assert.rejects(runMigration(b.ctx(), b.planId, await sign(b, ["terminate", "legacyOpen"])), code("open_log"));
  assert.equal((await b.gasStore.getJournal(b.planId)).steps.legacyOpen.status, "submitted");
  assert.deepEqual(b.active, []);

  const c = await setup();
  await planned(c);
  c.mode["/owner"] = "refuse";
  await assert.rejects(runMigration(c.ctx(), c.planId, await sign(c, ["terminate", "legacyOpen"])));
  c.W.sessions.set(c.oldSid, stateOf(c.oldGrant, { live: false }));          // the old session merely expired
  const later = BigInt((await c.gasStore.getJournal(c.planId)).steps.terminate.review.message.signBefore) + 1n;
  await assert.rejects(reconcileMigration(c.ctx({ now: later }), c.planId), code("step_contradiction"));
  assert.equal((await c.gasStore.getJournal(c.planId)).steps.terminate.status, "admitted");
});

test("owner controls with intake OFF and no network config: pins/record only, exact relay wire shapes", async () => {
  const target = controlsTarget(parseRuntimePins(PINS), OWNER);
  assert.equal(target.vault, cfg.vault);
  const sent = [];
  const relay = async (method, path, body) => { sent.push({ method, path, body }); return { txHash: TX("f1") }; };
  const store = new MemoryV2Store();
  const provider = scriptedProvider();
  await ownerControl({ target, provider, relay, store, op: "withdraw", amount: "1000000", now: NOW });
  await ownerControl({ target, provider, relay, store, op: "terminate", sessionId: TX("aa"), now: NOW });
  const k = await newGasKey(crypto.subtle);
  const rec = { ...newGasRecord({ key: k, chainId: 8453, relay: "https://relay.test", owner: OWNER, vault: cfg.vault, factory: FACTORY,
    implementation: IMPL, label: "Gas", now: NOW }), status: "open", sid: TX("ab") };
  await endGasSession({ record: rec, relay, store, now: NOW, subtle: crypto.subtle });
  assert.deepEqual(sent.map((s) => s.path), ["/funding/owner", "/funding/owner", "/funding/end"]);
  assert.deepEqual(Object.keys(sent[0].body).sort(), ["args", "op", "owner", "sig", "vault"]);
  assert.deepEqual(Object.keys(sent[0].body.args).sort(), ["amount", "opNonce", "signBefore"]);
  assert.deepEqual(Object.keys(sent[1].body.args).sort(), ["opNonce", "sessionId", "signBefore"]);
  assert.deepEqual(Object.keys(sent[2].body).sort(), ["deadline", "r", "s", "sid", "vault", "x", "y"]);
  assert.deepEqual(provider.prompts, ["Withdraw", "Terminate"]);
  assert.throws(() => controlsTarget(parseRuntimePins(null), OWNER), code("funding_runtime_unconfigured"));
});
