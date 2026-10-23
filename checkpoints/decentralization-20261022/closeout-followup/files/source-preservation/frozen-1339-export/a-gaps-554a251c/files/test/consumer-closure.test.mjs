// The remaining independent consumers under --chain-verifier, offline: the verifier-backed client custody v2's own quorum
// reader takes (pinned-by-hash state only, nothing else), custodyChainClients, VerifiedChain.verifyOutcome (what a transport
// receipt can and cannot establish), and the credit-vault verifier reader with its outcome labels. Real loopback HTTP
// stand-ins play the verifier and the transport and count every method. The real-chain counterpart is
// test/consumer-closure.e2e.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { encodeFunctionData, encodeAbiParameters, decodeFunctionResult, parseAbi, pad, toHex } from 'viem';
import { verifierRequest, verifierClient } from '../network/verified-chain.mjs';
import { createQuorumReader } from '../custody/v2/quorum.mjs';
import * as I from '../cli/independent.mjs';
import { verifiedCreditReader, outcomeEvidence } from '../cli/credit-vault.mjs';
import { verifySignedTransaction, intendedTx } from '../cli/independent-signer.mjs';
import { privateKeyToAccount } from 'viem/accounts';

const servers = new Set();
test.after(() => { for (const s of servers) try { s.closeAllConnections?.(); s.close(); } catch {} });
const ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function revertMe() view returns (uint256)']);
const ADDR = '0x' + '44'.repeat(20), FROM = '0x' + '55'.repeat(20);
const BAL = encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [ADDR] }), REV = encodeFunctionData({ abi: ABI, functionName: 'revertMe' });
const hashOf = (n) => pad(toHex(BigInt(n) * 1000n + 1n), { size: 32 });
async function stand(handler) {
  const st = { calls: [], head: 100n, nonce: 0n };
  const s = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    const q = JSON.parse(Buffer.concat(c).toString() || 'null');
    const one = (m) => { st.calls.push([m.method, m.params]); try { return { jsonrpc: '2.0', id: m.id, result: handler(st, m) }; } catch (e) { return { jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32000, message: e.message } }; } };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
  }); });
  servers.add(s); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { st, url: `http://127.0.0.1:${s.address().port}/` };
}
const verifier = (st, m) => {
  switch (m.method) {
    case 'eth_chainId': return '0x2105';
    case 'eth_blockNumber': return toHex(st.head);
    case 'eth_getBlockByNumber': { const n = BigInt(m.params[0]); return { number: toHex(n), hash: hashOf(n), stateRoot: pad('0x22', { size: 32 }), timestamp: toHex(Math.floor(Date.now() / 1000)), baseFeePerGas: '0x7' }; }
    case 'eth_call': if (m.params[0].data === REV) throw Object.assign(new Error('execution reverted: nope'), { code: 3 }); return encodeAbiParameters([{ type: 'uint256' }], [42n]);
    case 'eth_getCode': return '0x6001';
    case 'eth_getBalance': return '0x10';
    case 'eth_getTransactionCount': return toHex(st.nonce);
    default: throw new Error('not served');
  }
};

test('the verifier-backed client serves only pinned-by-hash state and headers by number; anything else refuses by name, before any request', async () => {
  const v = await stand(verifier);
  const req = verifierRequest(v.url);
  assert.equal(await req('eth_blockNumber'), toHex(100n));
  assert.equal(String(await req('eth_getCode', [ADDR, { blockHash: hashOf(98), requireCanonical: true }])), '0x6001');
  assert.deepEqual(v.st.calls.at(-1), ['eth_getCode', [ADDR, { blockHash: hashOf(98) }]], 'the block param is normalized to the hash alone');
  const n = v.st.calls.length;
  for (const [method, params, why] of [['eth_call', [{ to: ADDR, data: BAL }, 'latest'], /explicit block hash/], ['eth_getBalance', [ADDR, { blockNumber: '0x1' }], /explicit block hash/],
    ['eth_getBlockByNumber', ['latest', false], /by block number/], ['eth_getBlockByNumber', ['0x1', true], /without transactions/],
    ['eth_getLogs', [{}], /not served by the local verifier/], ['eth_sendRawTransaction', ['0x00'], /not served by the local verifier/], ['eth_getTransactionReceipt', ['0x' + '1'.repeat(64)], /not served/]])
    await assert.rejects(req(method, params), (e) => e.code === 'chain_unsupported' && why.test(e.message), method);
  assert.equal(v.st.calls.length, n, 'nothing refused was sent');
  assert.throws(() => verifierRequest('https://rpc.example.org/'), /local endpoint/);
});

test('custody v2: its OWN quorum reader runs unchanged over ONE verifier-backed client (minAgree 1): confirmations, freshness, re-check and rollback', async () => {
  const v = await stand(verifier);
  const chain = I.independentChain({ chainVerifier: v.url, confirmations: 2 });
  const { clients, minAgree, authority } = I.custodyChainClients(chain, { quorum: 0 });
  assert.equal(clients.length, 1); assert.equal(minAgree, 1); assert.equal(authority, 'local-verifier');
  const agreed = createQuorumReader({ clients, minAgree, chainId: 8453, confirmations: 2, maxAgeSec: 120 });
  const r = await agreed(async (c, b) => ({ v: decodeFunctionResult({ abi: ABI, functionName: 'balanceOf',
    data: await c.request({ method: 'eth_call', params: [{ to: ADDR, data: BAL }, { blockHash: b.blockHash, requireCanonical: true }] }) }).toString() }));
  assert.equal(r.v, '42'); assert.equal(r.blockNumber, 98n); assert.equal(r.blockHash, hashOf(98));
  v.st.head = 90n;                                                     // the verifier goes behind the accepted block
  await assert.rejects(agreed(async () => ({ v: 1 })), (e) => e.code === 'chain_rollback' || /behind|rollback/.test(e.message));
  // an unpinned read inside the custody callback is refused by the client itself
  v.st.head = 100n;
  await assert.rejects(createQuorumReader({ clients, minAgree, chainId: 8453 })(async (c) => ({ v: await c.request({ method: 'eth_call', params: [{ to: ADDR, data: BAL }, 'latest'] }) })));
  const q = new I.QuorumChain({ clients: [{ origin: 'https://a.example', client: {} }, { origin: 'https://b.example', client: {} }], quorum: 2 });
  assert.equal(I.custodyChainClients(q, { quorum: 2 }).clients.length, 2, 'legacy: the quorum peers, unchanged');
});

test('verifyOutcome: the verifier must reach the receipt block AND show the nonce consumed; the receipt itself is never proof; confirm proves the effect', async () => {
  const v = await stand(verifier);
  const chain = I.independentChain({ chainVerifier: v.url, confirmations: 2 });
  v.st.nonce = 7n;                                                     // nonce 7 not yet used
  await assert.rejects(chain.verifyOutcome({ hash: '0x' + 'ab'.repeat(32), from: FROM, nonce: 7, receiptBlock: 98n, timeoutMs: 1500, pollMs: 50 }),
    (e) => e.outcomeUnknown && e.final && /still unused in verified state/.test(e.message));
  await assert.rejects(chain.verifyOutcome({ hash: '0x' + 'ab'.repeat(32), from: FROM, nonce: 7, receiptBlock: 500n, timeoutMs: 600, pollMs: 50 }),
    (e) => e.outcomeUnknown && /has not reached that block/.test(e.message), 'a receipt block the verifier never reaches stays unknown');
  v.st.nonce = 8n;
  const ev = await chain.verifyOutcome({ hash: '0x' + 'ab'.repeat(32), from: FROM, nonce: 7, receiptBlock: 98n, timeoutMs: 1500, pollMs: 50 });
  assert.equal(ev.nonceConsumed, 'verified'); assert.equal(ev.stateVerified, false); assert.match(ev.receipt, /unverified/);
  assert.match(I.receiptLine({ evidence: ev }), /UNVERIFIED/);
  await assert.rejects(chain.verifyOutcome({ hash: '0x' + 'ab'.repeat(32), from: FROM, nonce: 7, receiptBlock: 98n, confirm: async () => false, timeoutMs: 1500 }), /effect is not visible in verified state/);
  assert.equal((await chain.verifyOutcome({ hash: '0x' + 'ab'.repeat(32), from: FROM, nonce: 7, receiptBlock: 98n, confirm: async (c) => (await c.read(ADDR, ABI, 'balanceOf', [ADDR])) === 42n })).stateVerified, true);
  assert.equal(I.receiptLine({ agreeing: 2 }), 'confirmed by 2 RPCs', 'legacy wording unchanged');
  // a transport-supplied pending nonce that verified state already shows used is refused before anything is signed
  await assert.rejects(chain.assertNonceUnused(FROM, 7), /pending nonce 7 .* already used in verified state \(nonce 8 .*nothing was signed/);
  assert.equal((await chain.assertNonceUnused(FROM, 8)).nonce, 8n);
});

test('credit-vault reader: state from the verifier (revert as revert), history only from the explicit transport, outcomes say what is verified', async () => {
  const v = await stand(verifier);
  const r = verifiedCreditReader({ verifier: v.url, chainId: 8453, confirmations: 2 });
  const snap = await r.snapshot();
  assert.deepEqual([snap.number, snap.hash, snap.baseFeePerGas, r.authority], [98, hashOf(98), 7n, 'local-verifier']);
  assert.equal(BigInt(await r.call(snap, ADDR, BAL)), 42n);
  await assert.rejects(r.call(snap, ADDR, REV), (e) => e.revert === true);
  assert.equal(await r.code(snap, ADDR), '0x6001'); assert.equal(await r.balance(snap, ADDR), 16n);
  for (const f of [() => r.logs(snap, { address: ADDR, fromBlock: 0, toBlock: 98 }), () => r.tx('0x' + '1'.repeat(64)), () => r.receipt('0x' + '1'.repeat(64))])
    await assert.rejects(f(), /needs the explicit transaction\/history transport/);
  assert.ok(v.st.calls.every(([m]) => !['eth_getLogs', 'eth_getTransactionReceipt', 'eth_getTransactionByHash'].includes(m)), 'the verifier never serves history');
  const ex = outcomeEvidence({ status: 'executed', block: 98, txHash: '0x' + '1'.repeat(64) }, r);
  assert.match(ex.evidence.execution, /UNVERIFIED/); assert.equal(ex.evidence.nonce, 'verified state');
  assert.match(outcomeEvidence({ status: 'superseded', block: 98 }, r).evidence.execution, /moved in verified state/);
  assert.deepEqual(outcomeEvidence({ status: 'pending' }, { authority: undefined }), { status: 'pending' }, 'legacy outcomes unchanged');
});

test('external signer: a signature over a zero priority fee (an RLP-empty field the parser omits) is accepted exactly, and only exactly', async () => {
  const acct = privateKeyToAccount('0x' + '22'.repeat(32));
  const want = intendedTx({ type: 'eip1559', nonce: 0, to: ADDR, value: 0n, data: '0x', gas: 21000n, maxFeePerGas: 7n, maxPriorityFeePerGas: 0n }, 8453);
  const raw = await acct.signTransaction(want);
  assert.equal((await verifySignedTransaction(raw, want, acct.address)).raw, raw.toLowerCase());
  await assert.rejects(verifySignedTransaction(await acct.signTransaction({ ...want, maxPriorityFeePerGas: 1n }), want, acct.address), /maxPriorityFeePerGas 1 != intended 0/);
  await assert.rejects(verifySignedTransaction(await acct.signTransaction({ ...want, nonce: 1 }), want, acct.address), /nonce 1 != intended 0/);
});
