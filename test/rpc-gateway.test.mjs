import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRpcGateway,createServer} from '../rpc/gateway.mjs';
const ok=result=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result}));
const msg=(id=1,method='eth_call',params=[{to:'0x123',data:'0x'},'latest'])=>({jsonrpc:'2.0',id,method,params});
const setup=(fetchImpl,other={})=>createRpcGateway({upstreams:{base:['private-key-url','public-url']},fetchImpl,...other});
test('Alchemy first; cache/coalescing preserves each id; latest expires',async()=>{
 let calls=[],at=0;
 const g=setup(async url=>{calls.push(url);return ok('0x123');},{now:()=>at});
 const r=await Promise.all([g.request('base',msg(1)),g.request('base',msg('two'))]);
 assert.deepEqual(r.map(x=>x.id),[1,'two']);assert.deepEqual(calls,['private-key-url']);
 await g.request('base',msg(3));assert.equal(calls.length,1);
 at=1001;await g.request('base',msg(4));assert.equal(calls.length,2);
});
test('fallback on transient error, next cache miss returns to primary',async()=>{
 const calls=[];let fail=true;
 const g=setup(async url=>{calls.push(url);if(url==='private-key-url'&&fail)return new Response('',{status:429});return ok('0x123');});
 assert.equal((await g.request('base',msg())).result,'0x123');
 fail=false;await g.request('base',msg(2,'eth_blockNumber',[]));
 assert.deepEqual(calls,['private-key-url','public-url','private-key-url']);
});
test('reverts/errors/null results never cached; upstream messages redacted',async()=>{
 let calls=0,result={error:{code:3,message:'execution reverted at private-key-url',data:'0x1234'}};
 const g=setup(async()=>{calls++;return new Response(JSON.stringify({jsonrpc:'2.0',id:1,...result}));});
 const r=await g.request('base',msg());await g.request('base',msg());
 assert.equal(calls,2);assert.equal(r.error.data,'0x1234');assert.equal(JSON.stringify(r).includes('private-key'),false);
 result={result:null};await g.request('base',msg());await g.request('base',msg());assert.equal(calls,4);
});
test('writes, pending, and nonce reads bypass cache and coalescing',async()=>{
 let calls=0;const g=setup(async()=>{calls++;return ok('0x1');});
 for(const [method,params] of [['eth_sendRawTransaction',['0x1234']],['eth_call',[{},'pending']],['eth_getTransactionCount',['0x123','latest']]]){
 await Promise.all([g.request('base',msg(1,method,params)),g.request('base',msg(2,method,params))]);
 }
 assert.equal(calls,6);
});
test('ambiguous submission is not retried; unsupported methods do not spend credits',async()=>{
 let calls=0;const g=setup(async()=>{calls++;throw Error('secret-url');});
 const r=await g.request('base',msg(1,'eth_sendRawTransaction',['0x1234']));
 assert.equal(calls,1);assert.equal(r.error.code,-32002);assert(!JSON.stringify(r).includes('secret'));
 assert.equal((await g.request('base',msg(2,'debug_traceTransaction',[]))).error.code,-32601);assert.equal(calls,1);
});
test('wrong chain fails over; cache separates networks; bounded entries',async()=>{
 const calls=[];const g=setup(async url=>{calls.push(url);return ok(url==='private-key-url'?'0x1':'0x2105');},{maxEntries:2});
 assert.equal((await g.request('base',msg(1,'eth_chainId',[]))).result,'0x2105');assert.equal(calls.length,2);
 for(let i=0;i<4;i++)await g.request('base',msg(i,'eth_call',[{data:'0x'+i},'latest']));assert.equal(g.stats().entries,2);
 assert.equal((await g.request('other',msg())).error.code,-32602);
});
test('HTTP batches preserve ids; bounds and method restrictions',async t=>{
 const s=createServer(setup(async()=>ok('0x1')));await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>s.close());
 const url=`http://127.0.0.1:${s.address().port}/rpc/base`;
 const r=await fetch(url,{method:'POST',body:JSON.stringify([msg(1),msg('b')])});assert.deepEqual((await r.json()).map(x=>x.id),[1,'b']);
 assert.equal((await fetch(url,{method:'POST',body:JSON.stringify(Array(21).fill(msg()))})).status,400);
 assert.equal((await fetch(url)).status,405);
 assert.equal((await fetch(url,{method:'POST',body:'x'})).status,400);
});
test('maxLagSeconds tries a stale upstream after fresh ones and restores it once caught up',async()=>{
 let at=1_000_000_000_000,primaryTs=at/1000-3600;const calls=[],tick=()=>new Promise(r=>setImmediate(r));
 const g=setup(async(url,init)=>{
  const {method}=JSON.parse(init.body);
  if(method==='eth_getBlockByNumber')return ok({timestamp:'0x'+Math.floor(url==='private-key-url'?primaryTs:at/1000).toString(16)});
  calls.push(url);return ok('0x1');
 },{now:()=>at,maxLagSeconds:{base:120}});
 await g.request('base',msg(1,'eth_blockNumber',[]));await tick();
 at+=1001;await g.request('base',msg(2,'eth_blockNumber',[]));
 assert.deepEqual(calls,['private-key-url','public-url']);assert.equal(g.stats().staleUpstreams,1);
 primaryTs=at/1000;at+=15000;await g.request('base',msg(3,'eth_blockNumber',[]));await tick();
 at+=1001;await g.request('base',msg(4,'eth_blockNumber',[]));
 assert.deepEqual(calls.slice(2),['public-url','private-key-url']);
});
test('a single stale upstream is still served; networks without maxLagSeconds are never probed',async()=>{
 let at=1_000_000_000_000;const methods=[],tick=()=>new Promise(r=>setImmediate(r));
 const g=createRpcGateway({upstreams:{ethereum:['enclave'],base:['a','b']},now:()=>at,maxLagSeconds:{ethereum:60},fetchImpl:async(url,init)=>{
  const {method}=JSON.parse(init.body);methods.push(url+' '+method);
  return ok(method==='eth_getBlockByNumber'?{timestamp:'0x1'}:'0x1');
 }});
 await g.request('ethereum',msg(1,'eth_blockNumber',[]));await tick();at+=1001;
 assert.equal((await g.request('ethereum',msg(2,'eth_blockNumber',[]))).result,'0x1');
 await g.request('base',msg(3,'eth_blockNumber',[]));
 assert.deepEqual(methods.filter(m=>m.includes('getBlockByNumber')),['enclave eth_getBlockByNumber']);
});
test('upstream failures are logged by index, redacted, once a minute per reason',async()=>{
 let at=1_000_000_000_000,mode='url';const lines=[],tick=()=>new Promise(r=>setImmediate(r));
 const g=createRpcGateway({upstreams:{ethereum:['enclave'],base:['a','b']},now:()=>at,maxLagSeconds:{ethereum:60},log:l=>lines.push(JSON.parse(l)),fetchImpl:async url=>{
  if(url==='b')return ok('0x1');
  if(mode==='url')throw Error('fetch failed at https://base-mainnet.example/v2/SECRET',{cause:{code:'ECONNRESET'}});
  if(mode==='json')return new Response('{"echo":"https://x/v2/SECRET"');
  if(mode==='502')return new Response('',{status:502});
  throw Error('chain refuses enclave: Base RPCs disagree on the deployment');
 }});
 for(let i=0;i<3;i++)await g.request('base',msg(i,'eth_call',[{data:'0x'+i},'latest']));
 mode='json';at+=1001;await g.request('base',msg(4,'eth_blockNumber',[]));
 mode='chain';at+=1001;assert.equal((await g.request('ethereum',msg(5,'eth_blockNumber',[]))).error.code,-32002);await tick();
 assert.equal(JSON.stringify(lines).includes('SECRET'),false);
 assert.deepEqual(lines.filter(l=>l.event==='upstream-error'),[
  {event:'upstream-error',network:'base',index:0,reason:'fetch failed at <url> (ECONNRESET)'},
  {event:'upstream-error',network:'base',index:0,reason:'invalid JSON'},
  {event:'upstream-error',network:'ethereum',index:0,reason:'chain refuses enclave: Base RPCs disagree on the deployment'}]);
 assert.deepEqual(lines.filter(l=>l.event==='upstream-probe-error').map(l=>l.network),['ethereum']);
 mode='502';at+=1001;await g.request('ethereum',msg(8,'eth_blockNumber',[]));
 assert.equal(lines.at(-1).reason,'upstream unavailable: HTTP 502');
 mode='url';at+=55000;await g.request('base',msg(6,'eth_call',[{data:'0x6'},'latest']));
 assert.equal(lines.filter(l=>l.event==='upstream-error').length,4);
 at+=3000;await g.request('base',msg(7,'eth_call',[{data:'0x7'},'latest']));
 assert.equal(lines.filter(l=>l.event==='upstream-error').length,5);
});
