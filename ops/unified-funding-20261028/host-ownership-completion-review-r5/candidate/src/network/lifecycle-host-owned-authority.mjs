// ownership r3 + async r4 + completion r5 (SOURCE ONLY): the PROPOSED composition entry for the 'independent-host-registry-r1' profile.
// Intended location: network/lifecycle-host-owned-authority.mjs, beside the GENERATED dispatch/gate/runtime/witness. It builds the new
// profile's host side ONLY over exclusive owner handles:
//   - mandatory parent ownership: `journalFile` (the actual lifecycle journal) is flock-acquired FIRST and held until both
//     sidecar owners released successfully, so composition, cold recovery and any other parent owner exclude each other;
//   - the dispatch incarnation sidecar: openLockedHostIncarnationJournal(ownedJournal, file, { hostId }) (owner-guarded forwarded writes);
//   - the gate's permit sidecar: openLockedHostAuthorityJournal(file, { ownedJournal, hostId });
//   - v2 pins are mandatory (no v1 fallback) and the runtime must report hostAuthorityPermit === true.
// COLD RESTART (completion r5): both locked opens perform owned BOOT VERIFICATION (owned-durable-state: fsync now + provenance). If either
// sidecar is still uncertain (no matching acknowledgement, or an in-process/durable `unproven` acknowledgement), composition REFUSES and
// releases everything; the operator runs recoverOwnedHostSidecars() (explicit, under the same locks, classification against the exact
// retained intent - never synthesized) and then composes again; serving resumes only through the dispatch's fresh authenticated checks.
// release(reason) -> ONE promise, PUBLISHED BEFORE any callback (re-entrant calls get it), resolving { released, fenced, permit, incarnation }:
//   synchronously both owner handles refuse, the gate closes, the dispatch cadence stops; both flocks then wait for ONE combined withdrawal
//   (also published before callbacks) = gate.close()'s completion: tracked serving resources (generated revokeInstance), STAGED compute
//   (removal + confirmed absence), every in-flight start/serve operation (including an acknowledged fence of a late allow), and every
//   previously FAILED withdrawal (recorded for the gate's lifetime). Any failure, or exceeding withdrawDeadlineMs, keeps BOTH sidecar locks
//   (and the parent lock) held. Lock loss of either sidecar starts the same withdrawal and the release of the other owner.
// The owned lifecycle journal (pending/mined payloads, owner floor) is never modified by release or recovery; authenticated Stop and the
// scoped read-only/mined reconciliation methods stay available after authority loss.
import { openLockedHostIncarnationJournal } from './lifecycle-host-incarnation-journal.mjs';
import { openLockedHostAuthorityJournal } from './deployment-host-authority-journal.mjs';
import { openOwnedLock, assertOwnedLock } from './owned-durable-state.mjs';
import { DeploymentPermitGate } from './deployment-permit-gate.mjs';
import { DeploymentLifecycleWitness } from './deployment-lifecycle-witness.mjs';
import { createIsolationLifecycleRuntime } from './deployment-isolation-runtime.mjs';
import { composeIndependentLifecycle } from './lifecycle-host-authority.mjs';
import { isHostAuthorityPermit, HOST_AUTHORITY_PROFILE } from './deployment-host-authority.mjs';

import path from 'node:path';
import { openLifecycleJournal } from './deployment-lifecycle-journal.mjs';

const ID = /^0x[0-9a-f]{64}$/;

/** Open the actual parent journal only AFTER acquiring its exclusive lock. No caller-cached state is accepted. */
export async function openOwnedLifecycleJournal(file, options = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('absolute owned lifecycle journalFile required');
  const owner = await openOwnedLock(file, options);
  let released = false, lost = false;
  const listeners = [];
  const reads = new Set(['read', 'readAnchor', 'readHostAuthority', 'decision']);
  try {
    const state = openLifecycleJournal(file);
    const check = () => {
      try { assertOwnedLock(owner); }
      catch (e) {
        if (!lost) { lost = true; for (const fn of listeners) { try { Promise.resolve(fn(e.message)).catch(() => {}); } catch {} } }
        throw e;
      }
    };
    const journal = Object.fromEntries(Object.entries(state).filter(([, f]) => typeof f === 'function').map(([k, f]) => [k, (...args) => {
      if (reads.has(k)) return (released || lost ? openLifecycleJournal(file)[k] : f)(...args);
      check(); return f(...args);
    }]));
    return Object.freeze({ journal: Object.freeze(journal), onLoss(fn) { listeners.push(fn); },
      release() { if (released) return; owner.release(); released = true; } });
  } catch (e) { owner.release(); throw e; }
}

/** Acquire actual parent + both sidecars, in that order. Different sidecar paths cannot bypass parent exclusion. */
async function acquireOwners({ hostId, journalFile, incarnationFile, permitFile, flockPath, timeoutMs, withdrawDeadlineMs }) {
  const lock = { flockPath, timeoutMs, withdrawDeadlineMs };
  const parent = await openOwnedLifecycleJournal(journalFile, { flockPath, timeoutMs });
  const ownedJournal = parent.journal;
  let inc = null;
  try {
    inc = await openLockedHostIncarnationJournal(ownedJournal, incarnationFile, { hostId, ...lock });
    const perm = await openLockedHostAuthorityJournal(permitFile, { ownedJournal, hostId, ...lock });
    return { parent, inc, perm };
  } catch (e) {
    if (inc) { const r = await inc.release('acquisition failed'); if (!r.released) throw Error(`${e.message}; incarnation owner stays fenced`); }
    parent.release(); throw e;
  }
}
/** release both sidecar owners (memoized each), then the parent lock ONLY if both released */
async function releaseOwners({ parent, inc, perm }, reason) {
  const [permit, incarnation] = await Promise.all([perm.release(reason), inc.release(reason)]);
  const ok = permit.released && incarnation.released;
  if (ok) { try { parent.release(); } catch (error) { return Object.freeze({ released: false, fenced: true, permit, incarnation, error }); } }
  return Object.freeze({ released: ok, fenced: !ok, permit, incarnation });
}
const sidecarUncertain = ({ inc, perm }) => inc.journal.hostIncarnationFailed() ?? perm.journal.failed();

/**
 * -> { dispatch, hostId, independence, gaps, missing, gate, runtime, journal, hostAuthority, verification, release(reason) -> Promise }
 * journalFile: absolute actual parent path, opened under the acquired flock; caller-cached journals are refused.
 * client/plans/readiness/boundaries: the host's manager + enforcement adapters (production enforcement is an external dependency).
 */
export async function openOwnedHostRegistryLifecycle({ hostId, journalFile, ownedJournal, incarnationFile, permitFile, parentLockFile, pins, adapter, adapterPins,
  client, plans, readiness, boundaries, collectPermit, routes, platformWallets, capacityHeadroom, verifyQuiescence, now = Date.now, intervalMs, flockPath,
  timeoutMs, withdrawDeadlineMs = null } = {}) {
  if (!ID.test(hostId || '') || adapterPins?.host !== hostId) throw Error('exact host id (matching the adapter pins) required');
  if (adapterPins?.profile !== HOST_AUTHORITY_PROFILE) throw Error('openOwnedHostRegistryLifecycle composes only independent-host-registry-r1');
  if (!isHostAuthorityPermit(pins)) throw Error('independent-host-registry-r1 requires pins.servingPermit v2');
  if (ownedJournal !== undefined || parentLockFile !== undefined) throw Error('pass journalFile, not an already opened owned lifecycle journal or separate parent lock');
  const owners = await acquireOwners({ hostId, journalFile, incarnationFile, permitFile, flockPath, timeoutMs, withdrawDeadlineMs });
  const { inc, perm } = owners;
  const uncertain = sidecarUncertain(owners);
  if (uncertain) {
    const r = await releaseOwners(owners, 'composition refused: sidecar uncertain');
    throw Error(`owned host sidecar persistence uncertain (${uncertain}): run recoverOwnedHostSidecars before serving` + (r.released ? '' : '; owners stay fenced'));
  }
  try {
    const gate = new DeploymentPermitGate({ pins, journal: inc.journal, now, hostAuthority: perm.journal });
    const runtime = createIsolationLifecycleRuntime({ client, gate, journal: inc.journal, plans, readiness, collectPermit, boundaries, host: hostId, now });
    if (runtime.hostAuthorityPermit !== true) throw Error('independent-host-registry-r1 requires the v2 host-authority permit runtime');
    const c = composeIndependentLifecycle({ adapter, adapterPins, runtime, journal: inc.journal, inventory: { findByName: id => client.findByName(id) },
      routes, platformWallets, capacityHeadroom, verifyQuiescence, now, ...(intervalMs ? { intervalMs } : {}) });
    let combined = null, released = null;
    const withdrawAll = reason => {
      if (combined) return combined;
      let settle;
      combined = new Promise((resolve, reject) => { settle = { resolve, reject }; });   // published BEFORE any callback below
      combined.catch(() => {});                                 // observed by both owners' completions; never unhandled
      try {
        c.dispatch.stop();                                      // no new cadence pass
        queueMicrotask(() => { perm.release(reason); inc.release(reason); });   // lock loss of one owner releases the other too (memoized)
        gate.close(`host authority owner: ${reason}`).then(() => settle.resolve(true), settle.reject);   // every withdrawal, incl. recorded failures
      } catch (e) { settle.reject(e); }
      return combined;
    };
    owners.parent.onLoss(withdrawAll);
    perm.journal.onRelease(withdrawAll);                        // BOTH flocks wait for the SAME combined withdrawal
    inc.journal.onHostIncarnationRelease(withdrawAll);
    return { ...c, gate, runtime, journal: inc.journal, hostAuthority: perm.journal,
      verification: Object.freeze({ owners: [inc.journal.hostIncarnationOwned, perm.journal.hostAuthorityOwned] }),
      release(reason = 'owner released') {
        if (released) return released;
        let settle;
        released = new Promise(resolve => { settle = resolve; });   // published BEFORE any callback
        releaseOwners(owners, reason).then(settle, error => settle(Object.freeze({ released: false, fenced: true, error })));
        return released;
      } };
  } catch (e) { await releaseOwners(owners, 'composition failed'); throw e; }
}

/**
 * completion r5 EXPLICIT COLD RECOVERY ENTRY. Under the parent lock and BOTH sidecar flocks, each uncertain sidecar is recovered by
 * its current owner (owned-durable-state recover(): exact retained intent, exact before/after hash, fsync, provenance, retractable
 * acknowledgement); a missing/malformed intent or unclassifiable bytes REFUSE. Clean sidecars report 'clean'. The locks are then released
 * (successfully only if nothing was registered against them). -> { incarnation, permit, released }
 */
export async function recoverOwnedHostSidecars({ hostId, journalFile, ownedJournal, incarnationFile, permitFile, parentLockFile, flockPath, timeoutMs } = {}) {
  if (!ID.test(hostId || '')) throw Error('exact host id required');
  if (ownedJournal !== undefined || parentLockFile !== undefined) throw Error('pass journalFile, not an already opened owned lifecycle journal or separate parent lock');
  const owners = await acquireOwners({ hostId, journalFile, incarnationFile, permitFile, flockPath, timeoutMs });
  const outcome = {};
  try {
    outcome.incarnation = owners.inc.journal.recoverHostIncarnation();
    outcome.permit = owners.perm.journal.recover();
  } catch (e) {
    const r = await releaseOwners(owners, 'recovery refused');
    throw Error(`owned host sidecar recovery refused: ${e.message}` + (r.released ? '' : '; owners stay fenced'));
  }
  const r = await releaseOwners(owners, 'recovery complete');
  return Object.freeze({ ...outcome, released: r.released });
}

/** A v2 witness over its own exclusive permit-sidecar owner. release() closes the witness (aborting AND awaiting in-flight signing). */
export async function openOwnedHostAuthorityWitness({ sidecarFile, pins, account, journal, authority, health, now = Date.now, requestTimeoutMs, flockPath, timeoutMs } = {}) {
  if (!isHostAuthorityPermit(pins)) throw Error('a host-authority witness requires pins.servingPermit v2');
  const own = await openLockedHostAuthorityJournal(sidecarFile, { flockPath, timeoutMs });
  try {
    const witness = new DeploymentLifecycleWitness({ pins, account, journal, authority, health, now, hostAuthorityJournal: own.journal, ...(requestTimeoutMs ? { requestTimeoutMs } : {}) });
    return { witness, hostAuthority: own.journal, release: reason => own.release(reason) };
  } catch (e) { own.release('witness construction failed'); throw e; }
}
