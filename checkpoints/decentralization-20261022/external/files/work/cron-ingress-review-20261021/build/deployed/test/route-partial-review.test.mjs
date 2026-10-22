// Independent review counterexamples (work/cron-ingress-review-20261021) for the partial-qualification fix
// (cron-ingress-20261021/fix/tree/network/route-record.mjs 9ba9f6d3). Gaps not covered by the writer's 4 tests:
//   1. syntax is never filtered: a malformed route NEXT TO a qualified one rejects the WHOLE record (and does not move
//      the replay floor);
//   2. an unqualified route listed FIRST is not what the relay serves as `https.address`, and the relay map/labels hold
//      only the qualified subset (relay/network-routes.mjs, the api relay's /v1/network/routes);
//   3. documented as TODO (pre-existing, not introduced by the fix): the relay does not re-check qualification after
//      publish, so a previously accepted record keeps an address that lapsed until that record expires.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {DurableState} from '../network/durable-state.mjs';
import {defaultNetworkPolicy,validateNetworkPolicy} from '../network/network-policy.mjs';
import {signDelegation,signRoute,recordHash,verifyRoute} from '../network/route-record.mjs';
import {createNetworkRoutes} from '../relay/network-routes.mjs';
const operator=privateKeyToAccount('0x'+'2'.repeat(64));
const id='0x'+'ab'.repeat(32),runner='0x'+'cd'.repeat(32),label=id.slice(2,10),A='8.8.4.4',B='8.8.8.8';
const ENDPOINT='https://host.example/t/review';

async function rig(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'route-review-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const now=Date.now(),keys=generateKeyPairSync('ed25519'),policy=validateNetworkPolicy(defaultNetworkPolicy(id));
  const dl={version:2,deploymentId:id,runner,chainId:8453,deployments:'0x'+'03'.repeat(20),policyHash:recordHash(policy),epoch:now,notBefore:now,expiresAt:now+3600000,
    publicKey:keys.publicKey.export({type:'spki',format:'der'}).toString('base64'),ipns:'k51'+'a'.repeat(50)};
  const authorization=await signDelegation(operator,dl,now);
  const lease={id,runner,chainId:8453,deployments:dl.deployments,runnerOperator:operator.address,runnerRegistered:true,leaseUntil:now+900000,validUntil:now+90000,active:true,isPublic:true};
  const route=(i,address,extra={})=>({circuit:String(i).repeat(32),address,port:443,transport:'enclave-network',...extra});
  const bundle=(routes,sequence=1)=>({authorization,...signRoute(keys.privateKey,{version:2,deploymentId:id,delegationHash:recordHash(dl),sequence,issuedAt:now,expiresAt:now+60000,routes})});
  const qualified=[{address:A,eligibleRoles:['guard','ingress','egress'],qualifiedUntil:now+600000,pricePerGiB6:0}];
  const memory=new DurableState(dir);
  return {now,policy,lease,route,bundle,qualified,memory,opts:{deploymentId:id,policy,memory,now,lease,networkProviders:qualified}};
}

test('syntax is never filtered: a malformed route next to a qualified one rejects the WHOLE record, floor untouched',async t=>{
  const r=await rig(t);
  const bad={
    'port 80':r.route(2,B,{port:80}),
    'blocked host':r.route(2,'127.0.0.1'),
    'unknown key':r.route(2,B,{extra:1}),
    'duplicate circuit':r.route(1,B),
    'wrong transport':r.route(2,B,{transport:'direct'}),
    'not an IP':r.route(2,'eu.example'),
  };
  for(const [why,route] of Object.entries(bad)){
    await assert.rejects(verifyRoute(r.bundle([r.route(1,A),route]),r.opts),/invalid public route/,why);
    await assert.rejects(verifyRoute(r.bundle([route,r.route(1,A)]),r.opts),/invalid public route/,why+' (first)');
  }
  assert.equal(await r.memory.get(id),null,'no refused record advanced the replay floor');
  // more routes than the policy allows is still a whole-record refusal, not a truncation
  const many=Array.from({length:(r.policy.enclaveNetwork?.routes||0)+1},(_,i)=>r.route(i+1,A.replace(/\d+$/,String(i+1))));
  await assert.rejects(verifyRoute(r.bundle(many),r.opts),/invalid or expired route record/);
});

test('relay path: only the qualified subset is published and served; an unqualified FIRST route is never https.address',async t=>{
  const r=await rig(t);
  let providers=[...r.qualified];
  const network={currentPolicy:()=>r.policy,eligible:async()=>providers,checkers:[],noteStatus(){}};
  const routes=createNetworkRoutes({operatorOf:async()=>operator.address,endpointId:async()=>runner,eligible:()=>true,now:()=>r.now,
    leaseOf:async()=>({...r.lease}),memory:r.memory,network});
  // B (unqualified) is listed FIRST in the signed record
  await routes.publish({version:2,endpoint:ENDPOINT,policy:r.policy,bundle:r.bundle([r.route(1,B),r.route(2,A)])});
  const m=await routes.map([{id,runner,leaseUntil:Math.floor((r.now+900000)/1000)}]);
  assert.deepEqual(m.labels[label].addresses,[A]);
  assert.equal(m.labels[label].a,A);
  assert.equal(m.deployments[id].https.address,A,'the served address is the first QUALIFIED route, never the unqualified first route');
  assert.deepEqual(m.deployments[id].httpsRoutes.map(x=>x.address),[A]);
  // nothing qualified: refused; zero healthy is not served as "one"
  providers=[];
  await assert.rejects(routes.publish({version:2,endpoint:ENDPOINT,policy:r.policy,bundle:r.bundle([r.route(1,B)],2)}),/qualified Enclave-network ingress provider/);
});

test('relay re-checks qualification at read time (PRE-EXISTING gap, not introduced by the fix)',{todo:'relay/network-routes.mjs map() serves the publish-time verified routes until the record expires (<= 300 s); the public directories re-verify on every read'},async t=>{
  const r=await rig(t);
  let providers=[...r.qualified,{address:B,eligibleRoles:['guard','ingress','egress'],qualifiedUntil:r.now+600000,pricePerGiB6:0}];
  const network={currentPolicy:()=>r.policy,eligible:async()=>providers,checkers:[],noteStatus(){}};
  const routes=createNetworkRoutes({operatorOf:async()=>operator.address,endpointId:async()=>runner,eligible:()=>true,now:()=>r.now,
    leaseOf:async()=>({...r.lease}),memory:r.memory,network});
  await routes.publish({version:2,endpoint:ENDPOINT,policy:r.policy,bundle:r.bundle([r.route(1,A),r.route(2,B)])});
  providers=[...r.qualified];   // B lapses after publication
  const m=await routes.map([{id,runner,leaseUntil:Math.floor((r.now+900000)/1000)}]);
  assert.deepEqual(m.labels[label].addresses,[A],'a lapsed provider is withheld at read');
});
