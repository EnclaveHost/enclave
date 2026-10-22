import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { reserveRequest, checkCreationLanding } from './request.mjs';
const read = file => JSON.parse(fs.readFileSync(new URL(file,import.meta.url)));
const base = {
  pre:read('../../outputs/app-lease-gas-review/production-funding-preflight.json'),
  draft:read('../lease-gas-production-preflight/reserve-creation-draft.json'),
  simulation:read('../lease-gas-production-preflight/multicall-simulation.json'),
  mainSourceHash:createHash('sha256').update(fs.readFileSync(new URL('../enclave/contracts/EnclaveLeaseGasReserve.sol',import.meta.url))).digest('hex'),
};
base.now=Date.parse(base.pre.checkedAt)+1000;
const make=()=>reserveRequest(structuredClone(base));
test('reviewed two-provider simulation yields zero-value creation, no recipient or automatic funding',()=>{
 const r=make(); assert.equal(r.transaction.value,'0x0'); assert.equal(r.transaction.to,undefined);
 assert.equal(r.transaction.from,base.pre.owner); assert.match(r.predictedAddressWarning,/NOT a funding destination/);
 assert.equal(r.transaction.data,base.draft.creationData);
});
const bad=[
 ['stale preflight',x=>x.now+=120000,/less than two minutes/],
 ['changed main source',x=>x.mainSourceHash='00'.repeat(32),/main source changed/],
 ['changed creation code',x=>x.draft.creationData+='00',/calldata changed/],
 ['changed sender',x=>x.draft.from='0x'+'11'.repeat(20),/sender changed/],
 ['nonzero deposit',x=>x.draft.value='1',undefined],
 ['disagreeing block',x=>x.pre.reads[1].blockHash='0x'+'11'.repeat(32),/block disagreement/],
 ['disagreeing nonce',x=>x.pre.reads[1].nonce++,/nonce disagreement/],
 ['duplicated provider',x=>x.pre.reads[1].rpc=x.pre.reads[0].rpc,/duplicate RPC/],
 ['failed simulation',x=>x.simulation.results[0].result[0].calls[0].status='0x0',/failed simulated call/],
 ['changed runtime',x=>x.simulation.results[1].result[0].calls[0].returnData='0x00',/runtime hash inconsistent/],
 ['excess gas',x=>x.simulation.results[0].estimates[0].illustrativeGasLimit='5000001',/gas exceeds/],
 ['excess fees',x=>x.simulation.results[0].estimates[0].illustrativeMaxFeePerGas='1000000001',/fee exceeds/],
];
for(const [name,mutate,pattern] of bad)test('refuses '+name,()=>{const x=structuredClone(base);mutate(x);assert.throws(()=>reserveRequest(x),pattern)});
function landing(r) {
 const t=r.transaction,hash='0x'+'12'.repeat(32);
 return {transaction:{...t,to:null,chainId:8453,nonce:Number(BigInt(t.nonce)),input:t.data,hash},
 receipt:{status:'success',transactionHash:hash,contractAddress:r.predictedAddress},code:base.simulation.results[0].result[0].calls[0].returnData};
}
test('accepts exact creation landing for subsequent binding-read verification',()=>{const r=make();assert.equal(checkCreationLanding(r,landing(r)),r.predictedAddress)});
for(const [name,mutate,pattern] of [
 ['wrong recipient',x=>x.transaction.to='0x'+'11'.repeat(20),/not contract creation/],
 ['wrong code',x=>x.transaction.input='0x00',/wrong creation code/],
 ['reverted creation',x=>x.receipt.status='reverted',/creation reverted/],
 ['unrelated receipt',x=>x.receipt.transactionHash='0x'+'99'.repeat(32),/receipt hash differs/],
 ['wrong address',x=>x.receipt.contractAddress='0x'+'11'.repeat(20),/wrong deployed address/],
 ['wrong deployed runtime',x=>x.code='0x00',/unexpected runtime/],
 ['wallet raised fee',x=>x.transaction.maxFeePerGas='0x7fffffffffffffff',/increased fee cap/],
])test('rejects landing with '+name,()=>{const r=make(),l=landing(r);mutate(l);assert.throws(()=>checkCreationLanding(r,l),pattern)});
