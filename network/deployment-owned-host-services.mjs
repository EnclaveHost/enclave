import { ownHostLifecycleJournals } from './deployment-host-journal-owner.mjs';
import { isHostAuthorityPermit } from './deployment-host-authority.mjs';
import { DeploymentPermitGate } from './deployment-permit-gate.mjs';
import { DeploymentLifecycleWitness } from './deployment-lifecycle-witness.mjs';
import { createIsolationLifecycleRuntime } from './deployment-isolation-runtime.mjs';

function requireProfile(pins) {
  if (!isHostAuthorityPermit(pins)) throw Error('owned host services require explicit v2 host authority permits');
}

/** Opt-in composition. The supplied adapters must authenticate authority and
 * enforce real resource withdrawal. This neither starts work nor changes the
 * production dispatcher. Runtime and witness use separate journal paths.
 */
export async function ownHostLifecycleRuntime(file, { pins, host, ownerOptions = {},
  now = Date.now, monotonic, timers, onError, ...adapters } = {}) {
  requireProfile(pins);
  const owner = await ownHostLifecycleJournals(file, { ...ownerOptions, hostId: host });
  try {
    const gate = new DeploymentPermitGate({ pins, journal: owner.journal,
      hostAuthority: owner.hostAuthority, now, monotonic, timers, onError });
    // Closing a parent invalidates its journal immediately. Gate withdrawal
    // uses captured resource identities and never writes through that journal.
    owner.onRelease(reason => gate.close(reason));
    const runtime = createIsolationLifecycleRuntime({ ...adapters, host, now, gate, journal: owner.journal });
    return Object.freeze({ runtime, gate, journal: owner.journal,
      close: owner.close, verification: owner.verification });
  } catch (error) { await owner.close('runtime construction refused'); throw error; }
}

export async function ownHostLifecycleWitness(file, { pins, host, ownerOptions = {}, ...adapters } = {}) {
  requireProfile(pins);
  const owner = await ownHostLifecycleJournals(file, { ...ownerOptions, hostId: host });
  try {
    const witness = new DeploymentLifecycleWitness({ ...adapters, pins, journal: owner.journal,
      hostAuthorityJournal: owner.hostAuthority });
    owner.onRelease(() => witness.close());
    return Object.freeze({ witness, journal: owner.journal,
      close: owner.close, verification: owner.verification });
  } catch (error) { await owner.close('witness construction refused'); throw error; }
}
