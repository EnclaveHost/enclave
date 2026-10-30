// permit r12 FIRST DELIVERABLE (AUTHORED, NOT RUN). The real consumer positive, then the admission/withdrawal races on the same rig.
// ACTUAL, nothing replaced or source-extracted: Host class (tick/protectedTick -> private #protectedPass/#protectedLaunch/#isolationReconcile,
//   isolationVerdict -> node-bridge isolationPlan, lifecycleView) -> isolation-lifecycle.reconcile -> protected-supervisor (pinned enrollment,
//   authority lanes, live new-work fence) -> composeProtectedAuthority (pinned config, forbidden-capability scan, hash-pinned reader/verifier
//   modules) -> R18 openOwnedHostRegistryLifecycle (owned parent + incarnation + permit journals under flock) -> real dispatch attach/activate/
//   observeRoute/admitStart/settleStart -> DeploymentPermitGate + createIsolationLifecycleRuntime -> ProtectedIsolationClient -> GuestdControl
//   (real handshake/MAC) -> router CompositeManager (snapshot/precheck/admission/attest/observePending) -> legacy ProtectedManager +
//   native-role Manager -> guard -> router dataServer splice -> TCP echo.
// TEST FIXTURES, each labelled and limited to EXTERNAL inputs: (1) chain: the canonical adapter's read() returns authenticated-snapshot
//   INPUTS (the real dispatch/factory still decide: route binding, decision keys, floors, incarnation, start identity); (2) owner-selected
//   quiescence verifier module; (3) owner-selected witness collector module signing with PUBLIC TEST witness keys (world.mjs WITNESSES);
//   (4) Host's external services at import (chain.mjs ledger/financial sends are INERT spies, relay secrets probe, caps file, platform gate);
//   (5) JSON "Hyper-V" inventories + launcher/readiness doubles, TEST host headroom; (6) public TEST operator key. No signing of
//   transactions, no network beyond loopback, no funds. Linux flock + TEST hardware are NOT Windows/native qualification.
// FIXTURE-UNVERIFIED (stated plainly; root's first run qualifies these, a mismatch is a FIXTURE correction, never a product bypass):
//   (a) the host admission decision object (DECISION_KEYS + hostIncarnation shape) the owned authority derives from the adapter read;
//   (b) the Host plan inputs (appConfig strict fetch of an empty configCid, isolationPlan over the TEST component vector) producing the
//       exact spawn body the router/manager precheck accepts. The author did not execute or fully source-trace either in this pass.
// ZERO periodic on-chain renewal/heartbeat: the serving permit refresh is OFF-CHAIN (owner-selected witnesses); fixture.sends must stay [].
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto, { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { HyperVPartitionBackend } from "../../control/windows/vbslike/manager/backend.mjs";
import { startManager } from "../../control/windows/vbslike/manager/server.mjs";
import { ProtectedManager } from "../../control/windows/vbslike/manager/protected-manager.mjs";
import { composeProtected, dataLookup } from "../../control/windows/vbslike/manager/compose.mjs";
import { type1VmMemMiB } from "../../control/windows/vbslike/manager/wmi-launcher.mjs";
import { CONFIG_SCHEMA, TEST_QUALIFICATION } from "../../control/windows/vbslike/manager/permit-enforcement.mjs";
import { openOwnedLog, initializeOwnedLog, TEST_inProcessExclusion } from "../../control/windows/vbslike/manager/win-durable.mjs";
import { openPermitJournal } from "../../control/windows/vbslike/manager/permit-journal.mjs";
import { GuardClient } from "../../control/windows/vbslike/guard/guard-client.mjs";
import { dataPlaneFor } from "../../control/windows/vbslike/datapath/node-bridge.mjs";
import { CompositeManager, LaunchJournal } from "../../control/windows/vbslike/router/control.mjs";
import { makeRequest, controlServer, dataServer } from "../../control/windows/vbslike/router/io.mjs";
import * as supervisor from "../../control/windows/node/protected-supervisor.mjs";
import * as factory from "../../control/windows/node/protected-authority-factory.mjs";
import { ownedObligationStore, OBLIGATION_PURPOSE } from "../../control/windows/node/protected-isolation.mjs";
import { PINS, HOST, KEY, vectors, tmp, writeInv, readInv, testLauncher, echoServer, startGuard, selfIdentity, envelope, waitFor } from "./helpers/world.mjs";

const FLOCK = "/usr/bin/flock";
const H = (b) => "0x" + b.repeat(32), A = (b) => "0x" + b.repeat(20);
const DEP = H("d1"), NEIGHBOUR = H("77");
const CTRL = A("c7"), REG = A("ab"), CODE = H("23"), LEDGER = A("e2"), OLD = A("e1"), PROFILE = "independent-host-registry-r1";
const BUNDLE = "bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e", ARTIFACT = "e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a";
const POOLS = Object.freeze({ ramPoolMiB: 16 * 1024, cpuPoolVcpus: 4, physicalRamPoolMiB: 24 * 1024 });
const route = (deployment) => ({ deployment, oldLedger: OLD, newLedger: LEDGER, controller: CTRL, deploymentsSchema: 17, lifecycleSchema: 3,
  ledgerCodeHash: H("11"), controllerCodeHash: H("22"), quiescenceDigest: H("f1"), profile: PROFILE, bundleSha256: BUNDLE,
  hostRegistry: REG, hostRegistryCodeHash: CODE, hostRegistryArtifactSha256: ARTIFACT });

// ---- (4) Host's external services: replaced at import for host.mjs ONLY; isolation client/lifecycle/node-bridge/protected-* stay REAL ----
const hostURL = new URL("../../control/windows/node/host.mjs", import.meta.url);
const fixture = { host: HOST, sends: [], reads: 0 };
globalThis.__r12ConsumerFixture = fixture;
const REAL = new Set(["./protected-supervisor.mjs", "./isolation-client.mjs", "./isolation-lifecycle.mjs", "../vbslike/datapath/node-bridge.mjs",
  "../vbslike/datapath/partition-offers.mjs", "../../relay/shield-desktop-derive.mjs"]);
const exportsBySpec = new Map();
for (const m of fs.readFileSync(hostURL, "utf8").matchAll(/^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/gm)) {
  if (!m[2].startsWith(".") || REAL.has(m[2])) continue;
  exportsBySpec.set(m[2], m[1].trim().startsWith("{") ? m[1].replace(/[{}]/g, "").split(",").map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean) : []);
}
const implementations = { desktopReleaseFromEnv: "()=>null", loadCaps: "()=>({caps:{paused:false,cpuShare:1,gpuShare:1},error:null})", hostAdmissionFromEnv: "()=>null",
  createHostServiceGate: "()=>({enabled:false,serviceRefusal:()=>null,newWorkRefusal:()=>null})", shieldStartupEnvelope: "()=>null",
  secretsExist: "async()=>false", fetchSecrets: "async()=>null", parseWaf: "()=>({})", forget: "()=>{}" };
const chainSource = `const f=globalThis.__r12ConsumerFixture;
 export const enclaveIdOf=()=>f.host,setLeaseJournal=()=>{},setOperatorWriteJournal=()=>{},setSponsoredObligations=()=>{},rpcUrls=()=>[],addressBook=()=>({}),setLeaseRelayPolicy=()=>{},addresses={};
 export const resolvePendingReleases=async()=>[],releaseHold=()=>null,parseEnvelope=()=>({}),effectiveCpuShare=()=>0,placementRefusal=()=>null,isolationForBackend=()=>false;
 export const operatorAddress=()=>'0x'+'12'.repeat(20),resolveAddresses=async()=>{},shareRamMiB=(p,s)=>Math.floor(p*s),renewLeadMs=async()=>60000;
 export const readDeployment=async()=>{f.reads++;throw Error('TEST: an enrolled route never reads the retired ledger row');};
 export const resolveAppRef=async()=>{f.reads++;throw Error('TEST: no publisher catalog read for an enrolled route');};
 export const claimableBy=async()=>false;
 export const claimDeployment=async(id)=>{f.sends.push(['claim',id]);throw Error('TEST inert');};
 export const renewDeployment=async(id)=>{f.sends.push(['renew',id]);throw Error('TEST inert');};
 export const releaseDeployment=async(id)=>{f.sends.push(['release',id]);throw Error('TEST inert');};`;
const hooks = registerHooks({ resolve(spec, ctx, next) {
  if (ctx.parentURL !== hostURL.href || !spec.startsWith(".") || REAL.has(spec)) return next(spec, ctx);
  let source;
  if (spec === "./chain.mjs") source = chainSource;
  else {
    const names = exportsBySpec.get(spec);
    if (!names) return next(spec, ctx);   // a dynamic import not listed statically: the REAL module
    source = names.map((n) => `export const ${n}=${implementations[n] || `(...a)=>{throw Error(${JSON.stringify("TEST unexpected dependency " + spec + ":" + n)});}`};`).join("\n");
  }
  return { url: "data:text/javascript;base64," + Buffer.from(source).toString("base64"), shortCircuit: true };
} });
const { Host } = await import(hostURL.href);
test.after(() => { hooks.deregister(); delete globalThis.__r12ConsumerFixture; });

function confirmingLauncher(opts) {   // (5) TEST launcher confirming the exact type-1 allocation the manager reserved
  const l = testLauncher(opts), start = l.start.bind(l);
  l.start = async (mapping, o) => ({ ...(await start(mapping, o)), memory: { vmMiB: type1VmMemMiB(o.appMemoryMiB ?? mapping.record.policy.memMiB, { name: o.identity.name, appId: o.identity.appId }) } });
  return l;
}
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", r));
const sha = (b) => createHash("sha256").update(b).digest("hex");

async function rig(t) {
  supervisor.TEST_resetProtectedComposition();
  const dir = tmp(t), { record, component } = vectors(), relayPort = await echoServer(t);
  const judgeReady = async () => ({ status: "running", transportKeySha256: KEY, checks: { document: { verdict: "TEST" } } });
  // ---- actual managers / guard / router (the r7 composite rig, unchanged) ----
  const inventory = path.join(dir, "inventory.json"); writeInv(inventory, { vms: [] });
  const legacy = new ProtectedManager({ backend: new HyperVPartitionBackend({ launcher: confirmingLauncher({ file: inventory, relayPort }) }), runtimeId: record.runtimeId,
    fetchComponent: async () => component, judgeReady, ...POOLS });
  await startManager(legacy);
  const jfile = path.join(dir, "permit.log"); initializeOwnedLog(jfile, { purpose: "enclave-manager-permit/1" });
  const log = openOwnedLog(jfile, { purpose: "enclave-manager-permit/1", exclusion: TEST_inProcessExclusion() }); t.after(() => { try { log.release(); } catch {} });
  const g = await startGuard(t, dir, { inventory });
  const guard = await GuardClient.connect({ path: g.socket, key: g.key, identity: { ...selfIdentity(), epoch: legacy.epoch } }); t.after(() => guard.close());
  let enforcement = null;
  const dp = dataPlaneFor(dataLookup(legacy, () => enforcement)); await listen(dp.server); t.after(() => dp.server.close());
  const controlKey = crypto.randomBytes(32), routerKey = crypto.randomBytes(32);
  const computeRemover = { label: "TEST-independent-remover", async survey() { return readInv(inventory); },
    async removeById(vmId) { const j = readInv(inventory), n = j.vms.length; j.vms = j.vms.filter((v) => v.vmId !== vmId); writeInv(inventory, j); return n === j.vms.length ? { found: false, removed: false } : { found: true, removed: true }; } };
  const managerAuthority = { qualification: "TEST manager-side authority view (the node's authority is the owned factory below)", read: async (id) => chainRead(id) };
  const c = await composeProtected({ manager: legacy, enforcementConfig: { schema: CONFIG_SCHEMA, pins: PINS, host: HOST, maxStagingMs: 60_000, derivations: ["enclave-catalog-bundle/1"], qualification: TEST_QUALIFICATION, retryMs: 200 },
    journal: openPermitJournal(log), guard, authority: managerAuthority, dataPlane: dp, computeRemover, controlKey, routerKey });
  enforcement = c.enforcement;
  await listen(c.server); t.after(async () => { c.server.closeAllConnections(); await new Promise((r) => c.server.close(r)); });
  const rfile = path.join(dir, "router.log"); LaunchJournal.initialize(rfile); const rjournal = new LaunchJournal(rfile);
  const headroom = { freeMiB: 64 * 1024 };   // (5) TEST host physical headroom
  const router = new CompositeManager({ journal: rjournal, nativePins: null, availableMemoryMiB: async () => headroom.freeMiB, attestKey: routerKey,
    request: makeRequest({ legacyPort: c.server.address().port, nativePort: 1 }) });
  const rsrv = controlServer(router); await listen(rsrv); t.after(async () => { rsrv.closeAllConnections(); await new Promise((r) => rsrv.close(r)); });
  const compositeDp = dataServer({ legacyPort: dp.server.address().port, nativePort: 1 }); await listen(compositeDp.server); t.after(() => compositeDp.close());
  const routerBase = `http://127.0.0.1:${rsrv.address().port}`;
  // ---- (1) chain fixture: authenticated snapshot INPUTS for the canonical adapter; the state is driven by the test ----
  const chain = { state: "queued", generation: 4, revision: "1", cpuMilli: 250, configCid: "", hostStatus: "online", sequenceSeen: [] };
  const chainRead = async (id) => ({ id, ledger: LEDGER, controller: CTRL, thisHost: HOST, verified: true, proofVerified: true, authorityTier: "l1-finalized-derived",
    forPrivate: false, label: "TEST chain fixture (authenticated snapshot inputs)",
    assignment: { state: chain.state, host: HOST, generation: chain.generation, revision: 1, policyRevision: 1 },
    resources: { cpuMilli: chain.cpuMilli, gpuMilli: 0, cpuShare: chain.cpuMilli / 1000, gpuShare: 0, version: { memMb: 512, cpuGflops: 0, vramMb: 0, gpuGflops: 0, config: "" } },
    content: { appRef: `catalog://${H("aa")}/1`, cid: record.cid ?? "bafyTESTcontent", createdAt: "1" },
    envelope: { configCid: chain.configCid, owner: A("11") },
    hostIncarnation: { hostId: HOST, registry: REG, registryCodeHash: CODE, generation: "1", digest: H("9a"), status: chain.hostStatus },
    hostAuthorityEvidence: chain.hostStatus === "offline" ? { proofVerified: true, status: "offline", context: { hostId: HOST } } : null,
    decision: { hostId: HOST, deployment: id, owner: A("11"), revision: "1", policyHash: H("5e"), refusal: null, validUntil: Date.now() + 60_000 },
    policy: undefined });
  const never = (label) => async () => { throw Error(`TEST: ${label} is not available to the read-only node`); };
  const adapter = { authorityKind: "derived", profile: PROFILE, lifecycleSchema: 3, lifecycleProofSchema: 2, bundleSha256: BUNDLE,
    hostRegistry: { address: REG, runtimeCodeHash: CODE, artifactSha256: ARTIFACT }, independence: { complete: false, blockers: ["TEST chain fixture"] },
    read: (id) => chainRead(id), prepare: never("prepare"), submit: never("submit"), resolve: never("resolve"), finalize: never("finalize") };
  // ---- (2)(3) owner-selected modules + pinned config, through the REAL composeProtectedAuthority ----
  const write = (name, value) => { const file = path.join(dir, name), bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    fs.writeFileSync(file, bytes, { mode: 0o600 }); return { file, sha256: sha(bytes) }; };
  const reader = write("reader.mjs", "export async function createAnchorReader(){return async()=>{throw Error('TEST anchor: the adapter fixture carries the snapshot')}}");
  const qv = write("quiescence.mjs", `export async function createQuiescenceVerifier(o, cap){ return async (r) => ({ label: 'TEST owner-selected quiescence evidence',
    verified: true, proofVerified: true, authorityTier: 'l1-finalized-derived', deployment: r.deployment, ledger: r.oldLedger, quiescent: true, digest: r.quiescenceDigest }); }`);
  const cfg = { schema: factory.AUTHORITY_SCHEMA, host: HOST, journalFile: path.join(dir, "parent.json"), parentImportSha256: null,
    incarnationFile: path.join(dir, "inc.json"), permitFile: path.join(dir, "permit.json"),
    pins: write("pins.json", { ...PINS, chainId: 8453, lifecycle: CTRL, servingPermit: { version: 2, profile: PROFILE } }),
    adapterPins: write("adapter-pins.json", { chainId: 8453, host: HOST, profile: PROFILE, payee: A("99"), hostRegistry: { artifactSha256: ARTIFACT }, contracts: {
      registry: { address: REG, codeHash: CODE }, hostOwnership: { address: REG, codeHash: CODE }, ledger: { address: LEDGER, codeHash: H("11") },
      lifecycle: { address: CTRL, codeHash: H("22") }, catalog: { address: A("cd"), codeHash: H("24") } } }),
    witnesses: { endpoints: [], timeoutMs: 1000 }, operatorKeyFile: write("public-test-key.txt", "0x" + "11".repeat(32)).file,
    finality: { readerModule: reader.file, readerModuleSha256: reader.sha256, readerOptions: {}, verifier: { url: "http://127.0.0.1:1" }, maxAnchorAgeSec: 3600 },
    hostPolicyDir: dir, platformWallets: [], capacityHeadroom: 0, lock: { flockPath: FLOCK, timeoutMs: 1000, withdrawDeadlineMs: 1000 },
    routes: [route(DEP)], quiescence: { verifierModule: qv.file, verifierModuleSha256: qv.sha256, verifierOptions: {} } };
  const authorityCfg = write("authority.json", cfg);
  const collected = [];
  const modules = { owned: await import("../../control/network/lifecycle-host-owned-authority.mjs"), hostAuthority: await import("../../control/network/deployment-host-authority.mjs"),
    accounts: { privateKeyToAccount: () => ({ address: A("12"), label: "TEST public permit identity" }) },
    chain: { createLifecycleChainAdapter: () => adapter },
    finality: { createLifecycleFinalitySnapshot: () => ({ label: "TEST: the adapter fixture carries finality" }) },
    collector: { createPermitCollector: () => async (rec) => { const e = await envelope(rec); collected.push(e); return e; } } };
  // ---- the node: pinned enrollment naming the ROUTER as manager origin; the Host is constructed with it ----
  const keyFile = path.join(dir, "control.key"); fs.writeFileSync(keyFile, controlKey.toString("hex"), { mode: 0o600 });
  const pol = Buffer.from(JSON.stringify({ schema: supervisor.ENROLLMENT_SCHEMA, host: HOST, manager: routerBase, controlKeyFile: keyFile, deployments: [DEP], stagingMs: 30_000 }));
  const polFile = path.join(dir, "enrollment.json"); fs.writeFileSync(polFile, pol);
  const ofile = path.join(dir, "protected-obligations.log"); initializeOwnedLog(ofile, { purpose: OBLIGATION_PURPOSE });   // installed beside the key (owned store)
  const olog = openOwnedLog(ofile, { purpose: OBLIGATION_PURPOSE, exclusion: TEST_inProcessExclusion() }); t.after(() => { try { olog.release(); } catch {} });
  const env = { ENCLAVE_PROTECTED_ENROLLMENT: polFile, ENCLAVE_PROTECTED_ENROLLMENT_SHA256: sha(pol), ENCLAVE_PROTECTED_AUTHORITY: authorityCfg.file, ENCLAVE_PROTECTED_AUTHORITY_SHA256: authorityCfg.sha256 };
  const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const host = new Host({ dir, endpoint: "TEST", appsEnabled: true, ownerStartup: null, walletAdmission: null, isolationManager: routerBase, isolationRuntimeId: record.runtimeId });
  host.chainReady = true; host.registered = {};
  for (const name of ["followBook", "enforceOff", "refreshOwners", "ensureRegistered", "ensurePriced", "scanLedger", "retireForeignRecovered"]) host[name] = async () => {};   // retired legacy services: not part of this path
  supervisor.composition.store = ownedObligationStore(olog);
  const composed = await factory.composeProtectedAuthority({ hostId: HOST, hostView: host.lifecycleView(), env, modules });
  t.after(async () => {
    await supervisor.protectedShutdown("TEST cleanup").catch(() => {});
    await composed?.release?.("TEST cleanup").catch(() => {});
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    supervisor.TEST_resetProtectedComposition();
  });
  const plain = async (method, p) => { const r = await fetch(routerBase + p, { method, signal: AbortSignal.timeout(5000) }); return { status: r.status, body: await r.json() }; };
  return { host, legacy, enforcement, router, rjournal, headroom, compositeDp, chain, collected, inventory, plain, dir, polFile, composed };
}
const splice = (dp, m) => new Promise((resolve) => {
  const s = net.connect(dp.server.address().port, "127.0.0.1"); let got = ""; s.on("error", () => {}); s.setEncoding("latin1"); s.on("data", (d) => { got += d; });
  s.on("connect", () => s.write(`ENCLAVE-SPLICE/1 id=${m.id} app=${m.appId} image=${m.image} runtime=${m.runtimeId} key=${KEY}\n`));
  setTimeout(() => resolve({ s, got: () => got }), 300);
});
const staged = (w) => w.enforcement.journal.instances().find((r) => r.deployment === DEP && r.state !== "removed");

test("r12 REAL CONSUMER: Host -> owned factory/dispatch -> runtime/client -> router/manager: queued -> Running -> TCP -> off-chain refresh -> Stop", { timeout: 120000 }, async (t) => {
  if (!fs.existsSync(FLOCK)) { t.skip("Linux flock unavailable (R18 Linux lock implementation; not Windows qualification)"); return; }
  const w = await rig(t);
  // 1. queued: the actual Host pass plans from the authenticated snapshot and the real dispatch admits ONE exact stage
  await w.host.protectedTick();
  const id = await waitFor(() => staged(w)?.instanceId, { timeoutMs: 30000 });
  assert.match(id, /^pp/, w.host.records.get(DEP)?.reason);
  assert.equal(w.rjournal.pending(), false, "router pending cost cleared only by the same-epoch reservation");
  await waitFor(() => w.legacy.get(id)?.status === "running");
  for (let i = 0; i < 2; i++) { await w.host.protectedTick(); assert.equal(staged(w).instanceId, id, "repeated queued readiness: the same instance, no churn"); }
  // 2. Running: owner-selected witnesses -> gate.install -> boundaries.allow -> manager permit (OFF-CHAIN), then a refresh on the next pass
  w.chain.state = "running"; w.chain.generation = w.enforcement.journal.instance(id).generation;
  await w.host.protectedTick();
  assert.equal(w.enforcement.journal.instance(id).state, "serving", w.host.records.get(DEP)?.reason);
  const d1 = w.enforcement.journal.instance(id).permit.digest;
  await w.host.protectedTick();
  assert.ok(w.collected.length >= 2, "refresh collected another off-chain envelope");
  assert.equal(w.collected.at(-1).record.sequence, w.collected.at(-2).record.sequence + 1, "increasing permit sequence");
  assert.notEqual(w.enforcement.journal.instance(id).permit.digest, d1, "refresh installed the newer exact permit digest");
  // 3. useful TCP through the actual router splice under the current permit
  const s = await splice(w.compositeDp, w.legacy.get(id));
  assert.match(s.got(), /^OK/);
  s.s.write("ping-r12\n"); await waitFor(() => s.got().includes("ping-r12"));
  // 4. authenticated Stop -> withdrawal closes traffic -> exact removal -> capacity released by evidence
  w.chain.state = "stopped";
  await w.host.protectedTick();
  await waitFor(() => s.s.destroyed || s.s.readableEnded);
  assert.equal(w.enforcement.journal.instance(id).state, "removed");
  assert.equal(w.host.records.get(DEP).status, "stopped");
  assert.equal(readInv(w.inventory).vms.length, 0);
  assert.deepEqual(w.fixtureSends ?? fixture.sends, [], "ZERO on-chain claim/renew/release/heartbeat for the enrolled event-driven route");
  assert.equal(fixture.reads, 0, "no retired ledger/catalog read");
  // 5. owner release: exact, locks recoverable by a later owner
  const r = await supervisor.protectedShutdown("TEST owner release");
  assert.equal(r.released, true);
});

test("r12 finding 1: Host plan on context A, authenticated B at admission -> NO old-body start; identical context positive", { timeout: 120000 }, async (t) => {
  if (!fs.existsSync(FLOCK)) { t.skip("Linux flock unavailable"); return; }
  const w = await rig(t);
  // the owner resizes BETWEEN the Host's plan (A: 250) and the dispatch admission's fresh read (B: 500): hook the adapter read once planned
  let plannedA = false;
  const orig = w.host.isolationVerdict.bind(w.host);
  w.host.isolationVerdict = async (...a) => { const v = await orig(...a); if (!plannedA) { plannedA = true; w.chain.cpuMilli = 500; } return v; };
  await w.host.protectedTick();
  assert.equal(staged(w), undefined, "a body planned on A is never staged under B");
  assert.match(w.host.records.get(DEP).reason, /changed since the plan|another authenticated context|no verified launch plan/);
  // next pass replans from B (unchanged since): identical context -> one exact stage
  await w.host.protectedTick();
  await waitFor(() => staged(w)?.instanceId, { timeoutMs: 30000 });
  assert.equal(fixture.sends.length, 0);
});

test("r12 finding 2: enrollment corrupted DURING the awaited stage path -> no stage POST; Stop still withdraws", { timeout: 120000 }, async (t) => {
  if (!fs.existsSync(FLOCK)) { t.skip("Linux flock unavailable"); return; }
  const w = await rig(t);
  const orig = w.host.isolationVerdict.bind(w.host);
  w.host.isolationVerdict = async (...a) => { const v = await orig(...a); fs.writeFileSync(w.polFile, "{}"); return v; };   // after the queue-entry checks
  await w.host.protectedTick();
  assert.equal(staged(w), undefined, "no protected stage after the policy became unknown mid-path");
  w.chain.state = "stopped";
  await w.host.protectedTick();
  assert.equal(w.host.records.get(DEP).status, "stopped", "authenticated Stop is independent of the new-work fence");
});
