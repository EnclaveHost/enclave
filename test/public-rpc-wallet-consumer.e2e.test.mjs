// COMPOSED: E's actual profile-broadcast wallet route (the site modules of E dc2e5d74, git archive into
// consumers/e-dc2e5d74, hash-pinned: wallet.js sendTx -> profile-broadcast.js sendViaProfile -> chain.js waitReceipt and
// the real quorum reader) against TWO PACKAGED public-rpc roles under the runner, whose node is the operator's own reth
// v2.8.0 --dev. Run in Node exactly as E's own test runs them (localStorage profile, a page fetch that refuses every origin
// that is not this machine); E's production browser build is E's scope and is not rebuilt here.
//   host A: no propagation statement -> refuses eth_sendRawTransaction by name (nothing reaches its node);
//   host B: rawTransactions.propagation stated -> forwards the node's own answer.
// BOTH roles front ONE node: the two-origin quorum exercises the route, it is NOT two independent nodes.
// The wallet is an in-test EIP-1193 signer holding reth's public dev key (anvil #0): a LOCAL TEST SIGNER, no real wallet,
// no MetaMask. MetaMask itself cannot take this route (no eth_signTransaction): a wallet without it is refused, by name.
//   - before signing: the agreed snapshot, the tip quote (eth_maxPriorityFeePerGas, labelled fee-quote-unverified) and
//     the next nonce (eth_getTransactionCount "pending", labelled mempool-unverified) come through the roles;
//   - the exact signed bytes go to A (refused) and then B (accepted); the node receives those bytes once; the receipt comes
//     through the profile;
//   - a node that quotes no tip: E's own fallback tip (0.001 gwei) is signed, never an invented quote;
//   - a wallet that only broadcasts is refused, nothing signed or sent; the node down refuses before anything is signed.
//   env: RETH_BIN (pinned), CONSUMERS (default ../consumers).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseTransaction, keccak256, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRethDev, haveReth, DEV_KEY, freePort, RETH_BIN } from './helpers/reth-dev.mjs';
import { startPackagedRole, packagePin, pinnedConsumer, pinnedFile } from './helpers/packaged-rpc-role.mjs';

const E_SUMS = '786507164c8b3642ff002a7feb3e77c7a8223a28f8d0e1bb68e5b480eb109831';
const RETH_PIN = '8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250';
const skip = haveReth() || (!packagePin() && 'needs the built packages') || false;
const signer = privateKeyToAccount(DEV_KEY), OWNER = signer.address.toLowerCase();
const TO = '0x' + 'be'.repeat(20);
const nativeFetch = globalThis.fetch;
const mem = (m = new Map()) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
let reth, proxy, hostA, hostB, rpcs, W, C, PB, Enclave, mode = 'ok';
const nodeSeen = [], page = [], forbidden = [], walletCalls = [];

const nodeRpc = async (method, params = []) => {
  const j = await (await nativeFetch(reth.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw new Error(j.error.message); return j.result;
};
// the operator's node behind a fault proxy: ok | no-tip (the node quotes no priority fee) | down
function startProxy() {
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const q = JSON.parse(body); nodeSeen.push([q.method, q.params]);
    if (mode === 'down') return req.socket.destroy();
    if (mode === 'no-tip' && q.method === 'eth_maxPriorityFeePerGas') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'the method eth_maxPriorityFeePerGas does not exist/is not available' } })); }
    const r = await nativeFetch(reth.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(await r.text());
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
/** A local test signer: signs exactly the request with the dev key, never broadcasts. */
const tx = (req) => ({ type: 'eip1559', chainId: 8453, nonce: Number(BigInt(req.nonce)), to: req.to, value: BigInt(req.value), data: req.data, gas: BigInt(req.gas),
  maxFeePerGas: BigInt(req.maxFeePerGas), maxPriorityFeePerGas: BigInt(req.maxPriorityFeePerGas) });
const wallet = (sign) => ({ request: async ({ method, params }) => {
  walletCalls.push(method);
  if (method === 'eth_signTransaction') return sign(params[0]);
  if (method === 'eth_chainId') return '0x2105';
  if (method === 'eth_accounts') return [OWNER];
  throw Object.assign(new Error('unexpected wallet method ' + method), { code: 4200 });
} });
const signOnly = wallet((req) => signer.signTransaction(tx(req)));
const broadcastOnly = wallet(() => { throw Object.assign(new Error('The method "eth_signTransaction" does not exist / is not available.'), { code: 4200 }); });
const reset = (m = 'ok') => { mode = m; page.length = 0; nodeSeen.length = 0; walletCalls.length = 0; };
const pageCalls = (method) => page.filter((p) => p.method === method);
const nodeRaws = () => nodeSeen.filter(([m]) => m === 'eth_sendRawTransaction').map(([, p]) => p[0]);

before(async () => {
  if (skip) return;
  pinnedFile(RETH_BIN, RETH_PIN);
  const dir = pinnedConsumer('e-dc2e5d74', E_SUMS);
  reth = await startRethDev({ blockTime: '1s' });
  proxy = await startProxy();
  const portA = await freePort(), portB = await freePort();
  hostA = await startPackagedRole('wa', portA, { node: proxy.url, allowedOrigins: ['http://localhost'] });
  hostB = await startPackagedRole('wb', portB, { node: proxy.url, allowedOrigins: ['http://localhost'], rawTransactions: { propagation: 'test: the local dev node mines it (no network)' } });
  rpcs = [hostA.url, `http://localhost:${portB}`];
  const profile = { format: 'enclave-browser-profile', version: 1, name: 'loopback test network (packaged public-rpc roles, one reth)', chainId: 8453, rpcs, quorum: 2, confirmations: 0, maxBlockAgeSeconds: 86400,
    contractPins: { version: 1, chainId: 8453, contracts: { registry: '0x' + '11'.repeat(20), deployments: '0x' + '22'.repeat(20), appCatalog: '0x' + '33'.repeat(20),
      proofOfTime: '0x' + '44'.repeat(20), enclavePay: '0x' + '00'.repeat(20), verificationFees: '0x' + '00'.repeat(20),
      sessionVaultFactory: '0x' + '00'.repeat(20), secretVaultV2: '0x' + '00'.repeat(20) } }, usdc: '0x' + '66'.repeat(20) };
  const text = JSON.stringify(profile);
  globalThis.localStorage = mem(new Map([['enclave_independent_profile', text]]));
  globalThis.sessionStorage = mem(new Map([['enclave_independent_ack', text]]));
  globalThis.location = { hostname: 'localhost', origin: 'http://localhost' };
  // the page's network: this machine only; every call to a role is recorded with the role's labels
  globalThis.fetch = async (url, opts) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) { forbidden.push(u.href); throw new TypeError('blocked: not this machine'); }
    const res = await nativeFetch(url, opts);
    let q = null; try { q = JSON.parse(opts?.body); } catch {}
    if (q?.method) {
      const body = await res.clone().json().catch(() => null);
      page.push({ origin: u.origin, method: q.method, params: q.params, status: res.status, cls: res.headers.get('x-enclave-rpc-class'), source: res.headers.get('x-enclave-rpc-source'),
        propagation: res.headers.get('x-enclave-rpc-propagation'), result: body?.result, error: body?.error });
    }
    return res;
  };
  const core = (m) => import(pathToFileURL(path.join(dir, 'site/js/core', m)).href);
  [W, C, PB, { Enclave }] = await Promise.all([core('wallet.js'), core('chain.js'), core('profile-broadcast.js'), core('api.js')]);
  Enclave.address = OWNER;
  PB.setBroadcastRoute('profile');
});
after(async () => {
  globalThis.fetch = nativeFetch;
  await hostA?.stop(); await hostB?.stop();
  proxy?.srv.closeAllConnections?.(); proxy?.srv.close(); reth?.stop();
});

test('E\'s profile route through two packaged roles: labelled tip and pending nonce, the local signer signs only, the same bytes refused by A then accepted by B, the receipt through the profile', { skip, timeout: 90_000 }, async () => {
  reset(); Enclave.provider = signOnly;
  assert.equal(PB.broadcastRoute(), 'profile');
  const before = Number(BigInt(await nodeRpc('eth_getTransactionCount', [OWNER, 'latest'])));
  const hash = await W.sendTx(TO, '0x', '0x1');
  assert.deepEqual(walletCalls, ['eth_signTransaction'], 'the wallet signed, and did nothing else');
  // before signing: the tip quote and the pending nonce came through a role, labelled as the node's unverified view
  const [tipCall] = pageCalls('eth_maxPriorityFeePerGas'), [nonceCall] = pageCalls('eth_getTransactionCount');
  assert.ok(tipCall && nonceCall, 'both asked through the profile');
  assert.equal(tipCall.cls, 'fee-quote-unverified'); assert.equal(tipCall.source, 'node'); assert.match(tipCall.result, /^0x[0-9a-f]+$/);
  assert.deepEqual(nonceCall.params, [OWNER, 'pending']); assert.equal(nonceCall.cls, 'mempool-unverified'); assert.equal(BigInt(nonceCall.result), BigInt(before));
  assert.ok(nodeSeen.some(([m, p]) => m === 'eth_getTransactionCount' && p[1] === 'pending'), 'the role forwarded the pending nonce to its own node');
  // the exact bytes, in the profile's order
  const raws = pageCalls('eth_sendRawTransaction');
  assert.deepEqual(raws.map((r) => r.origin), [new URL(rpcs[0]).origin, new URL(rpcs[1]).origin]);
  assert.equal(raws[0].error.code, -32601); assert.match(raws[0].error.message, /not stated a transaction propagation route/);
  assert.equal(raws[1].result, hash); assert.equal(raws[1].cls, 'submission'); assert.equal(raws[1].propagation, 'operator-stated');
  assert.equal(raws[0].params[0], raws[1].params[0], 'identical signed bytes to both');
  assert.deepEqual(nodeRaws(), [raws[1].params[0]], 'the node received those bytes once (A refused before its node)');
  const raw = raws[1].params[0];
  assert.equal(keccak256(raw), hash);
  assert.equal((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase(), OWNER);
  const p = parseTransaction(raw);
  assert.deepEqual([p.chainId, p.to.toLowerCase(), p.value, p.type, p.nonce], [8453, TO, 1n, 'eip1559', before]);
  const quoted = BigInt(tipCall.result);
  // E's own strict decoder (viem's parser leaves a zero field undefined; reth --dev quotes a zero tip)
  assert.equal(PB.decodeSigned(raw).maxPriorityFeePerGas, quoted > 2_000_000_000n ? 2_000_000_000n : quoted, 'the node\'s quote, capped by E');
  const rec = await C.waitReceipt(hash);
  assert.equal(rec.status, '0x1'); assert.equal(rec.from.toLowerCase(), OWNER);
  assert.ok(pageCalls('eth_getTransactionReceipt').every((c) => c.cls === 'chain-state'));
  assert.equal(Number(BigInt(await nodeRpc('eth_getTransactionCount', [OWNER, 'latest']))), before + 1);
  assert.deepEqual(forbidden, []);
});

test('a node that quotes no tip: E signs its own stated fallback (0.001 gwei), never an invented quote', { skip, timeout: 90_000 }, async () => {
  reset('no-tip'); Enclave.provider = signOnly;
  const hash = await W.sendTx(TO, '0x', '0x1');
  const [tipCall] = pageCalls('eth_maxPriorityFeePerGas');
  assert.ok(tipCall.error && !tipCall.result, 'the role passed the node\'s refusal on unchanged');
  const raw = pageCalls('eth_sendRawTransaction').at(-1).params[0];
  assert.equal(PB.decodeSigned(raw).maxPriorityFeePerGas, 1_000_000n);
  assert.equal((await C.waitReceipt(hash)).status, '0x1');
});

test('a wallet that only broadcasts (as MetaMask) is refused by name; the node down refuses before anything is signed; nothing goes anywhere else', { skip, timeout: 90_000 }, async () => {
  reset(); Enclave.provider = broadcastOnly;
  await assert.rejects(W.sendTx(TO, '0x', '0x1'), (e) => e.code === 'unsupported' && /does not sign a transaction without broadcasting/.test(e.message));
  assert.deepEqual(walletCalls, ['eth_signTransaction'], 'no fallback to eth_sendTransaction');
  assert.equal(pageCalls('eth_sendRawTransaction').length, 0); assert.deepEqual(nodeRaws(), []);
  reset('down'); Enclave.provider = signOnly;
  await new Promise((r) => setTimeout(r, 2100));          // past the roles' 2 s sync-check cache
  await assert.rejects(W.sendTx(TO, '0x', '0x1'));
  assert.deepEqual(walletCalls, [], 'never asked to sign');
  assert.equal(pageCalls('eth_sendRawTransaction').length, 0);
  assert.ok(page.every((c) => c.status === 503 || c.error), 'every role refused: ' + JSON.stringify(page.map((c) => [c.method, c.status])).slice(0, 300));
  assert.deepEqual(forbidden, []);
  mode = 'ok';
});
