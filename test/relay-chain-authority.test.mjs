// The relay's one chain authority (relay/relay-chain-authority.mjs) for api-relay.js chain() and relay/store.js
// rpcParts()/rpcPool() and the wallet clients built on them, run as SHIPPED: a flat relay directory with the runtime bundle
// built from this source (test/helpers/relay-flat.mjs), real child processes, scripted loopback stand-ins for the local
// verifier, the own backend and a legacy BASE_RPC (each records every request), and a preload that blocks AND records any
// non-loopback fetch. What the verifier proves is network/chain-authority.mjs's (test/chain-authority.test.mjs and the
// real-runtime test/chain-consumer-closure.e2e.test.mjs); here: which server each relay consumer reaches, that no provider
// is reached under the verifier, that sends go only to the bound own backend, outages and mixed settings fail closed, and
// legacy mode is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { keccak256, toFunctionSelector, parseTransaction } from 'viem';
import { flatRelay } from './helpers/relay-flat.mjs';

const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'relay-chain-authority-'));
const servers = new Set(), children = new Set();
test.after(() => { for (const c of children) try { c.kill('SIGKILL'); } catch {} for (const s of servers) try { s.closeAllConnections?.(); s.close(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });
const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

const FLAT = flatRelay(tmp);
// the same relay modules WITHOUT the runtime bundle: the legacy path must not need it
const BARE = path.join(tmp, 'relay-bare'); fs.mkdirSync(BARE);
for (const f of ['store.js']) fs.copyFileSync(path.join(FLAT, f), path.join(BARE, f));
fs.symlinkSync(fs.realpathSync(path.join(FLAT, 'node_modules')), path.join(BARE, 'node_modules'));

// a preload: every non-loopback fetch is recorded (host, and whether it was JSON-RPC) and fails as if offline
const PRELOAD = path.join(tmp, 'no-public.mjs');
fs.writeFileSync(PRELOAD, `import fs from 'node:fs';
const orig = globalThis.fetch, log = process.env.PUBLIC_LOG;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    fs.appendFileSync(log, JSON.stringify({ host: u.host, rpc: /jsonrpc/.test(typeof init.body === 'string' ? init.body : '') }) + '\\n');
    throw new TypeError('fetch failed (test: the public network is blocked)');
  }
  return orig(input, init);
};
`);
const publicLog = (name) => path.join(tmp, `public-${name}.jsonl`);
const publicRequests = (name) => fs.existsSync(publicLog(name)) ? fs.readFileSync(publicLog(name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const HEAD = 100, HEAD_HASH = '0x' + 'ab'.repeat(32);
const blockAt = (n, { hash = n === HEAD ? HEAD_HASH : '0x' + n.toString(16).padStart(64, 'c'), age = 2 } = {}) => ({ number: '0x' + n.toString(16), hash,
  timestamp: '0x' + Math.floor(Date.now() / 1000 - age).toString(16), baseFeePerGas: '0x3b9aca00', parentHash: '0x' + '0'.repeat(64), gasLimit: '0x1c9c380',
  gasUsed: '0x0', miner: a(0), extraData: '0x', logsBloom: '0x' + '0'.repeat(512), difficulty: '0x0', nonce: '0x0000000000000000', stateRoot: '0x' + '5'.repeat(64),
  receiptsRoot: '0x' + '6'.repeat(64), sha3Uncles: '0x' + '7'.repeat(64), size: '0x1', transactionsRoot: '0x' + '8'.repeat(64), transactions: [], uncles: [] });
/** a scripted JSON-RPC server: answer(method, params) -> {result} | {error}; every call recorded */
async function scripted(answer) {
  const calls = [];
  const s = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    let q; try { q = JSON.parse(b); } catch { q = null; }
    const one = (m) => { calls.push({ method: m?.method, params: m?.params }); return { jsonrpc: '2.0', id: m?.id ?? null, ...(answer(m?.method, m?.params || []) ?? { error: { code: -32601, message: 'not scripted' } }) }; };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
  }); });
  servers.add(s); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${s.address().port}/`, methods: () => calls.map((c) => c.method) };
}
const SEL = { addr: toFunctionSelector('addr(bytes32)'), get: toFunctionSelector('get(bytes32)'), balanceOf: toFunctionSelector('balanceOf(address)'),
  schema: toFunctionSelector('deploymentsSchema()'), getPage: toFunctionSelector('getPage(uint256,uint256)') };
const sent = new Map();                                     // tx hash -> raw (what the own backend accepted)
const receiptFor = (hash) => ({ blockHash: HEAD_HASH, blockNumber: '0x' + HEAD.toString(16), contractAddress: null, cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca01',
  from: a(1), gasUsed: '0x5208', logs: [], logsBloom: '0x' + '0'.repeat(512), status: '0x1', to: a(0x7c), transactionHash: hash, transactionIndex: '0x0', type: '0x2' });
const verifierScript = ({ age = 2, st = { sent } } = {}) => (method, params) => {
  switch (method) {
    case 'eth_chainId': return { result: '0x2105' };
    case 'eth_blockNumber': return { result: '0x' + HEAD.toString(16) };
    case 'eth_getBlockByNumber': return { result: blockAt(Number(BigInt(params[0])), { age }) };
    case 'eth_call': {
      const d = String(params[0]?.data || params[0]?.input || '');
      if (d.startsWith(SEL.addr)) return { result: '0x' + word(a(0x12).slice(2)) };
      if (d.startsWith(SEL.schema)) return { result: '0x' + word('2') };
      return { result: '0x' + word('7') };
    }
    case 'eth_estimateGas': return { result: '0x5208' };
    case 'eth_getLogs': return { result: [] };
    case 'eth_getTransactionByHash': return { result: null };
    case 'eth_getTransactionReceipt': return st.sent.has(params[0]) ? { result: receiptFor(params[0]) } : { error: { code: -32000, message: 'receipt not found' } };
    case 'eth_getCode': return { result: st.sent.size ? '0x60' : '0x' };   // code once something was created
    default: return null;
  }
};
const backendScript = ({ hash = HEAD_HASH, st = { sent } } = {}) => (method, params) => {
  switch (method) {
    case 'eth_chainId': return { result: '0x2105' };
    case 'eth_getBlockByNumber': return { result: blockAt(Number(BigInt(params[0])), { hash }) };
    case 'eth_getTransactionCount': return { result: '0x' + st.sent.size.toString(16) };   // the pool: one sender, each accepted send
    case 'eth_maxPriorityFeePerGas': return { result: '0x1' };
    case 'eth_sendRawTransaction': { const h = keccak256(params[0]); sent.set(h, params[0]); st.sent.set(h, params[0]); return { result: h }; }
    default: return null;
  }
};

// one store.js scenario in a fresh process (its own env, the module state of a real relay process)
const SCENARIO = `
const S = await import(process.env.STORE_DIR + '/store.js');
const { createWalletClient } = await import('viem');
const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
const out = {};
try {
  if (process.env.MODE === 'init') { const p = await S.rpcParts(); out.authority = !!p.authority; }
  if (process.env.MODE === 'read') {
    const pub = await S.rpcPool(), parts = await S.rpcParts();
    out.authority = !!parts.authority; out.same = pub === (parts.authority ? parts.authority.client : pub);
    out.balance = String(await pub.readContract({ address: '${a(0x7c)}', abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: ['${a(1)}'] }));
    out.logs = (await pub.getLogs({ address: '${a(0x7c)}', fromBlock: 99n, toBlock: 100n })).length;
  }
  if (process.env.MODE === 'send') {
    const { chain, transport } = await S.rpcParts();
    const wallet = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain, transport });
    const hash = await wallet.writeContract({ address: '${a(0x7c)}', abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }], functionName: 'transfer', args: ['${a(2)}', 5n] });
    const rcpt = await (await S.rpcPool()).waitForTransactionReceipt({ hash, timeout: 20000, pollingInterval: 200 });
    out.hash = hash; out.status = rcpt.status;
  }
  if (process.env.MODE === 'vault') {               // the production relayer path: relay/vaultsvc.js on rpcParts()/rpcPool()
    const V = await import(process.env.STORE_DIR + '/vaultsvc.js');
    await V.initVault({ addressBook: '${a(0xb00c)}', usdc: '${a(0x7c)}' });
    out.enabled = V.vaultEnabled(); out.broadcast = [];
    const r = await V.depositToVault({ x: '1', y: '2' }, 5n, (hash, vault) => out.broadcast.push({ hash, vault }));
    out.vault = r.vault; out.hash = r.txHash;
  }
} catch (e) { const why = []; for (let x = e; x; x = x.cause) why.push(String(x.details || ''), String(x.shortMessage || ''), String(x.message || '')); out.err = why.filter(Boolean).join(' | '); }   // viem wraps the refusal: keep its whole cause chain
console.log('RESULT ' + JSON.stringify(out));
`;
fs.writeFileSync(path.join(FLAT, 'scenario.mjs'), SCENARIO); fs.writeFileSync(path.join(BARE, 'scenario.mjs'), SCENARIO);
function child(argv, { env, cwd, until = null, ms = 60000 }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--import', PRELOAD, ...argv], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(c);
    let out = '', done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ out, code, child: c }); };
    const t = setTimeout(() => finish(null), ms);
    const on = (d) => { out += d; if (until && until.test(out)) finish(null); };
    c.stdout.on('data', on); c.stderr.on('data', on); c.on('exit', (code) => finish(code ?? -1));
  });
}
async function scenario(name, mode, env, dir = FLAT) {
  const r = await child([path.join(dir, 'scenario.mjs')], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, STORE_DIR: dir, MODE: mode, PUBLIC_LOG: publicLog(name), ...env } });
  const m = /RESULT (.*)/.exec(r.out); assert.ok(m, r.out.slice(-1500));
  return JSON.parse(m[1]);
}
const auth = (v, b) => ({ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url, ...(b ? { ENCLAVE_CHAIN_TX_BACKEND: b.url } : {}) });

test('store legacy: no chain authority named -> the BASE_RPC pool exactly as before, without the runtime bundle; the verifier is never asked', async () => {
  const legacy = await scripted(verifierScript()), v = await scripted(verifierScript());
  const r = await scenario('legacy', 'read', { BASE_RPC: legacy.url, RPC_FALLBACKS: '0' }, BARE);
  assert.equal(r.err, undefined, r.err); assert.equal(r.authority, false); assert.equal(r.balance, '7'); assert.equal(r.logs, 0);
  assert.deepEqual(legacy.methods().filter((m) => m === 'eth_call' || m === 'eth_getLogs').sort(), ['eth_call', 'eth_getLogs']);
  assert.equal(v.calls.length, 0); assert.deepEqual(publicRequests('legacy'), []);
});

test('store verifier: pool reads are the authority (one marked client), proven by the verifier; no provider, the backend is not asked for state', async () => {
  const v = await scripted(verifierScript()), b = await scripted(backendScript());
  const r = await scenario('vread', 'read', auth(v, b));
  assert.equal(r.err, undefined, r.err); assert.equal(r.authority, true); assert.equal(r.same, true); assert.equal(r.balance, '7');
  assert.ok(v.methods().includes('eth_call') && v.methods().includes('eth_getLogs'), v.methods().join());
  assert.deepEqual(b.calls, [], 'state and logs never go to the own backend');
  assert.deepEqual(publicRequests('vread'), [], 'no non-loopback request at all');
});

test('store verifier: a wallet on rpcParts() submits ONLY to the bound own backend; nonce/fees from it; receipt from the verifier', async () => {
  const v = await scripted(verifierScript()), b = await scripted(backendScript());
  const r = await scenario('vsend', 'send', auth(v, b));
  assert.equal(r.err, undefined, r.err); assert.equal(r.status, 'success'); assert.ok(sent.has(r.hash));
  assert.ok(!v.methods().includes('eth_sendRawTransaction'), 'the verifier is never sent a transaction');
  assert.equal(b.methods().filter((m) => m === 'eth_sendRawTransaction').length, 1, b.methods().join());
  const sendAt = b.methods().indexOf('eth_sendRawTransaction');
  assert.ok(b.methods().slice(0, sendAt).includes('eth_getBlockByNumber'), 'the backend is bound to the verifier head before the send');
  assert.ok(b.calls.some((c) => c.method === 'eth_getTransactionCount' && c.params[1] === 'pending'), 'the pending nonce comes from the own backend');
  assert.ok(b.methods().includes('eth_maxPriorityFeePerGas'), 'the fee hint comes from the own backend');
  for (const m of ['eth_call', 'eth_getLogs', 'eth_getBalance', 'eth_getTransactionReceipt']) assert.ok(!b.methods().includes(m), `${m} never asked of the backend`);
  assert.ok(v.methods().includes('eth_estimateGas') && v.methods().includes('eth_getTransactionReceipt'), v.methods().join());
  assert.deepEqual(publicRequests('vsend'), []);
});

test('vaultsvc on the verifier (real relayer path): book + factory reads proven; createVault then deposit sent ONLY to the bound backend with pool nonces 0,1; the hash persisted before the receipt is the one sent', async () => {
  const st = { sent: new Map() };
  const v = await scripted(verifierScript({ st })), b = await scripted(backendScript({ st }));
  const r = await scenario('vault', 'vault', { ...auth(v, b), PROVISIONER_PRIVATE_KEY: '0x' + '11'.repeat(32) });   // a test-only key
  assert.equal(r.err, undefined, r.err); assert.equal(r.enabled, true);
  const raws = b.calls.filter((c) => c.method === 'eth_sendRawTransaction').map((c) => parseTransaction(c.params[0]));
  assert.deepEqual(raws.map((t) => t.nonce), [0, 1], 'createVault then the deposit, at the own pool\'s nonces');
  assert.equal(raws[0].data.slice(0, 10), toFunctionSelector('createVault(uint256,uint256)'));
  assert.equal(raws[1].to.toLowerCase(), a(0x7c)); assert.equal(raws[1].data.slice(0, 10), toFunctionSelector('transfer(address,uint256)'));
  assert.equal(raws[0].chainId, 8453); assert.ok(raws.every((t) => t.maxPriorityFeePerGas === 1n), 'the fee hint is the own backend\'s');
  assert.deepEqual(r.broadcast.map((x) => x.hash), [r.hash]); assert.equal(keccak256(b.calls.filter((c) => c.method === 'eth_sendRawTransaction')[1].params[0]), r.hash);
  assert.ok(v.calls.some((c) => c.method === 'eth_call' && String(c.params[0]?.to).toLowerCase() === a(0xb00c)), 'the factory comes from the admin\'s book, via the verifier');
  assert.ok(v.methods().includes('eth_getCode') && v.calls.some((c) => c.method === 'eth_getTransactionReceipt' && c.params[0] === r.hash));
  assert.ok(!v.methods().includes('eth_sendRawTransaction'));
  for (const m of ['eth_call', 'eth_getCode', 'eth_getLogs', 'eth_getTransactionReceipt']) assert.ok(!b.methods().includes(m), `${m} never asked of the backend`);
  assert.deepEqual(publicRequests('vault'), []);
});

test('vaultsvc on the verifier, stale head: the deposit path signs nothing that reaches any server', async () => {
  const st = { sent: new Map() };
  const v = await scripted(verifierScript({ st, age: 600 })), b = await scripted(backendScript({ st }));
  const r = await scenario('vault-stale', 'vault', { ...auth(v, b), PROVISIONER_PRIVATE_KEY: '0x' + '11'.repeat(32) });
  assert.match(String(r.err), /s old/, r.err); assert.deepEqual(r.broadcast, []);
  assert.ok(!b.methods().includes('eth_sendRawTransaction') && !v.methods().includes('eth_sendRawTransaction'));
  assert.deepEqual(publicRequests('vault-stale'), []);
});

test('store verifier: unbound backend, stale head, no backend -> the send is refused before reaching any server; nothing public', async () => {
  for (const [name, v, b, why] of [
    ['unbound', await scripted(verifierScript()), await scripted(backendScript({ hash: '0x' + 'ee'.repeat(32) })), /another block/],
    ['stale', await scripted(verifierScript({ age: 600 })), await scripted(backendScript()), /s old/],
    ['nobackend', await scripted(verifierScript()), null, /only known to an own transaction backend \(ENCLAVE_CHAIN_TX_BACKEND unset\)|no own transaction backend/]]) {
    const r = await scenario(name, 'send', auth(v, b));
    assert.match(String(r.err), why, `${name}: ${r.err}`);
    assert.ok(!(b?.methods() || []).includes('eth_sendRawTransaction') && !v.methods().includes('eth_sendRawTransaction'), name);
    assert.deepEqual(publicRequests(name), [], name);
  }
});

test('store verifier outage: reads and sends fail closed; the pool and public defaults are never used instead', async () => {
  const dead = { url: `http://127.0.0.1:${await freePort()}/` }, b = await scripted(backendScript());
  const r = await scenario('outage-read', 'read', auth(dead, b));
  assert.match(String(r.err), /unreachable|fetch failed|ECONNREFUSED/i, r.err);
  const s = await scenario('outage-send', 'send', auth(dead, b));
  assert.ok(s.err, 'the send fails'); assert.ok(!b.methods().includes('eth_sendRawTransaction'));
  assert.deepEqual([...publicRequests('outage-read'), ...publicRequests('outage-send')], []);
});

test('store: invalid or mixed selections refuse before any request (BASE_RPC, RPC_FALLBACKS, remote verifier, public backend, testnet, R4-R6 provider lists)', async () => {
  const v = await scripted(verifierScript());
  for (const [i, [env, why]] of [
    [{ ...auth(v), BASE_RPC: 'http://127.0.0.1:1/' }, /BASE_RPC must be unset/],
    [{ ...auth(v), RPC_FALLBACKS: '0' }, /RPC_FALLBACKS must be unset/],
    [{ ENCLAVE_CHAIN_VERIFIER: v.url }, /not verifier/],
    [{ ENCLAVE_CHAIN_AUTHORITY: 'quorum', ENCLAVE_CHAIN_TX_BACKEND: 'http://127.0.0.1:2/' }, /not verifier/],
    [{ ENCLAVE_CHAIN_AUTHORITY: 'verfier', ENCLAVE_CHAIN_VERIFIER: v.url }, /must be quorum or verifier/],
    [{ ENCLAVE_CHAIN_AUTHORITY: 'verifier' }, /needs ENCLAVE_CHAIN_VERIFIER/],
    [{ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'https://rpc.example.org/' }, /local endpoint/],
    [{ ...auth(v), ENCLAVE_CHAIN_TX_BACKEND: 'https://base.example.org/' }, /loopback or private IPv4/],
    [{ ...auth(v), ENCLAVE_CHAIN_TX_BACKEND: 'http://8.8.8.8:8545/' }, /public address/],
    [{ ...auth(v), BILLING_NETWORK: 'base-sepolia' }, /BILLING_NETWORK must be base/],
    // the R4-R6 provider lists (their consumers read through the authority now; the sponsor is migrated, not refused)
    [{ ...auth(v), SECRETS_RELEASE_CATALOG_RPCS: 'https://a.example,https://b.example' }, /SECRETS_RELEASE_CATALOG_RPCS must be unset/],
    [{ ...auth(v), CUSTODY_RPCS: 'https://a.example,https://b.example' }, /CUSTODY_RPCS must be unset/],
    [{ ...auth(v), CUSTODY_MIN_AGREE: '1' }, /CUSTODY_MIN_AGREE must be unset/],
    [{ ...auth(v), SESSIONS_RPC: 'http://127.0.0.1:3/' }, /SESSIONS_RPC must be unset/],
    [{ ...auth(v), SESSIONS_NETWORK: 'base-sepolia' }, /SESSIONS_NETWORK must be base/]].entries()) {
    const r = await scenario(`mixed-${i}`, 'init', env);
    assert.match(String(r.err), why, `case ${i}: ${r.err}`);
    assert.deepEqual(publicRequests(`mixed-${i}`), [], `case ${i}`);
  }
  assert.equal(v.calls.length, 0, 'a refused selection contacts nothing');
});

// ---- api-relay.js as a process: chain() consumers (the admin's book, placement) through the same authority ------------
async function apiRelay(name, env) {
  const port = await freePort();
  const r = await child([path.join(FLAT, 'api-relay.js')], { cwd: FLAT, until: /\[api-relay\] :\d+/, ms: 60000,
    env: { PATH: process.env.PATH, HOME: FLAT, ENCLAVES: 'http://127.0.0.1:1', API_RELAY_PORT: String(port), API_RELAY_BIND: '127.0.0.1',
      ADDRESS_BOOK_ADDRESS: a(0xb00c), FEATURED_VIEWS_FILE: path.join(tmp, `views-${port}.json`), PUBLIC_LOG: publicLog(name), ...env } });
  return { ...r, port };
}
const ID = '0x' + '42'.repeat(32);
// a ledger record read: answered from EnclaveDeployments with zero live enclaves (api-relay ledgerRows() through chain())
const recordRead = (port) => fetch(`http://127.0.0.1:${port}/v1/deployments/${ID}`).then(async (r) => `${r.status} ${(await r.text()).slice(0, 300)}`, (e) => `0 ${e.message}`);
// getPage(uint256,uint256) on the ledger: only api-relay's ledgerRows() pages it (not the network LeaseReader)
const askedPage = (srv) => srv.calls.some((c) => c.method === 'eth_call' && String(c.params[0]?.to || '').toLowerCase() === a(0x12)
  && String(c.params[0]?.data || c.params[0]?.input || '').startsWith(SEL.getPage));
const askedBook = (srv) => srv.calls.some((c) => c.method === 'eth_call' && String(c.params[0]?.to || '').toLowerCase() === a(0xb00c) && String(c.params[0]?.data || c.params[0]?.input || '').startsWith(SEL.addr));

test('api-relay process, verifier: the book (admin anchor) and ledger reads of chain() are the verifier; no provider; the backend is not asked for state', { timeout: 180000 }, async () => {
  const v = await scripted(verifierScript()), b = await scripted(backendScript());
  const r = await apiRelay('relay-v', auth(v, b));
  assert.match(r.out, /\[chain\] relay chain authority: local verifier .* no provider RPC is used/, r.out.slice(-1500));
  // the admin's book through chain() (resolveDeployments logs what it read; the verifier is the only server it could ask)
  assert.match(r.out, /\[api-relay\] address book: deployments \(unset\) -> 0x0{38}12/, r.out.slice(-1500));
  const st = await recordRead(r.port);
  assert.ok(await waitFor(() => askedBook(v) && askedPage(v)), `record read ${st}; the verifier saw: ${JSON.stringify(v.calls.map((c) => [c.method, c.params[0]?.to, String(c.params[0]?.data || c.params[0]?.input || '').slice(0, 10)]))}\n${r.out.slice(-1500)}`);
  assert.ok(!b.methods().some((m) => ['eth_call', 'eth_getLogs', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt'].includes(m)), b.methods().join());
  assert.deepEqual(publicRequests('relay-v').filter((x) => x.rpc), [], 'no JSON-RPC request leaves loopback');
  r.child.kill('SIGKILL');
});

test('api-relay process, legacy: chain() reads BASE_RPC exactly as before; the verifier is never asked', { timeout: 180000 }, async () => {
  const legacy = await scripted(verifierScript()), v = await scripted(verifierScript());
  // no address book here (the legacy network reader needs two independent HTTPS providers); the ledger address is pinned
  const r = await apiRelay('relay-legacy', { BASE_RPC: legacy.url, RPC_FALLBACKS: '0', ADDRESS_BOOK_ADDRESS: undefined, DEPLOYMENTS_ADDRESS: a(0x12) });
  assert.doesNotMatch(r.out, /relay chain authority/);
  const st = await recordRead(r.port);
  assert.ok(await waitFor(() => askedPage(legacy)), `record read ${st}; BASE_RPC saw: ${legacy.methods().join()}\n${r.out.slice(-1500)}`);
  assert.equal(v.calls.length, 0);
  r.child.kill('SIGKILL');
});

test('api-relay process: a mixed or invalid relay chain selection stops the relay at startup, before any chain request', { timeout: 180000 }, async () => {
  const v = await scripted(verifierScript());
  for (const [i, [env, why]] of [[{ ...auth(v), BASE_RPC: 'http://127.0.0.1:1/' }, /BASE_RPC must be unset/],
    [{ ...auth(v), CUSTODY_RPCS: 'https://a.example,https://b.example' }, /CUSTODY_RPCS must be unset/],
    [{ ...auth(v), ENCLAVE_CHAIN_TX_BACKEND: 'https://base.example.org/' }, /loopback or private IPv4/]].entries()) {
    const r = await apiRelay(`relay-mixed-${i}`, env);
    await waitFor(() => r.child.exitCode !== null);
    assert.equal(r.child.exitCode, 1, r.out.slice(-1200)); assert.match(r.out, /fatal: relay chain authority: /); assert.match(r.out, why);
    assert.deepEqual(publicRequests(`relay-mixed-${i}`).filter((x) => x.rpc), []);
  }
  assert.equal(v.calls.length, 0, 'the relay stopped before contacting the verifier');
});
