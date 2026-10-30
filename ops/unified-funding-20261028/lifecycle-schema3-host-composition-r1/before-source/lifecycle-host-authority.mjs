// Host-ownership-scoped admission for event-driven lifecycle routes, and the composer that wires it to the generated
// independent-profile chain adapter (r6 + tools/generate-lifecycle-adapter-candidate.mjs). Intended location:
// network/lifecycle-host-authority.mjs. NOT activated by any environment flag; nothing here changes legacy admission
// (host-admission-policy.mjs and host-admission-runtime.mjs are imported, never modified, and keep their behavior).
//
// Separation kept here (r3):
//  - INTEGRITY (always): the referenced catalog version exists with a content commitment.
//  - HOST OWNER (always): the policy the host wallet committed in EnclaveHostOwnership (hash-checked by the production
//    readHostAdmissionPolicy), including its deny lists.
//  - CATALOG MODERATION AND PUBLISHER LISTING (optional): catalog-owner approval and the publisher's delist/yank apply
//    only when the host owner elected requireCatalogApproval. r2 made delist/yank mandatory "publisher consent"; that
//    kept a global veto for whoever published the app (root goal correction). They are metadata otherwise.
//  - ONE BLOCK (r3): with the independent-profile adapter, admission is derived from the adapter's authenticated
//    snapshot itself (createSnapshotHostAdmission): host owner, policy, content, resources and forPrivate all come from
//    the same block as the ledger/controller state. The r2 separate-reader admission remains available, unchanged.
import { parseAbi } from 'viem';
import { hostAuthorityReader, readHostAdmissionPolicy } from './host-admission-policy.mjs';
import { canonicalAppRef, catalogIntegrityRefusal, independentAdmissionRefusal, publisherListing } from './lifecycle-independent-admission.mjs';
import { createLifecycleDispatch, LifecycleActivationBlocked } from './lifecycle-host-dispatch.mjs';

export { canonicalAppRef, catalogIntegrityRefusal, independentAdmissionRefusal, publisherListing };

const ID = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/, ZERO = /^0x0{40}$/, UINT = /^(0|[1-9][0-9]{0,30})$/;
const SNAPSHOT_MS = 90_000;   // the production host admission's chain snapshot lifetime (host-admission-runtime.mjs)
const DECISION_MS = 20_000;   // a snapshot-derived decision lives no longer than a serving permit
export const INDEPENDENT_PROFILE = 'independent-r1';
// The production catalog views (host-admission-runtime.mjs catalogABI, verbatim).
const catalogABI = parseAbi([
  'function getApp(bytes32) view returns ((bytes32 appId,address publisher,string slug,string name,string description,uint32 versionCount,uint64 createdAt,uint64 updatedAt,bool active))',
  'function getVersion(bytes32,uint256) view returns ((string cid,string version,uint32 vramMb,uint32 gpuGflops,uint32 memMb,uint32 cpuGflops,uint64 createdAt,bool verified,bool yanked,string ports,uint8 approval,string config))',
]);
const fresh = (t, at) => Number.isSafeInteger(t) && t <= at + 5000 && t + SNAPSHOT_MS > at;

/**
 * The authenticated owner of THIS host from the pinned EnclaveHostOwnership, through the production reader
 * (hostAuthorityReader -> LeaseReader.agreed) and readHostAdmissionPolicy (document hash-checked). Enforces a
 * monotonic revision floor: an older revision (replay) or a different owner/policy at one revision (equivocation) is
 * unknown, never allow. (r2; the dispatch additionally persists its floor in the owned journal.)
 */
export function createScopedHostAuthority({ hostId, ownershipContract, reader, loadPolicy, now = Date.now }) {
  if (!ID.test(hostId || '') || !ADDRESS.test(ownershipContract || '') || ZERO.test(ownershipContract)) throw Error('exact host and ownership contract required');
  if (typeof reader?.agreed !== 'function' || typeof loadPolicy !== 'function') throw Error('agreeing chain reader and policy loader required');
  const readAuthority = hostAuthorityReader(reader);
  let floor = null;
  return {
    hostId, ownershipContract,
    async snapshot() {
      let raw = null;
      const resolved = await readHostAdmissionPolicy({ hostId, ownershipContract, loadPolicy,
        readAuthority: async (c, h) => (raw = await readAuthority(c, h)) });
      if (!fresh(raw?.timestamp, now())) throw Error('host authority snapshot expired');
      const revision = BigInt(resolved.revision);
      if (floor && (revision < floor.revision || (revision === floor.revision && (resolved.owner !== floor.owner || raw.policyHash !== floor.policyHash))))
        throw Error(`host authority replay or equivocation (revision ${revision} vs accepted ${floor.revision})`);
      floor = { revision, owner: resolved.owner, policyHash: raw.policyHash };
      return Object.freeze({ hostId, owner: resolved.owner, revision: revision.toString(), policyHash: raw.policyHash,
        policy: resolved.policy, validUntil: raw.timestamp + SNAPSHOT_MS });
    },
  };
}

/** The production catalog views at one agreeing block. Unknown (throws) on any failure; never allow. */
export function catalogVersionReader({ reader, catalog }) {
  if (!ADDRESS.test(catalog || '') || ZERO.test(catalog) || typeof reader?.agreed !== 'function') throw Error('pinned catalog and agreeing reader required');
  return async (appRef) => {
    const ref = canonicalAppRef(appRef);
    return reader.agreed(async (client, blockNumber) => {
      const [app, v] = await Promise.all([
        client.readContract({ address: catalog, abi: catalogABI, functionName: 'getApp', args: [ref.appId], blockNumber }),
        client.readContract({ address: catalog, abi: catalogABI, functionName: 'getVersion', args: [ref.appId, BigInt(ref.index)], blockNumber }),
      ]);
      return { app: { appId: String(app.appId).toLowerCase(), versionCount: String(app.versionCount), active: app.active === true },
        version: { cid: String(v.cid), createdAt: String(v.createdAt), yanked: v.yanked, approval: Number(v.approval) } };
    });
  };
}

/** r2 separate-reader authority.decision(id, snapshot): the exact DECISION_KEYS, bound to host and deployment. */
export function createIndependentHostAdmission({ hostId, ownership, readCatalog, now = Date.now }) {
  if (!ID.test(hostId || '') || ownership?.hostId !== hostId || typeof ownership.snapshot !== 'function' || typeof readCatalog !== 'function')
    throw Error('host-bound ownership and catalog reader required');
  return {
    hostId,
    async decision(id, snapshot) {
      if (!ID.test(id || '') || snapshot?.id !== id) throw Error('admission needs the authenticated snapshot of this deployment');
      const a = await ownership.snapshot();
      const c = await readCatalog(snapshot.appRef);
      const at = now();
      if (!fresh(c?.timestamp, at)) throw Error('catalog snapshot expired during admission');
      if (a.validUntil <= at) throw Error('host authority expired during admission');
      // forPrivate only relaxes elected moderation; absent from the snapshot it is false (stricter).
      const refusal = independentAdmissionRefusal(a.policy, { hostId, deploymentId: id, appRef: snapshot.appRef, app: c.app, version: c.version,
        forPrivate: snapshot.forPrivate === true });
      return { hostId, deployment: id, owner: a.owner, revision: a.revision, policyHash: a.policyHash, refusal,
        validUntil: Math.min(a.validUntil, c.timestamp + SNAPSHOT_MS) };
    },
  };
}

/**
 * r3 authority.decision(id, snapshot) from the independent-profile adapter's snapshot: host owner/revision/policyHash
 * and the owner-policy refusal (independentAdmissionRefusal) were read at the SAME authenticated block as the ledger,
 * controller, catalog version and resources. A policy document that was unavailable or did not match its commitment
 * is UNKNOWN (throws: serving fenced, starts refused, the runner keeps reconciling), never a decision and never allow.
 */
export function createSnapshotHostAdmission({ hostId, now = Date.now }) {
  if (!ID.test(hostId || '')) throw Error('exact host id required');
  return {
    hostId,
    async decision(id, s) {
      if (!ID.test(id || '') || s?.id !== id || s.thisHost !== hostId || s.verified !== true || s.profile !== INDEPENDENT_PROFILE)
        throw Error('admission needs this host\'s verified independent-profile snapshot of this deployment');
      const a = s.hostAuthority;
      if (!a || !ADDRESS.test(a.owner) || ZERO.test(a.owner)) throw Error('host ownership unavailable at the authenticated block');
      if (a.policyKnown !== true) throw Error(`host owner policy unknown at the authenticated block: ${String(s.host?.ownerDenial || '').slice(0, 160)}`);
      if (typeof a.revision !== 'string' || !UINT.test(a.revision) || !ID.test(a.policyHash)) throw Error('host authority malformed');
      const refusal = s.host?.ownerDenial ?? null;
      if (refusal !== null && (typeof refusal !== 'string' || !refusal)) throw Error('host owner refusal malformed');
      return { hostId, deployment: id, owner: a.owner, revision: a.revision, policyHash: a.policyHash, refusal, validUntil: now() + DECISION_MS };
    },
  };
}

const lower = a => String(a || '').toLowerCase();

/**
 * composeIndependentLifecycle(parts) -> { dispatch, hostId, independence, gaps, missing }. Wires REAL interfaces only:
 *   adapter, adapterPins  an instance of the GENERATED candidate createLifecycleChainAdapter created with these exact
 *                         pins, pins.profile 'independent-r1' (a legacy-profile adapter is refused: it still applies the
 *                         central catalog/address-book gates). The binding (ledger, controller, code hashes) and this
 *                         host id come from those reviewed pins, never from separate arguments.
 *   runtime, journal      createIsolationLifecycleRuntime output and the generated owned journal (no initialize)
 *   inventory             the manager client (IsolationManagerClient) whose findByName the runtime also uses
 *   routes, platformWallets, capacityHeadroom, verifyQuiescence   as createLifecycleDispatch
 * Any missing part -> LifecycleActivationBlocked naming it (or a held dispatch with onMissing: 'hold').
 */
export function composeIndependentLifecycle({ adapter, adapterPins, runtime, journal, inventory, routes, platformWallets,
  capacityHeadroom, verifyQuiescence, now = Date.now, intervalMs, onMissing = 'throw' } = {}) {
  const missing = [];
  for (const f of ['read', 'prepare', 'submit', 'resolve', 'finalize']) if (typeof adapter?.[f] !== 'function') missing.push(`adapter.${f}`);
  const C = adapterPins?.contracts || {};
  for (const k of ['ledger', 'lifecycle', 'hostOwnership', 'catalog']) if (!ADDRESS.test(lower(C[k]?.address)) || !ID.test(C[k]?.codeHash || '')) missing.push(`adapterPins.contracts.${k}`);
  if (!ID.test(adapterPins?.host || '')) missing.push('adapterPins.host');
  if (adapterPins?.profile !== INDEPENDENT_PROFILE) missing.push('adapterPins.profile (independent-r1)');
  if (missing.some(m => m.startsWith('adapterPins'))) throw new LifecycleActivationBlocked(missing);
  if (!missing.length && (adapter.profile !== INDEPENDENT_PROFILE || !Array.isArray(adapter.independence?.blockers)))
    missing.push('adapter.profile (independent-r1 candidate adapter)');
  const hostId = adapterPins.host, ledger = lower(C.ledger.address), controller = lower(C.lifecycle.address);
  const binding = { ledger, controller, deploymentsSchema: 17, lifecycleSchema: 2,   // the adapter refuses any other schema at every read
    ledgerCodeHash: C.ledger.codeHash, controllerCodeHash: C.lifecycle.codeHash };
  const usable = !missing.length;
  const chain = !usable ? { binding } : {
    binding,
    // the adapter verified lifecycle.ledger == ledger and the code hashes at the SAME authenticated block; these labels restate those pins.
    async read(id) { const s = await adapter.read(id); return s && { ...s, ledger, controller }; },
    prepare: (...a) => adapter.prepare(...a), submit: (...a) => adapter.submit(...a),
    resolve: (...a) => adapter.resolve(...a), finalize: (...a) => adapter.finalize(...a),
  };
  const authority = usable ? createSnapshotHostAdmission({ hostId, now }) : undefined;
  if (missing.length && onMissing === 'throw') throw new LifecycleActivationBlocked(missing);
  const dispatch = createLifecycleDispatch({ routes, chain, runtime, journal, inventory, pins: { chainId: 8453, lifecycle: controller }, authority,
    platformWallets, capacityHeadroom, verifyQuiescence, now, onMissing, ...(intervalMs ? { intervalMs } : {}) });
  const independence = usable ? adapter.independence : Object.freeze({ complete: false, blockers: Object.freeze(['adapter is not the independent-profile candidate']) });
  return { dispatch, hostId, independence, gaps: independence.blockers, missing: Object.freeze([...missing, ...dispatch.blocked]) };
}
