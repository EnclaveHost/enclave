// The SAME platform host policy gate for every host runtime (Linux supervisor.js, the Windows node host): this host checks
// ITS OWN registry id (keccak256 of its advertised endpoint) at agreed blocks and
//   - takes NO NEW WORK (claims, claim hints, new deployments) unless the policy admits it now (or is not activated);
//   - stops SERVICE (app traffic) and stops renewing leases on an explicit refusal (ban, allowlist miss, deregistration);
//     a refusal is sticky until a NEW authenticated admit (the admin's unban), and survives restarts;
//   - keeps serving through a TRANSIENT outage (RPC/mirror loss, node behind the anchor) for at most graceMs after the last
//     authenticated admit, and never before a first admit on a fresh host.
// Off (every check passes, status says why) only when the resolved configuration is off.
//
// POLICY CARRIERS for the host runtimes (ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS): supervisor.js and windows/node/host.mjs build
// this gate from process.env with no fetch of their own, so without a carrier an ANCHORED policy can only come from a mirror
// - and the production bundles carry none (the fleet's DigitalOcean mirrors are not used). The SAME carriers as the hosted
// runner (network/host-services/runner.mjs policyCarrierFetch) and the challenge replica, configured by ONE JSON value:
//   { "importDir"?: <abs dir of <digest>.json the operator imported>, "policyMirrorStateDir"?: <abs dir of a policy-mirror
//     role's state>, "peers"?: ["http(s)://<host>/platform-policy", ...], "serviceIndex"?: { chainId, address, codeHash } }
// They are untrusted transport (network/policy-carriers.mjs): each candidate is checked against FRESH authoritative state
// (freshVerifier: its exact digest, signed by the book's CURRENT owner at a fresh agreed block of THIS gate's own RPC quorum,
// the same snapshot object the gate reads through), then verified again, independently, by the unchanged gate (anchored
// digest, sequence high-water, expiry/staleness, bans). They are shown to the gate as the reserved mirror CARRIER_MIRROR.
// Unset: this file behaves exactly as before. A caller that passes its own fetch (the runner, the challenge replica) keeps
// it; combining that with this setting is refused (ambiguous transport), never silently merged.
import path from "node:path";
import { keccak256, toBytes } from "viem";
import { createHostPolicyRuntime, resolveHostPolicyConfig, fileStore, quorumSnapshot } from "./host-policy-runtime.mjs";
import { CARRIER_MIRROR, validateCarrierBases, fileCarrier, httpCarriers, indexCarriers, freshVerifier, carrierFetch } from "./policy-carriers.mjs";
import { validateIndexPin } from "./service-index.mjs";
export { resolveHostPolicyConfig } from "./host-policy-runtime.mjs";

export const hostIdOfEndpoint = (endpoint) => keccak256(toBytes(String(endpoint || "").replace(/\/+$/, ""))).toLowerCase();

/** ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS -> null (unset) or the validated carrier settings; a malformed value throws. */
export function hostPolicyCarriersFromEnv(env = process.env) {
  const raw = String(env.ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS ?? "").trim();
  if (!raw) return null;
  let c; try { c = JSON.parse(raw); } catch { throw Error("ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: JSON { importDir?, policyMirrorStateDir?, peers?, serviceIndex? }"); }
  if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some((k) => !["importDir", "policyMirrorStateDir", "peers", "serviceIndex"].includes(k)))
    throw Error("ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: JSON { importDir?, policyMirrorStateDir?, peers?, serviceIndex? }");
  for (const k of ["importDir", "policyMirrorStateDir"]) if (c[k] !== undefined && (typeof c[k] !== "string" || !path.isAbsolute(c[k]))) throw Error(`ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS.${k} must be an absolute path`);
  const out = { importDir: c.importDir ?? null, policyMirrorStateDir: c.policyMirrorStateDir ?? null,
    peers: validateCarrierBases(c.peers ?? [], "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS.peers"), serviceIndex: c.serviceIndex === undefined ? null : validateIndexPin(c.serviceIndex) };
  if (!out.importDir && !out.policyMirrorStateDir && !out.peers.length && !out.serviceIndex) throw Error("ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS names no carrier");
  return Object.freeze(out);
}

/**
 * createHostServiceGate({ env, chainId, book, endpoint|hostId, stateDir?, intervalMs?, graceMs?, runtime?, fetch?, log?, now? })
 * -> { enabled, hostId, start(), stop(), check(), newWorkRefusal(), serviceRefusal(), status() }
 */
export function createHostServiceGate({ env = process.env, chainId = null, book = null, endpoint = null, hostId = null, stateDir = null,
  intervalMs = null, graceMs = null, runtime = null, fetch = undefined, log = console.log, now = () => Date.now() } = {}) {
  const carriers = runtime ? null : hostPolicyCarriersFromEnv(env);
  if (carriers && fetch !== undefined) throw Error("platform host policy: ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS together with a caller's own fetch (one transport only)");
  // the carrier set is ONE more mirror origin for the gate (as the runner's policyEnv does); never a fleet mirror
  const gateEnv = carriers ? { ...env, ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS: [...String(env.ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS || "").split(",").map((s) => s.trim()).filter(Boolean), CARRIER_MIRROR].join(",") } : env;
  const resolved = runtime ? { on: true } : resolveHostPolicyConfig({ env: gateEnv, chainId, book });
  if (!resolved.on) {
    if (carriers) throw Error("ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS is set but the platform host policy is off: nothing would use them");
    const off = { enabled: false, reason: resolved.reason };
    return { ...off, hostId: null, start() {}, stop() {}, async check() { return off; }, newWorkRefusal: () => null, serviceRefusal: () => null,
             status: () => ({ platformHostPolicy: "off", reason: resolved.reason }) };
  }
  const id = hostId ? String(hostId).toLowerCase() : endpoint ? hostIdOfEndpoint(endpoint) : null;
  if (!/^0x[0-9a-f]{64}$/.test(String(id))) throw Error("platform host policy: this host's advertised endpoint (PUBLIC_URL) is required to enforce it");
  let rt = runtime, carrierSummary = null;
  if (!rt && carriers) {
    const c = resolved.config;
    if (!c.rpcs || !c.rpcs.length) throw Error("platform host policy carriers need the policy's own RPC quorum");
    // ONE agreed-block reader for the gate AND the carriers' fresh verification (no second client set, no lowered quorum)
    const snapshot = quorumSnapshot({ rpcs: c.rpcs, minAgree: c.minAgree ?? null });
    const net = globalThis.fetch;
    const sources = [
      ...(carriers.importDir ? [fileCarrier(carriers.importDir)] : []),
      ...(carriers.policyMirrorStateDir ? [fileCarrier(path.join(carriers.policyMirrorStateDir, "documents"))] : []),
      ...httpCarriers(carriers.peers, { fetch: net }),
      ...(carriers.serviceIndex ? [indexCarriers({ pin: carriers.serviceIndex, peers: c.rpcs, fetch: net, log })] : []),
    ];
    const verify = freshVerifier({ snapshot, book: c.book, hostOwnership: c.hostOwnership });
    const cf = carrierFetch({ carriers: sources, verify, fetch: net, log });
    carrierSummary = { importDir: !!carriers.importDir, policyMirrorStateDir: !!carriers.policyMirrorStateDir, peers: carriers.peers.length, serviceIndex: !!carriers.serviceIndex };
    rt = createHostPolicyRuntime(resolved, { snapshot, store: stateDir ? fileStore(`${stateDir}/platform-host-policy.json`) : null, fetch: cf, log });
    log(`[host-policy] policy carriers: ${Object.entries(carrierSummary).filter(([, v]) => v).map(([k, v]) => (v === true ? k : `${k} ${v}`)).join(", ")} (verified at the gate's own quorum)`);
  }
  rt ||= createHostPolicyRuntime(resolved, { store: stateDir ? fileStore(`${stateDir}/platform-host-policy.json`) : null, fetch: fetch ?? globalThis.fetch, log });
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
    status: () => ({ platformHostPolicy: "on", hostId: id, ...gate.state(), runtime: rt.status(), ...(carrierSummary ? { carriers: carrierSummary } : {}) }),
  };
}
