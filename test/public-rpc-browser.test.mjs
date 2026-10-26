// The PACKAGED public-rpc role (network/host-services/packages/public-rpc.*, run by network/host-services/runner.mjs) as the
// RPC origins of a browser network profile, in a REAL Chromium: the unbundled dashboard's own chain modules
// (site/js/core/quorum.js, chain.js with a saved and confirmed profile) talk to two hosts' roles over CORS, and every
// non-loopback origin is refused at the browser. The backend is reth v2.8.0 --dev (test/helpers/reth-dev.mjs) behind a
// fault proxy. BOTH roles front that ONE node here: the two-origin quorum proves the browser path, CORS, EIP-1898 pinning,
// reverts, history, estimates and receipts through the role - it is NOT two independent nodes, and nothing here claims it.
//   - agreed snapshot, eth_call at the agreed block hash, an agreed revert, logs, estimate, balance and code; a receipt
//     through the profile's rotating reads (chain.js baseRpc);
//   - a page on an origin the roles do not allow cannot read them (CORS refuses in the browser);
//   - the node down: the quorum refuses within bounded time, nothing answers from elsewhere;
//   - no request leaves loopback (the browser refuses any other origin; the job runs in a loopback-only namespace).
//   run: node --test test/public-rpc-browser.test.mjs   (reth, Playwright's Chromium, the built packages)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http as viemHttp, encodeFunctionData, keccak256, toBytes, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRethDev, haveReth, DEV_KEY, freePort } from './helpers/reth-dev.mjs';
import { compileProbe } from './helpers/rpc-probe-contract.mjs';
import { runHostServices } from '../network/host-services/runner.mjs';
import { rpcHostIdentities, assertDistinctRpcHosts } from '../network/public-rpc-hosts.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(REPO, 'network/host-services/packages');
const require = createRequire(new URL('../e2e/package.json', import.meta.url));
let chromium; try { ({ chromium } = require('playwright')); } catch {}
const skip = haveReth() || (!chromium && 'needs Playwright\'s Chromium (e2e)') || (!fs.existsSync(path.join(PKG, 'public-rpc.package.json')) && 'needs the built packages') || false;
const chain = defineChain({ id: 8453, name: 'base-dev', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } });
const pin = 'sha256:' + (fs.existsSync(path.join(PKG, 'public-rpc.package.json')) ? createHash('sha256').update(fs.readFileSync(path.join(PKG, 'public-rpc.package.json'))).digest('hex') : '0'.repeat(64));
let reth, probe, proxy, mode = 'ok', site, other, hosts = [], browser, deployBlock, pokeTx;
const servers = [];

async function serve(handler) {
  const s = http.createServer(handler); await new Promise((ok) => s.listen(0, '127.0.0.1', ok)); servers.push(s); return s.address().port;
}
// the unbundled site; /network/* for the module independent.js imports from the repository root
const statics = (req, res) => {
  const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/blank.html';
  const file = p.startsWith('/network/') ? path.join(REPO, p) : path.join(REPO, 'site', p);
  if (p === '/blank.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>profile page</title>'); }
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'text/plain' }); fs.createReadStream(file).pipe(res);
};
async function startHost(name, port, allowedOrigins) {
  const endpoint = `https://host-${name}.public-rpc-browser.net`, dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', `prb-${name}-`));
  const cfg = { format: 'enclave-host-services/v1', host: { endpoint }, platformHostPolicy: 'production', packagesDir: PKG, stateRoot: dir,
    services: [{ role: 'public-rpc', package: pin, heapMiB: 96, config: { port, bind: '127.0.0.1', hostId: keccak256(toBytes(endpoint)).toLowerCase(), chainId: 8453, node: proxy.url, allowedOrigins } }] };
  const logs = [];
  const running = await runHostServices(cfg, { gate: { check: async () => {}, start() {}, stop() {}, serviceRefusal: () => null, status: () => ({}) }, log: (x) => logs.push(x), intervalMs: 300 });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/health')).ok) break; } catch {} await new Promise((x) => setTimeout(x, 200)); }
  return { name, url, running, logs, dir };
}

before(async () => {
  if (skip) return;
  reth = await startRethDev({ blockTime: '1s' });
  probe = compileProbe();
  const pc = createPublicClient({ chain, transport: viemHttp(reth.url) });
  const wc = createWalletClient({ chain, account: privateKeyToAccount(DEV_KEY), transport: viemHttp(reth.url) });
  const rc = await pc.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: probe.abi, bytecode: probe.bytecode }) });
  probe.address = rc.contractAddress; deployBlock = Number(rc.blockNumber);
  pokeTx = await wc.writeContract({ address: probe.address, abi: probe.abi, functionName: 'poke', args: [7n] });
  await pc.waitForTransactionReceipt({ hash: pokeTx });
  const pport = await serve(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    if (mode === 'down') return req.socket.destroy();
    const r = await fetch(reth.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(await r.text());
  });
  proxy = { url: `http://127.0.0.1:${pport}` };
  site = await serve(statics); other = await serve(statics);
  const allowed = [`http://localhost:${site}`];
  hosts = [await startHost('a', await freePort(), allowed), await startHost('b', await freePort(), allowed)];
  browser = await chromium.launch({ args: ['--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=1', '--disable-extensions', '--js-flags=--max-old-space-size=192'] });
});
after(async () => {
  await browser?.close();
  for (const h of hosts) { await h.running.stop().catch(() => {}); fs.rmSync(h.dir, { recursive: true, force: true }); }
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  reth?.stop();
});

test('a browser profile on two packaged roles: agreed reads, EIP-1898 calls, a revert, history, estimates and a receipt, over CORS, loopback only', { skip, timeout: 240_000 }, async () => {
  const forbidden = [], seen = [];
  const context = await browser.newContext();
  await context.route('**/*', (route) => { const u = new URL(route.request().url()); if (!['localhost', '127.0.0.1'].includes(u.hostname)) { forbidden.push(u.href); return route.abort(); } return route.continue(); });
  context.on('request', (r) => seen.push(r.url()));
  const zero = (n) => '0x' + n.repeat(40);
  const profile = { format: 'enclave-browser-profile', version: 1, name: 'public-rpc role test (ONE reth node behind both roles)', chainId: 8453, rpcs: hosts.map((h) => h.url), quorum: 2,
    confirmations: 0, maxBlockAgeSeconds: 600, usdc: zero('6'),
    contractPins: { version: 1, chainId: 8453, contracts: { registry: zero('1'), deployments: zero('2'), appCatalog: zero('3'), proofOfTime: zero('4'), enclavePay: zero('0'), verificationFees: zero('0'), sessionVaultFactory: zero('0'), secretVaultV2: zero('0') } } };
  await context.addInitScript((text) => { localStorage.setItem('enclave_independent_profile', text); sessionStorage.setItem('enclave_independent_ack', text); }, JSON.stringify(profile));
  const page = await context.newPage();
  await page.goto(`http://localhost:${site}/`);
  const from = privateKeyToAccount(DEV_KEY).address;
  const out = await page.evaluate(async ({ rpcs, probe: p, data, from, deployBlock, pokeTx }) => {
    const { createQuorumReader } = await import('/js/core/quorum.js');
    const r = createQuorumReader({ rpcs, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 600, chainId: 8453 });
    const snap = await r.snapshot();
    const value = await r.call(snap, p, data.value);
    const revert = await r.call(snap, p, data.fail).then(() => null, (e) => ({ revert: !!e.revert, message: e.message }));
    const logs = await r.logs(snap, { address: p, topics: [], fromBlock: deployBlock, toBlock: snap.number });
    const gas = String(await r.estimateGas(snap, { from, to: p, data: data.poke }));
    const balance = String(await r.balance(snap, from));
    const code = await r.code(snap, p);
    const C = await import('/js/core/config.js');
    const { baseRpc } = await import('/js/core/chain.js');
    const receipt = await baseRpc('eth_getTransactionReceipt', [pokeTx]);
    return { state: C.INDEPENDENT.state, agreed: snap.rpcs.length, value, revert, logs: logs.map((l) => l.transactionHash), gas, balance, codeLen: code.length, receipt: receipt && receipt.status };
  }, { rpcs: hosts.map((h) => h.url), probe: probe.address, from, deployBlock, pokeTx, data: {
    value: encodeFunctionData({ abi: probe.abi, functionName: 'value' }), fail: encodeFunctionData({ abi: probe.abi, functionName: 'fail' }),
    poke: encodeFunctionData({ abi: probe.abi, functionName: 'poke', args: [8n] }) } });
  assert.equal(out.state, 'on', 'the profile is saved and confirmed in this tab');
  assert.equal(out.agreed, 2);
  assert.equal(BigInt(out.value), 7n);
  assert.deepEqual(out.revert, { revert: true, message: 'the contract call reverted' }, 'both roles return the revert; the quorum reports an agreed revert');
  assert.deepEqual(out.logs, [pokeTx]);
  assert.ok(BigInt(out.gas) > 21000n); assert.ok(BigInt(out.balance) > 0n); assert.ok(out.codeLen > 10);
  assert.equal(out.receipt, '0x1');
  assert.deepEqual(forbidden, [], 'no non-loopback origin was attempted');
  for (const u of seen) assert.ok(['localhost', '127.0.0.1'].includes(new URL(u).hostname), u);
  assert.ok(seen.some((u) => u.startsWith(hosts[0].url)) && seen.some((u) => u.startsWith(hosts[1].url)), 'both roles were read');
  // the two origins are two configured hosts (distinct registry ids) - and here ONE node: identities say who answers, not independence
  const ids = assertDistinctRpcHosts(await rpcHostIdentities(hosts.map((h) => h.url)));
  assert.equal(new Set(ids.map((x) => x.hostId)).size, 2);
  await context.close();
});

test('a page on an origin the roles do not allow cannot read them; the node down refuses in bounded time', { skip, timeout: 120_000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${other}/`);
  const blocked = await page.evaluate((url) => fetch(url + '/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })
    .then((r) => 'answered ' + r.status, (e) => e.name), hosts[0].url);
  assert.equal(blocked, 'TypeError', 'CORS refuses a page of another origin');
  await page.goto(`http://localhost:${site}/`);
  mode = 'down';
  try {
    await new Promise((x) => setTimeout(x, 2200));                            // the roles' cached node health expires
    const t = Date.now();
    const r = await page.evaluate(async (rpcs) => {
      const { createQuorumReader } = await import('/js/core/quorum.js');
      return createQuorumReader({ rpcs, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 600, chainId: 8453 }).snapshot().then(() => 'answered', (e) => e.message);
    }, hosts.map((h) => h.url));
    assert.match(r, /only 0 of 2 chain endpoints answered \(need 2\)/);
    assert.ok(Date.now() - t < 10_000, 'bounded');
  } finally { mode = 'ok'; await context.close(); }
});
