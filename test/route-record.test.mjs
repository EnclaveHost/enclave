import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {qualifyProvider,PROVIDER_CHECKS} from '../network/provider-qualification.mjs';
import {privateKeyToAccount} from 'viem/accounts';
import {DurableState} from '../network/durable-state.mjs';
import {defaultNetworkPolicy,validateNetworkPolicy} from '../network/network-policy.mjs';
import {canonical, recordHash, signDelegation, signRoute, validateRoutePolicy, verifyRoute} from '../network/route-record.mjs';

const app='0x'+'ab'.repeat(32), runner='0x'+'cd'.repeat(32);
const owner=privateKeyToAccount('0x'+'01'.repeat(32)), operator=privateKeyToAccount('0x'+'02'.repeat(32));
const policy=validateNetworkPolicy(defaultNetworkPolicy(app));
async function fixture(t,selectedPolicy=policy) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'enclave-routes-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const now=Date.now(), keys=generateKeyPairSync('ed25519');
 const d={version:2,deploymentId:app,runner,chainId:8453,deployments:'0x'+'03'.repeat(20),policyHash:recordHash(selectedPolicy),epoch:now,notBefore:now,expiresAt:now+3600000,publicKey:keys.publicKey.export({type:'spki',format:'der'}).toString('base64'),ipns:'k51'+'a'.repeat(50)};
 const authorization=await signDelegation(operator,d,now);
 const record={version:2,deploymentId:app,delegationHash:recordHash(d),sequence:1,issuedAt:now,expiresAt:now+60000,routes:[{circuit:'f'.repeat(32),address:'8.8.4.4',port:443,transport:'enclave-network'}]};
 const bundle=r=>({authorization,...signRoute(keys.privateKey,r)});
 const networkProviders=[{providerId:'e'.repeat(32),address:'8.8.4.4',eligibleRoles:['guard','ingress','egress'],qualifiedUntil:now+600000,pricePerGiB6:0}];
 const options={deploymentId:app,policy:selectedPolicy,lease:{id:app,runner,chainId:8453,deployments:d.deployments,runnerOperator:operator.address,leaseUntil:now+900000,validUntil:now+90000,active:true,isPublic:true},memory:new DurableState(dir),networkProviders,now};
 return {record,bundle,options,dir};
}
test('canonical JSON is sorted and refuses undefined',()=>{
 assert.equal(canonical({b:1,a:[false,'x']}),'{"a":[false,"x"],"b":1}');
 assert.throws(()=>canonical({x:undefined}));
});
test('TUNA-era route policies (v2 guarded TUNA, v3 on-chain direct, v4 USDC TUNA) are refused; v5 is the only route policy',async t=>{
 for(const version of [2,3,4,undefined])assert.throws(()=>validateRoutePolicy({version,deploymentId:app}),/retired/);
 assert.deepEqual(validateRoutePolicy(policy),policy);
 const old={version:2,deploymentId:app,mode:'guarded',directFallback:false,routes:2,maxPrice:'0.0002',budgetNkn:'1',diversity:'beneficiary-and-network'};
 const {record,bundle,options}=await fixture(t,old);
 await assert.rejects(verifyRoute(bundle({...record,routes:[{...record.routes[0],transport:'tuna-guarded-tcp'}]}),{...options,policy:old}),/retired/);
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
 await assert.rejects(verifyRoute(bundle({...record,routes:[{...record.routes[0],address:'9.9.9.9'}]}),options),/qualified Enclave-network ingress provider/);
 await assert.rejects(verifyRoute(bundle(record),{...options,networkProviders:[{...options.networkProviders[0],eligibleRoles:['guard','egress']}]}),/ingress provider/);
 await assert.rejects(verifyRoute(bundle(record),{...options,networkProviders:[{...options.networkProviders[0],pricePerGiB6:1}]}),/ingress provider/,'over the policy\'s price limit');
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
test('TUNA fallback fields (directPort, fallback) are not part of a v5 route',async t=>{
 const {record,bundle,options}=await fixture(t);
 for(const extra of [{directPort:20000},{fallback:true},{other:1}])await assert.rejects(verifyRoute(bundle({...record,routes:[{...record.routes[0],...extra}]}),options),/public route/);
});

test('v5 direct routes (Enclave network policy): accepted only with a trusted checker\'s current qualification of this runner, operator and address',async t=>{
 const p={version:5,deploymentId:app,nonce:1,issuedAt:1,mode:'direct',fallback:'none',direct:{maxPricePerGiB6:0}};
 const {record,bundle,options}=await fixture(t,p),checker=privateKeyToAccount('0x'+'04'.repeat(32)),stranger=privateKeyToAccount('0x'+'05'.repeat(32));
 const address=record.routes[0].address;
 const q=(signer,over={})=>qualifyProvider({hostId:runner,operator:operator.address,address,probe:Object.fromEntries(PROVIDER_CHECKS.map(k=>[k,async()=>true])),signer,now:()=>options.now,validForMs:300000,...over});
 const r={...record,qualification:await q(checker),routes:[{...record.routes[0],transport:'direct'}]},opts={...options,providerProbeSigners:[checker.address]};
 assert.equal((await verifyRoute(bundle(r),opts)).routes[0].transport,'direct');
 await assert.rejects(verifyRoute(bundle({...r,qualification:await q(stranger)}),opts),/./,'an untrusted checker');
 const {qualification:_q,...bare}=r;await assert.rejects(verifyRoute(bundle(bare),opts),/./,'no qualification');
 await assert.rejects(verifyRoute(bundle({...r,routes:[{...r.routes[0],transport:'enclave-network'}]}),opts),/invalid public route/,'a direct policy routes only direct');
 await assert.rejects(verifyRoute(bundle({...r,routes:[{...r.routes[0],address:'9.9.9.9'}]}),opts),/./,'another address than the qualified one');
});
