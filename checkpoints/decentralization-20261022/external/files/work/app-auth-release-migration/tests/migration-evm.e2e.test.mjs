// EAB1 account migration, end to end, on the CANDIDATE components (eyesoff-ai and jot with candidate/apply.py) against a
// REAL EVM (local anvil, the test wallets of enclave-apps/eyesoff-ai/tests/fixtures/contract-wallet) and, for jot, a REAL
// bucket (local MinIO). Every key and account here is synthetic; the account store is generated in the relay's exact
// shape (relay/auth.js: {accounts: {acct_…: {id, wallets, passkeys}}, byWallet, byCredential}).
//
// The story: BEFORE cutover the issuer exists (EST1) and the account has data (a sealed jot note; an EyesOff API key).
// AT cutover the operator runs tools/eab1.mjs on the store; the platform key signs the statement; the owner pins it and
// sets sso.until. AFTER cutover no EST1 counts; a user with the migration file and a wallet the account had signs a link,
// and the old data and keys are theirs again - with no issuer anywhere.
//
//   EYESOFF_WASM=… JOT_WASM=… node --test tests/migration-evm.e2e.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

const WO = '/home/steven/Documents/Codex/2026-10-18/wo/work';
const MIG = `${WO}/app-auth-release-migration`;
const { haveEvm, startChain, readers, personalSign, hashMessage, addressOf } = await import(`${WO}/enclave-apps/eyesoff-ai/tests/helpers/evm.mjs`);
const T = await import(`${MIG}/tools/eab1.mjs`);
const EYESOFF = process.env.EYESOFF_WASM, JOT = process.env.JOT_WASM;
const have = (c, a = '--version') => { try { execFileSync(c, [a], { stdio: 'ignore' }); return true; } catch { return false; } };
// each app's tests run when ITS candidate component is given (EYESOFF_WASM / JOT_WASM)
const skip = !have('minio') || !have('wasmtime') ? 'minio/wasmtime missing' : !haveEvm ? 'anvil/cast missing' : false;
const skipJot = skip || (!JOT || !existsSync(JOT) ? 'JOT_WASM (the candidate component) missing' : false);
const skipEyes = skip || (!EYESOFF || !existsSync(EYESOFF) ? 'EYESOFF_WASM (the candidate component) missing' : false);

const AUD = '0xcc1f4f3f000000000000000000000000000000000000000000000000000000aa';
const KEY_SSO = '0x' + '42'.repeat(32);                        // the (test) platform key: EST1 and the snapshot statement
const KEY_EOA = '0x' + '51'.repeat(32), KEY_DEP = '0x' + '52'.repeat(32), KEY_CF = '0x' + '53'.repeat(32), KEY_X = '0x' + '5f'.repeat(32), KEY_NEW = '0x' + '54'.repeat(32);
const A_EOA = 'acct_0e64d1897f10b32d3a1bc84e', A_DEP = 'acct_1b2c3d4e5f60718293a4b5c6', A_CF = 'acct_2c3d4e5f60718293a4b5c6d7', A_PK = 'acct_3d4e5f60718293a4b5c6d7e8';
const SEED = 's33d-0f1e2d3c4b5a69788796a5b4c3d2e1f0', AK = 'migtest', SK = 'migtest-secret-0123456789', BUCKET = 'notes';
const b64u = (b) => Buffer.from(b).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const est1 = (sub, { iat = now(), exp = iat + 3600 } = {}) => { const p = b64u(JSON.stringify({ aud: AUD, exp, iat, sub, v: 1 }));
  return `EST1.${p}.${b64u(Buffer.from(personalSign(KEY_SSO, `EST1.${p}`).slice(2), 'hex'))}`; };
const ews1 = (msg, sig) => `EWS1.${b64u(msg)}.${b64u(Buffer.from(sig.slice(2), 'hex'))}`;
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(4000);
const tool = (...a) => execFileSync(process.execPath, [`${MIG}/tools/eab1.mjs`, ...a], { encoding: 'utf8' });

let chain, rd, minio, s3, work, W = {}, snap, statementFile, pin;
const stops = [];
test.before(async () => {
  if (skip) return;
  work = mkdtempSync(path.join(MIG, 'scratch', 'mig-e2e-'));
  const port = await freePort();
  s3 = `http://127.0.0.1:${port}`;
  minio = spawn('minio', ['server', path.join(work, 'minio'), '--address', `127.0.0.1:${port}`, '--console-address', `127.0.0.1:${await freePort()}`, '--quiet'],
    { env: { ...process.env, MINIO_ROOT_USER: AK, MINIO_ROOT_PASSWORD: SK, MINIO_BROWSER: 'off' }, stdio: 'ignore' });
  for (let i = 0; ; i++) { try { if ((await fetch(`${s3}/minio/health/ready`)).ok) break; } catch {} if (i > 150) throw new Error('minio did not come up'); await sleep(100); }
  execFileSync('curl', ['-s', '-X', 'PUT', '--aws-sigv4', 'aws:amz:us-east-1:s3', '--user', `${AK}:${SK}`, `${s3}/${BUCKET}`]);
  chain = await startChain();
  rd = await readers(chain);
  W.eoa = addressOf(KEY_EOA);
  W.dep = await chain.deployWallet(KEY_DEP, 61);          // a deployed contract wallet the relay knew (SIWE via EIP-1271)
  W.cf = await chain.predict(KEY_CF, 62);                 // a counterfactual one (SIWE via EIP-6492), never deployed
  await settle();
  // the relay's account store, in its exact shape
  const pk = { credId: 'Y3JlZC1pZC1wYXNza2V5LTE', pubX: '0x' + '11'.repeat(32), pubY: '0x' + '22'.repeat(32), publicKey: 'x', counter: 0 };
  const acct = (id, wallets, passkeys = []) => ({ id, createdAt: '2026-01-01T00:00:00Z', userHandle: 'u', wallets, passkeys });
  const store = { accounts: { [A_EOA]: acct(A_EOA, [W.eoa], [pk]), [A_DEP]: acct(A_DEP, [W.dep]), [A_CF]: acct(A_CF, [W.cf]),
                              [A_PK]: acct(A_PK, [], [{ ...pk, credId: 'cGFzc2tleS1vbmx5' }]) }, byCredential: {}, byWallet: {} };
  writeFileSync(path.join(work, 'accounts.json'), JSON.stringify(store));
  // CUTOVER: the operator's one act, the platform key's one signature, the owner's pin
  snap = JSON.parse(tool('snapshot', '--accounts', path.join(work, 'accounts.json'), '--cutover', 'enclave-e2e-cutover', '--out', path.join(work, 'cut')));
  statementFile = path.join(work, 'cut', 'statement.json');
  const st = JSON.parse(readFileSync(statementFile, 'utf8'));
  tool('attach', '--statement', statementFile, '--signature', personalSign(KEY_SSO, st.text), '--signer', addressOf(KEY_SSO));
  pin = JSON.parse(tool('config', '--statement', statementFile)).migration;
});
test.after(() => { for (const s of stops.reverse()) { try { s(); } catch {} } rd?.stop(); chain?.stop(); minio?.kill('SIGKILL'); if (work) rmSync(work, { recursive: true, force: true }); });

const bundle = (acct) => readFileSync(path.join(work, 'cut', 'bundles', `${acct}.json`), 'utf8').trim();
const cred = (acct) => T.credential(bundle(acct));

async function serveComponent(wasm, cfg, envs = {}) {
  const port = await freePort(), host = `127.0.0.1:${port}`;
  const args = ['serve', '-Scommon', '-Snn', '--addr', host, '--env', `ENCLAVE_CONFIG=${JSON.stringify(cfg(host))}`];
  for (const [k, v] of Object.entries(envs)) args.push('--env', `${k}=${v}`);
  const p = spawn('wasmtime', [...args, wasm], { stdio: 'ignore' });
  stops.push(() => p.kill('SIGKILL'));
  const base = `http://${host}`;
  for (let i = 0; ; i++) { try { if ((await fetch(`${base}/ping`)).ok) break; } catch {} if (i > 200) throw new Error('component did not come up'); await sleep(100); }
  const call = async (method, p, { headers = {}, body } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  return { host, base, call, stop: () => p.kill('SIGKILL') };
}
// a wallet's link signature over the deployment's challenge (a 6492 wrapper for the counterfactual one)
const signFor = (key, which, msg) => (which === 'cf' ? chain.wrap6492(KEY_CF, 62, personalSign(KEY_CF, msg)) : personalSign(key, msg));

// ---------------------------------------------------------------- jot ----------------------------------------------
const jotEnv = { JOT_AK: AK, JOT_SK: SK, JOT_MASTER: 'master-key-0123456789abcdef', JOT_LINK_KEY: 'link-key-one-0123456789abcdef' };
const jotCfg = ({ cut, prefix }) => (host) => ({
  endpoint: s3, region: 'us-east-1', bucket: BUCKET, prefix,
  credentials: { accessKeyId: '$JOT_AK', secretAccessKey: '$JOT_SK' }, master_key: '$JOT_MASTER', link_key: '$JOT_LINK_KEY',
  sso: { signer: addressOf(KEY_SSO), audience: AUD, ...(cut ? { until: now() - 1 } : {}) },
  wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets },
  ...(cut ? { migration: pin } : {}),
});
async function jotWallet(j, key, which, address) {
  const nonce = 'mig' + Math.random().toString(36).slice(2, 18).padEnd(16, '0');
  const c = await j.call('GET', `/api/auth/wallet/challenge?address=${address}&nonce=${nonce}`);
  assert.equal(c.status, 200, c.text);
  return ews1(c.json.message, signFor(key, which, c.json.message));
}
async function jotMigrate(j, acct, key, which, address) {
  const nonce = 'mig' + Math.random().toString(36).slice(2, 18).padEnd(16, '0');
  const c = await j.call('POST', '/api/link/challenge', { body: { address, nonce, account: cred(acct) } });
  if (c.status !== 200) return { stage: 'challenge', ...c };
  return { msg: c.json.message, ...(await j.call('POST', '/api/link', { body: { account: cred(acct), wallet: ews1(c.json.message, signFor(key, which, c.json.message)) } })) };
}

test('jot: every committed wallet kind restores its account\'s sealed notebook after cutover, with no issuer', { skip: skipJot, timeout: 600_000 }, async () => {
  const prefix = 'j1/';
  // BEFORE: three accounts write sealed notes while the issuer exists
  const before = await serveComponent(JOT, jotCfg({ cut: false, prefix }), jotEnv);
  for (const a of [A_EOA, A_DEP, A_CF]) {
    const r = await before.call('PUT', '/api/notes/plans.md', { headers: { 'x-sso-token': est1(a) }, body: { content: `secret of ${a}` } });
    assert.equal(r.status, 200, r.text);
  }
  before.stop();
  // AFTER: sso.until passed, migration pinned
  const j = await serveComponent(JOT, jotCfg({ cut: true, prefix }), jotEnv);
  const st = await j.call('GET', '/api/status');
  assert.equal(st.json.wallet.migration, 'enclave-e2e-cutover');
  // the issuer's authority is over: a fresh, validly signed EST1 opens nothing and proves no account
  const lateEst = est1(A_EOA);
  assert.equal((await j.call('GET', '/api/notes', { headers: { 'x-sso-token': lateEst } })).status, 401, 'post-cutoff EST1 opened the notebook');
  const lc = await j.call('POST', '/api/link/challenge', { headers: { 'x-sso-token': lateEst }, body: { address: addressOf(KEY_X), nonce: 'latelatelate0001' } });
  assert.equal(lc.status, 401, 'post-cutoff EST1 proved an account for a link');
  // each wallet kind migrates its own account and reads the note sealed before cutover
  for (const [acct, key, which, address] of [[A_EOA, KEY_EOA, 'eoa', W.eoa], [A_DEP, KEY_DEP, 'dep', W.dep], [A_CF, KEY_CF, 'cf', W.cf]]) {
    const m = await jotMigrate(j, acct, key, which, address);
    assert.equal(m.status, 200, `${which}: ${m.text}`);
    const sess = await jotWallet(j, key, which, address);
    const st2 = await j.call('GET', '/api/status', { headers: { 'x-sso-token': sess } });
    assert.deepEqual(st2.json.you, { sub: acct, via: 'wallet-link' }, which);
    const note = await j.call('GET', '/api/notes/plans.md', { headers: { 'x-sso-token': sess } });
    assert.equal(note.status, 200, note.text);
    assert.match(note.text, new RegExp(`secret of ${acct}`));
  }
  assert.equal(await chain.code(W.cf), '0x', 'nothing was deployed for the counterfactual wallet');
  j.stop();
  // RESTART with the same keys: the links hold
  const again = await serveComponent(JOT, jotCfg({ cut: true, prefix }), jotEnv);
  const sess = await jotWallet(again, KEY_EOA, 'eoa', W.eoa);
  assert.deepEqual((await again.call('GET', '/api/status', { headers: { 'x-sso-token': sess } })).json.you, { sub: A_EOA, via: 'wallet-link' });
  // TRANSFER is not offered by jot: the account is linked, so a second wallet is refused (no relink, as before migration)
  const second = await jotMigrate(again, A_EOA, KEY_EOA, 'eoa', W.eoa);
  assert.ok(second.status === 409 || second.status === 200, `replaying the same link is harmless: ${second.text}`);
  again.stop();
});

test('jot: wrong wallets, corrupted and forged files, other cutovers and a former issuer\'s new snapshot are refused', { skip: skipJot, timeout: 600_000 }, async () => {
  const prefix = 'j2/';
  const before = await serveComponent(JOT, jotCfg({ cut: false, prefix }), jotEnv);
  assert.equal((await before.call('PUT', '/api/notes/plans.md', { headers: { 'x-sso-token': est1(A_EOA) }, body: { content: 'victim secret' } })).status, 200);
  before.stop();
  const j = await serveComponent(JOT, jotCfg({ cut: true, prefix }), jotEnv);
  // a wallet the account did not have: refused at the challenge...
  const wrong = await jotMigrate(j, A_EOA, KEY_X, 'eoa', addressOf(KEY_X));
  assert.equal(wrong.status, 401); assert.equal(wrong.stage, 'challenge');
  assert.match(wrong.json.error.message, /not one the account migration file commits/);
  // ...and at the link, when the attacker builds the link message themself and signs it with their own wallet
  const good = await j.call('POST', '/api/link/challenge', { body: { address: W.eoa, nonce: 'craftedcrafted01', account: cred(A_EOA) } });
  assert.equal(good.status, 200, good.text);
  const lines = good.json.message.split('\n');
  lines[1] = execFileSync('cast', ['to-check-sum-address', addressOf(KEY_X)], { encoding: 'utf8' }).trim();
  const crafted = lines.join('\n');
  const r = await j.call('POST', '/api/link', { body: { account: cred(A_EOA), wallet: ews1(crafted, personalSign(KEY_X, crafted)) } });
  assert.equal(r.status, 401, 'a crafted link signed by a wallet the account never had was accepted');
  // another account's bundle with this wallet
  assert.equal((await jotMigrate(j, A_DEP, KEY_EOA, 'eoa', W.eoa)).status, 401);
  // corrupted bundles: a flipped path byte, an edited account, a truncated file, a different salt
  const raw = JSON.parse(bundle(A_EOA));
  const mutate = (f) => { const b = structuredClone(raw); f(b); return T.credential(JSON.stringify(b)); };
  for (const [what, bad] of [
    ['a flipped path node', mutate((b) => { b.credentials[0].path[0] = b.credentials[0].path[0].replace(/.$/, (c) => (c === '0' ? '1' : '0')); })],
    ['another account', mutate((b) => { b.account = A_DEP; })],
    ['another salt', mutate((b) => { b.salt = '0x' + '77'.repeat(32); })],
    ['a truncated file', cred(A_EOA).slice(0, 200)],
  ]) {
    const c = await j.call('POST', '/api/link/challenge', { body: { address: W.eoa, nonce: 'corruptcorrupt01', account: bad } });
    assert.equal(c.status, 401, `${what} was accepted`);
  }
  // a FORMER ISSUER after cutover builds its own snapshot binding the victim's account to its wallet: not the pinned root
  writeFileSync(path.join(work, 'evil.json'), JSON.stringify({ accounts: { [A_EOA]: { id: A_EOA, wallets: [addressOf(KEY_X)], passkeys: [] } } }));
  tool('snapshot', '--accounts', path.join(work, 'evil.json'), '--cutover', 'enclave-e2e-cutover', '--out', path.join(work, 'evil'));
  const evil = T.credential(readFileSync(path.join(work, 'evil', 'bundles', `${A_EOA}.json`), 'utf8'));
  const e = await j.call('POST', '/api/link/challenge', { body: { address: addressOf(KEY_X), nonce: 'formerissuer0001', account: evil } });
  assert.equal(e.status, 401);
  assert.match(e.json.error.message, /another snapshot root/);
  // ...nor can it mint a late EST1 for the victim (sso.until), so the victim's sealed note stays shut to it
  const xs = await jotWallet(j, KEY_X, 'eoa', addressOf(KEY_X));
  assert.equal((await j.call('GET', '/api/notes/plans.md', { headers: { 'x-sso-token': xs } })).status, 404);
  j.stop();
});

test('jot: resume after a failed attempt, and revocation of a migrated contract wallet', { skip: skipJot, timeout: 600_000 }, async () => {
  const prefix = 'j3/';
  const before = await serveComponent(JOT, jotCfg({ cut: false, prefix }), jotEnv);
  assert.equal((await before.call('PUT', '/api/notes/plans.md', { headers: { 'x-sso-token': est1(A_DEP) }, body: { content: 'dep secret' } })).status, 200);
  before.stop();
  const j = await serveComponent(JOT, jotCfg({ cut: true, prefix }), jotEnv);
  // attempt 1: the reader quorum is unavailable (two readers down): refused, nothing written
  rd.rs[1].setMode('denies'); rd.rs[2].setMode('denies');
  const failed = await jotMigrate(j, A_DEP, KEY_DEP, 'dep', W.dep);
  assert.equal(failed.status, 401, failed.text);
  rd.rs[1].setMode('honest'); rd.rs[2].setMode('honest');
  // attempt 2: resumes cleanly
  const ok = await jotMigrate(j, A_DEP, KEY_DEP, 'dep', W.dep);
  assert.equal(ok.status, 200, ok.text);
  const nonce = 'revk' + Math.random().toString(36).slice(2, 18).padEnd(16, '0');
  const c = await j.call('GET', `/api/auth/wallet/challenge?address=${W.dep}&nonce=${nonce}`);
  const sess = ews1(c.json.message, personalSign(KEY_DEP, c.json.message));
  assert.equal((await j.call('GET', '/api/notes/plans.md', { headers: { 'x-sso-token': sess } })).status, 200);
  // the wallet's owner revokes that session on chain: the account's notebook closes to it on the next request
  await chain.revoke(KEY_DEP, W.dep, hashMessage(c.json.message));
  await settle();
  assert.equal((await j.call('GET', '/api/notes/plans.md', { headers: { 'x-sso-token': sess } })).status, 401);
  j.stop();
});

// ------------------------------------------------------------- EyesOff ---------------------------------------------
const eyesCfg = ({ cut }) => (host) => ({
  sso: { signer: addressOf(KEY_SSO), audience: AUD, ...(cut ? { until: now() - 1 } : {}) },
  wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, api_key_seed: SEED,
  ...(cut ? { migration: pin } : {}),
});
async function eyesSession(s, key, which, address) {
  const nonce = 'eye' + Math.random().toString(36).slice(2, 18).padEnd(16, '0');
  const c = await s.call('GET', `/auth/wallet/challenge?address=${address}&nonce=${nonce}`);
  assert.equal(c.status, 200, c.text);
  return ews1(c.json.message, signFor(key, which, c.json.message));
}
async function eyesLink(s, accountProof, key, which, address) {
  const nonce = 'eyl' + Math.random().toString(36).slice(2, 18).padEnd(16, '0');
  const c = await s.call('POST', '/auth/link/challenge', { body: { address, nonce, account: accountProof } });
  if (c.status !== 200) return { stage: 'challenge', ...c };
  return s.call('POST', '/auth/link', { body: { account: accountProof, wallet: ews1(c.json.message, signFor(key, which, c.json.message)) } });
}
const keysAs = (s, token, link) => s.call('POST', '/v1/keys', { headers: { authorization: `Bearer ${token}`, ...(link ? { 'x-enclave-link': link } : {}) } });

test('EyesOff: a migrated wallet acts as the account with its old API key; transfer to a new wallet through that key', { skip: skipEyes, timeout: 600_000 }, async () => {
  const before = await serveComponent(EYESOFF, eyesCfg({ cut: false }));
  const keys = {};
  for (const a of [A_EOA, A_DEP, A_CF]) keys[a] = (await keysAs(before, est1(a))).json.key;
  before.stop();
  const s = await serveComponent(EYESOFF, eyesCfg({ cut: true }));
  const models = await s.call('GET', '/models');
  assert.equal(models.json.auth.wallet.migration, 'enclave-e2e-cutover');
  assert.equal((await keysAs(s, est1(A_EOA))).status, 401, 'post-cutoff EST1 still signs in');
  assert.equal((await eyesLink(s, est1(A_EOA), KEY_X, 'eoa', addressOf(KEY_X))).status, 401, 'post-cutoff EST1 proved an account');
  for (const [acct, key, which, address] of [[A_EOA, KEY_EOA, 'eoa', W.eoa], [A_DEP, KEY_DEP, 'dep', W.dep], [A_CF, KEY_CF, 'cf', W.cf]]) {
    const l = await eyesLink(s, cred(acct), key, which, address);
    assert.equal(l.status, 200, `${which}: ${l.text}`);
    assert.equal(l.json.account, acct);
    const sess = await eyesSession(s, key, which, address);
    const k = await keysAs(s, sess, l.json.link);
    assert.equal(k.status, 200, k.text);
    assert.equal(k.json.sub, acct);
    assert.equal(k.json.key, keys[acct], `${which}: the account's existing API key`);
  }
  // wrong wallet: refused at the challenge, and a crafted link signed by it is refused at the link
  assert.equal((await eyesLink(s, cred(A_EOA), KEY_X, 'eoa', addressOf(KEY_X))).status, 401);
  const c = await s.call('POST', '/auth/link/challenge', { body: { address: W.eoa, nonce: 'craftedcrafted02', account: cred(A_EOA) } });
  const lines = c.json.message.split('\n');
  lines[1] = execFileSync('cast', ['to-check-sum-address', addressOf(KEY_X)], { encoding: 'utf8' }).trim();
  const crafted = lines.join('\n');
  assert.equal((await s.call('POST', '/auth/link', { body: { account: cred(A_EOA), wallet: ews1(crafted, personalSign(KEY_X, crafted)) } })).status, 401);
  // TRANSFER: having migrated, the account holder moves to a NEW wallet with the account's own API key (EAK1), as any
  // EyesOff account can - the migration file is not needed again and is never the only way back
  const nl = await eyesLink(s, keys[A_EOA], KEY_NEW, 'eoa', addressOf(KEY_NEW));
  assert.equal(nl.status, 200, nl.text);
  const ns = await eyesSession(s, KEY_NEW, 'eoa', addressOf(KEY_NEW));
  assert.equal((await keysAs(s, ns, nl.json.link)).json.key, keys[A_EOA]);
  // a former issuer's new snapshot is not the pinned root
  writeFileSync(path.join(work, 'evil2.json'), JSON.stringify({ accounts: { [A_EOA]: { id: A_EOA, wallets: [addressOf(KEY_X)], passkeys: [] } } }));
  tool('snapshot', '--accounts', path.join(work, 'evil2.json'), '--cutover', 'enclave-e2e-cutover', '--out', path.join(work, 'evil2'));
  const evil = T.credential(readFileSync(path.join(work, 'evil2', 'bundles', `${A_EOA}.json`), 'utf8'));
  const e = await eyesLink(s, evil, KEY_X, 'eoa', addressOf(KEY_X));
  assert.equal(e.status, 401); assert.match(e.json.error.message, /another snapshot root/);
  // a passkey-only account is committed; it proves through its passkey vault only where the owner ALSO pins the vault
  // factory (migration.vault_factory; tests/passkey-recovery.mjs) - this deployment's pin has none, so it says exactly that
  const pk = await s.call('POST', '/auth/link/challenge', { body: { address: W.eoa, nonce: 'passkeyonly00001', account: cred(A_PK) } });
  assert.equal(pk.status, 401); assert.match(pk.json.error.message, /pins no passkey-vault factory/);
  // a deployment that pins no snapshot honours no migration file
  const none = await serveComponent(EYESOFF, (host) => ({ wallet: { audience: AUD, domains: [host] }, api_key_seed: SEED }));
  const n = await none.call('POST', '/auth/link/challenge', { body: { address: W.eoa, nonce: 'nosnapshot000001', account: cred(A_EOA) } });
  assert.equal(n.status, 401); assert.match(n.json.error.message, /honours no account migration snapshot/);
  none.stop(); s.stop();
});

test('the snapshot leaks no mapping, and the tool refuses an inconsistent store', { skip, timeout: 60_000 }, async () => {
  const st = JSON.parse(readFileSync(statementFile, 'utf8'));
  const pub = JSON.stringify(st);
  for (const secret of [A_EOA, A_DEP, A_CF, W.eoa, W.dep, W.cf]) assert.ok(!pub.includes(secret), 'the public statement names an account or wallet');
  assert.deepEqual(Object.keys(st).sort(), ['accounts', 'cutover', 'issued_at', 'leaves', 'root', 'signature', 'signer', 'text', 'v']);
  assert.equal(snap.accounts, 4); assert.equal(snap.passkey_only, 1);
  assert.equal((readFileSync(path.join(work, 'cut', 'bundles', `${A_EOA}.json`)).length > 0), true);
  // an owner verifies the statement and a bundle with the tool before pinning / before listing a depot user
  assert.match(tool('verify-statement', '--statement', statementFile, '--signer', addressOf(KEY_SSO)), /signed by/);
  assert.match(tool('verify', '--statement', statementFile, '--bundle', path.join(work, 'cut', 'bundles', `${A_DEP}.json`), '--wallet', W.dep), /"depot_accounts_entry":"wallet_0x/);
  assert.throws(() => tool('verify', '--statement', statementFile, '--bundle', path.join(work, 'cut', 'bundles', `${A_DEP}.json`), '--wallet', W.eoa));
  writeFileSync(path.join(work, 'dup.json'), JSON.stringify({ accounts: { [A_EOA]: { id: A_EOA, wallets: [W.eoa] }, [A_DEP]: { id: A_DEP, wallets: [W.eoa] } } }));
  assert.throws(() => tool('snapshot', '--accounts', path.join(work, 'dup.json'), '--cutover', 'x', '--out', path.join(work, 'dup')), /two accounts|Command failed/);
});
