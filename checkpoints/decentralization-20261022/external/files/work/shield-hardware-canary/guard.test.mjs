import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadStage, requireApproval, assertScope, withJournal, readJournal, planSpawn, bindVm, ownRecord, atomicJson, PORT, PREFIX, MARKER, stagedControl, scratchCallbackKey } from './guard.mjs';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-canary-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stage = {format:'enclave-shield-hardware-canary-stage/2',canaryDir:dir,port:PORT,prefix:PREFIX,marker:MARKER,commit:'a'.repeat(40),directIgvmSha256:'b'.repeat(64)};
  atomicJson(path.join(dir,'stage.json'),stage);
  return {dir, stage};
}
const body = {name:'0x'+'1'.repeat(64),bootstrap:'e30='};
const vmFor = r => ({id:r.id,name:r.deployment,vmName:PREFIX+'test',instanceId:'test',launcherVmId:'12345678-1234-1234-1234-123456789abc'});
test('stage requires complete identity, dedicated port and exact directory', t => {
  const {dir,stage}=fixture(t);assert.deepEqual(loadStage(dir),stage);
  for(const override of [{port:8091},{marker:'enclave-vbslike-app-domain'},{commit:null},{canaryDir:dir+'/other'},{format:undefined}]) {
    atomicJson(path.join(dir,'stage.json'),{...stage,...override});assert.throws(()=>loadStage(dir));
  }
});
test('approval requires apply and an exact line; similar step names do not grant authority',t=>{
 const {dir}=fixture(t);fs.writeFileSync(path.join(dir,'approved-steps.txt'),'unapproved: delete\napproved: delete-extra\n');
 assert.throws(()=>requireApproval(dir,'delete',true));assert.throws(()=>requireApproval(dir,'delete',false));
 fs.writeFileSync(path.join(dir,'approved-steps.txt'),'approved: delete\n');assert.throws(()=>requireApproval(dir,'delete',false));requireApproval(dir,'delete',true);
});
test('empty inventory from wrong listener, unknown inventory and foreign VM all refuse',t=>{
 const {stage}=fixture(t),health={vmScope:{prefix:PREFIX,marker:MARKER},images:{shieldDirect:{igvmSha256:stage.directIgvmSha256}},supports:{directBootstrap:true},inventory:{state:'ready'}};
 assertScope(health,{vms:[]},stage);
 assert.throws(()=>assertScope({...health,vmScope:{prefix:'enclave-app-',marker:'enclave-vbslike-app-domain'}},{vms:[]},stage));
 assert.throws(()=>assertScope({...health,inventory:{state:'unknown'}},{vms:[]},stage));
 assert.throws(()=>assertScope(health,{},stage));assert.throws(()=>assertScope(health,{vms:[{id:'x',vmName:'enclave-app-prod'}]},stage));
});
test('lost spawn response retains durable intent and prevents a duplicate deployment',async t=>{
 const {dir,stage}=fixture(t);let id;
 await assert.rejects(withJournal(dir,stage,async(j,save)=>{const r=planSpawn(j,body);id=r.id;save();throw new Error('lost response');}),/lost response/);
 const j=readJournal(dir,stage);assert.equal(j.records[0].id,id);assert.equal(j.records[0].state,'planned');
 await assert.rejects(withJournal(dir,stage,async(j)=>planSpawn(j,body)),/unresolved/);
 await withJournal(dir,stage,async(j,save)=>{const r=ownRecord(j,id);bindVm(r,vmFor(r));save();});
 assert.equal(readJournal(dir,stage).records[0].state,'created');
});
test('unknown ids, foreign VM names, wrong deployment and changed Hyper-V identity cannot be deleted',t=>{
 const {dir,stage}=fixture(t),j=readJournal(dir,stage),r=planSpawn(j,body),vm=vmFor(r);
 assert.throws(()=>ownRecord(j,'hv'+'f'.repeat(32)));assert.throws(()=>ownRecord(j,'../production'));
 for(const change of [{name:'0x'+'2'.repeat(64)},{vmName:'enclave-app-prod'},{launcherVmId:'invalid'},{id:'hv'+'e'.repeat(32)}]) assert.throws(()=>bindVm(r,{...vm,...change}));
 bindVm(r,vm);assert.throws(()=>bindVm(r,{...vm,launcherVmId:'aaaaaaaa-1234-1234-1234-123456789abc'}));
 bindVm(r,{...vm,launcherVmId:undefined}); // manager restart: durable VM identity survives, native check still required
 r.state='deleted';assert.throws(()=>ownRecord(j,r.id));
});
test('journal lock cannot be stolen; crash-stale lock refuses until explicit review',async t=>{
 const {dir,stage}=fixture(t);await withJournal(dir,stage,async()=>{await assert.rejects(withJournal(dir,stage,async()=>{}),/EEXIST/);});
 assert.equal(fs.existsSync(path.join(dir,'created-vms.lock')),false);
 fs.writeFileSync(path.join(dir,'created-vms.lock'),'{"pid":999999}');await assert.rejects(withJournal(dir,stage,async()=>{}),/EEXIST/);
});
test('journal from another stage is refused before mutation',t=>{
 const {dir,stage}=fixture(t);atomicJson(path.join(dir,'created-vms.json'),{...readJournal(dir,stage),commit:'c'.repeat(40)});
 assert.throws(()=>readJournal(dir,stage),/another stage/);
});
test('driver cannot import another bundle or read a production callback key',t=>{
 const {dir,stage}=fixture(t);stage.bundle=path.join(dir,'bundle');stage.custodyTransport=true;
 const control=path.join(stage.bundle,'control'),key=path.join(dir,'shield','custody-callback.key');
 fs.mkdirSync(control,{recursive:true});fs.mkdirSync(path.dirname(key));fs.writeFileSync(key,'fixture');
 assert.equal(stagedControl(stage),control);assert.equal(stagedControl(stage,control),control);
 assert.throws(()=>stagedControl(stage,path.join(dir,'production')));
 assert.equal(scratchCallbackKey(stage,key),key);
 assert.throws(()=>scratchCallbackKey(stage,path.join(dir,'production-key')));
 assert.throws(()=>scratchCallbackKey({...stage,custodyTransport:false},key));
 const other=path.join(dir,'other');fs.mkdirSync(other);
 fs.rmdirSync(control);fs.symlinkSync(other,control,'dir');assert.throws(()=>stagedControl(stage,control));
 fs.unlinkSync(key);const otherKey=path.join(dir,'other-key');fs.writeFileSync(otherKey,'fixture');
 fs.symlinkSync(otherKey,key);assert.throws(()=>scratchCallbackKey(stage,key));
});
