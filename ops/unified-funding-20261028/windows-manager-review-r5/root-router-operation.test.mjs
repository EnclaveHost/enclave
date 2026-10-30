// Actual router/journal and downstream MAC manager. TEST capacity admission snapshot only; not a full composite hardware proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {CompositeManager,LaunchJournal} from './candidate/control/windows/vbslike/router/control.mjs';
import {makeRequest,controlServer} from './candidate/control/windows/vbslike/router/io.mjs';
import {GuestdControl} from './candidate/control/isolation/m4/guestd/control-client.mjs';
import {rig,tmp,DEPLOYMENT} from './candidate/test/windows-permit/helpers/world.mjs';
const pins={deployment:'0x'+'d0'.repeat(32),catalogApp:'0x'+'d1'.repeat(32),runtimeId:'d2'.repeat(32),profileSha256:'d3'.repeat(32),igvmSha256:'d4'.repeat(32),controllerSha256:'d5'.repeat(32),catalogVersion:1,cid:'bafyTEST'};
async function setup(t,{drop=false}={}){
 const w=await rig(t),file=path.join(tmp(t),'router.log');LaunchJournal.initialize(file);const journal=new LaunchJournal(file);
 const forward=makeRequest({legacyPort:Number(new URL(w.base).port),nativePort:Number(new URL(w.base).port)});let held=null,status=null;
 const c=new CompositeManager({journal,nativePins:pins,availableMemoryMiB:async()=>1<<20,request:async(...args)=>{
  if(drop&&args[1]==='POST'&&args[2]==='/protected/vms'){held=args;throw Error('TEST transport held before manager');}
  const r=await forward(...args);if(args[2]==='/protected/vms')status=r.status;return r;
 }});
 // Isolate ownership/authentication from already separate hardware-capacity qualification.
 c.snapshot=async()=>({legacy:{canStart:true,permitEnforcement:{available:true}},rows:[],epoch:'TEST-fixed-epoch'});
 c.precheck=()=>{};c.admission=async()=>({appMiB:256,physicalMiB:512,gpuMilli:0,cpuUnits:100});
 const srv=controlServer(c);await new Promise(r=>srv.listen(0,'127.0.0.1',r));t.after(async()=>{srv.closeAllConnections();await new Promise(r=>srv.close(r));});
 const ctl=new GuestdControl(`http://127.0.0.1:${srv.address().port}`,w.pairing),body=w.stageBody();body.operation='op'+'ec'.repeat(16);body.spawn.gpuShare=0;
 return {w,c,journal,ctl,body,held:()=>held,status:()=>status};
}
test('ROOT rejected MAC cannot permanently poison router launch ownership',async t=>{
 const x=await setup(t);await assert.rejects(x.c.handle('POST','/protected/vms',Buffer.from(JSON.stringify(x.body)),{'x-guestd-session':'TEST-invalid'}));
 assert.equal(x.status(),401);assert.equal(x.w.journal.instances().length,0);
 assert.equal(x.journal.pending(),false,'downstream authentication rejection must not leave an attacker-created global launch latch');
});
test('ROOT exact durable cancellation of held stage resolves router pending ownership',async t=>{
 const x=await setup(t,{drop:true});await assert.rejects(x.ctl.request('POST','/protected/vms',x.body,{idempotent:false}));
 assert.ok(x.held());assert.equal(x.journal.pending(),true);
 const r=await x.ctl.request('POST',`/protected/operations/${x.body.operation}/cancel`,{deployment:DEPLOYMENT},{idempotent:false});
 assert.equal(r.status,200);assert.equal(r.body.state,'cancelled');assert.equal(x.w.journal.operation(x.body.operation).state,'cancelled');
 assert.equal(x.journal.pending(),false,'authenticated terminal cancellation must reconcile exact pending operation without requiring a live VM');
});
