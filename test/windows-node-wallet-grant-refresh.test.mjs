// Wallet GRANT REFRESH between slow passes (windows/node/host.mjs walletRefresh), end to end on one box, on the same harness as
// test/windows-node-wallet-network-hold.test.mjs: the REAL Host with chain.mjs on a fake Base RPC, writing its wallet channel
// that the REAL PrivacyAgent reads. The host admission answer is a stand-in decision() whose deadline is now + 80 s (the
// production runtime caps it at the chain snapshot + 90 s). Time moves with `skew`; the 10-s heartbeat and refresh timers are
// driven explicitly. 2026-10-22 minipc outage: a pass took ~7 min, so the adapter was admitted ~73 s of every 7 minutes.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {fakeBaseRpc,DEPLOYMENTS,CATALOG} from './helpers/fake-base-rpc.mjs';
process.env.NODE_OPERATOR_KEY='0x'+'7f'.repeat(32);
delete process.env.ENCLAVE_NETWORK_WALLET_HOLD;
const rpc=await fakeBaseRpc();
const chain=await import('../windows/node/chain.mjs');
chain.addresses.deployments=DEPLOYMENTS;chain.addresses.appCatalog=CATALOG;chain.loadOperator();
const {Host}=await import('../windows/node/host.mjs');
const {PrivacyAgent}=await import('../network/privacy-agent.mjs');
const {WalletAllowFile}=await import('../network/wallet-admission.mjs');
const {defaultNetworkPolicy}=await import('../network/network-policy-core.mjs');
const {HostEgress}=await import('../network/host-egress.mjs');
const dirs=[];
const id='0x'+'ab'.repeat(32),ref='catalog://0x'+'cd'.repeat(32)+'/1',endpoint='https://api.enclave.host/t/wallet-hold-test';
const runner=chain.enclaveIdOf(endpoint).toLowerCase(),INSTANCE='hv'+'1'.repeat(32);
const version={cid:'bafy',version:'1',vramMb:0,gpuGflops:0,memMb:512,cpuGflops:0,createdAt:1n,verified:true,yanked:false,ports:'',approval:1,config:'{}'};
const expected={appRef:ref,configCid:'',appSha256:'4'.repeat(64),runtimeId:'runtime'};

const mgr={vms:[],removed:[]};
const srv=http.createServer((q,s)=>{const send=(c,b)=>{s.writeHead(c,{'content-type':'application/json'});s.end(JSON.stringify(b));};
 const m=q.url.match(/^\/vms(?:\/([^/?]+))?$/);if(!m)return send(404,{error:'no'});
 const vid=m[1]&&decodeURIComponent(m[1]);
 if(q.method==='GET'&&!vid)return send(200,{vms:mgr.vms});
 if(q.method==='GET'){const v=mgr.vms.find(x=>x.id===vid);return v?send(200,v):send(404,{error:'gone'});}
 if(q.method==='DELETE'){const i=mgr.vms.findIndex(x=>x.id===vid);if(i<0)return send(404,{error:'gone'});mgr.removed.push(vid);mgr.vms.splice(i,1);return send(200,{removed:vid});}
 send(405,{});});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const MANAGER=`http://127.0.0.1:${srv.address().port}`;
const realNow=Date.now;let skew=0;Date.now=()=>realNow()+skew;
const loops=new Set();
after(()=>{for(const l of loops)clearInterval(l);Date.now=realNow;rpc.close();srv.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});});

const row=()=>({id,owner:chain.operatorAddress(),appRef:ref,ports:'',configCid:'',gpuMilli:0,cpuMilli:100,appPort:8000,isPublic:true,
 active:true,createdAt:1n,rate:1n,balance6:1000000n,spent6:0n,runner,runnerOperator:chain.operatorAddress(),
 leaseUntil:BigInt(Math.floor(Date.now()/1000)+600)});
const quiet=h=>{for(const name of ['followBook','enforceOff','ensureRegistered','ensurePriced','scanLedger','retireForeignRecovered'])h[name]=async()=>{};};
const UNKNOWN=()=>{throw Error('chain quorum unavailable');};
const ALLOW=(ms=80_000)=>({refusal:null,validUntil:Date.now()+ms});
const REFUSE=()=>({refusal:'banned by the host owner wallet policy',validUntil:Date.now()+80_000});

// the network agent of this box: the real PrivacyAgent on the host's channel file, its own lease and guest proof kept fresh
// (what its chain round and proof renewal do), its admission + snapshot timer at 100 ms (1 s in production)
function network(agentDir,{walletRunner=runner,wallet=true,run=true}={}){
 const reader=wallet?new WalletAllowFile({file:path.join(agentDir,'wallet-admission.json'),runner:walletRunner}):null;
 const agent=new PrivacyAgent({apps:[{deploymentId:id,expected}],runner,wallet:reader,directory:path.join(agentDir,'state'),dns:['1.1.1.1'],
  leaseReader:{get:()=>null},network:{localRoutes:false,runtime:{},providers:async()=>[]}});
 const prove=()=>{agent.admission.observeLease({id,runner,owner:'0x'+'5'.repeat(40),appRef:ref,configCid:'',active:true,isPublic:true,validUntil:Date.now()+90_000,leaseUntil:Date.now()+90_000});
  agent.admission.proofs.set(id,{deploymentId:id,appSha256:expected.appSha256,runtimeId:expected.runtimeId,spkiSha256:'5'.repeat(64),validUntil:Date.now()+60_000});};
 const tick=async()=>{prove();await agent.snapshot();};
 let loop=null;const start=()=>{loop=setInterval(()=>void tick().catch(()=>{}),100);loops.add(loop);},stop=()=>{clearInterval(loop);loops.delete(loop);};
 const n={agent,reader,tick,start,stop,
  admitted:()=>agent.manager.authorizationUntil(id)>Date.now(),
  egress:()=>JSON.parse(fs.readFileSync(path.join(agentDir,'state','egress-routes.json'),'utf8')).apps,
  configure:()=>agent.manager.configure([{deploymentId:id,names:[id.slice(2,10)+'.app.enclave.host'],policy:defaultNetworkPolicy(id)}])};
 return n;
}
// a FRESH node process with the channel on, a running domain on the manager, and its box's network agent
async function box(answer,{hostAdmission,agentDir,networkOpts={},startNetwork=true,cfg={}}={}){
 skew=0;mgr.removed=[];mgr.vms=[{id:INSTANCE,name:id,status:'running',appId:'a'.repeat(64)}];
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'host-wallet-hold-'));dirs.push(dir);
 agentDir||=path.join(dir,'agent');fs.mkdirSync(path.join(agentDir,'state'),{recursive:true});
 const walletAdmission={file:path.join(agentDir,'wallet-admission.json'),statusFile:path.join(agentDir,'state','status.json')};
 const h=new Host({dir,endpoint,name:'test',appsEnabled:true,vcpus:8,ramGb:16,cpuPricePerSec6:0,isolationManager:MANAGER,walletAdmission,walletRefreshDeadlineMs:1500,...cfg,
   hostAdmission:hostAdmission||{hostId:chain.enclaveIdOf(endpoint),refusal:async q=>(await answer(q)).refusal,decision:async q=>answer(q)}});
 h.chainReady=true;h.registered={cpuPricePerSec6:'0'};await h.refreshOwners();quiet(h);
 await h.walletChannelStart();
 rpc.row.current=row();rpc.catalog.current=version;rpc.chainTx.mine=true;
 h.tracked.add(id);h.records.set(id,{id});
 let launched=0;h.ensureApp=async()=>{launched++;h.records.set(id,{...h.records.get(id),status:'running',isolation:{instance:INSTANCE,appId:'a'.repeat(64)}});return h.records.get(id);};
 const withdrawn=[];h.servingWithdrawn=i=>withdrawn.push(i);
 const n=network(agentDir,networkOpts);await n.configure();if(startNetwork){await n.tick();n.start();}
 return {h,n,dir,agentDir,launched:()=>launched,withdrawn,tx:()=>rpc.chainTx.sent.length};
}


const allowsInFile=b=>JSON.parse(fs.readFileSync(path.join(b.agentDir,'wallet-admission.json'),'utf8')).allows;
// the 10-s timers of production, one step: the channel heartbeat, then one refresh round (awaited); then the agent's pass
// (the installed base has no walletRefresh: there a step is only the heartbeat - its outage is what these cases catch)
const NONE=()=>({refreshed:[],refused:[],unknown:[],lapsing:[],superseded:[]});
const step=async(b,sec=10)=>{skew+=sec*1000;b.h.walletHeartbeat();const r=(await b.h.walletRefresh?.())||NONE();await b.n.tick();return r;};
const until40=async b=>{for(let i=0;i<4;i++)await step(b);};   // 40 s after the grant: inside the refresh lead from here
const until30=async b=>{for(let i=0;i<3;i++)await step(b);};   // 30 s after the grant: the NEXT 10-s round is the first refresh
const fresh=over=>{rpc.row.current={...rpc.row.current,...over};};

test('the mechanism (installed and candidate): an allow lives only to its decision deadline, so a pass slower than that drops a legitimate app',{timeout:20_000},async()=>{
 const b=await box(()=>ALLOW());
 await b.h.tick();await b.n.tick();
 assert.equal(b.n.admitted(),true,'admitted right after the pass published its allow');
 for(let i=0;i<7;i++){skew+=10_000;b.h.walletHeartbeat();await b.n.tick();}
 assert.equal(b.n.admitted(),true,'70 s later: still inside the decision');
 skew+=15_000;b.h.walletHeartbeat();await b.n.tick();
 assert.equal(b.n.admitted(),false,'85 s: past the decision deadline, with no fresh decision the network admits nothing');
 assert.deepEqual(Object.keys(allowsInFile(b)),[],'the channel is fresh and lists no allow (walletUntil 0), as observed live');
});

test('a legitimate app stays admitted through a 7-minute pass gap, each allow from a FRESH decision on the fresh row',{timeout:30_000},async()=>{
 const asked=[];
 const b=await box(q=>{asked.push(q);return ALLOW();});
 await b.h.tick();await b.n.tick();
 const passAsked=asked.length;
 let refreshed=0;
 for(let t=10;t<=420;t+=10){const r=await step(b);refreshed+=r.refreshed.length;assert.equal(b.n.admitted(),true,`admitted at +${t} s`);}
 const again=asked.slice(passAsked);
 assert.equal(again.length,refreshed,'every published refresh is exactly one decision');
 assert.ok(again.length>=9&&again.length<=12,`one decision about every 40-50 s, not every 10 s (${again.length} in 420 s)`);
 assert.ok(again.every(q=>q.deploymentId===id&&q.appRef===ref&&q.forPrivate===false),'asked for the row as it is now');
 const a=allowsInFile(b)[id];
 assert.ok(a.validUntil>Date.now()+40_000&&a.validUntil<=Date.now()+90_000,'the published deadline is the latest decision\'s own');
});

test('a slow decision for one app does not starve another: per-app refresh, bounded by its deadline',{timeout:30_000},async()=>{
 const id2='0x'+'ef'.repeat(32);let hang=false;const asked=[];
 const b=await box(q=>{asked.push(q.deploymentId);if(hang&&q.deploymentId===id)return new Promise(()=>{});return ALLOW();});
 b.n.stop();                                    // the agent's status names only `id`: let the host refresh every allow
 fs.writeFileSync(path.join(b.agentDir,'state','status.json'),'{}');
 const rowA=rpc.row.current,rowB={...rowA,id:id2};
 rpc.row.current=null;rpc.rows.current=[rowA,rowB];
 b.h.tracked.add(id2);b.h.records.set(id2,{id:id2});
 b.h.ensureApp=async i=>{b.h.records.set(i,{...b.h.records.get(i),status:'running',isolation:{instance:INSTANCE,appId:'a'.repeat(64)}});return b.h.records.get(i);};
 await b.h.tick();
 assert.ok(allowsInFile(b)[id]&&allowsInFile(b)[id2],'the pass granted both');
 for(let i=0;i<3;i++){skew+=10_000;b.h.walletHeartbeat();await b.h.walletRefresh();}   // +30 s: nothing due yet
 hang=true;
 const untilB=allowsInFile(b)[id2].validUntil,untilA=allowsInFile(b)[id].validUntil;
 skew+=10_000;b.h.walletHeartbeat();
 const round=b.h.walletRefresh();            // A hangs; B must not wait for it
 await new Promise(r=>setTimeout(r,200));
 assert.ok(allowsInFile(b)[id2].validUntil>untilB,'B refreshed while A is still deciding');
 assert.equal(allowsInFile(b)[id].validUntil,untilA,'A unchanged (not extended)');
 const askedA=asked.filter(x=>x===id).length;
 const second=b.h.walletRefresh();           // a new round does not start A twice while it is in flight
 await new Promise(r=>setTimeout(r,50));
 assert.equal(asked.filter(x=>x===id).length,askedA,'A is not asked again while its refresh is in flight');
 const r=await round;
 assert.deepEqual(r.unknown,[id],'A ended at its refresh deadline as unknown');assert.deepEqual(r.refreshed,[id2]);
 await second;
 hang=false;skew+=10_000;b.h.walletHeartbeat();
 const r2=await b.h.walletRefresh();
 assert.deepEqual(r2.refreshed,[id],'and A is retried by the next round once it answers');
 rpc.rows.current=null;rpc.row.current=rowA;b.h.tracked.delete(id2);
});

test('the FRESH row binds the decision: a visibility, owner, version, config, runner or lease change is never refreshed; the allow lapses',{timeout:30_000},async()=>{
 const base=()=>({...rpc.row.current});
 for(const [what,over] of [['private now',{isPublic:false}],['another owner',{owner:'0x'+'99'.repeat(20)}],['another version',{appRef:'catalog://0x'+'cd'.repeat(32)+'/2'}],
   ['another config',{configCid:'bafyother'}],['another runner',{runner:'0x'+'77'.repeat(32)}],['inactive',{active:false}],['lease lapsed',{leaseUntil:1n}]]){
  const asked=[];
  const b=await box(q=>{asked.push(q);return ALLOW();});
  const keep=base();
  await b.h.tick();await b.n.tick();
  const until=allowsInFile(b)[id].validUntil,n=asked.length;
  fresh(over);
  await until40(b);
  const r=await step(b);
  assert.deepEqual(r.lapsing,[id],what);
  assert.equal(asked.length,n,`${what}: no decision is asked for a changed row`);
  assert.equal(allowsInFile(b)[id]?.validUntil??until,until,`${what}: never extended`);
  await step(b,40);
  assert.equal(b.n.admitted(),false,`${what}: lapsed at its own deadline`);
  rpc.row.current=keep;
 }
});

test('refusal at a refresh: withdrawn at once and never re-granted by the refresh',{timeout:20_000},async()=>{
 let mode='allow';const asked=[];
 const b=await box(()=>{asked.push(mode);return mode==='allow'?ALLOW():REFUSE();});
 await b.h.tick();await b.n.tick();
 await until30(b);
 mode='refuse';
 const r=await step(b);
 assert.deepEqual(r.refused,[id]);
 assert.equal(b.n.admitted(),false,'withdrawn before the old decision\'s deadline');
 assert.equal(allowsInFile(b)[id],undefined);
 const n=asked.length;mode='allow';
 for(let i=0;i<6;i++){await step(b);assert.equal(b.n.admitted(),false);}
 assert.equal(asked.length,n,'a refused deployment is not asked again by the refresh, let alone re-granted');
});

test('unknown at a refresh: nothing published or extended; the allow lapses at its own deadline; a later fresh decision restores it',{timeout:20_000},async()=>{
 let mode='allow';
 const b=await box(()=>mode==='allow'?ALLOW():UNKNOWN());
 await b.h.tick();await b.n.tick();
 const until=allowsInFile(b)[id].validUntil;
 mode='unknown';
 for(let i=0;i<7;i++){const r=await step(b);assert.equal(r.refreshed.length,0);}
 assert.equal(allowsInFile(b)[id]?.validUntil??until,until,'the deadline was never moved without a decision');
 await step(b,15);
 assert.equal(b.n.admitted(),false,'lapsed at its own deadline');
 mode='allow';
 const r=await step(b);
 assert.deepEqual(r.refreshed,[id]);assert.equal(b.n.admitted(),true,'a fresh decision for the unchanged, still-granted row restores it');
});

test('no resurrection: a deployment the pass stopped, or HELD on an unknown policy, is never re-granted by the refresh',{timeout:30_000},async()=>{
 {const asked=[];
  const b=await box(()=>{asked.push(1);return ALLOW();});
  await b.h.tick();await b.n.tick();
  fresh({active:false});await b.h.tick();await b.n.tick();
  fresh({active:true});
  const n=asked.length;
  for(let i=0;i<9;i++){await step(b);assert.equal(b.n.admitted(),false);}
  assert.equal(asked.length,n,'stopped: no refresh decision');}
 {let mode='allow';const asked=[];
  const b=await box(()=>{asked.push(mode);return mode==='allow'?ALLOW():UNKNOWN();});
  await b.h.tick();await b.n.tick();
  mode='unknown';await b.h.tick();await b.n.tick();   // the pass: UNKNOWN -> hold (acknowledged by the agent)
  assert.equal(b.h.records.get(id).walletHeld,true);
  mode='allow';const n=asked.length;
  for(let i=0;i<9;i++){await step(b);assert.equal(b.n.admitted(),false,'held until the PASS decides again');}
  assert.equal(asked.length,n,'held: no refresh decision');}
});

test('a refresh in flight while the pass withdraws the deployment cannot re-grant it',{timeout:20_000},async()=>{
 let gate=null;const asked=[];
 const b=await box(()=>{asked.push(1);if(!gate)return ALLOW();return gate.then(()=>ALLOW());},{cfg:{walletRefreshDeadlineMs:5000}});
 await b.h.tick();await b.n.tick();
 await until30(b);
 let release;gate=new Promise(r=>{release=r;});
 skew+=10_000;b.h.walletHeartbeat();
 const inflight=b.h.walletRefresh();
 await new Promise(r=>setTimeout(r,100));
 const n=asked.length;assert.ok(n>=2,'the refresh is deciding');
 fresh({active:false});
 await b.h.tick();                      // the pass stops it on the ledger -> revoke
 release();const r=await inflight;
 assert.deepEqual(r.superseded,[id],'the decided allow was dropped: its grant was withdrawn meanwhile');
 await b.n.tick();
 assert.equal(allowsInFile(b)[id],undefined);assert.equal(b.n.admitted(),false);
 fresh({active:true});
});

test('process generation: a new node process starts EMPTY and refreshes nothing it did not grant; the old generation is refused',{timeout:20_000},async()=>{
 const asked=[];
 const a=await box(()=>{asked.push(1);return ALLOW();});
 await a.h.tick();await a.n.tick();assert.equal(a.n.admitted(),true);
 // a fresh node process on the same channel (same agent): a new generation, written empty
 const dir2=fs.mkdtempSync(path.join(os.tmpdir(),'host-wallet-gen-'));dirs.push(dir2);
 const h2=new (a.h.constructor)({dir:dir2,endpoint,name:'test',appsEnabled:true,vcpus:8,ramGb:16,cpuPricePerSec6:0,isolationManager:MANAGER,
   walletAdmission:{file:path.join(a.agentDir,'wallet-admission.json'),statusFile:path.join(a.agentDir,'state','status.json')},walletRefreshDeadlineMs:1500,
   hostAdmission:{hostId:chain.enclaveIdOf(endpoint),refusal:async()=>null,decision:async()=>{asked.push(2);return ALLOW();}}});
 h2.chainReady=true;h2.registered={cpuPricePerSec6:'0'};await h2.refreshOwners();quiet(h2);h2.tracked.add(id);h2.records.set(id,{id,status:'running'});
 await h2.walletChannelStart();
 await a.n.tick();
 assert.equal(a.n.admitted(),false,'the new generation is empty');
 skew+=45_000;h2.walletHeartbeat();
 const r2=await h2.walletRefresh();
 assert.deepEqual(r2.refreshed,[],'the new process refreshes nothing it did not grant itself');assert.equal(asked.filter(x=>x===2).length,0);
 // the OLD process (if it were still running) refreshing its grant writes its old generation: the agent has retired it
 a.h.walletHeartbeat();await a.h.walletRefresh();await a.n.tick();
 assert.equal(a.n.admitted(),false,'the old generation cannot resurrect its grant');
});

test('a PRIVATE deployment is re-decided as private: forPrivate comes from the fresh row, as the pass asks it',{timeout:20_000},async()=>{
 const asked=[];
 const b=await box(q=>{asked.push(q);return ALLOW();});
 fresh({isPublic:false});
 await b.h.tick();
 assert.ok(asked.length>=1&&asked.every(q=>q.forPrivate===true),'the pass asked for a private deployment');
 const n=asked.length;
 await until30(b);const r=await step(b);
 assert.deepEqual(r.refreshed,[id]);
 assert.ok(asked.slice(n).length===1&&asked.slice(n).every(q=>q.forPrivate===true),'the refresh asked forPrivate: true, from the row');
 fresh({isPublic:true});
});

test('a refresh in flight while the pass HOLDS the deployment (unknown policy) cannot resurrect its grant',{timeout:30_000},async()=>{
 let mode='allow',gate=null;
 const b=await box(()=>{if(mode==='unknown')return UNKNOWN();if(gate)return gate.then(()=>ALLOW());return ALLOW();},{cfg:{walletRefreshDeadlineMs:8000}});
 await b.h.tick();await b.n.tick();
 await until30(b);
 let release;gate=new Promise(r=>{release=r;});
 skew+=10_000;b.h.walletHeartbeat();
 const inflight=b.h.walletRefresh();          // its row check passed (running); now it waits for the decision
 await new Promise(r=>setTimeout(r,100));
 mode='unknown';
 await b.h.tick();                             // the pass: UNKNOWN -> hold, acknowledged by the agent
 assert.equal(b.h.records.get(id).walletHeld,true);
 gate=null;release();
 const r=await inflight;
 assert.deepEqual(r.superseded,[id],'the decision arrived after the hold: dropped');
 await b.n.tick();
 assert.equal(allowsInFile(b)[id],undefined);assert.equal(b.n.admitted(),false,'held stays held until the PASS decides again');
});
