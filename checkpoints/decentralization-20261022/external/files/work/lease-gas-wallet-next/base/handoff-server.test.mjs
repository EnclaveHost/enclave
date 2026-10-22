import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHandoffServer,fileJournal} from './handoff-server.mjs';
const request={transaction:{from:'0x'+'11'.repeat(20),chainId:'0x2105',value:'0x0',data:'0x1234'}};
async function fixture(t,{prepare=async()=>request,verify=async(r,h)=>({transactionHash:h}),journal}={}){
 let saved={status:'ready'};
 journal??={read:()=>structuredClone(saved),write:x=>{saved=structuredClone(x)}};
 const app=createHandoffServer({initialRequest:request,prepare,verify,journal});await app.listen();t.after(()=>app.close());
 const token=(await (await fetch(app.origin+'/request')).json()).token;
 const post=(url,data={},headers={})=>fetch(app.origin+url,{method:'POST',headers:{Origin:app.origin,'X-Signing-Token':token,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
 return {app,post,token,journal};
}
test('rejects cross-origin and missing-token actions before preparation',async t=>{
 let calls=0;const {post}=await fixture(t,{prepare:async()=>{calls++;return request}});
 assert.equal((await post('/prepare',{}, {Origin:'https://unrelated.example'})).status,403);
 assert.equal((await post('/prepare',{}, {'X-Signing-Token':''})).status,403);assert.equal(calls,0);
});
test('one concurrent prepare produces one durable wallet attempt',async t=>{
 let release,calls=0;const held=new Promise(ok=>release=ok);
 const {post,app}=await fixture(t,{prepare:async()=>{calls++;await held;return request}});
 const first=post('/prepare');while(app.state.status!=='preparing')await new Promise(r=>setTimeout(r,5));
 assert.equal((await post('/prepare')).status,409);release();assert.equal((await first).status,200);
 assert.equal(calls,1);assert.equal(app.state.status,'awaiting-wallet');assert.equal((await post('/prepare')).status,409);
});
test('only an explicit wallet4001 before submission resets an attempt',async t=>{
 const {post,app}=await fixture(t);await post('/prepare');
 assert.equal((await post('/rejected',{code:-32000})).status,409);assert.equal(app.state.status,'awaiting-wallet');
 assert.equal((await post('/rejected',{code:4001})).status,200);assert.equal(app.state.status,'ready');
});
test('a failed chain observation keeps the submitted hash and prohibits resubmission',async t=>{
 const {post,app}=await fixture(t,{verify:async()=>{throw Error('RPC temporarily unavailable')}});await post('/prepare');
 const hash='0x'+'22'.repeat(32);assert.equal((await post('/result',{hash})).status,400);
 assert.equal(app.state.status,'submitted');assert.equal(app.state.hash,hash);
 assert.equal((await post('/prepare')).status,409);assert.equal((await post('/rejected',{code:4001})).status,409);
 assert.equal((await post('/result',{hash:'0x'+'33'.repeat(32)})).status,409);
});
test('confirmation records only the verifier result for the exact existing request',async t=>{
 const hash='0x'+'22'.repeat(32);
 const {post,app}=await fixture(t,{verify:async(r,h)=>{assert.deepEqual(r,request);assert.equal(h,hash);return {transactionHash:h,fundingReady:false}}});
 await post('/prepare');const response=await post('/result',{hash});assert.equal(response.status,200);
 assert.equal(app.state.status,'confirmed');assert.equal(app.state.verification.fundingReady,false);
 assert.equal((await post('/prepare')).status,409);
});
test('persistence failure never returns a transaction to the browser',async t=>{
 let saved={status:'ready'};const journal={read:()=>saved,write:x=>{if(x.status==='awaiting-wallet')throw Error('fsync failed');saved=x}};
 const {post,app}=await fixture(t,{journal});const r=await post('/prepare');assert.equal(r.status,400);
 assert.deepEqual(await r.json(),{error:'fsync failed'});assert.equal(app.state.status,'preparing');
});
test('read-only preparation failure permits a fresh preparation attempt',async t=>{
 const {post,app}=await fixture(t,{prepare:async()=>{throw Error('preflight disagreement')}});
 assert.equal((await post('/prepare')).status,400);assert.equal(app.state.status,'ready');
});
test('pending journal survives process restart and is not treated as ready',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-creation-handoff-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const journal=fileJournal(path.join(dir,'state.json'));journal.write({status:'awaiting-wallet',request});
 assert.equal(fs.statSync(path.join(dir,'state.json')).mode&0o777,0o600);
 const {post,app}=await fixture(t,{journal:fileJournal(path.join(dir,'state.json'))});
 assert.equal(app.state.status,'awaiting-wallet');assert.equal((await post('/prepare')).status,409);
});
