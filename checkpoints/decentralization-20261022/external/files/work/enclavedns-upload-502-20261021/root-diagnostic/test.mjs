import assert from 'node:assert/strict';
import {classifyUploadFailure as c, diagnosticFetch} from './upload-diagnostic.mjs';
const secret='<REDACTED:diagnostic-secret>';
for(const [msg,category] of [['pin failed: S3 answered 503: writer quorum '+secret,'writer-quorum'],['pin failed: read timeout '+secret,'timeout'],['pin failed: S3 answered 403: AccessDenied '+secret,'access-denied'],[secret,'other']]) {
 const out=c(502,'s3-ipfs-adapter/0.5.5',JSON.stringify({error:msg}));assert.equal(out.category,category);assert(!JSON.stringify(out).includes(secret));
}
assert.equal(c(502,'Caddy','').body,'empty');
let calls=0, reports=[];const body=JSON.stringify({error:'pin failed: S3 answered 500: '+secret});
const res=new Response(body,{status:502,headers:{server:'s3-ipfs-adapter/0.5.5'}});
const f=diagnosticFetch(async()=>{calls++;return res},'https://ipfs.enclave.host/add-wasm',v=>reports.push(v));
assert.equal(await f('https://ipfs.enclave.host/add-wasm',{method:'POST',headers:{secret}}),res);
assert.equal(calls,1);assert.equal(await res.text(),body);assert.equal(reports[0].s3Status,500);assert(!JSON.stringify(reports).includes(secret));
for(const [url,method,status] of [['https://api.enclave.host/token','POST',502],['https://ipfs.enclave.host/add-wasm','GET',502],['https://ipfs.enclave.host/add-wasm','POST',200]]) {
 const response=new Response('unchanged',{status});let emitted=false;const g=diagnosticFetch(async()=>response,'https://ipfs.enclave.host/add-wasm',()=>{emitted=true});assert.equal(await g(url,{method}),response);assert(!emitted);assert.equal(await response.text(),'unchanged');
}
let big;const response=new Response('x'.repeat(5000),{status:502});await diagnosticFetch(async()=>response,'u',v=>{big=v})('u',{method:'POST'});assert.equal(big.readState,'oversize');assert.equal((await response.text()).length,5000);
console.log('PASS fixed classifications, secret non-disclosure, one request, exact response passthrough, scope and size bounds');
