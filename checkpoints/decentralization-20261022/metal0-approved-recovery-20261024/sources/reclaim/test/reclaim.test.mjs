import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {APPS,LIMIT,RECORDS,digest,reclaimPair,validateApproval} from '../reclaim.mjs';
import {healthyBody} from '../guest-health.mjs';
const ids=Object.keys(APPS);
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'expired-reclaim-')));t.after(()=>fs.rmSync(root,{recursive:true}));const oldDir=path.join(root,'old'),dir=path.join(root,'private');for(const d of [oldDir,dir])fs.mkdirSync(d,{mode:0o700});fs.writeFileSync(path.join(oldDir,'STOP'),'');
 let clock=LIMIT.expiresAt-1500;const until=Object.fromEntries(ids.map(id=>[id,clock-600])),events=[];
 for(const id of ids){fs.mkdirSync(path.join(oldDir,id),{mode:0o700});for(let n=1;n<=8;n++){const prefix=String(n).padStart(3,'0');fs.writeFileSync(path.join(oldDir,id,prefix+'.intent.json'),'DO NOT OPEN THIS INTENT',{mode:0o600});fs.writeFileSync(path.join(oldDir,id,prefix+'.result.json'),JSON.stringify({id,guest:APPS[id],receiptVerified:true,operatorEthSpent:false,hash:'0x'+'ab'.repeat(32),leaseUntilAfter:until[id]}),{mode:0o600});}}
 const approval={operation:'paired-metal0-expired-claims-20261024',humanApproved:true,humanMessage:'Synthetic test fixture only, not human approval',approvedAt:clock,expiresAt:LIMIT.expiresAt,maxPerApp:1,maxChargeWei:LIMIT.maxChargeWei,acceptsExpiredLeaseRecovery:true,apps:APPS};
 const intent=id=>({kind:'claim',operator:LIMIT.operator,chainId:8453,reserve:LIMIT.reserve,executor:LIMIT.executor,ledger:LIMIT.ledger,lease:{id,kind:1,enclaveId:LIMIT.runner,deadline:clock+300,maxChargeWei:'1000'}});
 const deps={confirmedPrior:async(id,p)=>({hash:p.lastHash,receiptVerified:true,leaseUntil:clock-600}),lease:async id=>({active:true,owner:LIMIT.owner,runner:LIMIT.runner,runnerOperator:LIMIT.operator,leaseUntil:until[id],blockTs:clock}),health:async id=>({id,guest:APPS[id],healthy:true,strictTls:true,recordSha256:RECORDS[id]}),policy:async()=>({status:'Ready'}),claim:async(id,onSigned)=>{events.push('sign:'+id);await onSigned(intent(id));assert.ok(fs.existsSync(path.join(dir,id+'.intent.json')));events.push('send:'+id);until[id]=clock+1800;return {hash:'0x'+'cd'.repeat(32),chargedWei:'500',receiptVerified:true};}};
 const f={oldDir,dir,approval,approvalHash:digest(JSON.stringify(approval)),deps,stopped:async()=>{},now:()=>clock,events,until,intent};f.tick=n=>clock+=n;f.run=()=>reclaimPair(f);return f;
}
test('one app-paid claim per app, verified effect, bounded scope and original journal unchanged',async t=>{
 const f=fixture(t),before=fs.readFileSync(path.join(f.oldDir,ids[0],'008.result.json'));const r=await f.run();assert.equal(r.complete,true);assert.equal(r.maintenanceWindowPossible,true);assert.equal(r.minimumLeaseRemainingSec,1800);assert.equal(f.events.length,4);await f.run();assert.equal(f.events.length,4);assert.deepEqual(fs.readFileSync(path.join(f.oldDir,ids[0],'008.result.json')),before);assert.equal(fs.readFileSync(path.join(f.oldDir,ids[0],'008.intent.json'),'utf8'),'DO NOT OPEN THIS INTENT');
});
test('approval of a renewal or expanded/unapproved/expired claim scope cannot authorize recovery',async t=>{
 const f=fixture(t);for(const patch of [{operation:'one-paired-metal0-renewal-window-20261024'},{humanApproved:false},{maxPerApp:2},{acceptsExpiredLeaseRecovery:false},{maxChargeWei:String(BigInt(LIMIT.maxChargeWei)+1n)}])assert.throws(()=>validateApproval({...f.approval,...patch},f.now()));assert.throws(()=>validateApproval(f.approval,LIMIT.expiresAt));
});
test('missing old receipts or STOP and active signer prevent spending',async t=>{
 for(const change of [f=>fs.unlinkSync(path.join(f.oldDir,'STOP')),f=>fs.unlinkSync(path.join(f.oldDir,ids[1],'008.result.json')),f=>{f.stopped=async()=>{throw Error('running');};}]){const f=fixture(t);change(f);await assert.rejects(f.run);assert.equal(f.events.length,0);}
});
test('both original healthy VMs and unchanged expired leases must pass before either claim',async t=>{
 for(const patch of [{owner:'0x'+'00'.repeat(20)},{active:false},{runner:'0x'+'00'.repeat(32)},{runnerOperator:'0x'+'00'.repeat(20)},{leaseUntil:0},{blockTs:0}]){const f=fixture(t),read=f.deps.lease;f.deps.lease=async id=>({...await read(id),...(id===ids[1]?patch:{})});await assert.rejects(f.run);assert.equal(f.events.length,0);}
 for(const patch of [{healthy:false},{strictTls:false},{guest:'replacement'},{recordSha256:'a'.repeat(64)}]){const f=fixture(t),read=f.deps.health;f.deps.health=async id=>({...await read(id),...(id===ids[1]?patch:{})});await assert.rejects(f.run);assert.equal(f.events.length,0);}
 const f=fixture(t);f.until[ids[1]]=f.now()+100;await assert.rejects(f.run);assert.equal(f.events.length,0);
});
test('policy refusal, signed scope changes and excessive charge never reach relay',async t=>{
 const p=fixture(t);p.deps.policy=async()=>({status:'Blocked'});await assert.rejects(p.run);assert.equal(p.events.length,0);
 for(const change of [r=>r.kind='renew',r=>r.lease.kind=2,r=>r.lease.id=ids[1],r=>r.lease.enclaveId='0x'+'00'.repeat(32),r=>r.chainId=1,r=>r.reserve='0x'+'00'.repeat(20),r=>r.operator='0x'+'00'.repeat(20),r=>r.lease.maxChargeWei=String(BigInt(LIMIT.maxChargeWei)+1n),r=>r.lease.deadline=LIMIT.expiresAt+1000]){const f=fixture(t);let sent=false;f.deps.claim=async(id,cb)=>{const r=f.intent(id);change(r);await cb(r);sent=true;};await assert.rejects(f.run);assert.equal(sent,false);}
});
test('state or signer change immediately before journaling refuses transport',async t=>{
 const f=fixture(t);let checks=0;f.stopped=async()=>{if(++checks===3)throw Error('signer restarted');};await assert.rejects(f.run);assert.equal(f.events.filter(x=>x.startsWith('send:')).length,0);
 const g=fixture(t);let reads=0,read=g.deps.lease;g.deps.lease=async id=>({...await read(id),...(++reads===4?{owner:'0x'+'00'.repeat(20)}:{})});await assert.rejects(g.run);assert.equal(g.events.filter(x=>x.startsWith('send:')).length,0);
});
test('uncertain claim and failed receipt verification never cause a second signature',async t=>{
 for(const mode of ['send','effect','receipt']){const f=fixture(t);f.deps.claim=async(id,cb)=>{f.events.push('sign');await cb(f.intent(id));if(mode==='send')throw Error('unknown');if(mode==='receipt')f.until[id]=f.now()+1800;return {hash:'0x'+'ab'.repeat(32),chargedWei:'500',receiptVerified:mode!=='receipt'};};await assert.rejects(f.run,/reconciliation/);await assert.rejects(f.run,/incomplete/);assert.equal(f.events.length,1);}
});
test('completed first claim is retained if second fails; no retry or cap reset',async t=>{
 const f=fixture(t),send=f.deps.claim;f.deps.claim=async(id,cb)=>{if(id===ids[1]){await cb(f.intent(id));throw Error('unknown');}return send(id,cb);};await assert.rejects(f.run);assert.ok(fs.existsSync(path.join(f.dir,ids[0]+'.result.json')));await assert.rejects(f.run,/incomplete/);assert.equal(f.events.length,2);
});
test('confirmed short lease never reports the maintenance window ready',async t=>{
 const f=fixture(t),send=f.deps.claim;f.deps.claim=async(id,cb)=>{const r=await send(id,cb);f.until[id]=f.now()+900;return r;};const r=await f.run();assert.equal(r.complete,true);assert.equal(r.maintenanceWindowPossible,false);
});
test('application checks reject error/redirect/wrong app bodies and require the actual ping',()=>{
 const ping={kind:'json-ping'},html={kind:'html',minBytes:20,title:'Image Generator'};
 assert.equal(healthyBody(ping,200,'application/json',Buffer.from('{"ok":true,"pong":true}')),true);
 for(const [st,b] of [[302,'{}'],[200,'{}'],[500,'{"ok":true,"pong":true}'],[200,'<html>error</html>']])assert.equal(healthyBody(ping,st,'application/json',Buffer.from(b)),false);
 assert.equal(healthyBody(html,200,'text/html',Buffer.from('<title>Image Generator</title>')),true);assert.equal(healthyBody(html,200,'text/html',Buffer.from('<title>Other app</title>')),false);
});
import {requireStoppedForTTL} from '../runtime-guard.mjs';
test('actual monotonic stop timestamp must exceed all 300 seconds of TTL plus 60 seconds margin',()=>{
 const row={LoadState:'loaded',ActiveState:'inactive',MainPID:'0',InactiveEnterTimestampMonotonic:'1000000'};
 assert.doesNotThrow(()=>requireStoppedForTTL(row,361000000n));assert.throws(()=>requireStoppedForTTL(row,360999999n));
 for(const patch of [{ActiveState:'active'},{ActiveState:'failed'},{MainPID:'123'},{InactiveEnterTimestampMonotonic:'0'},{InactiveEnterTimestampMonotonic:'bad'},{InactiveEnterTimestampMonotonic:'900000000'}])assert.throws(()=>requireStoppedForTTL({...row,...patch},361000000n));
});

test('a collected exhausted keeper needs a complete inventory expiry bound; an absent control never qualifies',()=>{
 const row={LoadState:'not-found',ActiveState:'inactive',MainPID:'0',InactiveEnterTimestampMonotonic:'0'};
 const options={unit:'enclave-custody-protected-leases-20261023.service',exhaustedKeeperExpiry:1000,nowSec:1361};
 assert.doesNotThrow(()=>requireStoppedForTTL(row,1000000n,options));
 for(const patch of [{nowSec:1360},{exhaustedKeeperExpiry:undefined},{exhaustedKeeperExpiry:0},{unit:'enclave-metal.service'}])assert.throws(()=>requireStoppedForTTL(row,1000000n,{...options,...patch}));
 for(const patch of [{ActiveState:'active'},{MainPID:'22'},{LoadState:'loaded'}])assert.throws(()=>requireStoppedForTTL({...row,...patch},1000000n,options));
});

test('lagging old result is reconciled only to its verified original receipt, never a newer claim',async t=>{
 const f=fixture(t);for(const id of ids){const p=path.join(f.oldDir,id,'008.result.json'),r=JSON.parse(fs.readFileSync(p));r.leaseUntilAfter-=1516;fs.writeFileSync(p,JSON.stringify(r));}
 assert.equal((await f.run()).complete,true);
 for(const patch of [{receiptVerified:false},{hash:'0x'+'ff'.repeat(32)},{leaseUntil:0}]){const g=fixture(t),read=g.deps.confirmedPrior;g.deps.confirmedPrior=async(id,p)=>({...await read(id,p),...patch});await assert.rejects(g.run);assert.equal(g.events.length,0);}
 const g=fixture(t);g.until[ids[0]]++;await assert.rejects(g.run);assert.equal(g.events.length,0);
});
