// 7d independent review (node-hold-host-review-20261021): the OTHER lifecycle exits an ALLOWED deployment can take must
// withdraw its network allow AT ONCE (not after its <= 90 s chain deadline): stopped on the ledger, another runner holds
// the lease, and the lease no longer ours (re-claim path). Harness copied verbatim from 605 windows-node-wallet-network-hold
// (lines 6-85) so the REAL Host, PrivacyAgent, EgressMap and wallet channel are exercised.
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


const withdrawnAtOnce=async(label,mutateRow)=>{
 let mode='allow';
 const b=await box(()=>mode==='allow'?ALLOW(80_000):UNKNOWN());
 await b.h.tick();await b.n.tick();
 assert.equal(b.n.admitted(),true,`${label}: allowed first`);
 assert.ok(b.n.reader.status().allows.includes(id),`${label}: published`);
 // 5 s later the allow (80 s) and the channel (30 s) are both current: only an explicit withdrawal can stop it
 skew=5_000;rpc.row.current={...row(),...mutateRow()};
 await b.h.tick();await b.n.tick();
 assert.equal(b.n.reader.status().allows.includes(id),false,`${label}: the allow is withdrawn from the channel`);
 assert.equal(b.n.admitted(),false,`${label}: the network admits it no longer`);
 b.n.stop();
 return b;
};
test('7d: stopped on the ledger while allowed -> allow withdrawn at once',{timeout:20_000},async()=>{
 await withdrawnAtOnce('ledger stop',()=>({active:false}));
});
test('7d: another runner holds a live lease while allowed -> allow withdrawn at once',{timeout:20_000},async()=>{
 await withdrawnAtOnce('other runner',()=>({runner:'0x'+'42'.repeat(32)}));
});
test('7d: lease no longer ours and nobody\'s (re-claim path) -> allow withdrawn at once',{timeout:20_000},async()=>{
 const b=await withdrawnAtOnce('unclaimed',()=>({runner:'0x'+'00'.repeat(32),leaseUntil:BigInt(Math.floor(Date.now()/1000)-10)}));
 assert.ok(true,b?'':'');
});
test('7d: a hold of one deployment is acknowledged while another deployment of the same box stays allowed',{timeout:20_000},async()=>{
 // the predicate requires only that the HELD id is absent from the agent's allows; another id may be present
 const {walletHoldAcknowledged}=await import('../network/wallet-admission.mjs');
 const other='0x'+'cd'.repeat(32),gen='a'.repeat(32),now=Date.now();
 const status={version:2,updatedAt:now,walletAdmission:{runner,generation:gen,revision:5,fresh:true,applied:true,error:null,expiresAt:now+20_000,allows:[other]}};
 assert.equal(walletHoldAcknowledged({status,runner,id,hold:{generation:gen,revision:5},now}),true);
 assert.equal(walletHoldAcknowledged({status:{...status,walletAdmission:{...status.walletAdmission,allows:[other,id]}},runner,id,hold:{generation:gen,revision:5},now}),false,'held id still allowed: no ACK');
 assert.equal(walletHoldAcknowledged({status:{...status,walletAdmission:{...status.walletAdmission,revision:4}},runner,id,hold:{generation:gen,revision:5},now}),false,'older revision: no ACK');
 assert.equal(walletHoldAcknowledged({status:{...status,walletAdmission:{...status.walletAdmission,applied:false}},runner,id,hold:{generation:gen,revision:5},now}),false,'not applied: no ACK');
 assert.equal(walletHoldAcknowledged({status:{...status,updatedAt:now-6000},runner,id,hold:{generation:gen,revision:5},now}),false,'stale status: no ACK');
 assert.equal(walletHoldAcknowledged({status:{...status,version:1},runner,id,hold:{generation:gen,revision:5},now}),false,'old status schema: no ACK');
});
