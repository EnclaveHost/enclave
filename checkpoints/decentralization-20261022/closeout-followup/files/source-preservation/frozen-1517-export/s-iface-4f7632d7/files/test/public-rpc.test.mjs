// The host's public JSON-RPC role (network/public-rpc.mjs, host-service role 'public-rpc') on a REAL chain node: reth v2.8.0
// --dev with the 8453 genesis (test/helpers/reth-dev.mjs) as the operator's own local Base node, behind a fault proxy (down,
// stall, syncing, stale head, oversized answers). A probe contract (test/helpers/rpc-probe-contract.mjs) gives calls,
// history and reverts.
//   - the browser note's methods answer from the node: EIP-1898 block-hash reads, reverts with code/reason/data, estimates,
//     logs within the range bound, receipts; the only backend URL ever fetched is the configured node (or verifier);
//   - eth_sendRawTransaction is refused unless the operator states a propagation route; then the node's own answer returns;
//   - admin/debug/personal/signing/txpool/filter methods, unknown methods, batches, oversized bodies, bad JSON, wrong content
//     type, other paths and verbs are refused without reaching the node;
//   - CORS: allowed origins only, POST + content-type only, never credentials;
//   - bounds: a stalled node answers 504 within the deadline, in-flight and rate limits refuse at once, an all-down node and
//     a syncing or stale node refuse (503) instead of answering;
//   - the local verifier answers only its configured methods, never falls back to the node, and every answer says its source;
//   - two names of one host are one vote (network/public-rpc-hosts.mjs);
//   - the consumer interface: eth_getProof (bounded keys) and eth_getBlockByHash (no transactions) labelled proof material,
//     the pending nonce and the tip quote labelled the node's unverified view; every malformed shape refused before the node;
//   - configuration and runner: loopback node only, no secret, hostId = this host's registry id, not advertised (no index kind);
//   - the PACKAGED role (scripts/build-host-service-packages.mjs) under network/host-services/runner.mjs: reviewed bytes only,
//     and the platform host policy gate stops and restarts it.
//   run: node --test test/public-rpc.test.mjs     (reth binary RETH_BIN; the packaged-role test needs the built packages)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http as viemHttp, encodeFunctionData, decodeFunctionResult, keccak256, toBytes, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRethDev, haveReth, DEV_KEY, freePort } from './helpers/reth-dev.mjs';
import { compileProbe } from './helpers/rpc-probe-contract.mjs';
import { startLoopbackVerifier } from './helpers/loopback-verifier.mjs';
import { createPublicRpc, validatePublicRpcConfig, SERVED_METHODS } from '../network/public-rpc.mjs';
import { rpcHostIdentities, assertDistinctRpcHosts } from '../network/public-rpc-hosts.mjs';
import { ROLES } from '../network/host-services/roles.mjs';
import { validateHostServicesConfig, planHostServices, runHostServices, advertisements } from '../network/host-services/runner.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(REPO, 'network/host-services/packages');
const skip = haveReth() || false;
const chain = defineChain({ id: 8453, name: 'base-dev', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } });
const ENDPOINT = 'https://host-rpc.public-rpc-test.net', HOST_ID = keccak256(toBytes(ENDPOINT)).toLowerCase();
const PAGE = 'http://localhost:18999';
let reth, probe, proxy, mode = 'ok', deployBlock, pokeTx, roles = [];

/* the operator's node behind a fault proxy */
async function startProxy(upstream) {
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    if (mode === 'down') return req.socket.destroy();
    if (mode === 'stall') return;                                        // never answers
    const q = JSON.parse(body);
    if (mode === 'syncing' && q.method === 'eth_syncing') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: { startingBlock: '0x0', currentBlock: '0x1', highestBlock: '0xffff' } })); }
    if (mode === 'big') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: '0x' + 'ab'.repeat(70000) })); }
    const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    let text = await r.text();
    if (mode === 'stale' && q.method === 'eth_getBlockByNumber') { const j = JSON.parse(text); if (j.result) j.result.timestamp = '0x' + (BigInt(j.result.timestamp) - 10000n).toString(16); text = JSON.stringify(j); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(text);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok); }) };
}
async function role(over = {}, { fetchLog = [], methodLog = [] } = {}) {
  const r = await createPublicRpc({ port: await freePort(), bind: '127.0.0.1', hostId: HOST_ID, chainId: 8453, node: proxy.url, allowedOrigins: [PAGE], ...over },
    { fetch: (u, o) => { fetchLog.push(String(u)); methodLog.push(JSON.parse(o.body).method); return fetch(u, o); } });
  roles.push(r); r.url = `http://127.0.0.1:${r.port}`; r.fetchLog = fetchLog; r.methodLog = methodLog; return r;
}
const post = (r, body, headers = {}) => fetch(r.url + '/', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const call = async (r, method, params = [], headers) => { const res = await post(r, { jsonrpc: '2.0', id: 7, method, params }, headers); return { status: res.status, headers: res.headers, body: await res.json() }; };

before(async () => {
  if (skip) return;
  reth = await startRethDev({ blockTime: '1s' });
  probe = compileProbe();
  const pc = createPublicClient({ chain, transport: viemHttp(reth.url) });
  const wc = createWalletClient({ chain, account: privateKeyToAccount(DEV_KEY), transport: viemHttp(reth.url) });
  const rc = await pc.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: probe.abi, bytecode: probe.bytecode }) });
  probe.address = rc.contractAddress; deployBlock = rc.blockNumber; probe.deployTx = rc.transactionHash;
  pokeTx = await wc.writeContract({ address: probe.address, abi: probe.abi, functionName: 'poke', args: [7n] });
  await pc.waitForTransactionReceipt({ hash: pokeTx });
  proxy = await startProxy(reth.url);
});
after(async () => { for (const r of roles) await r.close().catch(() => {}); await proxy?.close(); reth?.stop(); });

test('configuration: the operator\'s own loopback node only, no secret, no remote verifier; the runner binds it to this host and never advertises it', () => {
  const ok = { port: 18191, bind: '127.0.0.1', hostId: HOST_ID, chainId: 8453, node: 'http://127.0.0.1:8545', allowedOrigins: ['https://dashboard.example'] };
  assert.equal(validatePublicRpcConfig(ok).limits.maxLogRange, 2000);
  for (const [over, re] of [[{ node: 'https://mainnet.base.org' }, /loopback/], [{ node: 'http://10.0.0.5:8545' }, /RPC URLs must be HTTPS|loopback/], [{ bind: '0.0.0.0' }, /bind must be loopback/],
    [{ apiKey: 'x' }, /holds no secret/], [{ chainVerifier: 'http://127.0.0.1:8545', verifiedMethods: ['eth_call'] }, /node itself/],
    [{ chainVerifier: 'https://verifier.example', verifiedMethods: ['eth_call'] }, /loopback/], [{ chainVerifier: 'http://127.0.0.1:8546', verifiedMethods: ['eth_getLogs'] }, /subset/],
    [{ rawTransactions: { propagation: 'x' } }, /propagation/], [{ allowedOrigins: ['https://a.example/path'] }, /bare https origin/], [{ allowedOrigins: ['*', 'https://a.example'] }, /allowedOrigins\[0\] is not a URL/],
    [{ limits: { maxBodyBytes: 1 << 30 } }, /maxBodyBytes/], [{ hostId: '0x' + '00'.repeat(32) }, /registry id/]])
    assert.throws(() => validatePublicRpcConfig({ ...ok, ...over }), re, JSON.stringify(over));
  assert.equal(ROLES['public-rpc'].kind, null, 'no service-index kind is claimed');
  const cfg = (svc, extra = {}) => ({ format: 'enclave-host-services/v1', host: { endpoint: ENDPOINT, ...extra }, platformHostPolicy: 'production', packagesDir: '/tmp/p', stateRoot: '/tmp/s',
    services: [{ role: 'public-rpc', package: 'sha256:' + '0'.repeat(64), config: svc }] });
  assert.equal(validateHostServicesConfig(cfg(ok)).services[0].config.hostId, HOST_ID);
  assert.throws(() => validateHostServicesConfig(cfg({ ...ok, hostId: keccak256(toBytes('https://other.example')) })), /hostId must be this host's registry id/);
  assert.throws(() => validateHostServicesConfig(cfg(ok, { publicEndpoints: { 'public-rpc': ['https://rpc.example/'] } })), /no service-index kind and is not advertised/);
});

test('the browser\'s methods from the operator\'s node: EIP-1898 reads, reverts, estimates, history, receipts; only the node is fetched', { skip }, async () => {
  const r = await role();
  const id = await call(r, 'eth_chainId');
  assert.equal(id.body.result, '0x2105'); assert.equal(id.headers.get('x-enclave-rpc-source'), 'node'); assert.equal(id.headers.get('x-enclave-rpc-host'), HOST_ID);
  const head = await call(r, 'eth_getBlockByNumber', ['latest', false]);
  assert.match(head.body.result.hash, /^0x[0-9a-f]{64}$/);
  const value = encodeFunctionData({ abi: probe.abi, functionName: 'value' });
  for (const at of ['latest', head.body.result.number, { blockHash: head.body.result.hash }, { blockHash: head.body.result.hash, requireCanonical: true }, { blockNumber: head.body.result.number }]) {
    const c = await call(r, 'eth_call', [{ to: probe.address, data: value }, at]);
    assert.equal(decodeFunctionResult({ abi: probe.abi, functionName: 'value', data: c.body.result }), 7n, JSON.stringify(at));
  }
  const before = await call(r, 'eth_call', [{ to: probe.address, data: value }, '0x' + deployBlock.toString(16)]);
  assert.equal(decodeFunctionResult({ abi: probe.abi, functionName: 'value', data: before.body.result }), 42n, 'a historical block answers its own state');
  const rev = await call(r, 'eth_call', [{ to: probe.address, data: encodeFunctionData({ abi: probe.abi, functionName: 'fail' }) }, 'latest']);
  assert.equal(rev.status, 200); assert.match(rev.body.error.message, /revert/i); assert.equal(rev.body.error.code, 3);
  assert.match(String(rev.body.error.data), /^0x08c379a0/, 'the revert reason data is returned unchanged');
  const pin = { blockHash: head.body.result.hash };
  assert.match((await call(r, 'eth_getCode', [probe.address, pin])).body.result, /^0x6080/);
  assert.match((await call(r, 'eth_getBalance', [privateKeyToAccount(DEV_KEY).address, pin])).body.result, /^0x[0-9a-f]+$/);
  assert.equal(BigInt((await call(r, 'eth_getStorageAt', [probe.address, '0x0', pin])).body.result), 7n);
  assert.ok(Number((await call(r, 'eth_getTransactionCount', [privateKeyToAccount(DEV_KEY).address, 'latest'])).body.result) >= 2);
  const est = await call(r, 'eth_estimateGas', [{ from: privateKeyToAccount(DEV_KEY).address, to: probe.address, data: encodeFunctionData({ abi: probe.abi, functionName: 'poke', args: [8n] }) }, 'latest']);
  assert.ok(BigInt(est.body.result) > 21000n);
  const logs = await call(r, 'eth_getLogs', [{ address: probe.address, fromBlock: '0x' + deployBlock.toString(16), toBlock: 'latest' }]);
  assert.equal(logs.body.result.length, 1); assert.equal(logs.body.result[0].transactionHash, pokeTx);
  const rcpt = await call(r, 'eth_getTransactionReceipt', [pokeTx]);
  assert.equal(rcpt.body.result.status, '0x1');
  assert.equal((await call(r, 'eth_getTransactionByHash', [pokeTx])).body.result.hash, pokeTx);
  const wide = await call(r, 'eth_getLogs', [{ address: probe.address, fromBlock: '0x0', toBlock: '0x' + (2000n + 5n).toString(16) }]);
  assert.match(wide.body.error.message, /at most 2000 blocks/);
  assert.match((await call(r, 'eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x1' }])).body.error.message, /exactly one contract/);
  assert.deepEqual([...new Set(r.fetchLog)], [proxy.url], 'the role fetched nothing but the configured node');
});

test('raw transactions: refused unless the operator states a route; then the node\'s own answer, never a fabricated hash', { skip }, async () => {
  const wc = createWalletClient({ chain, account: privateKeyToAccount(DEV_KEY), transport: viemHttp(reth.url) });
  const raw = await wc.signTransaction(await wc.prepareTransactionRequest({ to: probe.address, data: encodeFunctionData({ abi: probe.abi, functionName: 'poke', args: [9n] }) }));
  const off = await role();
  const refused = await call(off, 'eth_sendRawTransaction', [raw]);
  assert.match(refused.body.error.message, /not offered: this operator has not stated a transaction propagation route/);
  assert.ok(!off.fetchLog.length, 'nothing reached the node');
  assert.equal((await (await fetch(off.url + '/health')).json()).rawTransactions.offered, false);
  const on = await role({ rawTransactions: { propagation: 'test: the dev node mines locally (no network)' } });
  const health = await (await fetch(on.url + '/health')).json();
  assert.deepEqual(health.rawTransactions, { offered: true, propagation: 'test: the dev node mines locally (no network)', checkedByThisRole: false });
  const sent = await call(on, 'eth_sendRawTransaction', [raw]);
  assert.equal(sent.body.result, keccak256(raw)); assert.equal(sent.headers.get('x-enclave-rpc-propagation'), 'operator-stated');
  let rc = null; for (let i = 0; i < 60 && !rc; i++) { rc = (await call(on, 'eth_getTransactionReceipt', [sent.body.result])).body.result; if (!rc) await new Promise((x) => setTimeout(x, 250)); }
  assert.equal(rc.status, '0x1');
  const dup = await call(on, 'eth_sendRawTransaction', [raw]);
  assert.ok(dup.body.error, 'the node refuses a replay and the role says so: ' + JSON.stringify(dup.body));
});

test('refused without reaching the node: privileged and signing methods, unknown methods, batches, bad bodies, other paths and verbs', { skip }, async () => {
  const r = await role({ limits: { maxBodyBytes: 4096 } });
  for (const m of ['admin_nodeInfo', 'admin_addPeer', 'debug_traceTransaction', 'personal_unlockAccount', 'personal_sign', 'eth_sign', 'eth_signTypedData_v4', 'eth_sendTransaction',
    'eth_accounts', 'txpool_content', 'eth_newFilter', 'eth_getFilterChanges', 'eth_subscribe', 'eth_createAccessList', 'miner_start', 'engine_newPayloadV3', 'trace_block'])
    assert.match((await call(r, m, [])).body.error.message, /not offered by a public endpoint/, m);
  assert.equal((await call(r, 'eth_mysteryMethod', [])).body.error.code, -32601);
  assert.match((await (await post(r, [{ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }])).json()).error.message, /batch requests are not served/);
  assert.equal((await post(r, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: probe.address, data: '0x' + '00'.repeat(5000) }, 'latest'] })).status, 413);
  assert.equal((await (await post(r, '{not json')).json()).error.code, -32700);
  assert.equal((await post(r, '{}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await fetch(r.url + '/')).status, 405);
  assert.equal((await fetch(r.url + '/v1/anything', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  for (const [m, p, re] of [['eth_getBlockByNumber', ['latest', true], /full transaction objects/], ['eth_call', [{ to: probe.address }, 'latest', { [probe.address]: { code: '0x00' } }], /expects 2 parameters/],
    ['eth_call', [{ to: probe.address }, 'pending'], /pending is not served/], ['eth_call', [{ to: probe.address, stateOverride: {} }, 'latest'], /unsupported call field/],
    ['eth_getBalance', ['0x1234', 'latest'], /address/], ['eth_getTransactionReceipt', ['0x12'], /32-byte hash/]])
    assert.match((await call(r, m, p)).body.error.message, re, m);
  const count = r.fetchLog.length;
  for (const m of ['admin_nodeInfo', 'debug_traceTransaction', 'eth_sendTransaction']) await call(r, m, []);
  assert.equal(r.fetchLog.length, count, 'refused methods never reach the node');
});

test('inherited names are never methods, call fields, limits or roles (root allowlist review: own properties only)', { skip }, async () => {
  const r = await role();
  const before = r.fetchLog.length;
  for (const m of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', '__defineGetter__', 'isPrototypeOf'])
    assert.equal((await call(r, m, [])).body.error?.code, -32601, m);
  assert.equal(r.fetchLog.length, before, 'an inherited name never reaches the node');
  for (const f of ['constructor', 'toString', '__proto__', 'valueOf']) {
    const body = `{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"${probe.address}","${f}":"0x"},"latest"]}`;
    const res = await (await post(r, body)).json();
    assert.match(res.error?.message || '', /unsupported call field/, f);
  }
  const ok = { port: 18191, bind: '127.0.0.1', hostId: HOST_ID, chainId: 8453, node: 'http://127.0.0.1:8545', allowedOrigins: ['https://dashboard.example'] };
  for (const k of ['constructor', 'toString', 'hasOwnProperty']) assert.throws(() => validatePublicRpcConfig({ ...ok, limits: { [k]: 1 } }), /limits: unknown field/, k);
  assert.throws(() => validatePublicRpcConfig({ ...ok, limits: JSON.parse('{"__proto__":{"maxBodyBytes":1}}') }), /limits: unknown field/);
  for (const role of ['constructor', 'toString', '__proto__'])
    assert.throws(() => validateHostServicesConfig({ format: 'enclave-host-services/v1', host: { endpoint: ENDPOINT }, platformHostPolicy: 'production', packagesDir: '/tmp/p', stateRoot: '/tmp/s',
      services: [{ role, package: 'sha256:' + '0'.repeat(64), config: ok }] }), /unknown role/, role);
});

test('CORS: the configured origins only, POST with content-type only, never credentials', { skip }, async () => {
  const r = await role();
  const pre = await fetch(r.url + '/', { method: 'OPTIONS', headers: { origin: PAGE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), PAGE); assert.equal(pre.headers.get('access-control-allow-methods'), 'POST');
  assert.equal(pre.headers.get('access-control-allow-credentials'), null);
  assert.equal((await fetch(r.url + '/', { method: 'OPTIONS', headers: { origin: PAGE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, authorization' } })).status, 403);
  assert.equal((await fetch(r.url + '/', { method: 'OPTIONS', headers: { origin: PAGE, 'access-control-request-method': 'PUT' } })).status, 403);
  const other = await call(r, 'eth_chainId', [], { origin: 'https://evil.example' });
  assert.equal(other.status, 403); assert.equal(other.headers.get('access-control-allow-origin'), null);
  const ok = await call(r, 'eth_chainId', [], { origin: PAGE });
  assert.equal(ok.headers.get('access-control-allow-origin'), PAGE); assert.equal(ok.headers.get('vary'), 'Origin');
  assert.match(ok.headers.get('access-control-expose-headers'), /x-enclave-rpc-source/);
});

test('bounds and honesty: stalled, down, syncing, stale and oversized backends refuse in bounded time; in-flight and rate limits refuse at once', { skip }, async () => {
  const r = await role({ limits: { backendTimeoutMs: 1000, maxInFlight: 2, maxResponseBytes: 65536 } });
  assert.equal((await call(r, 'eth_chainId')).body.result, '0x2105');          // node health cached as synced
  try {
    mode = 'stall';
    let t = Date.now(); const st = await call(r, 'eth_blockNumber');
    assert.equal(st.status, 504); assert.match(st.body.error.message, /did not answer within 1000 ms/); assert.ok(Date.now() - t < 3500, 'bounded');
    const slow = [call(r, 'eth_blockNumber'), call(r, 'eth_blockNumber')];
    await new Promise((x) => setTimeout(x, 100));
    const busy = await call(r, 'eth_blockNumber');
    assert.equal(busy.status, 503); assert.match(busy.body.error.message, /too many requests in flight/);
    await Promise.all(slow);
    mode = 'down'; await new Promise((x) => setTimeout(x, 2100));             // the cached health expires
    t = Date.now(); const dn = await call(r, 'eth_blockNumber');
    assert.equal(dn.status, 503); assert.match(dn.body.error.message, /node is unreachable; nothing was answered/); assert.ok(Date.now() - t < 3500);
    assert.equal((await fetch(r.url + '/health')).status, 503);
    mode = 'syncing'; await new Promise((x) => setTimeout(x, 2100));
    assert.match((await call(r, 'eth_blockNumber')).body.error.message, /syncing/);
    mode = 'stale'; await new Promise((x) => setTimeout(x, 2100));
    assert.match((await call(r, 'eth_blockNumber')).body.error.message, /head is \d+ s old \(limit 120 s\)/);
    mode = 'ok'; await new Promise((x) => setTimeout(x, 2100));
    assert.equal((await call(r, 'eth_chainId')).body.result, '0x2105');
    mode = 'big';
    const big = await call(r, 'eth_getCode', [probe.address, 'latest']);
    assert.equal(big.status, 502); assert.match(big.body.error.message, /answered more than this endpoint returns/);
  } finally { mode = 'ok'; }
  const rl = await role({ limits: { perSecond: 1, burst: 2 } });
  const s = []; for (let i = 0; i < 3; i++) s.push((await call(rl, 'eth_chainId')).status);
  assert.deepEqual(s, [200, 200, 429]);
});

test('the local verifier answers only its configured methods, never falls back to the node, and every answer names its source', { skip }, async () => {
  const verifier = await startLoopbackVerifier({ upstream: reth.url });
  try {
    const r = await role({ chainVerifier: verifier.url, verifiedMethods: ['eth_call', 'eth_getBalance', 'eth_getBlockByNumber'] });
    const head = await call(r, 'eth_getBlockByNumber', ['latest', false]);
    assert.equal(head.headers.get('x-enclave-rpc-source'), 'verifier');
    const at = { blockHash: head.body.result.hash };
    const v = await call(r, 'eth_call', [{ to: probe.address, data: encodeFunctionData({ abi: probe.abi, functionName: 'value' }) }, at]);
    assert.equal(v.headers.get('x-enclave-rpc-source'), 'verifier'); assert.ok(BigInt(v.body.result) >= 7n);
    const before = r.fetchLog.filter((u) => u === proxy.url).length;
    verifier.state.fault = 'proof';
    const bad = await call(r, 'eth_call', [{ to: probe.address, data: '0x3fa4f245' }, at]);
    assert.match(bad.body.error.message, /invalid storage proof/); assert.equal(bad.headers.get('x-enclave-rpc-source'), 'verifier');
    verifier.state.fault = 'down';
    const down = await call(r, 'eth_getBalance', [probe.address, at]);
    assert.equal(down.status, 503); assert.match(down.body.error.message, /never fall back to the node/);
    assert.equal(r.fetchLog.filter((u) => u === proxy.url).length, before, 'no verified method reached the node');
    verifier.state.fault = null;
    const logs = await call(r, 'eth_getLogs', [{ address: probe.address, fromBlock: '0x' + deployBlock.toString(16), toBlock: 'latest' }]);
    assert.equal(logs.headers.get('x-enclave-rpc-source'), 'node', 'a method the verifier does not prove is answered (and labelled) by the node');
    assert.deepEqual((await (await fetch(r.url + '/health')).json()).verifiedMethods, ['eth_call', 'eth_getBalance', 'eth_getBlockByNumber']);
  } finally { await verifier.close(); }
});

test('two names of one host are one vote; two hosts are two (and say nothing about whether they share a node)', { skip }, async () => {
  const a = await role();
  const ids = await rpcHostIdentities([`http://127.0.0.1:${a.port}`, `http://localhost:${a.port}`]);
  assert.deepEqual(ids.map((x) => x.hostId), [HOST_ID, HOST_ID]);
  assert.throws(() => assertDistinctRpcHosts(ids), /same host .*one vote, not two RPCs/);
  const otherId = keccak256(toBytes('https://host-rpc-b.public-rpc-test.net')).toLowerCase();
  const b = await role({ hostId: otherId });
  const two = assertDistinctRpcHosts(await rpcHostIdentities([a.url, b.url, 'http://127.0.0.1:1']));
  assert.deepEqual(two.map((x) => x.hostId), [HOST_ID, otherId, null], 'a non-role origin states no identity');
  // a and b here front the SAME reth node: distinct host ids are distinct configured hosts, not proof of independent nodes
});

test('the PACKAGED role under the runner: reviewed bytes only, no inherited environment, stopped and restarted by the platform host policy gate', { skip: skip || (!fs.existsSync(path.join(PKG, 'public-rpc.package.json')) && 'needs the built packages') }, async () => {
  const raw = fs.readFileSync(path.join(PKG, 'public-rpc.package.json'));
  const m = JSON.parse(raw);
  assert.equal(m.kind, null); assert.equal(m.entry, 'network/public-rpc.mjs');
  assert.deepEqual(Object.keys(m.inputs).sort(), ['network/public-rpc-config.mjs', 'network/public-rpc.mjs', 'network/rpc-identity.mjs'], 'the bundle reaches only the role, its rules and the URL rule');
  const port = await freePort(), dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'public-rpc-runner-'));
  const cfg = { format: 'enclave-host-services/v1', host: { endpoint: ENDPOINT }, platformHostPolicy: 'production', packagesDir: PKG, stateRoot: dir,
    services: [{ role: 'public-rpc', package: 'sha256:' + createHash('sha256').update(raw).digest('hex'), heapMiB: 96,
      config: { port, bind: '127.0.0.1', hostId: HOST_ID, chainId: 8453, node: proxy.url, allowedOrigins: [PAGE] } }] };
  const plan = planHostServices(cfg);
  assert.deepEqual(plan.services[0].launch.env, {}); assert.ok(plan.services[0].launch.configFile);
  await assert.rejects(advertisements(cfg, { operator: '0x' + '11'.repeat(20), slot: 0, sequence: 1 }), /serviceIndex/);
  const gate = { refusal: null };
  const logs = [];
  const running = await runHostServices(cfg, { gate: { check: async () => {}, start() {}, stop() {}, serviceRefusal: () => gate.refusal, status: () => ({ refusal: gate.refusal }) }, log: (x) => logs.push(x), intervalMs: 200 });
  const ask = () => fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((x) => x.json()).then((j) => j.result, () => null);
  const until = async (f, what) => { for (let i = 0; i < 150; i++) { if (await f()) return; await new Promise((x) => setTimeout(x, 200)); } throw new Error(what + '\n' + logs.join('\n')); };
  try {
    await until(async () => (await ask()) === '0x2105', 'the packaged role serves');
    assert.ok(logs.some((l) => /\[public-rpc\] \[public-rpc\] serving 15 methods/.test(l)), logs.join('\n'));
    gate.refusal = 'platform host policy: banned by platform policy #3 (host): test';
    await until(async () => (await ask()) === null, 'a refused host stops the role');
    gate.refusal = null;
    await until(async () => (await ask()) === '0x2105', 'the admitted host serves again');
  } finally { await running.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('served methods are exactly the browser note\'s profile methods, the explicit raw submission, and the consumer interface (proof material, headers, tip quote)', () => {
  assert.deepEqual([...SERVED_METHODS].sort(), ['eth_blockNumber', 'eth_call', 'eth_chainId', 'eth_estimateGas', 'eth_getBalance', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getCode',
    'eth_getLogs', 'eth_getProof', 'eth_getStorageAt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_maxPriorityFeePerGas', 'eth_sendRawTransaction']);
});

test('consumer interface: proof material and headers by hash, a pending nonce and a tip quote - bounded, labelled by class, never "verified"', { skip }, async () => {
  const r = await role({ limits: { maxProofKeys: 4 } });
  const head = (await call(r, 'eth_getBlockByNumber', ['latest', false])).body.result;
  const owner = privateKeyToAccount(DEV_KEY).address;
  for (const at of [{ blockHash: head.hash }, head.hash, 'latest', head.number]) {
    const pr = await call(r, 'eth_getProof', [probe.address, ['0x0'], at]);
    assert.ok(Array.isArray(pr.body.result?.accountProof) && pr.body.result.accountProof.length > 0, JSON.stringify(at) + ' ' + JSON.stringify(pr.body).slice(0, 300));
    assert.equal(pr.body.result.storageProof.length, 1); assert.ok(BigInt(pr.body.result.storageProof[0].value) >= 7n);
    assert.equal(pr.headers.get('x-enclave-rpc-class'), 'proof-material-unverified'); assert.equal(pr.headers.get('x-enclave-rpc-source'), 'node');
  }
  const bh = await call(r, 'eth_getBlockByHash', [head.hash, false]);
  assert.equal(bh.body.result.hash, head.hash); assert.ok(typeof bh.body.result.transactions[0] !== 'object' || !bh.body.result.transactions.length, 'hashes only');
  assert.equal(bh.headers.get('x-enclave-rpc-class'), 'proof-material-unverified');
  const nonce = await call(r, 'eth_getTransactionCount', [owner, 'pending']);
  assert.match(nonce.body.result, /^0x[0-9a-f]+$/); assert.equal(nonce.headers.get('x-enclave-rpc-class'), 'mempool-unverified');
  assert.equal((await call(r, 'eth_getTransactionCount', [owner, 'latest'])).headers.get('x-enclave-rpc-class'), 'chain-state');
  const tip = await call(r, 'eth_maxPriorityFeePerGas', []);
  assert.match(tip.body.result, /^0x[0-9a-f]+$/); assert.equal(tip.headers.get('x-enclave-rpc-class'), 'fee-quote-unverified');
  const before = r.methodLog.length;
  for (const [m, params, re] of [
    ['eth_getProof', [probe.address, ['0x1', '0x2', '0x3', '0x4', '0x5'], 'latest'], /at most 4/],
    ['eth_getProof', [probe.address, ['0x0', '0x00'], 'latest'], /repeat/],
    ['eth_getProof', [probe.address, ['zz'], 'latest'], /hex word/],
    ['eth_getProof', [probe.address, ['0x' + '1'.repeat(65)], 'latest'], /hex word/],
    ['eth_getProof', [probe.address, '0x0', 'latest'], /storage keys/],
    ['eth_getProof', [probe.address, {}, 'latest'], /storage keys/],
    ['eth_getProof', ['0x1234', [], 'latest'], /address/],
    ['eth_getProof', [probe.address, [], 'pending'], /pending is not served/],
    ['eth_getProof', [probe.address, [], 'latest', {}], /expects 3 parameters/],
    ['eth_getProof', [probe.address, [], { blockHash: head.hash, extra: 1 }], /blockHash, requireCanonical/],
    ['eth_getBlockByHash', [head.hash, true], /full transaction objects/],
    ['eth_getBlockByHash', [head.hash], /expects 2 parameters/],
    ['eth_getBlockByHash', ['0x12', false], /32-byte hash/],
    ['eth_getBlockByHash', [head.number, false], /32-byte hash/],
    ['eth_getBalance', [owner, 'pending'], /pending is not served/],
    ['eth_call', [{ to: probe.address }, 'pending'], /pending is not served/],
    ['eth_getCode', [probe.address, 'pending'], /pending is not served/],
    ['eth_getTransactionCount', [owner, 'pending', 'x'], /expects 2 parameters/],
    ['eth_getTransactionCount', [owner, 'safe-ish'], /block must be/],
    ['eth_maxPriorityFeePerGas', ['latest'], /expects 0 parameters/],
  ]) assert.match((await call(r, m, params)).body.error?.message || '', re, `${m} ${JSON.stringify(params)}`);
  // inherited names: still not methods, and a storage key named like a prototype member is just an invalid key
  for (const m of ['constructor', '__proto__', 'toString']) assert.equal((await call(r, m, [probe.address, [], 'latest'])).body.error.code, -32601);
  assert.match((await call(r, 'eth_getProof', [probe.address, ['constructor'], 'latest'])).body.error.message, /hex word/);
  assert.deepEqual([...new Set(r.methodLog.slice(before))].filter((m) => !['eth_chainId', 'eth_syncing', 'eth_getBlockByNumber'].includes(m)), [],
    'refused calls reached the node only for its sync check, never as the refused method');
  // a proof the role served is checked by its CONSUMER: here the account proof's storage root must contain the proven slot,
  // and the role adds nothing that claims verification
  const pr = (await call(r, 'eth_getProof', [probe.address, ['0x0'], { blockHash: head.hash }]));
  for (const h of ['x-enclave-rpc-verified', 'x-enclave-proof-verified']) assert.equal(pr.headers.get(h), null);
});
