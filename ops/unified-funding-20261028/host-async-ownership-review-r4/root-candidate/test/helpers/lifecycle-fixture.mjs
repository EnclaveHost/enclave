// MOCK lifecycle adapters for the dispatch tests (r3: a superset of the r2 fixture, which the r2/root tests also get
// through test/helpers/baseline.mjs). They return `verified: true` and an authority tier only so the REAL
// DeploymentLifecycleRunner can be driven through its state machine. They establish NO production authority, fencing,
// funding, capacity or readiness, and nothing here substitutes for the qualified adapters named in docs/REPORT.md.
// r3 additions: a manager inventory (findByName: view | null | throws) tracking the mock VMs, exact-payload intents
// (the r6 canonical `intent.target` code), the owned journal's host-authority methods (same rules as the generated
// journal; the real one is tested in r3-durable-authority.test.mjs) and the host view's shareOf.
// host-registry r2 repair r1 (SUPERSET of root host-registry-generation-preflight-r4 test/helpers/lifecycle-fixture.mjs a5f599b7,
// every original line retained): the mock owned journal also carries the three host-incarnation methods with the SAME rules as
// network/lifecycle-host-incarnation-journal.mjs (in memory; the real durable file section is exercised by the Anvil suite).
export const H = (b) => '0x' + b.repeat(32);
export const OLD = '0x' + 'd0'.repeat(20);   // == the baseline fake-base-rpc DEPLOYMENTS address (the legacy ledger)
export const NEW = '0x' + 'e2'.repeat(20), CTRL = '0x' + 'c7'.repeat(20), OTHER = '0x' + 'd1'.repeat(20);
export const INDEP = '0x' + '1d'.repeat(20);      // an independent host-owner wallet
export const PLATFORM = '0x' + 'ea'.repeat(20);   // a pinned platform wallet
export const binding = () => ({ ledger: NEW, controller: CTRL, deploymentsSchema: 17, lifecycleSchema: 2, ledgerCodeHash: H('11'), controllerCodeHash: H('22') });
export const route = (id, over = {}) => ({ deployment: id, oldLedger: OLD, newLedger: NEW, controller: CTRL, deploymentsSchema: 17,
  lifecycleSchema: 2, ledgerCodeHash: H('11'), controllerCodeHash: H('22'), quiescenceDigest: H('33'), ...over });
export const good = (r) => ({ verified: true, proofVerified: true, authorityTier: 'finalized', deployment: r.deployment,
  ledger: r.oldLedger, digest: r.quiescenceDigest, quiescent: true });
// the authenticated resources an independent-profile snapshot carries (ledger cpuMilli/gpuMilli + catalog version minima)
export const resources = (cpuMilli = 100, gpuMilli = 0) => ({ cpuMilli, gpuMilli, cpuShare: cpuMilli / 1000, gpuShare: gpuMilli / 1000,
  version: { memMb: 512, cpuGflops: 0, vramMb: 0, gpuGflops: 0, config: '' } });
const CODE = { queued: 1, running: 2, stopped: 3 };

export function fixture({ hostId, state = 'running', now = Date.now } = {}) {
  const calls = { read: [], prepare: [], submit: [], resolve: [], finalize: [], fence: [], stop: [], health: [], ensureStaged: [], serve: [], decision: [], quiescence: [], inventory: [] };
  const S = { state: new Map(), over: new Map(), readGate: null, onRead: null, quiescence: good,
    owner: INDEP, revision: 1, refusal: null, decision: null, decisionError: null,
    staged: { ready: true }, health: { ready: true },
    // r3: manager inventory and removal. inventoryError: a reason (every id) or id => reason | null
    vms: new Set(), retiredVms: new Set(), views: new Map(), inventoryError: null, stopResult: true, stopError: null };
  const snap = (id) => ({ schema: 2, id, ledger: NEW, controller: CTRL, verified: true, authorityTier: 'finalized', blockAt: now(),
    thisHost: hostId, enabled: true, funded: true, admitted: true, policy: {}, appRef: 'catalog://0x' + 'cd'.repeat(32) + '/1',
    resources: resources(),
    assignment: { state: S.state.get(id) ?? state, host: hostId, generation: 3, revision: 1, startAfter: 0, crashHeld: false },
    ...(S.over.get(id) || {}) });
  const chain = {
    binding: binding(),
    async read(id) { calls.read.push(id); if (S.readGate) await S.readGate; S.onRead?.(id); return snap(id); },
    async resolve(id) { calls.resolve.push(id); return { verified: false }; },
    async finalize(id) { calls.finalize.push(id); return { verified: false }; },
    async prepare(id, snapshot, target) { calls.prepare.push({ id, target });
      return { digest: H(target === 'running' ? '44' : '45'), target, payload: JSON.stringify({ intent: { id, target: CODE[target] } }) }; },
    async submit(id, intent) { calls.submit.push({ id, intent }); },
  };
  // a VM exists for an assignment that starts out running (a recovered runtime) until it is stopped, or once staged
  const vmExists = (id) => S.vms.has(id) || (!S.retiredVms.has(id) && (S.state.get(id) ?? state) === 'running');
  const runtime = {
    async fence(id) { calls.fence.push(id); },
    async stop(id) { calls.stop.push(id); if (S.stopError) throw Error(S.stopError);
      if (S.stopResult === true) { S.vms.delete(id); S.retiredVms.add(id); } return S.stopResult; },
    async health(id) { calls.health.push(id); return S.health; },
    async ensureStaged(id) { calls.ensureStaged.push(id); S.vms.add(id); S.retiredVms.delete(id); return S.staged; },
    async serve(id) { calls.serve.push(id); },
  };
  const inventory = {
    async findByName(id) { calls.inventory.push(id);
      const err = typeof S.inventoryError === 'function' ? S.inventoryError(id) : S.inventoryError;
      if (err) throw Error(err);
      if (S.views.has(id)) return S.views.get(id);
      return vmExists(id) ? { id: `vm-${id.slice(2, 10)}`, name: id, status: 'running', recovered: false } : null; },
  };
  const rows = new Map();
  const row = (id) => { if (!rows.has(id)) rows.set(id, { denial: null, minedTransitions: [], pending: null, runtime: null, sequence: 0 }); return rows.get(id); };
  // the owned journal's host-authority section, in memory, with the generated journal's rules
  const hostAuthority = new Map();
  const entry = (h) => { if (!hostAuthority.has(h)) hostAuthority.set(h, { floor: null, ownerEpoch: 0, holds: {} }); return hostAuthority.get(h); };
  // host-registry r2 repair r1: host incarnation section (MOCK, in memory; rules identical to lifecycle-host-incarnation-journal.mjs)
  const incarnations = new Map();
  const journal = {
    read: row, observeAssignment() {}, restoreDenial() {}, deny() {}, settleMined() {}, archiveMined() {},
    settleTransition(id) { row(id).pending = null; },
    prepareTransition(id, intent) { if (row(id).pending) throw Error('an intent is already pending'); row(id).pending = intent; },
    healthy() {}, unhealthy() {}, failure() {}, decision() { return { start: true }; },
    readHostAuthority: (h) => (hostAuthority.has(h) ? structuredClone(hostAuthority.get(h)) : null),
    acceptHostAuthority(h, { revision, owner, policyHash }) {
      const e = entry(h), f = e.floor;
      if (f && (BigInt(revision) < BigInt(f.revision) || BigInt(revision) === BigInt(f.revision) && (owner !== f.owner || policyHash !== f.policyHash)))
        throw Error('host authority rollback or equivocation');
      e.floor = { revision, owner, policyHash }; return { ...e.floor };
    },
    holdHostLocal(h, id, { why, at }) { const e = entry(h); e.holds[id] = { why, ownerEpoch: e.ownerEpoch, at }; return { ...e.holds[id] }; },
    releaseHostLocal(h, id) { const e = entry(h), x = e.holds[id];
      if (!x) throw Error('no such local hold');
      if (!(x.ownerEpoch < e.ownerEpoch)) throw Error('a local hold is released only by a later owner control change');
      delete e.holds[id]; },
    advanceOwnerControls(h) { return ++entry(h).ownerEpoch; },
    readHostIncarnation: (h) => (incarnations.has(h) ? structuredClone(incarnations.get(h)) : null),
    acceptHostIncarnation(h, x) {
      const e = incarnations.get(h), f = e?.floor;
      if (f) {
        if (BigInt(x.generation) < BigInt(f.generation)) throw Error('host incarnation rollback');
        if (x.generation === f.generation && x.digest !== f.digest) throw Error('host incarnation equivocation');
        if (x.generation === f.generation) return { ...f };
      }
      const floor = { generation: x.generation, digest: x.digest, context: structuredClone(x) };
      incarnations.set(h, { floor, genesis: e?.genesis ?? x.digest, bound: e?.bound ?? {} });
      return { ...floor };
    },
    bindHostIncarnation(h, id, { generation, digest, reason, at }) {
      const e = incarnations.get(h);
      if (!e?.floor || e.floor.digest !== digest || e.floor.generation !== generation) throw Error('an app context binds only the durable current host incarnation');
      e.bound[id] = { generation, digest, reason, at }; return { ...e.bound[id] };
    },
  };
  const authority = { async decision(id, s) {
    calls.decision.push(id);
    if (S.decisionError) throw Error(S.decisionError);
    return S.decision ? S.decision(id, s) : { hostId, deployment: id, owner: S.owner, revision: String(S.revision), policyHash: H('55'),
      refusal: S.refusal, validUntil: now() + 60_000 };
  } };
  const verifyQuiescence = async (r) => { calls.quiescence.push(r.deployment); return S.quiescence(r); };
  const V = { ledger: OLD, holds: new Map(), owner: null, service: null, newWork: null, activity: new Map(), records: new Map(), logs: [],
    capacity: { paused: false, cpuCap: 1, gpuCap: 1, cpuUsed: 0, gpuUsed: 0 } };
  const hostView = (id) => ({ hostId: id, legacyLedger: () => V.ledger, legacyHold: (d) => V.holds.get(d) ?? null,
    ownerRestriction: () => V.owner, platformService: () => V.service, platformNewWork: () => V.newWork,
    legacyActivity: (d) => V.activity.get(d) ?? [], capacity: () => V.capacity,
    shareOf: (d, r) => ({ cpuShare: r.cpuShare, gpuShare: r.gpuShare }),   // MOCK: the real host prices it with Host.cpuShareOf
    record: (d, p) => V.records.set(d, { ...V.records.get(d), ...p }), log: (m) => V.logs.push(m) });
  const parts = (routes, over = {}) => ({ routes, chain, runtime, journal, inventory, pins: { chainId: 8453, lifecycle: CTRL }, authority,
    platformWallets: [PLATFORM], capacityHeadroom: 0.05, verifyQuiescence, now, ...over });
  return { calls, S, V, chain, runtime, journal, inventory, rows, hostAuthority, incarnations, authority, verifyQuiescence, hostView, parts };
}
