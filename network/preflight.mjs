#!/usr/bin/env node
// Read-only cutover check: all admitted deployments need a live allocation and
// a valid guest TLS endpoint at that IP. No DNS mutation or certificate bypass.
import https from 'node:https';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { isBlockedHost } from '../relay/net-guard.mjs';

export function checkMap(map, required = [], now = Date.now()) {
  if (map?.transport !== 'tuna' || !Array.isArray(map.pending) || !map.deployments) throw new Error('TUNA admission map unavailable or incomplete');
  if (map.pending.length) throw new Error(`TUNA not ready for ${map.pending.map(x => `${x.id}: ${x.reason}`).join(', ')}`);
  for (const id of required) if (!map.deployments[id]) throw new Error(`required deployment is not admitted: ${id}`);
  const entries = Object.entries(map.deployments);
  if (!entries.length) throw new Error('no admitted deployments to verify');
  for (const [id, r] of entries) {
    if (!/^0x[0-9a-f]{64}$/.test(id) || r.expiresAt <= now + 15000 || !r.https || r.https.port !== 443 || !net.isIP(r.https.address) || isBlockedHost(r.https.address))
      throw new Error(`missing, expired or invalid HTTPS allocation: ${id}`);
    const label = map.labels?.[id.slice(2, 10)];
    if (!label || (label.a || label.aaaa) !== r.https.address) throw new Error(`missing or ambiguous DNS label: ${id}`);
  }
  return entries;
}

export function probe(id, allocation, zone = 'app.enclave.host') {
  return new Promise((resolve, reject) => {
    const hostname = `${id.slice(2, 10)}.${zone}`;
    const req = https.get({ hostname, servername: hostname, port: 443, path: '/',
      lookup: (_host, opts, cb) => {
        const address = allocation.https.address, family = net.isIP(address);
        cb(null, opts.all ? [{address, family}] : address, family);
      }, agent: false, timeout: 15000 }, res => {
      // A private app may deny an anonymous request. TLS must still verify.
      const status = res.statusCode;
      res.destroy();
      if (status < 200 || status >= 500) reject(new Error(`${id}: HTTP ${status}`));
      else resolve({id, hostname, address: allocation.https.address, status});
    });
    req.once('timeout', () => req.destroy(new Error(`${id}: provider timed out`)));
    req.once('error', reject);
  });
}

export async function preflight(api, required = []) {
  const response = await fetch(new URL('/v1/network/tuna', api), { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`TUNA map returned HTTP ${response.status}`);
  const entries = checkMap(await response.json(), required), results = [];
  for (const [id, allocation] of entries) results.push(await probe(id, allocation));
  const fresh = await fetch(new URL('/v1/network/tuna', api), { signal: AbortSignal.timeout(15000) });
  if (!fresh.ok) throw new Error('TUNA admission refresh failed');
  const current = new Map(checkMap(await fresh.json(), entries.map(([id]) => id)));
  for (const [id, allocation] of entries) if (current.get(id)?.https?.address !== allocation.https.address)
    throw new Error(`${id}: allocation changed during preflight; retry`);
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  preflight(process.env.TUNA_API || 'https://api.enclave.host', process.argv.slice(2))
    .then(results => console.log(JSON.stringify({ok: true, results}, null, 2)))
    .catch(e => { console.error(`TUNA cutover refused: ${e.message}`); process.exitCode = 1; });
}
