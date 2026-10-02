import test from 'node:test';import assert from 'node:assert/strict';
import {withGuardedFailover} from '../network/guarded-fetch.mjs';
test('control RPC remembers a usable guard after an aborted attempt',async()=>{
 const calls=[],abort=new AbortController();let entries=['127.0.0.1:1','127.0.0.1:2'];
 const fetch=withGuardedFailover(()=>entries,p=>async()=>{calls.push(p);if(p.endsWith(':1')){abort.abort(new Error('deadline'));throw Error('guard timeout');}return new Response('{}');});
 await assert.rejects(fetch('https://rpc.example',{signal:abort.signal}),/deadline/);
 assert.equal((await fetch('https://rpc.example')).status,200);assert.deepEqual(calls,['127.0.0.1:1','127.0.0.1:2']);
 entries=[];await assert.rejects(fetch('https://rpc.example'),/unavailable/);assert.equal(calls.length,2);
});
test('blocked and rate-limited guard responses try only the explicit sibling',async()=>{
 const calls=[];const fetch=withGuardedFailover(()=>['127.0.0.1:1','127.0.0.1:2'],p=>async()=>{calls.push(p);return new Response('{}',{status:p.endsWith(':1')?403:200});});
 assert.equal((await fetch('https://rpc.example')).status,200);assert.equal((await fetch('https://rpc.example')).status,200);
 assert.deepEqual(calls,['127.0.0.1:1','127.0.0.1:2','127.0.0.1:2']);
});
