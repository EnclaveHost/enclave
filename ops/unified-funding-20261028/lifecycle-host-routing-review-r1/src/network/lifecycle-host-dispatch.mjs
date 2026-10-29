// Per-deployment host dispatch between the legacy lease loop and the event-driven
// lifecycle runner. Intended location: network/lifecycle-host-dispatch.mjs, beside
// deployment-lifecycle-runner.mjs. NOT activated by any environment flag.
//
// Routes are a LOCAL ROUTING DECISION, not chain authority. They are fixed at
// construction (frozen, finite, exact) and keyed by deployment AND old/new ledger.
// A routed id is excluded from every legacy claim/renew/release/prove/restart path
// from the moment the host attaches the dispatch, whether or not the route has
// activated. Until activation it is HELD; it never falls back to v1.
//
// Activation of a route requires externally verified legacy quiescence evidence,
// an idle legacy state in this process, no unresolved legacy release intent and the
// exact legacy ledger. The v2 path then calls the existing DeploymentLifecycleRunner,
// which keeps every authenticated read, generation, witness, denial and funding
// check. This module only adds refusals; it never synthesizes `verified`, an
// authority tier, admission or funding, and it never opens, initializes, deletes or
// reconciles any journal.
import { DeploymentLifecycleRunner } from './deployment-lifecycle-runner.mjs';

const ID = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/, ZERO = /^0x0{40}$/;
export const LIFECYCLE_DEPLOYMENTS_SCHEMA = 17, LIFECYCLE_SCHEMA = 2, MAX_LIFECYCLE_ROUTES = 64;
const ROUTE_KEYS = ['deployment', 'oldLedger', 'newLedger', 'controller', 'deploymentsSchema', 'lifecycleSchema',
  'ledgerCodeHash', 'controllerCodeHash', 'quiescenceDigest'];
const BINDING_KEYS = ['ledger', 'controller', 'deploymentsSchema', 'lifecycleSchema', 'ledgerCodeHash', 'controllerCodeHash'];
const CHAIN_FNS = ['read', 'resolve', 'prepare', 'submit', 'finalize'];
const RUNTIME_FNS = ['fence', 'stop', 'health', 'ensureStaged', 'serve'];
// Every journal method DeploymentLifecycleRunner calls.
const JOURNAL_FNS = ['read', 'observeAssignment', 'restoreDenial', 'deny', 'settleMined', 'archiveMined', 'settleTransition',
  'prepareTransition', 'healthy', 'unhealthy', 'failure', 'decision'];
const HOST_FNS = ['legacyLedger', 'legacyHold', 'serviceRestriction', 'newWorkRestriction', 'legacyActivity', 'record', 'log'];
const PROOF_TIERS = ['finalized', 'l1-finalized-derived'];

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

function parseBinding(b) {
  exactKeys(b, BINDING_KEYS, 'lifecycle chain binding');
  address(b.ledger, 'binding.ledger'); address(b.controller, 'binding.controller');
  hash(b.ledgerCodeHash, 'binding.ledgerCodeHash'); hash(b.controllerCodeHash, 'binding.controllerCodeHash');
  if (b.deploymentsSchema !== LIFECYCLE_DEPLOYMENTS_SCHEMA || b.lifecycleSchema !== LIFECYCLE_SCHEMA)
    throw Error('lifecycle chain binding must pin deploymentsSchema 17 and lifecycleSchema 2');
  return Object.freeze({ ...b });
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
 *   routes             exact route objects (ROUTE_KEYS)
 *   chain              the qualified lifecycle chain adapter for DeploymentLifecycleRunner, plus an immutable `binding`
 *   runtime, journal   the isolation runtime and the OWNED lifecycle journal (never the legacy release journal)
 *   pins               reviewed lifecycle pins ({ chainId: 8453, lifecycle: controller })
 *   policy.refusal(id) host/catalog/owner-scope policy for the authenticated v2 record: refusal string, null, or throws (unknown)
 *   verifyQuiescence(route) proof-qualified evidence that the legacy assignment is fenced and quiescent
 */
export function createLifecycleDispatch({ routes, chain, runtime, journal, pins, policy, verifyQuiescence,
  now = Date.now, random = Math.random, intervalMs = 5000, onMissing = 'throw' } = {}) {
  if (onMissing !== 'throw' && onMissing !== 'hold') throw Error('onMissing must be throw or hold');
  const missing = [];
  for (const f of CHAIN_FNS) if (typeof chain?.[f] !== 'function') missing.push(`chain.${f}`);
  for (const f of RUNTIME_FNS) if (typeof runtime?.[f] !== 'function') missing.push(`runtime.${f}`);
  for (const f of JOURNAL_FNS) if (typeof journal?.[f] !== 'function') missing.push(`journal.${f}`);
  if (!pins || typeof pins !== 'object') missing.push('pins');
  if (typeof policy?.refusal !== 'function') missing.push('policy.refusal');
  if (typeof verifyQuiescence !== 'function') missing.push('verifyQuiescence');
  // Without the binding no route ledger can be checked, so not even a held table can be built.
  if (!chain?.binding) throw new LifecycleActivationBlocked(['chain.binding', ...missing]);
  if (missing.length && onMissing === 'throw') throw new LifecycleActivationBlocked(missing);
  const blocked = Object.freeze([...missing]);
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 10000) throw Error('lifecycle cadence must be 1000..10000 ms (permits last 20 s)');
  const binding = parseBinding(chain.binding);
  if (pins && (pins.chainId !== 8453 || String(pins.lifecycle || '').toLowerCase() !== binding.controller))
    throw Error('lifecycle pins do not match the bound controller');
  const table = parseLifecycleRoutes(routes, binding);

  let host = null, timer = null, activating = null;
  const activated = new Map();   // id -> { at, evidence } ; never removed in this process
  const heldWhy = new Map();     // id -> activation refusal
  const localHolds = new Map();  // id -> why (owner/platform restriction routed from a legacy give-up path)
  const epochs = new Map();      // id -> bumped by every local restriction; in-flight effects check it
  const active = new Map();      // id -> { epoch } of the reconcile currently inside the runner
  const inflight = new Map();    // id -> the ONE reconcile promise
  const last = new Map();        // id -> last outcome
  const epoch = id => epochs.get(id) || 0;
  const say = m => { try { host?.log(`lifecycle: ${m}`); } catch {} };

  // Synchronous refusals evaluated before and after every await and inside the runner's effects.
  function blocker(id) {
    const r = table.get(id);
    if (!host) return { why: 'host not attached' };
    if (String(host.legacyLedger() || '').toLowerCase() !== r.oldLedger) return { why: 'legacy ledger is not this route\'s old ledger; refused' };
    const hold = host.legacyHold(id);
    if (hold) return { why: `legacy release intent unresolved (retained): ${hold}` };
    const local = localHolds.get(id);
    if (local) return { why: local, stop: true };
    const service = host.serviceRestriction();
    if (service) return { why: service, stop: true };
    if (last.get(id)?.status !== 'running') { const nw = host.newWorkRestriction(); if (nw) return { why: nw }; }
    return null;
  }
  function assertCurrent(id) {
    const ctx = active.get(id);
    if (!ctx || ctx.epoch !== epoch(id)) throw Error('lifecycle context changed during reconcile');
    const b = blocker(id);
    if (b) throw Error(`lifecycle refused: ${b.why}`);
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
        return s;
      },
      resolve: (id, intent) => chain.resolve(id, intent),
      finalize: (id, intent) => chain.finalize(id, intent),
      // Gate BEFORE the runner journals an intent. submit is never gated: a journaled intent must be sent or reconciled.
      async prepare(id, snapshot, target, reason) {
        assertCurrent(id);
        const intent = await chain.prepare(id, snapshot, target, reason);
        // Still unsigned and not yet journaled: a context change during preparation
        // must not create a new intent. Already journaled sends remain reconciled.
        assertCurrent(id);
        return intent;
      },
      submit: (id, intent) => chain.submit(id, intent),
    };
    const boundRuntime = {
      fence: id => runtime.fence(id),
      stop: id => runtime.stop(id),
      health: (id, generation) => runtime.health(id, generation),
      async ensureStaged(id, snapshot) { assertCurrent(id); return runtime.ensureStaged(id, snapshot); },
      async serve(id, snapshot) { assertCurrent(id); return runtime.serve(id, snapshot); },
    };
    runner = new DeploymentLifecycleRunner({ chain: boundChain, runtime: boundRuntime, journal, pins, now, random });
  }

  function publish(id, result) {
    last.set(id, { ...result, at: now() });
    const s = result.status;
    const status = s === 'running' ? 'running' : s === 'stopped' || s === 'elsewhere' ? 'stopped' : s === 'held' ? 'held' : 'provisioning';
    // provisioning + isolationRequired: a staged VM may exist, so the legacy capacity view counts it (Host.occupies)
    try { host?.record(id, { status, reason: result.reason || '', lifecycle: true, lifecycleStatus: s, isolationRequired: true }); } catch {}
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
    const pre = blocker(id);
    if (pre) return fenceHeld(id, pre.why, pre.stop);
    const started = epoch(id);
    let refusal;
    try { refusal = await policy.refusal(id); }
    catch (e) { return fenceHeld(id, `v2 host policy unknown: ${e.message}`); }
    if (refusal !== null && typeof refusal !== 'string') return fenceHeld(id, 'v2 host policy answered neither null nor a refusal');
    if (refusal) return fenceHeld(id, `v2 host policy refusal: ${refusal}`, true);
    const mid = blocker(id);
    if (mid || epoch(id) !== started) return fenceHeld(id, mid?.why || 'restricted during policy read', !!mid?.stop || epoch(id) !== started);
    active.set(id, { epoch: started });
    let result;
    try { result = await runner.reconcile(id); }
    catch (e) { result = { status: 'held', reason: `lifecycle runner failed: ${e.message}` }; }
    finally { active.delete(id); }
    const post = blocker(id);
    if (post || epoch(id) !== started) return fenceHeld(id, `${post?.why || 'restricted'} (changed during reconcile)`, !!post?.stop || epoch(id) !== started);
    return publish(id, result);
  }

  const dispatch = {
    binding,
    blocked,
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
    /** Verify each not-yet-activated route once. Activated routes stay activated; per-pass refusals still hold them. */
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
          activated.set(id, Object.freeze({ at: now(), evidence: Object.freeze({ ...evidence }) }));
          say(`${id.slice(0, 10)} activated on ${r.newLedger}`);
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
    /** A legacy give-up path's owner/platform decision, enforced locally: fence and stop, no v1 release, no transaction. */
    async restrict(id, why) {
      id = String(id || '').toLowerCase();
      if (!table.has(id)) throw Error('no lifecycle route for this id');
      localHolds.set(id, String(why || 'restricted')); epochs.set(id, epoch(id) + 1);
      return fenceHeld(id, `restricted: ${why}`, true);
    },
    /** A claim hint never claims or reconciles a routed id. A FORCED hint (the operator) clears a local restriction only. */
    considerHint(id, { force = false } = {}) {
      id = String(id || '').toLowerCase();
      if (force && localHolds.delete(id)) say(`${id.slice(0, 10)} local restriction cleared by a forced hint`);
      const l = last.get(id);
      return { accepted: false, standing: 'lifecycle', reason: `managed by the event-driven lifecycle route (${l?.status || 'unknown'}${l?.reason ? `: ${l.reason}` : ''}); no legacy claim` };
    },
    start({ setInterval: every = setInterval } = {}) {
      if (!host) throw Error('lifecycle dispatch is not attached to a host');
      if (timer) return;
      timer = every(() => { dispatch.pass().catch(e => say(`pass: ${e.message}`)); }, intervalMs);
      timer?.unref?.();
      dispatch.pass().catch(e => say(`pass: ${e.message}`));
    },
    stop({ clearInterval: clear = clearInterval } = {}) { if (timer) clear(timer); timer = null; },
    state: () => [...table.keys()].map(id => ({ id, activated: activated.has(id), held: heldWhy.get(id) || null,
      restricted: localHolds.get(id) || null, last: last.get(id) || null, blocked,
      settlement: 'v2 paid proof-of-service settlement is not implemented by this dispatch' })),
  };
  return Object.freeze(dispatch);
}

/** The host's single entry: no dispatch -> null (legacy unchanged). Otherwise attach once with the host's live callbacks. */
export function attachLifecycleDispatch(dispatch, view) {
  if (dispatch === null || dispatch === undefined) return null;
  if (typeof dispatch.attach !== 'function' || typeof dispatch.owns !== 'function') throw Error('cfg.lifecycleDispatch must come from createLifecycleDispatch');
  return dispatch.attach(view);
}
