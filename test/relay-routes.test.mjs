// relay/network-routes.mjs: the relay accepts only signed per-app routes under the owner's current v5 (Enclave network)
// policy; every TUNA-era publication (v1 host allocations, route policies v2/v3/v4) is refused. The map it serves feeds
// the DNS relay and the relay's deploy preflight (network/preflight.mjs).
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
const {createNetworkRoutes}=await import(process.env.ENCLAVE_TEST_RELAY_BUNDLE||'../relay/network-routes.mjs');
import {RoutePublisher} from '../network/route-publisher.mjs';
import {DurableState} from '../network/durable-state.mjs';
import {defaultNetworkPolicy,validateNetworkPolicy} from '../network/network-policy.mjs';
import {checkMap,fetchRouteMap} from '../network/preflight.mjs';

const id='0x'+'ab'.repeat(32),runner='0x'+'cd'.repeat(32),endpoint='https://api.enclave.host/t/metal0';
const account=privateKeyToAccount('0x'+'03'.repeat(32));
const exits=['8.8.4.4','1.1.1.1'];

async function world(t,{lease:over={},policy=validateNetworkPolicy(defaultNetworkPolicy(id)),current=policy,operatorOf=async()=>account.address,endpointId=async()=>runner,network:withNetwork=true}={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'relay-routes-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const w={now:Date.now(),statuses:[],directory};
 w.lease={id,runner,runnerOperator:account.address,owner:account.address,chainId:8453,deployments:'0x'+'12'.repeat(20),active:true,isPublic:true,
  validUntil:w.now+120000,leaseUntil:w.now+600000,...over};
 w.providers=exits.map((address,i)=>({providerId:String(i).repeat(32),address,eligibleRoles:['guard','ingress','egress'],qualifiedUntil:w.now+600000,pricePerGiB6:0}));
 const network={currentPolicy:()=>current,eligible:async()=>w.providers,checkers:[],noteStatus:(i,s)=>w.statuses.push([i,s])};
 w.publisher=new RoutePublisher({directory:path.join(directory,'publisher'),account,policy:()=>policy,lease:()=>w.lease,distribute:async()=>{},now:()=>w.now});
 w.options={operatorOf,endpointId,eligible:()=>true,leaseOf:async()=>w.lease,memory:new DurableState(path.join(directory,'mirror')),now:()=>w.now,...(withNetwork?{network}:{})};
 w.mirror=createNetworkRoutes(w.options);
 w.routes=(addresses=exits)=>addresses.map((address,i)=>({circuit:String(i+1).repeat(32),address,port:443,transport:'enclave-network'}));
 w.publication=async(routes=w.routes())=>({version:2,endpoint,policy,bundle:await w.publisher.publish(id,routes)});
 w.row=()=>({...w.lease,leaseUntil:w.lease.leaseUntil/1000});
 return w;
}

test('a v5 publication is mapped to both exits, with the Enclave-network DNS label, and passes the deploy preflight',async t=>{
 const w=await world(t);
 const unpublished=await w.mirror.map([w.row()]);
 assert.deepEqual(unpublished.pending,[{id,reason:'host_unpublished'}]);
 assert.throws(()=>checkMap(unpublished),/not ready/);
 await w.mirror.publish({...await w.publication(),status:{deploymentId:id,ready:true}});
 const map=await w.mirror.map([w.row()]);
 assert.equal(map.transport,'enclave-network','the map format name readers check');
 assert.equal(checkMap({...map,transport:'tuna'},[id],w.now).length,1,'a pre-rename relay\'s map is still read');
 assert.throws(()=>checkMap({...map,transport:'other'},[id],w.now),/unavailable/);
 assert.deepEqual(map.labels.abababab.addresses,exits);assert.equal(map.labels.abababab.relay,'enclave');assert.equal(map.labels.abababab.a,exits[0]);
 assert.equal(map.deployments[id].transport,'enclave-network');assert.equal(map.deployments[id].httpsRoutes.length,2);
 assert.deepEqual(w.statuses,[[id,{deploymentId:id,ready:true}]],'the host\'s reported status reaches the Network tab');
 assert.equal(checkMap(map,[id],w.now).length,1);
 assert.throws(()=>checkMap(map,[id],w.now+60000),/expired/);
 await assert.rejects(w.mirror.publish({...await w.publication(),bundle:{...(await w.publication()).bundle,signature:'bad'}}),/signature/);
});

test('TUNA-era publications are refused: v1 host allocations and route policies v2, v3 and v4',async t=>{
 const w=await world(t);
 await assert.rejects(w.mirror.publish({version:1,endpoint,expiresAt:w.now+60000,web:{address:'9.9.9.9',port:443},raw:[]},'legacy'),/TUNA route publications are retired/);
 const good=await w.publication();
 for(const policy of [
  {version:2,deploymentId:id,mode:'guarded',directFallback:false,routes:2,maxPrice:'0.0002',budgetNkn:'1',diversity:'beneficiary-and-network'},
  {version:3,deploymentId:id,mode:'direct',routes:1,directFallback:false,nonce:'1',connectivity:'0x'+'12'.repeat(20),expiresAt:w.now+60000,maxPricePerGiB6:'0',budget6:'0'},
  {version:4,deploymentId:id,mode:'guarded',currency:'USDC'},
  undefined])
  await assert.rejects(w.mirror.publish({...good,policy}),/TUNA route publications are retired/);
 await assert.rejects(w.mirror.publish(undefined),/retired/);
 // nothing refused reached the map
 assert.deepEqual((await w.mirror.map([w.row()])).pending,[{id,reason:'host_unpublished'}]);
 // a host's route publisher refuses to sign under a TUNA-era policy at all
 const old=new RoutePublisher({directory:path.join(w.directory,'old'),account,policy:()=>({version:2,deploymentId:id}),lease:()=>w.lease,distribute:async()=>{},now:()=>w.now});
 await assert.rejects(old.publish(id,w.routes()),/route policy version 2 is retired/);
});

test('only the owner\'s current network policy carries routes, and a relay without the Enclave network accepts none',async t=>{
 const owned=validateNetworkPolicy({...defaultNetworkPolicy(id),nonce:3,issuedAt:1,enclaveNetwork:{routes:1,guard:true,maxPricePerGiB6:0,budget6:0}});
 const w=await world(t,{current:owned});
 await assert.rejects(w.mirror.publish(await w.publication()),/owner's current network policy/);
 const n=await world(t,{network:false});
 await assert.rejects(n.mirror.publish(await n.publication()),/not configured/);
});

test('a route address must be a qualified Enclave-network ingress provider',async t=>{
 const w=await world(t);
 await assert.rejects(w.mirror.publish(await w.publication(w.routes(['9.9.9.9']))),/qualified Enclave-network ingress provider/);
 w.providers[0].eligibleRoles=['guard','egress'];
 await assert.rejects(w.mirror.publish(await w.publication(w.routes([exits[0]]))),/qualified Enclave-network ingress provider/);
 await assert.rejects(w.mirror.publish(await w.publication([{...w.routes([exits[1]])[0],transport:'tuna-guarded-tcp'}])),/invalid public route/);
});

test('a withdrawal leaves the app pending, never on a shared route',async t=>{
 const w=await world(t);
 await w.mirror.publish(await w.publication());
 await w.mirror.publish(await w.publication([]));
 let map=await w.mirror.map([w.row()]);
 assert.equal(map.labels.abababab,undefined);assert.deepEqual(map.pending,[{id,reason:'private_routes_unavailable'}]);
 // a relay restart still remembers the app published (the route memory), so it stays pending rather than unpublished
 map=await createNetworkRoutes(w.options).map([w.row()]);
 assert.deepEqual(map.pending,[{id,reason:'private_routes_unavailable'}]);
});

test('a chain-read lease that proved the runner registration needs no second operator read',async t=>{
 let asked=0,runnerOf=async()=>runner;
 const w=await world(t,{lease:{runnerRegistered:true},operatorOf:async()=>{asked++;return null;},endpointId:e=>runnerOf(e)});
 await w.mirror.publish(await w.publication());
 assert.equal(asked,0);
 // The proof is about the lease's runner only: another endpoint is still refused.
 runnerOf=async()=>'0x'+'ee'.repeat(32);
 await assert.rejects(w.mirror.publish(await w.publication()),/not from the deployment runner/);
 // Without the chain proof the registry is asked, and its answer decides.
 runnerOf=async()=>runner;delete w.lease.runnerRegistered;
 await assert.rejects(w.mirror.publish(await w.publication()),/inactive route operator/);
 assert.equal(asked,1);
});

test('the preflight reads /v1/network/routes, and /v1/network/tuna only from a relay that predates the rename',async()=>{
 const seen=[];const fake=status=>async url=>{seen.push(new URL(url).pathname);return {status:new URL(url).pathname==='/v1/network/routes'?status:200};};
 assert.equal((await fetchRouteMap('https://api.example',fake(200))).status,200);assert.deepEqual(seen,['/v1/network/routes']);
 seen.length=0;await fetchRouteMap('https://api.example',fake(404));assert.deepEqual(seen,['/v1/network/routes','/v1/network/tuna']);
 seen.length=0;assert.equal((await fetchRouteMap('https://api.example',fake(503))).status,503,'only a 404 falls back');
});
