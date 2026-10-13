import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';import {recoverMessageAddress} from 'viem';
import {TunaUSDCSettlement,TunaReceiptSigner,tunaReceiptDigest} from '../network/tuna-usdc-settlement.mjs';
const id='0x'+'aa'.repeat(32),runner='0x'+'bb'.repeat(32),providerId='0x'+'dd'.repeat(32),owner='0x'+'11'.repeat(20),contract='0x'+'22'.repeat(20),ledger='0x'+'33'.repeat(20),hash='0x'+'cc'.repeat(32);
const host=privateKeyToAccount('0x'+'04'.repeat(32)),provider=privateKeyToAccount('0x'+'05'.repeat(32));
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tuna-settle-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const lease={id,runner,owner,runnerProofKey:host.address,active:true,chainId:8453,deployments:ledger,validUntil:190000,leaseUntil:200000,blockNumber:'100',blockHash:hash,balance6:'100000',bandwidthBackingRequired6:'0',
  connectivity:{address:contract,viaTuna:true,owner,nonce:'1',expires:200,maxPricePerGiB6:'1000',budget6:'10000',spent6:'0',providers:[{id:providerId,qualified:true,active:true,qualifiedUntil:200,pricePerGiB6:'1000',operator:provider.address,proofKey:provider.address}]}};
 const client={readContract:async()=>0n,getBlock:async()=>({hash})},reader={clients:[client,client],get:()=>lease,refresh:async()=>[lease]};
 let observed=1000n;
 const signer=new TunaReceiptSigner({providerId,proofAccount:provider,leaseReader:reader,observedBytes:async()=>observed,now:()=>100000});
 const adapter=new TunaUSDCSettlement({providerId,cosign:r=>signer.sign(r),directory,leaseReader:reader,proofAccount:host,maxPending6:'10',now:()=>100000});
 const request={deploymentId:id,policyHash:'ff'.repeat(32),cumulativeBytes:'1000',cumulativeCost6:'1',pricePerGiB6:'1000',nonce:'1'};
 const receipt={id,runnerId:runner,providerId,policyNonce:1n,leaseUntil:200n,issuedAt:100n,anchor:99n,cumulativeBytes:1000n,pricePerGiB6:1000n};
 const signRequest=async changes=>{const r={...receipt,...changes},digest=tunaReceiptDigest({chainId:8453,connectivity:contract,ledger,receipt:r,anchorHash:hash});return {receipt:r,anchorHash:hash,runnerSignature:await host.signMessage({message:{raw:digest}})};};
 return {adapter,signer,lease,request,signRequest,directory,setObserved:n=>{observed=n;}};
}
test('independent provider and host sign the same metered receipt',async t=>{
 const x=await fixture(t);await x.adapter.authorizeDebit(x.request);
 const state=await x.adapter.state.get(id.slice(2)+'-1');assert.equal(state.hostId,providerId);assert.equal(state.runnerId,runner);
 const result=await x.adapter.signedReceipt({id,s:state,lease:x.lease,c:x.lease.connectivity,head:{hash}});
 assert.equal(result.functionName,'settleTuna');
 const digest=tunaReceiptDigest({chainId:8453,connectivity:contract,ledger,receipt:result.receipt,anchorHash:hash});
 assert.equal(await recoverMessageAddress({message:{raw:digest},signature:result.args[1]}),host.address);
 assert.equal(await recoverMessageAddress({message:{raw:digest},signature:result.args[2]}),provider.address);
});
test('provider rejects unobserved traffic, wrong host, stale anchor and replayed policy',async t=>{
 for(const change of [{cumulativeBytes:1001n},{runnerId:providerId},{policyNonce:2n},{issuedAt:60n},{leaseUntil:201n},{providerId:runner}]){
  const x=await fixture(t);await assert.rejects(x.signer.sign(await x.signRequest(change)));
 }
 const x=await fixture(t);const request=await x.signRequest({});request.anchorHash='0x'+'00'.repeat(32);await assert.rejects(x.signer.sign(request),/quorum/);
});
test('current provider path, qualification, backing, price and signature are mandatory',async t=>{
 for(const alter of [x=>x.lease.connectivity.viaTuna=false,x=>x.lease.connectivity.providers[0].qualified=false,x=>x.lease.connectivity.maxPricePerGiB6='999',x=>x.lease.bandwidthBackingRequired6='1',x=>x.lease.connectivity.providers[0].id=runner,x=>x.lease.runnerProofKey=owner]){
  const x=await fixture(t);alter(x);await assert.rejects(x.adapter.authorizeDebit(x.request));
 }
 const x=await fixture(t);await x.adapter.authorizeDebit(x.request);x.adapter.cosign=async r=>r.runnerSignature;
 await assert.rejects(x.adapter.signedReceipt({id,s:await x.adapter.state.get(id.slice(2)+'-1'),lease:x.lease,c:x.lease.connectivity,head:{hash}}),/provider receipt/);
});
test('shared gas journal serializes distinct provider meters without nonce races',async t=>{
 const x=await fixture(t);const y=new TunaUSDCSettlement({providerId:runner,cosign:()=>{},directory:path.join(x.directory,'second'),transactionDirectory:x.adapter.transactions.directory,leaseReader:x.adapter.leaseReader,proofAccount:host,maxPending6:'10'});
 let active=0,max=0,done=0;
 for(const adapter of [x.adapter,y])adapter.sendReceipt=async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));active--;done++;};
 await Promise.all([x.adapter.settle(id,{}),y.settle(id,{})]);assert.equal(done,2);assert.equal(max,1);
});
