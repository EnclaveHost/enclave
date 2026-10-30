// Per-deployment host dispatch between the legacy lease loop and the event-driven
// lifecycle runner. Intended location: network/lifecycle-host-dispatch.mjs, beside
// deployment-lifecycle-runner.mjs. NOT activated by any environment flag.
//
// r2 (lifecycle-host-authority-r2): authority is SCOPED TO THE AUTHENTICATED HOST OWNER.
//  - The platform host policy (EnclaveAddressBook-owner gate) applies to a routed app only when this host's
//    authenticated owner (EnclaveHostOwnership.authority, via the host admission decision) is one of the
//    explicitly pinned platform wallets. On an independently owned host it is not a veto.
//  - The host box owner's local controls (hosting off, caps) and the host wallet's committed policy always apply.
//  - Online gates (admission, new work, capacity, legacy release hold) refuse STARTS and SERVING only. They never
//    stop the runner from reading authenticated state, reconciling a journaled intent or preparing a revocation
//    (queue/stop) intent. A local restriction fences immediately and the runner then records it on the ledger.
//  - The exact old ledger is proof-bound at handoff; a mutable old address book is never handoff authority.
//
// r3 (lifecycle-independent-composition-r3):
//  - CAPACITY IS RECOVERED, NOT ASSUMED. Every routed id has one allocation, derived from the manager's own name
//    inventory (IsolationManagerClient.findByName: null = absent, throws = unknown), runtime health, this process's
//    start effects and the OWNED journal's pending/mined running intents, priced by the host's own share accounting
//    (host.shareOf -> Host.cpuShareOf / gpuMilli) over the AUTHENTICATED snapshot resources. Fence, unknown chain,
//    unknown runtime, failed or timed-out removal never free it; only a confirmed runtime.stop() (the manager no longer
//    lists the name) releases a runtime. Until every route's allocation is resolved, no NEW start is admitted here
//    (lifecycle or, through the generated host's capacity edits, legacy). Health/serving of running apps continues.
//  - HOST AUTHORITY IS DURABLE. The accepted host owner/revision/policy floor and the box owner's local holds live in
//    the owned lifecycle journal (generated journal candidate). A restart cannot accept a lower revision or drop a
//    local cap/off hold. A hold is released only by a later authenticated owner control change (Host.setHostingCaps,
//    the hosting-admin-token API) - never by the relay's unauthenticated claim-hint `force` flag (r2 allowed that).
//
// Routes are a LOCAL ROUTING DECISION, not chain authority. They are fixed at
// construction (frozen, finite, exact) and keyed by deployment AND old/new ledger.
// A routed id is excluded from every legacy claim/renew/release/prove/restart path
// from the moment the host attaches the dispatch, whether or not the route has
// activated. Until activation it is HELD; it never falls back to v1.
//
// This module only adds refusals; it never synthesizes `verified`, an authority tier,
// admission or funding (it can only LOWER `admitted`), and it never opens, initializes,
// deletes or reconciles any journal.
import { DeploymentLifecycleRunner } from './deployment-lifecycle-runner.mjs';
import { schema3Binding, hostRegistryKeys, HOST_INCARNATION_FNS, validateHostIncarnation } from './lifecycle-host-profile.mjs';

const ID = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/, ZERO = /^0x0{40}$/, UINT = /^(0|[1-9][0-9]{0,30})$/;
export const LIFECYCLE_DEPLOYMENTS_SCHEMA = 17, LIFECYCLE_SCHEMA = 2, MAX_LIFECYCLE_ROUTES = 64, MAX_CAPACITY_HEADROOM = 0.5;
const ROUTE_KEYS = ['deployment', 'oldLedger', 'newLedger', 'controller', 'deploymentsSchema', 'lifecycleSchema',
  'ledgerCodeHash', 'controllerCodeHash', 'quiescenceDigest'];
const BINDING_KEYS = ['ledger', 'controller', 'deploymentsSchema', 'lifecycleSchema', 'ledgerCodeHash', 'controllerCodeHash'];
const DECISION_KEYS = ['hostId', 'deployment', 'owner', 'revision', 'policyHash', 'refusal', 'validUntil'];
const CHAIN_FNS = ['read', 'resolve', 'prepare', 'submit', 'finalize'];
const RUNTIME_FNS = ['fence', 'stop', 'health', 'ensureStaged', 'serve'];
// Every journal method DeploymentLifecycleRunner calls, plus the owned host-authority section (r3 journal candidate).
const JOURNAL_FNS = ['read', 'observeAssignment', 'restoreDenial', 'deny', 'settleMined', 'archiveMined', 'settleTransition',
  'prepareTransition', 'healthy', 'unhealthy', 'failure', 'decision',
  'readHostAuthority', 'acceptHostAuthority', 'holdHostLocal', 'releaseHostLocal', 'advanceOwnerControls'];
const HOST_FNS = ['legacyHold', 'ownerRestriction', 'platformService', 'platformNewWork', 'legacyActivity', 'capacity', 'shareOf', 'record', 'log'];
const PROOF_TIERS = ['finalized', 'l1-finalized-derived'];
// Revocation targets: never blocked by an online denial (admission, new work, capacity, platform outage).
const REVOCATIONS = new Set(['queued', 'stopped']);
const RUNNING_TARGET = 2;   // the r6 canonical intent payload's target code for 'running'

/**
 * Schema-3 emergency offline / independent failed-host reporter: NOT integrated. The candidate paired schema-3 ledger and
 * EnclaveDeploymentLifecycleEmergency (lifecycle-emergency-offline-r1 / peer lifecycle-ledger-v3-r1) are undeployed and
 * have no reviewed artifact/ABI/prover here; the r6 adapter pins lifecycleSchema 2. The normal path's non-running
 * transitions are signed by the owner authority or this host's operator with approvals [] and cannot report a crashed
 * host. Exact next adapter delta: docs/REPORT.md "Schema 3".
 */
export const EMERGENCY_OFFLINE = Object.freeze({ status: 'blocked', code: 'LIFECYCLE_SCHEMA3_INCOMPATIBLE',
  reason: 'pinned controller/ledger are lifecycleSchema 2; no reviewed schema-3 emergencyOffline/reconcileOffline ABI, deployment or prover is available' });

export class LifecycleActivationBlocked extends Error {
  constructor(missing) {
    super(`lifecycle dispatch blocked; required adapters missing: ${missing.join(', ')}`);
    this.code = 'LIFECYCLE_ACTIVATION_BLOCKED'; this.missing = Object.freeze([...missing]);
  }
}

const exactKeys = (o, keys, what) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw Error(`${what} must be an object`);
  const extra = Object.keys(o).filter(k => !keys.includes(k)), absent = keys.filter(k => !Object.hasOwn(o, k));
  if (extra.length || absent.length) throw Error(`${what} has ${extra.length ? `unknown ${extra.join(',')}` : ''}${extra.length && absent.length ? '; ' : ''}${absent.length ? `missing ${absent.join(',')}` : ''}`);
};
const address = (v, what) => { if (!ADDRESS.test(v) || ZERO.test(v)) throw Error(`${what} must be a lowercase non-zero address`); return v; };
const hash = (v, what) => { if (!ID.test(v) || /^0x0{64}$/.test(v)) throw Error(`${what} must be a lowercase non-zero bytes32`); return v; };
const share = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const msg = e => String(e?.message || e).slice(0, 200);

function parseBinding(b) {
  const s3 = schema3Binding(b);
  exactKeys(b, s3 ? [...BINDING_KEYS, 'profile', 'bundleSha256', ...hostRegistryKeys(b)] : BINDING_KEYS, 'lifecycle chain binding');
  address(b.ledger, 'binding.ledger'); address(b.controller, 'binding.controller');
  hash(b.ledgerCodeHash, 'binding.ledgerCodeHash'); hash(b.controllerCodeHash, 'binding.controllerCodeHash');
  if (b.deploymentsSchema !== LIFECYCLE_DEPLOYMENTS_SCHEMA || b.lifecycleSchema !== (s3 ? 3 : LIFECYCLE_SCHEMA))
    throw Error(`lifecycle chain binding must pin deploymentsSchema 17 and lifecycleSchema ${s3 ? 3 : 2}`);
  return Object.freeze({ ...b });
}

/** The explicitly pinned wallets through which the PLATFORM owns hosts. Empty is valid (it owns none here); absent is not. */
export function parsePlatformWallets(w) {
  if (!Array.isArray(w) || w.length > 64) throw Error('platformWallets must be an explicit array (at most 64) of reviewed wallet addresses');
  w.forEach((a, i) => address(a, `platformWallets[${i}]`));
  if (new Set(w).size !== w.length) throw Error('platformWallets has duplicates');
  return Object.freeze([...w]);
}

/** Exact, finite, duplicate-free routes, all matching the runner's single pinned chain binding. -> Map of frozen routes */
export function parseLifecycleRoutes(routes, binding) {
  binding = parseBinding(binding);
  const s3 = schema3Binding(binding);
  if (!Array.isArray(routes) || !routes.length) throw Error('at least one explicit lifecycle route is required; omit the dispatch for legacy behavior');
  if (routes.length > MAX_LIFECYCLE_ROUTES) throw Error(`at most ${MAX_LIFECYCLE_ROUTES} lifecycle routes`);
  const out = new Map();
  for (const [i, r] of routes.entries()) {
    const what = `lifecycle route ${i}`;
    exactKeys(r, s3 ? [...ROUTE_KEYS, 'profile', 'bundleSha256', ...hostRegistryKeys(binding)] : ROUTE_KEYS, what);
    if (s3 && (r.profile !== binding.profile || r.bundleSha256 !== binding.bundleSha256))
      throw Error(`${what}: profile or bundle differs from the exact chain binding`);
    if (hostRegistryKeys(binding).some(k => r[k] !== binding[k])) throw Error(`${what}: host registry identity differs from the exact chain binding`);   // host-registry r2
    if (!ID.test(r.deployment)) throw Error(`${what}: deployment must be a lowercase bytes32 id`);
    address(r.oldLedger, `${what}.oldLedger`); address(r.newLedger, `${what}.newLedger`); address(r.controller, `${what}.controller`);
    hash(r.ledgerCodeHash, `${what}.ledgerCodeHash`); hash(r.controllerCodeHash, `${what}.controllerCodeHash`);
    hash(r.quiescenceDigest, `${what}.quiescenceDigest`);
    if (r.oldLedger === r.newLedger) throw Error(`${what}: old and new ledger are the same`);
    if (r.deploymentsSchema !== LIFECYCLE_DEPLOYMENTS_SCHEMA || r.lifecycleSchema !== binding.lifecycleSchema)
      throw Error(`${what}: deploymentsSchema 17 and lifecycleSchema ${binding.lifecycleSchema} required`);
    if (out.has(r.deployment)) throw Error(`${what}: duplicate route for ${r.deployment}`);
    for (const k of ['ledger', 'controller', 'ledgerCodeHash', 'controllerCodeHash'])
      if (r[k === 'ledger' ? 'newLedger' : k] !== binding[k]) throw Error(`${what}: ${k} does not match the pinned lifecycle chain binding`);
    out.set(r.deployment, Object.freeze({ ...r }));
  }
  return out;
}

/** Does a journaled intent (exact r6 canonical payload) target running? Unparsable -> true: it may start something. */
function runningIntent(x) {
  try { return JSON.parse(x.payload).intent.target === RUNNING_TARGET; } catch { return true; }
}

/**
 * createLifecycleDispatch(parts) -> dispatch. Any absent safety adapter is LifecycleActivationBlocked: there are no
 * default, no-op or "assume allowed" substitutes. With onMissing: 'hold' the routes are still parsed (against
 * chain.binding) and OWNED, so the host keeps them away from every legacy path, but every one stays HELD and the
 * runner is never constructed; state() names the missing adapters.
 *   routes               exact route objects (ROUTE_KEYS)
 *   chain                the qualified lifecycle chain adapter for DeploymentLifecycleRunner, plus an immutable `binding`
 *   runtime, journal     the isolation runtime and the OWNED lifecycle journal (never the legacy release journal); the
 *                        journal must carry the host-authority section (generate-lifecycle-journal-candidate.mjs)
 *   inventory            the manager's name inventory (IsolationManagerClient: findByName -> view | null, throws = unknown)
 *   pins                 reviewed lifecycle pins ({ chainId: 8453, lifecycle: controller })
 *   authority.decision(id, snapshot)  the host wallet's authenticated admission for this routed record (DECISION_KEYS):
 *                        owner/revision/policyHash from EnclaveHostOwnership, refusal from the owner's committed policy
 *                        and content integrity. Throws when unknown. Never an ownership boolean.
 *   platformWallets      reviewed wallets through which the platform owns hosts; its host policy binds only those hosts
 *   capacityHeadroom     share (0..0.5) of each axis kept free beyond allocations and pending starts
 *   verifyQuiescence(route) proof-qualified evidence that the legacy assignment is fenced and quiescent
 */
export function createLifecycleDispatch({ routes, chain, runtime, journal, inventory, pins, authority, platformWallets, capacityHeadroom,
  verifyQuiescence, now = Date.now, random = Math.random, intervalMs = 5000, onMissing = 'throw', hostIncarnationGenesis = 'explicit' } = {}) {
  if (onMissing !== 'throw' && onMissing !== 'hold') throw Error('onMissing must be throw or hold');
  const missing = [];
  for (const f of CHAIN_FNS) if (typeof chain?.[f] !== 'function') missing.push(`chain.${f}`);
  for (const f of RUNTIME_FNS) if (typeof runtime?.[f] !== 'function') missing.push(`runtime.${f}`);
  for (const f of JOURNAL_FNS) if (typeof journal?.[f] !== 'function') missing.push(`journal.${f}`);
  if (typeof inventory?.findByName !== 'function') missing.push('inventory.findByName');
  if (!pins || typeof pins !== 'object') missing.push('pins');
  if (typeof authority?.decision !== 'function') missing.push('authority.decision');
  if (platformWallets === undefined || platformWallets === null) missing.push('platformWallets');
  if (capacityHeadroom === undefined || capacityHeadroom === null) missing.push('capacityHeadroom');
  if (typeof verifyQuiescence !== 'function') missing.push('verifyQuiescence');
  // host-registry r2: the exact profile requires the DURABLE host incarnation section of the owned journal (no in-memory substitute)
  const HR = hostRegistryKeys(chain?.binding).length > 0;
  if (HR) for (const f of HOST_INCARNATION_FNS) if (typeof journal?.[f] !== 'function') missing.push(`journal.${f} (durable host incarnation)`);
  if (HR && hostIncarnationGenesis !== 'explicit') throw Error('hostIncarnationGenesis must be explicit; unknown imported runtimes require safe adoption');
  // Without the binding no route ledger can be checked, so not even a held table can be built.
  if (!chain?.binding) throw new LifecycleActivationBlocked(['chain.binding', ...missing]);
  if (missing.length && onMissing === 'throw') throw new LifecycleActivationBlocked(missing);
  const blocked = Object.freeze([...missing]);
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 10000) throw Error('lifecycle cadence must be 1000..10000 ms (permits last 20 s)');
  const binding = parseBinding(chain.binding);
  const emergencyStatus = schema3Binding(binding) ? Object.freeze({
    status: 'unconfigured', code: 'LIFECYCLE_REPORTER_NOT_CONFIGURED',
    reason: 'schema3 app cutoff is qualified; independent emergency submission and host registry offline are not installed by this dispatch'
  }) : EMERGENCY_OFFLINE;
  if (pins && (pins.chainId !== 8453 || String(pins.lifecycle || '').toLowerCase() !== binding.controller))
    throw Error('lifecycle pins do not match the bound controller');
  const platform = platformWallets == null ? Object.freeze([]) : parsePlatformWallets(platformWallets);
  if (capacityHeadroom != null && !(typeof capacityHeadroom === 'number' && capacityHeadroom >= 0 && capacityHeadroom <= MAX_CAPACITY_HEADROOM))
    throw Error(`capacityHeadroom must be a share 0..${MAX_CAPACITY_HEADROOM}`);
  const table = parseLifecycleRoutes(routes, binding);
  const durable = typeof journal?.readHostAuthority === 'function';

  let host = null, timer = null, activating = null, durableError = null;
  const activated = new Map();   // id -> { at, evidence } ; never removed in this process
  const heldWhy = new Map();     // id -> activation refusal
  const localHolds = new Map();  // id -> why (box owner restriction from a legacy give-up path); mirrored in the owned journal
  const epochs = new Map();      // id -> bumped by every local restriction; in-flight effects check it
  const active = new Map();      // id -> context of the reconcile currently inside the runner
  const inflight = new Map();    // id -> the ONE reconcile promise
  const last = new Map();        // id -> last outcome (in memory only: never a gate on authenticated state)
  const decisions = new Map();   // id -> last validated admission decision (ingress uses it until validUntil)
  const alloc = new Map();       // id -> capacity allocation (see allocation())
  const epoch = id => epochs.get(id) || 0;
  const say = m => { try { host?.log(`lifecycle: ${m}`); } catch {} };

  // ---- capacity (r3) ------------------------------------------------------------------------------------------------
  //  observed   the manager inventory gave a definite answer for this id in THIS process
  //  physical   a runtime may exist: listed by the manager, inventory unknown, reported by health, or started here.
  //             Cleared ONLY by a confirmed runtime.stop() or a definite absent listing with no start effect here.
  //  reserved   this process attempted a start effect (ensureStaged / running intent); cleared only by confirmed stop
  //  commitment the owned journal holds a pending or mined running intent (it may start or keep a runtime here)
  //  known      { cpuShare, gpuShare } from the AUTHENTICATED snapshot resources via the host's own share accounting
  const allocation = (id) => {
    let a = alloc.get(id);
    if (!a) { a = { observed: false, physical: true, reserved: false, commitment: true, known: null, why: 'not yet observed since this process started' }; alloc.set(id, a); }
    return a;
  };
  const stateOf = (id) => {
    const a = allocation(id);
    if (!a.observed) return 'unresolved';
    if (!a.physical && !a.reserved && !a.commitment) return 'none';
    return a.known ? 'committed' : 'unresolved';
  };
  // The allocation is written into the host record at once (synchronously), so Host.shareUse - which every capacity
  // view, lifecycle or legacy, sums - never lags a decision made here.
  function syncRecord(id) {
    const a = allocation(id), st = stateOf(id);
    try { host?.record(id, { lifecycle: true, lifecycleAllocated: st !== 'none', lifecycleCapacity: st,
      cpuShare: st === 'none' ? 0 : a.known?.cpuShare ?? 0, gpuShare: st === 'none' ? 0 : a.known?.gpuShare ?? 0 }); } catch {}
  }
  const unresolvedRoutes = (except = null) => [...table.keys()].filter(x => x !== except && stateOf(x) === 'unresolved');
  function checkedShares(id, resources) {
    if (!resources || typeof resources !== 'object' || !share(resources.cpuShare) || !share(resources.gpuShare))
      throw Error('deployment resource shares are not in the authenticated snapshot; capacity unknown');
    const s = host.shareOf(id, resources);
    if (!s || !share(s.cpuShare) || !share(s.gpuShare)) throw Error('host share accounting returned no valid shares');
    // never below what the authenticated record dials (the host may only raise it to the version's minima here)
    if (s.cpuShare + 1e-9 < resources.cpuShare || s.gpuShare + 1e-9 < resources.gpuShare) throw Error('host share accounting is below the authenticated shares');
    return Object.freeze({ cpuShare: s.cpuShare, gpuShare: s.gpuShare });
  }
  function learnShares(id, snapshot) {
    if (snapshot?.verified !== true || snapshot.resources === undefined) return;
    let s; try { s = checkedShares(id, snapshot.resources); } catch (e) { allocation(id).why = msg(e); return; }
    const a = allocation(id), k = a.known;
    // a live runtime keeps at least what it was sized for; a resize up is counted at once
    a.known = (a.physical || a.reserved) && k ? Object.freeze({ cpuShare: Math.max(k.cpuShare, s.cpuShare), gpuShare: Math.max(k.gpuShare, s.gpuShare) }) : s;
    syncRecord(id);
  }
  async function observe(id) {
    const a = allocation(id);
    try {
      const row = journal.read(id);
      a.commitment = !!(row.pending && runningIntent(row.pending)) || (row.minedTransitions || []).some(runningIntent);
    } catch (e) { a.commitment = true; a.why = `owned journal unreadable: ${msg(e)}`; }
    let view;
    try {
      if (typeof inventory?.findByName !== 'function') throw Error('no manager inventory adapter');
      view = await inventory.findByName(id);
    } catch (e) { a.physical = true; a.why = `manager inventory unknown: ${msg(e)}`; syncRecord(id); return; }
    a.observed = true;
    if (view) a.physical = true;
    else if (!a.reserved) a.physical = false;   // the manager's definite absent listing, the evidence runtime.stop() itself uses
    syncRecord(id);
  }
  function present(id) { const a = allocation(id); a.physical = true; syncRecord(id); }
  function retired(id) {           // runtime.stop() resolved true: the manager no longer lists it
    const a = allocation(id); a.physical = false; a.reserved = false; a.observed = true; syncRecord(id);
  }
  function capacityRefusal(id, snapshot) {
    const others = unresolvedRoutes(id);
    if (others.length) return `capacity recovery unresolved for ${others.length} other lifecycle route(s) (${allocation(others[0]).why}); no new start until they are known`;
    if (!allocation(id).observed) return `this route's runtime inventory is not known (${allocation(id).why})`;
    let need; try { need = checkedShares(id, snapshot?.resources); } catch (e) { return msg(e); }
    let c; try { c = host.capacity(id); } catch (e) { return `host capacity unknown: ${e.message}`; }
    if (!c || c.paused !== false || ![c.cpuCap, c.gpuCap, c.cpuUsed, c.gpuUsed].every(Number.isFinite)) return 'host capacity unknown';
    if (c.cpuUsed + need.cpuShare + capacityHeadroom > c.cpuCap + 1e-9) return `capacity: CPU ${c.cpuUsed} allocated/pending + ${need.cpuShare} + headroom ${capacityHeadroom} exceeds ${c.cpuCap}`;
    if (need.gpuShare > 0 && c.gpuUsed + need.gpuShare + capacityHeadroom > c.gpuCap + 1e-9) return `capacity: GPU ${c.gpuUsed} allocated/pending + ${need.gpuShare} + headroom ${capacityHeadroom} exceeds ${c.gpuCap}`;
    return null;
  }

  // ---- durable host authority (r3) ----------------------------------------------------------------------------------
  function hostFloor() {
    const r = journal.readHostAuthority(host.hostId);   // throws when the owned journal is unreadable: unknown, never allow
    return r?.floor ? { revision: BigInt(r.floor.revision), owner: r.floor.owner, policyHash: r.floor.policyHash } : null;
  }
  // ---- host-registry r2: durable HOST INCARNATION (canonical registry generation), distinct from the app assignment generation ----
  // Every app context is bound in the owned journal, BEFORE its start effect, to the exact incarnation it started (or was explicitly
  // adopted) under. Any other current incarnation fences serving and new starts while old work may exist: never inherited. A journal or
  // decision that cannot be read is unknown, never allow. Nothing here releases a local hold or rewrites a journaled intent.
  const incarnation = () => {
    const r = journal.readHostIncarnation(host.hostId);   // throws when unreadable
    return { floor: r?.floor ?? null, genesis: r?.genesis ?? null, bound: r?.bound ?? {} };
  };
  const freshSnapshots = new Map();   // host-authority completion r2: the authenticated snapshot behind each freshDecision
  const requeuePending = id => { try { return incarnation().bound[id]?.requeue === true; } catch { return true; } };
  const oldWork = id => { const a = allocation(id); return !a.observed || a.physical || a.reserved || a.commitment; };
  function acceptIncarnation(d) {   // monotonic, persisted BEFORE use: lower generation = rollback, same generation other digest = equivocation
    const x = validateHostIncarnation(d.hostIncarnation, { hostId: host.hostId, registry: binding.hostRegistry, registryCodeHash: binding.hostRegistryCodeHash });
    journal.acceptHostIncarnation(host.hostId, x);
  }
  function incarnationRefusal(id, d) {
    try {
      const x = d?.hostIncarnation;
      if (!x) return 'host incarnation unknown';
      const st = incarnation(), b = st.bound[id];
      if (!st.floor || st.floor.digest !== x.digest || st.floor.generation !== x.generation) return `host incarnation ${x.generation} is not the durable accepted floor`;
      if (st.floor.offline) return `canonical host recorded Offline at generation ${st.floor.offline.generation}: no serving or start until a newer qualified generation`;   // host-authority completion r2
      if (b && b.digest === x.digest) return null;
      if (!oldWork(id)) return null;   // nothing of an older context can exist: a NEW start binds the current incarnation
      if (b) return `app context bound to host generation ${b.generation}, canonical host is now generation ${x.generation}: fenced until stopped or explicitly adopted`;
      return 'running app context has no recorded host incarnation: unknown until explicitly adopted';
    } catch (e) { return `host incarnation journal unknown: ${msg(e)}`; }
  }
  function bindIncarnation(id, d, why, requeue = false) {
    const x = d.hostIncarnation;
    if (incarnation().bound[id]?.digest === x.digest && (incarnation().bound[id]?.requeue === true) === requeue) return;
    journal.bindHostIncarnation(host.hostId, id, { generation: x.generation, digest: x.digest, reason: why, at: now(), requeue });
  }
  function incarnationGate(id, d) {   // read time: a mismatch is UNKNOWN (fences serve/start, the runner keeps reconciling and revoking)
    const why = incarnationRefusal(id, d);
    if (why) return why;
    return null;
  }
  // A FRESH authenticated read + decision of this route (adapter: code/schema/closure at its block); cached decisions never count.
  async function freshDecision(id, what) {
    const r = table.get(id), s = await chain.read(id);
    if (!s || s.id !== id || s.ledger !== r.newLedger || s.controller !== r.controller || s.thisHost !== host.hostId || s.verified !== true)
      throw Error(`${what}: no verified snapshot of this route`);
    freshSnapshots.set(id, s);   // host-authority completion r2
    return checkDecision(id, await authority.decision(id, s));
  }
  // Immediately before a Running transition is BROADCAST: exact Online status, durable floor and the app binding at a fresh read.
  // Refusal here is sender-side no-effect; the journaled intent stays for read-only resolution.
  async function submitBoundary(id) {
    const d = await freshDecision(id, 'running submission refused before broadcast'), b = incarnation().bound[id];
    const why = denial(id, d) ?? (d.hostIncarnation.status !== 'online' ? `canonical host is ${d.hostIncarnation.status}` : null) ??
      (b?.digest !== d.hostIncarnation.digest ? `the prepared start is not bound to current host generation ${d.hostIncarnation.generation}` : null);
    if (why) throw Error(`running submission refused before broadcast: ${why}`);
  }
  function checkDecision(id, d) {
    exactKeys(d, DECISION_KEYS.concat(HR ? ['hostIncarnation'] : []), 'host admission decision');
    if (d.hostId !== host.hostId || d.deployment !== id) throw Error('admission decision binds another host or deployment');
    address(d.owner, 'decision.owner');
    if (typeof d.revision !== 'string' || !UINT.test(d.revision)) throw Error('decision.revision must be a decimal string');
    if (!ID.test(d.policyHash)) throw Error('decision.policyHash must be a lowercase bytes32');
    if (d.refusal !== null && (typeof d.refusal !== 'string' || !d.refusal)) throw Error('decision.refusal must be null or a reason');
    if (!Number.isSafeInteger(d.validUntil) || d.validUntil <= now()) throw Error('admission decision is not fresh');
    if (durableError) throw Error(durableError);
    const rev = BigInt(d.revision), floor = hostFloor();
    if (floor && (rev < floor.revision || (rev === floor.revision && (d.owner !== floor.owner || d.policyHash !== floor.policyHash))))
      throw Error(`host authority replay or equivocation (revision ${rev} vs accepted ${floor.revision})`);
    // persisted BEFORE it is used: a crash after this point cannot reopen at a lower floor
    if (!floor || rev > floor.revision) journal.acceptHostAuthority(host.hostId, { revision: d.revision, owner: d.owner, policyHash: d.policyHash });
    if (HR) acceptIncarnation(d);   // host-registry r2
    return Object.freeze({ ...d, platformOwned: platform.includes(d.owner) });
  }
  // Why THIS host must not run the routed app now (owner-scoped). null = no denial. Sync; re-evaluated at every effect.
  function denial(id, decision) {
    const local = localHolds.get(id);
    if (local) return `restricted: ${local}`;
    if (HR && requeuePending(id)) return 'explicitly adopted app context: its stopped runtime settles through an authorized queued transition before any fresh start';   // host-authority completion r2
    const owner = host.ownerRestriction();
    if (owner) return owner;
    if (decision?.refusal) return `host owner policy: ${decision.refusal}`;
    // The platform's host policy is an owner right only on a host its pinned wallet authentically owns.
    if (decision?.platformOwned) { const p = host.platformService(); if (p) return `${p} (this host is owned by a pinned platform wallet)`; }
    return null;
  }
  function serveRefusal(id) {
    const ctx = active.get(id);
    if (!ctx || ctx.epoch !== epoch(id)) return 'lifecycle context changed during reconcile';
    if (ctx.unknown) return ctx.unknown;
    if (HR) { const w = incarnationRefusal(id, ctx.decision); if (w) return w; }   // host-registry r2: re-checked at every serve/start
    if (!ctx.decision || ctx.decision.validUntil <= now()) return 'host admission expired';
    return denial(id, ctx.decision);
  }
  // A start (stage or running intent): every serving condition, plus new work, release journal, capacity. The check and
  // the reservation are one synchronous step: concurrent passes (Promise.all) see each other's reservations.
  function assertStart(id, snapshot) {
    const why = serveRefusal(id) ?? (() => {
      const hold = host.legacyHold(id);
      if (hold) return `legacy release intent unresolved (retained): ${hold}`;
      if (active.get(id).decision.platformOwned) { const nw = host.platformNewWork(); if (nw) return `${nw} (this host is owned by a pinned platform wallet)`; }
      return capacityRefusal(id, snapshot);
    })();
    if (why) throw Error(`lifecycle start refused: ${why}`);
    if (HR) bindIncarnation(id, active.get(id).decision, 'new start');   // host-registry r2: persisted BEFORE the start effect
    const a = allocation(id), need = checkedShares(id, snapshot.resources);
    a.reserved = true;
    a.known = a.known ? Object.freeze({ cpuShare: Math.max(a.known.cpuShare, need.cpuShare), gpuShare: Math.max(a.known.gpuShare, need.gpuShare) }) : need;
    // provisioning + isolationRequired: Host.occupies counts it even before any instance id exists
    try { host.record(id, { status: 'provisioning', lifecycle: true, isolationRequired: true }); } catch {}
    syncRecord(id);
  }

  let runner = null;
  if (!blocked.length) {
    // The runner's adapters, with refusals ADDED. Nothing here returns authority the wrapped adapter did not.
    const boundChain = {
      async read(id) {
        const r = table.get(id);
        if (!r) throw Error('no lifecycle route');
        if (HR) decisions.delete(id);   // host-registry r2: an unknown/failed read leaves NO previous decision usable (ingress, adoption)
        const s = await chain.read(id);
        if (!s || s.id !== id || s.ledger !== r.newLedger || s.controller !== r.controller || s.thisHost !== host.hostId) throw Error('lifecycle read is not from this route\'s ledger, controller and attached host');
        learnShares(id, s);
        const ctx = active.get(id);
        try { ctx.decision = checkDecision(id, await authority.decision(id, s)); ctx.unknown = null; decisions.set(id, ctx.decision); if (HR) ctx.unknown = incarnationGate(id, ctx.decision); if (HR && !ctx.unknown && s.assignment?.state !== 'running' && !oldWork(id) && requeuePending(id)) bindIncarnation(id, ctx.decision, 'requeued after explicit adoption: assignment no longer running', false); }
        catch (e) { ctx.decision = null; ctx.unknown = `host admission unknown: ${msg(e)}`; decisions.delete(id); }
        // An owner-scoped denial LOWERS admission, so the runner fences, stops and records a revocation itself.
        // Unknown admission does not: it refuses serving and starts at their effects, and the runner keeps reconciling.
        const deny = ctx.decision ? denial(id, ctx.decision) : (localHolds.get(id) ? `restricted: ${localHolds.get(id)}` : host.ownerRestriction());
        ctx.deny = deny;
        return deny ? { ...s, admitted: false } : s;
      },
      resolve: (id, intent) => chain.resolve(id, intent),
      finalize: (id, intent) => chain.finalize(id, intent),
      // A revocation is never gated by an online denial. A start is gated BEFORE the runner journals it and again
      // after the unsigned preparation (root r1 fix). submit is never gated: a journaled intent must be sent or reconciled.
      async prepare(id, snapshot, target, reason) {
        if (REVOCATIONS.has(target)) return chain.prepare(id, snapshot, target, reason);
        assertStart(id, snapshot);
        const intent = await chain.prepare(id, snapshot, target, reason);
        assertStart(id, snapshot);
        return intent;
      },
      submit: (id, intent) => HR && runningIntent(intent) ? submitBoundary(id).then(() => chain.submit(id, intent)) : chain.submit(id, intent),
    };
    const boundRuntime = {
      fence: id => runtime.fence(id),
      // only a CONFIRMED stop releases capacity; false, a throw or a timeout keeps the allocation
      async stop(id) { const ok = await runtime.stop(id); if (ok === true) retired(id); return ok; },
      async health(id, generation) {
        const h = await runtime.health(id, generation);
        if (h?.ready === true || (h?.ended !== true && typeof h?.instance === 'string' && h.instance.length)) present(id);
        return h;
      },
      async ensureStaged(id, snapshot) { assertStart(id, snapshot); return runtime.ensureStaged(id, snapshot); },
      async serve(id, snapshot) { const why = serveRefusal(id); if (HR && runtime?.hostAuthorityPermit !== true) throw Error('lifecycle serving refused: independent-host-registry-r1 serves only through the v2 host-authority permit runtime'); if (why) throw Error(`lifecycle serving refused: ${why}`); return runtime.serve(id, HR ? Object.freeze({ ...snapshot, hostIncarnation: active.get(id).decision.hostIncarnation }) : snapshot); },
    };
    runner = new DeploymentLifecycleRunner({ chain: boundChain, runtime: boundRuntime, journal, pins, now, random });
  }

  function publish(id, result) {
    last.set(id, { ...result, at: now() });
    const s = result.status;
    const status = s === 'running' ? 'running' : s === 'stopped' || s === 'elsewhere' ? 'stopped' : s === 'held' ? 'held' : 'provisioning';
    // provisioning + isolationRequired: a staged VM may exist, so the legacy capacity view counts it (Host.occupies).
    // The allocation itself is never released here: only observe()/retired() change it, on evidence.
    try { host?.record(id, { status, reason: result.reason || '', lifecycle: true, lifecycleStatus: s, isolationRequired: true }); } catch {}
    syncRecord(id);
    return result;
  }
  async function fenceHeld(id, why, stop = false) {
    let reason = why;
    if (typeof runtime?.fence !== 'function') reason = `${why}; no lifecycle runtime to fence`;
    else try {
      await runtime.fence(id);
      if (stop) {
        const ok = typeof runtime.stop === 'function' && await runtime.stop(id);
        if (ok === true) retired(id); else reason = `${why}; stop not confirmed`;
      }
    } catch (e) { reason = `${why}; runtime withdrawal failed: ${e.message}`; }
    return publish(id, { status: 'held', reason });
  }

  async function reconcileOnce(id) {
    await observe(id);
    if (!runner) return fenceHeld(id, `lifecycle adapters missing: ${blocked.join(', ')}`);
    if (!activated.has(id)) return fenceHeld(id, heldWhy.get(id) || 'route not activated');
    // After activation nothing here holds the runner: authenticated reads, journaled-intent reconciliation and
    // revocations always proceed; serving and starts are refused at their effects.
    const started = epoch(id);
    active.set(id, { epoch: started, decision: null, unknown: 'host admission not read', deny: null });
    let result;
    try { result = await runner.reconcile(id); }
    catch (e) { result = { status: 'held', reason: `lifecycle runner failed: ${e.message}` }; }
    finally { active.delete(id); }
    if (epoch(id) !== started) return fenceHeld(id, `restricted (changed during reconcile; last: ${result.status})`, true);
    return publish(id, result);
  }

  const dispatch = {
    binding,
    blocked,
    platformWallets: platform,
    emergencyOffline: emergencyStatus,
    routes: () => [...table.values()],
    owns: id => table.has(String(id || '').toLowerCase()),
    attach(view) {
      if (host) throw Error('lifecycle dispatch is already attached to a host');
      if (!view || !ID.test(view.hostId || '') || HOST_FNS.some(f => typeof view[f] !== 'function'))
        throw new LifecycleActivationBlocked(['hostId', ...HOST_FNS].filter(f => f === 'hostId' ? !ID.test(view?.hostId || '') : typeof view?.[f] !== 'function'));
      host = Object.freeze({ ...view });
      // The box owner's local holds survive a restart: they are re-read from the owned journal before anything runs.
      if (durable) {
        try {
          const r = journal.readHostAuthority(host.hostId);
          for (const [id, h] of Object.entries(r?.holds || {})) if (table.has(id)) localHolds.set(id, h.why);
        } catch (e) { durableError = `owned journal host authority unreadable: ${msg(e)}`; }
      }
      for (const id of table.keys()) publish(id, { status: 'held', reason: blocked.length ? `lifecycle adapters missing: ${blocked.join(', ')}` : 'route not activated' });
      return dispatch;
    },
    /**
     * Verify each not-yet-activated route once. Activation is the handoff: it binds the EXACT legacy ledger, an empty
     * legacy release journal entry (never cleared here), no legacy work in this process and finalized quiescence
     * evidence. The mutable address book is not consulted, even on a cold restart.
     */
    activate() {
      if (!host) return Promise.reject(Error('lifecycle dispatch is not attached to a host'));
      activating ||= (async () => {
        for (const [id, r] of table) {
          if (activated.has(id)) continue;
          if (blocked.length) { heldWhy.set(id, `lifecycle adapters missing: ${blocked.join(', ')}`); continue; }
          const local = () => {
            // The explicit route and its authenticated old-ledger proof bind the source ledger.
            // A mutable discovery/address-book choice is not handoff authority, including after restart.
            const hold = host.legacyHold(id); if (hold) return `legacy release intent unresolved (retained): ${hold}`;
            const busy = host.legacyActivity(id); if (!Array.isArray(busy)) return 'legacy activity unknown';
            return busy.length ? `legacy work in this process: ${busy.join(', ')}` : null;
          };
          let why = local(), evidence = null;
          if (!why) {
            try { evidence = await verifyQuiescence(r); } catch (e) { why = `quiescence evidence unavailable: ${e.message}`; }
            if (!why && !(evidence?.verified === true && evidence.proofVerified === true && PROOF_TIERS.includes(evidence.authorityTier) &&
                evidence.deployment === id && evidence.ledger === r.oldLedger && evidence.digest === r.quiescenceDigest && evidence.quiescent === true))
              why = 'legacy quiescence evidence does not bind this route';
            why ||= local();   // re-checked after the await
          }
          if (why) { heldWhy.set(id, why); say(`${id.slice(0, 10)} held: ${why}`); continue; }
          heldWhy.delete(id);
          activated.set(id, Object.freeze({ at: now(), oldLedger: r.oldLedger, evidence: Object.freeze({ ...evidence }) }));
          say(`${id.slice(0, 10)} activated on ${r.newLedger}; legacy ledger ${r.oldLedger} handed off`);
        }
        return dispatch.state();
      })().finally(() => { activating = null; });
      return activating;
    },
    /** ONE reconcile per deployment: concurrent callers (cadence, tests) join it. */
    reconcile(id) {
      id = String(id || '').toLowerCase();
      if (!table.has(id)) return Promise.resolve({ status: 'refused', reason: 'no lifecycle route for this id' });
      let p = inflight.get(id);
      if (p) return p;
      p = reconcileOnce(id).catch(e => fenceHeld(id, `lifecycle dispatch failed: ${e.message}`))
        .finally(() => { if (inflight.get(id) === p) inflight.delete(id); });
      inflight.set(id, p);
      return p;
    },
    pass() { return Promise.all([...table.keys()].map(id => dispatch.reconcile(id))); },
    /**
     * A legacy give-up path's owner decision (hosting off, caps), enforced locally AT ONCE: fence and stop. The
     * authenticated ledger record follows through the runner (it sees admission lowered and prepares a queue/stop
     * revocation through the chain adapter); runtime.stop alone never claims to change the ledger. The hold is
     * persisted in the owned journal; a persistence failure never delays the local stop.
     */
    async restrict(id, why) {
      id = String(id || '').toLowerCase();
      if (!table.has(id)) throw Error('no lifecycle route for this id');
      const reason = String(why || 'restricted').slice(0, 300);
      localHolds.set(id, reason); epochs.set(id, epoch(id) + 1);
      if (host && durable) {
        try { journal.holdHostLocal(host.hostId, id, { why: reason, at: now() }); }
        catch (e) { say(`${id.slice(0, 10)} local hold not persisted (held in memory): ${msg(e)}`); }
      }
      const r = await fenceHeld(id, `restricted: ${why}`, true);
      if (runner && activated.has(id)) (inflight.get(id) || Promise.resolve()).then(() => dispatch.reconcile(id)).catch(e => say(`follow-up: ${e.message}`));
      return r;
    },
    /**
     * The box owner changed their hosting controls through the authenticated local API (Host.setHostingCaps, after the
     * caps file is saved). Advances the durable owner-control epoch; when hosting is on, releases holds recorded under
     * an EARLIER epoch. Capacity and every other gate still decide each start. Never throws into the host.
     */
    ownerControlsChanged({ paused } = {}) {
      if (!host || !durable) return { released: [], epoch: null };
      let at;
      try { at = journal.advanceOwnerControls(host.hostId); } catch (e) { say(`owner control change not journaled; holds kept: ${msg(e)}`); return { released: [], epoch: null }; }
      if (paused === true) return { released: [], epoch: at };
      const released = [];
      let holds = {};
      try { holds = journal.readHostAuthority(host.hostId)?.holds || {}; } catch (e) { say(`holds unreadable; kept: ${msg(e)}`); }
      for (const [id, h] of Object.entries(holds)) {
        if (!(h.ownerEpoch < at)) continue;
        try { journal.releaseHostLocal(host.hostId, id); localHolds.delete(id); released.push(id); }
        catch (e) { say(`${id.slice(0, 10)} hold kept: ${msg(e)}`); }
      }
      if (released.length) say(`owner control change released ${released.length} local hold(s)`);
      return { released, epoch: at };
    },
    /**
     * host-registry r2: the box owner's EXPLICIT adoption (authenticated local hosting-admin path, like restrict) of an existing app context
     * into the exact CURRENT Online host incarnation, named by decimal generation and digest. It takes its OWN fresh authenticated read
     * (an unknown chain refuses), needs an unrefused decision, the durable floor and no local hold, and fences old-context serving before
     * the durable rebinding. Never automatic; never a platform decision over a foreign host.
     */
    async adoptHostIncarnation(id, { generation, digest } = {}) {
      id = String(id || '').toLowerCase();
      if (!HR) throw Error('host incarnation adoption exists only in the host-registry profile');
      if (!host || !runner || !table.has(id) || !activated.has(id)) throw Error('lifecycle route not activated');
      if (inflight.has(id)) throw Error('host adoption cannot overlap reconciliation or another adoption');
      const startingEpoch = epoch(id);
      const stableLocal = () => {
        if (epoch(id) !== startingEpoch || localHolds.get(id)) throw Error('owner controls changed or hold remains during adoption');
        const row = journal.read(id);
        if (row.pending || (row.minedTransitions || []).length) throw Error('pending or nonfinal app transition must be reconciled before adoption');
      };
      const named = () => Error('adoption must name the exact current Online host incarnation (decimal generation and digest)');
      if (typeof generation !== 'string' || !/^0x[0-9a-f]{64}$/.test(digest || '')) throw named();
      let p;
      p = (async () => {
        stableLocal();
        const d = await freshDecision(id, 'adoption refused'), x = d.hostIncarnation, why = denial(id, d);
        if (why) throw Error(`adoption refused: ${why}`);
        if (x.status !== 'online' || generation !== x.generation || digest !== x.digest) throw named();
        stableLocal();
        await runtime.fence(id);
        if (await runtime.stop(id) !== true) throw Error('adoption refused: old runtime stop not confirmed');
        if (await inventory.findByName(id)) throw Error('adoption refused: old runtime still present');
        // A confirmed manager absence releases physical allocation, never a pending financial commitment.
        retired(id);
        stableLocal();
        const current = await freshDecision(id, 'adoption final read refused'), y = current.hostIncarnation;
        stableLocal();
        const finalWhy = denial(id, current);
        if (finalWhy) throw Error(`adoption refused: ${finalWhy}`);
        if (y.status !== 'online' || y.generation !== generation || y.digest !== digest ||
            current.owner !== d.owner || current.revision !== d.revision || current.policyHash !== d.policyHash)
          throw Error('host incarnation or accepted owner authority changed during adoption');
        const st = incarnation();
        if (!st.floor || st.floor.digest !== digest) throw Error('named incarnation is not the durable current floor');
        // host-authority completion r2: the v2 runtime/gate handoff under THIS adoption's final fresh read, still serialized
        if (runtime?.hostAuthorityPermit === true) {
          await runtime.adoptHostAuthority(id, freshSnapshots.get(id));
          // ownership r3: the await above can span a canonical owner change, Offline or recovery. Re-read independently NOW, before binding.
          let post = null, postWhy = null;
          try { if (await inventory.findByName(id)) postWhy = 'old runtime reappeared during the handoff'; } catch (e) { postWhy = `inventory unknown: ${msg(e)}`; }
          if (!postWhy) try { post = await freshDecision(id, 'adoption post-handoff read refused'); } catch (e) { postWhy = msg(e); }
          if (!postWhy) try { stableLocal(); } catch (e) { postWhy = msg(e); }
          if (!postWhy) { const z = post.hostIncarnation;
            postWhy = denial(id, post) ?? (z.status !== 'online' || z.generation !== generation || z.digest !== digest || post.owner !== d.owner ||
              post.revision !== d.revision || post.policyHash !== d.policyHash ? 'canonical host/owner authority changed during the runtime handoff' : null); }
          if (postWhy) {
            try { await runtime.revokeHostAuthority?.(id, freshSnapshots.get(id)); } catch (e) { say(`${id.slice(0, 10)} handoff revocation failed (gate stays fenced): ${msg(e)}`); }
            throw Error(`adoption aborted after the runtime handoff: ${postWhy}`);
          }
        }
        bindIncarnation(id, current, 'explicit owner adoption after confirmed runtime quiescence', true);
        say(`${id.slice(0, 10)} adopted into host generation ${generation} after confirmed stop`);
        return Object.freeze({ adopted: true, generation, digest });
      })().finally(() => { if (inflight.get(id) === p) inflight.delete(id); });
      inflight.set(id, p);
      return p;
    },
    /** null, or why NO new work (lifecycle or legacy) may be admitted on this host: a route's allocation is unknown. */
    capacityUnresolved() {
      const u = unresolvedRoutes();
      return u.length ? `lifecycle capacity recovery unresolved for ${u.length} route(s) (${allocation(u[0]).why}); new work is held` : null;
    },
    /** A claim hint never claims, reconciles or clears anything for a routed id (its `force` is not owner-authenticated). */
    considerHint(id) {
      id = String(id || '').toLowerCase();
      const l = last.get(id);
      return { accepted: false, standing: 'lifecycle', reason: `managed by the event-driven lifecycle route (${l?.status || 'unknown'}${l?.reason ? `: ${l.reason}` : ''}); no legacy claim` };
    },
    /** The host ingress decision for a routed id (sync): owner-scoped, never the platform's unless it owns this host. */
    ingressRefusal(id) {
      id = String(id || '').toLowerCase();
      if (!table.has(id)) return 'no lifecycle route for this id';
      if (!activated.has(id) || !host) return 'lifecycle route not activated';
      const l = last.get(id);
      if (l?.status !== 'running') return `not serving (${l?.status || 'not yet reconciled'})`;
      const d = decisions.get(id);
      if (!d || d.validUntil <= now()) return 'host admission not fresh';
      if (HR) { const w = denial(id, d) ?? incarnationRefusal(id, d); if (w) return w; }   // host-registry r2
      return denial(id, d);
    },
    start({ setInterval: every = setInterval } = {}) {
      if (!host) throw Error('lifecycle dispatch is not attached to a host');
      if (timer) return;
      timer = every(() => { dispatch.pass().catch(e => say(`pass: ${e.message}`)); }, intervalMs);
      timer?.unref?.();
      dispatch.pass().catch(e => say(`pass: ${e.message}`));
    },
    stop({ clearInterval: clear = clearInterval } = {}) { if (timer) clear(timer); timer = null; },
    state: () => [...table.keys()].map(id => {
      const d = decisions.get(id), a = allocation(id);
      return { id, activated: activated.has(id), held: heldWhy.get(id) || null, restricted: localHolds.get(id) || null,
        last: last.get(id) || null, blocked, reservation: a.reserved ? a.known : null,
        allocation: { state: stateOf(id), cpuShare: a.known?.cpuShare ?? null, gpuShare: a.known?.gpuShare ?? null,
          observed: a.observed, physical: a.physical, reserved: a.reserved, commitment: a.commitment, why: stateOf(id) === 'unresolved' ? a.why : null },
        hostAuthority: d ? { owner: d.owner, revision: d.revision, platformOwned: d.platformOwned, refusal: d.refusal } : null,
        ...(HR ? { hostIncarnation: d?.hostIncarnation ?? null } : {}),   // host-registry r2
        settlement: 'v2 paid proof-of-service settlement is not implemented by this dispatch',
        emergencyOffline: emergencyStatus.code };
    }),
  };
  return Object.freeze(dispatch);
}

/** The host's single entry: no dispatch -> null (legacy unchanged). Otherwise attach once with the host's live callbacks. */
export function attachLifecycleDispatch(dispatch, view) {
  if (dispatch === null || dispatch === undefined) return null;
  if (typeof dispatch.attach !== 'function' || typeof dispatch.owns !== 'function' || typeof dispatch.ingressRefusal !== 'function')
    throw Error('cfg.lifecycleDispatch must come from createLifecycleDispatch');
  return dispatch.attach(view);
}
