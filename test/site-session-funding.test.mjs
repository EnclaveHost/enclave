import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const storage = new Map();
globalThis.localStorage = { getItem:k=>storage.get(k)||null, setItem:(k,v)=>storage.set(k,String(v)), removeItem:k=>storage.delete(k) };
globalThis.document = new EventTarget();
document.querySelector=()=>null; document.querySelectorAll=()=>[];
const {Enclave,WALLET_SESSION_KEY}=await import('../site/js/core/api.js');
const {_useSdkForTests}=await import('../site/js/core/sessions.js');
const {fundRuntimeFromSession}=await import('../site/js/core/session-funding.js');
const owner='0x'+'11'.repeat(20),vault='0x'+'22'.repeat(20),id='0x'+'33'.repeat(32),sid='0x'+'44'.repeat(32);
let calls,refusal,record;
beforeEach(()=>{
 storage.clear();storage.set(WALLET_SESSION_KEY,sid);calls=[];refusal=null;
 Enclave.address=owner;Enclave.base='https://api.example.test/v1';
 Enclave.provider={request(){throw Error('Owner wallet must not be called');}};
 record={id:sid,relay:'https://api.example.test',handle:{owner,vault,sid,relay:'https://api.example.test'}};
 _useSdkForTests({IndexedDbStore:class{async load(){return record;}},sessionFromRecord:async r=>({handle:r.handle,call:async(action,args)=>{calls.push({action,args});if(refusal)throw refusal;return{txHash:'0xreceipt'};}})});
});
test('funds the exact deployment and amount through the selected session',async()=>{
 const r=await fundRuntimeFromSession(id,.25);
 assert.deepEqual(calls,[{action:'deploy.fund',args:{id,amount6:250000n}}]);
 assert.equal(r.sessionId,sid);assert.equal(r.payer,'session');assert.equal(r.txHash,'0xreceipt');
});
test('without a selected session leaves the existing wallet flow available',async()=>{
 storage.clear();assert.equal(await fundRuntimeFromSession(id,.25),null);assert.equal(calls.length,0);
});
test('missing selected key refuses rather than falling back',async()=>{
 record=null;await assert.rejects(fundRuntimeFromSession(id,.25),/unavailable/);assert.equal(calls.length,0);
});
test('another owner refuses before signing',async()=>{
 Enclave.address=vault;await assert.rejects(fundRuntimeFromSession(id,.25),/another wallet/);assert.equal(calls.length,0);
});
test('another relay refuses before signing',async()=>{
 Enclave.base='https://other.example/v1';await assert.rejects(fundRuntimeFromSession(id,.25),/another API/);assert.equal(calls.length,0);
});
for(const code of ['expired','budget','env','delegation','fee','relay'])test(`${code} refusal never falls back or retries`,async()=>{
 refusal=Object.assign(Error(code),{code});await assert.rejects(fundRuntimeFromSession(id,.25),e=>e===refusal);assert.equal(calls.length,1);
});
test('invalid identifiers and amounts sign nothing',async()=>{
 await assert.rejects(fundRuntimeFromSession('wrong',.25),/Invalid deployment/);
 for(const amount of [NaN,Infinity,-1,0,.001,Number.MAX_SAFE_INTEGER])await assert.rejects(fundRuntimeFromSession(id,amount));
 assert.equal(calls.length,0);
});

test('a session removed after the form was opened cannot fall back to wallet funding',async()=>{
 storage.clear();await assert.rejects(fundRuntimeFromSession(id,.25,{required:true}),/unavailable/);assert.equal(calls.length,0);
});
