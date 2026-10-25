// The platform host policy gate (network/host-service-gate.mjs, unchanged) built from an explicit operator block
// (host-policy-gate-config.mjs), with the integrated runner's carrier fetch (host-services/runner.mjs policyCarrierFetch ->
// policy-carriers.mjs) when the block names carriers. Shared by the challenge replica and the privacy agent's host services.
//
// snapshot (optional): ONE agreed-block chain authority for both the gate and the carriers' fresh verification - the seam for
// a verified chain authority (e.g. a light-client verifier). When it is given, neither the gate nor any carrier builds its
// own raw RPC quorum, so a verifier mode can never fall back to raw RPC silently. Without it both use the policy's RPC
// quorum, exactly as before. A block whose chainAuthority is "verifier" (host-policy-gate-config.mjs) gets that ONE snapshot
// here - the local verifier's (host-policy-runtime.mjs hostPolicySnapshot) - unless the caller injected its own.
import path from 'node:path';
import { createHostServiceGate, resolveHostPolicyConfig } from './host-service-gate.mjs';
import { createHostPolicyRuntime, fileStore, hostPolicySnapshot } from './host-policy-runtime.mjs';
import { hostPolicyGateEnv } from './host-policy-gate-config.mjs';

/** h: a normalized block -> the gate { enabled, start(), stop(), check(), serviceRefusal(), status() }. */
export async function hostPolicyCarrierGate(h, { endpoint = null, hostId = null, stateDir = null, fetch = globalThis.fetch, log = () => {}, snapshot = null,
  intervalMs = null, graceMs = null } = {}) {
  const { env, shape } = hostPolicyGateEnv(h);
  if (!snapshot && h.chainAuthority === 'verifier') snapshot = hostPolicySnapshot({ chainAuthority: 'verifier', chainVerifier: h.chainVerifier });
  const gateFetch = h.carriers ? await (await import('./host-services/runner.mjs')).policyCarrierFetch(shape, { fetch, log, snapshot }) : fetch;
  let runtime = null;
  if (snapshot) {
    const resolved = resolveHostPolicyConfig({ env, chainId: 8453 });
    if (resolved.on) runtime = createHostPolicyRuntime(resolved, { snapshot, store: stateDir ? fileStore(path.join(stateDir, 'platform-host-policy.json')) : null, fetch: gateFetch, log });
  }
  return createHostServiceGate({ env, chainId: 8453, endpoint, hostId, stateDir, fetch: gateFetch, log, runtime,
    ...(intervalMs ? { intervalMs } : {}), ...(graceMs ? { graceMs } : {}) });
}
