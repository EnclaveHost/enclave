// permit r10 (AUTHORED, NOT RUN). Actual Host class + actual tick/protectedTick/private #protectedPass/#protectedLaunch/#isolationReconcile,
// actual renewDue/consider/shareUse/lifecycleView, actual protected-supervisor (enrollment parser, authority(), reconcile()).
// Portable successor of the root-executed evidence/root-r9/root-host-consumer.test.mjs (corrected port41 run: 1 PASS / 3 FAIL), which is
// preserved unchanged. No Host source rewrite or private-method extraction.
// TEST DOUBLES, explicitly labelled: Host's external service modules (chain.mjs, isolation client/lifecycle, caps, admission, startup) are
// replaced at import by the same resolve hook the root used; the protected OWNED RUNTIME in part A is a labelled TEST runtime recording calls
// (part B uses the REAL r18 owned factory/journals/dispatch with the actual Host.lifecycleView()). isolationVerdict is a labelled
// reachability probe in part A (it never stages). Nothing here is a real stage/serve, chain, Windows or Base qualification.
// CHANGED vs the root file (deliberately): its positive control asserted ONE retired-catalog lookup; r10 removes that dependency, so the
// carried control asserts ZERO retired ledger/catalog reads and reachability through an authenticated snapshot instead.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import * as supervisor from "../../control/windows/node/protected-supervisor.mjs";
import * as factory from "../../control/windows/node/protected-authority-factory.mjs";

const hostURL = new URL("../../control/windows/node/host.mjs", import.meta.url);
const H = (b) => "0x" + b.repeat(32), A = (b) => "0x" + b.repeat(20);
const HOST = H("a1"), DEP = H("d1"), NEIGHBOR = H("b7");
const fixture = { host: HOST, yanked: false, reads: 0, catalog: 0, sends: [] };
globalThis.__r10HostFixture = fixture;
const exportsBySpec = new Map();
for (const m of fs.readFileSync(hostURL, "utf8").matchAll(/^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/gm)) {
  if (!m[2].startsWith(".") || m[2] === "./protected-supervisor.mjs") continue;
  const names = m[1].trim().startsWith("{") ? m[1].replace(/[{}]/g, "").split(",").map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean) : [];
  exportsBySpec.set(m[2], names);
}
const implementations = {
  desktopReleaseFromEnv: "()=>null",
  loadCaps: "()=>({caps:{paused:false,cpuShare:1,gpuShare:1},error:null})",
  hostAdmissionFromEnv: "()=>null",
  createHostServiceGate: "()=>({enabled:false,serviceRefusal:()=>null,newWorkRefusal:()=>null})",
  shieldStartupEnvelope: "()=>null",
};
// TEST chain.mjs double: every financial send is an INERT spy (recorded, never signed); retired ledger/catalog reads are counted
const chainSource = `const f=globalThis.__r10HostFixture;
 export const enclaveIdOf=()=>f.host,setLeaseJournal=()=>{},rpcUrls=()=>[],addressBook=()=>({}),setLeaseRelayPolicy=()=>{},addresses={};
 export const resolvePendingReleases=async()=>[],releaseHold=()=>null,parseEnvelope=()=>({}),effectiveCpuShare=()=>0,placementRefusal=()=>null;
 export const operatorAddress=()=>'0x'+'12'.repeat(20),resolveAddresses=async()=>{},shareRamMiB=(p,s)=>Math.floor(p*s),renewLeadMs=async()=>60000;
 export const readDeployment=async(id)=>{f.reads++;return {active:true,runner:f.host,leaseUntil:Math.floor(Date.now()/1000)+30,appRef:'fixture',configCid:'',cpuMilli:250,gpuMilli:0,owner:'0x'+'11'.repeat(20),isPublic:true};};
 export const resolveAppRef=async()=>{f.catalog++;return {yanked:f.yanked};};
 export const claimableBy=async()=>true;
 export const claimDeployment=async(id,gate)=>{f.sends.push(['claim',id]);return '0xTEST';};
 export const renewDeployment=async(id,{gate}={})=>{const stale=gate?.();f.sends.push(['renew',id,stale||null]);if(stale){const e=Error(stale);e.superseded=true;throw e;}};
 export const releaseDeployment=async(id)=>{f.sends.push(['release',id]);return '0xTEST';};`;
const hooks = registerHooks({ resolve(spec, ctx, next) {
  if (ctx.parentURL !== hostURL.href || !spec.startsWith(".") || spec === "./protected-supervisor.mjs") return next(spec, ctx);
  let source;
  if (spec === "./chain.mjs") source = chainSource;
  else if (spec === "./isolation-client.mjs") source = "export class IsolationManagerClient { constructor(){} static spawnBody(s){return {...s};} async health(){return null;} async list(){return [];} async findByName(){return null;} }";
  else if (spec === "./isolation-lifecycle.mjs") source = "export const reconcile=()=>{throw Error('TEST unexpected actual stage');};";
  else {
    const names = exportsBySpec.get(spec); if (!names) throw Error("TEST unlisted dependency " + spec);
    source = names.map((name) => `export const ${name}=${implementations[name] || `(...args)=>{throw Error(${JSON.stringify("TEST unexpected dependency " + spec + ":" + name)});}`};`).join("\n");
  }
  return { url: "data:text/javascript;base64," + Buffer.from(source).toString("base64"), shortCircuit: true };
} });
const { Host } = await import(hostURL.href);

function enroll(dir, deployments, { corrupt = false } = {}) {
  const policy = { schema: supervisor.ENROLLMENT_SCHEMA, host: HOST, manager: "http://127.0.0.1:41", controlKeyFile: path.join(dir, "TEST-key"), deployments, stagingMs: 30000 };
  const bytes = Buffer.from(JSON.stringify(policy)), file = path.join(dir, "enrollment.json");
  fs.writeFileSync(file, bytes); fs.writeFileSync(policy.controlKeyFile, "11".repeat(32), { mode: 0o600 });
  process.env.ENCLAVE_PROTECTED_ENROLLMENT = file;
  process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256 = corrupt ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex");
}
function makeHost(t, { deployments = [DEP], corrupt = false } = {}) {
  supervisor.TEST_resetProtectedComposition(); Object.assign(fixture, { yanked: false, reads: 0, catalog: 0, sends: [] });
  const dir = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "r10host-"));
  enroll(dir, deployments, { corrupt });
  const host = new Host({ dir, endpoint: "TEST", appsEnabled: true, ownerStartup: null, walletAdmission: null });
  host.chainReady = true; host.registered = {};
  for (const name of ["followBook", "enforceOff", "refreshOwners", "ensureRegistered", "ensurePriced", "scanLedger", "retireForeignRecovered"]) host[name] = async () => {};
  host.sharesCoupled = () => false;
  const reached = [];
  host.isolationVerdict = async (id) => { reached.push(id); return { ok: false, unknown: true, input: "TEST", why: "reachability probe; no stage permitted" }; };
  t.after(() => { delete process.env.ENCLAVE_PROTECTED_ENROLLMENT; delete process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256; supervisor.TEST_resetProtectedComposition(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { host, reached, dir };
}

// ---- part A: actual Host + actual supervisor + labelled TEST owned runtime --------------------------------------------------------------
const snapOf = (state, extra = {}) => ({ id: DEP, verified: true, proofVerified: true, forPrivate: false,
  assignment: { deployment: DEP, proofVerified: true, state, host: HOST, generation: 1 },
  resources: { cpuMilli: 250, gpuMilli: 0, cpuShare: 0.25, gpuShare: 0, version: { memMb: 512, cpuGflops: 0, vramMb: 0, gpuGflops: 0, config: "" } },
  content: { appRef: `catalog://${H("aa")}/1`, cid: "bafyTESTcontent", createdAt: "1" },
  envelope: { configCid: "", owner: A("11") },
  listing: { delisted: fixture.yanked, yanked: fixture.yanked, approval: 1, moderation: "host-owner-elected" }, ...extra });
function composeTest(snapshot) {
  const calls = [];
  Object.assign(supervisor.composition, { hostId: HOST, collect: async () => null,
    controlFor: () => ({ request: async () => ({ status: 503, body: {} }) }),          // TEST manager control: never available
    store: { owned: true, load: () => null, save: () => {}, assertLive: () => {} },      // TEST obligation store
    openRuntime: async ({ bind }) => {
      bind({ gate: { entries: new Map() }, pins: {} });
      const rec = (op) => async (id) => { calls.push([op, id]); return op === "fence" ? true : { absent: true, held: true }; };
      return { gate: {}, pins: {}, release: async () => ({ released: true }), snapshot: async (id) => snapshot(id),
        runtime: { fence: rec("fence"), revokeAuthority: rec("revoke"), revokeHostAuthority: rec("offline"), stop: async (id) => { calls.push(["stop", id]); return true; },
          ensureStaged: async (id) => { calls.push(["stage", id]); return { ready: false }; }, health: async () => ({ ready: false }), serve: async () => {} },
        handoff: { owns: () => true, activated: () => true, why: () => null, activate: async () => {}, newWorkRefusal: () => null,
          observe: async (id) => { calls.push(["observe", id]); } } };
    } });
  return calls;
}

test("r10 carried ROOT positive control: authenticated queued snapshot reaches the plan with ZERO retired ledger/catalog reads", async (t) => {
  const { host, reached } = makeHost(t); composeTest(() => snapOf("queued"));
  await host.tick();
  assert.deepEqual(reached, [DEP]);
  assert.equal(fixture.reads, 0, "no retired ledger row read for an enrolled route");
  assert.equal(fixture.catalog, 0, "no publisher catalog read for an enrolled route");
  assert.equal(host.records.get(DEP).envelope, "", "configuration recorded from the authenticated snapshot");
});
test("r10 carried ROOT: publisher yank/delist does not veto unchanged owner-authorized content", async (t) => {
  const { host, reached } = makeHost(t); fixture.yanked = true; composeTest(() => snapOf("queued"));
  await host.tick();
  assert.deepEqual(reached, [DEP], "publisher metadata must not block independent reconciliation");
});
test("r10 carried ROOT: retired book failure and chain-unready do not precede or prevent independent reconciliation", async (t) => {
  const { host, reached } = makeHost(t); composeTest(() => snapOf("queued"));
  host.followBook = async () => { throw Error("TEST retired book unavailable"); };
  await assert.rejects(host.tick(), /retired book unavailable/, "the legacy pass still reports its own failure");
  assert.deepEqual(reached, [DEP]);
  host.chainReady = false; reached.length = 0;
  await host.tick();
  assert.deepEqual(reached, [DEP], "cold recovery without the retired chain services");
});
test("r10 canonical Stop withdraws BEFORE (and without) a new-work plan, despite catalog/book failure", async (t) => {
  const { host, reached } = makeHost(t); const calls = composeTest(() => snapOf("stopped"));
  host.followBook = async () => { throw Error("TEST retired book unavailable"); };
  host.isolationVerdict = async () => { throw Error("TEST failed new-work plan must not be needed for withdrawal"); };
  await host.tick().catch(() => {});
  assert.deepEqual(calls.filter(([op]) => op === "revoke"), [["revoke", DEP]]);
  assert.deepEqual(reached, []);
  assert.equal(host.records.get(DEP).status, "stopped"); assert.match(host.records.get(DEP).reason, /compute confirmed absent/);
  assert.equal(fixture.reads + fixture.catalog, 0); assert.deepEqual(fixture.sends, [], "local withdrawal is not a ledger transaction");
});
test("r10 canonical Offline (proof-verified, this host) revokes host authority; unknown authority only fences", async (t) => {
  const { host } = makeHost(t);
  let snap = () => snapOf("running", { hostAuthorityEvidence: { proofVerified: true, status: "offline", context: { hostId: HOST } } });
  const calls = composeTest((id) => snap(id));
  await host.protectedTick();
  assert.deepEqual(calls.filter(([op]) => op === "offline"), [["offline", DEP]]);
  calls.length = 0; snap = () => { throw Error("TEST stale derived evidence"); };
  await host.protectedTick();
  assert.deepEqual(calls, [["fence", DEP]], "unknown authority fences only: no invented Stop/Offline, obligations kept");
  assert.equal(host.records.get(DEP).status, "held");
});
test("r10 carried ROOT: recovered/pending lifecycle commitments count alongside ordinary neighbours", (t) => {
  const { host } = makeHost(t);
  host.records.set("neighbor", { id: "neighbor", status: "running", cpuShare: 0.2, gpuShare: 0.1 });
  host.lifecycleView().record(DEP, { id: DEP, status: "held", lifecycleAllocated: true, lifecycleCapacity: "committed", cpuShare: 0.4, gpuShare: 0.3 });
  assert.equal(host.shareUse().cpu, 0.2 + 0.4);
  assert.equal(host.lifecycleView().capacity("new").gpuUsed, 0.1 + 0.3);
});
test("r10 malformed/hash-mismatched enrollment: zero legacy claim/renew/release across tick, keeper and claim; tracking retained", async (t) => {
  const { host } = makeHost(t, { deployments: [DEP], corrupt: true });
  assert.equal(supervisor.enrollmentState(), "unknown");
  host.tracked.add(NEIGHBOR); host.records.set(NEIGHBOR, { id: NEIGHBOR, status: "running", cpuShare: 0.1, leaseUntil: Math.floor(Date.now() / 1000) + 30 });
  await host.tick();
  assert.equal(host.records.get(NEIGHBOR).status, "held"); assert.match(host.records.get(NEIGHBOR).reason, /enrollment policy unreadable/);
  assert.equal(host.tracked.has(NEIGHBOR), true, "obligation retained");
  const r = await host.renewDue(); assert.deepEqual(r.renewed, []);
  const c = await host.consider(NEIGHBOR); assert.equal(c.accepted, false);
  assert.deepEqual(fixture.sends, [], "no legacy financial send of any kind on an unknown policy");
  assert.equal(fixture.reads, 0, "the legacy reconcile was not entered");
});

// ---- part B: actual Host.lifecycleView() + REAL r18 owned factory/journals/dispatch (capacity recovery) --------------------------------
const FLOCK = "/usr/bin/flock", CTRL = A("c7"), REG = A("ab"), CODE = H("23"), LEDGER = A("e2"), OLD = A("e1"), PROFILE = "independent-host-registry-r1";
const BUNDLE = "bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e", ARTIFACT = "e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a";
const route = (deployment) => ({ deployment, oldLedger: OLD, newLedger: LEDGER, controller: CTRL, deploymentsSchema: 17, lifecycleSchema: 3,
  ledgerCodeHash: H("11"), controllerCodeHash: H("22"), quiescenceDigest: H("f1"), profile: PROFILE, bundleSha256: BUNDLE,
  hostRegistry: REG, hostRegistryCodeHash: CODE, hostRegistryArtifactSha256: ARTIFACT });
test("r10 REAL dispatch + actual Host: cold unresolved allocation holds legacy AND lifecycle starts; max commitment kept across shrink/unknown; released only on evidence",
  { timeout: 20000 }, async (t) => {
  if (!fs.existsSync(FLOCK)) { t.skip("Linux flock unavailable (R18 Linux lock implementation)"); return; }
  const { host, dir } = makeHost(t, { deployments: [DEP] });
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const write = (name, value) => { const file = path.join(dir, name), bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    fs.writeFileSync(file, bytes, { mode: 0o600 }); return { file, sha256: sha(bytes) }; };
  const reader = write("reader.mjs", "export async function createAnchorReader(){return async()=>{throw Error('TEST anchor not read here')}}");
  const qv = write("quiescence.mjs", `export async function createQuiescenceVerifier(o, cap){ return async (r) => ({ label: 'TEST fixture quiescence evidence',
    verified: true, proofVerified: true, authorityTier: 'l1-finalized-derived', deployment: r.deployment, ledger: r.oldLedger, quiescent: true, digest: r.quiescenceDigest }); }`);
  const cfg = { schema: factory.AUTHORITY_SCHEMA, host: HOST, journalFile: path.join(dir, "parent.json"), parentImportSha256: null,
    incarnationFile: path.join(dir, "inc.json"), permitFile: path.join(dir, "permit.json"),
    pins: write("pins.json", { chainId: 8453, lifecycle: CTRL, servingPermit: { version: 2, profile: PROFILE } }),
    adapterPins: write("adapter-pins.json", { chainId: 8453, host: HOST, profile: PROFILE, payee: A("99"), hostRegistry: { artifactSha256: ARTIFACT }, contracts: {
      registry: { address: REG, codeHash: CODE }, hostOwnership: { address: REG, codeHash: CODE }, ledger: { address: LEDGER, codeHash: H("11") },
      lifecycle: { address: CTRL, codeHash: H("22") }, catalog: { address: A("cd"), codeHash: H("24") } } }),
    witnesses: { endpoints: [], timeoutMs: 1000 }, operatorKeyFile: write("public-test-key.txt", "0x" + "11".repeat(32)).file,
    finality: { readerModule: reader.file, readerModuleSha256: reader.sha256, readerOptions: {}, verifier: { url: "http://127.0.0.1:1" }, maxAnchorAgeSec: 3600 },
    hostPolicyDir: dir, platformWallets: [], capacityHeadroom: 0, lock: { flockPath: FLOCK, timeoutMs: 1000, withdrawDeadlineMs: 1000 },
    routes: [route(DEP)], quiescence: { verifierModule: qv.file, verifierModuleSha256: qv.sha256, verifierOptions: {} } };
  const c = write("authority.json", cfg);
  const never = (label) => async () => { throw Error(`TEST: ${label} must not run here`); };
  const adapter = { authorityKind: "derived", profile: PROFILE, lifecycleSchema: 3, lifecycleProofSchema: 2, bundleSha256: BUNDLE,
    hostRegistry: { address: REG, runtimeCodeHash: CODE, artifactSha256: ARTIFACT }, independence: { complete: false, blockers: ["TEST canonical adapter stand-in"] },
    read: never("chain read"), prepare: never("prepare"), submit: never("submit"), resolve: never("resolve"), finalize: never("finalize") };
  const modules = { owned: await import("../../control/network/lifecycle-host-owned-authority.mjs"), hostAuthority: await import("../../control/network/deployment-host-authority.mjs"),
    accounts: { privateKeyToAccount: () => ({ address: A("12") }) }, chain: { createLifecycleChainAdapter: () => adapter },
    finality: { createLifecycleFinalitySnapshot: () => never("finality") }, collector: { createPermitCollector: () => never("permit collection") } };
  // TEST manager inventory: the dispatch's observe() reads it; unknown -> throws
  let inventory = "unknown"; const stages = [];
  const adapters = { client: { findByName: async (id) => { if (inventory === "unknown") throw Error("TEST inventory unknown"); return inventory === "present" ? { id: "vmTEST", name: id } : null; },
      spawn: async () => { stages.push("spawn"); throw Error("TEST no spawn"); }, remove: never("remove") },
    plans: { read: never("plan") }, readiness: { verify: never("readiness") }, boundaries: { hold: never("hold"), allow: never("allow") }, collectPermit: never("permit") };
  host.records.set(NEIGHBOR, { id: NEIGHBOR, status: "running", cpuShare: 0.5, gpuShare: 0 });   // ordinary running neighbour
  await factory.composeProtectedAuthority({ hostId: HOST, hostView: host.lifecycleView(), modules,
    env: { ENCLAVE_PROTECTED_ENROLLMENT: process.env.ENCLAVE_PROTECTED_ENROLLMENT, ENCLAVE_PROTECTED_AUTHORITY: c.file, ENCLAVE_PROTECTED_AUTHORITY_SHA256: c.sha256 } });
  const opened = await supervisor.composition.openRuntime({ host: HOST, deployments: [DEP], bind: () => adapters });
  try {
    assert.equal(opened.handoff.activated(DEP), true);
    // COLD: the route's allocation is unresolved -> legacy new work held on the actual Host; a lifecycle start refused with nothing staged
    const cold = await host.consider(H("c9"));
    assert.equal(cold.accepted, false); assert.match(cold.reason, /capacity recovery unresolved|not yet observed/);
    await assert.rejects(opened.runtime.ensureStaged(DEP, snapOf("queued")), /lifecycle start refused/);
    assert.deepEqual(stages, []); assert.deepEqual(fixture.sends, []);
    // unknown inventory keeps it unresolved
    await opened.handoff.observe(DEP, snapOf("queued"));
    assert.match(await host.consider(H("c9")).then((r) => r.reason), /capacity recovery unresolved|manager inventory unknown/);
    // a recovered VM is listed: committed at the AUTHENTICATED share (0.25) beside the neighbour (0.5)
    inventory = "present"; await opened.handoff.observe(DEP, snapOf("queued"));
    assert.equal(opened.handoff.state()[0].allocation.state, "committed");
    assert.equal(host.shareUse().cpu, 0.5 + 0.25);
    // SHRINK while the VM may run: the larger confirmed commitment is kept; an unknown read keeps it too
    const shrunk = snapOf("queued"); shrunk.resources = { ...shrunk.resources, cpuMilli: 100, cpuShare: 0.1 };
    await opened.handoff.observe(DEP, shrunk); assert.equal(host.shareUse().cpu, 0.5 + 0.25);
    inventory = "unknown"; await opened.handoff.observe(DEP, shrunk); assert.equal(host.shareUse().cpu, 0.5 + 0.25);
    // released only on evidence: a definite absent listing with no start effect/commitment here
    inventory = "absent"; await opened.handoff.observe(DEP, shrunk);
    assert.equal(opened.handoff.state()[0].allocation.state, "none"); assert.equal(host.shareUse().cpu, 0.5);
    assert.equal(host.lifecycleView().capacity(H("c9")).cpuUsed, 0.5);
    assert.deepEqual(fixture.sends, [], "no financial send in local capacity recovery");
  } finally {
    assert.equal((await opened.release("TEST cleanup")).released, true);
  }
});

// ---- permit r11 additions (AUTHORED, NOT RUN). Same actual Host/supervisor and labelled TEST external runtime as part A. ----------------
test("r11 (root r10 FAIL carried): a held plan on one route does not delay another route's authenticated Stop; progress resumes after", async (t) => {
  const OTHER = H("d2");
  const { host } = makeHost(t, { deployments: [DEP, OTHER] });
  let stopped = false, unblock, entered, plans = 0;
  const held = new Promise((r) => { unblock = r; });
  const atPlan = new Promise((r) => { entered = r; });
  const calls = composeTest((id) => snapOf(stopped && id === OTHER ? "stopped" : "queued",
    { id, assignment: { deployment: id, proofVerified: true, state: stopped && id === OTHER ? "stopped" : "queued", host: HOST, generation: 1 } }));
  host.isolationVerdict = async (id) => {
    if (id === DEP) { plans++; entered(); await held; }
    return { ok: false, unknown: true, input: "TEST", why: "held plan; no stage" };
  };
  const first = host.protectedTick();
  await atPlan;
  stopped = true;
  const second = host.protectedTick();
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(calls.some(([op, id]) => op === "revoke" && id === OTHER), "the other route's Stop is processed while DEP's plan is held");
    assert.equal(host.records.get(OTHER).status, "stopped");
    assert.equal(plans, 1, "the second pass started NO duplicate new work for DEP while its first is in flight");
  } finally { unblock(); await Promise.all([first, second]); }
  await host.protectedTick();   // DEP's lane is free again: positive progress resumes (a fresh plan), still no duplicate
  assert.equal(plans, 2);
  assert.deepEqual(fixture.sends, [], "no lease claim/renew/release for enrolled routes");
});
test("r11: a hung authority read on one route is bounded for the pass, joined (never doubled) next pass, other route still withdrawn", { timeout: 40000 }, async (t) => {
  const OTHER = H("d3");
  const { host } = makeHost(t, { deployments: [DEP, OTHER] });
  let release, reads = 0;
  const hang = new Promise((r) => { release = r; });
  const calls = composeTest(async (id) => {
    if (id === DEP) { reads++; await hang; }
    return snapOf(id === OTHER ? "stopped" : "queued", { id, assignment: { deployment: id, proofVerified: true, state: id === OTHER ? "stopped" : "queued", host: HOST, generation: 1 } });
  });
  const started = Date.now();
  await host.protectedTick();   // returns after the per-route bound even though DEP's snapshot read hangs
  assert.ok(Date.now() - started < 30000);
  assert.ok(calls.some(([op, id]) => op === "revoke" && id === OTHER));
  assert.match(host.records.get(DEP).reason, /still in progress/);
  const p = host.protectedTick();
  release(); await p;
  assert.equal(reads, 1, "the hung pass was joined, not restarted beside itself");
});
test("r11: an enrollment policy corrupted after establishment still withdraws an enrolled route but starts no new work", async (t) => {
  const { host } = makeHost(t, { deployments: [DEP] });
  let state = "queued";
  const calls = composeTest((id) => snapOf(state, { id, assignment: { deployment: id, proofVerified: true, state, host: HOST, generation: 1 } }));
  await host.protectedTick();
  fs.writeFileSync(process.env.ENCLAVE_PROTECTED_ENROLLMENT, "{}");   // corrupt AFTER the policy was established
  const before = calls.filter(([op]) => op === "stage").length;
  await host.protectedTick();
  assert.equal(calls.filter(([op]) => op === "stage").length, before, "no new stage under an unknown policy");
  state = "stopped";
  await host.protectedTick();
  assert.ok(calls.some(([op, id]) => op === "revoke" && id === DEP), "authenticated Stop still withdraws under the established policy");
  assert.deepEqual(fixture.sends, []);
});
test("r11 actual admittedRuntime: stages the admission's FRESH snapshot and discharges the reservation only on terminal evidence", async () => {
  // TEST dispatch double (the real dispatch's settleStart/startChange evidence rules need the root host-registry fixture; see report)
  const planned = snapOf("queued"), fresh = { ...snapOf("queued"), TESTfresh: true };
  const seen = [], settled = [];
  const dispatch = { admitStart: async () => ({ id: DEP, snapshot: fresh }), settleStart: async (id, adm, o) => { settled.push(o.rawUnknown); return o.rawUnknown === false; },
    confirmRetired: () => {}, confirmPresent: () => {} };
  let outcome = { ready: false, ended: true, instance: "boot:TEST" };
  const runtime = { ensureStaged: async (id, s) => { seen.push(s); if (outcome instanceof Error) throw outcome; return outcome; } };
  const rt = factory.admittedRuntime(runtime, dispatch, { snapshotOf: (raw) => ({ ...raw, TESTprotected: true }) });
  const r = await rt.ensureStaged(DEP, planned);
  assert.equal(seen[0].TESTfresh, true); assert.equal(seen[0].TESTprotected, true, "fresh raw read converted like the supervisor's snapshot");
  assert.equal(r.capacityReleased, true); assert.deepEqual(settled, [false]);
  outcome = { ready: false, ended: false, reason: "launch outcome unknown" };
  await rt.ensureStaged(DEP, planned); assert.deepEqual(settled, [false], "unknown launch keeps the reservation (no settle)");
  outcome = Error("TEST verified-plan refusal");
  await assert.rejects(rt.ensureStaged(DEP, planned, { rawUnknown: () => true }), /verified-plan/);
  assert.deepEqual(settled, [false, true], "a throw with an unknown raw stage never releases");
  await assert.rejects(rt.ensureStaged(DEP, planned, { rawUnknown: () => false }), /verified-plan/);
  assert.deepEqual(settled, [false, true, false]);
});
test.after(() => { hooks.deregister(); delete globalThis.__r10HostFixture; });
