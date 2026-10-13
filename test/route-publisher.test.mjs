import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {RoutePublisher} from '../network/route-publisher.mjs';
import {verifyRoute} from '../network/route-record.mjs';
import {DurableState} from '../network/durable-state.mjs';
import {defaultNetworkPolicy,validateNetworkPolicy} from '../network/network-policy.mjs';
const id='0x'+'ab'.repeat(32),account=privateKeyToAccount('0x'+'01'.repeat(32));
test('route identity and replay counter survive restart, while expired leases withdraw',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'enclave-publisher-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const now=Date.now();let lease={id,chainId:8453,deployments:'0x'+'11'.repeat(20),runner:'0x'+'22'.repeat(32),runnerOperator:account.address,
  owner:account.address,validUntil:now+60000,leaseUntil:now+120000,active:true,isPublic:true};
 const policy=validateNetworkPolicy(defaultNetworkPolicy(id)),options={directory,account,lease:()=>lease,policy:()=>policy,distribute:async()=>{}};
 const networkProviders=[{providerId:'0'.repeat(32),address:'8.8.4.4',eligibleRoles:['guard','ingress','egress'],qualifiedUntil:now+600000,pricePerGiB6:0}];
 const routes=[{circuit:'ab'.repeat(16),address:'8.8.4.4',port:443,transport:'enclave-network'}];
 const first=await new RoutePublisher(options).publish(id,routes),second=await new RoutePublisher(options).publish(id,[]);
 assert.equal(first.authorization.delegation.ipns,second.authorization.delegation.ipns);assert.equal(second.record.sequence,first.record.sequence+1);
 assert.ok(first.record.expiresAt<=now+61000,'a v5 route lives at most a minute');
 const memory=new DurableState(path.join(directory,'reader'));
 assert.deepEqual((await verifyRoute(second,{deploymentId:id,policy,lease,memory,networkProviders})).routes,[]);
 await assert.rejects(verifyRoute(first,{deploymentId:id,policy,lease,memory,networkProviders}),/rollback/);
 lease={...lease,validUntil:0};assert.equal(await new RoutePublisher(options).publish(id,routes),null);
});
test('a direct route needs the host\'s current direct-hosting qualification',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'enclave-publisher-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const now=Date.now(),lease={id,chainId:8453,deployments:'0x'+'11'.repeat(20),runner:'0x'+'22'.repeat(32),runnerOperator:account.address,
  owner:account.address,validUntil:now+60000,leaseUntil:now+120000,active:true,isPublic:true};
 const policy=validateNetworkPolicy({version:5,deploymentId:id,nonce:1,issuedAt:1,mode:'direct',fallback:'none',direct:{maxPricePerGiB6:0}});
 const routes=[{circuit:'ab'.repeat(16),address:'8.8.4.4',port:443,transport:'direct'}];
 let qualification;
 const publisher=new RoutePublisher({directory,account,lease:()=>lease,policy:()=>policy,qualification:async()=>qualification,distribute:async()=>{}});
 await assert.rejects(publisher.publish(id,routes),/qualification required/);
 qualification={report:{expiresAt:now+30000}};
 const bundle=await publisher.publish(id,routes);
 assert.deepEqual(bundle.record.qualification,qualification);assert.ok(bundle.record.expiresAt<=now+30000,'never outlives the qualification');
 assert.deepEqual((await publisher.publish(id,[])).record.routes,[],'a withdrawal needs no qualification');
});
