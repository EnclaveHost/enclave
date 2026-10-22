// Route-map churn (root note 16:42Z: eu-central served 2 labels while the others served 11). public-directory.mjs
// routeContext(state,id) includes ALL providers, so a provider/qualification update for a provider that NO route uses,
// landing while /v1/network/routes is verifying (slow chain reads), marks every app "changed": after 3 attempts every app
// is withheld (readRoutes) or refused (currentRoute). Live verdict cadence: 2 checkers x 4 providers, about every 4 min each.
// The tests below must keep these properties of the narrowed context:
//   - an UNRELATED provider's update must not withhold an app;
//   - a NEGATIVE verdict for a provider the app's signed route names must still reach the served map, never stale
//     authorization;
//   - withdrawal and replay floors are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {PublicDirectory} from '../network/public-directory.mjs';
import {signProviderRecord,signQualification,providerIdFor,CHECKS} from '../network/provider-directory.mjs';
import {defaultNetworkPolicy} from '../network/network-policy.mjs';
import {signDelegation,signRoute,recordHash} from '../network/route-record.mjs';
const account=n=>privateKeyToAccount('0x'+n.repeat(64));
const owner=account('1'),operator=account('2'),checker=account('3');
const id='0x'+'ab'.repeat(32),runner='0x'+'cd'.repeat(32),label=id.slice(2,10),A='8.8.4.4',B='8.8.8.8',C='9.9.9.9';
const pass=Object.fromEntries(CHECKS.map(k=>[k,true])),sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function rig(t,{leaseDelayMs=60}={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'route-churn-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const policy=defaultNetworkPolicy(id),now0=Date.now();
  const lease={id,owner:owner.address,runner,chainId:8453,deployments:'0x'+'05'.repeat(20),runnerOperator:operator.address,active:true,isPublic:true,leaseUntil:now0+600000,validUntil:now0+90000};
  // the live directory's lease read is a chain quorum read taking seconds; here a bounded delay
  const d=new PublicDirectory({directory:dir,checkers:[checker.address],hostOperator:async()=>operator.address,leaseOf:async()=>{await sleep(leaseDelayMs);return {...lease};}});
  const providers={};
  for(const [n,address,k] of [['A',A,1],['B',B,3],['C',C,5]]){
    const record={version:1,providerId:providerIdFor(operator.address,address),operator:operator.address.toLowerCase(),address,
      wgExitKey:Buffer.alloc(32,k).toString('base64'),wgGuardKey:Buffer.alloc(32,k+1).toString('base64'),ports:{exit:51820,guard:51821,control:51822},
      roles:['guard','ingress','egress'],pricePerGiB6:0,region:'test',kind:'community',hostId:runner,issuedAt:now0,expiresAt:now0+1800000};
    await d.accept('provider',await signProviderRecord(operator,record));providers[n]=record;
  }
  let at=now0-50000;
  const verdict=async(n,checks={})=>{const r=providers[n];at+=1000;
    await d.accept('qualification',await signQualification(checker,{version:1,providerId:r.providerId,operator:r.operator,address:r.address,wgExitKey:r.wgExitKey,
      wgGuardKey:r.wgGuardKey,roles:r.roles,checks:{...pass,...checks},issuedAt:at,expiresAt:at+600000}));};
  for(const n of ['A','B','C'])await verdict(n);
  const keys=generateKeyPairSync('ed25519');
  const delegation={version:2,deploymentId:id,runner,chainId:8453,deployments:lease.deployments,policyHash:recordHash(policy),epoch:now0,notBefore:now0,expiresAt:now0+3600000,
    publicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),ipns:'k51'+'a'.repeat(50)};
  const authorization=await signDelegation(operator,delegation,now0);
  const record={version:2,deploymentId:id,delegationHash:recordHash(delegation),sequence:1,issuedAt:now0,expiresAt:now0+60000,
    routes:[A,B].map((address,i)=>({circuit:String(i+1).repeat(32),address,port:443,transport:'enclave-network'}))};
  await d.accept('route',{version:2,endpoint:'https://old-control.example/t/host',policy,bundle:{authorization,...signRoute(keys.privateKey,record)}});
  return {d,verdict};
}
// read the route map while `during` keeps changing state, every `everyMs`, until the read completes
async function readDuring(d,during,everyMs=25){
  let done=false;const read=d.routes().finally(()=>{done=true;});
  const churn=(async()=>{while(!done){await during();await sleep(everyMs);}})();
  const r=await read;await churn;return r;
}

test('control: no change during the read -> the app is served',async t=>{
  const {d}=await rig(t);
  assert.deepEqual((await d.routes()).labels[label]?.addresses,[A,B]);
});

test('an UNRELATED provider\'s fresh passing verdicts during the read must not withhold the app',async t=>{
  const {d,verdict}=await rig(t);
  const r=await readDuring(d,()=>verdict('C'));
  assert.deepEqual(r.labels[label]?.addresses,[A,B],'withheld because provider C (in no route) got a new verdict: '+JSON.stringify(r.pending));
});

test('a NEGATIVE verdict for a provider the signed route names, landing during the read, still takes effect (no stale authorization)',async t=>{
  const {d,verdict}=await rig(t);
  let sent=false;
  const r=await readDuring(d,async()=>{if(!sent){sent=true;await verdict('B',{blocksPrivateDestinations:false});}});
  const after=await d.routes();
  assert.notDeepEqual(r.labels[label]?.addresses,[A,B],'the read that saw the change must not serve B as qualified');
  assert.deepEqual(after.labels[label]?.addresses,[A],'the next read withholds B (route-record 9ba9f6d3 partial service)');
});
