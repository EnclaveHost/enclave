// App-scoped provider policy. Different keys are not proof of different owners.
import net from 'node:net';
import {isBlockedHost} from '../relay/net-guard.mjs';

const providerPattern = /^(?:[a-zA-Z0-9_.-]{1,128}\.)?[0-9a-f]{64}$/;
const deploymentPattern = /^0x[0-9a-f]{64}$/;
export function nknAmount(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,10})(?:\.\d{1,8})?$/.test(value)) throw new Error('invalid NKN amount');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
}
function identities(value = []) {
  if (!Array.isArray(value) || value.length > 256 || value.some(x => typeof x !== 'string' || !providerPattern.test(x)) || new Set(value).size !== value.length)
    throw new Error('invalid provider identities');
  return [...value];
}
export function validateCircuitPolicy(p) {
  if (!p || p.version !== 2 || !deploymentPattern.test(p.deploymentId || '')) throw new Error('invalid deployment policy');
  if (Object.keys(p).some(k => !['version','deploymentId','mode','directFallback','routes','maxPrice','budgetNkn','diversity','providers'].includes(k)) ||
      (p.providers && Object.keys(p.providers).some(k => !['guard','public','egress'].includes(k)))) throw new Error('unknown circuit policy option');
  if (p.mode !== 'guarded' || p.directFallback !== false || p.routes !== 2) throw new Error('privacy policy requires two guarded routes and no direct fallback');
  if (nknAmount(p.maxPrice) <= 0n || nknAmount(p.budgetNkn) <= 0n) throw new Error('positive price and funded budget required');
  const providers = {};
  for (const role of ['guard', 'public', 'egress']) {
    const value = p.providers?.[role] || {};
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['allow','prefer','deny'].includes(k))) throw new Error('invalid provider policy');
    providers[role] = {allow: identities(value.allow), prefer: identities(value.prefer), deny: identities(value.deny)};
    if (providers[role].prefer.some(id => providers[role].deny.includes(id) || (providers[role].allow.length && !providers[role].allow.includes(id))))
      throw new Error('preferred provider is forbidden by policy');
  }
  if (!['beneficiary-and-network', 'verified-operator'].includes(p.diversity)) throw new Error('explicit diversity policy required');
  return {...p, providers};
}
export function providerAllowed(provider, rule, maxPrice, now = Date.now()) {
  if (!providerPattern.test(provider?.identity || '') || !net.isIP(provider?.address) || isBlockedHost(provider.address)) return false;
  if (!Number.isSafeInteger(provider.expiresAt) || provider.expiresAt <= now) return false;
  if (rule.deny.includes(provider.identity) || (rule.allow.length && !rule.allow.includes(provider.identity))) return false;
  try {
    const prices = provider.price.split(',');
    if (prices.length > 2 || prices.some(price => nknAmount(price) > nknAmount(maxPrice))) return false;
  } catch { return false; }
  return true;
}
export function independent(a, b, level) {
  if (!a || !b || a.identity === b.identity || a.address === b.address) return false;
  // Unknown ownership/network metadata does not satisfy a strict diversity gate.
  if (!a.beneficiary || !b.beneficiary || a.beneficiary === b.beneficiary || !Number.isSafeInteger(a.asn) || !Number.isSafeInteger(b.asn) || a.asn <= 0 || b.asn <= 0 || a.asn === b.asn) return false;
  if (level === 'verified-operator') return !!a.verifiedOperator && !!b.verifiedOperator && a.verifiedOperator !== b.verifiedOperator;
  return true;
}
// Every provider in one circuit must be independent of every provider in its
// sibling. Within a circuit, the public and egress edges may share an operator;
// neither may share the guard's operator or network.
export function independentCircuits(a, b, level) {
  return Object.values(a).every(x => Object.values(b).every(y => independent(x, y, level)));
}
export function selectCircuitProviders(policy, inventory, {existing = [], locked = [], occupiedPublic = new Set(), cooldown = new Map(), now = Date.now()} = {}) {
  const p = validateCircuitPolicy(policy);
  if (!Array.isArray(inventory) || inventory.length > 10000) throw new Error('invalid provider inventory');
  const candidates = role => inventory.filter(n => Array.isArray(n?.services) && (role !== 'public' || !occupiedPublic.has(n.address)) && n.services.includes(role === 'public' ? 'reverse' : 'socksproxy') &&
    providerAllowed(n, p.providers[role], p.maxPrice, now) && (cooldown.get(role+':'+n.identity) || cooldown.get(n.identity) || 0) <= now)
    .sort((a, b) => {
      const preferred = id => p.providers[role].prefer.includes(id) ? 0 : 1;
      const stable = id => existing.some(c => c[role]?.identity === id && c.healthy) ? 0 : 1;
      return preferred(a.identity) - preferred(b.identity) || stable(a.identity) - stable(b.identity) ||
        (b.outcomes?.[role]?.successRate ?? b.successRate ?? 0.5) - (a.outcomes?.[role]?.successRate ?? a.successRate ?? 0.5) || (a.outcomes?.[role]?.latencyMs ?? a.latencyMs ?? Infinity) - (b.outcomes?.[role]?.latencyMs ?? b.latencyMs ?? Infinity) || a.identity.localeCompare(b.identity);
    });
  const guards = candidates('guard'), publicNodes = candidates('public'), egressNodes = candidates('egress');
  // Bounded backtracking avoids getting stuck on the fastest first guard when
  // another initial choice is the only way to satisfy both routes' constraints.
  if (locked.length > p.routes || locked.some((c,i) => locked.slice(0,i).some(other => !independentCircuits(c,other,p.diversity)))) throw new Error('invalid locked circuits');
  let examined = 0, partial = [...locked];
  const search = chosen => {
    if (chosen.length === p.routes) return chosen;
    for (const guard of guards) {
      if (chosen.some(c => Object.values(c).some(n => !independent(n, guard, p.diversity)))) continue;
      for (const publicNode of publicNodes) {
        if (!independent(guard, publicNode, p.diversity)) continue;
        if (chosen.some(c => Object.values(c).some(n => !independent(n, publicNode, p.diversity)))) continue;
        for (const egress of egressNodes) {
          if (++examined > 100000) return null;
          const circuit = {guard, public: publicNode, egress};
          if (!independent(guard, egress, p.diversity) || chosen.some(c => !independentCircuits(c, circuit, p.diversity))) continue;
          const next = [...chosen, circuit];
          if (next.length > partial.length) partial = next;
          const result = search(next);
          if (result) return result;
        }
      }
    }
    return null;
  };
  const circuits = search([...locked]);
  return circuits ? {circuits, ready:true, reason:null} : {circuits:partial, ready:false,
    reason: examined > 100000 ? 'provider selection work limit reached' : 'insufficient independently eligible providers'};
}
