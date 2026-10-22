// Public readback of https://<ip>/ as an arbitrary dashboard origin sees it (certificate-validated, no proxy).
//   node activation/public-readback.mjs <ip> --expect active|inactive  -> one JSON line; ok true when the expectation holds.
// active:   /v1/network/records 200 v1 with ACAO * (the control API answers 404 there), provider ids equal this host's own
//           directory (http://<ip>:8188), GET/POST preflight answered with ACAO *, the REAL DirectoryClient verifies the
//           operator-signed providers, and a POST of an invalid management record is refused by the directory (no write).
// inactive: the pre-activation state (records not served over HTTPS); only GET/OPTIONS are sent.
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const ENCLAVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../enclave');
const {DirectoryClient} = await import(pathToFileURL(path.join(ENCLAVE, 'network/directory-client.mjs')).href);
const IPS = ['134.199.235.187', '134.209.248.172', '165.245.191.129', '146.190.246.39'];
const ip = process.argv[2], expect = process.argv[process.argv.indexOf('--expect') + 1];
if (!IPS.includes(ip) || !['active', 'inactive'].includes(expect)) { console.error('usage: <ip> --expect active|inactive'); process.exit(2); }
const ORIGIN = 'https://independent-dashboard.example', base = 'https://' + ip;
const get = async (url, init = {}) => { const r = await fetch(url, {redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000), ...init});
  const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch {} return {status: r.status, acao: r.headers.get('access-control-allow-origin'), methods: r.headers.get('access-control-allow-methods'), body}; };
const out = {at: new Date().toISOString(), ip, expect, checks: {}};
const ids = s => (s?.providers || []).map(p => p.record?.record?.providerId).sort();
try {
  const rec = await get(base + '/v1/network/records', {headers: {origin: ORIGIN}});
  const own = await get(`http://${ip}:8188/v1/network/records`);
  out.checks.records = {status: rec.status, acao: rec.acao, version: rec.body?.version, providers: ids(rec.body).length, equalsOwnDirectory: JSON.stringify(ids(rec.body)) === JSON.stringify(ids(own.body))};
  const pre = await get(base + '/v1/network/providers', {method: 'OPTIONS', headers: {origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type'}});
  out.checks.preflight = {status: pre.status, acao: pre.acao, methods: pre.methods};
  const nat = await get(base + '/native/status');
  out.checks.legacyNativeStatus = {status: nat.status};
  if (expect === 'active') {
    const dc = new DirectoryClient({origins: [base]});
    const v = await dc.providers();
    out.checks.directoryClient = {verifiedProviders: v.providers.length, providerIds: v.providers.map(p => p.record.record.providerId)};
    const post = await get(base + '/v1/network/management', {method: 'POST', headers: {origin: ORIGIN, 'content-type': 'application/json'}, body: '{}'});
    out.checks.invalidPost = {status: post.status, acao: post.acao, refusedByDirectory: post.status === 400 && typeof post.body?.error === 'string'};
    out.ok = rec.status === 200 && rec.acao === '*' && rec.body?.version === 1 && out.checks.records.equalsOwnDirectory &&
      pre.status === 204 && pre.acao === '*' && pre.methods === 'GET, POST' && v.providers.length > 0 && out.checks.invalidPost.refusedByDirectory && post.acao === '*';
  } else {
    out.ok = rec.status !== 200 || rec.acao !== '*';
  }
} catch (e) { out.ok = false; out.error = String(e?.cause?.code || e?.message || e).slice(0, 300); }
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
