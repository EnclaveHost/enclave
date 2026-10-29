// Host-ownership-scoped admission for event-driven lifecycle routes, and the composer that wires it to the existing
// lifecycle chain adapter (lifecycle-chain-adapter-stage r6). Intended location: network/lifecycle-host-authority.mjs.
// NOT activated by any environment flag; nothing here changes legacy admission (host-admission-policy.mjs and
// host-admission-runtime.mjs are imported, never modified, and keep their behavior for every legacy path).
//
// Separation kept here:
//  - INTEGRITY / CONSENT (always): the referenced catalog version exists with a content commitment, and its publisher
//    has neither delisted the app nor yanked the version (EnclaveAppCatalog.setActive / yankVersion: publisher-only,
//    `_resolveMine`).
//  - HOST OWNER (always): the policy the host wallet committed in EnclaveHostOwnership (hash-checked by the production
//    readHostAdmissionPolicy), including its deny lists.
//  - CATALOG MODERATION (optional): catalog-owner approval (EnclaveAppCatalog.setApproval, owner-only) applies only when
//    the host owner elected it with requireCatalogApproval. It is never a mandatory central approval for this path.
import { parseAbi } from 'viem';
import { hostAuthorityReader, readHostAdmissionPolicy, validateHostAdmissionPolicy } from './host-admission-policy.mjs';
import { catalogAdmissionRefusal } from '../site/js/core/catalog-policy.js';
import { createLifecycleDispatch, LifecycleActivationBlocked } from './lifecycle-host-dispatch.mjs';

const ID = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/, ZERO = /^0x0{40}$/;
const REF = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/([0-9]{1,9})$/;
const SNAPSHOT_MS = 90_000;   // the production host admission's chain snapshot lifetime (host-admission-runtime.mjs)
// The production catalog views (host-admission-runtime.mjs catalogABI, verbatim).
const catalogABI = parseAbi([
  'function getApp(bytes32) view returns ((bytes32 appId,address publisher,string slug,string name,string description,uint32 versionCount,uint64 createdAt,uint64 updatedAt,bool active))',
  'function getVersion(bytes32,uint256) view returns ((string cid,string version,uint32 vramMb,uint32 gpuGflops,uint32 memMb,uint32 cpuGflops,uint64 createdAt,bool verified,bool yanked,string ports,uint8 approval,string config))',
]);
const fresh = (t, at) => Number.isSafeInteger(t) && t <= at + 5000 && t + SNAPSHOT_MS > at;

/** Production's exact appRef pattern and canonicalisation. Throws on anything else. */
export function canonicalAppRef(appRef) {
  const m = typeof appRef === 'string' && appRef.match(REF);
  if (!m) throw Error('catalog app reference required');
  const appId = m[1].toLowerCase(), index = Number(m[2]);
  return { appId, index, canonical: `catalog://${appId}/${index}` };
}

/** Content integrity and publisher consent; independent of any moderator. -> refusal string or null */
export function catalogIntegrityRefusal({ app, version, appId, index }) {
  if (!app || String(app.appId).toLowerCase() !== appId || !(BigInt(app.versionCount ?? 0) > BigInt(index)))
    return 'the catalog has no such app version';
  if (!version || typeof version.cid !== 'string' || !version.cid.length || !(BigInt(version.createdAt ?? 0) > 0n))
    return 'the catalog version carries no content commitment';
  if (app.active !== true) return 'the publisher has delisted this app';
  if (version.yanked !== false) return 'the publisher has yanked this version';
  return null;
}

/**
 * The independent lifecycle path's admission: host owner policy + integrity, and catalog moderation ONLY when the host
 * owner elected it. Legacy hostAdmissionRefusal (mandatory platform moderation) is not used for this path and not changed.
 */
export function independentAdmissionRefusal(policy, { hostId, deploymentId, appRef, app, version, forPrivate = false }) {
  const p = validateHostAdmissionPolicy(policy);
  if (p.hostId !== hostId) throw Error('host policy cannot apply to another host');
  if (typeof deploymentId !== 'string' || !ID.test(deploymentId)) throw Error('deployment id required');
  const ref = canonicalAppRef(appRef);
  if (p.denyDeployments.includes(deploymentId) || p.denyAppRefs.includes(ref.canonical)) return 'this host owner declines this deployment';
  const integrity = catalogIntegrityRefusal({ app, version, appId: ref.appId, index: ref.index });
  if (integrity) return integrity;
  if (p.requireCatalogApproval === true) {
    const moderation = catalogAdmissionRefusal(app, version, { forPrivate: forPrivate === true });
    if (moderation) return `this host owner applies catalog moderation: ${moderation}`;
    if (Number(version.approval) !== 1) return 'this host owner requires current catalog approval';
  }
  return null;
}

/**
 * The authenticated owner of THIS host from the pinned EnclaveHostOwnership, through the production reader
 * (hostAuthorityReader -> LeaseReader.agreed) and readHostAdmissionPolicy (document hash-checked). Enforces a
 * monotonic revision floor: an older revision (replay) or a different owner/policy at one revision (equivocation) is
 * unknown, never allow.
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

/** authority.decision(id, snapshot) for createLifecycleDispatch: the exact DECISION_KEYS, bound to host and deployment. */
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

// Composition gaps that remain in the EXISTING r6 adapter (not fixed by this composer; see docs/REPORT.md).
export const ADAPTER_GAPS = Object.freeze([
  'r6 pinned() requires the address book to equal the reviewed entries at every read: an address-book change fails every routed read closed (fence, no stop)',
  'r6 maps the production catalog moderation (approval) into the GLOBAL `enabled` field: a catalog-owner rejection makes the runner stop the deployment on every host',
  'r6 counts an addressBook.owner/pendingOwner change as adminChanged: new starts denied on every host',
  'r6 snapshot carries no resource shares (snapshot.resources) and no isPublic (snapshot.forPrivate): routed starts are refused for unknown capacity',
]);

const lower = a => String(a || '').toLowerCase();

/**
 * composeIndependentLifecycle(parts) -> { dispatch, gaps }. Wires REAL interfaces only:
 *   adapter, adapterPins  an instance of r6 createLifecycleChainAdapter and the exact pins it was created with; the
 *                         binding (ledger, controller, code hashes), this host id, the EnclaveHostOwnership and catalog
 *                         addresses are taken from those reviewed pins, never from separate arguments
 *   reader, loadPolicy    the production LeaseReader (agreed) and publicHostPolicyLoader used by createHostAdmission
 *   runtime, journal      createIsolationLifecycleRuntime output and ownLifecycleJournal(file) (no initialize)
 *   routes, platformWallets, capacityHeadroom, verifyQuiescence   as createLifecycleDispatch
 * Any missing part -> LifecycleActivationBlocked naming it (or a held dispatch with onMissing: 'hold').
 */
export function composeIndependentLifecycle({ adapter, adapterPins, reader, loadPolicy, runtime, journal, routes, platformWallets,
  capacityHeadroom, verifyQuiescence, now = Date.now, intervalMs, onMissing = 'throw' } = {}) {
  const missing = [];
  for (const f of ['read', 'prepare', 'submit', 'resolve', 'finalize']) if (typeof adapter?.[f] !== 'function') missing.push(`adapter.${f}`);
  const C = adapterPins?.contracts || {};
  for (const k of ['ledger', 'lifecycle', 'hostOwnership', 'catalog']) if (!ADDRESS.test(lower(C[k]?.address)) || !ID.test(C[k]?.codeHash || '')) missing.push(`adapterPins.contracts.${k}`);
  if (!ID.test(adapterPins?.host || '')) missing.push('adapterPins.host');
  if (typeof reader?.agreed !== 'function') missing.push('reader.agreed');
  if (typeof loadPolicy !== 'function') missing.push('loadPolicy');
  if (missing.some(m => m.startsWith('adapterPins'))) throw new LifecycleActivationBlocked(missing);
  const hostId = adapterPins.host, ledger = lower(C.ledger.address), controller = lower(C.lifecycle.address);
  const binding = { ledger, controller, deploymentsSchema: 17, lifecycleSchema: 2,   // r6 pinned() refuses any other schema at every read
    ledgerCodeHash: C.ledger.codeHash, controllerCodeHash: C.lifecycle.codeHash };
  const chain = missing.some(m => m.startsWith('adapter.')) ? { binding } : {
    binding,
    // r6 verified lifecycle.ledger == ledger and the code hashes at the SAME authenticated block; these labels restate those pins.
    async read(id) { const s = await adapter.read(id); return s && { ...s, ledger, controller }; },
    prepare: (...a) => adapter.prepare(...a), submit: (...a) => adapter.submit(...a),
    resolve: (...a) => adapter.resolve(...a), finalize: (...a) => adapter.finalize(...a),
  };
  let authority;
  if (!missing.length) {
    const ownership = createScopedHostAuthority({ hostId, ownershipContract: lower(C.hostOwnership.address), reader, loadPolicy, now });
    authority = createIndependentHostAdmission({ hostId, ownership, readCatalog: catalogVersionReader({ reader, catalog: lower(C.catalog.address) }), now });
  }
  if (missing.length && onMissing === 'throw') throw new LifecycleActivationBlocked(missing);
  const dispatch = createLifecycleDispatch({ routes, chain, runtime, journal, pins: { chainId: 8453, lifecycle: controller }, authority,
    platformWallets, capacityHeadroom, verifyQuiescence, now, onMissing, ...(intervalMs ? { intervalMs } : {}) });
  return { dispatch, hostId, gaps: ADAPTER_GAPS, missing: Object.freeze([...missing, ...dispatch.blocked]) };
}
