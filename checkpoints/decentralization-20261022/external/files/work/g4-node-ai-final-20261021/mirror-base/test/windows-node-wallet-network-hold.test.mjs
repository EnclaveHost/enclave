// The non-destructive wallet hold, end to end on one box: the REAL Host (windows/node/host.mjs) with chain.mjs on a fake
// Base RPC and the real IsolationManagerClient against a loopback manager that counts removals, writing its wallet channel
// (network/wallet-admission.mjs) that the REAL PrivacyAgent / EnclaveNetworkManager / EgressMap read, whose status.json
// the Host then reads back as the hold's acknowledgement. An UNKNOWN host-wallet answer keeps a running domain only with
// that acknowledgement; everything else is retired as before.
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
 const h=new Host({dir,endpoint,name:'test',appsEnabled:true,vcpus:8,ramGb:16,cpuPricePerSec6:0,isolationManager:MANAGER,walletAdmission,...cfg,
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

test('UNKNOWN with a confirmed network hold: domain KEPT (no removal, no tx), ingress/egress and an established stream withdrawn, app zone refuses; a fresh allow restores',{timeout:20_000},async t=>{
 let mode='allow';
 const b=await box(()=>mode==='allow'?ALLOW():UNKNOWN());
 assert.equal(b.n.admitted(),false,'a fresh node generation starts EMPTY: nothing admitted before the first allow');
 await b.h.tick();await b.n.tick();
 assert.equal(b.n.admitted(),true,'the definite allow is published with its chain deadline');
 assert.ok(await b.h.appZoneTarget(id),'served by the app zone while allowed');
 // a REAL established host-egress stream for the app (the SOCKS server and its splice unchanged; destination on loopback)
 const sockets=new Set(),echo=net.createServer(s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));s.pipe(s);});
 echo.listen(0,'127.0.0.1');await once(echo,'listening');
 const egress=new HostEgress({authorize:i=>b.n.agent.admission.allows(i),connect:()=>net.connect({host:'127.0.0.1',port:echo.address().port})});
 let client=null;t.after(async()=>{b.n.stop();client?.destroy();await egress.close();for(const s of sockets)s.destroy();await new Promise(r=>echo.close(r));});
 const c=await egress.start({deploymentId:id});c.healthy=true;b.n.agent.manager.apps.get(id).circuits.push(c);await b.n.tick();
 client=net.connect({host:'127.0.0.1',port:Number(c.egress.split(':').at(-1))});client.on('error',()=>{});await once(client,'connect');
 let reply=once(client,'data');client.write(Buffer.from([5,1,0]));await reply;
 reply=once(client,'data');client.write(Buffer.from([5,1,0,1,8,8,8,8,0,80]));assert.equal((await reply)[0][1],0);
 reply=once(client,'data');client.write('before');assert.equal((await reply)[0].toString(),'before');
 assert.ok(b.n.egress()[id],'egress map lists the app while allowed');
 const closed=once(client,'close'),before=b.tx();
 mode='unknown';skew=30_000;await b.n.tick();await b.h.tick();
 assert.deepEqual(mgr.removed,[],'the running domain (its key and certificate) is NOT retired');
 assert.equal(b.tx(),before,'nothing released or renewed on an unknown policy');
 const r=b.h.records.get(id);assert.equal(r.status,'held');assert.equal(r.walletHeld,true);assert.equal(r.walletKept,true);
 assert.match(r.reason,/^host wallet policy unavailable \(chain quorum unavailable\): not served, renewed or released.*its domain hv1+ is KEPT: the network agent confirmed its ingress and egress withdrawn$/);
 await closed;assert.equal(c.closed,true,'the established egress stream was cut before the acknowledgement');
 assert.equal(b.n.admitted(),false);assert.deepEqual(b.n.egress(),{},'egress map withdrawn');
 assert.equal(await b.h.appZoneTarget(id),null,'the app zone splices nothing for it');
 assert.equal(b.h.appZoneAdmitted(id),false);assert.deepEqual(b.withdrawn,[id],'the app zone\'s open streams for it are cut');
 assert.equal(b.launched(),1,'nothing launched while unknown');
 skew=60_000;await b.n.tick();await b.h.tick();assert.deepEqual(mgr.removed,[],'still kept on the next unknown pass');assert.equal(b.tx(),before);
 mode='allow';skew=90_000;await b.h.tick();await b.n.tick();
 assert.equal(b.h.records.get(id).walletHeld,null);assert.equal(b.launched(),2,'served again: ensureApp adopts the kept domain');
 assert.equal(b.n.admitted(),true,'a FRESH allow restores network admission');assert.deepEqual(mgr.removed,[]);
});

test('a COLD node (first answer UNKNOWN) keeps the running domain only on the acknowledgement of its NEW generation',{timeout:20_000},async()=>{
 let mode='unknown';
 const b=await box(()=>mode==='allow'?ALLOW():UNKNOWN());
 await b.h.tick();
 assert.deepEqual(mgr.removed,[]);assert.equal(b.h.records.get(id).walletKept,true);assert.equal(b.n.admitted(),false);
 assert.equal(b.n.reader.status().generation,b.h.walletChannel.generation);
 mode='allow';skew=30_000;await b.h.tick();await b.n.tick();assert.equal(b.n.admitted(),true);assert.deepEqual(mgr.removed,[]);
 b.n.stop();
});

test('no false preserve: no network agent, an older one, a stale status, another runner, or an intervening allow -> retired as before',{timeout:30_000},async()=>{
 const cases=[
  ['no network agent (no status)',{startNetwork:false},/the network agent's status cannot be read/],
  ['an older network agent (no walletAdmission)',{networkOpts:{wallet:false}},/does not enforce wallet holds/],
  ['another runner\'s channel',{networkOpts:{walletRunner:'0x'+'99'.repeat(32)}},/reads another runner's channel/],
 ];
 for(const [name,opts,why] of cases){
  const b=await box(()=>UNKNOWN(),opts);const t0=realNow();
  await b.h.tick();b.n.stop();
  assert.equal(mgr.removed.length,1,`${name}: retired`);assert.ok(realNow()-t0<3000,`${name}: at once, not after the bound`);
  const r=b.h.records.get(id);assert.notEqual(r.walletKept,true);assert.match(r.reason,why,name);
 }
 // stale: the agent stopped answering 6 s ago; waited for within the bound, then retired
 {const b=await box(()=>UNKNOWN(),{cfg:{walletHoldAckMs:1500}});b.n.stop();await b.n.tick();skew=6000;const t0=realNow();await b.h.tick();
  assert.equal(mgr.removed.length,1,'stale status: retired');assert.ok(realNow()-t0>=1400);assert.match(b.h.records.get(id).reason,/within 1.5 s \(its status is stale\)/);}
 // an allow lands between the hold and its acknowledgement (another path re-allowed): revision alone is no proof
 {const b=await box(()=>UNKNOWN(),{cfg:{walletHoldAckMs:1500}});const w=b.h.walletChannel,hold=w.hold.bind(w);
  w.hold=i=>{const r=hold(i);w.allow(i,{appRef:ref,configCid:'',validUntil:Date.now()+60_000});return r;};
  const t0=realNow();await b.h.tick();b.n.stop();
  assert.equal(mgr.removed.length,1,'reallowed: no false preserve');assert.ok(realNow()-t0>=1400);
  assert.match(b.h.records.get(id).reason,/did not confirm the withdrawal within 1.5 s/);}
});

test('an acknowledgement that never comes (a circuit close that does not finish) retires after exactly WALLET_HOLD_ACK_MS (15 s)',{timeout:30_000},async()=>{
 const b=await box(()=>UNKNOWN());
 b.n.agent.manager.apps.get(id).circuits.push({id:'stuck',healthy:true,providers:{},admit(){},close:()=>new Promise(()=>{})});
 const t0=realNow();await b.h.tick();const took=realNow()-t0;b.n.stop();
 assert.equal(mgr.removed.length,1);assert.ok(took>=15_000&&took<17_000,`bounded wait ${took} ms`);
 assert.match(b.h.records.get(id).reason,/did not confirm the withdrawal within 15 s/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(b.agentDir,'state','status.json'),'utf8')).walletAdmission.applied,false);
});

test('a DEFINITE refusal (owner deny, catalog approval, yank) with the channel on: withdrawn on the network, retired and released at once, never KEPT',{timeout:20_000},async()=>{
 for(const refusal of ['this host owner declines this deployment','this host owner requires current catalog approval','catalog: the version is yanked by its publisher']){
  let mode='allow';
  const b=await box(()=>mode==='allow'?ALLOW():{refusal,validUntil:Date.now()+80_000});
  await b.h.tick();await b.n.tick();assert.equal(b.n.admitted(),true);
  // 10 s later: the allow (80 s) and the channel document (30 s) are both still current, so only its withdrawal stops it
  const before=b.tx();mode='deny';skew=10_000;await b.n.tick();assert.equal(b.n.admitted(),true);await b.h.tick();await b.n.tick();
  assert.equal(mgr.removed.length,1,`retired: ${refusal}`);assert.equal(b.tx(),before+1,'and released');
  assert.equal(b.n.admitted(),false,'its allow is withdrawn from the network');
  assert.doesNotMatch(b.h.records.get(id).reason||'',/KEPT/);assert.equal(b.h.tracked.has(id),false);
  b.n.stop();
 }
});

test('a lease that lapses while held is stopped locally: retired, not released, not renewed',{timeout:20_000},async()=>{
 const b=await box(()=>UNKNOWN());
 await b.h.tick();assert.deepEqual(mgr.removed,[]);const before=b.tx();
 skew=601_000;await b.h.tick();
 assert.equal(mgr.removed.length,1,'retired at lease end');assert.equal(b.tx(),before,'nothing on chain');
 assert.equal(b.h.records.get(id).status,'stopped');assert.equal(b.h.tracked.has(id),false);
 b.n.stop();
});

test('node restart: the new process retires every earlier grant at once (EMPTY generation); its own UNKNOWN is kept only on its ACK',{timeout:20_000},async()=>{
 let mode='allow';const answer=()=>mode==='allow'?ALLOW():UNKNOWN();
 const b=await box(answer);await b.h.tick();await b.n.tick();assert.equal(b.n.admitted(),true);
 // the node process ends without a word; a new one starts on the same files
 const h2=new Host({dir:b.dir,endpoint,name:'test',appsEnabled:true,vcpus:8,ramGb:16,cpuPricePerSec6:0,isolationManager:MANAGER,
  walletAdmission:b.h.walletAdmission,hostAdmission:{hostId:chain.enclaveIdOf(endpoint),refusal:async()=>null,decision:async()=>answer()}});
 h2.chainReady=true;h2.registered={cpuPricePerSec6:'0'};await h2.refreshOwners();quiet(h2);h2.tracked.add(id);h2.records.set(id,{id});
 let launched=0;h2.ensureApp=async()=>{launched++;return h2.records.get(id);};
 await h2.walletChannelStart();await b.n.tick();
 assert.notEqual(h2.walletChannel.generation,b.h.walletChannel.generation);
 assert.equal(b.n.admitted(),false,'the previous process\'s allow does not survive the restart');assert.deepEqual(mgr.removed,[]);
 mode='unknown';await h2.tick();assert.deepEqual(mgr.removed,[],'kept on the new generation\'s acknowledgement');assert.equal(h2.records.get(id).walletKept,true);
 // the old process's writer (a zombie) cannot resurrect its generation: the reader retired it
 b.h.walletChannel.heartbeat();await b.n.tick();assert.equal(b.n.admitted(),false);assert.match(b.n.reader.status().error,/retired/);
 h2.walletChannel.heartbeat();await b.n.tick();
 mode='allow';await h2.tick();await b.n.tick();assert.equal(b.n.admitted(),true,'a fresh allow of the new process restores');assert.equal(launched,1);
 b.n.stop();
});

test('node crash or hang: the channel lapses in 30 s and the network withholds; a heartbeat never extends a decision',{timeout:20_000},async()=>{
 const b=await box(()=>ALLOW(40_000));b.n.stop();
 await b.h.tick();await b.n.tick();assert.equal(b.n.admitted(),true);
 skew=31_000;await b.n.tick();assert.equal(b.n.admitted(),false,'no heartbeat: the channel document lapsed');
 skew=0;b.h.walletChannel.allow(id,{appRef:ref,configCid:'',validUntil:Date.now()+40_000});
 skew=25_000;b.h.walletHeartbeat();await b.n.tick();assert.equal(b.n.admitted(),true,'heartbeat keeps the CHANNEL alive');
 skew=41_000;b.h.walletHeartbeat();await b.n.tick();assert.equal(b.n.admitted(),false,'but not the decision past its chain deadline');
 assert.deepEqual(mgr.removed,[],'withholding never touched the domain');
});

test('an allow that cannot be published is an UNKNOWN (held, nothing launched), and a forced ensureApp cannot bypass the hold',{timeout:20_000},async()=>{
 let b=await box(()=>ALLOW(200_000));
 await b.h.tick();assert.equal(b.launched(),0);assert.equal(b.n.admitted(),false);
 assert.match(b.h.records.get(id).reason,/the allow could not be published to the network agent/);assert.deepEqual(mgr.removed,[]);b.n.stop();
 b=await box(()=>UNKNOWN());delete b.h.ensureApp;const before=b.tx();
 const rec=await b.h.ensureApp(id,row(),{force:true,version});
 assert.equal(rec.status,'held');assert.equal(rec.walletKept,true);assert.equal(b.h.apps.has(id),false);assert.deepEqual(mgr.removed,[]);assert.equal(b.tx(),before);
 b.n.stop();
});

test('channel OFF (an older host-admission bundle without decision(), or not configured): UNKNOWN retires exactly as before, no file written',{timeout:20_000},async()=>{
 const b=await box(null,{hostAdmission:{hostId:chain.enclaveIdOf(endpoint),refusal:async()=>{throw Error('chain quorum unavailable');}},networkOpts:{wallet:false}});
 assert.equal(b.h.walletChannel,null);assert.match(b.h.walletChannelOff,/older host-admission bundle/);
 assert.equal(fs.existsSync(b.h.walletAdmission.file),false,'no channel file');
 await b.h.tick();assert.equal(mgr.removed.length,1);
 assert.equal(b.h.records.get(id).reason,'host wallet policy unavailable (chain quorum unavailable): not served, renewed or released until it is established; asked again each pass');
 b.n.stop();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'host-wallet-off-'));dirs.push(dir);
 const h=new Host({dir,endpoint,name:'t',appsEnabled:true,vcpus:8,ramGb:16,cpuPricePerSec6:0,isolationManager:MANAGER,hostAdmission:{hostId:chain.enclaveIdOf(endpoint),refusal:async()=>null,decision:async()=>ALLOW()}});
 assert.equal(h.walletAdmission,null,'off unless ENCLAVE_NETWORK_WALLET_HOLD=1');assert.equal(await h.walletChannelStart(),null);
});

test('a Windows sharing refusal of the hold write is retried (kept); a persistent one falls back to the retire',{timeout:20_000},async()=>{
 let b=await box(()=>UNKNOWN());let w=b.h.walletChannel,hold=w.hold.bind(w),refusals=2;
 w.hold=i=>{if(refusals-->0)throw Object.assign(Error('EPERM: operation not permitted, rename'),{code:'EPERM'});return hold(i);};
 await b.h.tick();assert.deepEqual(mgr.removed,[]);assert.equal(b.h.records.get(id).walletKept,true);b.n.stop();
 b=await box(()=>UNKNOWN());w=b.h.walletChannel;w.hold=()=>{throw Object.assign(Error('EPERM: operation not permitted, rename'),{code:'EPERM'});};
 await b.h.tick();assert.equal(mgr.removed.length,1);assert.match(b.h.records.get(id).reason,/not kept: the hold could not be written \(EPERM/);b.n.stop();
});
