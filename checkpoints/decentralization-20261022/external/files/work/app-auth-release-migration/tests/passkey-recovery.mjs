// PASSKEY-ONLY account recovery, end to end in a REAL browser against a REAL EVM, on the candidate app component(s):
//   - Chromium's virtual WebAuthn authenticator (CDP) holds the account's passkeys, on RP "localhost"; every assertion
//     below is a genuine WebAuthn assertion made by the browser for the page's own origin;
//   - the vault is the PRODUCTION credit-vault source (contracts/EnclaveCreditVault.sol @ d36100ae, byte-identical to the
//     live factory per passkey/production-factory.json), compiled with the deploy settings and deployed on a local anvil
//     with the RIP-7212 P-256 precompile (--network optimism), its pinned origin set to the signer page's local origin;
//   - the signer page is passkey/recover (the candidate static page for the site), using the site's own /vendor/aa.js;
//   - the app pins the snapshot and the factory, and checks the vault's ERC-1271 / ERC-6492 answer through two honest
//     readers and a third that lies.
// The account store is synthetic, in the relay's shape. Production differs only by origin (https://enclave.host) and the
// factory/implementation addresses (recover-config.production.json).
//   ONLY=jot JOT_WASM=… [EYESOFF_WASM=…] node tests/passkey-recovery.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const WO = '/home/steven/Documents/Codex/2026-10-18/wo/work', MIG = `${WO}/app-auth-release-migration`;
const viem = await import(`${WO}/enclave/node_modules/viem/_esm/index.js`);
const { chromium } = await import(`${WO}/enclave/node_modules/playwright/index.mjs`);
const { readers, personalSign, addressOf } = await import(`${WO}/enclave-apps/eyesoff-ai/tests/helpers/evm.mjs`);
const T = await import(`${MIG}/tools/eab1.mjs`);
const VAULT = JSON.parse(fs.readFileSync(`${MIG}/passkey/fixtures/credit-vault-d36100ae.json`, 'utf8'));
const ONLY = process.env.ONLY || '', JOT = process.env.JOT_WASM, EYESOFF = process.env.EYESOFF_WASM;
const AUD = '0xcc1f4f3f000000000000000000000000000000000000000000000000000000aa';
const KEY_SSO = '0x' + '42'.repeat(32), KEY_W = '0x' + '71'.repeat(32);
const A_PK = 'acct_6a70718293a4b5c6d7e8f901', A_W = 'acct_7b8192a3b4c5d6e7f8091a2b';
const AK = 'pkrecovery', SK = 'pkrecovery-secret-0123456789';
const b64u = (b) => Buffer.from(b).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const est1 = (sub) => { const p = b64u(JSON.stringify({ aud: AUD, exp: now() + 3600, iat: now(), sub, v: 1 }));
  return `EST1.${p}.${b64u(Buffer.from(personalSign(KEY_SSO, `EST1.${p}`).slice(2), 'hex'))}`; };
const ews1 = (msg, sigHex) => `EWS1.${b64u(msg)}.${b64u(Buffer.from(sigHex.slice(2), 'hex'))}`;
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = async (u) => { for (let i = 0; ; i++) { try { if ((await fetch(u)).ok) return; } catch {} if (i > 200) throw new Error(`no answer from ${u}`); await sleep(100); } };
const tool = (...a) => execFileSync(process.execPath, [`${MIG}/tools/eab1.mjs`, ...a], { encoding: 'utf8' });
const results = [];
const check = (name, cond, detail = '') => { assert.ok(cond, `${name} ${detail}`); results.push(name); console.log(`PASS ${name}`); };

const stops = [];
process.on('exit', () => { for (const s of stops.reverse()) { try { s(); } catch {} } });
const work = fs.mkdtempSync(path.join(MIG, 'scratch', 'passkey-'));
stops.push(() => fs.rmSync(work, { recursive: true, force: true }));

// ---- chain: anvil with the P-256 precompile (Base has RIP-7212) ----------------------------------------------------
const cport = await freePort(), chainUrl = `http://127.0.0.1:${cport}`;
const anvil = spawn('anvil', ['--port', String(cport), '--chain-id', '8453', '--block-time', '1', '--network', 'optimism', '--silent'], { stdio: 'ignore' });
stops.push(() => anvil.kill('SIGKILL'));
const pc = viem.createPublicClient({ transport: viem.http(chainUrl) });
for (let i = 0; ; i++) { try { await pc.getChainId(); break; } catch { if (i > 100) throw new Error('anvil'); await sleep(100); } }
const [from] = await pc.request({ method: 'eth_accounts' });
const send = async (tx) => { const h = await pc.request({ method: 'eth_sendTransaction', params: [{ from, gas: '0x7a1200', ...tx }] });
  for (;;) { const rc = await pc.request({ method: 'eth_getTransactionReceipt', params: [h] }); if (rc) { if (rc.status !== '0x1') throw new Error('reverted'); return rc; } await sleep(200); } };
const settle = () => sleep(4000);   // readers judge 2 confirmations back at 1 block/s

// ---- the signer page, on its own origin (the vault's pinned origin), and a second origin it must NOT work from ----
const SITE_VENDOR = `${WO}/enclave/site/vendor/aa.js`;
async function staticSite(config) {
  const port = await freePort(), origin = `http://localhost:${port}`;
  const files = { '/recover/': `${MIG}/passkey/recover/index.html`, '/recover/index.html': `${MIG}/passkey/recover/index.html`,
    '/recover/recover.js': `${MIG}/passkey/recover/recover.js`, '/vendor/aa.js': SITE_VENDOR };
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, origin).pathname;
    if (p === '/recover/recover-config.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ...config(origin) })); }
    const f = files[p]; if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'text/javascript' }); res.end(fs.readFileSync(f));
  });
  await new Promise((ok) => srv.listen(port, '127.0.0.1', ok));
  stops.push(() => srv.close());
  return { origin, port };
}
let factory, implementation;
const siteCfg = (origin) => ({ origin, rpId: 'localhost', factory, implementation });
const site = await staticSite(siteCfg), other = await staticSite(siteCfg);

// the PRODUCTION-source factory, its pinned origin = the signer page's origin
const dep = await send({ data: viem.encodeDeployData({ abi: VAULT.factory.abi, bytecode: VAULT.factory.bytecode,
  args: ['0x' + '01'.repeat(20), '0x' + '02'.repeat(20), '0x' + '03'.repeat(20), site.origin, ''] }) });
factory = dep.contractAddress.toLowerCase();
implementation = (await pc.readContract({ address: factory, abi: VAULT.factory.abi, functionName: 'implementation' })).toLowerCase();

// ---- passkeys: P-256 keys the virtual authenticator holds (the browser signs with them; we never do) ---------------
function passkey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }), id = crypto.randomBytes(16);
  return { credId: b64u(id), idB64: id.toString('base64'), pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
           x: '0x' + Buffer.from(jwk.x, 'base64url').toString('hex'), y: '0x' + Buffer.from(jwk.y, 'base64url').toString('hex') };
}
const K1 = passkey(), K2 = passkey(), K3 = passkey();          // K1, K2: the account's (committed); K3: someone else's
const vaultOf = (k) => T.vaultFor(factory, implementation, k.x, k.y);
const V1 = vaultOf(K1), V2 = vaultOf(K2), V3 = vaultOf(K3);
check('the tool, the page and the factory agree on the vault address', V1 === (await pc.readContract({ address: factory, abi: VAULT.factory.abi, functionName: 'vaultFor', args: [BigInt(K1.x), BigInt(K1.y)] })).toLowerCase());

// ---- the cutover: a synthetic relay store, the operator's snapshot, the platform key's statement, the owner's pin ---
const pk = (k) => ({ credId: k.credId, pubX: k.x, pubY: k.y, publicKey: 'cose', counter: 0 });
fs.writeFileSync(path.join(work, 'accounts.json'), JSON.stringify({ accounts: {
  [A_PK]: { id: A_PK, wallets: [], passkeys: [pk(K1), pk(K2)] },                           // passkey-only, two devices
  [A_W]: { id: A_W, wallets: [addressOf(KEY_W)], passkeys: [] },                          // a wallet account beside it
  'acct_8c92a3b4c5d6e7f8091a2b3c': { id: 'acct_8c92a3b4c5d6e7f8091a2b3c', wallets: [], passkeys: [] } } }));   // no credential
const snapOut = JSON.parse(tool('snapshot', '--accounts', path.join(work, 'accounts.json'), '--cutover', 'enclave-passkey-cutover', '--out', path.join(work, 'cut')));
check('an account with no credential at all is reported, not committed; the passkey-only one is committed', snapOut.no_credential === 1 && snapOut.accounts === 2 && snapOut.passkey_only === 1);
const stFile = path.join(work, 'cut', 'statement.json');
tool('attach', '--statement', stFile, '--signature', personalSign(KEY_SSO, JSON.parse(fs.readFileSync(stFile, 'utf8')).text), '--signer', addressOf(KEY_SSO));
const pin = JSON.parse(tool('config', '--statement', stFile, '--vault-factory', factory, '--vault-implementation', implementation)).migration;
const bundleFile = path.join(work, 'cut', 'bundles', `${A_PK}.json`), cred = T.credential(fs.readFileSync(bundleFile, 'utf8').trim());
check('the tool derives the passkey-only account\'s addresses from its committed passkeys',
  JSON.stringify(JSON.parse(tool('vault', '--bundle', bundleFile, '--vault-factory', factory, '--vault-implementation', implementation)).map((v) => v.vault)) === JSON.stringify([V1, V2]));

const rd = await readers({ url: chainUrl }, 'denies');        // two honest readers and one that says "no" to everything
stops.push(() => rd.stop());
await settle();

// ---- the browser: the signer tab holds a virtual authenticator with the account's passkeys and a stranger's -------
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM || '/usr/sbin/chromium' });
stops.push(() => browser.close());
const ctx = await browser.newContext();
const signer = await ctx.newPage();
const cdp = await ctx.newCDPSession(signer);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
  hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
for (const k of [K1, K2, K3]) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: k.idB64, isResidentCredential: false,
  rpId: 'localhost', privateKey: k.pkcs8, signCount: 0 } });

/** The person's steps on the signer page: open it, load the file, choose the passkey -> the address it shows. */
async function openOnPage(origin, keyIndex = 0) {
  await signer.goto(`${origin}/recover/`);
  await signer.setInputFiles('#file', bundleFile);
  await signer.waitForSelector('#step2', { state: 'visible' });
  await signer.selectOption('#key', String(keyIndex));
  return (await signer.textContent('#vault')).trim();
}
/** … then paste the app's message and sign with the passkey. */
async function signOnPage(origin, message, keyIndex = 0) {
  await openOnPage(origin, keyIndex);
  await signer.fill('#message', message);
  await signer.click('#sign');
  await signer.waitForFunction(() => document.querySelector('#signature').value.length > 0 || /bad/.test(document.querySelector('#note').className), null, { timeout: 30000 });
  return { signature: await signer.inputValue('#signature'), note: await signer.textContent('#note'), shown: await signer.textContent('#vault') };
}
/** An assertion the page itself would never build (another key, another vault, another factory call): made with the
 *  same vendored signer, in the signer tab, at `origin` - what an attacker holding THAT key could produce. */
async function rawAssertion(origin, message, key, asVault, createFor = key) {
  if (!signer.url().startsWith(origin)) await signer.goto(`${origin}/recover/`);
  return signer.evaluate(async ({ message, key, asVault, createFor, factory }) => {
    const L = await import('/vendor/aa.js');
    const b = new TextEncoder().encode(message);
    const challenge = L.keccak256(L.concat([L.toHex(new TextEncoder().encode(`\x19Ethereum Signed Message:\n${b.length}`)), L.toHex(b)]));
    const a = await L.WebAuthnP256.sign({ challenge, credentialId: key.credId, rpId: 'localhost', userVerification: 'required' });
    const SIG = { type: 'tuple', components: ['bytes authenticatorData', 'string clientDataJSON', 'uint256 r', 'uint256 s', 'uint256 x', 'uint256 y'].map((s) => { const [type, name] = s.split(' '); return { type, name }; }) };
    const inner = L.encodeAbiParameters([SIG], [{ authenticatorData: a.metadata.authenticatorData, clientDataJSON: a.metadata.clientDataJSON, r: a.signature.r, s: a.signature.s, x: BigInt(key.x), y: BigInt(key.y) }]);
    if (!asVault) return inner;
    const deploy = L.encodeFunctionData({ abi: [{ type: 'function', name: 'createVault', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [{ type: 'address' }], stateMutability: 'nonpayable' }], functionName: 'createVault', args: [BigInt(createFor.x), BigInt(createFor.y)] });
    return L.concat([L.encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }], [factory, deploy, inner]), '0x' + '6492'.repeat(16)]);
  }, { message, key, asVault, createFor, factory });
}

// ---- the apps ------------------------------------------------------------------------------------------------------
async function serve(wasm, cfg, envs = {}) {
  const port = await freePort(), host = `127.0.0.1:${port}`;
  const args = ['serve', '-Scommon', '-Snn', '--addr', host, '--env', `ENCLAVE_CONFIG=${JSON.stringify(cfg(host))}`];
  for (const [k, v] of Object.entries(envs)) args.push('--env', `${k}=${v}`);
  const p = spawn('wasmtime', [...args, wasm], { stdio: 'ignore' });
  stops.push(() => p.kill('SIGKILL'));
  await up(`http://${host}/ping`);
  const call = async (method, p2, { headers = {}, body } = {}) => { const r = await fetch(`http://${host}${p2}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; };
  return { host, base: `http://${host}`, call, stop: () => p.kill('SIGKILL') };
}

// ---- EyesOff (runs first: it leaves the vault undeployed and K1 active for jot below) ------------------------------
const SEED = 's33d-0f1e2d3c4b5a69788796a5b4c3d2e1f0';
if (ONLY !== 'jot') {
  const cfg = (cut) => (host) => ({ sso: { signer: addressOf(KEY_SSO), audience: AUD, ...(cut ? { until: now() - 1 } : {}) },
    wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, api_key_seed: SEED, ...(cut ? { migration: pin } : {}) });
  const before = await serve(EYESOFF, cfg(false));
  const oldKey = (await before.call('POST', '/v1/keys', { headers: { authorization: `Bearer ${est1(A_PK)}` } })).json.key;
  check('eyesoff: before cutover the passkey-only account has its API key', typeof oldKey === 'string' && oldKey.length > 16, String(oldKey));
  before.stop();
  const s = await serve(EYESOFF, cfg(true));
  const challenge = async (address, account) => s.call('POST', '/auth/link/challenge', { body: { address, nonce: 'ek' + crypto.randomBytes(9).toString('hex'), account } });
  const link = (message, signature) => s.call('POST', '/auth/link', { body: { account: cred, wallet: ews1(message, signature) } });
  check('eyesoff: a post-cutoff EST1 opens nothing', (await s.call('POST', '/v1/keys', { headers: { authorization: `Bearer ${est1(A_PK)}` } })).status === 401);
  const c3 = await challenge(V3, cred);
  check('eyesoff: a vault derived from a passkey the account never had is refused at the challenge', c3.status === 401 && /not one the account migration file commits/.test(c3.text), c3.text);
  const c1 = await challenge(V1, cred);
  assert.equal(c1.status, 200, c1.text);
  check('eyesoff: a passkey that is not the account\'s cannot sign as its vault', (await link(c1.json.message, await rawAssertion(site.origin, c1.json.message, K3, true, K1))).status === 401);
  check('eyesoff: the account\'s own passkey signing from another origin is refused by the vault', (await link(c1.json.message, await rawAssertion(other.origin, c1.json.message, K1, true))).status === 401);
  check('eyesoff: an ERC-6492 wrapper that deploys a different vault is refused', (await link(c1.json.message, await rawAssertion(site.origin, c1.json.message, K3, true, K3))).status === 401);
  // THE RECOVERY through the app's own pages: sign in (the gate) as the passkey's vault, then restore the account
  const page = await ctx.newPage();
  const handSign = async () => {   // the app's "another signer" dialog <-> the signer page
    await page.waitForSelector('#signerAddr', { state: 'visible', timeout: 20000 });
    await page.fill('#signerAddr', await openOnPage(site.origin, 0));
    await page.click('#signerNext');
    await page.waitForFunction(() => document.querySelector('#signerMsg').value.length > 0, null, { timeout: 30000 });
    const signed = await signOnPage(site.origin, await page.inputValue('#signerMsg'), 0);
    assert.ok(signed.signature, signed.note);
    await page.fill('#signerSig', signed.signature);
    await page.click('#signerDone');
  };
  await page.goto(`${s.base}/`);
  await page.waitForSelector('#walletOther', { state: 'visible', timeout: 20000 });
  await page.click('#walletOther');
  await handSign();
  await page.waitForFunction(() => (localStorage.getItem('llmchat-sso') || '').startsWith('EWS1.'), null, { timeout: 60000 });
  check('eyesoff: the passkey signs in at the gate as its vault address (signer page, real WebAuthn)', true);
  await page.click('#apiBtn');
  await page.waitForSelector('#migrateRow', { state: 'visible', timeout: 20000 });
  await page.setInputFiles('#migrateFile', bundleFile);       // a passkey-only file goes to the hand-signed path
  await handSign();
  await page.waitForFunction(() => /^Linked: wallet/.test(document.querySelector('#linkNote').textContent), null, { timeout: 60000 });
  const lk = await page.evaluate(() => JSON.parse(localStorage.getItem('llmchat-link')));
  check('eyesoff: the passkey-only account is restored from its file, linked to its vault', lk.account === A_PK, JSON.stringify(lk));
  const tok = await page.evaluate(() => localStorage.getItem('llmchat-sso'));
  const k = await s.call('POST', '/v1/keys', { headers: { authorization: `Bearer ${tok}`, 'x-enclave-link': lk.link } });
  check('eyesoff: the passkey acts as the account, with the account\'s existing API key', k.json?.sub === A_PK && k.json.key === oldKey, k.text);
  await page.close();
  s.stop();
}

if (ONLY !== 'eyesoff') {
  const s3port = await freePort();
  const minio = spawn('minio', ['server', path.join(work, 'minio'), '--address', `127.0.0.1:${s3port}`, '--console-address', `127.0.0.1:${await freePort()}`, '--quiet'],
    { env: { ...process.env, MINIO_ROOT_USER: AK, MINIO_ROOT_PASSWORD: SK, MINIO_BROWSER: 'off' }, stdio: 'ignore' });
  stops.push(() => minio.kill('SIGKILL'));
  await up(`http://127.0.0.1:${s3port}/minio/health/ready`);
  execFileSync('curl', ['-s', '-X', 'PUT', '--aws-sigv4', 'aws:amz:us-east-1:s3', '--user', `${AK}:${SK}`, `http://127.0.0.1:${s3port}/notes`]);
  const env = { JOT_AK: AK, JOT_SK: SK, JOT_MASTER: 'master-key-0123456789abcdef', JOT_LINK_KEY: 'link-key-one-0123456789abcdef' };
  const cfg = (cut) => (host) => ({ endpoint: `http://127.0.0.1:${s3port}`, region: 'us-east-1', bucket: 'notes', prefix: 'p/',
    credentials: { accessKeyId: '$JOT_AK', secretAccessKey: '$JOT_SK' }, master_key: '$JOT_MASTER', link_key: '$JOT_LINK_KEY',
    sso: { signer: addressOf(KEY_SSO), audience: AUD, ...(cut ? { until: now() - 1 } : {}) },
    wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, ...(cut ? { migration: pin } : {}) });
  // BEFORE the cutover: the passkey-only account (signed in through the issuer) writes a sealed note
  const before = await serve(JOT, cfg(false), env);
  check('jot: before cutover the passkey-only account seals a note', (await before.call('PUT', '/api/notes/plans.md', { headers: { 'x-sso-token': est1(A_PK) }, body: { content: 'sealed note of the passkey-only account' } })).status === 200);
  before.stop();
  const j = await serve(JOT, cfg(true), env);
  const challenge = async (address, account) => j.call('POST', '/api/link/challenge', { body: { address, nonce: 'pk' + crypto.randomBytes(9).toString('hex'), account } });
  const link = (message, signature) => j.call('POST', '/api/link', { body: { account: cred, wallet: ews1(message, signature) } });
  const signIn = async (address) => (await j.call('GET', `/api/auth/wallet/challenge?address=${address}&nonce=pk${crypto.randomBytes(9).toString('hex')}`)).json.message;

  // REFUSALS first (nothing linked yet)
  const c3 = await challenge(V3, cred);
  check('jot: a vault derived from a passkey the account never had is refused at the challenge', c3.status === 401 && /not one the account migration file commits/.test(c3.text), c3.text);
  const c1 = await challenge(V1, cred);
  assert.equal(c1.status, 200, c1.text);
  const m1 = c1.json.message;
  // a stranger's passkey signing as this account's vault: the vault has no such key
  check('jot: a passkey that is not the account\'s cannot sign as its vault', (await link(m1, await rawAssertion(site.origin, m1, K3, true, K1))).status === 401);
  // the right passkey, but asked from ANOTHER origin (a tenant page, a phishing page): the vault refuses the assertion
  check('jot: the account\'s own passkey signing from another origin is refused by the vault', (await link(m1, await rawAssertion(other.origin, m1, K1, true))).status === 401);
  // a counterfactual wrapper whose factory call makes ANOTHER vault: the claimed one never answers
  check('jot: an ERC-6492 wrapper that deploys a different vault is refused', (await link(m1, await rawAssertion(site.origin, m1, K3, true, K3))).status === 401);
  // the signer page itself refuses to sign for an address that is not the chosen passkey's
  const wrongAddr = await signOnPage(site.origin, m1.replace(/\n0x[0-9a-fA-F]{40}\n/, `\n${viem.getAddress(V3)}\n`));
  check('jot: the signer page will not sign a message naming another address', wrongAddr.signature === '' && /another address/.test(wrongAddr.note));
  // a former issuer's NEW snapshot binding this account to the stranger's passkey: not the pinned root
  fs.writeFileSync(path.join(work, 'evil.json'), JSON.stringify({ accounts: { [A_PK]: { id: A_PK, wallets: [], passkeys: [pk(K3)] } } }));
  tool('snapshot', '--accounts', path.join(work, 'evil.json'), '--cutover', 'enclave-passkey-cutover', '--out', path.join(work, 'evil'));
  const evil = T.credential(fs.readFileSync(path.join(work, 'evil', 'bundles', `${A_PK}.json`), 'utf8'));
  check('jot: a former issuer\'s new snapshot is refused', /another snapshot root/.test((await challenge(V3, evil)).text));
  // a post-cutoff EST1 proves nothing
  check('jot: a post-cutoff EST1 opens nothing', (await j.call('GET', '/api/notes', { headers: { 'x-sso-token': est1(A_PK) } })).status === 401);

  // THE RECOVERY, through both pages: the app's restore control, the signer page's passkey prompt, back to the app
  const app = await ctx.newPage();
  await app.goto(`${j.base}/`);
  await app.waitForSelector('#restorebtn', { state: 'visible', timeout: 20000 });
  await app.setInputFiles('#restorefile', bundleFile);
  await app.waitForSelector('#hs-addr', { state: 'visible', timeout: 20000 });
  const shown = await openOnPage(site.origin, 0);
  check('jot: the signer page shows the account address the passkey controls', shown === V1, shown);
  await app.fill('#hs-addr', shown);
  await app.click('#hs-next');
  await app.waitForFunction(() => document.querySelector('#hs-msg').value.length > 0, null, { timeout: 30000 });
  const linkMsg = await app.inputValue('#hs-msg');
  const s1 = await signOnPage(site.origin, linkMsg, 0);
  check('jot: the passkey signs the link on its own origin (a real WebAuthn assertion)', /^0x[0-9a-f]+$/.test(s1.signature) && s1.signature.endsWith('6492'.repeat(16)), s1.note);
  await app.fill('#hs-sig', s1.signature);
  await app.click('#hs-done');
  await app.waitForFunction(() => /Linked: wallet/.test(document.querySelector('#ssoerr').textContent), null, { timeout: 60000 });
  check('jot: the passkey-only account is linked to its vault address, with no issuer', true);
  // SIGN-IN after recovery: the same two pages; the account's sealed note opens
  const sm = await signIn(V1);
  const s2 = await signOnPage(site.origin, sm, 0);
  const tok = ews1(sm, s2.signature);
  const st = await j.call('GET', '/api/status', { headers: { 'x-sso-token': tok } });
  check('jot: signing in with the passkey acts as the account', st.json?.you?.sub === A_PK && st.json.you.via === 'wallet-link', st.text);
  const note = await j.call('GET', '/api/notes/plans.md', { headers: { 'x-sso-token': tok } });
  check('jot: the account\'s sealed note is readable again', note.status === 200 && /sealed note of the passkey-only account/.test(note.text));
  check('jot: the vault was never deployed (ERC-6492 simulation only)', (await pc.getCode({ address: V1 })) === undefined);

  // ROTATION and REVOCATION on the original contract: the vault is deployed; K1 adds K2 on chain (the site's existing
  // vault-op flow, here signed in the same signer tab at the pinned origin); then K2 removes K1
  await send({ to: factory, data: viem.encodeFunctionData({ abi: VAULT.factory.abi, functionName: 'createVault', args: [BigInt(K1.x), BigInt(K1.y)] }) });
  const vaultOp = async (op, signerKey, fields) => {
    const nonce = await pc.readContract({ address: V1, abi: VAULT.vault.abi, functionName: 'nonce' });
    const deadline = BigInt(now() + 600), tag = viem.keccak256(viem.toHex(op === 'add' ? 'EnclaveVault.addKey.v1' : 'EnclaveVault.removeKey.v1'));
    const digest = viem.keccak256(op === 'add'
      ? viem.encodeAbiParameters(['bytes32', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'].map((type) => ({ type })), [tag, V1, 8453n, nonce, BigInt(fields.x), BigInt(fields.y), deadline])
      : viem.encodeAbiParameters(['bytes32', 'address', 'uint256', 'uint256', 'bytes32', 'uint256'].map((type) => ({ type })), [tag, V1, 8453n, nonce, fields.keyHash, deadline]));
    if (!signer.url().startsWith(site.origin)) await signer.goto(`${site.origin}/recover/`);
    const a = await signer.evaluate(async ({ digest, key }) => { const L = await import('/vendor/aa.js');
      const r = await L.WebAuthnP256.sign({ challenge: digest, credentialId: key.credId, rpId: 'localhost', userVerification: 'required' });
      return { authenticatorData: r.metadata.authenticatorData, clientDataJSON: r.metadata.clientDataJSON, r: '0x' + r.signature.r.toString(16), s: '0x' + r.signature.s.toString(16) }; }, { digest, key: signerKey });
    const sig = { authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, r: BigInt(a.r), s: BigInt(a.s), x: BigInt(signerKey.x), y: BigInt(signerKey.y) };
    await send({ to: V1, data: viem.encodeFunctionData({ abi: VAULT.vault.abi, functionName: op === 'add' ? 'addKey' : 'removeKey',
      args: op === 'add' ? [BigInt(fields.x), BigInt(fields.y), deadline, sig] : [fields.keyHash, deadline, sig] }) });
  };
  await vaultOp('add', K1, K2);
  await settle();
  const mRot = await signIn(V1);
  const rot = ews1(mRot, await rawAssertion(site.origin, mRot, K2, true, K1));
  check('jot: after an on-chain rotation the added passkey signs as the account\'s vault', (await j.call('GET', '/api/notes/plans.md', { headers: { 'x-sso-token': rot } })).status === 200);
  const beforeRevoke = ews1(mRot, await rawAssertion(site.origin, mRot, K1, true));
  check('jot: (the root passkey still works before revocation)', (await j.call('GET', '/api/notes/plans.md', { headers: { 'x-sso-token': beforeRevoke } })).status === 200);
  await vaultOp('remove', K2, { keyHash: viem.keccak256(viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(K1.x), BigInt(K1.y)])) });
  await settle();
  check('jot: after the root passkey is removed on chain, its earlier session is refused on the next request', (await j.call('GET', '/api/notes/plans.md', { headers: { 'x-sso-token': beforeRevoke } })).status === 401);
  const mAfter = await signIn(V1);
  check('jot: and a fresh signature by the removed passkey is refused', (await j.call('GET', '/api/notes/plans.md', { headers: { 'x-sso-token': ews1(mAfter, await rawAssertion(site.origin, mAfter, K1, true)) } })).status === 401);
  check('jot: while the remaining passkey still opens the account', (await j.call('GET', '/api/notes/plans.md', { headers: { 'x-sso-token': ews1(mAfter, await rawAssertion(site.origin, mAfter, K2, true, K1)) } })).status === 200);
  // the account's OTHER committed passkey (a second device before cutover) links through its own (counterfactual) vault
  check('jot: the signer page shows the second passkey\'s own address', (await openOnPage(site.origin, 1)) === V2);
  const cV2 = await challenge(V2, cred);
  assert.equal(cV2.status, 200, cV2.text);
  const lV2 = await link(cV2.json.message, (await signOnPage(site.origin, cV2.json.message, 1)).signature);
  // jot keeps ONE wallet per account (link.rs, unchanged): the second device joins the account's vault on chain (addKey,
  // below) rather than as a second link; its own vault is still accepted as committed (either device can restore first)
  check('jot: the account\'s second committed passkey is accepted at the challenge; jot\'s one-wallet-per-account rule then holds',
    lV2.status === 409 && /already linked to another wallet/.test(lV2.text), lV2.text);
  j.stop();
}
console.log(`ALL PASS (${results.length} checks)`);
process.exit(0);
