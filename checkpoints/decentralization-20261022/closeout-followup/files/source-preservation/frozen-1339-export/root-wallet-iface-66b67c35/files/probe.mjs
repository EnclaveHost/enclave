import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createPublicRpc} from './frozen/public-rpc.mjs';
const sock=http.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
const calls=[];
const role=await createPublicRpc({port,bind:'127.0.0.1',hostId:'0x'+'11'.repeat(32),chainId:8453,node:'http://127.0.0.1:1',allowedOrigins:['http://localhost']},{fetch:async(url,init)=>{const {method}=JSON.parse(init.body);calls.push(method);const values={eth_chainId:'0x2105',eth_syncing:false,eth_getBlockByNumber:{number:'0x1',timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)}};assert.ok(Object.hasOwn(values,method),'target method must not reach backend');return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:values[method]}),{headers:{'content-type':'application/json'}})}});
try {
const results=[];
for(const [method,params,expected] of [['eth_getTransactionCount',['0x'+'22'.repeat(20),'pending'],-32602],['eth_maxPriorityFeePerGas',[],-32601]]) {
const r=await fetch('http://127.0.0.1:'+port+'/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(3000)});
const body=await r.json();assert.equal(body.error.code,expected);results.push({method,params,status:r.status,body});
}
assert.deepEqual([...calls].sort(),['eth_chainId','eth_getBlockByNumber','eth_syncing'].sort());
const result={at:new Date().toISOString(),scope:'Actual immutable proposed public-role HTTP server with scripted healthy-node responses. Only the three health methods reach the backend stub; requested nonce and fee methods do not. Interface mismatch proof, not full wallet integration or production observation.',results,backendCalls:calls,conclusion:'The pending nonce request required by profile-broadcast.js is refused before signing can begin. Fee tip method is also unsupported, but the wallet has an explicit fallback tip, so that alone is not fatal.'};
fs.writeFileSync(new URL('./RESULT.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} finally {await role.close();}
