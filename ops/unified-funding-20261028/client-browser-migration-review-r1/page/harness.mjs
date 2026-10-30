// client-browser-migration-r1 page module (UNREVIEWED, NOT RUN). Bundled by root to page/dist/harness.js.
// TEST ONLY. Runs the UNCHANGED client-repair-r4 modules (migration, funding-client, v2-store) and the vendored v1 SDK in
// a REAL browser against the harness origin (owned loopback anvil + actual composed relay, see harness/server.mjs):
//   Start    : opens the ORIGINAL 30 USDC session exactly as the site does (SDK, NON-extractable key in REAL IndexedDB,
//              explicit wildcard ["*"] grant, owner EIP-712 + EIP-3009 by the TEST fixture signer, HTTP /open), builds the
//              8 + 2 finite partition plan (29 legacy / 0.8 / 0.2), signs ONLY terminate + replacement + first gas part
//              (5 fixture-signer prompts) and runs: terminate and the replacement are proven and adopted; the harness
//              loses the reply of the first gas open, so that step stays ADMITTED (persisted intent) - then STOP.
//   (reload) : in-memory signatures are gone; only IndexedDB + sessionStorage (public names/ids) survive.
//   Continue : reconcile proves the interrupted gas open from chain logs (no resend, no new signature), signs ONLY the
//              second gas part (2 prompts), finishes, checks 30 USDC conservation, the SAME legacy key passing the host's
//              real API verifier, the separate finite 8 + 2 grants on chain, then funds all ten apps through the grant
//              that names each app (session keys from IndexedDB) and refuses a cross-app attempt.
// Never: window.ethereum or any provider discovery, a production URL or database, key export, a URL supplied by input.
import * as S from "../../../source/sdk/sessions/dist/browser.mjs";
import * as FC from "../../client-repair-r4/lib/funding-client.mjs";
import * as MIG from "../../client-repair-r4/lib/migration.mjs";
import * as V2 from "../../client-repair-r4/lib/v2-store.mjs";

const PREFIX = "client-browser-migration-r1-TEST-";
const REAL_DBS = new Set(["enclave-sessions", V2.V2_DB, V2.LEGACY_DB]);
const SS_KEY = "client-browser-migration-r1";
const OLD_ACTIONS = ["deploy.create", "deploy.fund", "deploy.setAppRef", "deploy.setConfig", "deploy.setShares",
  "deploy.setMaxRate", "deploy.setActive", "deploy.refund", "api.status", "api.logs", "api.restart", "api.upload",
  "api.appAccess", "api.placement", "api.account"];
const OLD_BUDGET = 30_000_000n;
const FIRST = ["terminate", "legacyOpen", "gasOpen:nucbox"];
const SECOND = ["gasOpen:metal"];
const FULL = [...FIRST, ...SECOND];
const PATHS = Object.freeze({ config: "/test/fixture/config", status: "/test/fixture/status", tick: "/test/fixture/tick",
  sign: "/test/owner-sign", verify: "/test/verify-api", record: "/test/record-dbs", gas: "/test/fixture/gas-session/" });

const $ = (id) => document.getElementById(id);
const lower = (a) => String(a ?? "").toLowerCase();
const nowS = () => BigInt(Math.floor(Date.now() / 1000));
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const load = () => JSON.parse(sessionStorage.getItem(SS_KEY) || "null");
const save = (o) => sessionStorage.setItem(SS_KEY, JSON.stringify(o));
const guard = (n) => {
  if (typeof n !== "string" || !n.startsWith(PREFIX) || REAL_DBS.has(n)) throw new Error(`refusing database ${n}`);
  return n;
};

// ---- UI --------------------------------------------------------------------------------------------------------------
const logEl = $("log"), statusEl = $("status"), stagesEl = $("stages");
const log = (m) => { logEl.textContent += `${m}\n`; };
const setStatus = (r, m) => { statusEl.dataset.result = r; statusEl.textContent = `${r}${m ? `: ${m}` : ""}`; };
const check = (cond, what) => { if (!cond) throw new Error(`assertion failed: ${what}`); log(`    ok  ${what}`); };
async function stage(name, fn) {
  const li = document.createElement("li");
  li.textContent = `${name} ...`;
  li.dataset.result = "RUNNING";
  stagesEl.appendChild(li);
  log(`> ${name}`);
  try { const out = await fn(); li.textContent = `${name}: PASS`; li.dataset.result = "PASS"; return out; }
  catch (e) { li.textContent = `${name}: FAIL (${e?.code ? `${e.code}: ` : ""}${e?.message ?? e})`; li.dataset.result = "FAIL"; throw e; }
}
function showDbs() {
  const s = load();
  $("dbs").textContent = s ? `TEST databases (this run): ${s.legacyDb}, ${s.v2Db}` : "no run recorded in this tab";
}
let busy = false;
const button = (id, fn) => $(id).addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  for (const b of ["start", "continue", "cleanup"]) $(b).disabled = true;
  logEl.textContent = ""; stagesEl.textContent = "";
  setStatus("RUNNING");
  try { await fn(); }
  catch (e) { log(`FAIL ${e?.code ? `${e.code}: ` : ""}${e?.message ?? e}`); setStatus("FAIL", e?.message ?? String(e)); }
  finally { busy = false; for (const b of ["start", "continue", "cleanup"]) $(b).disabled = false; showDbs(); }
});

// ---- same-origin harness calls (fixed paths only) -----------------------------------------------------------------------
async function call(pathName, body) {
  const r = await fetch(pathName, body === undefined ? { method: "GET" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body, big) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { code: j.code ?? `http_${r.status}`, status: r.status });
  return j;
}
/** TEST fixture signer: an EIP-1193-shaped object that ONLY answers eth_signTypedData_v4 by asking the harness's public
 *  fixture key (restricted server-side to the owned chain-8453 fixture domains). It is NOT a wallet. */
const fixtureProvider = Object.freeze({
  async request({ method, params }) {
    if (method !== "eth_signTypedData_v4") throw new Error(`the TEST fixture signer refuses ${method}`);
    return (await call(PATHS.sign, { address: params[0], payload: params[1] })).sig;
  },
});
const fixtureOwnerSigner = (owner) => ({ address: owner,
  signTypedData: async (td) => (await call(PATHS.sign, { address: owner, payload: JSON.stringify(td, big) })).sig });

async function context(st) {
  await call(PATHS.tick, {});                               // one empty block so the pinned block is fresh
  const fx = await call(PATHS.config);
  const origin = location.origin;
  const rpcUrl = `${origin}/rpc`;
  const rpc = FC.jsonRpc(rpcUrl);
  const relay = FC.relayClient(origin);                     // the DEFAULT client, exactly as the site page
  const runtime = await FC.verifyRuntime({ pins: fx.pins, rpc, relay, owner: fx.owner, now: nowS() });
  const legacyStore = new S.IndexedDbStore(guard(st.legacyDb));
  const gasStore = new V2.IndexedDbV2Store(guard(st.v2Db));
  return { fx, origin, rpcUrl, rpc, relay, runtime, legacyStore, gasStore, chain: MIG.legacyChain(rpc, S) };
}
const migCtx = (c) => ({ S, chain: c.chain, legacyRelay: new S.RelayClient(c.origin), relay: c.relay, runtime: c.runtime,
  legacyStore: c.legacyStore, gasStore: c.gasStore, now: nowS(),
  setActive: async (sid, from) => { save({ ...load(), active: sid, activeFrom: from }); log(`    active pointer -> ${sid}`); } });
const usdcOf = (c, a) => FC.ethCall(c.rpc, c.fx.usdc, "balanceOf", [a]).then(BigInt);
const fresh = (c) => FC.freshRecoveryScope({ rpc: c.rpc, book: c.fx.book, owner: c.fx.owner, legacyVault: c.fx.legacyVault,
  deploymentIds: c.fx.deployments.map((d) => d.id), now: nowS() });
const splitOf = (fx) => ({ legacy6: BigInt(fx.split.legacy6), gas: [
  { name: "nucbox", budget6: BigInt(fx.split.nucbox6), opsPerPeriod: BigInt(fx.split.nucboxOps), appIds: fx.partition.nucbox },
  { name: "metal", budget6: BigInt(fx.split.metal6), opsPerPeriod: BigInt(fx.split.metalOps), appIds: fx.partition.metal }] });
async function verifyKeyRecord(rec, what) {
  check(rec && rec.privateKey instanceof CryptoKey, `${what}: CryptoKey loaded from IndexedDB`);
  check(rec.privateKey.extractable === false && rec.privateKey.type === "private", `${what}: private and NON-extractable`);
  let exported = false;
  try { await crypto.subtle.exportKey("pkcs8", rec.privateKey); exported = true; } catch { /* refused, as required */ }
  check(!exported, `${what}: pkcs8 export refused`);
}
async function apiProbe(c, rec) {
  const header = await (await S.sessionFromRecord(rec)).apiAuthorization("GET", c.fx.apiProbeUrl);
  return call(PATHS.verify, { header });
}

// =====================================================================================================================
// Start
// =====================================================================================================================
button("start", async () => {
  if (load()) throw new Error("a run is already recorded in this tab: Continue it, or Delete its TEST databases first");
  const tag = () => hex(crypto.getRandomValues(new Uint8Array(8)));
  const st0 = { legacyDb: `${PREFIX}legacy-${tag()}`, v2Db: `${PREFIX}v2-${tag()}`, phase: "starting" };
  save(st0);
  showDbs();
  await call(PATHS.record, { names: [st0.legacyDb, st0.v2Db] });
  const c = await stage("1. owned fixture reachable; runtime verified against deployed code and /funding/config", () => context(st0));
  check(c.runtime.intake?.openEnabled === true, "successor intake open");
  check(c.runtime.cfg.legacyVault === c.fx.legacyVault, "runtime legacy vault = fixture legacy vault");
  const ownerStart = await usdcOf(c, c.fx.owner);

  const { oldSid, oldKeyHash } = await stage("2. ORIGINAL 30 USDC session opened like the site (SDK, real IndexedDB, explicit wildcard)", async () => {
    const { signer, record } = await S.newSessionKey(c.legacyStore, { relay: c.origin, chainId: 8453,
      label: "client-browser-migration-r1 TEST original", extractable: false });
    check(record.privateKey.extractable === false, "fresh legacy key is non-extractable");
    const t0 = BigInt((await c.rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
    const grant = { label: "client-browser-migration-r1 TEST original", preset: "browser", sessionKey: signer.keyHash, actions: OLD_ACTIONS,
      apps: ["*"], environments: ["staging", "prod"], budget: OLD_BUDGET, spendPerPeriod: 100_000_000n, periodSeconds: 86_400,
      opsPerPeriod: 1000, maxFeePerOp: 250_000n, maxAppFeePerHour: 0n, maxRatePerHour: 5_000_000n, expiresAt: t0 + 7n * 86_400n,
      measurement: `0x${"0".repeat(64)}`, grantNonce: `0x${hex(crypto.getRandomValues(new Uint8Array(32)))}`, signBefore: t0 + 900n };
    const usdcDom = await S.usdcDomain(S.chainClient(8453, c.rpcUrl), c.fx.usdc, 8453);
    await S.openSession({ relay: new S.RelayClient(c.origin), owner: fixtureOwnerSigner(c.fx.owner), chainId: 8453,
      vault: c.fx.legacyVault, grant, usdc: usdcDom });
    const oldRec = await S.completeSession(c.legacyStore, record, { vault: c.fx.legacyVault, owner: c.fx.owner, grant, rpc: c.rpcUrl });
    const sid = lower(oldRec.id);
    await verifyKeyRecord(await c.legacyStore.load(sid), "original record");
    const s = await c.chain.sessionOf(c.fx.legacyVault, sid);
    check(s.live && s.anyApp === true && s.apps.length === 0 && s.balance6 === OLD_BUDGET, "chain: live, explicit wildcard, 30 USDC");
    check(await usdcOf(c, c.fx.owner) === ownerStart - OLD_BUDGET, "owner wallet down exactly 30 (mock USDC)");
    return { oldSid: sid, oldKeyHash: lower(oldRec.keyHash) };
  });
  save({ ...load(), oldSid, oldKeyHash, ownerStart: ownerStart.toString(), phase: "original" });

  const plan = await stage("3. evidence + TEST 8+2 finite partition plan (29 legacy / 0.8 / 0.2), journal in real IndexedDB", async () => {
    const scope = await fresh(c);
    check(scope.partitionRequired === true && scope.appIds.length === 10, "fresh scope: 10 distinct apps, partition required");
    const evidence = await MIG.loadLegacyEvidence({ S, legacyStore: c.legacyStore, sid: oldSid, owner: c.fx.owner, chain: c.chain,
      legacyConfig: await new S.RelayClient(c.origin).config(), runtime: c.runtime, now: nowS() });
    check(evidence.state.anyApp === true && evidence.grant.apps.join() === "*", "persisted grant + chain agree: explicit wildcard");
    const p = await MIG.buildMigrationPlan({ S, evidence, runtime: c.runtime, scope, split: splitOf(c.fx), now: nowS(),
      gasStore: c.gasStore, relayBase: c.origin });
    check(p.terms.order.join() === FULL.join(), `order ${FULL.join(" -> ")}`);
    check(p.steps.legacyOpen.review.grant.apps.join() === "*", "replacement keeps the explicit wildcard");
    check(new Set([p.terms.legacy.keyHash, p.steps["gasOpen:nucbox"].review.keyHash, p.steps["gasOpen:metal"].review.keyHash]).size === 3,
      "legacy key + two fresh gas keys, all distinct");
    check(p.terms.legacy.keyHash === oldKeyHash, "replacement uses the SAME legacy key");
    for (const r of await c.gasStore.listKeys()) await verifyKeyRecord(r, `gas key ${r.id.slice(0, 12)}`);
    return p;
  });
  save({ ...load(), planId: plan.id, phase: "planned" });

  const signed = await stage("4. TEST fixture signer: terminate + replacement grant/deposit + first gas grant/deposit (5 prompts)", async () => {
    const before = (await call(PATHS.status)).prompts.length;
    const s = await MIG.signSteps({ S, plan: await c.gasStore.getJournal(plan.id), steps: FIRST,
      approval: { rootReviewed: true, termsHash: plan.termsHash },      // TEST approval of TEST terms
      provider: fixtureProvider, rpc: c.rpc, runtime: c.runtime, now: nowS() });
    const st = await call(PATHS.status);
    check(st.prompts.length - before === 5, "exactly 5 new fixture-signer prompts");
    return s;
  });

  await stage("5. run: terminate + replacement proven and adopted; first gas reply LOST -> intent persisted, then stop", async () => {
    let err = null;
    try { await MIG.runMigration(migCtx(c), plan.id, signed); } catch (e) { err = e; }
    check(err && (err.code === "relay_unreachable" || err instanceof TypeError),
      `the first gas response is unreadable (${err?.code ?? err?.name ?? "no error"})`);
    // Exact one-send/one-interruption and persisted admitted-state assertions below must also pass.
    const j = await c.gasStore.getJournal(plan.id);
    check(j.steps.terminate.status === "proven" && j.steps.legacyOpen.status === "proven", "terminate + replacement proven on chain");
    check(j.steps["gasOpen:nucbox"].status === "admitted" && !j.steps["gasOpen:nucbox"].txHash && j.steps["gasOpen:nucbox"].observed,
      "first gas part ADMITTED with observed block, no txHash: the persisted intent");
    check(j.steps["gasOpen:metal"].status === "planned", "second gas part not touched");
    const newSid = j.steps.legacyOpen.review.sid;
    const rep = await c.legacyStore.load(newSid);
    await verifyKeyRecord(rep, "replacement record");
    check(lower(rep.keyHash) === oldKeyHash && rep.grant.budget === 29_000_000n && rep.grant.apps.join() === "*",
      "replacement record: same legacy key, 29 USDC, wildcard");
    check(load().active === newSid, "active pointer moved to the replacement");
    const status = await call(PATHS.status);
    check((status.hits["POST /v1/sessions/funding/open"] ?? 0) === 1 && status.dropped.length === 1, "one gas open sent, its reply dropped");
    save({ ...load(), newSid, phase: "interrupted" });
  });
  setStatus("PASS", "interrupted as designed - now RELOAD this page (F5), then click Continue");
});

// =====================================================================================================================
// Continue (after a reload)
// =====================================================================================================================
button("continue", async () => {
  const st = load();
  if (!st || st.phase !== "interrupted") throw new Error("nothing to continue: click Start first (and let it stop)");
  const nav = performance.getEntriesByType("navigation")[0];
  check(nav?.type === "reload", "this document was loaded by a reload (in-memory signatures are gone)");
  const c = await stage("6. new connections to the same TEST databases; runtime re-verified", () => context(st));
  const before = await call(PATHS.status);

  await stage("7. reconcile: the interrupted gas open is PROVEN from chain logs - nothing resent, nothing re-signed", async () => {
    const r = await MIG.reconcileMigration(migCtx(c), st.planId);
    check(r.steps["gasOpen:nucbox"] === "proven" && r.steps["gasOpen:metal"] === "planned", "nucbox proven, metal still planned");
    const after = await call(PATHS.status);
    check(after.prompts.length === before.prompts.length, "no new signature");
    check((after.hits["POST /v1/sessions/funding/open"] ?? 0) === (before.hits["POST /v1/sessions/funding/open"] ?? 0), "no resend");
  });

  await stage("8. sign ONLY the second gas part (2 prompts) and finish", async () => {
    const plan = await c.gasStore.getJournal(st.planId);
    const signed = await MIG.signSteps({ S, plan, steps: SECOND, approval: { rootReviewed: true, termsHash: plan.termsHash },
      provider: fixtureProvider, rpc: c.rpc, runtime: c.runtime, now: nowS() });
    check((await MIG.runMigration(migCtx(c), st.planId, signed)).done === true, "migration done");
    const s = await call(PATHS.status);
    const migrationPrompts = s.prompts.slice(2).map((p) => p.primaryType);           // the first 2 opened the original
    check(JSON.stringify(migrationPrompts) === JSON.stringify(["Terminate", "SessionGrant", "ReceiveWithAuthorization",
      "SessionGrant", "ReceiveWithAuthorization", "SessionGrant", "ReceiveWithAuthorization"]), "7 migration prompts in total, each once");
    check(s.hits["POST /v1/sessions/open"] === 2 && s.hits["POST /v1/sessions/owner"] === 1 && s.hits["POST /v1/sessions/funding/open"] === 2,
      "sends: original open + replacement open, one terminate, two gas opens - none duplicated");
  });

  await stage("9. 30 USDC conservation (mock funds)", async () => {
    const owner = await usdcOf(c, c.fx.owner);
    check(owner === BigInt(st.ownerStart) - OLD_BUDGET, "owner wallet down exactly 30: refund 30 out, 29 + 0.8 + 0.2 in");
    check(await usdcOf(c, c.fx.legacyVault) === 29_000_000n, "legacy vault holds 29");
    check(await usdcOf(c, c.fx.vault) === 1_000_000n, "successor vault holds 1");
  });

  await stage("10. SAME legacy key keeps the API capability; the original is refused", async () => {
    const rep = await c.legacyStore.load(st.newSid);
    const old = await c.legacyStore.load(st.oldSid);
    check(old && lower(old.keyHash) === st.oldKeyHash, "original record still present, unchanged key");
    check(lower(rep.keyHash) === st.oldKeyHash, "replacement record = same key hash");
    const ok = await apiProbe(c, rep);
    check(ok.sid === st.newSid && ok.anyApp === true, "host verifyApiRequest(api.status) accepts the replacement (wildcard)");
    let refused = null;
    try { await apiProbe(c, old); } catch (e) { refused = e; }
    check(refused?.status === 401, "the terminated original is refused (401)");
    const s = await c.chain.sessionOf(c.fx.legacyVault, st.newSid);
    check(s.live && s.anyApp === true && s.apps.length === 0 && s.balance6 === 29_000_000n, "chain: replacement live, wildcard, 29");
  });

  await stage("11. separate finite gas grants on chain: 8 + 2 disjoint apps, 0.8 + 0.2", async () => {
    const j = await c.gasStore.getJournal(st.planId);
    const g1 = await call(PATHS.gas + j.steps["gasOpen:nucbox"].review.sid);
    const g2 = await call(PATHS.gas + j.steps["gasOpen:metal"].review.sid);
    check(g1.live && g1.anyApp === false && [...g1.apps].sort().join() === [...c.fx.partition.nucbox].sort().join() && g1.balance6 === "800000",
      "nucbox grant: exactly its 8 apps, no wildcard, 0.8");
    check(g2.live && g2.anyApp === false && [...g2.apps].sort().join() === [...c.fx.partition.metal].sort().join() && g2.balance6 === "200000",
      "metal grant: exactly its 2 apps, no wildcard, 0.2");
    check(!g1.apps.some((a) => g2.apps.includes(a)), "the two scopes are disjoint");
  });

  await stage("12. real P-256 gas.fund for all ten apps through the grant that names each (keys from IndexedDB)", async () => {
    const scope = await fresh(c);
    for (const d of c.fx.deployments) {
      const rec = FC.selectGasRecord(await c.gasStore.listKeys(), scope, d.id);
      await verifyKeyRecord(rec, `gas key for app ${d.app.slice(0, 10)}`);
      const review = await FC.quoteGasFund({ runtime: c.runtime, record: rec, relay: c.relay, scope, deployment: d.id,
        ethOut: BigInt(c.fx.ethOut), feeTier: c.fx.feeTier, now: nowS(), journalEntries: await c.gasStore.listJournal() });
      const out = await FC.confirmGasFund({ runtime: c.runtime, store: c.gasStore, record: rec, review, relay: c.relay, rpc: c.rpc, now: nowS() });
      check(out.pending === false && out.settlement.actual.totalDebit6 <= review.totals.totalMaximum6, `app ${d.app.slice(0, 10)} funded and settled`);
    }
    const nuc = FC.selectGasRecord(await c.gasStore.listKeys(), scope, c.fx.deployments.find((d) => c.fx.partition.nucbox.includes(d.app)).id);
    const metalDep = c.fx.deployments.find((d) => c.fx.partition.metal.includes(d.app)).id;
    let refused = null;
    try { await FC.quoteGasFund({ runtime: c.runtime, record: nuc, relay: c.relay, scope, deployment: metalDep, ethOut: BigInt(c.fx.ethOut),
      feeTier: c.fx.feeTier, now: nowS() }); } catch (e) { refused = e; }
    check(refused?.code === "app_not_granted", "the nucbox grant cannot fund a metal app (client refusal)");
    const s = await call(PATHS.status);
    check(s.hits["POST /v1/sessions/funding/execute"] === 10, "exactly ten gas executes sent");
  });
  save({ ...load(), phase: "done" });
  setStatus("PASS", "resumed after reload: no duplicate signature, send or debit; same legacy key; separate finite grants");
});

// =====================================================================================================================
// Cleanup: deletes ONLY this run's two TEST databases
// =====================================================================================================================
button("cleanup", async () => {
  const st = load();
  if (!st) { setStatus("PASS", "nothing recorded in this tab"); return; }
  for (const n of [st.legacyDb, st.v2Db]) {
    await new Promise((ok, bad) => { const r = indexedDB.deleteDatabase(guard(n)); r.onsuccess = ok; r.onerror = () => bad(r.error); r.onblocked = ok; });
    log(`deleted ${n}`);
  }
  sessionStorage.removeItem(SS_KEY);
  setStatus("PASS", "this run's TEST databases deleted");
});

showDbs();
setStatus("IDLE", load()?.phase === "interrupted" ? "reload done? click Continue" : "click Start");
