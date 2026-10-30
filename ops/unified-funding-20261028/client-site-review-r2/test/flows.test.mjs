// UNREVIEWED, NOT RUN. Executable boundary tests of the /funding click flows (authored/site/js/funding/flows.js).
// The flows are the page's real code; the "core" here is a FAKE that performs the same effect sequence as the r4 core
// (signSteps: one wallet prompt per signature, in order; runMigration: read -> admit (CAS) -> relay POST -> outcome CAS
// -> adoption/setActive; quoteGasFund/confirmGasFund: relay quote -> session-key sign -> relay execute). It proves the
// guard / binding rules at those boundaries, not the r4 core itself, a wallet, a relay, the chain or IndexedDB.
import test from "node:test";
import assert from "node:assert/strict";
import * as ST from "../authored/site/js/funding/state.js";
import * as FL from "../authored/site/js/funding/flows.js";
import { OWNER, OTHER, SID, DEPS, code, ctxA, np, plan, recordsFor } from "./fixtures.mjs";

const APPROVAL = { schema: ST.APPROVAL_SCHEMA, rootReviewed: true, termsHash: "0xterms", owner: OWNER, chainId: 8453, oldSid: SID };
const now = () => 100n;

/** In-memory store with the IndexedDB casJournal contract: a throwing mutate aborts and writes nothing. */
function memStore(journal = [], keys = []) {
  const J = new Map(journal.map((e) => [e.id, structuredClone(e)]));
  const K = new Map(keys.map((r) => [r.id, structuredClone(r)]));
  return {
    J, K, writes: [],
    async getJournal(id) { return J.has(id) ? structuredClone(J.get(id)) : null; },
    async listJournal() { return [...J.values()].map((e) => structuredClone(e)); },
    async listKeys() { return [...K.values()].map((r) => structuredClone(r)); },
    async loadKey(id) { return K.has(id) ? structuredClone(K.get(id)) : null; },
    async saveKey(r) { this.writes.push(["saveKey", r.id, r.status]); K.set(r.id, structuredClone(r)); },
    async putJournal(e) { this.writes.push(["putJournal", e.id, e.status]); J.set(e.id, structuredClone(e)); },
    async casJournal(id, mutate) {
      const next = mutate(J.has(id) ? structuredClone(J.get(id)) : null);   // throws -> abort, nothing written
      this.writes.push(["cas", id]);
      J.set(id, structuredClone(next));
      return structuredClone(next);
    },
  };
}
function world() {
  const live = { epoch: 1, owner: OWNER, chainId: 8453, provider: null };
  const prompts = [];
  const provider = { async request(a) { prompts.push(a.method); if (provider.onPrompt) await provider.onPrompt(prompts.length); return `0xsig${prompts.length}`; } };
  live.provider = provider;
  const p = plan();
  const store = memStore([p], recordsFor(p));
  const posts = [];
  const relay = async (m, path) => { posts.push(`${m} ${path}`); return { txHash: "0xtx" }; };
  return { live, provider, prompts, p, store, posts, relay, g: () => FL.createGuard(() => ({ ...live })) };
}
// FAKE core signSteps: terminate = 1 prompt, legacyOpen = 2 prompts, each gas part = 2 prompts (as in r4).
const fakeSign = async ({ provider, steps, plan: pl }) => {
  const out = {};
  for (const k of steps) {
    const n = k === "terminate" ? 1 : 2;
    for (let i = 0; i < n; i += 1) await provider.request({ method: "eth_signTypedData_v4" });
    out[k] = { digest: pl.steps[k].review.digest, body: { k } };
  }
  return out;
};
// FAKE core runMigration: for each next planned step with a signature: admit (CAS) -> POST -> submitted (CAS) -> proven (CAS) -> setActive.
const fakeRun = async (ctx, planId, signed) => {
  for (;;) {
    const pl = await ctx.gasStore.getJournal(planId);
    const k = pl.terms.order.find((s) => pl.steps[s].status !== "proven");
    if (!k) return { done: true };
    if (pl.steps[k].status !== "planned" || !signed[k]) return { stage: k, needsSignature: true };
    await ctx.gasStore.casJournal(planId, (cur) => { cur.steps[k].status = "admitted"; return cur; });
    let out;
    try { out = await (k === "terminate" || k === "legacyOpen" ? ctx.legacyRelay.request("POST", `/${k}`, {}) : ctx.relay("POST", "/funding/open", {})); }
    catch (err) { await ctx.gasStore.casJournal(planId, (cur) => { cur.steps[k].lastError = err.code; return cur; }); throw err; }
    await ctx.gasStore.casJournal(planId, (cur) => { cur.steps[k].status = "submitted"; cur.steps[k].txHash = out.txHash; return cur; });
    if (ctx.onSubmitted) await ctx.onSubmitted(k);
    await ctx.gasStore.casJournal(planId, (cur) => { cur.steps[k].status = "proven"; return cur; });
    if (k === "legacyOpen") await ctx.setActive("0xnew", SID);
  }
};
const signArgs = (w, memory, g, over = {}) => ({ g, memory, ctx: ctxA, np: np(), approvalCfg: APPROVAL, store: w.store, provider: w.provider,
  core: { signSteps: fakeSign }, signArgs: {}, now, shown: { planId: w.p.id, termsHash: w.p.termsHash, steps: ST.nextSignable(w.p, 100n) }, ...over });

test("sign: approved, scoped plan -> 1 + 2 + 2 + 2 prompts, bundle held for exactly that plan", async () => {
  const w = world();
  const memory = ST.createMemory();
  memory.bind(ctxA);
  const steps = await FL.signFlow(signArgs(w, memory, w.g()));
  assert.deepEqual(steps, ["terminate", "legacyOpen", "gasOpen:nucbox", "gasOpen:metal"]);
  assert.equal(w.prompts.length, 7, "seven signatures, all after the exact approval");
  assert.ok(memory.signedFor(ctxA, await w.store.getJournal(w.p.id)));
});

test("sign: no approval, a mismatched proposal, another relay's plan or a changed plan -> no prompt at all", async () => {
  for (const [over, want] of [[{ approvalCfg: null }, "approval_required"], [{ approvalCfg: { ...APPROVAL, termsHash: "0xx" } }, "approval_required"],
    [{ np: np({ legacy6: "28900000", gas: [{ name: "nucbox", budget6: "900000", opsPerPeriod: "16", appIds: plan().terms.gas.parts[0].appIds }, { name: "metal", budget6: "200000", opsPerPeriod: "4", appIds: plan().terms.gas.parts[1].appIds }] }) }, "proposal_plan_mismatch"],
    [{ ctx: ST.contextOf({ ...ctxA, relay: "https://two.invalid" }) }, "plan_out_of_scope"],
    [{ shown: { planId: plan().id, termsHash: "0xterms", steps: ["terminate", "legacyOpen"] } }, "plan_changed"]]) {
    const w = world();
    const memory = ST.createMemory();
    memory.bind(over.ctx ?? ctxA);
    await assert.rejects(FL.signFlow(signArgs(w, memory, w.g(), over)), code(want), want);
    assert.equal(w.prompts.length, 0, `${want}: no wallet prompt`);
    assert.equal(memory.hasSigned, false);
  }
});

test("sign: an account switch while the journal read is pending -> no prompt", async () => {
  const w = world();
  const memory = ST.createMemory();
  memory.bind(ctxA);
  const g = w.g();
  const read = w.store.getJournal.bind(w.store);
  w.store.getJournal = async (id) => { const r = await read(id); w.live.owner = OTHER; return r; };
  await assert.rejects(FL.signFlow(signArgs(w, memory, g)), code(FL.CANCELLED));
  assert.equal(w.prompts.length, 0);
});

test("sign: a chain switch between wallet prompts stops the rest and keeps nothing", async () => {
  const w = world();
  const memory = ST.createMemory();
  memory.bind(ctxA);
  w.provider.onPrompt = (n) => { if (n === 2) w.live.chainId = 1; };
  await assert.rejects(FL.signFlow(signArgs(w, memory, w.g())), code(FL.CANCELLED));
  assert.equal(w.prompts.length, 2, "the prompt that was open when it changed is discarded; no third prompt");
  assert.equal(memory.hasSigned, false);
});

const runArgs = (w, memory, g, extra = {}) => ({ g, memory, ctx: ctxA, np: np(), approvalCfg: APPROVAL, planId: w.p.id, store: w.store,
  core: { runMigration: fakeRun }, stepCtx: { ...FL.guardedStepCtx({ gasStore: w.store, relay: w.relay, legacyRelay: { request: async (m, p) => { w.posts.push(`${m} ${p}`); return { txHash: "0xtx" }; } },
    setActive: async (sid) => { w.active = sid; } }, g), ...extra } });

test("send: the held bundle runs once; a second click has nothing to send", async () => {
  const w = world();
  const memory = ST.createMemory();
  memory.bind(ctxA);
  const g = w.g();
  await FL.signFlow(signArgs(w, memory, g));
  assert.deepEqual(await FL.runFlow(runArgs(w, memory, g)), { done: true });
  assert.equal(w.active, "0xnew");
  assert.equal(w.posts.length, 4);
  await assert.rejects(FL.runFlow(runArgs(w, memory, g)), code("signatures_stale"));
  assert.equal(w.posts.length, 4);
});

test("send: a switch before the click's send -> nothing admitted, nothing posted", async () => {
  const w = world();
  const memory = ST.createMemory();
  memory.bind(ctxA);
  await FL.signFlow(signArgs(w, memory, w.g()));
  const g = w.g();
  const read = w.store.listKeys.bind(w.store);
  w.store.listKeys = async () => { const r = await read(); w.live.epoch = 2; return r; };   // remount while reading
  await assert.rejects(FL.runFlow(runArgs(w, memory, g)), code(FL.CANCELLED));
  assert.equal(w.posts.length, 0);
  assert.equal((await w.store.getJournal(w.p.id)).steps.terminate.status, "planned");
});

test("send: a switch after a step was SUBMITTED records its outcome, starts nothing new, never moves the active session", async () => {
  const w = world();
  const memory = ST.createMemory();
  memory.bind(ctxA);
  const g = w.g();
  await FL.signFlow(signArgs(w, memory, g));
  const args = runArgs(w, memory, g, { onSubmitted: (k) => { if (k === "legacyOpen") w.live.owner = OTHER; } });
  await assert.rejects(FL.runFlow(args), code(FL.CANCELLED));
  const j = await w.store.getJournal(w.p.id);
  assert.equal(j.steps.legacyOpen.status, "proven", "the already-admitted step's outcome is still recorded (reconcile works)");
  assert.equal(w.active, undefined, "the active pointer was not moved for another wallet");
  assert.equal(j.steps["gasOpen:nucbox"].status, "planned", "no further step admitted");
  assert.equal(w.posts.length, 2);
});

test("send: a switch between admission and POST leaves the step admitted with an error note, nothing posted, no resend", async () => {
  const w = world();
  const memory = ST.createMemory();
  memory.bind(ctxA);
  const g = w.g();
  await FL.signFlow(signArgs(w, memory, g));
  const store = w.store;
  const cas = store.casJournal.bind(store);
  store.casJournal = async (id, m) => { const r = await cas(id, m); if (r.steps.terminate.status === "admitted") w.live.provider = {}; return r; };
  await assert.rejects(FL.runFlow(runArgs(w, memory, g)), code(FL.CANCELLED));
  const j = await store.getJournal(w.p.id);
  assert.equal(j.steps.terminate.status, "admitted");
  assert.equal(j.steps.terminate.lastError, FL.CANCELLED, "shown as 'outcome unknown, check the chain'");
  assert.deepEqual(ST.stepView(j.steps.terminate, 100n).actions, ["reconcile"]);
  assert.equal(w.posts.length, 0);
});

test("guarded store: after a switch, a planned step cannot be admitted or re-armed and a new plan cannot be created", async () => {
  const w = world();
  const g = w.g();
  const gs = FL.guardGasStore(w.store, g);
  w.live.owner = OTHER;
  await assert.rejects(gs.casJournal(w.p.id, (cur) => { cur.steps.terminate.status = "admitted"; return cur; }), code(FL.CANCELLED));
  await assert.rejects(gs.casJournal(w.p.id, (cur) => { cur.steps.terminate.review = { digest: "0xnew" }; return cur; }), code(FL.CANCELLED));
  await assert.rejects(gs.casJournal("migration:new", () => ({ id: "migration:new", steps: {} })), code(FL.CANCELLED));
  await assert.rejects(gs.saveKey({ id: "gas-x", status: "reviewed" }), code(FL.CANCELLED));
  await gs.saveKey({ id: "gas-x", status: "open" });                 // adoption of a proven open is still recorded
  assert.equal((await w.store.getJournal(w.p.id)).steps.terminate.status, "planned");
});

// ---- gas: quote click -> re-render -> fund click -----------------------------------------------------------------------
function gasWorld() {
  const w = world();
  const recs = [{ id: "gas-nucbox", sid: "0xs1", status: "open", owner: OWNER, chainId: 8453, vault: ctxA.vault, relay: ctxA.relay, grant: { apps: ["0xa"] } },
    { id: "gas-metal", sid: "0xs2", status: "open", owner: OWNER, chainId: 8453, vault: ctxA.vault, relay: ctxA.relay, grant: { apps: ["0xb"] } }];
  w.store = memStore([], recs);
  const scope = { deployments: new Map([[DEPS[0], { appId: "0xa" }], [DEPS[1], { appId: "0xb" }]]) };
  const calls = { quote: 0, confirm: [] };
  const core = {
    selectGasRecord: (rs, sc, d) => { const r = rs.find((x) => x.grant.apps.includes(sc.deployments.get(d).appId)); if (!r) throw new Error("none"); return r; },
    quoteGasFund: async ({ record, deployment, ethOut, feeTier }) => { calls.quote += 1;
      return { deployment, sid: record.sid, call: { digest: `0xD${calls.quote}`, intent: { ethOut: BigInt(ethOut), fee: feeTier }, execute: { deadline: 1000n } }, totals: {} }; },
    confirmGasFund: async ({ record, review, relay }) => { await relay("POST", "/funding/execute", {}); calls.confirm.push([record.id, review.call.digest]); return { pending: true }; },
  };
  return { ...w, scope, core, calls };
}
const inA = ST.quoteInputsOf({ deployment: DEPS[0], ethOut: "20000000000000", feeTier: "500" });
const inB = ST.quoteInputsOf({ deployment: DEPS[1], ethOut: "20000000000000", feeTier: "500" });
const quote = (w, memory, inputs) => FL.quoteFlow({ g: w.g(), memory, ctx: ctxA, inputs, store: w.store, scope: w.scope, core: w.core, quoteArgs: {}, now });
const fund = (w, memory, inputs, shownDigest) => FL.fundFlow({ g: w.g(), memory, ctx: ctxA, inputs, shownDigest, store: w.store, scope: w.scope,
  core: w.core, fundArgs: { relay: w.relay }, now });

test("gas: quote -> the re-render shows the same quote -> fund sends exactly that quote, once", async () => {
  const w = gasWorld();
  const memory = ST.createMemory();
  memory.bind(ctxA);
  const q = await quote(w, memory, inA);
  memory.bind(ctxA);                                             // what the act() re-render does (same context)
  const restored = memory.quoteInputs(ctxA);                     // the re-render restores the controls from the held quote
  const shown = memory.peekQuote(ctxA, restored, 100n);
  assert.equal(shown.digest, q.digest.toLowerCase());
  assert.equal(shown.recordId, "gas-nucbox");
  await fund(w, memory, restored, shown.digest);
  assert.deepEqual(w.calls.confirm, [["gas-nucbox", "0xD1"]], "the displayed quote is the one sent");
  await assert.rejects(fund(w, memory, restored, shown.digest), code("quote_stale"), "single use");
  assert.equal(w.calls.confirm.length, 1);
});

test("gas: selecting deployment B after quoting A can never fund A's quote; changed inputs, remount and switches refuse", async () => {
  const w = gasWorld();
  const memory = ST.createMemory();
  memory.bind(ctxA);
  const q = await quote(w, memory, inA);
  assert.equal(memory.peekQuote(ctxA, inB, 100n), null, "B shows no quote");
  await assert.rejects(fund(w, memory, inB, q.digest), code("quote_stale"));
  await quote(w, memory, inA);
  memory.dropQuote();                                            // what an input change does
  await assert.rejects(fund(w, memory, inA, "0xd2"), code("quote_stale"));
  await quote(w, memory, inA);
  memory.clear();                                                // remount
  await assert.rejects(fund(w, memory, inA, "0xd3"), code("quote_stale"));
  memory.bind(ctxA);
  await quote(w, memory, inA);
  const g = w.g();
  w.live.chainId = 1;
  await assert.rejects(FL.fundFlow({ g, memory, ctx: ctxA, inputs: inA, shownDigest: "0xd4", store: w.store, scope: w.scope, core: w.core, fundArgs: { relay: w.relay }, now }), code(FL.CANCELLED));
  assert.deepEqual(w.calls.confirm, []);
  assert.equal(w.posts.length, 0);
});
