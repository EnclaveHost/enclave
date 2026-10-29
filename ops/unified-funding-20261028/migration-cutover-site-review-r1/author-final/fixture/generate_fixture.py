#!/usr/bin/env python3
"""migration-cutover-site-r1 owned TEST browser fixture generator. UNREVIEWED, NOT RUN by its author. ROOT reviews first.

    python3 migration-cutover-site-r1/fixture/generate_fixture.py

Derives ONE actual-page browser fixture from the QUALIFIED production-grant-terms-r1 harness (its out/server.mjs, shell,
build driver and page shell; every input sha256-pinned in generated/FIXTURE-GEN-PINS.json, root-filled; null, drift or
rootConfirmed != true refuses). Writes ONLY migration-cutover-site-r1/{out,shell,build,page}/ (same layout, so the
server's / build driver's HERE / UF derivation is unchanged) and refuses if any exists. Edits are labelled
"migration-cutover-site-r1"; reversing them must give back each pinned input exactly.

  out/server.mjs   + ONE labelled fault: while POST /test/fixture/funding-api {absent:true} is on, EVERY /v1/sessions/funding/*
                     request is answered with the EXACT production pre-API reply: HTTP 404 application/json
                     {"error":"no such sessions endpoint","code":"not_found"} (counted). Original routes (/owner, /open) are
                     the real composed relay. Everything else (owned Anvil 8453/osaka, public Anvil keys, mock USDC, ONE
                     TxQueue, dropped first gas-open reply, execute faults, intake-off fault, CSP, loopback Host pin,
                     prompt cap, owned-PID cleanup, no code-size override) is the pinned server byte for byte.
  shell/harness-state.js, shell/facade/config.js   + FUNDING_MIGRATION_CUTOVER / FUNDING_CUTOVER_ACTIVATION (TEST values
                     from the shell; null unless a phase sets them).
  shell/main.mjs   + the page under test is migration-cutover-site-r1/candidate (generate_site.py output);
                   + cutover phases C1-C10 replace phases 1-4 for this run (pPrepare is never enabled), ending in the
                     existing "interrupted" state, so the qualified phases 5-16 (+ controls / null runtime / cleanup) follow
                     unchanged; pComplete's absolute prompt count becomes 19 (2 + 7 + 6 + 2 + 2).
  build/build-harness.mjs   the page path (2 lines) + provenance.   page/index.html   the title.

NOT produced here (root, after review): candidate/site/vendor/funding.js built from candidate/sdk/funding/browser-entry.mjs,
generated/BUILD-PINS.json + page/dist/harness.js, generated/HARNESS-INPUTS.json (as for production-grant-terms-r1).
"""
from pathlib import Path
import hashlib
import json
import re
import sys

HERE = Path(__file__).resolve().parent.parent           # migration-cutover-site-r1
UF = HERE.parent                                        # unified-funding-20261028
M = "migration-cutover-site-r1"
B = "production-grant-terms-r1"
FACADES = ["api.js", "wallet.js", "empty.js", "sessions.js", "vendor-funding.js"]
COPIES = {f"{B}/shell/facade/{f}": f"shell/facade/{f}" for f in FACADES}
INPUTS = [f"{B}/out/server.mjs", f"{B}/shell/main.mjs", f"{B}/shell/harness-state.js", f"{B}/shell/facade/config.js",
          f"{B}/build/build-harness.mjs", f"{B}/page/index.html", *COPIES]
OUTDIRS = ["out", "shell", "build", "page"]
GUARD = '  if (args.some((a) => /code-size|disable-code-size/.test(a))) fail("no code-size override");'
ANVIL_KEYS = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
              "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
              "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"]
T = "   // " + M


def sub(a, b):
    return (a, b)


def before(a, ins):
    return (a, ins + a)


def after(a, ins):
    return (a, a + ins)


SERVER_EDITS = [
    before('// DERIVED by production-grant-terms-r1/fixture/generate_fixture.py from client-execution-site-r2/out/server.mjs (pinned). Lines marked "production-grant-terms-r1"\n',
           "// DERIVED by " + M + "/fixture/generate_fixture.py from " + B + "/out/server.mjs (pinned). Lines marked \"" + M + "\" are the\n"
           "// only changes: a labelled fault answering /v1/sessions/funding/* with the EXACT production pre-API 404. TEST ONLY.\n"),
    sub('owned.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "production-grant-terms-r1-"));',
        'owned.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "' + M + '-"));'),
    sub("const counters = { prompts: [], hits: {}, dropped: [], ticks: 0, dbs: [], intakeOff: false, intakeOffReplies: 0, executeFaults: [] };\n",
        "const counters = { prompts: [], hits: {}, dropped: [], ticks: 0, dbs: [], intakeOff: false, intakeOffReplies: 0, executeFaults: [],\n"
        "  fundingApiAbsent: false, fundingApiAbsentReplies: 0 };" + T + "\n"),
    after("let intakeOff = false;                      // client-site-browser-r1: labelled fault, toggled only by POST /test/fixture/intake\n",
          "let fundingApiAbsent = false;" + T + ": labelled fault, toggled only by POST /test/fixture/funding-api\n"
          'const PRE_FUNDING_API_404 = Object.freeze({ error: "no such sessions endpoint", code: "not_found" });' + T + ": the exact production reply\n"),
    before('  if (p === "/test/fixture/intake") {                       // client-site-browser-r1: labelled intake-off fault switch\n',
           '  if (p === "/test/fixture/funding-api") {' + T + ": labelled pre-funding-API fault switch\n"
           '    if (typeof body.absent !== "boolean") return send(res, 400, { error: "absent must be a boolean" });\n'
           "    fundingApiAbsent = body.absent; counters.fundingApiAbsent = fundingApiAbsent;\n"
           '    console.log(`harness: TEST pre-funding-API fault ${fundingApiAbsent ? "ON" : "OFF"}`);\n'
           "    return send(res, 200, { fundingApiAbsent });\n"
           "  }\n"),
    before('    if (k === "GET /v1/sessions/funding/config" && intakeOff) {   // client-site-browser-r1 labelled fault (service error shape)\n',
           '    if (fundingApiAbsent && u.pathname.startsWith("/v1/sessions/funding/")) {' + T + ": the old relay has NO funding routes\n"
           "      counters.fundingApiAbsentReplies += 1;\n"
           "      return send(res, 404, PRE_FUNDING_API_404);\n"
           "    }\n"),
]
SERVER_KEEP = ['"--chain-id", "8453", "--hardfork", "osaka"', "if (req.headers.host !== here)", "let dropFirstFundingOpen = true;",
               'owned.server.listen(port, "127.0.0.1"', "const MAX_PROMPTS = 24;", 'if (p === "/test/fixture/execute-fault") {',
               'await write(usdc, "fiatUsdc", "mint", [owner, 1_000_000_000n]);                 // mock funds only',
               "const ETH_OUT = 200_000_000_000_000n;", '  split: { legacy6: "24000000", nucbox6: "4800000", nucboxOps: "16", metal6: "1200000", metalOps: "4" },']

STATE_EDITS = [
    sub("    pageConfig = Object.freeze({ runtime: c.runtime ?? null, proposal: c.proposal ?? null, approval: c.approval ?? null });\n",
        "    pageConfig = Object.freeze({ runtime: c.runtime ?? null, proposal: c.proposal ?? null, approval: c.approval ?? null,\n"
        "      cutover: c.cutover ?? null, activation: c.activation ?? null });" + T + "\n"),
]
CONFIG_EDITS = [
    after("export const FUNDING_MIGRATION_APPROVAL = c.approval;\n",
          "export const FUNDING_MIGRATION_CUTOVER = c.cutover;" + T + ": TEST pause terms (null unless a C-phase set them)\n"
          "export const FUNDING_CUTOVER_ACTIVATION = c.activation;" + T + ": TEST activation record (never a production review)\n"),
]
BUILD_EDITS = [
    after("#!/usr/bin/env node\n", "// DERIVED by " + M + "/fixture/generate_fixture.py from " + B + "/build/build-harness.mjs (pinned): page path only.\n"),
    sub('const PAGE = abs("client-execution-site-r2/candidate/site/js/pages/funding.js");',
        'const PAGE = abs("' + M + '/candidate/site/js/pages/funding.js");'),
    sub('["../../client-execution-site-r2/candidate/site/js/pages/funding.js", PAGE],',
        '["../../' + M + '/candidate/site/js/pages/funding.js", PAGE],'),
]
PAGE_EDITS = [
    sub("<title>TEST ONLY - production-grant-terms-r1 /funding recovery page harness (NEW TEST terms 24 / 4.8 / 1.2)</title>",
        "<title>TEST ONLY - " + M + " /funding reviewed cutover (pause after the original ends) page harness</title>"),
]

PHASES = r'''// =====================================================================================================================
// migration-cutover-site-r1: the reviewed cutover path. C1-C10 replace phases 1-4 in this run; C10 hands over to phase 5;
// phases 5-16 then run unchanged. While the labelled fault is on, the relay answers /v1/sessions/funding/* with the EXACT
// production pre-API 404. Every activation record here is a TEST record, never a production review or a drain proof.
// =====================================================================================================================
const CUT_DOCS = ["TEST activation plan (migration-cutover-site-r1 fixture; not a production document)",
  "TEST rollback plan (migration-cutover-site-r1 fixture; not a production document)"];
const sha256hex = async (s) => `0x${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))))}`;
const fundingPosts = (s) => Object.entries(s.hits).filter(([k]) => k.startsWith("POST /v1/sessions/funding/")).reduce((n, [, v]) => n + v, 0);
const shownPaused = () => !!q('#fdMig [data-cutover="paused"]');
const hitOf = (s, k) => s.hits[k] ?? 0;
async function activationOf(st, over = {}) {
  const j = await planOf(st);
  return { schema: "enclave-funding-cutover-activation-r1", planId: j.id, termsHash: j.termsHash, terminateTxHash: j.steps.terminate.txHash,
    terminateBlockHash: j.steps.terminate.proof.blockHash, activationPlanSha256: st.cutover.terms.activationPlanSha256, relayer: st.relayer,
    legacyRelayerReconciledThroughNonce: "0",           // TEST statement only: unverifiable by the browser, NOT a drain proof
    rootReviewed: true, reviewedBy: "TEST fixture (migration-cutover-site-r1); never a production review", ...over };
}
async function stillPaused(st, what) {
  const j = await planOf(st);
  check(j.cutover?.paused === true && !j.cutover.resumed && ORDER.slice(1).every((k) => j.steps[k].status === "planned"), what);
}

phase("cMode", "C1. Reviewed pause mode: hide the funding API (exact 404) and set the TEST pause terms (reloads)", "original", async () => {
  const st = H.load();
  const live = await F.relayClient(origin)("GET", "/funding/config");
  check(/^0x[0-9a-fA-F]{40}$/.test(String(live.relayer)), "fixture successor relayer read BEFORE the API is hidden");
  await call("/test/fixture/funding-api", { absent: true });
  let refused = null;
  try { await F.relayClient(origin)("GET", "/funding/config"); } catch (e) { refused = e; }
  check(refused?.status === 404 && refused.code === "not_found" && JSON.stringify(refused.detail) === '{"error":"no such sessions endpoint","code":"not_found"}',
    "the relay now answers the exact production pre-API 404");
  const [a, r] = await Promise.all(CUT_DOCS.map(sha256hex));
  const cutover = { schema: "enclave-funding-migration-cutover-r1", chainId: 8453, owner: fx.owner, oldSid: st.oldSid,
    terms: { pauseAfter: "terminate", activationPlanSha256: a, rollbackPlanSha256: r } };
  H.save({ ...H.load(), cutover, relayer: lower(live.relayer) });
  advance("cutMode", "TEST pause terms set; funding API hidden", true);
});

phase("cPrepare", "C2. Page: API shown as not deployed; controls render; prepare the pause-bound plan (no wallet)", "cutMode", async () => {
  const st = H.load();
  const s0 = await status();
  await fresh();
  check(!!q('#fdMig [data-funding-api="absent"]') && text("#fdMig").includes("not deployed yet") && text("#fdMig").includes("404 not_found"),
    "page: the new funding service is not deployed (404 not_found), not relabelled");
  check(text("#fdControls").toLowerCase().includes(lower(fx.vault)), "owner controls render independently of the missing API");
  check(text("#fdGas").includes("New gas funding is paused"), "gas: nothing offered while the API is absent");
  const n = toasts.length;
  await clickPage("#fdPrepare");
  await waitToast(n, /Plan prepared/, "plan prepared");
  await settled();
  const plan = await planOf(st);
  await stage("journaled plan is exactly the TEST terms (24 / 4.8 / 1.2, NEW candidate) and what the page displays", () => verifyTestTerms(plan, st));
  const tc = plan.terms.cutover;
  check(Object.keys(tc).length === 4 && tc.pauseAfter === "terminate" && tc.activationPlanSha256 === st.cutover.terms.activationPlanSha256
    && tc.rollbackPlanSha256 === st.cutover.terms.rollbackPlanSha256 && tc.claim === "termination-prefix-only-not-a-relay-drain",
  "termsHash covers the pause, the activation and rollback hashes and the not-a-drain claim");
  check(plan.stagedIntake === null && String(plan.stagedIntakeWhy).startsWith("not_found:"), "intake recorded as absent (null), never on");
  check(text("#fdMig").includes("Waiting for review") && q("#fdSign").disabled && q("#fdRun").disabled, "waiting for review: Sign and Send disabled");
  const s1 = await status();
  check(s1.prompts.length === s0.prompts.length && JSON.stringify(posts(s1)) === JSON.stringify(posts(s0)), "no prompt, no POST");
  check(s1.fundingApiAbsentReplies > s0.fundingApiAbsentReplies, "the page really met the exact 404");
  advance("cutPlanned", "pause-bound plan prepared; click C3");
});

phase("cApprove", "C3. Harness: TEST-approve exactly the displayed pause-bound plan (reloads)", "cutPlanned", async () => {
  const st = H.load();
  await fresh();
  const plan = await planOf(st);
  await stage("re-check TEST terms before approving", () => verifyTestTerms(plan, st));
  const approval = { schema: "enclave-funding-migration-approval-r1", rootReviewed: true, termsHash: plan.termsHash, owner: fx.owner, chainId: 8453, oldSid: st.oldSid };
  log(`    TEST approval for termsHash ${plan.termsHash} (TEST terms only; never a production approval)`);
  H.save({ ...H.load(), approval });
  advance("cutApproved", "TEST approval set for this exact pause-bound plan", true);
});

phase("cTerminate", "C4. Page: Sign the WHOLE plan (7 prompts), then Send: only the original ends, exact refund, paused", "cutApproved", async () => {
  const st = H.load();
  await fresh();
  check(text("#fdMig").includes("Approved for exactly this plan.") && /\(4 steps\)/.test(text("#fdSign")) && !q("#fdSign").disabled, "approved; Sign next (4 steps)");
  check(await usdcOf(fx, fx.owner) === BigInt(st.ownerStart) - OLD_BUDGET && await usdcOf(fx, fx.legacyVault) === OLD_BUDGET, "before: the original holds exactly 30");
  const s0 = await status();
  let n = toasts.length;
  await clickPage("#fdSign");
  await waitToast(n, /Signed 4 step/, "signed");
  await settled();
  const s1 = await status();
  check(JSON.stringify(s1.prompts.slice(s0.prompts.length).map((p) => p.primaryType)) === JSON.stringify(["Terminate", "SessionGrant",
    "ReceiveWithAuthorization", "SessionGrant", "ReceiveWithAuthorization", "SessionGrant", "ReceiveWithAuthorization"]), "7 prompts: the whole plan, in step order");
  check(JSON.stringify(posts(s1)) === JSON.stringify(posts(s0)), "signing sent nothing");
  n = toasts.length;
  await clickPage("#fdRun");
  await waitToast(n, /paused until the new funding service/, "paused after the original ended");
  await settled();
  const s2 = await status();
  check(hitOf(s2, "POST /v1/sessions/owner") - hitOf(s0, "POST /v1/sessions/owner") === 1 && hitOf(s2, "POST /v1/sessions/open") === hitOf(s0, "POST /v1/sessions/open")
    && fundingPosts(s2) === fundingPosts(s0), "exactly one send (the original's termination); no replacement, no gas POST");
  const j = await planOf(st);
  check(j.steps.terminate.status === "proven" && j.cutover?.paused === true && j.cutover.terminate?.txHash === j.steps.terminate.txHash, "durable pause recorded with the termination proof");
  await stillPaused(st, "everything after the termination is still planned");
  check(await usdcOf(fx, fx.owner) === BigInt(st.ownerStart) && await usdcOf(fx, fx.legacyVault) === 0n, "exact refund: owner back to its Start balance, original vault 0");
  check(shownPaused() && text("#fdMig").includes("$30.00 returned to your wallet") && q("#fdSign").disabled && q("#fdRun").disabled, "page: Paused, $30.00 returned; Sign and Send disabled");
  check(q("#fdActivate")?.disabled === true && text("#fdMig").includes("Waiting for the reviewed activation record"), "no record: Record activation disabled");
  check(localStorage.getItem(WALLET_SESSION_KEY) !== j.steps.legacyOpen.review.sid, "active pointer not moved to an unopened replacement");
  advance("cutPaused", "original ended with an exact refund; paused; click C5");
});

phase("cReload", "C5. Real reload while paused", "cutPaused", async () => { advance("cutReloaded", "reloading while paused", true); });

phase("cPausedCheck", "C6. After reload: still paused; Check status keeps it; no replacement, gas POST or prompt", "cutReloaded", async () => {
  const st = H.load();
  check(performance.getEntriesByType("navigation")[0]?.type === "reload", "this document was loaded by a reload");
  const s0 = await status();
  await fresh();
  check(shownPaused() && q("#fdSign").disabled && q("#fdRun").disabled && q("#fdActivate")?.disabled === true, "after reload: paused; nothing to sign, send or activate");
  check(text("#fdGas").includes("New gas funding is paused"), "gas: paused while the API is absent");
  const n = toasts.length;
  await clickPage("#fdRec");
  await waitToast(n, /^Status:/, "reconcile status");
  await settled();
  await stillPaused(st, "reconcile kept the pause; nothing admitted");
  const s1 = await status();
  check(s1.prompts.length === s0.prompts.length && JSON.stringify(posts(s1)) === JSON.stringify(posts(s0)), "no prompt, no POST");
  check(shownPaused(), "still paused on the page");
  H.save({ ...H.load(), activation: await activationOf(st, { terminateTxHash: `0x${"ab".repeat(32)}` }) });
  advance("cutBadAct", "a MISMATCHED TEST activation record is configured for the next load", true);
});

phase("cBadAct", "C7. Page Record activation with a mismatched record: refused, still paused (then the right record, reloads)", "cutBadAct", async () => {
  const st = H.load();
  const s0 = await status();
  await fresh();
  check(!q("#fdActivate").disabled && text("#fdMig").includes("A reviewed activation record is available."), "Record activation enabled (a record is configured)");
  const n = toasts.length;
  await clickPage("#fdActivate");
  await waitToast(n, /activation_not_plan/, "mismatched record refused");
  await settled();
  await stillPaused(st, "mismatched record: still paused");
  const s1 = await status();
  check(s1.prompts.length === s0.prompts.length && JSON.stringify(posts(s1)) === JSON.stringify(posts(s0)), "no prompt, no POST");
  H.save({ ...H.load(), activation: await activationOf(st) });
  advance("cutNoApi", "the right TEST record is configured; the funding API is still absent", true);
});

phase("cNoApi", "C8. Page Record activation with the right record while the API is still absent: refused (intake), still paused", "cutNoApi", async () => {
  const st = H.load();
  const s0 = await status();
  await fresh();
  const n = toasts.length;
  await clickPage("#fdActivate");
  await waitToast(n, /intake_off/, "no live intake: refused");
  await settled();
  await stillPaused(st, "absent intake: still paused");
  const s1 = await status();
  check(s1.prompts.length === s0.prompts.length && JSON.stringify(posts(s1)) === JSON.stringify(posts(s0)), "no prompt, no POST");
  check(s1.fundingApiAbsentReplies > s0.fundingApiAbsentReplies, "the fresh check really met the 404");
  await call("/test/fixture/funding-api", { absent: false });
  advance("cutApiLive", "TEST successor API now answers; click C9");
});

phase("cActivate", "C9. Page Record activation: an ACCOUNT switch during the fresh check stops it; then it records (no send)", "cutApiLive", async () => {
  const st = H.load();
  for (let i = 0; i < 4; i += 1) await tick();              // the termination must be final for the record
  await fresh();
  check(!q('#fdMig [data-funding-api="absent"]') && shownPaused() && !q("#fdActivate").disabled, "API live; still paused; Record activation enabled");
  const s0 = await status();
  H.armRpc(async () => { log("    (hold) switching the account before the fresh check's first chain read"); walletState(OTHER, 8453); });
  let n = toasts.length;
  await clickPage("#fdActivate");
  await waitToast(n, /context_changed/, "cancelled by the switch");
  await settled();
  await sleep(1500);
  await stillPaused(st, "switch: nothing recorded");
  await fresh();
  n = toasts.length;
  await clickPage("#fdActivate");
  await waitToast(n, /Activation recorded/, "activation recorded");
  await settled();
  const j = await planOf(st);
  check(j.cutover?.paused === true && j.cutover.resumed?.terminateTxHash === j.steps.terminate.txHash && j.cutover.resumed.runtimeBlock > Number(j.steps.terminate.proof.block),
    "activation recorded against a runtime verified after the termination; the pause record is kept");
  check(ORDER.slice(1).every((k) => j.steps[k].status === "planned"), "recording sent nothing; every remaining step still planned");
  const s1 = await status();
  check(s1.prompts.length === s0.prompts.length && JSON.stringify(posts(s1)) === JSON.stringify(posts(s0)), "no prompt, no POST, no automatic send");
  check(!!q('#fdMig [data-cutover="resumed"]') && /\(3 steps\)/.test(text("#fdSign")) && !q("#fdSign").disabled && q("#fdRun").disabled, "page: remaining 3 steps offered for signing; nothing held");
  advance("cutActivated", "activation recorded; click C10");
});

phase("cResign", "C10. Page: re-sign the remaining steps (6 prompts), then Send (first gas reply is LOST)", "cutActivated", async () => {
  const st = H.load();
  await fresh();
  const s0 = await status();
  let n = toasts.length;
  await clickPage("#fdSign");
  await waitToast(n, /Signed 3 step/, "signed");
  await settled();
  const s1 = await status();
  check(JSON.stringify(s1.prompts.slice(s0.prompts.length).map((p) => p.primaryType)) === JSON.stringify(["SessionGrant", "ReceiveWithAuthorization",
    "SessionGrant", "ReceiveWithAuthorization", "SessionGrant", "ReceiveWithAuthorization"]), "6 prompts: replacement + both gas parts");
  n = toasts.length;
  await clickPage("#fdRun");
  await waitFor(() => toasts.length > n, "the send result");
  await settled();
  const j = await planOf(st);
  check(j.steps.legacyOpen.status === "proven" && j.steps["gasOpen:nucbox"].status === "admitted" && !j.steps["gasOpen:nucbox"].txHash
    && j.steps["gasOpen:metal"].status === "planned", "replacement proven; first gas open ADMITTED (unknown, never resent); metal untouched");
  const s2 = await status();
  check(hitOf(s2, "POST /v1/sessions/open") - hitOf(s0, "POST /v1/sessions/open") === 1 && hitOf(s2, "POST /v1/sessions/funding/open") - hitOf(s0, "POST /v1/sessions/funding/open") === 1
    && s2.dropped.length === 1, "one replacement open, one gas open (its reply dropped by the fixture)");
  check(localStorage.getItem(WALLET_SESSION_KEY) === j.steps.legacyOpen.review.sid, "the page moved the TEST active pointer to the replacement");
  check(text("#fdMig").includes("Outcome unknown") && q("#fdRun").disabled && q("#fdSign").disabled, "page: outcome unknown, only Check status offered");
  H.save({ ...H.load(), newSid: j.steps.legacyOpen.review.sid });
  advance("interrupted", "interrupted as designed: click Reload page, then phase 5 (unchanged)");
});

'''

MAIN_EDITS = [
    before('// DERIVED by production-grant-terms-r1/fixture/generate_fixture.py from client-execution-site-r2/shell/main.mjs (pinned). Lines marked "production-grant-terms-r1"\n',
           "// DERIVED by " + M + "/fixture/generate_fixture.py from " + B + "/shell/main.mjs (pinned). Lines marked \"" + M + "\" are the only\n"
           "// changes: the page under test is " + M + "/candidate, and cutover phases C1-C10 replace phases 1-4 in this run.\n"),
    sub('phase("pPrepare", "1. Page button: Check original & prepare plan (no wallet)", "original", async () => {\n',
        'phase("pPrepare", "1. (not in this run: replaced by C1-C10)", "never-in-' + M + '", async () => {' + T + "\n"),
    before('phase("pReload", "Reload page (F5 equivalent)", "*", async () => { location.reload(); });\n', PHASES),
    sub('  check(s.prompts.length === 15, "15 owner prompts in total (2 original + 2 cancelled + 7 + 2 dropped bundle + 2)");\n',
        '  check(s.prompts.length === 19, "19 owner prompts in total (2 original + 7 whole plan + 6 after activation + 2 dropped bundle + 2)");' + T + "\n"),
    sub("  H.setPageConfig({ runtime: st?.nullRuntime ? null : fx.pins, proposal: st?.oldSid ? proposalOf(fx, st.oldSid) : null, approval: st?.approval ?? null });\n",
        "  H.setPageConfig({ runtime: st?.nullRuntime ? null : fx.pins, proposal: st?.oldSid ? proposalOf(fx, st.oldSid) : null, approval: st?.approval ?? null,\n"
        "    cutover: st?.cutover ?? null, activation: st?.activation ?? null });" + T + "\n"),
    sub('  const page = await import("../../client-execution-site-r2/candidate/site/js/pages/funding.js");   // client-execution-site-r2: the generated recovery page copy (aliases only)\n',
        '  const page = await import("../../' + M + '/candidate/site/js/pages/funding.js");' + T + ": the cutover page candidate (aliases only)\n"),
]
NEW_PHASES = ["cMode", "cPrepare", "cApprove", "cTerminate", "cReload", "cPausedCheck", "cBadAct", "cNoApi", "cActivate", "cResign"]
KEPT_PHASES = ["pStart", "pReload", "pRecover", "pSwitch2", "pComplete", "pQuote", "pFund", "pExecFinal", "pExecLost", "pExecReload",
               "pExec502", "pExecSwitch", "pControls", "pNull", "pNullCheck", "pCleanup"]
ADDED_FORBIDDEN = ["window.ethereum", "eth_requestAccounts", "exportKey", "https://", "api.enclave.host", "--code-size", "funding_disabled",
                   "openEnabled: true"]


def sha(b):
    return hashlib.sha256(b).hexdigest()


def die(m):
    sys.exit(f"generate_fixture.py: {m}")


def apply(text, edits, what):
    new = text
    for a, b in edits:
        if new.count(a) != 1:
            die(f"{what}: anchor occurs {new.count(a)} times (expected 1): {a[:80]!r}")
        if a not in b and new.count(b) != 0:
            die(f"{what}: replacement text already present")
        new = new.replace(a, b)
    back = new
    for a, b in reversed(edits):
        if back.count(b) != 1:
            die(f"{what}: replacement occurs {back.count(b)} times: {b[:80]!r}")
        back = back.replace(b, a)
    if back != text:
        die(f"{what}: reversing the edits does not give back the pinned source exactly")
    return new


def added_text(edits):
    return "".join(b.replace(a, "", 1) if a in b else b for a, b in edits)


def main():
    if sys.argv[1:]:
        die("no arguments")
    pins = json.loads((HERE / "generated" / "FIXTURE-GEN-PINS.json").read_text())
    if pins.get("rootConfirmed") is not True:
        die("FIXTURE-GEN-PINS.json rootConfirmed is not true: root must hash the inputs independently first")
    if set(pins["inputs"]) != set(INPUTS):
        die(f"FIXTURE-GEN-PINS.json must list exactly {sorted(INPUTS)}")
    src = {}
    for rel, want in pins["inputs"].items():
        if not isinstance(want, str) or not re.fullmatch(r"[0-9a-f]{64}", want):
            die(f"{rel}: no root-filled sha256 (refusing)")
        b = (UF / rel).read_bytes()
        if sha(b) != want:
            die(f"{rel}: sha256 {sha(b)} != pinned {want} (refusing)")
        src[rel] = b
    for d in OUTDIRS:
        if (HERE / d).exists():
            die(f"{d}/ already exists; inspect or move it first (nothing is overwritten)")
    if not (HERE / "candidate" / "GENERATED.json").exists():
        die("generate the page/SDK candidate first (generator/generate_site.py); the fixture qualifies that candidate")

    all_added = added_text(SERVER_EDITS + MAIN_EDITS + STATE_EDITS + CONFIG_EDITS + BUILD_EDITS + PAGE_EDITS)
    for bad in ADDED_FORBIDDEN:
        if bad in all_added:
            die(f"the fixture edits add {bad!r}")
    if PHASES.count('advance("interrupted"') != 1 or PHASES.count('"original", async') != 1:
        die("the cutover path must start at the original session and hand over to phase 5 exactly once")

    server = src[f"{B}/out/server.mjs"].decode("utf-8")
    if M in server:
        die(f"the source server already mentions {M}")
    new_server = apply(server, SERVER_EDITS, "server")
    if new_server.count(GUARD) != 1:
        die("the unchanged no-code-size-override refusal must remain exactly once")
    scanned = new_server.replace(GUARD, "")
    for bad in ("--code-size", "disable-code-size", "pkill", "killall", "process.kill(-", "mainnet", "base.org", "window.ethereum"):
        if bad in scanned:
            die(f"the derived server contains {bad!r}")
    for keep in SERVER_KEEP:
        if new_server.count(keep) != 1:
            die(f"the derived server must keep {keep!r} exactly once")
    found_keys = set(re.findall(r"0x[0-9a-f]{64}", new_server)) & set(re.findall(r'\["(0x[0-9a-f]{64})", "0x[0-9A-Fa-f]{40}"\]', new_server))
    if found_keys != set(ANVIL_KEYS):
        die(f"the derived server's signing keys must be exactly the three public Anvil keys, got {sorted(found_keys)}")

    main_js = src[f"{B}/shell/main.mjs"].decode("utf-8")
    if M in main_js:
        die(f"the source shell already mentions {M}")
    new_main = apply(main_js, MAIN_EDITS, "shell/main.mjs")
    for ph in NEW_PHASES + KEPT_PHASES:
        if new_main.count(f'phase("{ph}", ') != 1:
            die(f"phase {ph} must be defined exactly once")

    outputs = {
        "out/server.mjs": new_server.encode("utf-8"),
        "shell/main.mjs": new_main.encode("utf-8"),
        "shell/harness-state.js": apply(src[f"{B}/shell/harness-state.js"].decode("utf-8"), STATE_EDITS, "harness-state.js").encode("utf-8"),
        "shell/facade/config.js": apply(src[f"{B}/shell/facade/config.js"].decode("utf-8"), CONFIG_EDITS, "config.js").encode("utf-8"),
        "build/build-harness.mjs": apply(src[f"{B}/build/build-harness.mjs"].decode("utf-8"), BUILD_EDITS, "build").encode("utf-8"),
        "page/index.html": apply(src[f"{B}/page/index.html"].decode("utf-8"), PAGE_EDITS, "page").encode("utf-8"),
    }
    for rel, t in COPIES.items():
        outputs[t] = src[rel]
    for p, b in outputs.items():
        f = HERE / p
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b)
    gen = {"schema": f"{M}-fixture-generated/v1", "testOnly": True, "inputs": pins["inputs"],
           "outputs": {p: sha(b) for p, b in sorted(outputs.items())},
           "phases": {"new": NEW_PHASES, "kept": KEPT_PHASES, "neverEnabled": ["pPrepare", "pApprove", "pSwitch1", "pSignSend"]},
           "edits": {"server": len(SERVER_EDITS), "shell": len(MAIN_EDITS), "harness-state": len(STATE_EDITS), "config": len(CONFIG_EDITS),
                     "build": len(BUILD_EDITS), "page": len(PAGE_EDITS)},
           "rootMustStill": ["build candidate/site/vendor/funding.js from candidate/sdk/funding/browser-entry.mjs",
                             "fill generated/BUILD-PINS.json and run build/build-harness.mjs", "fill generated/HARNESS-INPUTS.json"]}
    (HERE / "out" / "GENERATED.json").write_text(json.dumps(gen, indent=2) + "\n")
    print(json.dumps(gen, indent=2))


if __name__ == "__main__":
    main()
