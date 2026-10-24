import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {beginRecipientAttempt,collectRecipientAttempt} from '../driver/recipient-observer.mjs';
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'recipient-observer-')));t.after(()=>fs.rmSync(root,{recursive:true}));
 const f={root,time:100000,custodianWindowDigest:'9'.repeat(64),identity:{id:'0x'+'12'.repeat(32),appId:'a'.repeat(64),runtimeId:'b'.repeat(64),measurement:'c'.repeat(96),stepHash:'d'.repeat(64)}};
 const vm='gdabcdef01',dir=path.join(root,vm);fs.mkdirSync(dir,{mode:0o700});f.file=path.join(dir,vm+'.serial');
 f.line=`DOM custody: deployment ${f.identity.id.slice(0,10)}... secrets revision 2 from a v2 threshold of 1 over 1 custodian machines, 2 name(s)\nDOM serving address spki_sha256=private-fingerprint ready_ms=100\n`;
 fs.writeFileSync(f.file,f.line,{mode:0o600});
 f.guest={id:vm,name:f.identity.id,status:'running',createdAt:101,appId:f.identity.appId,runtimeId:f.identity.runtimeId,measurement:f.identity.measurement,backend:'snp-guest-per-app',hostData:f.identity.id.slice(2),recordSha256:'e'.repeat(64),transportKeySha256:'f'.repeat(64)};
 f.q={pid:900,ppid:1,startTicks:'100',uid:process.getuid(),exe:'/fixture/qemu-system-x86_64',argsHash:'1'.repeat(64),cgroup:'0::/fixture'};
 f.snap={bootId:'same-boot',units:{'enclave-guestd.service':{invocation:'1'.repeat(32),main:{pid:100,startTicks:'20'}}},qemus:[{pid:200,startTicks:'30'}]};f.list=[];f.now=()=>f.time;
 const args=['qemu-system-x86_64','-serial','file:'+f.file,'-object','sev-snp-guest,id=sev0,host-data='+Buffer.from(f.identity.id.slice(2),'hex').toString('base64')];
 f.io={snapshot:()=>({...structuredClone(f.snap),at:f.time}),args:pid=>pid===900?args:['unrelated'],process:()=>({...f.q}),openFile:()=>{const s=fs.statSync(f.file);return {dev:String(s.dev),ino:String(s.ino),writable:true};}};
 f.client={instance:'2'.repeat(32),get:async route=>({status:200,body:route==='/vms'?{vms:structuredClone(f.list)}:structuredClone(f.guest)})};
 f.begin=()=>beginRecipientAttempt(f);f.start=()=>{f.time=102000;f.list=[f.guest];f.snap.qemus.push(f.q);};f.collect=w=>collectRecipientAttempt({...f,...w});return f;
}
test('a new authenticated instance with a live serial writer produces only bounded identity and front counts',async t=>{
 const f=fixture(t),w=await f.begin();f.start();const r=await f.collect(w);assert.equal(r.status,'recipient-observed');assert.equal(r.front.releases[0].secretRev,2);assert.equal(r.front.serving,1);assert.equal(r.outcome,undefined);assert.ok(!JSON.stringify(r).includes('private-fingerprint'));assert.equal(r.log.bytes,Buffer.byteLength(f.line));
});
test('old instances, wrong deployment/image/runtime/transport, early starts and failed instances refuse',async t=>{
 for(const field of ['old','name','appId','runtimeId','measurement','hostData','recordSha256','transportKeySha256','createdAt','status','backend']){
  const f=fixture(t);if(field==='old')f.list=[f.guest];const w=await f.begin();f.start();
  if(field==='createdAt')f.guest[field]=99;else if(field!=='old')f.guest[field]='wrong';
  await assert.rejects(()=>f.collect(w),field);
 }
});
test('changed guestd generation, missing unrelated VM, replaced recipient process and reused PID refuse',async t=>{
 for(const mutation of ['manager','service','boot','unrelated','process','pid']){
  const f=fixture(t);if(mutation==='pid')f.snap.qemus.push(f.q);const w=await f.begin();f.start();
  if(mutation==='manager')f.client.instance='3'.repeat(32);
  if(mutation==='service')f.snap.units['enclave-guestd.service'].invocation='4'.repeat(32);
  if(mutation==='boot')f.snap.bootId='reboot';
  if(mutation==='unrelated')f.snap.qemus.shift();
  if(mutation==='process')f.io.process=()=>({...f.q,startTicks:'changed'});
  await assert.rejects(()=>f.collect(w),mutation);
 }
});
test('serial cannot be substituted, made writable to others, truncated out of bounds, or read without the QEMU writer',async t=>{
 for(const mutation of ['symlink','hardlink','public-parent','writable','empty','oversize','writer','host-data']){
  const f=fixture(t),w=await f.begin();f.start();
  if(mutation==='symlink'){fs.renameSync(f.file,f.file+'.old');fs.symlinkSync(f.file+'.old',f.file);}
  if(mutation==='hardlink')fs.linkSync(f.file,f.file+'.link');
  if(mutation==='public-parent')fs.chmodSync(path.dirname(f.file),0o755);
  if(mutation==='writable')fs.chmodSync(f.file,0o666);
  if(mutation==='empty')fs.truncateSync(f.file,0);
  if(mutation==='oversize')fs.truncateSync(f.file,4*1024*1024+1);
  if(mutation==='writer')f.io.openFile=()=>({dev:'0',ino:'0',writable:false});
  if(mutation==='host-data'){const orig=f.io.args;f.io.args=pid=>orig(pid).map(a=>a.startsWith('sev-snp-guest,')?'sev-snp-guest,id=sev0,host-data=wrong':a);}
  await assert.rejects(()=>f.collect(w),mutation);
 }
});
test('changed metadata or census during collection and expired or modified baselines refuse',async t=>{
 for(const mutation of ['metadata','census','expired','digest','cursor']){
  const f=fixture(t),w=await f.begin();f.start();
  if(mutation==='expired')f.time+=300001;
  if(mutation==='digest')w.digest='a'.repeat(64);
  if(mutation==='cursor')w.cursor.oldIds.push('gd00000000');
  if(mutation==='metadata'||mutation==='census'){const get=f.client.get;f.client.get=async route=>{if(route!=='/vms'){if(mutation==='metadata')f.guest.transportKeySha256='a'.repeat(64);else f.snap.qemus.push({...f.q,pid:901});}return get(route);};}
  await assert.rejects(()=>f.collect(w),mutation);
 }
});
test('only complete front lines are classified; peer messages are not returned',async t=>{
 const f=fixture(t),w=await f.begin();f.start();fs.writeFileSync(f.file,'DOM ERROR front: custody: private-canary-payload insufficient custodian quorum\n'+f.line.replace(f.identity.id.slice(2,10),'ffffffff')+'DOM serving incomplete-private');
 const r=await f.collect(w);assert.equal(r.front.custodyErrors,1);assert.equal(r.front.quorumErrors,1);assert.equal(r.front.otherDeployment,1);assert.equal(r.front.releases.length,0);assert.equal(r.front.serving,1);assert.ok(!JSON.stringify(r).includes('private'));
});

import {saveRecipientAttempt,loadRecipientAttempt,readRecipientSerial,linuxRecipientIO} from '../driver/recipient-observer.mjs';
import {evalObservedRelease} from '../driver/assert.mjs';
import {spawn} from 'node:child_process';
test('recipient cursors are exclusive and changes, links or exposed permissions refuse',async t=>{
 const f=fixture(t),attempt=await f.begin(),name='recipient-C1.release.1-20261024T000000Z.json',args={dir:f.root,name,attempt},ref={dir:f.root,name,digest:attempt.digest};
 assert.equal(saveRecipientAttempt(args).digest,attempt.digest);assert.deepEqual(loadRecipientAttempt(ref),attempt);assert.throws(()=>saveRecipientAttempt(args),/EEXIST/);
 assert.throws(()=>loadRecipientAttempt({...ref,digest:'a'.repeat(64)}));const file=path.join(f.root,name);fs.chmodSync(file,0o644);assert.throws(()=>loadRecipientAttempt(ref));fs.chmodSync(file,0o600);
 fs.writeFileSync(file,'private-invalid-cursor');assert.throws(()=>loadRecipientAttempt(ref),e=>!e.message.includes('private-invalid-cursor'));
});
test('release evaluation binds the real recipient observation to the current custodian interval and revision',async t=>{
 const f=fixture(t),w=await f.begin();f.start();const recipient=await f.collect(w);
 const encKey='0x'+'34'.repeat(32),recipientEndpoint='https://runner.example/metal0',window={status:'custodian-window-collected',windowDigest:f.custodianWindowDigest,to:f.time,identity:{id:f.identity.id,stepHash:f.identity.stepHash,measurement:f.identity.measurement,encKey,recipientEndpoint},counts:{matchingReleases:1,matchingRefusals:0,wrongIdentity:0,syntheticReleases:0,malformedOrError:0}};
 const args={id:f.identity.id,expect:{secretRev:2},imageMeasurement:f.identity.measurement,custodianEncKey:encKey,recipientEndpoint,window,recipient,appAnswered:true};assert.equal(evalObservedRelease(args).outcome,'pass');
 for(const mutate of [a=>a.recipient.front.releases[0].secretRev=1,a=>a.recipient.front.releases[0].threshold=2,a=>a.recipient.front.custodyErrors=1,a=>a.recipient.front.serving=0,a=>a.recipient.front.otherDeployment=1,a=>a.window.counts.matchingReleases=0,a=>a.window.counts.syntheticReleases=1,a=>a.window.counts.matchingRefusals=1,a=>a.recipient.custodianWindowDigest='0'.repeat(64),a=>a.window.to--,a=>a.recipient.identity.stepHash='0'.repeat(64),a=>a.appAnswered=false]){const a=structuredClone(args);mutate(a);assert.equal(evalObservedRelease(a).outcome,'fail');}
});
test('Linux descriptor collection observes a real child writer and rejects a substituted descriptor',async t=>{
 const f=fixture(t),child=spawn(process.execPath,['-e',"const fs=require('fs');const fd=fs.openSync(process.argv[1],'a');fs.writeSync(fd,'complete-line\\n');fs.fsyncSync(fd);process.stdin.resume();process.stdout.write('ready');",f.file],{stdio:['pipe','pipe','pipe']});
 t.after(async()=>{child.kill();await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('close',resolve);});});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
 const io=linuxRecipientIO(),proc=io.process(child.pid),r=readRecipientSerial({file:f.file,process:proc,io});assert.ok(r.text.endsWith('complete-line\n'));assert.ok(r.bytes>0);
 assert.throws(()=>readRecipientSerial({file:f.file,process:proc,io:{...io,openFile:()=>({dev:'0',ino:'0',writable:true})}}),/not open/);
});
