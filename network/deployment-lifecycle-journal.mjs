// A single host/witness process owns this journal. Mutations are synchronous
// and durably committed BEFORE returning an action that may start, sign or
// broadcast. Corruption/write failure closes the journal; never replace it
// with an empty state and accidentally clear a crash loop or a witness fence.
import fs from 'node:fs';
import { strictWriteFile } from './lease-release-journal.mjs';
import { initialRestartState, validateRestartState, restartFailure, restartHealthy,
  restartUnhealthy, restartDecision, ownerResumeRestartState } from './deployment-restart-policy.mjs';

const ID = /^0x[0-9a-f]{64}$/;
const int = n => Number.isSafeInteger(n) && n >= 0;
function validate(j) {
  if (!j || j.version !== 1 || !Array.isArray(j.deployments) || j.deployments.length > 65536)
    throw new Error('invalid lifecycle journal');
  const seen = new Set();
  for (const row of j.deployments) {
    if (!row || !ID.test(row.id) || seen.has(row.id)) throw new Error('invalid or duplicate deployment');
    seen.add(row.id); validateRestartState(row.restart);
    if (!int(row.generation) || !int(row.revision) || !int(row.sequence) || typeof row.fenced !== 'boolean' ||
        !(row.digest === null || ID.test(row.digest))) throw new Error('invalid witness state');
    if (row.pending !== null && (typeof row.pending !== 'object' || !ID.test(row.pending.digest) ||
        typeof row.pending.payload !== 'string' || row.pending.payload.length > 32768)) throw new Error('invalid transition outbox');
  }
  return j;
}
const fresh = id => ({ id, restart: initialRestartState(), generation: 0, revision: 0,
  sequence: 0, digest: null, fenced: false, pending: null });

export function openLifecycleJournal(file, { fsImpl = fs, platform = process.platform } = {}) {
  let state = { version: 1, deployments: [] }, failed = null;
  if (fsImpl.existsSync(file)) {
    try { state = validate(JSON.parse(fsImpl.readFileSync(file, 'utf8'))); }
    catch (e) { failed = `lifecycle journal is unreadable: ${e.message}`; }
  }
  const check = () => { if (failed) throw new Error(failed); };
  const idOf = id => { if (!ID.test(id)) throw new Error('invalid deployment id'); return id; };
  function read(id) { check(); return structuredClone(state.deployments.find(x => x.id === idOf(id)) || fresh(id)); }
  function update(id, change) {
    check(); const next = structuredClone(state), row = read(id), changed = change(row);
    const index = next.deployments.findIndex(x => x.id === id);
    if (index < 0) next.deployments.push(changed); else next.deployments[index] = changed;
    validate(next);
    try { strictWriteFile(file, JSON.stringify(next), { fsImpl, platform }); }
    catch (e) { failed = `lifecycle journal write failed: ${e.message}`; throw e; }
    state = next; return structuredClone(changed);
  }
  return {
    read,
    failure(id, args) { return update(id, row => ({ ...row, restart: restartFailure(row.restart, args) })); },
    healthy(id, args) { return update(id, row => ({ ...row, restart: restartHealthy(row.restart, args) })); },
    unhealthy(id, now) { return update(id, row => ({ ...row, restart: restartUnhealthy(row.restart, now) })); },
    decision(id, now) { return restartDecision(read(id).restart, now); },
    // Called only AFTER authenticating an explicit owner resume.
    resume(id, now) { return update(id, row => ({ ...row, restart: ownerResumeRestartState(row.restart, now) })); },
    observeAssignment(id, generation, revision) {
      if (!int(generation) || !int(revision) || generation === 0 || revision === 0) throw new Error('invalid assignment');
      return update(id, row => {
        if (generation < row.generation || generation === row.generation && revision < row.revision) throw new Error('assignment rollback');
        if (generation === row.generation && revision === row.revision) return row;
        // A policy edit must not revive an assignment that this witness fenced.
        return { ...row, generation, revision, sequence: 0, digest: null,
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
  };
}
