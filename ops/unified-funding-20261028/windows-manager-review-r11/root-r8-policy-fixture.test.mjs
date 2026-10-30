// permit r8 (AUTHORED, NOT RUN). The production protected authority factory (protected-authority-factory.mjs) and its ACTUAL consumer
// (ProtectedSupervisor). What this proves: SOURCE COMPOSITION only - the node entry's composeProtectedAuthority sets the supervisor
// composition from the pinned config; the chain adapter is constructed with NO actorSigner/approvals/relay and the supervisor sees a
// read-only reader; the owned r18 lifecycle receives the client's exact runtime adapters and its dispatch is stopped; snapshot
// normalization derives proof qualification only from the adapter's own fields; the supervisor's decisions over factory snapshots:
// independent Online proceeds despite an Enclave catalog refusal, canonical Offline revokes, unverified/stale fences, wrong host
// withdraws, lost obligation owner admits no new work.
// TEST and labelled: the r18 owned/chain/collector/finality MODULES are injected TEST doubles (`modules`) recording their arguments
// (the pinned r18 files are materialized by the release closure; their own suites are r18 evidence), TEST pins/keys/config files,
// TEST manager control (GET /health only) and TEST runtime double for the supervisor decisions. Not chain/Windows/Base evidence.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as hostAuthorityModule from "./candidate/control/network/deployment-host-authority.mjs";
import { AUTHORITY_SCHEMA, loadAuthorityConfig, readOnlyChainReader, protectedSnapshotOf, composeProtectedAuthority, FORBIDDEN } from "./candidate/control/windows/node/protected-authority-factory.mjs";
import { ProtectedSupervisor, composition, TEST_resetProtectedComposition } from "./candidate/control/windows/node/protected-supervisor.mjs";
import { PINS, HOST, DEPLOYMENT, tmp } from "./candidate/test/windows-permit/helpers/world.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const put = (dir, name, data) => { const f = path.join(dir, name), b = Buffer.from(typeof data === "string" ? data : JSON.stringify(data)); fs.writeFileSync(f, b); return { file: f, sha256: sha(b) }; };
const ADAPTER_PINS = { host: HOST, chainId: 8453, profile: "independent-host-registry-r1", payee: "0x" + "99".repeat(20) };

function config(dir, over = {}) {
  const q = quiescenceModule(dir);
  const reader = put(dir, "anchor-reader.mjs", "export async function createAnchorReader(o){ return async () => ({ tier: 'TEST', o }); }");
  const c = { schema: AUTHORITY_SCHEMA, host: HOST, journalFile: path.join(dir, "lifecycle.json"), parentImportSha256: null, incarnationFile: path.join(dir, "inc.json"),
    permitFile: path.join(dir, "permit.json"), pins: put(dir, "pins.json", PINS), adapterPins: put(dir, "adapter-pins.json", ADAPTER_PINS),
    witnesses: { endpoints: [], timeoutMs: 1000 }, operatorKeyFile: put(dir, "op.key", "0x" + "11".repeat(32)).file,
    finality: { readerModule: reader.file, readerModuleSha256: reader.sha256, readerOptions: { label: "TEST" }, verifier: { url: "http://127.0.0.1:1" }, maxAnchorAgeSec: 3600 },
    hostPolicyDir: dir, platformWallets: [], capacityHeadroom: 0, lock: { flockPath: null, timeoutMs: 1000, withdrawDeadlineMs: 1000 },
    // r9: explicit routes + owner-selected quiescence verifier (TEST module; refuses, so nothing would activate)
    routes: [{ deployment: DEPLOYMENT, label: "TEST route; exact keys are checked by the real parseLifecycleRoutes, not this double" }],
    quiescence: { verifierModule: q.file, verifierModuleSha256: q.sha256, verifierOptions: {} }, ...over };
  return put(dir, "authority.json", c);
}
const quiescenceModule = (dir) => put(dir, "quiescence.mjs", "export async function createQuiescenceVerifier(o, r){ return async () => { throw Error('TEST: no quiescence proof'); }; }");
// r9 TEST host view fixture (the actual one is Host.lifecycleView(); constructing a full Host is outside this unit test)
const TEST_hostView = (hostId = HOST) => ({ hostId, legacyHold: () => null, ownerRestriction: () => null, platformService: () => null, platformNewWork: () => null,
  legacyActivity: () => [], capacity: () => ({ paused: false, cpuCap: 1, gpuCap: 1, cpuUsed: 0, gpuUsed: 0 }), shareOf: (id, r) => r, record: () => {}, log: () => {} });
function TEST_modules(rec) {
  return { hostAuthority: hostAuthorityModule, accounts: { privateKeyToAccount: (k) => ({ address: "0x" + "12".repeat(20), k }) },
    finality: { createLifecycleFinalitySnapshot: (o) => { rec.finality = o; return async () => { throw Error("TEST finality not exercised"); }; } },
    chain: { createLifecycleChainAdapter: (o) => { rec.chain = o; return { authorityKind: "derived", profile: "independent-host-registry-r1", read: async (id) => rec.snapshot(id),
      prepare: async () => { throw Error("TEST"); }, submit: async () => { throw Error("TEST"); } }; } },
    collector: { createPermitCollector: (o) => { rec.collector = o; return async () => { throw Error("TEST collector"); }; } },
    owned: { openOwnedHostRegistryLifecycle: async (o) => { rec.owned = o; rec.started = false; rec.activations = 0;
      return { runtime: { label: "TEST-runtime" }, gate: { entries: new Map([["k", 1]]) }, journal: { readAnchor: () => null, acceptAnchor: () => {} },
        dispatch: { start: () => { rec.started = true; }, attach: (v) => { rec.attached = v; }, owns: (id) => id === DEPLOYMENT,
          activate: async () => { rec.activations++; return []; }, state: () => [{ id: DEPLOYMENT, activated: false, held: "TEST: quiescence unproven" }] },
        release: async () => ({ released: true }) }; } } };
}
const snap = ({ state = "running", host = HOST, tier = "l1-finalized-derived", verified = true, haStatus = "online", catalogRefusal = null } = {}) => ({
  id: DEPLOYMENT, verified, proofVerified: verified, authorityTier: tier, blockAt: Date.now(), blockHash: "0x" + "ab".repeat(32), admitted: true, funded: true,
  catalog: { refusal: catalogRefusal }, policy: { witnesses: [], threshold: 3 },
  hostAuthorityEvidence: { proofVerified: verified, status: haStatus, context: { hostId: HOST } },
  assignment: { state, host, operator: "0x" + "12".repeat(20), generation: 1, revision: 1 } });

test("r8 factory: pinned config refuses unknown fields, forbidden capabilities, wrong host and hash drift", (t) => {
  const dir = tmp(t);
  const ok = config(dir);
  assert.equal(loadAuthorityConfig(ok.file, ok.sha256, { hostId: HOST }).host, HOST);
  assert.throws(() => loadAuthorityConfig(ok.file, ok.sha256, { hostId: "0x" + "b2".repeat(32) }), /verified identity/);
  assert.throws(() => loadAuthorityConfig(ok.file, "0".repeat(64), { hostId: HOST }), /hash differs/);
  const bad = config(dir, { finality: { ...JSON.parse(fs.readFileSync(ok.file)).finality, readerOptions: { relay: "http://x" } } });
  assert.throws(() => loadAuthorityConfig(bad.file, bad.sha256, { hostId: HOST }), /forbidden capability finality\.readerOptions\.relay/);
  const extra = put(dir, "extra.json", { ...JSON.parse(fs.readFileSync(ok.file)), enclaveEndpoint: "https://enclave" });
  assert.throws(() => loadAuthorityConfig(extra.file, extra.sha256, { hostId: HOST }), /unknown or missing fields/);
});

test("r8 factory: the supervisor's chain reader is read-only; proof qualification comes only from the adapter's own fields", () => {
  const r = readOnlyChainReader({ authorityKind: "derived", read: async () => 1, submit: async () => 2, prepare: async () => 3, relay: {} });
  for (const k of FORBIDDEN) assert.equal(k in r, false, `reader must not expose ${k}`);
  assert.equal(protectedSnapshotOf(PINS, snap(), hostAuthorityModule.servingContextOf).assignment.proofVerified, true);
  assert.equal(protectedSnapshotOf(PINS, snap(), hostAuthorityModule.servingContextOf).assignment.deployment, DEPLOYMENT);
  assert.equal(protectedSnapshotOf(PINS, snap({ tier: "rpc-quorum" }), hostAuthorityModule.servingContextOf).assignment.proofVerified, false, "an RPC label is not finality");
  assert.equal(protectedSnapshotOf(PINS, snap({ verified: false }), hostAuthorityModule.servingContextOf).assignment.proofVerified, false);
  assert.ok(protectedSnapshotOf(PINS, snap(), hostAuthorityModule.servingContextOf).servingContext, "v2 serving context built by servingContextOf");
});

test("r8 factory: node entry composition -> no signer/relay adapter -> owned lifecycle bound to the client's runtime adapters, dispatch stopped", async (t) => {
  TEST_resetProtectedComposition(); t.after(() => TEST_resetProtectedComposition());
  const dir = tmp(t), c = config(dir), rec = { snapshot: async () => snap() };
  const env = { ENCLAVE_PROTECTED_ENROLLMENT: path.join(dir, "enrollment.json"), ENCLAVE_PROTECTED_AUTHORITY: c.file, ENCLAVE_PROTECTED_AUTHORITY_SHA256: c.sha256 };
  assert.equal(await composeProtectedAuthority({ hostId: HOST, env: {} }), null, "no enrollment: nothing composed (legacy unchanged)");
  const out = await composeProtectedAuthority({ hostId: HOST, hostView: TEST_hostView(), env, modules: TEST_modules(rec) });
  assert.match(out.summary, /protected authority composed/);
  assert.equal(composition.hostId, HOST);
  assert.equal(typeof composition.openRuntime, "function"); assert.equal(typeof composition.collect, "function");
  for (const k of ["actorSigner", "approvals", "relay"]) assert.equal(rec.chain[k], undefined, `chain adapter constructed without ${k}`);
  assert.equal(rec.chain.authority.kind, "derived");
  assert.throws(() => rec.finality.journal.readAnchor(8453), /not yet owned/, "no finality read before the owned anchor journal is bound");
  const bound = { client: { findByName() {} }, plans: {}, readiness: {}, boundaries: {}, collectPermit: async () => {} };
  let gateSeen = null;
  await assert.rejects(composition.openRuntime({ host: HOST, deployments: [], bind: () => bound }), /unenrolled/, "r9: a route must name an enrolled deployment");
  const o = await composition.openRuntime({ host: HOST, deployments: [DEPLOYMENT], bind: ({ gate }) => { gateSeen = gate; return bound; } });
  assert.equal(rec.owned.client, bound.client); assert.equal(rec.owned.boundaries, bound.boundaries); assert.equal(rec.owned.collectPermit, bound.collectPermit);
  assert.equal(rec.owned.hostId, HOST); assert.equal(rec.started, false, "r9: dispatch cadence never started (no automatic chain work)");
  assert.deepEqual(rec.owned.routes.map((r) => r.deployment), [DEPLOYMENT], "r9: the config's explicit routes reach the real constructor");
  assert.equal(typeof rec.owned.verifyQuiescence, "function"); assert.equal(rec.attached?.hostId, HOST, "dispatch attached to the host view");
  assert.equal(rec.activations, 1, "activation (the handoff) attempted once at open");
  assert.equal(o.handoff.activated(DEPLOYMENT), false); assert.match(o.handoff.why(DEPLOYMENT), /quiescence unproven/);
  assert.equal(gateSeen.entries.get("k"), 1, "the client's adapters see the OWNED gate's entries after binding");
  assert.equal((await o.snapshot(DEPLOYMENT)).assignment.proofVerified, true);
  await assert.rejects(composition.openRuntime({ host: HOST, deployments: [DEPLOYMENT], bind: () => bound }), /never a second owner/);
  await assert.rejects(composeProtectedAuthority({ hostId: "0x" + "b2".repeat(32), hostView: TEST_hostView("0x" + "b2".repeat(32)), env, modules: TEST_modules(rec) }), /verified identity/);
  await assert.rejects(composeProtectedAuthority({ hostId: HOST, env, modules: TEST_modules(rec) }), /Host lifecycle view/, "r9: no composition without the actual host view");
});

// the ACTUAL supervisor's decisions over factory-normalized snapshots (TEST runtime double records what it was asked to do)
function sup(snapshotOf, { capability = { available: true } } = {}) {
  const calls = [];
  const runtime = { fence: async (id) => { calls.push(["fence", id]); }, revokeAuthority: async (id, why) => { calls.push(["revoke", why]); return { absent: true, held: true }; },
    revokeHostAuthority: async (id) => { calls.push(["offline", id]); return { absent: true, held: true }; },
    health: async () => { calls.push(["health"]); return { ready: false }; }, ensureStaged: async () => { calls.push(["stage"]); return { ready: false, reason: "TEST" }; } };
  const control = { request: async (m, u) => { calls.push(["http", m, u]);
    return u === "/health" ? { status: 200, body: { supports: { permitEnforcement: true }, permitEnforcement: { available: capability.available, reasons: [] } } } : { status: 200, body: { schema: "enclave-protected-inventory/1", deployment: DEPLOYMENT, complete: true, instances: [], managerEpoch: "e" } }; } };
  const s = new ProtectedSupervisor({ policy: { host: HOST, deployments: [DEPLOYMENT], stagingMs: 30_000 }, control, collect: async () => null,
    openRuntime: async ({ bind }) => { bind({ gate: { entries: new Map() }, pins: PINS }); return { runtime, gate: { close: async () => true }, pins: PINS,
      handoff: { owns: () => true, activated: () => true, why: () => null, activate: async () => [], newWorkRefusal: () => null, label: "TEST fixture (r9): pre-activated route handoff" }, snapshot: async () => protectedSnapshotOf(PINS, snapshotOf(), hostAuthorityModule.servingContextOf) }; } });
  return { s, calls };
}
const body = { name: DEPLOYMENT };

test("r8 supervisor over factory snapshots: Online despite Enclave catalog refusal proceeds; Offline revokes; unverified fences; wrong host withdraws", async (t) => {
  // ROOT fixture-only: direct constructor now also consumes the pinned enrollment policy. Install a real TEST policy, not a gate override.
  TEST_resetProtectedComposition();
  const dir=tmp(t), pol=put(dir,'root-enrollment.json',{schema:'enclave-protected-enrollment/1',host:HOST,manager:'http://127.0.0.1:41',controlKeyFile:path.join(dir,'TEST-key'),deployments:[DEPLOYMENT],stagingMs:30000});
  const priorFile=process.env.ENCLAVE_PROTECTED_ENROLLMENT, priorHash=process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256;
  process.env.ENCLAVE_PROTECTED_ENROLLMENT=pol.file;process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256=pol.sha256;
  t.after(()=>{if(priorFile===undefined)delete process.env.ENCLAVE_PROTECTED_ENROLLMENT;else process.env.ENCLAVE_PROTECTED_ENROLLMENT=priorFile;
    if(priorHash===undefined)delete process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256;else process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256=priorHash;TEST_resetProtectedComposition();});
  { const { s, calls } = sup(() => snap({ catalogRefusal: "Enclave catalog: delisted" }));
    await s.reconcile({ id: DEPLOYMENT, body });
    assert.ok(calls.some((c) => c[0] === "health"), "independent Online reaches the running path"); assert.ok(!calls.some((c) => c[0] === "revoke" || c[0] === "offline")); }
  { const { s, calls } = sup(() => snap({ haStatus: "offline" }), { capability: { available: false } });
    const r = await s.reconcile({ id: DEPLOYMENT, body });
    assert.equal(r.withdrawn, true); assert.deepEqual(calls.filter((c) => c[0] === "offline"), [["offline", DEPLOYMENT]]);
    assert.ok(!calls.some((c) => c[0] === "http" && c[2] === "/health"), "Offline bypasses the capability/new-work admission"); }
  { const { s, calls } = sup(() => snap({ tier: "rpc-quorum" }));
    const r = await s.reconcile({ id: DEPLOYMENT, body });
    assert.match(r.reason, /authority unknown/); assert.deepEqual(calls.filter((c) => c[0] !== "http"), [["fence", DEPLOYMENT]], "unverified evidence fences, never an invented Offline"); }
  { const { s, calls } = sup(() => snap({ host: "0x" + "c3".repeat(32) }));
    const r = await s.reconcile({ id: DEPLOYMENT, body });
    assert.equal(r.withdrawn, true); assert.match(calls.find((c) => c[0] === "revoke")[1], /moved to host/); }
  { const { s, calls } = sup(() => snap({ state: "stopped" }), { capability: { available: false } });
    const r = await s.reconcile({ id: DEPLOYMENT, body });
    assert.equal(r.withdrawn, true, "owner Stop bypasses ONLINE/new-work admission"); assert.ok(calls.some((c) => c[0] === "revoke")); }
});
