// This file is a durable rollback floor/audit trail, NEVER a proof of its saved
// output root. Every process starts from a newly authenticated ASR bootstrap and
// re-derives through this floor before it may publish. Host-edited saved roots
// can cause refusal, not authorize a chain. Disk rollback resistance additionally
// requires the accepted domain's externally protected recovery floor.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { takeRuntimeLock } from '../runtime-lock.mjs';
import { strictWriteFile } from '../lease-release-journal.mjs';
import { commitJournalBytes, validateJournalCommit } from '../journal-commit.mjs';
const HASH = /^0x[0-9a-f]{64}$/;
const int = n => Number.isSafeInteger(n) && n >= 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateAnchor(anchor) {
  if (!anchor || !['l1-finalized-derived', 'l1-finalized-asr-anchor'].includes(anchor.tier)) throw Error('invalid agreed-root authority tier');
  const { base, l1 } = anchor;
  for (const b of [base, l1]) if (!b || !int(b.number) || !int(b.timestamp) || !HASH.test(b.hash) || !HASH.test(b.stateRoot)) throw Error('invalid agreed-root header');
  if (!HASH.test(base.outputRoot) || !HASH.test(base.messagePasserStorageRoot)) throw Error('invalid agreed output root');
  return anchor;
}
export async function openDerivedJournal(directory, { binding, initialize = false, commit = null, requireCommit = false, commitTimeoutMs = 10000 } = {}) {
  if (!path.isAbsolute(directory) || !/^[0-9a-f]{64}$/.test(binding || '')) throw Error('derived journal needs a pinned binding and absolute directory');
  validateJournalCommit({ commit, requireCommit, commitTimeoutMs });
  if (initialize && requireCommit) throw Error('replicated journals require explicit verified enrollment');
  const root = fs.realpathSync(directory), file = path.join(root, 'derived-state.json');
  const unlock = await takeRuntimeLock(path.join(root, 'derived-state.lock'));
  let failed = false, closed = false, state, pending = false, commitController = null, pendingDone = null;
  try {
    if (['.enrollment-inflight', '.enrollment-inflight.strict.tmp'].some(n => fs.existsSync(path.join(root, n))))
      throw Error('derived enrollment uncertain; explicit recovery required');
    if (!fs.existsSync(file)) {
      if (!initialize) throw Error('derived journal missing; explicit enrollment/recovery required');
      state = { format: 'enclave-derived-root-journal/v1', binding, floor: null, entries: [] };
      strictWriteFile(file, JSON.stringify(state));
    }
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 262144) throw Error('invalid derived journal file');
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.format !== 'enclave-derived-root-journal/v1' || state.binding !== binding || !Array.isArray(state.entries) || state.entries.length > 128) throw Error('derived journal binding or schema mismatch');
    if (requireCommit && !state.enrollment || state.enrollment &&
        (state.enrollment.phase !== 'committed' || !/^[0-9a-f]{64}$/.test(state.enrollment.digest))) throw Error('derived enrollment incomplete; explicit recovery required');
    if (state.floor) validateAnchor(state.floor);
    let prior;
    for (const entry of state.entries) {
      if (!/^[0-9a-f]{64}$/.test(entry.previousDigest) || !HASH.test(entry.agreedRoot) || !int(entry.agreedNumber)) throw Error('invalid derived journal link');
      validateAnchor(entry.anchor);
      const { hash, ...value } = entry;
      if (hash !== digest(value) || prior && entry.previousDigest !== prior) throw Error('derived journal hash-chain corruption');
      prior = hash;
    }
    if (state.entries.length && JSON.stringify(state.entries.at(-1).anchor) !== JSON.stringify(state.floor)) throw Error('derived journal floor mismatch');
  } catch (e) { unlock(); throw e; }
  const alive = () => { if (closed || failed) throw Error('derived journal closed or failed'); };
  const available = () => { alive(); if (pending) throw Error('derived journal commit pending'); };
  return {
    read() { available(); return structuredClone(state); },
    async accept(agreed, anchor, { signal } = {}) {
      available(); signal?.throwIfAborted(); validateAnchor(agreed); validateAnchor(anchor);
      if (anchor.tier !== 'l1-finalized-derived' || anchor.base.number <= agreed.base.number || anchor.l1.number < agreed.l1.number ||
          anchor.l1.number === agreed.l1.number && anchor.l1.hash !== agreed.l1.hash) throw Error('derived result does not advance its agreed root');
      const floor = state.floor;
      if (floor && (anchor.base.number < floor.base.number || anchor.base.number === floor.base.number && anchor.base.hash !== floor.base.hash ||
          anchor.l1.number < floor.l1.number || anchor.l1.number === floor.l1.number && anchor.l1.hash !== floor.l1.hash)) throw Error('derived authority rollback or contradiction');
      const value = { previousDigest: state.entries.at(-1)?.hash || '0'.repeat(64), agreedRoot: agreed.base.outputRoot,
        agreedNumber: agreed.base.number, anchor: structuredClone(anchor) };
      const next = { ...state, floor: structuredClone(anchor), entries: [...state.entries, { ...value, hash: digest(value) }].slice(-128) };
      const bytes = JSON.stringify(next);
      pending = true; commitController = new AbortController();
      let finish; pendingDone = new Promise(resolve => { finish = resolve; });
      const combined = signal ? AbortSignal.any([signal, commitController.signal]) : commitController.signal;
      try {
        strictWriteFile(file, bytes);
        await commitJournalBytes(commit, { file, bytes, signal: combined }, commitTimeoutMs);
        combined.throwIfAborted(); alive();
        state = next;
      } catch (e) { failed = true; throw e; }
      finally { pending = false; commitController = null; finish(); pendingDone = null; }

    },
    close() {
      if (!closed) {
        closed = true; commitController?.abort(Error('derived journal closed'));
        if (pendingDone) return pendingDone.then(unlock);
        unlock();
      }
    },
  };
}
