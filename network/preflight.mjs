#!/usr/bin/env node
// Read-only cutover check (relay/deploy.sh runs it first): every admitted deployment needs a live route in the relay's
// route map (/v1/network/routes) and a valid guest TLS endpoint at that IP. No DNS mutation or
// certificate bypass.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { isBlockedHost } from '../relay/net-guard.mjs';

export const fetchRouteMap = (api, fetchImpl = fetch) =>
  fetchImpl(new URL('/v1/network/routes', api), { signal: AbortSignal.timeout(15000) });

export function checkMap(map, required = [], now = Date.now()) {
  if (map?.transport !== 'enclave-network' || !Array.isArray(map.pending) || !map.deployments) throw new Error('route map unavailable or incomplete');
  if (map.pending.length) throw new Error(`routes not ready for ${map.pending.map(x => `${x.id}: ${x.reason}`).join(', ')}`);
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

export function probeRedirect(id, allocation, zone = 'app.enclave.host') {
  const hostname = `${id.slice(2, 10)}.${zone}`;
  return new Promise((resolve, reject) => {
    const req = http.request({hostname:allocation.https.address, port:80, method:'HEAD', path:'/',
      headers:{host:hostname}, agent:false, timeout:15000}, res => {
      res.resume();
      if (![301,308].includes(res.statusCode) || res.headers.location !== `https://${hostname}/`)
        reject(new Error(`${id}: HTTP redirect unavailable or wrong destination`));
      else resolve(res.statusCode);
    });
    req.once('timeout', () => req.destroy(new Error(`${id}: HTTP redirect timed out`)));
    req.once('error', reject); req.end();
  });
}

export async function preflight(api, required = []) {
  const response = await fetchRouteMap(api);
  if (!response.ok) throw new Error(`route map returned HTTP ${response.status}`);
  const entries = checkMap(await response.json(), required), results = [];
  for (const [id, allocation] of entries) {
    const [tls, httpStatus] = await Promise.all([probe(id, allocation), probeRedirect(id, allocation)]);
    results.push({...tls, httpStatus});
  }
  const fresh = await fetchRouteMap(api);
  if (!fresh.ok) throw new Error('route map refresh failed');
  const current = new Map(checkMap(await fresh.json(), entries.map(([id]) => id)));
  for (const [id, allocation] of entries) if (current.get(id)?.https?.address !== allocation.https.address)
    throw new Error(`${id}: allocation changed during preflight; retry`);
  return results;
}
// Routes are short-lived and renewed on a rolling schedule, so a single read can land a few seconds before a renewal and
// see one with less than the 15 s margin left (2026-10-14 08:49: 'missing, expired or invalid HTTPS allocation' for an app
// serving fine, which failed a relay deploy). Those readings - an expiring allocation, routes not ready yet, an allocation
// that moved during the check - are read again a few times before the cutover is refused; any other refusal is final.
const TRANSIENT = /missing, expired or invalid HTTPS allocation|routes not ready|allocation changed during preflight/;
export async function preflightWithRetry(api, required = [], { attempts = 4, delayMs = 8000, run = preflight, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 1; ; i++) {
    try { return await run(api, required); }
    catch (e) { if (i >= attempts || !TRANSIENT.test(String(e?.message))) throw e; await sleep(delayMs); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  preflightWithRetry(process.env.ENCLAVE_API || 'https://api.enclave.host', process.argv.slice(2))
    .then(results => console.log(JSON.stringify({ok: true, results}, null, 2)))
    .catch(e => { console.error(`relay cutover refused: ${e.message}`); process.exitCode = 1; });
}
