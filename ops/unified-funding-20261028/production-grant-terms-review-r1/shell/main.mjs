// DERIVED by production-grant-terms-r1/fixture/generate_fixture.py from client-execution-site-r2/shell/main.mjs (pinned). Lines marked "production-grant-terms-r1"
// are the only changes: the TEST terms are the NEW candidate gas-recovery-6usdc-r1 split 24 / 4.8 / 1.2 and its exact literals.
// DERIVED by client-execution-site-r2/harness/generate_harness.py from client-site-browser-r1/shell/main.mjs (pinned): the page is now the GENERATED
// recovery page copy (client-execution-site-r2/candidate), pFund reads the successor journal, and phases 12-16 are added. Lines marked
// "client-execution-site-r2" are the only changes.
// client-site-browser-r1 TEST shell (UNREVIEWED, NOT RUN). Bundled with the UNMODIFIED /funding page by
// build/build-harness.mjs. TEST ONLY, one loopback origin served by out/server.mjs (derived from the qualified
// client-browser-migration-r1 fixture server).
//
// ACTUAL code under test: client-site-repair-r2 pages/funding.js + funding/flows.js + funding/state.js (byte-identical,
// module aliases only), source/site/js/core/util.js, the generated portable client funding.js (served as-is) and the
// vendored SDK bundle (served as-is), against the real composed relay / owned Anvil 8453 / native P-256 / one TxQueue.
// MOCKED SHELL: facade/api.js (Enclave object), facade/wallet.js, facade/sessions.js (sdk/sessionsConfig/relayRoot
// over the actual SDK), facade/config.js (fixture values), facade/vendor-funding.js (TEST DB name + RPC hold), the
// empty component modules, and this panel. Owner signatures: the server's TEST fixture signer (public Anvil key),
// reached through an EIP-1193-shaped object that answers only eth_signTypedData_v4. It is NOT a wallet.
//
// Every phase is ONE explicit click on a harness button; nothing runs before "TEST Start". Each phase drives the page's
// REAL buttons (element.click() on the page's own DOM) and then checks the fixture counters, the journal in real
// IndexedDB and the owned chain. Bounded: every wait has a timeout; prompts are capped server-side (24).
import { emit, on } from "../../../source/site/js/core/util.js";           // ACTUAL util.js (same module the page uses)
import { Enclave, WALLET_SESSION_KEY } from "./facade/api.js";
import { H, PREFIX } from "./harness-state.js";
import * as F from "/harness/vendor/funding.js";                            // ACTUAL generated portable client

const OTHER = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";              // public Anvil dev account 6 (never signs here)
const OLD_ACTIONS = ["deploy.create", "deploy.fund", "deploy.setAppRef", "deploy.setConfig", "deploy.setShares",
  "deploy.setMaxRate", "deploy.setActive", "deploy.refund", "api.status", "api.logs", "api.restart", "api.upload",
  "api.appAccess", "api.placement", "api.account"];                          // as client-browser-migration-r1 (root-run)
const OLD_BUDGET = 30_000_000n;
const ORDER = ["terminate", "legacyOpen", "gasOpen:nucbox", "gasOpen:metal"];
const WAIT_MS = 90_000;

const $ = (id) => document.getElementById(id);
const lower = (a) => String(a ?? "").toLowerCase();
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const origin = location.origin;
const rpcUrl = `${origin}/rpc`;
const rpc = F.jsonRpc(rpcUrl);                                               // the shell's own reads (actual, never held)

// ---- panel ----------------------------------------------------------------------------------------------------------
const logEl = $("hlog"), statusEl = $("hstatus"), stagesEl = $("hstages"), toastEl = $("htoasts");
const log = (m) => { logEl.textContent += `${m}\n`; };
const setStatus = (r, m) => { statusEl.dataset.result = r; statusEl.textContent = `${r}${m ? `: ${m}` : ""}`; };
const check = (cond, what) => { if (!cond) throw new Error(`assertion failed: ${what}`); log(`    ok  ${what}`); };
const toasts = [];
on("enclave:toast", (d) => { toasts.push(String(d.message)); toastEl.textContent = toasts.slice(-8).join("\n"); });
async function waitFor(pred, what, ms = WAIT_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out (${ms / 1000}s) waiting for ${what}`);
    await sleep(250);
  }
}
const waitToast = (since, re, what) => waitFor(() => toasts.slice(since).find((t) => re.test(t)), `toast ${what} (${re})`);
const q = (sel) => document.querySelector(`#fdBody ${sel}`);
const text = (sel) => q(sel)?.textContent ?? "";
async function settled() {
  const done = () => { const b = $("fdBody"); return !!b && !b.textContent.includes("Loading…") && !!b.querySelector("#fdControls, #fdConnect"); };
  await sleep(100);
  await waitFor(done, "the page to finish rendering");
  await sleep(500);
  await waitFor(done, "the page to finish rendering (stable)");
}
async function clickPage(sel) {
  const el = await waitFor(() => q(sel), `page element ${sel}`);
  if (el.disabled) throw new Error(`page button ${sel} is disabled`);
  el.click();
}

// ---- fixture calls (fixed same-origin paths only) -------------------------------------------------------------------
async function call(p, body) {
  const r = await fetch(p, body === undefined ? { method: "GET" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body, big) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { code: j.code ?? `http_${r.status}`, status: r.status });
  return j;
}
const status = () => call("/test/fixture/status");
const tick = () => call("/test/fixture/tick", {});
const usdcOf = (fx, a) => F.ethCall(rpc, fx.usdc, "balanceOf", [a]).then(BigInt);
const posts = (s) => Object.fromEntries(Object.entries(s.hits).filter(([k]) => k.startsWith("POST ")));
const v2 = () => new F.IndexedDbV2Store(H.dbName("v2", [F.V2_DB, F.LEGACY_DB]));
let S = null;
const sdkReal = async () => (S ??= await import("/harness/vendor/sessions.js"));       // ACTUAL SDK (shell's own use)
const legacyStore = async () => new (await sdkReal()).IndexedDbStore(H.dbName("legacy"));

/** TEST fixture signer (EIP-1193-shaped, eth_signTypedData_v4 only), with the shell's one-shot delayed answer. */
const fixtureProvider = Object.freeze({
  async request({ method, params }) {
    if (method !== "eth_signTypedData_v4") throw new Error(`the TEST fixture signer refuses ${method}`);
    const { sig } = await call("/test/owner-sign", { address: params[0], payload: params[1] });
    await H.afterSign();                     // a hold may switch the account/chain while this answer is "open"
    return sig;
  },
});
/** What site/js/core/wallet.js does on connect / accountsChanged / chainChanged: set Enclave, emit enclave:wallet. */
function walletState(address, chainId) {
  Object.assign(Enclave, { address, chainId, provider: address ? fixtureProvider : null, base: `${origin}/v1` });
  emit("enclave:wallet", { address });
}
/** Phase start: one empty block (the client refuses pinned blocks older than its limit), then a remount exactly as an
 *  enclave:wallet event does. Never used between a page Sign and its Send (a remount drops held signatures). */
async function fresh() {
  await tick();
  walletState(fx.owner, 8453);
  await settled();
}

// ---- TEST terms and proposal ----------------------------------------------------------------------------------------
const proposalOf = (f, oldSid) => ({ schema: "enclave-funding-migration-proposal-r1", chainId: 8453, owner: f.owner, oldSid,
  legacy6: f.split.legacy6, gas: [
    { name: "nucbox", budget6: f.split.nucbox6, opsPerPeriod: f.split.nucboxOps, appIds: [...f.partition.nucbox] },
    { name: "metal", budget6: f.split.metal6, opsPerPeriod: f.split.metalOps, appIds: [...f.partition.metal] }],
  deploymentIds: f.deployments.map((d) => d.id) });
/** The journaled plan must be EXACTLY the TEST terms (30 -> 24 / 4.8 / 1.2, finite 8 + 2, same key) and hash to its   (production-grant-terms-r1)
 *  termsHash, which must be the fingerprint the page displays. Only then may the harness TEST-approve it. */
function verifyTestTerms(plan, st) {
  const t = plan.terms;
  check(t.order.join() === ORDER.join(), `order ${ORDER.join(" -> ")}`);
  check(lower(t.owner) === lower(fx.owner) && Number(t.chainId) === 8453, "owner + chain 8453");
  check(t.legacy.oldSid === st.oldSid && t.legacy.oldBalance6 === "30000000" && t.legacy.keyHash === st.oldKeyHash, "original sid, exactly 30, same legacy key");
  check(JSON.stringify(t.legacy.grantTemplate.apps) === '["*"]', "replacement keeps the original's explicit wildcard (never widened)");
  check(t.split.legacy6 === "24000000" && t.split.gas6 === "6000000" && t.split.total6 === "30000000", "split 24 + 6 = 30");   // production-grant-terms-r1
  const parts = t.gas.parts.map((p) => [p.name, p.budget6, p.opsPerPeriod, [...p.appIds].sort().join()]);
  check(JSON.stringify(parts) === JSON.stringify([["nucbox", "4800000", "16", [...fx.partition.nucbox].sort().join()],   // production-grant-terms-r1
    ["metal", "1200000", "4", [...fx.partition.metal].sort().join()]]), "gas parts: nucbox 4.8 / 16 ops / 8 apps, metal 1.2 / 4 ops / 2 apps");
  check(!t.gas.parts.some((p) => p.appIds.includes("*")), "no gas wildcard");
  const NEW_CANDIDATE = { id: "gas-recovery-6usdc-r1", budget: "6000000", spendPerPeriod: "6000000", periodSeconds: "86400", opsPerPeriod: "20",
    maxFeePerOp: "80000", maxGasUsdcPerOp: "600000", maxUsdcPerEth6: "2500000000", maxEthPerOp: "200000000000000" };   // production-grant-terms-r1
  check(Object.entries(NEW_CANDIDATE).every(([k, v]) => t.gasCandidate?.[k] === v), "terms carry the exact NEW candidate literals");   // production-grant-terms-r1
  check(t.gas.parts.every((p) => p.grantTemplate.maxFeePerOp === "80000" && p.grantTemplate.maxGasUsdcPerOp === "600000"   // production-grant-terms-r1
    && p.grantTemplate.maxEthPerOp === "200000000000000" && p.grantTemplate.maxUsdcPerEth6 === "2500000000"
    && p.grantTemplate.spendPerPeriod === p.budget6 && p.grantTemplate.budget === p.budget6), "each part grant: the candidate caps, its own budget per period");
  check([...t.gas.deployments].sort().join() === fx.deployments.map((d) => d.id).sort().join(), "the ten fixture deployments");
  check(F.hashOf(t) === plan.termsHash, "termsHash = hash of the journaled terms");
  const shown = [...document.querySelectorAll("#fdMig code")].map((c) => c.textContent.trim()).filter((s) => /^0x[0-9a-f]{64}$/.test(s));
  check(shown.includes(plan.termsHash), "the page displays exactly this termsHash");
}
const planOf = async (st) => (await v2()).getJournal(`migration:${st.oldSid}`);

// ---- phases ---------------------------------------------------------------------------------------------------------
let fx = null;
let busy = false;
const PHASES = [];
function phase(id, label, need, fn) { PHASES.push({ id, label, need, fn }); }
function refresh() {
  const st = H.load();
  for (const p of PHASES) $(p.id).disabled = busy || !fx || !(p.need === "*" || (p.need === null ? !st : st?.phase === p.need));
  $("hphase").textContent = st ? `phase: ${st.phase}` : "phase: not started (click TEST Start)";
  $("hdbs").textContent = st?.legacyDb ? `TEST databases: ${st.legacyDb}, ${st.v2Db}` : "no TEST databases yet";
}
async function stage(name, fn) {
  const li = document.createElement("li");
  li.textContent = `${name} ...`; li.dataset.result = "RUNNING"; stagesEl.appendChild(li);
  log(`> ${name}`);
  try { const out = await fn(); li.textContent = `${name}: PASS`; li.dataset.result = "PASS"; return out; }
  catch (e) { li.textContent = `${name}: FAIL (${e?.code ? `${e.code}: ` : ""}${e?.message ?? e})`; li.dataset.result = "FAIL"; throw e; }
}
function advance(next, msg, reload = false) {
  H.save({ ...H.load(), phase: next, last: { result: "PASS", msg } });
  setStatus("PASS", msg);
  if (reload) { log("reloading (the page config changes only on load)"); location.reload(); }
}

phase("pStart", "TEST Start: random TEST DBs + ORIGINAL 30 USDC session (SDK, 2 fixture prompts)", null, async () => {
  const tag = () => hex(crypto.getRandomValues(new Uint8Array(8)));
  const st0 = { legacyDb: `${PREFIX}legacy-${tag()}`, v2Db: `${PREFIX}v2-${tag()}`, phase: "starting" };
  H.save(st0);
  H.dbName("legacy"); H.dbName("v2", [F.V2_DB, F.LEGACY_DB]);
  await call("/test/record-dbs", { names: [st0.legacyDb, st0.v2Db] });
  check((await status()).prompts.length === 0, "fresh fixture: no prompt yet");
  await tick();
  const Sx = await sdkReal();
  const ls = await legacyStore();
  const ownerStart = await usdcOf(fx, fx.owner);
  const out = await stage("original 30 USDC session opened like the site (actual SDK, real IndexedDB, explicit wildcard)", async () => {
    const { signer, record } = await Sx.newSessionKey(ls, { relay: origin, chainId: 8453, label: "client-site-browser-r1 TEST original", extractable: false });
    check(record.privateKey.extractable === false, "fresh legacy key is non-extractable");
    const t0 = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
    const grant = { label: "client-site-browser-r1 TEST original", preset: "browser", sessionKey: signer.keyHash, actions: OLD_ACTIONS,
      apps: ["*"], environments: ["staging", "prod"], budget: OLD_BUDGET, spendPerPeriod: 100_000_000n, periodSeconds: 86_400,
      opsPerPeriod: 1000, maxFeePerOp: 250_000n, maxAppFeePerHour: 0n, maxRatePerHour: 5_000_000n, expiresAt: t0 + 7n * 86_400n,
      measurement: `0x${"0".repeat(64)}`, grantNonce: `0x${hex(crypto.getRandomValues(new Uint8Array(32)))}`, signBefore: t0 + 900n };
    const usdcDom = await Sx.usdcDomain(Sx.chainClient(8453, rpcUrl), fx.usdc, 8453);
    const ownerSigner = { address: fx.owner, signTypedData: async (td) => (await call("/test/owner-sign", { address: fx.owner, payload: JSON.stringify(td, big) })).sig };
    await Sx.openSession({ relay: new Sx.RelayClient(origin), owner: ownerSigner, chainId: 8453, vault: fx.legacyVault, grant, usdc: usdcDom });
    const rec = await Sx.completeSession(ls, record, { vault: fx.legacyVault, owner: fx.owner, grant, rpc: rpcUrl });
    const back = await ls.load(lower(rec.id));
    check(back.privateKey instanceof CryptoKey && back.privateKey.extractable === false, "original record reloaded: non-extractable CryptoKey");
    let exported = false;
    try { await crypto.subtle.exportKey("pkcs8", back.privateKey); exported = true; } catch { /* refused, as required */ }
    check(!exported, "pkcs8 export refused");
    check(await usdcOf(fx, fx.owner) === ownerStart - OLD_BUDGET, "owner wallet down exactly 30 (mock USDC)");
    return { oldSid: lower(rec.id), oldKeyHash: lower(rec.keyHash) };
  });
  check((await status()).prompts.length === 2, "exactly 2 fixture prompts so far");
  H.save({ ...H.load(), ...out, ownerStart: ownerStart.toString(), connected: true });
  advance("original", "original open; the page now gets the TEST proposal for this sid", true);
});

phase("pPrepare", "1. Page button: Check original & prepare plan (no wallet)", "original", async () => {
  const st = H.load();
  await fresh();
  check(text("#fdMig").includes("proposed, not prepared") && text("#fdMig").includes("$24.00") && text("#fdMig").includes("$4.80")   // production-grant-terms-r1
    && text("#fdMig").includes("$1.20"), "page shows the proposed 24 / 4.80 / 1.20 split");
  const before = await status();
  const n = toasts.length;
  await clickPage("#fdPrepare");
  await waitToast(n, /Plan prepared/, "plan prepared");
  await settled();
  const plan = await planOf(st);
  await stage("journaled plan is exactly the TEST terms and is what the page displays", () => verifyTestTerms(plan, st));
  check(text("#fdMig").includes("Waiting for review") && q("#fdSign").disabled && q("#fdRun").disabled, "waiting for review: Sign and Send disabled");
  check(text("#fdMig").includes("$30.00") && text("#fdMig").includes("= the original, nothing added"), "page: total 30 = the original");
  const after = await status();
  check(after.prompts.length === before.prompts.length && JSON.stringify(posts(after)) === JSON.stringify(posts(before)), "no prompt, no POST");
  const keys = await (await v2()).listKeys();
  check(keys.length === 2 && keys.every((r) => r.privateKey.extractable === false && r.relay === origin), "two fresh non-extractable gas keys for THIS relay");
  advance("planned", "plan prepared and displayed; click TEST-approve");
});

phase("pApprove", "2. Harness: TEST-approve exactly the displayed TEST plan (reloads)", "planned", async () => {
  const st = H.load();
  await fresh();
  const plan = await planOf(st);
  await stage("re-check TEST terms before approving", () => verifyTestTerms(plan, st));
  const approval = { schema: "enclave-funding-migration-approval-r1", rootReviewed: true, termsHash: plan.termsHash, owner: fx.owner, chainId: 8453, oldSid: st.oldSid };
  log(`    TEST approval for termsHash ${plan.termsHash} (TEST terms only; never a production approval)`);
  H.save({ ...H.load(), approval });
  advance("approved", "TEST approval set for this exact plan", true);
});

phase("pSwitch1", "3. Page Sign with an ACCOUNT switch while the 2nd prompt is open (expect stop, nothing kept)", "approved", async () => {
  const st = H.load();
  await fresh();
  check(text("#fdMig").includes("Approved for exactly this plan.") && /\(4 steps\)/.test(text("#fdSign")) && !q("#fdSign").disabled, "approved; Sign next (4 steps) enabled");
  const before = await status();
  H.armSign(2, async () => { log("    (hold) switching the account to a public non-owner address while prompt 2 is open"); walletState(OTHER, 8453); });
  const n = toasts.length;
  await clickPage("#fdSign");
  await waitToast(n, /context_changed/, "cancelled by the switch");
  await settled();
  await sleep(1500);
  const after = await status();
  check(after.prompts.length - before.prompts.length === 2, "exactly 2 prompts: no prompt after the switch");
  check(JSON.stringify(posts(after)) === JSON.stringify(posts(before)), "no POST of any kind");
  check(text("#fdMig").includes("another wallet"), "the page now offers nothing to the other account");
  const plan = await planOf(st);
  check(ORDER.every((k) => plan.steps[k].status === "planned"), "journal untouched: all steps planned");
  await fresh();
  check(!q("#fdSign").disabled && q("#fdRun").disabled, "owner back: nothing held (Send disabled), Sign enabled again");
  advance("switched1", "account switch stopped the signing; nothing kept or sent");
});

phase("pSignSend", "4. Page buttons: Sign next (7 prompts), then Send (first gas reply is LOST)", "switched1", async () => {
  const st = H.load();
  await fresh();
  const before = await status();
  let n = toasts.length;
  await clickPage("#fdSign");
  await waitToast(n, /Signed 4 step/, "signed");
  await settled();
  const mid = await status();
  check(JSON.stringify(mid.prompts.slice(before.prompts.length).map((p) => p.primaryType)) === JSON.stringify(["Terminate",
    "SessionGrant", "ReceiveWithAuthorization", "SessionGrant", "ReceiveWithAuthorization", "SessionGrant", "ReceiveWithAuthorization"]),
  "7 prompts after the approval, in step order");
  check(!q("#fdRun").disabled, "Send signed steps enabled");
  n = toasts.length;
  await clickPage("#fdRun");
  await waitFor(() => toasts.length > n, "the send result");
  await settled();
  const j = await planOf(st);
  check(j.steps.terminate.status === "proven" && j.steps.legacyOpen.status === "proven", "terminate + replacement proven on chain");
  check(j.steps["gasOpen:nucbox"].status === "admitted" && !j.steps["gasOpen:nucbox"].txHash && j.steps["gasOpen:nucbox"].observed,
    "first gas open ADMITTED, no txHash: persisted intent, never resent");
  check(j.steps["gasOpen:metal"].status === "planned", "second gas part untouched");
  const s = await status();
  check((s.hits["POST /v1/sessions/funding/open"] ?? 0) === 1 && s.dropped.length === 1, "one gas open sent, its reply dropped (fixture fault)");
  check(localStorage.getItem(WALLET_SESSION_KEY) === j.steps.legacyOpen.review.sid, "the page moved the TEST active pointer to the replacement");
  check(text("#fdMig").includes("Outcome unknown") && q("#fdRun").disabled && q("#fdSign").disabled, "page: outcome unknown, only Check status offered");
  H.save({ ...H.load(), newSid: j.steps.legacyOpen.review.sid });
  advance("interrupted", "interrupted as designed: click Reload page, then phase 5");
});

phase("pReload", "Reload page (F5 equivalent)", "*", async () => { location.reload(); });

phase("pRecover", "5. After reload: page button Check status on chain (no resend, no signature)", "interrupted", async () => {
  const st = H.load();
  check(performance.getEntriesByType("navigation")[0]?.type === "reload", "this document was loaded by a reload");
  await fresh();
  const before = await status();
  const n = toasts.length;
  await clickPage("#fdRec");
  await waitToast(n, /^Status:/, "reconcile status");
  await settled();
  const j = await planOf(st);
  check(j.steps["gasOpen:nucbox"].status === "proven" && j.steps["gasOpen:metal"].status === "planned", "nucbox proven from chain logs; metal planned");
  const after = await status();
  check(after.prompts.length === before.prompts.length && JSON.stringify(posts(after)) === JSON.stringify(posts(before)), "no signature, no resend");
  check(/\(1 step\)/.test(text("#fdSign")) && !q("#fdSign").disabled, "page offers Sign next (1 step)");
  advance("recovered", "recovered after reload without resend");
});

phase("pSwitch2", "6. Page Sign metal (2 prompts), then Send with a CHAIN switch at its first chain read (expect no send)", "recovered", async () => {
  const st = H.load();
  await fresh();
  let n = toasts.length;
  const b0 = await status();
  await clickPage("#fdSign");
  await waitToast(n, /Signed 1 step/, "signed");
  await settled();
  const before = await status();
  check(before.prompts.length - b0.prompts.length === 2, "2 prompts for the metal part");
  H.armRpc(async () => { log("    (hold) switching the chain to 1 before the send's first chain read"); walletState(fx.owner, 1); });
  n = toasts.length;
  await clickPage("#fdRun");
  await waitToast(n, /context_changed/, "cancelled by the switch");
  await settled();
  await sleep(1500);
  const after = await status();
  check(after.prompts.length === before.prompts.length && JSON.stringify(posts(after)) === JSON.stringify(posts(before)), "no prompt, no POST after the switch");
  const j = await planOf(st);
  check(j.steps["gasOpen:metal"].status === "planned" && ["terminate", "legacyOpen", "gasOpen:nucbox"].every((k) => j.steps[k].status === "proven"),
    "metal not admitted; earlier outcomes preserved");
  check(text("#fdMig").includes("Switch your wallet to Base"), "page offers nothing off Base");
  await fresh();
  check(q("#fdRun").disabled && !q("#fdSign").disabled, "back on Base: the dropped bundle is not reused; Sign enabled");
  advance("switched2", "chain switch stopped the send before admission");
});

phase("pComplete", "7. Page buttons: Sign metal again + Send -> complete; conservation, same-key API, finite grants", "switched2", async () => {
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
  check(s.prompts.length === 15, "15 owner prompts in total (2 original + 2 cancelled + 7 + 2 dropped bundle + 2)");
  check(s.hits["POST /v1/sessions/open"] === 2 && s.hits["POST /v1/sessions/owner"] === 1 && s.hits["POST /v1/sessions/funding/open"] === 2,
    "sends: original + replacement open, one terminate, two gas opens - none duplicated");
  check(await usdcOf(fx, fx.owner) === BigInt(st.ownerStart) - OLD_BUDGET, "owner wallet down exactly 30 since Start (30 refunded, 24 + 4.8 + 1.2 out)");   // production-grant-terms-r1
  check(await usdcOf(fx, fx.legacyVault) === 24_000_000n && await usdcOf(fx, fx.vault) === 6_000_000n, "legacy vault 24, successor vault 6");   // production-grant-terms-r1
  const Sx = await sdkReal();
  const ls = await legacyStore();
  const rep = await ls.load(st.newSid), old = await ls.load(st.oldSid);
  check(rep && old && lower(rep.keyHash) === st.oldKeyHash && lower(old.keyHash) === st.oldKeyHash, "replacement and original records: the SAME key");
  const probe = async (rec) => call("/test/verify-api", { header: await (await Sx.sessionFromRecord(rec)).apiAuthorization("GET", fx.apiProbeUrl) });
  const ok = await probe(rep);
  check(ok.sid === st.newSid && ok.anyApp === true, "host verifyApiRequest accepts the replacement (same key, wildcard)");
  let refused = null;
  try { await probe(old); } catch (e) { refused = e; }
  check(refused?.status === 401, "the terminated original is refused (401)");
  const j = await planOf(st);
  const g1 = await call(`/test/fixture/gas-session/${j.steps["gasOpen:nucbox"].review.sid}`);
  const g2 = await call(`/test/fixture/gas-session/${j.steps["gasOpen:metal"].review.sid}`);
  check(g1.live && !g1.anyApp && g1.apps.sort().join() === [...fx.partition.nucbox].sort().join() && g1.balance6 === "4800000", "nucbox: its 8 apps, no wildcard, 4.8");   // production-grant-terms-r1
  check(g2.live && !g2.anyApp && g2.apps.sort().join() === [...fx.partition.metal].sort().join() && g2.balance6 === "1200000", "metal: its 2 apps, no wildcard, 1.2");   // production-grant-terms-r1
  check(text("#fdMig").includes("Migration complete."), "page: migration complete");
  advance("migrated", "migration complete through the page");
});

/** Set the page's gas inputs like a person would (value + input/change events on the page's own controls). */
function setInputs(a) {
  const d = q("#fdDep"), e = q("#fdEth"), t = q("#fdTier");
  if (a.dep !== undefined) d.value = a.dep;
  if (a.eth !== undefined) e.value = a.eth;
  if (a.tier !== undefined) t.value = a.tier;
  for (const [el, v] of [[d, a.dep], [e, a.eth], [t, a.tier]]) if (v !== undefined) { el.dispatchEvent(new Event("input")); el.dispatchEvent(new Event("change")); }
  if (a.dep !== undefined) check(d.value === a.dep, `deployment input = ${a.dep.slice(0, 12)}…`);
  if (a.tier !== undefined) check(t.value === a.tier, `tier input = ${a.tier}`);
}
const shownQuote = () => ({ digest: q("#fdQuoteOut")?.dataset.digest ?? "", text: text("#fdQuoteOut"), fund: q("#fdFund") });
async function quoteThroughPage(a) {
  setInputs(a);
  const n = toasts.length;
  await clickPage("#fdQuote");
  await waitToast(n, /Quote ready/, "quote ready");
  await settled();
  const s = shownQuote();
  check(/^0x[0-9a-f]{64}$/.test(s.digest), "after the re-render the quote is still displayed (call digest present)");
  check(q("#fdDep").value === a.dep && q("#fdEth").value === a.eth && q("#fdTier").value === a.tier, "controls restored to exactly the quoted inputs");
  check(s.text.includes(a.dep.slice(0, 12)) && s.text.includes(`${a.eth} wei`) && s.text.includes(`tier ${a.tier}`) && /relay fee \$/.test(s.text)
    && /total at most \$/.test(s.text) && /valid \d+s/.test(s.text), "quote shows deployment, amount, tier, fee, maximum and time left");
  check(!s.fund.disabled, "Fund enabled for this quote");
  return s.digest;
}
const nucDeps = () => fx.deployments.filter((d) => fx.partition.nucbox.includes(d.app)).map((d) => d.id);

phase("pQuote", "8. Quote stays visible after render; changing deployment / amount / tier clears it; stale fund refused", "migrated", async () => {
  await fresh();
  check(!!q("#fdQuote"), "gas section offers Get quote");
  const [depA, depB] = nucDeps();
  const A = { dep: depA, eth: fx.ethOut, tier: String(fx.feeTier) };
  for (const [what, change] of [["deployment", { dep: depB }], ["amount", { eth: (BigInt(fx.ethOut) / 2n).toString() }], ["tier", { tier: String(fx.altFeeTier) }]]) {
    await tick();
    await quoteThroughPage(A);
    const s0 = await status();
    setInputs(change);
    const s = shownQuote();
    check(s.digest === "" && s.fund.disabled && s.text.includes("Choices changed"), `changing the ${what} clears the quote and disables Fund`);
    const n = toasts.length;
    s.fund.disabled = false;                       // a forced click on the stale button: the page must still refuse
    s.fund.click();
    await waitToast(n, /quote_stale/, `stale fund refused after a ${what} change`);
    await settled();
    const s1 = await status();
    check((s1.hits["POST /v1/sessions/funding/execute"] ?? 0) === (s0.hits["POST /v1/sessions/funding/execute"] ?? 0), `no execute after the ${what} change`);
  }
  advance("quoted", "quote persistence and invalidation verified");
});

phase("pFund", "9. Page buttons: quote the selected inputs and Fund; canonical settlement and fixture balances", "quoted", async () => {
  const st = H.load();
  await fresh();
  const [depA] = nucDeps();
  const A = { dep: depA, eth: fx.ethOut, tier: String(fx.feeTier) };
  const digest = await quoteThroughPage(A);
  const j = await planOf(st);
  const sid = j.steps["gasOpen:nucbox"].review.sid;
  const bal0 = BigInt((await call(`/test/fixture/gas-session/${sid}`)).balance6);
  const vault0 = await usdcOf(fx, fx.vault);
  const s0 = await status();
  const n = toasts.length;
  await clickPage("#fdFund");
  const t = await waitToast(n, /^(Funded:|Sent)/, "fund result");   // client-execution-site-r2: the copy words "Sent, not on chain yet"
  check(/^Funded:/.test(t), "settled on a canonical receipt (not pending)");
  await settled();
  const e = (await (await v2()).listJournal()).find((x) => x.kind === "gas-execute" && lower(x.call?.digest) === digest);   // client-execution-site-r2: successor journal
  check(e && ["observed", "settled"].includes(e.status) && e.evidence?.kind === "settlement" && lower(e.deployment) === depA && lower(e.sid) === lower(sid),
    "journal: the displayed quote's exact call, for the selected deployment, canonically settled (final or NOT final yet)");
  check(t.includes(e.status === "settled" ? "(final on chain)" : "NOT final yet"), "the page message matches the proof: never final when it is not");
  const debit = BigInt(e.evidence.actual.totalDebit6);
  check(debit > 0n && debit <= BigInt(e.maximum.totalMaximum6), "actual debit within the displayed maximum");
  check(bal0 - BigInt((await call(`/test/fixture/gas-session/${sid}`)).balance6) === debit, "grant balance down exactly the settled debit");
  check(vault0 - await usdcOf(fx, fx.vault) === debit, "successor vault USDC down exactly the settled debit");
  const s1 = await status();
  check(s1.hits["POST /v1/sessions/funding/execute"] - (s0.hits["POST /v1/sessions/funding/execute"] ?? 0) === 1, "exactly one execute");
  check(e.call.intent.ethOut === fx.ethOut && fx.ethOut === "200000000000000", "the settled call bought exactly 2e14 wei (the candidate maxEthPerOp)");   // production-grant-terms-r1
  advance("funded", "funded the selected inputs through the page");
});

// =====================================================================================================================
// client-execution-site-r2: gas payment recovery through the ACTUAL generated recovery page copy (phases 12-16).
// UNREVIEWED, NOT RUN. Every effect is a click on the page's own buttons. The shell only arms the server's labelled
// one-shot execute reply fault (the execute itself is REALLY processed and mined first), or the existing RPC hold that
// switches the wallet/network, and then reads fixture counters, the real IndexedDB journal and the owned chain.
// =====================================================================================================================
const EXEC = "POST /v1/sessions/funding/execute", QUOTE = "POST /v1/sessions/funding/quote";
const hit = (s, k) => s.hits[k] ?? 0;
const execEntries = async () => (await (await v2()).listJournal()).filter((x) => x.kind === "gas-execute");
const execRow = (id) => q(`#fdExec [data-exec-row="${id}"]`);
const nucSidOf = async (st) => (await planOf(st)).steps["gasOpen:nucbox"].review.sid;
const sessionBal = async (sid) => BigInt((await call(`/test/fixture/gas-session/${sid}`)).balance6);
const secretFree = (e) => { const j = JSON.stringify(e); return !j.includes("privateKey") && !/"(r|s|sig|signature)":/.test(j); };
const nucA = (k) => ({ dep: nucDeps()[k], eth: fx.ethOut, tier: String(fx.feeTier) });

/** The page's "Check status on chain" for one payment, with empty blocks between checks, until the CORE proves it final.
 *  Bounded: at most 8 checks. Elapsed time is never treated as an outcome. */
async function checkUntilFinal(id, what) {
  for (let i = 0; i < 8; i++) {
    await tick(); await tick();
    await fresh();
    const e0 = await (await v2()).getJournal(id);
    if (e0.status === "settled") return e0;
    check(!!execRow(id), `${what}: the page lists the unresolved payment (${e0.status})`);
    const n = toasts.length;
    await clickPage(`#fdExec [data-exec="${id}"]`);
    const t = await waitFor(() => toasts.slice(n)[0], `${what}: the check result`);
    log(`    ${what}: ${t}`);
    await settled();
    const e = await (await v2()).getJournal(id);
    if (e.status === "settled") return e;
    check(["observed", "unknown", "pending", "dispatching"].includes(e.status), `${what}: still reserved as ${e.status} (never cleared by time)`);
  }
  throw new Error(`${what}: not proven final within 8 bounded checks`);
}
async function quoteRefused(A, what) {
  const s0 = await status();
  setInputs(A);
  const n = toasts.length;
  await clickPage("#fdQuote");
  await waitToast(n, /unreconciled_execute/, `${what}: quote refused`);
  await settled();
  check(hit(await status(), QUOTE) === hit(s0, QUOTE), `${what}: no quote request reached the relay`);
}

phase("pExecFinal", "12. After the normal Fund: on-chain-not-final is shown and blocks a quote; page Check status until final", "funded", async () => {
  await fresh();
  const e0 = (await execEntries()).find((x) => x.evidence?.kind === "settlement");
  check(!!e0, "the funded payment is journaled with its chain evidence");
  if (e0.status === "observed") {
    check(!!execRow(e0.id) && text("#fdExec").includes("not final"), "page: the payment is on chain but NOT final, shown as unresolved");
    check(!!q("[data-exec-blocked]"), "the gas section says a payment is unresolved");
    await quoteRefused(nucA(0), "not final");
  } else log(`    note: the fixture had already finalized that block (${e0.status}); the not-final display was not observable in this run`);
  const s0 = await status();
  const done = await checkUntilFinal(e0.id, "normal payment");
  const s1 = await status();
  check(done.evidence.final === true && done.evidence.txHash === e0.evidence.txHash, "the same transaction, proven final");
  check(hit(s1, EXEC) === hit(s0, EXEC) && s1.prompts.length === s0.prompts.length, "checking status sent nothing and signed nothing");
  await fresh();
  check(!execRow(e0.id) && text("#fdExec").includes("No unresolved gas payment"), "no unresolved payment left");
  advance("execFinal", "normal payment shown truthfully until proven final");
});

async function lostReplyFund(mode, k) {
  const st = H.load();
  await fresh();
  const sid = await nucSidOf(st);
  const A = nucA(k);
  const digest = await quoteThroughPage(A);
  const bal0 = await sessionBal(sid), vault0 = await usdcOf(fx, fx.vault), s0 = await status();
  await call("/test/fixture/execute-fault", { mode });
  const n = toasts.length;
  await clickPage("#fdFund");
  const t = await waitFor(() => toasts.slice(n)[0], "the fund result");
  check(!/^Funded:/.test(t), `the page does not claim success (${t})`);
  await settled();
  const s1 = await status();
  check(hit(s1, EXEC) - hit(s0, EXEC) === 1 && s1.executeFaults.at(-1) === mode,
    `exactly one execute POST; its reply ${mode === "body" ? "body was truncated after headers" : "was replaced by a 502"} AFTER real processing`);
  check(s1.prompts.length === s0.prompts.length, "no owner prompt");
  const e = (await execEntries()).find((x) => lower(x.call?.digest) === digest);
  check(e?.status === "unknown", "journal (real IndexedDB): UNKNOWN, never refused");
  check(e.schema === "enclave-funding-gas-execute-r2" && e.call.nonce === e.nonce && /^0x[0-9a-f]+$/.test(e.call.args) && !!e.anchor?.hash
    && lower(e.sid) === lower(sid) && lower(e.deployment) === A.dep && e.relay === origin, "the exact public intent is persisted: call, nonce, anchor, sid, deployment, relay");
  check(secretFree(e), "no key or signature in the journal");
  check(execRow(e.id)?.dataset.execStatus === "unknown", "page: the payment is listed as unknown with a read-only Check button");
  await waitFor(async () => (await sessionBal(sid)) < bal0, "the really processed execute to be mined", 30_000);
  const drop = bal0 - await sessionBal(sid);
  await quoteRefused(A, `${mode}: unknown`);
  return { id: e.id, sid, bal0: bal0.toString(), vault0: vault0.toString(), drop: drop.toString(), exec: hit(s1, EXEC), prompts: s1.prompts.length };
}
async function provenOnce(L, what) {
  const done = await checkUntilFinal(L.id, what);
  const s = await status();
  check(hit(s, EXEC) === L.exec, `${what}: no execute resent`);
  check(s.prompts.length === L.prompts, `${what}: no signature`);
  const debit = BigInt(done.evidence.actual.totalDebit6);
  check(debit === BigInt(L.drop) && BigInt(L.bal0) - await sessionBal(L.sid) === debit, `${what}: the proven debit is the single on-chain balance drop`);
  check(BigInt(L.vault0) - await usdcOf(fx, fx.vault) === debit, `${what}: successor vault USDC down exactly that debit`);
  check(done.evidence.final === true && /^0x[0-9a-f]{64}$/.test(done.evidence.txHash), `${what}: exact canonical settlement, proven final`);
  return done;
}

phase("pExecLost", "13. Page Fund with the reply body LOST after headers: persisted UNKNOWN with the exact intent (then Reload)", "execFinal", async () => {
  const L = await lostReplyFund("body", 1);
  H.save({ ...H.load(), lostBody: L });
  advance("execUnknown", "UNKNOWN persisted; click Reload page, then phase 14");
});

phase("pExecReload", "14. After reload: the UNKNOWN row is still there; page Check status proves it once, read-only", "execUnknown", async () => {
  const L = H.load().lostBody;
  check(performance.getEntriesByType("navigation")[0]?.type === "reload", "this document was loaded by a reload");
  await fresh();
  check(!!execRow(L.id), "after reload the recovery row is still listed (real IndexedDB)");
  check((await (await v2()).getJournal(L.id)).status === "unknown", "still UNKNOWN after reload");
  await stage("store-level, NOT page: two concurrent IndexedDB compare-and-set creates of one id - exactly one commits", async () => {
    const id = `harness-cas-probe:${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
    const mk = (who) => (cur) => { if (cur) throw Object.assign(new Error("exists"), { code: "exists" }); return { id, kind: "harness-cas-probe", who }; };
    const r = await Promise.allSettled([v2().casJournal(id, mk("a")), v2().casJournal(id, mk("b"))]);
    check(r.filter((x) => x.status === "fulfilled").length === 1 && r.filter((x) => x.status === "rejected").length === 1, "exactly one create committed");
  });
  await provenOnce(L, "lost-body payment");
  advance("execRecovered", "lost-body payment recovered read-only after reload");
});

phase("pExec502", "15. Page Fund answered by a gateway 502 AFTER real processing: UNKNOWN, then page Check status proves it once", "execRecovered", async () => {
  const L = await lostReplyFund("gateway502", 2);
  await provenOnce(L, "502 payment");
  advance("exec502Done", "gateway-502 payment recovered read-only");
});

phase("pExecSwitch", "16. Page Fund with an ACCOUNT switch, then a CHAIN switch, at the payment's first chain read: nothing admitted or sent", "exec502Done", async () => {
  const sid = await nucSidOf(H.load());
  for (const [what, to] of [["account", () => walletState(OTHER, 8453)], ["chain", () => walletState(fx.owner, 1)]]) {
    await fresh();
    await quoteThroughPage(nucA(3));
    const s0 = await status(), n0 = (await execEntries()).length, bal0 = await sessionBal(sid);
    H.armRpc(async () => { log(`    (hold) ${what} switch at the payment's first chain read`); to(); });
    const n = toasts.length;
    await clickPage("#fdFund");
    await waitToast(n, /context_changed/, `${what} switch cancelled the payment`);
    await settled();
    await sleep(1500);
    check(hit(await status(), EXEC) === hit(s0, EXEC), `${what}: no execute POST`);
    check((await execEntries()).length === n0, `${what}: no execution admitted (the guarded store refused the new entry)`);
    check(await sessionBal(sid) === bal0, `${what}: no debit`);
  }
  await fresh();
  advance("execDone", "account and chain switches cannot dispatch a payment");
});

phase("pControls", "10. Intake OFF, then config/catalog unavailable: owner controls still render; page Terminate works", "execDone", async () => {
  const st = H.load();
  const j = await planOf(st);
  const metal = j.steps["gasOpen:metal"].review;
  const term = `#fdControls [data-term="${metal.recordId}"]`;
  try {
    await call("/test/fixture/intake", { off: true });
    await fresh();
    check(text("#fdGas").includes("New gas funding is paused"), "intake off: new gas funding paused");
    check(q(term) && !q(term).disabled, "intake off: owner Terminate still enabled");
    H.configUnavailable = true;
    await fresh();
    check(text("#fdMig").includes("Unavailable right now") && text("#fdGas").includes("Not available here"), "config/catalog unavailable: migration and gas unavailable");
    check(q("#fdControls [data-end]") && q(term) && !q(term).disabled, "controls still list this browser's grants with enabled buttons");
    const s0 = await status();
    const n = toasts.length;
    await clickPage(term);
    await waitToast(n, /Terminate sent/, "terminate sent");
    const s1 = await status();
    check(s1.prompts.length - s0.prompts.length === 1 && s1.prompts.at(-1).primaryType === "Terminate" && lower(s1.prompts.at(-1).verifyingContract) === lower(fx.vault),
      "one owner prompt: Terminate on the successor vault");
    check(s1.hits["POST /v1/sessions/funding/owner"] - (s0.hits["POST /v1/sessions/funding/owner"] ?? 0) === 1, "one /funding/owner POST");
    check(s1.intakeOffReplies > 0, "the relay config really answered intake-off during this phase");
    await waitFor(async () => !(await call(`/test/fixture/gas-session/${metal.sid}`)).live, "the metal grant to end on chain", 60_000);
    log("    ok  metal grant ended on chain");
  } finally {
    H.configUnavailable = false;
    await call("/test/fixture/intake", { off: false });
  }
  advance("controls", "owner controls independent of intake and config");
});

phase("pNull", "11. Null runtime (reloads): zero signing offered", "controls", async () => {
  H.save({ ...H.load(), nullRuntime: true, nullBase: await status() });
  advance("nullRuntime", "runtime set to null for the next load", true);
});
phase("pNullCheck", "11b. Check the null-runtime page: nothing to sign or send", "nullRuntime", async () => {
  const st = H.load();
  await fresh();
  await sleep(3000);
  check(text("#fdControls").includes("not set up") && text("#fdMig").includes("no deployed successor") && text("#fdGas").includes("Not available"),
    "page: not set up / not available");
  check(document.querySelectorAll("#fdBody button:not([disabled])").length === 0, "no enabled button anywhere on the page");
  const s = await status();
  check(s.prompts.length === st.nullBase.prompts.length && JSON.stringify(posts(s)) === JSON.stringify(posts(st.nullBase)), "no prompt, no POST");
  advance("done", "ALL PHASES PASS (TEST fixture only)");
});

phase("pCleanup", "Delete this run's TEST databases", "*", async () => {
  const st = H.load();
  if (st?.legacyDb) {
    for (const n of [H.dbName("legacy"), H.dbName("v2", [F.V2_DB, F.LEGACY_DB])]) {
      await new Promise((ok, bad) => { const r = indexedDB.deleteDatabase(n); r.onsuccess = ok; r.onerror = () => bad(r.error); r.onblocked = ok; });
      log(`deleted ${n}`);
    }
  }
  localStorage.removeItem(WALLET_SESSION_KEY);
  sessionStorage.clear();
  setStatus("PASS", "this run's TEST databases deleted; reload for a fresh run");
});

// ---- boot: fixture config first, then the page module (its config facade reads it at evaluation) --------------------
const panel = $("hbuttons");
for (const p of PHASES) {
  const b = document.createElement("button");
  b.id = p.id; b.type = "button"; b.textContent = p.label; b.disabled = true;
  b.addEventListener("click", async () => {
    if (busy) return;
    busy = true; refresh();
    logEl.textContent = ""; stagesEl.textContent = "";
    setStatus("RUNNING", p.label);
    try { await p.fn(); }
    catch (e) { log(`FAIL ${e?.code ? `${e.code}: ` : ""}${e?.message ?? e}`); setStatus("FAIL", e?.message ?? String(e)); H.save({ ...(H.load() || {}), last: { result: "FAIL", msg: e?.message } }); }
    finally { busy = false; refresh(); }
  });
  panel.appendChild(b);
  panel.appendChild(document.createElement("br"));
}
try {
  fx = await call("/test/fixture/config");
  const st = H.load();
  H.setPageConfig({ runtime: st?.nullRuntime ? null : fx.pins, proposal: st?.oldSid ? proposalOf(fx, st.oldSid) : null, approval: st?.approval ?? null });
  if (st?.connected) Object.assign(Enclave, { address: fx.owner, chainId: 8453, provider: fixtureProvider, base: `${origin}/v1` });
  const page = await import("../../client-execution-site-r2/candidate/site/js/pages/funding.js");   // client-execution-site-r2: the generated recovery page copy (aliases only)
  page.boot();
  refresh();
  setStatus(st?.last?.result ?? "IDLE", st?.last?.msg ?? "click TEST Start");
} catch (e) {
  setStatus("FAIL", `boot: ${e?.message ?? e}`);
}
