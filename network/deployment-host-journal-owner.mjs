import { ownLifecycleJournal } from './deployment-journal-owner.mjs';
import { openLockedHostIncarnationJournal } from './lifecycle-host-incarnation-journal.mjs';
import { openLockedHostAuthorityJournal } from './deployment-host-authority-journal.mjs';

/** Linux ownership for parent intent state and the two host authority sidecars.
 * This returns storage capabilities, not permission to serve. Consumers must
 * authenticate current host authority and register actual boundary withdrawal
 * before publishing service. No chain intent is settled by closing/recovery.
 */
async function acquire(file, { hostId, initialize = false,
  importSha256 = null, withdrawDeadlineMs = 5000, ...lockOptions } = {}, recovery = false) {
  if (process.platform !== 'linux') throw Error('host journal composition requires qualified Linux ownership');
  if (!/^0x[0-9a-f]{64}$/.test(hostId ?? '')) throw Error('exact host id required');
  const parent = await ownLifecycleJournal(file, { initialize, importSha256, withdrawDeadlineMs, ...lockOptions });
  let incarnation, permit;
  try {
    const old = parent.journal.readHostAuthority(hostId);
    const established = old?.sidecarsEstablished === true || !!old?.floor;
    if (!old?.sidecarsEstablished) parent.journal.establishHostSidecars(hostId);
    // First-use status was captured under the parent lock BEFORE persisting its
    // marker. A subsequent process must treat missing sidecars as lost state.
    incarnation = await openLockedHostIncarnationJournal(parent.journal, file + '.host-incarnation',
      { ...lockOptions, established, withdrawDeadlineMs });
    permit = await openLockedHostAuthorityJournal(file + '.host-authority',
      { ...lockOptions, established, withdrawDeadlineMs });
    const failure = incarnation.journal.hostIncarnationFailed() ?? permit.journal.failed();
    if (failure && !recovery) throw Error('host sidecar persistence uncertain: ' + failure);
  } catch (error) {
    const closed = await Promise.all([incarnation?.release('composition refused'), permit?.release('composition refused')]);
    if (closed.some(r => r && !r.released)) throw Error('composition refused; sidecar owner remains fenced', { cause: error });
    await parent.close('composition refused');
    throw error;
  }
  return { parent, incarnation, permit };
}

export async function ownHostLifecycleJournals(file, options = {}) {
  const { parent, incarnation, permit } = await acquire(file, options);
  let withdrawal = null, closing = false;
  const callbacks = [];
  const withdraw = reason => {
    if (withdrawal) return withdrawal;
    closing = true;
    let resolve, reject;
    withdrawal = new Promise((a, b) => { resolve = a; reject = b; });
    withdrawal.catch(() => {});
    // Publish before callbacks, including callbacks which reenter close().
    Promise.all(callbacks.map(fn => { try { return Promise.resolve(fn(reason)); } catch (e) { return Promise.reject(e); } }))
      .then(() => resolve(true), reject);
    return withdrawal;
  };
  const sidecarLoss = reason => {
    const done = withdraw(reason);
    // Do not join parent.close here: it waits for these exact sidecar owners.
    queueMicrotask(() => { parent.close(reason); });
    return done;
  };
  incarnation.journal.onHostIncarnationRelease(sidecarLoss);
  permit.journal.onRelease(sidecarLoss);
  parent.onRelease(async reason => {
    const done = withdraw(reason);
    const releases = [incarnation.release(reason), permit.release(reason)];
    await done;
    const results = await Promise.all(releases);
    if (results.some(r => !r.released)) throw Error('host sidecar withdrawal unconfirmed; parent remains owned');
  });
  const guarded = source => Object.freeze(Object.fromEntries(Object.entries(source).map(([key, value]) =>
    [key, typeof value !== 'function' ? value : (...args) => {
      try { return value(...args); }
      catch (error) {
        if (incarnation.journal.hostIncarnationFailed() || permit.journal.failed())
          parent.close('host sidecar durability lost');
        throw error;
      }
    }])));
  return Object.freeze({ journal: guarded(incarnation.journal), hostAuthority: guarded(permit.journal),
    onRelease(fn) {
      if (closing || typeof fn !== 'function') throw Error('live host journal owner and withdrawal callback required');
      callbacks.push(fn);
    },
    close: reason => parent.close(reason),
    verification: () => parent.verification(),
  });
}

/** Classify retained sidecar intents under all three current locks. A failed
 * parent must first use recoverLifecycleJournal. No serving or settlement is
 * implied; successful recovery requires a fresh normal open and authority read.
 */
export async function recoverHostLifecycleJournals(file, options = {}) {
  const owners = await acquire(file, { ...options, initialize: false }, true);
  try {
    return Object.freeze({ incarnation: owners.incarnation.journal.recoverHostIncarnation(),
      permit: owners.permit.journal.recover(), servingAuthorized: false });
  } finally {
    const closed = await Promise.all([owners.incarnation.release('recovery ended'), owners.permit.release('recovery ended')]);
    if (closed.some(r => !r.released)) throw Error('sidecar recovery ended with ownership still fenced');
    const parent = await owners.parent.close('recovery ended');
    if (!parent.released) throw Error('parent recovery ownership still fenced');
  }
}
