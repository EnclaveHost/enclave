// Account links over a REAL S3 transport: the built jot component under `wasmtime serve`, talking SigV4 to a local
// minio through a recording proxy that logs every request jot makes. Proves, end to end and with nothing simulated
// between jot and the bucket:
//
//   - the conditional headers jot actually sends: `If-None-Match: *` creating a link record, `If-Match: <etag>`
//     replacing an unauthenticated one; and that this minio HONOURS both (412 for a create over an existing key and for
//     a stale If-Match);
//   - the storage operator cannot forge a link: both reciprocal records written straight into the bucket (unsigned, or
//     MAC'd under the operator's own key) do not let the operator's wallet read the victim's SEALED notes;
//   - a legitimate link (fresh Enclave sign-in + the wallet's link signature) lets that wallet read the account's
//     existing notes, survives a component restart with the same link key, goes inert under another key, and cannot
//     be relinked to another account or wallet.
//
// Needs: minio, wasmtime and cast on PATH, and a jot component. JOT_WASM picks the component (default: this crate's
// release build). The run recorded in the app-auth parity report used a TEST build compiled in a scratch copy with stub
// embedding files (search quality is irrelevant here; it is not a deployable artifact). Skips when anything is missing.
//
//   JOT_WASM=/path/to/jot.wasm node --test scripts/link-minio.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const WASM = process.env.JOT_WASM || new URL('../target/wasm32-wasip2/release/jot.wasm', import.meta.url).pathname;
const have = (cmd, arg = '--version') => { try { execFileSync(cmd, [arg], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !existsSync(WASM) ? `no jot component at ${WASM}` : !have('minio') ? 'minio missing' : !have('wasmtime') ? 'wasmtime missing' : !have('cast') ? 'cast missing' : false;

const AUD = '0xcc1f4f3f000000000000000000000000000000000000000000000000000000aa';
const KEY_SSO = '0x' + '42'.repeat(32);   // the pinned platform SSO signer in this config
const KEY_W = '0x' + '43'.repeat(32);     // the victim's own wallet, linked legitimately
const KEY_X = '0x' + '44'.repeat(32);     // the storage operator's wallet
const KEY_Y = '0x' + '45'.repeat(32);     // another wallet
const A = 'acct_0e64d1897f10b32d3a1bc84e', A2 = 'acct_99aa11bb22cc33dd44ee55ff';
const AK = 'jotlinktest', SK = 'jotlinktest-secret-0123456789';
const BUCKET = 'notes', PREFIX = 'notes/';
const LINK_KEY_1 = 'link-key-one-0123456789abcdef', LINK_KEY_2 = 'link-key-two-0123456789abcdef';

const sign = (key, msg) => execFileSync('cast', ['wallet', 'sign', '--private-key', key, msg], { encoding: 'utf8' }).trim();
const addr = (key) => execFileSync('cast', ['wallet', 'address', '--private-key', key], { encoding: 'utf8' }).trim().toLowerCase();
const b64u = (b) => Buffer.from(b).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const est1 = (sub, iat = now()) => {
  const p = b64u(JSON.stringify({ aud: AUD, exp: iat + 3600, iat, sub, v: 1 }));
  return `EST1.${p}.${b64u(Buffer.from(sign(KEY_SSO, `EST1.${p}`).slice(2), 'hex'))}`;
};
const ews1 = (msg, sig) => `EWS1.${b64u(msg)}.${b64u(Buffer.from(sig.slice(2), 'hex'))}`;
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, m) => crypto.createHmac('sha256', k).update(m).digest();

// ---- a raw SigV4 client: the storage operator's own hands on the bucket -----------------------------------------
function s3(port, method, key, { body = Buffer.alloc(0), headers = {} } = {}) {
  const host = `127.0.0.1:${port}`;
  const p = `/${BUCKET}${key ? '/' + key.split('/').map(encodeURIComponent).join('/') : ''}`;
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amz.slice(0, 8);
  const h = { host, 'x-amz-content-sha256': sha(body), 'x-amz-date': amz };
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const names = Object.keys(h).sort();
  const canon = [method, p, '', names.map((k) => `${k}:${String(h[k]).trim()}\n`).join(''), names.join(';'), h['x-amz-content-sha256']].join('\n');
  const scope = `${date}/us-east-1/s3/aws4_request`;
  let k = hmac('AWS4' + SK, date); k = hmac(k, 'us-east-1'); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(k, ['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n')).toString('hex')}`;
  return new Promise((ok, no) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { ...h, 'content-length': body.length } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => ok({ status: res.statusCode, etag: res.headers.etag, body: Buffer.concat(chunks) }));
    });
    r.on('error', no); r.end(body);
  });
}

// the link-record MAC as jot computes it, under a key of the caller's choosing (the operator's, below)
function forgedRecord(secret, dir, account, wallet, at = 1) {
  const key = hmac(crypto.createHash('sha256').update(secret).digest(), 'jot-link-v1:mac');
  const fields = ['jot-link-record-v2', dir, AUD, BUCKET, PREFIX, account, wallet, String(at)];
  const msg = Buffer.concat(fields.flatMap((f) => { const b = Buffer.from(f); const l = Buffer.alloc(8); l.writeBigUInt64BE(BigInt(b.length)); return [l, b]; }));
  return JSON.stringify({ v: 2, dir, account, wallet, aud: AUD, at, mac: crypto.createHmac('sha256', key).update(msg).digest('hex') });
}

async function startMinio() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jot-minio-'));
  const port = await freePort(), cport = await freePort();
  const p = spawn('minio', ['server', dir, '--address', `127.0.0.1:${port}`, '--console-address', `127.0.0.1:${cport}`, '--quiet'],
    { env: { ...process.env, MINIO_ROOT_USER: AK, MINIO_ROOT_PASSWORD: SK, MINIO_BROWSER: 'off' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await s3(port, 'GET', '')).status < 500) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, stop: () => { p.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); } };
}

// a transparent recording proxy: jot -> proxy -> minio, Host passed through so SigV4 still verifies
async function startProxy(target) {
  const log = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const up = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: req.headers }, (r) => {
        log.push({ method: req.method, path: decodeURIComponent(req.url), ifNoneMatch: req.headers['if-none-match'], ifMatch: req.headers['if-match'], status: r.statusCode });
        res.writeHead(r.statusCode, r.headers); r.pipe(res);
      });
      up.on('error', () => { res.writeHead(502); res.end(); });
      up.end(Buffer.concat(chunks));
    });
  });
  const port = await freePort();
  await new Promise((ok) => srv.listen(port, '127.0.0.1', ok));
  return { port, log, stop: () => srv.close() };
}

async function startJot(s3port, linkKey) {
  const port = await freePort();
  const host = `127.0.0.1:${port}`;
  const cfg = {
    endpoint: `http://127.0.0.1:${s3port}`, region: 'us-east-1', bucket: BUCKET, prefix: PREFIX,
    credentials: { accessKeyId: '$JOT_AK', secretAccessKey: '$JOT_SK' }, api_key: '$JOT_API_KEY', master_key: '$JOT_MASTER',
    link_key: '$JOT_LINK_KEY',
    sso: { signer: addr(KEY_SSO), audience: AUD },
    wallet: { audience: AUD, domains: [host] },
  };
  const env = { JOT_AK: AK, JOT_SK: SK, JOT_API_KEY: 'api-key-0123456789', JOT_MASTER: 'master-key-0123456789abcdef', JOT_LINK_KEY: linkKey };
  const args = ['serve', '-Scommon', '--addr', host, '--env', `ENCLAVE_CONFIG=${JSON.stringify(cfg)}`];
  for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`);
  const p = spawn('wasmtime', [...args, WASM], { stdio: 'ignore' });
  const base = `http://${host}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/ping`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const call = async (method, p, { token, body } = {}) => {
    const h = { 'content-type': 'application/json' };
    if (token) h['x-sso-token'] = token;
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  return { host, call, stop: () => p.kill('SIGKILL') };
}

async function walletSession(j, key) {
  const nonce = 'jotsess' + Math.random().toString(36).slice(2, 14).padEnd(12, '0');
  const c = await j.call('GET', `/api/auth/wallet/challenge?address=${addr(key)}&nonce=${nonce}`);
  assert.equal(c.status, 200, c.text);
  return ews1(c.json.message, sign(key, c.json.message));
}
async function link(j, key, est) {
  const nonce = 'jotlink' + Math.random().toString(36).slice(2, 14).padEnd(12, '0');
  const c = await j.call('POST', '/api/link/challenge', { token: est, body: { address: addr(key), nonce } });
  if (c.status !== 200) return c;
  return j.call('POST', '/api/link', { token: est, body: { wallet: ews1(c.json.message, sign(key, c.json.message)) } });
}

const step = (n) => { if (process.env.JOT_LINK_DEBUG) console.error('step', n); };
test('account links over a real S3 transport: authenticated, conditional, restart-safe, unforgeable', { skip, timeout: 180_000 }, async () => {
  const m = await startMinio();
  const px = await startProxy(m.port);
  let j;
  try {
    assert.equal((await s3(m.port, 'PUT', '')).status, 200, 'bucket created');
    j = await startJot(px.port, LINK_KEY_1);
    const W = `wallet_${addr(KEY_W)}`, X = `wallet_${addr(KEY_X)}`;

    // the victim's account writes a note; at rest it is sealed
    step(0); const put = await j.call('PUT', '/api/notes/plans.md', { token: est1(A), body: { content: 'the victim secret' } });
    assert.equal(put.status, 200, put.text);
    step(1); const raw = await s3(m.port, 'GET', `${PREFIX}users/${A}/plans.md`);
    assert.equal(raw.status, 200);
    assert.equal(raw.body.subarray(0, 4).toString(), 'JOT1', 'sealed at rest');
    assert.ok(!raw.body.includes(Buffer.from('victim secret')));

    // THE STORAGE OPERATOR forges both reciprocal records mapping its wallet X to the victim's account:
    // first unsigned (the old shape), then MAC'd under a key of its own choosing
    step(2); for (const [wb, ab] of [
      [JSON.stringify({ v: 1, account: A, wallet: X, aud: AUD, at: 1 }), JSON.stringify({ v: 1, account: A, wallet: X, aud: AUD, at: 1 })],
      [forgedRecord('the-operators-own-secret-0123', 'wallet', A, X), forgedRecord('the-operators-own-secret-0123', 'account', A, X)],
    ]) {
      assert.equal((await s3(m.port, 'PUT', `${PREFIX}.jot/links/wallet/${X}`, { body: Buffer.from(wb) })).status, 200);
      assert.equal((await s3(m.port, 'PUT', `${PREFIX}.jot/links/account/${A}`, { body: Buffer.from(ab) })).status, 200);
      const xs = await walletSession(j, KEY_X);
      const st = await j.call('GET', '/api/status', { token: xs });
      assert.deepEqual(st.json.you, { sub: X, via: 'wallet' }, 'the forged map named nobody else');
      assert.equal((await j.call('GET', '/api/notes/plans.md', { token: xs })).status, 404, 'the victim note is not reachable');
      const list = await j.call('GET', '/api/notes', { token: xs });
      assert.deepEqual(list.json.notes, []);
    }

    // a LEGITIMATE link for the victim's own wallet W: the account slot holds the operator's forged record, which is
    // not an authority and is replaced at its exact ETag; the empty wallet slot is created only-if-absent
    step(3); px.log.length = 0;
    const made = await link(j, KEY_W, est1(A));
    assert.equal(made.status, 200, made.text);
    const puts = px.log.filter((e) => e.method === 'PUT' && e.path.includes('/.jot/links/'));
    const wput = puts.find((e) => e.path.endsWith(`/wallet/${W}`));
    const aput = puts.find((e) => e.path.endsWith(`/account/${A}`));
    assert.equal(wput.ifNoneMatch, '*', 'the wallet record is created only if absent');
    assert.equal(wput.status, 200);
    assert.ok(aput.ifMatch && aput.ifMatch.replace(/"/g, '').length > 0, 'the forged account record is replaced at its ETag');
    assert.equal(aput.status, 200);

    step(4); const ws = await walletSession(j, KEY_W);
    assert.deepEqual((await j.call('GET', '/api/status', { token: ws })).json.you, { sub: A, via: 'wallet-link' });
    const got = await j.call('GET', '/api/notes/plans.md', { token: ws });
    assert.equal(got.status, 200, got.text);
    assert.equal(got.json.content, 'the victim secret', 'the account\'s existing sealed note, opened through the link');
    // the operator's wallet still reaches nothing
    assert.equal((await j.call('GET', '/api/notes/plans.md', { token: await walletSession(j, KEY_X) })).status, 404);

    step(5); // no relink, either side
    assert.equal((await link(j, KEY_W, est1(A2))).status, 409);
    assert.equal((await link(j, KEY_Y, est1(A))).status, 409);
    // a stale sign-in is no account proof
    assert.equal((await link(j, KEY_Y, est1(A2, now() - 3600))).status, 401);

    step(6); // this minio HONOURS the conditions jot relies on
    const wkey = `${PREFIX}.jot/links/wallet/${W}`;
    assert.equal((await s3(m.port, 'PUT', wkey, { body: Buffer.from('x'), headers: { 'if-none-match': '*' } })).status, 412);
    assert.equal((await s3(m.port, 'PUT', wkey, { body: Buffer.from('x'), headers: { 'if-match': '"00000000000000000000000000000000"' } })).status, 412);

    step(7); // restart with the same link key: the link holds
    j.stop();
    j = await startJot(px.port, LINK_KEY_1);
    assert.deepEqual((await j.call('GET', '/api/status', { token: await walletSession(j, KEY_W) })).json.you, { sub: A, via: 'wallet-link' });
    // restart under ANOTHER link key: the records are not believed, the wallet is only itself
    j.stop();
    j = await startJot(px.port, LINK_KEY_2);
    const w2 = await walletSession(j, KEY_W);
    assert.deepEqual((await j.call('GET', '/api/status', { token: w2 })).json.you, { sub: W, via: 'wallet' });
    assert.equal((await j.call('GET', '/api/notes/plans.md', { token: w2 })).status, 404);
    // and back: the original key, the original link
    j.stop();
    j = await startJot(px.port, LINK_KEY_1);
    const w3 = await walletSession(j, KEY_W);
    assert.equal((await j.call('GET', '/api/notes/plans.md', { token: w3 })).json.content, 'the victim secret');
    // nothing was ever deleted from the link namespace
    assert.equal(px.log.filter((e) => e.method === 'DELETE').length, 0);
  } finally {
    if (j) j.stop();
    px.stop();
    m.stop();
  }
});
