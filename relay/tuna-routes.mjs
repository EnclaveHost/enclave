// Authenticated, expiring TUNA allocations. This is DNS/control metadata;
// application bytes never pass through this service.
import net from 'node:net';
import { isBlockedHost } from './net-guard.mjs';
import { recoverOp } from './fleet-auth.js';

export const tunaMessage = publication => 'enclave-tuna-route:v1\n' + JSON.stringify(publication);
export function validatePublication(p, now = Date.now()) {
  if (!p || p.version !== 1 || typeof p.endpoint !== 'string' || p.endpoint.length > 512) throw new Error('invalid TUNA publication');
  const endpoint = new URL(p.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || p.endpoint.endsWith('/')) throw new Error('invalid registered endpoint');
  if (!Number.isSafeInteger(p.expiresAt) || p.expiresAt <= now || p.expiresAt > now + 120000) throw new Error('publication must expire within two minutes');
  if (p.web !== null && (!p.web || !net.isIP(p.web.address) || isBlockedHost(p.web.address) || p.web.port !== 443)) throw new Error('HTTPS requires a public IP and port 443');
  if (!Array.isArray(p.raw) || p.raw.length > 256) throw new Error('invalid raw allocations');
  const seen = new Set();
  for (const r of p.raw) {
    if (!/^0x[0-9a-f]{64}$/.test(r.id) || seen.has(r.id) || !net.isIP(r.address) || isBlockedHost(r.address)) throw new Error('invalid raw allocation');
    seen.add(r.id);
    for (const protocol of ['tcp', 'udp']) {
      if (!Array.isArray(r[protocol]) || r[protocol].length > 255) throw new Error('invalid port mappings');
      const ports = new Set();
      for (const m of r[protocol]) {
        if (![m.port, m.publicPort].every(n => Number.isInteger(n) && n > 0 && n <= 65535) || ports.has(m.port)) throw new Error('invalid port mapping');
        ports.add(m.port);
      }
    }
  }
  return p;
}

export function createTunaRoutes({ operatorOf, endpointId, eligible, now = Date.now, recover = recoverOp }) {
  const hosts = new Map();
  const prune = () => { for (const [ep, p] of hosts) if (p.expiresAt <= now()) hosts.delete(ep); };
  return {
    async publish(publication, signature) {
      validatePublication(publication, now());
      const signer = await recover(tunaMessage(publication), signature);
      if (!signer) throw new Error('registered operator signature required');
      const owner = await operatorOf(publication.endpoint);
      if (!owner || String(owner).toLowerCase() !== signer) throw new Error('registered operator signature required');
      prune();
      if ((hosts.get(publication.endpoint)?.expiresAt || 0) >= publication.expiresAt) throw new Error('stale publication');
      if (!hosts.has(publication.endpoint) && hosts.size >= 4096) throw new Error('host publication limit');
      hosts.set(publication.endpoint, structuredClone(publication));
    },
    async map(rows) {
      prune(); const byRunner = new Map();
      for (const [ep, p] of hosts) byRunner.set(String(await endpointId(ep)).toLowerCase(), p);
      const labels = {}, deployments = {}, pending = [], seen = new Set(), duplicates = new Set();
      for (const d of rows) {
        if (!/^0x[0-9a-f]{64}$/i.test(d.id || '')) continue;
        const id = d.id.toLowerCase(), label = id.slice(2, 10);
        if (seen.has(label)) { duplicates.add(label); delete labels[label]; } seen.add(label);
        const p = byRunner.get(String(d.runner).toLowerCase());
        const admission = eligible(d);
        if (Number(d.leaseUntil) * 1000 <= now() || !admission || (typeof admission === 'number' && admission <= now())) continue;
        if (!p || !p.web) pending.push({ id, reason: p ? 'https_unavailable' : 'host_unpublished' });
        if (!p) continue;
        const expiresAt = Math.min(p.expiresAt, Number(d.leaseUntil) * 1000, typeof admission === 'number' ? admission : Infinity);
        if (expiresAt <= now()) continue;
        const raw = p.raw.find(r => r.id === id);
        deployments[id] = { transport: 'tuna', endpoint: p.endpoint, expiresAt, dedicatedIP: false,
          https: p.web, ...(raw ? { address: raw.address, tcp: raw.tcp, udp: raw.udp } : {}) };
        if (p.web && !duplicates.has(label)) labels[label] = { transport: 'tuna', relay: 'tuna',
          expiresAt, [net.isIPv4(p.web.address) ? 'a' : 'aaaa']: p.web.address };
      }
      return { transport: 'tuna', updatedAt: new Date(now()).toISOString(), relays: [], labels, deployments, pending };
    },
  };
}
