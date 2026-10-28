#!/usr/bin/env node
// Local owner-wallet handoff server. Binds 127.0.0.1 only. Read-only RPC; the browser wallet signs, never this process.
// No subprocesses, no key material, no writes beyond ./journal. Default: SIGNING_DISABLED.
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {
  LIMITS, PROVIDERS, Refusal, stable, readBoundedFile, computeToolDigests, loadInputs, readJournal, journalFile,
  createService, httpRpc, offlineReport, dryRun,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOY_DIR = path.resolve(HERE, '../deployment-r1');
export const UNIFIED_DIR = path.resolve(HERE, '..');
export const JOURNAL_DIR = path.join(HERE, 'journal');

const STATIC = Object.freeze({
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['public/app.css', 'text/css; charset=utf-8'],
});
const ROUTES = Object.freeze({
  prepare: ['index', 'account', 'walletChainId'],
  report: ['index', 'offerId', 'kind', 'hash', 'code', 'message'],
  reconcile: ['index', 'hash'],
});
const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; "
    + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
});
const PATH_RE = /^\/([A-Za-z0-9_-]{43})(\/|\/app\.js|\/app\.css|\/api\/(?:state|prepare|report|reconcile))$/;

// Static files are read once; these exact bytes are what toolSourceSha256 covers.
export function loadStaticFiles(dir = HERE) {
  return Object.fromEntries(Object.entries(STATIC).map(([route, [file, type]]) => [route, {bytes: readBoundedFile(path.join(dir, file), LIMITS.toolFileMaxBytes), type}]));
}

const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(stable(body));
  res.writeHead(status, {...SECURITY_HEADERS, ...extra, 'content-type': type, 'content-length': buf.length});
  res.end(buf);
};
const deny = (res, status, code, message, extra) => send(res, status, {ok: false, refusal: {code, message}}, undefined, extra);

const readBody = (req, max) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.setTimeout(10_000, () => reject(new Refusal('body_timeout', 'request body timed out')));
  req.on('data', (c) => {
    size += c.length;
    if (size > max) { reject(new Refusal('body_too_large', `body exceeds ${max} bytes`)); req.pause(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

export function createHandler({service, files, capability, token, port}) {
  const host = `127.0.0.1:${port}`, origin = `http://${host}`;
  const html = Buffer.from(files['/'].bytes.toString('utf8').replace('__DEPLOY_TOKEN__', token));
  return async (req, res) => {
    if (req.headers.host !== host) return deny(res, 403, 'bad_host', 'unexpected Host header');
    const m = PATH_RE.exec(req.url ?? '');
    if (!m || !safeEqual(m[1], capability)) return deny(res, 404, 'not_found', 'not found');
    const route = m[2];
    if (req.method === 'GET') {
      // GET only displays: static review page and journal/inputs state. No RPC, no mutation.
      if (route === '/') return send(res, 200, html, files['/'].type);
      if (files[route]) return send(res, 200, files[route].bytes, files[route].type);
      if (route === '/api/state') return send(res, 200, service.state());
      return deny(res, 405, 'method_not_allowed', 'POST only', {allow: 'POST'});
    }
    if (req.method !== 'POST') return deny(res, 405, 'method_not_allowed', 'GET and POST only', {allow: 'GET, POST'});
    const name = /^\/api\/(prepare|report|reconcile)$/.exec(route)?.[1];
    if (!name) return deny(res, 405, 'method_not_allowed', 'GET only', {allow: 'GET'});
    if (req.headers.origin !== origin) return deny(res, 403, 'bad_origin', 'cross-origin or missing Origin');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return deny(res, 403, 'bad_origin', 'not a same-origin request');
    if (!/^application\/json(;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return deny(res, 415, 'bad_content_type', 'application/json required');
    if (!safeEqual(req.headers['x-deploy-token'], token)) return deny(res, 403, 'bad_token', 'missing or wrong page token');
    if (Number(req.headers['content-length'] ?? 0) > LIMITS.bodyMax) {
      res.on('finish', () => req.destroy());
      return deny(res, 413, 'body_too_large', `body exceeds ${LIMITS.bodyMax} bytes`, {connection: 'close'});
    }
    let body;
    try {
      body = JSON.parse((await readBody(req, LIMITS.bodyMax)).toString('utf8'));
    } catch (e) {
      if (e instanceof Refusal && e.code === 'body_too_large') { res.on('finish', () => req.destroy()); return deny(res, 413, e.code, e.message, {connection: 'close'}); }
      return deny(res, 400, 'bad_request', e instanceof Refusal ? e.message : 'body is not JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).every((k) => ROUTES[name].includes(k))) {
      return deny(res, 400, 'bad_request', `allowed keys: ${ROUTES[name].join(', ')}`);
    }
    const out = await service[name](body);
    return send(res, out.ok ? 200 : 409, out);
  };
}

export async function startServer({service, files, port = 0}) {
  const capability = crypto.randomBytes(32).toString('base64url');
  const token = crypto.randomBytes(32).toString('base64url');
  let handler = null;
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => { if (!res.headersSent) deny(res, 500, 'internal_error', 'internal error'); else res.destroy(); });
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  server.maxConnections = 16;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actual = server.address().port;
  handler = createHandler({service, files, capability, token, port: actual});
  const close = () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  return {server, port: actual, capability, token, url: `http://127.0.0.1:${actual}/${capability}/`, close};
}

const print = (x) => process.stdout.write(stable(x) + '\n');
const fail = (msg) => { process.stderr.write(`refused: ${msg}\n`); process.exitCode = 1; };

function readAuthorization(file) {
  if (!path.isAbsolute(file)) throw new Refusal('authorization_invalid', '--authorization must be an absolute path');
  try { return JSON.parse(readBoundedFile(file, 64 * 1024).toString('utf8')); } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal('authorization_invalid', 'authorization file is not JSON');
  }
}

async function main() {
  const {values} = parseArgs({strict: true, allowPositionals: false, options: {
    check: {type: 'boolean'}, 'dry-run': {type: 'boolean'}, serve: {type: 'boolean'},
    reconcile: {type: 'string'}, hash: {type: 'string'},
    'release-unknown': {type: 'string'}, 'confirm-no-pending-wallet-tx': {type: 'boolean'},
    authorization: {type: 'string'}, port: {type: 'string'},
  }});
  const modes = ['check', 'dry-run', 'serve', 'reconcile', 'release-unknown'].filter((k) => values[k] !== undefined);
  if (modes.length !== 1) return fail('choose exactly one of --check | --dry-run | --serve | --reconcile <i> [--hash 0x..] | --release-unknown <i> --confirm-no-pending-wallet-tx');
  const inputs = loadInputs({deployDir: DEPLOY_DIR, unifiedDir: UNIFIED_DIR});
  const toolDigests = computeToolDigests(HERE);
  const authorization = values.authorization ? readAuthorization(values.authorization) : null;

  if (values.check) {
    // Offline: no network, no writes.
    return print(offlineReport({inputs, toolDigests, journal: readJournal(journalFile(JOURNAL_DIR), inputs), authorization}));
  }
  const rpcs = PROVIDERS.map((u) => httpRpc(u));
  if (values['dry-run']) {
    const out = await dryRun({inputs, journalDir: JOURNAL_DIR, rpcs});
    print(out);
    if (!out.ok) process.exitCode = 1;
    return;
  }
  const service = createService({inputs, journalDir: JOURNAL_DIR, rpcs, authorization, toolDigests});
  if (values.reconcile !== undefined || values['release-unknown'] !== undefined) {
    // Root CLI; the server must be stopped (journal lock).
    try {
      const out = values.reconcile !== undefined
        ? await service.reconcile({index: Number(values.reconcile), ...(values.hash ? {hash: values.hash} : {})})
        : await service.releaseUnknown({index: Number(values['release-unknown']), confirmNoPendingWalletTx: values['confirm-no-pending-wallet-tx'] === true});
      print(out);
      if (!out.ok) process.exitCode = 1;
    } finally { service.close(); }
    return;
  }
  if (authorization) {
    const sig = service.state().signing;
    if (!sig.enabled) { service.close(); return fail(sig.reason); }
  }
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (port > 0 && port < 1024)) { service.close(); return fail('--port must be 0 or 1024..65535'); }
  let srv;
  try { srv = await startServer({service, files: loadStaticFiles(HERE), port}); } catch (e) { service.close(); throw e; }
  const sig = service.state().signing;
  process.stdout.write(`${sig.enabled ? `signing ENABLED by authorization reviewed by ${sig.reviewedBy}, notAfter ${sig.notAfter}` : sig.reason}\n`);
  process.stdout.write(`open this capability URL once, in the browser profile holding the owner wallet (do not share it):\n${srv.url}\n`);
  const stop = () => { srv.close().finally(() => { service.close(); process.exit(0); }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => fail(e instanceof Refusal ? `${e.code}: ${e.message}` : String(e?.stack ?? e)));
}
