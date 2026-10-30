// migration-cutover-site-r1: DERIVED (pinned) from source/site/js/funding/flows.js; lines marked "migration-cutover-site-r1" are new.
/* ============================================================
   Funding page click flows + effect guards (no DOM, no globals).
   UNREVIEWED SOURCE (client-site-repair-r2).

   Every dependency is injected (core functions, store, relay,
   provider, the live wallet snapshot), so the exact sequence a
   click performs is executable in offline tests.

   A guard snapshots { epoch, owner, chainId, provider } when a
   click starts. The effect boundaries handed to the UNCHANGED core
   re-check it immediately before every effect:
     - provider.request: before each wallet prompt, and the answer
       is discarded if the context changed while it was open;
     - relay POSTs (successor function client and legacy client);
     - journal compare-and-set: a transition of a planned/void step
       (admission, re-arm) is refused; outcomes of ALREADY admitted
       steps (submitted, proven, error notes, rechecks, void) are
       still recorded, so reconcile keeps working;
     - gas key records: only adoption (status "open") is recorded
       after a change;
     - the active legacy pointer (setActive) is never moved.
   A tripped guard throws `context_changed`; nothing is retried.
   ============================================================ */
import * as ST from "./state.js";

export const CANCELLED = "context_changed";
const cancelled = (what) => new ST.StateError(CANCELLED, `the wallet, network or page changed; ${what} was not done`);

export function createGuard(read) {
  const at = read();
  const g = {
    at,
    alive() {
      const n = read();
      return n.epoch === at.epoch && ST.lower(n.owner) === ST.lower(at.owner) && Number(n.chainId) === Number(at.chainId)
        && n.provider === at.provider && !!at.owner;
    },
    check(what = "the next step") { if (!g.alive()) throw cancelled(what); },
  };
  return g;
}

export const guardProvider = (provider, g) => provider && Object.freeze({
  async request(args) {
    g.check(`the wallet request ${args?.method ?? ""}`);
    const out = await provider.request(args);
    g.check("using the wallet's answer");                 // answered for an old context: discarded
    return out;
  },
});

const isRead = (method) => String(method).toUpperCase() === "GET";
export const guardRelayFn = (relay, g) => async (method, path, body) => {
  if (!isRead(method)) g.check(`${method} ${path}`);
  return relay(method, path, body);
};
export const guardLegacyRelay = (client, g) => Object.freeze({
  request: async (method, path, body) => {
    if (!isRead(method)) g.check(`${method} ${path}`);
    return client.request(method, path, body);
  },
});

/** Steps whose status was planned/void must not change after a context switch (no admission, no re-arm). */
function startsSomething(before, after) {
  const a = before?.steps || {};
  const b = after?.steps || {};
  return Object.keys({ ...a, ...b }).some((k) => {
    const was = a[k]?.status;
    if (was !== "planned" && was !== "void" && was !== undefined) return false;
    return JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null);
  }) || (!before && !!after)
    || JSON.stringify(before?.cutover?.resumed ?? null) !== JSON.stringify(after?.cutover?.resumed ?? null);   // migration-cutover-site-r1: recording activation starts something
}
export function guardGasStore(store, g) {
  return Object.freeze({
    loadKey: (id) => store.loadKey(id),
    listKeys: () => store.listKeys(),
    getJournal: (id) => store.getJournal(id),
    listJournal: () => store.listJournal(),
    putJournal: (e) => store.putJournal(e),             // core journals outcomes of its own sends (never a start)
    async saveKey(rec) {
      if (!g.alive() && rec?.status !== "open") throw cancelled("updating a gas key record");
      return store.saveKey(rec);
    },
    casJournal(id, mutate) {
      return store.casJournal(id, (cur) => {
        const before = cur ? JSON.parse(JSON.stringify(cur)) : null;
        const next = mutate(cur);
        if (!g.alive() && startsSomething(before, next)) throw cancelled("admitting or re-arming a step");
        return next;
      });
    },
  });
}
export const guardSetActive = (setActive, g) => async (newSid, oldSid) => {
  g.check("moving the active session");
  return setActive(newSid, oldSid);
};

/** The plan for this click, re-read and re-checked: scoped to this context (relay evidence included), equal to the
 *  configured proposal, approved field by field. Throws with a code, never returns a partial answer. */
async function freshScopedPlan({ g, store, ctx, np, planId, approvalCfg, cut }) {
  const plan = await store.getJournal(planId);
  const records = await store.listKeys();
  g.check("reading the plan");
  const sc = ST.planScope(plan, ctx, records, np?.oldSid);
  if (!sc.ok) throw new ST.StateError("plan_out_of_scope", `this plan does not belong to the connected context (${sc.reason})`);
  const m = ST.proposalMatchesPlan(np, plan);
  if (!m.ok) throw new ST.StateError("proposal_plan_mismatch", `the configured proposal differs from the plan's reviewed terms (${m.diffs.join(", ")})`);
  const ok = ST.approvalStatus(approvalCfg, plan, ctx);
  if (!ok.ok) throw new ST.StateError("approval_required", `not approved: ${ok.reason}`);
  const md = ST.planMode(plan, cut ?? null);   // migration-cutover-site-r1: a plan is used only in its own mode
  if (!md.ok) throw new ST.StateError("plan_mode", `this plan cannot be used in the configured mode (${md.reason})`);
  return { plan, approval: ok.approval };
}

/** Sign the next steps of the plan the person was SHOWN (same termsHash, same steps). Wallet prompts go through the
 *  guarded provider, one after another; a change between prompts stops the rest and keeps nothing. */
export async function signFlow({ g, memory, ctx, np, approvalCfg, cut, shown, store, provider, core, signArgs, now }) {
  g.check("signing");
  const { plan, approval } = await freshScopedPlan({ g, store, ctx, np, planId: shown.planId, approvalCfg, cut });
  if (plan.termsHash !== shown.termsHash) throw new ST.StateError("plan_changed", "the plan changed; review it again");
  const want = ST.signableOf(plan, now(), cut ?? null);   // migration-cutover-site-r1
  if (want.length === 0 || want.join() !== shown.steps.join()) throw new ST.StateError("plan_changed", "the signable steps changed; review again");
  const bundle = await core.signSteps({ ...signArgs, plan, steps: want, approval, provider: guardProvider(provider, g), now: now() });
  g.check("keeping the signatures");
  memory.holdSigned(ctx, plan, want, bundle);
  return want;
}

/** Send the held bundle for the exact plan it was signed for. The bundle is single use; the core admits and sends one
 *  step at a time through the guarded store / relays / setActive in `stepCtx`. */
export async function runFlow({ g, memory, ctx, np, approvalCfg, cut, planId, store, core, stepCtx }) {
  g.check("sending");
  const { plan } = await freshScopedPlan({ g, store, ctx, np, planId, approvalCfg, cut });
  const bundle = memory.signedFor(ctx, plan);
  if (!bundle) throw new ST.StateError("signatures_stale", "the held signatures do not match this exact plan anymore; sign again");
  memory.dropSigned();
  g.check("sending");
  return core.runMigration(stepCtx, planId, bundle);
}

/** The guarded context handed to the core's runMigration / reconcileMigration / rearmStep. */
export const guardedStepCtx = (base, g) => ({ ...base, gasStore: guardGasStore(base.gasStore, g), relay: guardRelayFn(base.relay, g),
  legacyRelay: guardLegacyRelay(base.legacyRelay, g), setActive: guardSetActive(base.setActive, g) });

/** Quote click: the record is the ONE open grant naming the selected deployment's app; the quote is held for exactly
 *  the selected inputs and is what later renders display. */
export async function quoteFlow({ g, memory, ctx, inputs, store, scope, core, quoteArgs, now }) {
  g.check("quoting");
  if (!inputs) throw new ST.StateError("quote_inputs", "choose a deployment, a whole-wei ETH amount and a fee tier");
  const records = ST.selectOwnRecords(await store.listKeys(), ctx);
  const journal = await store.listJournal();
  g.check("quoting");
  const record = core.selectGasRecord(records, scope, inputs.deployment);
  const review = await core.quoteGasFund({ ...quoteArgs, record, scope, deployment: inputs.deployment, ethOut: inputs.ethOut,
    feeTier: Number(inputs.feeTier), now: now(), journalEntries: journal });
  g.check("keeping the quote");
  memory.holdQuote(ctx, record, inputs, review);
  return { recordId: record.id, digest: ST.lower(review.call.digest) };
}

/** Fund click: re-selects the record for the CURRENT inputs, takes the held quote only for those inputs and the digest
 *  the person saw, then the core signs with the session key and executes through the guarded relay. */
export async function fundFlow({ g, memory, ctx, inputs, shownDigest, store, scope, core, fundArgs, now }) {
  g.check("funding");
  const records = ST.selectOwnRecords(await store.listKeys(), ctx);
  g.check("funding");
  let record = null;
  try { record = inputs ? core.selectGasRecord(records, scope, inputs.deployment) : null; } catch { record = null; }
  const review = memory.takeQuote(ctx, record, inputs, shownDigest, now());
  if (!review) throw new ST.StateError("quote_stale", "the quote expired, was used, or does not match the current choices; get a new one");
  return core.confirmGasFund({ ...fundArgs, store: guardGasStore(store, g), record, review, relay: guardRelayFn(fundArgs.relay, g), now: now() });
}

/** migration-cutover-site-r1: "Record activation" click. A FRESH verified context (a new runtime read) must name the SAME
 *  owner / chain / vaults / relay as the page shown; the plan is re-read, scoped, equal to the proposal, approved and in
 *  the reviewed cutover mode and paused; then the core checks the root-reviewed evidence, live intake, the relayer and a
 *  final termination, and records the activation. Never signs, sends, re-arms or reconnects anything. */
export async function resumeFlow({ g, ctx, np, approvalCfg, cut, planId, store, activation, freshContext, core, stepCtxOf }) {
  g.check("recording the activation");
  if (!cut) throw new ST.StateError("plan_mode", "the reviewed pause is not configured here");
  if (activation === null || activation === undefined) throw new ST.StateError("activation_required", "no reviewed activation record is configured; still paused");
  const fresh = await freshContext();
  g.check("recording the activation");
  if (!fresh?.ctx || fresh.ctx.key !== ctx.key) throw new ST.StateError("context_mismatch", "the fresh check names another wallet, network, vault or relay; still paused");
  const scoped = await freshScopedPlan({ g, store, ctx, np, planId, approvalCfg, cut });
  if (ST.cutoverView(scoped.plan).kind !== "paused") throw new ST.StateError("not_paused", "this plan is not paused after its original ended");
  g.check("recording the activation");
  return core.resumeCutover(stepCtxOf(fresh), planId, activation);
}
