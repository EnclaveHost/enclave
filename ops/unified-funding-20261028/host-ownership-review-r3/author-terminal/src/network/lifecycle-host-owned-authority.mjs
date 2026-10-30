// ownership r3 (SOURCE ONLY): the PROPOSED composition entry for the 'independent-host-registry-r1' profile. Intended location:
// network/lifecycle-host-owned-authority.mjs, beside the GENERATED dispatch/gate/runtime/witness. It is the only constructor in this delivery
// that builds the new profile's host side, and it does so ONLY over exclusive owner handles:
//   - the dispatch incarnation sidecar: openLockedHostIncarnationJournal(ownedJournal, file, { hostId }) - flock + coupling to the actual owned
//     lifecycle journal (its host-authority floor proves establishment; a lost sidecar/marker refuses; a fresh host is established at open);
//   - the gate's permit sidecar: openLockedHostAuthorityJournal(file, { ownedJournal, hostId }) - same rules;
//   - v2 pins are mandatory (isHostAuthorityPermit refuses the new profile without them: no v1 fallback), and the runtime must report
//     hostAuthorityPermit === true.
// release() withdraws authority BEFORE either flock is released: the permit owner's listener closes the gate (every installed grant and
// tracked resource dropped; install/assert/track/handoff through any retained reference refuse, so runtime start/serve/adopt refuse), the
// incarnation owner's listener stops the dispatch cadence, and every retained journal method refuses forever. A failed withdrawal keeps
// that owner's flock HELD (fenced) instead of letting a second owner in. The owned lifecycle journal (pending/mined payloads, owner floor)
// is never touched by release: read-only financial reconciliation continues under the next owner.
// Production chain reader, guestd/ingress/storage/secret enforcement and the witness service remain external (not provided here).
import { openLockedHostIncarnationJournal } from './lifecycle-host-incarnation-journal.mjs';
import { openLockedHostAuthorityJournal } from './deployment-host-authority-journal.mjs';
import { DeploymentPermitGate } from './deployment-permit-gate.mjs';
import { DeploymentLifecycleWitness } from './deployment-lifecycle-witness.mjs';
import { createIsolationLifecycleRuntime } from './deployment-isolation-runtime.mjs';
import { composeIndependentLifecycle } from './lifecycle-host-authority.mjs';
import { isHostAuthorityPermit, HOST_AUTHORITY_PROFILE } from './deployment-host-authority.mjs';

const ID = /^0x[0-9a-f]{64}$/;

/**
 * -> { dispatch, hostId, independence, gaps, missing, gate, runtime, journal, hostAuthority, release(reason) }
 * ownedJournal: the actual owned lifecycle journal (openLifecycleJournal of the generated owned journal); its single owner is this process.
 * client/plans/readiness/boundaries: the host's manager + enforcement adapters (production enforcement is an external dependency).
 */
export async function openOwnedHostRegistryLifecycle({ hostId, ownedJournal, incarnationFile, permitFile, pins, adapter, adapterPins, client, plans,
  readiness, boundaries, collectPermit, routes, platformWallets, capacityHeadroom, verifyQuiescence, now = Date.now, intervalMs, flockPath, timeoutMs } = {}) {
  if (!ID.test(hostId || '') || adapterPins?.host !== hostId) throw Error('exact host id (matching the adapter pins) required');
  if (adapterPins?.profile !== HOST_AUTHORITY_PROFILE) throw Error('openOwnedHostRegistryLifecycle composes only independent-host-registry-r1');
  if (!isHostAuthorityPermit(pins)) throw Error('independent-host-registry-r1 requires pins.servingPermit v2');
  if (typeof ownedJournal?.readHostAuthority !== 'function') throw Error('the actual owned lifecycle journal (with its host-authority section) is required');
  const lock = { flockPath, timeoutMs };
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
    inc.journal.onHostIncarnationRelease(() => c.dispatch.stop());
    let released = null;
    return { ...c, gate, runtime, journal: inc.journal, hostAuthority: perm.journal,
      release(reason = 'owner released') {
        if (released) return released;
        released = Object.freeze({ permit: perm.release(reason), incarnation: inc.release(reason) });
        return released;
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
