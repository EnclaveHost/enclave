import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {recoverMessageAddress} from 'viem';
import {USDCBandwidthSettlement,receiptDigest} from '../network/usdc-bandwidth.mjs';
const id='0x'+'aa'.repeat(32),runner='0x'+'bb'.repeat(32),owner='0x'+'11'.repeat(20),contract='0x'+'22'.repeat(20),ledger='0x'+'33'.repeat(20),hash='0x'+'cc'.repeat(32);
const proof=privateKeyToAccount('0x'+'04'.repeat(32));
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bandwidth-settle-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 let reads=0;const reader={clients:[{readContract:async()=>{reads++;return 0n;}},{readContract:async()=>{reads++;return 0n;}}],get:()=>lease};
 const lease={id,runner,owner,runnerProofKey:proof.address,active:true,chainId:8453,deployments:ledger,leaseUntil:200000,blockNumber:'100',blockHash:hash,balance6:'100000',bandwidthBackingRequired6:'0',
  connectivity:{address:contract,owner,nonce:'1',expires:200,direct:true,pricePerGiB6:'1000',budget6:'10000',spent6:'0'}};
 const adapter=new USDCBandwidthSettlement({directory,leaseReader:reader,proofAccount:proof,maxPending6:'10',now:()=>100000});
 const request={deploymentId:id,policyHash:'ff'.repeat(32),cumulativeBytes:'1',cumulativeCost6:'1',pricePerGiB6:'1000',nonce:'1'};
 return {adapter,lease,request,directory,reads:()=>reads};
}
test('bounded provider credit keeps chain reads off subsequent packet writes',async t=>{
 const x=await fixture(t);await x.adapter.authorizeDebit(x.request);
 await x.adapter.authorizeDebit({...x.request,cumulativeBytes:'2'});assert.equal(x.reads(),2);
 const saved=await x.adapter.state.get(id.slice(2)+'-1');assert.equal(saved.bytes,'2');
 x.lease.connectivity.expires=0;await assert.rejects(x.adapter.authorizeDebit({...x.request,cumulativeBytes:'3'}),/authorization/);
});
test('unbacked balances, misbound signer, wrong rates and budget overrun refuse traffic',async t=>{
 for(const modify of [x=>x.lease.bandwidthBackingRequired6='1',x=>x.lease.runnerProofKey=owner,x=>x.request.pricePerGiB6='2000',x=>x.lease.connectivity.budget6='0']){
  const x=await fixture(t);modify(x);await assert.rejects(x.adapter.authorizeDebit(x.request));
 }
});
test('credit cap forces settlement before admitting more traffic and failure does not advance counters',async t=>{
 const x=await fixture(t);await x.adapter.authorizeDebit(x.request);let calls=0;x.adapter.settle=async()=>{calls++;throw Error('chain unavailable')};
 await assert.rejects(x.adapter.authorizeDebit({...x.request,cumulativeBytes:'1073741824',cumulativeCost6:'1000'}),/unavailable/);
 assert.equal(calls,1);assert.equal((await x.adapter.state.get(id.slice(2)+'-1')).bytes,'1');
});
test('receipt signature binds chain, ledger, host, policy and byte count',async()=>{
 const receipt={id,hostId:runner,policyNonce:1n,leaseUntil:200n,issuedAt:100n,anchor:99n,cumulativeBytes:1000n,pricePerGiB6:1000n};
 const args={chainId:8453,connectivity:contract,ledger,receipt,anchorHash:hash};const digest=receiptDigest(args);
 const signature=await proof.signMessage({message:{raw:digest}});
 assert.equal((await recoverMessageAddress({message:{raw:digest},signature})).toLowerCase(),proof.address.toLowerCase());
 assert.notEqual(receiptDigest({...args,chainId:8454}),digest);
 assert.notEqual(receiptDigest({...args,receipt:{...receipt,cumulativeBytes:1001n}}),digest);
});
test('restart discovers durable accepted counters for settlement without requiring new traffic',async t=>{
 const x=await fixture(t);await x.adapter.authorizeDebit(x.request);
 const y=new USDCBandwidthSettlement({directory:x.directory,leaseReader:x.adapter.leaseReader,proofAccount:proof,maxPending6:'10',now:()=>100000});
 await y.start();assert.equal(y.apps.size,1);clearInterval(y.timer);
});
test('shared wallet recovery never imports another meter directory into this meter',async t=>{
 const x=await fixture(t);await x.adapter.authorizeDebit(x.request);
 const accepted=await x.adapter.state.get(id.slice(2)+'-1');
 const y=new USDCBandwidthSettlement({directory:path.join(x.directory,'another'),transactionDirectory:x.adapter.transactions.directory,leaseReader:x.adapter.leaseReader,proofAccount:proof,maxPending6:'10',now:()=>100000});
 await x.adapter.transactions.set('wallet-current',{state:'confirmed',acceptedDirectory:x.adapter.state.directory,meter:'direct',deploymentId:id,nonce:'1',accepted});
 await y.start();clearInterval(y.timer);
 assert.equal(y.apps.size,0);assert.equal(await y.recoverCounters(x.request),undefined);
 await y.authorizeDebit({...x.request,policyHash:'ee'.repeat(32)});
 assert.equal((await y.state.get(id.slice(2)+'-1')).policyHash,'ee'.repeat(32));
});

test('payment journal repairs a crash between accepted payment and local traffic counter commit',async t=>{
 const {TrafficMeter}=await import('../network/traffic-meter.mjs');
 const x=await fixture(t);
 const options={directory:path.join(x.directory,'traffic'),deploymentId:id,policyHash:x.request.policyHash,
  terms:{nonce:'1',pricePerGiB6:'1000',budget6:'10000',expiresAt:200000},now:()=>100000,
  authorizeDebit:r=>x.adapter.authorizeDebit(r),recoverCounters:r=>x.adapter.recoverCounters(r)};
 const first=new TrafficMeter(options);
 first.state.update=async(_key,fn)=>{await fn(null);throw Error('simulated power loss before counter commit');};
 await assert.rejects(first.consume('out',100),/power loss/);
 const resumed=new TrafficMeter(options),result=await resumed.consume('in',100);
 assert.equal(result.out,'100');assert.equal(result.in,'100');assert.equal(result.units,'200000');
 // A confirmed transaction also survives a crash before accepted state commits.
 const accepted=await x.adapter.state.get(id.slice(2)+'-1');
 await x.adapter.state.set(id.slice(2)+'-1',null);
 await x.adapter.transactions.set('wallet-current',{state:'confirmed',deploymentId:id,nonce:'1',accepted});
 assert.deepEqual(await x.adapter.recoverCounters({...x.request}),accepted.counters);
});
