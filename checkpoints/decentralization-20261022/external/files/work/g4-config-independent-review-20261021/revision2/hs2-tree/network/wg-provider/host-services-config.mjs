// A provider's hostServices block (work/host-service-transport-20261021): which registered hosts' own public service
// roles this transport carries, as raw packets (provider.mjs service, dnsTarget; kernel.mjs dns).
//   hostServices: { zone, platformHostPolicy: "production" | {book, hostOwnership, mirrors[], ...} | "off",
//                   platformHostPolicyMirrors?: [https], platformHostPolicyRpcs?: [url], maxHosts?,
//                   dns?: { hosts: [registry ids], staleMs?, perSourcePps?, perSourceBurst?, globalPps?, globalBurst?, tcpPerSource? },
//                   challenge?: true }   (also grant each carried host its attested challenge origin chal-<b32>.<zone>
//                                         (host-service-names.mjs hostChallengeName; work/challenge-host-tls-20261021);
//                                         absent/false = exactly the three role names, as before)
// "off" is a development option, written explicitly: the transport profile (scripts/check-transport-profile.mjs) refuses it.
// zone: the APP zone itself (the hosted route-dns answers the derived labels from its appStatic, network/host-services/
// stage-tool.mjs hostServicePublication) or a zone apart from both the app and the probe zone - never nested in either.
import { validServiceZone } from '../host-service-names.mjs';
import { dnsLimits, DNS_LIMITS } from './kernel.mjs';

const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const ID = /^0x[0-9a-f]{64}$/;
const fail = (m) => { throw new Error(`hostServices: ${m}`); };
const inside = (a, b) => a === b || a.endsWith('.' + b) || b.endsWith('.' + a);

/** -> null (absent) | { zone, platformHostPolicy, mirrors, rpcs, maxHosts, dns: null | { hosts, staleMs, limits } } */
export function providerHostServices(hs, { zone = 'app.enclave.host', probeZone = 'probe.enclave.host', roles = [] } = {}) {
  if (hs === undefined || hs === null) return null;
  if (!plain(hs)) fail('must be an object');
  const allowed = ['zone', 'platformHostPolicy', 'platformHostPolicyMirrors', 'platformHostPolicyRpcs', 'maxHosts', 'dns', 'challenge'];
  for (const k of Object.keys(hs)) if (!allowed.includes(k)) fail(`unknown field ${JSON.stringify(k)}`);
  try { validServiceZone(hs.zone); } catch (e) { fail(e.message.replace(/^hostServices\.?/, '')); }
  // the app zone itself is allowed (only the service SHAPE is reserved there); a zone nested in or above it, or touching the
  // probe zone, is not
  if (zone && hs.zone !== zone && inside(hs.zone, zone)) fail(`zone ${hs.zone} overlaps the app zone ${zone} (use the app zone itself or a separate zone)`);
  if (probeZone && inside(hs.zone, probeZone)) fail(`zone ${hs.zone} overlaps the probe zone ${probeZone}`);
  if (!roles.includes('ingress')) fail('a provider carries host services only with the ingress role');
  const p = hs.platformHostPolicy;
  if (p === undefined) fail('platformHostPolicy is required: "production", an explicit platform JSON, or "off" (explicit; not a production configuration)');
  if (!(p === 'production' || p === 'off' || plain(p))) fail('platformHostPolicy: "production" | "off" | { book, hostOwnership, mirrors[] }');
  const https = (list, what) => {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > 8 || list.some((u) => typeof u !== 'string' || !/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(u))) fail(`${what}: up to 8 https URLs`);
    return [...list];
  };
  const mirrors = https(hs.platformHostPolicyMirrors, 'platformHostPolicyMirrors'), rpcs = https(hs.platformHostPolicyRpcs, 'platformHostPolicyRpcs');
  if (p === 'off' && (mirrors.length || rpcs.length)) fail('platformHostPolicy "off" with mirrors or RPCs: nothing would use them');
  if (hs.maxHosts !== undefined && (!Number.isInteger(hs.maxHosts) || hs.maxHosts < 1 || hs.maxHosts > 256)) fail('maxHosts: 1 to 256');
  if (hs.challenge !== undefined && typeof hs.challenge !== 'boolean') fail('challenge: true or false');
  let dns = null;
  if (hs.dns !== undefined) {
    const d = hs.dns;
    if (!plain(d)) fail('dns must be an object');
    for (const k of Object.keys(d)) if (!['hosts', 'staleMs', ...Object.keys(DNS_LIMITS)].includes(k)) fail(`dns: unknown field ${JSON.stringify(k)}`);
    if (!Array.isArray(d.hosts) || d.hosts.length < 1 || d.hosts.length > 16 || d.hosts.some((h) => typeof h !== 'string' || !ID.test(h.toLowerCase()) || /^0x0{64}$/.test(h)))
      fail('dns.hosts: 1 to 16 registry ids (0x + 64 hex) the operator pins to answer DNS at this address');
    if (d.staleMs !== undefined && (!Number.isInteger(d.staleMs) || d.staleMs < 30000 || d.staleMs > 600000)) fail('dns.staleMs: 30000 to 600000');
    const { hosts, staleMs, ...limits } = d;
    let l; try { l = dnsLimits(limits); } catch (e) { fail(e.message); }
    dns = { hosts: [...new Set(hosts.map((h) => h.toLowerCase()))], staleMs: staleMs ?? 180000, limits: l };
  }
  return { zone: hs.zone, platformHostPolicy: p, mirrors, rpcs, maxHosts: hs.maxHosts ?? 64, dns, ...(hs.challenge === true ? { challenge: true } : {}) };
}

/** DNS 53 forwarding FAILS CLOSED without conntrack-tools (final review N2): -> { on, limits|null, pins|null, reason|null }.
 *  Off, the provider applies no DNS rules and pins no host; its transport roles are unaffected. */
export function providerDnsPlan(h, conntrack) {
  if (!h?.dns) return { on: false, limits: null, pins: null, reason: null };
  if (!conntrack) return { on: false, limits: null, pins: null, reason: 'hostServices.dns is configured but conntrack-tools is absent: DNS 53 is NOT forwarded (fail closed)' };
  return { on: true, limits: h.dns.limits, pins: { hosts: h.dns.hosts, staleMs: h.dns.staleMs }, reason: null };
}

/** the resolveHostPolicyConfig environment for this block (platform-host-policy-config.mjs), or null for "off" */
export function hostServicesPolicyEnv(h) {
  if (!h || h.platformHostPolicy === 'off') return null;
  return { ENCLAVE_PLATFORM_HOST_POLICY: typeof h.platformHostPolicy === 'string' ? h.platformHostPolicy : JSON.stringify(h.platformHostPolicy),
    ...(h.mirrors.length ? { ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS: h.mirrors.join(',') } : {}),
    ...(h.rpcs.length ? { ENCLAVE_PLATFORM_HOST_POLICY_RPCS: h.rpcs.join(',') } : {}) };
}
