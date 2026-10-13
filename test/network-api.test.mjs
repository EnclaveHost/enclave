// The relay's Enclave-network API (relay/network-api.mjs): directory, qualifications, owner policies, BYO configs.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {createNetworkApi,byoConfigMessage,byoOwnerMessage} from '../relay/network-api.mjs';
import {JsonStore} from '../relay/store.js';
import {signProviderRecord,signQualification,providerIdFor,CHECKS} from '../network/provider-directory.mjs';
import {signNetworkPolicy,byoReleaseMessage} from '../network/network-policy.mjs';

const id='0x'+'ab'.repeat(32),runner='0x'+'11'.repeat(32);
const owner=privateKeyToAccount(generatePrivateKey()),other=privateKeyToAccount(generatePrivateKey()),runnerOp=privateKeyToAccount(generatePrivateKey());
const operator=privateKeyToAccount(generatePrivateKey()),checker=privateKeyToAccount(generatePrivateKey());
const K=()=>randomBytes(32).toString('base64');
function rig(){
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'netapi-')),'network.json');let t=Date.now();
 const api=createNetworkApi({checkers:[checker.address],file,JsonStore,secretsKey:'aa'.repeat(32),clients:async()=>[],now:()=>t});
 const rows=[{id,owner:owner.address,runner,runnerOperator:runnerOp.address,leaseUntil:Math.floor(t/1000)+3600,isPublic:true}];
 const ctx={json:(res,status,body)=>{res.status=status;res.body=body;},readBody:async req=>Buffer.from(JSON.stringify(req.body||{})),ledgerRows:async()=>rows};
 const call=async(method,p,body)=>{const res={};await api.handle({method,body},res,new URL('http://x'+p),ctx);return res;};
 return {api,call,rows,advance:ms=>{t+=ms;},now:()=>t};
}
async function record(r,over={}){
 const address='134.199.235.187',rec={version:1,providerId:providerIdFor(operator.address,address),operator:operator.address.toLowerCase(),address,wgExitKey:K(),wgGuardKey:K(),
  ports:{exit:51820,guard:51821,control:51822},roles:['guard','ingress','egress'],pricePerGiB6:0,region:'sfo3',kind:'enclave',hostId:null,issuedAt:r.now(),expiresAt:r.now()+1800000,...over};
 return signProviderRecord(operator,rec);
}
const qual=(rec,r,signer=checker,checks=Object.fromEntries(CHECKS.map(c=>[c,true])))=>signQualification(signer,{version:1,providerId:rec.providerId,operator:rec.operator,address:rec.address,wgExitKey:rec.wgExitKey,wgGuardKey:rec.wgGuardKey,roles:rec.roles,checks,issuedAt:r.now(),expiresAt:r.now()+600000});

test('providers opt in with a signed record; only trusted checkers qualify them; eligibility follows',async()=>{
 const r=rig(),env=await record(r);
 assert.equal((await r.call('POST','/v1/network/providers',env)).status,200);
 assert.equal((await r.call('POST','/v1/network/providers',env)).status,409,'stale re-publication');
 const forged={record:{...env.record,pricePerGiB6:5},signature:env.signature};
 assert.equal((await r.call('POST','/v1/network/providers',forged)).status,400);
 assert.equal((await r.api.eligible()).length,0,'not qualified yet');
 assert.equal((await r.call('POST','/v1/network/qualifications',await qual(env.record,r,other))).status,403,'untrusted checker');
 assert.equal((await r.call('POST','/v1/network/qualifications',await qual(env.record,r))).status,200);
 const e=await r.api.eligible();assert.equal(e.length,1);assert.deepEqual(e[0].eligibleRoles,['guard','ingress','egress']);
 // a failed check: stored, but not eligible
 r.advance(1000);const failed=Object.fromEntries(CHECKS.map(c=>[c,c!=='blocksSmtp']));
 assert.equal((await r.call('POST','/v1/network/qualifications',await qual(env.record,r,checker,failed))).body.passed,false);
 assert.equal((await r.api.eligible()).length,0);
 // new keys: the old qualification no longer applies
 r.advance(1000);await r.call('POST','/v1/network/qualifications',await qual(env.record,r));
 r.advance(1000);const rekeyed=await record(r,{issuedAt:r.now()});
 assert.equal((await r.call('POST','/v1/network/providers',rekeyed)).body.qualified,false);
 assert.equal((await r.api.eligible()).length,0);
 // expiry
 r.advance(11*60000);assert.equal((await r.call('GET','/v1/network/providers')).body.providers.length,1);
});
test('owner policies: owner only, increasing nonce, BYO only with its config uploaded',async()=>{
 const r=rig();
 assert.equal((await r.call('GET','/v1/network/policy/'+id)).body.policy.mode,'enclave-network','default before any policy');
 const p1={version:5,deploymentId:id,nonce:1,issuedAt:1,mode:'enclave-network',fallback:'none',enclaveNetwork:{routes:1,guard:true,maxPricePerGiB6:0,budget6:0}};
 assert.equal((await r.call('POST','/v1/network/policy/'+id,{envelope:await signNetworkPolicy(other,p1)})).status,400);
 assert.equal((await r.call('POST','/v1/network/policy/'+id,{envelope:await signNetworkPolicy(owner,p1)})).status,200);
 assert.equal((await r.call('POST','/v1/network/policy/'+id,{envelope:await signNetworkPolicy(owner,p1)})).status,409,'same nonce again');
 const byo={version:5,deploymentId:id,nonce:2,issuedAt:2,mode:'byo-wireguard',fallback:'none',byo:{configDigest:'cd'.repeat(32),ingress:'none'}};
 assert.equal((await r.call('POST','/v1/network/policy/'+id,{envelope:await signNetworkPolicy(owner,byo)})).status,409,'config first');
 assert.equal(r.api.currentPolicy(id).nonce,1);
});
const cfg=`[Interface]\nPrivateKey = ${'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk='}\nAddress = 10.64.0.2/32\nDNS = 10.64.0.1\n[Peer]\nPublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=\nEndpoint = 203.0.114.9:51820\nAllowedIPs = 0.0.0.0/0\n`;
test('BYO configs: sealed, redacted, owner-only view, released only to the current runner, once per request',async()=>{
 const r=rig(),salt=randomBytes(32).toString('hex'),expiry=Math.floor(r.now()/1000)+300;
 const {wireGuardConfigDigest,parseWireGuardConfig}=await import('../network/wg-config.mjs');
 const digest=await wireGuardConfigDigest(salt,parseWireGuardConfig(cfg).config);
 const put=async(signer)=>r.call('POST','/v1/network/byo/'+id,{config:cfg,salt,expiry,signature:await signer.signMessage({message:byoConfigMessage({deploymentId:id,configDigest:digest,expiry})})});
 assert.equal((await put(other)).status,403);
 const ok=await put(owner);assert.equal(ok.status,200);assert.equal(ok.body.configDigest,digest);
 assert.ok(!JSON.stringify(ok.body).includes('yAnz5TF'),'no private key in any response');
 const stored=fs.readFileSync(r.api.store.file,'utf8');assert.ok(!stored.includes('yAnz5TF')&&!stored.includes('10.64.0.1/'),'sealed at rest');
 assert.equal((await put(owner)).status,409,'a signature is single-use');
 // now a policy may name it
 const byo={version:5,deploymentId:id,nonce:2,issuedAt:2,mode:'byo-wireguard',fallback:'none',byo:{configDigest:digest,ingress:'none'}};
 assert.equal((await r.call('POST','/v1/network/policy/'+id,{envelope:await signNetworkPolicy(owner,byo)})).status,200);
 const view=await r.call('POST',`/v1/network/byo/${id}/view`,{expiry,signature:await owner.signMessage({message:byoOwnerMessage({deploymentId:id,action:'view',expiry})})});
 assert.equal(view.body.redacted.endpoint,'203.0.114.9:51820');assert.ok(!JSON.stringify(view.body).includes('yAnz5TF'));
 const release=async(signer,over={})=>{const request={version:1,deploymentId:id,runner,issuedAt:r.now(),nonce:randomBytes(16).toString('hex'),...over};
  return r.call('POST',`/v1/network/byo/${id}/release`,{request,signature:await signer.signMessage({message:byoReleaseMessage(request)})});};
 assert.equal((await release(owner)).status,403,'not even the owner: only the runner host');
 assert.equal((await release(runnerOp,{runner:'0x'+'22'.repeat(32)})).status,403);
 const got=await release(runnerOp);assert.equal(got.status,200);assert.equal(got.body.config,cfg);assert.equal(got.body.salt,salt);
 assert.equal((await release(runnerOp,{issuedAt:r.now()-120000})).status,422,'stale');
 r.rows[0].leaseUntil=Math.floor(r.now()/1000)-1;assert.equal((await release(runnerOp)).status,403,'lease ended');
 const del=await r.call('POST',`/v1/network/byo/${id}/delete`,{expiry,signature:await owner.signMessage({message:byoOwnerMessage({deploymentId:id,action:'delete',expiry})})});
 assert.equal(del.body.deleted,true);
 const bad=await r.call('POST','/v1/network/byo/'+id,{config:cfg.replace('AllowedIPs','PostUp = rm -rf /\nAllowedIPs'),salt,expiry,signature:'0x'});
 assert.equal(bad.status,422);assert.ok(bad.body.problems.some(p=>/PostUp/.test(p)));
});

test('two checkers: a pass from either keeps a provider; a checker that reached it and saw a failure revokes it; one that could not reach it proves nothing',async()=>{
 const r=rig(),env=await record(r);await r.call('POST','/v1/network/providers',env);
 const second=privateKeyToAccount(generatePrivateKey());
 const api2=createNetworkApi({checkers:[checker.address,second.address],file:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'netapi2-')),'n.json'),JsonStore,secretsKey:'aa'.repeat(32),clients:async()=>[],now:()=>r.now()});
 const ctx={json:(res,status,body)=>{res.status=status;res.body=body;},readBody:async req=>Buffer.from(JSON.stringify(req.body||{})),ledgerRows:async()=>r.rows};
 const call=async(method,p,body)=>{const res={};await api2.handle({method,body},res,new URL('http://x'+p),ctx);return res;};
 await call('POST','/v1/network/providers',env);
 const all=Object.fromEntries(CHECKS.map(c=>[c,true])),unreachable=Object.fromEntries(CHECKS.map(c=>[c,false])),smtpOpen={...all,blocksSmtp:false};
 await call('POST','/v1/network/qualifications',await qual(env.record,r,checker,all));
 r.advance(1000);await call('POST','/v1/network/qualifications',await qual(env.record,r,second,unreachable));
 assert.equal((await api2.eligible()).length,1,'the second checker could not reach it: the first one\'s pass stands');
 assert.equal((await call('GET','/v1/network/providers')).body.providers[0].qualifications.length,2,'both verdicts are served');
 r.advance(1000);await call('POST','/v1/network/qualifications',await qual(env.record,r,second,smtpOpen));
 assert.equal((await api2.eligible()).length,0,'a checker that reached it saw SMTP open: revoked despite the other pass');
 r.advance(1000);await call('POST','/v1/network/qualifications',await qual(env.record,r,second,all));
 assert.equal((await api2.eligible()).length,1,'fixed and rechecked: eligible again');
 r.advance(11*60000);assert.equal((await api2.eligible()).length,0,'every verdict expired: not eligible (fail closed)');
});

test('a paid (community) provider\'s on-chain attestation travels with a passing verdict and is served with it',async()=>{
 const r=rig();const hostId='0x'+'dd'.repeat(32);
 const env=await record(r,{kind:'community',hostId,pricePerGiB6:50000});
 const ctx=r;   // the relay checks the record's operator against the registry host
 const api=r.api;let res={};
 const call=async(method,p,body)=>{const out={};await api.handle({method,body},out,new URL('http://x'+p),{json:(o,status,b)=>{o.status=status;o.body=b;},readBody:async req=>Buffer.from(JSON.stringify(req.body||{})),ledgerRows:async()=>[],hostOperator:async h=>h===hostId?operator.address:null});return out;};
 assert.equal((await call('POST','/v1/network/providers',env)).status,200);
 const onchain={hostId,addressHash:'0x'+'ee'.repeat(32),issuedAt:Math.floor(r.now()/1000)-30,expires:Math.floor(r.now()/1000)+270,checks:511,signature:'0x'+'11'.repeat(65)};
 assert.equal((await call('POST','/v1/network/qualifications',{...await qual(env.record,r),onchain:{...onchain,hostId:'0x'+'ab'.repeat(32)}})).status,422,'another host');
 assert.equal((await call('POST','/v1/network/qualifications',{...await qual(env.record,r,checker,Object.fromEntries(CHECKS.map(c=>[c,c!=='tcp80']))),onchain})).status,422,'a failing verdict carries none');
 assert.notEqual((await call('POST','/v1/network/qualifications',{...await qual(env.record,r),onchain:{...onchain,expires:onchain.issuedAt+301}})).status,200,'over 5 minutes');
 r.advance(1000);
 assert.equal((await call('POST','/v1/network/qualifications',{...await qual(env.record,r),onchain})).status,200);
 const served=(await call('GET','/v1/network/providers')).body.providers[0].qualifications[0];
 assert.deepEqual(served.onchain,onchain);
});
