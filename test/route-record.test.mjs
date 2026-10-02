import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {DurableState} from '../network/durable-state.mjs';
import {validateCircuitPolicy} from '../network/circuit-policy.mjs';
import {canonical, recordHash, signDelegation, signRoute, signOwnerPolicy, verifyOwnerPolicy, verifyRoute} from '../network/route-record.mjs';

const app='0x'+'ab'.repeat(32), runner='0x'+'cd'.repeat(32);
const owner=privateKeyToAccount('0x'+'01'.repeat(32)), operator=privateKeyToAccount('0x'+'02'.repeat(32));
const policy=validateCircuitPolicy({version:2,deploymentId:app,mode:'guarded',directFallback:false,routes:2,maxPrice:'0.0002',budgetNkn:'1',diversity:'beneficiary-and-network'});
async function fixture(t) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'enclave-routes-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const now=Date.now(), keys=generateKeyPairSync('ed25519');
 const d={version:2,deploymentId:app,runner,chainId:8453,deployments:'0x'+'03'.repeat(20),policyHash:recordHash(policy),epoch:now,notBefore:now,expiresAt:now+3600000,publicKey:keys.publicKey.export({type:'spki',format:'der'}).toString('base64'),ipns:'k51'+'a'.repeat(50)};
 const authorization=await signDelegation(operator,d,now);
 const record={version:2,deploymentId:app,delegationHash:recordHash(d),sequence:1,issuedAt:now,expiresAt:now+60000,routes:[{circuit:'f'.repeat(32),address:'8.8.4.4',port:443,transport:'tuna-guarded-tcp'}]};
 const bundle=r=>({authorization,...signRoute(keys.privateKey,r)});
 const options={deploymentId:app,policy,lease:{id:app,runner,chainId:8453,deployments:d.deployments,runnerOperator:operator.address,leaseUntil:now+900000,validUntil:now+90000,active:true,isPublic:true},memory:new DurableState(dir),now};
 return {record,bundle,options,dir};
}
test('canonical policy signatures require the owner, not the host operator',async()=>{
 assert.equal(canonical({b:1,a:[false,'x']}),'{"a":[false,"x"],"b":1}');
 assert.throws(()=>canonical({x:undefined}));
 const signed=await signOwnerPolicy(owner,policy);
 assert.deepEqual(await verifyOwnerPolicy(signed,owner.address),policy);
 await assert.rejects(verifyOwnerPolicy(signed,operator.address),/owner signature/);
});
test('routes bind app, live lease, delegated key, policy and public addresses',async t=>{
 const {record,bundle,options}=await fixture(t);
 assert.equal((await verifyRoute(bundle(record),options)).routes.length,1);
 const forged=bundle(record);forged.record={...record,sequence:2};
 await assert.rejects(verifyRoute(forged,options),/signature/);
 await assert.rejects(verifyRoute(bundle(record),{...options,deploymentId:runner}),/app mismatch/);
 await assert.rejects(verifyRoute(bundle(record),{...options,lease:{...options.lease,validUntil:options.now}}),/fresh matching lease/);
 await assert.rejects(verifyRoute(bundle(record),{...options,lease:{...options.lease,runnerOperator:owner.address}}),/current runner/);
 await assert.rejects(verifyRoute(bundle({...record,routes:[{...record.routes[0],address:'127.0.0.1'}]}),options),/public route/);
});
test('withdrawal survives restart, rejects replay and serializes concurrent floors',async t=>{
 const {record,bundle,options,dir}=await fixture(t);
 await verifyRoute(bundle(record),options);
 await verifyRoute(bundle({...record,sequence:3,routes:[]}),options);
 options.memory=new DurableState(dir);
 await assert.rejects(verifyRoute(bundle(record),options),/rollback/);
 await assert.rejects(verifyRoute(bundle({...record,sequence:3}),options),/equivocation/);
 const results=await Promise.allSettled([verifyRoute(bundle({...record,sequence:5}),options),verifyRoute(bundle({...record,sequence:4}),options)]);
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
 assert.equal((await options.memory.get(app)).sequence,5);
});
