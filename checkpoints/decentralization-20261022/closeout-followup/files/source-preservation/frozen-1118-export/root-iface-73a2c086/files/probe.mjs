import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createPublicRpc,SERVED_METHODS} from '../root-public-rpc-allowlist-review-20261023/frozen/fixed-public-rpc.mjs';
import {WITNESS_METHODS} from '../resume-after-checkpoint-20261022/linux-rpc-runtime-launch/repo/network/witness-gateway.mjs';
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
let calls=0;
const role=await createPublicRpc({port,bind:'127.0.0.1',hostId:'0x'+'11'.repeat(32),chainId:8453,node:'http://127.0.0.1:1',allowedOrigins:['http://localhost']},{fetch:()=>{calls++;throw Error('backend must not be contacted by this refusal test')}});
try{
 const results=[];
 for(const [method,params] of [['eth_getProof',['0x'+'22'.repeat(20),[],'0x1']],['eth_getBlockByHash',['0x'+'33'.repeat(32),false]]]){
  assert.ok(WITNESS_METHODS.includes(method));assert.ok(!SERVED_METHODS.includes(method));
  const r=await fetch('http://127.0.0.1:'+port+'/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(3000)});
  const body=await r.json();assert.equal(body.error.code,-32601);results.push({method,status:r.status,body});
 }
 assert.equal(calls,0);
 const out={at:new Date().toISOString(),scope:'Real proposed public-role HTTP server with prior own-property correction; actual verifier exported method list. Backend deliberately unreachable and never contacted. Interface refusal proof, not a full Reth/Helios integration test or production observation.',results,backendCalls:calls,conclusion:'This public endpoint cannot yet serve as the verifier fresh-proof source. A separate supported proof endpoint or bounded added methods is required.'};
 fs.writeFileSync(new URL('./RESULT.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));
}finally{await role.close();}
