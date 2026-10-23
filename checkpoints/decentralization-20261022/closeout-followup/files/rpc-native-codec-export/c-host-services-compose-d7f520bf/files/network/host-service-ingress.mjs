#!/usr/bin/env node
// A host's ingress for its OWN public service roles (work/host-service-transport-20261021), behind a 'service' circuit:
// the circuit's inner tunnel hands every connection that reached the exit for one of this host's derived names
// (host-service-names.mjs) to this worker, which routes it by TLS SNI (the 443 side) or HTTP Host (the 80 side) to the
// role's LOOPBACK port, raw (wg-provider/router.mjs with local routes: no TLS termination, no rewrite, no redirect).
//   - only the names in its table, each to 127.0.0.1:<port>; any other name, a missing name or malformed bytes: closed;
//   - the 443 side routes a name only to the role's TLS port (a host TLS terminator, G3); without one it is closed;
//   - no app, broker, deployment or upstream is reachable from here.
// worker.json: {names: {"<name>": {http: <port>, tls: <port>|null}}, tlsPort, httpPort}; prints {"type":"ready",...};
// stdin {"type":"stop"} (or EOF) closes it.
import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createRouter } from './wg-provider/router.mjs';
import { isHostServiceName } from './host-service-names.mjs';

const port = (v, what, optional = false) => {
  if (optional && (v === null || v === undefined)) return null;
  if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`host service ingress: ${what} must be a port`);
  return v;
};
/** -> Map(name -> {host:'127.0.0.1', http, tls|null}); refuses anything but host-service names to loopback ports */
export function serviceTable(names) {
  if (!names || typeof names !== 'object' || Array.isArray(names)) throw new Error('host service ingress: names must map names to ports');
  const entries = Object.entries(names);
  if (!entries.length || entries.length > 8) throw new Error('host service ingress: 1 to 8 names');
  return new Map(entries.map(([n, t]) => {
    if (n !== n.toLowerCase() || !isHostServiceName(n)) throw new Error(`host service ingress: ${JSON.stringify(n)} is not a host service name`);
    if (!t || typeof t !== 'object' || Object.keys(t).some((k) => !['http', 'tls'].includes(k))) throw new Error(`host service ingress: ${n}: {http, tls?}`);
    return [n, { host: '127.0.0.1', http: port(t.http, `${n}.http`), tls: port(t.tls, `${n}.tls`, true) }];
  }));
}

export async function createHostServiceIngress({ names, tlsPort = 0, httpPort = 0, maxConnections = 512, log = () => {} }) {
  const table = serviceTable(names);
  const tls = await createRouter({ port: tlsPort, host: '127.0.0.1', tls: true, maxConnections, log,
    route: (n) => { const t = table.get(n); return t && t.tls ? { host: t.host, tls: t.tls, http: t.http } : null; } });
  const http = await createRouter({ port: httpPort, host: '127.0.0.1', tls: false, maxConnections, log,
    route: (n) => { const t = table.get(n); return t ? { host: t.host, tls: t.tls || 0, http: t.http } : null; } });
  return { tlsPort: tls.port, httpPort: http.port, close() { tls.close(); http.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const ingress = await createHostServiceIngress({ names: cfg.names, tlsPort: port(cfg.tlsPort, 'tlsPort'), httpPort: port(cfg.httpPort, 'httpPort') });
  let closed = false;
  const close = () => { if (closed) return; closed = true; ingress.close(); process.exit(0); };
  const commands = createInterface({ input: process.stdin });
  commands.on('line', (line) => { try { if (JSON.parse(line).type === 'stop') close(); } catch { close(); } });
  commands.once('close', close); process.once('SIGTERM', close); process.once('SIGINT', close);
  // the same ready shape as the app worker (wg-circuit-runtime.mjs waits for its two ports)
  console.log(JSON.stringify({ type: 'ready', ingress: ingress.tlsPort, redirect: ingress.httpPort }));
}
