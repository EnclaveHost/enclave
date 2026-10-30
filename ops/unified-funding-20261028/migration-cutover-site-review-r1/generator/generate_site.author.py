#!/usr/bin/env python3
"""migration-cutover-site-r1 site/SDK generator. UNREVIEWED, NOT RUN by its author. ROOT reviews before running.

    python3 migration-cutover-site-r1/generator/generate_site.py [--link-viem]

Derives an ISOLATED candidate (writes ONLY migration-cutover-site-r1/candidate/, refuses if it exists):

  candidate/sdk/funding/*.mjs   = migration-cutover-prep-r1/candidate/sdk/funding (root-reviewed, 11 checks passed; pinned
                                  below from its GENERATED.json "outputs") with ONE module edited: funding-client.mjs gains
                                  an explicit opt-in staging allowance in verifyRuntime for ONLY the exact production answer
                                  GET /funding/config -> HTTP 404 {"error":"no such sessions endpoint","code":"not_found"}.
                                  With the opt-in (staging: PRE_FUNDING_API) that answer is recorded as ABSENT intake
                                  (intake null, intakeWhy = the original "not_found: ..." text, intakeAbsent = {status, code,
                                  error}); never as on, never relabelled funding_disabled. Without the opt-in (default) the
                                  same answer still throws not_found exactly as before. Every on-chain pin is still checked
                                  first; every other answer keeps its old handling. POST / gas-send code is untouched.
                                  The other seven modules (migration.mjs with the reviewed pause included) are byte-identical.
  candidate/site/js/pages/funding.js, candidate/site/js/funding/state.js, candidate/site/js/funding/flows.js
                                = source/site/js/... (pinned) + the smallest UI wiring of the reviewed cutover mode.

Pins of source/site/js/... are the client-execution-site-r2 INSTALL-MANIFEST "sha256" values (what source/ should hold
after that install). ROOT: re-hash source/ independently; the generator refuses on any drift.

Nothing in source/, production-grant-terms-r1/ or migration-cutover-prep-r1/ is written. All FUNDING_* defaults stay
null: the page reads the two NEW optional values (FUNDING_MIGRATION_CUTOVER, FUNDING_CUTOVER_ACTIVATION) through a
namespace import of the UNCHANGED core/config.js, so a config.js without them (the live one) yields null = old behavior.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import sys

HERE = Path(__file__).resolve().parent.parent            # migration-cutover-site-r1
UF = HERE.parent                                         # unified-funding-20261028
SRCROOT = UF.parent / "source"                           # == migration-cutover-site-r1/../../source
M = "migration-cutover-site-r1"
PREP = UF / "migration-cutover-prep-r1"
SDK_IN = PREP / "candidate" / "sdk" / "funding"
OUT = HERE / "candidate"
VIEM_VERSION = "2.53.1"

# migration-cutover-prep-r1/candidate/GENERATED.json "outputs" (root-reviewed candidate). Cross-checked at run time.
SDK_PINS = {
    "browser-entry.mjs": "9820589c2aab82d3ae22f2ba73011970d0754557f12da7871859f3d368bbf879",
    "chain-proof.mjs": "ca799d8f86db1dd3a7113703cba5fd929e770f02f5c63fa3f5589b05f5e074b3",
    "funding-client.mjs": "4a17b36549b5eb115863b0d08ac76e6e9dbd966934b93875bbc34fd0ea897fa7",
    "funding-codec.mjs": "ceed082639299b35073005d2ffb0ce8e5ceee1a3035804f197cdf53a4f6739d7",
    "gas-execution.mjs": "1ccf75dbd8ac248c9a139ab692f1f144b8f0f16c8e2b0334c4047ceac9b3df5c",
    "migration.mjs": "740e0f859da31ce55139e3f893ac2e344214a41257491a8fd3708c3ba0f57ced",
    "util.mjs": "38b678a68ecf7fd897fb1ae905d27471a17d10f8061fa29d81f5870549e12e66",
    "v2-store.mjs": "b00d0742ee3d2b211b4cf811c48c8e7004dbf7e8a4cf30517db5ec199181733c",
}
# client-execution-site-r2/candidate/INSTALL-MANIFEST.json "sha256" of the installed source files. ROOT: re-hash source/.
PAGE_PINS = {
    "site/js/pages/funding.js": "2730b091138529d08be82504a2121107a202125cf1f55f95b2cc8c715c69bd3c",
    "site/js/funding/state.js": "361bae2bc531a640cfb58d389e026d5677eb5da70063f2bdda07070b09397f54",
    "site/js/funding/flows.js": "137b4a1babb7ccb5d6f913488c519660c99d5b934c79a433a0255b35e8fa48d1",
}


def before(a, ins):
    return (a, ins + a)


def after(a, ins):
    return (a, a + ins)


def sub(a, b):
    return (a, b)


T = "   // " + M

# ---------------------------------------------------------------------------------------------------------------------
# SDK: funding-client.mjs (verifyRuntime only)
# ---------------------------------------------------------------------------------------------------------------------
FC_BLOCK = '''// ''' + M + ''': the ONE answer of a relay WITHOUT the funding API that a reviewed cutover may be PREPARED against.
// Opt-in only (verifyRuntime({ ..., staging: PRE_FUNDING_API })). The answer is recorded as ABSENT intake, never as on.
export const PRE_FUNDING_API = "pre-funding-api-404-r1";
const PRE_FUNDING_API_REPLY = Object.freeze({ status: 404, code: "not_found", error: "no such sessions endpoint" });
/** true ONLY for the exact production reply GET /funding/config -> HTTP 404 {"error":"no such sessions endpoint",
 *  "code":"not_found"} (exactly these two keys, as relayClient parsed it). Anything else is false. */
export function isPreFundingApiReply(e) {
  const d = e?.detail;
  const R = PRE_FUNDING_API_REPLY;
  return e instanceof RelayError && e.status === R.status && e.code === R.code && e.message === `${R.code}: ${R.error}`
    && d !== null && typeof d === "object" && !Array.isArray(d) && Object.keys(d).sort().join() === "code,error"
    && d.code === R.code && d.error === R.error;
}

'''
FC_EDITS = [
    sub("export async function verifyRuntime({ pins, rpc, relay, owner, now }) {\n",
        FC_BLOCK
        + "export async function verifyRuntime({ pins, rpc, relay, owner, now, staging }) {\n"
        + '  if (staging !== undefined && staging !== PRE_FUNDING_API) fail("staging_mode", `the only staging mode is ${PRE_FUNDING_API}`);' + T + "\n"),
    after("  let intakeWhy = null;\n",
          "  let intakeAbsent = null;" + T + "\n"),
    sub('    if (e?.code !== "funding_disabled" && e?.code !== "relay_unreachable") throw e;\n',
        "    const absent = staging === PRE_FUNDING_API && isPreFundingApiReply(e);" + T + ": exact opt-in match only\n"
        "    if (absent) intakeAbsent = Object.freeze({ status: e.status, code: e.code, error: e.detail.error });\n"
        '    if (!absent && e?.code !== "funding_disabled" && e?.code !== "relay_unreachable") throw e;\n'),
    sub("  return Object.freeze({ cfg, pins: P, intake, intakeWhy, relayer: intake?.relayer ?? null,\n",
        "  return Object.freeze({ cfg, pins: P, intake, intakeWhy, ...(intakeAbsent ? { intakeAbsent } : {}), relayer: intake?.relayer ?? null,\n"),
]
FC_KEEP = ['const c = await relay("GET", "/funding/config");',
           'if (c.enabled !== true || Number(c.chainId) !== CHAIN_ID || Number(c.action) !== ACTION_GAS_FUND) fail("relay_config"',
           'openEnabled: c.open?.enabled === true, ownerEnabled: c.owner?.enabled === true',
           "await pin.recheck();\n\n  let intake = null;",
           'if (keccak256(code) !== P.codehashes[k]) fail("codehash_mismatch"',
           'if (!runtime.intake?.openEnabled) fail("intake_off", `successor intake/open is off:',
           'if (!runtime.intake) fail("intake_off", `gas.fund intake is off:']

# ---------------------------------------------------------------------------------------------------------------------
# state.js
# ---------------------------------------------------------------------------------------------------------------------
ST_BLOCK = '''
// ---- ''' + M + ''': explicit reviewed cutover mode (pause after the original session ends) ------------------
// The SDK decides (terms.cutover in termsHash, full-plan signatures before terminate, durable pause, resumeCutover);
// this only selects the mode, mirrors the journal for display and narrows what the page OFFERS to sign.

export const CUTOVER_CONFIG_SCHEMA = "enclave-funding-migration-cutover-r1";
/** null -> null (normal mode, unchanged). Otherwise the reviewed pause terms for THIS owner, chain and original session. */
export function validateCutover(c, { owner, chainId, oldSid }) {
  if (c === null || c === undefined) return null;
  exactKeys(c, ["schema", "chainId", "owner", "oldSid", "terms"], "cutover");
  if (c.schema !== CUTOVER_CONFIG_SCHEMA) fail("schema", `cutover.schema must be ${CUTOVER_CONFIG_SCHEMA}`);
  if (Number(c.chainId) !== Number(chainId)) fail("chain", "the cutover is for another chain");
  if (!ADDR.test(String(c.owner)) || lower(c.owner) !== lower(owner)) fail("owner", "the cutover is for another wallet");
  if (!HEX32.test(String(c.oldSid)) || lower(c.oldSid) !== lower(oldSid)) fail("sid", "the cutover is for another session");
  exactKeys(c.terms, ["pauseAfter", "activationPlanSha256", "rollbackPlanSha256"], "cutover.terms");
  if (c.terms.pauseAfter !== "terminate") fail("shape", "the only reviewed pause is right after the original ends");
  for (const k of ["activationPlanSha256", "rollbackPlanSha256"]) {
    if (!HEX32.test(String(c.terms[k])) || c.terms[k] === ZERO32) fail("shape", `cutover.terms.${k} must be a lower-case sha256`);
  }
  if (c.terms.activationPlanSha256 === c.terms.rollbackPlanSha256) fail("shape", "the activation and rollback plans must differ");
  return Object.freeze({ pauseAfter: "terminate", activationPlanSha256: c.terms.activationPlanSha256, rollbackPlanSha256: c.terms.rollbackPlanSha256 });
}

/** A journaled plan is used only in ITS OWN mode: never silently moved into or out of the reviewed pause. */
export function planMode(plan, cut) {
  const pc = plan?.terms?.cutover ?? null;
  if (!pc && !cut) return { mode: "normal", ok: true };
  if (pc && cut && pc.pauseAfter === cut.pauseAfter && pc.activationPlanSha256 === cut.activationPlanSha256
    && pc.rollbackPlanSha256 === cut.rollbackPlanSha256) return { mode: "cutover", ok: true };
  return { mode: pc ? "cutover" : "normal", ok: false, reason: pc ? (cut ? "cutover_terms_differ" : "cutover_not_configured") : "plan_without_pause" };
}

/** The pause as the journal records it (display only; the core's cutoverHeld decides admission). */
export function cutoverView(plan) {
  if (!plan?.terms?.cutover) return { kind: "none" };
  const t = plan.steps?.terminate;
  const c = plan.cutover;
  if (t?.status !== "proven") return { kind: "before" };
  if (c?.paused !== true || c.terminate?.txHash !== t.txHash) return { kind: "marker_missing" };
  if (c.resumed && c.resumed.terminateTxHash === t.txHash) return { kind: "resumed", txHash: t.txHash };
  return { kind: "paused", txHash: t.txHash, block: c.terminate.block };
}

/** Cutover mode: before the original ends ONLY the whole plan at once (terminate, replacement, every gas part); while
 *  paused, nothing; after the recorded activation, the normal rule. Never a bundle across an unknown/admitted step. */
export function cutoverSignable(plan, nowSec) {
  const v = cutoverView(plan);
  if (v.kind === "paused" || v.kind === "marker_missing") return [];
  const next = nextSignable(plan, nowSec);
  if (next[0] === "terminate" && next.length !== (plan.terms.order || []).length) return [];
  return next;
}
export const signableOf = (plan, nowSec, cut) => (cut ? cutoverSignable(plan, nowSec) : nextSignable(plan, nowSec));
'''
ST_EDITS = [
    before("/* ============================================================\n",
           "// " + M + ": DERIVED (pinned) from source/site/js/funding/state.js; only the appended cutover block is new.\n"),
    after("    get hasQuote() { return quote !== null; },\n  };\n  return api;\n}\n", ST_BLOCK),
]
ST_KEEP = ['if (out[0] === "terminate" && !out.includes("legacyOpen")) return [];',
           "for (const k of order.slice(0, at)) if (!stillProven(plan.steps[k])) return null;",
           'if (approval.termsHash !== plan.termsHash) return { ok: false, reason: "approval_other_terms", termsHash: plan.termsHash };',
           'if (approval.rootReviewed !== true) return { ok: false, reason: "approval_not_reviewed" };',
           'bind(ctx) { if (ctxKey !== ctx.key) { signed = null; quote = null; } ctxKey = ctx.key; },']

# ---------------------------------------------------------------------------------------------------------------------
# flows.js
# ---------------------------------------------------------------------------------------------------------------------
FL_RESUME = '''
/** ''' + M + ''': "Record activation" click. A FRESH verified context (a new runtime read) must name the SAME
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
'''
FL_EDITS = [
    before("/* ============================================================\n",
           "// " + M + ": DERIVED (pinned) from source/site/js/funding/flows.js; lines marked \"" + M + "\" are new.\n"),
    sub("  }) || (!before && !!after);\n",
        "  }) || (!before && !!after)\n"
        "    || JSON.stringify(before?.cutover?.resumed ?? null) !== JSON.stringify(after?.cutover?.resumed ?? null);" + T + ": recording activation starts something\n"),
    sub("async function freshScopedPlan({ g, store, ctx, np, planId, approvalCfg }) {\n",
        "async function freshScopedPlan({ g, store, ctx, np, planId, approvalCfg, cut }) {\n"),
    after('  if (!ok.ok) throw new ST.StateError("approval_required", `not approved: ${ok.reason}`);\n',
          "  const md = ST.planMode(plan, cut ?? null);" + T + ": a plan is used only in its own mode\n"
          '  if (!md.ok) throw new ST.StateError("plan_mode", `this plan cannot be used in the configured mode (${md.reason})`);\n'),
    sub("export async function signFlow({ g, memory, ctx, np, approvalCfg, shown, store, provider, core, signArgs, now }) {\n",
        "export async function signFlow({ g, memory, ctx, np, approvalCfg, cut, shown, store, provider, core, signArgs, now }) {\n"),
    sub("freshScopedPlan({ g, store, ctx, np, planId: shown.planId, approvalCfg })",
        "freshScopedPlan({ g, store, ctx, np, planId: shown.planId, approvalCfg, cut })"),
    sub("  const want = ST.nextSignable(plan, now());\n",
        "  const want = ST.signableOf(plan, now(), cut ?? null);" + T + "\n"),
    sub("export async function runFlow({ g, memory, ctx, np, approvalCfg, planId, store, core, stepCtx }) {\n",
        "export async function runFlow({ g, memory, ctx, np, approvalCfg, cut, planId, store, core, stepCtx }) {\n"),
    sub("  const { plan } = await freshScopedPlan({ g, store, ctx, np, planId, approvalCfg });\n",
        "  const { plan } = await freshScopedPlan({ g, store, ctx, np, planId, approvalCfg, cut });\n"),
    after("  return core.confirmGasFund({ ...fundArgs, store: guardGasStore(store, g), record, review, relay: guardRelayFn(fundArgs.relay, g), now: now() });\n}\n",
          FL_RESUME),
]
FL_KEEP = ['if (!g.alive() && startsSomething(before, next)) throw cancelled("admitting or re-arming a step");',
           'if (!bundle) throw new ST.StateError("signatures_stale"', "memory.dropSigned();",
           'if (want.length === 0 || want.join() !== shown.steps.join()) throw new ST.StateError("plan_changed"',
           'g.check("using the wallet\'s answer");']

# ---------------------------------------------------------------------------------------------------------------------
# pages/funding.js
# ---------------------------------------------------------------------------------------------------------------------
P_CUT = '''  const md = ST.planMode(plan, cut);''' + T + ''': never moves a plan between modes
  const cv = ST.cutoverView(plan);
  const next = md.ok ? ST.signableOf(plan, now, cut) : [];
'''
P_CUTHTML = '''  const canSign = appr.ok && match.ok && md.ok && next.length > 0 && !signedReady;
  const rearmOk = md.ok && cv.kind !== "paused" && cv.kind !== "marker_missing";''' + T + '''
  const cutHtml = !md.ok ? `<p><strong>${md.reason === "plan_without_pause" ? "This plan was prepared without the reviewed pause, so it cannot be used now."
      : "This plan's pause does not match this site's reviewed setting."} Nothing can be signed or sent; you can still check status.</strong></p>`
    : cv.kind === "before" ? "<p>All steps are signed together. Sending ends the original session first; then everything pauses until the new funding service is confirmed.</p>"
    : cv.kind === "paused" ? `<p data-cutover="paused"><strong>Paused.</strong> The original session has ended and ${esc(usd(tv.original6))} returned to your wallet
      (confirmed on chain, tx <code>${esc(cv.txHash.slice(0, 12))}…</code>). The replacement session and gas grants stay closed until the new
      funding service is confirmed. Nothing is sent automatically. This does not show that the old service has finished its work.</p>
      <p>${FUNDING_CUTOVER_ACTIVATION ? "A reviewed activation record is available." : "Waiting for the reviewed activation record."}</p>
      <button class="btn" id="fdActivate" ${FUNDING_CUTOVER_ACTIVATION && appr.ok && match.ok ? "" : "disabled"}>Record activation</button>`
    : cv.kind === "marker_missing" ? "<p data-cutover=\\"marker_missing\\"><strong>Paused: the record of the pause is missing. Stop and ask for review.</strong></p>"
    : cv.kind === "resumed" ? "<p data-cutover=\\"resumed\\">Activation recorded. Sign the remaining steps, then send.</p>" : "";
'''
P_EDITS = [
    before("// GENERATED by client-execution-site-r2/generator/generate_page.py from client-site-repair-r2/authored/site/js/pages/funding.js (pinned). Additions are marked\n",
           "// DERIVED by " + M + "/generator/generate_site.py from source/site/js/pages/funding.js (pinned). Lines marked \"" + M + "\"\n"
           "// are the only changes: the explicit reviewed cutover mode (FUNDING_MIGRATION_CUTOVER) and its Record activation click.\n"),
    after('import * as FL from "../funding/flows.js";\n',
          'import * as SITE_CONFIG from "../core/config.js";' + T + ": optional values; absent = null\n"
          "// " + M + ": the reviewed pause terms and the root-reviewed activation record. Both default to null; with null the page\n"
          "// behaves exactly as before. Neither is ever derived, defaulted or filled in by the page.\n"
          "const FUNDING_MIGRATION_CUTOVER = SITE_CONFIG.FUNDING_MIGRATION_CUTOVER ?? null;\n"
          "const FUNDING_CUTOVER_ACTIVATION = SITE_CONFIG.FUNDING_CUTOVER_ACTIVATION ?? null;\n"),
    sub("async function context(owner) {\n", "async function context(owner, cut = null) {\n"),
    sub("  const relay = f.relayClient(relayRoot());\n  const runtime = await f.verifyRuntime({ pins: FUNDING_RUNTIME, rpc, relay, owner, now: nowS() });\n",
        "  const relay = f.relayClient(relayRoot());\n"
        "  // " + M + ": ONLY with the reviewed pause configured for this owner/session may the exact \"funding API not deployed\"\n"
        "  // answer be staged against (recorded as absent, never on). Default: unchanged strict check.\n"
        "  const runtime = await f.verifyRuntime({ pins: FUNDING_RUNTIME, rpc, relay, owner, now: nowS(), ...(cut ? { staging: f.PRE_FUNDING_API } : {}) });\n"),
    sub("  let c;\n  try { c = await context(owner); }",
        "  let cut;" + T + "\n"
        "  try { cut = ST.validateCutover(FUNDING_MIGRATION_CUTOVER, { owner, chainId: CHAIN, oldSid: np.oldSid }); }\n"
        "  catch (err) { box.innerHTML = `<h3>Funding migration</h3><p>No migration is offered to this wallet (${errText(err)}).</p>`; return; }\n"
        "  let c;\n  try { c = await context(owner, cut); }"),
    after("  view.c = c;\n  memory.bind(c.ctx);\n",
          "  const apiNote = c.runtime.intakeAbsent ? `<p data-funding-api=\"absent\"><strong>The new funding service is not deployed yet</strong>" + T + "\n"
          "    (the server answered ${esc(String(c.runtime.intakeAbsent.status))} ${esc(c.runtime.intakeAbsent.code)}). Your controls above are not affected.</p>` : \"\";\n"
          "  const cutNote = cut ? \"<p>Reviewed pause: after the original session ends, nothing else opens until the new funding service is confirmed.</p>\" : \"\";\n"),
    after("      ${refusedNote}\n", "      ${apiNote}${cutNote}\n"),
    sub("        gasStore: FL.guardGasStore(c.gasStore, g), relayBase: relayRoot() });\n",
        "        gasStore: FL.guardGasStore(c.gasStore, g), relayBase: relayRoot(), ...(cut ? { cutover: { ...cut } } : {}) });" + T + "\n"),
    sub("  const next = ST.nextSignable(plan, now);\n", P_CUT),
    sub("  const canSign = appr.ok && match.ok && next.length > 0 && !signedReady;\n", P_CUTHTML),
    after("    <p>These are the plan's own terms; every signature covers exactly these amounts.</p>\n", "    ${apiNote}\n"),
    sub('      ${v.actions.includes("rearm") ? `<button class="btn" data-rearm="${esc(k)}">Prepare again</button>` : ""}</li>`; }).join("")}</ol>\n',
        '      ${v.actions.includes("rearm") && rearmOk ? `<button class="btn" data-rearm="${esc(k)}">Prepare again</button>` : ""}</li>`; }).join("")}</ol>\n'),
    before('    <button class="btn" id="fdRec">Check status on chain</button>\n', "    ${cutHtml}\n"),
    sub('    <button class="btn" id="fdRun" ${signedReady && match.ok && appr.ok ? "" : "disabled"}>Send signed steps</button>`;\n',
        '    <button class="btn" id="fdRun" ${signedReady && match.ok && appr.ok && md.ok ? "" : "disabled"}>Send signed steps</button>`;\n'),
    sub("  const flowArgs = (g) => ({ g, memory, ctx: c.ctx, np, approvalCfg: FUNDING_MIGRATION_APPROVAL, store: c.gasStore });\n",
        "  const flowArgs = (g) => ({ g, memory, ctx: c.ctx, np, approvalCfg: FUNDING_MIGRATION_APPROVAL, cut, store: c.gasStore });" + T + "\n"),
    sub('    return r.done ? "Migration complete" : r.pending ? "Sent; waiting for chain confirmation" : r.needsSignature ? "Next step needs signing" : "Check status on chain";\n',
        '    return r.done ? "Migration complete" : r.paused ? "Original session ended and refunded; paused until the new funding service is confirmed"' + T + "\n"
        '      : r.pending ? "Sent; waiting for chain confirmation" : r.needsSignature ? "Next step needs signing" : "Check status on chain";\n'),
    after('    return "Prepared again; it needs signing (the approval is unchanged because the terms are unchanged).";\n  })));\n',
          '  if (cv.kind === "paused" && $("#fdActivate")) $("#fdActivate").addEventListener("click", act(e, owner, async (g) => {' + T + "\n"
          "    await FL.resumeFlow({ g, ctx: c.ctx, np, approvalCfg: FUNDING_MIGRATION_APPROVAL, cut, planId: plan.id, store: c.gasStore,\n"
          "      activation: FUNDING_CUTOVER_ACTIVATION, freshContext: () => context(owner, cut), core: c.f, stepCtxOf: (fc) => stepCtx(fc, g) });\n"
          '    return "Activation recorded. Sign the remaining steps, then send.";\n'
          "  }));\n"),
]
P_KEEP = ["memory.clear();", 'if (!c.runtime.intake) { box.innerHTML = `<h3>Gas for your apps</h3><p>New gas funding is paused',
          "await renderControls(e, owner);", "const runtime = await f.verifyRuntime({ pins: FUNDING_RUNTIME, rpc, relay, owner, now: nowS() });",
          "const r = await c.f.reconcileMigration(stepCtx(c, g), plan.id);", "await c.f.rearmStep({ ...stepCtx(c, g), rng: undefined }, plan.id, el.dataset.rearm);",
          'import { APP_CATALOG_RPCS, FUNDING_RUNTIME, FUNDING_MIGRATION_PROPOSAL, FUNDING_MIGRATION_APPROVAL } from "../core/config.js";',
          'const lib = async () => (F ??= await import("/vendor/funding.js"));']

# Added text that would be a fake intake, a relabel, a new secret/signing/network path, an override or a production URL.
FORBIDDEN_NEW = ["openEnabled: true", "intake = ", "enabled: true", "localStorage", "lsSet(", "window.ethereum", "eth_requestAccounts",
                 "eth_sendTransaction", "exportKey", "pkcs8", "privateKey", "fetch(", "setTimeout", "setInterval", "override",
                 "https://", "api.enclave.host", "connectWallet(", "runMigration(", "signSteps(", "rearmStep(", "process.env", "\"*\"",
                 "drained", "drain proof"]
SINGLE = {"funding-client.mjs": ["staging === PRE_FUNDING_API", 'fail("staging_mode"'],
          "site/js/pages/funding.js": ["staging: f.PRE_FUNDING_API", "FL.resumeFlow(", "cutover: { ...cut }"]}


def sha(b):
    return hashlib.sha256(b).hexdigest()


def die(m):
    sys.exit(f"generate_site.py: {m}")


def apply(text, edits, what):
    new = text
    for a, b in edits:
        if new.count(a) != 1:
            die(f"{what}: anchor occurs {new.count(a)} times (expected 1): {a[:90]!r}")
        if a not in b and new.count(b) != 0:
            die(f"{what}: replacement text already present")
        new = new.replace(a, b)
    back = new
    for a, b in reversed(edits):
        if back.count(b) != 1:
            die(f"{what}: replacement occurs {back.count(b)} times: {b[:90]!r}")
        back = back.replace(b, a)
    if back != text:
        die(f"{what}: reversing the edits does not give back the pinned input exactly")
    return new


def added_text(edits):
    return "".join(b.replace(a, "", 1) if a in b else b for a, b in edits)


def derive(name, text, edits, keep):
    if M in text:
        die(f"{name} already mentions {M}")
    new = apply(text, edits, name)
    for k in keep:
        if text.count(k) != 1 or new.count(k) != 1:
            die(f"{name} must keep {k!r} exactly once")
    added = added_text(edits)
    for bad in FORBIDDEN_NEW:
        if bad in added:
            die(f"{name}: the edits add {bad!r}")
    for one in SINGLE.get(name, []):
        if new.count(one) != 1:
            die(f"{name}: {one!r} must appear exactly once")
    return new


def main():
    if sys.argv[1:] not in ([], ["--link-viem"]):
        die("usage: generate_site.py [--link-viem]")
    gen = json.loads((PREP / "candidate" / "GENERATED.json").read_text())
    outs = {k.rsplit("/", 1)[1]: v for k, v in gen["outputs"].items()}
    if outs != SDK_PINS:
        die("migration-cutover-prep-r1/candidate/GENERATED.json outputs differ from this generator's pins")
    sdk = {}
    for f, want in SDK_PINS.items():
        b = (SDK_IN / f).read_bytes()
        if sha(b) != want:
            die(f"sdk {f}: sha256 {sha(b)} != pinned {want}")
        sdk[f] = b
    page = {}
    for rel, want in PAGE_PINS.items():
        b = (SRCROOT / rel).read_bytes()
        if sha(b) != want:
            die(f"source/{rel}: sha256 {sha(b)} != pinned {want}")
        page[rel] = b
    if OUT.exists():
        die("candidate/ already exists; inspect or move it first (nothing is overwritten)")

    fc_in = sdk["funding-client.mjs"].decode("utf-8")
    fc = derive("funding-client.mjs", fc_in, FC_EDITS, FC_KEEP)
    for word in ('"funding_disabled"', '"relay_unreachable"', '"not_found"'):
        if fc.count(word) != fc_in.count(word) + (1 if word == '"not_found"' else 0):
            die(f"funding-client.mjs: {word} count changed unexpectedly (no relabel, one exact reply literal)")
    outputs = {f"sdk/funding/{f}": b for f, b in sdk.items() if f != "funding-client.mjs"}
    outputs["sdk/funding/funding-client.mjs"] = fc.encode("utf-8")
    outputs["site/js/funding/state.js"] = derive("site/js/funding/state.js", page["site/js/funding/state.js"].decode("utf-8"), ST_EDITS, ST_KEEP).encode("utf-8")
    outputs["site/js/funding/flows.js"] = derive("site/js/funding/flows.js", page["site/js/funding/flows.js"].decode("utf-8"), FL_EDITS, FL_KEEP).encode("utf-8")
    outputs["site/js/pages/funding.js"] = derive("site/js/pages/funding.js", page["site/js/pages/funding.js"].decode("utf-8"), P_EDITS, P_KEEP).encode("utf-8")

    for rel, b in outputs.items():
        p = OUT / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    for f in SDK_PINS:
        if f != "funding-client.mjs" and (OUT / "sdk" / "funding" / f).read_bytes() != sdk[f]:
            die(f"{f} must be byte-identical")

    viem = None
    if sys.argv[1:] == ["--link-viem"]:
        target = (SRCROOT / "node_modules" / "viem").resolve()
        v = json.loads((target / "package.json").read_text())
        if v.get("name") != "viem" or v.get("version") != VIEM_VERSION:
            die(f"viem at {target} is {v.get('name')}@{v.get('version')}, pinned {VIEM_VERSION}")
        (OUT / "node_modules").mkdir()
        os.symlink(target, OUT / "node_modules" / "viem", target_is_directory=True)
        viem = {"symlink": "candidate/node_modules/viem", "target": str(target), "version": v["version"]}

    out = {"schema": f"{M}-generated/v1", "status": "UNREVIEWED_NOT_APPROVED_NOT_SIGNABLE",
           "inputs": {**{f"migration-cutover-prep-r1/candidate/sdk/funding/{f}": h for f, h in SDK_PINS.items()},
                      **{f"source/{r}": h for r, h in PAGE_PINS.items()}},
           "outputs": {f"candidate/{r}": sha(b) for r, b in sorted(outputs.items())},
           "byteIdentical": sorted(f"sdk/funding/{f}" for f in SDK_PINS if f != "funding-client.mjs"),
           "edits": {"funding-client.mjs": len(FC_EDITS), "state.js": len(ST_EDITS), "flows.js": len(FL_EDITS), "pages/funding.js": len(P_EDITS)},
           "defaults": {"FUNDING_RUNTIME": None, "FUNDING_MIGRATION_PROPOSAL": None, "FUNDING_MIGRATION_APPROVAL": None,
                        "FUNDING_MIGRATION_CUTOVER": None, "FUNDING_CUTOVER_ACTIVATION": None},
           "viem": viem}
    (OUT / "GENERATED.json").write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
