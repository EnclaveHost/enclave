// App-scoped provider policy. Different keys are not proof of different owners.
import net from 'node:net';
import {publicReservations} from './public-fallback.mjs';
import {isBlockedHost} from '../relay/net-guard.mjs';
import {publicProviderAddress} from './provider-qualification.mjs';
import {validateDirectPolicy} from './connectivity-policy.mjs';

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
  if(p?.version===3)return validateDirectPolicy(p);
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
  if (!providerPattern.test(provider?.identity || '') || !publicProviderAddress(provider.address)) return false;
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
export const providerCooldownKey = (role, provider) => role+':'+provider.identity+(role==='public'&&provider.publicTcp?':'+provider.publicTcp.join(','):'');
export function selectCircuitProviders(policy, inventory, {existing = [], locked = [], occupiedPublic = new Set(), cooldown = new Map(), now = Date.now()} = {}) {
  const p = validateCircuitPolicy(policy);
  if (!Array.isArray(inventory) || inventory.length > 10000) throw new Error('invalid provider inventory');
  const candidates = role => inventory.filter(n => Array.isArray(n?.services) && (role !== 'public' || ((!occupiedPublic.has(n.address) || !!n.publicTcp) && !publicReservations(n).some(k=>occupiedPublic.has(k)))) && n.services.includes(role === 'public' ? 'reverse' : 'socksproxy') &&
    providerAllowed(n, p.providers[role], p.maxPrice, now) && (cooldown.get(providerCooldownKey(role,n)) || cooldown.get(n.identity) || 0) <= now)
    .sort((a, b) => {
      const preferred = id => p.providers[role].prefer.includes(id) ? 0 : 1;
      const stable = id => existing.some(c => c[role]?.identity === id && c.healthy) ? 0 : 1;
      // An untried node inherits its network's record for this role (see
      // ProviderInventory.refresh); its own record replaces that once it has one.
      const ownOrNetwork = (n, r) => { const o = n.outcomes?.[r]; return o && o.known === false && o.networkRate !== undefined ? o.networkRate : (o?.successRate ?? n.successRate ?? 0.5); };
      // A guard is only as good as the allocations it carries (see 'carry' in
      // CircuitManager); with no carry record yet its own health stands.
      const carried = n => { const o = n.outcomes?.carry; return o && (o.known || o.networkRate !== undefined) ? ownOrNetwork(n, 'carry') : 1; };
      const rate = n => role === 'guard' ? Math.min(ownOrNetwork(n, 'guard'), carried(n)) : ownOrNetwork(n, role);
      return preferred(a.identity) - preferred(b.identity) || (role==='public'?Number(!!a.fallback)-Number(!!b.fallback):0) || stable(a.identity) - stable(b.identity) ||
        rate(b) - rate(a) || (a.outcomes?.[role]?.latencyMs ?? a.latencyMs ?? Infinity) - (b.outcomes?.[role]?.latencyMs ?? b.latencyMs ?? Infinity) || a.identity.localeCompare(b.identity);
    });
  const guards = candidates('guard'), publicNodes = candidates('public'), egressNodes = candidates('egress');
  // Bounded backtracking avoids getting stuck on the fastest first guard when
  // another initial choice is the only way to satisfy both routes' constraints.
  if (locked.length > p.routes || locked.some((c,i) => locked.slice(0,i).some(other => !independentCircuits(c,other,p.diversity)))) throw new Error('invalid locked circuits');
  let examined = 0, partial = [...locked];
  const search = (chosen, requireFallback) => {
    if (chosen.length === p.routes) return !requireFallback || chosen.some(c=>c.public.fallback) ? chosen : null;
    for (const guard of guards) {
      if (chosen.some(c => Object.values(c).some(n => !independent(n, guard, p.diversity)))) continue;
      const availablePublic=requireFallback && chosen.length===p.routes-1 && !chosen.some(c=>c.public.fallback) ? publicNodes.filter(n=>n.fallback) : publicNodes;
      for (const publicNode of availablePublic) {
        if (!independent(guard, publicNode, p.diversity)) continue;
        if (chosen.some(c => Object.values(c).some(n => !independent(n, publicNode, p.diversity)))) continue;
        // Public ingress and egress are already permitted to share an edge
        // provider within a circuit. Prefer that shape before consuming a
        // third failure domain, which can strand the sibling on unproven edges.
        // An explicit owner preference still takes precedence.
        const edgeRank=n=>n.identity===publicNode.identity?0:n.beneficiary===publicNode.beneficiary&&n.asn===publicNode.asn?1:n.asn===publicNode.asn?2:3;
        const edges=[...egressNodes].sort((a,b)=>(p.providers.egress.prefer.includes(a.identity)?0:1)-(p.providers.egress.prefer.includes(b.identity)?0:1)||edgeRank(a)-edgeRank(b));
        for (const egress of edges) {
          if (++examined > 100000) return null;
          const circuit = {guard, public: publicNode, egress};
          if (!independent(guard, egress, p.diversity) || chosen.some(c => !independentCircuits(c, circuit, p.diversity))) continue;
          const next = [...chosen, circuit];
          if (next.length > partial.length) partial = next;
          const result = search(next, requireFallback);
          if (result) return result;
        }
      }
    }
    return null;
  };
  // Keep one warm fallback when possible, while all owner constraints and
  // cross-circuit independence still apply. If it is unavailable, ordinary
  // independent providers can fill both slots. It is not an owner pin.
  const wantFallback=publicNodes.some(n=>n.fallback)&&!p.providers.public.prefer.length;
  let circuits=wantFallback?search([...locked],true):null;
  if(!circuits){examined=0;circuits=search([...locked],false);}
  return circuits ? {circuits, ready:true, reason:null} : {circuits:partial, ready:false,
    reason: examined > 100000 ? 'provider selection work limit reached' : 'insufficient independently eligible providers'};
}
