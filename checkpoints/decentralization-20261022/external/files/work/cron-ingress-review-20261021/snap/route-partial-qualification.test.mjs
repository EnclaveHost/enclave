// Regression (2026-10-21 16:01:51Z): one provider's qualification lapsed (both checkers' latest verdicts: payloadIntegrity
// i/o timeout) and every app routed through it AND another provider vanished from every directory and from DNS, because
// a route record naming one unqualified address was rejected whole. Now: that address is withheld, the record's other
// qualified routes are served; a record with no qualified route is still refused; security revocation is still immediate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {PublicDirectory} from '../network/public-directory.mjs';
import {DurableState} from '../network/durable-state.mjs';
import {signProviderRecord,signQualification,providerIdFor,CHECKS} from '../network/provider-directory.mjs';
import {defaultNetworkPolicy,validateNetworkPolicy} from '../network/network-policy.mjs';
import {signDelegation,signRoute,recordHash,verifyRoute} from '../network/route-record.mjs';
const account=n=>privateKeyToAccount('0x'+n.repeat(64));
const owner=account('1'),operator=account('2'),checker=account('3'),checker2=account('6');
const id='0x'+'ab'.repeat(32),runner='0x'+'cd'.repeat(32),label=id.slice(2,10),A='8.8.4.4',B='8.8.8.8';
const pass=Object.fromEntries(CHECKS.map(k=>[k,true]));

async function rig(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'route-partial-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let now=Date.now();const policy=defaultNetworkPolicy(id);
  const lease={id,owner:owner.address,runner,chainId:8453,deployments:'0x'+'05'.repeat(20),runnerOperator:operator.address,active:true,isPublic:true,leaseUntil:now+600000,validUntil:now+90000};
  const d=new PublicDirectory({directory:dir,checkers:[checker.address,checker2.address],now:()=>now,hostOperator:async()=>operator.address,leaseOf:async()=>({...lease})});
  const providers={};
  for(const [n,address] of [['A',A],['B',B]]){
    const record={version:1,providerId:providerIdFor(operator.address,address),operator:operator.address.toLowerCase(),address,
      wgExitKey:Buffer.alloc(32,n==='A'?1:3).toString('base64'),wgGuardKey:Buffer.alloc(32,n==='A'?2:4).toString('base64'),ports:{exit:51820,guard:51821,control:51822},
      roles:['guard','ingress','egress'],pricePerGiB6:0,region:'test',kind:'community',hostId:runner,issuedAt:now,expiresAt:now+1800000};
    await d.accept('provider',await signProviderRecord(operator,record));
    providers[n]=record;
  }
  // a checker's verdict for provider n, issued `at` ms from now (later verdicts of the same checker replace earlier ones)
  const verdict=async(n,checks,{by=checker,at=0}={})=>{const r=providers[n];
    await d.accept('qualification',await signQualification(by,{version:1,providerId:r.providerId,operator:r.operator,address:r.address,wgExitKey:r.wgExitKey,wgGuardKey:r.wgGuardKey,roles:r.roles,
      checks:{...pass,...checks},issuedAt:now+at,expiresAt:now+at+600000}));};
  const keys=generateKeyPairSync('ed25519');
  async function publication(addresses,sequence=1){
    const delegation={version:2,deploymentId:id,runner,chainId:8453,deployments:lease.deployments,policyHash:recordHash(policy),epoch:now,notBefore:now,expiresAt:now+3600000,
      publicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),ipns:'k51'+'a'.repeat(50)};
    const authorization=await signDelegation(operator,delegation,now);
    const record={version:2,deploymentId:id,delegationHash:recordHash(delegation),sequence,issuedAt:now,expiresAt:now+60000,
      routes:addresses.map((address,i)=>({circuit:String(i+1).repeat(32),address,port:443,transport:'enclave-network'}))};
    return {version:2,endpoint:'https://old-control.example/t/host',policy,bundle:{authorization,...signRoute(keys.privateKey,record)}};
  }
  return {d,verdict,publication,advance:ms=>{now+=ms;}};
}
const served=async d=>{const r=await d.routes();return {labels:r.labels[label]?.addresses||null,https:r.deployments[id]?.httpsRoutes?.map(x=>x.address)||null,pending:r.pending.map(x=>x.id)};};

test('the incident: one provider loses its passing verdicts (payload timeouts) -> its address is withheld, the app stays served by the other',async t=>{
  const r=await rig(t);
  for(const n of ['A','B'])for(const by of [checker,checker2])await r.verdict(n,{},{by});
  await r.d.accept('route',await r.publication([A,B]));
  assert.deepEqual((await served(r.d)).labels,[A,B]);
  // both checkers' LATEST verdicts for B: payloadIntegrity false (a reachability/throughput non-pass, every security check true)
  r.advance(1000);
  for(const by of [checker,checker2])await r.verdict('B',{payloadIntegrity:false},{by});
  const s=await served(r.d);
  assert.deepEqual(s.labels,[A],'before the fix the whole label disappeared (DNS answered nothing for the app)');
  assert.deepEqual(s.https,[A]);
  assert.deepEqual(s.pending,[]);
  // B passes again: both addresses are served again from the same signed record (nothing was re-published)
  r.advance(1000);await r.verdict('B',{},{by:checker});
  assert.deepEqual((await served(r.d)).labels,[A,B]);
});

test('a SECURITY failure still revokes that provider at once, and a record with no qualified route is still refused',async t=>{
  const r=await rig(t);
  for(const n of ['A','B'])await r.verdict(n,{});
  await r.d.accept('route',await r.publication([A,B]));
  r.advance(1000);await r.verdict('A',{blocksPrivateDestinations:false});   // reached it (udpEcho true) and it leaked
  assert.deepEqual((await served(r.d)).labels,[B],'the leaking provider is withheld immediately, even though another checker could pass it');
  r.advance(1000);await r.verdict('B',{payloadIntegrity:false});
  const s=await served(r.d);
  assert.equal(s.labels,null,'no qualified route left: the app is withheld, never served through an unqualified provider');
  assert.deepEqual(s.pending,[id]);
});

test('publication: a record naming one unqualified exit is accepted for its qualified routes; one naming only unqualified exits is refused',async t=>{
  const r=await rig(t);
  await r.verdict('A',{});await r.verdict('B',{payloadIntegrity:false});
  await assert.rejects(r.d.accept('route',await r.publication([B])),/qualified/);
  await r.d.accept('route',await r.publication([A,B],2));
  assert.deepEqual((await served(r.d)).labels,[A]);
});

test('verifyRoute exposes only qualified routes but binds signature and replay floor to the WHOLE signed record',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'route-partial-unit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const now=Date.now(),keys=generateKeyPairSync('ed25519'),policy=validateNetworkPolicy(defaultNetworkPolicy(id));
  const dl={version:2,deploymentId:id,runner,chainId:8453,deployments:'0x'+'03'.repeat(20),policyHash:recordHash(policy),epoch:now,notBefore:now,expiresAt:now+3600000,publicKey:keys.publicKey.export({type:'spki',format:'der'}).toString('base64'),ipns:'k51'+'a'.repeat(50)};
  const authorization=await signDelegation(operator,dl,now);
  const record={version:2,deploymentId:id,delegationHash:recordHash(dl),sequence:1,issuedAt:now,expiresAt:now+60000,
    routes:[{circuit:'1'.repeat(32),address:A,port:443,transport:'enclave-network'},{circuit:'2'.repeat(32),address:B,port:443,transport:'enclave-network'}]};
  const bundle=rec=>({authorization,...signRoute(keys.privateKey,rec)});
  const memory=new DurableState(dir);
  const opts={deploymentId:id,policy,memory,now,lease:{id,runner,chainId:8453,deployments:dl.deployments,runnerOperator:operator.address,leaseUntil:now+900000,validUntil:now+90000,active:true,isPublic:true},
    networkProviders:[{address:A,eligibleRoles:['guard','ingress','egress'],qualifiedUntil:now+600000,pricePerGiB6:0},{address:B,eligibleRoles:['guard','egress'],qualifiedUntil:now+600000,pricePerGiB6:0}]};
  const out=await verifyRoute(bundle(record),opts);
  assert.deepEqual(out.routes.map(x=>x.address),[A]);
  assert.equal((await memory.get(id)).hash,recordHash(record),'the floor is the full signed record, not the served subset');
  // a forged record (the served subset passed off as the signed record) is still refused
  const forged=bundle(record);forged.record={...record,routes:[record.routes[0]]};
  await assert.rejects(verifyRoute(forged,opts),/signature/);
  // a provider over the policy's price limit or not yet qualified long enough is withheld the same way
  const again=await verifyRoute(bundle(record),{...opts,networkProviders:[opts.networkProviders[0],{...opts.networkProviders[1],eligibleRoles:['ingress'],pricePerGiB6:1}]});
  assert.deepEqual(again.routes.map(x=>x.address),[A]);
  await assert.rejects(verifyRoute(bundle(record),{...opts,networkProviders:[]}),/qualified Enclave-network ingress provider/);
});
