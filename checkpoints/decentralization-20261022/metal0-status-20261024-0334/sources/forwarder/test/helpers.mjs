// Test helpers: a guest-like custodian upstream (WHATWG dispatch, as custody/v2/http.mjs), raw-socket requests, and a
// forwarder under test. FORWARDER_MODULE selects the module (test/run-mutants.mjs points it at mutated copies).
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MOD = process.env.FORWARDER_MODULE ? pathToFileURL(path.resolve(process.env.FORWARDER_MODULE)).href : new URL('../forwarder.mjs', import.meta.url).href;
export const F = await import(MOD);
export const PREFIX = '/custody-v2-canary/metal0';
export const PRIVATE_ROUTES = ['/v2/custody/host-binding', '/health', '/'];

/** A custodian stand-in that dispatches like the guest: new URL(req.url).pathname, so dot/backslash forms resolve. */
export async function fakeCustodian() {
  const hits = [];
  const g = { hits, behavior: null, closed: 0, connections: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const pathname = new URL(req.url, 'http://x').pathname;
      const hit = { method: req.method, raw: req.url, pathname, headers: { ...req.headers }, body: Buffer.concat(chunks).toString('utf8') };
      hits.push(hit);
      res.on('close', () => { if (!res.writableEnded) g.closed++; });
      if (g.behavior) return g.behavior(req, res, hit);
      const reply = (s, o) => { const b = JSON.stringify(o); res.writeHead(s, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), 'set-cookie': 'x=1', 'x-upstream-secret': 'no' }); res.end(b); };
      if (pathname === '/v2/custody/host-binding') return reply(200, { reached: 'HOST-BINDING' });
      if (pathname === '/health' || pathname === '/') return reply(200, { reached: 'HEALTH' });
      if (pathname.startsWith('/v2/custody/')) return reply(200, { ok: true, route: pathname, method: req.method, echo: hit.body });
      return reply(404, { error: 'not_found' });
    });
  });
  server.on('connection', () => { g.connections++; });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  g.port = server.address().port;
  g.close = () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
  return g;
}

/** Start a forwarder in front of `upstream` with small test limits (overridable). */
export async function forwarder(upstreamPort, over = {}, opts = {}) {
  const f = F.createForwarder({ listen: { host: '127.0.0.1', port: 0 }, prefix: PREFIX, upstreamPort, maxBodyBytes: 4096, maxResponseBytes: 8192,
                                bodyTimeoutMs: 400, upstreamTimeoutMs: 600, headersTimeoutMs: 400, requestTimeoutMs: 1500, maxInFlight: 8, ...over }, opts);
  const a = await f.listen();
  return { f, port: a.port, close: () => f.close() };
}

/** Send exact bytes; resolve with the parsed status (0 if none) once the server closes or `ms` passes. */
export function raw(port, text, { ms = 2500, writes = null } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let data = Buffer.alloc(0), closed = false;
    const done = () => {
      clearTimeout(t);
      const str = data.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(str);
      const [head, ...rest] = str.split('\r\n\r\n');
      resolve({ status: m ? Number(m[1]) : 0, head, body: rest.join('\r\n\r\n'), closed, text: str });
      s.destroy();
    };
    const t = setTimeout(done, ms);
    s.on('data', (d) => { data = Buffer.concat([data, d]); });
    s.on('close', () => { closed = true; done(); });
    s.on('error', () => {});
    s.on('connect', async () => {
      if (!writes) return s.write(text);
      for (const [delay, chunk] of writes) { await new Promise((r) => setTimeout(r, delay)); if (!s.destroyed) s.write(chunk); }
    });
  });
}

export function request(port, method, target, body = null, headers = {}) {
  const b = body === null ? '' : body;
  const h = { host: 'api.enclave.host', connection: 'close', ...(body === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }), ...headers };
  return raw(port, `${method} ${target} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${b}`);
}
export const headersOf = (head) => Object.fromEntries(head.split('\r\n').slice(1).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()]; }));
