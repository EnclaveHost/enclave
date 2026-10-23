// Independent mode (CLI and MCP) under --chain-verifier: the QuorumChain interface over the local verifier
// (cli/independent.mjs VerifiedChain via independentChain). A real loopback HTTP JSON-RPC stand-in plays the verifier and,
// separately, the explicit transaction transport; both count every method. State reads, revert facts and simulations are
// the verifier's; nonce/receipts/log hints only the explicit transport's (refused by name without one); custody's own
// quorum extraction refuses; MCP's Scope reads one verified block per call even while another call moves the floor.
// The real-chain counterpart is test/cli-mcp-verifier.e2e.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { encodeFunctionData, encodeAbiParameters, parseAbi, pad, toHex, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as I from '../cli/independent.mjs';
import { Scope } from '../mcp/independent.mjs';

const servers = new Set();
test.after(() => { for (const s of servers) try { s.closeAllConnections?.(); s.close(); } catch {} });
const ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function revertMe() view returns (uint256)', 'event Ping(uint256 n)']);
const ADDR = '0x' + '44'.repeat(20);
const BAL = encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [ADDR] }).slice(0, 10);
const REV = encodeFunctionData({ abi: ABI, functionName: 'revertMe' }).slice(0, 10);
const hashOf = (n, salt = 0) => pad(toHex(BigInt(n) * 1000n + BigInt(salt) + 1n), { size: 32 });
async function stand(handler) {
  const st = { calls: [], head: 100n, salt: 0 };
  const s = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    const q = JSON.parse(Buffer.concat(c).toString() || 'null');
    const one = (m) => { st.calls.push(m.method); try { return { jsonrpc: '2.0', id: m.id, result: handler(st, m) }; } catch (e) { return { jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32000, message: e.message } }; } };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
  }); });
  servers.add(s); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { st, url: `http://127.0.0.1:${s.address().port}/` };
}
const verifierHandler = (st, m) => {
  switch (m.method) {
    case 'eth_chainId': return '0x2105';
    case 'eth_blockNumber': return toHex(st.head);
    case 'eth_getBlockByNumber': { const n = BigInt(m.params[0]); return { number: toHex(n), hash: hashOf(n, st.salt), stateRoot: pad('0x22', { size: 32 }), timestamp: toHex(Math.floor(Date.now() / 1000)) }; }
    case 'eth_call': {
      st.callBlocks = [...(st.callBlocks || []), m.params[1]?.blockHash];
      const sel = m.params[0].data.slice(0, 10);
      if (sel === REV) throw Object.assign(new Error('execution reverted: nope'), { code: 3 });
      if (sel === BAL) return encodeAbiParameters([{ type: 'uint256' }], [42n]);
      return '0x';                                                    // a plain simulation (sendQuorumTx's c.call)
    }
    case 'eth_getBalance': return '0x10';
    default: throw new Error('method not served');
  }
};
const txHandler = (st, m) => {
  switch (m.method) {
    case 'eth_chainId': return '0x2105';
    case 'eth_getTransactionCount': return '0x5';
    case 'eth_getLogs': st.logRange = [m.params[0].fromBlock, m.params[0].toBlock]; return [];
    default: throw new Error('not served by this stand-in');
  }
};
const VERIFIER_ONLY = (url) => ({ chainVerifier: url });

test('state reads, revert facts and snapshots come from the verifier; the chain reports no provider peers', async () => {
  const v = await stand(verifierHandler);
  const chain = I.independentChain({ ...VERIFIER_ONLY(v.url), confirmations: 2 });
  assert.equal(chain.authority, 'local-verifier'); assert.deepEqual(chain.peers, []);
  assert.equal(await chain.read(ADDR, ABI, 'balanceOf', [ADDR]), 42n);
  await assert.rejects(chain.read(ADDR, ABI, 'revertMe'), (e) => e.agreedRevert === true && /nope/.test(e.message), 'a proof-backed revert is a fact, not an outage');
  assert.deepEqual(await chain.readMany([{ address: ADDR, abi: ABI, functionName: 'balanceOf', args: [ADDR] }, { address: ADDR, abi: ABI, functionName: 'revertMe', optional: true }]).then((s) => s.value), [42n, null]);
  assert.equal(await chain.balance(ADDR), 16n);
  const s = await chain.snapshot(async (c, b) => ({ b, code: typeof c.getCode }));
  assert.equal(s.blockNumber, 98n); assert.equal(s.blockHash, hashOf(98)); assert.equal(s.value.code, 'function');
  assert.ok(v.st.callBlocks.every((h) => h === hashOf(98)), 'every call is pinned to the verified block by hash');
  assert.equal(await I.quorumPublicClient(chain).readContract({ address: ADDR, abi: ABI, functionName: 'balanceOf', args: [ADDR] }), 42n, 'the SDK-facing view reads the verifier too');
});

test('transaction/history work refuses by name without an explicit transport, and uses ONLY that transport when configured', async () => {
  const v = await stand(verifierHandler), tx = await stand(txHandler);
  const bare = I.independentChain(VERIFIER_ONLY(v.url));
  await assert.rejects(bare.each((c) => c.getTransactionCount({ address: ADDR, blockTag: 'pending' }), 'pending nonce'), /needs the explicit transaction\/history transport/);
  await assert.rejects(bare.receiptSnapshot(async () => 0), /needs the explicit transaction\/history transport/);
  await assert.rejects(bare.snapshot((c) => c.getLogs({ address: ADDR, event: ABI[2], fromBlock: 0n, toBlock: 100n })), /getLogs: under --chain-verifier/);
  await assert.rejects(bare.snapshot((c) => c.getTransactionReceipt({ hash: hashOf(1) })), /not available under the verifier authority/);
  // sendQuorumTx: the precondition simulation is the verifier's; without a transport nothing is signed or sent
  const key = privateKeyToAccount('0x' + '11'.repeat(32));
  await assert.rejects(I.sendQuorumTx(bare, { account: key, to: ADDR, data: REV }), /would revert at agreed block 98 \(nope\)/);
  await assert.rejects(I.sendQuorumTx(bare, { account: key, to: ADDR, data: '0x' }), /pending nonce: under --chain-verifier/);
  const withTx = I.independentChain({ ...VERIFIER_ONLY(v.url), rpcs: [tx.url] });
  assert.deepEqual(await withTx.each((c) => c.getTransactionCount({ address: ADDR, blockTag: 'pending' }), 'pending nonce'), [5]);
  await withTx.snapshot((c) => c.getLogs({ address: ADDR, event: ABI[2], fromBlock: 0n, toBlock: 10_000n }));
  assert.deepEqual(tx.st.logRange, ['0x0', toHex(98)], 'log hints are clamped to the verified block');
  assert.ok(!v.st.calls.includes('eth_getTransactionCount') && !v.st.calls.includes('eth_getLogs'), 'the verifier never serves transaction/history');
  assert.ok(!tx.st.calls.includes('eth_call'), 'the transport never answers a state read');
  assert.throws(() => I.leaseReaderClients(withTx), /custody reads .* not available under --chain-verifier/);
  assert.deepEqual(I.independentReaderAuthority({ chainVerifier: v.url }, withTx), { authority: 'verifier', verifier: v.url });
});

test('a stale or reorganized verifier refuses; nothing falls back to the transport', async () => {
  const v = await stand((st, m) => (m.method === 'eth_getBlockByNumber' ? { ...verifierHandler(st, m), timestamp: toHex(Math.floor(Date.now() / 1000) - 3600) } : verifierHandler(st, m)));
  const tx = await stand(txHandler);
  const chain = I.independentChain({ ...VERIFIER_ONLY(v.url), rpcs: [tx.url] });
  await assert.rejects(chain.read(ADDR, ABI, 'balanceOf', [ADDR]), (e) => e.code === 'chain_stale');
  assert.equal(tx.st.calls.length, 0);
});

test('MCP Scope: one verified block per call; its later reads resume that exact block even after another call moved the floor', async () => {
  const v = await stand(verifierHandler);
  const chain = I.independentChain(VERIFIER_ONLY(v.url));
  const authority = { chain, name: 'p', trust: {}, cfg: {} };
  const a = new Scope(authority);
  const blockA = await a.at();
  assert.equal(blockA.number, 98n); assert.equal(blockA.authority, 'local-verifier');
  v.st.head = 110n;
  const b = new Scope(authority);
  assert.equal((await b.at()).number, 108n, 'a newer call reads a newer block');
  assert.equal(await a.read(ADDR, ABI, 'balanceOf', [ADDR]), 42n, 'the older call still reads ITS block');
  assert.equal(v.st.callBlocks.at(-1), hashOf(98));
  assert.equal(a.summary().authority, 'local-verifier');
  v.st.salt = 7;                                                      // block 98 replaced: the call refuses rather than mixing blocks
  await assert.rejects(a.agree((c, n) => c.readContract({ address: ADDR, abi: ABI, functionName: 'balanceOf', args: [ADDR], blockNumber: n })), (e) => e.code === 'chain_reorg');
});

test('trust and factory: the RPC list is optional under the verifier and only the transport; legacy is unchanged', () => {
  const PINS = Object.freeze({ registry: '0x' + '11'.repeat(20), deployments: '0x' + '22'.repeat(20), appCatalog: '0x' + '33'.repeat(20), proofOfTime: '0x' + '44'.repeat(20),
    enclavePay: '0x' + '00'.repeat(20), verificationFees: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '00'.repeat(20), secretVaultV2: '0x' + '00'.repeat(20) });
  const base = { contractPins: PINS, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
  const t = I.loadIndependentTrust({ ...base, chainVerifier: 'http://127.0.0.1:8545/' });
  assert.deepEqual(t.rpcs, []);
  assert.ok(I.independentChain({ rpcs: t.rpcs, chainVerifier: t.chainVerifier }) instanceof I.VerifiedChain);
  const legacy = I.loadIndependentTrust({ ...base, rpcs: ['https://a.example.org', 'https://b.example.org'] });
  assert.ok(I.independentChain({ rpcs: legacy.rpcs, quorum: legacy.quorum }) instanceof I.QuorumChain);
  assert.throws(() => I.loadIndependentTrust(base), /2 to 8 explicit RPC origins/);
  assert.throws(() => I.loadIndependentTrust({ ...base, chainVerifier: 'https://rpc.example.org/' }), /local endpoint/);
});
