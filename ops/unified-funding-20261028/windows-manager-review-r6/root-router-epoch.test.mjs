// permit r6 (AUTHORED, NOT RUN). ACTUAL router CompositeManager/LaunchJournal + ACTUAL manager (rig: ProtectedManager,
// PermitEnforcement, ControlServer, createProtectedServer with the TEST owner-selected router key K_r) + ACTUAL
// GuestdControl MAC client + router/attest.mjs. DIAGNOSTIC: snapshot/precheck/admission are TEST stubs (as in the root r5
// evidence) to isolate ownership from capacity; these tests are NOT full composite/capacity acceptance (no second manager,
// no real snapshot). TEST: transport hold, the TEST control double for the obligation client, in-process log exclusion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {CompositeManager,LaunchJournal} from './candidate/control/windows/vbslike/router/control.mjs';
import {makeRequest,controlServer} from './candidate/control/windows/vbslike/router/io.mjs';
import {GuestdControl} from './candidate/control/isolation/m4/guestd/control-client.mjs';
import {initializeOwnedLog,openOwnedLog,TEST_inProcessExclusion} from './candidate/control/windows/vbslike/manager/win-durable.mjs';
import {ProtectedIsolationClient,ownedObligationStore,OBLIGATION_PURPOSE} from './candidate/control/windows/node/protected-isolation.mjs';
import {rig,tmp,DEPLOYMENT} from './candidate/test/windows-permit/helpers/world.mjs';
const pins={deployment:'0x'+'d0'.repeat(32),catalogApp:'0x'+'d1'.repeat(32),runtimeId:'d2'.repeat(32),profileSha256:'d3'.repeat(32),igvmSha256:'d4'.repeat(32),controllerSha256:'d5'.repeat(32),catalogVersion:1,cid:'bafyTEST'};
const op=()=>'op'+crypto.randomBytes(16).toString('hex');
async function setup(t,{drop=false,attest=true}={}){
 const routerKey=crypto.randomBytes(32),w=await rig(t,{routerKey}),file=path.join(tmp(t),'router.log');LaunchJournal.initialize(file);const journal=new LaunchJournal(file);
 const forward=makeRequest({legacyPort:Number(new URL(w.base).port),nativePort:Number(new URL(w.base).port)});const seen=[];let held=null,hold=drop;
 const c=new CompositeManager({journal,nativePins:pins,availableMemoryMiB:async()=>1<<20,attestKey:attest?routerKey:null,request:async(...args)=>{
  if(args[2]==='/protected/vms')seen.push(args[1]);
  if(hold&&args[1]==='POST'&&args[2]==='/protected/vms'){held=args;hold=false;throw Error('TEST transport held before manager');}
  return forward(...args);
 }});
 // DIAGNOSTIC TEST capacity (labelled; see header)
 c.snapshot=async()=>({legacy:{canStart:true,permitEnforcement:{available:true}},rows:[],epoch:'TEST-fixed-epoch'});
 c.precheck=()=>{};c.admission=async()=>({appMiB:256,physicalMiB:512,gpuMilli:0,cpuUnits:100});
 const srv=controlServer(c);await new Promise(r=>srv.listen(0,'127.0.0.1',r));t.after(async()=>{srv.closeAllConnections();await new Promise(r=>srv.close(r));});
 const ctl=new GuestdControl(`http://127.0.0.1:${srv.address().port}`,w.pairing),body=w.stageBody();body.operation=op();body.spawn.gpuShare=0;
 return {w,c,journal,ctl,body,seen,held:()=>held};
}
test('ROOT another manager epoch cannot discharge pending old-epoch operation',async t=>{
 const x=await setup(t,{drop:true});await assert.rejects(x.ctl.request('POST','/protected/vms',x.body,{idempotent:false}));assert.equal(x.journal.pending(),true);
 const old=x.journal.read().record.managerEpoch; x.w.manager.epoch=crypto.randomBytes(16).toString('hex');assert.notEqual(x.w.manager.epoch,old);
 const cancelled=x.w.enforcement.cancelOperation(x.body.operation,DEPLOYMENT);assert.equal(cancelled.state,'cancelled');
 // Actual manager signs a fresh router answer under the same install key; changed epoch models a different incarnation.
 await x.c.reconcile().catch(()=>{});
 assert.equal(x.journal.pending(),true,'same install key and operation ID must not erase old-incarnation ownership');
});
