import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {APPS,LIMIT,digest,extendWindow,validateApproval} from '../window.mjs';
const ids=Object.keys(APPS),zero='0x'+'0'.repeat(64);
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'maintenance-window-')));t.after(()=>fs.rmSync(root,{recursive:true}));
 const oldDir=path.join(root,'old'),dir=path.join(root,'private');for(const d of [oldDir,dir])fs.mkdirSync(d,{mode:0o700});fs.writeFileSync(path.join(oldDir,'STOP'),'');
 let clock=LIMIT.expiresAt-1000;const until=Object.fromEntries(ids.map(id=>[id,clock+200])),events=[];
 for(const id of ids){fs.mkdirSync(path.join(oldDir,id),{mode:0o700});for(let n=1;n<=8;n++){
  const prefix=String(n).padStart(3,'0');fs.writeFileSync(path.join(oldDir,id,prefix+'.intent.json'),'DO NOT OPEN THIS INTENT',{mode:0o600});
  fs.writeFileSync(path.join(oldDir,id,prefix+'.result.json'),JSON.stringify({id,guest:APPS[id],receiptVerified:true,operatorEthSpent:false,hash:'0x'+'ab'.repeat(32),leaseUntilAfter:until[id]}),{mode:0o600});
 }}
 const approval={operation:'one-paired-metal0-renewal-window-20261024',humanApproved:true,humanMessage:'Synthetic test fixture only, not human approval',approvedAt:clock,expiresAt:LIMIT.expiresAt,maxPerApp:1,maxChargeWei:LIMIT.maxChargeWei,apps:APPS};
 const intent=id=>({kind:'renew',operator:LIMIT.operator,chainId:8453,reserve:LIMIT.reserve,executor:LIMIT.executor,ledger:LIMIT.ledger,lease:{id,kind:2,enclaveId:zero,deadline:clock+300,maxChargeWei:'1000'}});
 const deps={lease:async id=>({active:true,runner:LIMIT.runner,runnerOperator:LIMIT.operator,leaseUntil:until[id]}),guest:async(id,vm)=>({status:'running',name:id,vm}),availability:async()=>[],policy:async()=>({status:'Ready'}),renew:async(id,onSigned)=>{events.push('sign:'+id);await onSigned(intent(id));assert.ok(fs.existsSync(path.join(dir,id+'.intent.json')));events.push('send:'+id);until[id]+=1500;return {hash:'0x'+'cd'.repeat(32),chargedWei:'500'};}};
 const f={oldDir,dir,approval,approvalHash:digest(JSON.stringify(approval)),deps,stopped:async()=>{},health:async()=>{},now:()=>clock,events,until,intent};f.tick=n=>clock+=n;f.run=()=>extendWindow(f);return f;
}
test('one renewal per app preserves original journal and replay only returns existing results',async t=>{
 const f=fixture(t),original=fs.readFileSync(path.join(f.oldDir,ids[0],'008.result.json'));const r=await f.run();assert.equal(r.complete,true);assert.equal(f.events.length,4);await f.run();assert.equal(f.events.length,4);assert.deepEqual(fs.readFileSync(path.join(f.oldDir,ids[0],'008.result.json')),original);assert.equal(fs.readFileSync(path.join(f.oldDir,ids[0],'008.intent.json'),'utf8'),'DO NOT OPEN THIS INTENT');
});
test('missing approval, expired window, changed scope, running signers and missing old results prevent signing',async t=>{
 const changes=[f=>f.approval.humanApproved=false,f=>f.tick(1001),f=>f.approval.maxPerApp=2,f=>f.approvalHash='f'.repeat(64),f=>{f.stopped=async()=>{throw Error('running');};},f=>fs.unlinkSync(path.join(f.oldDir,ids[0],'008.result.json')),f=>fs.unlinkSync(path.join(f.oldDir,'STOP')),f=>{f.health=async()=>{throw Error('unhealthy');};}];
 for(const change of changes){const f=fixture(t);change(f);await assert.rejects(f.run);assert.equal(f.events.length,0);}
});
test('wrong guest, wrong lease and unreadable chain prevent any signature; stopped control availability is not required',async t=>{
 for(const change of [f=>{f.deps.guest=async()=>({status:'running',name:ids[0],vm:'replacement'});},f=>{f.deps.lease=async()=>({active:false});},f=>{f.deps.lease=async()=>{throw Error('chain unavailable');};}]){const f=fixture(t);change(f);await assert.rejects(f.run);assert.equal(f.events.length,0);}
 const f=fixture(t);f.deps.availability=async()=>{throw Error('stopped control has no endpoint');};assert.equal((await f.run()).complete,true);
});
test('not-ready apps remain waiting; a later call may renew each only once',async t=>{
 const f=fixture(t);let ready=false;f.deps.policy=async id=>({status:id===ids[0]||ready?'Ready':'NotInRenewWindow'});assert.equal((await f.run()).complete,false);assert.equal(f.events.length,2);ready=true;assert.equal((await f.run()).complete,true);assert.equal(f.events.length,4);
});
test('uncertain send or post-send verification never re-signs',async t=>{
 for(const fail of ['send','read']){const f=fixture(t);f.deps.renew=async(id,onSigned)=>{f.events.push('sign');await onSigned(f.intent(id));if(fail==='send')throw Error('unknown');return {hash:'0x'+'ab'.repeat(32),chargedWei:'500'};};await assert.rejects(f.run,/reconciliation/);await assert.rejects(f.run,/ambiguous/);assert.equal(f.events.length,1);}
});
test('wrong signed scope, high charges, changed signer state and expired authorization refuse before send',async t=>{
 for(const change of [r=>r.kind='claim',r=>r.chainId=1,r=>r.operator='0x'+'00'.repeat(20),r=>r.lease.id=ids[1],r=>r.lease.enclaveId=LIMIT.runner,r=>r.lease.maxChargeWei=String(BigInt(LIMIT.maxChargeWei)+1n),r=>r.lease.deadline=LIMIT.expiresAt+1000]){
  const f=fixture(t);let sent=false;f.deps.renew=async(id,onSigned)=>{const r=f.intent(id);change(r);await onSigned(r);sent=true;};await assert.rejects(f.run);assert.equal(sent,false);
 }
});

test('a signer restarting immediately before journaling blocks transmission, and orphaned results refuse',async t=>{
 const f=fixture(t);let checks=0;f.stopped=async()=>{if(++checks===3)throw Error('signer restarted');};await assert.rejects(f.run);assert.equal(f.events.filter(x=>x.startsWith('send:')).length,0);
 const g=fixture(t);fs.writeFileSync(path.join(g.dir,ids[0]+'.result.json'),'{}',{mode:0o600});await assert.rejects(g.run,/incomplete/);assert.equal(g.events.length,0);
});
test('approval validator rejects an authentic digest of an unauthorized or expanded scope, before operational checks',t=>{
 const f=fixture(t);for(const patch of [{humanApproved:false},{maxPerApp:2},{maxChargeWei:String(BigInt(LIMIT.maxChargeWei)+1n)}])assert.throws(()=>validateApproval({...f.approval,...patch},f.now()),/approval/);
 assert.throws(()=>validateApproval(f.approval,LIMIT.expiresAt),/approval/);
});
