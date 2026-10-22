// 2026-10-21 (minipc): a node-agent restart starts with an empty host-policy cache and asks for every deployment at once;
// one transient quorum miss made #walletHold RETIRE a domain that was already running (new key, new certificate).
// #coldWalletKeep: before this process has any DEFINITE answer for a deployment, an UNKNOWN answer keeps a domain the
// manager reports RUNNING (nothing served, renewed, claimed or released here) for at most 90 s; everything else is as
// before. Driven through the real Host, chain.mjs (fake Base RPC) and IsolationManagerClient against a loopback fake
// manager that counts removals.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fakeBaseRpc,DEPLOYMENTS,CATALOG} from './helpers/fake-base-rpc.mjs';
process.env.NODE_OPERATOR_KEY='0x'+'7f'.repeat(32);
const rpc=await fakeBaseRpc();
const chain=await import('../windows/node/chain.mjs');
chain.addresses.deployments=DEPLOYMENTS;chain.addresses.appCatalog=CATALOG;chain.loadOperator();
const {Host}=await import('../windows/node/host.mjs');
const dirs=[];
const id='0x'+'ab'.repeat(32),ref='catalog://0x'+'cd'.repeat(32)+'/1',endpoint='https://api.enclave.host/t/wallet-cold-test';
const version={cid:'bafy',version:'1',vramMb:0,gpuGflops:0,memMb:512,cpuGflops:0,createdAt:1n,verified:true,yanked:false,ports:'',approval:1,config:'{}'};

// the fake manager: one domain named after the deployment, until it is removed
const mgr={vms:[],removed:[],down:false};
const srv=http.createServer((q,s)=>{const send=(c,b)=>{s.writeHead(c,{'content-type':'application/json'});s.end(JSON.stringify(b));};
 if(mgr.down){s.destroy();return;}
 const m=q.url.match(/^\/vms(?:\/([^/?]+))?$/);if(!m)return send(404,{error:'no'});
 const vid=m[1]&&decodeURIComponent(m[1]);
 if(q.method==='GET'&&!vid)return send(200,{vms:mgr.vms});
 if(q.method==='GET'){const v=mgr.vms.find(x=>x.id===vid);return v?send(200,v):send(404,{error:'gone'});}
 if(q.method==='DELETE'){const i=mgr.vms.findIndex(x=>x.id===vid);if(i<0)return send(404,{error:'gone'});mgr.removed.push(vid);mgr.vms.splice(i,1);return send(200,{removed:vid});}
 send(405,{});});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const MANAGER=`http://127.0.0.1:${srv.address().port}`;
after(()=>{rpc.close();srv.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});});

const realNow=Date.now;let skew=0;Date.now=()=>realNow()+skew;after(()=>{Date.now=realNow;});
const row=h=>({id,owner:chain.operatorAddress(),appRef:ref,ports:'',configCid:'',gpuMilli:0,cpuMilli:100,appPort:8000,isPublic:true,
 active:true,createdAt:1n,rate:1n,balance6:1000000n,spent6:0n,runner:h.enclaveId,runnerOperator:chain.operatorAddress(),
 leaseUntil:BigInt(Math.floor(Date.now()/1000)+600)});   // inside the 15-min renewal lead (a served lease would renew), outliving the 90 s skews
const quiet=h=>{for(const name of ['followBook','enforceOff','ensureRegistered','ensurePriced','scanLedger','retireForeignRecovered'])h[name]=async()=>{};};
// a FRESH agent process (empty policy cache), a manager holding a running domain for the deployment
async function box(answer,{manager=MANAGER,running=true}={}){
 skew=0;mgr.down=false;mgr.removed=[];mgr.vms=running?[{id:'hv'+'1'.repeat(32),name:id,status:'running',appId:'a'.repeat(64)}]:[];
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'host-wallet-cold-'));dirs.push(dir);
 const h=new Host({dir,endpoint,name:'test',appsEnabled:true,vcpus:8,ramGb:16,cpuPricePerSec6:0,isolationManager:manager,
   hostAdmission:{hostId:chain.enclaveIdOf(endpoint),refusal:answer}});
 h.chainReady=true;h.registered={cpuPricePerSec6:'0'};await h.refreshOwners();quiet(h);
 rpc.row.current=row(h);rpc.catalog.current=version;rpc.chainTx.mine=true;
 h.tracked.add(id);h.records.set(id,{id});           // tracked from the previous process; nothing adopted yet in this one
 let launched=0;h.ensureApp=async()=>{launched++;return h.records.get(id);};
 return {h,launched:()=>launched};
}
const UNKNOWN=async()=>{throw Error('chain quorum unavailable');};

test('cold start + a transient quorum miss: the RUNNING domain is kept (not retired), nothing sent on chain; served once the policy answers',async()=>{
 let mode='unknown';
 const {h,launched}=await box(async()=>{if(mode==='unknown')throw Error('chain quorum unavailable');return null;});
 const before=rpc.chainTx.sent.length;
 await h.tick();
 assert.deepEqual(mgr.removed,[],'the running domain is NOT retired on a cold-cache unknown');
 assert.equal(rpc.chainTx.sent.length,before,'no release and no renewal on an unknown policy');
 const r=h.records.get(id);assert.equal(r.status,'held');assert.equal(r.walletHeld,true);
 assert.match(r.reason,/before this agent's first definite answer: the running domain hv1+ is KEPT, not served, renewed or released/);
 assert.equal(launched(),0,'nothing is served here while unknown');assert.equal(h.tracked.has(id),true);
 skew=30_000;await h.tick();                                                   // still unknown 30 s later: still kept
 assert.deepEqual(mgr.removed,[]);assert.equal(rpc.chainTx.sent.length,before);
 mode='allowed';skew=60_000;await h.tick();
 assert.equal(h.records.get(id).walletHeld,null);assert.equal(launched(),1,'served again (the existing domain is adopted by ensureApp)');
 assert.deepEqual(mgr.removed,[],'the domain, its key and certificate survive the transient');
});

test('cold start + an unknown that persists past 90 s: the ordinary hold retires the domain (fail-closed is kept)',async()=>{
 const {h,launched}=await box(UNKNOWN);const before=rpc.chainTx.sent.length;
 await h.tick();assert.deepEqual(mgr.removed,[]);
 skew=89_000;await h.tick();assert.deepEqual(mgr.removed,[],'still inside the 90 s window');
 skew=90_000;await h.tick();
 assert.equal(mgr.removed.length,1,'retired once the cold window is over');
 const r=h.records.get(id);assert.equal(r.status,'held');assert.match(r.reason,/^host wallet policy unavailable \(chain quorum unavailable\): not served, renewed or released/);
 assert.equal(rpc.chainTx.sent.length,before,'still nothing released or renewed');assert.equal(launched(),0);
});

test('a DEFINITE refusal (host owner declines) on a cold start is enforced at once: retired and given up',async()=>{
 const {h,launched}=await box(async()=>'this host owner declines this deployment');const before=rpc.chainTx.sent.length;
 await h.tick();
 assert.equal(mgr.removed.length,1,'the domain is retired at once');assert.equal(launched(),0);
 assert.equal(rpc.chainTx.sent.length,before+1,'and the lease is released, as before');
 assert.match(h.records.get(id).reason,/host owner declines/);
});

test('a platform moderation refusal (catalog approval withdrawn / version yanked) on a cold start is enforced at once',async()=>{
 // the real host-admission answers these as DEFINITE refusals (Kb: "this host owner requires current catalog approval",
 // and the catalog verdict for a yanked/delisted version); they are never UNKNOWN, so the cold keep cannot defer them
 for(const refusal of ['this host owner requires current catalog approval','catalog: the version is yanked by its publisher']){
  const {h,launched}=await box(async()=>refusal);const before=rpc.chainTx.sent.length;
  await h.tick();
  assert.equal(mgr.removed.length,1,`retired at once: ${refusal}`);assert.equal(launched(),0);
  assert.equal(rpc.chainTx.sent.length,before+1,'given up as before');assert.doesNotMatch(h.records.get(id).reason||'',/KEPT/);
 }
});

test('a WARM node (a definite answer already seen in this process) holds exactly as before: unknown retires at once',async()=>{
 let mode='allowed';
 const {h}=await box(async()=>{if(mode==='unknown')throw Error('chain quorum unavailable');return null;});
 await h.tick();assert.deepEqual(mgr.removed,[]);
 mode='unknown';skew=30_000;await h.tick();
 assert.equal(mgr.removed.length,1,'no cold keep after a definite answer');
 assert.match(h.records.get(id).reason,/^host wallet policy unavailable \(chain quorum unavailable\): not served/);
});

test('no running domain, or a manager that cannot be asked: the ordinary hold, unchanged (no keep)',async()=>{
 let {h}=await box(UNKNOWN,{running:false});await h.tick();
 assert.match(h.records.get(id).reason,/^host wallet policy unavailable \(chain quorum unavailable\): not served/);
 ({h}=await box(UNKNOWN));mgr.down=true;await h.tick();
 assert.doesNotMatch(h.records.get(id).reason,/is KEPT/,'an unanswered manager is not read as "running"');
 assert.equal(h.records.get(id).walletHeld,true);
});

test('a forced ensureApp on a cold unknown keeps the running domain and launches nothing (no bypass of the gate)',async()=>{
 const {h}=await box(UNKNOWN);delete h.ensureApp;                                  // the REAL ensureApp
 const before=rpc.chainTx.sent.length;
 const rec=await h.ensureApp(id,row(h),{force:true,version});
 assert.equal(rec.status,'held');assert.match(rec.reason,/is KEPT, not served/);assert.deepEqual(mgr.removed,[]);
 assert.equal(h.apps.has(id),false,'nothing is served');assert.equal(rpc.chainTx.sent.length,before);
});
