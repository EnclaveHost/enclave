// migration-cutover-site-r1 offline tests. UNREVIEWED, NOT RUN by their author. Bounded OFFLINE tests of ONLY what
// generator/generate_site.py adds: the exact pre-funding-API staging match in verifyRuntime, cutover config / plan-mode
// selection, the whole-plan initial signature bundle, the pause view and context changes around Record activation.
// The pause itself (SDK) is covered by migration-cutover-prep-r1's 11 root-run checks and is not repeated.
// Run (root):  python3 migration-cutover-site-r1/generator/generate_site.py --link-viem
//              node --test migration-cutover-site-r1/test/site-cutover.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, encodeFunctionResult, decodeFunctionData } from "../../../source/node_modules/viem/_esm/index.js";
import * as FC from "../candidate/sdk/funding/funding-client.mjs";
import { predictVault } from "../candidate/sdk/funding/funding-codec.mjs";
import * as ST from "../candidate/site/js/funding/state.js";
import * as FL from "../candidate/site/js/funding/flows.js";

// ---- TEST data only -------------------------------------------------------------------------------------------------
const A = (b) => `0x${b.repeat(20)}`;
const H = (b) => `0x${b.repeat(32)}`;
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";                 // public anvil #0 address
const OTHER = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const FACTORY = A("11"), IMPL = A("22"), ADAPTER = A("33"), LFACTORY = A("44"), LVAULT = A("55"), USDC = A("66"), RELAYER = A("77");
const VAULT = predictVault(FACTORY, IMPL, OWNER).toLowerCase();
const NOW = 1793202897n;
const CODE = "0x60016000";
const PINS = { schema: FC.RUNTIME_SCHEMA, chainId: 8453, factory: FACTORY, implementation: IMPL, gasAdapter: ADAPTER, legacyFactory: LFACTORY,
  usdc: USDC, feeTiers: [100, 500, 3000], codehashes: { factory: keccak256(CODE), implementation: keccak256(CODE), gasAdapter: keccak256(CODE) },
  source: { kind: "deployed-receipts", deployTxs: [H("d1")], reviewedBy: "test" } };
const EXACT = '{"error":"no such sessions endpoint","code":"not_found"}';
const LIVE = JSON.stringify({ enabled: true, chainId: 8453, action: 10, factory: FACTORY, implementation: IMPL, adapter: ADAPTER,
  legacyFactory: LFACTORY, adapterMaxEthOut: String(10n ** 17n), feeTiers: [500], relayer: RELAYER, open: { enabled: true },
  owner: { enabled: true }, notAfter: "0" });

function chain({ code = CODE } = {}) {
  const calls = [];
  const rpc = async (method, params = []) => {
    calls.push(method);
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: H("c1"), timestamp: `0x${NOW.toString(16)}` };
    if (method === "eth_getCode") return code;
    if (method === "eth_call") {
      const { to, data } = params[0];
      const { functionName, args } = decodeFunctionData({ abi: FC.READ_ABI, data });
      const result = { implementation: IMPL, gasAdapter: ADAPTER, legacyFactory: LFACTORY, usdc: USDC, maxEthOut: 10n ** 17n,
        vaultFor: to.toLowerCase() === FACTORY ? predictVault(FACTORY, IMPL, args[0]) : LVAULT }[functionName];
      return encodeFunctionResult({ abi: FC.READ_ABI, functionName, result });
    }
    throw new Error(`unscripted rpc ${method}`);
  };
  return { rpc, calls };
}
function relayAnswering(status, body) {
  const seen = [];
  const relay = FC.relayClient("http://127.0.0.1:9", async (url, init) => {
    seen.push(`${init.method} ${url}`);
    return { status, ok: status >= 200 && status < 300, text: async () => body };
  });
  return { relay, seen };
}
const verify = (relay, extra = {}, c = chain()) => FC.verifyRuntime({ pins: PINS, rpc: c.rpc, relay, owner: OWNER, now: NOW, ...extra });
const STAGE = { staging: FC.PRE_FUNDING_API };
const codeOf = async (p) => { try { await p; } catch (e) { return e.code ?? `uncoded:${e.message}`; } return "NO_THROW"; };

// =====================================================================================================================
// 1. verifyRuntime staging match
// =====================================================================================================================
test("default (no opt-in): the exact production 404 still throws not_found, unchanged", async () => {
  const { relay } = relayAnswering(404, EXACT);
  assert.equal(await codeOf(verify(relay)), "not_found");
});

test("opt-in + the exact 404: chain pins verified, intake ABSENT (null, original code/status/text), never on", async () => {
  const { relay, seen } = relayAnswering(404, EXACT);
  const c = chain();
  const rt = await verify(relay, STAGE, c);
  assert.equal(rt.intake, null);
  assert.equal(rt.relayer, null);
  assert.equal(rt.intakeWhy, "not_found: no such sessions endpoint");
  assert.deepEqual({ ...rt.intakeAbsent }, { status: 404, code: "not_found", error: "no such sessions endpoint" });
  assert.ok(!JSON.stringify(rt.intakeAbsent).includes("funding_disabled"), "not relabelled");
  assert.equal(rt.cfg.vault.toLowerCase(), VAULT);
  assert.deepEqual(seen, ["GET http://127.0.0.1:9/v1/sessions/funding/config"]);
  assert.ok(c.calls.filter((m) => m === "eth_getCode").length === 3 && c.calls.includes("eth_call"), "every on-chain pin was read");
});

test("opt-in: every other answer keeps its old handling (no general override)", async () => {
  const cases = [
    [404, '{"error":"no such sessions endpoint","code":"not_found","x":1}', "not_found"],
    [404, '{"error":"No such sessions endpoint","code":"not_found"}', "not_found"],
    [404, '{"code":"not_found"}', "not_found"],
    [404, '{"error":"no such sessions endpoint","code":"not_found_x"}', "not_found_x"],
    [410, EXACT, "not_found"],
    [500, EXACT, "not_found"],
    [404, "not found", "relay"],
    [200, '{"enabled":false}', "relay_config"],
  ];
  for (const [status, body, want] of cases) {
    const { relay } = relayAnswering(status, body);
    assert.equal(await codeOf(verify(relay, STAGE)), want, `${status} ${body}`);
  }
});

test("opt-in never weakens the chain: a codehash mismatch still refuses before the relay is asked; unknown mode refuses", async () => {
  const a = relayAnswering(404, EXACT);
  assert.equal(await codeOf(verify(a.relay, STAGE, chain({ code: "0x6002" }))), "codehash_mismatch");
  assert.deepEqual(a.seen, []);
  const b = relayAnswering(404, EXACT);
  const c = chain();
  assert.equal(await codeOf(verify(b.relay, { staging: "anything" }, c)), "staging_mode");
  assert.deepEqual(c.calls, []);
});

test("live successor config: same result with or without opt-in; default runtime shape unchanged", async () => {
  const plain = await verify(relayAnswering(200, LIVE).relay);
  const staged = await verify(relayAnswering(200, LIVE).relay, STAGE);
  for (const rt of [plain, staged]) {
    assert.deepEqual(Object.keys(rt), ["cfg", "pins", "intake", "intakeWhy", "relayer", "block"]);
    assert.equal(rt.intake.openEnabled, true);
    assert.equal(rt.relayer.toLowerCase(), RELAYER);
  }
  const off = await verify(relayAnswering(503, '{"error":"off","code":"funding_disabled"}').relay);
  assert.equal(off.intake, null);
  assert.equal("intakeAbsent" in off, false);
});

// =====================================================================================================================
// 2. state: config, plan mode, signable steps, pause view
// =====================================================================================================================
const OLD_SID = H("0d");
const TX = H("7e");
const CUT = Object.freeze({ pauseAfter: "terminate", activationPlanSha256: H("a5"), rollbackPlanSha256: H("5b") });
const CFG = { schema: ST.CUTOVER_CONFIG_SCHEMA, chainId: 8453, owner: OWNER, oldSid: OLD_SID, terms: { ...CUT } };
const ORDER = ["terminate", "legacyOpen", "gasOpen:nucbox", "gasOpen:metal"];
const NUC = ["01", "02", "03", "04", "05", "06", "07", "08"].map(H), METAL = ["09", "0a"].map(H), DEPS = ["d1", "d2"].map(H);
const RELAY = "http://127.0.0.1:9";
const NOWS = 1000n;
const DIG = { terminate: H("e1"), legacyOpen: H("e2"), "gasOpen:nucbox": H("e3"), "gasOpen:metal": H("e4") };

function planOf({ cutover = CUT, st = {}, exp = {}, marker = null } = {}) {
  const steps = Object.fromEntries(ORDER.map((k) => [k, { status: st[k] ?? "planned",
    review: k === "terminate" ? { digest: DIG[k], message: { signBefore: String(exp[k] ?? 2000n) } }
      : { digest: DIG[k], grant: { signBefore: String(exp[k] ?? 2000n) }, recordId: `rec-${k}`, keyHash: `kh-${k}`, sid: DIG[k] } }]));
  if (steps.terminate.status === "proven") Object.assign(steps.terminate, { txHash: TX, proof: { block: 32, blockHash: H("b7"), final: true } });
  const plan = { id: `migration:${OLD_SID}`, kind: "migration", v: 3, termsHash: H("ab"), steps,
    terms: { owner: OWNER.toLowerCase(), chainId: 8453, order: [...ORDER],
      legacy: { vault: LVAULT, oldSid: OLD_SID, oldBalance6: "30000000", grantTemplate: { apps: ["*"] } }, split: { legacy6: "24000000" },
      gas: { vault: VAULT, deployments: [...DEPS], parts: [{ name: "nucbox", budget6: "4800000", opsPerPeriod: "16", appIds: NUC },
        { name: "metal", budget6: "1200000", opsPerPeriod: "4", appIds: METAL }] },
      ...(cutover ? { cutover: { ...cutover, claim: "termination-prefix-only-not-a-relay-drain" } } : {}) } };
  if (marker) plan.cutover = marker;
  return plan;
}
const PAUSED = { paused: true, after: "terminate", at: 1, terminate: { txHash: TX, block: 32, blockHash: H("b7") } };
const RESUMED = { ...PAUSED, resumed: { at: 2, terminateTxHash: TX, runtimeBlock: 40, activationHash: H("ac"), activation: {} } };

test("validateCutover: null = normal; only THIS owner / chain / session with exact reviewed terms", () => {
  const sc = { owner: OWNER, chainId: 8453, oldSid: OLD_SID };
  assert.equal(ST.validateCutover(null, sc), null);
  assert.equal(ST.validateCutover(undefined, sc), null);
  assert.deepEqual({ ...ST.validateCutover(CFG, sc) }, { ...CUT });
  const bad = (o, s = sc) => { try { ST.validateCutover(o, s); } catch (e) { return e.code; } return "NO_THROW"; };
  assert.equal(bad({ ...CFG, owner: OTHER }), "owner");
  assert.equal(bad({ ...CFG, chainId: 1 }), "chain");
  assert.equal(bad(CFG, { ...sc, oldSid: H("0e") }), "sid");
  assert.equal(bad({ ...CFG, schema: "x" }), "schema");
  assert.equal(bad({ ...CFG, extra: 1 }), "shape");
  assert.equal(bad({ ...CFG, terms: { ...CUT, pauseAfter: "legacyOpen" } }), "shape");
  assert.equal(bad({ ...CFG, terms: { ...CUT, rollbackPlanSha256: CUT.activationPlanSha256 } }), "shape");
  assert.equal(bad({ ...CFG, terms: { ...CUT, activationPlanSha256: `0x${"0".repeat(64)}` } }), "shape");
  assert.equal(bad({ ...CFG, terms: { ...CUT, claim: "x" } }), "shape");
});

test("planMode: a plan is never moved between modes (no silent inheritance of an unpaused plan)", () => {
  assert.deepEqual(ST.planMode(planOf({ cutover: null }), null), { mode: "normal", ok: true });
  assert.deepEqual(ST.planMode(planOf(), CUT), { mode: "cutover", ok: true });
  assert.equal(ST.planMode(planOf({ cutover: null }), CUT).reason, "plan_without_pause");
  assert.equal(ST.planMode(planOf(), null).reason, "cutover_not_configured");
  assert.equal(ST.planMode(planOf(), { ...CUT, rollbackPlanSha256: H("5c") }).reason, "cutover_terms_differ");
});

test("signable: whole plan first in cutover mode; nothing while paused; never across an admitted/unknown step", () => {
  assert.deepEqual(ST.signableOf(planOf(), NOWS, CUT), ORDER);
  assert.deepEqual(ST.signableOf(planOf({ cutover: null }), NOWS, null), ORDER, "normal mode unchanged");
  const metalExpired = { exp: { "gasOpen:metal": 500n } };
  assert.deepEqual(ST.signableOf(planOf(metalExpired), NOWS, CUT), [], "cutover: no partial bundle before terminate");
  assert.deepEqual(ST.signableOf(planOf({ ...metalExpired, cutover: null }), NOWS, null), ORDER.slice(0, 3), "normal: old rule kept");
  assert.deepEqual(ST.signableOf(planOf({ exp: { terminate: 500n } }), NOWS, CUT), []);
  const paused = planOf({ st: { terminate: "proven" }, marker: PAUSED });
  assert.deepEqual(ST.signableOf(paused, NOWS, CUT), []);
  assert.deepEqual(ST.nextSignable(paused, NOWS), ORDER.slice(1), "(the old rule alone would have offered them)");
  assert.deepEqual(ST.signableOf(planOf({ st: { terminate: "proven" } }), NOWS, CUT), [], "marker missing: nothing");
  assert.deepEqual(ST.signableOf(planOf({ st: { terminate: "proven" }, marker: RESUMED }), NOWS, CUT), ORDER.slice(1));
  assert.deepEqual(ST.signableOf(planOf({ st: { terminate: "proven", legacyOpen: "admitted" }, marker: RESUMED }), NOWS, CUT), []);
  assert.deepEqual(ST.signableOf(planOf({ st: { terminate: "proven", legacyOpen: "proven", "gasOpen:nucbox": "admitted" }, marker: RESUMED }), NOWS, CUT), []);
});

test("cutoverView mirrors the journal: before / paused / marker_missing / resumed / none", () => {
  assert.equal(ST.cutoverView(planOf({ cutover: null })).kind, "none");
  assert.equal(ST.cutoverView(planOf()).kind, "before");
  assert.equal(ST.cutoverView(planOf({ st: { terminate: "proven" }, marker: PAUSED })).kind, "paused");
  assert.equal(ST.cutoverView(planOf({ st: { terminate: "proven" }, marker: { ...PAUSED, terminate: { txHash: H("99") } } })).kind, "marker_missing");
  assert.equal(ST.cutoverView(planOf({ st: { terminate: "proven" }, marker: RESUMED })).kind, "resumed");
});

// =====================================================================================================================
// 3. flows: whole-plan signing, paused run result, Record activation and context changes
// =====================================================================================================================
const NP = ST.validateProposal({ schema: ST.PROPOSAL_SCHEMA, chainId: 8453, owner: OWNER, oldSid: OLD_SID, legacy6: "24000000",
  gas: [{ name: "nucbox", budget6: "4800000", opsPerPeriod: "16", appIds: NUC }, { name: "metal", budget6: "1200000", opsPerPeriod: "4", appIds: METAL }],
  deploymentIds: DEPS }, { owner: OWNER, chainId: 8453 });
const CTX = ST.contextOf({ owner: OWNER, chainId: 8453, vault: VAULT, legacyVault: LVAULT, relay: RELAY });
const RECORDS = ORDER.slice(2).map((k) => ({ id: `rec-${k}`, owner: OWNER, chainId: 8453, vault: VAULT, relay: RELAY, keyHash: `kh-${k}` }));
const APPROVAL = { schema: ST.APPROVAL_SCHEMA, rootReviewed: true, termsHash: H("ab"), owner: OWNER, chainId: 8453, oldSid: OLD_SID };
function memStore(plan) {
  let cur = structuredClone(plan);
  return { getJournal: async () => structuredClone(cur), listKeys: async () => structuredClone(RECORDS), listJournal: async () => [structuredClone(cur)],
    loadKey: async () => null, saveKey: async () => {}, putJournal: async () => {},
    casJournal: async (_id, m) => { cur = m(structuredClone(cur)); return cur; }, get cur() { return cur; } };
}
function wallet() {
  const w = { epoch: 1, owner: OWNER, chainId: 8453, provider: {} };
  return { w, g: FL.createGuard(() => ({ ...w })) };
}

test("signFlow (cutover): ONE whole-plan bundle before anything is sent; refused for a plan of the other mode", async () => {
  const plan = planOf();
  const store = memStore(plan);
  const memory = ST.createMemory();
  memory.bind(CTX);
  const signed = [];
  const core = { signSteps: async ({ steps }) => { signed.push([...steps]); return Object.fromEntries(steps.map((k) => [k, { digest: DIG[k] }])); } };
  const args = (cut, p = plan) => ({ g: wallet().g, memory, ctx: CTX, np: NP, approvalCfg: APPROVAL, cut, store: memStore(p), provider: {}, core,
    signArgs: {}, now: () => NOWS, shown: { planId: p.id, termsHash: p.termsHash, steps: ORDER } });
  assert.deepEqual(await FL.signFlow({ ...args(CUT), store }), ORDER);
  assert.deepEqual(signed, [ORDER]);
  assert.ok(memory.signedFor(CTX, plan), "held for exactly this plan");
  assert.equal(await codeOf(FL.signFlow(args(null))), "plan_mode");
  assert.equal(await codeOf(FL.signFlow(args(CUT, planOf({ cutover: null })))), "plan_mode");
  assert.equal(await codeOf(FL.signFlow(args({ ...CUT, activationPlanSha256: H("a6") }))), "plan_mode");
  assert.equal(signed.length, 1, "no further prompt");
});

test("runFlow passes the core's paused result through and drops the bundle (single use)", async () => {
  const plan = planOf();
  const memory = ST.createMemory();
  memory.bind(CTX);
  memory.holdSigned(CTX, plan, ORDER, { b: 1 });
  let runs = 0;
  const core = { runMigration: async () => { runs += 1; return { stage: "legacyOpen", paused: true }; } };
  const r = await FL.runFlow({ g: wallet().g, memory, ctx: CTX, np: NP, approvalCfg: APPROVAL, cut: CUT, planId: plan.id, store: memStore(plan), core, stepCtx: {} });
  assert.equal(r.paused, true);
  assert.equal(runs, 1);
  assert.equal(memory.hasSigned, false);
});

test("resumeFlow: refuses without record, on another context, when not paused, or after a switch; else one core call", async () => {
  const paused = planOf({ st: { terminate: "proven" }, marker: PAUSED });
  let calls = 0;
  const core = { resumeCutover: async (sc, id, a) => { calls += 1; assert.equal(sc.tag, "fresh-step-ctx"); assert.equal(id, paused.id); return a; } };
  const base = (over = {}) => ({ g: wallet().g, ctx: CTX, np: NP, approvalCfg: APPROVAL, cut: CUT, planId: paused.id, store: memStore(paused),
    activation: { a: 1 }, freshContext: async () => ({ ctx: CTX }), core, stepCtxOf: () => ({ tag: "fresh-step-ctx" }), ...over });
  let fresh = 0;
  assert.equal(await codeOf(FL.resumeFlow(base({ activation: null, freshContext: async () => { fresh += 1; return { ctx: CTX }; } }))), "activation_required");
  assert.equal(fresh, 0, "no runtime read without a record");
  assert.equal(await codeOf(FL.resumeFlow(base({ cut: null }))), "plan_mode");
  const otherRelay = ST.contextOf({ owner: OWNER, chainId: 8453, vault: VAULT, legacyVault: LVAULT, relay: "http://127.0.0.1:8" });
  assert.equal(await codeOf(FL.resumeFlow(base({ freshContext: async () => ({ ctx: otherRelay }) }))), "context_mismatch");
  assert.equal(await codeOf(FL.resumeFlow(base({ store: memStore(planOf()) }))), "not_paused");
  assert.equal(await codeOf(FL.resumeFlow(base({ store: memStore(planOf({ st: { terminate: "proven" }, marker: RESUMED })) }))), "not_paused");
  const sw = wallet();
  assert.equal(await codeOf(FL.resumeFlow(base({ g: sw.g, freshContext: async () => { sw.w.owner = OTHER; return { ctx: CTX }; } }))), "context_changed");
  const ch = wallet();
  assert.equal(await codeOf(FL.resumeFlow(base({ g: ch.g, freshContext: async () => { ch.w.chainId = 1; return { ctx: CTX }; } }))), "context_changed");
  assert.equal(calls, 0, "no activation recorded by any refusal");
  assert.deepEqual(await FL.resumeFlow(base()), { a: 1 });
  assert.equal(calls, 1);
});

test("guarded store after a switch: recording activation is refused; the termination outcome + pause is still recorded", async () => {
  const { w, g } = wallet();
  const admitted = planOf({ st: { terminate: "admitted" } });
  const store = memStore(admitted);
  const gs = FL.guardGasStore(store, g);
  w.owner = OTHER;
  await gs.casJournal(admitted.id, (cur) => {
    Object.assign(cur.steps.terminate, { status: "proven", txHash: TX, proof: { block: 32, blockHash: H("b7"), final: true } });
    cur.cutover = { ...PAUSED };
    return cur;
  });
  assert.equal(store.cur.cutover.paused, true, "outcome of an already admitted step is kept");
  await assert.rejects(gs.casJournal(admitted.id, (cur) => { cur.cutover.resumed = { terminateTxHash: TX }; return cur; }), (e) => e.code === "context_changed");
  assert.equal(store.cur.cutover.resumed, undefined);
});
