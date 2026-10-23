// network/chain-authority.mjs: the local-verifier chain authority of supervisor.js and its lease/nomination readers, with
// SCRIPTED loopback stand-ins for the verifier and the own backend (each records every request it gets), so routing,
// refusals and "nothing was contacted" are observed directly. What the verifier PROVES is shown against the real
// runtime and chain in test/chain-consumer-closure.e2e.test.mjs; here only where each method goes and what refuses.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createPublicClient, http as viemHttp, parseAbi, encodeErrorResult, keccak256 } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient } from 'viem';
import { chainAuthorityFromEnv, createChainAuthority, refusingChainAuthority, checkOwnBackend, isVerifierClient, METHODS, VERIFIED_METHODS, BACKEND_METHODS }
  from '../network/chain-authority.mjs';
import { leaseRpcSet, verifiedLeaseAuthority } from '../client/lease-executor-authority.mjs';
import * as NET_AUTH from '../network/lease-executor-authority.mjs';
import { loadLeaseGasConfig } from '../network/lease-gas-runtime.mjs';
import { checkChainVerifier, checkTxBackendUrl, guestChainVerifier, withChainVerifierEnv, CHAIN_AUTHORITY_NAMES, REFUSING_VERIFIER } from '../metal/guest/chain-verifier.mjs';

const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'chain-authority-'));
const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } fs.rmSync(tmp, { recursive: true, force: true }); });
const NOW = 1_800_000_000_000;
const blockAt = (n, { ts = NOW / 1000 - 4, hash } = {}) => ({ number: '0x' + n.toString(16), hash: hash || '0x' + n.toString(16).padStart(64, 'a'),
  stateRoot: '0x' + '5'.repeat(64), timestamp: '0x' + Math.floor(ts).toString(16), baseFeePerGas: '0x3b9aca00', parentHash: '0x' + '0'.repeat(64),
  transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0', miner: '0x' + '0'.repeat(40), extraData: '0x', logsBloom: '0x' + '0'.repeat(512),
  difficulty: '0x0', nonce: '0x0000000000000000', receiptsRoot: '0x' + '6'.repeat(64), sha3Uncles: '0x' + '7'.repeat(64), size: '0x1', transactionsRoot: '0x' + '8'.repeat(64), uncles: [] });
/** a scripted JSON-RPC server: answer(method, params) -> {result} | {error}; every call recorded */
async function scripted(answer) {
  const calls = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const q = JSON.parse(b); calls.push({ method: q.method, params: q.params });
    const a = answer(q.method, q.params) ?? { error: { code: -32601, message: 'not scripted' } };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, ...a }));
  }); });
  servers.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${srv.address().port}/`, methods: () => calls.map((c) => c.method) };
}
const HEAD = 100;
const verifierScript = (over = {}) => (method, params) => {
  if (over[method]) return over[method](params);
  switch (method) {
    case 'eth_chainId': return { result: '0x2105' };
    case 'eth_blockNumber': return { result: '0x' + HEAD.toString(16) };
    case 'eth_getBlockByNumber': return { result: blockAt(params[0] === 'latest' ? HEAD : Number(BigInt(params[0]))) };
    case 'eth_call': return { result: '0x' + '0'.repeat(63) + '7' };
    case 'eth_getTransactionCount': return { result: '0x5' };
    case 'eth_getTransactionReceipt': return { error: { code: -32000, message: 'receipt not found' } };
    case 'eth_estimateGas': return { result: '0x5208' };
    default: return null;
  }
};
const backendScript = (over = {}) => (method, params) => {
  if (over[method]) return over[method](params);
  switch (method) {
    case 'eth_chainId': return { result: '0x2105' };
    case 'eth_getBlockByNumber': return { result: blockAt(Number(BigInt(params[0]))) };
    case 'eth_getTransactionCount': return { result: '0x6' };
    case 'eth_maxPriorityFeePerGas': return { result: '0xf4240' };
    case 'eth_sendRawTransaction': return { result: keccak256(params[0]) };
    default: return null;
  }
};
const authority = (v, b, opts = {}) => createChainAuthority({ verifier: v.url, backend: b?.url ?? null, chain: base, now: () => NOW, ...opts });
const ABI = parseAbi(['function count() view returns (uint256)', 'error NotYours(address who)', 'function take() returns (uint256)']);

test('the selection: unset or quorum is the legacy path; verifier needs a local URL; anything ambiguous refuses', () => {
  assert.equal(chainAuthorityFromEnv({}, { chain: base }), null);
  assert.equal(chainAuthorityFromEnv({ ENCLAVE_CHAIN_AUTHORITY: 'quorum' }, { chain: base }), null);
  assert.throws(() => chainAuthorityFromEnv({ ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:1/' }, { chain: base }), /not verifier/);
  assert.throws(() => chainAuthorityFromEnv({ ENCLAVE_CHAIN_TX_BACKEND: 'http://127.0.0.1:1/' }, { chain: base }), /not verifier/, 'a backend alone is never an authority');
  assert.throws(() => chainAuthorityFromEnv({ ENCLAVE_CHAIN_AUTHORITY: 'verifier' }, { chain: base }), /needs ENCLAVE_CHAIN_VERIFIER/);
  assert.throws(() => chainAuthorityFromEnv({ ENCLAVE_CHAIN_AUTHORITY: 'helios' }, { chain: base }), /quorum or verifier/);
  assert.throws(() => chainAuthorityFromEnv({ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'https://mainnet.base.org/' }, { chain: base }), /local endpoint/);
  const a = chainAuthorityFromEnv({ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:50546/', ENCLAVE_CHAIN_TX_BACKEND: 'http://10.0.2.2:8545/' }, { chain: base });
  assert.equal(a.mode, 'verifier');
  assert.deepEqual(a.describe().backend, { label: 'http://10.0.2.2:8545', scope: 'private', use: [...BACKEND_METHODS, 'eth_getTransactionCount(pending)'] });
  assert.equal(isVerifierClient(a.client), true);
  assert.equal(isVerifierClient(JSON.parse(JSON.stringify({ ...a.client }))), false, 'the mark never survives JSON');
  // every routed method has exactly one place, and the trust table names each
  for (const [m, [where, trust]] of Object.entries(METHODS)) { assert.ok(['verifier', 'backend'].includes(where), m); assert.ok(trust.length > 10, m); }
  assert.equal(METHODS.eth_getLogs[1].includes('completeness not proven'), true);
  assert.deepEqual(BACKEND_METHODS, ['eth_sendRawTransaction', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_gasPrice']);
  assert.ok(!VERIFIED_METHODS.includes('eth_sendRawTransaction'));
});

test('the own backend: a loopback or private address literal only, never a name or public address; the guest checker agrees', () => {
  const ok = ['http://127.0.0.1:8545/', 'http://10.0.2.2:8545', 'https://192.168.1.20:8545/', 'http://172.16.0.9:8545', 'http://172.31.255.1:1', 'http://[::1]:8545/'];
  const bad = ['https://mainnet.base.org/', 'https://base-rpc.publicnode.com', 'http://localhost:8545/', 'http://8.8.8.8:8545/', 'http://172.32.0.1:8545/',
    'http://user:pw@10.0.0.2:8545/', 'http://10.0.0.2:8545/?key=x', 'http://10.0.0.2:8545/#x', 'ws://10.0.0.2:8546/', 'http://10.0.0.256:1/', 'not a url'];
  for (const u of ok) { assert.ok(checkOwnBackend(u).url, u); assert.equal(checkTxBackendUrl(u), checkOwnBackend(u).url, `parity: ${u}`); }
  for (const u of bad) { assert.throws(() => checkOwnBackend(u), /TX_BACKEND/, u); assert.throws(() => checkTxBackendUrl(u), /txBackend/, `parity: ${u}`); }
});

test('routing: state, receipts, logs and nonces go to the verifier only; unlisted methods refuse by name and reach no server', async () => {
  const v = await scripted(verifierScript()), b = await scripted(backendScript());
  const a = authority(v, b);
  assert.equal(await a.client.readContract({ address: '0x' + '11'.repeat(20), abi: ABI, functionName: 'count' }), 7n);
  assert.equal(await a.client.getTransactionCount({ address: '0x' + '22'.repeat(20) }), 5, 'latest: proven by the verifier');
  assert.equal(await a.client.getTransactionCount({ address: '0x' + '22'.repeat(20), blockTag: 'pending' }), 6, 'pending: the own backend\'s pool');
  assert.equal(await a.client.getBlockNumber({ cacheTime: 0 }), BigInt(HEAD));
  await assert.rejects(a.client.getTransactionReceipt({ hash: '0x' + '33'.repeat(32) }), /could not be found/,
    'Helios "receipt not found" is a plain absence of evidence (viem TransactionReceiptNotFound), as a provider null is');
  assert.deepEqual([...new Set(v.methods())].sort(), ['eth_blockNumber', 'eth_call', 'eth_getTransactionCount', 'eth_getTransactionReceipt']);
  assert.deepEqual(b.methods(), ['eth_getTransactionCount'], 'the backend saw only the pending-pool question');
  const before = v.calls.length + b.calls.length;
  for (const m of ['eth_sign', 'eth_accounts', 'debug_traceTransaction', 'eth_getProof', 'eth_newFilter', 'txpool_content', 'eth_getTransactionByHash'])
    await assert.rejects(a.client.request({ method: m, params: [] }), (e) => /refused by the local chain authority/.test(String(e.details || e.message)), m);
  assert.equal(v.calls.length + b.calls.length, before, 'a refused method reaches no server');
});

test('a revert keeps its data through the verifier (simulate/readContract decode it); errors keep their code', async () => {
  const data = encodeErrorResult({ abi: ABI, errorName: 'NotYours', args: ['0x' + '44'.repeat(20)] });
  const v = await scripted(verifierScript({ eth_call: () => ({ error: { code: 3, message: 'execution reverted', data } }) }));
  const a = authority(v, null);
  await assert.rejects(a.client.simulateContract({ address: '0x' + '11'.repeat(20), abi: ABI, functionName: 'take', account: '0x' + '55'.repeat(20) }),
    (e) => e.walk((x) => x.name === 'ContractFunctionRevertedError')?.data?.errorName === 'NotYours');
});

test('submission: only through a backend BOUND to the verifier\'s chain on a fresh head; otherwise refused before anything is sent', async () => {
  const key = '0x' + '61'.repeat(32), account = privateKeyToAccount(key);
  const send = async (a) => { const w = createWalletClient({ account, chain: base, transport: a.transport });
    return w.sendTransaction({ to: account.address, value: 0n, gas: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, nonce: 6 }); };
  // bound: same hash at the verifier's confirmed block
  const v = await scripted(verifierScript()), b = await scripted(backendScript());
  const hash = await send(authority(v, b));
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.ok(b.methods().includes('eth_sendRawTransaction'));
  assert.ok(!v.methods().includes('eth_sendRawTransaction'), 'the verifier is never a submission path');
  // no backend: refused in words, nothing sent anywhere
  const v2 = await scripted(verifierScript());
  await assert.rejects(send(authority(v2, null)), (e) => /no own transaction backend/.test(String(e.details || e.message)));
  // a backend on another chain (a different block at the confirmed height): refused, it never gets the transaction
  const v3 = await scripted(verifierScript()), b3 = await scripted(backendScript({ eth_getBlockByNumber: (p) => ({ result: blockAt(Number(BigInt(p[0])), { hash: '0x' + 'f'.repeat(64) }) }) }));
  await assert.rejects(send(authority(v3, b3)), (e) => /another block .* than the verifier's signed head chain/.test(String(e.details || e.message)));
  assert.ok(!b3.methods().includes('eth_sendRawTransaction'));
  // a backend for another chain id
  const v4 = await scripted(verifierScript()), b4 = await scripted(backendScript({ eth_chainId: () => ({ result: '0x1' }) }));
  await assert.rejects(send(authority(v4, b4)), (e) => /follows another chain/.test(String(e.details || e.message)));
  assert.ok(!b4.methods().includes('eth_sendRawTransaction'));
  // a stale verifier head: nothing is submitted (and the gate says why)
  const v5 = await scripted(verifierScript({ eth_getBlockByNumber: (p) => ({ result: blockAt(p[0] === 'latest' ? HEAD : Number(BigInt(p[0])), { ts: NOW / 1000 - 600 }) }) }));
  const b5 = await scripted(backendScript()), a5 = authority(v5, b5);
  await assert.rejects(send(a5), (e) => /head is 600 s old/.test(String(e.details || e.message)));
  assert.ok(!b5.methods().includes('eth_sendRawTransaction'));
  await assert.rejects(a5.actionGate({ what: 'claim' }), (e) => e.code === 'chain_stale' && /^claim not done/.test(e.message));
  assert.equal(a5.status().ok, false);
});

test('an invalid selection refuses every method and every action: nothing falls back', async () => {
  const a = refusingChainAuthority('ENCLAVE_CHAIN_VERIFIER: the verifier must be a local endpoint', { chain: base });
  await assert.rejects(a.client.getBlockNumber(), (e) => /selection is invalid/.test(String(e.details || e.message)));
  await assert.rejects(a.actionGate({ what: 'renew' }), (e) => e.code === 'chain_misconfigured');
  assert.equal(isVerifierClient(a.client), true, 'a refusing client is still one authority (never mixed into a quorum)');
});

test('lease readers: the verifier is ONE authority (required 1), never mixed with RPCs, never repeated; RPC quorums are unchanged', async () => {
  const v = await scripted(verifierScript());
  const a = authority(v, null);
  for (const M of [{ leaseRpcSet }, NET_AUTH]) {
    const set = M.leaseRpcSet([a.client], { quorum: 3 });
    assert.equal(set.required, 1); assert.equal(set.authority, 'local-verifier'); assert.equal(set.localFixture, false);
    const rpcClient = createPublicClient({ chain: base, transport: viemHttp('https://rpc-a.example/') });
    assert.throws(() => M.leaseRpcSet([a.client, rpcClient], {}), /one authority, never a quorum member/);
    assert.throws(() => M.leaseRpcSet([a.client, a.client], {}), /one authority/);
    const plain = M.leaseRpcSet([rpcClient, createPublicClient({ chain: base, transport: viemHttp('https://rpc-b.example/') })], {});
    assert.equal(plain.required, 2); assert.equal(plain.authority, 'rpc-quorum');
    assert.throws(() => M.leaseRpcSet([rpcClient], {}), /strict majority/, 'one provider is still never a quorum');
  }
  // the agreed authority block comes from the verifier alone, at its head minus the confirmation depth
  const pins = { chainId: 8453, reserve: '0x' + '0a'.repeat(20), executor: '0x' + '0b'.repeat(20), ledger: '0x' + '0c'.repeat(20), registry: '0x' + '0d'.repeat(20),
    reserveCodeHash: keccak256('0x01'), executorCodeHash: keccak256('0x02') };
  await assert.rejects(verifiedLeaseAuthority({ clients: [a.client], deployment: pins, now: () => NOW }), /unreviewed runtime code|lease-gas/);
  const asked = v.calls.filter((c) => c.method === 'eth_getBlockByNumber').map((c) => c.params[0]);
  assert.ok(asked.includes('0x' + (HEAD - 2).toString(16)), 'the authority block is the verifier head minus 2');
});

test('app-funded lease config under the verifier: reads use it alone, the configured RPCs are never contacted (kept for byte-identical config)', async () => {
  const v = await scripted(verifierScript()), rpcStub = await scripted(() => ({ result: '0x2105' }));
  // a reviewed deployment record, as test/lease-gas-runtime.test.mjs builds it
  const addr = (x) => '0x' + x.repeat(20);
  const fixture = { format: 'enclave-lease-gas-deployment/v1', chainId: 8453, reserve: addr('11'), executor: addr('22'), ledger: addr('33'), registry: addr('44'),
    reserveCodeHash: '0x' + '55'.repeat(32), executorCodeHash: '0x' + '66'.repeat(32) };
  const bytes = Buffer.from(JSON.stringify(fixture)), recordFile = 'reviewed-deployment.json';
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const readFile = (f) => { assert.equal(f, recordFile); return bytes; };
  const env = { ENCLAVE_LEASE_GAS_FILE: recordFile, ENCLAVE_LEASE_GAS_DIGEST: digest, ENCLAVE_LEASE_GAS_RPCS: rpcStub.url, ENCLAVE_LEASE_GAS_RELAYS: 'https://relay-a.example',
    ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url };
  const c = loadLeaseGasConfig({ env, chain: base, ledger: fixture.ledger, registry: fixture.registry, readFile, allowLoopbackHttp: true });
  assert.equal(c.authority, 'local-verifier'); assert.equal(c.clients.length, 1); assert.equal(isVerifierClient(c.clients[0]), true); assert.equal(c.quorum, 1);
  const noRpcs = { ...env }; delete noRpcs.ENCLAVE_LEASE_GAS_RPCS;
  assert.equal(loadLeaseGasConfig({ env: noRpcs, chain: base, ledger: fixture.ledger, registry: fixture.registry, readFile }).authority, 'local-verifier',
    'no RPCS needed under the verifier');
  assert.throws(() => loadLeaseGasConfig({ env: { ...env, ENCLAVE_CHAIN_VERIFIER: 'https://mainnet.base.org/' }, chain: base, ledger: fixture.ledger, registry: fixture.registry, readFile }),
    /local endpoint/, 'an invalid selection refuses the lease config; never the RPCs');
  assert.equal(rpcStub.calls.length, 0, 'the configured RPC was never contacted');
});

test('guest opt-in: txBackend is checked and reaches the supervisor only with a usable verifier, from this channel only', () => {
  const RAW = { format: 'enclave-chain-verifier/v1', unsafeSigner: '0x' + '9a'.repeat(20), proofSources: ['https://holder.example.net/'], port: 50546 };
  assert.equal(checkChainVerifier({ ...RAW, txBackend: 'http://10.0.2.2:8545' }).txBackend, 'http://10.0.2.2:8545/');
  assert.equal('txBackend' in checkChainVerifier(RAW), false, 'absent stays absent');
  assert.throws(() => checkChainVerifier({ ...RAW, txBackend: 'https://mainnet.base.org' }), /txBackend must be a loopback or private/);
  assert.ok(CHAIN_AUTHORITY_NAMES.includes('ENCLAVE_CHAIN_TX_BACKEND'));
  const image = JSON.parse(fs.readFileSync(new URL('../metal/chain-verifier-image.json', import.meta.url), 'utf8'));   // the committed image record
  const ok = guestChainVerifier({ ...RAW, txBackend: 'http://10.0.2.2:8545' }, { image });
  const env = withChainVerifierEnv({ ENCLAVE_CHAIN_TX_BACKEND: 'https://mainnet.base.org/', X: '1' }, ok);
  assert.deepEqual(env, { X: '1', ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:50546/', ENCLAVE_CHAIN_TX_BACKEND: 'http://10.0.2.2:8545/' });
  const noImage = guestChainVerifier({ ...RAW, txBackend: 'http://10.0.2.2:8545' }, { imageFile: path.join(tmp, 'absent.json') });
  assert.deepEqual(withChainVerifierEnv({ ENCLAVE_CHAIN_TX_BACKEND: 'http://10.0.2.2:1/' }, noImage), { ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: REFUSING_VERIFIER },
    'a refusing verifier gets no backend: nothing is submitted');
  assert.deepEqual(withChainVerifierEnv({ ENCLAVE_CHAIN_TX_BACKEND: 'http://10.0.2.2:1/', Y: '2' }, null), { Y: '2' }, 'absent: every name dropped, nothing added');
});
