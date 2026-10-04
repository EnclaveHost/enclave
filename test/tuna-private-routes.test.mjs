import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
const {createTunaRoutes}=await import(process.env.ENCLAVE_TEST_RELAY_BUNDLE||'../relay/tuna-routes.mjs');
import {RoutePublisher,defaultPolicy} from '../network/route-publisher.mjs';
import {DurableState} from '../network/durable-state.mjs';
const id='0x'+'ab'.repeat(32),runner='0x'+'cd'.repeat(32),endpoint='https://api.enclave.host/t/metal0';
const account=privateKeyToAccount('0x'+'03'.repeat(32));
test('DNS compatibility retains both signed routes and never falls back to a shared route after migration',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'tuna-private-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let now=Date.now();const policy=defaultPolicy(id),lease={id,runner,runnerOperator:account.address,owner:account.address,chainId:8453,
  deployments:'0x'+'12'.repeat(20),active:true,isPublic:true,validUntil:now+120000,leaseUntil:now+600000};
 const publisher=new RoutePublisher({directory:path.join(directory,'publisher'),account,policy:()=>policy,lease:()=>lease,distribute:async()=>{},now:()=>now});
 const addresses=['8.8.4.4','1.1.1.1'];const bundle=await publisher.publish(id,addresses.map((address,i)=>({circuit:String(i).padStart(32,'0'),address,port:443,transport:'tuna-guarded-tcp'})));
 const options={operatorOf:async()=>account.address,endpointId:async()=>runner,eligible:()=>true,leaseOf:async()=>lease,memory:new DurableState(path.join(directory,'mirror')),now:()=>now,recover:async()=>account.address.toLowerCase()};
 const mirror=createTunaRoutes(options),publication={version:2,endpoint,policy,bundle};
 await mirror.publish(publication);
 const row={...lease,leaseUntil:lease.leaseUntil/1000};
 let map=await mirror.map([row]);assert.deepEqual(map.labels.abababab.addresses,addresses);assert.equal(map.deployments[id].httpsRoutes.length,2);
 await assert.rejects(mirror.publish({...publication,bundle:{...bundle,signature:'bad'}}),/signature/);
 now+=61000;
 await mirror.publish({version:1,endpoint,expiresAt:now+60000,web:{address:'9.9.9.9',port:443},raw:[]},'legacy');
 map=await mirror.map([row]);assert.equal(map.labels.abababab,undefined);assert.equal(map.pending[0].reason,'private_routes_unavailable');
 const restarted=createTunaRoutes(options);await restarted.publish({version:1,endpoint,expiresAt:now+60000,web:{address:'9.9.9.9',port:443},raw:[]},'legacy');
 assert.equal((await restarted.map([row])).labels.abababab,undefined);
});
test('DNS keeps the warm fallback out of normal answers and promotes it when the primary is withdrawn',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'tuna-fallback-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const now=Date.now(),policy=defaultPolicy(id),lease={id,runner,runnerOperator:account.address,owner:account.address,chainId:8453,deployments:'0x'+'12'.repeat(20),active:true,isPublic:true,validUntil:now+120000,leaseUntil:now+600000};
 const publisher=new RoutePublisher({directory:path.join(directory,'publisher'),account,policy:()=>policy,lease:()=>lease,distribute:async()=>{},now:()=>now});
 const mirror=createTunaRoutes({operatorOf:async()=>account.address,endpointId:async()=>runner,eligible:()=>true,leaseOf:async()=>lease,memory:new DurableState(path.join(directory,'mirror')),now:()=>now});
 const primary={circuit:'a'.repeat(32),address:'8.8.4.4',port:443,transport:'tuna-guarded-tcp'},fallback={circuit:'b'.repeat(32),address:'1.1.1.1',port:443,transport:'tuna-guarded-tcp',directPort:20000,fallback:true};
 const row={...lease,leaseUntil:lease.leaseUntil/1000};
 const publish=async routes=>mirror.publish({version:2,endpoint,policy,bundle:await publisher.publish(id,routes)});
 await publish([primary,fallback]);let map=await mirror.map([row]);
 assert.deepEqual(map.labels.abababab.addresses,[primary.address]);assert.equal(map.deployments[id].httpsRoutes[1].directPort,20000);
 await publish([fallback]);map=await mirror.map([row]);assert.deepEqual(map.labels.abababab.addresses,[fallback.address]);
 await publish([]);assert.equal((await mirror.map([row])).labels.abababab,undefined);
});

test('USDC TUNA mirror accepts chain-authorized paths and rejects substituted or revoked policies',async t=>{
 const {keccak256,stringToHex}=await import('viem');const {tunaPolicyFromLease}=await import('../network/tuna-policy.mjs');
 const directory=await mkdtemp(path.join(os.tmpdir(),'tuna-usdc-mirror-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const now=Date.now(),expiry=Math.floor(now/1000)+120,address='8.8.4.4';
 const provider={id:'0x'+'ef'.repeat(32),qualified:true,active:true,qualifiedUntil:expiry,pricePerGiB6:'1000',addressHash:keccak256(stringToHex(address))};
 const c={owner:account.address,address:'0x'+'12'.repeat(20),viaTuna:true,nonce:'1',expires:expiry,maxPricePerGiB6:'1000',budget6:'10000',providers:[provider]};
 const lease={id,runner,runnerOperator:account.address,owner:account.address,chainId:8453,deployments:'0x'+'12'.repeat(20),active:true,isPublic:true,validUntil:now+90000,leaseUntil:now+600000,connectivity:c};
 const policy=tunaPolicyFromLease(lease),publisher=new RoutePublisher({directory:path.join(directory,'publisher'),account,policy:()=>policy,lease:()=>lease,distribute:async()=>{},now:()=>now});
 const bundle=await publisher.publish(id,[{circuit:'a'.repeat(32),address,port:443,transport:'tuna-guarded-tcp'}]);
 const mirror=createTunaRoutes({operatorOf:async()=>account.address,endpointId:async()=>runner,eligible:()=>true,leaseOf:async()=>lease,memory:new DurableState(path.join(directory,'mirror')),now:()=>now});
 const publication={version:2,endpoint,policy,bundle};await mirror.publish(publication);
 assert.equal((await mirror.map([{...lease,leaseUntil:lease.leaseUntil/1000}])).deployments[id].https.address,address);
 lease.connectivity={...c,nonce:'2',expires:0};await assert.rejects(mirror.publish(publication));
 // A current runner can withdraw its own route after revocation, without
 // acquiring a new spending authorization merely to stop traffic.
 await mirror.publish({...publication,bundle:await publisher.publish(id,[])});
 assert.equal((await mirror.map([{...lease,leaseUntil:lease.leaseUntil/1000}])).deployments[id],undefined);
});
