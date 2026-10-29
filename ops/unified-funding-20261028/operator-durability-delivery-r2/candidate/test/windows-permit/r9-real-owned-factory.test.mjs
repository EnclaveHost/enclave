// permit r9 (AUTHORED, NOT RUN). POSITIVE successor of the root-executed evidence/root-r8/real-owned-factory.test.mjs (d2693af2..., 0 PASS /
// 1 FAIL at the positive-open assertion: "at least one explicit lifecycle route is required"). That evidence is preserved unchanged.
// REAL here (no replacement of constructors or prechecks): r9 composeProtectedAuthority (config load, hash pins, forbidden-capability scan,
// quiescence verifier loading) -> R18 openOwnedHostRegistryLifecycle (candidate copy, sha-pinned below) -> actual parent journal + both
// owned sidecars under Linux flock -> DeploymentPermitGate + createIsolationLifecycleRuntime -> composeIndependentLifecycle ->
// createLifecycleDispatch -> parseLifecycleRoutes over the config's EXPLICIT routes -> dispatch.attach -> dispatch.activate (the handoff).
// TEST FIXTURES, explicitly labelled and limited: the canonical chain adapter identity (same construction as R18 O8 / the r8 evidence; no
// chain read happens), the owner-selected quiescence verifier MODULE (returns fixture evidence; the dispatch still checks every binding
// field), the inert finality/collector/accounts constructors, inert manager/readiness/boundary adapters, and the Host view (the actual
// one is Host.lifecycleView(); constructing a full Host needs chain/enclave state). Linux flock is not Windows qualification.
// NOT covered here (remaining, see REPORT-WINDOWS-PERMIT-R9.md): useful stage/serve through a real manager after activation, Stop/Offline
// through this composition, and a real derived-finality chain read.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import * as own from "../../control/network/lifecycle-host-owned-authority.mjs";
import * as locks from "../../control/network/owned-durable-state.mjs";
import * as hostAuthority from "../../control/network/deployment-host-authority.mjs";
import * as factory from "../../control/windows/node/protected-authority-factory.mjs";
import * as supervisor from "../../control/windows/node/protected-supervisor.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const here = path.dirname(new URL(import.meta.url).pathname);
const OWNED_SHA = "ee1f93c8ab968ab6b26e3f38a18cf66604d476b87acd37acd7e9cb09ea6c302c";   // pinned R18 owned factory (unchanged in r9)
const FLOCK = "/usr/bin/flock";
const H = (b) => "0x" + b.repeat(32), A = (b) => "0x" + b.repeat(20);
const HOST = H("a1"), CTRL = A("c7"), REG = A("ab"), CODE = H("23"), LEDGER = A("e2"), OLD = A("e1");
const PROFILE = "independent-host-registry-r1";
const BUNDLE = "bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e";
const ARTIFACT = "e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a";
const PINS = { chainId: 8453, lifecycle: CTRL, servingPermit: { version: 2, profile: PROFILE } };
const ADAPTER_PINS = { chainId: 8453, host: HOST, profile: PROFILE, payee: A("99"), hostRegistry: { artifactSha256: ARTIFACT }, contracts: {
  registry: { address: REG, codeHash: CODE }, hostOwnership: { address: REG, codeHash: CODE },
  ledger: { address: LEDGER, codeHash: H("11") }, lifecycle: { address: CTRL, codeHash: H("22") }, catalog: { address: A("cd"), codeHash: H("24") } } };
const DEP_A = H("d1"), DEP_B = H("d2"), DIGEST_A = H("f1"), DIGEST_B = H("f2");
// exact route shape for the host-registry binding (ROUTE_KEYS + profile/bundle + host registry identity); validated by the REAL parser
const route = (deployment, quiescenceDigest) => ({ deployment, oldLedger: OLD, newLedger: LEDGER, controller: CTRL, deploymentsSchema: 17, lifecycleSchema: 3,
  ledgerCodeHash: H("11"), controllerCodeHash: H("22"), quiescenceDigest, profile: PROFILE, bundleSha256: BUNDLE,
  hostRegistry: REG, hostRegistryCodeHash: CODE, hostRegistryArtifactSha256: ARTIFACT });

test("r9 ROOT: production factory opens the REAL R18 owned runtime with explicit routes; real dispatch handoff activates only on bound quiescence", { timeout: 20000 }, async (t) => {
  assert.equal(sha(fs.readFileSync(path.join(here, "../../control/network/lifecycle-host-owned-authority.mjs"))), OWNED_SHA, "owned factory is the pinned R18 source");
  if (!fs.existsSync(FLOCK)) { t.skip("Linux flock unavailable: this source composition needs the R18 Linux lock implementation"); return; }
  supervisor.TEST_resetProtectedComposition(); t.after(() => supervisor.TEST_resetProtectedComposition());
  const dir = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), "r9-real-factory-")); fs.chmodSync(dir, 0o700);
  const write = (name, value) => { const file = path.join(dir, name), bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    fs.writeFileSync(file, bytes, { mode: 0o600 }); return { file, sha256: sha(bytes) }; };
  const calls = [];
  const never = (label) => async () => { calls.push(label); throw Error(`TEST: ${label} must not run in this composition test`); };
  const reader = write("reader.mjs", "export async function createAnchorReader(){return async()=>{throw Error('TEST anchor not read here')}}");
  // owner-selected quiescence verifier FIXTURE: evidence for DEP_A only, bound to its route; DEP_B gets evidence for the WRONG digest
  const qv = write("quiescence.mjs", `export async function createQuiescenceVerifier(o, cap){
    if (Object.keys(cap).join() !== 'read') throw Error('verifier must receive only the read-only reader');
    return async (r) => ({ label: 'TEST fixture quiescence evidence', verified: true, proofVerified: true, authorityTier: 'l1-finalized-derived',
      deployment: r.deployment, ledger: r.oldLedger, quiescent: true, digest: r.deployment === o.good ? r.quiescenceDigest : o.wrongDigest }); }`);
  const cfg = { schema: factory.AUTHORITY_SCHEMA, host: HOST, journalFile: path.join(dir, "parent.json"), parentImportSha256: null,
    incarnationFile: path.join(dir, "inc.json"), permitFile: path.join(dir, "permit.json"), pins: write("pins.json", PINS),
    adapterPins: write("adapter-pins.json", ADAPTER_PINS), witnesses: { endpoints: [], timeoutMs: 1000 },
    operatorKeyFile: write("public-test-key.txt", "0x" + "11".repeat(32)).file,
    finality: { readerModule: reader.file, readerModuleSha256: reader.sha256, readerOptions: {}, verifier: { url: "http://127.0.0.1:1" }, maxAnchorAgeSec: 3600 },
    hostPolicyDir: dir, platformWallets: [], capacityHeadroom: 0, lock: { flockPath: FLOCK, timeoutMs: 1000, withdrawDeadlineMs: 1000 },
    routes: [route(DEP_A, DIGEST_A), route(DEP_B, DIGEST_B)],
    quiescence: { verifierModule: qv.file, verifierModuleSha256: qv.sha256, verifierOptions: { good: DEP_A, wrongDigest: H("ee") } } };
  const c = write("authority.json", cfg);
  const adapter = { authorityKind: "derived", profile: PROFILE, lifecycleSchema: 3, lifecycleProofSchema: 2, bundleSha256: BUNDLE,
    hostRegistry: { address: REG, runtimeCodeHash: CODE, artifactSha256: ARTIFACT },
    independence: { complete: false, blockers: ["TEST canonical adapter stand-in, same construction as R18 O8"] },
    read: never("chain read"), prepare: never("transition preparation"), submit: never("transaction submit"),
    resolve: never("receipt reconciliation"), finalize: never("transition finalization") };
  const modules = { owned: own, hostAuthority, accounts: { privateKeyToAccount: () => ({ address: A("12") }) },
    chain: { createLifecycleChainAdapter: () => adapter }, finality: { createLifecycleFinalitySnapshot: () => never("finality snapshot") },
    collector: { createPermitCollector: () => never("permit collection") } };
  // TEST host view fixture with the exact HOST_FNS; legacy activity of DEP_B toggles to prove the local re-check
  const records = new Map(), legacy = new Map([[DEP_B, ["tracked legacy lease"]]]);
  const hostView = { hostId: HOST, legacyHold: () => null, ownerRestriction: () => null, platformService: () => null, platformNewWork: () => null,
    legacyActivity: (id) => legacy.get(id) ?? [], capacity: () => ({ paused: false, cpuCap: 1, gpuCap: 1, cpuUsed: 0, gpuUsed: 0 }),
    shareOf: (id, r) => ({ cpuShare: r.cpuShare, gpuShare: r.gpuShare }), record: (id, p) => records.set(id, { ...(records.get(id) || {}), ...p }), log: () => {} };

  const composed = await factory.composeProtectedAuthority({ hostId: HOST, hostView, modules,
    env: { ENCLAVE_PROTECTED_ENROLLMENT: path.join(dir, "enrollment-not-read-by-factory.json"), ENCLAVE_PROTECTED_AUTHORITY: c.file, ENCLAVE_PROTECTED_AUTHORITY_SHA256: c.sha256 } });
  assert.deepEqual(composed.routes, [DEP_A, DEP_B]);
  const adapters = { client: { findByName: never("VM inventory"), spawn: never("VM launch"), remove: never("VM removal") },
    plans: { read: never("plan") }, readiness: { verify: never("readiness") }, boundaries: { hold: never("hold"), allow: never("allow") },
    collectPermit: never("runtime permit collection") };
  // route identity: a route for an unenrolled deployment is refused BEFORE any owner is acquired
  await assert.rejects(supervisor.composition.openRuntime({ host: HOST, deployments: [DEP_A], bind: () => adapters }), /unenrolled/);
  assert.equal(fs.existsSync(cfg.journalFile + ".parent-established"), false, "no owner acquired for a refused route set");

  let opened = null, error = null;
  try { opened = await supervisor.composition.openRuntime({ host: HOST, deployments: [DEP_A, DEP_B], bind: () => adapters }); } catch (e) { error = e; }
  try {
    assert.ifError(error);   // r8 failed exactly here (missing routes); r9 must open
    assert.equal(opened.runtime.hostAuthorityPermit, true, "real v2 host-authority runtime");
    // the real dispatch owns exactly the explicit routes, attached to the host view (attach publishes held rows for each route)
    assert.equal(opened.handoff.owns(DEP_A), true); assert.equal(opened.handoff.owns(DEP_B), true); assert.equal(opened.handoff.owns(H("d3")), false);
    assert.equal(records.get(DEP_A)?.lifecycle, true, "real dispatch published its route row through the host view");
    // the handoff: DEP_A has bound quiescence and no legacy work -> activated. DEP_B: legacy lease still here -> held
    assert.equal(opened.handoff.activated(DEP_A), true, "bound quiescence evidence + no legacy activity activates the route");
    assert.equal(opened.handoff.activated(DEP_B), false); assert.match(opened.handoff.why(DEP_B), /legacy work in this process/);
    // legacy work ends, but the evidence names the wrong digest: the real dispatch still refuses (evidence shape alone is not authority)
    legacy.delete(DEP_B);
    await opened.handoff.activate();
    assert.equal(opened.handoff.activated(DEP_B), false); assert.match(opened.handoff.why(DEP_B), /does not bind this route/);
    // a second owner in this process is refused
    await assert.rejects(supervisor.composition.openRuntime({ host: HOST, deployments: [DEP_A, DEP_B], bind: () => adapters }), /never a second owner/);
    assert.deepEqual(calls, [], "no chain, VM, permit or financial operation in composition/handoff");
  } finally {
    if (opened) assert.equal((await opened.release("TEST cleanup")).released, true, "exact owner release");
    for (const f of [cfg.journalFile, cfg.incarnationFile, cfg.permitFile]) { const l = await locks.openOwnedLock(f, { flockPath: FLOCK, timeoutMs: 1000 }); l.release(); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
