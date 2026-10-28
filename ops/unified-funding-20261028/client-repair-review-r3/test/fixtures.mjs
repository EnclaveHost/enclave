// UNREVIEWED, NOT RUN. Shared OFFLINE fixtures for test/offline.test.mjs and test/partition.test.mjs: scripted EIP-1193
// provider (well-known TEST key), scripted relays, a scripted chain whose receipts/blocks/logs carry full canonical
// metadata and go through the REAL canonicalReceipt / receiptFinality, an explicit chain clock (W.time) separate from
// the local clock, Node's WebCrypto (not a browser) and in-memory stores (not IndexedDB). Addresses are fixtures; the
// nine app ids are the HISTORICAL identities of ../RECOVERY-SCOPE-HISTORICAL-r1.json (not current authority).
import assert from "node:assert/strict";
import * as S from "../../../source/sdk/sessions/dist/browser.mjs";
import {
  encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, hexToBytes, keccak256, parseAbi, toHex,
} from "../../../source/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "../../../source/node_modules/viem/_esm/accounts/index.js";
import { fundingConfig, predictVault } from "../../client-r1/funding-codec.mjs";
import { lower, sameAddr } from "../lib/util.mjs";
import { MemoryV2Store } from "../lib/v2-store.mjs";
import { USDC_EVENTS, VAULT_EVENTS, canonicalReceipt, receiptFinality } from "../lib/chain-proof.mjs";
import { actionsMaskV1, buildMigrationPlan, loadLegacyEvidence, signSteps } from "../lib/migration.mjs";

export { S };
export const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";   // public anvil key #0
const acct = privateKeyToAccount(TEST_KEY);
export const OWNER = acct.address;
export const A = (b) => `0x${b.repeat(20)}`;
export const FACTORY = A("11"), IMPL = A("22"), ADAPTER = A("33"), LFACTORY = A("44"), LVAULT = A("55"), USDC = A("66"), RELAYER = A("77");
export const ZERO = `0x${"0".repeat(64)}`;
export const NOW = 1793202897n;                         // block timestamp of session-live-20261028-r2.json
export const LEG_EXP = 1793765924n;                     // live old expiresAt
export const LIVE_ACTIONS_MASK = 43215860598959184859848575143834562855167n;   // live old `actions`, same snapshot
export const DEP = `0x${"d1".repeat(32)}`;
export const APPS = [`0x${"a1".repeat(32)}`, `0x${"b2".repeat(32)}`];
export const TX = (b) => `0x${b.repeat(32)}`;
export const code = (c) => (e) => e?.code === c;
export const rawPoint = (x, y) => new Uint8Array([4, ...hexToBytes(toHex(x, { size: 32 })), ...hexToBytes(toHex(y, { size: 32 }))]);

export const cfg = fundingConfig({ chainId: 8453, factory: FACTORY, implementation: IMPL, vault: predictVault(FACTORY, IMPL, OWNER),
  owner: OWNER, gasAdapter: ADAPTER, legacyFactory: LFACTORY, legacyVault: LVAULT, adapterMaxEthOut: 10n ** 17n,
  adapterFeeTiers: [500, 3000] });
export const runtime = Object.freeze({ cfg, pins: { usdc: USDC, legacyFactory: LFACTORY },
  intake: { openEnabled: true, ownerEnabled: true, feeTiers: [500, 3000], relayer: RELAYER }, intakeWhy: null, relayer: RELAYER });
export const scope = { appIds: APPS, block: 1n,
  deployments: new Map([[DEP, { holder: cfg.legacyVault, env: 2, appId: APPS[0], active: true }]]) };
export const PINS = { schema: "enclave-funding-browser-runtime-r1", chainId: 8453, factory: FACTORY, implementation: IMPL, gasAdapter: ADAPTER,
  legacyFactory: LFACTORY, usdc: USDC, feeTiers: [500, 3000], codehashes: { factory: TX("c1"), implementation: TX("c2"), gasAdapter: TX("c3") },
  source: { kind: "deployed-receipts", deployTxs: [TX("d9")], reviewedBy: "test-fixture" } };
export const OLD_ACTIONS = ["deploy.create", "deploy.fund", "deploy.setAppRef", "deploy.setConfig", "deploy.setShares",
  "deploy.setMaxRate", "deploy.setActive", "deploy.refund", "api.status", "api.logs", "api.restart", "api.upload",
  "api.appAccess", "api.placement", "api.account"];

// ---- the historical nine (deployment -> appId); metal0 = the image app, the rest = NucBox apps -----------------------
export const HIST = Object.freeze([
  ["0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9", "0xefc67700f25204b843dadb224520bbc73ac9755d3b9c2aed9183443bccf5c8e6", "metal0"],
  ["0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a", "0x9afdfb401d6f2cfea70c446f9f5874bbca8ce7dd116e2b15715312d8d32a65ef", "nucbox"],
  ["0xa77d0c577c1ca48510ff72545f9e050dc7d1fc9c6d1129f056494a5190cb8371", "0x550d4da98ad8ece07c0def18c095c7f01bc695727a35d953a2096c49713eaef7", "nucbox"],
  ["0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77", "0x5bca36b520b80fa26272f34886e38344393e1f69098be8ad5a0d2372ec3147bc", "nucbox"],
  ["0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c", "0xf1897f065ed94bc096d351b831514311e08b30702148c639cbaf8d0deb74d03a", "nucbox"],
  ["0xc13d4b6a613ba277e9a8559adb76b2f60394ef16649f7a623e8a7a6c4f097681", "0xfd420627abb04e52e7d12e3a535e2df94a048ba51c0b0fec173e9e7de2e24b28", "nucbox"],
  ["0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238", "0x093fa91736c2639e93867b76074c6c4dbc5e49150faf4e8618bdf45e30d275c6", "nucbox"],
  ["0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c", "0x85f28c21b1545a05aee6661faf4b149b5dd18377fce59ad290e9f19857baab06", "nucbox"],
  ["0x9a28642bed115105c07bea1131c56c83ae2843ce4daf07958ab36437c0528a6b", "0xcdc1fa941d248411e49f922e0bc7adfe8cc343712ca4fe4dfb24fab3ef6c70ce", "nucbox"],
]);
export const IMAGE_APP = HIST.find((r) => r[2] === "metal0")[1];
export const NUC_APPS = HIST.filter((r) => r[2] === "nucbox").map((r) => r[1]).sort();
export const scope9 = { appIds: HIST.map((r) => r[1]).sort(), block: 1n, byApp: Object.fromEntries(HIST.map((r) => [r[1], [r[0]]])),
  deployments: new Map(HIST.map(([d, a]) => [d, { holder: OWNER, env: 2, appId: a, active: true }])) };
/** The CANDIDATE partition (not approved): legacy 29 + gas 0.9 over eight NucBox apps + gas 0.1 over the image app.
 *  The per-part opsPerPeriod values are test placeholders inside the reviewed total of 20. */
export const SPLIT_CANDIDATE = Object.freeze({ legacy6: 29_000_000n, gas: [
  { name: "nucbox", budget6: 900_000n, opsPerPeriod: 18n, appIds: NUC_APPS },
  { name: "image", budget6: 100_000n, opsPerPeriod: 2n, appIds: [IMAGE_APP] }] });

// scripted EIP-1193 provider: signs whatever typed data it is handed with the TEST key, counting prompts
export function scriptedProvider() {
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
export const ended = (vault, sid, reason, refund) => ev(vault, VAULT_EVENTS, "SessionEnded", { sid }, [U8, U256, U256], [reason, refund, 0n]);
export const opened = (vault, sid, keyHash, expiresAt, actions, envs, budget, label) => ev(vault, VAULT_EVENTS, "SessionOpened",
  { sid, keyHash }, [U64, U256, U8, U256, STR], [BigInt(expiresAt), BigInt(actions), envs, BigInt(budget), label]);
export const transfer = (from, to, value) => ev(USDC, USDC_EVENTS, "Transfer", { from, to }, [U256], [BigInt(value)]);
export const authUsed = (authorizer, nonce) => ev(USDC, USDC_EVENTS, "AuthorizationUsed", { authorizer, nonce }, [], []);
const DEAD = Object.freeze({ live: false, state: 0, balance6: 0n, spent6: 0n, apps: [] });

export function world() {
  const W = { head: 1000n, time: NOW, txs: new Map(), receipts: new Map(), logs: [], hidden: new Set(), sessions: new Map(),
    auth: new Set(), wallet: 0n, n: 0 };
  W.bhash = (n) => keccak256(toHex(BigInt(n), { size: 32 }));
  W.block = (n) => ({ number: toHex(n), hash: W.bhash(n), timestamp: toHex(W.time), transactions: W.txs.get(n) ?? [] });
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
    pin: async () => {
      const at = { number: W.head, hash: W.bhash(W.head) };
      return { number: at.number, tag: toHex(at.number), hash: at.hash, timestamp: W.time,
        recheck: async () => { if (W.bhash(at.number) !== at.hash || at.number > W.head) throw Object.assign(new Error("reorg"), { code: "block_reorged" }); } };
    },
    sessionOf: async (_v, sid) => W.sessions.get(lower(sid)) ?? DEAD,
    owner: async () => OWNER, free: async () => 0n, vaultFor: async () => LVAULT,
    usdcBalance: async () => W.wallet, authorizationUsed: async (_u, _w, n) => W.auth.has(lower(n)),
    receipt: (h) => canonicalReceipt(W.rpc, h), finality: (rc) => receiptFinality(W.rpc, rc),
    getLogs: async ({ address, topics, fromBlock }) => W.logs.filter((l) => !W.hidden.has(l.transactionHash) && sameAddr(l.address, address)
      && topics.every((tp, i) => tp == null || l.topics[i] === tp) && BigInt(l.blockNumber) >= BigInt(fromBlock)),
  };
  return W;
}

export const stateOf = (g, over = {}) => ({ live: true, state: 1, keyHash: lower(g.sessionKey), measurement: lower(g.measurement),
  actions: actionsMaskV1(S, g.actions), expiresAt: BigInt(g.expiresAt), envs: 3, anyApp: true, balance6: BigInt(g.budget),
  spent6: 0n, perPeriod6: BigInt(g.spendPerPeriod), maxFee6: BigInt(g.maxFeePerOp), maxAppFeeHour6: BigInt(g.maxAppFeePerHour),
  maxRateHour6: BigInt(g.maxRatePerHour), period: Number(g.periodSeconds), opsPerPeriod: Number(g.opsPerPeriod),
  periodSpent6: 0n, apps: [], ...over });

/** t.mode[path] = "ok" | "refuse" (nothing mined) | "pending" (mined, receipt hidden) | "drop" (mined, reply lost)
 *  | "wrongHash" (legacy /open answers with the terminate tx) | "badReason" (terminate emits reason 2). */
export async function setup() {
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
  const t = { legacyStore, oldGrant, oldRec, oldSid, W, gasStore, mode: {}, calls: [], active: [], minted: {}, gasOpens: [] };
  const finish = (path, tx, extra) => {
    t.minted[path] = tx;
    const mode = t.mode[path] ?? "ok";
    if (mode === "pending") W.hidden.add(tx);
    if (mode === "drop") throw Object.assign(new Error("relay unreachable: connection reset"), { code: "relay" });
    return { txHash: mode === "wrongHash" ? t.minted["/owner"] : tx, ...extra };
  };
  t.legacyRelay = { async request(method, path, body) {
    t.calls.push(`${method} ${path}`);
    const mode = t.mode[path] ?? "ok";
    if (mode === "refuse") throw Object.assign(new Error("simulation refused"), { code: "relay" });
    if (path === "/owner") {
      const sid = lower(body.args.sessionId);
      const old = W.sessions.get(sid);
      W.sessions.set(sid, { ...old, live: false, state: 2, balance6: 0n });
      W.wallet += old.balance6;
      return finish(path, W.mine([ended(LVAULT, sid, mode === "badReason" ? 2 : 1, old.balance6), transfer(LVAULT, OWNER, old.balance6)]), {});
    }
    if (path === "/open") {
      const g = body.grant;
      const sid = lower(S.sessionIdOf(LVAULT, g.sessionKey, g.grantNonce));
      const digest = lower(S.grantDigest(8453, LVAULT, g));
      W.sessions.set(sid, stateOf(g));
      W.auth.add(digest);
      W.wallet -= g.budget;
      return finish(path, W.mine([opened(LVAULT, sid, g.sessionKey, g.expiresAt, actionsMaskV1(S, g.actions), 3, g.budget, g.label),
        authUsed(OWNER, digest), transfer(OWNER, LVAULT, g.budget)]), { sid, vault: LVAULT });
    }
    throw new Error(`unscripted legacy ${path}`);
  } };
  t.relay = async (method, path, body) => {
    t.calls.push(`${method} ${path}`);
    if (path !== "/funding/open") throw Object.assign(new Error("unscripted"), { code: "relay" });
    if ((t.mode[path] ?? "ok") === "refuse") throw Object.assign(new Error("simulation refused"), { code: "relay" });
    const plan = await gasStore.getJournal(t.planId);
    const k = Object.keys(plan.steps).find((s) => s.startsWith("gasOpen") && plan.steps[s].review.grant.grantNonce === body.grant.grantNonce);
    assert.ok(k, "funding open for a grant the journal does not hold");
    t.gasOpens.push(k);
    const r = plan.steps[k].review;
    W.auth.add(r.digest);
    W.wallet -= BigInt(r.grant.budget);
    const tx = W.mine([opened(cfg.vault, r.sid, r.keyHash, r.grant.expiresAt, 1n << 10n, 3, r.grant.budget, r.grant.label),
      authUsed(OWNER, r.digest), transfer(OWNER, cfg.vault, r.grant.budget)]);
    t.minted[k] = tx;
    return finish(path, tx, { sid: r.sid });
  };
  t.ctx = (over = {}) => ({ S, chain: W.chain, legacyRelay: t.legacyRelay, relay: t.relay, runtime, legacyStore, gasStore, now: W.time,
    setActive: async (sid, from) => { t.active.push([sid, from]); }, ...over });
  return t;
}

export async function planned(t, { now = NOW, split = { legacy6: 29_000_000n, gas6: 1_000_000n }, scope: sc = scope } = {}) {
  const evidence = await loadLegacyEvidence({ S, legacyStore: t.legacyStore, sid: t.oldSid, owner: OWNER, chain: t.W.chain,
    legacyConfig: { chainId: 8453, factory: LFACTORY }, runtime, now });
  const plan = await buildMigrationPlan({ S, evidence, runtime, scope: sc, gasStore: t.gasStore, relayBase: "https://relay.test", now, split });
  t.planId = plan.id;
  return plan;
}
export const sign = async (t, steps, now = NOW, provider = scriptedProvider()) => {
  const plan = await t.gasStore.getJournal(t.planId);
  return signSteps({ S, plan, steps, approval: { rootReviewed: true, termsHash: plan.termsHash }, provider, rpc: t.W.rpc, runtime, now });
};
export const statuses = async (t) => Object.fromEntries(Object.entries((await t.gasStore.getJournal(t.planId)).steps).map(([k, s]) => [k, s.status]));
