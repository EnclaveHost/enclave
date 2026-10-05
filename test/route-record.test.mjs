import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {keccak256,stringToHex} from 'viem';
import {qualifyProvider,PROVIDER_CHECKS} from '../network/provider-qualification.mjs';
import {privateKeyToAccount} from 'viem/accounts';
import {DurableState} from '../network/durable-state.mjs';
import {validateCircuitPolicy} from '../network/circuit-policy.mjs';
import {tunaPolicyFromLease} from '../network/tuna-policy.mjs';
import {canonical, recordHash, signDelegation, signRoute, signOwnerPolicy, verifyOwnerPolicy, verifyRoute} from '../network/route-record.mjs';

const app='0x'+'ab'.repeat(32), runner='0x'+'cd'.repeat(32);
const owner=privateKeyToAccount('0x'+'01'.repeat(32)), operator=privateKeyToAccount('0x'+'02'.repeat(32));
const policy=validateCircuitPolicy({version:2,deploymentId:app,mode:'guarded',directFallback:false,routes:2,maxPrice:'0.0002',budgetNkn:'1',diversity:'beneficiary-and-network'});
test('USDC routes recheck owner authorization and provider qualification, including signed stale records',async t=>{
 const expires=Math.floor(Date.now()/1000)+120,provider={id:'0x'+'ef'.repeat(32),qualified:true,active:true,qualifiedUntil:expires,pricePerGiB6:'1000',addressHash:keccak256(stringToHex('8.8.4.4'))};
 const connectivity={owner:owner.address,address:'0x'+'12'.repeat(20),viaTuna:true,nonce:'1',expires,maxPricePerGiB6:'1000',budget6:'10000',providers:[provider]};
 const p=tunaPolicyFromLease({id:app,owner:owner.address,connectivity});
 const {record,bundle,options}=await fixture(t,p),lease={...options.lease,owner:owner.address,connectivity},opts={...options,lease};
 assert.equal((await verifyRoute(bundle(record),opts)).routes.length,1);
 for(const change of [{viaTuna:false},{nonce:'2'},{owner:operator.address},{budget6:'1'},{providers:[]},{providers:[{...provider,qualified:false}]},{providers:[{...provider,qualifiedUntil:Math.floor(options.now/1000)+1}]},{providers:[{...provider,pricePerGiB6:'1001'}]}])await assert.rejects(verifyRoute(bundle(record),{...opts,lease:{...lease,connectivity:{...connectivity,...change}}}));
 for(const extra of [{fallback:true},{directPort:20000}])await assert.rejects(verifyRoute(bundle({...record,routes:[{...record.routes[0],...extra}]}),opts),/authorization/);
 const revoked={...opts,lease:{...lease,connectivity:{...connectivity,viaTuna:false}}};
 assert.deepEqual((await verifyRoute(bundle({...record,sequence:2,routes:[]}),revoked)).routes,[]);
});
async function fixture(t,selectedPolicy=policy) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'enclave-routes-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const now=Date.now(), keys=generateKeyPairSync('ed25519');
 const d={version:2,deploymentId:app,runner,chainId:8453,deployments:'0x'+'03'.repeat(20),policyHash:recordHash(selectedPolicy),epoch:now,notBefore:now,expiresAt:now+3600000,publicKey:keys.publicKey.export({type:'spki',format:'der'}).toString('base64'),ipns:'k51'+'a'.repeat(50)};
 const authorization=await signDelegation(operator,d,now);
 const record={version:2,deploymentId:app,delegationHash:recordHash(d),sequence:1,issuedAt:now,expiresAt:now+60000,routes:[{circuit:'f'.repeat(32),address:'8.8.4.4',port:443,transport:'tuna-guarded-tcp'}]};
 const bundle=r=>({authorization,...signRoute(keys.privateKey,r)});
 const options={deploymentId:app,policy:selectedPolicy,lease:{id:app,runner,chainId:8453,deployments:d.deployments,runnerOperator:operator.address,leaseUntil:now+900000,validUntil:now+90000,active:true,isPublic:true},memory:new DurableState(dir),now};
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
test('signed fallback direct ports are bounded and cannot be altered or added after signing',async t=>{
 const {record,bundle,options}=await fixture(t);
 const route={...record.routes[0],directPort:20000,fallback:true};
 const signed=bundle({...record,routes:[route]});
 assert.equal((await verifyRoute(signed,options)).routes[0].directPort,20000);
 const forged=structuredClone(signed);forged.record.routes[0].directPort=20002;
 await assert.rejects(verifyRoute(forged,options),/signature/);
 // out-of-range or non-integer ports are refused, at signing (canonical JSON) or at verification
 for(const directPort of [0,443,1023,65536,20000.5,'20000'])await assert.rejects(async()=>verifyRoute(bundle({...record,routes:[{...route,directPort}]}),options),/public route|bounded JSON/);
});

test('direct records require current on-chain owner and provider authorization even with a valid host signature',async t=>{
 const p={version:3,deploymentId:app,mode:'direct',routes:1,directFallback:false,nonce:'1',connectivity:'0x'+'12'.repeat(20),expiresAt:(Math.floor(Date.now()/1000)+120)*1000,maxPricePerGiB6:'1000',budget6:'10000'};
 const {record,bundle,options}=await fixture(t,p),checker=privateKeyToAccount('0x'+'04'.repeat(32));
 const address=record.routes[0].address;
 const q=await qualifyProvider({hostId:runner,operator:operator.address,address,probe:Object.fromEntries(PROVIDER_CHECKS.map(k=>[k,async()=>true])),signer:checker,now:()=>options.now,validForMs:300000});
 const lease={...options.lease,owner:owner.address,connectivity:{address:p.connectivity,owner:owner.address,nonce:'1',expires:p.expiresAt/1000,maxPricePerGiB6:p.maxPricePerGiB6,budget6:p.budget6,direct:true,qualifiedUntil:Math.floor(options.now/1000)+300,operator:operator.address,addressHash:keccak256(stringToHex(address))}};
 const r={...record,qualification:q,routes:[{...record.routes[0],transport:'direct'}]},opts={...options,lease,providerProbeSigners:[checker.address]};
 assert.equal((await verifyRoute(bundle(r),opts)).routes[0].transport,'direct');
 for(const change of [{nonce:'2'},{expires:0},{direct:false},{addressHash:'0x'+'00'.repeat(32)}])await assert.rejects(verifyRoute(bundle(r),{...opts,lease:{...lease,connectivity:{...lease.connectivity,...change}}}),/authorization/);
 await assert.rejects(verifyRoute(bundle({...r,expiresAt:p.expiresAt+1}),opts),/authorization/);
});

test('direct route accepts owner-scoped chain quorum without a global checker list and stops on trust change',async t=>{
 const p={version:3,deploymentId:app,mode:'direct',routes:1,directFallback:false,nonce:'1',connectivity:'0x'+'12'.repeat(20),expiresAt:(Math.floor(Date.now()/1000)+120)*1000,maxPricePerGiB6:'1000',budget6:'10000'};
 const {record,bundle,options}=await fixture(t,p);
 const c={appScopedQualification:true,address:p.connectivity,owner:owner.address,nonce:'1',expires:p.expiresAt/1000,maxPricePerGiB6:p.maxPricePerGiB6,budget6:p.budget6,direct:true,qualifiedUntil:Math.floor(options.now/1000)+90,operator:operator.address,addressHash:keccak256(stringToHex(record.routes[0].address))};
 const lease={...options.lease,owner:owner.address,connectivity:c},r={...record,routes:[{...record.routes[0],transport:'direct'}]},opts={...options,lease};
 assert.equal((await verifyRoute(bundle(r),opts)).routes[0].transport,'direct');
 for(const change of [{nonce:'2',expires:1},{direct:false},{operator:owner.address},{qualifiedUntil:Math.floor(options.now/1000)+1}])await assert.rejects(verifyRoute(bundle(r),{...opts,lease:{...lease,connectivity:{...c,...change}}}));
});
