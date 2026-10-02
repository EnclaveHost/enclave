import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {RoutePublisher,defaultPolicy,appPolicy} from '../network/route-publisher.mjs';
import {verifyRoute,signOwnerPolicy} from '../network/route-record.mjs';
import {DurableState} from '../network/durable-state.mjs';
const id='0x'+'ab'.repeat(32),account=privateKeyToAccount('0x'+'01'.repeat(32));
test('route identity and replay counter survive restart, while expired leases withdraw',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'enclave-publisher-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const now=Date.now();let lease={id,chainId:8453,deployments:'0x'+'11'.repeat(20),runner:'0x'+'22'.repeat(32),runnerOperator:account.address,
  owner:account.address,validUntil:now+60000,leaseUntil:now+120000,active:true,isPublic:true};
 const policy=defaultPolicy(id),options={directory,account,lease:()=>lease,policy:()=>policy,distribute:async()=>{}};
 const routes=[{circuit:'ab'.repeat(16),address:'8.8.4.4',port:443,transport:'tuna-guarded-tcp'}];
 const first=await new RoutePublisher(options).publish(id,routes),second=await new RoutePublisher(options).publish(id,[]);
 assert.equal(first.authorization.delegation.ipns,second.authorization.delegation.ipns);assert.equal(second.record.sequence,first.record.sequence+1);
 const memory=new DurableState(path.join(directory,'reader'));
 assert.deepEqual((await verifyRoute(second,{deploymentId:id,policy,lease,memory})).routes,[]);
 await assert.rejects(verifyRoute(first,{deploymentId:id,policy,lease,memory}),/rollback/);
 lease={...lease,validUntil:0};assert.equal(await new RoutePublisher(options).publish(id,routes),null);
});
test('pins require owner authorization; default policy needs no fabricated signature',async()=>{
 const lease={id,owner:account.address};assert.equal((await appPolicy({deploymentId:id},lease)).routes,2);
 await assert.rejects(appPolicy({deploymentId:id,policy:defaultPolicy(id)},lease),/owner signature/);
 const policy=defaultPolicy(id);policy.providers.guard.prefer=['12'.repeat(32)];
 const ownerPolicy=await signOwnerPolicy(account,policy);
 assert.equal((await appPolicy({deploymentId:id,ownerPolicy},lease)).providers.guard.prefer[0],'12'.repeat(32));
 await assert.rejects(appPolicy({deploymentId:id,ownerPolicy},{...lease,owner:'0x'+'33'.repeat(20)}),/owner signature/);
});
