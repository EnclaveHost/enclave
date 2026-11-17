// The Windows node's wiring of proof of capacity (windows/node/proof-of-capacity.mjs): off unless enabled, off on a
// prover that is not one, and when on, an answer and an agent that talk to the contract through the node's chain module.
import test from 'node:test';
import assert from 'node:assert/strict';
import {pad, toHex, keccak256, toBytes, decodeFunctionData, encodeFunctionResult, recoverTypedDataAddress} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {createNodeProofOfCapacity} from '../windows/node/proof-of-capacity.mjs';
import {POC_ABI} from '../network/proof-of-capacity-host.mjs';
import {createCardCheck, softwareCardDriver, CARD_CHECK_PATH} from '../network/proof-of-capacity-card.mjs';

const A = pad(toHex(0xA1), {size: 32}), seed = keccak256(toBytes('s')), CONTRACT = '0x00000000000000000000000000000000000c0ffe';
function chainStub({schema = 3n, standing = [false, 'needs its own proof of capacity']} = {}) {
  const key = privateKeyToAccount(generatePrivateKey()), sent = [], views = {
    proofSchema: () => schema, epochNow: () => 4n, seedOf: () => seed, targetsOf: () => [], checkersOf: () => [],
    verdictOf: () => 0, standing: () => standing};
  return {key, sent, chainId: 8453, addresses: {proofOfTime: CONTRACT}, proofAddress: () => key.address,
    proofSign: m => key.signTypedData(m), blockNumber: async () => 1n, readEnclave: async () => null,
    publicClient: () => ({getBlock: async ({blockNumber} = {}) => ({number: blockNumber ?? 100n, hash: seed}), readContract: async ({functionName, args}) => { if (schema === null) throw new Error('execution reverted'); return views[functionName](...args); }}),
    sendOperatorTx: async (address, abi, fn, args) => { sent.push({address, fn, args}); return '0xhash'; }};
}

test('off: not enabled, no proof key, not registered, or a prover that is not one (said once)', async () => {
  const logs = [];
  let chain = chainStub();
  assert.equal(await createNodeProofOfCapacity({chain, hostId: () => A, wantsCredit: async () => true, enabled: false})(), null);
  assert.equal(await createNodeProofOfCapacity({chain, hostId: () => null, wantsCredit: async () => true, enabled: true})(), null);
  assert.equal(await createNodeProofOfCapacity({chain: {...chain, proofAddress: () => null}, hostId: () => A, wantsCredit: async () => true, enabled: true})(), null);
  for (const schema of [2n, null]) {
    chain = chainStub({schema});
    const get = createNodeProofOfCapacity({chain, hostId: () => A, wantsCredit: async () => true, enabled: true, log: m => logs.push(m)});
    assert.equal(await get(), null); assert.equal(await get(), null);
  }
  assert.equal(logs.length, 2); assert.match(logs[0], /not an EnclaveProofOfCapacity \(proofSchema 2\)/); assert.match(logs[1], /proofSchema unread/);
});

test('on: a lone box sends its own proof through the node\'s operator queue, to the prover, signed by the proof key', async () => {
  const chain = chainStub(), logs = [];
  const get = createNodeProofOfCapacity({chain, hostId: () => A, wantsCredit: async () => true, enabled: true, log: m => logs.push(m)});
  const poc = await get(); assert.ok(poc); assert.equal(await get(), poc);
  const r = await poc.agent.tick();
  assert.equal(r.selfProved, true);
  assert.deepEqual(chain.sent.map(x => [x.address, x.fn]), [[CONTRACT, 'proveSelf']]);
  assert.equal(chain.sent[0].args[0], A);
  // and it answers nobody the contract did not assign
  const res = await poc.answer({version: 2, lanes: 1, epoch: 4, checker: pad(toHex(0xB2), {size: 32}), target: A, seed, nonce: '0x' + '33'.repeat(32), rounds: 10, memoryMiB: 1, signature: '0x00'});
  assert.equal(res.status, 403);
});

test('the card a box sells is checked like a metal host\'s: the box answers for it from its own worker, and for none when it sells none', async () => {
  // a checker the contract assigned to this box, the box's card answered by the chain in software
  const B = pad(toHex(0xB2), {size: 32}), checker = privateKeyToAccount(generatePrivateKey()), box = chainStub();
  const chain = {...box, readEnclave: async id => (id === B ? {active: true, endpoint: 'https://b.example', proofKey: checker.address, operator: checker.address}
    : id === A ? {active: true, endpoint: 'https://a.example', proofKey: box.key.address, operator: box.key.address} : null),
    publicClient: () => ({readContract: async ({functionName}) => ({proofSchema: 3n, epochNow: 4n, seedOf: seed, checkersOf: [B]}[functionName])})};
  let sells = [{id: 0, endpoint: '127.0.0.1:9595'}];
  const poc = await createNodeProofOfCapacity({chain, hostId: () => A, wantsCredit: async () => false, enabled: true, cards: () => sells, openCard: softwareCardDriver()})();
  const domain = {chainId: 8453, contract: CONTRACT}, recover = (typedData, signature) => recoverTypedDataAddress({...typedData, signature});
  const check = () => createCardCheck({host: B, domain, sign: m => checker.signTypedData(m), recover, k: 64, batch: 4, stride: 4,
    fetch: async (url, init) => { assert.equal(url, 'https://a.example' + CARD_CHECK_PATH); const r = await poc.card(JSON.parse(init.body)); return {ok: r.status === 200, status: r.status, json: async () => r.body}; }});
  const claim = {cards: [{id: 0, gmacPerSec: 0.0001, share: 1}]}, row = {endpoint: 'https://a.example', proofKey: box.key.address};
  const r = await check()(A, row, {epoch: 4, seed, claim});
  assert.equal(r.ok, true, r.why); assert.equal(r.evidence.opened, 24);
  // no card sold now: advertised and not answered for
  sells = [];
  const box2 = await createNodeProofOfCapacity({chain, hostId: () => A, wantsCredit: async () => false, enabled: true, cards: () => sells, openCard: softwareCardDriver()})();
  const none = await createCardCheck({host: B, domain, sign: m => checker.signTypedData(m), recover, k: 64, batch: 4, stride: 4,
    fetch: async (_url, init) => { const x = await box2.card(JSON.parse(init.body)); return {ok: x.status === 200, status: x.status, json: async () => x.body}; }})(A, row, {epoch: 4, seed, claim});
  assert.equal(none.ok, false); assert.match(none.why, /does not answer for it \(HTTP 404\)/);
});
