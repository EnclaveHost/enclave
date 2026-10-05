import test from 'node:test';import assert from 'node:assert/strict';import {hashMessage} from 'viem';
import {verifyContractOwnerSignature} from '../relay/contract-owner-signature.mjs';
const owner='0x'+'12'.repeat(20),message='enclave-secrets:put:deployment:expiry:payload';
test('contract owner verification uses the exact message hash and configured owner',async()=>{
 let called=false;const client={getCode:async({address})=>{assert.equal(address,owner);return '0x1234';},readContract:async q=>{called=true;assert.equal(q.address,owner);assert.deepEqual(q.args,[hashMessage(message),'0x1234']);return '0x1626ba7e';}};
 assert.equal(await verifyContractOwnerSignature({client,owner,message,signature:'0x1234'}),true);assert.equal(called,true);
});
test('EOAs, wrong magic, oversized input and RPC failures cannot authorize secrets',async()=>{
 for(const client of [{getCode:async()=>'0x'},{getCode:async()=>'0x01',readContract:async()=>'0xffffffff'},{getCode:async()=>{throw Error('offline');}}])assert.equal(await verifyContractOwnerSignature({client,owner,message,signature:'0x1234'}),false);
 assert.equal(await verifyContractOwnerSignature({client:{},owner,message,signature:'0x'+'11'.repeat(4097)}),false);
});
