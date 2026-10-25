// The node's 30 s tick runs ONE pass at a time (windows/node/host.mjs tick()): a call while a pass is in flight joins it,
// and the guard clears when the pass settles (success or error). 2026-10-21, nucbox: with chain quorum reads taking up to
// their 30 s deadline, overlapping passes asked the same wallet policy twice, retired the same VM twice and raced the same
// renewal. Same fixture as windows-node-wallet-policy.test.mjs (fake Base RPC, injected host admission). Every check still
// runs on every pass: nothing is skipped or cached.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fakeBaseRpc,DEPLOYMENTS,CATALOG} from './helpers/fake-base-rpc.mjs';
process.env.NODE_OPERATOR_KEY='0x'+'7f'.repeat(32);
const rpc=await fakeBaseRpc();
const chain=await import('../windows/node/chain.mjs');
chain.addresses.deployments=DEPLOYMENTS;chain.addresses.appCatalog=CATALOG;chain.loadOperator();
const {Host}=await import('../windows/node/host.mjs');
const dirs=[];after(()=>{rpc.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});});
const id='0x'+'ab'.repeat(32),ref='catalog://0x'+'cd'.repeat(32)+'/1',endpoint='https://api.enclave.host/t/tick-single-flight-test';
const version={cid:'bafy',version:'1',vramMb:0,gpuGflops:0,memMb:512,cpuGflops:0,createdAt:1n,verified:true,yanked:false,ports:'',approval:1,config:'{}'};
const quiet=h=>{for(const name of ['followBook','enforceOff','ensureRegistered','ensurePriced','scanLedger','retireForeignRecovered'])h[name]=async()=>{};};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// a host whose wallet policy answers after `delayMs` (a slow chain quorum), counting every check
const box=async(answer,delayMs=0)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'host-tick-test-'));dirs.push(dir);
 const checks={n:0};
 const h=new Host({dir,endpoint,name:'test',appsEnabled:true,vcpus:8,ramGb:16,cpuPricePerSec6:0,
   hostAdmission:{hostId:chain.enclaveIdOf(endpoint),refusal:async()=>{checks.n++;await sleep(delayMs);return answer();}}});
 h.chainReady=true;h.registered={cpuPricePerSec6:'0'};await h.refreshOwners();quiet(h);return {h,checks};
};
const row=(h,leaseIn=3600)=>({id,owner:chain.operatorAddress(),appRef:ref,ports:'',configCid:'',gpuMilli:0,cpuMilli:100,appPort:8000,isPublic:true,
 active:true,createdAt:1n,rate:1n,balance6:1000000n,spent6:0n,runner:h.enclaveId,runnerOperator:chain.operatorAddress(),
 leaseUntil:BigInt(Math.floor(Date.now()/1000)+leaseIn)});
const serving=h=>{let stopped=0;h.apps.set(id,{stop:async()=>{stopped++;},alive:async()=>true});h.tracked.add(id);
 h.records.set(id,{id,status:'running',appRef:ref,isolationRequired:false});h.ensureApp=async()=>h.records.get(id);return ()=>stopped;};

test('a tick called while a pass is in flight JOINS it: one pass, one policy check, one outcome',async()=>{
 const {h,checks}=await box(()=>null,400);rpc.row.current=row(h);rpc.catalog.current=version;serving(h);
 const t1=h.tick(),t2=h.tick(),t3=h.tick();
 await Promise.all([t1,t2,t3]);
 assert.equal(checks.n,1,`${checks.n} wallet policy checks for one tracked deployment: the passes overlapped`);
});

test('overlapping ticks while the policy is UNKNOWN retire the VM once, not once per overlapping pass',async()=>{
 const {h,checks}=await box(()=>{throw Error('chain quorum unavailable');},400);rpc.row.current=row(h);rpc.catalog.current=version;rpc.chainTx.mine=true;
 const stopped=serving(h);const lines=[];const log=h.log.bind(h);h.log=m=>{lines.push(String(m));log(m);};
 const before=rpc.chainTx.sent.length;
 await Promise.all([h.tick(),h.tick()]);
 assert.equal(checks.n,1);assert.equal(stopped(),1,'the app was stopped once');
 assert.equal(lines.filter(l=>/wallet policy unavailable/.test(l)).length,1,'one hold line, not a duplicate per overlapping pass');
 assert.equal(rpc.chainTx.sent.length,before,'fail-closed unchanged: no release and no renewal on an unknown policy');
 const r=h.records.get(id);assert.equal(r.status,'held');assert.equal(r.walletHeld,true);
});

test('overlapping ticks inside the renewal lead send at most ONE renewal',async()=>{
 const {h}=await box(()=>null,400);rpc.row.current=row(h,60);rpc.catalog.current=version;rpc.chainTx.mine=true;serving(h);
 const before=rpc.chainTx.sent.length;
 await Promise.all([h.tick(),h.tick(),h.tick()]);
 assert.ok(rpc.chainTx.sent.length-before<=1,`${rpc.chainTx.sent.length-before} renewal transactions from overlapping passes`);
});

test('the guard clears after a pass: the next tick runs a NEW pass with fresh checks',async()=>{
 const {h,checks}=await box(()=>null,50);rpc.row.current=row(h);rpc.catalog.current=version;serving(h);
 await h.tick();await h.tick();
 assert.equal(checks.n,2,'each sequential tick makes its own fresh policy check');
});

test('the guard clears after a pass that FAILS: no permanent stall',async()=>{
 const {h,checks}=await box(()=>null,0);rpc.row.current=row(h);rpc.catalog.current=version;serving(h);
 let boom=true;h.followBook=async()=>{if(boom){boom=false;throw Error('book read failed');}};
 await assert.rejects(h.tick(),/book read failed/);
 await h.tick();
 assert.equal(checks.n,1,'the pass after the failed one ran (and checked the policy)');
});

test('a tick called after the pass settled is not joined to the old promise',async()=>{
 const {h}=await box(()=>null,0);rpc.row.current=row(h);rpc.catalog.current=version;serving(h);
 const a=h.tick();await a;const b=h.tick();
 assert.notEqual(a,b);await b;
});
