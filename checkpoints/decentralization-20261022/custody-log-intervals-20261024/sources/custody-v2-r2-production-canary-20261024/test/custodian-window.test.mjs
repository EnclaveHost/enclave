import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {attachCanaryLogs,inspectCanaryLogs} from '../driver/private-log.mjs';
import {beginCustodianWindow,collectCustodianWindow,MAX_WINDOW_MS} from '../driver/custodian-window.mjs';
function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'custody-window-'))),child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
 const opts={dir,hostPid:123,hostStartTicks:'456',onFailure:()=>{}};attachCanaryLogs(child,opts);t.after(()=>{child.emit('close');fs.rmSync(dir,{recursive:true});});
 const f={dir,child,time:1000,identity:{id:'0x'+'12'.repeat(32),encKey:'0x'+'34'.repeat(32),stepHash:'a'.repeat(64),measurement:'b'.repeat(96),recipientEndpoint:'https://runner.example/metal0'}};
 f.runtime={status:'runtime-verified',unit:'enclave-custody-r2-20261024T000000Z.service',invocation:'c'.repeat(32),bundleDigest:'d'.repeat(64),hostPid:123,guestPid:124,protectedServicesUnchanged:true,loopbackPortsVerified:true};
 f.now=()=>f.time;f.inspectRuntime=async()=>({...f.runtime,at:f.time,privateLogs:inspectCanaryLogs(opts)});
 f.ok=`[custodian-v2 ${f.identity.encKey.slice(2,14)}] release ${f.identity.id} to ${f.identity.recipientEndpoint}: OK (indices 1, measurement ${f.identity.measurement.slice(0,16)}...)\n`;
 f.no=`[custodian-v2 ${f.identity.encKey.slice(2,14)}] release ${f.identity.id} to ${f.identity.recipientEndpoint}: REFUSED paused: private-canary-message\n`;
 f.begin=()=>beginCustodianWindow(f);f.collect=w=>collectCustodianWindow({...f,...w});return f;
}
test('only fresh complete lines from actual private stream files are counted; no raw text or lifecycle pass escapes',async t=>{
 const f=fixture(t);f.child.stdout.write(f.ok);const w=await f.begin();f.child.stdout.write(f.ok);f.child.stderr.write(f.no);const r=await f.collect(w);
 assert.equal(r.counts.matchingReleases,1);assert.equal(r.counts.matchingRefusals,1);assert.equal(r.counts.refusalCodes.paused,1);assert.equal(r.outcome,undefined);
 assert.ok(!JSON.stringify(r).includes('private-canary-message'));assert.ok(!JSON.stringify(r).includes('indices 1'));assert.equal(r.ranges.stdout.from,Buffer.byteLength(f.ok));
});
test('a historical release and a line split across either window boundary cannot pass as a fresh release',async t=>{
 const f=fixture(t);f.child.stdout.write(f.ok+f.ok.slice(0,20));const w=await f.begin();f.child.stdout.write(f.ok.slice(20)+f.ok.slice(0,-1));
 assert.equal((await f.collect(w)).counts.matchingReleases,0);f.child.stdout.write('\n');assert.equal((await f.collect(w)).counts.matchingReleases,1);
});
test('rewritten old prefixes, truncation, replaced files and unsafe links refuse',async t=>{
 for(const mutation of ['rewrite','truncate','replace','symlink','hardlink','mode']){
  const f=fixture(t);f.child.stdout.write(f.ok);const w=await f.begin(),p=path.join(f.dir,'stdout.log');
  if(mutation==='rewrite'){const fd=fs.openSync(p,'r+');fs.writeSync(fd,Buffer.from('X'),0,1,0);fs.closeSync(fd);}
  if(mutation==='truncate')fs.truncateSync(p,0);
  if(mutation==='replace'){fs.renameSync(p,p+'.old');fs.writeFileSync(p,f.ok,{mode:0o600});fs.unlinkSync(p+'.old');}
  if(mutation==='symlink'){fs.unlinkSync(p);fs.symlinkSync(path.join(f.dir,'stderr.log'),p);}
  if(mutation==='hardlink')fs.linkSync(p,path.join(f.dir,'extra'));
  if(mutation==='mode')fs.chmodSync(p,0o644);
  await assert.rejects(()=>f.collect(w));
 }
});
test('changed cursor, deployment, key, measurement, endpoint, step, runtime or expired observation refuse',async t=>{
 for(const field of ['digest','cursor','id','encKey','measurement','recipientEndpoint','stepHash','invocation','hostPid','guestPid','bundleDigest','time']){
  const f=fixture(t),w=await f.begin();f.child.stdout.write(f.ok);
  if(field==='digest')w.digest='e'.repeat(64);else if(field==='cursor')w.cursor.beganAt++;
  else if(field==='time')f.time+=MAX_WINDOW_MS+1;
  else if(Object.hasOwn(f.identity,field))f.identity[field]=field==='recipientEndpoint'?'https://other.example/metal0':f.identity[field].replace(/.$/,'f');
  else f.runtime[field]=typeof f.runtime[field]==='number'?f.runtime[field]+1:'e'.repeat(64);
  await assert.rejects(()=>f.collect(w),field);
 }
});
test('synthetic roots, wrong machine, endpoint, measurement and malformed releases stay distinguishable',async t=>{
 const f=fixture(t),w=await f.begin();
 f.child.stdout.write(f.ok.replace('...)','..., SYNTHETIC roots)')+f.ok.replace('343434343434','565656565656')+f.ok.replace('runner.example','other.example')+f.ok.replace('bbbbbbbbbbbbbbbb','aaaaaaaaaaaaaaaa')+f.ok.replace('OK (','ERROR (')+f.no.replace('paused','sensitive_unlisted_code'));
 const r=await f.collect(w);assert.equal(r.counts.matchingReleases,0);assert.equal(r.counts.wrongIdentity,3);assert.equal(r.counts.syntheticReleases,1);assert.equal(r.counts.malformedOrError,1);assert.equal(r.counts.refusalCodes.other,1);assert.ok(!JSON.stringify(r).includes('sensitive_unlisted_code'));
});
test('changes during begin or collection never combine different generations or log snapshots',async t=>{
 for(const phase of ['begin','collect']){
  const f=fixture(t),w=phase==='collect'?await f.begin():undefined,original=f.inspectRuntime;let n=0;
  f.inspectRuntime=async()=>{if(++n===2)f.child.stdout.write(f.ok);return original();};
  await assert.rejects(()=>phase==='begin'?f.begin():f.collect(w),/changed/);
 }
});
test('closed capture and backward time cannot open or finish a live window',async t=>{
 const f=fixture(t),w=await f.begin();f.time--;await assert.rejects(()=>f.collect(w));f.time++;f.child.emit('close');await assert.rejects(f.begin,/open logs/);
});

import {saveCustodianWindow,loadCustodianWindow} from '../driver/custodian-window.mjs';
test('cursor storage is exclusive, bounded, private and digest checked; malformed content is never echoed',async t=>{
 const f=fixture(t),window=await f.begin(),dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'custody-cursor-')));t.after(()=>fs.rmSync(dir,{recursive:true}));
 const name='custodian-window-O.restart-20261024T000000Z.json',args={dir,name,window},ref={dir,name,digest:window.digest};
 assert.equal(saveCustodianWindow(args).digest,window.digest);assert.deepEqual(loadCustodianWindow(ref),window);
 assert.throws(()=>saveCustodianWindow(args),/EEXIST/);assert.throws(()=>loadCustodianWindow({...ref,digest:'f'.repeat(64)}),/malformed or changed/);
 const file=path.join(dir,name);fs.chmodSync(file,0o644);assert.throws(()=>loadCustodianWindow(ref));fs.chmodSync(file,0o600);
 fs.writeFileSync(file,'private-malformed-fixture');assert.throws(()=>loadCustodianWindow(ref),e=>!e.message.includes('private-malformed-fixture'));
 assert.throws(()=>saveCustodianWindow({...args,name:'../unsafe'}),/cursor name/);
});

import {evalCollectedRelease,filterLines} from '../driver/assert.mjs';
test('release recorder requires the live interval counts; old releases and current refusals cannot pass',async t=>{
 const f=fixture(t);f.child.stdout.write(f.ok);const w=await f.begin();
 const args={id:f.identity.id,imageMeasurement:f.identity.measurement,recipientEndpoint:f.identity.recipientEndpoint,custodianEncKey:f.identity.encKey,expect:{secretRev:2},obs:{appAnswered:true,lines:filterLines({id:f.identity.id,frontLog:`DOM custody: deployment ${f.identity.id.slice(0,10)}... secrets revision 2 from a v2 threshold of 1 over 1 custodian machines, 2 name(s)`,custodianLog:''})}};
 assert.equal(evalCollectedRelease({...args,window:await f.collect(w)}).outcome,'fail');
 f.child.stdout.write(f.ok);const window=await f.collect(w);assert.equal(evalCollectedRelease({...args,window}).outcome,'pass');
 for(const changed of [{...args,expect:{secretRev:1}},{...args,custodianEncKey:'0x'+'56'.repeat(32)},{...args,obs:{...args.obs,appAnswered:false}},{...args,obs:{...args.obs,lines:{front:[]}}}])assert.equal(evalCollectedRelease({...changed,window}).outcome,'fail');
 f.child.stderr.write(f.no);assert.equal(evalCollectedRelease({...args,window:await f.collect(w)}).outcome,'fail');
});
test('refusal recorder requires the current expected reason plus a front failure and non-serving app',async t=>{
 const f=fixture(t),w=await f.begin(),args={id:f.identity.id,imageMeasurement:f.identity.measurement,recipientEndpoint:f.identity.recipientEndpoint,custodianEncKey:f.identity.encKey,refusal:true,expect:{codes:['evidence_refused'],message:'measurement'},obs:{appAnswered:false,lines:{front:['DOM ERROR front: custody: insufficient custodian quorum']}}};
 f.child.stderr.write(f.no);assert.equal(evalCollectedRelease({...args,window:await f.collect(w)}).outcome,'fail');
 f.child.stderr.write(f.no.replace('paused: private-canary-message','evidence_refused: measurement differs'));const window=await f.collect(w);assert.equal(evalCollectedRelease({...args,window}).outcome,'pass');
 assert.equal(evalCollectedRelease({...args,obs:{...args.obs,appAnswered:true},window}).outcome,'fail');
 assert.equal(evalCollectedRelease({...args,obs:{...args.obs,lines:{front:[]}},window}).outcome,'fail');
 f.child.stdout.write(f.ok);assert.equal(evalCollectedRelease({...args,window:await f.collect(w)}).outcome,'fail');
});
