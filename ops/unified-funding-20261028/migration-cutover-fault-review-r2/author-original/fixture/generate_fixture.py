#!/usr/bin/env python3
"""migration-cutover-fault-r2 owned TEST browser fixture generator. UNREVIEWED, NOT RUN by its author. ROOT reviews first.

    python3 migration-cutover-fault-r2/fixture/generate_fixture.py

Derives ONE actual-page browser fixture from the ROOT-QUALIFIED migration-cutover-site-review-r1 harness (its out/server.mjs,
shell, build driver and page shell). Every input is sha256-pinned in generated/FIXTURE-GEN-PINS.json; each pin must equal
BOTH the file's actual sha256 AND the value in root's own review-r1 manifests (out/GENERATED.json, generated/BUILD-PINS.json,
generated/HARNESS-INPUTS.json), else this refuses. The page/flows/state/vendor SDK under test are NOT copied: the shell keeps
importing migration-cutover-site-review-r1/candidate (byte-unchanged; pinned again under "unchangedUnderTest").
Writes ONLY migration-cutover-fault-r2/{out,shell,build,page}/ (same layout) and refuses if any exists. Every edit is
labelled "migration-cutover-fault-r2"; reversing them must give back each pinned input exactly.

Closes three cutover gaps (TEST ONLY; no production terms, approval, relay, key or DB):
  (1) C4/C5/C6: the termination REPLY is lost after the real relay processed it (labelled one-shot fault on
      POST /v1/sessions/owner); the journal must hold a durable UNKNOWN (admitted, no txHash); a REAL reload; then the
      page's Check status proves the exact refund from the chain (canonical + final) and writes PAUSED - no resend,
      replacement, gas POST or prompt.
  (2) C8b/C9/C10: ONE labelled, bounded, one-shot TEST time advance (owned Anvil evm_increaseTime + the fixture server's
      clock + the page's Date.now from the next load, all by the same offset) puts the chain's ACTUAL latest timestamp past
      every remaining signBefore. While paused nothing is offered; after activation only "Prepare again" is offered; the
      three re-arms keep terms/termsHash/approval, the pause + termination evidence + activation record, the old legacy
      key and each gas part's key/record/finite scope/budget; a forced Send admits nothing; only fresh signatures (6) send.
  (3) C8c/C9/pComplete: a PEER tab (same origin, same random TEST databases, BroadcastChannel, four whitelisted page
      clicks) races the primary: both click Record activation at one instant (exactly one records), and both sign metal
      and click Send at one instant (exactly one admission, exactly one /funding/open POST).
Everything else (owned Anvil 8453/osaka/native P-256, public Anvil keys, mock USDC, ONE TxQueue, dropped first gas-open
reply, execute faults, intake-off, pre-API 404, CSP, loopback Host pin, prompt cap 24, tick cap 250, maxSeconds <= 1800,
owned-PID cleanup) is the qualified review-r1 fixture byte for byte.
"""
from pathlib import Path
import hashlib
import json
import re
import sys

HERE = Path(__file__).resolve().parent.parent           # migration-cutover-fault-r2
UF = HERE.parent                                        # unified-funding-20261028
M = "migration-cutover-fault-r2"
B = "migration-cutover-site-review-r1"
FACADES = ["api.js", "wallet.js", "empty.js", "sessions.js", "vendor-funding.js", "config.js"]
COPIES = {f"{B}/shell/facade/{f}": f"shell/facade/{f}" for f in FACADES}
COPIES[f"{B}/shell/harness-state.js"] = "shell/harness-state.js"
INPUTS = [f"{B}/out/server.mjs", f"{B}/shell/main.mjs", f"{B}/build/build-harness.mjs", f"{B}/page/index.html", *COPIES]
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


# =====================================================================================================================
# out/server.mjs
# =====================================================================================================================
SERVER_ROUTES = r'''  if (p === "/test/fixture/owner-reply-fault") {   // migration-cutover-fault-r2: arm ONE lost reply for the next POST /v1/sessions/owner
    if (body.mode !== "body") return send(res, 400, { error: "mode must be body" });
    if (ownerReplyFaultUsed) return send(res, 409, { error: "the owner reply fault is one-shot per run" });
    ownerReplyFault = "body"; ownerReplyFaultUsed = true;
    console.log("harness: TEST owner (terminate) reply fault armed: body");
    return send(res, 200, { armed: ownerReplyFault });
  }
  if (p === "/test/fixture/advance-time") {   // migration-cutover-fault-r2: ONE bounded TEST time advance (owned Anvil + this process)
    const s = body.seconds;
    if (!Number.isInteger(s) || s < MIN_ADVANCE_S || s > MAX_ADVANCE_S) return send(res, 400, { error: `seconds must be an integer ${MIN_ADVANCE_S}..${MAX_ADVANCE_S}` });
    if (clockAdvanceS !== 0) return send(res, 409, { error: "the TEST time advance is one-shot per run" });
    const pool = await rawRpc(rpc, "txpool_status");
    if (BigInt(pool.pending) !== 0n || BigInt(pool.queued) !== 0n) return send(res, 409, { error: "transactions in flight on the owned anvil; not advancing" });
    const b0 = await rawRpc(rpc, "eth_getBlockByNumber", ["latest", false]);
    await rawRpc(rpc, "evm_increaseTime", [`0x${s.toString(16)}`]);
    await rawRpc(rpc, "evm_mine");
    const b1 = await rawRpc(rpc, "eth_getBlockByNumber", ["latest", false]);
    if (BigInt(b1.timestamp) < BigInt(b0.timestamp) + BigInt(s)) return send(res, 500, { error: "the owned anvil did not advance its time" });
    clockAdvanceS = s;
    counters.clockAdvanceS = s;
    counters.advance = { seconds: s, before: { number: b0.number, timestamp: b0.timestamp }, after: { number: b1.number, timestamp: b1.timestamp } };
    console.log(`harness: TEST time advance ${s}s: owned anvil ${BigInt(b0.timestamp)} -> ${BigInt(b1.timestamp)}; this process's clock follows`);
    return send(res, 200, { seconds: s, ...counters.advance });
  }
'''
SERVER_OWNER_FAULT = r'''    if (k === "POST /v1/sessions/owner" && ownerReplyFault) {   // migration-cutover-fault-r2 labelled fault: REAL processing, reply lost after headers
      ownerReplyFault = null;
      const begin = res.writeHead.bind(res), part = res.write.bind(res);
      res.writeHead = () => res; res.setHeader = () => res; res.write = () => true;
      res.end = () => {
        counters.ownerReplyFaults.push("body");
        begin(200, { ...HEADERS, "content-type": "application/json", "content-length": "1024" });
        res.flushHeaders(); part('{"txHash":');
        setTimeout(() => req.socket.destroy(), 100);
        return res;
      };
    }
'''
SERVER_EDITS = [
    before('// DERIVED by migration-cutover-site-review-r1/fixture/generate_fixture.py from production-grant-terms-r1/out/server.mjs (pinned). Lines marked "migration-cutover-site-review-r1" are the\n',
           "// DERIVED by " + M + "/fixture/generate_fixture.py from " + B + "/out/server.mjs (pinned). Lines marked \"" + M + "\" are the only\n"
           "// changes: a one-shot lost reply of POST /v1/sessions/owner AFTER real processing, and ONE bounded one-shot TEST time\n"
           "// advance of the owned anvil and this process's clock (the intake manifest notAfter is widened by that bound). TEST ONLY.\n"),
    sub('owned.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-cutover-site-review-r1-"));',
        'owned.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "' + M + '-"));'),
    after("const MAX_BODY = 64 * 1024;\n",
          "const MIN_ADVANCE_S = 60, MAX_ADVANCE_S = 1200;" + T + ": bounds of the ONE labelled TEST time advance\n"
          "let clockAdvanceS = 0;" + T + ": 0 until POST /test/fixture/advance-time\n"
          "const realNow = Date.now.bind(Date);" + T + "\n"
          "Date.now = () => realNow() + clockAdvanceS * 1000;" + T + ": the composed relay host's clock follows the owned chain\n"),
    sub('const manifest = { schema: "enclave-funding-activation-r1", chainId: 8453, notAfter: unix() + maxSeconds + 600, maxBlockAgeSec: 600, addresses,\n',
        'const manifest = { schema: "enclave-funding-activation-r1", chainId: 8453, notAfter: unix() + maxSeconds + 600 + MAX_ADVANCE_S, maxBlockAgeSec: 600, addresses,' + T + ": + the bounded advance\n"),
    sub("  fundingApiAbsent: false, fundingApiAbsentReplies: 0 };   // migration-cutover-site-review-r1\n",
        "  fundingApiAbsent: false, fundingApiAbsentReplies: 0,   // migration-cutover-site-review-r1\n"
        "  ownerReplyFaults: [], clockAdvanceS: 0, advance: null };" + T + "\n"),
    after('const PRE_FUNDING_API_404 = Object.freeze({ error: "no such sessions endpoint", code: "not_found" });   // migration-cutover-site-review-r1: the exact production reply\n',
          'let ownerReplyFault = null;' + T + ': labelled one-shot "body" for the NEXT POST /v1/sessions/owner reply\n'
          "let ownerReplyFaultUsed = false;" + T + "\n"),
    before('  if (p === "/test/fixture/funding-api") {   // migration-cutover-site-review-r1: labelled pre-funding-API fault switch\n', SERVER_ROUTES),
    before('    if (fundingApiAbsent && u.pathname.startsWith("/v1/sessions/funding/")) {   // migration-cutover-site-review-r1: the old relay has NO funding routes\n',
           SERVER_OWNER_FAULT),
]
SERVER_KEEP = ['"--chain-id", "8453", "--hardfork", "osaka"', "if (req.headers.host !== here)", "let dropFirstFundingOpen = true;",
               'owned.server.listen(port, "127.0.0.1"', "const MAX_PROMPTS = 24;", "const MAX_TICKS = 250;", 'if (p === "/test/fixture/execute-fault") {',
               'if (!Number.isInteger(maxSeconds) || maxSeconds < 30 || maxSeconds > 1800) fail("maxSeconds must be 30..1800");',
               'await write(usdc, "fiatUsdc", "mint", [owner, 1_000_000_000n]);                 // mock funds only',
               "const ETH_OUT = 200_000_000_000_000n;", '  split: { legacy6: "24000000", nucbox6: "4800000", nucboxOps: "16", metal6: "1200000", metalOps: "4" },',
               'if (fundingApiAbsent && u.pathname.startsWith("/v1/sessions/funding/"))']

# =====================================================================================================================
# shell/main.mjs
# =====================================================================================================================
INFRA = r'''// =====================================================================================================================
// migration-cutover-fault-r2: labelled TEST additions (UNREVIEWED, NOT RUN). (a) ONE time advance: after
// POST /test/fixture/advance-time the owned Anvil, the fixture server and (from the next load) this page's Date.now run the
// same bounded offset ahead, so every window is judged on one consistent clock and expiry is guarded on the chain's own
// latest timestamp. (b) A PEER tab (same origin, same random TEST databases, opened in C8c) that acts ONLY on whitelisted
// harness messages over a same-origin BroadcastChannel: remount, click one of four page buttons, close. (c) A cumulative
// phase history kept in sessionStorage across reloads. No wallet discovery, no other origin, no other database.
// =====================================================================================================================
const PEER = location.hash === "#peer";
const PEER_CLICKS = new Set(["#fdActivate", "#fdRec", "#fdSign", "#fdRun"]);
const chan = new BroadcastChannel("migration-cutover-fault-r2-peer");
let clockOffsetMs = 0;
function applyTestClock(sec) {
  if (sec === 0) return;
  if (!Number.isInteger(sec) || sec < 60 || sec > 1200 || clockOffsetMs !== 0) throw new Error(`TEST clock advance ${sec} refused`);
  const real = Date.now.bind(Date);
  clockOffsetMs = sec * 1000;
  Date.now = () => real() + clockOffsetMs;
  $("hclock").textContent = `TEST clock: +${sec}s (owned Anvil, fixture server and this page; ONE labelled time advance, TEST ONLY)`;
}
function renderHistory(st) {
  const el = $("hhistory");
  el.textContent = "";
  for (const h of st?.history ?? []) {
    const li = document.createElement("li");
    li.dataset.result = h.result;
    li.textContent = `${h.result}  ${h.from ?? "start"} -> ${h.next ?? "(stopped)"}: ${h.msg}`;
    el.appendChild(li);
  }
}
function failed(p, e) {
  const st = H.load() || {};
  return { ...st, last: { result: "FAIL", msg: e?.message }, history: [...(st.history ?? []), { result: "FAIL", from: st.phase ?? null, next: null, msg: `${p.id}: ${e?.message ?? e}` }] };
}
let peerSeq = 0, handoverSt = null, peerReady = null, peerBusy = false;
const peerWait = new Map();
chan.onmessage = (ev) => {
  const m = ev.data;
  if (PEER) { if (m?.to === "peer") onPeerCommand(m); return; }
  if (m?.to !== "primary") return;
  if (m.hello) { if (handoverSt) chan.postMessage({ to: "peer", cmd: "handover", st: handoverSt }); return; }
  if (m.ready) { peerReady = { legacyDb: m.legacyDb, v2Db: m.v2Db }; return; }
  const w = peerWait.get(m.id);
  if (!w) return;
  peerWait.delete(m.id);
  if (m.ok) w.ok(m.out); else w.bad(new Error(`peer: ${m.error}`));
};
/** Primary -> peer: one whitelisted command, bounded wait for its answer. */
function peer(cmd, extra = {}, ms = WAIT_MS) {
  const id = ++peerSeq;
  return new Promise((ok, bad) => {
    const t = setTimeout(() => { peerWait.delete(id); bad(new Error(`peer ${cmd}: no answer within ${ms / 1000}s`)); }, ms);
    peerWait.set(id, { ok: (v) => { clearTimeout(t); ok(v); }, bad: (e) => { clearTimeout(t); bad(e); } });
    chan.postMessage({ to: "peer", id, cmd, ...extra });
  });
}
const peerSnap = () => {
  const st = H.load();
  return { paused: shownPaused(), resumed: !!q('#fdMig [data-cutover="resumed"]'), activateDisabled: q("#fdActivate")?.disabled ?? null,
    signDisabled: q("#fdSign")?.disabled ?? null, runDisabled: q("#fdRun")?.disabled ?? null, legacyDb: st?.legacyDb ?? null, v2Db: st?.v2Db ?? null };
};
async function onPeerCommand(m) {
  if (m.cmd === "handover") {
    if (!H.load() && typeof m.st?.legacyDb === "string" && typeof m.st?.v2Db === "string") { H.save(m.st); location.reload(); }
    return;
  }
  const reply = (o) => chan.postMessage({ to: "primary", id: m.id, ...o });
  if (!fx || peerBusy) return reply({ ok: false, error: fx ? "busy" : "not booted" });
  peerBusy = true;
  try {
    if (m.cmd === "remount") { walletState(fx.owner, 8453); await settled(); return reply({ ok: true, out: peerSnap() }); }
    if (m.cmd === "click") {
      if (!PEER_CLICKS.has(m.sel)) throw new Error(`peer refuses ${m.sel}`);
      const wait = Number(m.at) - Date.now();
      if (!(wait <= 5000)) throw new Error("peer: barrier too far ahead");
      await sleep(Math.max(0, wait));
      const n = toasts.length;
      await clickPage(m.sel);
      const t = await waitFor(() => toasts.slice(n)[0], `peer ${m.sel} result`);
      await settled();
      return reply({ ok: true, out: t });
    }
    if (m.cmd === "close") { reply({ ok: true, out: "closing" }); setTimeout(() => window.close(), 200); return undefined; }
    throw new Error(`peer refuses command ${m.cmd}`);
  } catch (e) {
    return reply({ ok: false, error: `${e?.code ? `${e.code}: ` : ""}${e?.message ?? e}` });
  } finally { peerBusy = false; }
}
async function peerHandover() {
  setStatus("PEER", "waiting for this run's TEST state from the primary tab (C8c)");
  for (let i = 0; i < 240; i += 1) { chan.postMessage({ to: "primary", hello: true }); await sleep(500); }
  throw new Error("peer: no handover from the primary tab within 120s");
}
/** Both tabs click the same page button at one shared instant; returns [primary toast, peer toast]. */
async function raceClick(sel) {
  const at = Date.now() + 1500;
  const theirs = peer("click", { sel, at });
  await sleep(Math.max(0, at - Date.now()));
  const n = toasts.length;
  await clickPage(sel);
  const mine = await waitFor(() => toasts.slice(n)[0], `primary ${sel} result`);
  return [mine, await theirs];
}
const fixedGrant = (g) => JSON.stringify(Object.entries(g).filter(([k]) => k !== "grantNonce" && k !== "signBefore").sort(([a], [b]) => (a < b ? -1 : 1)));

'''

OLD_C4_C6 = r'''phase("cTerminate", "C4. Page: Sign the WHOLE plan (7 prompts), then Send: only the original ends, exact refund, paused", "cutApproved", async () => {
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
'''

NEW_C4_C6 = r'''phase("cTerminate", "C4. Page: Sign the WHOLE plan (7 prompts), then Send: the termination REPLY is LOST after real processing -> durable UNKNOWN", "cutApproved", async () => {   // migration-cutover-fault-r2
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
  await call("/test/fixture/owner-reply-fault", { mode: "body" });
  n = toasts.length;
  await clickPage("#fdRun");
  const t = await waitFor(() => toasts.slice(n)[0], "the send result");
  check(!/paused until|Migration complete/.test(t), `the page claims neither the pause nor success without a reply (${t})`);
  await settled();
  const s2 = await status();
  check(hitOf(s2, "POST /v1/sessions/owner") - hitOf(s0, "POST /v1/sessions/owner") === 1 && s2.ownerReplyFaults.length === 1
    && hitOf(s2, "POST /v1/sessions/open") === hitOf(s0, "POST /v1/sessions/open") && fundingPosts(s2) === fundingPosts(s0),
  "exactly one send (the termination), its reply LOST after real processing; no replacement, no gas POST");
  check(s2.prompts.length === s1.prompts.length, "no prompt after signing");
  const j = await planOf(st);
  const tm = j.steps.terminate;
  check(tm.status === "admitted" && !tm.txHash && !!tm.observed && !j.cutover, "journal (real IndexedDB): termination ADMITTED without a txHash = durable UNKNOWN; no pause marker");
  check(ORDER.slice(1).every((k) => j.steps[k].status === "planned"), "nothing after the termination admitted");
  const logs = await rpc("eth_getLogs", [{ address: fx.legacyVault, fromBlock: `0x${Number(tm.observed.block).toString(16)}`, toBlock: "latest" }]);
  const txs = [...new Set(logs.filter((l) => l.removed !== true).map((l) => lower(l.transactionHash)))];
  check(txs.length === 1 && /^0x[0-9a-f]{64}$/.test(txs[0]), "the owned chain shows exactly ONE original-vault transaction since admission (the really processed termination)");
  check(await usdcOf(fx, fx.owner) === BigInt(st.ownerStart) && await usdcOf(fx, fx.legacyVault) === 0n, "chain: the original really ended with the exact refund (the page cannot know yet)");
  check(text("#fdMig").includes("Outcome unknown") && !shownPaused() && q("#fdSign").disabled, "page: outcome unknown; NOT shown as paused; nothing to sign");
  check(localStorage.getItem(WALLET_SESSION_KEY) !== j.steps.legacyOpen.review.sid, "active pointer not moved to an unopened replacement");
  H.save({ ...H.load(), lostTerminateTx: txs[0] });
  advance("cutUnknown", "termination outcome UNKNOWN (reply lost after real processing); click C5 (real reload)");
});

phase("cReload", "C5. Real reload while the termination outcome is UNKNOWN", "cutUnknown", async () => { advance("cutReloaded", "reloading while the termination outcome is UNKNOWN", true); });   // migration-cutover-fault-r2

phase("cPausedCheck", "C6. After reload: still UNKNOWN (durable); page Check status proves the exact refund on chain -> PAUSED; no resend, sign or POST", "cutReloaded", async () => {   // migration-cutover-fault-r2
  const st = H.load();
  check(performance.getEntriesByType("navigation")[0]?.type === "reload", "this document was loaded by a reload");
  const j0 = await planOf(st);
  const t0 = j0.steps.terminate;
  check(t0.status === "admitted" && !t0.txHash && !!t0.observed && !j0.cutover, "after reload: the journal (real IndexedDB) still holds the termination ADMITTED/UNKNOWN; no pause yet");
  const s0 = await status();
  for (let i = 0; i < 4; i += 1) await tick();              // let the really mined termination become final before the check
  await fresh();
  check(text("#fdMig").includes("Outcome unknown") && !shownPaused() && q("#fdSign").disabled && q("#fdRun").disabled, "page after reload: outcome unknown, not paused; nothing to sign or send");
  check(text("#fdGas").includes("New gas funding is paused"), "gas: paused while the API is absent");
  const n = toasts.length;
  await clickPage("#fdRec");
  await waitToast(n, /^Status:/, "reconcile status");
  await settled();
  const j = await planOf(st);
  const tp = j.steps.terminate;
  check(tp.status === "proven" && tp.txHash === st.lostTerminateTx && tp.proof?.final === true,
    "termination proven from the chain: THE really processed transaction, canonical and final");
  check(j.cutover?.paused === true && j.cutover.terminate?.txHash === tp.txHash && j.cutover.terminate.blockHash === tp.proof.blockHash, "durable pause written with exactly that termination proof");
  await stillPaused(st, "everything after the termination is still planned");
  check(await usdcOf(fx, fx.owner) === BigInt(st.ownerStart) && await usdcOf(fx, fx.legacyVault) === 0n, "exact refund: owner back to its Start balance, original vault 0");
  const s1 = await status();
  check(s1.prompts.length === s0.prompts.length && JSON.stringify(posts(s1)) === JSON.stringify(posts(s0)), "no prompt, no POST: termination NOT resent; no replacement or gas send");
  check(shownPaused() && text("#fdMig").includes("$30.00 returned to your wallet") && q("#fdSign").disabled && q("#fdRun").disabled, "page: Paused, $30.00 returned; Sign and Send disabled");
  check(q("#fdActivate")?.disabled === true && text("#fdMig").includes("Waiting for the reviewed activation record"), "no record: Record activation disabled");
  check(localStorage.getItem(WALLET_SESSION_KEY) !== j.steps.legacyOpen.review.sid, "active pointer not moved to an unopened replacement");
  H.save({ ...H.load(), activation: await activationOf(st, { terminateTxHash: `0x${"ab".repeat(32)}` }) });
  advance("cutBadAct", "UNKNOWN resolved to PAUSED from the chain; a MISMATCHED TEST activation record is configured for the next load", true);
});
'''

OLD_C9_C10 = r'''phase("cActivate", "C9. Page Record activation: an ACCOUNT switch during the fresh check stops it; then it records (no send)", "cutApiLive", async () => {
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
'''

NEW_C8B_C10 = r'''phase("cWait", "C8b. Activation wait: ONE labelled TEST time advance (owned Anvil + fixture server + page clock) past every remaining signing window (reloads)", "cutApiLive", async () => {   // migration-cutover-fault-r2
  const st = H.load();
  const j = await planOf(st);
  check(j.cutover?.paused === true && !j.cutover.resumed, "still paused before the wait");
  const windows = ORDER.slice(1).map((k) => BigInt(j.steps[k].review.grant.signBefore));
  const maxW = windows.reduce((a, b) => (a > b ? a : b));
  const before = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  const seconds = Math.max(60, Number(maxW - before) + 60);
  const s0 = await status();
  check(s0.clockAdvanceS === 0 && seconds <= 1200, `one bounded advance of ${seconds}s (<= 1200s; none earlier in this run)`);
  const r = await call("/test/fixture/advance-time", { seconds });
  const after = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  check(r.seconds === seconds && after >= before + BigInt(seconds), `owned Anvil latest block timestamp moved ${after - before}s (>= ${seconds}s)`);
  check(windows.every((w) => after > w), "guard: the owned chain's ACTUAL latest timestamp is past every remaining step's signBefore");
  const s1 = await status();
  check(s1.prompts.length === s0.prompts.length && JSON.stringify(posts(s1)) === JSON.stringify(posts(s0)) && s1.clockAdvanceS === seconds, "no prompt, no POST; the server reports the same advance");
  H.save({ ...H.load(), advanced: { seconds, chainTimestamp: after.toString() } });
  advance("cutWaited", `TEST time advanced ${seconds}s; reloading so the page clock follows`, true);
});

phase("cPeer", "C8c. Open the PEER tab (second same-origin page on this run's TEST databases; acts only on harness messages)", "cutWaited", async () => {   // migration-cutover-fault-r2
  const st = H.load();
  check(clockOffsetMs === st.advanced.seconds * 1000, "this page booted on the advanced TEST clock");
  handoverSt = { ...st };
  peerReady = null;
  const w = window.open(`${location.pathname}#peer`, "migration-cutover-fault-r2-peer", "popup,width=1000,height=800");
  log(w ? "    peer window opened by the harness" : `    popup blocked: open ${origin}/#peer in a second window of THIS browser now`);
  try { await waitFor(() => peerReady, "the peer tab to load this run's TEST state"); } finally { handoverSt = null; }
  check(peerReady.legacyDb === st.legacyDb && peerReady.v2Db === st.v2Db, "the peer uses exactly this run's random TEST databases (no other database)");
  const p = await peer("remount");
  check(p.paused && p.activateDisabled === false && p.signDisabled === true, "peer page: the same plan, paused, Record activation enabled, nothing to sign");
  advance("cutPeer", "peer tab ready; click C9");
});

phase("cActivate", "C9. Expired + paused offers nothing; ACCOUNT switch stops Record activation; then BOTH tabs click it at one instant: exactly one records", "cutPeer", async () => {   // migration-cutover-fault-r2
  const st = H.load();
  for (let i = 0; i < 4; i += 1) await tick();              // the termination must be final for the record
  await fresh();
  check(!q('#fdMig [data-funding-api="absent"]') && shownPaused() && !q("#fdActivate").disabled, "API live; still paused; Record activation enabled");
  check(text("#fdMig").includes("its signing window has passed") && !q("[data-rearm]") && q("#fdSign").disabled && q("#fdRun").disabled,
    "remaining reviews expired, yet while paused nothing is offered: no Prepare again, no Sign, no Send");
  const s0 = await status();
  H.armRpc(async () => { log("    (hold) switching the account before the fresh check's first chain read"); walletState(OTHER, 8453); });
  const n = toasts.length;
  await clickPage("#fdActivate");
  await waitToast(n, /context_changed/, "cancelled by the switch");
  await settled();
  await sleep(1500);
  await stillPaused(st, "switch: nothing recorded");
  await fresh();
  const p0 = await peer("remount");
  check(p0.paused && p0.activateDisabled === false, "peer: paused, Record activation enabled");
  const [mine, theirs] = await raceClick("#fdActivate");
  log(`    primary: ${mine}\n    peer:    ${theirs}`);
  check([mine, theirs].filter((x) => /Activation recorded/.test(x)).length === 1, "exactly ONE of the two tabs recorded the activation (IndexedDB compare-and-set)");
  await fresh();
  const j = await planOf(st);
  check(j.cutover?.paused === true && j.cutover.resumed?.terminateTxHash === j.steps.terminate.txHash && j.cutover.resumed.runtimeBlock > Number(j.steps.terminate.proof.block),
    "activation recorded against a runtime verified after the termination; the pause record is kept");
  check(ORDER.slice(1).every((k) => j.steps[k].status === "planned"), "recording sent nothing; every remaining step still planned");
  const s1 = await status();
  check(s1.prompts.length === s0.prompts.length && JSON.stringify(posts(s1)) === JSON.stringify(posts(s0)), "no prompt, no POST, no automatic send (either tab)");
  check(!!q('#fdMig [data-cutover="resumed"]') && q("#fdSign").disabled && q("#fdRun").disabled && document.querySelectorAll("#fdBody [data-rearm]").length === 3,
    "page: resumed; the 3 expired remaining steps offer only Prepare again, no Sign");
  advance("cutActivated", "activation recorded exactly once; click C10");
});

phase("cResign", "C10. Prepare again x3 keeps terms/pause/evidence/keys/scopes; nothing admits without fresh signatures; Sign (6), Send (first gas reply LOST)", "cutActivated", async () => {   // migration-cutover-fault-r2
  const st = H.load();
  await fresh();
  const s0 = await status();
  const j0 = await planOf(st);
  const keysOf = async () => (await (await v2()).listKeys()).map((r) => `${r.id}:${lower(r.keyHash)}`).sort().join();
  const keys0 = await keysOf();
  const chainTs = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  check(ORDER.slice(1).every((k) => BigInt(j0.steps[k].review.grant.signBefore) < chainTs), "guard: the owned chain's latest timestamp is past every remaining signBefore");
  for (const k of ORDER.slice(1)) {
    const nk = toasts.length;
    await clickPage(`[data-rearm="${k}"]`);
    await waitToast(nk, /Prepared again/, `${k} prepared again`);
    await settled();
  }
  const j1 = await planOf(st);
  check(j1.termsHash === j0.termsHash && F.hashOf(j1.terms) === j0.termsHash && JSON.stringify(j1.terms) === JSON.stringify(j0.terms), "terms and termsHash unchanged (the same TEST approval applies)");
  check(JSON.stringify(j1.cutover) === JSON.stringify(j0.cutover), "pause marker, termination evidence and activation record unchanged");
  check(JSON.stringify(j1.steps.terminate) === JSON.stringify(j0.steps.terminate), "the proven termination (txHash, block, blockHash, final) unchanged");
  for (const k of ORDER.slice(1)) {
    const a = j0.steps[k], b = j1.steps[k];
    const last = b.history.at(-1);
    check(b.status === "planned" && b.attempt === a.attempt + 1 && b.review.digest !== a.review.digest && last?.digest === a.review.digest
      && last?.status === "planned" && last?.txHash === null, `${k}: re-armed (new digest), the old review kept in history, never sent`);
    check(BigInt(b.review.grant.signBefore) > chainTs, `${k}: a fresh signing window beyond the chain time`);
    check(fixedGrant(b.review.grant) === fixedGrant(a.review.grant), `${k}: every grant field except nonce and window unchanged (key, scope, budget, caps, expiry)`);
  }
  check(lower(j1.steps.legacyOpen.review.grant.sessionKey) === st.oldKeyHash && JSON.stringify(j1.steps.legacyOpen.review.grant.apps) === '["*"]',
    "replacement: the SAME old key and the original's explicit wildcard");
  check(["gasOpen:nucbox", "gasOpen:metal"].every((k) => j1.steps[k].review.keyHash === j0.steps[k].review.keyHash && j1.steps[k].review.recordId === j0.steps[k].review.recordId
    && !JSON.stringify(j1.steps[k].review.grant).includes('"*"')), "gas parts: the same fresh key and record each, finite scope (no wildcard)");
  check(await keysOf() === keys0, "the same two gas key records (no key minted or lost)");
  const s1 = await status();
  check(s1.prompts.length === s0.prompts.length && JSON.stringify(posts(s1)) === JSON.stringify(posts(s0)), "Prepare again: no prompt, no POST");
  check(q("#fdRun").disabled && !q("#fdSign").disabled && /\(3 steps\)/.test(text("#fdSign")), "page: Send disabled (nothing held); Sign next (3 steps)");
  const forced = q("#fdRun");
  forced.disabled = false;                       // a forced click on the disabled Send: the page must still admit nothing
  const nf = toasts.length;
  forced.click();
  log(`    forced Send: ${await waitFor(() => toasts.slice(nf)[0], "the forced Send result", 30_000)}`);
  await settled();
  const jf = await planOf(st);
  check(ORDER.slice(1).every((k) => jf.steps[k].status === "planned" && jf.steps[k].review.digest === j1.steps[k].review.digest), "forced Send without fresh signatures: nothing admitted");
  const sf = await status();
  check(sf.prompts.length === s0.prompts.length && JSON.stringify(posts(sf)) === JSON.stringify(posts(s0)), "forced Send: no prompt, no POST");
  await fresh();
  const s2 = await status();
  let n = toasts.length;
'''

OLD_C10_TAIL = r'''  check(JSON.stringify(s1.prompts.slice(s0.prompts.length).map((p) => p.primaryType)) === JSON.stringify(["SessionGrant", "ReceiveWithAuthorization",
    "SessionGrant", "ReceiveWithAuthorization", "SessionGrant", "ReceiveWithAuthorization"]), "6 prompts: replacement + both gas parts");
'''
NEW_C10_TAIL = r'''  check(JSON.stringify((await status()).prompts.slice(s2.prompts.length).map((p) => p.primaryType)) === JSON.stringify(["SessionGrant", "ReceiveWithAuthorization",
    "SessionGrant", "ReceiveWithAuthorization", "SessionGrant", "ReceiveWithAuthorization"]), "6 FRESH prompts for the re-armed reviews: replacement + both gas parts");   // migration-cutover-fault-r2
'''
OLD_C10_SENDCHECK = r'''  check(hitOf(s2, "POST /v1/sessions/open") - hitOf(s0, "POST /v1/sessions/open") === 1 && hitOf(s2, "POST /v1/sessions/funding/open") - hitOf(s0, "POST /v1/sessions/funding/open") === 1
    && s2.dropped.length === 1, "one replacement open, one gas open (its reply dropped by the fixture)");
'''
NEW_C10_SENDCHECK = r'''  const s3 = await status();   // migration-cutover-fault-r2
  check(hitOf(s3, "POST /v1/sessions/open") - hitOf(s0, "POST /v1/sessions/open") === 1 && hitOf(s3, "POST /v1/sessions/funding/open") - hitOf(s0, "POST /v1/sessions/funding/open") === 1
    && s3.dropped.length === 1, "one replacement open, one gas open (its reply dropped by the fixture)");   // migration-cutover-fault-r2
'''

OLD_PCOMPLETE = r'''phase("pComplete", "7. Page buttons: Sign metal again + Send -> complete; conservation, same-key API, finite grants", "switched2", async () => {
  const st = H.load();
  await fresh();
  let n = toasts.length;
  await clickPage("#fdSign");
  await waitToast(n, /Signed 1 step/, "signed");
  await settled();
  n = toasts.length;
  await clickPage("#fdRun");
  await waitToast(n, /Migration complete/, "complete");
  await settled();
  const s = await status();
  check(s.prompts.length === 19, "19 owner prompts in total (2 original + 7 whole plan + 6 after activation + 2 dropped bundle + 2)");   // migration-cutover-site-review-r1
'''
NEW_PCOMPLETE = r'''phase("pComplete", "7. BOTH tabs sign metal, then Send at one instant: exactly one admission/send -> complete; conservation, same-key API, finite grants", "switched2", async () => {   // migration-cutover-fault-r2
  const st = H.load();
  await fresh();
  const s0 = await status();
  const m0 = (await planOf(st)).steps["gasOpen:metal"];
  const n = toasts.length;
  await clickPage("#fdSign");
  await waitToast(n, /Signed 1 step/, "signed");
  await settled();
  const p0 = await peer("remount");
  check(p0.signDisabled === false && p0.runDisabled === true, "peer: Sign next enabled for the same metal step; nothing held");
  const ps = await peer("click", { sel: "#fdSign", at: Date.now() + 200 });
  check(/Signed 1 step/.test(ps), `peer signed the same metal review (${ps})`);
  const [mine, theirs] = await raceClick("#fdRun");
  log(`    primary: ${mine}\n    peer:    ${theirs}`);
  check([mine, theirs].some((x) => /Migration complete/.test(x)), "the race completed the migration in at least one tab");
  await fresh();
  const m1 = (await planOf(st)).steps["gasOpen:metal"];
  check(m1.status === "proven" && m1.attempt === m0.attempt && m1.review.digest === m0.review.digest && m1.history.length === m0.history.length,
    "metal: ONE admission of the same review (real IndexedDB compare-and-set); no re-arm");
  const s = await status();
  check(hitOf(s, "POST /v1/sessions/funding/open") - hitOf(s0, "POST /v1/sessions/funding/open") === 1, "exactly ONE gas open POST for the two racing tabs (no duplicate send)");
  check(s.prompts.length === 21, "21 owner prompts in total (2 original + 7 whole plan + 6 after re-arm + 2 dropped bundle + 2 + 2 peer)");
  log(`    peer close: ${await peer("close", {}, 10_000).catch((e) => e.message)}`);
'''

OLD_BOOT_HEAD = '''  fx = await call("/test/fixture/config");
  const st = H.load();
'''
NEW_BOOT_HEAD = '''  fx = await call("/test/fixture/config");
  applyTestClock((await status()).clockAdvanceS);''' + T + ''': before the page module evaluates
  const st = H.load();
  if (PEER && !st) await peerHandover();''' + T + ''': reloads on handover, else throws after 120s
'''
OLD_BOOT_TAIL = '''  setStatus(st?.last?.result ?? "IDLE", st?.last?.msg ?? "click TEST Start");
'''
NEW_BOOT_TAIL = '''  if (PEER) {''' + T + '''
    setStatus("PEER", "TEST peer tab: same origin, same TEST databases; it acts ONLY on the primary tab's harness messages");
    chan.postMessage({ to: "primary", ready: true, legacyDb: st.legacyDb, v2Db: st.v2Db });
  } else setStatus(st?.last?.result ?? "IDLE", st?.last?.msg ?? "click TEST Start");
'''

MAIN_EDITS = [
    before('// DERIVED by migration-cutover-site-review-r1/fixture/generate_fixture.py from production-grant-terms-r1/shell/main.mjs (pinned). Lines marked "migration-cutover-site-review-r1" are the only\n',
           "// DERIVED by " + M + "/fixture/generate_fixture.py from " + B + "/shell/main.mjs (pinned). Lines marked \"" + M + "\" are the only\n"
           "// changes: C4-C6 lose the termination reply (durable UNKNOWN -> reload -> chain proof -> PAUSED), C8b advances TEST time past\n"
           "// every remaining window, C8c opens a same-origin PEER tab that races C9 (activation) and phase 7 (admission), C10 re-arms.\n"),
    sub('  for (const p of PHASES) $(p.id).disabled = busy || !fx || !(p.need === "*" || (p.need === null ? !st : st?.phase === p.need));\n',
        '  for (const p of PHASES) $(p.id).disabled = PEER || busy || !fx || !(p.need === "*" || (p.need === null ? !st : st?.phase === p.need));' + T + ": a peer tab never runs phases\n"),
    after('  $("hdbs").textContent = st?.legacyDb ? `TEST databases: ${st.legacyDb}, ${st.v2Db}` : "no TEST databases yet";\n',
          "  renderHistory(st);" + T + "\n"),
    sub('  H.save({ ...H.load(), phase: next, last: { result: "PASS", msg } });\n',
        "  const prev = H.load();" + T + ": the cumulative pass history survives reloads\n"
        '  H.save({ ...prev, phase: next, last: { result: "PASS", msg }, history: [...(prev?.history ?? []), { result: "PASS", from: prev?.phase ?? null, next, msg }] });\n'),
    before('const CUT_DOCS = ["TEST activation plan (migration-cutover-site-r1 fixture; not a production document)",\n', INFRA),
    sub(OLD_C4_C6, NEW_C4_C6),
    sub('  advance("cutApiLive", "TEST successor API now answers; click C9");\n',
        '  advance("cutApiLive", "TEST successor API now answers; click C8b");' + T + "\n"),
    sub(OLD_C9_C10, NEW_C8B_C10),
    sub(OLD_C10_TAIL, NEW_C10_TAIL),
    sub(OLD_C10_SENDCHECK, NEW_C10_SENDCHECK),
    sub(OLD_PCOMPLETE, NEW_PCOMPLETE),
    sub('H.save({ ...(H.load() || {}), last: { result: "FAIL", msg: e?.message } }); }\n',
        "H.save(failed(p, e)); }" + T + ": FAIL kept in the history\n"),
    sub(OLD_BOOT_HEAD, NEW_BOOT_HEAD),
    sub(OLD_BOOT_TAIL, NEW_BOOT_TAIL),
]
NEW_PHASES = ["cMode", "cPrepare", "cApprove", "cTerminate", "cReload", "cPausedCheck", "cBadAct", "cNoApi", "cWait", "cPeer", "cActivate", "cResign"]
KEPT_PHASES = ["pStart", "pReload", "pRecover", "pSwitch2", "pComplete", "pQuote", "pFund", "pExecFinal", "pExecLost", "pExecReload",
               "pExec502", "pExecSwitch", "pControls", "pNull", "pNullCheck", "pCleanup"]

BUILD_EDITS = [
    after("#!/usr/bin/env node\n",
          "// DERIVED by " + M + "/fixture/generate_fixture.py from " + B + "/build/build-harness.mjs (pinned): this line only. The page under\n"
          "// test stays " + B + "/candidate (byte-unchanged); only shell/ is this directory's.\n"),
]
PAGE_EDITS = [
    sub("<title>TEST ONLY - migration-cutover-site-review-r1 /funding reviewed cutover (pause after the original ends) page harness</title>",
        "<title>TEST ONLY - " + M + " /funding cutover fault fixture (lost termination reply, expiry re-arm, two-tab races)</title>"),
    sub('''<h1>TEST ONLY: generated /funding recovery page copy on an owned fixture (production-grant-terms-r1, gas candidate gas-recovery-6usdc-r1)</h1>
<p><strong>Owned loopback Anvil (chain id 8453, NOT Base). Public Anvil fixture keys, mock USDC, TEST terms only (NEW gas candidate gas-recovery-6usdc-r1: 24 legacy / 4.8 nucbox / 1.2 metal).</strong>
Owner signatures come from a server-side TEST fixture signer, not a wallet; no wallet or extension is used.
The page is the client-execution-site-r2 generated copy of the r2 page (recovery section added); its flows and state are the client-site-repair-r2 files, unmodified; site modules around them are TEST facades.</p>
''',
        '''<h1>TEST ONLY: ''' + M + ''' cutover fault fixture on an owned chain</h1>
<p><strong>Owned loopback Anvil (chain id 8453, NOT Base). Public Anvil fixture keys, mock USDC, TEST terms, TEST approval and TEST activation records only (24 legacy / 4.8 nucbox / 1.2 metal). Nothing here is a production review or approval.</strong>
Owner signatures come from a server-side TEST fixture signer, not a wallet; no wallet or extension is used.
The page under test is the root-qualified ''' + B + ''' candidate (pages/funding.js, funding/flows.js, funding/state.js and the vendored funding client), byte-unchanged; site modules around it are TEST facades.
Labelled TEST faults: a lost termination reply, ONE bounded time advance, and a same-origin peer tab.</p>
'''),
    after('  <div id="hdbs"></div>\n', '  <div id="hclock">TEST clock: real time (no advance)</div>\n'),
    after('  <ol id="hstages"></ol>\n', '  <h3>Cumulative phase history (this run; survives reloads)</h3>\n  <ol id="hhistory"></ol>\n'),
]


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


def root_manifest_pins():
    """What root's own review-r1 manifests say about each input (the only source of the pins)."""
    gen = json.loads((UF / B / "out" / "GENERATED.json").read_text())["outputs"]
    out = {f"{B}/{rel}": h for rel, h in gen.items()}
    for rel, h in json.loads((UF / B / "generated" / "BUILD-PINS.json").read_text())["inputs"].items():
        if out.setdefault(rel, h) != h:
            die(f"root manifests disagree about {rel}")
    for rel, h in json.loads((UF / B / "generated" / "HARNESS-INPUTS.json").read_text())["files"].items():
        if out.setdefault(rel, h) != h:
            die(f"root manifests disagree about {rel}")
    return out


def main():
    if sys.argv[1:]:
        die("no arguments")
    pins = json.loads((HERE / "generated" / "FIXTURE-GEN-PINS.json").read_text())
    if set(pins["inputs"]) != set(INPUTS):
        die(f"FIXTURE-GEN-PINS.json must list exactly {sorted(INPUTS)}")
    root = root_manifest_pins()
    src = {}
    for group in ("inputs", "unchangedUnderTest"):
        for rel, want in pins[group].items():
            if not isinstance(want, str) or not re.fullmatch(r"[0-9a-f]{64}", want):
                die(f"{rel}: pin is not a sha256 (refusing)")
            if root.get(rel) != want:
                die(f"{rel}: pin {want} is not what root's review-r1 manifests record ({root.get(rel)})")
            b = (UF / rel).read_bytes()
            if sha(b) != want:
                die(f"{rel}: sha256 {sha(b)} != pinned {want} (refusing)")
            src[rel] = b
    if pins["unchangedUnderTest"][f"{B}/candidate/site/vendor/funding.js"] != "f23ba2d79661ade43ed484e186d0347b95756dbe70a9735c4b3152da653dd957":
        die("the vendored funding client must be the exact qualified f23ba2d7... build")
    for d in OUTDIRS:
        if (HERE / d).exists():
            die(f"{d}/ already exists; inspect or move it first (nothing is overwritten)")

    server = src[f"{B}/out/server.mjs"].decode("utf-8")
    if M in server:
        die(f"the source server already mentions {M}")
    new_server = apply(server, SERVER_EDITS, "server")
    if new_server.count(GUARD) != 1:
        die("the unchanged no-code-size-override refusal must remain exactly once")
    scanned = new_server.replace(GUARD, "")
    for bad in ("--code-size", "disable-code-size", "pkill", "killall", "process.kill(-", "mainnet", "base.org", "window.ethereum",
                "api.enclave.host", "https://", "evm_setNextBlockTimestamp", "anvil_setCode", "anvil_impersonate"):
        if bad in scanned:
            die(f"the derived server contains {bad!r}")
    for keep in SERVER_KEEP:
        if new_server.count(keep) != 1:
            die(f"the derived server must keep {keep!r} exactly once")
    if new_server.count('"evm_increaseTime"') != 1 or new_server.count("Date.now = ") != 1:
        die("exactly one time-advance call site and one clock offset are allowed")
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
    order = [new_main.index(f'phase("{ph}", ') for ph in NEW_PHASES]
    if order != sorted(order):
        die("the C phases must be defined in their click order")
    added = "".join(b for _, b in MAIN_EDITS)
    for bad in ("window.ethereum", "eth_requestAccounts", "exportKey(\"pkcs8\", back", "https://", "api.enclave.host", "deleteDatabase",
                "indexedDB.open", "localStorage.clear", "eval(", "new Function"):
        if bad in added:
            die(f"the added shell code contains {bad!r}")
    for same in ('"interrupted"', "indexedDB.deleteDatabase", "MAX_PROMPTS"):
        if new_main.count(same) != main_js.count(same):
            die(f"{same} must occur exactly as often as in the qualified shell")
    if new_main.count("const PEER_CLICKS = new Set([\"#fdActivate\", \"#fdRec\", \"#fdSign\", \"#fdRun\"]);") != 1:
        die("the peer click whitelist must be exactly the four page buttons")

    outputs = {
        "out/server.mjs": new_server.encode("utf-8"),
        "shell/main.mjs": new_main.encode("utf-8"),
        "build/build-harness.mjs": apply(src[f"{B}/build/build-harness.mjs"].decode("utf-8"), BUILD_EDITS, "build").encode("utf-8"),
        "page/index.html": apply(src[f"{B}/page/index.html"].decode("utf-8"), PAGE_EDITS, "page").encode("utf-8"),
    }
    for rel, t in COPIES.items():
        outputs[t] = src[rel]
    for p, b in outputs.items():
        f = HERE / p
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b)
    gen = {"schema": f"{M}-fixture-generated/v1", "testOnly": True, "inputs": pins["inputs"], "unchangedUnderTest": pins["unchangedUnderTest"],
           "outputs": {p: sha(b) for p, b in sorted(outputs.items())},
           "phases": {"order": ["pStart", *NEW_PHASES, "pReload", "pRecover", "pSwitch2", "pComplete", "pQuote", "pFund", "pExecFinal",
                                "pExecLost", "pExecReload", "pExec502", "pExecSwitch", "pControls", "pNull", "pNullCheck"],
                      "new": NEW_PHASES, "kept": KEPT_PHASES, "disabled": ["pPrepare (and so pApprove, pSwitch1, pSignSend)"]},
           "edits": {"server": len(SERVER_EDITS), "shell": len(MAIN_EDITS), "build": len(BUILD_EDITS), "page": len(PAGE_EDITS)},
           "rootMustStill": ["python3 " + M + "/run-build-r2.py (BUILD-PINS, bundle, HARNESS-INPUTS, node --check)"]}
    (HERE / "out" / "GENERATED.json").write_text(json.dumps(gen, indent=2) + "\n")
    print(json.dumps(gen, indent=2))


if __name__ == "__main__":
    main()
