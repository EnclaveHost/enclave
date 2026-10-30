// MOCK lifecycle adapters for the dispatch tests. They return `verified: true` and an authority tier only so the REAL
// DeploymentLifecycleRunner can be driven through its state machine. They establish NO production authority, fencing,
// funding or readiness, and nothing here is a substitute for the qualified adapters named in REPORT.md.
export const H = (b) => '0x' + b.repeat(32);
export const OLD = '0x' + 'd0'.repeat(20);   // == the baseline fake-base-rpc DEPLOYMENTS address (the legacy ledger)
export const NEW = '0x' + 'e2'.repeat(20), CTRL = '0x' + 'c7'.repeat(20), OTHER = '0x' + 'd1'.repeat(20);
export const binding = () => ({ ledger: NEW, controller: CTRL, deploymentsSchema: 17, lifecycleSchema: 2, ledgerCodeHash: H('11'), controllerCodeHash: H('22') });
export const route = (id, over = {}) => ({ deployment: id, oldLedger: OLD, newLedger: NEW, controller: CTRL, deploymentsSchema: 17,
  lifecycleSchema: 2, ledgerCodeHash: H('11'), controllerCodeHash: H('22'), quiescenceDigest: H('33'), ...over });
export const good = (r) => ({ verified: true, proofVerified: true, authorityTier: 'finalized', deployment: r.deployment,
  ledger: r.oldLedger, digest: r.quiescenceDigest, quiescent: true });

export function fixture({ hostId, state = 'running', now = Date.now } = {}) {
  const calls = { read: [], prepare: [], submit: [], resolve: [], finalize: [], fence: [], stop: [], health: [], ensureStaged: [], serve: [], policy: [], quiescence: [] };
  const S = { state: new Map(), over: new Map(), readGate: null, onRead: null, policy: () => null, quiescence: good,
    staged: { ready: true }, health: { ready: true } };
  const snap = (id) => ({ schema: 2, id, ledger: NEW, controller: CTRL, verified: true, authorityTier: 'finalized', blockAt: now(),
    thisHost: hostId, enabled: true, funded: true, admitted: true, policy: {},
    assignment: { state: S.state.get(id) ?? state, host: hostId, generation: 3, revision: 1, startAfter: 0, crashHeld: false },
    ...(S.over.get(id) || {}) });
  const chain = {
    binding: binding(),
    async read(id) { calls.read.push(id); if (S.readGate) await S.readGate; S.onRead?.(id); return snap(id); },
    async resolve(id) { calls.resolve.push(id); return { verified: false }; },
    async finalize(id) { calls.finalize.push(id); return { verified: false }; },
    async prepare(id, snapshot, target) { calls.prepare.push({ id, target }); return { digest: H('44'), target }; },
    async submit(id, intent) { calls.submit.push({ id, intent }); },
  };
  const runtime = {
    async fence(id) { calls.fence.push(id); },
    async stop(id) { calls.stop.push(id); return true; },
    async health(id) { calls.health.push(id); return S.health; },
    async ensureStaged(id) { calls.ensureStaged.push(id); return S.staged; },
    async serve(id) { calls.serve.push(id); },
  };
  const rows = new Map();
  const row = (id) => { if (!rows.has(id)) rows.set(id, { denial: null, minedTransitions: [], pending: null, runtime: null, sequence: 0 }); return rows.get(id); };
  const journal = {
    read: row, observeAssignment() {}, restoreDenial() {}, deny() {}, settleMined() {}, archiveMined() {},
    settleTransition(id) { row(id).pending = null; },
    prepareTransition(id, intent) { if (row(id).pending) throw Error('an intent is already pending'); row(id).pending = intent; },
    healthy() {}, unhealthy() {}, failure() {}, decision() { return { start: true }; },
  };
  const policy = { async refusal(id) { calls.policy.push(id); return S.policy(id); } };
  const verifyQuiescence = async (r) => { calls.quiescence.push(r.deployment); return S.quiescence(r); };
  const V = { ledger: OLD, holds: new Map(), service: null, newWork: null, activity: new Map(), records: new Map(), logs: [] };
  const hostView = (id) => ({ hostId: id, legacyLedger: () => V.ledger, legacyHold: (d) => V.holds.get(d) ?? null,
    serviceRestriction: () => V.service, newWorkRestriction: () => V.newWork, legacyActivity: (d) => V.activity.get(d) ?? [],
    record: (d, p) => V.records.set(d, { ...V.records.get(d), ...p }), log: (m) => V.logs.push(m) });
  const parts = (routes) => ({ routes, chain, runtime, journal, pins: { chainId: 8453, lifecycle: CTRL }, policy, verifyQuiescence, now });
  return { calls, S, V, chain, runtime, journal, rows, policy, verifyQuiescence, hostView, parts };
}
