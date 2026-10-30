// A single host/witness process owns this journal. Row mutations synchronously
// commit locally before returning an action. acceptAnchor is asynchronous and
// additionally awaits the configured exact-bytes replication hook. Corruption/write failure closes the journal; never replace it
// with an empty state and accidentally clear a crash loop or a witness fence.
import fs from 'node:fs';
import { commitJournalBytes, validateJournalCommit } from './journal-commit.mjs';
import { strictWriteFile } from './lease-release-journal.mjs';
import { initialRestartState, validateRestartState, restartFailure, restartHealthy,
  restartUnhealthy, restartDecision, ownerResumeRestartState } from './deployment-restart-policy.mjs';

const ID = /^0x[0-9a-f]{64}$/;
const int = n => Number.isSafeInteger(n) && n >= 0;
function validate(j) {
  if (!j || j.version !== 1 || !Array.isArray(j.deployments) || j.deployments.length > 65536)
    throw new Error('invalid lifecycle journal');
  j.authorityAnchors ??= {};
  if (!j.authorityAnchors || typeof j.authorityAnchors !== 'object' || Array.isArray(j.authorityAnchors) ||
      Object.keys(j.authorityAnchors).length > 32) throw Error('invalid authority anchor journal');
  for (const [chain, anchor] of Object.entries(j.authorityAnchors)) {
    if (!/^[1-9][0-9]{0,14}$/.test(chain) || !validAnchor(anchor)) throw Error('invalid durable authority anchor');
  }
  const seen = new Set();
  for (const row of j.deployments) {
    if (!row || !ID.test(row.id) || seen.has(row.id)) throw new Error('invalid or duplicate deployment');
    seen.add(row.id); validateRestartState(row.restart);
    row.bindingDigest ??= null;
    row.successorVote ??= null;
    row.denial ??= null;
    row.attemptSequence ??= 0; row.runtime ??= null;
    row.minedTransitions ??= [];
    if (!Array.isArray(row.minedTransitions) || row.minedTransitions.length > 128 || row.minedTransitions.some(x =>
      !ID.test(x?.digest) || typeof x.payload !== 'string' || x.payload.length > 32768 ||
      !ID.test(x.transactionHash) || !ID.test(x.blockHash) || !int(x.blockNumber))) throw new Error('invalid mined transition journal');
    if (!int(row.attemptSequence) || row.runtime !== null && (!int(row.runtime.generation) || !int(row.runtime.startedAt) ||
        typeof row.runtime.instance !== 'string' || !row.runtime.instance.length || row.runtime.instance.length > 256))
      throw new Error('invalid runtime journal');
    if (row.denial !== null && (!int(row.denial.blockNumber) || !ID.test(row.denial.blockHash) ||
        !int(row.denial.observedAt) || !int(row.denial.revision))) throw new Error('invalid denial floor');
    if (row.successorVote !== null && (!int(row.successorVote.generation) || !ID.test(row.successorVote.digest) ||
        !ID.test(row.successorVote.previous) || typeof row.successorVote.payload !== 'string' || row.successorVote.payload.length > 8192))
      throw new Error('invalid successor vote');
    if (!int(row.generation) || !int(row.revision) || !int(row.sequence) || typeof row.fenced !== 'boolean' ||
        !(row.digest === null || ID.test(row.digest)) ||
        !(row.bindingDigest === null || ID.test(row.bindingDigest))) throw new Error('invalid witness state');
    if (row.pending !== null && (typeof row.pending !== 'object' || !ID.test(row.pending.digest) ||
        typeof row.pending.payload !== 'string' || row.pending.payload.length > 32768)) throw new Error('invalid transition outbox');
  }
  return j;
}
function validAnchor(a) {
  return a?.tier === 'l1-finalized-derived' && [a.base, a.l1].every(b => b && int(b.number) && int(b.timestamp) && ID.test(b.hash)) &&
    ID.test(a.base.stateRoot) && ID.test(a.base.outputRoot);
}
const fresh = id => ({ id, restart: initialRestartState(), generation: 0, revision: 0,
  sequence: 0, digest: null, bindingDigest: null, successorVote: null, denial: null,
  attemptSequence: 0, runtime: null, minedTransitions: [], fenced: false, pending: null });

export function openLifecycleJournal(file, { fsImpl = fs, platform = process.platform, requireExisting = false,
  commit = null, requireCommit = false, commitTimeoutMs = 10000 } = {}) {
  validateJournalCommit({ commit, requireCommit, commitTimeoutMs });
  if ((requireExisting || requireCommit) && !fsImpl.existsSync(file)) throw Error('lifecycle journal missing; explicit enrollment/recovery required');
  let state = { version: 1, deployments: [], authorityAnchors: {} }, failed = null, pending = false, closed = false, commitController = null, pendingDone = null;
  if (fsImpl.existsSync(file)) {
    try { state = validate(JSON.parse(fsImpl.readFileSync(file, 'utf8'))); }
    catch (e) { failed = `lifecycle journal is unreadable: ${e.message}`; }
  }
  const check = () => { if (closed) throw Error('lifecycle journal closed'); if (failed) throw new Error(failed); if (pending) throw Error('lifecycle journal commit pending'); };
  const idOf = id => { if (!ID.test(id)) throw new Error('invalid deployment id'); return id; };
  function read(id) { check(); return structuredClone(state.deployments.find(x => x.id === idOf(id)) || fresh(id)); }
  function update(id, change) {
    check();
    if (requireCommit) throw Error('replicated anchor journal cannot mutate lifecycle rows');
    const next = structuredClone(state), row = read(id), changed = change(row);
    const index = next.deployments.findIndex(x => x.id === id);
    if (index < 0) next.deployments.push(changed); else next.deployments[index] = changed;
    validate(next);
    try { strictWriteFile(file, JSON.stringify(next), { fsImpl, platform }); }
    catch (e) { failed = `lifecycle journal write failed: ${e.message}`; throw e; }
    state = next; return structuredClone(changed);
  }
  return {
    close() { closed = true; commitController?.abort(Error('lifecycle journal closed')); return pendingDone || undefined; },
    read,
    readAnchor(chainId) { check(); return structuredClone(state.authorityAnchors[String(chainId)] || null); },
    async acceptAnchor(chainId, anchor, { signal } = {}) {
      check(); signal?.throwIfAborted();
      if (!Number.isSafeInteger(chainId) || chainId < 1 || !validAnchor(anchor)) throw Error('invalid durable authority anchor');
      const old = state.authorityAnchors[String(chainId)];
      if (old && ['base', 'l1'].some(k => anchor[k].number < old[k].number ||
          anchor[k].number === old[k].number && anchor[k].hash !== old[k].hash)) throw Error('durable authority anchor rollback');
      if (old && anchor.base.number === old.base.number &&
          (anchor.base.stateRoot !== old.base.stateRoot || anchor.base.outputRoot !== old.base.outputRoot || anchor.base.timestamp !== old.base.timestamp))
        throw Error('durable authority anchor contradiction');
      const next = structuredClone(state); next.authorityAnchors[String(chainId)] = structuredClone(anchor); validate(next);
      const bytes = JSON.stringify(next); pending = true; commitController = new AbortController();
      const combined = signal ? AbortSignal.any([signal, commitController.signal]) : commitController.signal;
      let finish; pendingDone = new Promise(resolve => { finish = resolve; });
      try {
        strictWriteFile(file, bytes, { fsImpl, platform });
        await commitJournalBytes(commit, { file, bytes, signal: combined }, commitTimeoutMs);
        combined.throwIfAborted();
        if (closed) throw Error('lifecycle journal closed');
        state = next;
      } catch (e) { failed = `lifecycle anchor commit failed: ${e.message}`; throw e; }
      finally { pending = false; commitController = null; finish(); pendingDone = null; }
    },
    failure(id, args) { return update(id, row => ({ ...row, restart: restartFailure(row.restart, args) })); },
    healthy(id, args) { return update(id, row => ({ ...row, restart: restartHealthy(row.restart, args) })); },
    unhealthy(id, now) { return update(id, row => ({ ...row, restart: restartUnhealthy(row.restart, now) })); },
    decision(id, now) { return restartDecision(read(id).restart, now); },
    // Called only AFTER authenticating an explicit owner resume.
    resume(id, now) { return update(id, row => ({ ...row, restart: ownerResumeRestartState(row.restart, now) })); },
    observeAssignment(id, generation, revision, bindingDigest = null) {
      if (!int(generation) || !int(revision) || generation === 0 || revision === 0) throw new Error('invalid assignment');
      if (bindingDigest !== null && !ID.test(bindingDigest)) throw new Error('invalid assignment binding');
      return update(id, row => {
        if (generation < row.generation || generation === row.generation && revision < row.revision) throw new Error('assignment rollback');
        if (generation === row.generation && revision === row.revision) {
          if (row.bindingDigest && bindingDigest && row.bindingDigest !== bindingDigest) throw new Error('conflicting assignment binding');
          return { ...row, bindingDigest: row.bindingDigest || bindingDigest };
        }
        // A policy edit must not revive an assignment that this witness fenced.
        return { ...row, generation, revision, sequence: 0, digest: null, bindingDigest,
          fenced: generation === row.generation ? row.fenced : false };
      });
    },
    permit(id, { generation, revision, sequence, digest }) {
      if (!int(sequence) || sequence < 1 || !ID.test(digest)) throw new Error('invalid permit');
      return update(id, row => {
        if (row.fenced || row.generation !== generation || row.revision !== revision) throw new Error('generation fenced or unknown');
        if (sequence < row.sequence || sequence === row.sequence && digest !== row.digest) throw new Error('permit replay or equivocation');
        return { ...row, sequence, digest };
      });
    },
    fence(id, generation) {
      return update(id, row => {
        if (row.generation !== generation) throw new Error('wrong generation to fence');
        return { ...row, fenced: true };
      });
    },
    voteSuccessor(id, { generation, previous, digest, payload }) {
      return update(id, row => {
        if (generation !== row.generation + 1) throw new Error('successor does not follow observed generation');
        const old = row.successorVote;
        if (old && (generation < old.generation || generation === old.generation &&
            (old.digest !== digest || old.previous !== previous || old.payload !== payload)))
          throw new Error('conflicting successor vote');
        return { ...row, fenced: true, successorVote: { generation, previous, digest, payload } };
      });
    },
    deny(id, denial) {
      return update(id, row => ({ ...row, denial: !row.denial || denial.blockNumber >= row.denial.blockNumber ? denial : row.denial }));
    },
    // Only after authenticating finalized positive policy beyond the denial.
    restoreDenial(id, blockNumber) {
      return update(id, row => {
        if (!row.denial || !int(blockNumber) || blockNumber < row.denial.blockNumber) throw new Error('restoration precedes denial');
        return { ...row, denial: null };
      });
    },
    beginAttempt(id) {
      return update(id, row => ({ ...row, attemptSequence: row.attemptSequence + 1 })).attemptSequence;
    },
    rememberRuntime(id, { instance, generation, now }) {
      return update(id, row => {
        if (row.runtime && (row.runtime.generation > generation || row.runtime.generation === generation && row.runtime.instance !== instance))
          throw new Error('conflicting runtime instance');
        return { ...row, runtime: { instance, generation,
          startedAt: row.runtime?.instance === instance && row.runtime.generation === generation ? row.runtime.startedAt : now } };
      }).runtime;
    },
    // Only after the manager confirms this concrete instance is retired AND
    // every serving/data boundary is held. It does not reset crash accounting.
    retireRuntime(id, instance) {
      return update(id, row => {
        if (row.runtime && row.runtime.instance !== instance) throw Error('wrong runtime retirement');
        return { ...row, runtime: null };
      });
    },
    prepareTransition(id, { digest, payload }) {
      return update(id, row => {
        if (row.pending && (row.pending.digest !== digest || row.pending.payload !== payload))
          throw new Error('unresolved transition; reconcile exact intent first');
        return { ...row, pending: { digest, payload } };
      });
    },
    // The caller must verify a matching chain receipt or a finalized nonce/
    // generation fence. A transport timeout is NOT evidence that nothing landed.
    settleTransition(id, digest) {
      return update(id, row => {
        if (!row.pending || row.pending.digest !== digest) throw new Error('wrong transition settlement');
        return { ...row, pending: null };
      });
    },
    // A proof-verified mined receipt plus an anchored quorum certificate may
    // advance operational state, but the exact intent remains until finality.
    archiveMined(id, digest, receipt) {
      return update(id, row => {
        if (!row.pending || row.pending.digest !== digest) throw new Error('wrong mined transition');
        return { ...row, pending: null, minedTransitions: [...row.minedTransitions, { ...row.pending,
          transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber }] };
      });
    },
    settleMined(id, digest) {
      return update(id, row => {
        if (!row.minedTransitions.some(x => x.digest === digest)) throw new Error('unknown mined transition');
        return { ...row, minedTransitions: row.minedTransitions.filter(x => x.digest !== digest) };
      });
    },
  };
}
