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
