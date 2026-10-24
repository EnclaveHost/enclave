#!/usr/bin/env node
// Custody v2 CANARY ingress forwarder (metal0). It supports an explicit dedicated HTTPS origin or legacy prefix behind a loopback reverse tunnel, and
// forwards ONLY the corrected custodian's public protocol, from the reviewed allowlist of custody/v2/ingress.mjs (ab589bf8;
// pinned/ingress.mjs), to ONE fixed loopback custody management port (custody/v2/host.mjs mgmtPort -> guest :8787).
//
// Why exact matching on the RAW request target. The guest dispatches on new URL(req.url).pathname (custody/v2/http.mjs).
// WHATWG resolution turns /v2/custody/x/../host-binding, /v2/custody/x/%2e%2e/host-binding and backslash forms into the
// PRIVATE host-binding route. Here the raw target must equal <prefix><route> byte for byte, for one of the 12 routes and with
// its one method. Nothing is decoded, normalised or case-folded. The upstream path is the allowlist's own constant, never a
// client string. Private routes (host-binding, /health, /) and the host's state/submit port are unreachable by construction.
//
// Bounds. Request body: Content-Length checked before reading, then counted (413), and the whole body within bodyTimeoutMs
// (408). GET carries no body. Headers: Node's headersTimeout, requestTimeout and maxHeaderSize. In flight: maxInFlight (503).
// The upstream exchange, including its response body, must finish within upstreamTimeoutMs (504). The response body is capped
// at maxResponseBytes (502). The upstream must answer 2xx, 4xx or 5xx JSON (3xx and non-JSON -> 502: no redirects are
// followed or passed on). A client that goes away aborts the upstream request.
//
// Headers. Nothing the client sends is forwarded: no Host, X-Forwarded-*, Forwarded, Cookie, Authorization or hop-by-hop
// headers. The upstream request carries only host, content-type: application/json, content-length, accept and connection:
// close. The client gets only content-type, content-length, cache-control, nosniff, connection: close and a numeric
// Retry-After. Every connection closes after one response, so there is no keep-alive or pipelining state. Upgrade and CONNECT
// are destroyed.
//
// Not this file's job: TLS (the control-VM Caddy), client identity or rate limits (the guest's own, per TCP peer: behind this
// hop every client shares one bucket), and anything permanent (the Linux host-role route is deferred).
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

/** The reviewed public allowlist (pinned/ingress.mjs directCustodyIngress at ab589bf8): route -> its one method. */
export const ROUTES = Object.freeze(new Map([
  ['/v2/custody/info', 'GET'],
  ['/v2/custody/evidence', 'POST'],
  ['/v2/custody/challenge', 'POST'],
  ['/v2/custody/release', 'POST'],
  ['/v2/custody/join', 'POST'],
  ['/v2/custody/approve', 'POST'],
  ['/v2/custody/independent-genesis', 'POST'],
  ['/v2/custody/code-approve', 'POST'],
  ['/v2/custody/owner-read/challenge', 'POST'],
  ['/v2/custody/owner-read', 'POST'],
  ['/v2/custody/shield-session/challenge', 'POST'],
  ['/v2/custody/shield-session/attest', 'POST'],
]));
export const GUEST_MAX_BODY = 262144;   // custody/v2/http.mjs MAX_BODY at ab589bf8

const DEFAULTS = Object.freeze({
  maxBodyBytes: GUEST_MAX_BODY, maxResponseBytes: 1048576, bodyTimeoutMs: 10000, upstreamTimeoutMs: 30000,
  headersTimeoutMs: 10000, requestTimeoutMs: 45000, maxInFlight: 16, maxHeaderBytes: 8192,
});
const KEYS = ['listen', 'mount', 'prefix', 'upstreamPort', ...Object.keys(DEFAULTS)];
const PREFIX = /^(\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?){1,3}$/;   // 1-3 lowercase segments, no dots, encodings or slashes
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const isPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

/** -> the validated configuration (defaults filled in); throws on anything else. */
export function validateConfig(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('config must be an object');
  for (const k of Object.keys(c)) if (!KEYS.includes(k)) throw new Error(`unknown config key ${JSON.stringify(k)}`);
  const l = c.listen;
  if (!l || typeof l !== 'object' || Object.keys(l).some((k) => !['host', 'port'].includes(k))) throw new Error('listen must be {host, port}');
  if (!LOOPBACK.has(l.host)) throw new Error('listen.host must be a loopback address (127.0.0.1 or ::1): the reverse tunnel is the only client');
  if (!(l.port === 0 || isPort(l.port))) throw new Error('listen.port must be a TCP port');
  if (!isPort(c.upstreamPort)) throw new Error('upstreamPort must be the custody management port (loopback, fixed)');
  if (l.port !== 0 && l.port === c.upstreamPort) throw new Error('listen.port and upstreamPort must differ');
  const mount=c.mount??'prefix';
  if(!['prefix','origin'].includes(mount))throw new Error('mount must be prefix or origin');
  if(mount==='origin') {
    if(c.prefix!=='')throw new Error('origin mount requires an explicitly empty prefix');
  } else if (typeof c.prefix !== 'string' || !PREFIX.test(c.prefix) || c.prefix.startsWith('/t/') || c.prefix === '/t' || c.prefix.startsWith('/v2'))
    throw new Error('prefix must be 1-3 lowercase segments, not under relay tunnels or /v2');
  const out = { listen: { host: l.host, port: l.port }, mount, prefix: c.prefix, upstreamPort: c.upstreamPort };
  const range = { maxBodyBytes: [1, 16777216], maxResponseBytes: [1024, 16777216], bodyTimeoutMs: [100, 120000], upstreamTimeoutMs: [100, 300000],
                  headersTimeoutMs: [100, 60000], requestTimeoutMs: [200, 300000], maxInFlight: [1, 1024], maxHeaderBytes: [1024, 65536] };
  for (const [k, [lo, hi]] of Object.entries(range)) {
    const v = c[k] ?? DEFAULTS[k];
    if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new Error(`${k}: an integer from ${lo} to ${hi}`);
    out[k] = v;
  }
  if (out.requestTimeoutMs <= out.headersTimeoutMs) throw new Error('requestTimeoutMs must exceed headersTimeoutMs');
  return out;
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' };
function send(res, status, body, extra = {}) {
  if (res.headersSent || res.destroyed) return;
  const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));   // upstream bytes pass unchanged
  res.sendDate = false;
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': b.length, ...extra });
  res.end(b);
}
const refuse = (res, status, error, message) => send(res, status, { error, message });

/** -> the allowlisted route for this exact raw request target and method under `prefix`, or null. */
export function routeOf(prefix, method, target) {
  if (typeof target !== 'string' || !target.startsWith(prefix + '/')) return null;
  const route = target.slice(prefix.length);
  return ROUTES.has(route) && ROUTES.get(route) === method ? route : null;
}

/**
 * createForwarder(config, { log, afterBody }) -> { server, listen() -> Promise<{host, port}>, close() -> Promise, stats }
 * afterBody(req, res) is a TEST SEAM only (test/forwarder.test.mjs): called synchronously once the body is complete, before
 * any upstream work, so a test can make the client go away in exactly that window. Production passes nothing.
 * log(event) receives { status, reason, route?, ms } per request: never a body, header or raw target.
 */
export function createForwarder(config, { log = () => {}, afterBody = null } = {}) {
  const c = validateConfig(config);
  const stats = { inFlight: 0, forwarded: 0, refused: 0 };
  const server = http.createServer({ maxHeaderSize: c.maxHeaderBytes, requestTimeout: c.requestTimeoutMs, headersTimeout: c.headersTimeoutMs,
                                     keepAliveTimeout: 1000, joinDuplicateHeaders: false,
                                     connectionsCheckingInterval: Math.max(50, Math.min(1000, Math.floor(c.headersTimeoutMs / 4))) });

  async function handle(req, res, expectContinue) {
    const t0 = Date.now();
    let reason = 'ok', route = null;
    const done = (_status, why) => { reason = why; stats.refused++; };
    stats.inFlight++;
    res.once('close', () => { stats.inFlight--; log({ status: res.statusCode, reason, ...(route ? { route } : {}), ms: Date.now() - t0 }); });
    if (stats.inFlight > c.maxInFlight) { done(503, 'busy'); return refuse(res, 503, 'busy', 'Too many requests in progress; retry shortly.'); }
    route = routeOf(c.prefix, req.method, req.url);
    if (!route) { done(404, 'not_allowlisted'); return refuse(res, 404, 'not_found', 'Not found'); }
    const method = ROUTES.get(route);
    const declared = req.headers['content-length'];
    const chunked = req.headers['transfer-encoding'] !== undefined;
    if (method === 'GET' && (chunked || (declared !== undefined && declared !== '0'))) { done(400, 'get_body'); return refuse(res, 400, 'bad_request', 'GET carries no body.'); }
    if (declared !== undefined && !(/^\d{1,12}$/.test(declared) && Number(declared) <= c.maxBodyBytes)) { done(413, 'declared_too_large'); return refuse(res, 413, 'too_large', 'Body too large.'); }

    // the body, bounded in size and time; a client that goes away aborts everything after this point
    const ac = new AbortController();
    const onGone = () => { if (!res.writableEnded) ac.abort(); };
    res.once('close', onGone);
    let body = Buffer.alloc(0);
    if (method === 'POST') {
      if (expectContinue) res.writeContinue();
      const got = await new Promise((resolve) => {
        const chunks = []; let n = 0;
        const timer = setTimeout(() => finish('timeout'), c.bodyTimeoutMs);
        function finish(v) { clearTimeout(timer); req.off('data', onData); req.off('end', onEnd); req.off('error', onErr); resolve(v); }
        function onData(d) { n += d.length; if (n > c.maxBodyBytes) return finish('too_large'); chunks.push(d); }
        function onEnd() { finish(Buffer.concat(chunks, n)); }
        function onErr() { finish('aborted'); }
        req.on('data', onData); req.once('end', onEnd); req.once('error', onErr);
        ac.signal.addEventListener('abort', () => finish('aborted'), { once: true });
      });
      if (got === 'too_large') { done(413, 'too_large'); return refuse(res, 413, 'too_large', 'Body too large.'); }
      if (got === 'timeout') { done(408, 'body_timeout'); return refuse(res, 408, 'timeout', 'The request body did not arrive in time.'); }
      if (got === 'aborted') { done(499, 'client_gone'); return; }
      body = got;
    }
    afterBody?.(req, res);
    // A client can go away after its body completed but before this point: its socket 'close' arrives via nextTick, which
    // runs before this continuation, so `ac` may ALREADY be aborted, and an abort listener added from here on would never
    // fire. So check the state itself, before any upstream socket exists (ROOT-FOLLOWUP 2026-10-23).
    if (ac.signal.aborted || res.destroyed || req.socket?.destroyed) { done(499, 'client_gone'); return; }

    // one upstream exchange to the fixed loopback port, with the allowlist's own path and method, under one deadline
    const result = await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => end({ fail: 504 }), c.upstreamTimeoutMs);
      const up = http.request({ host: '127.0.0.1', port: c.upstreamPort, method, path: route, agent: false,
        headers: { host: `127.0.0.1:${c.upstreamPort}`, accept: 'application/json', connection: 'close',
                   ...(method === 'POST' ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } });
      function end(v) { if (settled) return; settled = true; clearTimeout(timer); if (v.fail || v.gone) up.destroy(); resolve(v); }
      ac.signal.addEventListener('abort', () => end({ gone: true }), { once: true });
      if (ac.signal.aborted) return end({ gone: true });   // aborted before the listener existed: it would never fire
      up.once('error', () => end({ fail: 502 }));
      up.once('response', (r) => {
        const s = r.statusCode, type = String(r.headers['content-type'] || '');
        if (!(s >= 200 && s < 300) && !(s >= 400 && s < 600)) { r.resume(); return end({ fail: 502 }); }   // no 1xx/3xx passed on
        if (!/^application\/json(\s*;|$)/i.test(type)) { r.resume(); return end({ fail: 502 }); }
        const declaredUp = r.headers['content-length'];
        if (declaredUp !== undefined && !(Number(declaredUp) <= c.maxResponseBytes)) { r.resume(); return end({ fail: 502 }); }
        const chunks = []; let n = 0;
        r.on('data', (d) => { n += d.length; if (n > c.maxResponseBytes) return end({ fail: 502 }); chunks.push(d); });
        r.once('end', () => { if (r.complete) end({ status: s, body: Buffer.concat(chunks, n), retryAfter: r.headers['retry-after'] }); else end({ fail: 502 }); });
        r.once('aborted', () => end({ fail: 502 }));
        r.once('error', () => end({ fail: 502 }));
      });
      up.end(method === 'POST' ? body : undefined);
    });
    if (result.gone) { done(499, 'client_gone'); return; }
    if (result.fail) {
      reason = result.fail === 504 ? 'upstream_timeout' : 'upstream_failed';
      return refuse(res, result.fail, result.fail === 504 ? 'upstream_timeout' : 'upstream_unavailable',
                    result.fail === 504 ? 'The custodian did not answer in time.' : 'The custodian is unavailable.');
    }
    stats.forwarded++;
    const retry = /^\d{1,5}$/.test(String(result.retryAfter || '')) ? { 'retry-after': String(result.retryAfter) } : {};
    send(res, result.status, result.body, retry);
  }

  server.on('request', (req, res) => { handle(req, res, false).catch(() => refuse(res, 500, 'internal', 'Internal error.')); });
  server.on('checkContinue', (req, res) => { handle(req, res, true).catch(() => refuse(res, 500, 'internal', 'Internal error.')); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('clientError', (err, socket) => {
    const line = err?.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout' : err?.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
    if (socket.writable && !socket.destroyed) socket.end(`HTTP/1.1 ${line}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    else socket.destroy();
  });
  return {
    server, stats, config: c,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(c.listen.port, c.listen.host, () => { server.off('error', reject); const a = server.address(); resolve({ host: a.address, port: a.port }); });
    }),
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node forwarder.mjs CONFIG.json'); process.exit(2); }
  const f = createForwarder(JSON.parse(fs.readFileSync(file, 'utf8')), { log: (e) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e })) });
  const a = await f.listen();
  console.log(JSON.stringify({ listening: `${a.host}:${a.port}`, prefix: f.config.prefix, upstream: `127.0.0.1:${f.config.upstreamPort}`, routes: ROUTES.size }));
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => f.close().then(() => process.exit(0)));
}
