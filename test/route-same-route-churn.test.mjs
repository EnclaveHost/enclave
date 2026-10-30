// SAME-route publication churn (2026-10-21 17:18Z, churn/post-rollout/POST-ROLLOUT-RESULT.txt finding B): hosts re-sign an
// unchanged route record every few seconds (sequence +1, new issuedAt/expiresAt, same delegation, policy and routes). The
// publication is part of routeContext, so a re-sign landing while /v1/network/routes verifies (slow lease reads) makes that
// app "changed"; after the retries it is withheld although every record involved authorizes the same routes.
// Real signed records (owner/operator/checker keys, Ed25519 route key); a bounded slow lease read stands in for the chain.
// The boundaries below must hold with any fix: a shorter newer expiry bounds what is served; withdrawal, route, delegation,
// policy, provider-verdict and lease changes take effect; replay floors only advance; equivocation is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {PublicDirectory} from '../network/public-directory.mjs';
import {signProviderRecord,signQualification,providerIdFor,CHECKS} from '../network/provider-directory.mjs';
import {defaultNetworkPolicy,signNetworkPolicy} from '../network/network-policy.mjs';
import {signDelegation,signRoute,recordHash} from '../network/route-record.mjs';
const account=n=>privateKeyToAccount('0x'+n.repeat(64));
const owner=account('1'),operator=account('2'),checker=account('3');
const id='0x'+'ab'.repeat(32),runner='0x'+'cd'.repeat(32),label=id.slice(2,10),A='8.8.4.4',B='8.8.8.8',C='9.9.9.9';
const pass=Object.fromEntries(CHECKS.map(k=>[k,true])),sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function rig(t,{leaseDelayMs=60}={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'route-same-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const policy=defaultNetworkPolicy(id),now0=Date.now();
  const lease={id,owner:owner.address,runner,chainId:8453,deployments:'0x'+'05'.repeat(20),runnerOperator:operator.address,active:true,isPublic:true,leaseUntil:now0+600000,validUntil:now0+90000};
  const calls={lease:0};
  const d=new PublicDirectory({directory:dir,checkers:[checker.address],hostOperator:async()=>operator.address,leaseOf:async()=>{calls.lease++;await sleep(leaseDelayMs);return {...lease};}});
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
  // the host's route identity: a delegation (epoch, Ed25519 key, IPNS name) and a sequence it re-signs under
  const identity=async(epoch,ipnsChar)=>{const keys=generateKeyPairSync('ed25519');
    const delegation={version:2,deploymentId:id,runner,chainId:8453,deployments:lease.deployments,policyHash:recordHash(policy),epoch,notBefore:epoch,expiresAt:epoch+3600000,
      publicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),ipns:'k51'+ipnsChar.repeat(50)};
    return {keys,delegation,authorization:await signDelegation(operator,delegation,Date.now())};};
  const host={id:await identity(now0,'a'),sequence:0,last:null};
  // re-sign: the next sequence, fresh issuedAt/expiresAt; routes and delegation unchanged unless asked
  const publish=async({routes=[A,B],expiresIn=60000,sequence=++host.sequence,circuit=i=>String(i+1).repeat(32)}={})=>{
    const now=Date.now();
    const record={version:2,deploymentId:id,delegationHash:recordHash(host.id.delegation),sequence,issuedAt:now,expiresAt:now+expiresIn,
      routes:routes.map((address,i)=>({circuit:circuit(i),address,port:443,transport:'enclave-network'}))};
    const publication={version:2,endpoint:'https://old-control.example/t/host',policy,bundle:{authorization:host.id.authorization,...signRoute(host.id.keys.privateKey,record)}};
    await d.accept('route',publication);host.last=record;return record;};
  const rotate=async()=>{host.id=await identity(Date.now(),'b');};
  await publish();
  const floor=async()=>JSON.parse(await readFile(path.join(dir,'route-floors',id+'.json'),'utf8').catch(()=>'null'));
  return {d,verdict,publish,rotate,host,lease,floor,policy,calls};
}
// read the route map while `during` keeps changing state, every `everyMs`, until the read completes
async function readDuring(d,during,everyMs=25){
  let done=false,n=0;const read=d.routes().finally(()=>{done=true;});
  const churn=(async()=>{while(!done){await during(n++);await sleep(everyMs);}})();
  const r=await read;await churn;return Object.assign(r,{during:n});
}
const served=r=>r.labels[label]?.addresses;

test('control: no change during the read -> served',async t=>{
  const {d}=await rig(t);
  assert.deepEqual(served(await d.routes()),[A,B]);
});

test('COUNTEREXAMPLE: the host re-signing the SAME route during the read must not withhold the app',async t=>{
  const {d,publish,host}=await rig(t);
  const r=await readDuring(d,()=>publish());
  assert.deepEqual(served(r),[A,B],'withheld by same-route re-signs: '+JSON.stringify(r.pending));
  assert.ok(r.deployments[id].expiresAt<=host.last.expiresAt,'served past the newest record\'s own expiry');
  assert.ok(r.during>=1&&host.sequence>=2,'the stream re-signed during the read');
});

test('PATH: one re-sign accepted while the read waits on acceptance is served from the verified record (no re-verification), bounded by the newer expiry',async t=>{
  const {d,publish,host,calls}=await rig(t);
  calls.lease=0;
  const read=d.routes();
  await sleep(20);                       // the read is inside its 60 ms lease read; the re-sign's own lease read ends after it
  const newer=await publish({expiresIn:45000});
  const r=await read;
  assert.deepEqual(served(r),[A,B]);
  assert.ok(r.deployments[id].expiresAt<=newer.expiresAt,'bounded by the newer record\'s expiry');
  assert.equal(host.sequence,2);
  assert.equal(calls.lease,2,'one verification for the read + one for the acceptance (a re-verification makes 3)');
});

test('a SHORTER expiry in the newer same-route record bounds what is served',async t=>{
  const {d,publish,host}=await rig(t);
  const r=await readDuring(d,async n=>{if(n===0)await publish({expiresIn:1500});});
  assert.equal(host.last.expiresAt-host.last.issuedAt,1500);
  if(served(r))assert.ok(r.deployments[id].expiresAt<=host.last.expiresAt,`served until ${r.deployments[id].expiresAt} > newest record ${host.last.expiresAt}`);
  await sleep(1700);
  const after=await d.routes();
  assert.equal(served(after),undefined,'served after the newest record expired');
  assert.deepEqual(after.pending.map(p=>p.id),[id]);
});

test('a WITHDRAWAL (routes: []) during the read is never answered with the old routes',async t=>{
  const {d,publish}=await rig(t);
  const r=await readDuring(d,async n=>{if(n===0)await publish({routes:[]});});
  assert.equal(served(r),undefined,'old routes served after a withdrawal: '+JSON.stringify(r.labels[label]));
  assert.equal(served(await d.routes()),undefined);
});

test('a ROUTE change during the read (B -> C) is never answered with the old routes',async t=>{
  const {d,publish}=await rig(t);
  const r=await readDuring(d,async n=>{if(n===0)await publish({routes:[A,C]});else await publish({routes:[A,C]});});
  assert.notDeepEqual(served(r),[A,B]);
  assert.deepEqual(served(await d.routes()),[A,C]);
});

test('a CIRCUIT change on the same addresses during the read is never answered with the old circuits',async t=>{
  const {d,publish}=await rig(t);
  const fresh=i=>String(i+7).repeat(32);
  const r=await readDuring(d,()=>publish({circuit:fresh}));
  if(served(r))assert.deepEqual(r.deployments[id].httpsRoutes.map(x=>x.circuit),[0,1].map(fresh),'old circuits served after a circuit change');
  assert.deepEqual((await d.routes()).deployments[id].httpsRoutes.map(x=>x.circuit),[0,1].map(fresh));
});

test('a DELEGATION rotation (same routes, new key/IPNS) during the read: only the new authorization is served',async t=>{
  const {d,publish,rotate}=await rig(t);
  const r=await readDuring(d,async n=>{if(n===0){await rotate();}await publish();});
  if(served(r))assert.equal(r.deployments[id].discovery.ipns,'k51'+'b'.repeat(50),'served under the superseded delegation');
  assert.equal((await d.routes()).deployments[id].discovery.ipns,'k51'+'b'.repeat(50));
});

test('an owner POLICY change during the read withholds the route made under the old policy',async t=>{
  const {d,publish,policy}=await rig(t);
  const newer=await signNetworkPolicy(owner,{...policy,nonce:1,issuedAt:1});
  const r=await readDuring(d,async n=>{if(n===0)await d.accept('policy',newer);else await publish().catch(()=>{});});
  assert.equal(served(r),undefined,'route under a superseded policy served');
  assert.deepEqual((await d.routes()).pending.map(p=>p.id),[id]);
});

test('a NEGATIVE verdict for a route-named provider during same-route re-signs still takes effect',async t=>{
  const {d,publish,verdict}=await rig(t);
  const r=await readDuring(d,async n=>{if(n===0)await verdict('B',{blocksPrivateDestinations:false});await publish();});
  assert.notDeepEqual(served(r),[A,B]);
  assert.deepEqual(served(await d.routes()),[A]);
});

test('LEASE change: an inactive lease withholds the app even while the host keeps re-signing',async t=>{
  const {d,publish,lease}=await rig(t);
  await readDuring(d,()=>publish());
  lease.active=false;
  const r=await readDuring(d,()=>publish().catch(()=>{}));
  assert.equal(served(r),undefined);
  assert.equal(served(await d.routes()),undefined);
});

test('REPLAY FLOOR: reads never lower it; older sequences and equivocation stay refused',async t=>{
  const {d,publish,host,floor}=await rig(t);
  await readDuring(d,()=>publish());
  const top=host.sequence;
  assert.equal((await floor()).sequence,top,'floor equals the newest accepted sequence after the reads');
  await assert.rejects(publish({sequence:top-1}),/rollback or equivocation/);
  await assert.rejects(publish({sequence:top,routes:[A,C]}),/rollback or equivocation/);
  assert.equal((await floor()).sequence,top);
  assert.deepEqual(served(await d.routes()),[A,B]);
});

test('an OLD sequence fails verification once a newer acceptance advanced the floor; the read moves to the newer record',async t=>{
  const {d,publish,host}=await rig(t);
  const old=await d.read();
  await publish();
  await assert.rejects(d.checkRoute(old.publications[id],old),/rollback or equivocation/,'boundary: old sequence after the floor advanced');
  const r=await d.currentRoute(id,old);
  assert.equal(r.sequence,host.sequence,'served from the newer record, never the rejected one');
});
