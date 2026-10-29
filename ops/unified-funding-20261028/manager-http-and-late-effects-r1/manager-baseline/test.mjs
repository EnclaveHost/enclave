import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Manager,createServer} from './control/windows/vbslike/manager/server.mjs';
import {HyperVPartitionBackend} from './control/windows/vbslike/manager/backend.mjs';
const vectors=JSON.parse(fs.readFileSync(new URL('./derive_vectors.json',import.meta.url)));
const record=vectors.ok[0].mapping.record, component=Buffer.from(vectors.component_hex,'hex');
// Actual installed-source manager HTTP surface. TEST launch/readiness only: no Windows, partition, attestation or production channel.
async function rig(t){
 let stops=0;const backend=new HyperVPartitionBackend({launch:async()=>({appReady:true,stop:async()=>{stops++;}})});
 const manager=new Manager({backend,runtimeId:record.runtimeId,fetchComponent:async()=>component});
 const server=createServer(manager);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(method,path,body)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(3000)});return{status:r.status,body:await r.json()};};
 return{manager,request,stops:()=>stops};
}
const spawn={derive:record,name:'0x'+'e6'.repeat(32),isPublic:true,hasSecrets:false};
test('current manager reports readiness capabilities, never claims continuing lifecycle deadline enforcement',async t=>{
 const r=await rig(t),h=await r.request('GET','/health');assert.equal(h.status,200);assert.equal(h.body.backend,'hyperv-partition-per-app');
 assert.notEqual(h.body.supports?.lifecyclePermit,true);assert.notEqual(h.body.supports?.servingPermit,true);assert.notEqual(h.body.expiryEnforced,true);
 console.log('ROOT health evidence',JSON.stringify({backend:h.body.backend,supports:h.body.supports,expiryEnforced:h.body.expiryEnforced??null}));
});
test('legacy start/read/explicit stop still works through exact-source HTTP without treating readiness as a permit',async t=>{
 const r=await rig(t),created=await r.request('POST','/vms',spawn);assert.equal(created.status,201);assert.equal(created.body.status,'running');assert.equal(created.body.appReady,true);
 assert.notEqual(created.body.expiryEnforced,true);const id=created.body.id;
 assert.equal((await r.request('GET','/vms/'+id)).status,200);
 assert.equal((await r.request('DELETE','/vms/'+id)).status,200);assert.equal(r.stops(),1);
 assert.equal((await r.request('GET','/vms/'+id)).status,404);
});
test('unimplemented deadline endpoint refuses; HTTP success on legacy VM is not an enforcement acknowledgment',async t=>{
 const r=await rig(t),created=await r.request('POST','/vms',spawn);assert.equal(created.status,201);
 const answer=await r.request('POST','/vms/'+created.body.id+'/permit',{TEST_ONLY:true,generation:1,validUntil:Date.now()+100,hostAuthority:'0x'+'11'.repeat(32)});
 assert.equal(answer.status,404);assert.equal(answer.body.error,'not_found');
 assert.equal((await r.request('GET','/vms/'+created.body.id)).body.status,'running','unsupported extension must not mutate legacy tenant');
 await r.request('DELETE','/vms/'+created.body.id);assert.equal(r.stops(),1);
});
