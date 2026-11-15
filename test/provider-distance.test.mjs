// How far a provider is from this host (network/provider-distance.mjs): which providers are measured, how often, and
// what a provider that does not answer becomes.
import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';
import {createProviderDistance,handshakeMs} from '../network/provider-distance.mjs';

const prov=(n,over={})=>({providerId:String(n).repeat(32).slice(0,32),address:`44.0.0.${n}`,region:'r'+n,eligibleRoles:['guard','ingress','egress'],...over});

test('a provider is measured once per run: the shortest of three handshakes; one that does not answer is asked again later',async()=>{
 let t=1000;const asked=[],answers={'44.0.0.1':[31.26,29.94,40],'44.0.0.2':[null],'44.0.0.3':[80,null,75.5]},lines=[];
 const measure=async a=>{asked.push(a);return answers[a].shift()??null;};
 const distance=createProviderDistance({measure,now:()=>t,log:l=>lines.push(l)});
 const list=[1,2,3].map(n=>prov(n));
 const m=await distance(list);
 assert.deepEqual([...m],[[prov(1).providerId,29.9],[prov(3).providerId,75.5]]);
 // no answer to the first handshake: not asked twice more
 assert.deepEqual([1,2,3].map(n=>asked.filter(a=>a===`44.0.0.${n}`).length),[3,1,3]);
 assert.match(lines[0],/measured 3 provider\(s\): r1 29\.9 ms, r2 no answer, r3 75\.5 ms/);assert.ok(!/44\.0\.0/.test(lines.join()),'no address in the log');
 // nothing is measured again while the answers stand
 asked.length=0;assert.deepEqual([...await distance(list)],[...m]);assert.deepEqual(asked,[]);assert.equal(lines.length,1);
 // the silent provider is asked again after ten minutes, not before
 t+=9*60000;await distance(list);assert.deepEqual(asked,[]);
 answers['44.0.0.2']=[150,140,145];t+=60000;
 assert.equal((await distance(list)).get(prov(2).providerId),140);assert.deepEqual(asked,['44.0.0.2','44.0.0.2','44.0.0.2']);
});
test('only address literals of providers that offer ingress are measured; a changed address is measured anew',async()=>{
 const asked=[];const distance=createProviderDistance({measure:async a=>{asked.push(a);return 10;},samples:1});
 const m=await distance([prov(1),prov(2,{eligibleRoles:['guard']}),prov(3,{address:'edge.example'}),prov(4,{eligibleRoles:undefined})]);
 assert.deepEqual(asked,['44.0.0.1']);assert.deepEqual([...m.keys()],[prov(1).providerId]);
 const moved=prov(1,{address:'44.0.0.9'});
 assert.equal((await distance([moved])).get(moved.providerId),10);assert.deepEqual(asked,['44.0.0.1','44.0.0.9']);
 // a provider that left the list is not in the answer
 assert.equal((await distance([])).size,0);
});
test('the handshake itself: a listening port answers in milliseconds, a closed one is no answer',async()=>{
 const server=net.createServer(s=>s.destroy());await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const {port}=server.address();
 try{
  const ms=await handshakeMs('127.0.0.1',{port});assert.ok(typeof ms==='number'&&ms>=0&&ms<1000);
 }finally{await new Promise(r=>server.close(r));}
 assert.equal(await handshakeMs('127.0.0.1',{port,timeoutMs:500}),null);
});
