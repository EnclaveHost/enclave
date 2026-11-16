// A host's carry order (network/host-carry.mjs): what it signs is what EnclaveHostExecutor checks (the digest is pinned
// to the contract's in contracts/foundry/test/EnclaveHostExecutor.t.sol testCarryDigestVector), and what a carrier does.
import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionData, encodeAbiParameters, keccak256, hashTypedData, recoverTypedDataAddress, parseAbi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {carryMessage, callsHash, signCarry, carryOrder, CARRY_ABI} from '../network/host-carry.mjs';

const eth = {encodeFunctionData, encodeAbiParameters, keccak256};
const key = privateKeyToAccount('0x' + 'b0b0'.padStart(64, '0')), operator = key.address;
const ledger = '0x00000000000000000000000000000000000000d1', target = '0x00000000000000000000000000000000000c0ffe';
const calls = ['0x1234', '0xabcdef'];
const fixed = {target, callsHash: callsHash(eth, calls), nonce: 7n, deadline: 1800000900n, payee: '0x000000000000000000000000000000000000ca11', fee6: 20000n, payout: '0x000000000000000000000000000000000000c01d'};
export const VECTOR = {callsHash: fixed.callsHash, digest: hashTypedData(carryMessage({chainId: 8453, operator, ledger}, fixed)), operator};
const PINNED = {callsHash: '0x235b07881835fd59445003e4559948b717643ee0ab15498b1e39e9ed94fcdd9a', digest: '0x8a06fb9d66f388e5ec836faaaacfa805b529860d23a681cd24605ed9fb2894f1'};

test('the order\'s digest and its commitment to the calls are the contract\'s', () => {
  assert.deepEqual({callsHash: VECTOR.callsHash, digest: VECTOR.digest}, PINNED);
});

test('an order that names no target, a malformed address or a negative fee is not signed', () => {
  const ok = {chainId: 8453, operator, ledger};
  for (const bad of [{target: '0x' + '00'.repeat(20)}, {target: 'x'}, {callsHash: '0x12'}, {payee: ''}, {fee6: -1n}, {deadline: 0n}])
    assert.throws(() => carryMessage(ok, {...fixed, ...bad}), JSON.stringify(bad, (_k, v) => typeof v === 'bigint' ? String(v) : v));
  assert.throws(() => carryMessage({...ok, chainId: 0}, fixed));
});

const abi = parseAbi(['function touch()', 'function proveSelf(bytes32 host, bytes32 evidence, bytes sig)']);
test('signCarry: the calls encoded in order, the key\'s signature over exactly them, a deadline from now', async () => {
  const host = '0x' + 'a1'.repeat(32);
  const o = await signCarry({eth, chainId: 8453, operator, ledger, target, nonce: 3n, fee6: 1500n, ttlSec: 120, now: () => 1_800_000_000_000,
    sign: m => key.signTypedData(m), calls: [{abi, functionName: 'touch'}, {abi, functionName: 'proveSelf', args: [host, host, '0x00']}]});
  assert.equal(o.calls.length, 2); assert.equal(o.calls[0], encodeFunctionData({abi, functionName: 'touch'}));
  assert.deepEqual({nonce: o.carry.nonce, deadline: o.carry.deadline, fee6: o.carry.fee6, payee: o.carry.payee}, {nonce: 3n, deadline: 1_800_000_120n, fee6: 1500n, payee: '0x' + '00'.repeat(20)});
  assert.equal(o.carry.callsHash, callsHash(eth, o.calls));
  assert.equal(await recoverTypedDataAddress({...carryMessage({chainId: 8453, operator, ledger}, o.carry), signature: o.signature}), operator);
  await assert.rejects(signCarry({eth, chainId: 8453, operator, ledger, target, nonce: 0n, fee6: 0n, sign: async () => '0x', calls: []}));
  // the encoded transaction is the contract's carry(c, calls, signature)
  assert.match(encodeFunctionData({abi: CARRY_ABI, functionName: 'carry', args: [o.carry, o.calls, o.signature]}), /^0x[0-9a-f]+$/);
});

test('a carrier sends only an order that pays it enough, still stands, pays it, and would not revert', async () => {
  const me = {address: '0x000000000000000000000000000000000000ca11'}, sent = [];
  const order = (over = {}) => ({operator, calls, signature: '0x' + '11'.repeat(65), carry: {...fixed, ...over}});
  const client = {simulateContract: async () => ({})}, wallet = {writeContract: async c => { sent.push(c); return '0xhash'; }};
  const at = {now: () => 1_800_000_000_000, client, wallet, account: me};
  assert.deepEqual(await carryOrder({...at, order: order()}), {sent: '0xhash'});
  assert.deepEqual({address: sent[0].address, functionName: sent[0].functionName, calls: sent[0].args[1]}, {address: operator, functionName: 'carry', calls});
  assert.match((await carryOrder({...at, order: order(), minFee6: 20001n})).refused, /under this carrier's/);
  assert.match((await carryOrder({...at, order: order({deadline: 1_800_000_010n})})).refused, /about to expire/);
  assert.match((await carryOrder({...at, order: order({payee: '0x000000000000000000000000000000000000beef'})})).refused, /another carrier/);
  assert.deepEqual(await carryOrder({...at, order: order({payee: '0x' + '00'.repeat(20)})}), {sent: '0xhash'});   // whoever carries it
  const reverting = {simulateContract: async () => { throw Object.assign(new Error('x'), {shortMessage: 'FeeNotCovered(100, 20000)'}); }};
  const before = sent.length;
  assert.match((await carryOrder({...at, client: reverting, order: order()})).refused, /would revert: FeeNotCovered/);
  assert.equal(sent.length, before);
  assert.deepEqual(await carryOrder({...at, order: null}), {refused: 'not an order'});
});
