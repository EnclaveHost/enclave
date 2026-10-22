// Real-browser check of the account-restore pages on the CANDIDATE components (EyesOff and jot with the EAB1 patch):
// headless Chromium (the system one; Playwright from the enclave repository, read-only), a local anvil chain with the test
// wallets, a local MinIO for jot. The person chooses their migration FILE in the page's own file picker and signs:
//   - with a browser wallet: an EIP-1193 provider injected into the page, whose personal_sign is answered by the owner's
//     key outside the page (as an extension would) - the page's own flow, nothing stubbed in it;
//   - by hand: a counterfactual (EIP-6492) wallet, signed outside the browser and pasted.
// Then the component is asked who that wallet now is. Every key and account is synthetic.
//   EYESOFF_WASM=… JOT_WASM=… node tests/browser-migration.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const WO = '/home/steven/Documents/Codex/2026-10-18/wo/work', MIG = `${WO}/app-auth-release-migration`;
const { chromium } = await import(`${WO}/enclave/node_modules/playwright/index.mjs`);
const { startChain, readers, personalSign, addressOf } = await import(`${WO}/enclave-apps/eyesoff-ai/tests/helpers/evm.mjs`);
const T = await import(`${MIG}/tools/eab1.mjs`);
const EYESOFF = process.env.EYESOFF_WASM, JOT = process.env.JOT_WASM, ONLY = process.env.ONLY || '';   // ONLY=jot|eyesoff runs one app
const AUD = '0xcc1f4f3f000000000000000000000000000000000000000000000000000000aa';
const KEY_SSO = '0x' + '42'.repeat(32), KEY_EOA = '0x' + '61'.repeat(32), KEY_CF = '0x' + '62'.repeat(32);
const A_EOA = 'acct_4e5f60718293a4b5c6d7e8f9', A_CF = 'acct_5f60718293a4b5c6d7e8f90a';
const AK = 'migbrowser', SK = 'migbrowser-secret-0123456789', SEED = 's33d-0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const b64u = (b) => Buffer.from(b).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const est1 = (sub) => { const p = b64u(JSON.stringify({ aud: AUD, exp: now() + 3600, iat: now(), sub, v: 1 }));
  return `EST1.${p}.${b64u(Buffer.from(personalSign(KEY_SSO, `EST1.${p}`).slice(2), 'hex'))}`; };
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = async (u) => { for (let i = 0; ; i++) { try { if ((await fetch(u)).ok) return; } catch {} if (i > 200) throw new Error(`no answer from ${u}`); await sleep(100); } };
const tool = (...a) => execFileSync(process.execPath, [`${MIG}/tools/eab1.mjs`, ...a], { encoding: 'utf8' });

const stops = [];
process.on('exit', () => { for (const s of stops.reverse()) { try { s(); } catch {} } });
const work = mkdtempSync(path.join(MIG, 'scratch', 'browser-'));
stops.push(() => rmSync(work, { recursive: true, force: true }));
const chain = await startChain(); stops.push(() => chain.stop());
const rd = await readers(chain); stops.push(() => rd.stop());
const W = { eoa: addressOf(KEY_EOA), cf: await chain.predict(KEY_CF, 71) };
const s3port = await freePort();
const minio = spawn('minio', ['server', path.join(work, 'minio'), '--address', `127.0.0.1:${s3port}`, '--console-address', `127.0.0.1:${await freePort()}`, '--quiet'],
  { env: { ...process.env, MINIO_ROOT_USER: AK, MINIO_ROOT_PASSWORD: SK, MINIO_BROWSER: 'off' }, stdio: 'ignore' });
stops.push(() => minio.kill('SIGKILL'));
await up(`http://127.0.0.1:${s3port}/minio/health/ready`);
execFileSync('curl', ['-s', '-X', 'PUT', '--aws-sigv4', 'aws:amz:us-east-1:s3', '--user', `${AK}:${SK}`, `http://127.0.0.1:${s3port}/notes`]);
await sleep(4000);
// the cutover, as in the e2e test
writeFileSync(path.join(work, 'accounts.json'), JSON.stringify({ accounts: {
  [A_EOA]: { id: A_EOA, wallets: [W.eoa], passkeys: [] }, [A_CF]: { id: A_CF, wallets: [W.cf], passkeys: [] } } }));
tool('snapshot', '--accounts', path.join(work, 'accounts.json'), '--cutover', 'enclave-browser-cutover', '--out', path.join(work, 'cut'));
const stFile = path.join(work, 'cut', 'statement.json');
tool('attach', '--statement', stFile, '--signature', personalSign(KEY_SSO, JSON.parse(readFileSync(stFile, 'utf8')).text), '--signer', addressOf(KEY_SSO));
const pin = JSON.parse(tool('config', '--statement', stFile)).migration;
const bundleFile = (a) => path.join(work, 'cut', 'bundles', `${a}.json`);

async function serve(wasm, cfg, envs = {}) {
  const port = await freePort(), host = `127.0.0.1:${port}`;
  const args = ['serve', '-Scommon', '-Snn', '--addr', host, '--env', `ENCLAVE_CONFIG=${JSON.stringify(cfg(host))}`];
  for (const [k, v] of Object.entries(envs)) args.push('--env', `${k}=${v}`);
  const p = spawn('wasmtime', [...args, wasm], { stdio: 'ignore' });
  stops.push(() => p.kill('SIGKILL'));
  await up(`http://${host}/ping`);
  return { host, base: `http://${host}`, stop: () => p.kill('SIGKILL') };
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM || '/usr/sbin/chromium' });
stops.push(() => browser.close());
// an EIP-1193 provider in the page, as an extension provides one; its signatures come from the owner's key out here
async function pageWithWallet(key, address) {
  const page = await browser.newPage();
  await page.exposeFunction('__walletSign', (hexMsg) => personalSign(key, hexMsg));   // cast signs 0x-hex as the raw bytes
  await page.addInitScript((addr) => {
    window.ethereum = { request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
      if (method === 'personal_sign') return window.__walletSign(params[0]);
      throw Object.assign(new Error('unsupported ' + method), { code: 4200 });
    } };
  }, address);
  return page;
}
const results = [];

// ------------------------------------------------------------------ jot ----------------------------------------------
if (ONLY !== 'eyesoff') {
  const jotEnv = { JOT_AK: AK, JOT_SK: SK, JOT_MASTER: 'master-key-0123456789abcdef', JOT_LINK_KEY: 'link-key-one-0123456789abcdef' };
  const cfg = (cut) => (host) => ({ endpoint: `http://127.0.0.1:${s3port}`, region: 'us-east-1', bucket: 'notes', prefix: 'b/',
    credentials: { accessKeyId: '$JOT_AK', secretAccessKey: '$JOT_SK' }, master_key: '$JOT_MASTER', link_key: '$JOT_LINK_KEY',
    sso: { signer: addressOf(KEY_SSO), audience: AUD, ...(cut ? { until: now() - 1 } : {}) },
    wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, ...(cut ? { migration: pin } : {}) });
  const before = await serve(JOT, cfg(false), jotEnv);
  for (const a of [A_EOA, A_CF]) {
    const r = await fetch(`${before.base}/api/notes/plans.md`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-sso-token': est1(a) }, body: JSON.stringify({ content: `sealed note of ${a}` }) });
    assert.equal(r.status, 200);
  }
  before.stop();
  const j = await serve(JOT, cfg(true), jotEnv);
  // (1) browser wallet
  const page = await pageWithWallet(KEY_EOA, W.eoa);
  await page.goto(`${j.base}/`);
  await page.waitForSelector('#restorebtn', { state: 'visible', timeout: 20000 });
  await page.setInputFiles('#restorefile', bundleFile(A_EOA));
  await page.waitForFunction(() => /Linked: wallet/.test(document.querySelector('#ssoerr').textContent), null, { timeout: 60000 });
  // sign in with that wallet, in the page
  await page.click('#walletbtn');
  await page.waitForFunction(() => (sessionStorage.getItem('jot-sso') || localStorage.getItem('jot-sso') || '').startsWith('EWS1.')
    || Object.values(sessionStorage).some((v) => String(v).startsWith('EWS1.')), null, { timeout: 60000 });
  const tok = await page.evaluate(() => Object.values(sessionStorage).find((v) => String(v).startsWith('EWS1.')));
  const st = await (await fetch(`${j.base}/api/status`, { headers: { 'x-sso-token': tok } })).json();
  assert.deepEqual(st.you, { sub: A_EOA, via: 'wallet-link' });
  const note = await (await fetch(`${j.base}/api/notes/plans.md`, { headers: { 'x-sso-token': tok } })).text();
  assert.match(note, new RegExp(`sealed note of ${A_EOA}`));
  results.push(['jot', 'browser wallet', st.you.sub]);
  await page.close();
  // (2) by hand, a counterfactual wallet (no browser wallet in this page)
  const p2 = await browser.newPage();
  await p2.goto(`${j.base}/`);
  await p2.waitForSelector('#restorebtn', { state: 'visible', timeout: 20000 });
  await p2.setInputFiles('#restorefile', bundleFile(A_CF));
  await p2.waitForSelector('#hs-addr', { state: 'visible', timeout: 20000 });
  await p2.fill('#hs-addr', W.cf);
  await p2.click('#hs-next');
  await p2.waitForFunction(() => document.querySelector('#hs-msg').value.length > 0, null, { timeout: 30000 });
  const msg = await p2.inputValue('#hs-msg');
  assert.match(msg, new RegExp(`urn:enclave:link:account:${A_CF}`));
  await p2.fill('#hs-sig', chain.wrap6492(KEY_CF, 71, personalSign(KEY_CF, msg)));
  await p2.click('#hs-done');
  await p2.waitForFunction(() => /Linked: wallet/.test(document.querySelector('#ssoerr').textContent), null, { timeout: 60000 });
  results.push(['jot', 'by hand (EIP-6492)', A_CF]);
  await p2.close();
  j.stop();
}

// --------------------------------------------------------------- EyesOff ---------------------------------------------
if (ONLY !== 'jot') {
  const cfg = (cut) => (host) => ({ sso: { signer: addressOf(KEY_SSO), audience: AUD, ...(cut ? { until: now() - 1 } : {}) },
    wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, api_key_seed: SEED, ...(cut ? { migration: pin } : {}) });
  const before = await serve(EYESOFF, cfg(false));
  const oldKey = (await (await fetch(`${before.base}/v1/keys`, { method: 'POST', headers: { authorization: `Bearer ${est1(A_EOA)}` } })).json()).key;
  before.stop();
  const s = await serve(EYESOFF, cfg(true));
  const page = await pageWithWallet(KEY_EOA, W.eoa);
  await page.goto(`${s.base}/`);
  // the gate: sign in with the browser wallet (the page's own flow)
  await page.waitForSelector('#walletGo', { state: 'visible', timeout: 20000 });
  await page.click('#walletGo');
  await page.waitForFunction(() => (localStorage.getItem('llmchat-sso') || '').startsWith('EWS1.'), null, { timeout: 60000 });
  // the API panel: restore the account with its migration file
  await page.click('#apiBtn');
  await page.waitForSelector('#migrateRow', { state: 'visible', timeout: 20000 });
  await page.setInputFiles('#migrateFile', bundleFile(A_EOA));
  await page.waitForFunction(() => /^Linked: wallet/.test(document.querySelector('#linkNote').textContent), null, { timeout: 60000 });
  const link = await page.evaluate(() => JSON.parse(localStorage.getItem('llmchat-link')));
  assert.equal(link.account, A_EOA);
  const tok = await page.evaluate(() => localStorage.getItem('llmchat-sso'));
  const k = await (await fetch(`${s.base}/v1/keys`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'x-enclave-link': link.link } })).json();
  assert.equal(k.sub, A_EOA);
  assert.equal(k.key, oldKey, 'the account keeps its API key');
  results.push(['eyesoff-ai', 'browser wallet', k.sub]);
  await page.close();
  s.stop();
}
for (const [app, how, who] of results) console.log(`PASS ${app}: restored through the page (${how}) as ${who}`);
console.log(`counterfactual wallet still undeployed: ${(await chain.code(W.cf)) === '0x'}`);
process.exit(0);
