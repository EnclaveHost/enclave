// Browser check of the hand-signed sign-in path in the three app pages, against the BUILT components, a real EVM
// (local anvil + test wallets, enclave-apps/eyesoff-ai/tests/helpers/evm.mjs) and, for jot and depot, a local MinIO.
// A real headless Chromium clicks "another signer", types a COUNTERFACTUAL wallet's address, reads the exact message the
// page shows, pastes the EIP-6492 signature the wallet's owner makes over it, and the test then asks the component who
// that page is now signed in as. Evidence script for work/claude-app-auth-final-integration-result.md; uses the main
// repository's installed Playwright read-only.
//
//   node work/app-auth-final/browser-hand-signer.mjs     (env EYESOFF_WASM, JOT_WASM, DEPOT_WASM name the components)
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const WO = '/home/steven/Documents/Codex/2026-10-18/wo/work';
const APPS = `${WO}/enclave-apps`;
const { chromium } = await import(`${WO}/enclave/node_modules/playwright/index.mjs`);
const { startChain, readers, personalSign } = await import(`${APPS}/eyesoff-ai/tests/helpers/evm.mjs`);
const EYESOFF = process.env.EYESOFF_WASM, JOT = process.env.JOT_WASM, DEPOT = process.env.DEPOT_WASM;
const AUD = '0xcc1f4f3f000000000000000000000000000000000000000000000000000000aa';
const KEY_B = '0x' + '43'.repeat(32);
const AK = 'browsertest', SK = 'browsertest-secret-0123456789';
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = async (url) => { for (let i = 0; ; i++) { try { if ((await fetch(url)).ok) return; } catch {} if (i > 200) throw new Error(`no answer from ${url}`); await sleep(100); } };
const results = [];
const stops = [];

// every resource is registered for cleanup the moment it exists, and cleanup runs however the script ends
process.on('exit', () => { for (const s of stops.reverse()) { try { s(); } catch {} } });
const chain = await startChain();
stops.push(() => chain.stop());
const cf = await chain.predict(KEY_B, 41);
const rd = await readers(chain);
stops.push(() => rd.stop());
const work = mkdtempSync(path.join(WO, 'app-auth-final/scratch', 'browser-'));
stops.push(() => rmSync(work, { recursive: true, force: true }));
const s3port = await freePort();
const minio = spawn('minio', ['server', path.join(work, 'minio'), '--address', `127.0.0.1:${s3port}`, '--console-address', `127.0.0.1:${await freePort()}`, '--quiet'],
  { env: { ...process.env, MINIO_ROOT_USER: AK, MINIO_ROOT_PASSWORD: SK, MINIO_BROWSER: 'off' }, stdio: 'ignore' });
stops.push(() => minio.kill('SIGKILL'));
await up(`http://127.0.0.1:${s3port}/minio/health/ready`);
for (const b of ['notes', 'depot']) execFileSync('curl', ['-s', '-X', 'PUT', '--aws-sigv4', 'aws:amz:us-east-1:s3', '--user', `${AK}:${SK}`, `http://127.0.0.1:${s3port}/${b}`]);
await sleep(4000);   // the readers' confirmations

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM || '/usr/sbin/chromium' });   // the installed one; nothing is downloaded
stops.push(() => browser.close());

// the person at the keyboard: address in, message out, signature in
async function handSign(page, sel) {
  await page.click(sel.open);
  await page.fill(sel.addr, cf);
  await page.click(sel.next);
  await page.waitForFunction((s) => document.querySelector(s).value.length > 0, sel.msg);
  const message = await page.inputValue(sel.msg);
  assert.ok(message.toLowerCase().includes(cf), 'the page shows a message naming the address typed');
  await page.fill(sel.sig, chain.wrap6492(KEY_B, 41, personalSign(KEY_B, message)));
  await page.click(sel.done);
  return message;
}

try {
  // ---- EyesOff (wasmtime serve) ----
  {
    const port = await freePort(), host = `127.0.0.1:${port}`;
    const cfg = { wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, api_key_seed: 's33d-0f1e2d3c4b5a69788796a5b4c3d2e1f0' };
    const p = spawn('wasmtime', ['serve', '-Scommon', '-Snn', '--addr', host, '--env', `ENCLAVE_CONFIG=${JSON.stringify(cfg)}`, EYESOFF], { stdio: 'ignore' });
    stops.push(() => p.kill('SIGKILL'));
    await up(`http://${host}/ping`);
    const page = await browser.newPage();
    await page.goto(`http://${host}/`);
    await page.waitForSelector('#walletOther', { state: 'visible', timeout: 20000 });
    await handSign(page, { open: '#walletOther', addr: '#signerAddr', next: '#signerNext', msg: '#signerMsg', sig: '#signerSig', done: '#signerDone' });
    await page.waitForFunction(() => (localStorage.getItem('llmchat-sso') || '').startsWith('EWS1.'), null, { timeout: 60000 });
    const tok = await page.evaluate(() => localStorage.getItem('llmchat-sso'));
    const who = await (await fetch(`http://${host}/v1/keys`, { method: 'POST', headers: { authorization: `Bearer ${tok}` } })).json();
    assert.equal(who.sub, `wallet_${cf}`);
    assert.equal(await page.isVisible('#signerOverlay'), false, 'the dialog closed');
    results.push(['eyesoff-ai', who.sub]);
    await page.close();
  }
  // ---- jot (wasmtime serve, MinIO) ----
  {
    const port = await freePort(), host = `127.0.0.1:${port}`;
    const cfg = { endpoint: `http://127.0.0.1:${s3port}`, region: 'us-east-1', bucket: 'notes', prefix: 'b/',
      credentials: { accessKeyId: '$JOT_AK', secretAccessKey: '$JOT_SK' }, master_key: '$JOT_MASTER',
      wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets } };
    const p = spawn('wasmtime', ['serve', '-Scommon', '--addr', host, '--env', `ENCLAVE_CONFIG=${JSON.stringify(cfg)}`,
      '--env', `JOT_AK=${AK}`, '--env', `JOT_SK=${SK}`, '--env', 'JOT_MASTER=master-key-0123456789abcdef', JOT], { stdio: 'ignore' });
    stops.push(() => p.kill('SIGKILL'));
    await up(`http://${host}/ping`);
    const page = await browser.newPage();
    await page.goto(`http://${host}/`);
    await page.waitForSelector('#handbtn', { state: 'visible', timeout: 20000 });
    await handSign(page, { open: '#handbtn', addr: '#hs-addr', next: '#hs-next', msg: '#hs-msg', sig: '#hs-sig', done: '#hs-done' });
    await page.waitForFunction(() => Object.keys(sessionStorage).some((k) => (sessionStorage.getItem(k) || '').startsWith('EWS1.')), null, { timeout: 60000 });
    const tok = await page.evaluate(() => Object.values(sessionStorage).find((v) => v.startsWith('EWS1.')));
    const st = await (await fetch(`http://${host}/api/status`, { headers: { 'x-sso-token': tok } })).json();
    assert.deepEqual(st.you, { sub: `wallet_${cf}`, via: 'wallet' });
    assert.equal(await page.isVisible('#handsign'), false, 'the panel closed');
    assert.equal((await page.textContent('#ssoerr')).trim(), '');
    results.push(['jot', st.you.sub]);
    await page.close();
  }
  // ---- depot (wasmtime run, MinIO) ----
  {
    const port = await freePort(), host = `127.0.0.1:${port}`;
    const cfg = { storage: { endpoint: `http://127.0.0.1:${s3port}`, region: 'us-east-1', bucket: 'depot', prefix: 'b/', access_key: '$E2E_AK', secret_key: '$E2E_SK' },
      master_key: '$E2E_MASTER', local_test: true, title: 'depot browser',
      wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, users: { carol: { accounts: [`wallet_${cf}`], read: ['*'] } } };
    const env = { ...process.env, ENCLAVE_CONFIG: JSON.stringify(cfg), ENCLAVE_PORTS: `http:8000=${port}`, E2E_AK: AK, E2E_SK: SK, E2E_MASTER: 'm'.repeat(40) };
    const p = spawn('wasmtime', ['run', '-S', 'inherit-network=y', '-S', 'allow-ip-name-lookup=y',
      ...['ENCLAVE_CONFIG', 'ENCLAVE_PORTS', 'E2E_AK', 'E2E_SK', 'E2E_MASTER'].flatMap((k) => ['--env', k]), DEPOT], { env, stdio: 'ignore' });
    stops.push(() => p.kill('SIGKILL'));
    await up(`http://${host}/ping`);
    const page = await browser.newPage();
    await page.goto(`http://${host}/`);
    await page.waitForSelector('#handbtn', { state: 'visible', timeout: 20000 });
    await handSign(page, { open: '#handbtn', addr: '#hd-addr', next: '#hd-next', msg: '#hd-msg', sig: '#hd-sig', done: '#hd-done' });
    await page.waitForFunction(() => (sessionStorage.getItem('depot-sso') || '').startsWith('EWS1.'), null, { timeout: 60000 });
    const tok = await page.evaluate(() => sessionStorage.getItem('depot-sso'));
    const me = await (await fetch(`http://${host}/api/whoami`, { headers: { 'x-sso-token': tok } })).json();
    assert.equal(me.user, 'carol');
    await page.waitForFunction(() => document.querySelector('#who').textContent.includes('carol'), null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => document.querySelector('#handdlg').open), false, 'the dialog closed');
    results.push(['depot', me.user]);
    await page.close();
  }
  for (const [app, who] of results) console.log(`PASS ${app}: the page's hand-signed path signed in as ${who}`);
  console.log(`counterfactual wallet still undeployed: ${(await chain.code(cf)) === '0x'}`);
} finally {
  for (const s of stops.reverse()) { try { await s(); } catch {} }
}
