import test from 'node:test';
import assert from 'node:assert/strict';
import {F,forwarder,fakeCustodian,request,raw} from './helpers.mjs';
import {compileOriginIngress} from '../origin-config.mjs';
import {directCustodyIngress} from '../pinned/ingress.mjs';
test('origin mount is explicit; an omitted, nonempty, invalid or misspelled origin mode refuses',()=>{
 const c={mount:'origin',prefix:'',listen:{host:'127.0.0.1',port:18973},upstreamPort:18971};assert.equal(F.validateConfig(c).prefix,'');
 for(const bad of [{...c,mount:undefined},{...c,mount:'typo'},{...c,prefix:undefined},{...c,prefix:'/'},{...c,prefix:'/t/x'},{...c,prefix:'/prefix'},{...c,listen:{host:'0.0.0.0',port:18973}}])assert.throws(()=>F.validateConfig(bad));
});
test('dedicated origin carries every exact protocol route and rejects private, normalized and wrong-method requests before upstream',async t=>{
 const up=await fakeCustodian(),fw=await forwarder(up.port,{mount:'origin',prefix:''});t.after(async()=>{await fw.close();await up.close();});
 for(const [route,method] of F.ROUTES){const r=await request(fw.port,method,route,method==='POST'?'{}':null);assert.equal(r.status,200);assert.equal(up.hits.at(-1).raw,route);}
 up.hits.length=0;const targets=new Set(['/','/health','/state','/submit','/v2/custody/host-binding','/v2/custody/challenge/../host-binding','/v2/custody/challenge/%2e%2e/host-binding','/v2/custody/info/..\\host-binding','//v2/custody/host-binding']);
 for(const [route,method] of F.ROUTES){
  for(const bad of [route+'/',route+'?x',route+';x',route.toUpperCase(),route.replace('/custody/','/x/../custody/'),route.replace('/custody/','/custody/./'),route.replace('/v2/','/%76%32/'),'http://other'+route,'/custody-v2-canary/metal0'+route,'/'+route])targets.add(bad);
  const wrong=method==='POST'?'GET':'POST';assert.equal((await request(fw.port,wrong,route,wrong==='POST'?'{}':null)).status,404);
 }
 for(const target of targets)for(const method of ['GET','POST'])assert.ok([400,404].includes((await request(fw.port,method,target,method==='POST'?'{}':null)).status),target);
 assert.deepEqual(up.hits,[]);
 const upgrade=await raw(fw.port,'GET /v2/custody/info HTTP/1.1\r\nhost:x\r\nconnection:upgrade\r\nupgrade:websocket\r\n\r\n');assert.ok(upgrade.closed&&upgrade.status!==200);
});
test('dedicated origin Caddy config and reverse port exactly match the reviewed ingress methods and paths',()=>{
 const c=compileOriginIngress({endpoint:'https://custody-canary.enclave.host',listenPort:18973,upstreamPort:18971,tunnelPort:18972});
 const pairs=s=>[...s.matchAll(/method (\S+)\s+path ([^\n]+)/g)].flatMap(m=>m[2].trim().split(/\s+/).map(p=>m[1]+' '+p)).sort();
 assert.deepEqual(pairs(c.caddy),pairs(directCustodyIngress({endpoint:c.endpoint,mgmtPort:18972})));
 assert.equal(c.forwarder.mount,'origin');assert.equal(c.forwarder.prefix,'');assert.equal(c.reverseForward,'127.0.0.1:18972:127.0.0.1:18973');
 assert.equal((c.caddy.match(/reverse_proxy 127.0.0.1:18972/g)||[]).length,2);assert.match(c.caddy,/handle \{\s*respond "Not found" 404/);assert.match(c.caddy,/max_size 262144/);
 for(const endpoint of ['https://api.enclave.host','https://enclave.host','https://canary.example/prefix','https://canary.example/','http://canary.example','https://x@canary.example','https://canary.example:8443'])assert.throws(()=>compileOriginIngress({endpoint,listenPort:18973,upstreamPort:18971,tunnelPort:18972}));
 assert.throws(()=>compileOriginIngress({endpoint:c.endpoint,listenPort:18971,upstreamPort:18971,tunnelPort:18972}));
});
