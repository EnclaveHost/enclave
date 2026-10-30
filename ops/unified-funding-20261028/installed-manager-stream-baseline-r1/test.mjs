import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import { Manager } from './control/windows/vbslike/manager/server.mjs';
import { HyperVPartitionBackend } from './control/windows/vbslike/manager/backend.mjs';
import { dataPlaneFor } from './control/windows/vbslike/datapath/node-bridge.mjs';
import { dataServer } from './control/windows/vbslike/router/io.mjs';
const V=JSON.parse(fs.readFileSync(new URL('./derive_vectors.json',import.meta.url))),record=V.ok[0].mapping.record;
const image='a1'.repeat(32),key='b2'.repeat(32);
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const wait=async(f,why)=>{for(let i=0;i<200;i++){if(f())return;await new Promise(r=>setTimeout(r,5));}assert.fail(why);};
async function fixture(t){
 const sockets=new Set(), servers=[], stops=new Map();
 const track=s=>{sockets.add(s);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));return s;};
 const echo=net.createServer(s=>{track(s);s.pipe(s);});servers.push(echo);echo.listen(0,'127.0.0.1');await once(echo,'listening');
 const backend=new HyperVPartitionBackend({launch:async(_mapping,opts)=>({appReady:false,image,launcherKey:'TEST-public-launcher',launcherVmId:'TEST-VM-'+opts.identity.id,tcpPort:echo.address().port,stop:async()=>{const gate=stops.get(opts.identity.id);if(gate){gate.entered=true;await gate.promise;}}})});
 const manager=new Manager({backend,runtimeId:record.runtimeId,fetchComponent:async()=>Buffer.from(V.component_hex,'hex'),judgeReady:async()=>({status:'running',transportKeySha256:key,checks:{document:{verdict:'TEST-readiness-not-attestation'}}})});
 const dp=dataPlaneFor(manager);servers.push(dp.server);dp.server.listen(0,'127.0.0.1');await once(dp.server,'listening');
 manager.onReclaim=(id,why)=>dp.closeInstance(id,why);
 const router=dataServer({legacyPort:dp.server.address().port,nativePort:dp.server.address().port});servers.push(router.server);router.server.listen(0,'127.0.0.1');await once(router.server,'listening');
 t.after(async()=>{for(const g of stops.values())g.resolve();for(const s of sockets)s.destroy();for(const s of servers)await new Promise(r=>s.close(r));});
 const spawn=async(n)=>{const x=await manager.spawn({derive:record,name:'0x'+n.repeat(64),isPublic:true,hasSecrets:false});await wait(()=>manager.get(x.id)?.status==='running','TEST readiness');return manager.get(x.id);};
 const open=async(rec,{throughRouter=false,badKey=false,preamble=true}={})=>{const s=track(net.connect({host:'127.0.0.1',port:(throughRouter?router.server:dp.server).address().port}));let data='';s.on('data',b=>data+=b.toString());await once(s,'connect');const head=()=>s.write(`ENCLAVE-SPLICE/1 id=${rec.id} app=${rec.appId} image=${rec.image} runtime=${rec.runtimeId} key=${badKey?'c3'.repeat(32):rec.transportKeySha256}\n`);if(preamble)head();return{s,head,data:()=>data};};
 const admitted=async(c)=>{await wait(()=>c.data().startsWith('OK\n'),'actual splice OK');c.s.write('TEST-roundtrip');await wait(()=>c.data().includes('TEST-roundtrip'),'actual payload roundtrip');};
 return {manager,dp,router,spawn,open,admitted,stops};
}
test('STREAM1 exact installed Manager+direct data plane performs real TCP roundtrip and rejects wrong key',async t=>{
 const r=await fixture(t),a=await r.spawn('1'),c=await r.open(a);await r.admitted(c);
 const denied=await r.open(a,{badKey:true});await wait(()=>denied.data().startsWith('NO '),'wrong key refused');assert.equal(r.dp.stats().open,1);
 await r.manager.remove(a.id);await wait(()=>c.s.destroyed,'removed instance stream closed');assert.equal(r.dp.stats().open,0);
});
test('STREAM2 actual composite data router preserves per-instance close and denies delayed preamble after removal while neighbor remains',async t=>{
 const r=await fixture(t),a=await r.spawn('2'),b=await r.spawn('3'),ca=await r.open(a,{throughRouter:true}),cb=await r.open(b,{throughRouter:true}),late=await r.open(a,{throughRouter:true,preamble:false});
 await r.admitted(ca);await r.admitted(cb);await r.manager.remove(a.id);await wait(()=>ca.s.destroyed,'router stream closes after actual reclaim');
 late.head();await wait(()=>late.data().startsWith('NO ')||late.s.destroyed,'late preamble denied');assert.ok(!late.data().startsWith('OK\n'));
 cb.s.write('TEST-neighbor-survives');await wait(()=>cb.data().includes('TEST-neighbor-survives'),'neighbor preserved');assert.equal(r.manager.get(b.id).status,'running');assert.equal(r.dp.stats().open,1);
 await r.manager.remove(b.id);await wait(()=>cb.s.destroyed,'neighbor explicit removal closes');
});
test('STREAM3 observed legacy stop waits for backend completion before revoking existing or new streams; not a protected deadline guarantee',async t=>{
 const r=await fixture(t),a=await r.spawn('4'),c=await r.open(a,{throughRouter:true});await r.admitted(c);
 const g={...defer(),entered:false};r.stops.set(a.id,g);let done=false;const removal=r.manager.remove(a.id).then(v=>{done=true;return v;});await wait(()=>g.entered,'backend stop entered');
 assert.equal(done,false);c.s.write('TEST-held-stop');await wait(()=>c.data().includes('TEST-held-stop'),'legacy stream remains until stop acknowledgment');
 const late=await r.open(a,{throughRouter:true});await r.admitted(late);assert.equal(r.manager.get(a.id).status,'running');
 g.resolve();assert.equal((await removal).removed,true);await wait(()=>c.s.destroyed&&late.s.destroyed,'both close only after confirmed stop');assert.equal(r.dp.stats().open,0);
 console.log('ROOT legacy compatibility: pending compute stop does not revoke traffic; protected expiry needs a separate before-stop withdrawal path');
});
