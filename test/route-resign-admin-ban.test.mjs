// Reviewer 9d (isolated): an ADMIN host ban (platform host policy, hostAdmission) and a lease end landing DURING a
// same-route re-sign stream. TREE=<dir with network/> selects the fixed tree or base. Characterises: (1) once banned, no
// new re-sign is accepted; (2) the ban takes effect no later than the next read; (3) what the in-flight read serves.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const TREE=process.env.TREE?path.resolve(process.env.TREE):fileURLToPath(new URL('../',import.meta.url));
const imp=p=>import(path.join(TREE,p));
const {privateKeyToAccount}=await imp('node_modules/viem/_esm/accounts/index.js');
const {PublicDirectory}=await imp('network/public-directory.mjs');
const {signProviderRecord,signQualification,providerIdFor,CHECKS}=await imp('network/provider-directory.mjs');
const {defaultNetworkPolicy}=await imp('network/network-policy.mjs');
const {signDelegation,signRoute,recordHash}=await imp('network/route-record.mjs');
const account=n=>privateKeyToAccount('0x'+n.repeat(64));
const owner=account('1'),operator=account('2'),checker=account('3');
const id='0x'+'ab'.repeat(32),runner='0x'+'cd'.repeat(32),label=id.slice(2,10),A='8.8.4.4',B='8.8.8.8';
const pass=Object.fromEntries(CHECKS.map(k=>[k,true])),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function rig(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'route-ban-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const policy=defaultNetworkPolicy(id),now0=Date.now(),admission={admit:true,asked:0};
  const lease={id,owner:owner.address,runner,chainId:8453,deployments:'0x'+'05'.repeat(20),runnerOperator:operator.address,active:true,isPublic:true,leaseUntil:now0+600000,validUntil:now0+90000};
  const d=new PublicDirectory({directory:dir,checkers:[checker.address],hostOperator:async()=>operator.address,leaseOf:async()=>{await sleep(60);return {...lease};},
    hostAdmission:async()=>{admission.asked++;return admission.admit?{admit:true}:{admit:false,reason:'banned by platform policy #9 (admin)'};}});
  for(const [address,k] of [[A,1],[B,3]]){
    const record={version:1,providerId:providerIdFor(operator.address,address),operator:operator.address.toLowerCase(),address,wgExitKey:Buffer.alloc(32,k).toString('base64'),
      wgGuardKey:Buffer.alloc(32,k+1).toString('base64'),ports:{exit:51820,guard:51821,control:51822},roles:['guard','ingress','egress'],pricePerGiB6:0,region:'t',kind:'community',hostId:runner,issuedAt:now0,expiresAt:now0+1800000};
    await d.accept('provider',await signProviderRecord(operator,record));
    await d.accept('qualification',await signQualification(checker,{version:1,providerId:record.providerId,operator:record.operator,address,wgExitKey:record.wgExitKey,wgGuardKey:record.wgGuardKey,roles:record.roles,checks:pass,issuedAt:now0-1000,expiresAt:now0+590000}));
  }
  const keys=generateKeyPairSync('ed25519');
  const delegation={version:2,deploymentId:id,runner,chainId:8453,deployments:lease.deployments,policyHash:recordHash(policy),epoch:now0,notBefore:now0,expiresAt:now0+3600000,publicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),ipns:'k51'+'a'.repeat(50)};
  const authorization=await signDelegation(operator,delegation,Date.now());let seq=0;
  const publish=async()=>{const now=Date.now();const record={version:2,deploymentId:id,delegationHash:recordHash(delegation),sequence:++seq,issuedAt:now,expiresAt:now+60000,
    routes:[A,B].map((address,i)=>({circuit:String(i+1).repeat(32),address,port:443,transport:'enclave-network'}))};
    await d.accept('route',{version:2,endpoint:'https://h.example/t/host',policy,bundle:{authorization,...signRoute(keys.privateKey,record)}});};
  await publish();
  return {d,publish,admission,lease};
}
const served=r=>r.labels[label]?.addresses;
async function readDuring(d,during,everyMs=20){let done=false,n=0;const read=d.routes().finally(()=>{done=true;});
  const churn=(async()=>{while(!done){await during(n++);await sleep(everyMs);}})();const r=await read;await churn;return r;}

test('an admin BAN landing during same-route re-signs: re-signs refused after it, and the NEXT read withholds the app',async t=>{
  const {d,publish,admission}=await rig(t);
  let refusedAfterBan=0,acceptedAfterBan=0;
  const r=await readDuring(d,async(n)=>{ if(n===1)admission.admit=false;
    try{await publish(); if(!admission.admit)acceptedAfterBan++;}catch(e){ if(!admission.admit&&/platform host policy/.test(e.message))refusedAfterBan++; else if(admission.admit) throw e; }});
  console.log('# in-flight read served:',JSON.stringify(served(r)),'pending:',JSON.stringify(r.pending));
  if(admission.admit){admission.admit=false;try{await publish();}catch(e){if(/platform host policy/.test(e.message))refusedAfterBan++;}}   // the read ended first: ban now
  assert.equal(acceptedAfterBan,0,'no re-sign is accepted once the host is banned');
  assert.ok(refusedAfterBan>=1,'a re-sign after the ban is refused by the platform host policy');
  const next=await d.routes();
  assert.equal(served(next),undefined,'the ban takes effect by the next read');
  assert.equal(next.pending[0]?.reason,'no_current_verified_route');
});

test('a LEASE end landing during same-route re-signs takes effect by the next read',async t=>{
  const {d,publish,lease}=await rig(t);
  const r=await readDuring(d,async(n)=>{ if(n===1)lease.active=false; await publish().catch(()=>{}); });
  console.log('# in-flight read served:',JSON.stringify(served(r)),'lease active at end:',lease.active);
  lease.active=false;   // whether or not the read ended first
  assert.equal(served(await d.routes()),undefined,'the lease end takes effect by the next read');
});
