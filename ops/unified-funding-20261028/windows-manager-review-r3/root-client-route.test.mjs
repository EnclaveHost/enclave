import test from 'node:test';
import assert from 'node:assert/strict';
import {ProtectedIsolationClient} from './candidate/control/windows/node/protected-isolation.mjs';
import {rig} from './candidate/test/windows-permit/helpers/world.mjs';
const D='0x'+'11'.repeat(32), I='pp'+'b'.repeat(32), DIG='0x'+'22'.repeat(32);
// Scripted transport is explicitly not a real manager/VM or proof of duplicated effects.
for(const variant of ['empty inventory','hold failure'])test(`ROOT unknown stage obligation survives ${variant}`,async()=>{
 let held=0;
 const c=new ProtectedIsolationClient({control:{request:async(method,path)=>{
  if(method==='GET'&&path==='/vms')return {status:200,body:{vms:variant==='empty inventory'?[]:[{id:I,name:D}]}};
  if(method==='POST'){held++;return {status:503,body:{error:'TEST unavailable'}};}
  throw Error('unexpected test request');
 }}});
 c.unknownStages.set(D,'TEST lost stage response');await c.resolveUnknown(()=>false);
 if(variant==='hold failure')assert.equal(held,1);
 assert.equal(c.unknownStages.has(D),true,'absence at this instant or failed hold cannot discharge a possibly late stage');
});
test('ROOT matching digest on held expired view cannot reconcile as serving',async()=>{
 const c=new ProtectedIsolationClient({control:{request:async(method,path,body,opt)=>{
  if(method==='GET')return {status:200,body:{id:I,status:'stopped',protected:{state:'held',permitDigest:DIG,validUntil:1}}};
  const result=await opt.reconcile();return {status:'reconciled',body:result};
 }}});
 let result;try{result=await c.permit(I,{}, {permitDigest:DIG});}catch{}
 assert.notEqual(result?.serving,true,'held expired view is not a positive serving observation');
});
test('ROOT authenticated DELETE still withdraws through an unreadable instance journal',async t=>{
 const w=await rig(t);const staged=await w.stage();assert.equal(staged.status,202);
 const id=staged.body.instanceId;await w.staged(id);assert.equal((await w.serve(id)).status,200);
 const stream=await w.splice(id);assert.match(stream.got(),/^OK/);
 const read=w.enforcement.journal.instance,close=w.dp.closeInstance;let closed=0,result;
 w.enforcement.journal.instance=()=>{throw Error('TEST unreadable instance journal');};
 w.dp.closeInstance=function(...args){closed++;return close.apply(this,args);};
 try {result=await w.client.request('DELETE',`/vms/${id}`,undefined,{idempotent:true});}
 finally {w.enforcement.journal.instance=read;w.dp.closeInstance=close;stream.c.destroy();await w.enforcement.withdraw(id,'TEST cleanup').catch(()=>{});}
 assert.equal(result.status,500,'unconfirmed removal must not be reported successful');
 assert.ok(closed>0,'actual authenticated DELETE bypassed withdrawal because journal lookup threw first');
});
