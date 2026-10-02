import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {createTunaRoutes} from '../relay/tuna-routes.mjs';
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
