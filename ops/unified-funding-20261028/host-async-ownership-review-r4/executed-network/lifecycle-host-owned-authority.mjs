// ownership r3 + async r4 (SOURCE ONLY): the PROPOSED composition entry for the 'independent-host-registry-r1' profile. Intended location:
// network/lifecycle-host-owned-authority.mjs, beside the GENERATED dispatch/gate/runtime/witness. It is the only constructor in this delivery
// that builds the new profile's host side, and it does so ONLY over exclusive owner handles:
//   - the dispatch incarnation sidecar: openLockedHostIncarnationJournal(ownedJournal, file, { hostId }) - flock + coupling to the actual owned
//     lifecycle journal; forwarded owned-journal methods are guarded by this owner's liveness (scoped safe reconciliation excepted);
//   - the gate's permit sidecar: openLockedHostAuthorityJournal(file, { ownedJournal, hostId }) - same rules;
//   - v2 pins are mandatory (no v1 fallback) and the runtime must report hostAuthorityPermit === true.
// async r4 release(reason) -> ONE memoized promise of { released, fenced, permit, incarnation }:
//   SYNCHRONOUSLY both owner handles refuse, the gate closes (assert/install/track/handoff/work refuse) and the dispatch cadence stops;
//   then BOTH flocks wait for ONE combined withdrawal = gate.close()'s completion (every tracked resource callback - the generated runtime's
//   revokeInstance - and every in-flight runtime start, including removal of an instance whose spawn was initiated before close). If that
//   combined withdrawal fails (or exceeds withdrawDeadlineMs), BOTH locks stay held (fenced); nothing is released by a timeout.
//   Lock loss of either sidecar starts the same combined withdrawal and the release of the other owner.
// The owned lifecycle journal (pending/mined payloads, owner floor) is never modified by release: authenticated Stop and read-only financial
// reconciliation remain available through the scoped safe methods. Production chain reader, guestd/ingress/storage/secret enforcement and
// the witness service remain external (not provided here).
import { openLockedHostIncarnationJournal } from './lifecycle-host-incarnation-journal.mjs';
import { openLockedHostAuthorityJournal } from './deployment-host-authority-journal.mjs';
import { DeploymentPermitGate } from './deployment-permit-gate.mjs';
import { DeploymentLifecycleWitness } from './deployment-lifecycle-witness.mjs';
import { createIsolationLifecycleRuntime } from './deployment-isolation-runtime.mjs';
import { composeIndependentLifecycle } from './lifecycle-host-authority.mjs';
import { isHostAuthorityPermit, HOST_AUTHORITY_PROFILE } from './deployment-host-authority.mjs';

const ID = /^0x[0-9a-f]{64}$/;

/**
 * -> { dispatch, hostId, independence, gaps, missing, gate, runtime, journal, hostAuthority, release(reason) -> Promise }
 * ownedJournal: the actual owned lifecycle journal (openLifecycleJournal of the generated owned journal); its single owner is this process.
 * client/plans/readiness/boundaries: the host's manager + enforcement adapters (production enforcement is an external dependency).
 */
export async function openOwnedHostRegistryLifecycle({ hostId, ownedJournal, incarnationFile, permitFile, pins, adapter, adapterPins, client, plans,
  readiness, boundaries, collectPermit, routes, platformWallets, capacityHeadroom, verifyQuiescence, now = Date.now, intervalMs, flockPath, timeoutMs,
  withdrawDeadlineMs = null } = {}) {
  if (!ID.test(hostId || '') || adapterPins?.host !== hostId) throw Error('exact host id (matching the adapter pins) required');
  if (adapterPins?.profile !== HOST_AUTHORITY_PROFILE) throw Error('openOwnedHostRegistryLifecycle composes only independent-host-registry-r1');
  if (!isHostAuthorityPermit(pins)) throw Error('independent-host-registry-r1 requires pins.servingPermit v2');
  if (typeof ownedJournal?.readHostAuthority !== 'function') throw Error('the actual owned lifecycle journal (with its host-authority section) is required');
  const lock = { flockPath, timeoutMs, withdrawDeadlineMs };
  const inc = await openLockedHostIncarnationJournal(ownedJournal, incarnationFile, { hostId, ...lock });
  let perm;
  try { perm = await openLockedHostAuthorityJournal(permitFile, { ownedJournal, hostId, ...lock }); }
  catch (e) { inc.release('composition failed'); throw e; }
  try {
    const gate = new DeploymentPermitGate({ pins, journal: inc.journal, now, hostAuthority: perm.journal });
    const runtime = createIsolationLifecycleRuntime({ client, gate, journal: inc.journal, plans, readiness, collectPermit, boundaries, host: hostId, now });
    if (runtime.hostAuthorityPermit !== true) throw Error('independent-host-registry-r1 requires the v2 host-authority permit runtime');
    const c = composeIndependentLifecycle({ adapter, adapterPins, runtime, journal: inc.journal, inventory: { findByName: id => client.findByName(id) },
      routes, platformWallets, capacityHeadroom, verifyQuiescence, now, ...(intervalMs ? { intervalMs } : {}) });
    let combined = null, released = null;
    const withdrawAll = reason => (combined ??= (async () => {
      c.dispatch.stop();                                        // no new cadence pass
      queueMicrotask(() => { perm.release(reason); inc.release(reason); });   // lock loss of one owner releases the other too (memoized)
      await gate.close(`host authority owner: ${reason}`);      // rejects unless EVERY resource/in-flight withdrawal settled successfully
      return true;
    })());
    perm.journal.onRelease(withdrawAll);                        // BOTH flocks wait for the SAME combined withdrawal
    inc.journal.onHostIncarnationRelease(withdrawAll);
    return { ...c, gate, runtime, journal: inc.journal, hostAuthority: perm.journal,
      release(reason = 'owner released') {
        return (released ??= Promise.all([perm.release(reason), inc.release(reason)]).then(([permit, incarnation]) => Object.freeze({
          released: permit.released && incarnation.released, fenced: permit.fenced || incarnation.fenced, permit, incarnation })));
      } };
  } catch (e) { perm.release('composition failed'); inc.release('composition failed'); throw e; }
}

/** A v2 witness over its own exclusive permit-sidecar owner. release() closes the witness (aborting in-flight signing) before the flock goes. */
export async function openOwnedHostAuthorityWitness({ sidecarFile, pins, account, journal, authority, health, now = Date.now, requestTimeoutMs, flockPath, timeoutMs } = {}) {
  if (!isHostAuthorityPermit(pins)) throw Error('a host-authority witness requires pins.servingPermit v2');
  const own = await openLockedHostAuthorityJournal(sidecarFile, { flockPath, timeoutMs });
  try {
    const witness = new DeploymentLifecycleWitness({ pins, account, journal, authority, health, now, hostAuthorityJournal: own.journal, ...(requestTimeoutMs ? { requestTimeoutMs } : {}) });
    return { witness, hostAuthority: own.journal, release: reason => own.release(reason) };
  } catch (e) { own.release('witness construction failed'); throw e; }
}
