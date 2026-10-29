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
//  - The old ledger / old address book matter only until a route is activated by finalized quiescence evidence.
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

const ID = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/, ZERO = /^0x0{40}$/, UINT = /^(0|[1-9][0-9]{0,30})$/;
export const LIFECYCLE_DEPLOYMENTS_SCHEMA = 17, LIFECYCLE_SCHEMA = 2, MAX_LIFECYCLE_ROUTES = 64, MAX_CAPACITY_HEADROOM = 0.5;
const ROUTE_KEYS = ['deployment', 'oldLedger', 'newLedger', 'controller', 'deploymentsSchema', 'lifecycleSchema',
  'ledgerCodeHash', 'controllerCodeHash', 'quiescenceDigest'];
const BINDING_KEYS = ['ledger', 'controller', 'deploymentsSchema', 'lifecycleSchema', 'ledgerCodeHash', 'controllerCodeHash'];
const DECISION_KEYS = ['hostId', 'deployment', 'owner', 'revision', 'policyHash', 'refusal', 'validUntil'];
const CHAIN_FNS = ['read', 'resolve', 'prepare', 'submit', 'finalize'];
const RUNTIME_FNS = ['fence', 'stop', 'health', 'ensureStaged', 'serve'];
// Every journal method DeploymentLifecycleRunner calls.
const JOURNAL_FNS = ['read', 'observeAssignment', 'restoreDenial', 'deny', 'settleMined', 'archiveMined', 'settleTransition',
  'prepareTransition', 'healthy', 'unhealthy', 'failure', 'decision'];
const HOST_FNS = ['legacyLedger', 'legacyHold', 'ownerRestriction', 'platformService', 'platformNewWork', 'legacyActivity', 'capacity', 'record', 'log'];
const PROOF_TIERS = ['finalized', 'l1-finalized-derived'];
// Revocation targets: never blocked by an online denial (admission, new work, capacity, platform outage).
const REVOCATIONS = new Set(['queued', 'stopped']);

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

function parseBinding(b) {
  exactKeys(b, BINDING_KEYS, 'lifecycle chain binding');
  address(b.ledger, 'binding.ledger'); address(b.controller, 'binding.controller');
  hash(b.ledgerCodeHash, 'binding.ledgerCodeHash'); hash(b.controllerCodeHash, 'binding.controllerCodeHash');
  if (b.deploymentsSchema !== LIFECYCLE_DEPLOYMENTS_SCHEMA || b.lifecycleSchema !== LIFECYCLE_SCHEMA)
    throw Error('lifecycle chain binding must pin deploymentsSchema 17 and lifecycleSchema 2');
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
  if (!Array.isArray(routes) || !routes.length) throw Error('at least one explicit lifecycle route is required; omit the dispatch for legacy behavior');
  if (routes.length > MAX_LIFECYCLE_ROUTES) throw Error(`at most ${MAX_LIFECYCLE_ROUTES} lifecycle routes`);
  const out = new Map();
  for (const [i, r] of routes.entries()) {
    const what = `lifecycle route ${i}`;
    exactKeys(r, ROUTE_KEYS, what);
    if (!ID.test(r.deployment)) throw Error(`${what}: deployment must be a lowercase bytes32 id`);
    address(r.oldLedger, `${what}.oldLedger`); address(r.newLedger, `${what}.newLedger`); address(r.controller, `${what}.controller`);
    hash(r.ledgerCodeHash, `${what}.ledgerCodeHash`); hash(r.controllerCodeHash, `${what}.controllerCodeHash`);
    hash(r.quiescenceDigest, `${what}.quiescenceDigest`);
    if (r.oldLedger === r.newLedger) throw Error(`${what}: old and new ledger are the same`);
    if (r.deploymentsSchema !== LIFECYCLE_DEPLOYMENTS_SCHEMA || r.lifecycleSchema !== LIFECYCLE_SCHEMA)
      throw Error(`${what}: deploymentsSchema 17 and lifecycleSchema 2 required`);
    if (out.has(r.deployment)) throw Error(`${what}: duplicate route for ${r.deployment}`);
    for (const k of ['ledger', 'controller', 'ledgerCodeHash', 'controllerCodeHash'])
      if (r[k === 'ledger' ? 'newLedger' : k] !== binding[k]) throw Error(`${what}: ${k} does not match the pinned lifecycle chain binding`);
    out.set(r.deployment, Object.freeze({ ...r }));
  }
  return out;
}

/**
 * createLifecycleDispatch(parts) -> dispatch. Any absent safety adapter is LifecycleActivationBlocked: there are no
 * default, no-op or "assume allowed" substitutes. With onMissing: 'hold' the routes are still parsed (against
 * chain.binding) and OWNED, so the host keeps them away from every legacy path, but every one stays HELD and the
 * runner is never constructed; state() names the missing adapters.
 *   routes               exact route objects (ROUTE_KEYS)
 *   chain                the qualified lifecycle chain adapter for DeploymentLifecycleRunner, plus an immutable `binding`
 *   runtime, journal     the isolation runtime and the OWNED lifecycle journal (never the legacy release journal)
 *   pins                 reviewed lifecycle pins ({ chainId: 8453, lifecycle: controller })
 *   authority.decision(id, snapshot)  the host wallet's authenticated admission for this routed record (DECISION_KEYS):
 *                        owner/revision/policyHash from EnclaveHostOwnership, refusal from the owner's committed policy
 *                        and content integrity. Throws when unknown. Never an ownership boolean.
 *   platformWallets      reviewed wallets through which the platform owns hosts; its host policy binds only those hosts
 *   capacityHeadroom     share (0..0.5) of each axis kept free beyond allocations and pending starts
 *   verifyQuiescence(route) proof-qualified evidence that the legacy assignment is fenced and quiescent
 */
export function createLifecycleDispatch({ routes, chain, runtime, journal, pins, authority, platformWallets, capacityHeadroom, verifyQuiescence,
  now = Date.now, random = Math.random, intervalMs = 5000, onMissing = 'throw' } = {}) {
  if (onMissing !== 'throw' && onMissing !== 'hold') throw Error('onMissing must be throw or hold');
  const missing = [];
  for (const f of CHAIN_FNS) if (typeof chain?.[f] !== 'function') missing.push(`chain.${f}`);
  for (const f of RUNTIME_FNS) if (typeof runtime?.[f] !== 'function') missing.push(`runtime.${f}`);
  for (const f of JOURNAL_FNS) if (typeof journal?.[f] !== 'function') missing.push(`journal.${f}`);
  if (!pins || typeof pins !== 'object') missing.push('pins');
  if (typeof authority?.decision !== 'function') missing.push('authority.decision');
  if (platformWallets === undefined || platformWallets === null) missing.push('platformWallets');
  if (capacityHeadroom === undefined || capacityHeadroom === null) missing.push('capacityHeadroom');
  if (typeof verifyQuiescence !== 'function') missing.push('verifyQuiescence');
  // Without the binding no route ledger can be checked, so not even a held table can be built.
  if (!chain?.binding) throw new LifecycleActivationBlocked(['chain.binding', ...missing]);
  if (missing.length && onMissing === 'throw') throw new LifecycleActivationBlocked(missing);
  const blocked = Object.freeze([...missing]);
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 10000) throw Error('lifecycle cadence must be 1000..10000 ms (permits last 20 s)');
  const binding = parseBinding(chain.binding);
  if (pins && (pins.chainId !== 8453 || String(pins.lifecycle || '').toLowerCase() !== binding.controller))
    throw Error('lifecycle pins do not match the bound controller');
  const platform = platformWallets == null ? Object.freeze([]) : parsePlatformWallets(platformWallets);
  if (capacityHeadroom != null && !(typeof capacityHeadroom === 'number' && capacityHeadroom >= 0 && capacityHeadroom <= MAX_CAPACITY_HEADROOM))
    throw Error(`capacityHeadroom must be a share 0..${MAX_CAPACITY_HEADROOM}`);
  const table = parseLifecycleRoutes(routes, binding);

  let host = null, timer = null, activating = null;
  let hostFloor = null;          // highest authenticated host authority seen: { revision, owner, policyHash } (replay floor)
  const activated = new Map();   // id -> { at, evidence } ; never removed in this process
  const heldWhy = new Map();     // id -> activation refusal
  const localHolds = new Map();  // id -> why (owner restriction routed from a legacy give-up path: hosting off, caps)
  const epochs = new Map();      // id -> bumped by every local restriction; in-flight effects check it
  const active = new Map();      // id -> context of the reconcile currently inside the runner
  const inflight = new Map();    // id -> the ONE reconcile promise
  const last = new Map();        // id -> last outcome (in memory only: never a gate on authenticated state)
  const decisions = new Map();   // id -> last validated admission decision (ingress uses it until validUntil)
  const reservations = new Map();// id -> { cpuShare, gpuShare } reserved for a start on this host
  const epoch = id => epochs.get(id) || 0;
  const say = m => { try { host?.log(`lifecycle: ${m}`); } catch {} };

  function checkDecision(id, d) {
    exactKeys(d, DECISION_KEYS, 'host admission decision');
    if (d.hostId !== host.hostId || d.deployment !== id) throw Error('admission decision binds another host or deployment');
    address(d.owner, 'decision.owner');
    if (typeof d.revision !== 'string' || !UINT.test(d.revision)) throw Error('decision.revision must be a decimal string');
    if (!ID.test(d.policyHash)) throw Error('decision.policyHash must be a lowercase bytes32');
    if (d.refusal !== null && (typeof d.refusal !== 'string' || !d.refusal)) throw Error('decision.refusal must be null or a reason');
    if (!Number.isSafeInteger(d.validUntil) || d.validUntil <= now()) throw Error('admission decision is not fresh');
    const rev = BigInt(d.revision);
    if (hostFloor && (rev < hostFloor.revision || (rev === hostFloor.revision && (d.owner !== hostFloor.owner || d.policyHash !== hostFloor.policyHash))))
      throw Error(`host authority replay or equivocation (revision ${rev} vs accepted ${hostFloor.revision})`);
    hostFloor = { revision: rev, owner: d.owner, policyHash: d.policyHash };
    return Object.freeze({ ...d, platformOwned: platform.includes(d.owner) });
  }
  // Why THIS host must not run the routed app now (owner-scoped). null = no denial. Sync; re-evaluated at every effect.
  function denial(id, decision) {
    const local = localHolds.get(id);
    if (local) return `restricted: ${local}`;
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
    if (!ctx.decision || ctx.decision.validUntil <= now()) return 'host admission expired';
    return denial(id, ctx.decision);
  }
  function capacityRefusal(id, snapshot) {
    const need = snapshot?.resources;
    if (!need || !share(need.cpuShare) || !share(need.gpuShare)) return 'deployment resource shares are not in the authenticated snapshot; capacity unknown';
    let c; try { c = host.capacity(id); } catch (e) { return `host capacity unknown: ${e.message}`; }
    if (!c || c.paused !== false || ![c.cpuCap, c.gpuCap, c.cpuUsed, c.gpuUsed].every(Number.isFinite)) return 'host capacity unknown';
    if (c.cpuUsed + need.cpuShare + capacityHeadroom > c.cpuCap + 1e-9) return `capacity: CPU ${c.cpuUsed} allocated/pending + ${need.cpuShare} + headroom ${capacityHeadroom} exceeds ${c.cpuCap}`;
    if (need.gpuShare > 0 && c.gpuUsed + need.gpuShare + capacityHeadroom > c.gpuCap + 1e-9) return `capacity: GPU ${c.gpuUsed} allocated/pending + ${need.gpuShare} + headroom ${capacityHeadroom} exceeds ${c.gpuCap}`;
    return null;
  }
  // A start (stage or running intent): every serving condition, plus new work, release journal, capacity.
  function assertStart(id, snapshot) {
    const why = serveRefusal(id) ?? (() => {
      const hold = host.legacyHold(id);
      if (hold) return `legacy release intent unresolved (retained): ${hold}`;
      if (active.get(id).decision.platformOwned) { const nw = host.platformNewWork(); if (nw) return `${nw} (this host is owned by a pinned platform wallet)`; }
      if (reservations.has(id)) return null;
      return capacityRefusal(id, snapshot);
    })();
    if (why) throw Error(`lifecycle start refused: ${why}`);
    if (!reservations.has(id)) {
      const r = Object.freeze({ cpuShare: snapshot.resources.cpuShare, gpuShare: snapshot.resources.gpuShare });
      reservations.set(id, r);
      // the reservation is visible to the host's own capacity view (Host.occupies counts provisioning + isolationRequired)
      try { host.record(id, { status: 'provisioning', lifecycle: true, isolationRequired: true, cpuShare: r.cpuShare, gpuShare: r.gpuShare }); } catch {}
    }
  }

  let runner = null;
  if (!blocked.length) {
    // The runner's adapters, with refusals ADDED. Nothing here returns authority the wrapped adapter did not.
    const boundChain = {
      async read(id) {
        const r = table.get(id);
        if (!r) throw Error('no lifecycle route');
        const s = await chain.read(id);
        if (!s || s.id !== id || s.ledger !== r.newLedger || s.controller !== r.controller || s.thisHost !== host.hostId) throw Error('lifecycle read is not from this route\'s ledger, controller and attached host');
        const ctx = active.get(id);
        try { ctx.decision = checkDecision(id, await authority.decision(id, s)); ctx.unknown = null; decisions.set(id, ctx.decision); }
        catch (e) { ctx.decision = null; ctx.unknown = `host admission unknown: ${String(e?.message || e).slice(0, 200)}`; decisions.delete(id); }
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
      submit: (id, intent) => chain.submit(id, intent),
    };
    const boundRuntime = {
      fence: id => runtime.fence(id),
      stop: id => runtime.stop(id),
      health: (id, generation) => runtime.health(id, generation),
      async ensureStaged(id, snapshot) { assertStart(id, snapshot); return runtime.ensureStaged(id, snapshot); },
      async serve(id, snapshot) { const why = serveRefusal(id); if (why) throw Error(`lifecycle serving refused: ${why}`); return runtime.serve(id, snapshot); },
    };
    runner = new DeploymentLifecycleRunner({ chain: boundChain, runtime: boundRuntime, journal, pins, now, random });
  }

  function publish(id, result) {
    last.set(id, { ...result, at: now() });
    const s = result.status;
    const keep = s === 'running' || s === 'pending' || s === 'reconcile' || (s === 'queued' && result.reason === 'starting without a serving permit');
    if (!keep) reservations.delete(id);
    const r = reservations.get(id);
    const status = s === 'running' ? 'running' : s === 'stopped' || s === 'elsewhere' ? 'stopped' : s === 'held' ? 'held' : 'provisioning';
    // provisioning + isolationRequired: a staged VM may exist, so the legacy capacity view counts it (Host.occupies)
    try { host?.record(id, { status, reason: result.reason || '', lifecycle: true, lifecycleStatus: s, isolationRequired: true,
      cpuShare: r?.cpuShare ?? 0, gpuShare: r?.gpuShare ?? 0 }); } catch {}
    return result;
  }
  async function fenceHeld(id, why, stop = false) {
    let reason = why;
    if (typeof runtime?.fence !== 'function') reason = `${why}; no lifecycle runtime to fence`;
    else try {
      await runtime.fence(id);
      if (stop && !(typeof runtime.stop === 'function' && await runtime.stop(id))) reason = `${why}; stop not confirmed`;
    } catch (e) { reason = `${why}; runtime withdrawal failed: ${e.message}`; }
    return publish(id, { status: 'held', reason });
  }

  async function reconcileOnce(id) {
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
    routes: () => [...table.values()],
    owns: id => table.has(String(id || '').toLowerCase()),
    attach(view) {
      if (host) throw Error('lifecycle dispatch is already attached to a host');
      if (!view || !ID.test(view.hostId || '') || HOST_FNS.some(f => typeof view[f] !== 'function'))
        throw new LifecycleActivationBlocked(['hostId', ...HOST_FNS].filter(f => f === 'hostId' ? !ID.test(view?.hostId || '') : typeof view?.[f] !== 'function'));
      host = Object.freeze({ ...view });
      for (const id of table.keys()) publish(id, { status: 'held', reason: blocked.length ? `lifecycle adapters missing: ${blocked.join(', ')}` : 'route not activated' });
      return dispatch;
    },
    /**
     * Verify each not-yet-activated route once. Activation is the handoff: it binds the EXACT legacy ledger, an empty
     * legacy release journal entry (never cleared here), no legacy work in this process and finalized quiescence
     * evidence. After it, the old ledger/address book is not consulted again for this route.
     */
    activate() {
      if (!host) return Promise.reject(Error('lifecycle dispatch is not attached to a host'));
      activating ||= (async () => {
        for (const [id, r] of table) {
          if (activated.has(id)) continue;
          if (blocked.length) { heldWhy.set(id, `lifecycle adapters missing: ${blocked.join(', ')}`); continue; }
          const local = () => {
            if (String(host.legacyLedger() || '').toLowerCase() !== r.oldLedger) return 'legacy ledger is not this route\'s old ledger';
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
     * revocation through the chain adapter); runtime.stop alone never claims to change the ledger.
     */
    async restrict(id, why) {
      id = String(id || '').toLowerCase();
      if (!table.has(id)) throw Error('no lifecycle route for this id');
      localHolds.set(id, String(why || 'restricted')); epochs.set(id, epoch(id) + 1);
      const r = await fenceHeld(id, `restricted: ${why}`, true);
      if (runner && activated.has(id)) (inflight.get(id) || Promise.resolve()).then(() => dispatch.reconcile(id)).catch(e => say(`follow-up: ${e.message}`));
      return r;
    },
    /** A claim hint never claims or reconciles a routed id. A FORCED hint (the operator) clears a local restriction only. */
    considerHint(id, { force = false } = {}) {
      id = String(id || '').toLowerCase();
      if (force && localHolds.delete(id)) say(`${id.slice(0, 10)} local restriction cleared by a forced hint`);
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
      const d = decisions.get(id);
      return { id, activated: activated.has(id), held: heldWhy.get(id) || null, restricted: localHolds.get(id) || null,
        last: last.get(id) || null, blocked, reservation: reservations.get(id) || null,
        hostAuthority: d ? { owner: d.owner, revision: d.revision, platformOwned: d.platformOwned, refusal: d.refusal } : null,
        settlement: 'v2 paid proof-of-service settlement is not implemented by this dispatch' };
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
