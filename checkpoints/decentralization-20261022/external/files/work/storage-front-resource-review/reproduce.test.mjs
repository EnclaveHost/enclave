// Negative-control evidence against the frozen unactivated candidate. Passing tests CONFIRM the reviewed defects;
// they are not acceptance tests for a release. No network, chain, keys or production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {createLeaseGenerationReader} from '../storage-front-binding/tree/relay/lease-generation.mjs';
const root=new URL('../storage-front-binding/tree/',import.meta.url);
const source=f=>fs.readFileSync(new URL(f,root),'utf8');
const deadlineLine=source('relay/secrets-release.mjs').split('\n').find(l=>l.startsWith('export const withDeadline = '));
assert.ok(deadlineLine);
const withDeadline=vm.runInNewContext(deadlineLine.replace('export ','')+'\nwithDeadline;',{Promise,setTimeout,Error});
const ledger='0x'+'11'.repeat(20), id='0x'+'22'.repeat(32), runner='0x'+'33'.repeat(32);
const keepAlive=setInterval(()=>{},1000);test.after(()=>clearInterval(keepAlive));
const result={scope:'Negative-control reproduction of unactivated frozen source',files:Object.fromEntries(['relay/lease-generation.mjs','relay/api-relay.js','relay/secrets-release.mjs'].map(f=>[f,createHash('sha256').update(source(f)).digest('hex')]))};
test('release timeout returns while actual reader requests remain active; another release adds more',async()=>{
 let active=0,peak=0,aborts=0;
 const fetch=(_u,{signal})=>new Promise((_ok,no)=>{active++;peak=Math.max(peak,active);signal.addEventListener('abort',()=>{active--;aborts++;no(signal.reason);},{once:true});});
 const reader=createLeaseGenerationReader({rpcs:['https://a.example','https://b.example'],ledger,timeoutMs:300,fetch});
 const first=reader.writerAuthority(id,{runner});first.catch(()=>{});
 await assert.rejects(withDeadline(first,20),/no answer/);
 assert.equal(active,2);
 const second=reader.writerAuthority(id,{runner});second.catch(()=>{});
 await assert.rejects(withDeadline(second,20),/no answer/);
 assert.equal(active,4);
 await Promise.allSettled([first,second]);
 assert.equal(active,0);assert.equal(aborts,4);
 result.deadline={requestsAliveAfterSecondReleaseDeadline:4,peak,cleanupRequestsAlive:active};
});
test('actual API timer callback starts overlapping tracker cycles',async()=>{
 const text=source('relay/api-relay.js');const start=text.indexOf('if (leaseGenerationReader) setInterval(async () => {');
 const end=text.indexOf('}, 15 * 60_000).unref();',start);assert.ok(start>=0&&end>start);
 const block=text.slice(start,end+'}, 15 * 60_000).unref();'.length);
 let cb,active=0,peak=0;const resolvers=[];
 vm.runInNewContext(block,{setInterval:f=>{cb=f;return{unref(){}}},leaseGenerationReader:{tracked:()=>['8453|ledger|id'],track:()=>new Promise(ok=>{active++;peak=Math.max(peak,active);resolvers.push(()=>{active--;ok();});})}});
 const a=cb(),b=cb();assert.equal(active,2);for(const done of resolvers)done();await Promise.all([a,b]);
 result.tracker={overlappingCycles:peak,cleanupActive:active};
});
test('actual reader buffers 8 MiB replies despite its declared 4 MiB limit',async()=>{
 let delivered=0;const size=8*1024*1024;
 const fetch=async()=>{let sent=0;return new Response(new ReadableStream({pull(c){if(sent>=size){c.close();return;}const chunk=new Uint8Array(65536).fill(32);sent+=chunk.length;delivered+=chunk.length;c.enqueue(chunk);}}));};
 const reader=createLeaseGenerationReader({rpcs:['https://a.example','https://b.example'],ledger,fetch});
 await assert.rejects(reader.writerAuthority(id,{runner}));
 assert.equal(delivered,2*size);
 result.responseLimit={declaredPerPeerBytes:4*1024*1024,deliveredPerPeerBytes:size,peers:2};
});
test.after(()=>fs.writeFileSync(new URL('./result.json',import.meta.url),JSON.stringify(result,null,2)+'\n'));
