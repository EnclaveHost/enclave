import { ownHostLifecycleRuntime } from './deployment-owned-host-services.mjs';
import { composeIndependentLifecycle } from './lifecycle-host-authority.mjs';
import { HOST_REGISTRY_PROFILE, hostRegistryPinRefusals } from './lifecycle-host-profile.mjs';

/** Maintained Linux composition. Does not activate routes, schedule passes,
 * register a host or submit funds. All adapter reads and handoff proofs must
 * come from qualified authenticated implementations supplied by the caller.
 */
export async function ownIndependentLifecycleDispatch(file, {
  adapter, adapterPins, hostView, runtime: runtimeOptions, ownerOptions = {},
  routes, platformWallets, capacityHeadroom, verifyQuiescence, now = Date.now, intervalMs,
} = {}) {
  if (adapterPins?.profile !== HOST_REGISTRY_PROFILE || hostRegistryPinRefusals(adapterPins).length)
    throw Error('owned dispatch requires the exact independent host registry profile and pins');
  if (hostView?.hostId !== adapterPins.host) throw Error('host callbacks must bind the pinned host');
  const pins = { chainId: adapterPins.chainId, lifecycle: adapterPins.contracts?.lifecycle?.address,
    servingPermit: { version: 2, profile: HOST_REGISTRY_PROFILE } };
  const service = await ownHostLifecycleRuntime(file, { ...runtimeOptions, pins, host: adapterPins.host, ownerOptions, now });
  try {
    const composed = composeIndependentLifecycle({ adapter, adapterPins, runtime: service.runtime,
      journal: service.journal, inventory: runtimeOptions.client, routes, platformWallets,
      capacityHeadroom, verifyQuiescence, now, intervalMs });
    // Registered before attachment can publish anything. Parent close waits
    // for both the driver's real in-flight effects and the gate's withdrawals.
    service.onRelease(() => composed.dispatch.close());
    composed.dispatch.attach(hostView);
    return Object.freeze({ ...composed, runtime: service.runtime, gate: service.gate,
      journal: service.journal, close: service.close, verification: service.verification });
  } catch (error) { await service.close('dispatch construction refused'); throw error; }
}
