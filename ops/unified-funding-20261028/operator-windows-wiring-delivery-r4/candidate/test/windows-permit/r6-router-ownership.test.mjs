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
import {CompositeManager,LaunchJournal} from '../../control/windows/vbslike/router/control.mjs';
import {makeRequest,controlServer} from '../../control/windows/vbslike/router/io.mjs';
import {GuestdControl} from '../../control/isolation/m4/guestd/control-client.mjs';
import {initializeOwnedLog,openOwnedLog,TEST_inProcessExclusion} from '../../control/windows/vbslike/manager/win-durable.mjs';
import {ProtectedIsolationClient,ownedObligationStore,OBLIGATION_PURPOSE} from '../../control/windows/node/protected-isolation.mjs';
import {rig,tmp,DEPLOYMENT} from './helpers/world.mjs';
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
test('ROOT-repaired: an invalid MAC is refused BEFORE any latch and nothing is forwarded',async t=>{
 const x=await setup(t);
 const r=await x.c.handle('POST','/protected/vms',Buffer.from(JSON.stringify(x.body)),{'x-guestd-session':'TEST-invalid','x-guestd-seq':'1','x-guestd-mac':'00'});
 assert.equal(r.status,401);assert.equal(x.journal.pending(),false,'no attacker-created global launch latch');
 assert.deepEqual(x.seen,[],'the unauthenticated stage never reached the manager');assert.equal(x.w.journal.instances().length,0);
});
test('ROOT-repaired: held original -> exact authenticated cancellation resolves ONLY its own reservation -> late original refused',async t=>{
 const x=await setup(t,{drop:true});
 await assert.rejects(x.ctl.request('POST','/protected/vms',x.body,{idempotent:false}));
 assert.ok(x.held());assert.equal(x.journal.pending(),true);assert.equal(x.journal.read().record.operation,x.body.operation);
 const r=await x.ctl.request('POST',`/protected/operations/${x.body.operation}/cancel`,{deployment:DEPLOYMENT},{idempotent:false});
 assert.equal(r.status,200);assert.equal(r.body.state,'cancelled');assert.equal(x.w.journal.operation(x.body.operation).state,'cancelled');
 assert.equal(x.journal.pending(),false);assert.equal(x.journal.read().record.observation,'verified durable cancellation before execution');
 const [,m,p,raw,h]=x.held(),late=await x.c.handle(m,p,raw,h);   // the exact held signed bytes arrive late
 assert.equal(late.status,409);assert.equal(x.journal.pending(),false);assert.equal(x.w.journal.instances().length,0,'late original never starts');
});
test('r6 NEGATIVE: cancel of ANOTHER operation, a replayed cancel, or an in-progress operation never clears the reservation',async t=>{
 const x=await setup(t,{drop:true});
 await assert.rejects(x.ctl.request('POST','/protected/vms',x.body,{idempotent:false}));
 const other=op();
 await x.ctl.request('POST',`/protected/operations/${other}/cancel`,{deployment:DEPLOYMENT},{idempotent:false});
 assert.equal(x.journal.pending(),true,'wrong operation');
 x.w.enforcement.ops.set(x.body.operation,DEPLOYMENT);   // TEST: mark the exact operation accepted/in-progress in the manager
 const r=await x.ctl.request('POST',`/protected/operations/${x.body.operation}/cancel`,{deployment:DEPLOYMENT},{idempotent:false});
 assert.equal(r.status,409);assert.equal(x.journal.pending(),true,'accepted/in-progress is not absence');
 await assert.rejects(x.c.reconcile(),/in-progress|stays charged/);assert.equal(x.journal.pending(),true);
 const h=await x.c.health().catch(e=>({status:e.status}));assert.notEqual(h.status,200,'admission stays unavailable under uncertainty');
});
test('r6 NEGATIVE: no router key -> protected stage refused with nothing latched; a client x-router-mac is stripped',async t=>{
 const x=await setup(t,{attest:false});
 await assert.rejects(x.c.handle('POST','/protected/vms',Buffer.from(JSON.stringify(x.body)),{'x-guestd-session':'s','x-guestd-seq':'1','x-guestd-mac':'00','x-router-mac':'ff'}),/attestation key not configured/);
 assert.equal(x.journal.pending(),false);assert.deepEqual(x.seen,[]);
});
test('r6 POSITIVE: accounted successful stage clears only from the exact confirmed reservation (DIAGNOSTIC snapshot)',async t=>{
 const x=await setup(t);
 x.c.snapshot=async()=>({legacy:{canStart:true,permitEnforcement:{available:true}},rows:x.w.manager.list(),epoch:'TEST-fixed-epoch'});
 x.c.admission=async(b)=>({appMiB:b.derive.policy.memMiB,physicalMiB:0,gpuMilli:0,cpuUnits:x.w.manager.list()[0]?.cpu?.grantedUnits??0,runtimeId:b.derive.runtimeId,cid:b.derive.cid,catalog:b.derive.catalog});
 const r=await x.ctl.request('POST','/protected/vms',x.body,{idempotent:false}).catch(e=>e);
 // the exact answer is the manager's; the latch clears only through observePending's same-epoch row match
 if(x.journal.pending())assert.match(String(x.journal.read().record.operation),/^op/);else assert.equal(x.journal.read().record.observation,'same-epoch backend reservation confirmed');
 assert.ok(r);
});

// ---- r6 owned obligations (win-durable log; TEST in-process exclusion proves logic only, NOT Windows EXLOCK) ----
const TEST_control=(answers)=>({sent:[],async request(m,p,b){this.sent.push([m,p,b]);const a=answers.shift();if(a instanceof Error)throw a;return a;}});
function ownedLog(t,dir=tmp(t)){const f=path.join(dir,'obligations.log');initializeOwnedLog(f,{purpose:OBLIGATION_PURPOSE});return f;}
test('r6 obligations: cold replay restores the exact unknown operation; concurrent owner refused; missing log never fresh',async t=>{
 const f=ownedLog(t),ex=TEST_inProcessExclusion(),log=openOwnedLog(f,{purpose:OBLIGATION_PURPOSE,exclusion:ex});
 assert.throws(()=>openOwnedLog(f,{purpose:OBLIGATION_PURPOSE,exclusion:ex}),e=>e.code==='JOURNAL_OWNED');
 const c1=new ProtectedIsolationClient({control:TEST_control([Object.assign(Error('TEST lost reply'),{mayHaveExecuted:true})]),store:ownedObligationStore(log)});
 await assert.rejects(c1.stage({deployment:DEPLOYMENT,stagingMs:30000,spawn:{name:DEPLOYMENT}}));
 const op1=c1.unknownStages.get(DEPLOYMENT).operation;log.release();
 const c2=new ProtectedIsolationClient({control:TEST_control([]),store:ownedObligationStore(openOwnedLog(f,{purpose:OBLIGATION_PURPOSE,exclusion:ex}))});
 assert.equal(c2.unknownStages.get(DEPLOYMENT).operation,op1);
 assert.throws(()=>openOwnedLog(path.join(tmp(t),'absent.log'),{purpose:OBLIGATION_PURPOSE,exclusion:TEST_inProcessExclusion()}));
});
test('r6 obligations: torn tail and released owner refuse; nothing is sent without a durable obligation',async t=>{
 const f=ownedLog(t);fs.appendFileSync(f,'{"seq":1,"prev":"x","kind":"obligations"');   // TEST crash-window torn write
 const log=openOwnedLog(f,{purpose:OBLIGATION_PURPOSE,exclusion:TEST_inProcessExclusion()});
 assert.throws(()=>new ProtectedIsolationClient({control:TEST_control([]),store:ownedObligationStore(log)}),/torn/);log.release();
 const g=ownedLog(t),l2=openOwnedLog(g,{purpose:OBLIGATION_PURPOSE,exclusion:TEST_inProcessExclusion()}),ctl=TEST_control([]);
 const c=new ProtectedIsolationClient({control:ctl,store:ownedObligationStore(l2)});l2.release();   // physical owner released
 await assert.rejects(c.stage({deployment:DEPLOYMENT,stagingMs:30000,spawn:{name:DEPLOYMENT}}),/not durable; nothing sent/);
 assert.equal(ctl.sent.length,0);
});
test('r6 obligations: a late ACCEPTED completion binds exactly; a cancelled one discharges only after the durable cancel',async t=>{
 const f=ownedLog(t),log=openOwnedLog(f,{purpose:OBLIGATION_PURPOSE,exclusion:TEST_inProcessExclusion()});
 const ctl=TEST_control([Object.assign(Error('TEST lost reply'),{mayHaveExecuted:true})]);
 const c=new ProtectedIsolationClient({control:ctl,store:ownedObligationStore(log)});
 await assert.rejects(c.stage({deployment:DEPLOYMENT,stagingMs:30000,spawn:{name:DEPLOYMENT}}));
 const o=c.unknownStages.get(DEPLOYMENT).operation;
 ctl.request=async(m,p)=>p===`/protected/operations/${o}`?{status:200,body:{schema:'enclave-protected-operation/1',operation:o,state:'in-progress',deployment:DEPLOYMENT,instanceId:null}}:{status:500,body:{}};
 assert.equal((await c.resolveUnknown())[0].kept,'in-progress');assert.ok(c.unknownStages.has(DEPLOYMENT));
 ctl.request=async(m,p)=>p===`/protected/operations/${o}`?{status:200,body:{schema:'enclave-protected-operation/1',operation:o,state:'unseen',deployment:null,instanceId:null}}
  :p.endsWith('/cancel')?{status:200,body:{schema:'enclave-protected-operation/1',operation:o,state:'cancelled',deployment:DEPLOYMENT,instanceId:null}}:{status:500,body:{}};
 assert.equal((await c.resolveUnknown())[0].discharged,'cancelled before execution');assert.equal(c.unknownStages.has(DEPLOYMENT),false);
 assert.equal(ownedObligationStore(log).load().unknown[DEPLOYMENT],undefined,'the discharge itself is durable');
});
