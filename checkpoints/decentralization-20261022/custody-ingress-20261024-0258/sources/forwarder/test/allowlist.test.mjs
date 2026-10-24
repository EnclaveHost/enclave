// The forwarder's allowlist IS the reviewed custodian ingress allowlist: pinned/ingress.mjs is the byte copy of
// custody/v2/ingress.mjs at ab589bf8 (blob ebacbcc6), and its generated Caddy site is parsed here, not re-typed.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { F } from './helpers.mjs';
import { directCustodyIngress } from '../pinned/ingress.mjs';

const PIN = JSON.parse(fs.readFileSync(new URL('../pinned/PROVENANCE.json', import.meta.url)));
const gitBlob = (b) => crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

test('pinned/ingress.mjs is the reviewed ab589bf8 blob', () => {
  const bytes = fs.readFileSync(new URL('../pinned/ingress.mjs', import.meta.url));
  assert.equal(gitBlob(bytes), PIN.blob);
  assert.equal(PIN.commit, 'ab589bf80b669c9671b53573d489b6c6c45779ea');
  // when the durability repository is present, the pin still equals the commit's blob (read-only git object read)
  const repo = new URL('../../custody-v2-durability-20261023/repo', import.meta.url).pathname;
  if (fs.existsSync(repo)) {
    const blob = execFileSync('git', ['-C', repo, 'rev-parse', `${PIN.commit}:custody/v2/ingress.mjs`], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).toString().trim();
    assert.equal(blob, PIN.blob);
  }
});

function allowlistOf(caddy) {
  const pairs = new Set();
  for (const m of caddy.matchAll(/@(\w+) \{\s*method (\S+)\s*path ([^\n]+)\n\s*\}/g)) for (const p of m[3].trim().split(/\s+/)) pairs.add(`${m[2]} ${p}`);
  // only those matchers are proxied, and everything else answers 404
  const handled = [...caddy.matchAll(/handle @(\w+) \{\s*reverse_proxy 127\.0\.0\.1:(\d+)\s*\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(handled, [...caddy.matchAll(/^\s*@(\w+) \{/gm)].map((m) => m[1]).sort());
  assert.match(caddy, /handle \{\s*respond "Not found" 404\s*\}/);
  return pairs;
}

test('the forwarder allowlist equals the reviewed ingress allowlist exactly (method + path)', () => {
  const pairs = allowlistOf(directCustodyIngress({ endpoint: 'https://canary.example', mgmtPort: 18787 }));
  assert.equal(pairs.size, 12);
  assert.deepEqual([...F.ROUTES].map(([p, m]) => `${m} ${p}`).sort(), [...pairs].sort());
  for (const priv of ['/v2/custody/host-binding', '/health', '/']) assert.equal(F.ROUTES.has(priv), false);
});

test('config validation: loopback only, fixed upstream, a dedicated prefix, bounded limits', () => {
  const ok = { listen: { host: '127.0.0.1', port: 18900 }, prefix: '/custody-v2-canary/metal0', upstreamPort: 18787 };
  assert.equal(F.validateConfig(ok).maxBodyBytes, F.GUEST_MAX_BODY);
  const bad = [
    { ...ok, listen: { host: '0.0.0.0', port: 18900 } }, { ...ok, listen: { host: '192.168.1.5', port: 18900 } },
    { ...ok, listen: { host: '127.0.0.1', port: 18787 } }, { ...ok, upstreamPort: 0 }, { ...ok, upstreamPort: '18787' },
    { ...ok, upstream: 'http://evil' }, { ...ok, upstreamHost: '10.0.0.1' },
    { ...ok, prefix: '/t/custody-metal0' }, { ...ok, prefix: '/v2' }, { ...ok, prefix: '/Custody' }, { ...ok, prefix: '/a/../b' },
    { ...ok, prefix: '/a%2fb' }, { ...ok, prefix: '/a/' }, { ...ok, prefix: 'custody' }, { ...ok, prefix: '/a/b/c/d' }, { ...ok, prefix: '' },
    { ...ok, maxBodyBytes: 0 }, { ...ok, maxBodyBytes: 1e9 }, { ...ok, upstreamTimeoutMs: 0 }, { ...ok, maxInFlight: 0 },
    { ...ok, headersTimeoutMs: 5000, requestTimeoutMs: 4000 },
  ];
  for (const c of bad) assert.throws(() => F.validateConfig(c), undefined, JSON.stringify(c));
});

test('the example canary config validates and the example Caddy snippet lists exactly prefix + the 12 routes', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../examples/forwarder.canary.json', import.meta.url)));
  const v = F.validateConfig(cfg);
  const caddy = fs.readFileSync(new URL('../examples/Caddyfile.canary-snippet', import.meta.url), 'utf8');
  const pairs = new Set();
  for (const m of caddy.matchAll(/^@(custody_canary_\w+) \{\s*method (\S+)\s*path ([^\n]+)\n\s*\}/gm)) for (const p of m[3].trim().split(/\s+/)) pairs.add(`${m[2]} ${p}`);
  assert.deepEqual([...pairs].sort(), [...F.ROUTES].map(([p, m]) => `${m} ${v.prefix}${p}`).sort());
  assert.match(caddy, /handle @custody_canary_rest \{\s*respond "Not found" 404\s*\}/);
  assert.match(caddy, /max_size 262144/);
});
