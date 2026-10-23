import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
const {createVerifiedSnapshot}=await import(process.env.VERIFIED_CHAIN_MODULE ? pathToFileURL(process.env.VERIFIED_CHAIN_MODULE).href : '../network/verified-chain.mjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const block=n=>({number:'0x'+n.toString(16),hash:'0x'+n.toString(16).padStart(64,'0'),stateRoot:'0x'+'22'.repeat(32),timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)});
function fake(){const s={n:100n,headers:0,final:null,signals:[]};return {s,verifier:{request:async(m,p,ms,signal)=>{
 s.signals.push(signal);if(m==='eth_chainId')return '0x2105';if(m==='eth_blockNumber')return '0x'+s.n.toString(16);
 if(m==='eth_getBlockByNumber'){const b=block(s.n);if(++s.headers===2&&s.final)await s.final;return b;}throw Error('unexpected');
}}};}
test('late final header after deadline cannot advance the accepted floor',async()=>{
 const {s,verifier}=fake();let release;s.final=new Promise(r=>release=r);
 const snap=createVerifiedSnapshot({verifier,chainId:8453,confirmations:0,deadlineMs:100});
 await assert.rejects(snap(async()=>true),e=>e.code==='chain_timeout');
 release();await sleep(20);s.n=99n;
 assert.equal((await snap(async()=>true)).blockNumber,99n);
 // An actually accepted floor is still enforced.
 s.n=98n;await assert.rejects(snap(async()=>true),e=>e.code==='chain_rollback');
});
test('a retained client closes metadata and RPC methods after success or failure',async()=>{
 for(const fail of [false,true]){
  const {s,verifier}=fake();const snap=createVerifiedSnapshot({verifier,chainId:8453,confirmations:0});let client;
  const pending=snap(async c=>{client=c;if(fail)throw Error('callback failed');return true;});
  if(fail)await assert.rejects(pending,/callback failed/);else await pending;
  for(const call of [()=>client.getChainId(),()=>client.getBlockNumber(),()=>client.getBlock(),()=>client.getCode({address:'0x'+'33'.repeat(20)})])
   await assert.rejects(call(),e=>e.code==='chain_closed');
  assert.ok(s.signals.length&&s.signals.every(s=>s?.aborted),'operation cancellation reached each request');
 }
});
test('callback failure aborts a pending local HTTP request before its long request timeout', {timeout:5000},async t=>{
 let began,ended;const started=new Promise(r=>began=r),closed=new Promise(r=>ended=r);
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const j=JSON.parse(body);if(j.method==='eth_getCode'){res.on('close',ended);began();return;}
  const result=j.method==='eth_chainId'?'0x2105':j.method==='eth_blockNumber'?'0x64':block(100n);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:j.id,result}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();server.close();});
 const snap=createVerifiedSnapshot({verifier:`http://127.0.0.1:${server.address().port}`,chainId:8453,confirmations:0,deadlineMs:30000});
 let rpc;
 await assert.rejects(snap(async c=>{rpc=c.getCode({address:'0x'+'33'.repeat(20)});rpc.catch(()=>{});await started;throw Error('callback failed');}),/callback failed/);
 let timer;try {await Promise.race([closed,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('pending HTTP request was not cancelled')),1000))]);}finally{clearTimeout(timer);}
 await assert.rejects(rpc);
});
