// depot sign-in with wallets against a REAL EVM: the BUILT depot component under `wasmtime run`, a local MinIO as its
// bucket, and three JSON-RPC readers in front of a local anvil chain (eyesoff-ai/tests/helpers/evm.mjs). Honest readers
// forward to anvil, so a deployed wallet's EIP-1271 answer and the ERC-6492 validator's simulation of a wallet not
// deployed yet are EXECUTED by the EVM; the third reader lies or is down. The wallets are test contracts
// (fixtures/contract-wallet/TestWallets.sol), not a production wallet.
//
// depot maps an identity to a depot user ONLY through the owner's config (`account` / `accounts`): the test shows that,
// an existing Sign-in-with-Enclave user keeping the same depot user through a wallet the owner lists, and that wallet
// working with no SSO block at all.
//
//   DEPOT_WASM=target/wasm32-wasip2/release/depot.wasm node --test tests/wallet-evm.e2e.test.mjs
// Needs minio, wasmtime, curl, anvil, cast; everything on loopback, data under a scratch directory on disk.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

import { haveEvm, startChain, readers, personalSign, hashMessage, addressOf } from '../../eyesoff-ai/tests/helpers/evm.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const WASM = process.env.DEPOT_WASM || path.join(ROOT, 'target/wasm32-wasip2/release/depot.wasm');
const SCRATCH = process.env.DEPOT_SCRATCH || path.join(ROOT, 'target');   // on disk, not tmpfs
const have = (c, a = ['--version']) => { try { execFileSync(c, a, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !existsSync(WASM) ? `no component at ${WASM}` : !have('wasmtime') ? 'wasmtime missing' : !have('minio', ['--version']) ? 'minio missing'
  : !haveEvm ? 'anvil/cast missing' : false;

const AK = 'depotaccesskey01', SK = 'depotsecretkey0123456789', BUCKET = 'depot-wallet-e2e';
const AUD = '0x' + '11'.repeat(32), OTHER = '0x' + '22'.repeat(32);
const KEY_A = '0x' + '42'.repeat(32), KEY_B = '0x' + '43'.repeat(32), KEY_C = '0x' + '44'.repeat(32);
const SSO_SIGNER = addressOf(KEY_A);          // the platform spec's throwaway signer key
const ACCT = 'acct_0e64d1897f10b32d3a1bc84e';
const now = () => Math.floor(Date.now() / 1000);
const b64u = (b) => Buffer.from(b).toString('base64url');
const ews1 = (msg, sig) => `EWS1.${b64u(msg)}.${b64u(Buffer.from(sig.slice(2), 'hex'))}`;
const est1 = (claims) => { const p = b64u(JSON.stringify(claims)); return `EST1.${p}.${b64u(Buffer.from(personalSign(KEY_A, `EST1.${p}`).slice(2), 'hex'))}`; };
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(4000);   // past the readers' 2 confirmations at 1 block/s

let chain, minio, s3, work, deployed, counterfactual, eoa;
test.before(async () => {
  if (skip) return;
  work = mkdtempSync(path.join(SCRATCH, 'wallet-e2e-'));
  const port = await freePort();
  s3 = `http://127.0.0.1:${port}`;
  minio = spawn('minio', ['server', '--quiet', '--address', `127.0.0.1:${port}`, path.join(work, 'minio')],
    { env: { ...process.env, MINIO_ROOT_USER: AK, MINIO_ROOT_PASSWORD: SK, MINIO_BROWSER: 'off' }, stdio: 'ignore' });
  for (let i = 0; ; i++) { try { if ((await fetch(`${s3}/minio/health/ready`)).ok) break; } catch {} if (i > 150) throw new Error('minio did not come up'); await sleep(100); }
  execFileSync('curl', ['-s', '-X', 'PUT', '--aws-sigv4', 'aws:amz:us-east-1:s3', '--user', `${AK}:${SK}`, `${s3}/${BUCKET}`]);
  chain = await startChain();
  deployed = await chain.deployWallet(KEY_A, 21);
  counterfactual = await chain.predict(KEY_B, 22);
  eoa = addressOf(KEY_C);
  await settle();
});
test.after(() => { chain?.stop(); minio?.kill('SIGKILL'); if (work) rmSync(work, { recursive: true, force: true }); });

async function depot(extra) {
  const port = await freePort();
  const host = `127.0.0.1:${port}`;
  const cfg = {
    storage: { endpoint: s3, region: 'us-east-1', bucket: BUCKET, prefix: `d${port}/`, access_key: '$E2E_AK', secret_key: '$E2E_SK' },
    master_key: '$E2E_MASTER', local_test: true, title: 'depot wallet e2e',
    ...extra(host),
  };
  const env = { ...process.env, ENCLAVE_CONFIG: JSON.stringify(cfg), ENCLAVE_PORTS: `http:8000=${port}`, E2E_AK: AK, E2E_SK: SK, E2E_MASTER: 'm'.repeat(40) };
  const child = spawn('wasmtime', ['run', '-S', 'inherit-network=y', '-S', 'allow-ip-name-lookup=y',
    ...['ENCLAVE_CONFIG', 'ENCLAVE_PORTS', 'E2E_AK', 'E2E_SK', 'E2E_MASTER'].flatMap((k) => ['--env', k]), WASM], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  const base = `http://${host}`;
  for (let i = 0; ; i++) { try { if ((await fetch(`${base}/ping`)).ok) break; } catch {} if (i > 300 || child.exitCode !== null) throw new Error(`depot did not come up: ${err}`); await sleep(100); }
  const whoami = async (tok) => { const r = await fetch(`${base}/api/whoami`, { headers: tok ? { 'x-sso-token': tok } : {} }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const challenge = async (address) => {
    const nonce = 'dep' + Math.random().toString(36).slice(2, 18).padEnd(16, '0');
    const r = await fetch(`${base}/api/auth/wallet/challenge?address=${address}&nonce=${nonce}`, { headers: { host } });
    const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j.message;
  };
  return { host, whoami, challenge, stop: () => child.kill('SIGKILL') };
}

test('owner-listed EOA, deployed and counterfactual wallets become depot users; one liar or absent reader changes nothing', { skip, timeout: 300_000 }, async () => {
  const rd = await readers(chain);
  const d = await depot((host) => ({ wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets },
    users: { carol: { accounts: [`wallet_${deployed}`, `wallet_${counterfactual}`], read: ['*'] }, dave: { accounts: [`wallet_${eoa}`] } } }));
  try {
    const mE = await d.challenge(eoa), m1 = await d.challenge(deployed), m2 = await d.challenge(counterfactual);
    const tE = ews1(mE, personalSign(KEY_C, mE)), t1 = ews1(m1, personalSign(KEY_A, m1));
    const t2 = ews1(m2, chain.wrap6492(KEY_B, 22, personalSign(KEY_B, m2)));
    const c0 = rd.calls();
    assert.equal((await d.whoami(tE)).json.user, 'dave');
    assert.equal(rd.calls(), c0, 'an EOA reached the readers');
    for (const mode of ['honest', 'denies', 'reverts', 'garbage', 'approves', 'down']) {
      rd.rs[2].setMode(mode);
      assert.equal((await d.whoami(t1)).json?.user, 'carol', `${mode}: deployed`);
      assert.equal((await d.whoami(t2)).json?.user, 'carol', `${mode}: counterfactual`);
      for (const f of [ews1(m1, personalSign(KEY_B, m1)), ews1(m2, chain.wrap6492(KEY_B, 22, personalSign(KEY_C, m2)))]) {
        const r = await d.whoami(f);
        assert.ok(r.status === 401 || r.json?.signed_in === false, `${mode}: a forged contract signature became a user`);
      }
    }
    // a wallet the owner did not list signs in validly and is nobody here
    const stranger = await chain.predict(KEY_C, 23);
    const mS = await d.challenge(stranger);
    const r = await d.whoami(ews1(mS, chain.wrap6492(KEY_C, 23, personalSign(KEY_C, mS))));
    assert.ok(r.status === 401 || r.json?.signed_in === false, 'an unlisted wallet became a depot user');
    assert.equal(await chain.code(counterfactual), '0x', 'the simulation deployed nothing');
  } finally { d.stop(); rd.stop(); }
});

test('revocation and foreign contexts on a real EVM', { skip, timeout: 300_000 }, async () => {
  const rd = await readers(chain);
  const cfg = (aud) => (host) => ({ wallet: { audience: aud, domains: [host], contract_wallets: rd.contract_wallets },
    users: { carol: { accounts: [`wallet_${deployed}`, `wallet_${counterfactual}`], read: ['*'] } } });
  const d = await depot(cfg(AUD)), o = await depot(cfg(OTHER));
  try {
    const m1 = await d.challenge(deployed);
    const t1 = ews1(m1, personalSign(KEY_A, m1));
    assert.equal((await d.whoami(t1)).json.user, 'carol');
    await chain.revoke(KEY_A, deployed, hashMessage(m1));
    await settle();
    const r = await d.whoami(t1);
    assert.ok(r.status === 401 || r.json?.signed_in === false, 'a revoked signature still names carol');
    // the other deployment's valid sign-in, replayed here: refused before any reader is asked
    const mo = await o.challenge(counterfactual);
    const forOther = ews1(mo, chain.wrap6492(KEY_B, 22, personalSign(KEY_B, mo)));
    assert.equal((await o.whoami(forOther)).json.user, 'carol');
    const before = rd.calls();
    const x = await d.whoami(forOther);
    assert.ok(x.status === 401 || x.json?.signed_in === false);
    assert.equal(rd.calls(), before, 'a foreign-context token reached the readers');
  } finally { d.stop(); o.stop(); rd.stop(); }
});

test('an existing Sign-in-with-Enclave user keeps its depot user through an owner-listed wallet, with no issuer', { skip, timeout: 300_000 }, async () => {
  const rd = await readers(chain);
  const users = { alice: { account: ACCT, accounts: [`wallet_${counterfactual}`], read: ['*'] } };
  // before: the platform issuer still exists and the owner pins its signer
  const before = await depot((host) => ({ sso: { signer: SSO_SIGNER, audience: AUD }, wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, users }));
  try {
    assert.equal((await before.whoami(est1({ aud: AUD, exp: now() + 3600, iat: now(), sub: ACCT, v: 1 }))).json.user, 'alice');
  } finally { before.stop(); }
  // after: no sso block at all; the same owner config still names alice's wallet
  const after = await depot((host) => ({ wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, users }));
  try {
    const m = await after.challenge(counterfactual);
    assert.equal((await after.whoami(ews1(m, chain.wrap6492(KEY_B, 22, personalSign(KEY_B, m))))).json.user, 'alice');
    const est = await after.whoami(est1({ aud: AUD, exp: now() + 3600, iat: now(), sub: ACCT, v: 1 }));
    assert.ok(est.status === 401 || est.json?.signed_in === false, 'no issuer pinned: EST1 names nobody');
  } finally { after.stop(); rd.stop(); }
});

test('the page\'s own hand-signed path: a signer outside the browser (a counterfactual wallet) becomes the listed user', { skip, timeout: 300_000 }, async () => {
  const { readFileSync } = await import('node:fs');
  const vm = (await import('node:vm')).default;
  const rd = await readers(chain);
  const d = await depot((host) => ({ wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets },
    users: { carol: { accounts: [`wallet_${counterfactual}`], read: ['*'] } } }));
  try {
    const js = readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8');
    const a = js.indexOf('const SIG_RE = ');
    const code = js.slice(a, js.indexOf("\n// The hand-signed path's two steps", a));
    const told = [];
    const shown = [];
    const handSigner = () => ({ address: async () => counterfactual,
      sign: async (_b, _a, text) => { shown.push(text); return chain.wrap6492(KEY_B, 22, personalSign(KEY_B, text)); } });
    const base = `http://${d.host}`;
    let booted = 0;
    const ctx = vm.createContext({ me: { wallet: { audience: AUD } }, window: {}, handSigner, tell: (m, e) => told.push([String(m && m.message || m), !!e]),
      fetch: (p, o) => fetch(base + p, o), location: { host: d.host }, crypto, TextEncoder, btoa, sessionStorage: { setItem() {} },
      boot: () => { booted++; }, Uint8Array, Array, String });
    vm.runInContext(`${code}\nthis.walletStart = walletStart; this.tok = () => sso;`, ctx);
    await ctx.walletStart('hand');
    assert.deepEqual(told, []);
    assert.equal(booted, 1);
    assert.equal(shown.length, 1);
    assert.equal((await d.whoami(ctx.tok())).json.user, 'carol');
    await ctx.walletStart();
    assert.match(told.at(-1)[0], /no browser wallet/);
  } finally { d.stop(); rd.stop(); }
});
