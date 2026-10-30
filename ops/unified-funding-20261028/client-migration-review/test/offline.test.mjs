// UNREVIEWED, NOT RUN. Bounded OFFLINE tests: scripted EIP-1193 provider (well-known TEST key), scripted relays, scripted
// chain adapter and JSON-RPC, Node's WebCrypto (not a browser) and in-memory stores (not IndexedDB). They check codec
// wiring, refusals, ordering and record preservation. They prove NOTHING about a real wallet, browser UI, IndexedDB,
// the deployed contracts, the live relays or production. Addresses below are test fixtures, never deployment values.
// Run (root, after review): node --test test/offline.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../../../source/sdk/sessions/dist/browser.mjs";
import {
  encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, hexToBytes, keccak256, parseAbi, toHex,
} from "../../../source/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "../../../source/node_modules/viem/_esm/accounts/index.js";
import { buildGasFundCall, fundingConfig, keyHashOf, predictVault } from "../../client-r1/funding-codec.mjs";
import { jsonable, lower } from "../lib/util.mjs";
import { LEGACY_DB, IndexedDbV2Store, MemoryV2Store, newGasKey, newGasRecord, signerFor, validateGasRecord } from "../lib/v2-store.mjs";
import { buildGasGrant, depositTypedData, grantBody, quoteGasFund } from "../lib/funding-client.mjs";
import {
  REPLACED_FIELDS, V1_GRANT_FIELDS, actionsMaskV1, buildMigrationPlan, executeMigration, loadLegacyEvidence,
  reconcileMigration, signMigration,
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
const BH = `0x${"bb".repeat(32)}`;
const TX = (b) => `0x${b.repeat(32)}`;

const cfg = fundingConfig({ chainId: 8453, factory: FACTORY, implementation: IMPL, vault: predictVault(FACTORY, IMPL, OWNER),
  owner: OWNER, gasAdapter: ADAPTER, legacyFactory: LFACTORY, legacyVault: LVAULT, adapterMaxEthOut: 10n ** 17n,
  adapterFeeTiers: [500, 3000] });
const runtime = Object.freeze({ cfg, pins: { usdc: USDC, legacyFactory: LFACTORY },
  intake: { openEnabled: true, ownerEnabled: true, feeTiers: [500, 3000], relayer: RELAYER }, intakeWhy: null, relayer: RELAYER });
const scope = { appIds: APPS, block: 1n,
  deployments: new Map([[DEP, { holder: cfg.legacyVault, env: 2, appId: APPS[0], active: true }]]) };

const OLD_ACTIONS = ["deploy.create", "deploy.fund", "deploy.setAppRef", "deploy.setConfig", "deploy.setShares",
  "deploy.setMaxRate", "deploy.setActive", "deploy.refund", "api.status", "api.logs", "api.restart", "api.upload",
  "api.appAccess", "api.placement", "api.account"];

const rawPoint = (x, y) => new Uint8Array([4, ...hexToBytes(toHex(x, { size: 32 })), ...hexToBytes(toHex(y, { size: 32 }))]);

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

const ERC = parseAbi(["function name() view returns (string)", "function version() view returns (string)"]);
function scriptedRpc() {
  const rpc = async (method, params) => {
    rpc.calls.push(method);
    if (method === "eth_call") {
      const fn = params[0].data === encodeFunctionData({ abi: ERC, functionName: "name" }) ? "name" : "version";
      return encodeFunctionResult({ abi: ERC, functionName: fn, result: fn === "name" ? "USD Coin" : "2" });
    }
    if (method === "eth_getTransactionReceipt") return { blockHash: BH, blockNumber: "0x10", status: "0x1", logs: [] };
    if (method === "eth_getBlockByNumber") return { hash: BH, number: "0x10" };
    throw new Error(`unscripted ${method}`);
  };
  rpc.calls = [];
  return rpc;
}

const stateOf = (g, over = {}) => ({ live: true, state: 1, keyHash: lower(g.sessionKey), measurement: lower(g.measurement),
  actions: actionsMaskV1(S, g.actions), expiresAt: BigInt(g.expiresAt), envs: 3, anyApp: true, balance6: BigInt(g.budget),
  spent6: 0n, perPeriod6: BigInt(g.spendPerPeriod), maxFee6: BigInt(g.maxFeePerOp), maxAppFeeHour6: BigInt(g.maxAppFeePerHour),
  period: Number(g.periodSeconds), opsPerPeriod: Number(g.opsPerPeriod), periodSpent6: 0n, apps: [], ...over });

async function setup({ openFails = false } = {}) {
  const legacyStore = new S.MemoryStore();
  const { record } = await S.newSessionKey(legacyStore, { relay: "https://relay.test", chainId: 8453, label: "Browser · test", extractable: false });
  const oldGrant = { label: "Browser · test", preset: "browser", sessionKey: record.keyHash, actions: OLD_ACTIONS, apps: [],
    environments: ["staging", "prod"], budget: 30_000_000n, spendPerPeriod: 100_000_000n, periodSeconds: 86400, opsPerPeriod: 1000,
    maxFeePerOp: 250_000n, maxAppFeePerHour: 0n, maxRatePerHour: 0n, expiresAt: LEG_EXP, measurement: ZERO,
    grantNonce: `0x${"01".repeat(32)}`, signBefore: NOW - 600n };
  const oldRec = await S.completeSession(legacyStore, record, { vault: LVAULT, owner: OWNER, grant: oldGrant });
  const oldSid = lower(oldRec.id);

  const chain = { sessions: new Map([[oldSid, stateOf(oldGrant)]]), receipts: new Map(), auth: new Set(), wallet: 0n,
    sessionOf: async (_v, sid) => chain.sessions.get(lower(sid)) ?? { ...stateOf(oldGrant), live: false, state: 0, balance6: 0n },
    owner: async () => OWNER, free: async () => 0n, vaultFor: async () => LVAULT,
    usdcBalance: async () => chain.wallet, authorizationUsed: async (_u, _w, n) => chain.auth.has(lower(n)),
    receipt: async (h) => chain.receipts.get(lower(h)) ?? null };

  const legacyRelay = { calls: [], async request(method, path, body) {
    legacyRelay.calls.push(`${method} ${path}`);
    if (path === "/owner" && body.op === "terminate") {
      const sid = lower(body.args.sessionId);
      chain.sessions.set(sid, { ...chain.sessions.get(sid), live: false, state: 2, balance6: 0n });
      chain.wallet += 30_000_000n;
      chain.receipts.set(TX("e1"), { logs: [{ address: LVAULT,
        topics: encodeEventTopics({ abi: S.sessionVaultAbi, eventName: "SessionEnded", args: { sid } }),
        data: encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }], [1, 30_000_000n, 0n]) }] });
      return { txHash: TX("e1") };
    }
    if (path === "/open") {
      if (openFails) throw Object.assign(new Error("relay unreachable: ECONNRESET"), { code: "relay" });
      assert.ok(body.deposit?.sig && body.ownerSig);
      const sid = lower(S.sessionIdOf(LVAULT, body.grant.sessionKey, body.grant.grantNonce));
      chain.sessions.set(sid, stateOf(body.grant));
      chain.auth.add(lower(S.grantDigest(8453, LVAULT, body.grant)));
      chain.wallet -= BigInt(body.grant.budget);
      chain.receipts.set(TX("e2"), { logs: [] });
      return { txHash: TX("e2"), sid, vault: LVAULT };
    }
    throw new Error(`unscripted legacy ${path}`);
  } };

  const relay = async (method, path, body) => {
    relay.calls.push(`${method} ${path}`);
    if (path === "/funding/open") return { txHash: TX("e3"), sid: relay.gasSid };
    throw Object.assign(new Error("unscripted"), { code: "relay" });
  };
  relay.calls = [];
  return { legacyStore, oldGrant, oldRec, oldSid, chain, legacyRelay, relay, gasStore: new MemoryV2Store(), rpc: scriptedRpc() };
}

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
  assert.equal("handle" in rec, false);                     // v1 sessionFromRecord refuses it
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
  const relayWith = (q, balance6 = "1000000") => async (method, path) => (method === "GET"
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

test("legacy evidence: live mask reproduced from the v1 SDK; missing record / changed chain state STOP", async () => {
  assert.equal(actionsMaskV1(S, OLD_ACTIONS), LIVE_ACTIONS_MASK);
  const t = await setup();
  const ev = (over = {}) => loadLegacyEvidence({ S, legacyStore: t.legacyStore, sid: t.oldSid, owner: OWNER, chain: t.chain,
    legacyConfig: { chainId: 8453, factory: LFACTORY }, runtime, ...over });
  const e = await ev();
  assert.equal(e.state.balance6, 30_000_000n);
  await assert.rejects(ev({ legacyStore: new S.MemoryStore() }), { code: "legacy_record_missing" });
  t.chain.sessions.set(t.oldSid, stateOf(t.oldGrant, { spent6: 1n }));
  await assert.rejects(ev(), { code: "legacy_state_changed" });
  t.chain.sessions.set(t.oldSid, stateOf(t.oldGrant, { maxFee6: 1n }));
  await assert.rejects(ev(), { code: "legacy_fields_mismatch" });
});

async function planned(t) {
  const evidence = await loadLegacyEvidence({ S, legacyStore: t.legacyStore, sid: t.oldSid, owner: OWNER, chain: t.chain,
    legacyConfig: { chainId: 8453, factory: LFACTORY }, runtime });
  const out = await buildMigrationPlan({ S, evidence, runtime, scope, gasStore: t.gasStore, relayBase: "https://relay.test",
    now: NOW, split: { legacy6: 29_000_000n, gas6: 1_000_000n } });
  t.relay.gasSid = out.plan.gasSid;
  return { evidence, ...out };
}

test("plan: explicit split must sum to the fresh balance; replacement changes only budget/grantNonce/signBefore", async () => {
  const t = await setup();
  const evidence = await loadLegacyEvidence({ S, legacyStore: t.legacyStore, sid: t.oldSid, owner: OWNER, chain: t.chain,
    legacyConfig: { chainId: 8453, factory: LFACTORY }, runtime });
  const b = (split) => buildMigrationPlan({ S, evidence, runtime, scope, gasStore: t.gasStore, relayBase: "https://relay.test", now: NOW, split });
  await assert.rejects(b(undefined), { code: "split_required" });
  await assert.rejects(b({ legacy6: 29_000_000n, gas6: 2_000_000n }), { code: "split_total" });
  await assert.rejects(b({ legacy6: 30_000_000n, gas6: 0n }), { code: "split_zero" });
  assert.equal((await t.gasStore.listKeys()).length, 0);    // refused plans created no gas key

  const { plan, internal } = await planned(t);
  for (const f of V1_GRANT_FIELDS) {
    if (!REPLACED_FIELDS.includes(f)) assert.deepEqual(internal.replacement[f], t.oldGrant[f], f);
  }
  assert.equal(internal.replacement.budget, 29_000_000n);
  assert.notEqual(internal.replacement.grantNonce, t.oldGrant.grantNonce);
  assert.equal(internal.replacement.signBefore, NOW + 900n);
  assert.equal(internal.legacyTd.domain.version, "1");
  assert.equal(internal.legacyTd.domain.verifyingContract, LVAULT);
  assert.equal(plan.terms.split.total6, "30000000");
  assert.equal(lower(internal.replacement.sessionKey), lower(t.oldRec.keyHash));   // SAME legacy key
  assert.notEqual(plan.gasKeyHash, lower(t.oldRec.keyHash));                      // fresh gas key
});

test("sign: no prompt without the root termsHash; then exactly 5 prompts in order", async () => {
  const t = await setup();
  const { plan, internal } = await planned(t);
  const provider = scriptedProvider();
  const sign = (approval) => signMigration({ plan, internal, approval, provider, rpc: t.rpc, runtime, now: NOW });
  await assert.rejects(sign(null), { code: "approval_required" });
  await assert.rejects(sign({ rootReviewed: true, termsHash: ZERO }), { code: "approval_required" });
  assert.equal(provider.prompts.length, 0);
  await sign({ rootReviewed: true, termsHash: plan.termsHash });
  assert.deepEqual(provider.prompts, ["Terminate", "SessionGrant", "ReceiveWithAuthorization", "SessionGrant", "ReceiveWithAuthorization"]);
});

test("execute (scripted): terminate -> legacy 29 -> gas 1; old record preserved; active moves once; no resend", async () => {
  const t = await setup();
  const { plan, internal } = await planned(t);
  const signed = await signMigration({ plan, internal, approval: { rootReviewed: true, termsHash: plan.termsHash },
    provider: scriptedProvider(), rpc: t.rpc, runtime, now: NOW });
  const active = [];
  const run = () => executeMigration({ S, plan, internal, signed, legacyRelay: t.legacyRelay, relay: t.relay, chain: t.chain,
    rpc: t.rpc, runtime, legacyStore: t.legacyStore, gasStore: t.gasStore, setActive: (sid) => active.push(sid), now: NOW });
  const out = await run();
  assert.equal(out.pending, false);
  assert.deepEqual(t.legacyRelay.calls, ["POST /owner", "POST /open"]);
  assert.deepEqual(t.relay.calls, ["POST /funding/open"]);
  assert.deepEqual(active, [plan.newLegacySid]);
  assert.equal(t.chain.wallet, 1_000_000n);                // scripted: the gas deposit is not modelled here

  const old = await t.legacyStore.load(t.oldRec.id);
  assert.ok(old, "old legacy record kept");
  assert.equal(old.keyHash, t.oldRec.keyHash);
  assert.equal(old.grant.budget, 30_000_000n);
  assert.equal(old.handle.sid, t.oldRec.handle.sid);
  const rep = await t.legacyStore.load(plan.newLegacySid);
  assert.equal(rep.privateKey, t.oldRec.privateKey);       // same non-extractable CryptoKey, by reference
  assert.equal(rep.grant.budget, 29_000_000n);
  assert.equal(rep.handle.sid, plan.newLegacySid);
  assert.equal((await t.gasStore.loadKey(plan.gasRecordId)).status, "open");

  const j = await t.gasStore.getJournal(plan.id);
  assert.deepEqual(j.steps, { terminate: "done", legacyOpen: "done", gasOpen: "done" });
  const all = JSON.stringify(await t.gasStore.listJournal());
  for (const sig of [signed.terminate.sig, signed.legacyOpen.ownerSig, signed.legacyOpen.deposit.sig, signed.gasOpen.ownerSig]) {
    assert.equal(all.includes(sig.slice(2)), false, "no signature is journaled");
  }
  await assert.rejects(run(), { code: "step_not_planned" });
  assert.equal(t.legacyRelay.calls.length, 2);
});

test("execute (scripted): replacement open unknown -> stop, nothing resent, old record + pointer kept, reconcile says what to do", async () => {
  const t = await setup({ openFails: true });
  const { plan, internal } = await planned(t);
  const signed = await signMigration({ plan, internal, approval: { rootReviewed: true, termsHash: plan.termsHash },
    provider: scriptedProvider(), rpc: t.rpc, runtime, now: NOW });
  const active = [];
  await assert.rejects(executeMigration({ S, plan, internal, signed, legacyRelay: t.legacyRelay, relay: t.relay, chain: t.chain,
    rpc: t.rpc, runtime, legacyStore: t.legacyStore, gasStore: t.gasStore, setActive: (sid) => active.push(sid), now: NOW }));
  const j = await t.gasStore.getJournal(plan.id);
  assert.deepEqual(j.steps, { terminate: "done", legacyOpen: "unknown", gasOpen: "planned" });
  assert.deepEqual(t.relay.calls, []);
  assert.deepEqual(active, []);
  assert.ok(await t.legacyStore.load(t.oldRec.id));
  const r = await reconcileMigration({ plan, chain: t.chain, relay: t.relay, runtime, gasStore: t.gasStore });
  assert.equal(r.facts.legacyOpen.opened, false);
  assert.ok(r.next.some((n) => n.state === "legacyOpen:unknown"));
  assert.deepEqual(t.legacyRelay.calls, ["POST /owner", "POST /open"]);   // reconcile submitted nothing
});
