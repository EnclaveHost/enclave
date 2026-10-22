// jot sign-in and account continuity with contract wallets against a REAL EVM and a REAL bucket: the built jot component
// under `wasmtime serve`, a local MinIO, and three JSON-RPC readers in front of a local anvil chain
// (eyesoff-ai/tests/helpers/evm.mjs). Honest readers forward to anvil, so a deployed wallet's EIP-1271 answer and the
// ERC-6492 validator's simulation of a wallet not deployed yet are EXECUTED by the EVM; the third reader lies or is down.
// The wallets are test contracts (eyesoff-ai/tests/fixtures/contract-wallet/TestWallets.sol), not a production wallet.
//
// jot embeds its search model at build time. The component used for the recorded run is a TEST build from a scratch
// copy with stub embedding files (no model was downloaded): search quality is irrelevant to every assertion here, and
// that component is not deployable.
//
//   JOT_WASM=/path/to/jot.wasm node --test scripts/wallet-evm.e2e.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { haveEvm, startChain, readers, personalSign, hashMessage, addressOf } from '../../eyesoff-ai/tests/helpers/evm.mjs';

const WASM = process.env.JOT_WASM || new URL('../target/wasm32-wasip2/release/jot.wasm', import.meta.url).pathname;
const SCRATCH = process.env.JOT_SCRATCH || new URL('..', import.meta.url).pathname;   // minio data on disk, not tmpfs
const have = (cmd, arg = '--version') => { try { execFileSync(cmd, [arg], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !existsSync(WASM) ? `no jot component at ${WASM}` : !have('minio') ? 'minio missing' : !have('wasmtime') ? 'wasmtime missing'
  : !haveEvm ? 'anvil/cast missing' : false;

const AUD = '0xcc1f4f3f000000000000000000000000000000000000000000000000000000aa', OTHER = '0x' + '22'.repeat(32);
const KEY_SSO = '0x' + '42'.repeat(32), KEY_A = '0x' + '46'.repeat(32), KEY_B = '0x' + '43'.repeat(32), KEY_C = '0x' + '44'.repeat(32);
const ACCT = 'acct_0e64d1897f10b32d3a1bc84e';
const AK = 'jotevmtest', SK = 'jotevmtest-secret-0123456789', BUCKET = 'notes';
const b64u = (b) => Buffer.from(b).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const est1 = (sub, iat = now(), aud = AUD) => {
  const p = b64u(JSON.stringify({ aud, exp: iat + 3600, iat, sub, v: 1 }));
  return `EST1.${p}.${b64u(Buffer.from(personalSign(KEY_SSO, `EST1.${p}`).slice(2), 'hex'))}`;
};
const ews1 = (msg, sig) => `EWS1.${b64u(msg)}.${b64u(Buffer.from(sig.slice(2), 'hex'))}`;
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(4000);   // past the readers' 2 confirmations at 1 block/s

let chain, minio, s3, work, deployed, counterfactual;
test.before(async () => {
  if (skip) return;
  work = mkdtempSync(path.join(SCRATCH, 'wallet-e2e-'));
  const port = await freePort(), cport = await freePort();
  s3 = `http://127.0.0.1:${port}`;
  minio = spawn('minio', ['server', path.join(work, 'minio'), '--address', `127.0.0.1:${port}`, '--console-address', `127.0.0.1:${cport}`, '--quiet'],
    { env: { ...process.env, MINIO_ROOT_USER: AK, MINIO_ROOT_PASSWORD: SK, MINIO_BROWSER: 'off' }, stdio: 'ignore' });
  for (let i = 0; ; i++) { try { if ((await fetch(`${s3}/minio/health/ready`)).ok) break; } catch {} if (i > 150) throw new Error('minio did not come up'); await sleep(100); }
  execFileSync('curl', ['-s', '-X', 'PUT', '--aws-sigv4', 'aws:amz:us-east-1:s3', '--user', `${AK}:${SK}`, `${s3}/${BUCKET}`]);
  chain = await startChain();
  deployed = await chain.deployWallet(KEY_A, 31);
  counterfactual = await chain.predict(KEY_B, 32);
  await settle();
});
test.after(() => { chain?.stop(); minio?.kill('SIGKILL'); if (work) rmSync(work, { recursive: true, force: true }); });

async function jot({ prefix, contract_wallets, sso = false, aud = AUD }) {
  const port = await freePort();
  const host = `127.0.0.1:${port}`;
  const cfg = {
    endpoint: s3, region: 'us-east-1', bucket: BUCKET, prefix,
    credentials: { accessKeyId: '$JOT_AK', secretAccessKey: '$JOT_SK' }, master_key: '$JOT_MASTER', link_key: '$JOT_LINK_KEY',
    ...(sso ? { sso: { signer: addressOf(KEY_SSO), audience: aud } } : {}),
    wallet: { audience: aud, domains: [host], contract_wallets },
  };
  const env = { JOT_AK: AK, JOT_SK: SK, JOT_MASTER: 'master-key-0123456789abcdef', JOT_LINK_KEY: 'link-key-one-0123456789abcdef' };
  const args = ['serve', '-Scommon', '--addr', host, '--env', `ENCLAVE_CONFIG=${JSON.stringify(cfg)}`];
  for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`);
  const p = spawn('wasmtime', [...args, WASM], { stdio: 'ignore' });
  const base = `http://${host}`;
  for (let i = 0; ; i++) { try { if ((await fetch(`${base}/ping`)).ok) break; } catch {} if (i > 150) throw new Error('jot did not come up'); await sleep(100); }
  const call = async (method, p, { token, body } = {}) => {
    const h = { 'content-type': 'application/json' };
    if (token) h['x-sso-token'] = token;
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  const challenge = async (address) => {
    const nonce = 'jotevm' + Math.random().toString(36).slice(2, 14).padEnd(12, '0');
    const c = await call('GET', `/api/auth/wallet/challenge?address=${address}&nonce=${nonce}`);
    assert.equal(c.status, 200, c.text);
    return c.json.message;
  };
  const you = async (token) => (await call('GET', '/api/status', { token })).json?.you;
  return { host, base, call, challenge, you, stop: () => p.kill('SIGKILL') };
}

test('EOA, deployed and counterfactual wallets open their own notebooks; one liar or absent reader changes nothing', { skip, timeout: 300_000 }, async () => {
  const rd = await readers(chain);
  const j = await jot({ prefix: 'n1/', contract_wallets: rd.contract_wallets });
  try {
    const eoa = addressOf(KEY_C);
    const mE = await j.challenge(eoa), m1 = await j.challenge(deployed), m2 = await j.challenge(counterfactual);
    const tE = ews1(mE, personalSign(KEY_C, mE)), t1 = ews1(m1, personalSign(KEY_A, m1));
    const t2 = ews1(m2, chain.wrap6492(KEY_B, 32, personalSign(KEY_B, m2)));
    const c0 = rd.calls();
    assert.deepEqual(await j.you(tE), { sub: `wallet_${eoa}`, via: 'wallet' });
    assert.equal(rd.calls(), c0, 'an EOA reached the readers');
    // each identity writes a sealed note; the others cannot read it
    assert.equal((await j.call('PUT', '/api/notes/mine.md', { token: t2, body: { content: 'counterfactual wallet note' } })).status, 200);
    assert.equal((await j.call('GET', '/api/notes/mine.md', { token: t1 })).status, 404, 'another wallet read the note');
    for (const mode of ['honest', 'denies', 'reverts', 'garbage', 'approves', 'down']) {
      rd.rs[2].setMode(mode);
      assert.deepEqual(await j.you(t1), { sub: `wallet_${deployed}`, via: 'wallet' }, `${mode}: deployed`);
      assert.deepEqual(await j.you(t2), { sub: `wallet_${counterfactual}`, via: 'wallet' }, `${mode}: counterfactual`);
      const forged = ews1(m2, chain.wrap6492(KEY_B, 32, personalSign(KEY_C, m2)));
      assert.equal((await j.call('GET', '/api/notes/mine.md', { token: forged })).status, 401, `${mode}: a forged signature read the note`);
    }
    rd.rs[2].setMode('honest');
    assert.equal(JSON.parse((await j.call('GET', '/api/notes/mine.md', { token: t2 })).text).content ?? 'ok', 'counterfactual wallet note');
    assert.equal(await chain.code(counterfactual), '0x', 'the simulation deployed nothing');
  } finally { j.stop(); rd.stop(); }
});

test('revocation and foreign contexts on a real EVM', { skip, timeout: 300_000 }, async () => {
  const rd = await readers(chain);
  const j = await jot({ prefix: 'n2/', contract_wallets: rd.contract_wallets });
  const o = await jot({ prefix: 'n2o/', contract_wallets: rd.contract_wallets, aud: OTHER });
  try {
    const m1 = await j.challenge(deployed);
    const t1 = ews1(m1, personalSign(KEY_A, m1));
    assert.equal((await j.you(t1))?.sub, `wallet_${deployed}`);
    await chain.revoke(KEY_A, deployed, hashMessage(m1));
    await settle();
    assert.equal((await j.call('GET', '/api/notes', { token: t1 })).status, 401, 'a revoked signature still opened the notebook');
    const mo = await o.challenge(counterfactual);
    const forOther = ews1(mo, chain.wrap6492(KEY_B, 32, personalSign(KEY_B, mo)));
    assert.equal((await o.you(forOther))?.sub, `wallet_${counterfactual}`);
    const before = rd.calls();
    assert.equal((await j.call('GET', '/api/notes', { token: forOther })).status, 401);
    assert.equal(rd.calls(), before, 'a foreign-context token reached the readers');
  } finally { j.stop(); o.stop(); rd.stop(); }
});

test('an existing account moves to a counterfactual wallet once, then reads its sealed notes with no issuer', { skip, timeout: 300_000 }, async () => {
  const rd = await readers(chain);
  const w = await chain.predict(KEY_C, 33);
  // 1. while the issuer exists: the account's existing note, then the one-time link (fresh EST1 + the wallet's link signature)
  const before = await jot({ prefix: 'n3/', contract_wallets: rd.contract_wallets, sso: true });
  let m;
  try {
    const est = est1(ACCT);
    assert.equal((await before.call('PUT', '/api/notes/plans.md', { token: est, body: { content: 'the account secret' } })).status, 200);
    const nonce = 'jotlnk' + Math.random().toString(36).slice(2, 14).padEnd(12, '0');
    const c = await before.call('POST', '/api/link/challenge', { token: est, body: { address: w, nonce } });
    assert.equal(c.status, 200, c.text);
    const made = await before.call('POST', '/api/link', { token: est, body: { wallet: ews1(c.json.message, chain.wrap6492(KEY_C, 33, personalSign(KEY_C, c.json.message))) } });
    assert.equal(made.status, 200, made.text);
  } finally { before.stop(); }
  // 2. the issuer is gone: no sso block. The wallet (still not deployed) opens the ACCOUNT's notebook through the link
  const after = await jot({ prefix: 'n3/', contract_wallets: rd.contract_wallets });
  try {
    m = await after.challenge(w);
    const sess = ews1(m, chain.wrap6492(KEY_C, 33, personalSign(KEY_C, m)));
    assert.deepEqual(await after.you(sess), { sub: ACCT, via: 'wallet-link' });
    const note = await after.call('GET', '/api/notes/plans.md', { token: sess });
    assert.equal(note.status, 200, note.text);
    assert.match(note.text, /the account secret/);
    assert.equal((await after.call('GET', '/api/notes', { token: est1(ACCT) })).status, 401, 'no issuer pinned: EST1 opens nothing');
    // 3. the wallet is deployed and its owner revokes this session's message: the notebook closes to it
    await chain.deployWallet(KEY_C, 33);
    await chain.revoke(KEY_C, w, hashMessage(m));
    await settle();
    assert.equal((await after.call('GET', '/api/notes/plans.md', { token: sess })).status, 401);
  } finally { after.stop(); rd.stop(); }
});

test('the page\'s own hand-signed path: a signer outside the browser (a counterfactual wallet) signs in', { skip, timeout: 300_000 }, async () => {
  const rd = await readers(chain);
  const j = await jot({ prefix: 'n4/', contract_wallets: rd.contract_wallets });
  try {
    const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
    const a = html.indexOf('const SIG_RE = ');
    const code = html.slice(a, html.indexOf("\n// The hand-signed path's two steps", a));
    const shown = [], err = { textContent: '' };
    const handSigner = () => ({ address: async () => counterfactual,
      sign: async (_b, _a, text) => { shown.push(text); return chain.wrap6492(KEY_B, 32, personalSign(KEY_B, text)); } });
    const api = async (method, p) => { const r = await j.call(method, p); if (r.status !== 200) throw new Error(r.text); return r.json; };
    const ctx = vm.createContext({ $: (s) => (s === '#ssoerr' ? err : null), status: { wallet: { aud: AUD } }, window: {}, api, handSigner,
      location: { host: j.host }, crypto, TextEncoder, btoa, SSO_KEY: 'jot-sso', sessionStorage: { setItem() {} }, localStorage: { setItem() {} },
      loadStatus: async () => {}, refresh: async () => {}, fresh: () => {}, Uint8Array, Array, String });
    vm.runInContext(`${code}\nthis.walletStart = walletStart; this.tok = () => ssoToken;`, ctx);
    await ctx.walletStart('hand');
    assert.equal(err.textContent, '', err.textContent);
    assert.equal(shown.length, 1);
    assert.deepEqual(await j.you(ctx.tok()), { sub: `wallet_${counterfactual}`, via: 'wallet' });
    await ctx.walletStart();
    assert.match(err.textContent, /No browser wallet/);
  } finally { j.stop(); rd.stop(); }
});
