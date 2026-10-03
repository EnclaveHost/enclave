import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openStateOf, probeAppTls } from '../site/js/core/app-tls.js';

const src = fs.readFileSync(new URL('../site/components/deployments/deployments.js', import.meta.url), 'utf8');
// Execute the real rendering function without booting the dashboard's wallet imports.
const start = src.indexOf('function openCtl(');
const end = src.indexOf('\n}', start) + 2;
const render = new Function('safeHref', 'esc', 'openStateOf', 'TLS_UNKNOWN', 'LOCK_SHUT',
  `${src.slice(start, end)}; return openCtl;`)(x => x, x => x, openStateOf, '[question]', '[closed-lock]');
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
  test(`${error.name} leaves an enabled link with an unknown indicator`, async () => {
    const result = await probeAppTls(origin, { fetchFn: async () => { throw error; } });
    assert.equal(result.state, 'noanswer');
    const html = render(row, origin, { ...result, href: origin });
    assert.match(html, /<a /);
    assert.match(html, /TLS status unknown/);
    assert.match(html, /\[question\]/);
    assert.doesNotMatch(html, /\[closed-lock\]|disabled|waiting for/);
  });
}

test('an old endpoint success never verifies a new endpoint', () => {
  assert.match(render(row, 'https://new.example', { state: 'ok', href: origin }), /\[question\]/);
});

test('unprobed and stopped rows cannot claim a verified connection', () => {
  assert.equal(openStateOf(undefined), 'noanswer');
  assert.match(render(row, origin, undefined), /\[question\]/);
  assert.equal(render({ ...row, status: 'stopped' }, origin, { state: 'ok', href: origin }), '');
});

test('HTTP endpoints are never probed or marked TLS verified', async () => {
  await assert.rejects(probeAppTls('http://app.example', { fetchFn: () => assert.fail('must not fetch') }), /require HTTPS/);
});

test('private app links still go through wallet authorization', () => {
  const html = render({ ...row, public: false }, origin, { state: 'ok', href: origin });
  assert.match(html, /href="authorize\?d=test"/);
  assert.match(html, /sign in with your wallet/);
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
