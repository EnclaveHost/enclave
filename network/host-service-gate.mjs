// The SAME platform host policy gate for every host runtime (Linux supervisor.js, the Windows node host): this host checks
// ITS OWN registry id (keccak256 of its advertised endpoint) at agreed blocks and
//   - takes NO NEW WORK (claims, claim hints, new deployments) unless the policy admits it now (or is not activated);
//   - stops SERVICE (app traffic) and stops renewing leases on an explicit refusal (ban, allowlist miss, deregistration);
//     a refusal is sticky until a NEW authenticated admit (the admin's unban), and survives restarts;
//   - keeps serving through a TRANSIENT outage (RPC/mirror loss, node behind the anchor) for at most graceMs after the last
//     authenticated admit, and never before a first admit on a fresh host.
// Off (every check passes, status says why) only when the resolved configuration is off.
import { keccak256, toBytes } from "viem";
import { createHostPolicyRuntime, resolveHostPolicyConfig, fileStore } from "./host-policy-runtime.mjs";
export { resolveHostPolicyConfig } from "./host-policy-runtime.mjs";

export const hostIdOfEndpoint = (endpoint) => keccak256(toBytes(String(endpoint || "").replace(/\/+$/, ""))).toLowerCase();

/**
 * createHostServiceGate({ env, chainId, book, endpoint|hostId, stateDir?, intervalMs?, graceMs?, runtime?, log?, now? })
 * -> { enabled, hostId, start(), stop(), check(), newWorkRefusal(), serviceRefusal(), status() }
 */
export function createHostServiceGate({ env = process.env, chainId = null, book = null, endpoint = null, hostId = null, stateDir = null,
  intervalMs = null, graceMs = null, runtime = null, fetch = globalThis.fetch, log = console.log, now = () => Date.now() } = {}) {
  const resolved = runtime ? { on: true } : resolveHostPolicyConfig({ env, chainId, book });
  if (!resolved.on) {
    const off = { enabled: false, reason: resolved.reason };
    return { ...off, hostId: null, start() {}, stop() {}, async check() { return off; }, newWorkRefusal: () => null, serviceRefusal: () => null,
             status: () => ({ platformHostPolicy: "off", reason: resolved.reason }) };
  }
  const id = hostId ? String(hostId).toLowerCase() : endpoint ? hostIdOfEndpoint(endpoint) : null;
  if (!/^0x[0-9a-f]{64}$/.test(String(id))) throw Error("platform host policy: this host's advertised endpoint (PUBLIC_URL) is required to enforce it");
  const rt = runtime || createHostPolicyRuntime(resolved, { store: stateDir ? fileStore(`${stateDir}/platform-host-policy.json`) : null, fetch, log });
  const every = Number(intervalMs ?? env.ENCLAVE_PLATFORM_HOST_POLICY_INTERVAL_SEC * 1000) || 60_000;
  const grace = Number(graceMs ?? env.ENCLAVE_PLATFORM_HOST_POLICY_GRACE_SEC * 1000) || 15 * 60_000;
  const gate = rt.measured(id, { graceMs: grace, now, persist: stateDir ? fileStore(`${stateDir}/platform-host-admission.json`) : null,
    onChange: (s) => log(`[host-policy] this host ${s.serving ? "is ADMITTED: serving and taking work" : `is NOT serving: ${s.reason}`}`) });
  let timer = null, checking = null;
  const check = () => (checking ||= gate.check().finally(() => { checking = null; }));
  const refusal = () => { const s = gate.state(); return s.serving ? null : `platform host policy: ${s.reason}`; };
  return {
    enabled: true, hostId: id, runtime: rt, check,
    start() { if (!timer) { check().catch(() => {}); timer = setInterval(() => check().catch(() => {}), every); timer.unref?.(); } },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    // new claims / hints / deployments: only while admitted (or not activated) now
    newWorkRefusal: refusal,
    // app traffic and lease renewal: refused on explicit refusal, and after the grace without an authenticated admit
    serviceRefusal: refusal,
    status: () => ({ platformHostPolicy: "on", hostId: id, ...gate.state(), runtime: rt.status() }),
  };
}
