import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import {beginRecipientAttempt,linuxRecipientIO} from '../driver/recipient-observer.mjs';
import {observeFailedRecipient,holdRecipientSerial} from '../driver/recipient-failure.mjs';
import {evalObservedRefusal} from '../driver/assert.mjs';
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'failed-recipient-')));t.after(()=>fs.rmSync(root,{recursive:true}));
 const f={time:100000,identity:{id:'0x'+'12'.repeat(32),appId:'a'.repeat(64),runtimeId:'b'.repeat(64),measurement:'c'.repeat(96),stepHash:'d'.repeat(64)},custodianWindowDigest:'e'.repeat(64),alive:false,closed:false};
 f.vm={id:'gdabcdef01',name:f.identity.id,status:'starting',createdAt:101,appId:f.identity.appId,runtimeId:f.identity.runtimeId,measurement:f.identity.measurement,backend:'snp-guest-per-app',hostData:f.identity.id.slice(2),recordSha256:'f'.repeat(64)};
 const dir=path.join(root,f.vm.id);fs.mkdirSync(dir,{mode:0o700});f.file=path.join(dir,f.vm.id+'.serial');fs.writeFileSync(f.file,'',{mode:0o600});
 f.proc={pid:900,ppid:1,startTicks:'123',uid:process.getuid(),exe:'/fixture/qemu-system-x86_64',argsHash:'1'.repeat(64),cgroup:'0::/fixture'};
 f.snap={bootId:'same',units:{'enclave-guestd.service':{invocation:'1'.repeat(32),main:{pid:100,startTicks:'20'}}},qemus:[{pid:200,startTicks:'30'}]};f.list=[];f.now=()=>f.time;
 f.io={snapshot:()=>({...structuredClone(f.snap),at:f.time}),args:pid=>pid===900?['qemu-system-x86_64','-serial','file:'+f.file,'-object','sev-snp-guest,id=sev0,host-data='+Buffer.from(f.identity.id.slice(2),'hex').toString('base64')]:['other'],process:()=>({...f.proc}),generationAlive:()=>f.alive,openFile:()=>{const s=fs.statSync(f.file);return {dev:String(s.dev),ino:String(s.ino),writable:true};}};
 f.client={instance:'2'.repeat(32),get:async route=>({status:200,body:route==='/vms'?{vms:structuredClone(f.list)}:structuredClone(f.vm)})};
 f.begin=()=>beginRecipientAttempt(f);f.start=()=>{f.time=102000;f.alive=true;f.list=[f.vm];f.snap.qemus.push(f.proc);};
 f.sleep=async()=>{f.time+=200;fs.appendFileSync(f.file,'DOM ERROR front: custody: private-canary-detail insufficient custodian quorum\n');f.vm.status='failed';f.alive=false;f.snap.qemus=f.snap.qemus.filter(p=>p.pid!==900);fs.unlinkSync(f.file);};
 f.openSerial=args=>{const r=holdRecipientSerial(args);return {...r,close(){f.closed=true;r.close();}};};
 f.observe=w=>observeFailedRecipient({...f,...w});return f;
}
test('live failed-boot watcher keeps complete serial through cleanup and returns only counts',async t=>{
 const f=fixture(t),w=await f.begin();f.start();const snapshot=f.io.snapshot;f.io.snapshot=()=>{f.time+=10;return snapshot();};const r=await f.observe(w);assert.equal(r.status,'recipient-failure-observed');assert.equal(r.log.retainedDescriptor,true);assert.equal(r.front.custodyErrors,1);assert.equal(r.front.quorumErrors,1);assert.equal(r.front.serving,0);assert.equal(f.closed,true);assert.ok(!JSON.stringify(r).includes('private-canary-detail'));assert.equal(r.outcome,undefined);
});
test('watcher may start before the old canary is stopped, but an incomplete terminal line refuses',async t=>{
 const f=fixture(t);const old={...f.vm,id:'gd11111111',status:'running',createdAt:99};f.list=[old];const w=await f.begin();
 let sleeps=0;const fail=f.sleep;f.sleep=async()=>{if(!sleeps++){f.start();}else await fail();};
 assert.equal((await f.observe(w)).status,'recipient-failure-observed');
 const g=fixture(t),x=await g.begin();g.start();const open=g.openSerial;g.openSerial=args=>{const held=open(args);return {...held,read(){const r=held.read();return {...r,text:r.text+'DOM serving incomplete'};}};};await assert.rejects(()=>g.observe(x),/terminal serial line incomplete/);assert.equal(g.closed,true);
});
test('already failed, wrong identity, served or replaced guests cannot pass the watcher',async t=>{
 for(const mutation of ['failed','running','old','name','appId','runtimeId','measurement','recordSha256','hostData','createdAt','replacement','manager','service','unrelated','pid']){
  const f=fixture(t);if(mutation==='old')f.list=[f.vm];if(mutation==='pid')f.snap.qemus.push(f.proc);const w=await f.begin();f.start();
  if(['failed','running'].includes(mutation))f.vm.status=mutation;
  if(['name','appId','runtimeId','measurement','recordSha256','hostData'].includes(mutation))f.vm[mutation]='wrong';
  if(mutation==='createdAt')f.vm.createdAt=99;
  if(mutation==='manager')f.client.instance='3'.repeat(32);
  if(mutation==='service')f.snap.units['enclave-guestd.service'].invocation='changed';
  if(mutation==='unrelated')f.snap.qemus.shift();
  if(mutation==='replacement'){const sleep=f.sleep;f.sleep=async()=>{await sleep();f.vm.id='gdabcdef02';};}
  // An old id never becomes a new attempt; bounded fake time proves this cannot wait forever.
  if(mutation==='old')f.sleep=async()=>{f.time+=1000;};
  await assert.rejects(()=>f.observe(w),mutation);
 }
});
test('watcher releases descriptors on timeouts, manager failures and changed terminal census',async t=>{
 for(const mutation of ['clock','timeout','manager-error','census','no-failed']){
  const f=fixture(t),w=await f.begin();f.start();const sleep=f.sleep;
  f.sleep=async()=>{if(mutation==='clock'){f.time--;return;}if(mutation==='timeout'){f.time+=60001;return;}await sleep();if(mutation==='manager-error')f.client.get=async()=>{throw Error('metadata unavailable');};if(mutation==='no-failed')f.vm.status='starting';if(mutation==='census'){const get=f.client.get;f.client.get=async route=>{if(route!=='/vms')f.snap.qemus.push({...f.proc,pid:901});return get(route);};}};
  await assert.rejects(()=>f.observe(w),mutation);assert.equal(f.closed,true);
 }
});
test('refusal evidence requires matching code, complete failed boot and no release/serving',async t=>{
 const f=fixture(t),w=await f.begin();f.start();const recipient=await f.observe(w),encKey='0x'+'34'.repeat(32),endpoint='https://runner.example/metal0';
 const window={status:'custodian-window-collected',windowDigest:f.custodianWindowDigest,to:f.time,identity:{id:f.identity.id,stepHash:f.identity.stepHash,measurement:f.identity.measurement,encKey,recipientEndpoint:endpoint},counts:{matchingReleases:0,matchingRefusals:1,wrongIdentity:0,syntheticReleases:0,malformedOrError:0,measurementRefusals:1,refusalCodes:{evidence_refused:1}}};
 const args={id:f.identity.id,expect:{codes:['evidence_refused'],message:'measurement'},imageMeasurement:f.identity.measurement,recipientEndpoint:endpoint,custodianEncKey:encKey,window,recipient};assert.equal(evalObservedRefusal(args).outcome,'pass');
 for(const change of [a=>a.recipient.front.serving=1,a=>a.recipient.front.releases=[{}],a=>a.recipient.front.custodyErrors=a.recipient.front.quorumErrors=0,a=>a.window.counts.matchingReleases=1,a=>a.window.counts.refusalCodes={},a=>a.window.counts.measurementRefusals=0,a=>a.recipient.custodianWindowDigest='0'.repeat(64),a=>a.window.to--,a=>a.recipient.log.retainedDescriptor=false]){const a=structuredClone(args);change(a);assert.equal(evalObservedRefusal(a).outcome,'fail');}
});
test('real child writer can unlink its log; retained descriptor captures its final bytes after exit',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'retained-recipient-'))),dir=path.join(root,'gd12345678');fs.mkdirSync(dir,{mode:0o700});const file=path.join(dir,'gd12345678.serial');
 const child=spawn(process.execPath,['-e',"const fs=require('fs');const file=process.argv[1],fd=fs.openSync(file,'w',0o600);process.stdout.write('ready');process.stdin.once('data',()=>{fs.writeSync(fd,'final-complete-line\\n');fs.unlinkSync(file);fs.closeSync(fd);process.exit(0);});",file],{stdio:['pipe','pipe','pipe']});
 const exited=new Promise(resolve=>child.once('close',resolve));let retained;
 t.after(async()=>{if(child.exitCode===null)child.kill();await exited;retained?.close();fs.rmSync(root,{recursive:true});});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});const io=linuxRecipientIO(),proc=io.process(child.pid);retained=holdRecipientSerial({file,process:proc,io});assert.throws(()=>retained.read(),/must have exited/);
 child.stdin.write('finish');await exited;const r=retained.read();assert.equal(r.text,'final-complete-line\n');assert.equal(r.retainedDescriptor,true);assert.equal(fs.existsSync(file),false);
 retained.close();assert.throws(()=>retained.read());
});
