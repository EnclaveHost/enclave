import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openStateOf, probeAppTls, PROBE_TIMEOUT_MS } from '../site/js/core/app-tls.js';

const src = fs.readFileSync(new URL('../site/components/deployments/deployments.js', import.meta.url), 'utf8');
// Execute the real rendering function without booting the dashboard's wallet imports.
const start = src.indexOf('function openCtl(');
const end = src.indexOf('\n}', start) + 2;
const render = new Function('safeHref', 'esc', 'openStateOf', 'LOCK_OPEN', 'LOCK_SHUT',
  `${src.slice(start, end)}; return openCtl;`)(x => x, x => x, openStateOf, '[open-lock]', '[closed-lock]');
const row = { id: 'test', status: 'running', public: true };
const origin = 'https://app.example';

test('health GET verifies an app whose root never answers, without requiring CORS', async () => {
  const calls = [];
  const result = await probeAppTls(origin, { fetchFn: async (url, options) => {
    calls.push({ url, options });
    if (url !== `${origin}/healthz`) throw new TypeError('root closes');
    assert.equal(options.method, 'GET');
    assert.equal(options.mode, 'no-cors');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'follow');
    return { type: 'opaque', status: 0 };
  } });
  assert.equal(result.state, 'ok');
  assert.equal(calls.length, 1);
  assert.match(render(row, origin, { ...result, href: origin }), /\[closed-lock\]/);
});

test('apps without a health route can still verify through root HEAD', async () => {
  const calls = [];
  const result = await probeAppTls(origin, { fetchFn: async (url, { method }) => {
    calls.push([url, method]);
    if (url.endsWith('/healthz')) throw new TypeError('connection closed');
    return { type: 'opaque', status: 0 }; // Includes 401, 404, and 500: TLS still worked.
  } });
  assert.equal(result.state, 'ok');
  assert.deepEqual(calls, [[`${origin}/healthz`, 'GET'], [`${origin}/`, 'HEAD']]);
});

for (const error of [new TypeError('DNS, TLS, or connection failure'), new DOMException('timed out', 'TimeoutError')]) {
  test(`${error.name} leaves an enabled link with an original open-lock indicator`, async () => {
    const result = await probeAppTls(origin, { fetchFn: async () => { throw error; } });
    assert.equal(result.state, 'noanswer');
    const html = render(row, origin, { ...result, href: origin });
    assert.match(html, /<a /);
    assert.match(html, /no answer to a readiness check/);
    assert.match(html, /\[open-lock\]/);
    assert.doesNotMatch(html, /\[closed-lock\]|disabled|waiting for/);
  });
}

test('an old endpoint success never verifies a new endpoint', () => {
  assert.match(render(row, 'https://new.example', { state: 'ok', href: origin }), /\[open-lock\]/);
});

test('unprobed and stopped rows cannot claim a verified connection', () => {
  assert.equal(openStateOf(undefined), 'noanswer');
  assert.match(render(row, origin, undefined), /\[open-lock\]/);
  assert.equal(render({ ...row, status: 'stopped' }, origin, { state: 'ok', href: origin }), '');
});

test('HTTP endpoints are never probed or marked TLS verified', async () => {
  await assert.rejects(probeAppTls('http://app.example', { fetchFn: () => assert.fail('must not fetch') }), /require HTTPS/);
});

test('private app links still go through wallet authorization', () => {
  const html = render({ ...row, public: false }, origin, { state: 'ok', href: origin });
  assert.match(html, /href="authorize\?d=test"/);
  assert.match(html, /opens through your session or a wallet sign-in/);
});

const probeStart = src.indexOf('  async _probeTls(rows) {');
const probeEnd = src.indexOf('  /* swap Open controls', probeStart);
function dashboardWithProbe(probe) {
  const dashboard = new Function('safeHref', 'appEndpoint', 'probeAppTls',
    `return { ${src.slice(probeStart, probeEnd)} };`)(x => x, d => d.endpoint, probe);
  dashboard._fillTls = () => {};
  return dashboard;
}

test('a hanging row does not delay another row or start duplicate checks', async () => {
  let finishSlow;
  const calls = [];
  const dashboard = dashboardWithProbe(async href => {
    calls.push(href);
    if (href === origin) return new Promise(resolve => { finishSlow = resolve; });
    return { state: 'ok' };
  });
  const rows = [{ ...row, endpoint: origin }, { ...row, id: 'fast', endpoint: 'https://fast.example' }];
  const first = dashboard._probeTls(rows);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dashboard._tls.get('fast').state, 'ok');
  await dashboard._probeTls(rows);
  assert.equal(calls.length, 2);
  finishSlow({ state: 'noanswer' });
  await first;
});

test('an in-flight success cannot overwrite a new endpoint or a stopped row', async () => {
  const pending = [];
  const dashboard = dashboardWithProbe(() => new Promise(resolve => pending.push(resolve)));
  const old = dashboard._probeTls([{ ...row, endpoint: origin }]);
  const newer = dashboard._probeTls([{ ...row, endpoint: 'https://new.example' }]);
  pending[1]({ state: 'noanswer' });
  await newer;
  pending[0]({ state: 'ok' });
  await old;
  assert.equal(dashboard._tls.get(row.id).href, 'https://new.example');
  assert.equal(dashboard._tls.get(row.id).state, 'noanswer');
  const last = dashboard._probeTls([{ ...row, endpoint: origin }]);
  await dashboard._probeTls([{ ...row, status: 'stopped', endpoint: origin }]);
  pending[2]({ state: 'ok' });
  await last;
  assert.equal(dashboard._tls.has(row.id), false);
});

test('a slow but answering app verifies: the default probe waits out a busy app (6 s, like the s3-ipfs-adapter while hashing)', async () => {
  assert.ok(PROBE_TIMEOUT_MS >= 10000);
  const t0 = Date.now();
  const result = await probeAppTls(origin, { fetchFn: (url, { signal }) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ type: 'opaque', status: 0 }), 6000);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); });
  }) });
  assert.equal(result.state, 'ok');
  assert.ok(Date.now() - t0 >= 5900);
});

// A whole-VM app (catalog runtime "sev-snp-vm", Enclave RPC) has no app-zone origin: the row must not offer one.
const wholeStart = src.indexOf('export function appEndpoint(');
const wholeEnd = src.indexOf('// appEndpoint can derive from server-supplied', wholeStart);   // through appLabel
function endpointsWith(byId) {
  return new Function('Enclave', 'APP_DOMAIN', 'STORE', 'parseCatalogRef',
    `${src.slice(wholeStart, wholeEnd).replace(/export function/g, 'function')}; return { appEndpoint, isWholeVm };`)(
    { base: 'https://api.enclave.host/v1' }, 'app.enclave.host', { byId },
    ref => { const m = /^catalog:\/\/(0x[0-9a-f]{64})\/(\d+)$/.exec(String(ref || '')); return m ? { appId: m[1], index: Number(m[2]) } : null; });
}
test('a whole-VM app gets no app address, so no Open link and no probe; every other row keeps its own', () => {
  const rpcApp = '0x0f628585d36c4272ae23c55b4f9ec6d5805f25e26d4744474710e46e4edbb537';
  const release = JSON.parse(fs.readFileSync(new URL('../ops/rpc-snp-prod-r7/release-r12/release.json', import.meta.url), 'utf8'));
  const versions = [{ config: '{"runtime":"wasm"}' }, { config: 'not json' }, { config: '' }, { config: JSON.stringify(release.config) }];
  const { appEndpoint, isWholeVm } = endpointsWith({ [rpcApp]: { versions } });
  const rpc = { id: '0x5ff56a4d600191f13ac43e1c600965673555f229472846a9da201785d396454f', status: 'running', public: true,
    image: { reference: `catalog://${rpcApp}/3` } };
  assert.equal(isWholeVm(rpc.image.reference), true);
  assert.equal(appEndpoint(rpc), '');
  assert.equal(render(rpc, appEndpoint(rpc), undefined), '');
  assert.equal(appEndpoint({ ...rpc, image: undefined, appRef: rpc.image.reference }), '', 'a chain-read row names its version in appRef');
  for (const index of [0, 1, 2, 9]) {
    const other = { ...rpc, image: { reference: `catalog://${rpcApp}/${index}` } };
    assert.equal(isWholeVm(other.image.reference), false);
    assert.equal(appEndpoint(other), 'https://5ff56a4d.app.enclave.host');
  }
  assert.equal(appEndpoint({ ...rpc, image: { reference: 'ipfs://bafy' } }), 'https://5ff56a4d.app.enclave.host');
  assert.equal(endpointsWith({}).appEndpoint(rpc), 'https://5ff56a4d.app.enclave.host', 'an unloaded catalog decides nothing');
  assert.match(src, /: isWholeVm\(\(d\.image && d\.image\.reference\) \|\| d\.appRef\) \? WHOLE_VM_NOTE : ''\)/);
});
