import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,X509Certificate} from 'node:crypto';
import http from 'node:http';
import {createDiscovery,routeFor,deployedOptions} from '../relay/native-discovery.mjs';

const DO=['134.199.235.187','134.209.248.172','165.245.191.129','146.190.246.39'];

test('native control names route only to a route from a control source, never to a fixed fleet',async()=>{
 const now=Date.now(),map={routes:{'api.enclavehost.eth':{addresses:['44.0.0.1','44.0.0.2'],expiresAt:now+1000},'mcp.enclavehost.eth':{addresses:['44.0.0.1'],expiresAt:now+1000}}};
 for(const service of ['api','mcp']){
  const name=service+'.enclavehost.eth',r=routeFor(name,map,now);
  assert.equal(r.kind,'control');assert.equal(r.port,443);assert.equal(r.expiresAt,now+1000);
  assert.deepEqual(r.addresses,map.routes[name].addresses);
  assert.equal(routeFor(name,null,now),null);assert.equal(routeFor(name,{},now),null);
  assert.equal(routeFor(name,map,now+1000),null,'expired');
 }
 assert.equal(routeFor('api.enclavehost.eth',{routes:{'mcp.enclavehost.eth':map.routes['mcp.enclavehost.eth']}},now),null,'one name never borrows another');
 const src=await readFile(new URL('../relay/native-discovery.mjs',import.meta.url),'utf8');
 for(const ip of DO)assert.ok(!src.includes(ip),`no fixed fleet address ${ip}`);
 // still deployable as the single file it is today (/opt/enclave-recovery/discovery.mjs, no node_modules)
 assert.deepEqual([...src.matchAll(/^import .* from '([^']+)';$/gm)].map(m=>m[1]).filter(x=>!x.startsWith('node:')),[]);
});

test('malformed control addresses are never served',()=>{
 const now=Date.now(),at=(addresses)=>routeFor('api.enclavehost.eth',{routes:{'api.enclavehost.eth':{addresses,expiresAt:now+1000}}},now);
 for(const addresses of [[],['10.0.0.1'],['127.0.0.1'],['100.64.1.1'],['169.254.1.1'],['203.0.113.5'],['224.0.0.1'],['255.255.255.255'],['0.1.2.3'],['44.0.0.01'],['2001:db8::1'],['44.0.0.1','192.168.1.1'],['44.0.0.1:443'],['api.example.org'],[44],[null],'44.0.0.1',null])
  assert.equal(at(addresses),null,JSON.stringify(addresses));
 assert.equal(routeFor('api.enclavehost.eth',{routes:{'api.enclavehost.eth':{addresses:['44.0.0.1'],expiresAt:'never'}}},now),null);
});

test('unknown native names have no route',()=>{
 const now=Date.now(),map={routes:{'api.enclavehost.eth':{addresses:['44.0.0.1'],expiresAt:now+1000}},labels:{'1234abcd':{addresses:['8.8.4.4'],expiresAt:now+1000}}};
 for(const name of ['api.enclavehost.eth.attacker.test','API.enclavehost.eth','other.enclavehost.eth','api.enclave.host','x.api.enclavehost.eth','enclavehost.eth','app.enclavehost.eth',
  '1234abcd.app.enclavehost.eth.evil','1234ABCD.app.enclavehost.eth','a'.repeat(254),null,undefined,42])assert.equal(routeFor(name,map,now),null,String(name));
});

test('native application discovery never returns an expired or absent route',()=>{
 const now=Date.now(),name='1234abcd.app.enclavehost.eth';
 const map={labels:{'1234abcd':{addresses:['8.8.4.4'],expiresAt:now+1000}}};
 assert.deepEqual(routeFor(name,map,now),{name,addresses:['8.8.4.4'],port:443,kind:'application',expiresAt:now+1000});
 assert.equal(routeFor(name,map,now+1000),null);assert.equal(routeFor(name,{},now),null);
 assert.equal(routeFor('nested.'+name,map,now),null);
 assert.equal(routeFor(name,{routes:{[name]:{addresses:['8.8.4.4'],expiresAt:now+1000}}},now),null,'an application name never reads the control map');
});

async function serve(t,opts){
 const caPem=await readFile(new URL('./fixtures/amd/Genoa-cert_chain.pem',import.meta.url),'utf8');
 const server=createDiscovery({caPem,...opts});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 return {caPem,origin,get:async(p)=>{const r=await fetch(origin+p);return {status:r.status,headers:r.headers,body:await r.json().catch(()=>null)};}};
}

test('native discovery publishes only public CA and routing metadata and refuses missing authority',async t=>{
 let reads=0;const {caPem,origin,get}=await serve(t,{getRoutes:async()=>{reads++;throw Error('offline');}});
 const status=(await get('/native/status')).body;assert.equal(status.caSha256,createHash('sha256').update(new X509Certificate(caPem).raw).digest('hex'));
 const control=await get('/native/resolve?name=api.enclavehost.eth');
 assert.equal(control.status,503);assert.equal(control.body.error,'control_route_unavailable');assert.ok(control.headers.get('retry-after'));assert.equal(reads,0);
 assert.equal((await get('/native/resolve?name=1234abcd.app.enclavehost.eth')).status,503);assert.equal(reads,1);
 assert.equal((await get('/native/resolve?name=other.enclavehost.eth')).status,404);assert.equal(reads,1);
 assert.equal((await get('/native/private.key')).status,404);
 assert.equal((await fetch(origin+'/native/status',{method:'POST'})).status,405);
});

test('native discovery serves verified control routes and answers unavailable, never another address, otherwise',async t=>{
 let now=Date.now(),controlReads=0,appReads=0,mode='ok';
 const getControlRoutes=async()=>{controlReads++;
  if(mode==='throw')throw Error('quorum down');
  if(mode==='hang')return new Promise(()=>{});
  return {routes:mode==='empty'?{}:{'api.enclavehost.eth':{addresses:['44.0.0.1'],expiresAt:mode==='expired'?now-1:Date.now()+60_000}}};};
 const getRoutes=async()=>{appReads++;return {labels:{'1234abcd':{addresses:['8.8.4.4'],expiresAt:Date.now()+60_000}}};};
 const {get}=await serve(t,{getRoutes,getControlRoutes,timeoutMs:300});
 const ok=await get('/native/resolve?name=api.enclavehost.eth');
 assert.equal(ok.status,200);assert.deepEqual(ok.body.addresses,['44.0.0.1']);assert.equal(ok.body.kind,'control');assert.match(ok.body.caSha256,/^[0-9a-f]{64}$/);
 for(const [m,code,error] of [['empty',503,'control_route_unavailable'],['expired',503,'control_route_unavailable'],['throw',503,'route_discovery_unavailable'],['hang',503,'route_discovery_unavailable']]){
  mode=m;const t0=Date.now(),r=await get('/native/resolve?name=api.enclavehost.eth');
  assert.equal(r.status,code,m);assert.equal(r.body.error,error,m);assert.ok(!JSON.stringify(r.body).match(/\d+\.\d+\.\d+\.\d+/),m);
  assert.ok(Date.now()-t0<3000,`${m} is bounded`);
 }
 assert.equal(appReads,0,'control names never read the application route map');
 mode='ok';const app=await get('/native/resolve?name=1234abcd.app.enclavehost.eth');
 assert.equal(app.status,200);assert.deepEqual(app.body.addresses,['8.8.4.4']);assert.equal(app.body.kind,'application');
 const reads=controlReads;assert.equal((await get('/native/resolve?name=1234abcd.app.enclavehost.eth')).status,200);assert.equal(controlReads,reads,'application names never read control routes');
 assert.equal((await get('/native/resolve?name=other.enclavehost.eth')).status,404);
 mode='ok';assert.equal((await get('/native/resolve?name=mcp.enclavehost.eth')).status,503,'a verified api route is not an mcp route');
});

test('deployed configuration has no control route source: no advertisement or route-map field can supply one',async t=>{
 const now=Date.now(),served=[];
 // the local relay's route map, carrying an attempted control route beside a real application route
 const relay=http.createServer((req,res)=>{served.push(req.url);res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({labels:{'1234abcd':{addresses:['8.8.4.4'],expiresAt:now+60_000}},routes:{'api.enclavehost.eth':{addresses:['44.0.0.6'],expiresAt:now+60_000}}}));});
 await new Promise(r=>relay.listen(0,'127.0.0.1',r));t.after(()=>relay.close());
 const caPem=await readFile(new URL('./fixtures/amd/Genoa-cert_chain.pem',import.meta.url),'utf8');
 const opts=deployedOptions(caPem,{routeMapUrl:`http://127.0.0.1:${relay.address().port}/v1/network/routes`});
 assert.deepEqual(Object.keys(opts).sort(),['caPem','getRoutes']);
 const server=createDiscovery(opts);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const get=async(n)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/native/resolve?name=${n}`);return {status:r.status,body:await r.json()};};
 for(const n of ['api.enclavehost.eth','mcp.enclavehost.eth']){const r=await get(n);assert.equal(r.status,503);assert.equal(r.body.error,'control_route_unavailable');}
 assert.equal(served.length,0,'control names never read the application route map');
 const app=await get('1234abcd.app.enclavehost.eth');assert.equal(app.status,200);assert.deepEqual(app.body.addresses,['8.8.4.4']);assert.equal(served.length,1);
});
