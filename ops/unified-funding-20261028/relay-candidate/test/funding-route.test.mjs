// OFFLINE tests (relay-r1): node --test test/
// Transport is MOCKED (test/fake-chain.mjs). No contract runs; no P-256, EIP-712 or EIP-3009 signature is verified;
// "simulated refusal" below is a scripted revert. These tests exercise the relay module's control flow only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256 } from "viem";
import {
  createFundingRoute, decodeIntent, encodeIntent, GRANT_COMPONENTS, parseFundingManifest, predictVault,
} from "../funding-route.mjs";
import { encodeDexGasIntent, predictVault as codecPredictVault } from "../../client-candidate/funding-codec.mjs";
import { BAD_R, BLOCK, gasReceipt, makeWorld, manifestOf, memStore, Revert, T } from "./fake-chain.mjs";

const policy = { fee: () => 5_000n, accept: ({ fee6 }) => fee6 >= 4_000n };

function setup({ w = makeWorld(), manifest, quotePolicy = policy, ownerManagement = false, receipt } = {}) {
  const store = memStore();
  const sent = [];
  const simulateAndSend = async (req) => {
    sent.push(req);
    if (typeof receipt === "function") return receipt(req);
    return receipt;
  };
  const route = createFundingRoute({ manifest: manifest === undefined ? manifestOf(w) : manifest, quotePolicy, ownerManagement,
    pc: w.pc, relayer: w.relayer, store, now: () => T, simulateAndSend });
  return { w, store, sent, route };
}

async function refuses(p, status, code) {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    assert.equal(e.status, status);
    return true;
  });
}

const quoteBody = (w) => ({ vault: w.vault, sid: w.sid, deployment: w.deployment, ethOut: 10n ** 15n, feeTier: 500 });
async function quoted(s) {
  const q = await s.route.route("POST", "/funding/quote", quoteBody(s.w));
  return { q, body: { vault: s.w.vault, sid: s.w.sid, nonce: q.nonce, action: 10, args: q.args, fee: q.fee, deadline: q.deadline,
    x: 1n, y: 2n, r: `0x${"0a".repeat(32)}`, s: `0x${"0b".repeat(32)}` } };
}
const executeCalls = (w) => w.calls.filter((c) => c.fn === "execute");

// ---- disabled by default ----------------------------------------------------------------------------------------------

test("offline: no manifest => every /funding route is 503 funding_disabled, nothing read or sent", async () => {
  const s = setup({ manifest: null });
  assert.equal(s.route.enabled, false);
  for (const [m, p] of [["GET", "/funding/config"], ["POST", "/funding/quote"], ["POST", "/funding/execute"], ["POST", "/funding/open"]]) {
    await refuses(s.route.route(m, p, { ownerManagement: true, enable: true }), 503, "funding_disabled");
  }
  assert.equal(s.w.calls.length, 0);
  assert.equal(s.sent.length, 0);
  const bare = createFundingRoute();
  await refuses(bare.route("GET", "/funding/config", {}), 503, "funding_disabled");
});

test("offline: a manifest without a host quote policy stays disabled (no invented price)", async () => {
  for (const qp of [null, { fee: () => 1n }, { accept: () => true }]) {
    const s = setup({ quotePolicy: qp });
    assert.equal(s.route.enabled, false);
    assert.match(s.route.why, /quote policy/);
    await refuses(s.route.route("POST", "/funding/quote", quoteBody(s.w)), 503, "funding_disabled");
    assert.equal(s.w.calls.length, 0);
  }
});

test("offline: manifest refusals (chain, schema, tiers, unknown or enabling fields, empty-code hash)", () => {
  const w = makeWorld();
  const m = manifestOf(w);
  const bad = [
    { ...m, chainId: 84532 }, { ...m, schema: "x" }, { ...m, feeTiers: [250], pools: { 250: m.pools[500] } },
    { ...m, ownerManagement: true }, { ...m, enabled: true },
    { ...m, codehashes: { ...m.codehashes, adapter: keccak256("0x") } },
    { ...m, addresses: { ...m.addresses, quoter: m.addresses.usdc } },
    { ...m, maxSlippageBps: 501 }, { ...m, deadlineSec: 901 },
  ];
  const { factory, ...noFactory } = m.addresses;
  bad.push({ ...m, addresses: noFactory });
  for (const b of bad) assert.ok(parseFundingManifest(b).why, JSON.stringify(Object.keys(b)));
  assert.ok(parseFundingManifest(m).manifest);
});

// ---- pins before any simulation or send ---------------------------------------------------------------------------------

const pinCases = [
  ["chain mismatch", (w) => { w.chainId = 84532; }, "chain_mismatch"],
  ["adapter code hash", (w) => { w.codes[w.A.adapter.toLowerCase()] = "0x6099"; }, "codehash_mismatch"],
  ["legacy implementation missing code", (w) => { delete w.codes[w.A.legacyImplementation.toLowerCase()]; }, "missing_code"],
  ["pool code hash", (w) => { w.codes[w.pool500.toLowerCase()] = "0x6098"; }, "codehash_mismatch"],
  ["factory.implementation()", (w) => { w.contracts[w.A.factory.toLowerCase()].fns.implementation = () => w.A.usdc; }, "identity_mismatch"],
  ["implementation.gasAdapter()", (w) => { w.contracts[w.A.implementation.toLowerCase()].fns.gasAdapter = () => w.A.usdc; }, "identity_mismatch"],
  ["implementation.legacyFactory()", (w) => { w.contracts[w.A.implementation.toLowerCase()].fns.legacyFactory = () => w.A.usdc; }, "identity_mismatch"],
  ["book ledger", (w) => { w.contracts[w.A.book.toLowerCase()].fns.addr = () => w.A.usdc; }, "identity_mismatch"],
  ["reserve ledger", (w) => { w.contracts[w.A.reserve.toLowerCase()].fns.ledger = () => w.A.usdc; }, "identity_mismatch"],
  ["legacy implementation", (w) => { w.contracts[w.A.legacyFactory.toLowerCase()].fns.implementation = () => w.A.usdc; }, "identity_mismatch"],
  ["quoter factory", (w) => { w.contracts[w.A.quoter.toLowerCase()].fns.factory = () => w.A.usdc; }, "identity_mismatch"],
  ["stale block", (w) => { w.timestamp = BigInt(T - 3600); }, "block_stale"],
];

for (const [name, mutate, code] of pinCases) {
  test(`offline: pin "${name}" => 503 ${code} before any execute simulation or send`, async () => {
    const w = makeWorld();
    const manifest = manifestOf(w);          // pinned to the GOOD world
    const s = setup({ w, manifest, receipt: () => assert.fail("must not send") });
    const { body } = await quoted(s);
    mutate(w);
    w.calls.length = 0;
    await refuses(s.route.route("POST", "/funding/execute", body), 503, code);
    assert.equal(executeCalls(w).length, 0);
    assert.equal(s.sent.length, 0);
  });
}

test("offline: an unlinked library is refused (implementation code must embed both library addresses)", async () => {
  const w = makeWorld();
  w.codes[w.A.implementation.toLowerCase()] = "0x60016000";
  const s = setup({ w });
  await refuses(s.route.route("GET", "/funding/config"), 503, "library_unlinked");
});

test("offline: a stale manifest (now > notAfter) is refused", async () => {
  const w = makeWorld();
  const s = setup({ w, manifest: manifestOf(w, { notAfter: T - 1 }) });
  await refuses(s.route.route("GET", "/funding/config"), 503, "manifest_stale");
});

test("offline: every pin, vault and session read uses ONE pinned block", async () => {
  const s = setup();
  await quoted(s);
  const tags = new Set(s.w.calls.map((c) => c.block));
  assert.deepEqual([...tags], [`0x${BLOCK.toString(16)}`]);
});

// ---- vault identity ---------------------------------------------------------------------------------------------------

test("offline: a vault the successor factory does not register is 404", async () => {
  const s = setup();
  s.w.contracts[s.w.A.factory.toLowerCase()].fns.isVault = () => false;
  await refuses(s.route.route("POST", "/funding/quote", quoteBody(s.w)), 404, "not_a_funding_vault");
});

test("offline: a vault whose owner() lies is refused (CREATE2 prediction, not owner())", async () => {
  const s = setup();
  s.w.contracts[s.w.vault.toLowerCase()].fns.owner = () => getAddress(`0x${"77".repeat(20)}`);
  await refuses(s.route.route("POST", "/funding/quote", quoteBody(s.w)), 409, "vault_identity");
});

// ---- quote ------------------------------------------------------------------------------------------------------------

test("offline: quote = real QuoterV2 amount + bounded slippage, capped by the grant; payer is the vault", async () => {
  const s = setup();
  const { q } = await quoted(s);
  assert.equal(q.quote.amountIn6, 3_000_000n);
  assert.equal(q.maximum.maxUsdcIn6, 3_015_000n);        // ceil(3_000_000 * 1.005)
  assert.equal(q.fee, 5_000n);
  assert.equal(q.maximum.totalMaximum6, 3_020_000n);
  assert.equal(q.intent.payer, s.w.vault);
  assert.equal(q.intent.fee, 500);
  assert.equal(q.action, 10);
  assert.deepEqual(decodeIntent(q.args), q.intent);
  const qc = s.w.calls.find((c) => c.fn === "quoteExactOutputSingle");
  assert.equal(qc.to, s.w.A.quoter);
  assert.equal(qc.args[0].tokenIn, s.w.A.usdc);
  assert.equal(qc.args[0].tokenOut, s.w.A.weth);
});

test("offline: the maximum never exceeds the grant's price cap", async () => {
  const s = setup();
  s.w.gasPolicy = [5_000_000n, 3_010_000_000n, 10n ** 16n];   // $3010/ETH => cap 3_010_000 for 0.001 ETH
  const { q } = await quoted(s);
  assert.equal(q.maximum.maxUsdcIn6, 3_010_000n);
});

test("offline: quote refusals - grant cap, fee cap, unpinned tier, missing quote (never a fake price)", async () => {
  let s = setup();
  s.w.gasPolicy = [2_000_000n, 5_000_000_000n, 10n ** 16n];
  await refuses(s.route.route("POST", "/funding/quote", quoteBody(s.w)), 409, "quote_exceeds_grant");
  s = setup({ quotePolicy: { fee: () => 30_000n, accept: () => true } });
  await refuses(s.route.route("POST", "/funding/quote", quoteBody(s.w)), 409, "fee_exceeds_grant");
  s = setup();
  await refuses(s.route.route("POST", "/funding/quote", { ...quoteBody(s.w), feeTier: 3000 }), 400, "fee_tier_not_pinned");
  s = setup();
  s.w.amountIn = new Revert("0x");
  await refuses(s.route.route("POST", "/funding/quote", quoteBody(s.w)), 502, "quote_unavailable");
  s = setup();
  s.w.session = { ...s.w.session, actions: 1n << 1n };
  await refuses(s.route.route("POST", "/funding/quote", quoteBody(s.w)), 403, "not_allowed");
});

test("offline: a record in the owner's ORIGINAL vault is quoted in place (legacy factory proof), nothing migrated", async () => {
  const s = setup();
  s.w.holder = s.w.oldVault;
  const { q } = await quoted(s);
  assert.equal(q.intent.expectedOwner, s.w.oldVault);
  assert.equal(q.holderKind, "legacyVault");
  s.w.contracts[s.w.A.legacyFactory.toLowerCase()].fns.isVault = () => false;
  await refuses(s.route.route("POST", "/funding/quote", quoteBody(s.w)), 403, "not_mine");
  assert.equal(s.sent.length, 0);
});

// ---- execute ----------------------------------------------------------------------------------------------------------

test("offline: execute simulates at the pinned block, calls simulateAndSend ONCE with the exact ABI args, returns ACTUAL", async () => {
  const s = setup({ receipt: null });
  const { q, body } = await quoted(s);
  const used = 2_990_000n;
  s.sent.length = 0;
  const s2 = { ...s };
  const route = createFundingRoute({ manifest: manifestOf(s.w), quotePolicy: policy, pc: s.w.pc, relayer: s.w.relayer, store: s.store,
    now: () => T, simulateAndSend: async (req) => { s2.sent.push(req); return gasReceipt(s.w, { intent: q.intent, nonce: q.nonce, args: q.args, fee: q.fee, used }); } });
  const out = await route.route("POST", "/funding/execute", body);
  assert.equal(s.sent.length, 1);
  const req = s.sent[0];
  assert.equal(req.to, s.w.vault);
  assert.equal(req.functionName, "execute");
  assert.deepEqual(req.args, [s.w.sid, q.nonce, 10, q.args, q.fee, q.deadline, 1n, 2n, body.r, body.s]);
  assert.equal(Object.keys(req).sort().join(","), "abi,args,functionName,label,to");
  const sim = executeCalls(s.w);
  assert.equal(sim.length, 1);
  assert.equal(sim[0].block, `0x${BLOCK.toString(16)}`);
  assert.equal(getAddress(sim[0].from), s.w.relayer);
  assert.equal(out.settlement.actual.usdcSpent6, used);
  assert.equal(out.settlement.actual.totalDebit6, used + q.fee);
  assert.equal(out.settlement.maximum.maxUsdcIn6, 3_015_000n);
  assert.equal(out.settlement.refund6, 3_015_000n - used);
  const idx = s.store.data.fundingOps[s.w.sid];
  assert.equal(idx.length, 1);
  assert.equal(idx[0].amount6, used.toString());           // the index records what was SPENT, not the maximum
  assert.equal(idx[0].maxUsdcIn6, "3015000");
  assert.deepEqual(Object.keys(s.store.data.vaults), []);  // the original factory's index is untouched
});

test("offline: simulated refusal (scripted BadSignature) => 409 revert, nothing sent", async () => {
  const s = setup({ receipt: () => assert.fail("must not send") });
  const { body } = await quoted(s);
  await refuses(s.route.route("POST", "/funding/execute", { ...body, r: BAD_R }), 409, "revert").catch(async (e) => { throw e; });
  assert.equal(s.sent.length, 0);
  const s2 = setup({ receipt: () => assert.fail("must not send") });
  const { body: b2 } = await quoted(s2);
  await assert.rejects(s2.route.route("POST", "/funding/execute", { ...b2, r: BAD_R }), (e) => e.extra?.errorName === "BadSignature");
});

test("offline: wrong payer / wrong action / retired action are refused before any chain read", async () => {
  const s = setup({ receipt: () => assert.fail("must not send") });
  const { q, body } = await quoted(s);
  s.w.calls.length = 0;
  const otherPayer = encodeIntent({ ...q.intent, payer: s.w.owner });
  await refuses(s.route.route("POST", "/funding/execute", { ...body, args: otherPayer }), 400, "wrong_payer");
  await refuses(s.route.route("POST", "/funding/execute", { ...body, action: 9 }), 400, "bad_action");
  await refuses(s.route.route("POST", "/funding/execute", { ...body, action: 1 }), 400, "bad_action");
  await refuses(s.route.route("POST", "/funding/execute", { ...body, args: `${q.args}00` }), 400, "bad_request");
  await refuses(s.route.route("POST", "/funding/execute", { ...body, deadline: q.intent.deadline + 1n }), 400, "bad_deadline");
  assert.equal(s.w.calls.length, 0);
  assert.equal(s.sent.length, 0);
});

test("offline: a session revoked in the host's shared store is refused before anything is read or sent", async () => {
  const s = setup({ receipt: () => assert.fail("must not send") });
  const { body } = await quoted(s);
  s.w.calls.length = 0;
  s.store.data.revoked[s.w.sid] = T;
  await refuses(s.route.route("POST", "/funding/execute", body), 409, "not_live");
  await refuses(s.route.route("POST", "/funding/quote", quoteBody(s.w)), 409, "not_live");
  assert.equal(s.w.calls.length, 0);
  assert.equal(s.sent.length, 0);
});

test("offline: the quote moving above the signed maximum, or the policy refusing, sends nothing", async () => {
  let s = setup({ receipt: () => assert.fail("must not send") });
  let { body } = await quoted(s);
  s.w.amountIn = 3_100_000n;
  await refuses(s.route.route("POST", "/funding/execute", body), 409, "quote_moved");
  s = setup({ quotePolicy: { fee: () => 5_000n, accept: () => false }, receipt: () => assert.fail("must not send") });
  ({ body } = await quoted(s));
  await refuses(s.route.route("POST", "/funding/execute", body), 402, "policy_refused");
  assert.equal(executeCalls(s.w).length, 0);
});

test("offline: a failed receipt is an error and indexes nothing", async () => {
  const w = makeWorld();
  let q;
  const s = setup({ w, receipt: () => gasReceipt(w, { intent: q.intent, nonce: q.nonce, args: q.args, fee: q.fee, used: 1n, status: "reverted" }) });
  const r = await quoted(s);
  q = r.q;
  await refuses(s.route.route("POST", "/funding/execute", r.body), 409, "reverted");
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.store.data.fundingOps, {});
});

test("offline: settlement refuses maximum-as-spending, a foreign relayer, and actual > maximum", async () => {
  const cases = [
    [(q) => ({ used: 2_990_000n, amount6: q.intent.maxUsdcIn6 }), "settlement_amount"],
    [() => ({ used: 2_990_000n, relayer: getAddress(`0x${"99".repeat(20)}`) }), "settlement_relayer"],
    [(q) => ({ used: q.intent.maxUsdcIn6 + 1n }), "settlement_actual"],
  ];
  for (const [over, code] of cases) {
    const w = makeWorld();
    let q;
    const s = setup({ w, receipt: () => gasReceipt(w, { intent: q.intent, nonce: q.nonce, args: q.args, fee: q.fee, ...over(q) }) });
    const r = await quoted(s);
    q = r.q;
    await refuses(s.route.route("POST", "/funding/execute", r.body), 502, code);
    assert.deepEqual(s.store.data.fundingOps, {});
  }
});

// ---- open ---------------------------------------------------------------------------------------------------------------

const grant = (w, over = {}) => {
  const g = { label: "gas", preset: "gas", sessionKey: `0x${"5e".repeat(32)}`, actions: ["gas.fund"], apps: ["*"], environments: ["prod"],
    budget: 1_000_000n, spendPerPeriod: 1_000_000n, periodSeconds: 86400, opsPerPeriod: 0, maxFeePerOp: 20_000n, maxAppFeePerHour: 0n,
    maxRatePerHour: 0n, maxGasUsdcPerOp: 500_000n, maxUsdcPerEth6: 5_000_000_000n, maxEthPerOp: 10n ** 16n, expiresAt: BigInt(T + 3600),
    measurement: `0x${"00".repeat(32)}`, grantNonce: `0x${"01".repeat(32)}`, signBefore: BigInt(T + 600), ...over };
  return g;
};

test("offline: /funding/open is disabled unless HOST code passes ownerManagement; body/manifest flags cannot enable it", async () => {
  const s = setup();
  assert.equal(s.route.enabled, true);
  assert.equal(s.route.openEnabled, false);
  for (const body of [{}, { ownerManagement: true }, { owner: s.w.owner, grant: grant(s.w), ownerSig: "0x", ownerManagement: true }]) {
    await refuses(s.route.route("POST", "/funding/open", body), 503, "funding_open_disabled");
  }
  const cfg = await s.route.route("GET", "/funding/config");
  assert.equal(cfg.open.enabled, false);
  assert.equal(s.sent.length, 0);
});

test("offline: open refuses an original-shaped grant (no gas limits) - no implicit migration or widening", async () => {
  const s = setup({ ownerManagement: true, receipt: () => assert.fail("must not send") });
  const { maxGasUsdcPerOp, maxUsdcPerEth6, maxEthPerOp, ...v1 } = grant(s.w);
  await refuses(s.route.route("POST", "/funding/open", { owner: s.w.owner, grant: v1, ownerSig: "0x1234" }), 400, "grant_missing_gas_limits");
  await refuses(s.route.route("POST", "/funding/open", { owner: s.w.owner, grant: grant(s.w), ownerSig: "0x1234" }), 400, "bad_request");
  assert.equal(s.sent.length, 0);
});

test("offline: open (host-enabled) simulates the factory call, sends ONCE, and never touches the original vault", async () => {
  const w = makeWorld();
  const { eventLog } = await import("./fake-chain.mjs");
  const { fundingSessionVaultAbi } = await import("../generated/funding-abi.mjs");
  const s = setup({ w, ownerManagement: true, receipt: () => ({ status: "success", transactionHash: `0x${"22".repeat(32)}`, blockNumber: BLOCK + 1n,
    logs: [eventLog(fundingSessionVaultAbi, w.vault, "SessionOpened", { sid: w.sid, keyHash: `0x${"5e".repeat(32)}`, expiresAt: BigInt(T + 3600),
      actions: 1n << 10n, envs: 2, budget6: 1_000_000n, label: "gas" })] }) });
  const g = grant(w);
  const out = await s.route.route("POST", "/funding/open", { owner: w.owner, grant: g, ownerSig: "0x1234",
    deposit: { validAfter: 0n, validBefore: BigInt(T + 600), sig: "0xabcd" } });
  assert.equal(out.vault, w.vault);
  assert.equal(out.sid, w.sid);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].to, w.A.factory);
  assert.equal(s.sent[0].functionName, "openWithDepositFor");
  assert.equal(s.sent[0].args[0], w.owner);
  assert.deepEqual(Object.keys(s.sent[0].args[1]), GRANT_COMPONENTS.map((c) => c.name));
  assert.equal(w.calls.filter((c) => c.fn === "openWithDepositFor").length, 1);
  assert.equal(w.calls.filter((c) => c.to === w.oldVault).length, 0);
  assert.equal(s.store.data.fundingVaults[w.vault], w.owner);
});

// ---- static and cross-checks ------------------------------------------------------------------------------------------

test("static: the module has no wallet client, key, TxQueue, nonce manager or signer", () => {
  const src = readFileSync(fileURLToPath(new URL("../funding-route.mjs", import.meta.url)), "utf8");
  for (const re of [/new\s+TxQueue/, /createWalletClient\s*\(/, /privateKeyToAccount\s*\(/, /\.sendTransaction\s*\(/,
    /sendRawTransaction/, /signTypedData\s*\(/, /\.writeContract\s*\(/, /getTransactionCount/, /\bfetch\s*\(/, /process\.env\.[A-Z_]*KEY/]) {
    assert.doesNotMatch(src, re);
  }
});

test("cross-check: CREATE2 prediction and intent encoding agree with client-r1/funding-codec.mjs", () => {
  const w = makeWorld();
  assert.equal(predictVault(w.A.factory, w.A.implementation, w.owner), codecPredictVault(w.A.factory, w.A.implementation, w.owner));
  const i = { payer: w.vault, deployment: w.deployment, expectedOwner: w.owner, ethOut: 10n ** 15n, maxUsdcIn6: 3_015_000n, fee: 500,
    deadline: BigInt(T + 120) };
  assert.equal(encodeIntent(i), encodeDexGasIntent(i));
  assert.equal(GRANT_COMPONENTS.length, 20);
});
