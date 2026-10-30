// production-grant-terms-r1 candidate tests. UNREVIEWED, NOT RUN by their author. Bounded OFFLINE tests over the
// GENERATED candidate (candidate/sdk/funding, from generator/generate_sdk.py --link-viem) next to the ORIGINAL
// source/sdk/funding modules. Scripted relays, a public TEST key, test addresses; the app/deployment ids are the
// provisional recovery ids from CANDIDATE-TERMS.json used as plain data. They prove the codec / split / plan wiring of
// the NEW candidate gas-recovery-6usdc-r1 only - nothing about a wallet, browser, contracts, relays or production.
// Run (root, after generating the candidate):  node --test production-grant-terms-r1/test/candidate-terms.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { privateKeyToAccount } from "../../../source/node_modules/viem/_esm/accounts/index.js";
import * as S from "../../../source/sdk/sessions/dist/browser.mjs";
import * as C from "../candidate/sdk/funding/funding-client.mjs";
import * as CM from "../candidate/sdk/funding/migration.mjs";
import * as CC from "../candidate/sdk/funding/funding-codec.mjs";
import * as CX from "../candidate/sdk/funding/gas-execution.mjs";
import { MemoryV2Store } from "../candidate/sdk/funding/v2-store.mjs";
import { canon, hashOf, jsonable } from "../candidate/sdk/funding/util.mjs";
import * as O from "../../../source/sdk/funding/funding-client.mjs";
import * as OM from "../../../source/sdk/funding/migration.mjs";
import * as OC from "../../../source/sdk/funding/funding-codec.mjs";
import * as OX from "../../../source/sdk/funding/gas-execution.mjs";

const HERE = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");          // production-grant-terms-r1
const SRC = path.resolve(HERE, "..", "..", "source", "sdk", "funding");
const TERMS = JSON.parse(fs.readFileSync(path.join(HERE, "CANDIDATE-TERMS.json"), "utf8"));
const QUOTE = JSON.parse(fs.readFileSync(path.resolve(HERE, "..", "recovery-dex-quote-r2.json"), "utf8"));

// ---- fixtures (TEST ONLY) -------------------------------------------------------------------------------------------
const acct = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");   // public anvil key #0
const OWNER = acct.address;
const A = (b) => `0x${b.repeat(20)}`;
const FACTORY = A("11"), IMPL = A("22"), ADAPTER = A("33"), LFACTORY = A("44"), LVAULT = A("55"), USDC = A("66"), RELAYER = A("77");
const ZERO = `0x${"0".repeat(64)}`;
const H = (b) => `0x${b.repeat(32)}`;
const NOW = 1793202897n;
const LEG_EXP = 1793765924n;
const NUC = [...TERMS.provisionalPartition.nucbox.appIds].sort();
const METAL = [...TERMS.provisionalPartition.metal.appIds].sort();
const ALL = [...NUC, ...METAL].sort();
const cfgOf = (codec) => codec.fundingConfig({ chainId: 8453, factory: FACTORY, implementation: IMPL,
  vault: codec.predictVault(FACTORY, IMPL, OWNER), owner: OWNER, gasAdapter: ADAPTER, legacyFactory: LFACTORY, legacyVault: LVAULT,
  adapterMaxEthOut: 10n ** 17n, adapterFeeTiers: [100, 500, 3000] });
const cfgC = cfgOf(CC), cfgO = cfgOf(OC);                     // each codec instance trusts only its own config object
const intake = { openEnabled: true, ownerEnabled: true, feeTiers: [100, 500, 3000], relayer: RELAYER };
const runtimeC = Object.freeze({ cfg: cfgC, pins: { usdc: USDC, legacyFactory: LFACTORY, factory: FACTORY, implementation: IMPL },
  intake, intakeWhy: null, relayer: RELAYER });
const NUC_PART = { budget6: 4_800_000n, opsPerPeriod: 16n };
const METAL_PART = { budget6: 1_200_000n, opsPerPeriod: 4n };
const grantIn = (over = {}) => ({ now: NOW, sessionKey: H("ab"), appIds: NUC, expiresAt: LEG_EXP, legacyExpiresAt: LEG_EXP,
  grantNonce: H("cd"), signBefore: NOW + 900n, label: "Gas recovery · nucbox", part: NUC_PART, ...over });
const codeOf = (fn) => { try { fn(); } catch (e) { return e.code ?? `uncoded:${e.message}`; } return "NO_THROW"; };
const codeOfAsync = async (fn) => { try { await fn(); } catch (e) { return e.code ?? `uncoded:${e.message}`; } return "NO_THROW"; };
const msgJson = (built) => jsonable(built.typedData.message);
const CAPS = { maxFeePerOp: "80000", maxGasUsdcPerOp: "600000", maxUsdcPerEth6: "2500000000", maxEthPerOp: "200000000000000",
  periodSeconds: "86400", maxAppFeePerHour: "0", maxRatePerHour: "0", measurement: ZERO, preset: "gas-recovery",
  actions: ["gas.fund"], environments: ["staging", "prod"] };

// =====================================================================================================================
test("the candidate literals are exactly CANDIDATE-TERMS.json; the ORIGINAL module still has the old candidate", () => {
  assert.deepEqual(jsonable(C.GAS_GRANT_CANDIDATE), TERMS.gasGrantCandidate);
  assert.equal(C.GAS_GRANT_CANDIDATE.id, "gas-recovery-6usdc-r1");
  assert.ok(Object.isFrozen(C.GAS_GRANT_CANDIDATE));
  const o = jsonable(O.GAS_GRANT_CANDIDATE), c = jsonable(C.GAS_GRANT_CANDIDATE);
  assert.deepEqual([o.budget, o.spendPerPeriod, o.maxFeePerOp, o.maxGasUsdcPerOp, o.maxEthPerOp],
    ["1000000", "1000000", "50000", "100000", "20000000000000"], "original S untouched");
  const changed = Object.keys(c).filter((k) => canon(c[k] ?? null) !== canon(o[k] ?? null)).sort();
  assert.deepEqual(changed, ["budget", "id", "maxEthPerOp", "maxFeePerOp", "maxGasUsdcPerOp", "spendPerPeriod"]);
  assert.equal(C.MAX_GRANT_APPS, 8);
  assert.equal(CM.MAX_COMBINED6, 30_000_000n);
  assert.equal(CM.MIGRATION_SCHEMA, OM.MIGRATION_SCHEMA);
});

test("only GAS_GRANT_CANDIDATE and buildMigrationPlan differ: every other export is the same code", () => {
  for (const [name, cand, orig] of [["funding-client", C, O], ["migration", CM, OM], ["gas-execution", CX, OX], ["codec", CC, OC]]) {
    assert.deepEqual(Object.keys(cand).sort(), Object.keys(orig).sort(), `${name} export set`);
    for (const k of Object.keys(orig)) {
      if (typeof orig[k] !== "function") continue;
      const same = cand[k].toString() === orig[k].toString();
      if (name === "migration" && k === "buildMigrationPlan") assert.ok(!same, "buildMigrationPlan gains the gasCandidate terms field");
      else assert.ok(same, `${name}.${k} is unchanged code`);
    }
  }
  for (const f of ["browser-entry.mjs", "chain-proof.mjs", "funding-codec.mjs", "gas-execution.mjs", "util.mjs", "v2-store.mjs"]) {
    assert.ok(fs.readFileSync(path.join(HERE, "candidate", "sdk", "funding", f)).equals(fs.readFileSync(path.join(SRC, f))), `${f} byte-identical`);
  }
});

// =====================================================================================================================
test("buildGasGrant: nucbox 4.8 / 16 ops and metal 1.2 / 4 ops carry exactly the candidate caps; digest-bound", () => {
  for (const [part, apps, label] of [[NUC_PART, NUC, "nucbox"], [METAL_PART, METAL, "metal"]]) {
    const built = C.buildGasGrant(cfgC, grantIn({ part, appIds: apps, label: `Gas recovery · ${label}` }));
    const m = msgJson(built);
    for (const [k, v] of Object.entries(CAPS)) assert.deepEqual(m[k], v, `${label}.${k}`);
    assert.equal(m.budget, String(part.budget6));
    assert.equal(m.spendPerPeriod, String(part.budget6), "spendPerPeriod = the part budget, never the aggregate");
    assert.equal(m.opsPerPeriod, String(part.opsPerPeriod));
    assert.deepEqual(m.apps, apps);
    assert.equal(m.expiresAt, String(LEG_EXP));
    assert.equal(built.actionsMask, 1n << 10n);
    assert.equal(built.envsMask, 3);
    // the unchanged codec (original instance) hashes the very same terms to the same digest: nothing but literals moved
    assert.equal(OC.buildGrantV2(cfgO, { domainVersion: "2", now: NOW, grant: C.grantBody(built) }).digest, built.digest);
    assert.equal(C.rebuildGasReview(cfgC, C.grantBody(built), built.digest, NOW).digest, built.digest);
    // a signature approval is bound to this exact digest; any other digest refuses before a wallet is touched
    assert.equal(codeOf(() => C.requireApproval({ rootReviewed: true, digest: H("ee") }, built.digest, "gas grant")), "approval_required");
    assert.equal(codeOf(() => C.requireApproval({ rootReviewed: false, digest: built.digest }, built.digest, "gas grant")), "approval_required");
    assert.equal(codeOf(() => C.requireApproval({ rootReviewed: true, digest: built.digest }, built.digest, "gas grant")), "NO_THROW");
  }
});

test("buildGasGrant refusals: old total, part caps, ops, apps, wildcard, duplicates, expiry", () => {
  assert.equal(codeOf(() => C.buildGasGrant(cfgC, grantIn({ part: undefined, budget: 1_000_000n }))), "gas_budget_not_candidate");
  assert.equal(codeOf(() => C.buildGasGrant(cfgC, grantIn({ part: undefined, budget: 6_000_001n }))), "gas_budget_not_candidate");
  assert.equal(codeOf(() => C.buildGasGrant(cfgC, grantIn({ part: { budget6: 6_000_001n, opsPerPeriod: 16n } }))), "gas_part_budget");
  assert.equal(codeOf(() => C.buildGasGrant(cfgC, grantIn({ part: { budget6: 0n, opsPerPeriod: 16n } }))), "gas_part_budget");
  assert.equal(codeOf(() => C.buildGasGrant(cfgC, grantIn({ part: { budget6: 4_800_000n, opsPerPeriod: 21n } }))), "gas_part_ops");
  assert.equal(codeOf(() => C.buildGasGrant(cfgC, grantIn({ part: { budget6: 4_800_000n, opsPerPeriod: 0n } }))), "gas_part_ops");
  assert.equal(codeOf(() => C.buildGasGrant(cfgC, grantIn({ budget: 1_200_000n }))), "gas_budget_not_candidate", "budget differs from its part");
  assert.equal(codeOf(() => C.buildGasGrant(cfgC, grantIn({ appIds: [...NUC, METAL[0]] }))), "gas_scope_apps", "9 apps");
  assert.equal(codeOf(() => C.buildGasGrant(cfgC, grantIn({ appIds: [] }))), "gas_scope_apps");
  assert.equal(codeOf(() => C.buildGasGrant(cfgC, grantIn({ appIds: [NUC[0], NUC[0]] }))), "gas_scope_apps");
  assert.equal(codeOf(() => C.buildGasGrant(cfgC, grantIn({ appIds: ["*"] }))), "hex32_format", "no wildcard");
  assert.equal(codeOf(() => C.buildGasGrant(cfgC, grantIn({ expiresAt: LEG_EXP + 1n }))), "gas_expiry_after_legacy");
  // the single-grant default is the reviewed candidate itself (6 USDC, 20 ops), never a runtime value
  const whole = msgJson(C.buildGasGrant(cfgC, grantIn({ part: undefined })));
  assert.deepEqual([whole.budget, whole.spendPerPeriod, whole.opsPerPeriod], ["6000000", "6000000", "20"]);
  // caller-supplied caps are not parameters: they are ignored, never applied (no silent override path exists)
  const tried = msgJson(C.buildGasGrant(cfgC, grantIn({ maxEthPerOp: 10n ** 18n, maxFeePerOp: 10n ** 6n, maxGasUsdcPerOp: 10n ** 9n,
    part: { ...NUC_PART, maxEthPerOp: 10n ** 18n, spendPerPeriod: 10n ** 9n } })));
  assert.deepEqual([tried.maxEthPerOp, tried.maxFeePerOp, tried.maxGasUsdcPerOp, tried.spendPerPeriod],
    ["200000000000000", "80000", "600000", "4800000"]);
});

// =====================================================================================================================
const scope10 = { appIds: ALL, byApp: {}, deployments: new Map() };
const scope8 = { appIds: NUC, byApp: {}, deployments: new Map() };
const NEW_SPLIT = { legacy6: "24000000", gas: [
  { name: "nucbox", budget6: "4800000", opsPerPeriod: "16", appIds: NUC },
  { name: "metal", budget6: "1200000", opsPerPeriod: "4", appIds: METAL }] };
const withParts = (legacy6, nuc, metal) => ({ legacy6, gas: [{ name: "nucbox", appIds: NUC, ...nuc }, { name: "metal", appIds: METAL, ...metal }] });

test("parseSplit accepts exactly 24 + 4.8 + 1.2 = 30 over the explicit 8 + 2 partition", () => {
  const sp = CM.parseSplit(NEW_SPLIT, scope10, 30_000_000n);
  assert.equal(sp.legacy6, 24_000_000n);
  assert.equal(sp.gasTotal, 6_000_000n);
  assert.deepEqual(sp.parts.map((p) => [p.step, p.budget6, p.opsPerPeriod, p.appIds.length]),
    [["gasOpen:nucbox", 4_800_000n, 16n, 8], ["gasOpen:metal", 1_200_000n, 4n, 2]]);
  assert.equal(sp.legacy6 + sp.gasTotal, 30_000_000n);
  assert.equal(codeOf(() => CM.parseSplit({ legacy6: "24000000", gas6: "6000000" }, scope8, 30_000_000n)), "NO_THROW", "single grant <= 8 apps");
});

test("parseSplit refusals: old 1 USDC total, conservation, caps, duplicated budget, overlap, wildcard, shape", () => {
  const r = (split, fresh = 30_000_000n, scope = scope10) => codeOf(() => CM.parseSplit(split, scope, fresh));
  assert.equal(r(withParts("29000000", { budget6: "800000", opsPerPeriod: "16" }, { budget6: "200000", opsPerPeriod: "4" })), "gas_budget_not_candidate", "old 29 / 0.8 / 0.2");
  assert.equal(r({ legacy6: "29000000", gas6: "1000000" }, 30_000_000n, scope8), "gas_budget_not_candidate", "old 29 + 1");
  assert.equal(r({ legacy6: "24000000", gas6: "6000000" }), "gas_partition_required", "10 apps never in one grant");
  assert.equal(r(NEW_SPLIT, 29_999_999n), "split_total", "must equal the fresh balance");
  assert.equal(r(withParts("24000001", { budget6: "4800000", opsPerPeriod: "16" }, { budget6: "1200000", opsPerPeriod: "4" }), 30_000_001n), "split_total", "> 30");
  assert.equal(r(withParts("18000000", { budget6: "6000000", opsPerPeriod: "16" }, { budget6: "6000000", opsPerPeriod: "4" })), "gas_budget_not_candidate", "duplicated budget");
  assert.equal(r(withParts("24000000", { budget6: "6000000", opsPerPeriod: "16" }, { budget6: "0", opsPerPeriod: "4" })), "split_zero");
  assert.equal(r(withParts("24000000", { budget6: "4800000", opsPerPeriod: "17" }, { budget6: "1200000", opsPerPeriod: "4" })), "gas_part_ops", "21 ops > 20");
  assert.equal(r(withParts("24000000", { budget6: "4800000", opsPerPeriod: "0" }, { budget6: "1200000", opsPerPeriod: "4" })), "gas_part_ops");
  const overlap = { legacy6: "24000000", gas: [{ name: "nucbox", budget6: "4800000", opsPerPeriod: "16", appIds: NUC },
    { name: "metal", budget6: "1200000", opsPerPeriod: "4", appIds: [...METAL, NUC[0]] }] };
  assert.equal(r(overlap), "gas_scope_overlap", "an app in two parts would duplicate its budget");
  const wild = { legacy6: "24000000", gas: [{ name: "nucbox", budget6: "4800000", opsPerPeriod: "16", appIds: ["*"] },
    { name: "metal", budget6: "1200000", opsPerPeriod: "4", appIds: METAL }] };
  assert.equal(r(wild), "hex32_format", "no wildcard part");
  const nine = { legacy6: "24000000", gas: [{ name: "nucbox", budget6: "4800000", opsPerPeriod: "16", appIds: [...NUC, METAL[0]] },
    { name: "metal", budget6: "1200000", opsPerPeriod: "4", appIds: [METAL[1]] }] };
  assert.equal(r(nine), "gas_part_apps");
  const capped = structuredClone(NEW_SPLIT);
  capped.gas[0].maxEthPerOp = "1000000000000000000";
  assert.equal(r(capped), "split_shape", "a part cannot carry caps");
  const dupName = structuredClone(NEW_SPLIT);
  dupName.gas[1].name = "nucbox";
  assert.equal(r(dupName), "split_shape");
  const uncovered = structuredClone(NEW_SPLIT);
  uncovered.gas[1].appIds = [METAL[0]];
  assert.equal(r(uncovered), "gas_scope_uncovered");
  assert.equal(r(NEW_SPLIT, 30_000_000n, scope8), "gas_scope_excess");
  assert.equal(r({ legacy6: "24000000", gas6: "6000000", gas: NEW_SPLIT.gas }), "split_shape");
  // the ORIGINAL module keeps its own (old) qualification: it accepts the old split and refuses the new one
  assert.equal(codeOf(() => OM.parseSplit(withParts("29000000", { budget6: "800000", opsPerPeriod: "16" }, { budget6: "200000", opsPerPeriod: "4" }), scope10, 30_000_000n)), "NO_THROW");
  assert.equal(codeOf(() => OM.parseSplit(NEW_SPLIT, scope10, 30_000_000n)), "gas_budget_not_candidate");
});

// =====================================================================================================================
test("a STORED grant built under the OLD candidate still rebuilds to its unchanged digest with its old caps", () => {
  const old = O.buildGasGrant(cfgO, grantIn({ part: { budget6: 800_000n, opsPerPeriod: 16n } }));
  const stored = O.grantBody(old);
  assert.equal(stored.maxEthPerOp, "20000000000000");
  const again = C.rebuildGasReview(cfgC, stored, old.digest, NOW);
  assert.equal(again.digest, old.digest);
  assert.equal(msgJson(again).maxFeePerOp, "50000");
  assert.equal(codeOf(() => C.rebuildGasReview(cfgC, { ...stored, maxEthPerOp: "200000000000000" }, old.digest, NOW)), "review_digest_mismatch",
    "an old grant is never reinterpreted under the new caps");
  // the new candidate cannot reproduce an old-candidate grant (so rearmStep of an old plan refuses: review_not_terms)
  assert.notEqual(C.buildGasGrant(cfgC, grantIn({ part: { budget6: 800_000n, opsPerPeriod: 16n } })).digest, old.digest);
});

test("an OLD open record's caps still govern its quotes (2e14 wei refused before the relay is asked)", async () => {
  const old = O.buildGasGrant(cfgO, grantIn({ part: { budget6: 800_000n, opsPerPeriod: 16n } }));
  const dep = H("d1");
  const record = { id: "old-gas", status: "open", sid: old.sessionId, keyHash: H("ab"), grant: O.grantBody(old) };
  const scope = { timestamp: NOW, deployments: new Map([[dep, { holder: LVAULT, env: 2, appId: NUC[0], active: true }]]) };
  const relay = async () => { throw new Error("relay must not be called"); };
  assert.equal(await codeOfAsync(() => C.quoteGasFund({ runtime: runtimeC, record, relay, scope, deployment: dep,
    ethOut: 200_000_000_000_000n, feeTier: 100, now: NOW })), "eth_cap");
});

test("owner controls: same target, same Terminate/Withdraw digests and bodies as the original module", async () => {
  const pins = { factory: FACTORY, implementation: IMPL };
  assert.deepEqual(C.controlsTarget(pins, OWNER), O.controlsTarget(pins, OWNER));
  const toBig = (types, primaryType, msg) => Object.fromEntries(types[primaryType].map(({ name, type }) =>
    [name, /^u?int/.test(type) ? BigInt(msg[name]) : msg[name]]));
  const provider = { async request({ method, params }) {
    assert.equal(method, "eth_signTypedData_v4");
    const td = JSON.parse(params[1]);
    const { EIP712Domain: _d, ...types } = td.types;
    return acct.signTypedData({ domain: { ...td.domain, chainId: Number(td.domain.chainId) }, types, primaryType: td.primaryType,
      message: toBig(types, td.primaryType, td.message) });
  } };
  const rng = { getRandomValues(b) { b.fill(7); return b; } };
  const run = async (M) => {
    const entries = [], bodies = [];
    const store = { async putJournal(e) { entries.push(e); } };
    const relay = async (method, p, body) => { bodies.push({ method, p, body }); return { txHash: H("f1") }; };
    const target = M.controlsTarget(pins, OWNER);
    await M.ownerControl({ target, provider, relay, store, op: "terminate", sessionId: H("5e"), now: NOW, rng });
    await M.ownerControl({ target, provider, relay, store, op: "withdraw", amount: 1_200_000n, now: NOW, rng });
    return { digests: entries.map((e) => [e.op, e.status, e.digest]), bodies: canon(bodies) };
  };
  const [c, o] = [await run(C), await run(O)];
  assert.deepEqual(c, o);
  assert.equal(c.digests.length, 4);
  assert.equal(await codeOfAsync(() => C.ownerControl({ target: C.controlsTarget(pins, OWNER), provider, relay: async () => ({}),
    store: { async putJournal() {} }, op: "revokeAll", now: NOW, rng })), "owner_op_unsupported");
});

test("unknown-outcome recovery is not relaxed (byte-identical module, same refusals and blockers)", async () => {
  assert.deepEqual(CX.CLEARED, OX.CLEARED);
  assert.deepEqual(jsonable(CX.DEFINITIVE_REFUSALS), jsonable(OX.DEFINITIVE_REFUSALS));
  assert.equal(CX.classifyExecuteFailure(new C.RelayError("relay_unreachable", "x", 0, { sent: "unknown" })).kind, "unknown");
  assert.equal(CX.classifyExecuteFailure(new C.RelayError("relay", "bad gateway", 502, {})).kind, "unknown");
  assert.equal(CX.classifyExecuteFailure(new TypeError("body lost")).kind, "unknown");
  const record = { id: "gas-nuc", status: "open", sid: H("5a"), keyHash: H("ab"), grant: {} };
  const unknown = { kind: "gas-execute", schema: CX.EXEC_SCHEMA, status: "unknown", sid: record.sid, record: { id: "gas-nuc" }, id: "gas-exec:x:1" };
  assert.equal(CX.isBlocking(unknown), true);
  assert.equal(CX.isBlocking({ ...unknown, status: "observed" }), true, "canonical is not final");
  assert.equal(await codeOfAsync(() => CX.quoteGasFund({ runtime: runtimeC, record, relay: async () => { throw new Error("relay must not be called"); },
    scope: { deployments: new Map() }, deployment: H("d1"), ethOut: 1n, feeTier: 100, now: NOW, journalEntries: [unknown] })), "unreconciled_execute");
});

// =====================================================================================================================
// Accounting: the readonly two-provider quote fits the signable terms (per op: maxUsdcIn6 <= maxGasUsdcPerOp, fee <=
// maxFeePerOp, price <= maxUsdcPerEth6, ethOut <= maxEthPerOp; per part: sum of maxima <= budget, ops <= opsPerPeriod)
// =====================================================================================================================
function quoteRelay({ record, balance6, maxUsdcIn6, fee, holder }) {
  const calls = [];
  const relay = async (method, p, body) => {
    calls.push(`${method} ${p}`);
    if (method === "GET" && p.startsWith("/funding/session/")) return { state: { live: true, keyHash: record.keyHash, balance6: String(balance6) } };
    if (method === "POST" && p === "/funding/quote") {
      const deadline = NOW + 300n;
      const intent = { payer: cfgC.vault, deployment: body.deployment, expectedOwner: holder, ethOut: String(body.ethOut),
        maxUsdcIn6: String(maxUsdcIn6), fee: body.feeTier, deadline: String(deadline) };
      const call = CC.buildGasFundCall(cfgC, { domainVersion: "2", now: NOW, sessionId: record.sid, nonce: 0n, action: 10, intent,
        fee: BigInt(fee), deadline });
      return { vault: cfgC.vault, sid: record.sid, action: 10, chainId: 8453, intent, nonce: "0", fee: String(fee), deadline: String(deadline),
        args: call.args, argsHash: call.argsHash, maximum: { totalMaximum6: String(BigInt(maxUsdcIn6) + BigInt(fee)) } };
    }
    throw new Error(`unexpected ${method} ${p}`);
  };
  return { relay, calls };
}
const appIdOf = (ref) => /^catalog:\/\/(0x[0-9a-f]{64})\//.exec(ref)[1];

test("the recovery quote fits: every op is accepted under its part's NEW grant, totals within 4.8 / 1.2", async () => {
  assert.equal(QUOTE.agreed, true);
  const groups = { NucBox: { part: NUC_PART, apps: NUC, sum: 0n, ops: 0n }, Metal0: { part: METAL_PART, apps: METAL, sum: 0n, ops: 0n } };
  for (const app of QUOTE.results[0].apps) {
    const g = groups[app.host];
    const built = C.buildGasGrant(cfgC, grantIn({ part: g.part, appIds: g.apps }));
    const record = { id: `gas-${app.host}`, status: "open", sid: built.sessionId, keyHash: H("ab"), grant: C.grantBody(built) };
    const dep = app.id.toLowerCase();
    const scope = { timestamp: NOW, deployments: new Map([[dep, { holder: LVAULT, env: 2, appId: appIdOf(app.appRef), active: true }]]) };
    const { relay } = quoteRelay({ record, balance6: g.part.budget6 - g.sum, maxUsdcIn6: app.maxUsdcIn6, fee: 80_000n, holder: LVAULT });
    const q = await C.quoteGasFund({ runtime: runtimeC, record, relay, scope, deployment: dep, ethOut: BigInt(app.ethOut), feeTier: app.chosenTier, now: NOW });
    assert.equal(q.totals.totalMaximum6, BigInt(app.withMaxFee6));
    assert.ok(BigInt(app.maxUsdcIn6) * 10n ** 18n <= 2_500_000_000n * BigInt(app.ethOut), `${app.id}: within maxUsdcPerEth6`);
    g.sum += q.totals.totalMaximum6;
    g.ops += 1n;
  }
  assert.equal(groups.NucBox.sum, 4_434_142n);
  assert.equal(groups.Metal0.sum, 1_109_714n);
  assert.ok(groups.NucBox.sum <= 4_800_000n && groups.NucBox.ops <= 16n);
  assert.ok(groups.Metal0.sum <= 1_200_000n && groups.Metal0.ops <= 4n);
});

test("per-op caps bind exactly at their bounds (fee, gas, price, eth, balance)", async () => {
  const built = C.buildGasGrant(cfgC, grantIn());
  const record = { id: "gas-nuc", status: "open", sid: built.sessionId, keyHash: H("ab"), grant: C.grantBody(built) };
  const dep = H("d1");
  const scope = { timestamp: NOW, deployments: new Map([[dep, { holder: LVAULT, env: 2, appId: NUC[0], active: true }]]) };
  const q = async ({ ethOut, maxUsdcIn6, fee = 80_000n, balance6 = 4_800_000n }) => codeOfAsync(() => C.quoteGasFund({ runtime: runtimeC, record,
    relay: quoteRelay({ record, balance6, maxUsdcIn6, fee, holder: LVAULT }).relay, scope, deployment: dep, ethOut, feeTier: 100, now: NOW }));
  const E = 200_000_000_000_000n;
  assert.equal(await q({ ethOut: E, maxUsdcIn6: 500_000n }), "NO_THROW", "2e14 wei at exactly 2500 USDC/ETH, fee 80000");
  assert.equal(await q({ ethOut: E, maxUsdcIn6: 500_001n }), "price_cap");
  assert.equal(await q({ ethOut: E + 1n, maxUsdcIn6: 400_000n }), "eth_cap");
  assert.equal(await q({ ethOut: E, maxUsdcIn6: 480_000n, fee: 80_001n }), "fee_exceeds_grant");
  assert.equal(await q({ ethOut: 10n ** 17n, maxUsdcIn6: 600_001n }), "eth_cap", "ethOut cap binds before maxGasUsdcPerOp could");
  assert.equal(await q({ ethOut: E, maxUsdcIn6: 480_000n, balance6: 559_999n }), "quote_exceeds_budget");
  assert.equal(await q({ ethOut: E, maxUsdcIn6: 480_000n, balance6: 560_000n }), "NO_THROW");
});

// =====================================================================================================================
test("buildMigrationPlan: termsHash covers the exact candidate literals and both part templates", async () => {
  const OLD_ACTIONS = ["deploy.create", "deploy.fund", "api.status"];
  const old = { label: "TEST original", preset: "browser", sessionKey: H("aa"), actions: OLD_ACTIONS, apps: ["*"],
    environments: ["staging", "prod"], budget: 30_000_000n, spendPerPeriod: 100_000_000n, periodSeconds: 86_400, opsPerPeriod: 1000,
    maxFeePerOp: 250_000n, maxAppFeePerHour: 0n, maxRatePerHour: 5_000_000n, expiresAt: LEG_EXP, measurement: ZERO, grantNonce: H("a1"),
    signBefore: NOW };
  const evidence = { grant: old, sid: H("0d"), owner: OWNER, factory: LFACTORY, vault: LVAULT, state: { balance6: 30_000_000n },
    observed: { block: 1, hash: H("b1"), timestamp: Number(NOW) } };
  const gasStore = new MemoryV2Store();
  const plan = await CM.buildMigrationPlan({ S, evidence, runtime: runtimeC, scope: { ...scope10, block: 1n, blockHash: H("b2") },
    split: NEW_SPLIT, now: NOW, rng: globalThis.crypto, subtle: globalThis.crypto.subtle, gasStore, relayBase: "http://127.0.0.1:9",
    gasExpiresAt: LEG_EXP });
  const t = plan.terms;
  assert.equal(plan.termsHash, hashOf(t));
  assert.deepEqual(t.gasCandidate, TERMS.gasGrantCandidate, "the reviewed terms name the exact candidate literals");
  assert.deepEqual(t.order, ["terminate", "legacyOpen", "gasOpen:nucbox", "gasOpen:metal"]);
  assert.deepEqual([t.split.legacy6, t.split.gas6, t.split.total6, t.split.max6], ["24000000", "6000000", "30000000", "30000000"]);
  for (const [k, budget, ops] of [["gasOpen:nucbox", "4800000", "16"], ["gasOpen:metal", "1200000", "4"]]) {
    const part = t.gas.parts.find((p) => p.step === k);
    const tpl = part.grantTemplate;
    for (const [f, v] of Object.entries(CAPS)) assert.deepEqual(tpl[f], v, `${k}.${f}`);
    assert.deepEqual([tpl.budget, tpl.spendPerPeriod, tpl.opsPerPeriod, part.budget6, part.opsPerPeriod], [budget, budget, ops, budget, ops]);
    const r = plan.steps[k].review;
    assert.equal(C.rebuildGasReview(cfgC, r.grant, r.digest, NOW).digest, r.digest, `${k}: journaled review hashes to its digest`);
    for (const f of Object.keys(tpl)) assert.deepEqual(r.grant[f], tpl[f], `${k}: journaled grant field ${f} = the reviewed template`);
  }
  const tampered = structuredClone(t);
  tampered.gasCandidate.maxEthPerOp = "20000000000000";
  assert.notEqual(hashOf(tampered), plan.termsHash, "changing any candidate literal changes termsHash (the approval no longer applies)");
});
