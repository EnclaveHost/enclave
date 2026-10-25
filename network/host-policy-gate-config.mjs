// The platform host policy gate's OPERATOR configuration, shared by every host component that builds the gate from an
// explicit block rather than its process environment: the challenge replica (enclaveNetwork.challengeReplica.hostPolicy),
// the privacy agent's own host services (enclaveNetwork.hostServicesPolicy) and the Windows enrollment that writes them.
// Dependency-free (no npm import), so the Windows node's deploy closure can validate a block before it writes it.
//
// The block maps onto the integrated runner's configuration shape (network/host-services/runner.mjs policyEnv and
// policyCarrierFetch take it), so there is ONE implementation of the policy environment and of the carrier fetch. Carriers
// (network/policy-carriers.mjs) are untrusted transport for the administrator's signed policy DOCUMENT - an operator-imported
// directory, this host's own policy-mirror store, other hosts' policy mirrors - never authority: the unchanged gate still
// requires the digest the book anchors at a fresh agreed block, signed by the book's CURRENT owner, the sequence high-water
// and the bans.
import { resolveHostPolicyConfig } from './platform-host-policy-config.mjs';
import { rpcEndpoint } from './rpc-identity.mjs';

// The carrier set is shown to the gate as ONE reserved mirror origin (`.invalid` never resolves: without the carrier fetch it
// reaches nothing), answered locally by policy-carriers.mjs carrierFetch.
export const CARRIER_MIRROR = 'https://policy-carriers.invalid/platform-policy';
export const MAX_CARRIERS = 16;
export const CARRIER_BASE = /^https?:\/\/[A-Za-z0-9.-]{1,200}(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~-]{1,64}){0,8}$/;

/** -> the normalized carrier base URLs (http(s), no credentials, query or fragment). */
export function validateCarrierBases(list, what = 'policy carriers') {
  if (!Array.isArray(list) || list.length > MAX_CARRIERS) throw Error(`${what}: at most ${MAX_CARRIERS} base URLs`);
  const out = list.map((u) => String(u).replace(/\/+$/, ''));
  if (out.some((u) => !CARRIER_BASE.test(u)) || new Set(out).size !== out.length) throw Error(`${what}: distinct http(s) base URLs without credentials, query or fragment`);
  return out;
}

// The integrated runner's configuration shape for the SAME gate inputs: no second implementation of the policy env or the
// carrier fetch. h: a normalized { policy, mirrors[], rpcs|null, carriers|null }.
export function runnerPolicyShape(h) {
  const pc = h.carriers ? { ...(h.carriers.importDir ? { importDir: h.carriers.importDir } : {}), ...(h.carriers.peers ? { peers: h.carriers.peers } : {}) } : null;
  return { platformHostPolicy: h.policy, ...(h.mirrors.length ? { platformHostPolicyMirrors: h.mirrors } : {}), ...(h.rpcs ? { platformHostPolicyRpcs: h.rpcs } : {}),
    ...(pc && Object.keys(pc).length ? { platformHostPolicyCarriers: pc } : {}),
    services: h.carriers?.policyMirrorStateDir ? [{ role: 'policy-mirror', config: { stateDir: h.carriers.policyMirrorStateDir } }] : [] };
}
/** The gate's environment for a normalized block (with the reserved carrier origin when carriers are configured). */
export function hostPolicyGateEnv(h) {
  const shape = runnerPolicyShape(h);
  const env = { ENCLAVE_PLATFORM_HOST_POLICY: typeof h.policy === 'string' ? h.policy : JSON.stringify(h.policy) };
  const mirrors = [...h.mirrors, ...(h.carriers ? [CARRIER_MIRROR] : [])];
  if (mirrors.length) env.ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS = mirrors.join(',');
  if (h.rpcs) env.ENCLAVE_PLATFORM_HOST_POLICY_RPCS = h.rpcs.join(',');
  return { env, shape };
}

const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const absolute = (p) => typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\'));
/**
 * enclaveNetwork.hostServicesPolicy -> the normalized { policy, mirrors, rpcs, carriers } (throws on anything malformed).
 *   policy:   "production" | "off" | { book, hostOwnership, mirrors?, activation?, rpcs?, minAgree? }  (explicit, never defaulted)
 *   mirrors?: extra HTTPS mirror origins (at most 8)
 *   rpcs?:    the policy's own RPC quorum (2 to 8 distinct providers; http only on loopback)
 *   carriers?: { importDir?, policyMirrorStateDir?, peers? }  (absolute directories; peers: other hosts' policy mirrors)
 * The endpoint and state directory are the agent's own (its runner and state directory), never repeated here. A policy whose
 * quorum is unknown (an explicit book with no rpcs) is refused: neither the gate nor a carrier could read it.
 */
export function hostServicesPolicyConfig(c, where = 'enclaveNetwork.hostServicesPolicy') {
  const fail = (m) => { throw new Error(`${where}: ${m}`); };
  if (!isObj(c)) fail('must be an object');
  const extra = Object.keys(c).filter((k) => !['policy', 'mirrors', 'rpcs', 'carriers'].includes(k));
  if (extra.length) fail(`unknown field(s): ${extra.join(', ')}`);
  const policy = c.policy;
  if (!(policy === 'production' || policy === 'off' || isObj(policy))) fail('policy must be "production", "off" or an explicit {book, hostOwnership, mirrors, ...}');
  try { resolveHostPolicyConfig({ env: { ENCLAVE_PLATFORM_HOST_POLICY: typeof policy === 'string' ? policy : JSON.stringify(policy) }, chainId: 8453 }); }
  catch (e) { fail(`policy: ${e.message}`); }
  if (policy === 'off') {
    if (['mirrors', 'rpcs', 'carriers'].some((k) => c[k] !== undefined)) fail('"off" takes no mirrors, rpcs or carriers');
    return Object.freeze({ policy, mirrors: [], rpcs: null, carriers: null });
  }
  let mirrors = [], rpcs = null, carriers = null;
  if (c.mirrors !== undefined) {
    if (!Array.isArray(c.mirrors) || c.mirrors.length > 8) fail('mirrors must list at most 8 https origins');
    mirrors = c.mirrors.map((m, i) => { let u; try { u = new URL(m); } catch { fail(`mirrors[${i}] is not a URL`); }
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) fail(`mirrors[${i}] must be https without credentials`); return u.href.replace(/\/+$/, ''); });
  }
  if (c.rpcs !== undefined) {
    if (!Array.isArray(c.rpcs) || c.rpcs.length < 2 || c.rpcs.length > 8) fail('rpcs must name 2 to 8 RPCs');
    const seen = new Set();
    rpcs = c.rpcs.map((u, i) => { let id; try { id = rpcEndpoint(u).identity; } catch (e) { fail(`rpcs[${i}]: ${e.message}`); }
      if (seen.has(id)) fail('rpcs must name distinct providers (one provider cannot vote twice)'); seen.add(id); return String(u); });
  }
  if (c.carriers !== undefined) {
    if (!isObj(c.carriers)) fail('carriers must be an object');
    const k = c.carriers, unknown = Object.keys(k).filter((x) => !['importDir', 'policyMirrorStateDir', 'peers'].includes(x));
    if (unknown.length) fail(`carriers has unknown field(s): ${unknown.join(', ')}`);
    for (const d of ['importDir', 'policyMirrorStateDir']) if (k[d] !== undefined && !absolute(k[d])) fail(`carriers.${d} must be an absolute path`);
    let peers; if (k.peers !== undefined) { try { peers = validateCarrierBases(k.peers, `${where}.carriers.peers`); } catch (e) { throw new Error(e.message); } }
    carriers = { ...(k.importDir !== undefined ? { importDir: k.importDir } : {}), ...(k.policyMirrorStateDir !== undefined ? { policyMirrorStateDir: k.policyMirrorStateDir } : {}),
      ...(peers?.length ? { peers } : {}) };
    if (!Object.keys(carriers).length) fail('carriers names no carrier');
  }
  const h = { policy, mirrors, rpcs, carriers };
  let resolved; try { resolved = resolveHostPolicyConfig({ env: hostPolicyGateEnv(h).env, chainId: 8453 }); } catch (e) { fail(e.message); }
  if (!resolved.config?.rpcs?.length) fail('the policy\'s RPC quorum is unknown: name rpcs (or use "production")');
  return Object.freeze(h);
}
