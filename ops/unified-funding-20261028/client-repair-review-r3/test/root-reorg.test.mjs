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

test("root: reconcile rechecks previously proven canonical-only steps before re-adopting", async()=>{
 const t=await setup(); await planned(t);
 t.W.chain.finality=async()=>({final:false});
 await runMigration(t.ctx(),t.planId,await sign(t,["terminate","legacyOpen"]));
 t.W.hidden.add(t.minted["/open"]);
 const prior=t.active.length;
 let refused=false; try { const r=await reconcileMigration(t.ctx(),t.planId); refused=r.steps.legacyOpen!=="proven"; } catch {refused=true;}
 assert.ok(refused,"reorged replacement kept proven");
 assert.equal(t.active.length,prior,"must not re-adopt an orphaned replacement");
});
test("root: next funding step cannot use an orphaned prior canonical-only proof",async()=>{
 const t=await setup();await planned(t);t.W.chain.finality=async()=>({final:false});
 await runMigration(t.ctx(),t.planId,await sign(t,["terminate","legacyOpen"]));
 t.W.hidden.add(t.minted["/owner"]);t.W.hidden.add(t.minted["/open"]);
 const before=t.calls.length;
 try { await runMigration(t.ctx(),t.planId,await sign(t,["gasOpen"])); } catch {}
 assert.equal(t.calls.length,before,"sent gas open after prior receipt disappeared");
});
test("root: finality refuses mismatched canonical header number",async()=>{
 const h="0x"+"11".repeat(32),bh="0x"+"ab".repeat(32);
 const rc={transactionHash:h,blockHash:bh,blockNumber:"0x10"};
 await assert.rejects(receiptFinality(async(_m,p)=>p[0]==="finalized"?{number:"0x20",hash:bh}:{number:"0x11",hash:bh},rc));
});
